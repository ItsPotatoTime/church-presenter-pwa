<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    name,
    songKey = null,
    meta,
    clamp = false,
  }: {
    name: string;
    songKey?: string | null;
    /** Optional secondary line(s) rendered under the title. */
    meta?: Snippet;
    /** Cap the title at two lines (fixed-height virtualized rows). */
    clamp?: boolean;
  } = $props();
</script>

<!-- Shared song-row content: text column on the left (title + meta lines),
     key badge on the right. The badge is a sibling of the WHOLE text block so
     it centers vertically on multi-line rows like the surrounding grip/action
     buttons do. Used by the queue, library and lists pages. -->
<div class="cols">
  <div class="text">
    <div class="name" class:clamp>{name}</div>
    {@render meta?.()}
  </div>
  {#if songKey}
    <span class="key-badge">{songKey}</span>
  {/if}
</div>

<style>
  .cols {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
  }
  .text {
    /* Long titles wrap instead of pushing the badge around. */
    min-width: 0;
  }
  .name {
    font-weight: 600;
  }
  .name.clamp {
    line-height: 1.25;
    overflow: hidden;
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
</style>
