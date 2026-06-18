// Search normalization mirrors desktop Python smart_search.normalize().

const PUNCT_RE = /[^\p{L}\p{N}\s]+/gu;
const PUNCT_CHAR_RE = /[^\p{L}\p{N}\s]/u;
const WS_RE = /\s+/g;
const MN_RE = /\p{Mn}+/gu;
const BOLD_RE = /\*\*(.+?)\*\*/g;

export function normalize(s: string): string {
  if (!s) return '';
  return s
    .normalize('NFD')
    .toLowerCase()
    .replace(MN_RE, '')
    .replace(PUNCT_RE, ' ')
    .replace(WS_RE, ' ')
    .trim();
}

function compact(s: string): string {
  return s.replaceAll(' ', '');
}

/** Convert **bold** markers to <b>bold</b>. Input is HTML-escaped first so it is XSS-safe. */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  if (!text.includes('**')) return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(BOLD_RE, '<b>$1</b>');
}

export default renderMarkdown;

export type ScoredResult<T> = {
  item: T;
  score: number;
  snippet: string;
};

export type NormCache = {
  nName: string;
  nFolder: string;
  nSlides: string[] | null;
  /** Pre-split words of `nName`. Filled lazily; null = not yet computed. */
  nNameWords: string[] | null;
  /** Pre-split words of `nFolder`. Filled lazily; null = not yet computed. */
  nFolderWords: string[] | null;
  /** Pre-split words of each slide in `nSlides`. Lazily aligned with nSlides. */
  nSlideWords: (string[] | null)[] | null;
};

function words(text: string): string[] {
  return text ? text.split(' ') : [];
}

function allTokensPresent(tokens: string[], text: string): boolean {
  return tokens.length > 0 && tokens.every((token) => text.includes(token));
}

function allTokensWordPrefix(tokens: string[], text: string): boolean {
  const textWords = words(text);
  return tokens.length > 0 && tokens.every((token) => textWords.some((word) => word.startsWith(token)));
}

function allTokensWordPrefixCached(tokens: string[], textWords: string[]): boolean {
  return tokens.length > 0 && tokens.every((token) => textWords.some((word) => word.startsWith(token)));
}

function contiguousTokensWordPrefix(tokens: string[], text: string): boolean {
  const textWords = words(text);
  if (tokens.length === 0 || textWords.length < tokens.length) return false;
  for (let start = 0; start <= textWords.length - tokens.length; start++) {
    if (tokens.every((token, offset) => textWords[start + offset].startsWith(token))) return true;
  }
  return false;
}

function contiguousTokensWordPrefixCached(tokens: string[], textWords: string[]): boolean {
  if (tokens.length === 0 || textWords.length < tokens.length) return false;
  for (let start = 0; start <= textWords.length - tokens.length; start++) {
    if (tokens.every((token, offset) => textWords[start + offset].startsWith(token))) return true;
  }
  return false;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function ratio(a: string, b: string): number {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 100 : ((maxLen - levenshtein(a, b)) / maxLen) * 100;
}

function partialRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.length > b.length) [a, b] = [b, a];
  if (b.includes(a)) return 100;
  const window = a.length;
  let best = 0;
  const step = b.length > 240 ? 2 : 1;
  for (let start = 0; start <= Math.max(0, b.length - window); start += step) {
    best = Math.max(best, ratio(a, b.slice(start, start + window)));
    if (best >= 100) break;
  }
  return best;
}

