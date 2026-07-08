// IndexedDB wrapper.
// Version 9 stores all offline data by server_key so each paired desktop is a
// separate offline workspace. The older global stores remain only as migration
// sources for installed clients upgrading from versions 2-8.

import { sortBibleVerses } from './bible';
import type { BibleBook, BibleVerse, LibrarySong, LibraryList, QueueState } from './protocol';

const DB_NAME = 'church-remote';
const DB_VERSION = 9;

const STORE_META = 'meta';
const STORE_SONGS = 'songs';
const STORE_LISTS = 'lists';
const STORE_PRIVATE_LISTS = 'private_lists';
const STORE_BIBLE_BOOKS = 'bible_books';
const STORE_BIBLE_VERSES = 'bible_verses';
const STORE_PENDING = 'pending_mutations';
const STORE_SERVERS = 'servers';
const STORE_SERVER_CACHES = 'server_caches';

const STORE_SERVER_SONGS = 'server_songs';
const STORE_SERVER_LISTS = 'server_lists';
const STORE_SERVER_PRIVATE_LISTS = 'server_private_lists';
const STORE_SERVER_BIBLE_BOOKS = 'server_bible_books';
const STORE_SERVER_BIBLE_VERSES = 'server_bible_verses';
const STORE_SERVER_QUEUE = 'server_queue';
const STORE_SERVER_SYNC_META = 'server_sync_meta';

// ── Public types ───────────────────────────────────────────────────

export interface Credentials {
  device_id: string;
  device_token: string;
  device_name: string;
  cloud_host: string | null;
  lan_host: string | null;
  server_name?: string;
  server_id?: string;
  paired_at?: number;
  server_key?: string;
  can_edit_keys?: boolean;
  can_edit_songs?: boolean;
}

export interface ServerEntry {
  server_key: string;
  device_id: string;
  device_token: string;
  device_name: string;
  cloud_host: string | null;
  lan_host: string | null;
  server_name?: string;
  server_id?: string;
  paired_at?: number;
  last_used?: number;
  // Legacy v4-v8 cache fields. New writes strip these from the server registry.
  cached_songs?: LibrarySong[];
  cached_lists?: LibraryList[];
  cached_bible_books?: BibleBook[];
  cached_bible_verses?: BibleVerse[];
  cached_bible_version?: string | null;
  cached_queue?: QueueState | null;
  last_sync_ts?: number;
  can_edit_keys?: boolean;
  can_edit_songs?: boolean;
}

interface ServerCacheEntry {
  server_key: string;
  cached_songs?: LibrarySong[];
  cached_lists?: LibraryList[];
  cached_bible_books?: BibleBook[];
  cached_bible_verses?: BibleVerse[];
  cached_bible_version?: string | null;
  cached_queue?: QueueState | null;
  last_sync_ts?: number;
}

interface ServerSyncMeta {
  server_key: string;
  last_sync_ts: number;
  bible_version: string | null;
}

interface ServerQueueRow {
  server_key: string;
  queue: QueueState | null;
}

type ScopedSong = LibrarySong & { server_key: string };
type ScopedList = LibraryList & { server_key: string };
type ScopedBibleBook = BibleBook & { server_key: string };
type ScopedBibleVerse = BibleVerse & { server_key: string };

export interface ServerDataBackup {
  server_key: string;
  songs: LibrarySong[];
  lists: LibraryList[];
  private_lists: LibraryList[];
  bible_books: BibleBook[];
  bible_verses: BibleVerse[];
  bible_version: string | null;
  queue: QueueState | null;
  last_sync_ts: number;
}

// ── DB open / upgrade ──────────────────────────────────────────────

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(retries = 3, delayMs = 150): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
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
      if (!db.objectStoreNames.contains(STORE_SERVER_CACHES)) {
        db.createObjectStore(STORE_SERVER_CACHES, { keyPath: 'server_key' });
      }
      if (!db.objectStoreNames.contains(STORE_PRIVATE_LISTS)) {
        db.createObjectStore(STORE_PRIVATE_LISTS, { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains(STORE_SERVER_SONGS)) {
        db.createObjectStore(STORE_SERVER_SONGS, { keyPath: ['server_key', 'path'] });
      }
      if (!db.objectStoreNames.contains(STORE_SERVER_LISTS)) {
        db.createObjectStore(STORE_SERVER_LISTS, { keyPath: ['server_key', 'name'] });
      }
      if (!db.objectStoreNames.contains(STORE_SERVER_PRIVATE_LISTS)) {
        db.createObjectStore(STORE_SERVER_PRIVATE_LISTS, { keyPath: ['server_key', 'name'] });
      }
      if (!db.objectStoreNames.contains(STORE_SERVER_BIBLE_BOOKS)) {
        db.createObjectStore(STORE_SERVER_BIBLE_BOOKS, { keyPath: ['server_key', 'book_num'] });
      }
      if (!db.objectStoreNames.contains(STORE_SERVER_BIBLE_VERSES)) {
        db.createObjectStore(STORE_SERVER_BIBLE_VERSES, { keyPath: ['server_key', 'id'] });
      }
      if (!db.objectStoreNames.contains(STORE_SERVER_QUEUE)) {
        db.createObjectStore(STORE_SERVER_QUEUE, { keyPath: 'server_key' });
      }
      if (!db.objectStoreNames.contains(STORE_SERVER_SYNC_META)) {
        db.createObjectStore(STORE_SERVER_SYNC_META, { keyPath: 'server_key' });
      }

      if (ev.oldVersion < 4 && db.objectStoreNames.contains(STORE_META)) {
        migrateLegacyCredentials(tx);
      }

      if (ev.oldVersion < 6 && db.objectStoreNames.contains(STORE_META)) {
        tx.objectStore(STORE_META).put({ key: 'last_sync_ts', value: 0 });
      }

      if (ev.oldVersion < 8 && db.objectStoreNames.contains(STORE_SERVERS)) {
        migrateServerEntryCaches(tx);
      }

      if (ev.oldVersion < 9) {
        migrateServerScopedData(tx);
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
        dbPromise = null;
      };
      dbInstance.onclose = () => {
        dbInstance = null;
        dbPromise = null;
      };
      resolve(dbInstance);
    };
    req.onerror = () => {
      dbPromise = null;
      if (retries > 1) {
        console.warn(`[db] Open failed, retrying in ${delayMs}ms. Retries left: ${retries - 1}. Error:`, req.error);
        setTimeout(() => {
          openDb(retries - 1, delayMs * 2).then(resolve, reject);
        }, delayMs);
      } else {
        reject(req.error);
      }
    };
  });

  return dbPromise;
}

