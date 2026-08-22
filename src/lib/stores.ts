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
export const connEndpoint: Writable<'cloud' | 'lan' | 'bridge' | null> = writable(null);

// When connected to the cloud bridge (wss://), this reflects whether the live
// desktop is actually up (true) or only the cloud mirror is reachable (false).
// Drives the LIVE tab "Live" vs "Cloud only" label and the settings status dot.
// `null` = unknown / not connected to a cloud bridge.
export const desktopOnline: Writable<boolean | null> = writable(null);

export const liveState: Writable<LiveState | null> = writable(null);
export const queueState: Writable<QueueState | null> = writable(null);
// True while the user is mid-drag reordering the queue on this device. Used to
// suppress incoming queue.state echoes so a re-render mid-drag can't corrupt the
// drop-index calculation.
export const queueDragActive: Writable<boolean> = writable(false);

export const songsStore: Writable<LibrarySong[]> = writable([]);

// Path -> song and path -> key maps shared by every page that needs to
// resolve a queue/list entry against the library (Queue rows, Lists sheet,
// preview modals). Computing them HERE means one rebuild per songsStore
// change no matter how many pages are mounted; per-page $derived copies each
// rebuilt their own 3500-entry Map on every store touch.
export const songsByPath: Readable<Map<string, LibrarySong>> = derived(
  songsStore,
  (songs) => {
    const m = new Map<string, LibrarySong>();
    for (const s of songs) m.set(s.path, s);
    return m;
  },
);

export const songKeysByPath: Readable<Map<string, string | null | undefined>> = derived(
  songsStore,
  (songs) => {
    const m = new Map<string, string | null | undefined>();
    for (const s of songs) m.set(s.path, s.key);
    return m;
  },
);
export const listsStore: Writable<LibraryList[]> = writable([]);
export const bibleBooksStore: Writable<BibleBook[]> = writable([]);
export const bibleVersesStore: Writable<BibleVerse[]> = writable([]);
export const bibleVersionStore: Writable<string | null> = writable(null);

export type SyncStatus = 'idle' | 'syncing' | 'error';
export const syncStatus: Writable<SyncStatus> = writable('idle');

// Last error from the deferred pending-list sync flow (offline → reconnect).
// Null means last attempt succeeded or hasn't run yet. Surfaced to the user as
// a toast/banner — pending mutations stay in IDB for retry on next reconnect.
export const pendingSyncError: Writable<string | null> = writable(null);

// Exclusive mode — null means open (everyone can control).
export const exclusiveDeviceId: Writable<string | null> = writable(null);
export const exclusiveDeviceName: Writable<string | null> = writable(null);

// Our own device id (from IndexedDB). Hydrated once on app startup.
export const myDeviceId: Writable<string | null> = writable(null);

export const serverName: Writable<string> = writable('ChurchPresenter');

export const canEditKeys: Writable<boolean> = writable(false);
export const canEditSongs: Writable<boolean> = writable(false);
export const canEditDisplays: Writable<boolean> = writable(false);

export const debugMode: Writable<boolean> = writable(
  typeof window !== 'undefined' ? localStorage.getItem('debug_mode') === 'true' : false
);

if (typeof window !== 'undefined') {
  debugMode.subscribe((value) => {
    localStorage.setItem('debug_mode', String(value));
  });
}

// ── Cloud bridge diagnostics ────────────────────────────────────────
// Ring buffer of the last cloud-probe / bridge-selection events so the user can
// diagnose "Cloud: offline" from the Settings page instead of guessing. Each
// entry records what URL was *built* (after scheme normalization) and why the
// probe succeeded or failed. Kept small (latest first).
export interface CloudDiagnostic {
  // `id` is a monotonic sequence number and is the stable, unique key for the
  // Settings `{#each}`. `ts` (Date.now) is NOT unique enough — two events pushed
  // in the same millisecond collide, which made Svelte throw `each_key_duplicate`
  // and crash the Settings route.
  id: number;
  ts: number;
  kind: 'endpoint' | 'ws' | 'status' | 'error' | 'info';
  message: string;
  detail?: string;
}

export const cloudDiagnostics: Writable<CloudDiagnostic[]> = writable([]);

const CLOUD_DIAG_MAX = 40;
let cloudDiagSeq = 0;

export function pushCloudDiagnostic(
  kind: CloudDiagnostic['kind'],
  message: string,
  detail?: string,
): void {
  const entry: CloudDiagnostic = { id: ++cloudDiagSeq, ts: Date.now(), kind, message, detail };
  cloudDiagnostics.update((list) => [entry, ...list].slice(0, CLOUD_DIAG_MAX));
}

/** True when a *different* phone holds exclusive control — this phone is view-only. */
export const isViewOnly: Readable<boolean> = derived(
  [exclusiveDeviceId, myDeviceId],
  ([$ex, $me]) => $ex !== null && $ex !== $me,
);

// Registry for active modal/dialog close callbacks
export const activeModals: Writable<(() => boolean)[]> = writable([]);

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
if (typeof window !== 'undefined') {
	localStorage.removeItem('library_raw_query');
}

export const libraryScrollY: Writable<number> = writable(0);
export const libraryRenderCount: Writable<number> = writable(300);
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
export const listsPickerSearchSlides: Writable<boolean> = persistentBoolean('lists_picker_search_slides', false);
export const listsScrollY: Writable<number> = writable(0);

// List-card ordering (Newest first by creation time is the default) and the
// search box text; both survive navigation like the rest of the Lists state.
export type ListSortMode = 'newest' | 'oldest' | 'az' | 'za' | 'songs';

const LISTS_SORT_KEY = 'lists_sort_mode';
const LIST_SORT_VALUES: ListSortMode[] = ['newest', 'oldest', 'az', 'za', 'songs'];

function readListSortMode(): ListSortMode {
  if (typeof window === 'undefined') return 'newest';
  const raw = localStorage.getItem(LISTS_SORT_KEY);
  return LIST_SORT_VALUES.includes(raw as ListSortMode) ? (raw as ListSortMode) : 'newest';
}

export const listsSortMode: Writable<ListSortMode> = writable(readListSortMode());
if (typeof window !== 'undefined') {
  listsSortMode.subscribe((value) => localStorage.setItem(LISTS_SORT_KEY, value));
}
export const listsRawQuery: Writable<string> = writable('');