function tokenSetRatio(a: string, b: string): number {
  const aTokens = new Set(words(a));
  const bTokens = new Set(words(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap++;
  }
  return (overlap / new Set([...aTokens, ...bTokens]).size) * 100;
}

function wrRatio(a: string, b: string): number {
  return Math.max(ratio(a, b), partialRatio(a, b), tokenSetRatio(a, b));
}

function bestWordRatio(query: string, text: string): number {
  const q = compact(query);
  if (q.length < 4) return 0;
  let best = 0;
  for (const word of words(text)) {
    if (Math.abs(word.length - q.length) <= Math.max(2, Math.floor(q.length / 4))) {
      best = Math.max(best, ratio(q, word));
    }
  }
  return best;
}

function textScore(
  text: string,
  q: string,
  tokens: string[],
  weights: [number, number, number, number, number, number],
  fuzzy = true,
  orderedTokens = false,
): number {
  const [exact, starts, wordPrefix, contains, allPrefixes, allTokens] = weights;
  if (!text || !q) return 0;
  if (text === q) return exact;
  if (text.startsWith(q)) return starts;
  const textWords = words(text);
  if (textWords.some((word) => word.startsWith(q))) return wordPrefix;
  if (text.includes(q)) return contains;

  const qCompact = compact(q);
  const textCompact = compact(text);
  if (qCompact.length >= 4 && textCompact.includes(qCompact)) return Math.max(1, contains - 8);

  if (tokens.length > 1) {
    if (contiguousTokensWordPrefixCached(tokens, textWords)) return allPrefixes;
    if (!orderedTokens && allTokensWordPrefixCached(tokens, textWords)) return Math.max(1, allPrefixes - 8);
    if (!orderedTokens && allTokensPresent(tokens, text)) return allTokens;
  }

  if (!fuzzy || qCompact.length < 4) return 0;

  const fuzzyCeiling = Math.max(1, allTokens - 1);
  const fuzzyFloor = Math.max(1, allTokens - 90);
  let best: number;
  let threshold: number;
  if (tokens.length <= 1) {
    best = Math.max(bestWordRatio(q, text), partialRatio(qCompact, textCompact));
    threshold = qCompact.length <= 6 ? 82 : 78;
  } else if (orderedTokens) {
    best = Math.max(partialRatio(q, text), partialRatio(qCompact, textCompact));
    threshold = tokens.length >= 4 ? 72 : 78;
  } else {
    best = Math.max(wrRatio(q, text), tokenSetRatio(q, text));
    threshold = tokens.length >= 4 ? 74 : 78;
  }
  if (best < threshold) return 0;
  return Math.min(
    fuzzyCeiling,
    Math.max(fuzzyFloor, fuzzyFloor + Math.floor(((best - threshold) * (fuzzyCeiling - fuzzyFloor)) / Math.max(1, 100 - threshold))),
  );
}

function textScoreCached(
  text: string,
  q: string,
  tokens: string[],
  weights: [number, number, number, number, number, number],
  textWords: string[],
  fuzzy = true,
  orderedTokens = false,
): number {
  const [exact, starts, wordPrefix, contains, allPrefixes, allTokens] = weights;
  if (!text || !q) return 0;
  if (text === q) return exact;
  if (text.startsWith(q)) return starts;
  if (textWords.some((word) => word.startsWith(q))) return wordPrefix;
  if (text.includes(q)) return contains;

  const qCompact = compact(q);
  const textCompact = compact(text);
  if (qCompact.length >= 4 && textCompact.includes(qCompact)) return Math.max(1, contains - 8);

  if (tokens.length > 1) {
    if (contiguousTokensWordPrefixCached(tokens, textWords)) return allPrefixes;
    if (!orderedTokens && allTokensWordPrefixCached(tokens, textWords)) return Math.max(1, allPrefixes - 8);
    if (!orderedTokens && allTokensPresent(tokens, text)) return allTokens;
  }

  if (!fuzzy || qCompact.length < 4) return 0;

  const fuzzyCeiling = Math.max(1, allTokens - 1);
  const fuzzyFloor = Math.max(1, allTokens - 90);
  let best: number;
  let threshold: number;
  if (tokens.length <= 1) {
    best = Math.max(bestWordRatio(q, text), partialRatio(qCompact, textCompact));
    threshold = qCompact.length <= 6 ? 82 : 78;
  } else if (orderedTokens) {
    best = Math.max(partialRatio(q, text), partialRatio(qCompact, textCompact));
    threshold = tokens.length >= 4 ? 72 : 78;
  } else {
    best = Math.max(wrRatio(q, text), tokenSetRatio(q, text));
    threshold = tokens.length >= 4 ? 74 : 78;
  }
  if (best < threshold) return 0;
  return Math.min(
    fuzzyCeiling,
    Math.max(fuzzyFloor, fuzzyFloor + Math.floor(((best - threshold) * (fuzzyCeiling - fuzzyFloor)) / Math.max(1, 100 - threshold))),
  );
}

function slideTextScore(text: string, q: string, tokens: string[], textWords?: string[]): number {
  if (tokens.length <= 1) {
    return textWords
      ? textScoreCached(text, q, tokens, [300, 290, 280, 270, 260, 250], textWords)
      : textScore(text, q, tokens, [300, 290, 280, 270, 260, 250]);
  }
  return textWords
    ? textScoreCached(text, q, tokens, [300, 285, 275, 270, 260, 250], textWords, true, true)
    : textScore(text, q, tokens, [300, 285, 275, 270, 260, 250], true, true);
}

function normalizeWithMap(raw: string): { text: string; offsets: number[] } {
  const chars: string[] = [];
  const offsets: number[] = [];
  let lastSpace = true;
  let rawIndex = 0;

  for (const ch of raw) {
    if (ch === '\u200b') {
      rawIndex += ch.length;
      continue;
    }
    const normalized = ch.normalize('NFD').toLowerCase().replace(MN_RE, '');
    for (const part of normalized) {
      const out = PUNCT_CHAR_RE.test(part) ? ' ' : part;
      if (/\s/u.test(out)) {
        if (!lastSpace) {
          chars.push(' ');
          offsets.push(rawIndex);
          lastSpace = true;
        }
      } else {
        chars.push(out);
        offsets.push(rawIndex);
        lastSpace = false;
      }
    }
    rawIndex += ch.length;
  }

  if (chars[chars.length - 1] === ' ') {
    chars.pop();
    offsets.pop();
  }
  return { text: chars.join(''), offsets };
}

function snippetForMatch(raw: string, q: string, tokens: string[]): string {
  const mapped = normalizeWithMap(raw);
  if (!mapped.text || mapped.offsets.length === 0) return '';

  let idx = mapped.text.indexOf(q);
  let matchLength = q.length;
  if (idx < 0) {
    const hits = tokens
      .map((token) => ({ idx: mapped.text.indexOf(token), token }))
      .filter((hit) => hit.idx >= 0);
    if (hits.length === 0) return '';
    hits.sort((a, b) => a.idx - b.idx);
    idx = hits[0].idx;
    matchLength = hits[0].token.length;
  }

  const rawStart = mapped.offsets[Math.max(0, idx)] ?? 0;
  const rawEndIdx = Math.min(mapped.offsets.length - 1, idx + Math.max(matchLength, 1) - 1);
  const rawEnd = (mapped.offsets[rawEndIdx] ?? rawStart) + 1;
  const start = Math.max(0, rawStart - 20);
  const end = Math.min(raw.length, rawEnd + 40);
  return (start > 0 ? '...' : '') + raw.slice(start, end).trim() + (end < raw.length ? '...' : '');
}

export function matchScore<
  T extends {
    name: string;
    folder?: string;
    slide_texts?: string[];
    normalized_name?: string;
    normalized_folder?: string;
    normalized_blob?: string;
    _norm_name?: string;
    _norm_folder?: string;
    _norm_blob?: string;
  },
>(
  q: string,
  item: T,
  searchSlides: boolean,
  normCache?: Map<T, NormCache>,
): { score: number; snippet: string } {
  if (!q) return { score: 700, snippet: '' };
  const tokens = q.split(' ').filter(Boolean);

  let cached = normCache?.get(item);
  if (!cached) {
    const normalizedBlob = item.normalized_blob ?? item._norm_blob;
    cached = {
      nName: item.normalized_name ?? item._norm_name ?? normalize(item.name),
      nFolder: item.normalized_folder ?? item._norm_folder ?? normalize(item.folder ?? ''),
      nSlides: normalizedBlob ? normalizedBlob.split(' | ') : null,
      nNameWords: null,
      nFolderWords: null,
      nSlideWords: null,
    };
    normCache?.set(item, cached);
  }

  const nameWords = cached.nNameWords ?? (cached.nNameWords = words(cached.nName));
  let score = textScoreCached(cached.nName, q, tokens, [700, 680, 660, 640, 620, 600], nameWords);
  if (score) return { score, snippet: '' };

  const folderWords = cached.nFolderWords ?? (cached.nFolderWords = words(cached.nFolder));
  score = textScoreCached(cached.nFolder, q, tokens, [500, 480, 460, 440, 420, 400], folderWords);
  if (score) return { score, snippet: '' };

  if (searchSlides && item.slide_texts) {
    const normalizedBlob = item.normalized_blob ?? item._norm_blob;
    if (tokens.length <= 1 && compact(q).length < 4 && normalizedBlob && !normalizedBlob.includes(q)) {
      return { score: 0, snippet: '' };
    }

    if (!cached.nSlides) {
      cached.nSlides = normalizedBlob ? normalizedBlob.split(' | ') : item.slide_texts.map(normalize);
      cached.nSlideWords = null;
    }
    let slideWords = cached.nSlideWords;
    if (!slideWords) {
      slideWords = new Array(cached.nSlides.length).fill(null);
      cached.nSlideWords = slideWords;
    }
    for (let si = 0; si < cached.nSlides.length; si++) {
      const ns = cached.nSlides[si];
      let sw = slideWords[si];
      if (!sw) {
        sw = words(ns);
        slideWords[si] = sw;
      }
      score = slideTextScore(ns, q, tokens, sw);
      if (score) {
        const raw = item.slide_texts[si] ?? '';
        return { score, snippet: snippetForMatch(raw, q, tokens) };
      }
    }
  }

  return { score: 0, snippet: '' };
}

export function filterSongs<T extends { name: string; folder?: string; slide_texts?: string[] }>(
  query: string,
  items: T[],
  searchSlides: boolean,
  maxResults = 200,
): ScoredResult<T>[] {
  if (!query.trim()) return items.map((item) => ({ item, score: 0, snippet: '' }));

  const q = normalize(query);
  const cache = new Map<T, NormCache>();
  const results: ScoredResult<T>[] = [];

  for (const item of items) {
    const { score, snippet } = matchScore(q, item, searchSlides, cache);
    if (score > 0) results.push({ item, score, snippet });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}