function migrateLegacyCredentials(tx: IDBTransaction): void {
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
      // Preserve the legacy server_id so a reconnect attempt can still hit
      // the right backend instead of looking like a brand-new server.
      server_id: creds.server_id,
      paired_at: creds.paired_at,
      last_used: Date.now(),
    };
    serversStore.put(entry);
    metaStore.put({ key: 'active_server_key', value: serverKey });
    copyGlobalStoresToServer(tx, serverKey);
    tagLegacyPendingMutations(tx, serverKey);
  };
}

function migrateServerEntryCaches(tx: IDBTransaction): void {
  const serversStore = tx.objectStore(STORE_SERVERS);
  const cacheStore = tx.objectStore(STORE_SERVER_CACHES);
  const serversReq = serversStore.getAll();
  serversReq.onsuccess = () => {
    const servers = (serversReq.result ?? []) as ServerEntry[];
    for (const server of servers) {
      cacheStore.put({
        server_key: server.server_key,
        cached_songs: server.cached_songs,
        cached_lists: server.cached_lists,
        cached_bible_books: server.cached_bible_books,
        cached_bible_verses: server.cached_bible_verses,
        cached_bible_version: server.cached_bible_version,
        cached_queue: server.cached_queue,
        last_sync_ts: server.last_sync_ts,
      } satisfies ServerCacheEntry);
      serversStore.put(stripServerCache(server));
    }
  };
}

function migrateServerScopedData(tx: IDBTransaction): void {
  const metaStore = tx.objectStore(STORE_META);
  const serversStore = tx.objectStore(STORE_SERVERS);
  const cacheStore = tx.objectStore(STORE_SERVER_CACHES);
  const syncMetaStore = tx.objectStore(STORE_SERVER_SYNC_META);

  const serversReq = serversStore.getAll();
  serversReq.onsuccess = () => {
    const servers = (serversReq.result ?? []) as ServerEntry[];
    for (const server of servers) {
      writeLegacyCacheToScopedStores(tx, {
        server_key: server.server_key,
        cached_songs: server.cached_songs,
        cached_lists: server.cached_lists,
        cached_bible_books: server.cached_bible_books,
        cached_bible_verses: server.cached_bible_verses,
        cached_bible_version: server.cached_bible_version,
        cached_queue: server.cached_queue,
        last_sync_ts: server.last_sync_ts,
      });
      syncMetaStore.put({
        server_key: server.server_key,
        last_sync_ts: server.last_sync_ts ?? 0,
        bible_version: server.cached_bible_version ?? null,
      } satisfies ServerSyncMeta);
      serversStore.put(stripServerCache(server));
    }
  };

  const cachesReq = cacheStore.getAll();
  cachesReq.onsuccess = () => {
    const caches = (cachesReq.result ?? []) as ServerCacheEntry[];
    for (const cache of caches) writeLegacyCacheToScopedStores(tx, cache);
  };

  const activeReq = metaStore.get('active_server_key');
  activeReq.onsuccess = () => {
    const activeKey = metaValue<string>(activeReq.result);
    if (!activeKey) return;
    copyGlobalStoresToServer(tx, activeKey);
    tagLegacyPendingMutations(tx, activeKey);
  };
}

function writeLegacyCacheToScopedStores(tx: IDBTransaction, cache: ServerCacheEntry): void {
  const serverKey = cache.server_key;
  if (!serverKey) return;
  putScopedRows(tx.objectStore(STORE_SERVER_SONGS), serverKey, cache.cached_songs ?? []);
  putScopedRows(tx.objectStore(STORE_SERVER_LISTS), serverKey, cache.cached_lists ?? []);
  putScopedRows(tx.objectStore(STORE_SERVER_BIBLE_BOOKS), serverKey, cache.cached_bible_books ?? []);
  putScopedRows(tx.objectStore(STORE_SERVER_BIBLE_VERSES), serverKey, cache.cached_bible_verses ?? []);
  tx.objectStore(STORE_SERVER_QUEUE).put({
    server_key: serverKey,
    queue: cache.cached_queue ?? null,
  } satisfies ServerQueueRow);
  tx.objectStore(STORE_SERVER_SYNC_META).put({
    server_key: serverKey,
    last_sync_ts: cache.last_sync_ts ?? 0,
    bible_version: cache.cached_bible_version ?? null,
  } satisfies ServerSyncMeta);
}

function copyGlobalStoresToServer(tx: IDBTransaction, serverKey: string): void {
  copyGlobalStoreToScopedStore(tx, STORE_SONGS, STORE_SERVER_SONGS, serverKey);
  copyGlobalStoreToScopedStore(tx, STORE_LISTS, STORE_SERVER_LISTS, serverKey);
  copyGlobalStoreToScopedStore(tx, STORE_PRIVATE_LISTS, STORE_SERVER_PRIVATE_LISTS, serverKey);
  copyGlobalStoreToScopedStore(tx, STORE_BIBLE_BOOKS, STORE_SERVER_BIBLE_BOOKS, serverKey);
  copyGlobalStoreToScopedStore(tx, STORE_BIBLE_VERSES, STORE_SERVER_BIBLE_VERSES, serverKey);

  const lastSyncReq = tx.objectStore(STORE_META).get('last_sync_ts');
  const bibleVersionReq = tx.objectStore(STORE_META).get('bible_version');
  lastSyncReq.onsuccess = () => {
    const lastSyncTs = Number(metaValue<number>(lastSyncReq.result) ?? 0);
    const putMeta = () => {
      tx.objectStore(STORE_SERVER_SYNC_META).put({
        server_key: serverKey,
        last_sync_ts: lastSyncTs,
        bible_version: metaValue<string | null>(bibleVersionReq.result) ?? null,
      } satisfies ServerSyncMeta);
    };
    if (bibleVersionReq.readyState === 'done') putMeta();
    else bibleVersionReq.onsuccess = putMeta;
  };
}

function copyGlobalStoreToScopedStore(
  tx: IDBTransaction,
  sourceName: string,
  targetName: string,
  serverKey: string,
): void {
  const req = tx.objectStore(sourceName).getAll();
  req.onsuccess = () => {
    putScopedRows(tx.objectStore(targetName), serverKey, req.result ?? []);
  };
}

function tagLegacyPendingMutations(tx: IDBTransaction, serverKey: string): void {
  const store = tx.objectStore(STORE_PENDING);
  const req = store.getAll();
  req.onsuccess = () => {
    const mutations = (req.result ?? []) as PendingMutation[];
    for (const mutation of mutations) {
      if (mutation.id !== undefined && !mutation.server_key) {
        store.put({ ...mutation, server_key: serverKey });
      }
    }
  };
}

function putScopedRows<T extends object>(store: IDBObjectStore, serverKey: string, rows: T[]): void {
  for (const row of rows) {
    store.put({ ...toIndexedDbValue(row), server_key: serverKey });
  }
}

// ── Low-level helpers ──────────────────────────────────────────────

function toIndexedDbValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function metaValue<T>(row: { value?: T } | T | null | undefined): T | null {
  if (!row) return null;
  if (typeof row === 'object' && row !== null && 'value' in row) {
    return (row as { value: T }).value;
  }
  return row as T;
}

