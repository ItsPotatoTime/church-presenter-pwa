// IndexedDB wrapper for persisting phone credentials.
// One object store: `meta` holding {key, value} rows.

const DB_NAME = 'church-remote';
const DB_VERSION = 1;
const STORE = 'meta';

export interface Credentials {
  device_id: string;
  device_token: string;
  device_name: string;
  cloud_host: string | null; // e.g. "funny-horse.trycloudflare.com"
  lan_host: string | null;   // e.g. "192.168.1.12:8765"
  server_name?: string;
  paired_at?: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getRow<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      const row = req.result as { key: string; value: T } | undefined;
      resolve(row ? row.value : null);
    };
    req.onerror = () => reject(req.error);
  });
}

async function setRow<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteRow(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Public API ──────────────────────────────────────────────────────

export async function loadCredentials(): Promise<Credentials | null> {
  return getRow<Credentials>('creds');
}

export async function saveCredentials(c: Credentials): Promise<void> {
  await setRow('creds', c);
}

export async function clearCredentials(): Promise<void> {
  await deleteRow('creds');
}

// Generate a stable, persistent device_id the first time we run.
export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await getRow<string>('device_id');
  if (existing) return existing;
  const id = crypto.randomUUID();
  await setRow('device_id', id);
  return id;
}
