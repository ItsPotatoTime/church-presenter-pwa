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
  // Baseline slides as loaded — sent to the desktop so it can compute
  // per-slide overrides (matching the desktop editor's override model)
  // instead of overwriting the whole slide set.
  let originalSlides = $state([...song.slide_texts]);
  let songName = $state(song.name);
  let selectedIndex = $state<number | null>(null);
  let isVirtual = $derived(song.path.startsWith('virtual://') || song.path.startsWith('virtual:'));

  // Initialize chorus groups
  let chorusGroups = $state<number[][]>(
    song.chorus_ranges && song.chorus_ranges.length > 0 
      ? song.chorus_ranges.map((g: number[]) => [...g])
      : (song.chorus_index !== undefined && song.chorus_index !== null 
          ? [[song.chorus_index]] 
          : [])
  );
  let chorusIndices = $derived(new Set(chorusGroups.flat()));
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

  // Reordering: Move Left / Move Right Buttons
  function moveLeft() {
    if (selectedIndex === null || selectedIndex <= 0) return;
    performMove(selectedIndex, selectedIndex - 1);
    scrollToSelected();
  }

  function moveRight() {
    if (selectedIndex === null || selectedIndex >= slides.length - 1) return;
    performMove(selectedIndex, selectedIndex + 1);
    scrollToSelected();
  }

  function scrollToSelected() {
    setTimeout(() => {
      const el = document.querySelector('.slide-thumb.selected');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }, 50);
  }

  function performMove(src: number, dst: number) {
    if (src === dst || src < 0 || src >= slides.length || dst < 0 || dst >= slides.length) return;

    // Move in slides array
    const items = [...slides];
    const [removed] = items.splice(src, 1);
    items.splice(dst, 0, removed);
    slides = items;

    // Shift chorus groups
    const remapIndex = (idx: number) => {
      if (idx === src) return dst;
      if (src < dst) {
        if (idx > src && idx <= dst) return idx - 1;
      } else {
        if (idx >= dst && idx < src) return idx + 1;
      }
      return idx;
    };
    chorusGroups = chorusGroups.map(group => {
      return group.map(remapIndex).sort((a, b) => a - b);
    });

    // Shift end slide index
    if (endSlideIndex === src) {
      endSlideIndex = dst;
    } else if (endSlideIndex !== null) {
      if (src < dst) {
        if (endSlideIndex > src && endSlideIndex <= dst) {
          endSlideIndex--;
        }
      } else {
        if (endSlideIndex >= dst && endSlideIndex < src) {
          endSlideIndex++;
        }
      }
    }

    // Shift selected index
    if (selectedIndex === src) {
      selectedIndex = dst;
    } else if (selectedIndex !== null) {
      if (src < dst) {
        if (selectedIndex > src && selectedIndex <= dst) {
          selectedIndex--;
        }
      } else {
        if (selectedIndex >= dst && selectedIndex < src) {
          selectedIndex++;
        }
      }
    }
  }

  function handleCardClick(index: number) {
    // Toggle selection
    if (selectedIndex === index) {
      selectedIndex = null;
    } else {
      selectedIndex = index;
    }
  }

  function handleTextInput(text: string) {
    if (selectedIndex === null) return;
    slides[selectedIndex] = text;

    // Chorus sync: propagate edits across all linked chorus slides in the same group
    const group = chorusGroups.find(g => g.includes(selectedIndex!));
    if (group) {
      group.forEach(idx => {
        if (idx !== selectedIndex) {
          slides[idx] = text;
        }
      });
    }
  }

  function toggleChorus(index: number) {
    const existingGroupIdx = chorusGroups.findIndex(g => g.includes(index));
    if (existingGroupIdx !== -1) {
      // Remove it from the group
      chorusGroups[existingGroupIdx] = chorusGroups[existingGroupIdx].filter(idx => idx !== index);
      // Clean up empty groups or groups with size < 2
      if (chorusGroups[existingGroupIdx].length < 2) {
        chorusGroups.splice(existingGroupIdx, 1);
      }
    } else {
      // Mark Chorus: Add it to a group
      if (chorusGroups.length > 0) {
        chorusGroups[0].push(index);
        chorusGroups[0].sort((a, b) => a - b);
      } else {
        chorusGroups.push([index]);
      }
      
      // Optional: Copy the text of the first chorus slide to this new one if it's currently blank
      const flatIndices = chorusGroups.flat();
      const firstChorusIdx = flatIndices.find(idx => idx !== index && slides[idx].trim());
      if (firstChorusIdx !== undefined && !slides[index].trim()) {
        slides[index] = slides[firstChorusIdx];
      }
    }
    chorusGroups = [...chorusGroups];
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

    // Shift chorus groups
    chorusGroups = chorusGroups
      .map(group => {
        return group
          .filter(idx => idx !== index)
          .map(idx => (idx > index ? idx - 1 : idx));
      })
      .filter(group => group.length > 0);

    // Shift end slide
    if (endSlideIndex === index) {
      endSlideIndex = null;
    } else if (endSlideIndex !== null && endSlideIndex > index) {
      endSlideIndex--;
    }

    // Shift selection
    if (selectedIndex === index) {
      selectedIndex = Math.min(index, slides.length - 1);
    } else if (selectedIndex !== null && selectedIndex > index) {
      selectedIndex--;
    }
  }

  function addSlide() {
    slides = [...slides, ''];
    selectedIndex = slides.length - 1;
    // Scroll list to end
    setTimeout(() => {
      const el = document.querySelector('.slides-list');
      if (el) el.scrollLeft = el.scrollWidth;
    }, 50);
  }

  async function handleSave() {
    if (!songName.trim()) {
      alert('Song name cannot be empty.');
      return;
    }

    // Filter out groups with length < 2 (as a group needs at least 2 linked slides)
    const ranges = chorusGroups
      .filter(g => g.length >= 2)
      .map(g => [...g]);
    const primaryChorusIndex = ranges.length > 0 ? ranges[0][0] : (chorusGroups.flat()[0] ?? null);
    const slideTexts = [...slides];

    const payload = {
      song_path: song.path,
      name: songName.trim(),
      slide_texts: slideTexts,
      original_slides: originalSlides,
      chorus_index: primaryChorusIndex,
      chorus_ranges: ranges.length > 0 ? ranges : null,
      end_slide_index: endSlideIndex,
      auto_chorus_enabled: chorusGroups.length > 0,
    };

    // 1. Update client store
    songsStore.update(list => {
      return list.map(s => {
        if (s.path === song.path) {
          return {
            ...s,
            name: payload.name,
            slide_texts: slideTexts,
            chorus_index: primaryChorusIndex ?? undefined,
            chorus_ranges: ranges.length > 0 ? ranges : undefined,
          };
        }
        return s;
      });
    });

    song.name = payload.name;
    song.slide_texts = slideTexts;
    song.chorus_index = primaryChorusIndex ?? undefined;
    song.chorus_ranges = ranges.length > 0 ? ranges : undefined;

    // 2. Persist local
    try {
      const current = $songsStore.find(s => s.path === song.path);
      if (current) await putSongs([current]);
    } catch (err) {
      console.error('Failed to save in IndexedDB:', err);
    }

    // 3. Sync or queue
    if ($connStatus === 'open') {
      try {
        const res = await remote.sendRequest('song.update', payload);
        if (!res.ok) alert(`Save error: ${res.error}`);
      } catch (err) {
        console.error('Save failed:', err);
      }
    } else {
      try {
        await addPendingMutation({ type: 'song.update', payload });
      } catch (err) {
        console.error('Mutation queue failed:', err);
      }
    }

    onclose();
  }