function stripServerCache(entry: ServerEntry): ServerEntry {
  const {
    cached_songs,
    cached_lists,
    cached_bible_books,
    cached_bible_verses,
    cached_bible_version,
    cached_queue,
    last_sync_ts,
    ...leanEntry
  } = entry;
  void cached_songs;
  void cached_lists;
  void cached_bible_books;
  void cached_bible_verses;
  void cached_bible_version;
  void cached_queue;
  void last_sync_ts;
  return leanEntry;
}

function stripServerKey<T extends { server_key?: string }>(row: T): Omit<T, 'server_key'> {
  const { server_key, ...rest } = row;
  void server_key;
  return rest;
}

async function getRow<T>(key: string, store = STORE_META): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(metaValue<T>(req.result));
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

async function getActiveServerKey(): Promise<string | null> {
  return (await getRow<string>('active_server_key')) ?? null;
}

async function requireActiveServerKey(): Promise<string | null> {
  const serverKey = await getActiveServerKey();
  if (!serverKey) return null;
  const entry = await _getServerByKey(serverKey);
  return entry ? serverKey : null;
}

function scopedKeyMatchesServer(key: IDBValidKey, serverKey: string): boolean {
  return Array.isArray(key) && key[0] === serverKey;
}

async function clearScopedStore(storeName: string, serverKey: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const key of req.result ?? []) {
        if (scopedKeyMatchesServer(key, serverKey)) store.delete(key);
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAllServerData(serverKey: string): Promise<void> {
  await Promise.all([
    clearScopedStore(STORE_SERVER_SONGS, serverKey),
    clearScopedStore(STORE_SERVER_LISTS, serverKey),
    clearScopedStore(STORE_SERVER_PRIVATE_LISTS, serverKey),
    clearScopedStore(STORE_SERVER_BIBLE_BOOKS, serverKey),
    clearScopedStore(STORE_SERVER_BIBLE_VERSES, serverKey),
    removeServerQueue(serverKey),
    removeServerSyncMeta(serverKey),
    clearPendingMutationsForServer(serverKey),
    _removeServerCache(serverKey),
  ]);
}

async function clearAllServerScopedStores(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([
      STORE_SERVER_SONGS,
      STORE_SERVER_LISTS,
      STORE_SERVER_PRIVATE_LISTS,
      STORE_SERVER_BIBLE_BOOKS,
      STORE_SERVER_BIBLE_VERSES,
      STORE_SERVER_QUEUE,
      STORE_SERVER_SYNC_META,
      STORE_PENDING,
      STORE_SERVER_CACHES,
    ], 'readwrite');
    for (const name of tx.objectStoreNames) tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Credentials (single-server shim delegates to servers store) ──

let _credCache: Credentials | null | undefined = undefined;

export async function loadCredentials(): Promise<Credentials | null> {
  if (_credCache !== undefined) return _credCache;

  try {
    const activeKey = await getActiveServerKey();
    if (activeKey) {
      const entry = await _getServerByKey(activeKey);
      if (entry?.device_token) {
        _credCache = _entryToCredentials(entry);
        return _credCache;
      }
    }

    const all = (await _loadAllServers()).filter((entry) => !!entry.device_token);
    if (all.length === 1) {
      const only = all[0];
      await setMeta('active_server_key', only.server_key);
      await initializeServerData(only.server_key);
      _credCache = _entryToCredentials(only);
      return _credCache;
    }

    if (activeKey) await deleteMeta('active_server_key');

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
      await initializeServerData(serverKey);
      await setMeta('active_server_key', serverKey);
      _credCache = _entryToCredentials(entry);
      return _credCache;
    }
  } catch (err) {
    console.error('[db] Error reading credentials from IndexedDB:', err);
    return null;
  }

  _credCache = null;
  return null;
}

export async function loadCredentialsResilient(maxAttempts = 3, delays = [150, 300]): Promise<Credentials | null> {
  let creds = null;
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      creds = await loadCredentials();
      if (creds && creds.device_token) return creds;
    } catch (err) {
      console.warn(`[db] loadCredentials failed (attempt ${attempts + 1}):`, err);
    }
    if (attempts < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delays[attempts]));
    }
    attempts++;
  }
  return creds;
}

export async function saveCredentials(c: Credentials): Promise<void> {
  const activeKey = c.server_key || (await getActiveServerKey());
  if (activeKey) {
    const existing = await _getServerByKey(activeKey);
    if (existing) {
      // Identity guard: never overwrite one desktop's record with another
      // desktop's data. During a server switch, a pending write-back from the
      // PREVIOUS connection (or a race between _credCache and
      // active_server_key) could otherwise route Biserica's reported name onto
      // VM's stored record (and vice-versa). Only merge when the server_id
      // values agree (or either side is missing one, e.g. legacy entries).
      const incomingId = (c.server_id ?? '').trim();
      const existingId = (existing.server_id ?? '').trim();
      const sameIdentity = !incomingId || !existingId || incomingId === existingId;

      if (sameIdentity) {
        const updated: ServerEntry = {
          ...existing,
          device_id: c.device_id,
          device_token: c.device_token,
          device_name: c.device_name,
          cloud_host: c.cloud_host,
          lan_host: c.lan_host,
          server_name: c.server_name ?? existing.server_name,
          server_id: c.server_id ?? existing.server_id,
          paired_at: c.paired_at ?? existing.paired_at,
          last_used: Date.now(),
          can_edit_keys: c.can_edit_keys ?? existing.can_edit_keys,
          can_edit_songs: c.can_edit_songs ?? existing.can_edit_songs,
        };
        await _saveServer(updated);
        await initializeServerData(activeKey);
        _credCache = _entryToCredentials(updated);
        return;
      }

      // Identity mismatch: writing here would clobber the wrong server's
      // record. Fall through to the create path, which writes to a fresh
      // record keyed by c.server_key (or a new UUID) instead.
      console.warn(
        '[db] saveCredentials: identity mismatch — refusing to overwrite ' +
          `"${existing.server_name ?? activeKey}" (server_id=${existingId.slice(0, 8)}) ` +
          `with data for server_id=${incomingId.slice(0, 8)}; creating a new record.`,
      );
    }
  }

  const serverKey = c.server_key ?? crypto.randomUUID();
  const entry: ServerEntry = {
    server_key: serverKey,
    device_id: c.device_id,
    device_token: c.device_token,
    device_name: c.device_name,
    cloud_host: c.cloud_host,
    lan_host: c.lan_host,
    server_name: c.server_name,
    server_id: c.server_id,
    paired_at: c.paired_at,
    last_used: Date.now(),
    can_edit_keys: c.can_edit_keys,
    can_edit_songs: c.can_edit_songs,
  };
  await _saveServer(entry);
  await initializeServerData(serverKey);
  await setMeta('active_server_key', serverKey);
  _credCache = _entryToCredentials(entry);
}

