// Delta-sync orchestrator. Talks to the desktop via `remote.send()` using
// a request-id so the response can be awaited. Applies results to IndexedDB
// + Svelte stores.

import { remote } from './ws';
import { get } from 'svelte/store';
import { sortBibleVerses } from './bible';
import {
  clearBibleBooks,
  clearBibleVerses,
  deleteSongsByPath,
  getAllSongPaths,
  getBibleVersion,
  getCachedQueueState,
  getLastSyncTs,
  getPendingMutations,
  loadPendingPublicLists,
  loadAllBibleBooks,
  loadAllBibleVerses,
  loadAllLists,
  loadAllPrivateLists,
  loadAllSongs,
  clearPendingListMutations,
  mergeServerLists,
  normalizedListName,
  putBibleBooks,
  putBibleVerses,
  putLists,
  putSongs,
  setBibleVersion,
  setLastSyncTs,
  stripListSyncStatus,
  updateSongKey,
} from './db';
import type { BibleBook, BibleVerse, LibraryList, LibrarySong, SyncDelta, SyncFull } from './protocol';
import {
  bibleBooksStore,
  bibleVersesStore,
  bibleVersionStore,
  listsStore,
  privateListsStore,
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

function requestSync(
  sinceTs: number,
  bibleVersion: string | null,
): Promise<{ type: string; payload: any }> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, resolve);
    // First sync can include the full song library plus the full Bible text.
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('sync timed out'));
    }, 60000);
    const clearOnResolve = (resolveWrapped: PendingResolver) => (m: any) => {
      clearTimeout(timer);
      resolveWrapped(m);
    };
    pending.set(id, clearOnResolve(resolve));
    try {
      remote.sendRaw({
        type: 'sync.request',
        id,
        payload: { since_ts: sinceTs, bible_version: bibleVersion },
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
  const [lastSyncTs, bibleBooks, bibleVerses, bibleVersion] = await Promise.all([
    getLastSyncTs(),
    loadAllBibleBooks(),
    loadAllBibleVerses(),
    getBibleVersion(),
  ]);
  const needsBibleSnapshot = bibleBooks.length === 0 || bibleVerses.length === 0;
  console.info(
    '[sync] syncNow: lastSyncTs=%s needsBibleSnapshot=%s cachedBibleVersion=%s',
    lastSyncTs, needsBibleSnapshot, bibleVersion,
  );
  return _doSync(needsBibleSnapshot ? 0 : lastSyncTs, bibleVersion);
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

export async function flushPendingLists(): Promise<void> {
  const pendingLists = await loadPendingPublicLists();
  const pendingMutations = (await getPendingMutations()).filter((mutation) => mutation.type.startsWith('list.'));
  if (!pendingLists.length && !pendingMutations.length) return;

  const payloadLists = pendingLists.map((l) => stripListSyncStatus(l));
  const payloadMutations = pendingMutations.map((mutation) => ({
    type: mutation.type,
    payload: mutation.payload,
  }));
  const resp = await remote.sendRequest(
    'list.merge_pending',
    { lists: payloadLists, mutations: payloadMutations },
    25000,
  );
  if (!resp?.ok || !Array.isArray(resp.lists)) {
    throw new Error(resp?.error ?? 'pending list merge failed');
  }

  // Verification gate: ensure the server actually confirmed every local pending list.
  // If any are missing, DO NOT clobber local state — keep mutations for retry on next reconnect.
  const respNames = new Set((resp.lists as LibraryList[]).map((l) => normalizedListName(l.name)));
  const lostPending = pendingLists.filter((p) => !respNames.has(normalizedListName(p.name)));
  if (lostPending.length > 0) {
    const missingNames = lostPending.map((p) => p.name).join(', ');
    throw new Error(`Server did not confirm pending list(s): ${missingNames}`);
  }

  await putLists(resp.lists);
  await clearPendingListMutations();
  listsStore.set(resp.lists);
}

async function _doSync(since: number, cachedBibleVersion: string | null = null): Promise<void> {
  syncStatus.set('syncing');
  console.info('[sync] Starting sync: since_ts=%s bible_version=%s', since, cachedBibleVersion);
  try {
    const resp = await requestSync(since, cachedBibleVersion);
    let songs: LibrarySong[] = [];
    let lists: LibraryList[] = [];
    let bibleBooks: BibleBook[] = [];
    let bibleVerses: BibleVerse[] = [];
    let bibleVersion: string | null = cachedBibleVersion;

    if (resp.type === 'sync.full') {
      const p = resp.payload as SyncFull;
      console.info(
        '[sync] Received sync.full: songs=%d lists=%d bible=%s server_ts=%s',
        p.songs?.length ?? 0, p.lists?.length ?? 0,
        p.bible ? p.bible.version : 'null', p.server_ts,
      );
      // Optimize full sync removal: only delete songs that vanished from the server
      const incomingPaths = new Set(p.songs.map((s) => s.path));
      const currentPaths = await getAllSongPaths();
      const toDelete = currentPaths.filter((x) => !incomingPaths.has(x));
      if (toDelete.length) {
        console.info('[sync] Removing %d local songs missing from server', toDelete.length);
        await deleteSongsByPath(toDelete);
      }

      await putSongs(p.songs);
      lists = await mergeServerLists(p.lists);
      await clearBibleBooks();
      await clearBibleVerses();
      if (p.bible) {
        const sortedVerses = sortBibleVerses(p.bible.verses);
        await putBibleBooks(p.bible.books);
        await putBibleVerses(sortedVerses);
        await setBibleVersion(p.bible.version);
        bibleBooks = p.bible.books;
        bibleVerses = sortedVerses;
        bibleVersion = p.bible.version;
        console.info('[sync] Bible written: books=%d verses=%d version=%s', bibleBooks.length, bibleVerses.length, bibleVersion);
      } else {
        bibleVersion = await getBibleVersion();
        bibleBooks = [];
        bibleVerses = [];
        console.info('[sync] sync.full carried no bible payload');
      }
      await setLastSyncTs(p.server_ts);
      console.info('[sync] sync.full applied: new lastSyncTs=%s', p.server_ts);
    } else if (resp.type === 'sync.delta') {
      const p = resp.payload as SyncDelta;
      console.info(
        '[sync] Received sync.delta: songs_changed=%d songs_removed=%d lists=%s bible=%s server_ts=%s',
        p.songs_changed?.length ?? 0, p.songs_removed?.length ?? 0,
        p.lists !== null ? `full(${p.lists.length})` : 'null',
        p.bible ? p.bible.version : 'null', p.server_ts,
      );
      if (p.songs_changed.length) await putSongs(p.songs_changed);
      // Remove only the songs the server journaled as deleted since our last sync
      if (p.songs_removed?.length) {
        console.info('[sync] Removing %d deleted songs: %s', p.songs_removed.length, p.songs_removed.join(', '));
        await deleteSongsByPath(p.songs_removed);
      }
      if (p.lists !== null) {
        lists = await mergeServerLists(p.lists);
      } else {
        lists = await loadAllLists();
      }
      if (p.bible) {
        const sortedVerses = sortBibleVerses(p.bible.verses);
        await putBibleBooks(p.bible.books);
        await putBibleVerses(sortedVerses);
        await setBibleVersion(p.bible.version);
        bibleBooks = p.bible.books;
        bibleVerses = sortedVerses;
        bibleVersion = p.bible.version;
        console.info('[sync] Bible updated: books=%d verses=%d version=%s', bibleBooks.length, bibleVerses.length, bibleVersion);
      } else {
        bibleBooks = await loadAllBibleBooks();
        bibleVerses = await loadAllBibleVerses();
        bibleVersion = await getBibleVersion();
      }
      await setLastSyncTs(p.server_ts);
      console.info('[sync] sync.delta applied: new lastSyncTs=%s', p.server_ts);
    } else {
      console.error('[sync] Unexpected sync response type: %s', resp.type);
      throw new Error('unexpected sync response: ' + resp.type);
    }

    // Reload songs from IndexedDB after putting them. This ensures Svelte store gets the merged keys and timestamps.
    // Sorting happens here at the store layer (used to be inside loadAllSongs on every call).
    songs = await loadAllSongs();
    songs = sortSongsForDisplay(songs);
    songsStore.set(songs);
    if (lists.length > 0) listsStore.set(lists);
    else listsStore.set(await loadAllLists());
    bibleBooksStore.set(bibleBooks);
    bibleVersesStore.set(bibleVerses);
    bibleVersionStore.set(bibleVersion);
    console.info('[sync] Sync complete: %d songs in store, status=idle', songs.length);
    syncStatus.set('idle');

  } catch (e: any) {
    syncStatus.set('error');
    console.warn('[sync] Sync failed:', e?.message ?? e);
  }
}

/** Sort songs for display: alphabetic with digit-prefixed names last. */
function sortSongsForDisplay(songs: LibrarySong[]): LibrarySong[] {
  return songs.sort((a, b) => {
    const aDigit = (a.name && a.name.charAt(0) >= '0' && a.name.charAt(0) <= '9') ? 1 : 0;
    const bDigit = (b.name && b.name.charAt(0) >= '0' && b.name.charAt(0) <= '9') ? 1 : 0;
    if (aDigit !== bDigit) return aDigit - bDigit;
    return a.name.localeCompare(b.name);
  });
}

/** Load whatever is in IndexedDB into the Svelte stores (for offline UI). */
export async function hydrateFromCache(): Promise<void> {
  const [songs, lists, privateLists, bibleBooks, bibleVerses, bibleVersion, cachedQueue] = await Promise.all([
    loadAllSongs(),
    loadAllLists(),
    loadAllPrivateLists(),
    loadAllBibleBooks(),
    loadAllBibleVerses(),
    getBibleVersion(),
    getCachedQueueState(),
  ]);
  songsStore.set(sortSongsForDisplay(songs));
  listsStore.set(lists);
  privateListsStore.set(privateLists);
  bibleBooksStore.set(bibleBooks);
  bibleVersesStore.set(bibleVerses);
  bibleVersionStore.set(bibleVersion);
  queueState.set(cachedQueue);
}

/**
 * Apply a remote key change pushed via the `song.key_changed` message. Updates
 * the cached song in IndexedDB and the in-memory store immediately, so the UI
 * re-renders the key badge without waiting for a full sync.delta round-trip.
 */
export async function applyRemoteKeyChange(
  songPath: string,
  key: string | null | undefined,
  keyTs?: number | null,
): Promise<void> {
  await updateSongKey(songPath, key, keyTs);
  songsStore.update((songs) => {
    const idx = songs.findIndex((s) => s.path === songPath);
    if (idx === -1) return songs;
    const updated = [...songs];
    const current = updated[idx];
    const incoming = keyTs ?? 0;
    const local = current.key_ts ?? 0;
    if (incoming === 0 || incoming >= local) {
      updated[idx] = { ...current, key: key ?? null, key_ts: incoming || local };
    }
    return updated;
  });
}
