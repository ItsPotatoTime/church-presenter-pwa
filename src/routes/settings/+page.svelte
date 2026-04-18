<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import {
    loadCredentials,
    loadAllServers,
    removeServer,
    switchServer,
    getLastSyncTs,
    type Credentials,
    type ServerEntry,
  } from '$lib/db';
  import { remote } from '$lib/ws';
  import { syncFull } from '$lib/sync';
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
  let servers = $state<ServerEntry[]>([]);
  let lastSyncTs = $state(0);

  onMount(async () => {
    const c = await loadCredentials();
    if (!c?.device_token) {
      goto(`${base}/`);
      return;
    }
    creds = c;
    servers = await loadAllServers();
    lastSyncTs = await getLastSyncTs();
    await remote.connect();
  });

  async function unpair() {
    if (!confirm('Forget this server? You will need a new QR to reconnect.')) return;
    await remote.unpair();
    // Reload server list — clearCredentials may have switched to another
    servers = await loadAllServers();
    creds = await loadCredentials();
    if (!creds?.device_token) goto(`${base}/`);
  }

  async function repair() {
    await remote.unpair();
    goto(`${base}/`);
  }

  async function resync() {
    await syncFull();
    lastSyncTs = await getLastSyncTs();
  }

  async function doRemoveServer(key: string) {
    if (!confirm('Remove this server pairing?')) return;
    await removeServer(key);
    servers = await loadAllServers();
    creds = await loadCredentials();
    if (!creds?.device_token) {
      goto(`${base}/`);
      return;
    }
    // Reconnect if we switched to a different server
    remote.disconnect();
    await remote.connect();
  }

  async function doSwitchServer(key: string) {
    const newCreds = await switchServer(key);
    if (!newCreds) return;
    creds = newCreds;
    servers = await loadAllServers();
    remote.disconnect();
    await remote.connect();
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
  <h2>Active server</h2>
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

{#if servers.length > 0}
  <section class="panel" style="margin-top:12px;">
    <h2>Paired servers</h2>
    {#each servers as s (s.server_key)}
      <div class="server-row" class:active={s.server_key === creds?.server_key}>
        <div class="server-info">
          <div class="server-name">{s.server_name ?? '(unknown)'}</div>
          <div class="muted small">{s.cloud_host ?? s.lan_host ?? '—'}</div>
        </div>
        <div class="server-actions">
          {#if s.server_key === creds?.server_key}
            <span class="badge">active</span>
          {:else}
            <button class="ghost sm" onclick={() => doSwitchServer(s.server_key)}>Switch</button>
          {/if}
          <button class="ghost sm danger" onclick={() => doRemoveServer(s.server_key)}>✕</button>
        </div>
      </div>
    {/each}
    <a href="{base}/pair/" class="ghost fw btn-link" style="margin-top:10px;">
      ＋ Pair another server
    </a>
  </section>
{/if}

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

  .server-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .server-row:last-of-type { border-bottom: none; }
  .server-row.active .server-name { color: var(--accent); }
  .server-info { flex: 1; min-width: 0; }
  .server-name { font-weight: 600; font-size: 14px; }
  .server-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
  .badge {
    font-size: 11px;
    color: var(--accent);
    background: transparent;
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 2px 6px;
  }

  button.fw, .btn-link { width: 100%; padding: 12px; margin-top: 12px; display: block; text-align: center; }
  button.ghost, .btn-link {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 14px;
  }
  button.sm { padding: 6px 10px; font-size: 13px; margin-top: 0; width: auto; }
  button.danger { color: var(--danger); border-color: var(--danger); }
  button.ghost:hover { color: var(--text-primary); }
</style>