export async function clearCredentials(): Promise<void> {
  const activeKey = await getActiveServerKey();
  if (activeKey) {
    await _removeServer(activeKey);
    await clearAllServerData(activeKey);
  }
  _credCache = null;
  await deleteMeta('creds');

  const remaining = await _loadAllServers();
  if (remaining.length === 1) {
    const next = remaining[0];
    await setMeta('active_server_key', next.server_key);
    await initializeServerData(next.server_key);
    _credCache = _entryToCredentials(next);
  } else {
    await deleteMeta('active_server_key');
    _credCache = null;
  }
}

// ── Multi-server API ───────────────────────────────────────────────

export async function loadAllServers(): Promise<ServerEntry[]> {
  const all = await _loadAllServers();
  return all.filter((entry) => !!entry.device_token);
}

export async function saveServer(entry: ServerEntry): Promise<void> {
  await _saveServer(entry);
  await initializeServerData(entry.server_key);
}

export async function removeServer(serverKey: string): Promise<void> {
  const activeKey = await getActiveServerKey();
  await _removeServer(serverKey);
  await clearAllServerData(serverKey);

  if (activeKey === serverKey) {
    const remaining = await _loadAllServers();
    if (remaining.length === 1) {
      const next = remaining[0];
      await setMeta('active_server_key', next.server_key);
      await initializeServerData(next.server_key);
      _credCache = _entryToCredentials(next);
    } else {
      await deleteMeta('active_server_key');
      _credCache = null;
    }
  }
}

export async function removeUnpairedServer(serverKey: string): Promise<void> {
  const entry = await _getServerByKey(serverKey);
  if (!entry || entry.device_token) return;
  await removeServer(serverKey);
}

export async function switchServer(serverKey: string): Promise<Credentials | null> {
  const entry = await _getServerByKey(serverKey);
  if (!entry) return null;
  const updated: ServerEntry = { ...entry, last_used: Date.now() };
  await _saveServer(updated);
  await initializeServerData(serverKey);
  await setMeta('active_server_key', serverKey);
  _credCache = _entryToCredentials(updated);
  return _credCache;
}

export async function migrateServerKey(
  oldKey: string | null | undefined,
  newKey: string,
  patch: Partial<ServerEntry> = {},
): Promise<void> {
  const targetKey = newKey.trim();
  if (!targetKey) return;

  if (!oldKey || oldKey === targetKey) {
    const existing = await _getServerByKey(targetKey);
    if (existing) {
      // Preserve the real server_id (UUID) — never overwrite it with the host
      // string. A stale host as server_id would make the phone hit wrong_server
      // against the live backend every time.
      const updated = {
        ...existing,
        ...patch,
        server_key: targetKey,
        server_id: existing.server_id ?? patch.server_id ?? targetKey,
      };
      await _saveServer(updated);
      _credCache = _entryToCredentials(updated);
    }
    await initializeServerData(targetKey);
    await setMeta('active_server_key', targetKey);
    return;
  }

  const [oldEntry, existingTarget] = await Promise.all([
    _getServerByKey(oldKey),
    _getServerByKey(targetKey),
  ]);
  const mergedEntry: ServerEntry = {
    ...(existingTarget ?? {}),
    ...(oldEntry ?? {}),
    ...patch,
    server_key: targetKey,
    // Carry forward any real server_id (UUID) we already had; only fall back
    // to targetKey (which is a host string) as a last resort. Without this,
    // a host-key migration would silently break auth against the live server.
    server_id:
      existingTarget?.server_id ??
      oldEntry?.server_id ??
      patch.server_id ??
      targetKey,
    last_used: Date.now(),
  } as ServerEntry;

  await _saveServer(mergedEntry);
  await Promise.all([
    moveScopedRows(STORE_SERVER_SONGS, oldKey, targetKey),
    moveScopedRows(STORE_SERVER_LISTS, oldKey, targetKey),
    moveScopedRows(STORE_SERVER_PRIVATE_LISTS, oldKey, targetKey),
    moveScopedRows(STORE_SERVER_BIBLE_BOOKS, oldKey, targetKey),
    moveScopedRows(STORE_SERVER_BIBLE_VERSES, oldKey, targetKey),
    moveKeyedServerRow(STORE_SERVER_QUEUE, oldKey, targetKey),
    moveKeyedServerRow(STORE_SERVER_SYNC_META, oldKey, targetKey),
    moveKeyedServerRow(STORE_SERVER_CACHES, oldKey, targetKey),
    movePendingMutations(oldKey, targetKey),
  ]);
  await _removeServer(oldKey);
  await initializeServerData(targetKey);
  await setMeta('active_server_key', targetKey);
  _credCache = _entryToCredentials(mergedEntry);
}

export async function initializeServerData(serverKey: string): Promise<void> {
  const meta = await getServerSyncMeta(serverKey);
  if (!meta) {
    await putServerSyncMeta({ server_key: serverKey, last_sync_ts: 0, bible_version: null });
  }
}

export { getActiveServerKey };

// ── Internal server helpers ─────────────────────────────────────────

function _entryToCredentials(e: ServerEntry): Credentials {
  return {
    device_id: e.device_id,
    device_token: e.device_token,
    device_name: e.device_name,
    cloud_host: e.cloud_host,
    lan_host: e.lan_host,
    server_name: e.server_name,
    server_id: e.server_id,
    paired_at: e.paired_at,
    server_key: e.server_key,
    can_edit_keys: e.can_edit_keys,
    can_edit_songs: e.can_edit_songs,
  };
}

