<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { loadCredentials } from '$lib/db';
  import { remote } from '$lib/ws';
  import { syncNow, hydrateFromCache } from '$lib/sync';
  import {
    connStatus,
    songsStore,
    syncStatus,
  } from '$lib/stores';
  import type { LibrarySong } from '$lib/protocol';

  let query = $state('');
  let searchSlides = $state(false);
  let previewSong = $state<LibrarySong | null>(null);
  let hasLibrary = $state(false);

  onMount(async () => {
    const creds = await loadCredentials();
    if (!creds?.device_token) {
      goto(`${base}/`);
      return;
    }
    await hydrateFromCache();
    hasLibrary = ($songsStore?.length ?? 0) > 0;
    await remote.connect();
    // Wait a tick for ws to open, then sync; if closed, the button lets the user retry.
  });

  // Sync once the socket reaches "open".
  $effect(() => {
    if ($connStatus === 'open') void syncNow().then(() => {
      hasLibrary = ($songsStore?.length ?? 0) > 0;
    });
  });

  const filtered = $derived.by(() => {
    const all = $songsStore;
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) => {
      if (s.name.toLowerCase().includes(q)) return true;
      if (s.folder.toLowerCase().includes(q)) return true;
      if (searchSlides) {
        for (const t of s.slide_texts ?? []) {
          if (t.toLowerCase().includes(q)) return true;
        }
      }
      return false;
    });
  });

  const grouped = $derived.by(() => {
    const groups = new Map<string, LibrarySong[]>();
    for (const s of filtered) {
      const k = s.folder || '—';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(s);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  function addToQueue(path: string) {
    remote.send({ type: 'queue.add', payload: { song_path: path } });
  }

  function openPreview(s: LibrarySong) {
    previewSong = s;
  }

  function closePreview() {
    previewSong = null;
  }
</script>

<header class="hdr">
  <h1>Library</h1>
  <div class="muted small">
    {#if $syncStatus === 'syncing'}Syncing…
    {:else if $syncStatus === 'error'}Sync failed — tap refresh
    {:else}{$songsStore.length} songs{/if}
  </div>
</header>

<section class="searchbar">
  <input
    type="text"
    placeholder="Search songs…"
    bind:value={query}
    autocomplete="off"
    autocapitalize="off"
    autocorrect="off"
  />
  <label class="slides-toggle">
    <input type="checkbox" bind:checked={searchSlides} />
    Slides
  </label>
  <button
    class="refresh"
    aria-label="Refresh"
    onclick={() => void syncNow()}
    disabled={$syncStatus === 'syncing' || $connStatus !== 'open'}
  >↻</button>
</section>

{#if !hasLibrary && $syncStatus !== 'syncing'}
  <section class="panel muted" style="margin-top:12px;">
    No songs cached yet. Pull once the desktop is connected.
  </section>
{/if}

{#each grouped as [folder, songs] (folder)}
  <section class="group">
    <div class="group-head">{folder}</div>
    {#each songs as s (s.path)}
      <div class="song">
        <button class="song-main" onclick={() => openPreview(s)}>
          <div class="song-name">{s.name}</div>
          {#if s.slide_texts?.length}
            <div class="muted small">{s.slide_texts.length} slides</div>
          {/if}
        </button>
        <button
          class="add"
          aria-label="Add to queue"
          onclick={() => addToQueue(s.path)}
          disabled={$connStatus !== 'open'}
        >＋</button>
      </div>
    {/each}
  </section>
{/each}

{#if previewSong}
  <div
    class="modal-back"
    role="button"
    tabindex="-1"
    aria-label="Close preview"
    onclick={closePreview}
    onkeydown={(e) => { if (e.key === 'Escape') closePreview(); }}
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
        <div class="modal-title">{previewSong.name}</div>
        <button class="ghost" onclick={closePreview}>Close</button>
      </div>
      {#each previewSong.slide_texts as slide, i (i)}
        <div class="slide-prev" class:chorus={previewSong.chorus_index === i}>
          {#each slide.split('\n') as line}
            <div>{line || '\u00A0'}</div>
          {/each}
        </div>
      {/each}
      <button
        class="accent fw"
        onclick={() => { if (previewSong) addToQueue(previewSong.path); closePreview(); }}
        disabled={$connStatus !== 'open'}
      >
        ＋ Add to queue
      </button>
    </div>
  </div>
{/if}

<style>
  .hdr { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; padding: 4px 0 10px; }
  h1 { margin:0; font-size: 22px; font-weight: 700; }
  .small { font-size: 12px; }

  .searchbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;
  }
  .searchbar input[type="text"] { flex: 1; }
  .slides-toggle {
    display: inline-flex; gap: 4px; align-items: center;
    font-size: 12px; color: var(--text-secondary);
  }
  .refresh {
    width: 40px; height: 40px; padding: 0;
    font-size: 18px; line-height: 1;
  }

  .group { margin-bottom: 14px; }
  .group-head {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-secondary);
    padding: 8px 2px 4px;
  }

  .song {
    display: flex;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px;
    margin-bottom: 6px;
  }
  .song-main {
    flex: 1;
    text-align: left;
    background: transparent;
    border: none;
    padding: 10px 12px;
    color: var(--text-primary);
    border-radius: 8px;
  }
  .song-name { font-weight: 600; }
  .add {
    width: 52px;
    font-size: 20px;
    font-weight: 700;
    color: var(--accent);
    border-color: var(--border);
  }

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
    max-height: 90vh;
    overflow-y: auto;
    padding: 16px;
  }
  .modal-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
  }
  .modal-title { font-weight: 700; font-size: 18px; }
  button.ghost {
    background: transparent;
    border-color: var(--border);
    color: var(--text-secondary);
  }
  button.accent.fw { width: 100%; padding: 14px; margin-top: 12px; }

  .slide-prev {
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 6px;
    white-space: pre-wrap;
    line-height: 1.4;
    font-size: 13px;
  }
  .slide-prev.chorus { background: var(--chorus-tint); color: #fff; }
</style>
