<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { loadCredentials, addPendingMutation, putLists } from '$lib/db';
  import { remote } from '$lib/ws';
  import { get } from 'svelte/store';
  import {
    connStatus, isViewOnly, listsStore, songsStore,
  } from '$lib/stores';
  import type { LibraryList, LibrarySong } from '$lib/protocol';
  import { normalize } from '$lib/search';

  let selectedName = $state<string | null>(null);
  let showPicker = $state(false);
  let pickerQuery = $state('');
  let dragFrom = $state<number | null>(null);
  let dragOver = $state<number | null>(null);

  // Layout already calls hydrateFromCache() on startup — no need to repeat here.
  onMount(async () => {
    const creds = await loadCredentials();
    if (!creds?.device_token) {
      goto(`${base}/`);
      return;
    }
    await remote.connect();
  });

  const selectedList = $derived<LibraryList | null>(
    selectedName === null
      ? null
      : ($listsStore.find((l) => l.name === selectedName) ?? null)
  );

  function send(cmd: { type: string; payload?: any }) {
    if ($isViewOnly) return;
    if ($connStatus !== 'open') {
      if (!applyLocally(cmd)) {
        alert('Connect to the desktop to perform this action.');
        return;
      }
      void addPendingMutation(cmd);
      return;
    }
    remote.send(cmd as any);
  }

  function applyLocally(cmd: { type: string; payload?: any }): boolean {
    const { type, payload } = cmd;
    if (type === 'list.create') {
      listsStore.update((ls) => [...ls, { name: payload.name, songs: [] }]);
      selectedName = payload.name;
    } else if (type === 'list.delete') {
      listsStore.update((ls) => ls.filter((l) => l.name !== payload.name));
      if (selectedName === payload.name) selectedName = null;
    } else if (type === 'list.rename') {
      listsStore.update((ls) =>
        ls.map((l) => (l.name === payload.old ? { ...l, name: payload.new } : l))
      );
      if (selectedName === payload.old) selectedName = payload.new;
    } else if (type === 'list.add_song') {
      const song = get(songsStore).find((s) => s.path === payload.song_path);
      if (!song) return false;
      listsStore.update((ls) =>
        ls.map((l) =>
          l.name === payload.list_name
            ? { ...l, songs: [...l.songs, { path: song.path, name: song.name, folder: song.folder }] }
            : l
        )
      );
    } else if (type === 'list.remove_song') {
      listsStore.update((ls) =>
        ls.map((l) =>
          l.name === payload.list_name
            ? { ...l, songs: l.songs.filter((_, i) => i !== payload.position) }
            : l
        )
      );
    } else {
      // list.load_to_queue and list.reorder cannot be applied offline
      return false;
    }
    // Persist the updated lists to IndexedDB so changes survive tab switches and restarts.
    void putLists(get(listsStore));
    return true;
  }

  function selectList(name: string) {
    selectedName = name;
  }

  function createList() {
    const name = prompt('New list name:');
    if (!name || !name.trim()) return;
    const clean = name.trim().slice(0, 80);
    if ($listsStore.some((l) => l.name === clean)) {
      alert('A list with that name already exists.');
      return;
    }
    send({ type: 'list.create', payload: { name: clean } });
    selectedName = clean;
  }

  function renameList() {
    if (!selectedList) return;
    const next = prompt('Rename list:', selectedList.name);
    if (!next || !next.trim()) return;
    const clean = next.trim().slice(0, 80);
    if (clean === selectedList.name) return;
    send({ type: 'list.rename', payload: { old: selectedList.name, new: clean } });
    selectedName = clean;
  }

  function deleteList() {
    if (!selectedList) return;
    if (!confirm(`Delete list "${selectedList.name}"?`)) return;
    send({ type: 'list.delete', payload: { name: selectedList.name } });
    selectedName = null;
  }

  function loadToQueue() {
    if (!selectedList) return;
    if (!selectedList.songs.length) { alert('List is empty.'); return; }
    if (!confirm(`Replace queue with ${selectedList.songs.length} song(s) from "${selectedList.name}"?`)) return;
    send({ type: 'list.load_to_queue', payload: { list_name: selectedList.name } });
  }

  function removeSong(pos: number) {
    if (!selectedList) return;
    send({
      type: 'list.remove_song',
      payload: { list_name: selectedList.name, position: pos },
    });
  }

  function onDragStart(e: DragEvent, i: number) {
    if ($isViewOnly) return;
    dragFrom = i;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    }
  }
  function onDragOver(e: DragEvent, i: number) {
    e.preventDefault();
    dragOver = i;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }
  function onDrop(e: DragEvent, i: number) {
    e.preventDefault();
    const from = dragFrom;
    dragFrom = null;
    dragOver = null;
    if (!selectedList || from === null || from === i) return;
    send({
      type: 'list.reorder',
      payload: { list_name: selectedList.name, from, to: i },
    });
  }
  function onDragEnd() { dragFrom = null; dragOver = null; }

  // ── Song picker (adds song(s) to current list) ──
  const pickerFiltered = $derived.by<LibrarySong[]>(() => {
    const q = normalize(pickerQuery);
    if (!q) return $songsStore;
    return $songsStore.filter((s) =>
      normalize(s.name).includes(q) || normalize(s.folder).includes(q)
    );
  });

  function openPicker() {
    if (!selectedList) return;
    pickerQuery = '';
    showPicker = true;
  }
  function closePicker() { showPicker = false; }
  function addSong(s: LibrarySong) {
    if (!selectedList) return;
    send({
      type: 'list.add_song',
      payload: { list_name: selectedList.name, song_path: s.path },
    });
    closePicker();
  }
