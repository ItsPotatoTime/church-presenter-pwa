// Search normalization — mirrors Python `search.normalize()` so queries
// behave identically on desktop and phone.
//
// Rules:
//   • lowercase
//   • strip combining diacritics (NFD, drop Mn category)
//   • replace punctuation (anything not letter/digit/space) with a space
//   • collapse runs of whitespace
// Result: "Cântați, cântați" → "cantati cantati", matching user query "cantati cantati".

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

export type ScoredResult<T> = {
  item: T;
  score: number;
  snippet: string;
};

type NormCache = { nName: string; nFolder: string; nSlides: string[] | null };

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

function textScore(
  text: string,
  q: string,
  tokens: string[],
  weights: [number, number, number, number, number, number],
): number {
  const [exact, starts, wordPrefix, contains, allPrefixes, allTokens] = weights;
  if (!text) return 0;
  if (text === q) return exact;
  if (text.startsWith(q)) return starts;
  if (words(text).some((word) => word.startsWith(q))) return wordPrefix;
  if (text.includes(q)) return contains;
  if (tokens.length > 1 && allTokensWordPrefix(tokens, text)) return allPrefixes;
  if (tokens.length > 1 && allTokensPresent(tokens, text)) return allTokens;
  return 0;
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
  return (start > 0 ? '…' : '') + raw.slice(start, end).trim() + (end < raw.length ? '…' : '');
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
  }
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
    };
    normCache?.set(item, cached);
  }

  let score = textScore(cached.nName, q, tokens, [700, 680, 660, 640, 620, 600]);
  if (score) return { score, snippet: '' };

  score = textScore(cached.nFolder, q, tokens, [500, 480, 460, 440, 420, 400]);
  if (score) return { score, snippet: '' };

  if (searchSlides && item.slide_texts) {
    const normalizedBlob = item.normalized_blob ?? item._norm_blob;
    // Fast rejection check using pre-normalized blob
    if (normalizedBlob && !normalizedBlob.includes(q) && !allTokensPresent(tokens, normalizedBlob)) {
      return { score: 0, snippet: '' };
    }

    if (!cached.nSlides) {
      cached.nSlides = normalizedBlob
        ? normalizedBlob.split(' | ')
        : item.slide_texts.map(normalize);
    }
    for (let si = 0; si < cached.nSlides.length; si++) {
      const ns = cached.nSlides[si];
      score = textScore(ns, q, tokens, [300, 290, 280, 270, 260, 250]);
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
    if (score > 0) {
      results.push({ item, score, snippet });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}
