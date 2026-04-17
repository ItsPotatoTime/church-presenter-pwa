// Svelte stores for connection status + live broadcast state + cached library.
import { writable, type Writable } from 'svelte/store';
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
