// Client-side inverted index mirroring the desktop's SQLite FTS5 approach.
//
// Desktop search uses two FTS5 tables (prefix + trigram) to narrow 3500+ songs
// down to a small candidate set (~1200 rowids) before running fuzzy scoring.
// This module builds the same kind of inverted index in-memory so the Web
// Worker can pre-filter candidates the same way, keeping per-keystroke work
// bounded instead of O(n_songs * fuzzy_levenshtein).
//
// Optimizations beyond a naive inverted index:
// - Sorted token-key arrays next to each Map for O(log n + matches) prefix
//   lookup instead of O(all_indexed_tokens) per query token.
// - AND-intersection of posting lists for multi-token queries (with OR-union
//   fallback when the intersection is empty). Without this, "i love you lord"
//   with Slides ON would surface ~2000 candidates and run Levenshtein on
//   every single one — multi-second latency.
// - Pre-populated NormCache (pre-split word arrays) so `matchScore` does
//   not re-allocate `text.split(' ')` for every candidate.

import { matchScore, normalize, type NormCache, type ScoredResult } from './search';
import type { BibleVerse, LibrarySong } from './protocol';

export interface SongIndexEntry {
  song: LibrarySong;
  normName: string;
  normFolder: string;
  normBlob: string; // ' | '-joined normalized slides, or '' when there are none
}

export interface SongSearchIndex {
  entries: SongIndexEntry[];
  /** token (>=1 char) -> song indices that contain the token in title or folder */
  titleTokens: Map<string, number[]>;
  /** token (>=3 chars) -> song indices that contain the token in the slide blob */
  blobTokens: Map<string, number[]>;
  /** sorted keys of `titleTokens`, for binary-search prefix lookups */
  titleTokenKeys: string[];
  /** sorted keys of `blobTokens`, for binary-search prefix lookups */
  blobTokenKeys: string[];
}

function splitTokens(text: string): string[] {
  return text ? text.split(' ').filter(Boolean) : [];
}

/**
 * Find every key in `sortedKeys` that starts with `prefix`. Returns the
 * half-open [start, end) index range. Uses binary search to locate the lower
 * bound, then walks forward while the prefix continues to match.
 */
function prefixKeyRange(sortedKeys: string[], prefix: string): [number, number] {
  if (prefix.length === 0) return [0, sortedKeys.length];

  // Lower bound: first key >= prefix.
  let lo = 0;
  let hi = sortedKeys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedKeys[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;

  // Upper bound: first key >= prefix with the next char, i.e. not a prefix
  // of prefix. Walk forward while sortedKeys[i] starts with prefix.
  let end = start;
  while (end < sortedKeys.length && sortedKeys[end].startsWith(prefix)) {
    end++;
  }
  return [start, end];
}

/**
 * Collect posting lists for a token by prefix-matching against the sorted
 * token-key array. Returns the concatenated postings (caller will AND-
 * intersect or OR-union them).
 */
function collectPrefixPostings(
  postingsByKey: Map<string, number[]>,
  sortedKeys: string[],
  token: string,
  out: number[][],
): void {
  const [start, end] = prefixKeyRange(sortedKeys, token);
  for (let i = start; i < end; i++) {
    const key = sortedKeys[i];
    if (key.length >= token.length && key.startsWith(token)) {
      out.push(postingsByKey.get(key)!);
    }
  }
}

/**
 * Build an in-memory inverted index over the song library. Mirrors the desktop
 * FTS5 tables (`song_search_fts` and `song_search_trigram`) using simple
 * Map<token, posting-list> structures. Long slide tokens (>=3 chars) are
 * indexed separately so we only pay for slide search when the user opts in.
 *
 * Runs entirely off the main thread (called from searchWorker.ts).
 */
export function buildSongIndex(songs: LibrarySong[]): SongSearchIndex {
  const entries: SongIndexEntry[] = new Array(songs.length);
  const titleTokens = new Map<string, number[]>();
  const blobTokens = new Map<string, number[]>();

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const normName = song.normalized_name ?? normalize(song.name);
    const normFolder = song.normalized_folder ?? normalize(song.folder ?? '');
    const normBlob = song.normalized_blob
      ?? (song.slide_texts?.length ? song.slide_texts.map(normalize).join(' | ') : '');

    entries[i] = { song, normName, normFolder, normBlob };

    const titleTokenSet = new Set<string>();
    for (const tok of splitTokens(normName)) titleTokenSet.add(tok);
    for (const tok of splitTokens(normFolder)) titleTokenSet.add(tok);
    for (const tok of titleTokenSet) {
      const arr = titleTokens.get(tok);
      if (arr) arr.push(i);
      else titleTokens.set(tok, [i]);
    }

    if (normBlob) {
      const blobTokenSet = new Set<string>();
      for (const tok of splitTokens(normBlob)) {
        if (tok.length >= 3) blobTokenSet.add(tok);
      }
      for (const tok of blobTokenSet) {
        const arr = blobTokens.get(tok);
        if (arr) arr.push(i);
        else blobTokens.set(tok, [i]);
      }
    }
  }

  const titleTokenKeys = Array.from(titleTokens.keys()).sort();
  const blobTokenKeys = Array.from(blobTokens.keys()).sort();

  return { entries, titleTokens, blobTokens, titleTokenKeys, blobTokenKeys };
}

