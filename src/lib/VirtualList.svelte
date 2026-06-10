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
  let measuredHeights = $state<Record<number, number>>({});

  const positions = $derived.by(() => {
    const offsets = new Array(items.length + 1);
    let top = 0;
    offsets[0] = 0;
    for (let i = 0; i < items.length; i++) {
      top += measuredHeights[i] ?? itemHeight;
      offsets[i + 1] = top;
    }
    return offsets;
  });
  const totalHeight = $derived(positions[items.length] ?? 0);
  const startIndex = $derived(Math.max(0, findStartIndex(positions, scrollTop) - overscan));
  const endIndex = $derived(findEndIndex(positions, scrollTop + viewportHeight, overscan));
  const visibleItems = $derived(items.slice(startIndex, endIndex));

  function findStartIndex(offsets: number[], value: number) {
    let lo = 0;
    let hi = Math.max(0, offsets.length - 2);
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (offsets[mid] <= value) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function findEndIndex(offsets: number[], value: number, extra: number) {
    let idx = findStartIndex(offsets, value) + extra + 1;
    return Math.min(items.length, Math.max(0, idx));
  }

  function updateViewport() {
    if (!viewport) return;
    scrollTop = viewport.scrollTop;
    viewportHeight = viewport.clientHeight || viewportHeight;
  }

  function measureRow(node: HTMLElement, index: number) {
    const update = () => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (height > 0 && measuredHeights[index] !== height) {
        measuredHeights = { ...measuredHeights, [index]: height };
      }
    };
    update();
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(node);
    return {
      update(nextIndex: number) {
        index = nextIndex;
        update();
      },
      destroy() {
        resizeObserver.disconnect();
      },
    };
  }

  $effect(() => {
    const el = viewport;
    if (!el) return;
    updateViewport();
    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  });

  $effect(() => {
    items.length;
    measuredHeights = {};
  });
</script>

<div
  bind:this={viewport}
  class={`virtual-list ${className}`}
  onscroll={updateViewport}
>
  <div class="virtual-spacer" style={`height: ${totalHeight}px;`}>
    <div class="virtual-window">
      {#each visibleItems as item, offset (startIndex + offset)}
        <div
          class="virtual-row"
          style={`transform: translateY(${positions[startIndex + offset]}px); padding-bottom: ${rowGap}px;`}
          use:measureRow={startIndex + offset}
        >
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
    left: 0;
    position: absolute;
    right: 0;
    top: 0;
  }
</style>
