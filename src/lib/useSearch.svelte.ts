// Svelte 5 rune-based search hook backed by a singleton Web Worker.
//
// The worker owns the inverted indices (see searchIndex.ts) and runs every
// normalize + fuzzy-score pass off the main thread so the UI stays responsive
// even with 3500+ songs and on-the-fly Levenshtein fallbacks.
//
// The hook ALSO races a server search when the WebSocket is open. Local worker
// results fill in instantly (~50ms) while the server request runs in parallel.
// When the server replies successfully, its results override the local ones
// (server-always-wins). On timeout/failure, local results stay visible — so
// the user never sees a blank "Searching…" screen waiting on an unreachable
// desktop.
//
// There is exactly one worker per page (shared across library and lists
// routes via module-level singleton). When songsStore or bibleVersesStore
// change after a sync, the relevant $effect in this hook re-indexes by
// posting the new dataset to the worker.
//
// Each query gets a sequence number; stale worker replies from older
// keystrokes are discarded so we never show out-of-order results.
// Server replies are guarded by per-effect `cancelled` flags (Svelte 5
// runs the cleanup before each re-run).
//
// A 30-second LRU cache (size 32) keeps recent server replies so
// back-and-forth navigation between library and lists shows instant results
// without re-firing the request.

import { get } from 'svelte/store';
import type {
  BibleSearchResult,
  BibleVerse,
  LibrarySong,
  SongSearchPayload,
} from './protocol';
import type { ScoredResult } from './search';
import { normalize } from './search';
import { connStatus } from './stores';
import { remote } from './ws';

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

// ── Server result cache ────────────────────────────────────────────
//
// 30s TTL, 32-entry LRU. Keys are `${query}|${slides?1:0}` for songs and
// `${query}|text` for Bible. Values are the raw server reply (path/
// book-verse keyed) so cache hits survive song store refreshes — we resolve
// against the current items array on read.
//
// Reads move the entry to the most-recent position (Map preserves insertion
// order in JS), so frequently-used queries stay cached.

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 32;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface RawSongResult {
  path: string;
  score: number;
  snippet: string;
}

type RawBibleResult = Pick<BibleSearchResult, 'book_num' | 'chapter' | 'verse' | 'text'>;

const songCache = new Map<string, CacheEntry<RawSongResult[]>>();
const bibleCache = new Map<string, CacheEntry<RawBibleResult[]>>();

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  // Move-to-end so frequently used entries survive longer (LRU).
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function resolveSongResults(
  raw: RawSongResult[],
  items: LibrarySong[],
): ScoredResult<LibrarySong>[] {
  const byPath = new Map<string, LibrarySong>();
  for (const s of items) byPath.set(s.path, s);
  const out: ScoredResult<LibrarySong>[] = [];
  for (const r of raw) {
    const song = byPath.get(r.path);
    if (song) out.push({ item: song, score: r.score, snippet: r.snippet });
  }
  return out;
}

function bibleVersesFromRaw(raw: RawBibleResult[]): BibleVerse[] {
  return raw.map((r) => ({
    id: `${r.book_num}:${r.chapter}:${r.verse}`,
    book_num: r.book_num,
    chapter: r.chapter,
    verse: r.verse,
    text: r.text,
    normalized_text: normalize(r.text),
  }));
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
  /** Debounce window for the local worker dispatch, in ms. Defaults to 180. */
  debounceMs?: number;
  /**
   * Server search race timeout, in ms. Defaults to 3000. The local worker
   * search fires in parallel and shows results immediately; when the server
   * replies within this window, its results override the local ones. When
   * the server times out or fails, the local results stay visible. Set to 0
   * to disable the server race entirely (offline-only mode).
   */
  serverTimeoutMs?: number;
}

export interface UseSongSearchResult {
  readonly results: ScoredResult<LibrarySong>[];
  readonly pending: boolean;
  /**
   * `'server'` when the most recent results came from the desktop, `'local'`
   * when the worker is currently authoritative (server not online, server
   * timed out, or server hasn't replied yet but local has), `null` when
   * there is no active query.
   */
  readonly source: 'local' | 'server' | null;
}

