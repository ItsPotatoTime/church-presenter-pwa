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

  if (cmd.type === 'queue.remove') {
    const items = current.items.filter((_, index) => index !== cmd.payload.position);
    await persistQueue({
      ...current,
      items,
      current_song_index: Math.min(current.current_song_index, items.length - 1),
      playing_song_index: Math.min(current.playing_song_index, items.length - 1),
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
    await persistQueue({ ...current, items });
    return true;
  }

  return false;
}

export async function queueCommandForOfflineReplay(cmd: ClientCommand): Promise<void> {
  await addPendingMutation(cmd);
}
