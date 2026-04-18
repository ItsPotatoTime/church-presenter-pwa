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
