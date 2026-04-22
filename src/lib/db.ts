// IndexedDB wrapper.
// Object stores:
//   meta              — {key, value} rows: device_id, last_sync_ts, active_server_key
//   songs             — keyed by song path
//   lists             — keyed by list name
//   pending_mutations — offline-queued list commands, replayed on reconnect
//   servers           — one entry per paired server (added in v4)
//
// Version 2 adds `songs` + `lists` stores (Phase 2).
// Version 3 adds `pending_mutations` (Phase 5 offline list editing).
// Version 4 adds `servers` for multi-device pairing support.
// Version 5 adds Bible cache stores.

import type { BibleBook, BibleVerse, LibrarySong, LibraryList, QueueState } from './protocol';

const DB_NAME = 'church-remote';
const DB_VERSION = 5;
const STORE_META = 'meta';
const STORE_SONGS = 'songs';
const STORE_LISTS = 'lists';
const STORE_BIBLE_BOOKS = 'bible_books';
const STORE_BIBLE_VERSES = 'bible_verses';
const STORE_PENDING = 'pending_mutations';
const STORE_SERVERS = 'servers';

// ── Public types ───────────────────────────────────────────────────

export interface Credentials {
  device_id: string;
  device_token: string;
  device_name: string;
  cloud_host: string | null;
  lan_host: string | null;
  server_name?: string;
  paired_at?: number;
  // Present when loaded from the servers store (multi-device support)
  server_key?: string;
}

export interface ServerEntry {
  server_key: string; // UUID — IndexedDB key for STORE_SERVERS
  device_id: string;
  device_token: string;
  device_name: string;
  cloud_host: string | null;
  lan_host: string | null;
  server_name?: string;
  paired_at?: number;
  last_used?: number;
  cached_songs?: LibrarySong[];
  cached_lists?: LibraryList[];
  cached_bible_books?: BibleBook[];
  cached_bible_verses?: BibleVerse[];
  cached_bible_version?: string | null;
  cached_queue?: QueueState | null;
  last_sync_ts?: number;
}

