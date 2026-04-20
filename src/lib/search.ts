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

export function matchScore<T extends { name: string; folder?: string; slide_texts?: string[] }>(
  q: string,
  item: T,
  searchSlides: boolean,
  normCache?: Map<T, { nName: string; nFolder: string; nSlides: string[] | null }>,
): { score: number; snippet: string } {
  if (!q) return { score: 3, snippet: '' };

  let cached = normCache?.get(item);
  if (!cached) {
    cached = {
      nName: normalize(item.name),
      nFolder: normalize(item.folder ?? ''),
      nSlides: null,
    };
    normCache?.set(item, cached);
  }

  if (cached.nName.includes(q)) return { score: 3, snippet: '' };
  if (cached.nFolder.includes(q)) return { score: 2, snippet: '' };

  if (searchSlides && item.slide_texts) {
    if (!cached.nSlides) {
      cached.nSlides = item.slide_texts.map(normalize);
    }
    for (let si = 0; si < cached.nSlides.length; si++) {
      const ns = cached.nSlides[si];
      if (ns.includes(q)) {
        const nIdx = ns.indexOf(q);
        const raw = item.slide_texts[si] ?? '';
        const start = Math.max(0, nIdx - 20);
        const end = Math.min(raw.length, nIdx + q.length + 40);
        const snippet =
          (start > 0 ? '…' : '') +
          raw.slice(start, end).trim() +
          (end < raw.length ? '…' : '');
        return { score: 1, snippet };
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
  const cache = new Map<T, { nName: string; nFolder: string; nSlides: string[] | null }>();
  const results: ScoredResult<T>[] = [];

  for (const item of items) {
    const { score, snippet } = matchScore(q, item, searchSlides, cache);
    if (score > 0) {
      results.push({ item, score, snippet });
    }
    if (results.length >= maxResults) break;
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
