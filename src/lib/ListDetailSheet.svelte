<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import SongTitleRow from './SongTitleRow.svelte';
  import type { LibraryList } from '$lib/protocol';

  // Bottom-sheet detail view for one list. Presentational only: every data
  // mutation is delegated to the page via callbacks so offline/pending logic
  // keeps a single source of truth there.
  let {
    list,
    canEdit,
    canLoad,
    songKeyMap,
    resolveName,
    onclose,
    onrename,
    ondelete,
    onaddsong,
    onloadqueue,
    onremovesong,
    onreorder,
    onpreviewsong,
  }: {
    list: LibraryList;
    /** Rename/delete/add/remove/reorder allowed (view-only public lists). */
    canEdit: boolean;
    /** Load-to-queue allowed (blocked by view-only, not by public/private). */
    canLoad: boolean;
    songKeyMap: Map<string, string | null | undefined>;
    resolveName: (path: string, name: string) => string;
    onclose: () => void;
    onrename: () => void;
    ondelete: () => void;
    onaddsong: () => void;
    onloadqueue: () => void;
    onremovesong: (pos: number) => void;
    onreorder: (from: number, to: number) => void;
    onpreviewsong: (path: string) => void;
  } = $props();

  // ── Drag-to-reorder (HTML5 dnd, same interaction as the old inline list) ──
  let dragFrom = $state<number | null>(null);
  let dragOver = $state<number | null>(null);

  function onDragStart(e: DragEvent, i: number) {
    if (!canEdit) return;
    dragFrom = i;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    }
  }
  function onDragOver(e: DragEvent, i: number) {
    if (!canEdit) return;
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
    onreorder(from, i);
  }
  function onDragEnd() {
    dragFrom = null;
    dragOver = null;
  }
</script>

<div class="sheet-root">
  <div
    class="sheet-back"
    role="button"
    tabindex="-1"
    aria-label="Close list"
    onclick={onclose}
    onkeydown={(e) => { if (e.key === 'Escape') onclose(); }}
    transition:fade={{ duration: 160 }}
  ></div>

  <div
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-label="List {list.name}"
    transition:fly={{ y: 80, duration: 200 }}
  >
    <header class="sheet-head">
      <div class="sheet-title">
        <span class="t-name">{list.name}</span>
        {#if list.sync_status === 'pending'}<span class="pending-badge">PENDING SYNC</span>{/if}
      </div>
      <button class="x" aria-label="Close" onclick={onclose}>✕</button>
    </header>

    <div class="sheet-actions">
      <button class="ghost" onclick={onrename} disabled={!canEdit}>✎ Rename</button>
      <button class="ghost danger" onclick={ondelete} disabled={!canEdit}>✕ Delete</button>
    </div>
    <div class="sheet-actions">
      <button
        class="ghost"
        onclick={onaddsong}
        disabled={!canEdit}
      >＋ Add song</button>
      <button
        class="accent"
        onclick={onloadqueue}
        disabled={!canLoad || list.songs.length === 0}
      >▶ Load to queue</button>
    </div>

    <div class="sheet-body">
      {#if list.songs.length === 0}
        <section class="panel muted empty">No songs in this list.</section>
      {:else}
        <ul class="songs">
          {#each list.songs as song, i (i + ':' + song.path)}
            <li
              class="song-row"
              class:drop={dragOver === i}
              draggable={canEdit}
              ondragstart={(e) => onDragStart(e, i)}
              ondragover={(e) => onDragOver(e, i)}
              ondrop={(e) => onDrop(e, i)}
              ondragend={onDragEnd}
            >
              <span class="grip" aria-hidden="true">⋮⋮</span>
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="meta"
                onclick={() => onpreviewsong(song.path)}
                style="cursor: pointer; flex: 1;"
                role="button"
                tabindex="0"
              >
                <SongTitleRow name={resolveName(song.path, song.name)} songKey={songKeyMap.get(song.path)}>
                  {#snippet meta()}
                    {#if song.folder}<div class="muted small">{song.folder}</div>{/if}
                  {/snippet}
                </SongTitleRow>
              </div>
              <button
                class="rm"
                aria-label="Remove from list"
                onclick={() => onremovesong(i)}
                disabled={!canEdit}
              >✕</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</div>

<style>
  .sheet-root {
    position: fixed;
    inset: 0;
    /* Below the generic modal layer (z-100) so the song picker, confirm and
       preview dialogs stack on top of the sheet. */
    z-index: 90;
  }
  .sheet-back {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .sheet {
    position: absolute;
    /* Centered card, like a desktop dialog but sized for touch. */
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    width: calc(100% - 32px);
    max-width: 480px;
    max-height: 76vh;
    background: var(--surface);
    border: 1px solid var(--border-light);
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
    overflow: hidden;
  }

  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 16px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .sheet-title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-size: 17px;
    font-weight: 700;
  }
  .t-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .x {
    width: 32px;
    height: 32px;
    padding: 0;
    flex-shrink: 0;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 14px;
    transition: color 150ms ease, border-color 150ms ease;
  }
  .x:hover {
    color: var(--text-primary);
    border-color: var(--border-light);
  }

  .sheet-actions {
    display: flex;
    gap: 8px;
    padding: 10px 16px 0;
    flex-shrink: 0;
  }
  .sheet-actions > button {
    flex: 1;
    padding: 11px 8px;
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
  button.ghost.danger:hover:not(:disabled) {
    border-color: var(--danger);
    color: var(--danger);
  }
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

  .sheet-body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 10px 16px 16px;
    overscroll-behavior: contain;
  }
  .empty {
    margin-top: 4px;
  }

  .songs { list-style: none; padding: 0; margin: 0; }
  .song-row {
    display: grid;
    grid-template-columns: 24px 1fr 44px;
    gap: 8px;
    align-items: center;
    background: var(--elevated, var(--panel));
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 10px;
    margin-bottom: 6px;
    transition: border-color 150ms ease, background-color 150ms ease;
  }
  .song-row.drop { border-color: var(--accent); }
  .grip { color: var(--text-secondary); font-size: 14px; cursor: grab; }
  .rm {
    width: 40px; padding: 0; font-size: 16px;
    background: transparent; color: var(--text-secondary); border-color: var(--border);
    transition: color 150ms ease, border-color 150ms ease, background-color 150ms ease, transform 100ms ease;
  }
  .rm:hover:not(:disabled) { color: var(--danger); border-color: var(--danger); }
  .rm:active:not(:disabled) { transform: scale(0.95); background: rgba(239, 68, 68, 0.15); }

  .small { font-size: 12px; }
</style>
