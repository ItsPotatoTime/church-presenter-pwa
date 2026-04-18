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

  let confirmDialog = $state<{ message: string; resolve: (v: boolean) => void } | null>(null);
  let promptDialog = $state<{ title: string; initial: string; value: string; resolve: (v: string | null) => void } | null>(null);
  let pickerSearchSlides = $state(false);

  function showConfirm(message: string): Promise<boolean> {
    return new Promise((resolve) => { confirmDialog = { message, resolve }; });
  }
  function showPrompt(title: string, initial = ''): Promise<string | null> {
    return new Promise((resolve) => { promptDialog = { title, initial, value: initial, resolve }; });
  }

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

  async function createList() {
    const name = await showPrompt('New list name:');
    if (!name || !name.trim()) return;
    const clean = name.trim().slice(0, 80);
    if ($listsStore.some((l) => l.name === clean)) {
      await showConfirm(`"${clean}" already exists.`);
      return;
    }
    send({ type: 'list.create', payload: { name: clean } });
    selectedName = clean;
  }

  async function renameList() {
    if (!selectedList) return;
    const next = await showPrompt('Rename list:', selectedList.name);
    if (!next || !next.trim()) return;
    const clean = next.trim().slice(0, 80);
    if (clean === selectedList.name) return;
    send({ type: 'list.rename', payload: { old: selectedList.name, new: clean } });
    selectedName = clean;
  }

  async function deleteList() {
    if (!selectedList) return;
    if (!await showConfirm(`Delete list "${selectedList.name}"?`)) return;
    send({ type: 'list.delete', payload: { name: selectedList.name } });
    selectedName = null;
  }

  async function loadToQueue() {
    if (!selectedList) return;
    if (!selectedList.songs.length) { await showConfirm('This list is empty.'); return; }
    if (!await showConfirm(`Replace queue with ${selectedList.songs.length} song(s) from "${selectedList.name}"?`)) return;
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
    return $songsStore.filter((s) => {
      if (normalize(s.name).includes(q) || normalize(s.folder).includes(q)) return true;
      if (pickerSearchSlides && s.slide_texts) {
        return s.slide_texts.some((t) => normalize(t).includes(q));
      }
      return false;
    });
  });

  function openPicker() {
    if (!selectedList) return;
    pickerQuery = '';
    pickerSearchSlides = false;
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
      <div class="picker-search-row">
        <input
          type="text"
          placeholder="Search songs…"
          bind:value={pickerQuery}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
        />
        <label class="slides-toggle">
          <input type="checkbox" bind:checked={pickerSearchSlides} />
          Slides
        </label>
      </div>
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

{#if confirmDialog}
  <div
    class="modal-back"
    role="button"
    tabindex="-1"
    aria-label="Cancel"
    onclick={() => { confirmDialog?.resolve(false); confirmDialog = null; }}
    onkeydown={(e) => { if (e.key === 'Escape') { confirmDialog?.resolve(false); confirmDialog = null; } }}
  >
    <div
      class="modal modal-dialog"
      role="alertdialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="dialog-msg">{confirmDialog.message}</div>
      <div class="dialog-btns">
        <button class="ghost" onclick={() => { confirmDialog?.resolve(false); confirmDialog = null; }}>Cancel</button>
        <button class="accent" onclick={() => { confirmDialog?.resolve(true); confirmDialog = null; }}>Confirm</button>
      </div>
    </div>
  </div>
{/if}

{#if promptDialog}
  <div
    class="modal-back modal-back-top"
    role="button"
    tabindex="-1"
    aria-label="Cancel"
    onclick={() => { promptDialog?.resolve(null); promptDialog = null; }}
    onkeydown={(e) => { if (e.key === 'Escape') { promptDialog?.resolve(null); promptDialog = null; } }}
  >
    <div
      class="modal modal-dialog"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="modal-title">{promptDialog.title}</div>
      <input
        type="text"
        bind:value={promptDialog.value}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        onkeydown={(e) => {
          if (e.key === 'Enter') { const v = promptDialog?.value ?? null; promptDialog?.resolve(v); promptDialog = null; }
        }}
      />
      <div class="dialog-btns" style="margin-top:12px;">
        <button class="ghost" onclick={() => { promptDialog?.resolve(null); promptDialog = null; }}>Cancel</button>
        <button class="accent" onclick={() => { const v = promptDialog?.value ?? null; promptDialog?.resolve(v); promptDialog = null; }}>OK</button>
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
  /* Dialogs with text input: align to top so the keyboard doesn't cover them */
  .modal-back-top {
    align-items: flex-start;
    padding-top: calc(env(safe-area-inset-top, 0) + 60px);
  }
  .modal-back-top .modal-dialog {
    border-radius: 14px;
    width: calc(100% - 32px);
    max-width: 480px;
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
  .modal-title { font-weight: 700; font-size: 18px; margin-bottom: 12px; }
  .modal input[type="text"] {
    width: 100%;
    padding: 10px 12px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-primary);
    margin-bottom: 10px;
  }

  .picker-search-row {
    display: flex; gap: 8px; align-items: center; margin-bottom: 10px;
  }
  .picker-search-row input[type="text"] { flex: 1; margin-bottom: 0; }
  .slides-toggle {
    display: inline-flex; gap: 4px; align-items: center;
    font-size: 12px; color: var(--text-secondary); white-space: nowrap;
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

  .modal-dialog {
    max-height: none;
    overflow-y: visible;
    padding: 20px 16px 24px;
  }
  .dialog-msg {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 18px;
    text-align: center;
  }
  .dialog-btns {
    display: flex;
    gap: 10px;
  }
  .dialog-btns button {
    flex: 1;
    padding: 13px;
    font-size: 15px;
  }
</style>
