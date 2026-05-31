<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import {
    loadCredentialsResilient,
    loadAllServers,
    removeServer,
    switchServer,
    getLastSyncTs,
    exportBackup,
    compareBackup,
    importBackup,
    type Credentials,
    type ServerEntry,
    type BackupData,
  } from '$lib/db';
  import { remote } from '$lib/ws';
  import { syncFull, hydrateFromCache } from '$lib/sync';
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
    debugMode,
    managerAccessCountdown,
  } from '$lib/stores';

  let creds = $state<Credentials | null>(null);
  let servers = $state<ServerEntry[]>([]);
  let lastSyncTs = $state(0);
  let checkingUpdate = $state(false);

  type NoticeTone = 'info' | 'success' | 'warning' | 'danger';
  type AppNotice = {
    kind?: 'notice' | 'update';
    tone?: NoticeTone;
    title: string;
    message: string;
    detail?: string;
    progress?: number;
    progressLabel?: string;
    locked?: boolean;
    closeLabel?: string;
  };
  type InstallProgressMessage =
    | { type: 'SW_INSTALL_PROGRESS'; done: number; total: number; asset?: string }
    | { type: 'SW_INSTALL_COMPLETE'; total: number }
    | { type: 'SW_INSTALL_ERROR'; message?: string };

  let appNotice = $state<AppNotice | null>(null);

  function showNotice(notice: AppNotice) {
    appNotice = {
      tone: 'info',
      kind: 'notice',
      closeLabel: 'OK',
      ...notice,
    };
  }

  function updateNotice(updates: Partial<AppNotice>) {
    if (!appNotice) return;
    appNotice = { ...appNotice, ...updates };
  }

  function closeNotice() {
    if (appNotice?.locked) return;
    appNotice = null;
  }

  async function grantManagerAccess() {
    try {
      await remote.sendRequest('device.grant_manager_access', {});
      managerAccessCountdown.set(300);
      showNotice({
        tone: 'success',
        title: 'Temporary Access Enabled',
        message: 'Phone Manager access is open for the next 5 minutes.',
        detail: 'The desktop settings menu will accept changes from this phone until the timer expires.',
        closeLabel: 'Done',
      });
    } catch (e: any) {
      showNotice({
        tone: 'danger',
        title: 'Access Failed',
        message: 'Phone Manager access could not be enabled.',
        detail: e?.message ?? String(e),
      });
    }
  }

  const formatCountdown = $derived.by(() => {
    const val = $managerAccessCountdown;
    if (val <= 0) return '';
    const m = Math.floor(val / 60);
    const s = val % 60;
    return `Access active: ${m}:${s.toString().padStart(2, '0')}`;
  });

  function handleServiceWorkerMessage(event: MessageEvent<InstallProgressMessage>) {
    const data = event.data;
    if (!data || typeof data !== 'object' || !('type' in data)) return;

    if (data.type === 'SW_INSTALL_PROGRESS') {
      const progress = data.total > 0 ? Math.round((data.done / data.total) * 100) : 35;
      const assetName = data.asset?.split('/').pop();
      showNotice({
        kind: 'update',
        tone: 'success',
        title: 'Installing Update',
        message: data.total > 0
          ? `Installing app files ${data.done} of ${data.total}.`
          : 'Preparing the new app version.',
        detail: assetName ? `Current file: ${assetName}` : 'Keeping the remote available while the update installs.',
        progress,
        progressLabel: `${progress}%`,
        locked: true,
      });
      return;
    }

    if (data.type === 'SW_INSTALL_COMPLETE') {
      showNotice({
        kind: 'update',
        tone: 'success',
        title: 'Update Installed',
        message: 'The new version is ready. Switching over now.',
        detail: `${data.total} app files updated.`,
        progress: 100,
        progressLabel: '100%',
        locked: true,
      });
      return;
    }

    if (data.type === 'SW_INSTALL_ERROR') {
      checkingUpdate = false;
      showNotice({
        kind: 'update',
        tone: 'danger',
        title: 'Update Failed',
        message: 'The update could not finish installing.',
        detail: data.message ?? 'Try again when the connection is stable.',
        locked: false,
      });
    }
  }

  onMount(async () => {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
    }

    const c = await loadCredentialsResilient();
    if (!c?.device_token) {
      goto(`${base}/`);
      return;
    }
    creds = c;
    servers = await loadAllServers();
    lastSyncTs = await getLastSyncTs();
    await remote.connect();
  });

  onDestroy(() => {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    }
  });

  async function unpair() {
    if (!confirm('Forget this server? You will need a new QR to reconnect.')) return;
    await remote.unpair();
    // Reload server list — clearCredentials may have switched to another
    servers = await loadAllServers();
    creds = await loadCredentialsResilient();
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
    creds = await loadCredentialsResilient();
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
    await hydrateFromCache();
    lastSyncTs = await getLastSyncTs();
    remote.disconnect();
    await remote.connect();
  }

  const lastSyncHuman = $derived.by(() => {
    if (!lastSyncTs) return 'never';
    const d = new Date(lastSyncTs * 1000);
    return d.toLocaleString();
  });

  let importDialog = $state<{ comparison: any; data: BackupData; resolve: (v: boolean) => void } | null>(null);

  async function doBackup() {
    try {
      const data = await exportBackup();
      const json = JSON.stringify(data);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const d = new Date().toISOString().slice(0, 10);
      a.download = `ChurchPresenter_PWA_backup_${d}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert('Backup failed: ' + (e?.message ?? e));
    }
  }

  async function doImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text) as BackupData;
        if (!data.version || !data.songs || !data.servers) {
          alert('Invalid backup file.');
          return;
        }
        const comparison = await compareBackup(data);
        const confirmed = await new Promise<boolean>((resolve) => {
          importDialog = { comparison, data, resolve };
        });
        importDialog = null;
        if (!confirmed) return;
        await importBackup(data);
        servers = await loadAllServers();
        creds = await loadCredentialsResilient();
        await hydrateFromCache();
        lastSyncTs = await getLastSyncTs();
        if (creds?.device_token) {
          remote.disconnect();
          await remote.connect();
        }
        alert('Import complete!');
      } catch (e: any) {
        alert('Import failed: ' + (e?.message ?? e));
      }
    };
    input.click();
  }

  async function checkForUpdates() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      showNotice({
        tone: 'warning',
        title: 'Updates Unavailable',
        message: 'This browser does not support service worker updates.',
      });
      return;
    }

    checkingUpdate = true;
    showNotice({
      kind: 'update',
      tone: 'info',
      title: 'Checking For Updates',
      message: 'Contacting GitHub Pages for the latest app version.',
      detail: 'This usually takes a moment.',
      progress: 8,
      progressLabel: 'Checking',
      locked: true,
    });

    function activateWorker(worker: ServiceWorker) {
      checkingUpdate = false;
      showNotice({
        kind: 'update',
        tone: 'success',
        title: 'Applying Update',
        message: 'The update is installed. Restarting the app into the new version.',
        detail: 'Your pairing and cached library stay on this phone.',
        progress: 100,
        progressLabel: 'Ready',
        locked: true,
      });
      worker.postMessage({ type: 'SKIP_WAITING' });
    }

    let trackedWorker: ServiceWorker | null = null;

    function handleWorkerState(worker: ServiceWorker) {
      if (worker.state === 'installing') {
        updateNotice({
          title: 'Installing Update',
          message: 'Downloading and caching the new app files.',
          progress: Math.max(appNotice?.progress ?? 0, 20),
          progressLabel: 'Installing',
        });
        return;
      }

      if (worker.state === 'installed') {
        if (navigator.serviceWorker.controller) {
          activateWorker(worker);
        } else {
          checkingUpdate = false;
          showNotice({
            kind: 'update',
            tone: 'success',
            title: 'App Ready Offline',
            message: 'The app shell has been installed for offline use.',
            progress: 100,
            progressLabel: 'Complete',
            locked: false,
            closeLabel: 'Done',
          });
        }
        return;
      }

      if (worker.state === 'activating') {
        updateNotice({
          title: 'Applying Update',
          message: 'Switching the app to the new version.',
          progress: 100,
          progressLabel: 'Ready',
        });
        return;
      }

      if (worker.state === 'activated') {
        checkingUpdate = false;
        updateNotice({
          title: 'Opening New Version',
          message: 'Reloading now.',
          progress: 100,
          progressLabel: 'Done',
        });
        return;
      }

      if (worker.state === 'redundant') {
        checkingUpdate = false;
        showNotice({
          kind: 'update',
          tone: 'danger',
          title: 'Update Stopped',
          message: 'The browser discarded the update before it finished.',
          detail: 'Try checking again.',
          locked: false,
        });
      }
    }

    function trackWorker(worker: ServiceWorker) {
      if (trackedWorker === worker) return;
      trackedWorker = worker;
      handleWorkerState(worker);
      worker.addEventListener('statechange', () => handleWorkerState(worker));
    }

    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        checkingUpdate = false;
        showNotice({
          kind: 'update',
          tone: 'warning',
          title: 'No App Installer',
          message: 'The app is running without a service worker.',
          detail: 'Open the installed PWA or the published GitHub Pages app to receive updates.',
          locked: false,
        });
        return;
      }

      let updateFound = false;
      const updateResult = new Promise<boolean>((resolve) => {
        const timeout = window.setTimeout(() => resolve(false), 1600);

        reg.onupdatefound = () => {
          window.clearTimeout(timeout);
          updateFound = true;
          const worker = reg.installing;
          if (worker) {
            trackWorker(worker);
          }
          resolve(true);
        };
      });

      if (reg.waiting) {
        activateWorker(reg.waiting);
        return;
      }

      await reg.update();

      if (reg.installing) {
        trackWorker(reg.installing);
        return;
      }

      if (reg.waiting) {
        activateWorker(reg.waiting);
        return;
      }

      const foundUpdate = updateFound || await updateResult;
      if (foundUpdate) {
        checkingUpdate = false;
        return;
      }

      checkingUpdate = false;
      showNotice({
        kind: 'update',
        tone: 'success',
        title: 'Already Up To Date',
        message: 'This phone is running the latest published version.',
        progress: 100,
        progressLabel: 'Current',
        locked: false,
        closeLabel: 'Done',
      });

    } catch (err: any) {
      checkingUpdate = false;
      showNotice({
        kind: 'update',
        tone: 'danger',
        title: 'Update Check Failed',
        message: 'The app could not check for a new version.',
        detail: err?.message ?? String(err),
        locked: false,
      });
    }
  }
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
          <div class="muted small mono" style="opacity:0.5;">id: {s.server_key.slice(0, 8)}</div>
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
  <h2>Phone Manager Access</h2>
  <p class="muted small" style="margin:0 0 10px;">
    Grant temporary access (5 minutes) to the desktop Phone Manager menu.
  </p>
  {#if $managerAccessCountdown > 0}
    <div class="access-active-banner">
      🟢 {formatCountdown}
    </div>
  {:else}
    <button
      class="accent fw"
      style="background: #fbbf24; border-color: #fbbf24; color: #000; font-weight: 600;"
      onclick={grantManagerAccess}
      disabled={$connStatus !== 'open'}
    >
      Enable temporary Phone Manager access
    </button>
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
  <div class="row" style="align-items: center; justify-content: space-between;">
    <span class="muted">Debug mode</span>
    <input type="checkbox" bind:checked={$debugMode} style="width: 18px; height: 18px; cursor: pointer; accent-color: var(--accent);" />
  </div>
  <button class="ghost fw" onclick={repair}>
    Re-pair (scan new QR)
  </button>
  <button class="ghost fw" onclick={unpair}>Forget this server</button>
</section>

<section class="panel" style="margin-top:12px;">
  <h2>Updates</h2>
  <p class="muted small" style="margin:0 0 10px;">
    Check if a newer version of the PWA is available on GitHub Pages.
  </p>
  <button class="ghost fw" onclick={checkForUpdates} disabled={checkingUpdate}>
    {checkingUpdate ? 'Checking for updates...' : 'Check for Updates'}
  </button>
</section>

<section class="panel" style="margin-top:12px;">
  <h2>Backup &amp; Import</h2>
  <p class="muted small" style="margin:0 0 10px;">
    Export all cached songs, lists, and server pairings as a file.
  </p>
  <button class="ghost fw" onclick={doBackup}>Export Backup</button>
  <button class="ghost fw" onclick={doImport}>Import Backup</button>
</section>

{#if importDialog}
  <div
    class="modal-back"
    role="button"
    tabindex="-1"
    aria-label="Cancel"
    onclick={() => { importDialog?.resolve(false); importDialog = null; }}
    onkeydown={(e) => { if (e.key === 'Escape') { importDialog?.resolve(false); importDialog = null; } }}
  >
    <div
      class="modal"
      role="alertdialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <h3 style="margin:0 0 12px; font-size:17px;">Import Backup</h3>

      <div class="compare-grid">
        <div class="compare-col">
          <div class="compare-head">Current</div>
          <div>Songs: {importDialog.comparison.current.songs}</div>
          <div>Lists: {importDialog.comparison.current.lists}</div>
          <div>Servers: {importDialog.comparison.current.servers}</div>
        </div>
        <div class="compare-col">
          <div class="compare-head">Backup</div>
          <div>Songs: {importDialog.comparison.backup.songs}</div>
          <div>Lists: {importDialog.comparison.backup.lists}</div>
          <div>Servers: {importDialog.comparison.backup.servers}</div>
          <div class="muted small">
            Exported: {new Date(importDialog.comparison.backup.exported_at).toLocaleString()}
          </div>
        </div>
      </div>

      {#if importDialog.comparison.backupIsOlder}
        <div class="warn">Warning: this backup is older than your current data.</div>
      {/if}
      {#if importDialog.comparison.backupHasLess}
        <div class="warn">Warning: this backup has fewer songs than you currently have.</div>
      {/if}

      <p class="muted small" style="margin:10px 0 0;">
        This will replace all current data. Continue?
      </p>
      <div class="modal-btns" style="margin-top:14px;">
        <button class="ghost" onclick={() => { importDialog?.resolve(false); importDialog = null; }}>Cancel</button>
        <button class="accent" onclick={() => { importDialog?.resolve(true); importDialog = null; }}>Import</button>
      </div>
    </div>
  </div>
{/if}

{#if appNotice}
  <div
    class="modal-back notice-back"
    role="button"
    tabindex="-1"
    aria-label="Close message"
    onclick={closeNotice}
    onkeydown={(e) => { if (e.key === 'Escape') closeNotice(); }}
  >
    <div
      class="modal notice-modal"
      class:notice-success={appNotice.tone === 'success'}
      class:notice-warning={appNotice.tone === 'warning'}
      class:notice-danger={appNotice.tone === 'danger'}
      role="alertdialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="notice-head">
        <div class="notice-mark" aria-hidden="true">
          {#if appNotice.tone === 'success'}
            ✓
          {:else if appNotice.tone === 'warning'}
            !
          {:else if appNotice.tone === 'danger'}
            ×
          {:else}
            i
          {/if}
        </div>
        <div class="notice-copy">
          <h3>{appNotice.title}</h3>
          <p>{appNotice.message}</p>
        </div>
      </div>

      {#if appNotice.detail}
        <div class="notice-detail">{appNotice.detail}</div>
      {/if}

      {#if typeof appNotice.progress === 'number'}
        <div class="progress-wrap">
          <div
            class="progress-bar"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={Math.round(appNotice.progress)}
          >
            <div class="progress-fill" style={`width: ${Math.min(100, Math.max(0, appNotice.progress))}%`}></div>
          </div>
          <div class="progress-label">{appNotice.progressLabel ?? `${Math.round(appNotice.progress)}%`}</div>
        </div>
      {/if}

      {#if !appNotice.locked}
        <div class="modal-btns notice-actions">
          <button class="accent" onclick={closeNotice}>{appNotice.closeLabel ?? 'OK'}</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

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
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform 100ms ease;
  }
  button.sm { padding: 6px 10px; font-size: 13px; margin-top: 0; width: auto; }
  button.danger {
    color: var(--danger);
    border-color: var(--danger);
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform 100ms ease;
  }
  button.danger:hover {
    background: rgba(239, 68, 68, 0.1);
    color: var(--danger);
    border-color: var(--danger);
  }
  button.danger:active {
    transform: scale(0.96);
  }
  button.ghost:hover, .btn-link:hover {
    color: var(--text-primary);
    border-color: var(--accent);
    background: var(--panel);
  }
  button.ghost:active, .btn-link:active {
    transform: scale(0.98);
  }
 
  .modal-back {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 100;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px 14px 0 0;
    width: 100%;
    max-width: 720px;
    padding: 20px 16px 24px;
  }
  .modal-btns { display: flex; gap: 10px; }
  .modal-btns button { flex: 1; padding: 13px; font-size: 15px; }
  button.accent {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: #fff;
    border-radius: 8px;
  }

  .compare-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    font-size: 14px;
    margin: 8px 0;
  }
  .compare-col { background: var(--elevated); border-radius: 8px; padding: 10px; }
  .compare-head { font-weight: 700; margin-bottom: 4px; font-size: 13px; color: var(--text-secondary); }
  .warn {
    color: var(--danger, #ff6b6b);
    font-size: 13px;
    font-weight: 600;
    margin-top: 8px;
  }
  .access-active-banner {
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid #22c55e;
    color: #22c55e;
    border-radius: 8px;
    padding: 10px;
    font-weight: 600;
    text-align: center;
    font-size: 14px;
    margin-top: 8px;
  }

  .notice-back {
    z-index: 120;
  }

  .notice-modal {
    border-color: var(--border-light);
    box-shadow: 0 -20px 60px rgba(0, 0, 0, 0.45);
  }

  .notice-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .notice-mark {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    color: var(--accent);
    font-size: 18px;
    font-weight: 800;
    line-height: 1;
  }

  .notice-success .notice-mark {
    background: rgba(34, 197, 94, 0.12);
    border-color: rgba(34, 197, 94, 0.45);
    color: var(--success);
  }

  .notice-warning .notice-mark {
    background: rgba(245, 158, 11, 0.12);
    border-color: rgba(245, 158, 11, 0.45);
    color: var(--warning);
  }

  .notice-danger .notice-mark {
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.45);
    color: var(--danger);
  }

  .notice-copy {
    min-width: 0;
  }

  .notice-copy h3 {
    margin: 0;
    font-size: 18px;
    line-height: 1.2;
  }

  .notice-copy p {
    margin: 5px 0 0;
    color: var(--text-secondary);
    font-size: 14px;
    line-height: 1.4;
  }

  .notice-detail {
    margin-top: 14px;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--elevated);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .progress-wrap {
    margin-top: 16px;
  }

  .progress-bar {
    height: 9px;
    border-radius: 999px;
    overflow: hidden;
    background: var(--elevated);
    border: 1px solid var(--border-light);
  }

  .progress-fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--accent), var(--accent-hover));
    transition: width 180ms ease;
  }

  .notice-success .progress-fill {
    background: linear-gradient(90deg, #16a34a, var(--success));
  }

  .progress-label {
    margin-top: 7px;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 700;
    text-align: right;
  }

  .notice-actions {
    margin-top: 16px;
  }
</style>
