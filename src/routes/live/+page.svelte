<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { loadCredentials } from '$lib/db';
  import { remote } from '$lib/ws';
  import { renderMarkdown } from '$lib/search';
  import {
    connStatus, connEndpoint, connError, liveState,
    isViewOnly, liveFollowEnabled,
  } from '$lib/stores';

  let textVisible = $state(true);
  let fontBoost = $state(1.0); // local preview zoom only

  onMount(async () => {
    const creds = await loadCredentials();
    if (!creds || !creds.device_token) {
      goto(`${base}/`);
      return;
    }
    await remote.connect();
  });

  // Re-send live.follow whenever connection opens or toggle changes.
  // No dedup guard: server resets the flag on disconnect so we must resend on every open.
  $effect(() => {
    if ($connStatus !== 'open') return;
    remote.send({ type: 'live.follow', payload: { enabled: $liveFollowEnabled } });
  });

  function toggleFollow() {
    liveFollowEnabled.update((v) => !v);
  }

  // What "Follow" does: when ON, this phone auto-updates to show the live slide.
  // When OFF, the phone display freezes so the operator can read without it jumping.

  onDestroy(() => {
    // Don't disconnect on page nav — user is still using the app.
  });

  function next()  { remote.send({ type: 'live.next' }); }
  function prev()  { remote.send({ type: 'live.prev' }); }
  function blank() { remote.send({ type: 'live.blank' }); }

  function togglePresenting() {
    remote.send({ type: 'live.toggle_present' });
  }

  function adjustFont(delta: number) {
    fontBoost = Math.max(0.6, Math.min(2.4, fontBoost + delta));
    remote.send({ type: 'live.font_size', payload: { delta: delta > 0 ? 1 : -1 } });
  }

  const statusLabel = $derived(
    ({
      idle: 'Idle',
      connecting: 'Connecting…',
      authenticating: 'Authenticating…',
      open: 'Live',
      error: 'Error',
      closed: 'Reconnecting…',
    } as const)[$connStatus]
  );

  const statusClass = $derived(
    ({
      idle: '',
      connecting: 'warn',
      authenticating: 'warn',
      open: 'ok',
      error: 'err',
      closed: 'warn',
    } as const)[$connStatus]
  );

  const currentSlideText = $derived.by(() => {
    const s = $liveState;
    if (!s || !s.slides || s.slide_index < 0) return '';
    return s.slides[s.slide_index] ?? '';
  });

  const presenting = $derived($liveState?.presenting ?? false);
</script>

<header>
  <div class="hrow">
    <div>
      <div class="song">{$liveState?.song_name ?? '— no song —'}</div>
      <div class="muted idx">
        {#if $liveState && $liveState.slide_index >= 0}
          Slide {$liveState.slide_index + 1} / {$liveState.slides.length}
        {/if}
      </div>
    </div>
    <div class="pills">
      <button
        class="pill follow-btn"
        class:off={!$liveFollowEnabled}
        onclick={toggleFollow}
        aria-pressed={$liveFollowEnabled}
        title={$liveFollowEnabled
          ? 'Following live — phone updates when slide changes (tap to freeze)'
          : 'Frozen — phone stays on current slide (tap to follow again)'}
      >
        {$liveFollowEnabled ? '👁 Follow' : '🚫 Frozen'}
      </button>
      <span class="pill {statusClass}">{statusLabel}</span>
      {#if $connEndpoint}<span class="pill">{$connEndpoint}</span>{/if}
    </div>
  </div>
  {#if $connError && $connStatus !== 'open'}
    <div class="muted err">{$connError}</div>
  {/if}
</header>

<section class="slide-box" class:blanked={$liveState?.blanked}>
  {#if $liveState?.blanked}
    <div class="blank-label">● BLACKED OUT</div>
  {:else if textVisible && currentSlideText}
    <div class="slide-text" style="font-size: {Math.round(18 * fontBoost)}px">
      {#each currentSlideText.split('\n') as line}
        <div>{@html renderMarkdown(line) || '\u00A0'}</div>
      {/each}
    </div>
    {#if $liveState?.bible_ref_display}
      <div class="bible-ref">{$liveState.bible_ref_display}</div>
    {/if}
  {:else if !textVisible}
    <div class="muted">Text hidden on this phone</div>
  {:else}
    <div class="muted">Waiting for slide…</div>
  {/if}
</section>

<section class="controls">
  <button class="big" onclick={prev} aria-label="Previous" disabled={$isViewOnly}>◀ Prev</button>
  <button class="big accent" onclick={next} aria-label="Next" disabled={$isViewOnly}>Next ▶</button>
</section>

<section class="row">
  <button onclick={blank} disabled={$isViewOnly}>⬛ Blank</button>
  <button
    onclick={togglePresenting}
    disabled={$isViewOnly}
    class:present-on={presenting}
    class:present-off={!presenting}
  >
    {presenting ? '⏹ Stop Show' : '▶ Start Show'}
  </button>
</section>

<section class="row">
  <button onclick={() => (textVisible = !textVisible)}>
    {textVisible ? 'Hide text' : 'Show text'}
  </button>
</section>

<section class="row font-row">
  <button onclick={() => adjustFont(-0.15)} disabled={$isViewOnly}>A−</button>
  <span class="muted" style="align-self:center; min-width:50px; text-align:center;">
    {Math.round(fontBoost * 100)}%
  </span>
  <button onclick={() => adjustFont(+0.15)} disabled={$isViewOnly}>A+</button>
</section>

<style>
  header { padding: 4px 0 10px; }
  .hrow {
    display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;
  }
  .song { font-size: 16px; font-weight: 600; }
  .idx { font-size: 12px; margin-top: 2px; }
  .pills { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .err { color: var(--danger); font-size: 12px; margin-top: 4px; }

  .slide-box {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px;
    margin-top: 12px;
    min-height: 40vh;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    transition: background 120ms;
    position: relative;
  }
  .slide-box.blanked {
    background: #000;
    border-color: var(--accent);
  }
  .blank-label { color: var(--accent); font-weight: 700; letter-spacing: 2px; }
  .bible-ref {
    position: absolute; bottom: 12px; right: 16px;
    font-size: 12px; color: var(--text-secondary); opacity: 0.8;
    font-style: italic;
  }
  .slide-text {
    line-height: 1.5;
    font-weight: 500;
    color: var(--text-primary);
    max-width: 100%;
    word-break: break-word;
  }

  .controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 14px;
  }
  .big {
    padding: 26px 10px;
    font-size: 20px;
    font-weight: 700;
  }

  .row {
    display: flex;
    gap: 10px;
    margin-top: 10px;
  }
  .row > button { flex: 1; }

  .font-row > button { flex: 1; }

  button.present-on {
    background: var(--danger, #c0392b);
    color: #fff;
    border-color: var(--danger, #c0392b);
    font-weight: 700;
  }
  button.present-off {
    background: var(--success, #27ae60);
    color: #fff;
    border-color: var(--success, #27ae60);
    font-weight: 700;
  }

  .pill {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 99px;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }
  .pill.ok   { color: var(--success); border-color: var(--success); }
  .pill.warn { color: var(--warning); border-color: var(--warning); }
  .pill.err  { color: var(--danger);  border-color: var(--danger); }
  button.pill.follow-btn {
    cursor: pointer;
    background: transparent;
    color: var(--accent);
    border-color: var(--accent);
  }
  button.pill.follow-btn.off {
    color: var(--text-secondary);
    border-color: var(--border);
  }
</style>