async function moveScopedRows(storeName: string, oldKey: string, newKey: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const rowsReq = store.getAll();
    const keysReq = store.getAllKeys();
    let rows: any[] | null = null;
    let keys: IDBValidKey[] | null = null;

    function maybeMove() {
      if (!rows || !keys) return;
      rows.forEach((row, index) => {
        if (row?.server_key === oldKey) {
          store.put({ ...row, server_key: newKey });
          store.delete(keys![index]);
        }
      });
    }

    rowsReq.onsuccess = () => {
      rows = (rowsReq.result ?? []) as any[];
      maybeMove();
    };
    keysReq.onsuccess = () => {
      keys = (keysReq.result ?? []) as IDBValidKey[];
      maybeMove();
    };
    rowsReq.onerror = () => reject(rowsReq.error);
    keysReq.onerror = () => reject(keysReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function moveKeyedServerRow(storeName: string, oldKey: string, newKey: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.get(oldKey);
    req.onsuccess = () => {
      if (req.result) {
        store.put({ ...req.result, server_key: newKey });
        store.delete(oldKey);
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function movePendingMutations(oldKey: string, newKey: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    const store = tx.objectStore(STORE_PENDING);
    const req = store.getAll();
    req.onsuccess = () => {
      for (const mutation of (req.result ?? []) as PendingMutation[]) {
        if (mutation.id !== undefined && mutation.server_key === oldKey) {
          store.put({ ...mutation, server_key: newKey });
        }
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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
    tx.objectStore(STORE_SERVERS).put(stripServerCache(entry));
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

async function _removeServerCache(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_CACHES, 'readwrite');
    tx.objectStore(STORE_SERVER_CACHES).delete(key);
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

// ── Sync bookkeeping ───────────────────────────────────────────────

async function getServerSyncMeta(serverKey: string): Promise<ServerSyncMeta | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_SYNC_META, 'readonly');
    const req = tx.objectStore(STORE_SERVER_SYNC_META).get(serverKey);
    req.onsuccess = () => resolve((req.result as ServerSyncMeta) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function putServerSyncMeta(meta: ServerSyncMeta): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_SYNC_META, 'readwrite');
    tx.objectStore(STORE_SERVER_SYNC_META).put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function removeServerSyncMeta(serverKey: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_SYNC_META, 'readwrite');
    tx.objectStore(STORE_SERVER_SYNC_META).delete(serverKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLastSyncTs(): Promise<number> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return 0;
  const meta = await getServerSyncMeta(serverKey);
  return meta?.last_sync_ts ?? 0;
}

export async function setLastSyncTs(ts: number): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  const meta = await getServerSyncMeta(serverKey);
  await putServerSyncMeta({
    server_key: serverKey,
    last_sync_ts: ts,
    bible_version: meta?.bible_version ?? null,
  });
}

export async function getBibleVersion(): Promise<string | null> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return null;
  const meta = await getServerSyncMeta(serverKey);
  return meta?.bible_version ?? null;
}

export async function setBibleVersion(version: string | null): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  const meta = await getServerSyncMeta(serverKey);
  await putServerSyncMeta({
    server_key: serverKey,
    last_sync_ts: meta?.last_sync_ts ?? 0,
    bible_version: version,
  });
}

// ── Songs ──────────────────────────────────────────────────────────

export async function putSongs(songs: LibrarySong[]): Promise<void> {
  if (!songs.length) return;
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  const activeServerKey = serverKey;
  const db = await openDb();

  // Pre-fetch existing keys/timestamps once so we can decide which incoming
  // rows need to inherit the locally-stored song key (key_ts newer locally).
  // Previously this was a sequential get→put chain per song (~3500 round
  // trips through the IndexedDB event loop). Now it's one getAll + N puts
  // issued back-to-back inside the same transaction.
  const existingByKey = new Map<string, { key: string | null | undefined; key_ts: number }>();
  await new Promise<void>((resolve, reject) => {
    const readTx = db.transaction(STORE_SERVER_SONGS, 'readonly');
    const readReq = readTx.objectStore(STORE_SERVER_SONGS).getAll();
    readReq.onsuccess = () => {
      const rows = (readReq.result ?? []) as ScopedSong[];
      for (const row of rows) {
        if (row.server_key === activeServerKey && row.path) {
          existingByKey.set(row.path, { key: row.key, key_ts: row.key_ts || 0 });
        }
      }
      resolve();
    };
    readReq.onerror = () => reject(readReq.error);
  });

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_SONGS, 'readwrite');
    const store = tx.objectStore(STORE_SERVER_SONGS);
    const syncQueue: { path: string; key: string | null | undefined; key_ts: number }[] = [];

    // Issue all puts up front. IndexedDB will queue them inside the
    // transaction; we don't need to wait for each one's onsuccess before
    // issuing the next. This is dramatically faster than serial get→put
    // chaining for 3500-song syncs.
    for (let i = 0; i < songs.length; i++) {
      const s = toIndexedDbValue(songs[i]) as ScopedSong;
      s.server_key = activeServerKey;
      const existing = existingByKey.get(s.path);
      if (existing) {
        const localTs = existing.key_ts || 0;
        const incomingTs = s.key_ts || 0;
        if (localTs > incomingTs) {
          s.key = existing.key;
          s.key_ts = existing.key_ts;
          syncQueue.push({ path: s.path, key: s.key, key_ts: s.key_ts ?? 0 });
        }
      }
      store.put(s);
    }

    tx.oncomplete = () => {
      if (syncQueue.length > 0) {
        void (async () => {
          try {
            for (const item of syncQueue) {
              await addPendingMutation({
                type: 'song.set_key',
                payload: { song_path: item.path, key: item.key, key_ts: item.key_ts },
              });
            }
            const { remote } = await import('./ws');
            if (remote.isOpen()) {
              const mutations = await getPendingMutations();
              for (const m of mutations) {
                if (remote.isOpen()) remote.sendRaw({ type: m.type, payload: m.payload });
              }
              await clearPendingMutations();
            }
          } catch (err) {
            console.error('Failed to sync newer keys back to server:', err);
          }
        })();
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteSongsByPath(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_SONGS, 'readwrite');
    const store = tx.objectStore(STORE_SERVER_SONGS);
    for (const p of paths) store.delete([serverKey, p]);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Apply a remote key change to a single cached song without touching the rest
 * of the library (used by the targeted `song.key_changed` push). Keeps the
 * locally-newer key if the incoming one is older, and only writes if the song
 * is actually cached for the active server.
 */
export async function updateSongKey(
  path: string,
  key: string | null | undefined,
  keyTs?: number | null,
): Promise<boolean> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return false;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_SONGS, 'readwrite');
    const store = tx.objectStore(STORE_SERVER_SONGS);
    const getReq = store.get([serverKey, path]);
    getReq.onsuccess = () => {
      const row = getReq.result as (ScopedSong & { key?: string | null; key_ts?: number }) | undefined;
      if (!row) {
        resolve(false);
        return;
      }
      const incoming = keyTs ?? 0;
      const local = row.key_ts ?? 0;
      if (incoming === 0 || incoming >= local) {
        row.key = key ?? null;
        row.key_ts = incoming || local;
        store.put(row);
      }
      resolve(true);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function clearSongs(): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  await clearScopedStore(STORE_SERVER_SONGS, serverKey);
}

export async function loadAllSongs(): Promise<LibrarySong[]> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return [];
  const rows = await loadScopedRows<ScopedSong>(STORE_SERVER_SONGS, serverKey);
  // NOTE: callers that need display order should sort at the store/UI layer
  // (see sync.ts:sortSongsForDisplay). Sorting here wastes time on every call.
  return rows.map((row) => stripServerKey(row) as LibrarySong);
}

export async function getAllSongPaths(): Promise<string[]> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return [];
  const db = await openDb();
  // getAllKeys on the compound [server_key, path] index is much cheaper than
  // loadAllSongs() + .map(s => s.path) — it skips deserializing slide_texts
  // for every song just to extract the path component.
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_SONGS, 'readonly');
    const req = tx.objectStore(STORE_SERVER_SONGS).getAllKeys();
    req.onsuccess = () => {
      const keys = (req.result ?? []) as unknown[][];
      const paths: string[] = [];
      for (const key of keys) {
        // Compound key is [server_key, path]
        if (Array.isArray(key) && key[0] === serverKey && key.length > 1) {
          paths.push(String(key[1]));
        }
      }
      resolve(paths);
    };
    req.onerror = () => reject(req.error);
  });
}

