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
    listsActiveTab, listsSelectedName, listsShowPicker, listsPickerRawQuery, listsPickerSearchSlides, listsScrollY,
    listsSortMode, listsRawQuery, pendingSyncError
  } from '$lib/stores';
  import type { LibraryList, LibrarySong } from '$lib/protocol';
  import { normalize, renderMarkdown } from '$lib/search';
  import type { ListSortMode } from '$lib/stores';
  import type { ScoredResult } from '$lib/search';
  import {
    ensureListCreatedTs,
    effectiveListCreatedTs,
    renameListCreatedTs,
    deleteListCreatedTs,
  } from '$lib/listMeta';
  import { useSongSearch } from '$lib/useSearch.svelte';
  import SongPreviewModal from '$lib/SongPreviewModal.svelte';
  import SongTitleRow from '$lib/SongTitleRow.svelte';
  import ListDetailSheet from '$lib/ListDetailSheet.svelte';
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

  // Resolve a list-entry's display name. The cached list entry may carry an
  // empty name (e.g. an offline add to the cloud mirror), so fall back to the
  // local library cache — the same source the click-to-preview modal uses — and
  // only then to the literal "Untitled" fallback.
  function displayName(path: string, name: string | undefined): string {
    if (name) return name;
    return get(songsStore).find((s) => s.path === path)?.name || 'Untitled';
  }

  // State initialized from stores to preserve tab state
  let activeTab = $state<'public' | 'private'>($listsActiveTab);
  let selectedName = $state<string | null>($listsSelectedName);
  let showPicker = $state($listsShowPicker);
  let rawPickerQuery = $state($listsPickerRawQuery);

  let confirmDialog = $state<{ message: string; resolve: (v: boolean) => void } | null>(null);
  let promptDialog = $state<{ title: string; initial: string; value: string; resolve: (v: string | null) => void } | null>(null);
  let pickerSearchSlides = $state($listsPickerSearchSlides);

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
  $effect(() => {
    listsPickerSearchSlides.set(pickerSearchSlides);
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

  // Register the open list sheet for back gestures: back closes the sheet
  // instead of navigating away from the page.
  $effect(() => {
    if (selectedList) {
      const handleClose = () => {
        closeList();
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

  // ── List search + sort (revamped card list) ──────────────────────────────
  let sortMode = $state<ListSortMode>($listsSortMode);
  $effect(() => {
    listsSortMode.set(sortMode);
  });

  let rawQuery = $state($listsRawQuery);
  $effect(() => {
    listsRawQuery.set(rawQuery);
  });
  let searchQuery = $state('');
  let searchDebounceTimer: number | null = null;
  $effect(() => {
    const value = rawQuery;
    if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = window.setTimeout(() => {
      searchQuery = value;
    }, 120);
    return () => {
      if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
    };
  });

  // First-seen stamps for lists whose peer sends no created_ts (legacy
  // desktops). The sweep only writes when a genuinely new name appears, so it
  // is a no-op after the first run; metaVersion re-triggers age computation.
  let metaVersion = $state(0);
  $effect(() => {
    if (ensureListCreatedTs(currentLists.map((l) => l.name)) > 0) metaVersion++;
  });

  // Normalized name variants per list, recomputed only when the store changes:
  // keystrokes then filter over precomputed strings instead of re-normalizing.
  const listHaystacks = $derived.by(() => {
    const map = new Map<LibraryList, { norm: string; compact: string }>();
    for (const l of currentLists) {
      const norm = normalize(l.name);
      map.set(l, { norm, compact: norm.replace(/\s+/g, '') });
    }
    return map;
  });

  const listAges = $derived.by(() => {
    void metaVersion;
    const map = new Map<LibraryList, number>();
    for (const l of currentLists) {
      const t = effectiveListCreatedTs(l.name, l.created_ts);
      if (t !== undefined) map.set(l, t);
    }
    return map;
  });

  // Unknown age sinks to the END of both time orderings.
  const ageOf = (l: LibraryList): number => listAges.get(l) ?? Number.MAX_SAFE_INTEGER;

  const filteredLists = $derived.by(() => {
    const q = normalize(searchQuery);
    const cq = q.replace(/\s+/g, '');
    if (!q && !cq) return currentLists;
    const hay = listHaystacks;
    return currentLists.filter((l) => {
      const info = hay.get(l);
      if (!info) return false;
      return info.norm.includes(q) || (cq !== '' && info.compact.includes(cq));
    });
  });

  // Romanian-aware alphabetical order; numeric suffixes sort naturally
  // ("List 2" before "List 10").
  const nameCollator = new Intl.Collator('ro', { sensitivity: 'base', numeric: true });

  const sortedLists = $derived.by(() => {
    const arr = [...filteredLists];
    switch (sortMode) {
      case 'az':
        arr.sort((a, b) => nameCollator.compare(a.name, b.name));
        break;
      case 'za':
        arr.sort((a, b) => nameCollator.compare(b.name, a.name));
        break;
      case 'songs':
        arr.sort(
          (a, b) =>
            b.songs.length - a.songs.length || nameCollator.compare(a.name, b.name),
        );
        break;
      case 'oldest':
        arr.sort((a, b) => ageOf(a) - ageOf(b) || nameCollator.compare(a.name, b.name));
        break;
      default:
        arr.sort((a, b) => ageOf(b) - ageOf(a) || nameCollator.compare(a.name, b.name));
    }
    return arr;
  });

  async function send(cmd: { type: string; payload?: any }) {
    if ($isViewOnly) {
      showToast('View-only mode — cannot edit lists', 'warning');
      return;
    }
    // Unified path: every mutation is applied locally (with pending badge) AND
    // queued as a pending mutation for fallback. When online, the live send
    // fires too — if the server silently drops it (duplicate name, missing
    // song, …), the pending mutation will retry via flushPendingLists on next reconnect.
    const handled = await applyLocally(cmd);
    if (!handled) {
      showToast('Cannot apply this list action right now', 'warning');
      return;
    }
    if (typeIsListMutation(cmd.type) && cmd.type !== 'list.load_to_queue') {
      await addPendingMutation(cmd);
    }
    if ($connStatus === 'open') {
      remote.send(cmd as any);
    }
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
      // If the song isn't in the local cache, fall back to a placeholder entry
      // carrying just the path — the server slot resolves it via db_queue_get_song.
      const cached = get(songsStore).find((s) => s.path === payload.song_path);
      const entry = cached
        ? { path: cached.path, name: cached.name, folder: cached.folder }
        : { path: String(payload.song_path ?? ''), name: String(payload.song_path ?? 'Untitled'), folder: '' };
      if (!entry.path) return false;
      listsStore.update((ls) =>
        ls.map((l) =>
          l.name === payload.list_name
            ? markPending({ ...l, songs: [...l.songs, entry] })
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
          // No-op reorder: do not mark pending (avoids spurious sync churn).
          if (from < 0 || from >= songs.length || from === to) return l;
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
        await queueCommandForOfflineReplay({ type: 'queue.add', payload: { song_path: song.path, name: song.name, folder: song.folder } });
      }
    } else {
      return false;
    }
    await putLists(get(listsStore));
    return true;
  }

  function selectList(name: string) {
    selectedName = name;
  }

  function closeList() {
    selectedName = null;
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
    // Carry the local fallback age to the new name (server stamps follow the
    // list on their own).
    renameListCreatedTs(selectedList.name, clean);

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
    deleteListCreatedTs(selectedList.name);

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
          await queueCommandForOfflineReplay({ type: 'queue.add', payload: { song_path: song.path, name: song.name, folder: song.folder } });
        }
        return;
      }
      remote.send({ type: 'queue.clear' });
      for (const song of selectedList.songs) {
        remote.send({ type: 'queue.add', payload: { song_path: song.path, name: song.name, folder: song.folder } });
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

  /** Reorder from the sheet component (no DragEvent involved). */
  function reorderSongs(from: number, to: number) {
    if (!selectedList || from === to) return;
    if (from < 0 || to < 0 || from >= selectedList.songs.length || to >= selectedList.songs.length) return;

    if (activeTab === 'private') {
      const songs = [...selectedList.songs];
      const [moved] = songs.splice(from, 1);
      songs.splice(to, 0, moved);
      const updated = $privateListsStore.map((l) =>
        l.name === selectedList.name ? { ...l, songs } : l
      );
      privateListsStore.set(updated);
      void putPrivateLists(updated);
    } else {
      send({
        type: 'list.reorder',
        payload: { list_name: selectedList.name, from, to },
      });
    }
  }

  // ── Song picker (adds song(s) to current list) ──

  // rawPickerQuery feeds useSongSearch directly: the hook debounces the
  // worker dispatch itself, so a second debounce here would double the
  // keystroke latency (~360ms) compared to the Library page.

  // Unified worker-backed local search with an optional parallel server
  // race. Local results (~50ms) fill in instantly while the server request
  // runs with a 3s timeout; on success the server results override the
  // local ones (server-always-wins), on timeout/failure the local results
  // stay visible. The "Searching…" empty-state from the old code path is
  // gone — the user always sees something immediately.
  const localPickerSearch = useSongSearch({
    items: () => $songsStore,
    query: () => rawPickerQuery.trim(),
    searchSlides: () => pickerSearchSlides,
    maxResults: 300,
    debounceMs: 180,
    serverTimeoutMs: 3000,
  });

  const pickerFiltered = $derived.by<ScoredResult<LibrarySong>[]>(() => {
    const q = rawPickerQuery.trim();
    if (!q) return $songsStore.map((s) => ({ item: s, score: 0, snippet: '' }));
    return localPickerSearch.results;
  });
  const pickerSearchPending = $derived(localPickerSearch.pending);

  const songKeyMap = $derived.by(() => new Map($songsStore.map((song) => [song.path, song.key])));

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
      // Include name/folder so the cloud bridge (used when the desktop is
      // offline) stores the correct title instead of an empty one that the
      // list row would render as "Untitled".
      send({
        type: 'list.add_song',
        payload: { list_name: selectedList.name, song_path: s.path, name: s.name, folder: s.folder },
      });
      showToast(`Added "${s.name}"`, 'success');
    }
  }

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

{#if $pendingSyncError}
  <section class="panel muted" style="margin-top:12px; border-color: var(--warning); color: var(--warning);">
    Pending sync failed: {$pendingSyncError}. Will retry on next reconnect.
  </section>
{/if}

{#if currentLists.length === 0}
  <section class="panel muted" style="margin-top:12px;">
    No {activeTab} lists yet. Tap <b>＋ New</b> to create one.
  </section>
{:else}
  <div class="list-tools">
    <div class="search-box">
      <input
        type="text"
        placeholder="Search lists…"
        bind:value={rawQuery}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        enterkeyhint="search"
      />
      {#if rawQuery}
        <button class="clear-btn" aria-label="Clear search" onclick={() => { rawQuery = ''; }}>✕</button>
      {/if}
    </div>
    <select class="sort-select" bind:value={sortMode} aria-label="Sort lists">
      <option value="newest">Newest</option>
      <option value="oldest">Oldest</option>
      <option value="az">A-Z</option>
      <option value="za">Z-A</option>
      <option value="songs">Most songs</option>
    </select>
  </div>

  {#if sortedLists.length === 0}
    <section class="panel muted" style="margin-top:12px;">
      No lists match "{normalize(searchQuery) || searchQuery}".
    </section>
  {:else}
    <ul class="list-cards">
      {#each sortedLists as l (l.name)}
        <li>
          <button
            class="list-card"
            class:active={selectedName === l.name}
            class:pending={l.sync_status === 'pending'}
            onclick={() => selectList(l.name)}
          >
            <span class="lc-text">
              <span class="lc-name">{l.name}</span>
              <span class="muted small">{l.songs.length} song{l.songs.length === 1 ? '' : 's'}</span>
            </span>
            <span class="lc-side">
              {#if l.sync_status === 'pending'}<span class="pending-badge">PENDING SYNC</span>{/if}
              <span class="chev" aria-hidden="true">›</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

{#if selectedList}
  <ListDetailSheet
    list={selectedList}
    canEdit={activeTab === 'private' || !$isViewOnly}
    canLoad={!$isViewOnly}
    songKeyMap={songKeyMap}
    resolveName={displayName}
    onclose={closeList}
    onrename={renameList}
    ondelete={deleteList}
    onaddsong={openPicker}
    onloadqueue={loadToQueue}
    onremovesong={removeSong}
    onreorder={reorderSongs}
    onpreviewsong={openSongPreview}
  />
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
          <div class="muted small picker-status">Searching songs...</div>
        {/if}
        <VirtualList items={pickerFiltered} itemHeight={104} class="picker-virtual-list">
          {#snippet children(sr)}
            <button class="picker-item" onclick={() => addSong(sr.item)}>
              <SongTitleRow name={sr.item.name} songKey={sr.item.key}>
                {#snippet meta()}
                  {#if sr.item.folder}<div class="muted small">{sr.item.folder}</div>{/if}
                  {#if sr.snippet}<div class="snippet">{@html renderMarkdown(sr.snippet)}</div>{/if}
                {/snippet}
              </SongTitleRow>
            </button>
          {/snippet}
        </VirtualList>
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
 
  .list-tools {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }
  .search-box {
    position: relative;
    flex: 1;
    display: flex;
  }
  .search-box input {
    width: 100%;
    padding-right: 36px;
  }
  .clear-btn {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    width: 26px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--border);
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1;
  }
  .sort-select {
    max-width: 132px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 500;
    padding: 0 8px;
  }

  /* Vertical list of list-cards, one row per list. */
  .list-cards {
    list-style: none;
    padding: 0;
    margin: 0 0 12px;
  }
  .list-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 6px;
    color: var(--text-primary);
    transition: border-color 150ms ease, background-color 150ms ease, transform 100ms ease;
  }
  .list-card:hover {
    border-color: var(--border-light);
    background: var(--panel);
  }
  .list-card:active {
    transform: scale(0.98);
  }
  .list-card.active {
    border-color: var(--accent);
    background: var(--elevated);
    box-shadow: 0 0 0 1px var(--accent) inset;
  }
  .list-card.pending {
    border-color: var(--warning);
  }
  .lc-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .lc-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lc-side {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .chev {
    color: var(--text-secondary);
    font-size: 18px;
    line-height: 1;
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
  .picker-status {
    padding: 4px 2px 8px;
  }
  :global(.picker-virtual-list) {
    height: min(55vh, 520px);
    min-height: 260px;
    width: 100%;
  }
  .picker-item {
    display: block;
    width: 100%;
    min-height: 96px;
    box-sizing: border-box;
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
    max-height: 1.3em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