/**
 * AND-intersect the posting lists of all query tokens (each resolved by
 * prefix-matching against the sorted token keys). Returns the intersection,
 * or — if the intersection is empty and every token has ≥3 chars — the OR
 * union (per user choice). Falls back to OR union when only one token's
 * posting lists have matches and others don't.
 *
 * This is the heart of multi-word search performance: instead of running
 * `matchScore` (with Levenshtein) on every song containing ANY token, we
 * only score songs that contain EVERY token. For "i love you lord" with
 * Slides ON, this typically narrows 2000+ candidates down to ~50-200 — a
 * 10-40x reduction in fuzzy-score work.
 */
function candidateIdsFromTokens(
  tokens: string[],
  titleMap: Map<string, number[]>,
  titleSortedKeys: string[],
  blobMap: Map<string, number[]> | null,
  blobSortedKeys: string[] | null,
  searchSlides: boolean,
  limit: number,
): number[] {
  // For each token, gather its prefix-matched posting lists and flatten to
  // a per-token Set of candidate song indices.
  const perToken: Set<number>[] = [];
  let anyTitleMatches = false;
  let anyBlobMatches = false;

  for (const tok of tokens) {
    const titleLists: number[][] = [];
    collectPrefixPostings(titleMap, titleSortedKeys, tok, titleLists);
    let blobLists: number[][] | null = null;
    if (searchSlides && blobMap && blobSortedKeys) {
      blobLists = [];
      collectPrefixPostings(blobMap, blobSortedKeys, tok, blobLists);
    }

    if (titleLists.length === 0 && (!blobLists || blobLists.length === 0)) {
      // Token appears nowhere — intersection will be empty.
      perToken.push(new Set());
      continue;
    }

    const tokSet = new Set<number>();
    for (const list of titleLists) {
      for (const idx of list) tokSet.add(idx);
      if (tokSet.size > limit) break;
    }
    if (blobLists) {
      for (const list of blobLists) {
        for (const idx of list) tokSet.add(idx);
        if (tokSet.size > limit) break;
      }
    }
    if (titleLists.length > 0) anyTitleMatches = true;
    if (blobLists && blobLists.length > 0) anyBlobMatches = true;
    perToken.push(tokSet);
  }

  if (perToken.length === 0) return [];
  if (perToken.length === 1) {
    const out = Array.from(perToken[0]);
    return out.length > limit ? out.slice(0, limit) : out;
  }

  // Smallest-set-first seed: pick the token with the fewest candidates to
  // minimise the working set for the intersection.
  perToken.sort((a, b) => a.size - b.size);
  const seed = perToken[0];
  if (seed.size === 0) {
    // At least one token had zero matches. Fall back to OR union only when
    // every token has ≥3 chars (per chosen strategy).
    if (tokens.every((t) => t.length >= 3)) {
      const union = new Set<number>();
      for (const set of perToken) {
        for (const idx of set) {
          union.add(idx);
          if (union.size >= limit) break;
        }
        if (union.size >= limit) break;
      }
      return Array.from(union);
    }
    return [];
  }

  const intersection = new Set<number>();
  for (const idx of seed) {
    let inAll = true;
    for (let i = 1; i < perToken.length; i++) {
      if (!perToken[i].has(idx)) { inAll = false; break; }
    }
    if (inAll) {
      intersection.add(idx);
      if (intersection.size >= limit) break;
    }
  }

  if (intersection.size > 0) return Array.from(intersection);

  // Empty intersection: fall back to OR union when every token has ≥3 chars.
  if (tokens.every((t) => t.length >= 3)) {
    const union = new Set<number>();
    for (const set of perToken) {
      for (const idx of set) {
        union.add(idx);
        if (union.size >= limit) break;
      }
      if (union.size >= limit) break;
    }
    return Array.from(union);
  }
  return [];
}