async function loadScopedRows<T extends { server_key: string }>(
  storeName: string,
  serverKey: string,
): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => {
      const rows = (req.result ?? []) as T[];
      resolve(rows.filter((row) => row.server_key === serverKey));
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Bible cache ────────────────────────────────────────────────────

export async function putBibleBooks(books: BibleBook[]): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_BIBLE_BOOKS, 'readwrite');
    const store = tx.objectStore(STORE_SERVER_BIBLE_BOOKS);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const key of req.result ?? []) {
        if (scopedKeyMatchesServer(key, serverKey)) store.delete(key);
      }
      for (const book of books) store.put({ ...toIndexedDbValue(book), server_key: serverKey });
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAllBibleBooks(): Promise<BibleBook[]> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return [];
  const rows = await loadScopedRows<ScopedBibleBook>(STORE_SERVER_BIBLE_BOOKS, serverKey);
  return rows.map((row) => stripServerKey(row) as BibleBook);
}

export async function clearBibleBooks(): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  await clearScopedStore(STORE_SERVER_BIBLE_BOOKS, serverKey);
}

export async function putBibleVerses(verses: BibleVerse[]): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_BIBLE_VERSES, 'readwrite');
    const store = tx.objectStore(STORE_SERVER_BIBLE_VERSES);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const key of req.result ?? []) {
        if (scopedKeyMatchesServer(key, serverKey)) store.delete(key);
      }
      for (const verse of verses) store.put({ ...toIndexedDbValue(verse), server_key: serverKey });
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAllBibleVerses(): Promise<BibleVerse[]> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return [];
  const rows = await loadScopedRows<ScopedBibleVerse>(STORE_SERVER_BIBLE_VERSES, serverKey);
  return sortBibleVerses(rows.map((row) => stripServerKey(row) as BibleVerse));
}

export async function clearBibleVerses(): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  await clearScopedStore(STORE_SERVER_BIBLE_VERSES, serverKey);
}

// ── Lists ──────────────────────────────────────────────────────────

export async function putLists(lists: LibraryList[]): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  await putScopedListRows(STORE_SERVER_LISTS, serverKey, lists);
}

export function stripListSyncStatus(list: LibraryList): LibraryList {
  return {
    name: list.name,
    songs: (list.songs ?? []).map((song) => ({
      path: song.path,
      name: song.name,
      folder: song.folder,
    })),
  };
}

export function normalizedListName(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function mergeServerListsWithPending(
  serverLists: LibraryList[],
  localLists: LibraryList[],
  pendingMutations: PendingMutation[],
): { merged: LibraryList[]; confirmedKeys: Set<string> } {
  const merged = serverLists.map(stripListSyncStatus);
  const byName = new Map(merged.map((list) => [normalizedListName(list.name), list]));
  const initialServerByName = new Map(
    serverLists.map((list) => [normalizedListName(list.name), list]),
  );
  const localPendingByName = new Map(
    localLists
      .filter((list) => list.sync_status === 'pending')
      .map((list) => [normalizedListName(list.name), list]),
  );

  function removeMergedList(name: unknown) {
    const key = normalizedListName(String(name ?? ''));
    if (!key) return;
    const existing = byName.get(key);
    if (!existing) return;
    const index = merged.indexOf(existing);
    if (index >= 0) merged.splice(index, 1);
    byName.delete(key);
  }

  function useLocalPendingList(name: unknown) {
    const key = normalizedListName(String(name ?? ''));
    if (!key) return;
    const local = localPendingByName.get(key);
    if (!local) return;
    const pendingCopy: LibraryList = { ...stripListSyncStatus(local), sync_status: 'pending' };
    const existing = byName.get(key);
    if (existing) {
      const index = merged.indexOf(existing);
      if (index >= 0) merged[index] = pendingCopy;
    } else {
      merged.push(pendingCopy);
    }
    byName.set(key, pendingCopy);
  }

  for (const mutation of pendingMutations) {
    if (!mutation.type.startsWith('list.')) continue;
    const payload = (mutation.payload ?? {}) as Record<string, unknown>;
    if (mutation.type === 'list.delete') {
      removeMergedList(payload.name);
    } else if (mutation.type === 'list.rename') {
      removeMergedList(payload.old);
      useLocalPendingList(payload.new);
    } else if (mutation.type === 'list.create') {
      useLocalPendingList(payload.name);
    } else if (
      mutation.type === 'list.add_song'
      || mutation.type === 'list.remove_song'
      || mutation.type === 'list.reorder'
    ) {
      useLocalPendingList(payload.list_name);
    }
  }

  const confirmedKeys = new Set<string>();

  for (const local of localLists) {
    if (local.sync_status !== 'pending') continue;
    const key = normalizedListName(local.name);
    if (!key) continue;
    const cleanLocal = stripListSyncStatus(local);
    const pendingSongPaths = new Set(
      cleanLocal.songs.map((s) => s.path).filter(Boolean),
    );

    // Server-side confirmation gate: did the server actually push this list with at
    // least every song the phone's pending copy held? If so, treat pending mutations
    // targeting it as ack'd — drop the badge and queue the mutations for cleanup.
    const serverOriginal = initialServerByName.get(key);
    if (serverOriginal) {
      const serverSongs = stripListSyncStatus(serverOriginal).songs;
      const serverPaths = new Set(serverSongs.map((s) => s.path).filter(Boolean));
      const superset = [...pendingSongPaths].every((p) => serverPaths.has(p));
      if (superset) {
        confirmedKeys.add(key);
        // Restore server's confirmed version (drops the local pending overlay).
        const existing = byName.get(key);
        if (existing) {
          const idx = merged.indexOf(existing);
          if (idx >= 0) {
            const restored = stripListSyncStatus(serverOriginal);
            merged[idx] = restored;
            byName.set(key, restored);
          }
        }
        continue;
      }
    }

    // Server did not confirm (or superset fails) — preserve pending overlay and
    // union-merge any songs the phone knows about that the server push lacked.
    const existing = byName.get(key);
    if (!existing) {
      const pendingCopy: LibraryList = { ...cleanLocal, sync_status: 'pending' };
      merged.push(pendingCopy);
      byName.set(key, pendingCopy);
      continue;
    }

    const seenPaths = new Set(existing.songs.map((song) => song.path));
    for (const song of cleanLocal.songs) {
      if (song.path && !seenPaths.has(song.path)) {
        existing.songs.push(song);
        seenPaths.add(song.path);
      }
    }
    existing.sync_status = 'pending';
  }

  return { merged, confirmedKeys };
}

export async function mergeServerLists(lists: LibraryList[]): Promise<LibraryList[]> {
  const local = await loadAllLists();
  const pending = await getPendingMutations();
  const hasPendingListMutations = pending.some((mutation) => mutation.type.startsWith('list.'));

  let merged: LibraryList[];
  let confirmedKeys = new Set<string>();

  if (hasPendingListMutations) {
    const result = mergeServerListsWithPending(lists, local, pending);
    merged = result.merged;
    confirmedKeys = result.confirmedKeys;
  } else {
    // No pending mutations: server is authoritative, but any leftover local pending
    // badges (e.g. orphaned after a partial flush) still need reconciliation.
    merged = lists.map(stripListSyncStatus);
    for (const localList of local) {
      if (localList.sync_status !== 'pending') continue;
      const key = normalizedListName(localList.name);
      if (!key) continue;
      const serverMatch = merged.find((m) => normalizedListName(m.name) === key);
      if (!serverMatch) continue;
      const cleanLocal = stripListSyncStatus(localList);
      const localPaths = new Set(cleanLocal.songs.map((s) => s.path).filter(Boolean));
      const serverPaths = new Set(serverMatch.songs.map((s) => s.path).filter(Boolean));
      const superset = [...localPaths].every((p) => serverPaths.has(p));
      if (superset) {
        confirmedKeys.add(key);
      } else {
        const seen = new Set(serverMatch.songs.map((s) => s.path));
        for (const s of cleanLocal.songs) {
          if (s.path && !seen.has(s.path)) {
            serverMatch.songs.push(s);
            seen.add(s.path);
          }
        }
        serverMatch.sync_status = 'pending';
      }
    }
  }

  await putLists(merged);
  if (confirmedKeys.size > 0) {
    await clearPendingListMutationsForListNames(confirmedKeys);
  }
  return merged;
}

export async function clearPendingListMutationsForListNames(names: Set<string>): Promise<void> {
  if (!names.size) return;
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    const store = tx.objectStore(STORE_PENDING);
    const req = store.getAll();
    req.onsuccess = () => {
      for (const mutation of (req.result ?? []) as PendingMutation[]) {
        if (mutation.id === undefined) continue;
        if (mutation.server_key !== serverKey) continue;
        if (!mutation.type.startsWith('list.')) continue;
        const payload = (mutation.payload ?? {}) as Record<string, unknown>;
        // Match by any name-carrying field used by list.* mutations.
        const candidates = [payload.name, payload.list_name, payload.new, payload.old];
        const matched = candidates.some(
          (c) => typeof c === 'string' && names.has(normalizedListName(c)),
        );
        if (matched) {
          store.delete(mutation.id);
        }
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadPendingPublicLists(): Promise<LibraryList[]> {
  return (await loadAllLists()).filter((list) => list.sync_status === 'pending');
}

export async function loadAllLists(): Promise<LibraryList[]> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return [];
  const rows = await loadScopedRows<ScopedList>(STORE_SERVER_LISTS, serverKey);
  return rows.map((row) => stripServerKey(row) as LibraryList);
}

export async function clearLists(): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  await clearScopedStore(STORE_SERVER_LISTS, serverKey);
}

export async function putPrivateLists(lists: LibraryList[]): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  await putScopedListRows(STORE_SERVER_PRIVATE_LISTS, serverKey, lists);
}

export async function loadAllPrivateLists(): Promise<LibraryList[]> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return [];
  const rows = await loadScopedRows<ScopedList>(STORE_SERVER_PRIVATE_LISTS, serverKey);
  return rows.map((row) => stripServerKey(row) as LibraryList);
}

