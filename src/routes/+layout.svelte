<script lang="ts">
  import '../app.css';
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { base } from '$app/paths';
  import { dev } from '$app/environment';
  import { beforeNavigate, goto } from '$app/navigation';
  import { getOrCreateDeviceId, loadCredentialsResilient } from '$lib/db';
  import { hydrateFromCache, isReducedDataConnection, syncNow } from '$lib/sync';
  import { myDeviceId, isViewOnly, connStatus, activeModals, libraryScrollY, listsScrollY, canEditKeys, canEditDisplays, debugMode, managerAccessCountdown, refreshManagerAccessCountdown } from '$lib/stores';

  let { children } = $props();
  let paired = $state(false);
  let ready = $state(false);
  let hasHydrated = $state(false);
  let hasTriggeredSync = $state(false);
  let showUpdateBanner = $state(false);
  let updateReloadTimer: number | null = null;
  let reloadingForUpdate = false;
  let recoveringFromChunkError = false;
  const UPDATE_RELOAD_GUARD_KEY = 'church_remote_update_reload_at';

  // Global debugger console logging overlay
  let consoleLogs = $state<{ type: 'log' | 'warn' | 'error', text: string, time: string }[]>([]);
  let showDebugDrawer = $state(false);

  function addLog(type: 'log' | 'warn' | 'error', ...args: any[]) {
    const text = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
    
    const time = new Date().toLocaleTimeString();
    consoleLogs = [...consoleLogs, { type, text, time }];
    if (consoleLogs.length > 200) {
      consoleLogs = consoleLogs.slice(-200);
    }
  }

  function setupConsoleInterceptor() {
    if (typeof window === 'undefined') return;

    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args) => {
      originalLog.apply(console, args);
      addLog('log', ...args);
    };
    console.warn = (...args) => {
      originalWarn.apply(console, args);
      addLog('warn', ...args);
    };
    console.error = (...args) => {
      originalError.apply(console, args);
      addLog('error', ...args);
    };

    window.addEventListener('error', (e) => {
      addLog('error', 'Unhandled error:', e.message, `at ${e.filename}:${e.lineno}:${e.colno}`, e.error?.stack || '');
    });

    window.addEventListener('unhandledrejection', (e) => {
      addLog('error', 'Unhandled Promise rejection:', e.reason?.message || e.reason, e.reason?.stack || '');
    });
  }

  if (typeof window !== 'undefined') {
    setupConsoleInterceptor();
  }

  // Foolproof dynamic chunk error handlers
  async function recoverFromChunkError() {
    if (recoveringFromChunkError) return;
    recoveringFromChunkError = true;
    showUpdateBanner = true;

    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith('cache-')).map((key) => caches.delete(key)));
      }
    } catch (err) {
      console.warn('[layout] Stale app-shell recovery failed:', err);
    } finally {
      const url = new URL(window.location.href);
      url.searchParams.set('_recover', String(Date.now()));
      window.location.replace(url.toString());
    }
  }

  function handleChunkError(e: ErrorEvent) {
    if (e.message && (e.message.includes('Failed to fetch dynamically imported module') || e.message.includes('Importing a module script failed'))) {
      console.warn('[layout] Chunk loading failed. Recovering stale app shell...');
      void recoverFromChunkError();
    }
  }

  function handleUnhandledRejection(e: PromiseRejectionEvent) {
    const message = e.reason?.message || '';
    if (message.includes('Failed to fetch dynamically imported module') || message.includes('Importing a module script failed')) {
      console.warn('[layout] Chunk loading rejection. Recovering stale app shell...');
      void recoverFromChunkError();
    }
  }

  // Active check for updates when phone remote wakes up
  async function handleVisibilityChange() {
    if (document.visibilityState === 'visible' && 'serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.update();
        }
      } catch (err) {
        console.warn('[layout] ServiceWorker update check failed:', err);
      }
    }
  }

  function reloadForUpdate(delayMs = 120) {
    if (reloadingForUpdate) return;
    const lastReload = Number(sessionStorage.getItem(UPDATE_RELOAD_GUARD_KEY) ?? '0');
    if (Number.isFinite(lastReload) && Date.now() - lastReload < 30_000) {
      showUpdateBanner = false;
      return;
    }
    reloadingForUpdate = true;
    showUpdateBanner = true;
    updateReloadTimer = window.setTimeout(() => {
      sessionStorage.setItem(UPDATE_RELOAD_GUARD_KEY, String(Date.now()));
      window.location.reload();
    }, delayMs);
  }

  function requestSkipWaiting(worker: ServiceWorker | null | undefined) {
    worker?.postMessage({ type: 'SKIP_WAITING' });
  }

  function trackServiceWorker(worker: ServiceWorker | null | undefined) {
    if (!worker) return;
    const handleState = () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        showUpdateBanner = true;
        requestSkipWaiting(worker);
      }
      if (worker.state === 'activated' && navigator.serviceWorker.controller) {
        reloadForUpdate();
      }
    };
    handleState();
    worker.addEventListener('statechange', handleState);
  }

  function handleServiceWorkerMessage(event: MessageEvent) {
    const type = event.data?.type;
    if (type === 'SW_INSTALL_PROGRESS' && navigator.serviceWorker.controller) {
      showUpdateBanner = true;
      return;
    }
    if (type === 'SW_INSTALL_COMPLETE' && navigator.serviceWorker.controller) {
      showUpdateBanner = true;
    }
  }

  onMount(async () => {
    // Register global error interceptors for chunk load failures
    window.addEventListener('error', handleChunkError, true);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Register PWA service worker (only in production)
    if ('serviceWorker' in navigator && !dev) {
      try {
        const registration = await navigator.serviceWorker.register(`${base}/service-worker.js`, {
          scope: `${base}/`,
          updateViaCache: 'none',
        });
        console.log('[layout] ServiceWorker registered with scope:', registration.scope);
        trackServiceWorker(registration.installing);
        requestSkipWaiting(registration.waiting);
        registration.addEventListener('updatefound', () => {
          trackServiceWorker(registration.installing);
        });
      } catch (err) {
        console.error('[layout] ServiceWorker registration failed:', err);
      }

      navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

      // Handle controller change (automatic reload when new SW activates)
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        reloadForUpdate(80);
      });
    }

    try {
      myDeviceId.set(await getOrCreateDeviceId());
    } catch (err) {
      console.error('[layout] Failed to get/create device ID:', err);
    }

    const creds = await loadCredentialsResilient();
    paired = !!creds && !!creds.device_token;
    if (creds) {
      canEditKeys.set(!!creds.can_edit_keys);
      canEditDisplays.set(!!creds.can_edit_displays);
    }
    if (paired) {
      // Load library cache so Library/Queue show something even offline.
      try {
        await hydrateFromCache();
        hasHydrated = true;
      } catch (err) {
        console.error('[layout] hydrateFromCache failed:', err);
      }
    }
    ready = true;
  });

  let countdownInterval: any = null;
  $effect(() => {
    refreshManagerAccessCountdown();
    const val = $managerAccessCountdown;
    if (val > 0) {
      if (!countdownInterval) {
        countdownInterval = setInterval(() => {
          const remaining = refreshManagerAccessCountdown();
          if (remaining <= 0) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
        }, 1000);
      }
    } else {
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
    }
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('error', handleChunkError, true);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
      }
    }
    if (updateReloadTimer !== null) {
      clearTimeout(updateReloadTimer);
    }
    if (countdownInterval) {
      clearInterval(countdownInterval);
    }
  });

  // After first QR pairing, connStatus becomes 'open' before layout re-mounts.
  // Update paired reactively so the tab bar appears without a page refresh.
  $effect(() => {
    if ($connStatus === 'open') {
      if (!paired) {
        paired = true;
        if (!hasHydrated) {
          hasHydrated = true;
          void hydrateFromCache();
        }
      }
      // Prefer a delta sync on reconnect; first sync falls back to a full sync
      // because this server's last_sync_ts starts at 0.
      if (!hasTriggeredSync && !isReducedDataConnection()) {
        hasTriggeredSync = true;
        void syncNow();
      }
    } else {
      hasTriggeredSync = false;
    }
  });

  // Hide the tab bar during first-run screens (/, /pair) to keep focus on setup.
  const showTabs = $derived(() => {
    if (!ready || !paired) return false;
    const p = $page.url.pathname;
    if (p.endsWith('/pair/') || p.endsWith('/pair')) return false;
    return true;
  });

  const tabs = [
    { href: `${base}/library/`, label: 'Library', icon: '🎵', key: 'library' },
    { href: `${base}/queue/`, label: 'Queue', icon: '≡', key: 'queue' },
    { href: `${base}/live/`, label: 'Live', icon: '●', key: 'live' },
    { href: `${base}/lists/`, label: 'Lists', icon: '☰', key: 'lists' },
    { href: `${base}/settings/`, label: 'Settings', icon: '⚙', key: 'settings' },
  ];

  function isActive(href: string) {
    const p = $page.url.pathname;
    return p === href || p === href.replace(/\/$/, '');
  }

  // Intercept back gesture / popstate navigation to close modals first
  beforeNavigate((navigation) => {
    if (navigation.type === 'popstate') {
      if ($activeModals.length > 0) {
        navigation.cancel();
        const closeFn = $activeModals[$activeModals.length - 1];
        closeFn();
      }
    }
  });

  function handleTabClick(e: MouseEvent, t: typeof tabs[0]) {
    if (isActive(t.href)) {
      if (t.key === 'library') {
        const search = $page.url.search;
        if (search && search.includes('mode=')) {
          // Exit Bible / Write Song modes if active
          e.preventDefault();
          libraryScrollY.set(0);
          goto(`${base}/library/`, { replaceState: true });
        } else {
          // Scroll smoothly to top and reset saved scroll Y
          e.preventDefault();
          libraryScrollY.set(0);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      } else if (t.key === 'lists') {
        e.preventDefault();
        listsScrollY.set(0);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  }
</script>

{#if showUpdateBanner}
  <div class="update-banner" role="alert">
    Updating to latest version...
  </div>
{:else}
  <div class="top-banners">
    {#if showTabs() && $isViewOnly}
      <div class="view-only-banner" role="status">
        View-only — another phone has exclusive control
      </div>
    {/if}
    {#if showTabs() && $managerAccessCountdown > 0}
      <div class="manager-access-banner" role="status">
        🟢 Phone Manager Access: {Math.floor($managerAccessCountdown / 60)}:{($managerAccessCountdown % 60).toString().padStart(2, '0')}
      </div>
    {/if}
  </div>
{/if}

<main class:has-tabs={showTabs()} class:has-banner={showTabs() && ($isViewOnly || $managerAccessCountdown > 0)} class:has-double-banner={showTabs() && $isViewOnly && $managerAccessCountdown > 0}>
  {#if ready}
    {@render children()}
  {:else}
    <div class="loading-screen">
      <div class="loader"></div>
      <div class="loading-text">Loading Remote...</div>
    </div>
  {/if}
</main>

{#if showTabs()}
  <nav class="tabbar">
    {#each tabs as t (t.key)}
      <a
        class="tab"
        class:active={isActive(t.href)}
        href={t.href}
        onclick={(e) => handleTabClick(e, t)}
        data-sveltekit-preload-data="tap"
        data-sveltekit-preload-code="eager"
      >
        <span class="icon">{t.icon}</span>
        <span class="label">{t.label}</span>
      </a>
    {/each}
  </nav>
{/if}

{#if showDebugDrawer}
  <div class="debug-drawer" style="position: fixed; inset: 0; background: rgba(11, 11, 13, 0.96); z-index: 100000; color: #fff; display: flex; flex-direction: column; font-family: monospace; font-size: 11px; padding: calc(16px + env(safe-area-inset-top, 0)) 16px 16px; box-sizing: border-box;">
    <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; margin-bottom: 8px; flex-shrink: 0;">
      <h3 style="margin: 0; font-size: 14px;">🐛 Console Debug Logs</h3>
      <div style="display: flex; gap: 8px;">
        <button style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 6px 10px; border-radius: 6px; cursor: pointer;" onclick={() => {
          const txt = consoleLogs.map(l => `[${l.time}] [${l.type.toUpperCase()}] ${l.text}`).join('\n');
          navigator.clipboard.writeText(txt).then(() => alert('Copied logs to clipboard!'));
        }}>Copy</button>
        <button style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239,68,68,0.3); color: #f87171; padding: 6px 10px; border-radius: 6px; cursor: pointer;" onclick={() => consoleLogs = []}>Clear</button>
        <button style="background: var(--accent); border: none; color: #fff; padding: 6px 12px; border-radius: 6px; font-weight: bold; cursor: pointer;" onclick={() => showDebugDrawer = false}>Close</button>
      </div>
    </div>
    <div style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;">
      {#each consoleLogs as log}
        <div style="border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 4px; white-space: pre-wrap; line-height: 1.3;">
          <span style="color: #6b7280; font-size: 9px; margin-right: 4px;">[{log.time}]</span>
          <span style="color: {log.type === 'error' ? '#f87171' : log.type === 'warn' ? '#fbbf24' : '#60a5fa'}; font-weight: bold; margin-right: 4px;">[{log.type.toUpperCase()}]</span>
          <span>{log.text}</span>
        </div>
      {/each}
      {#if consoleLogs.length === 0}
        <div style="color: #6b7280; text-align: center; margin-top: 40px;">No console logs captured yet.</div>
      {/if}
    </div>
  </div>
{/if}

{#if ready && $debugMode}
  <button 
    style="position: fixed; right: 16px; bottom: calc(80px + env(safe-area-inset-bottom, 0)); width: 32px; height: 32px; border-radius: 50%; background: rgba(30, 30, 40, 0.55); border: 1px solid rgba(255,255,255,0.15); display: flex; align-items: center; justify-content: center; font-size: 14px; z-index: 99999; cursor: pointer; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); transition: all 150ms; padding: 0; box-shadow: 0 4px 12px rgba(0,0,0,0.25);"
    onclick={() => showDebugDrawer = true}
    title="Open console debugger"
  >
    🐛
  </button>
{/if}

<style>
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: calc(20px + env(safe-area-inset-top, 0)) 16px 40px;
  }
  main.has-tabs {
    padding-bottom: calc(72px + env(safe-area-inset-bottom, 0));
  }
  main.has-banner {
    padding-top: calc(44px + env(safe-area-inset-top, 0));
  }
  main.has-double-banner {
    padding-top: calc(78px + env(safe-area-inset-top, 0));
  }

  .top-banners {
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .view-only-banner, .manager-access-banner {
    position: relative;
    width: 100%;
    text-align: center;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.4px;
    box-sizing: border-box;
  }

  .view-only-banner {
    background: var(--accent);
    color: #fff;
    padding: calc(10px + env(safe-area-inset-top, 0)) 12px 10px;
  }

  .manager-access-banner {
    background: #059669;
    color: #fff;
    padding: 10px 12px;
  }

  .update-banner {
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 50;
    background: linear-gradient(135deg, #10b981, #059669);
    color: #fff;
    text-align: center;
    padding: calc(12px + env(safe-area-inset-top, 0)) 12px 12px;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.5px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    animation: slideDown 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes slideDown {
    from { transform: translateY(-100%); }
    to { transform: translateY(0); }
  }


  .tabbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    display: flex;
    justify-content: space-around;
    background: rgba(22, 22, 30, 0.75);
    border-top: 1px solid rgba(48, 48, 74, 0.4);
    padding: 6px 8px calc(6px + env(safe-area-inset-bottom, 0));
    backdrop-filter: blur(12px) saturate(180%);
    -webkit-backdrop-filter: blur(12px) saturate(180%);
    box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.15);
  }

  .tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 4px;
    color: var(--text-secondary);
    text-decoration: none;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    -webkit-tap-highlight-color: transparent;
    position: relative;
    transition: color 150ms ease, transform 100ms ease;
    will-change: transform;
  }

  .tab:active {
    transform: scale(0.94);
  }

  .tab::after {
    content: '';
    position: absolute;
    top: -6px;
    left: 50%;
    transform: translateX(-50%) scaleX(0);
    width: 28px;
    height: 3px;
    background: var(--accent);
    border-radius: 0 0 3px 3px;
    transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);
    box-shadow: 0 2px 10px var(--accent);
    will-change: transform;
  }

  .tab.active {
    color: var(--accent);
  }

  .tab.active::after {
    transform: translateX(-50%) scaleX(1);
  }

  .tab .icon {
    font-size: 20px;
    line-height: 1;
    transition: transform 150ms ease;
  }

  .tab:hover .icon {
    transform: translateY(-1px);
  }

  .loading-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 50vh;
    text-align: center;
    gap: 16px;
  }

  .loader {
    width: 48px;
    height: 48px;
    border: 3.5px solid rgba(233, 69, 96, 0.1);
    border-radius: 50%;
    border-top-color: var(--accent);
    animation: spin 1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    box-shadow: 0 0 15px rgba(233, 69, 96, 0.1);
  }

  .loading-text {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: 0.5px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
