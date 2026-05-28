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

/** True when a *different* phone holds exclusive control — this phone is view-only. */
export const isViewOnly: Readable<boolean> = derived(
  [exclusiveDeviceId, myDeviceId],
  ([$ex, $me]) => $ex !== null && $ex !== $me,
);

// Registry for active modal/dialog close callbacks
export const activeModals: Writable<(() => boolean)[]> = writable([]);

// Saved state for Library page to support scroll and view preservation
export const libraryScrollY: Writable<number> = writable(0);
export const libraryRenderCount: Writable<number> = writable(300);
export const libraryRawQuery: Writable<string> = writable('');
export const librarySearchSlides: Writable<boolean> = writable(false);
export const libraryBibleCurrentBookNum: Writable<number | null> = writable(null);
export const libraryBibleCurrentChapter: Writable<number | null> = writable(null);
export const libraryBibleRawQuery: Writable<string> = writable('');
export const libraryBibleSearchMode: Writable<'reference' | 'text'> = writable('reference');

