// Svelte stores for connection status + live broadcast state + cached library.
import { derived, writable, type Readable, type Writable } from 'svelte/store';
import type { LibraryList, LibrarySong, LiveState, QueueState } from './protocol';

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

export type SyncStatus = 'idle' | 'syncing' | 'error';
export const syncStatus: Writable<SyncStatus> = writable('idle');

// Exclusive mode — null means open (everyone can control).
export const exclusiveDeviceId: Writable<string | null> = writable(null);
export const exclusiveDeviceName: Writable<string | null> = writable(null);

// Our own device id (from IndexedDB). Hydrated once on app startup.
export const myDeviceId: Writable<string | null> = writable(null);

export const serverName: Writable<string> = writable('ChurchPresenter');

// Phone-local toggle: when false, phone sends `live.follow {enabled:false}` so
// the desktop skips pushing `live.state` to us.
export const liveFollowEnabled: Writable<boolean> = writable(true);

/** True when a *different* phone holds exclusive control — this phone is view-only. */
export const isViewOnly: Readable<boolean> = derived(
  [exclusiveDeviceId, myDeviceId],
  ([$ex, $me]) => $ex !== null && $ex !== $me,
);
