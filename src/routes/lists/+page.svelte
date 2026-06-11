<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto, afterNavigate } from '$app/navigation';
  import { base } from '$app/paths';
  import { loadCredentialsResilient, addPendingMutation, putLists, putPrivateLists } from '$lib/db';
  import { replaceQueueFromSongs, queueCommandForOfflineReplay } from '$lib/offlineQueue';
  import { remote } from '$lib/ws';
  import { get } from 'svelte/store';
  import {
    connStatus, isViewOnly, listsStore, privateListsStore, songsStore, canEditKeys, activeModals,
    listsActiveTab, listsSelectedName, listsShowPicker, listsPickerRawQuery, listsScrollY
  } from '$lib/stores';
  import type { LibraryList, LibrarySong, SongSearchPayload } from '$lib/protocol';
  import { normalize, filterSongs, renderMarkdown } from '$lib/search';
  import type { ScoredResult } from '$lib/search';
  import SongPreviewModal from '$lib/SongPreviewModal.svelte';
  import VirtualList from '$lib/VirtualList.svelte';

  let previewSong = $state<LibrarySong | null>(null);

  function openSongPreview(path: string) {
    const s = $songsStore.find((song) => song.path === path);
    if (s) {
      previewSong = s;
    }
  }

  function closePreview() {
    previewSong = null;
  }

  // State initialized from stores to preserve tab state
  let activeTab = $state<'public' | 'private'>($listsActiveTab);
  let selectedName = $state<string | null>($listsSelectedName);
  let showPicker = $state($listsShowPicker);
  let rawPickerQuery = $state($listsPickerRawQuery);

  let pickerQuery = $state($listsPickerRawQuery);
  let pickerDebounceTimer: number | null = null;
  let dragFrom = $state<number | null>(null);
  let dragOver = $state<number | null>(null);

  let confirmDialog = $state<{ message: string; resolve: (v: boolean) => void } | null>(null);
  let promptDialog = $state<{ title: string; initial: string; value: string; resolve: (v: string | null) => void } | null>(null);
  let pickerSearchSlides = $state(false);
  let pickerServerSearch = $state<{
    query: string;
    searchSlides: boolean;
    items: ScoredResult<LibrarySong>[];
    pending: boolean;
    failed: boolean;
  }>({ query: '', searchSlides: false, items: [], pending: false, failed: false });
  let pickerSearchSeq = 0;

  // Sync state back to stores reactively
  $effect(() => {
    listsActiveTab.set(activeTab);
  });
  $effect(() => {
    listsSelectedName.set(selectedName);
  });
  $effect(() => {
    listsShowPicker.set(showPicker);
  });
  $effect(() => {
    listsPickerRawQuery.set(rawPickerQuery);
  });

  function showConfirm(message: string): Promise<boolean> {
    return new Promise((resolve) => { confirmDialog = { message, resolve }; });
  }
  function showPrompt(title: string, initial = ''): Promise<string | null> {
    return new Promise((resolve) => { promptDialog = { title, initial, value: initial, resolve }; });
  }

  // Register showPicker for back gestures
  $effect(() => {
    if (showPicker) {
      const handleClose = () => {
        closePicker();
        return true;
      };
      activeModals.update(list => [...list, handleClose]);
      return () => {
        activeModals.update(list => list.filter(fn => fn !== handleClose));
      };
    }
  });

  // Register confirmDialog for back gestures
  $effect(() => {
    if (confirmDialog) {
      const handleClose = () => {
        confirmDialog?.resolve(false);
        confirmDialog = null;
        return true;
      };
      activeModals.update(list => [...list, handleClose]);
      return () => {
        activeModals.update(list => list.filter(fn => fn !== handleClose));
      };
    }
  });

  // Register promptDialog for back gestures
  $effect(() => {
    if (promptDialog) {
      const handleClose = () => {
        promptDialog?.resolve(null);
        promptDialog = null;
        return true;
      };
      activeModals.update(list => [...list, handleClose]);
      return () => {
        activeModals.update(list => list.filter(fn => fn !== handleClose));
      };
    }
  });

  onMount(async () => {
    const creds = await loadCredentialsResilient();
    if (!creds?.device_token) {
      goto(`${base}/`);
      return;
    }
    await remote.connect();
  });

  // Dynamically resolve lists and selection based on active tab (Public vs Private)
  const currentLists = $derived(activeTab === 'public' ? $listsStore : $privateListsStore);

  const selectedList = $derived<LibraryList | null>(
    selectedName === null
      ? null
      : (currentLists.find((l) => l.name === selectedName) ?? null)
  );

  async function send(cmd: { type: string; payload?: any }) {
    if ($isViewOnly) return;
    if ($connStatus !== 'open') {
      if (!await applyLocally(cmd)) {
        alert('Connect to the desktop to perform this action.');
        return;
      }
      if (!typeIsListMutation(cmd.type)) {
        void addPendingMutation(cmd);
      }
      return;
    }
    remote.send(cmd as any);
  }

  function typeIsListMutation(type: string): boolean {
    return type.startsWith('list.');
  }

  function markPending(list: LibraryList): LibraryList {
    return { ...list, sync_status: 'pending' };
  }

  async function applyLocally(cmd: { type: string; payload?: any }): Promise<boolean> {
    const { type, payload } = cmd;
    if (type === 'list.create') {
      listsStore.update((ls) => [...ls, markPending({ name: payload.name, songs: [] })]);
      selectedName = payload.name;
    } else if (type === 'list.delete') {
      listsStore.update((ls) => ls.filter((l) => l.name !== payload.name));
      if (selectedName === payload.name) selectedName = null;
    } else if (type === 'list.rename') {
      listsStore.update((ls) =>
        ls.map((l) => (l.name === payload.old ? markPending({ ...l, name: payload.new }) : l))
      );
      if (selectedName === payload.old) selectedName = payload.new;
    } else if (type === 'list.add_song') {
      const song = get(songsStore).find((s) => s.path === payload.song_path);
      if (!song) return false;
      listsStore.update((ls) =>
        ls.map((l) =>
          l.name === payload.list_name
            ? markPending({ ...l, songs: [...l.songs, { path: song.path, name: song.name, folder: song.folder }] })
            : l
        )
      );
    } else if (type === 'list.remove_song') {
      listsStore.update((ls) =>
        ls.map((l) =>
          l.name === payload.list_name
            ? markPending({ ...l, songs: l.songs.filter((_, i) => i !== payload.position) })
            : l
        )
      );
    } else if (type === 'list.reorder') {
      listsStore.update((ls) =>
        ls.map((l) => {
          if (l.name !== payload.list_name) return l;
          const songs = [...l.songs];
          const from = payload.from;
          const to = Math.max(0, Math.min(songs.length - 1, payload.to));
          if (from < 0 || from >= songs.length || from === to) return markPending(l);
          const [moved] = songs.splice(from, 1);
          songs.splice(to, 0, moved);
          return markPending({ ...l, songs });
        })
      );
    } else if (type === 'list.load_to_queue') {
      const list = get(listsStore).find((l) => l.name === payload.list_name);
      if (!list) return false;
      await replaceQueueFromSongs(list.songs);
      await queueCommandForOfflineReplay({ type: 'queue.clear' });
      for (const song of list.songs) {
        await queueCommandForOfflineReplay({ type: 'queue.add', payload: { song_path: song.path } });
      }
    } else {
      return false;
    }
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

    if (activeTab === 'private') {
      if ($privateListsStore.some((l) => l.name === clean)) {
        await showConfirm(`"${clean}" already exists.`);
        return;
      }
      const updated = [...$privateListsStore, { name: clean, songs: [] }];
      privateListsStore.set(updated);
      await putPrivateLists(updated);
      selectedName = clean;
    } else {
      if ($listsStore.some((l) => l.name === clean)) {
        await showConfirm(`"${clean}" already exists.`);
        return;
      }
      send({ type: 'list.create', payload: { name: clean } });
      selectedName = clean;
    }
  }

  async function renameList() {
    if (!selectedList) return;
    const next = await showPrompt('Rename list:', selectedList.name);
    if (!next || !next.trim()) return;
    const clean = next.trim().slice(0, 80);
    if (clean === selectedList.name) return;

    if (activeTab === 'private') {
      if ($privateListsStore.some((l) => l.name === clean)) {
        await showConfirm(`"${clean}" already exists.`);
        return;
      }
      const updated = $privateListsStore.map((l) =>
        l.name === selectedList.name ? { ...l, name: clean } : l
      );
      privateListsStore.set(updated);
      await putPrivateLists(updated);
      selectedName = clean;
    } else {
      send({ type: 'list.rename', payload: { old: selectedList.name, new: clean } });
      selectedName = clean;
    }
  }

  async function deleteList() {
    if (!selectedList) return;
    if (!await showConfirm(`Delete list "${selectedList.name}"?`)) return;

    if (activeTab === 'private') {
      const updated = $privateListsStore.filter((l) => l.name !== selectedList.name);
      privateListsStore.set(updated);
      await putPrivateLists(updated);
      selectedName = null;
    } else {
      send({ type: 'list.delete', payload: { name: selectedList.name } });
      selectedName = null;
    }
  }

  async function loadToQueue() {
    if (!selectedList) return;
    if (!selectedList.songs.length) { await showConfirm('This list is empty.'); return; }
    if (!await showConfirm(`Replace queue with ${selectedList.songs.length} song(s) from "${selectedList.name}"?`)) return;

    if (activeTab === 'private') {
      if ($isViewOnly) return;
      if ($connStatus !== 'open') {
        await replaceQueueFromSongs(selectedList.songs);
        await queueCommandForOfflineReplay({ type: 'queue.clear' });
        for (const song of selectedList.songs) {
          await queueCommandForOfflineReplay({ type: 'queue.add', payload: { song_path: song.path } });
        }
        return;
      }
      remote.send({ type: 'queue.clear' });
      for (const song of selectedList.songs) {
        remote.send({ type: 'queue.add', payload: { song_path: song.path } });
      }
    } else {
      send({ type: 'list.load_to_queue', payload: { list_name: selectedList.name } });
    }
  }

  function removeSong(pos: number) {
    if (!selectedList) return;

    if (activeTab === 'private') {
      const updated = $privateListsStore.map((l) =>
        l.name === selectedList.name
          ? { ...l, songs: l.songs.filter((_, i) => i !== pos) }
          : l
      );
      privateListsStore.set(updated);
      void putPrivateLists(updated);
    } else {
      send({
        type: 'list.remove_song',
        payload: { list_name: selectedList.name, position: pos },
      });
    }
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

    if (activeTab === 'private') {
      const songs = [...selectedList.songs];
      const [moved] = songs.splice(from, 1);
      songs.splice(i, 0, moved);
      const updated = $privateListsStore.map((l) =>
        l.name === selectedList.name ? { ...l, songs } : l
      );
      privateListsStore.set(updated);
      void putPrivateLists(updated);
    } else {
      send({
        type: 'list.reorder',
        payload: { list_name: selectedList.name, from, to: i },
      });
    }
  }
  function onDragEnd() { dragFrom = null; dragOver = null; }

  // ── Song picker (adds song(s) to current list) ──

  $effect(() => {
    const value = rawPickerQuery;
    if (pickerDebounceTimer !== null) clearTimeout(pickerDebounceTimer);
    pickerDebounceTimer = window.setTimeout(() => {
      pickerQuery = value;
    }, 180);
    return () => {
      if (pickerDebounceTimer !== null) clearTimeout(pickerDebounceTimer);
    };
  });

  const pickerFiltered = $derived.by<ScoredResult<LibrarySong>[]>(() => {
    const q = pickerQuery.trim();
    if (!q) return $songsStore.map((s) => ({ item: s, score: 0, snippet: '' }));
    if ($connStatus === 'open' && !pickerServerSearch.failed) {
      if (pickerServerSearch.query === pickerQuery && pickerServerSearch.searchSlides === pickerSearchSlides) {
        return pickerServerSearch.items;
      }
      return [];
    }
    return filterSongs(q, $songsStore, pickerSearchSlides, Number.POSITIVE_INFINITY);
  });
  const pickerSearchPending = $derived(
    pickerQuery.trim().length > 0
      && $connStatus === 'open'
      && !pickerServerSearch.failed
      && (pickerServerSearch.pending || pickerServerSearch.query !== pickerQuery || pickerServerSearch.searchSlides !== pickerSearchSlides)
  );

  const songByPath = $derived.by(() => new Map($songsStore.map((song) => [song.path, song])));

  $effect(() => {
    const q = normalize(pickerQuery);
    if (!q || $connStatus !== 'open') {
      pickerServerSearch = { query: pickerQuery, searchSlides: pickerSearchSlides, items: [], pending: false, failed: false };
      return;
    }

    const seq = ++pickerSearchSeq;
    pickerServerSearch = { query: pickerQuery, searchSlides: pickerSearchSlides, items: [], pending: true, failed: false };
    remote
      .sendRequest('song.search', { query: pickerQuery, search_slides: pickerSearchSlides }, 10000)
      .then((payload: SongSearchPayload) => {
        if (seq !== pickerSearchSeq) return;
        if (!payload?.ok) {
          pickerServerSearch = { query: pickerQuery, searchSlides: pickerSearchSlides, items: [], pending: false, failed: true };
          return;
        }
        const items = payload.results
          .map((result) => {
            const song = songByPath.get(result.path);
            return song ? { item: song, score: result.score, snippet: result.snippet } : null;
          })
          .filter((item): item is ScoredResult<LibrarySong> => item !== null);
        pickerServerSearch = { query: pickerQuery, searchSlides: pickerSearchSlides, items, pending: false, failed: false };
      })
      .catch(() => {
        if (seq !== pickerSearchSeq) return;
        pickerServerSearch = { query: pickerQuery, searchSlides: pickerSearchSlides, items: [], pending: false, failed: true };
      });
  });

  let toast = $state<{ message: string; type: 'success' | 'warning' } | null>(null);
  let toastTimer: number | null = null;

  function showToast(message: string, type: 'success' | 'warning' = 'success') {
    if (toastTimer !== null) clearTimeout(toastTimer);
    toast = { message, type };
    toastTimer = window.setTimeout(() => {
      toast = null;
    }, 2500);
  }

  function openPicker() {
    if (!selectedList) return;
    rawPickerQuery = '';
    pickerQuery = '';
    pickerSearchSlides = false;
    showPicker = true;
  }
  function closePicker() { showPicker = false; }

  function addSong(s: LibrarySong) {
    if (!selectedList) return;
    const alreadyExists = selectedList.songs.some((song) => song.path === s.path);
    if (alreadyExists) {
      showToast(`"${s.name}" is already in this list`, 'warning');
      return;
    }

    if (activeTab === 'private') {
      const updated = $privateListsStore.map((l) =>
        l.name === selectedList.name
          ? { ...l, songs: [...l.songs, { path: s.path, name: s.name, folder: s.folder }] }
          : l
      );
      privateListsStore.set(updated);
      void putPrivateLists(updated);
      showToast(`Added "${s.name}"`, 'success');
    } else {
      send({
        type: 'list.add_song',
        payload: { list_name: selectedList.name, song_path: s.path },
      });
      showToast(`Added "${s.name}"`, 'success');
    }
  }

  const songKeyMap = $derived.by(() => new Map($songsStore.map((song) => [song.path, song.key])));

  // Scroll retention handling
  function handleScroll() {
    if (!previewSong && !showPicker) {
      listsScrollY.set(window.scrollY);
    }
  }

  afterNavigate(async () => {
    await tick();
    const savedY = get(listsScrollY);
    if (savedY > 0) {
      window.scrollTo(0, savedY);
    }
  });
