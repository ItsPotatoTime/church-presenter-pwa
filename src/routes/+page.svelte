<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import {
    getActiveServerKey,
    loadAllServers,
    loadCredentialsResilient,
    switchServer,
    type ServerEntry,
  } from '$lib/db';
  import { hydrateFromCache } from '$lib/sync';
  import { exclusiveDeviceId, exclusiveDeviceName, liveState, serverName } from '$lib/stores';
  import { remote } from '$lib/ws';
  import jsQR from 'jsqr';

  let checked = $state(false);
  let paired = $state(false);
  let servers = $state<ServerEntry[]>([]);
  let activeServerKey = $state<string | null>(null);
  let choosingServer = $state(false);
  let selectingServerKey = $state<string | null>(null);
  let standalone = $state(false);
  let installPromptAvailable = $state(false);
  let deferredPrompt: any = null;

  let isIOS = $state(false);
  let pasteUrl = $state('');
  let pasteErr = $state<string | null>(null);

  // Camera scanner states
  let scanSupported = $state(true);
  let scanning = $state(false);
  let scanErr = $state<string | null>(null);
  let videoEl: HTMLVideoElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let scanStream: MediaStream | null = null;
  let animationFrameId: number | null = null;

  onMount(() => {
    isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) &&
      !('MSStream' in window);

    standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;

    // Check if media devices and getUserMedia are supported (standard camera detection)
    scanSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

    const handler = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e;
      installPromptAvailable = true;
    };
    window.addEventListener('beforeinstallprompt', handler);

    void (async () => {
      const forceChoose = new URLSearchParams(window.location.search).has('choose');
      servers = (await loadAllServers()).sort((a, b) => (b.last_used ?? 0) - (a.last_used ?? 0));
      activeServerKey = await getActiveServerKey();

      if (forceChoose && servers.length > 1) {
        choosingServer = true;
        checked = true;
        return;
      }

      const creds = await loadCredentialsResilient();
      paired = !!creds && !!creds.device_token;
      checked = true;
      if (paired) {
        goto(`${base}/live/`);
        return;
      }

      if (servers.length > 1) {
        activeServerKey = await getActiveServerKey();
        choosingServer = true;
        return;
      }

      if (servers.length === 1) {
        const selected = await switchServer(servers[0].server_key);
        if (selected?.device_token) {
          goto(`${base}/live/`);
        }
      }
    })();

    return () => window.removeEventListener('beforeinstallprompt', handler);
  });

  onDestroy(() => {
    stopScan();
  });

  async function install() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installPromptAvailable = false;
  }

  /** Extract pt/c/l params from a pair URL and navigate to /pair/. */
  function handlePairUrl(raw: string): boolean {
    pasteErr = null;
    const s = raw.trim();
    if (!s) return false;
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      pasteErr = 'That does not look like a valid link.';
      return false;
    }
    const pt = url.searchParams.get('pt');
    const c = url.searchParams.get('c');
    const l = url.searchParams.get('l');
    if (!pt || (!c && !l)) {
      pasteErr = 'Link is missing pt and c/l parameters.';
      return false;
    }
    const qs = new URLSearchParams();
    qs.set('pt', pt);
    if (c) qs.set('c', c);
    if (l) qs.set('l', l);
    goto(`${base}/pair/?${qs.toString()}`);
    return true;
  }

  function onPasteSubmit(e: Event) {
    e.preventDefault();
    handlePairUrl(pasteUrl);
  }

  async function chooseServer(serverKey: string) {
    selectingServerKey = serverKey;
    const selected = await switchServer(serverKey);
    selectingServerKey = null;
    if (selected?.device_token) {
      activeServerKey = serverKey;
      serverName.set(selected.server_name ?? 'ChurchPresenter');
      liveState.set(null);
      exclusiveDeviceId.set(null);
      exclusiveDeviceName.set(null);
      await hydrateFromCache();
      remote.disconnect();
      void remote.connect();
      goto(`${base}/live/`);
    }
  }

  // ── Inline QR scanner ─────────────────────────────────────────────
  async function startScan() {
    scanErr = null;
    if (!scanSupported) {
      scanErr = 'Camera access is not supported on this browser. Paste the link instead.';
      return;
    }
    scanning = true;
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      // Wait for the <video> element (rendered when scanning=true)
      await new Promise((r) => setTimeout(r, 0));
      if (videoEl) {
        videoEl.srcObject = scanStream;
        await videoEl.play().catch(() => {});
      }
      animationFrameId = requestAnimationFrame(tick);
    } catch (e: any) {
      scanning = false;
      scanErr = e?.message ?? 'Camera unavailable';
    }
  }

  function stopScan() {
    scanning = false;
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (scanStream) {
      for (const t of scanStream.getTracks()) t.stop();
      scanStream = null;
    }
    if (videoEl) videoEl.srcObject = null;
  }

  function tick() {
    if (!scanning || !videoEl || !canvasEl) return;
    if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
      const ctx = canvasEl.getContext('2d');
      if (ctx) {
        canvasEl.width = videoEl.videoWidth;
        canvasEl.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
        const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'attemptBoth',
        });
        if (code && code.data) {
          const ok = handlePairUrl(code.data);
          if (ok) {
            stopScan();
            return;
          }
        }
      }
    }
    animationFrameId = requestAnimationFrame(tick);
  }
