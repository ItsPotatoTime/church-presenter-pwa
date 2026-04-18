<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { loadCredentials } from '$lib/db';
  import { remote } from '$lib/ws';
  import { connStatus, isViewOnly, queueState } from '$lib/stores';

  let dragFrom = $state<number | null>(null);
  let dragOver = $state<number | null>(null);
  let confirmDialog = $state<{ message: string; resolve: (v: boolean) => void } | null>(null);

  function showConfirm(message: string): Promise<boolean> {
    return new Promise((resolve) => { confirmDialog = { message, resolve }; });
  }

  onMount(async () => {
    const creds = await loadCredentials();
    if (!creds?.device_token) {
      goto(`${base}/`);
      return;
    }
    await remote.connect();
  });

  function send(cmd: any) {
    if ($connStatus !== 'open') return;
    if ($isViewOnly) return; // exclusive mode — read-only
    remote.send(cmd);
  }

  async function tapJump(songIdx: number) {
    const name = $queueState?.items[songIdx]?.name || 'this song';
    if (!await showConfirm(`Switch to "${name}"?`)) return;
    send({ type: 'live.goto', payload: { song_index: songIdx, slide_index: 0 } });
  }
  async function remove(pos: number) {
    const name = $queueState?.items[pos]?.name || 'this song';
    if (!await showConfirm(`Remove "${name}" from queue?`)) return;
    send({ type: 'queue.remove', payload: { position: pos } });
  }
  async function clearAll() {
    if (await showConfirm('Clear the entire queue?')) {
      send({ type: 'queue.clear' });
    }
  }

  // ── Drag reorder (HTML5 DnD + touch for mobile) ─────────────────
  function onDragStart(e: DragEvent, i: number) {
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
    if (from === null || from === i) return;
    send({ type: 'queue.reorder', payload: { from, to: i } });
  }
  function onDragEnd() {
    dragFrom = null;
    dragOver = null;
  }

  // ── Touch drag (mobile — HTML5 DnD doesn't fire touch events) ──
  let touchStartY = 0;
  let touchActive = false;
  let longPressTimer: number | null = null;
  let touchIdx = -1;

  function onTouchStart(e: TouchEvent, i: number) {
    if ($isViewOnly) return;
    touchIdx = i;
    touchStartY = e.touches[0].clientY;
    longPressTimer = window.setTimeout(() => {
      touchActive = true;
      dragFrom = i;
      dragOver = i;
    }, 300);
  }

  function onTouchMove(e: TouchEvent) {
    if (!touchActive) {
      if (longPressTimer !== null && Math.abs(e.touches[0].clientY - touchStartY) > 10) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      return;
    }
    e.preventDefault();
    const touch = e.touches[0];
    const els = document.querySelectorAll('.qitem');
    for (let j = 0; j < els.length; j++) {
      const rect = els[j].getBoundingClientRect();
      if (touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
        dragOver = j;
        break;
      }
    }
  }

  function onTouchEnd() {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (!touchActive) return;
    touchActive = false;
    const from = dragFrom;
    const to = dragOver;
    dragFrom = null;
    dragOver = null;
    if (from === null || to === null || from === to) return;
    send({ type: 'queue.reorder', payload: { from, to } });
  }
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
        class:drop={dragOver === i}
        class:dragging={dragFrom === i && touchActive}
        draggable={!$isViewOnly}
        ondragstart={(e) => onDragStart(e, i)}
        ondragover={(e) => onDragOver(e, i)}
        ondrop={(e) => onDrop(e, i)}
        ondragend={onDragEnd}
        ontouchstart={(e) => onTouchStart(e, i)}
        ontouchmove={(e) => onTouchMove(e)}
        ontouchend={onTouchEnd}
      >
        <span class="grip" aria-hidden="true">⋮⋮</span>
        <button class="label" onclick={() => tapJump(i)} disabled={$isViewOnly}>
          <div class="name">{item.name || 'Untitled'}</div>
          {#if item.folder}<div class="muted small">{item.folder}</div>{/if}
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
  }

  .qlist { list-style: none; padding: 0; margin: 0; }
  .qitem {
    display: grid;
    grid-template-columns: 24px 1fr 44px;
    gap: 8px;
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px 10px;
    margin-bottom: 8px;
  }
  .qitem.playing { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .qitem.current { border-color: var(--border-light); }
  .qitem.drop { border-color: var(--accent); background: var(--elevated); }
  .qitem.dragging { opacity: 0.5; transform: scale(0.97); }

  .grip { color: var(--text-secondary); font-size: 14px; cursor: grab; }
  .label {
    text-align: left; background: transparent; border: none;
    padding: 10px 4px; color: var(--text-primary); border-radius: 6px;
  }
  .name { font-weight: 600; }
  .rm {
    width: 40px; padding: 0; font-size: 16px;
    background: transparent; color: var(--text-secondary); border-color: var(--border);
  }
  .rm:hover { color: var(--danger); border-color: var(--danger); }
  a.btn.disabled {
    pointer-events: none;
    opacity: 0.45;
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
    padding: 20px 16px 24px;
  }
  .modal-msg {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 18px;
    text-align: center;
  }
  .modal-btns {
    display: flex;
    gap: 10px;
  }
  .modal-btns button {
    flex: 1;
    padding: 13px;
    font-size: 15px;
  }
  button.ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-primary);
  }
</style>
