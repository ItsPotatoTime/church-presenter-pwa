<script lang="ts">
  import type { LibrarySong } from '$lib/protocol';
  import { renderMarkdown } from '$lib/search';
  import { remote } from '$lib/ws';
  import { connStatus, isViewOnly, songsStore, canEditKeys, activeModals } from '$lib/stores';
  import ProjectorOverlay from '$lib/ProjectorOverlay.svelte';

  // Svelte 5 props
  let { song, onclose } = $props<{
    song: LibrarySong;
    onclose: () => void;
  }>();

  let showProjector = $state(false);

  // Register close handler for back gestures
  $effect(() => {
    const handleClose = () => {
      onclose();
      return true;
    };
    activeModals.update(list => [...list, handleClose]);
    return () => {
      activeModals.update(list => list.filter(fn => fn !== handleClose));
    };
  });

  const ALL_KEYS = ['A', 'Am', 'A#', 'A#m', 'B', 'Bm', 'C', 'Cm', 'C#', 'C#m', 'D', 'Dm', 'D#', 'D#m', 'E', 'Em', 'F', 'Fm', 'F#', 'F#m', 'G', 'Gm', 'G#', 'G#m'];

  function addToQueue(path: string) {
    remote.send({ type: 'queue.add', payload: { song_path: path } });
  }

  async function updateSongKey(songPath: string, key: string | null) {
    if (!$canEditKeys || $isViewOnly) return;
    try {
      const res = await remote.sendRequest('song.set_key', { song_path: songPath, key });
      if (res.ok) {
        songsStore.update(songs => {
          return songs.map(s => {
            if (s.path === songPath) {
              return { ...s, key };
            }
            return s;
          });
        });
        song.key = key; // Keep local prop up to date
      } else {
        console.error('Failed to set key:', res.error);
      }
    } catch (err) {
      console.error('Error setting key:', err);
    }
  }

  async function enterProjector() {
    showProjector = true;
    const docEl = document.documentElement as any;
    try {
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      } else if (docEl.mozRequestFullScreen) {
        await docEl.mozRequestFullScreen();
      } else if (docEl.msRequestFullscreen) {
        await docEl.msRequestFullscreen();
      }
    } catch (err) {
      console.warn('Failed to enter fullscreen:', err);
    }
  }
</script>

<div
  class="modal-back"
  role="button"
  tabindex="-1"
  aria-label="Close preview"
  onclick={onclose}
  onkeydown={(e) => { if (e.key === 'Escape') onclose(); }}
>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <div class="modal-head" style="flex-direction: column; align-items: stretch; gap: 8px;">
      <div class="modal-title-row" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%;">
        <div class="modal-title" style="flex: 1; font-weight: 700; font-size: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{song.name}</div>
        <div class="key-section" style="flex-shrink: 0; display: flex; align-items: center;">
          {#if $canEditKeys && !$isViewOnly}
            <select
              class="key-select"
              value={song.key || ''}
              onchange={(e) => updateSongKey(song.path, e.currentTarget.value || null)}
              style="background: var(--elevated); border: 1px solid var(--border); border-radius: 6px; color: var(--accent); font-size: 13px; font-weight: 700; padding: 4px 8px; cursor: pointer; outline: none;"
            >
              <option value="">No Key</option>
              {#each ALL_KEYS as k}
                <option value={k}>{k}</option>
              {/each}
            </select>
          {:else if song.key}
            <span class="key-display-badge" style="background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); color: var(--accent); font-size: 13px; font-weight: 700; padding: 4px 8px; border-radius: 6px; display: inline-block;">Key: {song.key}</span>
          {/if}
        </div>
        <button class="ghost" style="padding: 6px 12px; font-size: 13px; flex-shrink: 0;" onclick={onclose}>Close</button>
      </div>
      
      <div style="display: flex; gap: 8px; width: 100%; margin-top: 4px; margin-bottom: 8px;">
        <button
          class="accent"
          style="flex: 2; padding: 10px 14px; font-size: 14px;"
          onclick={() => { addToQueue(song.path); onclose(); }}
          disabled={$connStatus !== 'open' || $isViewOnly}
        >
          + Add to queue
        </button>
        <button
          class="ghost"
          style="flex: 1; padding: 10px 14px; font-size: 14px; border-color: var(--accent); color: var(--accent);"
          onclick={enterProjector}
        >
          Projector Show
        </button>
      </div>
    </div>
    {#each song.slide_texts as slide, i (i)}
      <div class="slide-prev" class:chorus={song.chorus_index === i}>
        {#each slide.split('\n') as line}
          <div>{@html renderMarkdown(line) || '\u00A0'}</div>
        {/each}
      </div>
    {/each}
  </div>
</div>

{#if showProjector}
  <ProjectorOverlay {song} onclose={() => { showProjector = false; }} />
{/if}

<style>
  .modal-back {
    position: fixed;
    inset: 0;
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
    max-height: 90vh;
    overflow-y: auto;
    padding: 16px;
    box-shadow: 0 -4px 30px rgba(0, 0, 0, 0.35);
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .modal-title { font-weight: 700; font-size: 18px; }
  
  .slide-prev {
    background: var(--elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 6px;
    white-space: pre-wrap;
    line-height: 1.4;
    font-size: 13px;
    transition: border-color 150ms ease;
  }
  .slide-prev:hover {
    border-color: var(--border-light);
  }
  .slide-prev.chorus {
    background: var(--chorus-tint);
    border-color: var(--chorus-border);
    color: #fff;
    box-shadow: 0 0 10px rgba(124, 58, 237, 0.15);
  }

  button.ghost {
    background: transparent;
    border-color: var(--border);
    color: var(--text-secondary);
    border-radius: 8px;
    padding: 10px 18px;
    font-family: inherit;
    font-size: 15px;
    cursor: pointer;
    transition: background 150ms ease, border-color 150ms ease, color 150ms ease, transform 100ms ease;
  }
  button.ghost:hover {
    border-color: var(--accent);
    background: var(--panel);
  }

  button.accent {
    background: var(--accent);
    color: #fff;
    font-weight: 700;
    border: none;
    border-radius: 8px;
    padding: 10px 18px;
    font-family: inherit;
    font-size: 15px;
    cursor: pointer;
    transition: background 150ms ease, transform 100ms ease;
  }
  button.accent:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  button.accent:active:not(:disabled) {
    background: var(--accent-dim);
    transform: scale(0.97);
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