// ── DB open / upgrade ──────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = (ev.target as IDBOpenDBRequest).transaction!;

      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_SONGS)) {
        db.createObjectStore(STORE_SONGS, { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains(STORE_LISTS)) {
        db.createObjectStore(STORE_LISTS, { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains(STORE_BIBLE_BOOKS)) {
        db.createObjectStore(STORE_BIBLE_BOOKS, { keyPath: 'book_num' });
      }
      if (!db.objectStoreNames.contains(STORE_BIBLE_VERSES)) {
        db.createObjectStore(STORE_BIBLE_VERSES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PENDING)) {
        db.createObjectStore(STORE_PENDING, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_SERVERS)) {
        db.createObjectStore(STORE_SERVERS, { keyPath: 'server_key' });
      }

      // Migration v3 → v4: move meta['creds'] into STORE_SERVERS
      if (ev.oldVersion < 4 && db.objectStoreNames.contains(STORE_META)) {
        const metaStore = tx.objectStore(STORE_META);
        const serversStore = tx.objectStore(STORE_SERVERS);
        const getReq = metaStore.get('creds');
        getReq.onsuccess = () => {
          const row = getReq.result as { key: string; value: Credentials } | undefined;
          if (!row?.value) return;
          const creds = row.value;
          const serverKey = crypto.randomUUID();
          const entry: ServerEntry = {
            server_key: serverKey,
            device_id: creds.device_id,
            device_token: creds.device_token,
            device_name: creds.device_name,
            cloud_host: creds.cloud_host,
            lan_host: creds.lan_host,
            server_name: creds.server_name,
            paired_at: creds.paired_at,
            last_used: Date.now(),
          };
          serversStore.put(entry);
          metaStore.put({ key: 'active_server_key', value: serverKey });
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Low-level helpers ──────────────────────────────────────────────

async function getRow<T>(key: string, store = STORE_META): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => {
      const row = req.result as { key: string; value: T } | T | undefined;
      if (!row) return resolve(null);
      if (store === STORE_META && (row as any).value !== undefined) {
        resolve((row as any).value as T);
      } else {
        resolve(row as T);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

async function setMeta<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteMeta(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Credentials (single-server shim — delegates to servers store) ──
// In-memory cache so tab-switch onMount reads are instant.
let _credCache: Credentials | null | undefined = undefined;

export async function loadCredentials(): Promise<Credentials | null> {
  if (_credCache !== undefined) return _credCache;

  // Try the active server first
  const activeKey = await getRow<string>('active_server_key');
  if (activeKey) {
    const entry = await _getServerByKey(activeKey);
    if (entry) {
      _credCache = _entryToCredentials(entry);
      return _credCache;
    }
  }

  // No active key or stale key — pick the most recently used server
  const all = await _loadAllServers();
  if (all.length > 0) {
    const best = all.sort((a, b) => (b.last_used ?? 0) - (a.last_used ?? 0))[0];
    await setMeta('active_server_key', best.server_key);
    _credCache = _entryToCredentials(best);
    return _credCache;
  }

  // Legacy fallback: meta['creds'] (pre-v4 data that didn't migrate in onupgradeneeded)
  const legacy = await getRow<Credentials>('creds');
  if (legacy) {
    const serverKey = crypto.randomUUID();
    const entry: ServerEntry = {
      server_key: serverKey,
      device_id: legacy.device_id,
      device_token: legacy.device_token,
      device_name: legacy.device_name,
      cloud_host: legacy.cloud_host,
      lan_host: legacy.lan_host,
      server_name: legacy.server_name,
      paired_at: legacy.paired_at,
      last_used: Date.now(),
    };
    await _saveServer(entry);
    await setMeta('active_server_key', serverKey);
    _credCache = _entryToCredentials(entry);
    return _credCache;
  }

  _credCache = null;
  return null;
}

export async function saveCredentials(c: Credentials): Promise<void> {
  // If there's an active server, update it in-place (preserves server_key).
  const activeKey = (c.server_key) || (await getRow<string>('active_server_key'));
  if (activeKey) {
    const existing = await _getServerByKey(activeKey);
    if (existing) {
      const updated: ServerEntry = {
        ...existing,
        device_id: c.device_id,
        device_token: c.device_token,
        device_name: c.device_name,
        cloud_host: c.cloud_host,
        lan_host: c.lan_host,
        server_name: c.server_name ?? existing.server_name,
        paired_at: c.paired_at ?? existing.paired_at,
        last_used: Date.now(),
      };
      await _saveServer(updated);
      _credCache = _entryToCredentials(updated);
      return;
    }
  }
  // No active server — create a new one.
  const serverKey = c.server_key ?? crypto.randomUUID();
  const entry: ServerEntry = {
    server_key: serverKey,
    device_id: c.device_id,
    device_token: c.device_token,
    device_name: c.device_name,
    cloud_host: c.cloud_host,
    lan_host: c.lan_host,
    server_name: c.server_name,
    paired_at: c.paired_at,
    last_used: Date.now(),
  };
  await _saveServer(entry);
  await setMeta('active_server_key', serverKey);
  _credCache = _entryToCredentials(entry);
}

export async function clearCredentials(): Promise<void> {
  const activeKey = await getRow<string>('active_server_key');
  if (activeKey) {
    await _removeServer(activeKey);
  }
  _credCache = null;
  // Remove legacy entry too
  await deleteMeta('creds');

  // If other servers remain, keep the most recent as active and restore its
  // cached data so IndexedDB doesn't still hold the removed server's songs.
  const remaining = await _loadAllServers();
  if (remaining.length > 0) {
    const next = remaining.sort((a, b) => (b.last_used ?? 0) - (a.last_used ?? 0))[0];
    await setMeta('active_server_key', next.server_key);
    await restoreServerData(next.server_key);
  } else {
    await deleteMeta('active_server_key');
    // No servers left — wipe stale song/list data from IndexedDB.
    await clearSongs();
    await clearLists();
    await clearBibleBooks();
    await clearBibleVerses();
    await deleteMeta('bible_version');
  }
}

// ── Multi-server API ───────────────────────────────────────────────

/** Load all stored server credentials. */
export async function loadAllServers(): Promise<ServerEntry[]> {
  return _loadAllServers();
}

/**
 * Add or replace a server entry.
 * If an entry with the same server_key already exists it is overwritten.
 */
export async function saveServer(entry: ServerEntry): Promise<void> {
  await _saveServer(entry);
}

/** Remove a specific server pairing by its key. */
export async function removeServer(serverKey: string): Promise<void> {
  const activeKey = await getRow<string>('active_server_key');
  await _removeServer(serverKey);
  if (activeKey === serverKey) {
    // Pick another server or clear active, and restore its cached data.
    const remaining = await _loadAllServers();
    if (remaining.length > 0) {
      const next = remaining.sort((a, b) => (b.last_used ?? 0) - (a.last_used ?? 0))[0];
      await setMeta('active_server_key', next.server_key);
      _credCache = _entryToCredentials(next);
      await restoreServerData(next.server_key);
    } else {
      await deleteMeta('active_server_key');
      _credCache = null;
      await clearSongs();
      await clearLists();
      await clearBibleBooks();
      await clearBibleVerses();
      await deleteMeta('bible_version');
    }
  }
}

/** Switch to a different stored server as the active one.
 *  Snapshots current server's data, restores target server's cached data. */
export async function switchServer(serverKey: string): Promise<Credentials | null> {
  const currentKey = await getRow<string>('active_server_key');
  if (currentKey && currentKey !== serverKey) {
    await snapshotServerData(currentKey);
  }

  const entry = await _getServerByKey(serverKey);
  if (!entry) return null;
  const updated: ServerEntry = { ...entry, last_used: Date.now() };
  await _saveServer(updated);
  await setMeta('active_server_key', serverKey);
  _credCache = _entryToCredentials(updated);

  await restoreServerData(serverKey);
  return _credCache;
}

// ── Internal helpers ───────────────────────────────────────────────

function _entryToCredentials(e: ServerEntry): Credentials {
  return {
    device_id: e.device_id,
    device_token: e.device_token,
    device_name: e.device_name,
    cloud_host: e.cloud_host,
    lan_host: e.lan_host,
    server_name: e.server_name,
    paired_at: e.paired_at,
    server_key: e.server_key,
  };
}

async function _getServerByKey(key: string): Promise<ServerEntry | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVERS, 'readonly');
    const req = tx.objectStore(STORE_SERVERS).get(key);
    req.onsuccess = () => resolve((req.result as ServerEntry) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function _loadAllServers(): Promise<ServerEntry[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVERS, 'readonly');
    const req = tx.objectStore(STORE_SERVERS).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as ServerEntry[]);
    req.onerror = () => reject(req.error);
  });
}

async function _saveServer(entry: ServerEntry): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVERS, 'readwrite');
    tx.objectStore(STORE_SERVERS).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function _removeServer(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVERS, 'readwrite');
    tx.objectStore(STORE_SERVERS).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Device ID ──────────────────────────────────────────────────────

export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await getRow<string>('device_id');
  if (existing) return existing;
  const id = crypto.randomUUID();
  await setMeta('device_id', id);
  return id;
}

// ── Active server key accessor ────────────────────────────────────

export async function getActiveServerKey(): Promise<string | null> {
  return (await getRow<string>('active_server_key')) ?? null;
}

// ── Sync bookkeeping (per-server) ─────────────────────────────────

export async function getLastSyncTs(): Promise<number> {
  const sk = await getRow<string>('active_server_key');
  if (sk) {
    const entry = await _getServerByKey(sk);
    if (entry?.last_sync_ts) return entry.last_sync_ts;
  }
  return (await getRow<number>('last_sync_ts')) ?? 0;
}

export async function setLastSyncTs(ts: number): Promise<void> {
  await setMeta('last_sync_ts', ts);
  const sk = await getRow<string>('active_server_key');
  if (sk) {
    const entry = await _getServerByKey(sk);
    if (entry) {
      entry.last_sync_ts = ts;
      await _saveServer(entry);
    }
  }
}

// ── Songs ──────────────────────────────────────────────────────────

export async function putSongs(songs: LibrarySong[]): Promise<void> {
  if (!songs.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SONGS, 'readwrite');
    const store = tx.objectStore(STORE_SONGS);
    for (const s of songs) store.put(s);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteSongsByPath(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SONGS, 'readwrite');
    const store = tx.objectStore(STORE_SONGS);
    for (const p of paths) store.delete(p);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearSongs(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SONGS, 'readwrite');
    tx.objectStore(STORE_SONGS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAllSongs(): Promise<LibrarySong[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SONGS, 'readonly');
    const req = tx.objectStore(STORE_SONGS).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as LibrarySong[]);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllSongPaths(): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SONGS, 'readonly');
    const req = tx.objectStore(STORE_SONGS).getAllKeys();
    req.onsuccess = () => resolve((req.result ?? []) as string[]);
    req.onerror = () => reject(req.error);
  });
}

