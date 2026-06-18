// Client-side inverted index mirroring the desktop's SQLite FTS5 approach.
//
// Desktop search uses two FTS5 tables (prefix + trigram) to narrow 3500+ songs
// down to a small candidate set (~1200 rowids) before running fuzzy scoring.
// This module builds the same kind of inverted index in-memory so the Web
// Worker can pre-filter candidates the same way, keeping per-keystroke work
// bounded instead of O(n_songs * fuzzy_levenshtein).

import { matchScore, normalize, type ScoredResult } from './search';
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
}

function splitTokens(text: string): string[] {
  return text ? text.split(' ').filter(Boolean) : [];
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

  return { entries, titleTokens, blobTokens };
}

/**
 * Find candidate song indices mirroring the desktop's
 * `_song_search_candidate_ids` semantics. Returns `null` to signal "do a
 * full scan" for very short queries (matches desktop behavior with
 * `len(query_norm) < 3`). Otherwise returns the union of posting-list hits
 * for each query token (prefix match on indexed tokens). Scoring still runs
 * afterwards via `matchScore`, which enforces the strict all-tokens requirement.
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

  const candidateSet = new Set<number>();

  function addPrefixMatches(map: Map<string, number[]>): void {
    for (const tok of tokens) {
      for (const [key, postings] of map.entries()) {
        if (key.length >= tok.length && key.startsWith(tok)) {
          for (const idx of postings) candidateSet.add(idx);
        }
      }
    }
  }

  addPrefixMatches(index.titleTokens);
  if (searchSlides) addPrefixMatches(index.blobTokens);

  if (candidateSet.size === 0) return [];
  let result = Array.from(candidateSet);
  if (result.length > limit) result = result.slice(0, limit);
  return result;
}

/**
 * Score the candidate set (or all entries for short queries) using the same
 * `matchScore` function the existing synchronous path uses. Only callers
 * inside the Web Worker should invoke this — it still runs `matchScore` per
 * song, but on a much smaller set than 3500.
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

  const candidateIds = findSongCandidates(index, q, searchSlides);
  const indices = candidateIds === null
    ? null
    : candidateIds;

  const cache = new Map<LibrarySong, { nName: string; nFolder: string; nSlides: string[] | null }>();
  const results: ScoredResult<LibrarySong>[] = [];

  if (indices === null) {
    for (const entry of index.entries) {
      const { score, snippet } = matchScore(q, entry.song, searchSlides, cache);
      if (score > 0) results.push({ item: entry.song, score, snippet });
    }
  } else {
    for (const i of indices) {
      const entry = index.entries[i];
      if (!entry) continue;
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

  return { entries, textTokens };
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
  const candidateSet = new Set<number>();

  for (const tok of tokens) {
    for (const [key, postings] of index.textTokens.entries()) {
      if (key.length >= tok.length && key.startsWith(tok)) {
        for (const idx of postings) candidateSet.add(idx);
      }
    }
  }

  const results: BibleVerse[] = [];
  for (const idx of candidateSet) {
    const entry = index.entries[idx];
    if (!entry) continue;
    if (tokens.every((tok) => entry.normText.includes(tok))) {
      results.push(entry.verse);
      if (results.length >= maxResults) break;
    }
  }
  return results;
}
