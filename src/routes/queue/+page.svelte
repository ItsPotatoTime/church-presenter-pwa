<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { loadCredentialsResilient } from '$lib/db';
  import { applyQueueCommandLocally, queueCommandForOfflineReplay } from '$lib/offlineQueue';
  import type { ClientCommand, LibrarySong } from '$lib/protocol';
  import { remote } from '$lib/ws';
  import { connStatus, isViewOnly, queueState, queueDragActive, liveState, songsStore, activeModals } from '$lib/stores';
  import SongPreviewModal from '$lib/SongPreviewModal.svelte';

  const songByPath = $derived.by(() => new Map($songsStore.map((song) => [song.path, song])));
  const songKeyMap = $derived.by(() => new Map($songsStore.map((song) => [song.path, song.key])));

  let confirmDialog = $state<{ message: string; resolve: (v: boolean) => void } | null>(null);
  let previewSong = $state<LibrarySong | null>(null);
  let previewSwitchIndex = $state<number | null>(null);
  const queueSwitchPrompt = $derived(
    previewSwitchIndex === null
      ? null
      : `Switch to "${$queueState?.items[previewSwitchIndex]?.name || 'this song'}"?`,
  );

  function showConfirm(msg: string): Promise<boolean> {
    return new Promise(resolve => { confirmDialog = { message: msg, resolve }; });
  }

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

  onMount(async () => {
    const creds = await loadCredentialsResilient();
    if (!creds?.device_token) { goto(`${base}/`); return; }
    await remote.connect();
  });

  async function send(cmd: ClientCommand) {
    if ($isViewOnly) return;
    if ($connStatus === 'open') {
      remote.send(cmd);
      return;
    }
    if (await applyQueueCommandLocally(cmd)) {
      await queueCommandForOfflineReplay(cmd);
    }
  }

  async function tapJump(i: number) {
    if (dragging !== null) return; // swallow taps that end a drag

    const item = $queueState?.items[i];
    const song = item && !item.is_bible && !item.is_merged ? (songByPath.get(item.path) ?? null) : null;
    if (song) {
      // Open the phone-only song preview menu. Nothing is sent to the desktop
      // until the user Confirm's in that menu (see confirmPreviewSwitch).
      previewSong = song;
      previewSwitchIndex = $isViewOnly ? null : i;
      return;
    }
    if ($isViewOnly) return;
    // Bible/merged items can't be previewed as a song — go live on confirm (as before).
    const name = $queueState?.items[i]?.name || 'this song';
    if (!await showConfirm(`Switch to "${name}"?`)) return;
    send({ type: 'live.goto', payload: { song_index: i, slide_index: 0 } });
  }

  function closePreview() {
    previewSong = null;
    previewSwitchIndex = null;
  }

  function cancelPreviewSwitch() {
    closePreview();
  }

  function confirmPreviewSwitch() {
    if (previewSwitchIndex === null || $isViewOnly) return;
    const idx = previewSwitchIndex;
    if ($liveState?.presenting) {
      // A show is already running and we're away from the laptop — switch live now
      // instead of waiting on the desktop's pending-confirm banner.
      send({ type: 'live.goto', payload: { song_index: idx, slide_index: 0 } });
    } else {
      // Idle: just select/load the song in the desktop main app (no live yet).
      send({ type: 'queue.select', payload: { song_index: idx } });
    }
    closePreview();
  }

  async function remove(pos: number) {
    const name = $queueState?.items[pos]?.name || 'this song';
    if (!await showConfirm(`Remove "${name}" from queue?`)) return;
    send({ type: 'queue.remove', payload: { position: pos } });
  }

  async function clearAll() {
    if (await showConfirm('Clear the entire queue?')) send({ type: 'queue.clear' });
  }

  // ─── Animated drag-to-reorder ─────────────────────────────────────────────
  // Items stay in DOM order; we use CSS translateY to shift them visually.
  // A floating ghost clone follows the pointer.

  let dragging = $state<number | null>(null);
  let insertAt = $state<number | null>(null);
  let ghostStyle = $state('');
  let ghostItem = $state<{ name: string; path?: string; folder?: string; is_merged?: boolean; is_bible?: boolean } | null>(null);

  // Cached at drag-start (viewport-relative, before any drag transforms).
  let _tops: number[] = [];
  let _heights: number[] = [];
  let _pointerOffsetY = 0;
  let _ghostLeft = 0;
  let _ghostWidth = 0;

  /** How many pixels item i should shift to make room for the dragged item. */
  function itemShift(i: number): string {
    if (dragging === null || insertAt === null || i === dragging) return 'translateY(0)';
    const d = dragging, t = insertAt;
    const step = (_heights[d] ?? 60) + 8; // item height + gap
    if (t < d && i >= t && i < d) return `translateY(${step}px)`;
    if (t > d && i > d && i <= t) return `translateY(${-step}px)`;
    return 'translateY(0)';
  }

  function onGripDown(e: PointerEvent, i: number) {
    if ($isViewOnly) return;
    e.preventDefault();

    const els = document.querySelectorAll<HTMLElement>('.qitem');
    const el = els[i];
    if (!el) return;

    const rect = el.getBoundingClientRect();
    _tops    = Array.from(els, el => el.getBoundingClientRect().top);
    _heights = Array.from(els, el => el.getBoundingClientRect().height);
    _pointerOffsetY = e.clientY - rect.top;
    _ghostLeft  = rect.left;
    _ghostWidth = rect.width;

    dragging  = i;
    insertAt  = i;
    queueDragActive.set(true);
    const qi = $queueState?.items[i];
    ghostItem = { name: qi?.name ?? '', path: qi?.path, folder: qi?.folder, is_merged: qi?.is_merged, is_bible: qi?.is_bible };
    ghostStyle = `top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px`;

    window.addEventListener('pointermove', onDragMove, { passive: false });
    window.addEventListener('pointerup',     onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  }

  function onDragMove(e: PointerEvent) {
    if (dragging === null) return;
    e.preventDefault();

    ghostStyle = `top:${e.clientY - _pointerOffsetY}px;left:${_ghostLeft}px;width:${_ghostWidth}px`;

    // Refresh geometry from the live DOM each move (the list may have re-rendered
    // since grip-down). Using stale cached positions would compute the wrong
    // drop index — the source of the flaky reorder.
    const els = document.querySelectorAll<HTMLElement>('.qitem');
    _tops    = Array.from(els, el => el.getBoundingClientRect().top);
    _heights = Array.from(els, el => el.getBoundingClientRect().height);

    // Count items (excluding dragged) whose midpoint is above the pointer.
    let rank = 0;
    for (let j = 0; j < _tops.length; j++) {
      if (j === dragging) continue;
      if (_tops[j] + _heights[j] / 2 < e.clientY) rank++;
    }
    insertAt = rank;
  }

  function onDragEnd() {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup',     onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);

    const from = dragging, to = insertAt;
    dragging  = null;
    insertAt  = null;
    ghostItem = null;
    queueDragActive.set(false);

    if (from !== null && to !== null && from !== to && !$isViewOnly) {
      const cmd: ClientCommand = { type: 'queue.reorder', payload: { from, to } };
      // Apply locally (adjusts the playing/current pointers so the live highlight
      // stays on the same song) and ship to the desktop — or queue for offline
      // replay. A single local apply replaces the old inline splice, which left
      // the playing index pointing at the wrong song and double-moved offline.
      void applyQueueCommandLocally(cmd);
      if ($connStatus === 'open') {
        remote.send(cmd);
      } else {
        void queueCommandForOfflineReplay(cmd);
      }
    }
  }

  onDestroy(() => {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup',     onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    queueDragActive.set(false);
  });
</script>

<header class="hdr">
  <div>
    <h1>Queue</h1>
    <div class="muted small">
      {#if $queueState}
        {$queueState.items.length} songs
        {#if $queueState.playing_song_index >= 0}
          · playing #{$queueState.playing_song_index + 1}
        {/if}
      {:else}
        Waiting for state…
      {/if}
    </div>
  </div>
  <div class="actions">
    <a class="btn ghost" href="{base}/library/" class:disabled={$isViewOnly}>＋ Add</a>
    <button
      class="ghost"
      onclick={clearAll}
      disabled={!$queueState?.items.length || $isViewOnly}
    >Clear</button>
  </div>
</header>

{#if $queueState && $queueState.items.length > 0}
  <ul class="qlist">
    {#each $queueState.items as item, i (i + ':' + item.path)}
      <li
        class="qitem"
        class:playing={$queueState.playing_song_index === i}
        class:current={$queueState.current_song_index === i && $queueState.playing_song_index !== i}
        class:drag-src={dragging === i}
        style="transform:{itemShift(i)};transition:transform 220ms cubic-bezier(0.2,0,0,1)"
      >
        <span
          class="grip"
          aria-hidden="true"
          onpointerdown={(e) => onGripDown(e, i)}
        >⋮⋮</span>
        <button class="label" onclick={() => tapJump(i)}>
          <div class="name-row" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;">
            <div class="name">{item.name || songByPath.get(item.path)?.name || 'Untitled'}</div>
            {#if !item.is_bible && !item.is_merged && songKeyMap.get(item.path)}
              <span class="key-badge">{songKeyMap.get(item.path)}</span>
            {/if}
          </div>
          {#if item.is_bible}
            <div class="muted small bible-tag">📖 {item.bible_refs?.length ?? 0} verse{((item.bible_refs?.length ?? 0) !== 1) ? 's' : ''}</div>
          {:else if item.is_merged}
            <div class="muted small merged-tag">🔀 merged</div>
          {:else if item.folder}
            <div class="muted small">{item.folder}</div>
          {/if}
        </button>
        <button class="rm" aria-label="Remove" onclick={() => remove(i)} disabled={$isViewOnly}>✕</button>
      </li>
    {/each}
  </ul>
{:else}
  <section class="panel muted" style="margin-top:12px;">
    Queue is empty. Add songs from the Library tab.
  </section>
{/if}

<!-- Floating ghost — follows the pointer, elevated above everything -->
{#if dragging !== null && ghostItem}
  <div class="drag-ghost" style={ghostStyle}>
    <span class="grip">⋮⋮</span>
    <div class="ghost-label">
      <div class="name">{ghostItem.name || songByPath.get(ghostItem.path ?? '')?.name || 'Untitled'}</div>
      {#if ghostItem.is_bible}
        <div class="muted small">📖 Bible</div>
      {:else if ghostItem.is_merged}
        <div class="muted small">🔀 merged</div>
      {:else if ghostItem.folder}
        <div class="muted small">{ghostItem.folder}</div>
      {/if}
    </div>
  </div>
{/if}

{#if previewSong}
  <SongPreviewModal
    song={previewSong}
    onclose={closePreview}
    queueSwitchPrompt={queueSwitchPrompt}
    onQueueSwitchConfirm={confirmPreviewSwitch}
    onQueueSwitchCancel={cancelPreviewSwitch}
  />
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
      class="modal"
      role="alertdialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="modal-msg">{confirmDialog.message}</div>
      <div class="modal-btns">
        <button class="ghost" onclick={() => { confirmDialog?.resolve(false); confirmDialog = null; }}>Cancel</button>
        <button class="accent" onclick={() => { confirmDialog?.resolve(true); confirmDialog = null; }}>Confirm</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .hdr {
    display: flex; justify-content: space-between; align-items: flex-end;
    gap: 12px; padding: 4px 0 12px;
  }
  h1 { margin: 0 0 2px; font-size: 22px; font-weight: 700; }
  .small { font-size: 12px; }
  .actions { display: flex; gap: 8px; }
  .btn {
    display: inline-block;
    padding: 10px 14px;
    border-radius: 8px;
    text-decoration: none;
    font-size: 14px;
    border: 1px solid var(--border);
    color: var(--text-primary);
    transition: background 150ms ease, border-color 150ms ease, transform 100ms ease;
  }
  .btn:hover:not(.disabled) {
    background: var(--panel);
    border-color: var(--accent);
  }
  .btn:active:not(.disabled) {
    transform: scale(0.97);
  }
 
  .qlist { list-style: none; padding: 0; margin: 0; }
  .qitem {
    display: grid;
    grid-template-columns: 36px 1fr 44px;
    gap: 8px;
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px 10px;
    margin-bottom: 8px;
    will-change: transform;
    box-sizing: border-box;
    transition: background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
  }
  .qitem.playing { border-color: var(--accent); box-shadow: 0 0 12px rgba(233, 69, 96, 0.25), 0 0 0 1px var(--accent) inset; }
  .qitem.current { border-color: var(--border-light); }
  /* Source item is invisible during drag — ghost takes its visual place */
  .qitem.drag-src { opacity: 0; }
 
  .grip {
    color: var(--text-secondary);
    font-size: 14px;
    cursor: grab;
    /* Prevent browser scroll / text-select from hijacking touch on the handle */
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    /* Larger touch target without changing visual footprint */
    padding: 12px 6px;
    margin: -12px -6px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
 
  .label {
    text-align: left; background: transparent; border: none;
    padding: 10px 4px; color: var(--text-primary); border-radius: 6px;
  }
  .name { font-weight: 600; }
  .rm {
    width: 40px; padding: 0; font-size: 16px;
    background: transparent; color: var(--text-secondary); border-color: var(--border);
    transition: color 150ms ease, border-color 150ms ease, background-color 150ms ease, transform 100ms ease;
  }
  .rm:hover:not(:disabled) { color: var(--danger); border-color: var(--danger); }
  .rm:active:not(:disabled) { transform: scale(0.95); background: rgba(239, 68, 68, 0.15); }
  a.btn.disabled { pointer-events: none; opacity: 0.45; }
 
  /* ── Floating drag ghost ──────────────────────────────────────────── */
  .drag-ghost {
    position: fixed;
    z-index: 9999;
    display: grid;
    grid-template-columns: 36px 1fr;
    gap: 8px;
    align-items: center;
    padding: 4px 10px;
    border-radius: 10px;
    background: var(--elevated, #2a2a2a);
    border: 1px solid var(--accent);
    box-shadow:
      0 12px 40px rgba(0, 0, 0, 0.5),
      0 4px 12px rgba(0, 0, 0, 0.35);
    transform: scale(1.04);
    pointer-events: none;
    box-sizing: border-box;
    /* GPU-composited so it tracks the finger with zero jank */
    will-change: top, left;
  }
  .ghost-label .name { font-weight: 600; }
  .bible-tag { color: var(--accent); }
 
  /* ── Confirm modal ─────────────────────────────────────────────────── */
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
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px 14px 0 0;
    width: 100%;
    max-width: 720px;
    padding: 20px 16px 24px;
    box-shadow: 0 -4px 30px rgba(0, 0, 0, 0.3);
  }
  .modal-msg {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 18px;
    text-align: center;
  }
  .modal-btns { display: flex; gap: 10px; }
  .modal-btns button { flex: 1; padding: 13px; font-size: 15px; }
  button.ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-primary);
  }
</style>