// â”€â”€ Bible cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function putBibleBooks(books: BibleBook[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BIBLE_BOOKS, 'readwrite');
    const store = tx.objectStore(STORE_BIBLE_BOOKS);
    store.clear();
    for (const book of books) store.put(book);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAllBibleBooks(): Promise<BibleBook[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BIBLE_BOOKS, 'readonly');
    const req = tx.objectStore(STORE_BIBLE_BOOKS).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as BibleBook[]);
    req.onerror = () => reject(req.error);
  });
}

export async function clearBibleBooks(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BIBLE_BOOKS, 'readwrite');
    tx.objectStore(STORE_BIBLE_BOOKS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function putBibleVerses(verses: BibleVerse[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BIBLE_VERSES, 'readwrite');
    const store = tx.objectStore(STORE_BIBLE_VERSES);
    store.clear();
    for (const verse of verses) store.put(verse);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAllBibleVerses(): Promise<BibleVerse[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BIBLE_VERSES, 'readonly');
    const req = tx.objectStore(STORE_BIBLE_VERSES).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as BibleVerse[]);
    req.onerror = () => reject(req.error);
  });
}

export async function clearBibleVerses(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BIBLE_VERSES, 'readwrite');
    tx.objectStore(STORE_BIBLE_VERSES).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getBibleVersion(): Promise<string | null> {
  return (await getRow<string>('bible_version')) ?? null;
}

