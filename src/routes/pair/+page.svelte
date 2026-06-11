<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import { get } from 'svelte/store';
  import { initializeServerData, loadCredentials, saveServer, switchServer, getOrCreateDeviceId, type ServerEntry } from '$lib/db';
  import { hydrateFromCache } from '$lib/sync';
  import { remote } from '$lib/ws';
  import { connStatus, connError } from '$lib/stores';
  import jsQR from 'jsqr';

  let deviceName = $state('Phone');
  let pairToken = $state<string | null>(null);
  let cloudHost = $state<string | null>(null);
  let lanHost = $state<string | null>(null);
  let serverId = $state<string | null>(null);
  let error = $state<string | null>(null);
  let phase: 'idle' | 'pairing' | 'done' = $state('idle');

  // iOS-in-Safari guard: pairing here would save creds to Safari's storage,
  // not the installed PWA's. We detect and divert the user.
  let iosWarning = $state(false);
  let copied = $state(false);

  // Camera QR Scanner states
  let scanning = $state(false);
  let scanErr = $state<string | null>(null);
  let videoEl: HTMLVideoElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let scanStream: MediaStream | null = null;
  let animationFrameId: number | null = null;

  let pasteUrl = $state('');
  let pasteErr = $state<string | null>(null);

  onMount(async () => {
    const qs = $page.url.searchParams;
    pairToken = qs.get('pt');
    cloudHost = qs.get('c');
    lanHost = qs.get('l');
    serverId = qs.get('sid');

    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window);
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;

    if (isIOS && !standalone) {
      iosWarning = true;
      return;
    }

    if (!pairToken || (!cloudHost && !lanHost)) {
      // No QR params — user navigated here manually.
      return;
    }

    const prev = await loadCredentials();
    if (prev?.device_name) deviceName = prev.device_name;
  });

  onDestroy(() => {
    stopScan();
  });

  function handlePairUrl(raw: string): boolean {
    scanErr = null;
    const s = raw.trim();
    if (!s) return false;
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      scanErr = 'That does not look like a valid link.';
      return false;
    }
    const pt = url.searchParams.get('pt');
    const c = url.searchParams.get('c');
    const l = url.searchParams.get('l');
    const sid = url.searchParams.get('sid');
    if (!pt || (!c && !l)) {
      scanErr = 'Link is missing pt and c/l parameters.';
      return false;
    }
    pairToken = pt;
    cloudHost = c;
    lanHost = l;
    serverId = sid;
    return true;
  }

  function onPasteSubmit(e: Event) {
    e.preventDefault();
    pasteErr = null;
    const ok = handlePairUrl(pasteUrl);
    if (!ok) {
      pasteErr = scanErr || 'Invalid pairing link.';
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      copied = false;
    }
  }

  async function startScan() {
    scanErr = null;
    scanning = true;
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
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

  async function startPair() {
    if (!pairToken) return;
    error = null;
    phase = 'pairing';

    const device_id = await getOrCreateDeviceId();
    const serverKey = serverId || crypto.randomUUID();
    const finalName = deviceName.trim() || 'Phone';
    const provisional: ServerEntry = {
      server_key: serverKey,
      server_id: serverId ?? undefined,
      device_id,
      device_token: '',
      device_name: finalName,
      cloud_host: cloudHost,
      lan_host: lanHost,
      last_used: Date.now(),
    };
    await saveServer(provisional);
    await initializeServerData(serverKey);
    await switchServer(serverKey);
    await hydrateFromCache();

    const unsub = connStatus.subscribe((s) => {
      if (s === 'open') {
        phase = 'done';
        unsub();
        setTimeout(() => goto(`${base}/live/`), 600);
      } else if (s === 'error') {
        unsub();
        connError.subscribe((e) => { error = e || 'Pair failed'; })();
        phase = 'idle';
      }
    });

    await remote.pair(
      { server_key: serverKey, server_id: serverId ?? undefined, pair_token: pairToken, cloud_host: cloudHost, lan_host: lanHost },
      finalName
    );

    if (get(connStatus) === 'open') {
      phase = 'done';
      unsub();
      setTimeout(() => goto(`${base}/live/`), 600);
    }
  }
</script>

<header>
  <h1>Pair this phone</h1>
</header>

{#if iosWarning}
  <section class="panel warn">
    <h2>Install the app first</h2>
    <p class="muted">
      You opened this link in Safari. On iPhone / iPad, pairing must happen inside the
      installed app — otherwise Safari saves the pairing and the installed app stays empty.
    </p>
    <ol class="steps">
      <li>Tap <b>Share</b> ⇧ → <b>Add to Home Screen</b>.</li>
      <li>Open <b>Remote</b> from your home screen.</li>
      <li>Back here: copy this link and paste it in the app, or scan the QR again from inside the app.</li>
    </ol>
    <button class="accent fw" onclick={copyLink}>
      {copied ? '✓ Link copied' : 'Copy pair link'}
    </button>
  </section>
{:else if !pairToken && !cloudHost && !lanHost}
  <section class="panel">
    <h2>Scan desktop QR code</h2>
    <p class="muted">
      Open the desktop app, go to <b>Settings → Remote</b>, and scan the QR code shown there to link this phone.
    </p>
    
    <button class="accent fw" onclick={startScan} style="margin-top: 16px;">
      📷 Scan QR code
    </button>
    
    {#if scanErr}
      <p class="err small" style="margin-top: 8px;">{scanErr}</p>
    {/if}

    <div class="or">— or —</div>

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
  </section>
{:else if error}
  <section class="panel err">
    <b>Couldn't pair</b>
    <p class="muted">{error}</p>
  </section>
{:else if phase === 'done'}
  <section class="panel ok">
    <b>✓ Paired</b>
    <p class="muted">Opening remote…</p>
  </section>
{:else}
  <p class="muted" style="margin-top:-8px;">
    First-time pairing. Give your phone a name so the operator can see who's connected.
  </p>

  <section class="panel">
    <label for="device-name">Phone name</label>
    <input
      id="device-name"
      type="text"
      autocapitalize="words"
      placeholder="Pulpit Phone"
      bind:value={deviceName}
      disabled={phase === 'pairing'}
    />

    <div class="endpoints muted">
      {#if cloudHost}<div>Cloud: <code>{cloudHost}</code></div>{/if}
      {#if lanHost}<div>LAN: <code>{lanHost}</code></div>{/if}
      {#if serverId}<div>Server ID: <code>{serverId.slice(0, 8)}</code></div>{/if}
    </div>

    <button class="accent fw" onclick={startPair} disabled={phase === 'pairing'}>
      {phase === 'pairing' ? 'Pairing…' : 'Pair'}
    </button>
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
  header { padding: 8px 0 12px; }
  h1 { margin: 0; font-size: 22px; font-weight: 700; }
  h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
  label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 6px; }

  .endpoints { margin-top: 12px; font-size: 12px; line-height: 1.6; }
  .endpoints code {
    background: var(--elevated);
    padding: 1px 6px;
    border-radius: 4px;
  }

  .panel.warn { border-color: var(--warning); }
  .panel.ok  { border-color: var(--success); }
  .panel.err { border-color: var(--danger); }
  button.fw { width: 100%; margin-top: 16px; padding: 14px; font-size: 16px; }

  .steps { margin: 8px 0 0 20px; padding: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
  .steps li { margin-bottom: 4px; }

  .or { text-align: center; color: var(--text-secondary); font-size: 12px; margin: 14px 0 4px; }
  .err { color: var(--danger); font-size: 12px; margin: 6px 0 0; }
  .small { font-size: 12px; }

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
