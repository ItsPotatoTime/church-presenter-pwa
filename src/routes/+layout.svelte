<script lang="ts">
  import '../app.css';
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { base } from '$app/paths';
  import { dev } from '$app/environment';
  import { beforeNavigate, goto } from '$app/navigation';
  import { getOrCreateDeviceId, loadCredentialsResilient } from '$lib/db';
  import { hydrateFromCache, isReducedDataConnection, syncNow } from '$lib/sync';
  import { myDeviceId, isViewOnly, connStatus, activeModals, libraryScrollY, listsScrollY } from '$lib/stores';

  let { children } = $props();
  let paired = $state(false);
  let ready = $state(false);
  let hasHydrated = $state(false);
  let hasTriggeredSync = $state(false);
  let showUpdateBanner = $state(false);

  // Foolproof dynamic chunk error handlers
  function handleChunkError(e: ErrorEvent) {
    if (e.message && (e.message.includes('Failed to fetch dynamically imported module') || e.message.includes('Importing a module script failed'))) {
      console.warn('[layout] Chunk loading failed. Reloading page...');
      window.location.reload();
    }
  }

  function handleUnhandledRejection(e: PromiseRejectionEvent) {
    const message = e.reason?.message || '';
    if (message.includes('Failed to fetch dynamically imported module') || message.includes('Importing a module script failed')) {
      console.warn('[layout] Chunk loading rejection. Reloading page...');
      window.location.reload();
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

  onMount(async () => {
    // Register global error interceptors for chunk load failures
    window.addEventListener('error', handleChunkError, true);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Register PWA service worker (only in production)
    if ('serviceWorker' in navigator && !dev) {
      try {
        const registration = await navigator.serviceWorker.register(`${base}/service-worker.js`, {
          scope: `${base}/`
        });
        console.log('[layout] ServiceWorker registered with scope:', registration.scope);
      } catch (err) {
        console.error('[layout] ServiceWorker registration failed:', err);
      }

      // Handle controller change (automatic reload when new SW activates)
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
          refreshing = true;
          showUpdateBanner = true;
          setTimeout(() => {
            window.location.reload();
          }, 800);
        }
      });
    }

    try {
      myDeviceId.set(await getOrCreateDeviceId());
    } catch (err) {
      console.error('[layout] Failed to get/create device ID:', err);
    }

    const creds = await loadCredentialsResilient();
    paired = !!creds && !!creds.device_token;
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

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('error', handleChunkError, true);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
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
      // Prefer a delta sync on reconnect; the first-ever sync still falls back
      // to a full snapshot because last_sync_ts starts at 0.
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
  {#if showTabs() && $isViewOnly}
    <div class="view-only-banner" role="status">
      View-only — another phone has exclusive control
    </div>
  {/if}
{/if}

<main class:has-tabs={showTabs()} class:has-banner={(showTabs() && $isViewOnly) || showUpdateBanner}>
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
    /* banner height = 10px + safe-area-inset-top + 10px + font ~16px ≈ 44px + inset */
    padding-top: calc(44px + env(safe-area-inset-top, 0));
  }

  .view-only-banner {
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 40;
    background: var(--accent);
    color: #fff;
    text-align: center;
    padding: calc(10px + env(safe-area-inset-top, 0)) 12px 10px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.4px;
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