export async function setBibleVersion(version: string | null): Promise<void> {
  await setMeta('bible_version', version);
  const sk = await getRow<string>('active_server_key');
  if (sk) {
    const entry = await _getServerByKey(sk);
    if (entry) {
      entry.cached_bible_version = version;
      await _saveServer(entry);
    }
  }
}

// ── Lists ──────────────────────────────────────────────────────────

export async function putLists(lists: LibraryList[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LISTS, 'readwrite');
    const store = tx.objectStore(STORE_LISTS);
    store.clear();
    for (const l of lists) store.put(l);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAllLists(): Promise<LibraryList[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LISTS, 'readonly');
    const req = tx.objectStore(STORE_LISTS).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as LibraryList[]);
    req.onerror = () => reject(req.error);
  });
}

// ── Per-server data cache (snapshot/restore on server switch) ──────

export async function snapshotServerData(serverKey: string): Promise<void> {
  const entry = await _getServerByKey(serverKey);
  if (!entry) return;
  entry.cached_songs = await loadAllSongs();
  entry.cached_lists = await loadAllLists();
  entry.cached_bible_books = await loadAllBibleBooks();
  entry.cached_bible_verses = await loadAllBibleVerses();
  entry.cached_bible_version = await getBibleVersion();
  entry.last_sync_ts = (await getRow<number>('last_sync_ts')) ?? 0;
  await _saveServer(entry);
}

export async function restoreServerData(serverKey: string): Promise<void> {
  const entry = await _getServerByKey(serverKey);
  await clearSongs();
  await clearLists();
  await clearBibleBooks();
  await clearBibleVerses();
  if (entry?.cached_songs?.length) await putSongs(entry.cached_songs);
  if (entry?.cached_lists?.length) await putLists(entry.cached_lists);
  if (entry?.cached_bible_books?.length) await putBibleBooks(entry.cached_bible_books);
  if (entry?.cached_bible_verses?.length) await putBibleVerses(entry.cached_bible_verses);
  await setMeta('last_sync_ts', entry?.last_sync_ts ?? 0);
  await setMeta('bible_version', entry?.cached_bible_version ?? null);
}

