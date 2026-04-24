import type { BibleVerse } from './protocol';

export function compareBibleVerses(a: BibleVerse, b: BibleVerse): number {
  return (
    a.book_num - b.book_num ||
    a.chapter - b.chapter ||
    a.verse - b.verse
  );
}

export function sortBibleVerses(verses: BibleVerse[]): BibleVerse[] {
  return [...verses].sort(compareBibleVerses);
}
