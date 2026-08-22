// Web Worker that owns the song and Bible inverted indices.
//
// Communication protocol (all messages are plain objects posted via postMessage):
//
//   Inbound
//   - { type: 'indexSongs', songs: LibrarySong[] }
//   - { type: 'indexBible', verses: BibleVerse[] }
//   - { type: 'searchSongs', seq: number, query: string,
//       searchSlides: boolean, maxResults: number }
//   - { type: 'searchBible', seq: number, query: string, maxResults: number }
//
//   Outbound
//   - { type: 'songsIndexed', count: number }
//   - { type: 'bibleIndexed', count: number }
//   - { type: 'searchResults', seq: number, results: ScoredResult<LibrarySong>[] }
//   - { type: 'bibleResults', seq: number, results: BibleVerse[] }
//
// The seq field lets the caller discard stale search results when the user
// types another character before the previous query finishes.
//
// indexSongs/indexBible are idempotent: the worker fingerprints the incoming
// dataset against the one it already holds (the hook computes the same
// fingerprint, but multiple hook instances share this worker, so a remount
// would otherwise re-clone multi-MB arrays for nothing). An unchanged dataset
// acks immediately without rebuilding.

/// <reference lib="webworker" />

import type { BibleVerse, LibrarySong } from './protocol';
import type { ScoredResult } from './search';
import {
  buildBibleIndex,
  buildSongIndex,
  searchBible,
  searchSongs,
  type BibleSearchIndex,
  type SongSearchIndex,
} from './searchIndex';

let songIndex: SongSearchIndex | null = null;
let bibleIndex: BibleSearchIndex | null = null;
// Fingerprints of the datasets the CURRENT indices were built from. The hooks
// compute the same strings; when they match, the postMessage payload is
// identical data the worker already holds and the rebuild is skipped.
let songIndexFingerprint = '';
let bibleIndexFingerprint = '';

/** Cheap search-relevance fingerprint: path + modified_ts + slide count. */
export function fingerprintSongs(songs: LibrarySong[]): string {
  if (songs.length === 0) return 'empty';
  let fp = songs.length.toString();
  for (let i = 0; i < songs.length; i++) {
    const s = songs[i];
    fp += '|';
    fp += s.path;
    fp += ':';
    fp += s.modified_ts ?? 0;
    fp += ':';
    fp += s.slide_texts?.length ?? 0;
  }
  return fp;
}

/** Coarse fingerprint: count + first/last verse identity (see useSearch). */
export function fingerprintVerses(verses: BibleVerse[]): string {
  if (verses.length === 0) return 'empty';
  const first = verses[0];
  const last = verses[verses.length - 1];
  return `${verses.length}|${first.id ?? first.book_num ?? ''}:${first.chapter}:${first.verse}|${last.id ?? last.book_num ?? ''}:${last.chapter}:${last.verse}`;
}

interface IndexSongsMessage {
  type: 'indexSongs';
  songs: LibrarySong[];
}

interface IndexBibleMessage {
  type: 'indexBible';
  verses: BibleVerse[];
}

interface SearchSongsMessage {
  type: 'searchSongs';
  seq: number;
  query: string;
  searchSlides: boolean;
  maxResults: number;
}

interface SearchBibleMessage {
  type: 'searchBible';
  seq: number;
  query: string;
  maxResults: number;
}

type Inbound =
  | IndexSongsMessage
  | IndexBibleMessage
  | SearchSongsMessage
  | SearchBibleMessage;

interface SongsIndexedMessage {
  type: 'songsIndexed';
  count: number;
}
interface BibleIndexedMessage {
  type: 'bibleIndexed';
  count: number;
}
interface SearchResultsMessage {
  type: 'searchResults';
  seq: number;
  results: ScoredResult<LibrarySong>[];
}
interface BibleResultsMessage {
  type: 'bibleResults';
  seq: number;
  results: BibleVerse[];
}

type Outbound =
  | SongsIndexedMessage
  | BibleIndexedMessage
  | SearchResultsMessage
  | BibleResultsMessage;

function post(message: Outbound): void {
  (self as unknown as Worker).postMessage(message);
}

self.onmessage = (event: MessageEvent<Inbound>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'indexSongs': {
      const fp = fingerprintSongs(msg.songs);
      if (songIndex && fp === songIndexFingerprint) {
        post({ type: 'songsIndexed', count: msg.songs.length });
        return;
      }
      songIndex = buildSongIndex(msg.songs);
      songIndexFingerprint = fp;
      post({ type: 'songsIndexed', count: msg.songs.length });
      return;
    }
    case 'indexBible': {
      const fp = fingerprintVerses(msg.verses);
      if (bibleIndex && fp === bibleIndexFingerprint) {
        post({ type: 'bibleIndexed', count: msg.verses.length });
        return;
      }
      bibleIndex = buildBibleIndex(msg.verses);
      bibleIndexFingerprint = fp;
      post({ type: 'bibleIndexed', count: msg.verses.length });
      return;
    }
    case 'searchSongs': {
      if (!songIndex) {
        post({ type: 'searchResults', seq: msg.seq, results: [] });
        return;
      }
      const results = searchSongs(songIndex, msg.query, msg.searchSlides, msg.maxResults);
      post({ type: 'searchResults', seq: msg.seq, results });
      return;
    }
    case 'searchBible': {
      if (!bibleIndex) {
        post({ type: 'bibleResults', seq: msg.seq, results: [] });
        return;
      }
      const results = searchBible(bibleIndex, msg.query, msg.maxResults);
      post({ type: 'bibleResults', seq: msg.seq, results });
      return;
    }
  }
};
