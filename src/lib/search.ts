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