</script>

<div class="editor-overlay">
  <!-- Top Bar -->
  <div class="editor-header">
    <button class="header-btn cancel" onclick={onclose}>Cancel</button>
    <div class="header-title">
      {#if isVirtual}
        <input type="text" bind:value={songName} class="title-input" placeholder="Song Title" />
      {:else}
        <span class="title-display">{songName} <span class="file-badge">PPTX</span></span>
      {/if}
    </div>
    <button class="header-btn save" onclick={handleSave}>Save</button>
  </div>

  <!-- Filmstrip Layout Container -->
  <div class="editor-container" class:has-selection={selectedIndex !== null}>
    <!-- Slides list (vertical grid when no selection, horizontal filmstrip when has selection) -->
    <div class="slides-list">
      {#each slides as slide, i (i)}
        <div
          class="slide-thumb"
          class:selected={selectedIndex === i}
          class:chorus={chorusIndices.has(i)}
          class:end={endSlideIndex === i}
          class:dimmed={endSlideIndex !== null && i > endSlideIndex}
          role="button"
          tabindex="0"
          onclick={() => handleCardClick(i)}
          onkeydown={(e) => { if (e.key === 'Enter') handleCardClick(i); }}
        >
          <div class="thumb-header">
            <span class="thumb-index">#{i + 1}</span>
            <div class="badge-row">
              {#if chorusIndices.has(i)}
                <span class="mini-badge purple">C</span>
              {/if}
              {#if endSlideIndex === i}
                <span class="mini-badge orange">E</span>
              {/if}
            </div>
          </div>
          <div class="thumb-preview">
            {#each slide.split('\n').slice(0, 3) as line}
              <div class="preview-line">{@html renderMarkdown(line) || '\u00A0'}</div>
            {/each}
          </div>
        </div>
      {/each}
      
      <!-- Add Slide Thumbnail -->
      <button class="add-card-thumb" onclick={addSlide} title="Add Slide">
        <span class="add-icon">+</span>
        <span class="add-text">Add Slide</span>
      </button>
    </div>

    <!-- Bottom Pane: Active Slide Controls & Text Editor -->
    {#if selectedIndex !== null}
      <div class="editor-workspace">
        <div class="workspace-card">
          <div class="workspace-header">
            <h3>Editing Slide #{selectedIndex + 1}</h3>
            {#if chorusIndices.has(selectedIndex)}
              <span class="status-banner chorus-sync-notice">♻ Mirroring: Edits will copy to all choruses</span>
            {/if}
          </div>
          
          <!-- Text Edit Box -->
          <textarea
            value={slides[selectedIndex]}
            oninput={(e) => handleTextInput(e.currentTarget.value)}
            placeholder="Type slide lyrics here..."
            class="lyrics-textarea"
          ></textarea>

          <!-- Slide Controls Row -->
          <div class="controls-row">
            <button
              class="control-btn chorus-toggle"
              class:active={chorusIndices.has(selectedIndex)}
              onclick={() => toggleChorus(selectedIndex!)}
            >
              🎤 {chorusIndices.has(selectedIndex) ? 'Clear Chorus' : 'Mark Chorus'}
            </button>

            <button
              class="control-btn end-toggle"
              class:active={endSlideIndex === selectedIndex}
              onclick={() => toggleEndSlide(selectedIndex!)}
            >
              🚩 {endSlideIndex === selectedIndex ? 'Clear End' : 'Mark as End'}
            </button>

            <button
              class="control-btn move-btn"
              disabled={selectedIndex === 0}
              onclick={moveLeft}
            >
              ◀ Move Left
            </button>

            <button
              class="control-btn move-btn"
              disabled={selectedIndex === slides.length - 1}
              onclick={moveRight}
            >
              Move Right ▶
            </button>

            <button
              class="control-btn delete-btn"
              onclick={() => deleteSlide(selectedIndex!)}
            >
              🗑 Delete Slide
            </button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .editor-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg, #0b0b0d);
    color: var(--text, #f3f4f6);
    z-index: 110;
    display: flex;
    flex-direction: column;
    font-family: system-ui, -apple-system, sans-serif;
  }

  .editor-header {
    height: 60px;
    background: var(--panel, #15151a);
    border-bottom: 1px solid var(--border, #24242b);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    flex-shrink: 0;
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
    background: var(--elevated, #1c1c22);
    border: 1px solid var(--border, #24242b);
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
    background: rgba(255, 255, 255, 0.08);
    font-size: 11px;
    font-weight: 500;
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--text-secondary);
  }



  .editor-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Slides List Container */
  .slides-list {
    scroll-behavior: smooth;
    -webkit-overflow-scrolling: touch;
    box-sizing: border-box;
    transition: all 200ms ease-in-out;
  }

  /* Grid layout when NO selection (shows overview) */
  .editor-container:not(.has-selection) .slides-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 12px;
    padding: 16px;
    overflow-y: auto;
    flex: 1;
    background: var(--bg, #0b0b0d);
  }

  /* Horizontal filmstrip layout when HAS selection */
  .editor-container.has-selection .slides-list {
    display: flex;
    gap: 12px;
    overflow-x: auto;
    padding: 16px;
    background: var(--surface, #111115);
    border-bottom: 1px solid var(--border, #24242b);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .slide-thumb {
    background: var(--elevated, #1c1c22);
    border: 1px solid var(--border, #24242b);
    border-radius: 8px;
    padding: 8px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    transition: all 150ms ease;
    box-sizing: border-box;
    position: relative;
    user-select: none;
  }

  /* Thumbnail dimensions when NO selection */
  .editor-container:not(.has-selection) .slide-thumb {
    height: 110px;
  }

  /* Thumbnail dimensions when HAS selection */
  .editor-container.has-selection .slide-thumb {
    flex: 0 0 145px;
    height: 105px;
  }

  .slide-thumb:hover {
    border-color: var(--border-light, #3f3f46);
  }

  .slide-thumb.selected {
    border-color: var(--accent, #7c3aed);
    box-shadow: 0 0 10px rgba(124, 58, 237, 0.4);
  }

  .slide-thumb.chorus {
    background: var(--chorus-tint, rgba(124, 58, 237, 0.08));
    border-color: var(--chorus-border, rgba(124, 58, 237, 0.3));
  }
  .slide-thumb.chorus.selected {
    border-color: var(--accent);
  }

  .slide-thumb.end {
    border-color: #f97316;
  }
  .slide-thumb.end.selected {
    border-color: #f97316;
    box-shadow: 0 0 10px rgba(249, 115, 22, 0.4);
  }

  .slide-thumb.dimmed {
    opacity: 0.35;
  }



  .thumb-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-secondary, #9ca3af);
  }

  .badge-row {
    display: flex;
    gap: 4px;
  }

  .mini-badge {
    font-size: 9px;
    font-weight: 800;
    padding: 1px 4px;
    border-radius: 3px;
    color: white;
  }
  .mini-badge.purple { background: var(--accent, #7c3aed); }
  .mini-badge.orange { background: #f97316; }

  .thumb-preview {
    font-size: 11px;
    line-height: 1.3;
    white-space: pre-wrap;
    overflow: hidden;
    flex-grow: 1;
    margin-top: 6px;
    color: var(--text, #f3f4f6);
  }

  .preview-line {
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
  }

  .add-card-thumb {
    border: 2px dashed var(--border, #24242b);
    background: transparent;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    cursor: pointer;
    transition: all 150ms ease;
    color: var(--text-secondary, #9ca3af);
  }

  /* Add Slide dimensions when NO selection */
  .editor-container:not(.has-selection) .add-card-thumb {
    height: 110px;
  }

  /* Add Slide dimensions when HAS selection */
  .editor-container.has-selection .add-card-thumb {
    flex: 0 0 145px;
    height: 105px;
  }
  
  .add-card-thumb:hover {
    border-color: var(--accent, #7c3aed);
    color: var(--accent, #7c3aed);
    background: rgba(124, 58, 237, 0.03);
  }

  .add-icon { font-size: 20px; font-weight: 700; }
  .add-text { font-size: 11px; font-weight: 600; }

  /* Bottom Area: Workspace Editor */
  .editor-workspace {
    flex: 1;
    background: var(--bg, #0b0b0d);
    display: flex;
    flex-direction: column;
    padding: 16px;
    overflow-y: auto;
  }

  .workspace-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    max-width: 800px;
    width: 100%;
    margin: 0 auto;
  }

  .workspace-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }

  .workspace-header h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
  }

  .status-banner {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 4px;
  }

  .chorus-sync-notice {
    background: rgba(124, 58, 237, 0.15);
    color: #c080ff;
    border: 1px solid rgba(124, 58, 237, 0.3);
  }

  .lyrics-textarea {
    flex: 1;
    min-height: 180px;
    background: var(--elevated, #1c1c22);
    border: 1px solid var(--border, #24242b);
    border-radius: 8px;
    color: #ffffff;
    font-family: inherit;
    font-size: 16px;
    line-height: 1.5;
    padding: 16px;
    outline: none;
    resize: none;
    box-sizing: border-box;
    transition: border-color 150ms ease;
  }
  .lyrics-textarea:focus {
    border-color: var(--accent, #7c3aed);
  }

  .controls-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 4px;
  }

  .control-btn {
    flex: 1 1 120px;
    background: var(--panel, #15151a);
    border: 1px solid var(--border, #24242b);
    color: var(--text-secondary, #9ca3af);
    border-radius: 6px;
    padding: 10px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: all 150ms ease;
  }

  .control-btn:hover {
    background: rgba(255,255,255,0.03);
    border-color: var(--border-light, #3f3f46);
  }

  .control-btn.chorus-toggle.active {
    background: var(--accent, #7c3aed);
    color: white;
    border-color: var(--accent);
  }

  .control-btn.end-toggle.active {
    background: #f97316;
    color: white;
    border-color: #f97316;
  }

  .control-btn.delete-btn {
    border-color: rgba(239, 68, 68, 0.3);
    color: #f87171;
  }
  .control-btn.delete-btn:hover {
    background: rgba(239, 68, 68, 0.08);
    border-color: #ef4444;
  }

  .control-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    background: rgba(255, 255, 255, 0.02);
    border-color: var(--border);
  }

  /* No selection view removed */

  @keyframes pulse {
    0% { border-color: rgba(124, 58, 237, 0.5); }
    50% { border-color: rgba(124, 58, 237, 1); }
    100% { border-color: rgba(124, 58, 237, 0.5); }
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-5px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