</script>

<header>
  <h1>{$serverName} Remote</h1>
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
{:else if choosingServer}
  <section class="panel">
    <h2>Choose server</h2>
    <p class="muted">Select the desktop you want this phone to control.</p>

    <div class="server-list">
      {#each servers as s (s.server_key)}
        <button
          class="server-choice"
          class:active={s.server_key === activeServerKey}
          onclick={() => chooseServer(s.server_key)}
          disabled={!!selectingServerKey}
        >
          <span class="server-main">
            <span class="server-title">{s.server_name ?? 'ChurchPresenter'}</span>
            <span class="server-host">{s.cloud_host ?? s.lan_host ?? 'No endpoint saved'}</span>
          </span>
          <span class="server-meta">
            {#if selectingServerKey === s.server_key}
              Opening…
            {:else if s.server_key === activeServerKey}
              Current
            {:else}
              Select
            {/if}
          </span>
        </button>
      {/each}
    </div>

    <a class="pair-link" href={`${base}/pair/`}>Pair another server</a>
  </section>
{:else}
  {#if isIOS && !standalone}
    <section class="panel warn">
      <h2>Install this first on iOS</h2>
      <p class="muted">
        Scanning a QR from Camera opens Safari, not the installed app — so we'd pair in Safari
        and lose it. To avoid that:
      </p>
      <ol class="steps">
        <li>Tap the <b>Share</b> icon ⇧ at the bottom of Safari.</li>
        <li>Choose <b>Add to Home Screen</b>.</li>
        <li>Open <b>Remote</b> from your home screen.</li>
        <li>Come back here and scan or paste the QR link below.</li>
      </ol>
    </section>
  {/if}

  <section class="panel" style="margin-top:16px;">
    <h2>Pair this phone</h2>
    <p class="muted">
      On the desktop, click <b>📱 Phone Remote</b> in the toolbar to show the QR.
    </p>

    {#if scanSupported}
      <button class="accent fw" onclick={startScan}>📷 Scan QR code</button>
      {#if scanErr}<p class="err small">{scanErr}</p>{/if}
      <div class="or">— or —</div>
    {/if}

    <form onsubmit={onPasteSubmit}>
      <label for="paste">Paste the pair link from the QR</label>
      <input
        id="paste"
        type="url"
        autocomplete="off"
        autocapitalize="none"
        autocorrect="off"
        placeholder="https://…/pair/?pt=…"
        bind:value={pasteUrl}
      />
      {#if pasteErr}<p class="err small">{pasteErr}</p>{/if}
      <button class="accent fw" type="submit" style="margin-top: 12px;" disabled={!pasteUrl.trim()}>
        Pair with this link
      </button>
    </form>

    <details class="tip">
      <summary class="muted small">How to get the link on iOS</summary>
      <p class="muted small">
        In the iPhone Camera app, point at the QR on the desktop. A yellow banner appears —
        <b>long-press it</b>, choose <b>Copy Link</b>, then switch back here and paste.
      </p>
    </details>
  </section>

  <section class="panel" style="margin-top:16px;">
    <h2>Install for best experience</h2>
    <p class="muted">
      {#if standalone}
        ✓ Running as an installed app.
      {:else if installPromptAvailable}
        Install to your home screen for a full-screen app-like experience.
      {:else if !isIOS}
        <b>Android:</b> menu → <i>Install app</i>.
      {/if}
    </p>
    {#if installPromptAvailable}
      <button class="accent" onclick={install}>Install app</button>
    {/if}
  </section>
{/if}

{#if scanning}
  <div class="scanner-modal" role="dialog" aria-modal="true">
    <div class="scanner-header">
      <h2>Scan QR Code</h2>
      <button class="close-btn" onclick={stopScan} aria-label="Close scanner">✕</button>
    </div>
    
    <div class="scanner-viewport">
      <video bind:this={videoEl} playsinline muted></video>
      <canvas bind:this={canvasEl} style="display: none;"></canvas>
      
      <!-- Visual targeting box -->
      <div class="scan-reticle">
        <div class="scan-line"></div>
        <div class="corner top-left"></div>
        <div class="corner top-right"></div>
        <div class="corner bottom-left"></div>
        <div class="corner bottom-right"></div>
      </div>
    </div>
    
    <div class="scanner-footer">
      <p class="muted">Align the QR code inside the box to scan</p>
    </div>
  </div>
{/if}

<style>
  header { padding: 8px 0 16px; }
  h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; }
  h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
 
  .panel.warn { border-color: var(--warning); }
  .steps { margin: 8px 0 0 20px; padding: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
  .steps li { margin-bottom: 4px; }
 
  form { display: block; margin-top: 4px; }
  label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 6px; }
 
  button.fw { width: 100%; padding: 14px; margin-top: 12px; font-size: 15px; }
  .or { text-align: center; color: var(--text-secondary); font-size: 12px; margin: 14px 0 4px; }
 
  .err { color: var(--danger); font-size: 12px; margin: 6px 0 0; }
  .small { font-size: 12px; }
 
  .tip { margin-top: 14px; }
  .tip summary { cursor: pointer; }
  .tip p { margin: 6px 0 0; line-height: 1.5; }

  .server-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 14px;
  }
  .server-choice {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 13px 12px;
    text-align: left;
    border-color: var(--border-light);
    background: var(--elevated);
  }
  .server-choice.active {
    border-color: var(--accent);
  }
  .server-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .server-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .server-host {
    font-size: 12px;
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  .server-meta {
    flex-shrink: 0;
    color: var(--accent);
    font-size: 12px;
    font-weight: 700;
  }
  .pair-link {
    display: block;
    margin-top: 14px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-primary);
    text-align: center;
    text-decoration: none;
  }

  /* Premium Scanner Overlay Styles */
  .scanner-modal {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(15, 15, 20, 0.95);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: calc(20px + env(safe-area-inset-top, 0)) 20px calc(30px + env(safe-area-inset-bottom, 0));
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }

  .scanner-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    margin-bottom: 20px;
  }

  .scanner-header h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--text-primary);
  }

  .close-btn {
    background: rgba(255, 255, 255, 0.08);
    border: none;
    color: var(--text-primary);
    width: 38px;
    height: 38px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    cursor: pointer;
    transition: background 150ms ease, transform 100ms ease;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .close-btn:active {
    transform: scale(0.92);
  }

  .scanner-viewport {
    position: relative;
    width: 100%;
    max-width: 400px;
    aspect-ratio: 1;
    margin: auto;
    border-radius: 20px;
    overflow: hidden;
    background: #000;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    border: 1px solid var(--border-light);
  }

  .scanner-viewport video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .scan-reticle {
    position: absolute;
    inset: 40px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    pointer-events: none;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
  }

  .corner {
    position: absolute;
    width: 20px;
    height: 20px;
    border: 3px solid var(--accent);
    pointer-events: none;
  }

  .top-left {
    top: -2px; left: -2px;
    border-right: none; border-bottom: none;
    border-top-left-radius: 8px;
  }

  .top-right {
    top: -2px; right: -2px;
    border-left: none; border-bottom: none;
    border-top-right-radius: 8px;
  }

  .bottom-left {
    bottom: -2px; left: -2px;
    border-right: none; border-top: none;
    border-bottom-left-radius: 8px;
  }

  .bottom-right {
    bottom: -2px; right: -2px;
    border-left: none; border-top: none;
    border-bottom-right-radius: 8px;
  }

  .scan-line {
    position: absolute;
    left: 4px;
    right: 4px;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    box-shadow: 0 0 8px var(--accent);
    animation: scan 2s linear infinite;
  }

  @keyframes scan {
    0% { top: 10%; }
    50% { top: 90%; }
    100% { top: 10%; }
  }

  .scanner-footer {
    text-align: center;
    margin-top: 20px;
  }
</style>