</script>

<header class="hdr">
  <h1>Lists</h1>
  <div class="actions">
    <button class="ghost" onclick={createList} disabled={$isViewOnly}>＋ New</button>
  </div>
</header>

{#if $listsStore.length === 0}
  <section class="panel muted" style="margin-top:12px;">
    No lists yet. Tap <b>＋ New</b> to create one.
  </section>
{:else}
  <div class="chips">
    {#each $listsStore as l (l.name)}
      <button
        class="chip"
        class:active={selectedName === l.name}
        onclick={() => selectList(l.name)}
      >
        {l.name}
        <span class="count">{l.songs.length}</span>
      </button>
    {/each}
  </div>
{/if}

{#if selectedList}
  <section class="list-head">
    <div class="list-title">{selectedList.name}</div>
    <div class="list-actions">
      <button class="ghost" onclick={renameList} disabled={$isViewOnly}>✎ Rename</button>
      <button class="ghost" onclick={deleteList} disabled={$isViewOnly}>✕ Delete</button>
    </div>
  </section>

  <section class="row">
    <button class="ghost" onclick={openPicker} disabled={$isViewOnly || $songsStore.length === 0}>
      ＋ Add song
    </button>
    <button class="accent" onclick={loadToQueue} disabled={$isViewOnly || $connStatus !== 'open' || selectedList.songs.length === 0}>
      ▶ Load to queue
    </button>
  </section>

  {#if selectedList.songs.length === 0}
    <section class="panel muted" style="margin-top:12px;">
      No songs in this list.
    </section>
  {:else}
    <ul class="songs">
      {#each selectedList.songs as song, i (i + ':' + song.path)}
        <li
          class="song-row"
          class:drop={dragOver === i}
          draggable={!$isViewOnly}
          ondragstart={(e) => onDragStart(e, i)}
          ondragover={(e) => onDragOver(e, i)}
          ondrop={(e) => onDrop(e, i)}
          ondragend={onDragEnd}
        >
          <span class="grip" aria-hidden="true">⋮⋮</span>
          <div class="meta">
            <div class="name">{song.name || 'Untitled'}</div>
            {#if song.folder}<div class="muted small">{song.folder}</div>{/if}
          </div>
          <button
            class="rm"
            aria-label="Remove from list"
            onclick={() => removeSong(i)}
            disabled={$isViewOnly}
          >✕</button>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

{#if showPicker}
  <div
    class="modal-back"
    role="button"
    tabindex="-1"
    aria-label="Close picker"
    onclick={closePicker}
    onkeydown={(e) => { if (e.key === 'Escape') closePicker(); }}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="modal-head">
        <div class="modal-title">Add song</div>
        <button class="ghost" onclick={closePicker}>Close</button>
      </div>
      <input
        type="text"
        placeholder="Search songs…"
        bind:value={pickerQuery}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
      />
      <div class="picker-list">
        {#each pickerFiltered as s (s.path)}
          <button class="picker-item" onclick={() => addSong(s)}>
            <div class="name">{s.name}</div>
            {#if s.folder}<div class="muted small">{s.folder}</div>{/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .hdr { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; padding: 4px 0 10px; }
  h1 { margin: 0; font-size: 22px; font-weight: 700; }
  .actions { display: flex; gap: 8px; }

  .chips {
    display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;
  }
  .chip {
    display: inline-flex; gap: 6px; align-items: center;
    padding: 8px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 99px;
    color: var(--text-primary);
    font-size: 13px;
  }
  .chip.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .count {
    background: var(--elevated);
    color: var(--text-secondary);
    padding: 0 6px;
    border-radius: 10px;
    font-size: 11px;
  }

  .list-head {
    display: flex; justify-content: space-between; align-items: center;
    gap: 10px; margin-top: 8px;
  }
  .list-title { font-size: 16px; font-weight: 700; }
  .list-actions { display: flex; gap: 6px; }

  .row { display: flex; gap: 8px; margin: 10px 0; }
  .row > button { flex: 1; padding: 12px; }
  button.accent { background: var(--accent); color: #fff; font-weight: 700; border: none; }
  button.ghost {
    background: transparent;
    color: var(--text-primary);
    border: 1px solid var(--border);
  }

  .songs { list-style: none; padding: 0; margin: 0; }
  .song-row {
    display: grid;
    grid-template-columns: 24px 1fr 44px;
    gap: 8px;
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 10px;
    margin-bottom: 6px;
  }
  .song-row.drop { border-color: var(--accent); background: var(--elevated); }
  .grip { color: var(--text-secondary); font-size: 14px; cursor: grab; }
  .name { font-weight: 600; }
  .rm {
    width: 40px; padding: 0; font-size: 16px;
    background: transparent; color: var(--text-secondary); border-color: var(--border);
  }
  .rm:hover { color: var(--danger); border-color: var(--danger); }

  .small { font-size: 12px; }

  .modal-back {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 100;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px 14px 0 0;
    width: 100%;
    max-width: 720px;
    max-height: 80vh;
    overflow-y: auto;
    padding: 16px;
  }
  .modal-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
  }
  .modal-title { font-weight: 700; font-size: 18px; }
  .modal input {
    width: 100%;
    padding: 10px 12px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-primary);
    margin-bottom: 10px;
  }

  .picker-list { display: flex; flex-direction: column; gap: 4px; }
  .picker-item {
    text-align: left;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--text-primary);
  }
</style>
