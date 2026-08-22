<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';

  // Virtualized list tuned for mid-range phones.
  //
  // Perf rules this follows (each one fixes a measured jank source):
  // - Scroll updates are rAF-batched: at most one state write + one re-render
  //   per animation frame, no matter how many scroll events fire.
  // - Row heights live in a plain mutable Map behind a single version counter,
  //   so a measurement costs O(1) instead of copying the whole height record.
  // - The version counter itself is bumped at most once per frame by a shared
  //   scheduler, so a batch of row measurements triggers ONE offsets rebuild.
  // - Measurements are keyed to the items array IDENTITY, not its length:
  //   swapping in search results with the same length can't reuse stale
  //   heights (which caused scroll jumps), and reusing the same array across
  //   unrelated parent re-renders doesn't wipe them.
  // - The offsets prefix-sum rebuild is O(n) but only runs once per version
  //   bump; at 3500 rows that is microseconds and simpler than incremental
  //   patching.

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
  let heightsVersion = $state(0);

  const measuredHeights = new Map<number, number>();
  let lastItemsRef: T[] | null = null;

  // Shared per-frame scheduler for measurement-driven invalidation. Multiple
  // ResizeObserver callbacks in the same frame collapse into one version bump
  // and therefore one offsets rebuild + one list re-render.
  let versionFrame: number | null = null;
  function scheduleHeightsInvalidate() {
    if (versionFrame !== null) return;
    versionFrame = requestAnimationFrame(() => {
      versionFrame = null;
      heightsVersion += 1;
    });
  }

  function resetMeasurements() {
    measuredHeights.clear();
    heightsVersion += 1;
  }

  const positions = $derived.by(() => {
    void heightsVersion; // rebuild whenever measurements changed
    // Positions exclude rowGap on purpose: the visual gap comes from each
    // row's own padding-bottom, which ResizeObserver's contentRect already
    // excludes. This mirrors the original list's geometry exactly.
    const offsets = new Array<number>(items.length + 1);
    let top = 0;
    for (let i = 0; i < items.length; i++) {
      offsets[i] = top;
      top += measuredHeights.get(i) ?? itemHeight;
    }
    offsets[items.length] = top;
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
    let idx = findStartIndex(positions, value) + extra + 1;
    return Math.min(items.length, Math.max(0, idx));
  }

  // rAF-batched scroll handling: record the newest scroll position, render at
  // most once per frame. Without this, every scroll event synchronously drove
  // a derived-chain recomputation and keyed each-diff.
  let scrollFrame: number | null = null;
  function handleScroll() {
    const el = viewport;
    if (!el || scrollFrame !== null) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      if (!viewport) return;
      scrollTop = viewport.scrollTop;
      viewportHeight = viewport.clientHeight || viewportHeight;
    });
  }

  function measureRow(node: HTMLElement, index: number) {
    // ResizeObserver fires once right after observe(), so no manual first
    // measurement is needed. contentRect avoids the forced layout that a
    // getBoundingClientRect call would trigger mid-scroll.
    const observer = new ResizeObserver((entries) => {
      const height = Math.ceil(entries[0]?.contentRect.height ?? 0);
      if (height > 0 && measuredHeights.get(index) !== height) {
        measuredHeights.set(index, height);
        scheduleHeightsInvalidate();
      }
    });
    observer.observe(node);
    return {
      update(nextIndex: number) {
        index = nextIndex;
      },
      destroy() {
        observer.disconnect();
      },
    };
  }

  $effect(() => {
    const el = viewport;
    if (!el) return;
    scrollTop = el.scrollTop;
    viewportHeight = el.clientHeight || viewportHeight;
    const resizeObserver = new ResizeObserver(handleScroll);
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  });

  // New items identity -> fresh measurements. Keyed by reference so a parent
  // re-render passing the SAME array never wipes heights (the old code reset
  // on length changes only, which both missed identity swaps of equal length
  // and needlessly cleared on filtered sets of coincidentally equal length).
  $effect(() => {
    if (lastItemsRef !== items) {
      lastItemsRef = items;
      resetMeasurements();
    }
  });

  $effect(() => {
    return () => {
      if (versionFrame !== null) cancelAnimationFrame(versionFrame);
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    };
  });
</script>

<div
  bind:this={viewport}
  class={`virtual-list ${className}`}
  onscroll={handleScroll}
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
    width: 100%;
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
    width: 100%;
  }
</style>
