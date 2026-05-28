<script lang="ts">
  import { onMount } from 'svelte';
  import { renderMarkdown } from '$lib/search';
  import type { LibrarySong } from '$lib/protocol';
  import { activeModals } from '$lib/stores';

  let { song, onclose } = $props<{ song: LibrarySong; onclose: () => void }>();

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

  let currentIndex = $state(0);
  let winW = $state(0);
  let winH = $state(0);
  let fontSize = $state(40);
  let wakeLock = $state<any>(null);

  // Normalization and matching logic for chorus detection
  const cleanText = (t: string): string => {
    return t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  };

  const getExpandedSlides = (slideTexts: string[], chorusIndex: number | undefined) => {
    if (chorusIndex === undefined || chorusIndex < 0 || chorusIndex >= slideTexts.length) {
      return slideTexts.map((text, i) => ({ text, isChorus: false, originalIndex: i }));
    }
    const chorusText = slideTexts[chorusIndex];
    const count = slideTexts.filter(t => t.trim() === chorusText.trim()).length;
    if (count >= 2) {
      return slideTexts.map((text, i) => ({
        text,
        isChorus: text.trim() === chorusText.trim(),
        originalIndex: i
      }));
    }

    const result: { text: string; isChorus: boolean; originalIndex: number }[] = [];
    for (let i = 0; i < slideTexts.length; i++) {
      const text = slideTexts[i];
      result.push({ text, isChorus: i === chorusIndex, originalIndex: i });
      if (i !== chorusIndex) {
        const nextIndex = i + 1;
        const isNextChorus = nextIndex < slideTexts.length && nextIndex === chorusIndex;
        const hasNoChorusSuffix = text.endsWith('\u200b');
        if (!isNextChorus && !hasNoChorusSuffix) {
          result.push({ text: chorusText, isChorus: true, originalIndex: chorusIndex });
        }
      }
    }
    return result;
  };

  const expandedSlides = $derived(getExpandedSlides(song.slide_texts, song.chorus_index));

  // End marker detection matches the desktop slide engine regex:
  // _END_MARKER_RE = re.compile(r'[\*✦✤✥•·×✶✸★☆]{3,}\s*$')
  const END_MARKER_RE = /[\*✦✤✥•·×✶✸★☆]{3,}\s*$/;

  const slideHasEndMarker = (text: string): boolean => {
    if (!text || !text.trim()) return false;
    const lines = text.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    return END_MARKER_RE.test(lastLine);
  };

  const stripEndMarker = (text: string): string => {
    if (!text || !text.trim()) return text;
    const lines = text.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const cleaned = lastLine.replace(END_MARKER_RE, '').trim();
    if (cleaned) {
      lines[lines.length - 1] = cleaned;
    } else {
      lines.pop();
    }
    return lines.join('\n');
  };

  const endMarkerIndices = $derived.by(() => {
    const indices = new Set<number>();
    expandedSlides.forEach((slide, i) => {
      if (slideHasEndMarker(slide.text)) {
        indices.add(i);
      }
    });
    if (indices.size === 0 && expandedSlides.length > 0) {
      indices.add(expandedSlides.length - 1);
    }
    return indices;
  });

  const currentSlide = $derived(expandedSlides[currentIndex] || { text: '', isChorus: false });
  const hasEndMarker = $derived(endMarkerIndices.has(currentIndex));

  const displayText = $derived(hasEndMarker ? stripEndMarker(currentSlide.text) : currentSlide.text);
  const displayTextLines = $derived(displayText.split('\n'));

  // Calculate padding responsively (min 20px, scales with viewport width/height)
  const padding = $derived(Math.max(20, Math.floor(Math.min(winW, winH) * 0.06)));

  function computeFontSize(
    text: string,
    width: number,
    height: number,
    pad: number,
    bold: boolean,
    showEnd: boolean
  ): number {
    if (width <= 0 || height <= 0) return 40;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 40;

    const availableW = width - 2 * pad;
    const lines = text.split('\n');

    let lo = 12;
    let hi = 300;
    let best = lo;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      ctx.font = `${bold ? 'bold' : 'normal'} ${mid}px 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", "SF Pro Display", "Ubuntu", system-ui, sans-serif`;
      
      let fits = true;
      for (const line of lines) {
        // Remove bold markdown tags from text measurements to be accurate
        const cleanLine = line.replace(/\*\*/g, '');
        if (ctx.measureText(cleanLine).width > availableW) {
          fits = false;
          break;
        }
      }

      if (fits) {
        const lineHeight = mid * 1.45;
        const textHeight = lineHeight * lines.length;

        let availableH = height - 2 * pad;
        if (showEnd) {
          const markerSize = Math.max(20, Math.floor(mid * 0.6));
          const reserved = markerSize + 24;
          
          // Overlap check identical to the Python logic
          const textTop = pad + Math.max(0, (availableH - textHeight) / 2);
          const markerTop = height - pad - markerSize - 4;
          if (textTop + textHeight > markerTop) {
            availableH -= reserved;
          }
        }

        if (textHeight <= availableH) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      } else {
        hi = mid - 1;
      }
    }

    return best;
  }

  $effect(() => {
    const text = displayText;
    const w = winW;
    const h = winH;
    const end = hasEndMarker;
    const pad = padding;
    
    if (w > 0 && h > 0) {
      fontSize = computeFontSize(text, w, h, pad, true, end);
    }
  });

  function next() {
    if (currentIndex < expandedSlides.length - 1) {
      currentIndex += 1;
    }
  }

  function prev() {
    if (currentIndex > 0) {
      currentIndex -= 1;
    }
  }

  function handleTap(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.exit-btn')) {
      return;
    }
    const x = e.clientX;
    const midPoint = winW / 2;
    if (x < midPoint) {
      prev();
    } else {
      next();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onclose();
    } else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
      next();
    } else if (e.key === 'ArrowLeft') {
      prev();
    }
  }

  // Wake lock requests to keep the phone screen active while presenting
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await (navigator.wakeLock as any).request('screen');
      }
    } catch (err) {
      console.warn('Wake Lock request failed:', err);
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().then(() => {
        wakeLock = null;
      });
    }
  }

  async function lockOrientation() {
    try {
      if (window.screen && window.screen.orientation && typeof (window.screen.orientation as any).lock === 'function') {
        await (window.screen.orientation as any).lock('portrait');
      }
    } catch (err) {
      console.warn('Orientation lock failed:', err);
    }
  }

  async function forceLandscapeOrientation() {
    try {
      if (window.screen && window.screen.orientation && typeof (window.screen.orientation as any).lock === 'function') {
        await (window.screen.orientation as any).lock('landscape');
      }
    } catch (err) {
      console.warn('Orientation lock landscape failed:', err);
    }
  }

  onMount(() => {
    requestWakeLock();
    void forceLandscapeOrientation();
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && !wakeLock) {
        await requestWakeLock();
      }
    };
    const handleFullscreenChange = () => {
      const doc = document as any;
      const isFullscreen = doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement;
      if (!isFullscreen) {
        onclose();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
      releaseWakeLock();
      void lockOrientation();
      const doc = document as any;
      if ((doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement) && doc.exitFullscreen) {
        doc.exitFullscreen().catch((err: any) => console.warn(err));
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      } else if (doc.mozCancelFullScreen) {
        doc.mozCancelFullScreen();
      } else if (doc.msExitFullscreen) {
        doc.msExitFullscreen();
      }
    };
  });