export async function clearPrivateLists(): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  await clearScopedStore(STORE_SERVER_PRIVATE_LISTS, serverKey);
}

async function putScopedListRows(
  storeName: string,
  serverKey: string,
  lists: LibraryList[],
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const key of req.result ?? []) {
        if (scopedKeyMatchesServer(key, serverKey)) store.delete(key);
      }
      for (const list of lists) {
        // Preserve sync_status: 'pending' for public lists so the offline
        // pending state survives reloads and reconnects. stripListSyncStatus
        // is still called explicitly wherever lists cross the wire to the server.
        store.put({ ...toIndexedDbValue(list), server_key: serverKey });
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Queue cache ────────────────────────────────────────────────────

export async function cacheQueueState(queue: QueueState | null): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_QUEUE, 'readwrite');
    tx.objectStore(STORE_SERVER_QUEUE).put({
      server_key: serverKey,
      queue: toIndexedDbValue(queue),
    } satisfies ServerQueueRow);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCachedQueueState(): Promise<QueueState | null> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_QUEUE, 'readonly');
    const req = tx.objectStore(STORE_SERVER_QUEUE).get(serverKey);
    req.onsuccess = () => resolve(((req.result as ServerQueueRow | undefined)?.queue) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function removeServerQueue(serverKey: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_QUEUE, 'readwrite');
    tx.objectStore(STORE_SERVER_QUEUE).delete(serverKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Pending offline mutations ──────────────────────────────────────

export interface PendingMutation {
  id?: number;
  server_key?: string | null;
  type: string;
  payload?: unknown;
  created_at: number;
}

export async function addPendingMutation(cmd: { type: string; payload?: unknown }): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    tx.objectStore(STORE_PENDING).add(toIndexedDbValue({
      server_key: serverKey,
      type: cmd.type,
      payload: cmd.payload,
      created_at: Date.now(),
    }));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingMutations(): Promise<PendingMutation[]> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return [];
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readonly');
    const req = tx.objectStore(STORE_PENDING).getAll();
    req.onsuccess = () => {
      const all = (req.result ?? []) as PendingMutation[];
      resolve(all.filter((m) => m.server_key === serverKey));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearPendingMutations(): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  await clearPendingMutationsForServer(serverKey);
}

export async function deletePendingMutation(id: number | undefined): Promise<void> {
  if (id === undefined) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    tx.objectStore(STORE_PENDING).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearPendingListMutations(): Promise<void> {
  const serverKey = await requireActiveServerKey();
  if (!serverKey) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    const store = tx.objectStore(STORE_PENDING);
    const req = store.getAll();
    req.onsuccess = () => {
      for (const mutation of (req.result ?? []) as PendingMutation[]) {
        if (
          mutation.id !== undefined
          && mutation.server_key === serverKey
          && mutation.type.startsWith('list.')
        ) {
          store.delete(mutation.id);
        }
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearPendingMutationsForServer(serverKey: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    const store = tx.objectStore(STORE_PENDING);
    const req = store.getAll();
    req.onsuccess = () => {
      const all = (req.result ?? []) as PendingMutation[];
      for (const mutation of all) {
        if (mutation.id !== undefined && mutation.server_key === serverKey) {
          store.delete(mutation.id);
        }
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Backup / Import ───────────────────────────────────────────────

export interface BackupData {
  version: number;
  exported_at: number;
  servers: ServerEntry[];
  server_data?: ServerDataBackup[];
  active_server_key: string | null;
  device_id: string | null;
  // Legacy v8 backup shape. Kept optional so older backups can still import.
  songs?: LibrarySong[];
  lists?: LibraryList[];
  private_lists?: LibraryList[];
  bible_books?: BibleBook[];
  bible_verses?: BibleVerse[];
  bible_version?: string | null;
}

export async function exportBackup(): Promise<BackupData> {
  const servers = await _loadAllServers();
  const activeKey = await getActiveServerKey();
  const deviceId = await getRow<string>('device_id');
  const serverData = await Promise.all(servers.map((server) => loadServerData(server.server_key)));
  const activeData = activeKey ? serverData.find((data) => data.server_key === activeKey) : null;
  return {
    version: DB_VERSION,
    exported_at: Date.now(),
    servers,
    server_data: serverData,
    active_server_key: activeKey,
    device_id: deviceId,
    songs: activeData?.songs ?? [],
    lists: activeData?.lists ?? [],
    private_lists: activeData?.private_lists ?? [],
    bible_books: activeData?.bible_books ?? [],
    bible_verses: activeData?.bible_verses ?? [],
    bible_version: activeData?.bible_version ?? null,
  };
}

export interface BackupComparison {
  current: { songs: number; lists: number; servers: number };
  backup: { songs: number; lists: number; servers: number; exported_at: number };
  backupIsOlder: boolean;
  backupHasLess: boolean;
}

export async function compareBackup(data: BackupData): Promise<BackupComparison> {
  const currentData = await Promise.all((await _loadAllServers()).map((server) => loadServerData(server.server_key)));
  const backupServerData = normalizeBackupServerData(data);
  const currentSongs = currentData.reduce((total, item) => total + item.songs.length, 0);
  const currentLists = currentData.reduce((total, item) => total + item.lists.length + item.private_lists.length, 0);
  const backupSongs = backupServerData.reduce((total, item) => total + item.songs.length, 0);
  const backupLists = backupServerData.reduce((total, item) => total + item.lists.length + item.private_lists.length, 0);
  const currentServers = await _loadAllServers();
  return {
    current: { songs: currentSongs, lists: currentLists, servers: currentServers.length },
    backup: {
      songs: backupSongs,
      lists: backupLists,
      servers: data.servers.length,
      exported_at: data.exported_at,
    },
    backupIsOlder: data.exported_at < Date.now() - 60_000,
    backupHasLess: backupSongs < currentSongs,
  };
}

export async function importBackup(data: BackupData): Promise<void> {
  const serverData = normalizeBackupServerData(data);
  await clearAllServerScopedStores();

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([
      STORE_SERVERS,
      STORE_SERVER_SONGS,
      STORE_SERVER_LISTS,
      STORE_SERVER_PRIVATE_LISTS,
      STORE_SERVER_BIBLE_BOOKS,
      STORE_SERVER_BIBLE_VERSES,
      STORE_SERVER_QUEUE,
      STORE_SERVER_SYNC_META,
    ], 'readwrite');
    const serversStore = tx.objectStore(STORE_SERVERS);
    serversStore.clear();
    for (const server of data.servers) serversStore.put(stripServerCache(server));
    for (const item of serverData) {
      putScopedRows(tx.objectStore(STORE_SERVER_SONGS), item.server_key, item.songs);
      putScopedRows(tx.objectStore(STORE_SERVER_LISTS), item.server_key, item.lists);
      putScopedRows(tx.objectStore(STORE_SERVER_PRIVATE_LISTS), item.server_key, item.private_lists);
      putScopedRows(tx.objectStore(STORE_SERVER_BIBLE_BOOKS), item.server_key, item.bible_books);
      putScopedRows(tx.objectStore(STORE_SERVER_BIBLE_VERSES), item.server_key, item.bible_verses);
      tx.objectStore(STORE_SERVER_QUEUE).put({
        server_key: item.server_key,
        queue: item.queue ?? null,
      } satisfies ServerQueueRow);
      tx.objectStore(STORE_SERVER_SYNC_META).put({
        server_key: item.server_key,
        last_sync_ts: item.last_sync_ts ?? 0,
        bible_version: item.bible_version ?? null,
      } satisfies ServerSyncMeta);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  if (data.active_server_key) await setMeta('active_server_key', data.active_server_key);
  else await deleteMeta('active_server_key');
  if (data.device_id) await setMeta('device_id', data.device_id);
  _credCache = undefined;
}

async function loadServerData(serverKey: string): Promise<ServerDataBackup> {
  const [songs, lists, privateLists, bibleBooks, bibleVerses, queue, meta] = await Promise.all([
    loadScopedRows<ScopedSong>(STORE_SERVER_SONGS, serverKey),
    loadScopedRows<ScopedList>(STORE_SERVER_LISTS, serverKey),
    loadScopedRows<ScopedList>(STORE_SERVER_PRIVATE_LISTS, serverKey),
    loadScopedRows<ScopedBibleBook>(STORE_SERVER_BIBLE_BOOKS, serverKey),
    loadScopedRows<ScopedBibleVerse>(STORE_SERVER_BIBLE_VERSES, serverKey),
    getServerQueue(serverKey),
    getServerSyncMeta(serverKey),
  ]);
  return {
    server_key: serverKey,
    songs: songs.map((row) => stripServerKey(row) as LibrarySong),
    lists: lists.map((row) => stripServerKey(row) as LibraryList),
    private_lists: privateLists.map((row) => stripServerKey(row) as LibraryList),
    bible_books: bibleBooks.map((row) => stripServerKey(row) as BibleBook),
    bible_verses: sortBibleVerses(bibleVerses.map((row) => stripServerKey(row) as BibleVerse)),
    bible_version: meta?.bible_version ?? null,
    queue,
    last_sync_ts: meta?.last_sync_ts ?? 0,
  };
}

async function getServerQueue(serverKey: string): Promise<QueueState | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SERVER_QUEUE, 'readonly');
    const req = tx.objectStore(STORE_SERVER_QUEUE).get(serverKey);
    req.onsuccess = () => resolve(((req.result as ServerQueueRow | undefined)?.queue) ?? null);
    req.onerror = () => reject(req.error);
  });
}

function normalizeBackupServerData(data: BackupData): ServerDataBackup[] {
  if (Array.isArray(data.server_data)) return data.server_data;
  const activeKey = data.active_server_key ?? data.servers[0]?.server_key;
  if (!activeKey) return [];
  return [{
    server_key: activeKey,
    songs: data.songs ?? [],
    lists: data.lists ?? [],
    private_lists: data.private_lists ?? [],
    bible_books: data.bible_books ?? [],
    bible_verses: data.bible_verses ?? [],
    bible_version: data.bible_version ?? null,
    queue: null,
    last_sync_ts: 0,
  }];
}
