<script lang="ts">
  import type { LibrarySong } from '$lib/protocol';
  import { renderMarkdown } from '$lib/search';
  import { remote } from '$lib/ws';
  import { connStatus, isViewOnly, songsStore, activeModals } from '$lib/stores';
  import { putSongs, addPendingMutation } from '$lib/db';

  // Svelte 5 props
  let { song, onclose } = $props<{
    song: LibrarySong;
    onclose: () => void;
  }>();

  // State
  let slides = $state([...song.slide_texts]);
  let songName = $state(song.name);
  let selectedIndex = $state<number | null>(slides.length > 0 ? 0 : null);
  let showMobileEditor = $state(false);
  let isVirtual = $derived(song.path.startsWith('virtual://') || song.path.startsWith('virtual:'));

  // Initialize chorus indices
  const initialChorus = new Set<number>();
  if (song.chorus_index !== undefined && song.chorus_index !== null) {
    initialChorus.add(song.chorus_index);
  }
  if (song.chorus_ranges) {
    for (const range of song.chorus_ranges) {
      for (const idx of range) {
        initialChorus.add(idx);
      }
    }
  }
  let chorusIndices = $state<Set<number>>(initialChorus);

  // Initialize end slide index if slides were previously limited
  // However, on PWA we only get the visible slides, so we allow marking any index as end.
  let endSlideIndex = $state<number | null>(null);

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

  // Drag and drop state
  let dragIndex = $state<number | null>(null);

  function handleDragStart(index: number, e: DragEvent) {
    dragIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Set dummy text for Firefox drag support
      e.dataTransfer.setData('text/plain', index.toString());
    }
  }

  function handleDragOver(index: number, e: DragEvent) {
    e.preventDefault();
  }

  function handleDrop(index: number, e: DragEvent) {
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;

    // Reorder slides
    const items = [...slides];
    const [removed] = items.splice(dragIndex, 1);
    items.splice(index, 0, removed);
    slides = items;

    // Map chorus indices
    const newChorus = new Set<number>();
    chorusIndices.forEach(idx => {
      if (idx === dragIndex) {
        newChorus.add(index);
      } else if (dragIndex < index) {
        if (idx > dragIndex && idx <= index) {
          newChorus.add(idx - 1);
        } else {
          newChorus.add(idx);
        }
      } else { // dragIndex > index
        if (idx >= index && idx < dragIndex) {
          newChorus.add(idx + 1);
        } else {
          newChorus.add(idx);
        }
      }
    });
    chorusIndices = newChorus;

    // Map end slide
    if (endSlideIndex === dragIndex) {
      endSlideIndex = index;
    } else if (endSlideIndex !== null) {
      if (dragIndex < index) {
        if (endSlideIndex > dragIndex && endSlideIndex <= index) {
          endSlideIndex--;
        }
      } else {
        if (endSlideIndex >= index && endSlideIndex < dragIndex) {
          endSlideIndex++;
        }
      }
    }

    if (selectedIndex === dragIndex) {
      selectedIndex = index;
    } else if (selectedIndex !== null) {
      if (dragIndex < index) {
        if (selectedIndex > dragIndex && selectedIndex <= index) {
          selectedIndex--;
        }
      } else {
        if (selectedIndex >= index && selectedIndex < dragIndex) {
          selectedIndex++;
        }
      }
    }

    dragIndex = null;
  }

  function moveSlide(index: number, direction: 'up' | 'down') {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= slides.length) return;

    const items = [...slides];
    const [removed] = items.splice(index, 1);
    items.splice(targetIndex, 0, removed);
    slides = items;

    // Swap chorus index memberships
    const newChorus = new Set<number>();
    chorusIndices.forEach(idx => {
      if (idx === index) {
        newChorus.add(targetIndex);
      } else if (idx === targetIndex) {
        newChorus.add(index);
      } else {
        newChorus.add(idx);
      }
    });
    chorusIndices = newChorus;

    // Swap end slide
    if (endSlideIndex === index) {
      endSlideIndex = targetIndex;
    } else if (endSlideIndex === targetIndex) {
      endSlideIndex = index;
    }

    // Swap selected
    if (selectedIndex === index) {
      selectedIndex = targetIndex;
    } else if (selectedIndex === targetIndex) {
      selectedIndex = index;
    }
  }

  function toggleChorus(index: number) {
    if (chorusIndices.has(index)) {
      chorusIndices.delete(index);
    } else {
      chorusIndices.add(index);
    }
    chorusIndices = new Set(chorusIndices); // trigger reactivity
  }

  function toggleEndSlide(index: number) {
    if (endSlideIndex === index) {
      endSlideIndex = null;
    } else {
      endSlideIndex = index;
    }
  }

  function deleteSlide(index: number) {
    if (slides.length <= 1) {
      alert('A song must have at least one slide.');
      return;
    }
    slides.splice(index, 1);
    slides = [...slides];

    // Shift chorus indices
    const newChorus = new Set<number>();
    chorusIndices.forEach(idx => {
      if (idx === index) return; // removed
      if (idx > index) {
        newChorus.add(idx - 1);
      } else {
        newChorus.add(idx);
      }
    });
    chorusIndices = newChorus;

    // Shift end slide index
    if (endSlideIndex === index) {
      endSlideIndex = null;
    } else if (endSlideIndex !== null && endSlideIndex > index) {
      endSlideIndex--;
    }

    // Adjust selected index
    if (selectedIndex === index) {
      selectedIndex = Math.min(index, slides.length - 1);
    } else if (selectedIndex !== null && selectedIndex > index) {
      selectedIndex--;
    }
  }

  function addSlide() {
    slides = [...slides, 'New Slide Text'];
    selectedIndex = slides.length - 1;
  }

  function computeChorusRanges(chorusSet: Set<number>): number[][] {
    const sorted = Array.from(chorusSet).sort((a, b) => a - b);
    const groups: number[][] = [];
    let currentGroup: number[] = [];
    for (const idx of sorted) {
      if (currentGroup.length === 0 || idx === currentGroup[currentGroup.length - 1] + 1) {
        currentGroup.push(idx);
      } else {
        groups.push(currentGroup);
        currentGroup = [idx];
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    return groups;
  }

  async function handleSave() {
    if (!songName.trim()) {
      alert('Song name cannot be empty.');
      return;
    }

    const ranges = computeChorusRanges(chorusIndices);
    const primaryChorusIndex = ranges.length > 0 && ranges[0].length > 0 ? ranges[0][0] : null;

    const payload = {
      song_path: song.path,
      name: songName.trim(),
      slide_texts: slides,
      chorus_index: primaryChorusIndex,
      chorus_ranges: ranges.length > 0 ? ranges : null,
      end_slide_index: endSlideIndex,
      auto_chorus_enabled: chorusIndices.size > 0,
    };

    // 1. Optimistically update local PWA store
    songsStore.update(songsList => {
      return songsList.map(s => {
        if (s.path === song.path) {
          return {
            ...s,
            name: payload.name,
            slide_texts: slides,
            chorus_index: primaryChorusIndex ?? undefined,
            chorus_ranges: ranges.length > 0 ? ranges : undefined,
          };
        }
        return s;
      });
    });

    // Mirror props to the parent preview modal
    song.name = payload.name;
    song.slide_texts = slides;
    song.chorus_index = primaryChorusIndex ?? undefined;
    song.chorus_ranges = ranges.length > 0 ? ranges : undefined;

    // 2. Persist in IndexedDB local cache
    try {
      const currentSongData = $songsStore.find(s => s.path === song.path);
      if (currentSongData) {
        await putSongs([currentSongData]);
      }
    } catch (err) {
      console.error('Failed to save song locally in IndexedDB:', err);
    }

    // 3. Dispatch to desktop or queue offline mutation
    if ($connStatus === 'open') {
      try {
        const res = await remote.sendRequest('song.update', payload);
        if (!res.ok) {
          console.error('Failed to update song on server:', res.error);
          alert(`Error saving to desktop: ${res.error}`);
        }
      } catch (err) {
        console.error('Error sending song update request:', err);
      }
    } else {
      // Offline mode: queue pending mutation
      try {
        await addPendingMutation({ type: 'song.update', payload });
      } catch (err) {
        console.error('Failed to queue offline update:', err);
      }
    }

    onclose();
  }
</script>

<div class="editor-overlay">
  <div class="editor-header">
    <div class="header-left">
      <button class="header-btn cancel" onclick={onclose}>Cancel</button>
    </div>
    <div class="header-title">
      {#if isVirtual}
        <input
          type="text"
          bind:value={songName}
          class="title-input"
          placeholder="Edit Song Title"
        />
      {:else}
        <span class="title-display">{songName} <span class="file-badge">PPTX</span></span>
      {/if}
    </div>
    <div class="header-right">
      <button class="header-btn save" onclick={handleSave}>Save</button>
    </div>
  </div>

  <div class="editor-layout">
    <!-- Left Pane: Slide List & Sorting -->
    <div class="slides-pane">
      <div class="pane-header">
        <h3>Slides ({slides.length})</h3>
        <button class="add-btn" onclick={addSlide}>+ Add Slide</button>
      </div>

      <div class="slides-list">
        {#each slides as slide, i (i)}
          <div
            class="slide-card"
            class:selected={selectedIndex === i}
            class:chorus={chorusIndices.has(i)}
            class:end={endSlideIndex === i}
            class:dimmed={endSlideIndex !== null && i > endSlideIndex}
            class:dragging={dragIndex === i}
            role="button"
            tabindex="0"
            draggable="true"
            ondragstart={(e) => handleDragStart(i, e)}
            ondragover={(e) => handleDragOver(i, e)}
            ondrop={(e) => handleDrop(i, e)}
            onclick={() => { selectedIndex = i; }}
            onkeydown={(e) => { if (e.key === 'Enter') selectedIndex = i; }}
          >
            <!-- Drag Handle / Number -->
            <div class="slide-num">
              <span class="drag-icon">⋮⋮</span>
              <span class="num-lbl">{i + 1}</span>
            </div>

            <!-- Slide Content Preview -->
            <div class="slide-body-prev">
              {#each slide.split('\n').slice(0, 3) as line}
                <div class="line-prev">{@html renderMarkdown(line) || '\u00A0'}</div>
              {/each}
              {#if slide.split('\n').length > 3}
                <div class="more-indicator">...</div>
              {/if}
            </div>

            <!-- Actions Row -->
            <div class="slide-actions" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
              <button
                class="action-btn chorus-toggle"
                class:active={chorusIndices.has(i)}
                onclick={() => toggleChorus(i)}
                title="Toggle Chorus"
              >
                Chorus
              </button>
              <button
                class="action-btn end-toggle"
                class:active={endSlideIndex === i}
                onclick={() => toggleEndSlide(i)}
                title="Mark as End"
              >
                End
              </button>
              
              <div class="reorder-btns">
                <button
                  class="reorder-btn"
                  disabled={i === 0}
                  onclick={() => moveSlide(i, 'up')}
                  title="Move Up"
                >
                  ▲
                </button>
                <button
                  class="reorder-btn"
                  disabled={i === slides.length - 1}
                  onclick={() => moveSlide(i, 'down')}
                  title="Move Down"
                >
                  ▼
                </button>
              </div>

              <button
                class="edit-btn"
                onclick={() => { selectedIndex = i; showMobileEditor = true; }}
                title="Edit Text"
              >
                ✎
              </button>
              <button
                class="delete-btn"
                onclick={() => deleteSlide(i)}
                title="Delete Slide"
              >
                🗑
              </button>
            </div>
          </div>
        {/each}
      </div>
    </div>

    <!-- Right Pane: Desktop Slide Editor (Hidden on Mobile) -->
    <div class="textarea-pane">
      {#if selectedIndex !== null}
        <div class="editor-container">
          <div class="editor-headline">
            <span>Editing Slide {selectedIndex + 1}</span>
            <div class="badge-row">
              {#if chorusIndices.has(selectedIndex)}
                <span class="badge chorus-badge">CHORUS</span>
              {/if}
              {#if endSlideIndex === selectedIndex}
                <span class="badge end-badge">END SLIDE</span>
              {/if}
            </div>
          </div>
          <textarea
            value={slides[selectedIndex]}
            oninput={(e) => {
              if (selectedIndex !== null) {
                slides[selectedIndex] = e.currentTarget.value;
              }
            }}
            placeholder="Type slide text here..."
            class="editor-textarea"
          ></textarea>
        </div>
      {:else}
        <div class="no-selection">
          Select a slide to edit its text.
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- Mobile Text Editor Modal (Overlay) -->
{#if showMobileEditor && selectedIndex !== null}
  <div class="mobile-editor-overlay" onclick={() => showMobileEditor = false} onkeydown={(e) => { if (e.key === 'Escape') showMobileEditor = false; }}>
    <div class="mobile-editor-dialog" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
      <div class="dialog-head">
        <h4>Edit Slide {selectedIndex + 1}</h4>
        <button class="close-dialog" onclick={() => showMobileEditor = false}>Done</button>
      </div>
      <textarea
        value={slides[selectedIndex]}
        oninput={(e) => {
          if (selectedIndex !== null) {
            slides[selectedIndex] = e.currentTarget.value;
          }
        }}
        placeholder="Type slide text here..."
        class="dialog-textarea"
      ></textarea>
    </div>
  </div>
{/if}

<style>
  .editor-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg, #121214);
    color: var(--text, #f3f4f6);
    z-index: 110;
    display: flex;
    flex-direction: column;
    font-family: system-ui, -apple-system, sans-serif;
  }

  .editor-header {
    height: 60px;
    background: var(--panel, #1e1e24);
    border-bottom: 1px solid var(--border, #2d2d34);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
  }

  .header-btn {
    border: none;
    background: transparent;
    padding: 8px 16px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    border-radius: 6px;
    transition: background 150ms ease;
  }
  
  .header-btn.cancel {
    color: var(--text-secondary, #9ca3af);
  }
  .header-btn.cancel:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .header-btn.save {
    background: var(--accent, #7c3aed);
    color: #ffffff;
  }
  .header-btn.save:hover {
    background: var(--accent-hover, #6d28d9);
  }

  .header-title {
    flex: 1;
    max-width: 480px;
    text-align: center;
    display: flex;
    justify-content: center;
  }

  .title-input {
    background: var(--elevated, #18181c);
    border: 1px solid var(--border, #2d2d34);
    border-radius: 6px;
    color: #ffffff;
    padding: 6px 12px;
    font-size: 15px;
    font-weight: 600;
    width: 100%;
    text-align: center;
    outline: none;
  }
  .title-input:focus {
    border-color: var(--accent, #7c3aed);
  }

  .title-display {
    font-size: 16px;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .file-badge {
    background: rgba(255,255,255,0.08);
    font-size: 11px;
    font-weight: 500;
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--text-secondary);
  }

  .editor-layout {
    display: grid;
    grid-template-columns: 1fr;
    height: calc(100% - 60px);
    overflow: hidden;
  }

  @media (min-width: 768px) {
    .editor-layout {
      grid-template-columns: 380px 1fr;
    }
  }

  /* Left Pane: Slide Cards List */
  .slides-pane {
    border-right: 1px solid var(--border, #2d2d34);
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
  }

  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border, #2d2d34);
    background: var(--surface, #15151a);
  }

  .pane-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    color: var(--text-secondary);
  }

  .add-btn {
    background: transparent;
    border: 1px solid var(--accent, #7c3aed);
    color: var(--accent, #7c3aed);
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
    transition: background 150ms ease;
  }
  .add-btn:hover {
    background: rgba(124, 58, 237, 0.08);
  }

  .slides-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .slide-card {
    background: var(--elevated, #18181c);
    border: 1px solid var(--border, #2d2d34);
    border-radius: 8px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    cursor: pointer;
    position: relative;
    user-select: none;
    transition: transform 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
  }
  
  .slide-card:hover {
    border-color: var(--border-light, #4b5563);
  }

  .slide-card.selected {
    border-color: var(--accent, #7c3aed);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .slide-card.chorus {
    background: var(--chorus-tint, rgba(124, 58, 237, 0.1));
    border-color: var(--chorus-border, rgba(124, 58, 237, 0.3));
  }
  .slide-card.chorus.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .slide-card.end {
    border-color: #f97316;
  }
  .slide-card.end.selected {
    border-color: #f97316;
    box-shadow: 0 0 0 1px #f97316;
  }

  .slide-card.dimmed {
    opacity: 0.35;
  }

  .slide-card.dragging {
    opacity: 0.5;
    transform: scale(0.98);
    border-style: dashed;
  }

  .slide-num {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-secondary);
  }

  .drag-icon {
    font-size: 14px;
    letter-spacing: -1px;
    cursor: grab;
    color: #4b5563;
  }

  .slide-body-prev {
    font-size: 12.5px;
    line-height: 1.4;
    white-space: pre-wrap;
    color: var(--text);
  }

  .line-prev {
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
  }

  .more-indicator {
    font-size: 11px;
    color: var(--text-secondary);
    margin-top: 2px;
  }

  .slide-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    border-top: 1px solid rgba(255,255,255,0.04);
    padding-top: 8px;
    margin-top: 2px;
  }

  .action-btn {
    border: 1px solid var(--border);
    background: transparent;
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    color: var(--text-secondary);
    transition: all 150ms ease;
  }

  .action-btn.chorus-toggle.active {
    background: var(--accent, #7c3aed);
    color: white;
    border-color: var(--accent);
  }

  .action-btn.end-toggle.active {
    background: #f97316;
    color: white;
    border-color: #f97316;
  }

  .reorder-btns {
    display: flex;
    gap: 2px;
  }

  .reorder-btn {
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 5px;
    font-size: 9px;
    cursor: pointer;
    color: var(--text-secondary);
  }
  .reorder-btn:disabled {
    opacity: 0.2;
    cursor: not-allowed;
  }

  .edit-btn, .delete-btn {
    background: transparent;
    border: none;
    font-size: 12px;
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 4px;
    transition: background 150ms ease;
  }
  
  .edit-btn {
    color: #3b82f6;
    margin-left: auto;
  }
  .edit-btn:hover { background: rgba(59, 130, 246, 0.08); }

  .delete-btn {
    color: #ef4444;
  }
  .delete-btn:hover { background: rgba(239, 68, 68, 0.08); }

  /* Right Pane: Slide Text Editor Area */
  .textarea-pane {
    background: var(--surface, #15151a);
    display: none;
    height: 100%;
    padding: 24px;
    box-sizing: border-box;
  }

  @media (min-width: 768px) {
    .textarea-pane {
      display: block;
    }
  }

  .editor-container {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
  }

  .editor-headline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 14px;
    font-weight: 700;
    color: var(--text-secondary);
  }

  .badge-row {
    display: flex;
    gap: 6px;
  }

  .badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .chorus-badge {
    background: var(--accent);
    color: white;
  }

  .end-badge {
    background: #f97316;
    color: white;
  }

  .editor-textarea {
    flex: 1;
    background: var(--elevated, #18181c);
    border: 1px solid var(--border, #2d2d34);
    border-radius: 8px;
    color: #ffffff;
    font-family: inherit;
    font-size: 16px;
    line-height: 1.5;
    padding: 16px;
    outline: none;
    resize: none;
    transition: border-color 150ms ease;
  }
  .editor-textarea:focus {
    border-color: var(--accent, #7c3aed);
  }

  .no-selection {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary);
    font-size: 15px;
  }

  /* Mobile Editor Overlay */
  .mobile-editor-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 120;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    padding: 16px;
  }

  .mobile-editor-dialog {
    background: var(--panel, #1e1e24);
    border: 1px solid var(--border, #2d2d34);
    border-radius: 12px;
    width: 100%;
    max-width: 480px;
    height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
  }

  .dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border, #2d2d34);
  }

  .dialog-head h4 {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
  }

  .close-dialog {
    background: var(--accent, #7c3aed);
    color: white;
    border: none;
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 700;
    border-radius: 6px;
    cursor: pointer;
  }

  .dialog-textarea {
    flex: 1;
    background: var(--bg, #121214);
    border: none;
    color: white;
    padding: 16px;
    font-family: inherit;
    font-size: 15px;
    line-height: 1.5;
    outline: none;
    resize: none;
  }
</style>