</script>

<svelte:window bind:innerWidth={winW} bind:innerHeight={winH} onkeydown={handleKeyDown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div 
  class="projector-overlay" 
  onclick={handleTap} 
  role="document"
>
  <button class="exit-btn" onclick={onclose}>Exit</button>
  <div class="slide-idx-indicator">{currentIndex + 1} / {expandedSlides.length}</div>
  
  <div class="slide-container" style="padding: {padding}px;">
    <div class="slide-text" style="font-size: {fontSize}px;">
      {#each displayTextLines as line}
        <div>{@html renderMarkdown(line) || '\u00A0'}</div>
      {/each}
    </div>
  </div>

  {#if hasEndMarker}
    <div 
      class="end-marker" 
      style="font-size: {Math.max(20, Math.floor(fontSize * 0.6))}px;"
    >
      ✦ ✦ ✦
    </div>
  {/if}
</div>

<style>
  .projector-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background-color: #000000;
    color: #ffffff;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
    overflow: hidden;
    font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", "SF Pro Display", "Ubuntu", system-ui, sans-serif;
  }

  .slide-container {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    box-sizing: border-box;
  }

  .slide-text {
    width: 100%;
    font-weight: 700;
    line-height: 1.45;
    word-break: break-word;
  }

  .exit-btn {
    position: absolute;
    top: calc(16px + env(safe-area-inset-top, 0));
    right: calc(16px + env(safe-area-inset-right, 0));
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.25);
    color: #ffffff;
    padding: 10px 20px;
    border-radius: 999px;
    font-size: 14px;
    font-weight: 600;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    transition: background-color 150ms ease, transform 100ms ease;
    z-index: 10000;
  }

  .exit-btn:hover {
    background: rgba(255, 255, 255, 0.25);
  }

  .exit-btn:active {
    transform: scale(0.95);
  }

  .slide-idx-indicator {
    position: absolute;
    top: calc(16px + env(safe-area-inset-top, 0));
    left: calc(16px + env(safe-area-inset-left, 0));
    color: rgba(255, 255, 255, 0.4);
    font-size: 14px;
    font-weight: 600;
    z-index: 10000;
  }

  .end-marker {
    position: absolute;
    bottom: calc(20px + env(safe-area-inset-bottom, 0));
    left: 0;
    right: 0;
    text-align: center;
    color: rgba(255, 255, 255, 0.6);
    font-weight: normal;
    pointer-events: none;
  }
</style>
