// Svelte stores for connection status + live broadcast state + cached library.
import { derived, writable, type Readable, type Writable } from 'svelte/store';
import type {
  BibleBook,
  BibleVerse,
  LibraryList,
  LibrarySong,
  LiveState,
  QueueState,
} from './protocol';

export type ConnStatus =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'open'
  | 'error'
  | 'closed';

export const connStatus: Writable<ConnStatus> = writable('idle');
export const connError: Writable<string | null> = writable(null);
export const connEndpoint: Writable<'cloud' | 'lan' | null> = writable(null);

export const liveState: Writable<LiveState | null> = writable(null);
export const queueState: Writable<QueueState | null> = writable(null);

export const songsStore: Writable<LibrarySong[]> = writable([]);
export const listsStore: Writable<LibraryList[]> = writable([]);
export const bibleBooksStore: Writable<BibleBook[]> = writable([]);
export const bibleVersesStore: Writable<BibleVerse[]> = writable([]);
export const bibleVersionStore: Writable<string | null> = writable(null);

export type SyncStatus = 'idle' | 'syncing' | 'error';
export const syncStatus: Writable<SyncStatus> = writable('idle');

// Exclusive mode — null means open (everyone can control).
export const exclusiveDeviceId: Writable<string | null> = writable(null);
export const exclusiveDeviceName: Writable<string | null> = writable(null);

// Our own device id (from IndexedDB). Hydrated once on app startup.
export const myDeviceId: Writable<string | null> = writable(null);

export const serverName: Writable<string> = writable('ChurchPresenter');

export const canEditKeys: Writable<boolean> = writable(false);
export const canEditSongs: Writable<boolean> = writable(false);

export const debugMode: Writable<boolean> = writable(
  typeof window !== 'undefined' ? localStorage.getItem('debug_mode') === 'true' : false
);

if (typeof window !== 'undefined') {
  debugMode.subscribe((value) => {
    localStorage.setItem('debug_mode', String(value));
  });
}

/** True when a *different* phone holds exclusive control — this phone is view-only. */
export const isViewOnly: Readable<boolean> = derived(
  [exclusiveDeviceId, myDeviceId],
  ([$ex, $me]) => $ex !== null && $ex !== $me,
);

// Registry for active modal/dialog close callbacks
export const activeModals: Writable<(() => boolean)[]> = writable([]);

function persistentString(key: string, fallback: string): Writable<string> {
  const initial = typeof window !== 'undefined' ? (localStorage.getItem(key) ?? fallback) : fallback;
  const store = writable(initial);
  if (typeof window !== 'undefined') {
    store.subscribe((value) => {
      localStorage.setItem(key, value);
    });
  }
  return store;
}

function persistentBoolean(key: string, fallback: boolean): Writable<boolean> {
  const initial = typeof window !== 'undefined'
    ? localStorage.getItem(key) === null
      ? fallback
      : localStorage.getItem(key) === 'true'
    : fallback;
  const store = writable(initial);
  if (typeof window !== 'undefined') {
    store.subscribe((value) => {
      localStorage.setItem(key, String(value));
    });
  }
  return store;
}

// Saved state for Library page to support scroll and view preservation
export const libraryScrollY: Writable<number> = writable(0);
export const libraryRenderCount: Writable<number> = writable(300);
export const libraryRawQuery: Writable<string> = persistentString('library_raw_query', '');
export const librarySearchSlides: Writable<boolean> = persistentBoolean('library_search_slides', false);
export const libraryBibleCurrentBookNum: Writable<number | null> = writable(null);
export const libraryBibleCurrentChapter: Writable<number | null> = writable(null);
export const libraryBibleRawQuery: Writable<string> = writable('');
export const libraryBibleSearchMode: Writable<'reference' | 'text'> = writable('reference');

// Private lists store
export const privateListsStore: Writable<LibraryList[]> = writable([]);

// Saved state for Lists page to support view preservation and scroll retention
export const listsActiveTab: Writable<'public' | 'private'> = writable('public');
export const listsSelectedName: Writable<string | null> = writable(null);
export const listsShowPicker: Writable<boolean> = writable(false);
export const listsPickerRawQuery: Writable<string> = writable('');
export const listsScrollY: Writable<number> = writable(0);

const MANAGER_ACCESS_EXPIRES_AT_KEY = 'manager_access_expires_at';

function readManagerAccessRemaining(): number {
  if (typeof window === 'undefined') return 0;
  const raw = localStorage.getItem(MANAGER_ACCESS_EXPIRES_AT_KEY);
  const expiresAt = raw ? Number(raw) : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    localStorage.removeItem(MANAGER_ACCESS_EXPIRES_AT_KEY);
    return 0;
  }
  const remaining = Math.ceil((expiresAt - Date.now()) / 1000);
  if (remaining <= 0) {
    localStorage.removeItem(MANAGER_ACCESS_EXPIRES_AT_KEY);
    return 0;
  }
  return remaining;
}

// Global countdown for temporary phone manager access (shared state across tabs)
export const managerAccessCountdown: Writable<number> = writable(readManagerAccessRemaining());

export function setManagerAccessDuration(seconds: number): void {
  if (typeof window === 'undefined') {
    managerAccessCountdown.set(Math.max(0, seconds));
    return;
  }
  if (seconds <= 0) {
    localStorage.removeItem(MANAGER_ACCESS_EXPIRES_AT_KEY);
    managerAccessCountdown.set(0);
    return;
  }
  localStorage.setItem(MANAGER_ACCESS_EXPIRES_AT_KEY, String(Date.now() + seconds * 1000));
  managerAccessCountdown.set(readManagerAccessRemaining());
}

export function refreshManagerAccessCountdown(): number {
  const remaining = readManagerAccessRemaining();
  managerAccessCountdown.set(remaining);
  return remaining;
}