/**
 * Find candidate song indices mirroring the desktop's
 * `_song_search_candidate_ids` semantics. Returns `null` to signal "do a
 * full scan" for very short queries (matches desktop behavior with
 * `len(query_norm) < 3`). Otherwise returns the AND-intersected candidate
 * set (with OR-union fallback); scoring still runs afterwards via
 * `matchScore`, which enforces the strict all-tokens requirement.
 */
export function findSongCandidates(
  index: SongSearchIndex,
  queryNorm: string,
  searchSlides: boolean,
  limit = 1500,
): number[] | null {
  if (queryNorm.length < 3) return null;

  const tokens = splitTokens(queryNorm);
  if (tokens.length === 0) return null;

  const ids = candidateIdsFromTokens(
    tokens,
    index.titleTokens,
    index.titleTokenKeys,
    searchSlides ? index.blobTokens : null,
    searchSlides ? index.blobTokenKeys : null,
    searchSlides,
    limit,
  );
  return ids;
}

/**
 * Score the candidate set (or all entries for short queries) using the same
 * `matchScore` function the existing synchronous path uses. Only callers
 * inside the Web Worker should invoke this — it still runs `matchScore` per
 * song, but on a much smaller set than 3500.
 *
 * Optimizations:
 * - Pre-populates the NormCache from the SongIndexEntry so `matchScore`
 *   doesn't re-normalize on first access.
 * - Prefilters slide-search candidates by requiring every query token to be
 *   a substring of the entry's `normBlob`. Guards against the rare case
 *   where a song entered the candidate set via title-tokens but doesn't
 *   actually contain all tokens in slides (would otherwise run the full
 *   per-slide matchScore pass before rejecting).
 */
