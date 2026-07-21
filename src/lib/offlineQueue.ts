import { get } from 'svelte/store';
import { addPendingMutation, cacheQueueState } from './db';
import type { ClientCommand, LibrarySong, QueueItem, QueueState } from './protocol';
import { queueState, songsStore } from './stores';

function emptyQueue(): QueueState {
  return {
    items: [],
    current_song_index: -1,
    playing_song_index: -1,
    current_slide_index: 0,
  };
}

function clampInsertPosition(position: number | undefined, length: number): number {
  if (position === undefined || !Number.isFinite(position)) return length;
  return Math.max(0, Math.min(length, Math.trunc(position)));
}

// Mirror of the desktop QueueManager._adjust_index_for_reorder. Keeps the
// current/playing pointers on the SAME song after a move instead of leaving
// them pinned to the old numeric slot (which now holds a different song and
// makes the phone show the wrong item as live).
function adjustIndexForReorder(idx: number, from: number, to: number): number {
  if (idx < 0) return idx;
  if (idx === from) return to;
  if (from < idx && idx <= to) return idx - 1;
  if (to <= idx && idx < from) return idx + 1;
  return idx;
}

// Mirror of the desktop QueueManager.remove_song index fix-up.
function adjustIndexForRemove(idx: number, removedPos: number, newLength: number): number {
  if (idx < 0) return idx;
  if (newLength <= 0) return -1;
  if (removedPos < idx) idx -= 1;
  else if (removedPos === idx && idx >= newLength) idx = newLength - 1;
  return Math.min(idx, newLength - 1);
}

function queueItemFromSong(song: LibrarySong): QueueItem {
  return {
    path: song.path,
    name: song.name,
    folder: song.folder,
  };
}

async function persistQueue(next: QueueState): Promise<void> {
  queueState.set(next);
  await cacheQueueState(next);
}

export async function replaceQueueFromSongs(songs: { path: string; name: string; folder: string }[]): Promise<void> {
  await persistQueue({
    ...emptyQueue(),
    items: songs.map((song) => ({ path: song.path, name: song.name, folder: song.folder })),
  });
}

export async function applyQueueCommandLocally(cmd: ClientCommand): Promise<boolean> {
  const current = get(queueState) ?? emptyQueue();

  if (cmd.type === 'queue.clear') {
    await persistQueue(emptyQueue());
    return true;
  }

  if (cmd.type === 'queue.add') {
    const song = get(songsStore).find((s) => s.path === cmd.payload.song_path);
    if (!song) return false;
    const items = [...current.items];
    items.splice(clampInsertPosition(cmd.payload.position, items.length), 0, queueItemFromSong(song));
    await persistQueue({ ...current, items });
    return true;
  }

  if (cmd.type === 'queue.add_bible_verse') {
    const items = [...current.items];
    const name = `${cmd.payload.book} ${cmd.payload.chapter}:${cmd.payload.verse}`;
    items.splice(clampInsertPosition(cmd.payload.position, items.length), 0, {
      path: `bible://${cmd.payload.book}/${cmd.payload.chapter}/${cmd.payload.verse}`,
      name,
      folder: 'Bible',
      is_bible: true,
      bible_refs: [{ book: cmd.payload.book, chapter: cmd.payload.chapter, verse: cmd.payload.verse }],
    });
    await persistQueue({ ...current, items });
    return true;
  }


  if (cmd.type === 'queue.add_bible_verses') {
    const verses = [...new Set(cmd.payload.verses)].sort((a, b) => a - b);
    if (!verses.length) return true;
    const first = verses[0];
    const last = verses[verses.length - 1];
    const contiguous = verses.every((verse, index) => index === 0 || verse === verses[index - 1] + 1);
    const name =
      verses.length === 1
        ? `${cmd.payload.book} ${cmd.payload.chapter}:${first}`
        : contiguous
          ? `${cmd.payload.book} ${cmd.payload.chapter}:${first}-${last}`
          : `${cmd.payload.book} ${cmd.payload.chapter} (${verses.length} verses)`;
    const items = [...current.items];
    items.splice(clampInsertPosition(cmd.payload.position, items.length), 0, {
      path: `bible://${cmd.payload.book}/${cmd.payload.chapter}/${verses.join(',')}`,
      name,
      folder: 'Bible',
      is_bible: true,
      bible_refs: verses.map((verse) => ({ book: cmd.payload.book, chapter: cmd.payload.chapter, verse }))
    });
    await persistQueue({ ...current, items });
    return true;
  }

  if (cmd.type === 'queue.remove') {
    const removedPos = cmd.payload.position;
    const items = current.items.filter((_, index) => index !== removedPos);
    await persistQueue({
      ...current,
      items,
      current_song_index: adjustIndexForRemove(current.current_song_index, removedPos, items.length),
      playing_song_index: adjustIndexForRemove(current.playing_song_index, removedPos, items.length),
    });
    return true;
  }

  if (cmd.type === 'queue.reorder') {
    const items = [...current.items];
    const from = cmd.payload.from;
    const to = Math.max(0, Math.min(items.length - 1, cmd.payload.to));
    if (from < 0 || from >= items.length || from === to) return true;
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    await persistQueue({
      ...current,
      items,
      current_song_index: adjustIndexForReorder(current.current_song_index, from, to),
      playing_song_index: adjustIndexForReorder(current.playing_song_index, from, to),
    });
    return true;
  }

  return false;
}

export async function queueCommandForOfflineReplay(cmd: ClientCommand): Promise<void> {
  await addPendingMutation(cmd);
}
