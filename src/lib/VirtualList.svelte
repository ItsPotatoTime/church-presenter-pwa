<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';

  let {
    items,
    itemHeight = 78,
    overscan = 8,
    rowGap = 6,
    class: className = '',
    children,
  } = $props<{
    items: T[];
    itemHeight?: number;
    overscan?: number;
    rowGap?: number;
    class?: string;
    children: Snippet<[T, number]>;
  }>();

  let viewport = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let viewportHeight = $state(480);

  const totalHeight = $derived(items.length * itemHeight);
  const startIndex = $derived(Math.max(0, Math.floor(scrollTop / itemHeight) - overscan));
  const visibleCount = $derived(Math.ceil(viewportHeight / itemHeight) + overscan * 2);
  const endIndex = $derived(Math.min(items.length, startIndex + visibleCount));
  const visibleItems = $derived(items.slice(startIndex, endIndex));
  const topOffset = $derived(startIndex * itemHeight);

  function updateViewport() {
    if (!viewport) return;
    scrollTop = viewport.scrollTop;
    viewportHeight = viewport.clientHeight || viewportHeight;
  }

  $effect(() => {
    const el = viewport;
    if (!el) return;
    updateViewport();
    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  });
</script>

<div
  bind:this={viewport}
  class={`virtual-list ${className}`}
  onscroll={updateViewport}
>
  <div class="virtual-spacer" style={`height: ${totalHeight}px;`}>
    <div class="virtual-window" style={`transform: translateY(${topOffset}px);`}>
      {#each visibleItems as item, offset (startIndex + offset)}
        <div class="virtual-row" style={`height: ${itemHeight}px; padding-bottom: ${rowGap}px;`}>
          {@render children(item, startIndex + offset)}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .virtual-list {
    height: calc(100vh - 220px);
    min-height: 320px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .virtual-spacer {
    position: relative;
  }

  .virtual-window {
    left: 0;
    position: absolute;
    right: 0;
    top: 0;
  }

  .virtual-row {
    box-sizing: border-box;
    overflow: hidden;
  }

  .virtual-row :global(> *) {
    height: 100%;
  }
</style>
