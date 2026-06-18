// Svelte 5 rune-based search hook backed by a singleton Web Worker.
//
// The worker owns the inverted indices (see searchIndex.ts) and runs every
// normalize + fuzzy-score pass off the main thread so the UI stays responsive
// even with 3500+ songs and on-the-fly Levenshtein fallbacks.
//
// There is exactly one worker per page (shared across library and lists
// routes via module-level singleton). When songsStore or bibleVersesStore
// change after a sync, the relevant $effect in this hook re-indexes by
// posting the new dataset to the worker.
//
// Each query gets a sequence number; stale worker replies from older
// keystrokes are discarded so we never show out-of-order results.

import type { BibleVerse, LibrarySong } from './protocol';
import type { ScoredResult } from './search';

// ── Worker singleton ───────────────────────────────────────────────

let workerPromise: Promise<Worker | null> | null = null;

type SongAckListener = (count: number) => void;
type BibleAckListener = (count: number) => void;
type SongSearchCallback = (results: ScoredResult<LibrarySong>[]) => void;
type BibleSearchCallback = (results: BibleVerse[]) => void;

/**
 * Listeners fired when the worker acks an index build. Multiple hook
 * instances subscribe so any of them can flip their local `indexed` flag.
 */
const songAckListeners = new Set<SongAckListener>();
const bibleAckListeners = new Set<BibleAckListener>();

const songSearchCallbacks = new Map<number, SongSearchCallback>();
const bibleSearchCallbacks = new Map<number, BibleSearchCallback>();

let songSearchSeq = 0;
let bibleSearchSeq = 0;

function getWorker(): Promise<Worker | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (workerPromise) return workerPromise;

  workerPromise = new Promise<Worker | null>((resolve) => {
    try {
      const w = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });

      w.onmessage = (ev: MessageEvent) => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;

        switch (msg.type) {
          case 'songsIndexed': {
            const count = msg.count as number;
            for (const listener of songAckListeners) {
              try {
                listener(count);
              } catch (err) {
                console.error('[useSearch] song ack listener threw:', err);
              }
            }
            return;
          }
          case 'bibleIndexed': {
            const count = msg.count as number;
            for (const listener of bibleAckListeners) {
              try {
                listener(count);
              } catch (err) {
                console.error('[useSearch] bible ack listener threw:', err);
              }
            }
            return;
          }
          case 'searchResults': {
            const cb = songSearchCallbacks.get(msg.seq as number);
            if (cb) {
              songSearchCallbacks.delete(msg.seq as number);
              cb(msg.results as ScoredResult<LibrarySong>[]);
            }
            return;
          }
          case 'bibleResults': {
            const cb = bibleSearchCallbacks.get(msg.seq as number);
            if (cb) {
              bibleSearchCallbacks.delete(msg.seq as number);
              cb(msg.results as BibleVerse[]);
            }
            return;
          }
        }
      };

      w.onerror = (err) => {
        console.error('[useSearch] worker error:', err);
      };

      resolve(w);
    } catch (err) {
      console.error('[useSearch] Failed to spawn worker:', err);
      resolve(null);
    }
  });

  return workerPromise;
}

// ── Song search hook ───────────────────────────────────────────────

export interface UseSongSearchOptions {
  /** Reactive getter for the song library. Re-indexes whenever the returned array reference changes. */
  items: () => LibrarySong[];
  /** Reactive getter for the debounced query string. */
  query: () => string;
  /** Reactive getter for the "search inside slide texts" toggle. */
  searchSlides: () => boolean;
  /** Hard cap on result count. Defaults to 200. */
  maxResults?: number;
  /** Debounce window in ms. Defaults to 180. */
  debounceMs?: number;
}

export interface UseSongSearchResult {
  readonly results: ScoredResult<LibrarySong>[];
  readonly pending: boolean;
}

/**
 * Reactive local song search backed by a Web Worker. Returns `{ results, pending }`.
 *
 * - When `query()` is empty: returns the full items list (capped to maxResults)
 *   with zero scores, no worker round-trip.
 * - When the underlying items() array changes (e.g. after a sync): the worker
 *   rebuilds its inverted index in the background; `pending` stays true and
 *   search replies are deferred until the worker acks the new index.
 * - Per-keystroke: debounce -> bump seq -> post to worker. Stale replies
 *   are discarded by comparing the embedded seq.
 *
 * This hook must be called from a component's `<script>` block (it uses
 * $state + $effect internally).
 */
