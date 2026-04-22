<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { loadCredentials } from '$lib/db';
  import { serverName } from '$lib/stores';

  let checked = $state(false);
  let paired = $state(false);
  let standalone = $state(false);
  let installPromptAvailable = $state(false);
  let deferredPrompt: any = null;

  let isIOS = $state(false);
  let pasteUrl = $state('');
  let pasteErr = $state<string | null>(null);

  // Camera scanner (BarcodeDetector — Safari 17+, Chrome/Edge desktop and Android)
  let scanSupported = $state(false);
  let scanning = $state(false);
  let scanErr = $state<string | null>(null);
  let videoEl: HTMLVideoElement | null = $state(null);
  let scanStream: MediaStream | null = null;
  let scanTimer: number | null = null;

  onMount(() => {
    isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) &&
      !('MSStream' in window);

    standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;

    scanSupported = 'BarcodeDetector' in window;

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

  // ── Inline QR scanner ─────────────────────────────────────────────
  async function startScan() {
    scanErr = null;
    if (!scanSupported) {
      scanErr = 'This browser has no built-in QR scanner. Paste the link instead.';
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
      // @ts-expect-error BarcodeDetector is not in all TS libs
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const tick = async () => {
        if (!scanning || !videoEl) return;
        try {
          const codes = await detector.detect(videoEl);
          if (codes && codes.length) {
            const value = String(codes[0].rawValue ?? '');
            if (value) {
              const ok = handlePairUrl(value);
              if (ok) {
                stopScan();
                return;
              }
            }
          }
        } catch {
          /* frame not ready — keep scanning */
        }
        scanTimer = window.setTimeout(tick, 200);
      };
      tick();
    } catch (e: any) {
      scanning = false;
      scanErr = e?.message ?? 'Camera unavailable';
    }
  }

  function stopScan() {
    scanning = false;
    if (scanTimer !== null) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (scanStream) {
      for (const t of scanStream.getTracks()) t.stop();
      scanStream = null;
    }
    if (videoEl) videoEl.srcObject = null;
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
      {#if !scanning}
        <button class="accent fw" onclick={startScan}>📷 Scan QR code</button>
      {:else}
        <div class="scan-wrap">
          <video bind:this={videoEl} playsinline muted></video>
          <button class="ghost fw" onclick={stopScan}>Cancel scan</button>
        </div>
      {/if}
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
      <button class="accent fw" type="submit" disabled={!pasteUrl.trim()}>
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

  .scan-wrap { margin-top: 10px; }
  video {
    width: 100%; max-height: 60vh;
    background: #000;
    border-radius: 10px;
  }

  .err { color: var(--danger); font-size: 12px; margin: 6px 0 0; }
  .small { font-size: 12px; }

  .tip { margin-top: 14px; }
  .tip summary { cursor: pointer; }
  .tip p { margin: 6px 0 0; line-height: 1.5; }
</style>
