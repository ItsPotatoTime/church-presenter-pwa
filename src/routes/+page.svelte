<script lang="ts">
  import { onMount } from 'svelte';

  let wsUrl = $state('');
  let status: 'idle' | 'connecting' | 'open' | 'error' | 'closed' = $state('idle');
  let log = $state<string[]>([]);
  let installPromptAvailable = $state(false);
  let standalone = $state(false);
  let ws: WebSocket | null = null;
  let deferredPrompt: any = null;

  function addLog(msg: string) {
    const ts = new Date().toLocaleTimeString();
    log = [...log, `[${ts}] ${msg}`].slice(-20);
  }

  function normalizeUrl(input: string): string {
    const trimmed = input.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `wss://${trimmed}`;
  }

  function connect() {
    if (!wsUrl.trim()) {
      addLog('Enter the tunnel URL first');
      return;
    }
    const url = normalizeUrl(wsUrl);
    addLog(`Connecting to ${url}`);
    status = 'connecting';
    try {
      ws?.close();
      ws = new WebSocket(url);
    } catch (e: any) {
      status = 'error';
      addLog(`Failed: ${e.message}`);
      return;
    }
    ws.onopen = () => {
      status = 'open';
      addLog('Open — sending "ping"');
      ws?.send('ping');
    };
    ws.onmessage = (ev) => {
      addLog(`← ${ev.data}`);
    };
    ws.onerror = () => {
      status = 'error';
      addLog('Error — check URL + tunnel is running');
    };
    ws.onclose = (ev) => {
      status = 'closed';
      addLog(`Closed (code ${ev.code})`);
    };
  }

  function disconnect() {
    ws?.close();
    ws = null;
  }

  async function install() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installPromptAvailable = false;
  }

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
    return () => window.removeEventListener('beforeinstallprompt', handler);
  });

  const statusLabel = $derived(
    { idle: 'Idle', connecting: '…', open: 'Connected', error: 'Error', closed: 'Closed' }[status]
  );
  const statusClass = $derived(
    { idle: '', connecting: 'warn', open: 'ok', error: 'err', closed: 'warn' }[status]
  );
</script>

<header>
  <h1>Church Presenter Remote</h1>
  <p class="muted">Phase 0 — infrastructure validation</p>
</header>

<section class="panel">
  <h2>Install</h2>
  <p class="muted">
    {#if standalone}
      ✓ Running as installed PWA
    {:else if installPromptAvailable}
      Tap <b>Install</b> to add this app to your home screen.
    {:else}
      On iOS: tap <b>Share → Add to Home Screen</b>. On Android: look for the install banner or browser menu.
    {/if}
  </p>
  {#if installPromptAvailable}
    <button class="accent" onclick={install}>Install app</button>
  {/if}
</section>

<section class="panel" style="margin-top: 16px;">
  <h2>Connection test</h2>
  <p class="muted">
    Paste the cloudflared tunnel URL from the desktop (e.g.
    <code>funny-horse-1234.trycloudflare.com</code>).
    The app will open a WebSocket to <code>wss://&lt;url&gt;</code> and send "ping".
  </p>

  <label style="display:block; margin: 12px 0 6px;">Tunnel URL</label>
  <input
    type="url"
    inputmode="url"
    autocapitalize="off"
    autocomplete="off"
    placeholder="xyz-abc-123.trycloudflare.com"
    bind:value={wsUrl}
  />

  <div style="display:flex; gap:10px; margin-top: 14px; align-items:center;">
    <button class="accent" onclick={connect} disabled={status === 'connecting'}>
      Test connection
    </button>
    <button onclick={disconnect} disabled={status !== 'open' && status !== 'connecting'}>
      Disconnect
    </button>
    <span class="pill {statusClass}">{statusLabel}</span>
  </div>
</section>

<section class="panel" style="margin-top: 16px;">
  <h2>Log</h2>
  <pre>{log.length === 0 ? '— empty —' : log.join('\n')}</pre>
</section>

<footer class="muted" style="margin-top: 24px; text-align:center;">
  v0.0.1 — success when this screen shows <b>Connected</b> and echoes "echo: ping".
</footer>

<style>
  header { padding: 8px 0 16px; }
  h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.2px; }
  h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; color: var(--text-primary); }
  code {
    background: var(--elevated);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 13px;
  }
  pre {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    max-height: 260px;
    overflow-y: auto;
    color: var(--text-secondary);
  }
</style>