export async function cacheQueueState(queue: QueueState | null): Promise<void> {
  const sk = await getRow<string>('active_server_key');
  if (!sk) return;
  const entry = await _getServerByKey(sk);
  if (!entry) return;
  entry.cached_queue = queue;
  await _saveServer(entry);
}

export async function getCachedQueueState(): Promise<QueueState | null> {
  const sk = await getRow<string>('active_server_key');
  if (!sk) return null;
  const entry = await _getServerByKey(sk);
  return entry?.cached_queue ?? null;
}

export async function clearLists(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LISTS, 'readwrite');
    tx.objectStore(STORE_LISTS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Pending offline mutations ──────────────────────────────────────

export interface PendingMutation {
  id?: number;
  type: string;
  payload?: unknown;
  created_at: number;
}

export async function addPendingMutation(cmd: { type: string; payload?: unknown }): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    tx.objectStore(STORE_PENDING).add({ type: cmd.type, payload: cmd.payload, created_at: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingMutations(): Promise<PendingMutation[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readonly');
    const req = tx.objectStore(STORE_PENDING).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as PendingMutation[]);
    req.onerror = () => reject(req.error);
  });
}

export async function clearPendingMutations(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    tx.objectStore(STORE_PENDING).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Backup / Import ───────────────────────────────────────────────

export interface BackupData {
  version: number;
  exported_at: number;
  songs: LibrarySong[];
  lists: LibraryList[];
  bible_books: BibleBook[];
  bible_verses: BibleVerse[];
  bible_version: string | null;
  servers: ServerEntry[];
  active_server_key: string | null;
  device_id: string | null;
}

export async function exportBackup(): Promise<BackupData> {
  const songs = await loadAllSongs();
  const lists = await loadAllLists();
  const bibleBooks = await loadAllBibleBooks();
  const bibleVerses = await loadAllBibleVerses();
  const bibleVersion = await getBibleVersion();
  const servers = await _loadAllServers();
  const activeKey = await getRow<string>('active_server_key');
  const deviceId = await getRow<string>('device_id');
  return {
    version: DB_VERSION,
    exported_at: Date.now(),
    songs,
    lists,
    bible_books: bibleBooks,
    bible_verses: bibleVerses,
    bible_version: bibleVersion,
    servers,
    active_server_key: activeKey,
    device_id: deviceId,
  };
}

export interface BackupComparison {
  current: { songs: number; lists: number; servers: number };
  backup: { songs: number; lists: number; servers: number; exported_at: number };
  backupIsOlder: boolean;
  backupHasLess: boolean;
}

export async function compareBackup(data: BackupData): Promise<BackupComparison> {
  const currentSongs = await loadAllSongs();
  const currentLists = await loadAllLists();
  const currentServers = await _loadAllServers();
  return {
    current: { songs: currentSongs.length, lists: currentLists.length, servers: currentServers.length },
    backup: { songs: data.songs.length, lists: data.lists.length, servers: data.servers.length, exported_at: data.exported_at },
    backupIsOlder: data.exported_at < Date.now() - 60_000,
    backupHasLess: data.songs.length < currentSongs.length,
  };
}

export async function importBackup(data: BackupData): Promise<void> {
  await clearSongs();
  await clearLists();
  await clearBibleBooks();
  await clearBibleVerses();
  if (data.songs.length) await putSongs(data.songs);
  if (data.lists.length) await putLists(data.lists);
  if (data.bible_books.length) await putBibleBooks(data.bible_books);
  if (data.bible_verses.length) await putBibleVerses(data.bible_verses);
  await setMeta('bible_version', data.bible_version ?? null);
  // Restore servers
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SERVERS, 'readwrite');
    const store = tx.objectStore(STORE_SERVERS);
    store.clear();
    for (const s of data.servers) store.put(s);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  if (data.active_server_key) await setMeta('active_server_key', data.active_server_key);
  if (data.device_id) await setMeta('device_id', data.device_id);
  _credCache = undefined;
}
