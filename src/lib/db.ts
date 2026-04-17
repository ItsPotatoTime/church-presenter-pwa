// IndexedDB wrapper.
// Object stores:
//   meta              — {key, value} rows: creds, device_id, last_sync_ts
//   songs             — keyed by song path
//   lists             — keyed by list name
//   pending_mutations — offline-queued list commands, replayed on reconnect
//
// Version 2 adds `songs` + `lists` stores (Phase 2).
// Version 3 adds `pending_mutations` (Phase 5 offline list editing).

import type { LibrarySong, LibraryList } from './protocol';

const DB_NAME = 'church-remote';
const DB_VERSION = 3;
const STORE_META = 'meta';
const STORE_SONGS = 'songs';
const STORE_LISTS = 'lists';
const STORE_PENDING = 'pending_mutations';

export interface Credentials {
  device_id: string;
  device_token: string;
  device_name: string;
  cloud_host: string | null;
  lan_host: string | null;
  server_name?: string;
  paired_at?: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_SONGS)) {
        db.createObjectStore(STORE_SONGS, { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains(STORE_LISTS)) {
        db.createObjectStore(STORE_LISTS, { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains(STORE_PENDING)) {
        db.createObjectStore(STORE_PENDING, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getRow<T>(key: string, store = STORE_META): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => {
      const row = req.result as { key: string; value: T } | T | undefined;
      if (!row) return resolve(null);
      // meta store uses {key, value}; songs/lists store whole object
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

// ── Credentials ────────────────────────────────────────────────────
// In-memory cache so tab-switch onMount reads are instant after first load.
let _credCache: Credentials | null | undefined = undefined;

export async function loadCredentials(): Promise<Credentials | null> {
  if (_credCache !== undefined) return _credCache;
  const result = await getRow<Credentials>('creds');
  _credCache = result;
  return result;
}

export async function saveCredentials(c: Credentials): Promise<void> {
  _credCache = c;
  await setMeta('creds', c);
}

export async function clearCredentials(): Promise<void> {
  _credCache = null;
  await deleteMeta('creds');
}

export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await getRow<string>('device_id');
  if (existing) return existing;
  const id = crypto.randomUUID();
  await setMeta('device_id', id);
  return id;
}

// ── Sync bookkeeping ───────────────────────────────────────────────

export async function getLastSyncTs(): Promise<number> {
  return (await getRow<number>('last_sync_ts')) ?? 0;
}

export async function setLastSyncTs(ts: number): Promise<void> {
  await setMeta('last_sync_ts', ts);
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

// ── Pending offline mutations ──────────────────────────────────────
// Commands queued while disconnected; flushed to server on reconnect.

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
