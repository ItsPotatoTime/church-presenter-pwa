// Svelte stores for connection status + live broadcast state.
import { writable, type Writable } from 'svelte/store';
import type { LiveState } from './protocol';

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