export function useSongSearch(opts: UseSongSearchOptions): UseSongSearchResult {
  const maxResults = opts.maxResults ?? 200;
  const debounceMs = opts.debounceMs ?? 180;

  let results = $state<ScoredResult<LibrarySong>[]>([]);
  let pending = $state(false);
  // True once the worker acks an index build for the most recent items.
  // The search effect gates on this so we never show empty results for a
  // query that arrived while a re-index was still in flight.
  let indexed = $state(false);

  // Subscribe to worker acks for the lifetime of this hook instance.
  // The worker processes messages in FIFO order, so any songsIndexed ack
  // means the most recent indexSongs post is in place.
  $effect(() => {
    const listener: SongAckListener = () => {
      indexed = true;
    };
    songAckListeners.add(listener);
    return () => {
      songAckListeners.delete(listener);
    };
  });

  // Re-index whenever the songs array changes. We mark `indexed = false`
  // up front so the search effect doesn't fire against stale data.
  $effect(() => {
    const songs = opts.items();
    void songs.length; // touch length so empty array swaps still re-run
    indexed = false;
    let cancelled = false;
    getWorker().then((w) => {
      if (!w || cancelled) return;
      w.postMessage({ type: 'indexSongs', songs });
    });
    return () => {
      cancelled = true;
    };
  });

  // Debounced search.
  $effect(() => {
    const q = opts.query().trim();
    const slides = opts.searchSlides();
    const max = maxResults;
    const items = opts.items();
    const ready = indexed; // tracking: re-run when indexed flips

    let timer: number | null = null;
    let cancelled = false;

    if (!q) {
      results = items.slice(0, max).map((s) => ({ item: s, score: 0, snippet: '' }));
      pending = false;
      return () => {
        cancelled = true;
      };
    }

    if (!ready) {
      // Index (re)build in flight — surface pending state without firing a
      // search that would race the rebuild. When `indexed` flips true,
      // this effect re-runs and proceeds.
      pending = true;
      return () => {
        cancelled = true;
      };
    }

    pending = true;
    timer = window.setTimeout(() => {
      if (cancelled) return;
      void getWorker().then((w) => {
        if (cancelled || !w) {
          pending = false;
          return;
        }
        const seq = ++songSearchSeq;
        songSearchCallbacks.set(seq, (res) => {
          if (cancelled || seq !== songSearchSeq) return;
          results = res;
          pending = false;
        });
        w.postMessage({
          type: 'searchSongs',
          seq,
          query: q,
          searchSlides: slides,
          maxResults: max,
        });
      });
    }, debounceMs);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  });

  return {
    get results() {
      return results;
    },
    get pending() {
      return pending;
    },
  };
}

// ── Bible text search hook ─────────────────────────────────────────

export interface UseBibleSearchOptions {
  verses: () => BibleVerse[];
  query: () => string;
  maxResults?: number;
  debounceMs?: number;
}

export interface UseBibleSearchResult {
  readonly results: BibleVerse[];
  readonly pending: boolean;
}

/**
 * Reactive Bible text search backed by the same Web Worker as songs.
 * Used by the library page when the user picks "search by text" and the
 * desktop server is unreachable or has not returned yet.
 */
export function useBibleSearch(opts: UseBibleSearchOptions): UseBibleSearchResult {
  const maxResults = opts.maxResults ?? 120;
  const debounceMs = opts.debounceMs ?? 180;

  let results = $state<BibleVerse[]>([]);
  let pending = $state(false);
  let indexed = $state(false);

  $effect(() => {
    const listener: BibleAckListener = () => {
      indexed = true;
    };
    bibleAckListeners.add(listener);
    return () => {
      bibleAckListeners.delete(listener);
    };
  });

  $effect(() => {
    const verses = opts.verses();
    void verses.length;
    indexed = false;
    let cancelled = false;
    getWorker().then((w) => {
      if (!w || cancelled) return;
      w.postMessage({ type: 'indexBible', verses });
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const q = opts.query().trim();
    const max = maxResults;
    const ready = indexed;

    let timer: number | null = null;
    let cancelled = false;

    if (!q) {
      results = [];
      pending = false;
      return () => {
        cancelled = true;
      };
    }

    if (!ready) {
      pending = true;
      return () => {
        cancelled = true;
      };
    }

    pending = true;
    timer = window.setTimeout(() => {
      if (cancelled) return;
      void getWorker().then((w) => {
        if (cancelled || !w) {
          pending = false;
          return;
        }
        const seq = ++bibleSearchSeq;
        bibleSearchCallbacks.set(seq, (res) => {
          if (cancelled || seq !== bibleSearchSeq) return;
          results = res;
          pending = false;
        });
        w.postMessage({
          type: 'searchBible',
          seq,
          query: q,
          maxResults: max,
        });
      });
    }, debounceMs);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  });

  return {
    get results() {
      return results;
    },
    get pending() {
      return pending;
    },
  };
}
