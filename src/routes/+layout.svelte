<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { base } from '$app/paths';
  import { getOrCreateDeviceId, loadCredentials } from '$lib/db';
  import { hydrateFromCache, syncFull } from '$lib/sync';
  import { myDeviceId, isViewOnly, connStatus } from '$lib/stores';

  let { children } = $props();
  let paired = $state(false);
  let ready = $state(false);
  let hasHydrated = $state(false);

  onMount(async () => {
    myDeviceId.set(await getOrCreateDeviceId());
    const creds = await loadCredentials();
    paired = !!creds && !!creds.device_token;
    if (paired) {
      // Load library cache so Library/Queue show something even offline.
      await hydrateFromCache();
      hasHydrated = true;
    }
    ready = true;
  });

  // After first QR pairing, connStatus becomes 'open' before layout re-mounts.
  // Update paired reactively so the tab bar appears without a page refresh.
  let hasTriggeredSync = false;
  $effect(() => {
    if ($connStatus === 'open') {
      if (!paired) {
        paired = true;
        if (!hasHydrated) {
          hasHydrated = true;
          void hydrateFromCache();
        }
      }
      // Force a full sync once per session on first open so slide_texts are never stale.
      if (!hasTriggeredSync) {
        hasTriggeredSync = true;
        void syncFull();
      }
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
</script>

{#if showTabs() && $isViewOnly}
  <div class="view-only-banner" role="status">
    View-only — another phone has exclusive control
  </div>
{/if}

<main class:has-tabs={showTabs()} class:has-banner={showTabs() && $isViewOnly}>
  {@render children()}
</main>

{#if showTabs()}
  <nav class="tabbar">
    {#each tabs as t (t.key)}
      <a
        class="tab"
        class:active={isActive(t.href)}
        href={t.href}
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

  .tabbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    display: flex;
    justify-content: space-around;
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: 6px 8px calc(6px + env(safe-area-inset-bottom, 0));
    backdrop-filter: blur(6px);
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
  }

  .tab.active {
    color: var(--accent);
  }

  .tab .icon {
    font-size: 20px;
    line-height: 1;
  }
</style>
