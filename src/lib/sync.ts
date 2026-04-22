// Delta-sync orchestrator. Talks to the desktop via `remote.send()` using
// a request-id so the response can be awaited. Applies results to IndexedDB
// + Svelte stores.

import { remote } from './ws';
import { get } from 'svelte/store';
import {
  clearBibleBooks,
  clearBibleVerses,
  deleteSongsByPath,
  getAllSongPaths,
  getBibleVersion,
  getCachedQueueState,
  getLastSyncTs,
  loadAllBibleBooks,
  loadAllBibleVerses,
  loadAllLists,
  loadAllSongs,
  putBibleBooks,
  putBibleVerses,
  putLists,
  putSongs,
  setBibleVersion,
  setLastSyncTs,
  snapshotServerData,
  getActiveServerKey,
} from './db';
import type { SyncDelta, SyncFull } from './protocol';
import {
  bibleBooksStore,
  bibleVersesStore,
  bibleVersionStore,
  listsStore,
  queueState,
  songsStore,
  syncStatus,
} from './stores';

type PendingResolver = (msg: { type: string; payload: any }) => void;

const pending = new Map<string, PendingResolver>();

/** Called by ws.ts whenever a sync.* message arrives. */
export function handleSyncMessage(msg: { type: string; id?: string; payload: any }): void {
  if (!msg.id) return; // unsolicited — ignore
  const resolver = pending.get(msg.id);
  if (resolver) {
    pending.delete(msg.id);
    resolver(msg);
  }
}

function requestSync(sinceTs: number): Promise<{ type: string; payload: any }> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, resolve);
    // 15s timeout (library could be large on first sync)
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('sync timed out'));
    }, 15000);
    const clearOnResolve = (resolveWrapped: PendingResolver) => (m: any) => {
      clearTimeout(timer);
      resolveWrapped(m);
    };
    pending.set(id, clearOnResolve(resolve));
    try {
      remote.sendRaw({
        type: 'sync.request',
        id,
        payload: { since_ts: sinceTs },
      });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

/** Force a full resync regardless of cached timestamp — use when slides look stale. */
export async function syncFull(): Promise<void> {
  return _doSync(0);
}

/** Perform a delta or full sync against the desktop and update IndexedDB + stores. */
export async function syncNow(): Promise<void> {
  return _doSync(await getLastSyncTs());
}

export function isReducedDataConnection(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (!connection) return false;
  if (connection.saveData) return true;
  return connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g';
}

async function _doSync(since: number): Promise<void> {
  syncStatus.set('syncing');
  try {
    const resp = await requestSync(since);
    let songs = get(songsStore);
    let lists = get(listsStore);
    let bibleBooks = get(bibleBooksStore);
    let bibleVerses = get(bibleVersesStore);
    let bibleVersion = get(bibleVersionStore);

    if (resp.type === 'sync.full') {
      const p = resp.payload as SyncFull;
      // Full replace
      const currentPaths = await getAllSongPaths();
      if (currentPaths.length) await deleteSongsByPath(currentPaths);
      await putSongs(p.songs);
      await putLists(p.lists);
      await clearBibleBooks();
      await clearBibleVerses();
      if (p.bible) {
        await putBibleBooks(p.bible.books);
        await putBibleVerses(p.bible.verses);
        await setBibleVersion(p.bible.version);
        bibleBooks = p.bible.books;
        bibleVerses = p.bible.verses;
        bibleVersion = p.bible.version;
      } else {
        bibleVersion = await getBibleVersion();
      }
      if (!p.bible) {
        bibleBooks = [];
        bibleVerses = [];
      }
      await setLastSyncTs(p.server_ts);
      songs = p.songs;
      lists = p.lists;
    } else if (resp.type === 'sync.delta') {
      const p = resp.payload as SyncDelta;
      if (p.songs_changed.length) await putSongs(p.songs_changed);
      // Remove songs that vanished on the server
      const haveNow = new Set(p.all_song_paths);
      const local = await getAllSongPaths();
      const toDelete = local.filter((x) => !haveNow.has(x));
      if (toDelete.length) await deleteSongsByPath(toDelete);
      if (p.lists !== null) {
        await putLists(p.lists);
        lists = p.lists;
      }
      if (p.bible) {
        await putBibleBooks(p.bible.books);
        await putBibleVerses(p.bible.verses);
        await setBibleVersion(p.bible.version);
        bibleBooks = p.bible.books;
        bibleVerses = p.bible.verses;
        bibleVersion = p.bible.version;
      }
      await setLastSyncTs(p.server_ts);

      if (p.songs_changed.length || toDelete.length) {
        const byPath = new Map(songs.map((song) => [song.path, song]));
        for (const song of p.songs_changed) byPath.set(song.path, song);
        for (const path of toDelete) byPath.delete(path);
        songs = [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
      }
    } else {
      throw new Error('unexpected sync response: ' + resp.type);
    }

    songsStore.set(songs);
    listsStore.set(lists);
    bibleBooksStore.set(bibleBooks);
    bibleVersesStore.set(bibleVerses);
    bibleVersionStore.set(bibleVersion);
    syncStatus.set('idle');

    // Persist fresh data into the server entry cache so switching away
    // and back doesn't restore stale/corrupted songs.
    const sk = await getActiveServerKey();
    if (sk) void snapshotServerData(sk);
  } catch (e: any) {
    syncStatus.set('error');
    console.warn('[sync]', e?.message ?? e);
  }
}

/** Load whatever is in IndexedDB into the Svelte stores (for offline UI). */
export async function hydrateFromCache(): Promise<void> {
  const [songs, lists, bibleBooks, bibleVerses, bibleVersion, cachedQueue] = await Promise.all([
    loadAllSongs(),
    loadAllLists(),
    loadAllBibleBooks(),
    loadAllBibleVerses(),
    getBibleVersion(),
    getCachedQueueState(),
  ]);
  songsStore.set(songs);
  listsStore.set(lists);
  bibleBooksStore.set(bibleBooks);
  bibleVersesStore.set(bibleVerses);
  bibleVersionStore.set(bibleVersion);
  if (cachedQueue) queueState.set(cachedQueue);
}