</script>

<svelte:window onscroll={handleScroll} />

<header class="hdr">
  <h1>Lists</h1>
  <div class="actions">
    <button class="ghost" onclick={createList} disabled={activeTab === 'public' && $isViewOnly}>＋ New</button>
  </div>
</header>

<div class="tab-switcher">
  <button
    class="switch-tab"
    class:active={activeTab === 'public'}
    onclick={() => { activeTab = 'public'; selectedName = null; }}
  >
    Public
  </button>
  <button
    class="switch-tab"
    class:active={activeTab === 'private'}
    onclick={() => { activeTab = 'private'; selectedName = null; }}
  >
    Private
  </button>
</div>

{#if currentLists.length === 0}
  <section class="panel muted" style="margin-top:12px;">
    No {activeTab} lists yet. Tap <b>＋ New</b> to create one.
  </section>
{:else}
  <div class="chips">
    {#each currentLists as l (l.name)}
      <button
        class="chip"
        class:active={selectedName === l.name}
        class:pending={l.sync_status === 'pending'}
        onclick={() => selectList(l.name)}
      >
        {l.name}
        {#if l.sync_status === 'pending'}<span class="pending-badge">pending</span>{/if}
        <span class="count">{l.songs.length}</span>
      </button>
    {/each}
  </div>
{/if}

{#if selectedList}
  <section class="list-head">
    <div class="list-title">
      {selectedList.name}
      {#if selectedList.sync_status === 'pending'}<span class="pending-badge">pending sync</span>{/if}
    </div>
    <div class="list-actions">
      <button class="ghost" onclick={renameList} disabled={activeTab === 'public' && $isViewOnly}>✎ Rename</button>
      <button class="ghost" onclick={deleteList} disabled={activeTab === 'public' && $isViewOnly}>✕ Delete</button>
    </div>
  </section>

  <section class="row">
    <button class="ghost" onclick={openPicker} disabled={(activeTab === 'public' && $isViewOnly) || $songsStore.length === 0}>
      ＋ Add song
    </button>
    <button class="accent" onclick={loadToQueue} disabled={$isViewOnly || selectedList.songs.length === 0}>
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
          draggable={activeTab === 'private' || !$isViewOnly}
          ondragstart={(e) => onDragStart(e, i)}
          ondragover={(e) => onDragOver(e, i)}
          ondrop={(e) => onDrop(e, i)}
          ondragend={onDragEnd}
        >
          <span class="grip" aria-hidden="true">⋮⋮</span>
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            class="meta"
            onclick={() => openSongPreview(song.path)}
            style="cursor: pointer; flex: 1;"
            role="button"
            tabindex="0"
          >
            <div class="name-row" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;">
              <div class="name">{song.name || 'Untitled'}</div>
              {#if songKeyMap.get(song.path)}
                <span class="key-badge">{songKeyMap.get(song.path)}</span>
              {/if}
            </div>
            {#if song.folder}<div class="muted small">{song.folder}</div>{/if}
          </div>
          <button
            class="rm"
            aria-label="Remove from list"
            onclick={() => removeSong(i)}
            disabled={activeTab === 'public' && $isViewOnly}
          >✕</button>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

{#if showPicker}
  <div
    class="modal-back modal-back-top"
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
          bind:value={rawPickerQuery}
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
        {#if pickerSearchPending}
          <div class="muted small" style="padding: 12px;">Searching songs...</div>
        {:else}
          <VirtualList items={pickerFiltered} itemHeight={86} class="picker-virtual-list">
            {#snippet children(sr)}
              <button class="picker-item" onclick={() => addSong(sr.item)}>
                <div class="name-row" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;">
                  <div class="name" style="font-weight: 600;">{sr.item.name}</div>
                  {#if sr.item.key}
                    <span class="key-badge">{sr.item.key}</span>
                  {/if}
                </div>
                {#if sr.item.folder}<div class="muted small">{sr.item.folder}</div>{/if}
                {#if sr.snippet}<div class="snippet">{@html renderMarkdown(sr.snippet)}</div>{/if}
              </button>
            {/snippet}
          </VirtualList>
        {/if}
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

{#if previewSong}
  <SongPreviewModal song={previewSong} onclose={closePreview} />
{/if}

{#if toast}
  <div class="toast" class:warning={toast.type === 'warning'}>
    {#if toast.type === 'warning'}
      <span class="icon">⚠️</span>
    {:else}
      <span class="icon">✓</span>
    {/if}
    <span class="msg">{toast.message}</span>
  </div>
{/if}

<style>
  .tab-switcher {
    display: flex;
    background: rgba(22, 22, 30, 0.6);
    border: 1px solid rgba(48, 48, 74, 0.4);
    border-radius: 14px;
    padding: 3px;
    margin-bottom: 16px;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .switch-tab {
    flex: 1;
    background: transparent;
    border: none;
    border-radius: 11px;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 600;
    padding: 8px 12px;
    transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .switch-tab.active {
    background: var(--accent);
    color: #fff;
    box-shadow: 0 4px 15px rgba(233, 69, 96, 0.35);
  }
  .switch-tab:hover:not(.active) {
    color: var(--text-primary);
  }

  .hdr { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; padding: 4px 0 10px; }
  h1 { margin: 0; font-size: 22px; font-weight: 700; }
  .actions { display: flex; gap: 8px; }
 
  .chips {
    display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;
  }
  .chip {
    display: inline-flex; gap: 6px; align-items: center;
    padding: 8px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 99px;
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 500;
    transition: border-color 150ms ease, color 150ms ease, background-color 150ms ease, transform 100ms ease;
  }
  .chip:active {
    transform: scale(0.95);
  }
  .chip.active {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--elevated);
  }
  .chip.pending {
    border-color: var(--warning);
  }
  .pending-badge {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 6px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--warning) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
    color: var(--warning);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .count {
    background: var(--border);
    color: var(--text-secondary);
    padding: 0 6px;
    border-radius: 10px;
    font-size: 11px;
    transition: background-color 150ms ease, color 150ms ease;
  }
  .chip.active .count {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
  }
 
  .list-head {
    display: flex; justify-content: space-between; align-items: center;
    gap: 10px; margin-top: 8px;
  }
  .list-title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-size: 16px;
    font-weight: 700;
  }
  .list-actions { display: flex; gap: 6px; }
 
  .row { display: flex; gap: 8px; margin: 10px 0; }
  .row > button { flex: 1; padding: 12px; }
  button.accent {
    background: var(--accent);
    color: #fff;
    font-weight: 700;
    border: none;
    transition: background 150ms ease, transform 100ms ease;
  }
  button.accent:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  button.accent:active:not(:disabled) {
    background: var(--accent-dim);
    transform: scale(0.97);
  }
  button.ghost {
    background: transparent;
    color: var(--text-primary);
    border: 1px solid var(--border);
    transition: border-color 150ms ease, background-color 150ms ease, transform 100ms ease;
  }
  button.ghost:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--panel);
  }
  button.ghost:active:not(:disabled) {
    transform: scale(0.97);
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
    transition: border-color 150ms ease, background-color 150ms ease;
  }
  .song-row:hover {
    border-color: var(--border-light);
    background: var(--panel);
  }
  .song-row.drop { border-color: var(--accent); background: var(--elevated); }
  .grip { color: var(--text-secondary); font-size: 14px; cursor: grab; }
  .name { font-weight: 600; }
  .rm {
    width: 40px; padding: 0; font-size: 16px;
    background: transparent; color: var(--text-secondary); border-color: var(--border);
    transition: color 150ms ease, border-color 150ms ease, background-color 150ms ease, transform 100ms ease;
  }
  .rm:hover:not(:disabled) { color: var(--danger); border-color: var(--danger); }
  .rm:active:not(:disabled) { transform: scale(0.95); background: rgba(239, 68, 68, 0.15); }
 
  .small { font-size: 12px; }
 
  .modal-back {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 100;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  /* Dialogs with text input: align to top so the keyboard doesn't cover them */
  .modal-back-top {
    align-items: flex-start;
    padding-top: calc(env(safe-area-inset-top, 0) + 60px);
  }
  .modal-back-top .modal-dialog,
  .modal-back-top .modal {
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
    box-shadow: 0 -4px 30px rgba(0, 0, 0, 0.3);
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
  :global(.picker-virtual-list) {
    height: min(55vh, 520px);
    min-height: 260px;
  }
  .picker-item {
    text-align: left;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--text-primary);
    transition: border-color 150ms ease, background-color 150ms ease, transform 100ms ease;
  }
  .picker-item:hover {
    border-color: var(--accent);
    background: var(--panel);
  }
  .picker-item:active {
    transform: scale(0.98);
  }
  .snippet {
    margin-top: 4px;
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.3;
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

  /* Toast alerts */
  .toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--panel);
    border: 1px solid var(--success);
    border-radius: 99px;
    padding: 8px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    z-index: 1000;
    animation: toast-fade-in 150ms ease-out;
  }
  .toast.warning {
    border-color: var(--warning);
  }
  .toast .icon {
    font-size: 14px;
  }
  .toast.warning .icon {
    color: var(--warning);
  }
  .toast:not(.warning) .icon {
    color: var(--success);
  }
  .toast .msg {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
  }
  @keyframes toast-fade-in {
    from { transform: translate(-50%, 15px); opacity: 0; }
    to { transform: translate(-50%, 0); opacity: 1; }
  }
</style>
