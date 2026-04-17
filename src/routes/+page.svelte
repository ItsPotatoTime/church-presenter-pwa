<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { loadCredentials } from '$lib/db';

  let checked = $state(false);
  let paired = $state(false);
  let standalone = $state(false);
  let installPromptAvailable = $state(false);
  let deferredPrompt: any = null;

  onMount(() => {
    standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;

    const handler = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e;
      installPromptAvailable = true;
    };
    window.addEventListener('beforeinstallprompt', handler);

    void (async () => {
      const creds = await loadCredentials();
      paired = !!creds && !!creds.device_token;
      checked = true;
      if (paired) goto(`${base}/live/`);
    })();

    return () => window.removeEventListener('beforeinstallprompt', handler);
  });

  async function install() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installPromptAvailable = false;
  }
</script>

<header>
  <h1>Church Presenter Remote</h1>
  <p class="muted">Companion remote for the desktop presenter.</p>
</header>

{#if !checked}
  <section class="panel">
    <p class="muted">Loading…</p>
  </section>
{:else if paired}
  <section class="panel">
    <p class="muted">Redirecting…</p>
  </section>
{:else}
  <section class="panel">
    <h2>Scan the pair QR</h2>
    <p class="muted">
      On the desktop app, click <b>📱 Phone Remote</b> in the toolbar. A QR code will appear —
      scan it with your phone camera. The browser will open this app already paired and go live.
    </p>
  </section>

  <section class="panel" style="margin-top: 16px;">
    <h2>Install for best experience</h2>
    <p class="muted">
      {#if standalone}
        ✓ Running as an installed app.
      {:else if installPromptAvailable}
        Install to your home screen for a full-screen app-like experience.
      {:else}
        <b>iOS:</b> tap Share → <i>Add to Home Screen</i>. <br>
        <b>Android:</b> menu → <i>Install app</i>.
      {/if}
    </p>
    {#if installPromptAvailable}
      <button class="accent" onclick={install}>Install app</button>
    {/if}
  </section>
{/if}

<style>
  header { padding: 8px 0 16px; }
  h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; }
  h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
</style>