export function searchSongs(
  index: SongSearchIndex,
  query: string,
  searchSlides: boolean,
  maxResults: number,
): ScoredResult<LibrarySong>[] {
  if (!query.trim()) {
    return index.entries.slice(0, maxResults).map((entry) => ({
      item: entry.song,
      score: 0,
      snippet: '',
    }));
  }
  const q = normalize(query);
  if (!q) return [];

  const tokens = splitTokens(q);
  const candidateIds = findSongCandidates(index, q, searchSlides);
  const indices = candidateIds;

  const cache = new Map<LibrarySong, NormCache>();
  const results: ScoredResult<LibrarySong>[] = [];

  if (indices === null) {
    // Short query: full scan.
    for (const entry of index.entries) {
      const { score, snippet } = matchScore(q, entry.song, searchSlides, cache);
      if (score > 0) results.push({ item: entry.song, score, snippet });
    }
  } else {
    for (const i of indices) {
      const entry = index.entries[i];
      if (!entry) continue;

      // Prefilter: when searching slides, skip entries whose blob doesn't
      // contain every query token as a substring. This guards against the
      // rare case where a song made the candidate set via title tokens but
      // wouldn't actually score on slides.
      if (searchSlides && entry.normBlob && tokens.length > 1) {
        let allInBlob = true;
        for (const tok of tokens) {
          if (!entry.normBlob.includes(tok)) { allInBlob = false; break; }
        }
        if (!allInBlob && !entry.normName.includes(q) && !entry.normFolder.includes(q)) {
          // Tokens aren't in the slides AND the query isn't in the title or
          // folder — matchScore would return 0, so skip it.
          continue;
        }
      }

      // Seed the NormCache from the already-normalized entry so matchScore
      // doesn't re-normalize on first access. The word arrays stay null and
      // are populated lazily by matchScore as needed.
      if (!cache.has(entry.song)) {
        cache.set(entry.song, {
          nName: entry.normName,
          nFolder: entry.normFolder,
          nSlides: entry.normBlob ? entry.normBlob.split(' | ') : null,
          nNameWords: null,
          nFolderWords: null,
          nSlideWords: null,
        });
      }

      const { score, snippet } = matchScore(q, entry.song, searchSlides, cache);
      if (score > 0) results.push({ item: entry.song, score, snippet });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

// ── Bible index ───────────────────────────────────────────────────

export interface BibleIndexEntry {
  verse: BibleVerse;
  normText: string;
}

export interface BibleSearchIndex {
  entries: BibleIndexEntry[];
  /** token (>=3 chars) -> verse indices */
  textTokens: Map<string, number[]>;
  /** sorted keys of `textTokens`, for binary-search prefix lookups */
  textTokenKeys: string[];
}

export function buildBibleIndex(verses: BibleVerse[]): BibleSearchIndex {
  const entries: BibleIndexEntry[] = new Array(verses.length);
  const textTokens = new Map<string, number[]>();

  for (let i = 0; i < verses.length; i++) {
    const verse = verses[i];
    const normText = verse.normalized_text ?? normalize(verse.text);
    entries[i] = { verse, normText };

    const tokenSet = new Set<string>();
    for (const tok of splitTokens(normText)) {
      if (tok.length >= 3) tokenSet.add(tok);
    }
    for (const tok of tokenSet) {
      const arr = textTokens.get(tok);
      if (arr) arr.push(i);
      else textTokens.set(tok, [i]);
    }
  }

  const textTokenKeys = Array.from(textTokens.keys()).sort();
  return { entries, textTokens, textTokenKeys };
}

export function searchBible(
  index: BibleSearchIndex,
  query: string,
  maxResults: number,
): BibleVerse[] {
  if (!query.trim()) return [];
  const q = normalize(query);
  if (!q) return [];

  if (q.length < 3) {
    // Full scan for short queries (matches desktop behavior)
    const results: BibleVerse[] = [];
    for (const entry of index.entries) {
      if (entry.normText.includes(q)) {
        results.push(entry.verse);
        if (results.length >= maxResults) break;
      }
    }
    return results;
  }

  const tokens = splitTokens(q);

  // AND-intersect the posting lists (with OR-union fallback when empty),
  // reusing the same logic as song search but resolved against a single
  // token map (the Bible text tokens).
  const perToken: Set<number>[] = [];
  for (const tok of tokens) {
    const lists: number[][] = [];
    collectPrefixPostings(index.textTokens, index.textTokenKeys, tok, lists);
    if (lists.length === 0) {
      perToken.push(new Set());
      continue;
    }
    const tokSet = new Set<number>();
    for (const list of lists) {
      for (const idx of list) tokSet.add(idx);
      if (tokSet.size > maxResults * 4) break;
    }
    perToken.push(tokSet);
  }

  if (perToken.length === 0) return [];
  if (perToken.length === 1) {
    const results: BibleVerse[] = [];
    for (const idx of perToken[0]) {
      const entry = index.entries[idx];
      if (!entry) continue;
      if (tokens.every((tok) => entry.normText.includes(tok))) {
        results.push(entry.verse);
        if (results.length >= maxResults) break;
      }
    }
    return results;
  }

  perToken.sort((a, b) => a.size - b.size);
  const seed = perToken[0];

  let candidateIds: number[];
  if (seed.size === 0) {
    // Intersection will be empty; per chosen strategy fall back to OR union
    // only when every token has ≥3 chars.
    if (tokens.every((t) => t.length >= 3)) {
      const union = new Set<number>();
      for (const set of perToken) {
        for (const idx of set) {
          union.add(idx);
          if (union.size >= maxResults * 4) break;
        }
        if (union.size >= maxResults * 4) break;
      }
      candidateIds = Array.from(union);
    } else {
      return [];
    }
  } else {
    const intersection = new Set<number>();
    for (const idx of seed) {
      let inAll = true;
      for (let i = 1; i < perToken.length; i++) {
        if (!perToken[i].has(idx)) { inAll = false; break; }
      }
      if (inAll) {
        intersection.add(idx);
        if (intersection.size >= maxResults * 4) break;
      }
    }
    if (intersection.size === 0 && tokens.every((t) => t.length >= 3)) {
      const union = new Set<number>();
      for (const set of perToken) {
        for (const idx of set) {
          union.add(idx);
          if (union.size >= maxResults * 4) break;
        }
        if (union.size >= maxResults * 4) break;
      }
      candidateIds = Array.from(union);
    } else {
      candidateIds = Array.from(intersection);
    }
  }

  const results: BibleVerse[] = [];
  for (const idx of candidateIds) {
    const entry = index.entries[idx];
    if (!entry) continue;
    if (tokens.every((tok) => entry.normText.includes(tok))) {
      results.push(entry.verse);
      if (results.length >= maxResults) break;
    }
  }
  return results;
}
