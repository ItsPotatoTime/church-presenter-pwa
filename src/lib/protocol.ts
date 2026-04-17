// Wire protocol shared with the Python `remote_server.py`.
// Any change here must be mirrored there.

export interface Envelope<T = unknown> {
  type: string;
  id?: string;
  payload?: T;
}

// ── Auth ─────────────────────────────────────────────────────────────
export interface AuthFirstPair {
  pair_token: string;
  device_id: string;
  device_name: string;
  platform: string;
}

export interface AuthReconnect {
  device_id: string;
  device_token: string;
}

export interface AuthOk {
  device_token: string; // empty string on reconnect
  server_name: string;
  version: string;
}

export interface AuthFail {
  reason:
    | 'bad_device_id'
    | 'pair_token_expired'
    | 'missing_token'
    | 'revoked'
    | 'bad_token';
}

// ── Live state broadcast ─────────────────────────────────────────────
export interface LiveState {
  song_name: string | null;
  song_path?: string;
  song_index: number;
  slide_index: number;
  slides: string[];
  blanked: boolean;
  presenting: boolean;
}

// ── Commands (client → server) ───────────────────────────────────────
export type ClientCommand =
  | { type: 'live.next' }
  | { type: 'live.prev' }
  | { type: 'live.blank' }
  | { type: 'live.freeze' }
  | { type: 'live.goto'; payload: { song_index: number; slide_index: number } }
  | { type: 'device.rename'; payload: { new_name: string } };
