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
  exclusive_device_id?: string | null;
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
  is_bible?: boolean;
  bible_refs?: BibleRef[];
  bible_ref_display?: string;
}

// ── Queue state broadcast ────────────────────────────────────────────
export interface BibleRef {
  book: string;
  chapter: number;
  verse: number;
}

export interface QueueItem {
  path: string;
  name: string;
  folder: string;
  is_merged?: boolean;
  is_bible?: boolean;
  bible_refs?: BibleRef[];
}

export interface QueueState {
  items: QueueItem[];
  current_song_index: number;
  playing_song_index: number;
  current_slide_index: number;
}

export interface BibleBook {
  book_num: number;
  name: string;
  max_chapter: number;
}

export interface BibleVerse {
  id: string;
  book_num: number;
  chapter: number;
  verse: number;
  text: string;
}

export interface BibleSyncData {
  version: string | null;
  books: BibleBook[];
  verses: BibleVerse[];
}

// ── Library song (shape used in sync payloads + IndexedDB) ──────────
export interface LibrarySong {
  path: string;
  name: string;
  folder: string;
  slide_texts: string[];
  chorus_index?: number;
  modified_ts?: number;
}

export interface LibraryList {
  name: string;
  songs: { path: string; name: string; folder: string }[];
}

// ── Sync (client → server) ───────────────────────────────────────────
export interface SyncRequest {
  since_ts: number; // 0 → force full resync
}

// ── Sync (server → client) ───────────────────────────────────────────
export interface SyncFull {
  songs: LibrarySong[];
  lists: LibraryList[];
  bible?: BibleSyncData | null;
  server_ts: number;
}

export interface SyncDelta {
  songs_changed: LibrarySong[];
  all_song_paths: string[];    // every current path — drives removal detection
  lists: LibraryList[] | null; // null means no list changes
  all_list_names: string[];
  bible?: BibleSyncData | null;
  server_ts: number;
}

// ── Lists broadcast (server → client) ───────────────────────────────
export interface ListsState {
  lists: LibraryList[];
}

// ── Exclusive mode (server → client) ─────────────────────────────────
export interface ExclusiveChanged {
  exclusive_device_id: string | null;
  device_name: string | null;
}

// ── Commands (client → server) ───────────────────────────────────────
export type ClientCommand =
  | { type: 'live.next' }
  | { type: 'live.prev' }
  | { type: 'live.blank' }
  | { type: 'live.freeze' }
  | { type: 'live.goto'; payload: { song_index: number; slide_index: number } }
  | { type: 'live.follow'; payload: { enabled: boolean } }
  | { type: 'queue.add'; payload: { song_path: string; position?: number } }
  | { type: 'queue.add_bible_verse'; payload: { book: string; chapter: number; verse: number; position?: number } }
  | { type: 'queue.remove'; payload: { position: number } }
  | { type: 'queue.reorder'; payload: { from: number; to: number } }
  | { type: 'queue.clear' }
  | { type: 'list.create'; payload: { name: string } }
  | { type: 'list.delete'; payload: { name: string } }
  | { type: 'list.rename'; payload: { old: string; new: string } }
  | { type: 'list.add_song'; payload: { list_name: string; song_path: string; position?: number } }
  | { type: 'list.remove_song'; payload: { list_name: string; position: number } }
  | { type: 'list.reorder'; payload: { list_name: string; from: number; to: number } }
  | { type: 'list.load_to_queue'; payload: { list_name: string } }
  | { type: 'sync.request'; id?: string; payload: { since_ts: number } }
  | { type: 'device.rename'; payload: { new_name: string } }
  | { type: 'live.toggle_present' }
  | { type: 'live.font_size'; payload: { delta: number } };
