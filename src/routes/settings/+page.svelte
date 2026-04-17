<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import {
    loadCredentials,
    getLastSyncTs,
    type Credentials,
  } from '$lib/db';
  import { remote } from '$lib/ws';
  import { syncNow } from '$lib/sync';
  import {
    connStatus,
    connEndpoint,
    connError,
    exclusiveDeviceId,
    exclusiveDeviceName,
    isViewOnly,
    myDeviceId,
    syncStatus,
    songsStore,
  } from '$lib/stores';

  let creds = $state<Credentials | null>(null);
  let lastSyncTs = $state(0);

  onMount(async () => {
    const c = await loadCredentials();
    if (!c?.device_token) {
      goto(`${base}/`);
      return;
    }
    creds = c;
    lastSyncTs = await getLastSyncTs();
    await remote.connect();
  });

  async function unpair() {
    if (!confirm('Unpair this phone? You will need a new QR to reconnect.')) return;
    await remote.unpair();
    goto(`${base}/`);
  }

  async function repair() {
    // Drop the current token but keep device_id, cloud_host, lan_host so the
    // next QR can simply refresh the session without the user retyping anything.
    await remote.unpair();
    goto(`${base}/`);
  }

  async function resync() {
    await syncNow();
    lastSyncTs = await getLastSyncTs();
  }

  const lastSyncHuman = $derived.by(() => {
    if (!lastSyncTs) return 'never';
    const d = new Date(lastSyncTs * 1000);
    return d.toLocaleString();
  });
</script>

<header>
  <h1>Settings</h1>
</header>

<section class="panel">
  <h2>Server</h2>
  <div class="row">
    <span class="muted">Name</span>
    <span>{creds?.server_name ?? '—'}</span>
  </div>
  <div class="row">
    <span class="muted">Status</span>
    <span>{$connStatus}{$connEndpoint ? ` (${$connEndpoint})` : ''}</span>
  </div>
  {#if $connError && $connStatus !== 'open'}
    <div class="row err"><span class="muted">Error</span><span>{$connError}</span></div>
  {/if}
  <div class="row">
    <span class="muted">Cloud</span>
    <span class="mono">{creds?.cloud_host ?? '—'}</span>
  </div>
  <div class="row">
    <span class="muted">LAN</span>
    <span class="mono">{creds?.lan_host ?? '—'}</span>
  </div>
</section>

<section class="panel" style="margin-top:12px;">
  <h2>Library</h2>
  <div class="row">
    <span class="muted">Cached songs</span>
    <span>{$songsStore.length}</span>
  </div>
  <div class="row">
    <span class="muted">Last sync</span>
    <span>{lastSyncHuman}</span>
  </div>
  <button
    class="accent fw"
    onclick={resync}
    disabled={$syncStatus === 'syncing' || $connStatus !== 'open'}
  >
    {$syncStatus === 'syncing' ? 'Syncing…' : 'Sync now'}
  </button>
</section>

<section class="panel" style="margin-top:12px;">
  <h2>Control mode</h2>
  <div class="row">
    <span class="muted">Exclusive</span>
    <span>
      {#if $exclusiveDeviceId === null}
        Off — all phones can control
      {:else if $exclusiveDeviceId === $myDeviceId}
        This phone has exclusive control
      {:else}
        Held by {$exclusiveDeviceName ?? 'another phone'}
      {/if}
    </span>
  </div>
  <p class="muted small">
    Exclusive mode is toggled from the desktop's Phones dialog
    (📱 Phone Remote → Manage phones…).
  </p>
  {#if $isViewOnly}
    <p class="muted small">
      Your commands are currently blocked. You can still browse the library,
      queue, and receive live updates.
    </p>
  {/if}
</section>

<section class="panel" style="margin-top:12px;">
  <h2>Device</h2>
  <div class="row">
    <span class="muted">Name</span>
    <span>{creds?.device_name ?? '—'}</span>
  </div>
  <div class="row">
    <span class="muted">Device ID</span>
    <span class="mono">{$myDeviceId ?? '—'}</span>
  </div>
  <button class="ghost fw" onclick={repair}>
    Re-pair (scan new QR)
  </button>
  <button class="ghost fw" onclick={unpair}>Forget this server</button>
</section>

<style>
  header { padding: 4px 0 12px; }
  h1 { margin: 0; font-size: 22px; font-weight: 700; }
  h2 { margin: 0 0 10px; font-size: 15px; font-weight: 600; color: var(--text-primary); }

  .row {
    display: flex; justify-content: space-between; gap: 10px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }
  .row:last-of-type { border-bottom: none; }
  .row.err { color: var(--danger); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .small { font-size: 12px; }
  p.muted { margin: 6px 0 0; }

  button.fw { width: 100%; padding: 12px; margin-top: 12px; }
  button.ghost {
    background: transparent;
    border-color: var(--border);
    color: var(--text-secondary);
  }
</style>