/**
 * Reactive local song search backed by a Web Worker, with an optional
 * parallel server search race. Returns `{ results, pending, source }`.
 *
 * Behaviour:
 * - Empty query → returns the full items list (capped to maxResults) with
 *   zero scores, no worker round-trip, `source = null`.
 * - The worker rebuilds its inverted index whenever `items()` changes
 *   (e.g. after a sync). Searches are deferred until the worker acks.
 * - Per-keystroke: debounce → bump seq → post to worker. Stale replies are
 *   discarded by comparing the embedded seq.
 * - When the WebSocket is open AND the query is non-empty AND no cache hit
 *   exists, a `song.search` request is fired in parallel with a 3s timeout.
 *   On success it overrides the local results (server-always-wins) and
 *   populates the LRU cache. On timeout/failure, local results stay visible.
 *
 * This hook must be called from a component's `<script>` block (it uses
 * `$state` + `$effect` internally).
 */
export function useSongSearch(opts: UseSongSearchOptions): UseSongSearchResult {
  const maxResults = opts.maxResults ?? 200;
  const debounceMs = opts.debounceMs ?? 180;
  const serverTimeoutMs = opts.serverTimeoutMs ?? 3000;

  let results = $state<ScoredResult<LibrarySong>[]>([]);
  let pending = $state(false);
  // True once the worker acks an index build for the most recent items.
  // The search effect gates on this so we never show empty results for a
  // query that arrived while a re-index was still in flight.
  let indexed = $state(false);
  let source = $state<'local' | 'server' | null>(null);

  // Shallow fingerprint of the items array used to skip the structured-clone
  // + worker re-index when a sync only touched non-search-relevant fields
  // like `key` or `key_ts`. Without this guard, every delta sync would
  // re-clone ~5-10MB of songs through the structured clone, rebuild the
  // inverted index from scratch (~100-200ms), and stall the search box
  // during the rebuild window. Same songs + same modified_ts + same slide
  // counts → no rebuild needed.
  let lastItemsFingerprint = '';

  // Subscribe to worker acks for the lifetime of this hook instance.
  $effect(() => {
    const listener: SongAckListener = () => {
      indexed = true;
    };
    songAckListeners.add(listener);
    return () => {
      songAckListeners.delete(listener);
    };
  });

  // Re-index whenever the items array changes — but only if the
  // search-relevant fields actually changed. Falls through as a no-op when
  // the fingerprint matches, so sync deltas that only update song keys
  // (the common case) no longer churn the worker.
  $effect(() => {
    const songs = opts.items();
    void songs.length; // touch length so empty array swaps still re-run

    let fingerprint: string;
    if (songs.length === 0) {
      fingerprint = 'empty';
    } else {
      // Cheap to compute (~1-5ms for 3500 songs). Includes the exact slide
      // count per song so adding/removing lyrics invalidates the cache
      // while changing just `key`/`key_ts` does not.
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
      fingerprint = fp;
    }

    if (fingerprint === lastItemsFingerprint) {
      // Already indexed this exact dataset — skip the rebuild.
      return;
    }
    lastItemsFingerprint = fingerprint;

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

  // Debounced local worker search + optional parallel server race.
  $effect(() => {
    const q = opts.query().trim();
    const slides = opts.searchSlides();
    const max = maxResults;
    const items = opts.items();
    const ready = indexed;
    const online = get(connStatus) === 'open';
    const timeoutMs = serverTimeoutMs;

    let timer: number | null = null;
    let cancelled = false;

    if (!q) {
      results = items.slice(0, max).map((s) => ({ item: s, score: 0, snippet: '' }));
      pending = false;
      source = null;
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

    // Cache hit (online only — we only cache successful server replies).
    if (online) {
      const cacheKey = `${q}|${slides ? 1 : 0}`;
      const cached = cacheGet(songCache, cacheKey);
      if (cached) {
        results = resolveSongResults(cached, items);
        source = 'server';
        pending = false;
        return () => {
          cancelled = true;
        };
      }
    }

    pending = true;

    // Local worker search. Always runs so we have a baseline of results
    // even when the server is unreachable or hasn't replied yet. Debounced
    // to avoid firing on every keystroke.
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
          // Server always wins: don't override an already-applied server reply.
          if (source === 'server') return;
          results = res;
          source = 'local';
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

    // Server race. Fires in parallel with the worker search. On success
    // it overrides the local results (server-always-wins) and populates
    // the LRU cache. On timeout/failure, the local results stay visible.
    if (online && timeoutMs > 0) {
      remote
        .sendRequest('song.search', { query: q, search_slides: slides }, timeoutMs)
        .then((payload: SongSearchPayload) => {
          if (cancelled) return;
          if (!payload?.ok || !Array.isArray(payload.results)) return;
          const cacheKey = `${q}|${slides ? 1 : 0}`;
          cacheSet(songCache, cacheKey, payload.results);
          // Re-check cancelled after the (synchronous) cache write, since
          // a newer effect run may have started while we were waiting.
          if (cancelled) return;
          const serverResults = resolveSongResults(payload.results, items);
          results = serverResults;
          source = 'server';
          pending = false;
        })
        .catch(() => {
          // Server failed or timed out — local results (if any) stay visible.
        });
    }

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
    get source() {
      return source;
    },
  };
}

// ── Bible text search hook ─────────────────────────────────────────

export interface UseBibleSearchOptions {
  verses: () => BibleVerse[];
  query: () => string;
  /**
   * Reactive getter for the search mode. Only `'text'` triggers the worker
   * and the optional server race. `'reference'` mode (book/chapter/verse
   * navigation) is handled by the caller, not this hook. Defaults to
   * `'text'`.
   */
  mode?: () => 'reference' | 'text';
  maxResults?: number;
  debounceMs?: number;
  /** Server search race timeout, in ms. Defaults to 3000. Set to 0 to disable. */
  serverTimeoutMs?: number;
}

export interface UseBibleSearchResult {
  readonly results: BibleVerse[];
  readonly pending: boolean;
  readonly source: 'local' | 'server' | null;
}

/**
 * Reactive Bible text search backed by the same Web Worker as songs, with
 * an optional parallel server race. Used by the library page when the user
 * picks "search by text". Mirrors `useSongSearch`'s caching + race logic.
 */
export function useBibleSearch(opts: UseBibleSearchOptions): UseBibleSearchResult {
  const maxResults = opts.maxResults ?? 120;
  const debounceMs = opts.debounceMs ?? 180;
  const serverTimeoutMs = opts.serverTimeoutMs ?? 3000;

  let results = $state<BibleVerse[]>([]);
  let pending = $state(false);
  let indexed = $state(false);
  let source = $state<'local' | 'server' | null>(null);
  // Bible verses are immutable for a given bible_version, so the diff-guard
  // is coarse: we cache on (count, first-id, last-id) rather than hashing
  // every verse. Bible re-sync very rarely changes a small subset of verses
  // (which is captured by bible_version), so when the same count + boundary
  // ids arrive we skip the re-index.
  let lastVersesFingerprint = '';

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

    let fingerprint: string;
    if (verses.length === 0) {
      fingerprint = 'empty';
    } else {
      const first = verses[0];
      const last = verses[verses.length - 1];
      fingerprint = `${verses.length}|${first.id ?? first.book_num ?? ''}:${first.chapter}:${first.verse}|${last.id ?? last.book_num ?? ''}:${last.chapter}:${last.verse}`;
    }

    if (fingerprint === lastVersesFingerprint) {
      return;
    }
    lastVersesFingerprint = fingerprint;

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
    const mode = opts.mode ? opts.mode() : 'text';
    const max = maxResults;
    const online = get(connStatus) === 'open';
    const timeoutMs = serverTimeoutMs;
    const ready = indexed;

    let timer: number | null = null;
    let cancelled = false;

    if (!q || mode !== 'text') {
      results = [];
      pending = false;
      source = null;
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

    if (online) {
      const cacheKey = `${q}|${mode}`;
      const cached = cacheGet(bibleCache, cacheKey);
      if (cached) {
        results = bibleVersesFromRaw(cached);
        source = 'server';
        pending = false;
        return () => {
          cancelled = true;
        };
      }
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
          if (source === 'server') return;
          results = res;
          source = 'local';
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

    if (online && timeoutMs > 0) {
      remote
        .sendRequest('bible.search', { query: q, mode: 'text', limit: max }, timeoutMs)
        .then((payload: { ok?: boolean; results?: BibleSearchResult[] }) => {
          if (cancelled) return;
          if (!payload?.ok || !Array.isArray(payload.results)) return;
          const raw: RawBibleResult[] = payload.results.map((r) => ({
            book_num: r.book_num,
            chapter: r.chapter,
            verse: r.verse,
            text: r.text,
          }));
          const cacheKey = `${q}|${mode}`;
          cacheSet(bibleCache, cacheKey, raw);
          if (cancelled) return;
          results = bibleVersesFromRaw(raw);
          source = 'server';
          pending = false;
        })
        .catch(() => {
          // Local results stay visible on failure/timeout.
        });
    }

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
    get source() {
      return source;
    },
  };
}
