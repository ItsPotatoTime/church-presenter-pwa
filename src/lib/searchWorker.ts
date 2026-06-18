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
      songIndex = buildSongIndex(msg.songs);
      post({ type: 'songsIndexed', count: msg.songs.length });
      return;
    }
    case 'indexBible': {
      bibleIndex = buildBibleIndex(msg.verses);
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
