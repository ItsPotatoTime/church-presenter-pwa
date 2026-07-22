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
  server_id?: string;
}

export interface AuthReconnect {
  device_id: string;
  device_token: string;
  server_id?: string;
}

export interface AuthOk {
  device_token: string; // empty string on reconnect
  server_name: string;
  server_id?: string;
  version: string;
  exclusive_device_id?: string | null;
  can_edit_keys?: boolean;
  can_edit_songs?: boolean;
  can_edit_displays?: boolean;
  // True when the *live desktop* is up behind the cloud bridge (drives the
  // PWA "Live" vs "Cloud only" label). Only present when connected to the
  // cloud server; older desktops / direct LAN never set it.
  desktop_online?: boolean;
  // Cloud bridge public URL (and id). The cloud server is authoritative for its
  // own host; when present the phone learns the bridge to fall back to when the
  // desktop closes, so it never loses connectivity entirely.
  cloud_url?: string | null;
  cloud_host?: string | null;
  cloud_id?: string | null;
}

// Whether the cloud bridge for a server is reachable / the desktop behind it
// is live. Drives the per-server status dot in Settings and the LIVE tab.
export type CloudStatus = 'online' | 'offline' | 'unknown';

export interface AuthFail {
  reason:
    | 'bad_device_id'
    | 'pair_token_expired'
    | 'missing_token'
    | 'revoked'
    | 'bad_token'
    | 'banned'
    | 'server_unregistered'
    | 'wrong_server';
  // Server includes its own identity in every auth.fail so the phone can
  // auto-switch to the right stored server entry on wrong_server, and
  // surface a useful diagnostic otherwise.
  server_id?: string;
  server_name?: string;
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
  // current_song_index: the focused/selected queue item (driven by `queue.select`).
  // Distinct from playing_song_index when the item is previewed but not yet live.
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
  normalized_text?: string;
}

export interface BibleSearchResult {
  book_num: number;
  book_name: string;
  chapter: number;
  verse: number;
  text: string;
  score: number;
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
  chorus_ranges?: number[][];
  modified_ts?: number;
  normalized_name?: string;
  normalized_folder?: string;
  normalized_blob?: string;
  key?: string | null;
  key_ts?: number | null;
}

export interface LibraryList {
  name: string;
  songs: { path: string; name: string; folder: string }[];
  sync_status?: 'pending';
}

// ── Sync (client → server) ───────────────────────────────────────────
export interface SyncRequest {
  since_ts: number; // 0 → force full resync
  bible_version?: string | null;
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
  songs_removed: string[];     // paths deleted since since_ts — removal detection
  lists: LibraryList[] | null; // null means no list changes
  all_list_names: string[];
  bible?: BibleSyncData | null;
  server_ts: number;
}

// Targeted push: a song's musical key changed (server-authoritative value),
// so phones can update instantly without a full sync.delta round-trip.
export interface SongKeyChanged {
  song_path: string;
  key: string | null;
  key_ts?: number | null;
}

export interface SongSearchResult {
  path: string;
  score: number;
  snippet: string;
}

export interface SongSearchPayload {
  ok: boolean;
  query: string;
  search_slides: boolean;
  results: SongSearchResult[];
  error?: string;
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

// ── Display configuration (server → client) ────────────────────────
// One physical screen the desktop can route an output window to. Mirrors the
// data the desktop's "Output Displays" menu is built from.
export interface DisplayScreen {
  index: number;
  name: string;
  is_app_screen: boolean;
  selected: boolean;
}

export interface DisplayConfig {
  ok: boolean;
  screens?: DisplayScreen[];
  error?: string;
}

// ── Commands (client → server) ───────────────────────────────────────
export type ClientCommand =
  | { type: 'live.next' }
  | { type: 'live.prev' }
  | { type: 'live.blank' }
  | { type: 'live.freeze' }
  | { type: 'live.chorus' }
  | { type: 'live.goto'; payload: { song_index: number; slide_index: number } }
  | { type: 'live.follow'; payload: { enabled: boolean } }
  | { type: 'queue.add'; payload: { song_path: string; position?: number; name?: string; folder?: string } }
  | { type: 'queue.add_bible_verse'; payload: { book: string; chapter: number; verse: number; position?: number } }
  | { type: 'queue.add_bible_verses'; payload: { book: string; chapter: number; verses: number[]; position?: number } }
  | { type: 'queue.remove'; payload: { position: number } }
  | { type: 'queue.reorder'; payload: { from: number; to: number } }
  | { type: 'queue.clear' }
  | { type: 'queue.select'; payload: { song_index: number } } // focus/select a queue item on desktop (preview, not go-live)
  | { type: 'list.create'; payload: { name: string } }
  | { type: 'list.delete'; payload: { name: string } }
  | { type: 'list.rename'; payload: { old: string; new: string } }
  | { type: 'list.add_song'; payload: { list_name: string; song_path: string; position?: number; name?: string; folder?: string } }
  | { type: 'list.remove_song'; payload: { list_name: string; position: number } }
  | { type: 'list.reorder'; payload: { list_name: string; from: number; to: number } }
  | { type: 'list.load_to_queue'; payload: { list_name: string } }
  | {
      type: 'list.merge_pending';
      id?: string;
      payload: {
        lists: LibraryList[];
        mutations?: { type: string; payload?: unknown }[];
      };
    }
  | { type: 'sync.request'; id?: string; payload: { since_ts: number; bible_version?: string | null } }
  | { type: 'song.search'; id?: string; payload: { query: string; search_slides: boolean } }
  | { type: 'bible.search'; id?: string; payload: { query: string; mode: 'reference' | 'text'; limit?: number } }
  | { type: 'device.rename'; payload: { new_name: string } }
  | { type: 'live.toggle_present' }
  | { type: 'live.font_size'; payload: { delta: number } }
  | { type: 'song.fetch_rc'; id?: string; payload: { url: string } }
  | { type: 'song.create'; id?: string; payload: { name: string; slide_texts: string[]; chorus_index?: number | number[] | null; folder?: string; overwrite?: boolean } }
  | { type: 'song.update'; id?: string; payload: { song_path: string; name: string; slide_texts: string[]; chorus_index?: number | null; chorus_ranges?: number[][] | null; end_slide_index?: number | null; auto_chorus_enabled?: boolean } }
  | { type: 'song.set_key'; payload: { song_path: string; key: string | null; key_ts?: number | null } }
  | { type: 'display.get_config'; id?: string }
  | { type: 'display.set_config'; id?: string; payload: { selected: string[] } };
