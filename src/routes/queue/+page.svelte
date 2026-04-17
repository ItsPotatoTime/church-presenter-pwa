<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { loadCredentials } from '$lib/db';
  import { remote } from '$lib/ws';
  import { connStatus, queueState } from '$lib/stores';

  let dragFrom = $state<number | null>(null);
  let dragOver = $state<number | null>(null);

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
    remote.send(cmd);
  }

  function tapJump(songIdx: number) {
    send({ type: 'live.goto', payload: { song_index: songIdx, slide_index: 0 } });
  }
  function remove(pos: number) {
    send({ type: 'queue.remove', payload: { position: pos } });
  }
  function clearAll() {
    if (confirm('Clear the entire queue?')) {
      send({ type: 'queue.clear' });
    }
  }

  // ── Drag reorder (HTML5 DnD — works in mobile Safari/Chrome with long-press) ──
  function onDragStart(e: DragEvent, i: number) {
    dragFrom = i;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Safari refuses drag without setData
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
    <a class="btn ghost" href="{base}/library/">＋ Add</a>
    <button class="ghost" onclick={clearAll} disabled={!$queueState?.items.length}>Clear</button>
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
        draggable={true}
        ondragstart={(e) => onDragStart(e, i)}
        ondragover={(e) => onDragOver(e, i)}
        ondrop={(e) => onDrop(e, i)}
        ondragend={onDragEnd}
      >
        <span class="grip" aria-hidden="true">⋮⋮</span>
        <button class="label" onclick={() => tapJump(i)}>
          <div class="name">{item.name || 'Untitled'}</div>
          {#if item.folder}<div class="muted small">{item.folder}</div>{/if}
        </button>
        <button class="rm" aria-label="Remove" onclick={() => remove(i)}>✕</button>
      </li>
    {/each}
  </ul>
{:else}
  <section class="panel muted" style="margin-top:12px;">
    Queue is empty. Add songs from the Library tab.
  </section>
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
</style>
