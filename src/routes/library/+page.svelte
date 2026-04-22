<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { loadCredentials } from '$lib/db';
  import { remote } from '$lib/ws';
  import { syncFull } from '$lib/sync';
  import {
    connStatus,
    isViewOnly,
    songsStore,
    syncStatus,
  } from '$lib/stores';
  import type { LibrarySong } from '$lib/protocol';
  import { normalize, renderMarkdown } from '$lib/search';

  let rawQuery = $state('');
  let query = $state('');
  let searchSlides = $state(false);
  let previewSong = $state<LibrarySong | null>(null);
  let debounceTimer: number | null = null;
  // Progressive rendering — only mount up to renderCount song nodes at a time.
  let renderCount = $state(300);
  let sentinel = $state<Element | null>(null);

  onMount(async () => {
    const creds = await loadCredentials();
    if (!creds?.device_token) {
      goto(`${base}/`);
      return;
    }
    await remote.connect();
  });

  const hasLibrary = $derived(($songsStore?.length ?? 0) > 0);

  let lastSyncAt = 0;
  $effect(() => {
    if ($connStatus !== 'open') return;
    const now = Date.now();
    if (now - lastSyncAt < 30_000) return;
    lastSyncAt = now;
    // Always full sync so slide_texts are never stale from an old IndexedDB snapshot.
    void syncFull();
  });

  $effect(() => {
    const v = rawQuery;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => { query = v; }, 200);
    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  });

  // IntersectionObserver: load the next chunk when the sentinel scrolls into view.
  $effect(() => {
    const el = sentinel;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          renderCount = Math.min(renderCount + 200, $songsStore.length);
        }
      },
      { rootMargin: '400px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  });

  type Entry = {
    s: LibrarySong;
    nName: string;
    nFolder: string;
    nSlides: string[] | null;
  };

  // Pre-normalise name/folder once per library snapshot.
  const index = $derived.by<Entry[]>(() =>
    $songsStore.map((s) => ({
      s,
      nName: normalize(s.name),
      nFolder: normalize(s.folder),
      nSlides: null,
    })),
  );

  // Lazy slide-normalisation — only computed when slide search is active.
  function slidesFor(e: Entry): string[] {
    if (e.nSlides) return e.nSlides;
    e.nSlides = (e.s.slide_texts ?? []).map(normalize);
    return e.nSlides;
  }

  const hasQuery = $derived(normalize(query).length > 0);

  // ── Browse mode (no query) — grouped + progressive ──────────────────
  const browseSongs = $derived<LibrarySong[]>(
    hasQuery ? [] : index.slice(0, renderCount).map((e) => e.s),
  );

  const grouped = $derived.by(() => {
    const groups = new Map<string, LibrarySong[]>();
    for (const s of browseSongs) {
      const k = s.folder || '—';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(s);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  // ── Search mode (query present) — scored + ranked, capped at MAX_RESULTS ──
  type SR = { s: LibrarySong; score: number; snippet: string };
  const MAX_RESULTS = 200;

  // Collects results in priority order (name > folder > slides) with an early-exit
  // cap so we never build or render more than MAX_RESULTS DOM nodes.
  // No sort needed — priority buckets are merged in order.
  const searchData = $derived.by<{ items: SR[]; overflow: boolean }>(() => {
    const q = normalize(query);
    if (!q) return { items: [], overflow: false };
    const names: SR[] = [];
    const folders: SR[] = [];
    const slideHits: SR[] = [];
    let overflow = false;

    for (const e of index) {
      if (names.length + folders.length + slideHits.length >= MAX_RESULTS) {
        overflow = true;
        break;
      }
      if (e.nName.includes(q)) {
        names.push({ s: e.s, score: 3, snippet: '' });
      } else if (e.nFolder.includes(q)) {
        folders.push({ s: e.s, score: 2, snippet: '' });
      } else if (searchSlides) {
        const ns = slidesFor(e);
        for (let si = 0; si < ns.length; si++) {
          if (ns[si].includes(q)) {
            const nIdx = ns[si].indexOf(q);
            const raw = e.s.slide_texts[si] ?? '';
            const start = Math.max(0, nIdx - 20);
            const end = Math.min(raw.length, nIdx + q.length + 40);
            const snip =
              (start > 0 ? '…' : '') +
              raw.slice(start, end).trim() +
              (end < raw.length ? '…' : '');
            slideHits.push({ s: e.s, score: 1, snippet: snip });
            break;
          }
        }
      }
    }

    return { items: [...names, ...folders, ...slideHits], overflow };
  });

  const searchResults = $derived(searchData.items);
  const searchOverflow = $derived(searchData.overflow);

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
    {:else if hasQuery}{searchResults.length}{searchOverflow ? '+' : ''} result{searchResults.length !== 1 ? 's' : ''}
    {:else}{$songsStore.length} songs{/if}
  </div>
</header>

<button class="bible-entry" type="button" disabled aria-disabled="true">
  <div class="bible-copy">
    <span class="bible-kicker">Coming soon</span>
    <span class="bible-title">Bible</span>
    <span class="bible-desc">Quick access for passages and references will live here.</span>
  </div>
  <span class="bible-pill">Later</span>
</button>

<section class="searchbar">
  <input
    type="text"
    placeholder="Search songs…"
    bind:value={rawQuery}
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
    onclick={() => void syncFull()}
    disabled={$syncStatus === 'syncing' || $connStatus !== 'open'}
  >↻</button>
</section>

{#if !hasLibrary && $syncStatus !== 'syncing'}
  <section class="panel muted" style="margin-top:12px;">
    No songs cached yet. Pull once the desktop is connected.
  </section>

{:else if hasQuery}
  <!-- ── Search results — flat, sorted by relevance ─────────────── -->
  {#if searchResults.length === 0}
    <section class="panel muted" style="margin-top:12px;">
      No songs match "{query}".
    </section>
  {:else}
    {#each searchResults as r (r.s.path)}
      <div class="song">
        <button class="song-main" onclick={() => openPreview(r.s)}>
          <div class="song-name">{r.s.name}</div>
          <div class="muted small">{r.s.folder || '—'}</div>
          {#if r.snippet}
            <div class="snippet muted">{@html renderMarkdown(r.snippet)}</div>
          {/if}
        </button>
        <button
          class="add"
          aria-label="Add to queue"
          onclick={() => addToQueue(r.s.path)}
          disabled={$connStatus !== 'open' || $isViewOnly}
        >＋</button>
      </div>
    {/each}
    {#if searchOverflow}
      <p class="muted small load-hint">Showing first {MAX_RESULTS} — type more to narrow results</p>
    {/if}
  {/if}

{:else}
  <!-- ── Browse — grouped by folder, progressive rendering ──────── -->
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
            disabled={$connStatus !== 'open' || $isViewOnly}
          >＋</button>
        </div>
      {/each}
    </section>
  {/each}

  {#if renderCount < $songsStore.length}
    <div bind:this={sentinel} class="sentinel" aria-hidden="true"></div>
    <p class="muted small load-hint">
      Showing {Math.min(renderCount, $songsStore.length)} of {$songsStore.length} — scroll for more
    </p>
  {/if}
{/if}

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
            <div>{@html renderMarkdown(line) || '\u00A0'}</div>
          {/each}
        </div>
      {/each}
      <button
        class="accent fw"
        onclick={() => { if (previewSong) addToQueue(previewSong.path); closePreview(); }}
        disabled={$connStatus !== 'open' || $isViewOnly}
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

  .bible-entry {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin: 0 0 14px;
    padding: 14px 16px;
    border-radius: 16px;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--panel) 72%, transparent), color-mix(in srgb, var(--surface) 88%, transparent)),
      var(--surface);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    text-align: left;
    cursor: default;
    opacity: 1;
  }
  .bible-entry:disabled {
    opacity: 1;
    cursor: default;
  }
  .bible-copy {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .bible-kicker {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--accent);
    font-weight: 700;
  }
  .bible-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .bible-desc {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.4;
  }
  .bible-pill {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--accent) 60%, var(--border));
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.2px;
  }

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
  .snippet {
    font-size: 11px;
    font-style: italic;
    margin-top: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 240px;
  }
  .add {
    width: 52px;
    font-size: 20px;
    font-weight: 700;
    color: var(--accent);
    border-color: var(--border);
  }

  .sentinel { height: 1px; }
  .load-hint { text-align: center; padding: 6px 0 10px; margin: 0; }

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
