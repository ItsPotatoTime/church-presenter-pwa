<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import { loadCredentials, saveServer, switchServer, getOrCreateDeviceId, type ServerEntry } from '$lib/db';
  import { remote } from '$lib/ws';
  import { connStatus, connError } from '$lib/stores';

  let deviceName = $state('Phone');
  let pairToken = $state<string | null>(null);
  let cloudHost = $state<string | null>(null);
  let lanHost = $state<string | null>(null);
  let error = $state<string | null>(null);
  let phase: 'idle' | 'pairing' | 'done' = $state('idle');

  // iOS-in-Safari guard: pairing here would save creds to Safari's storage,
  // not the installed PWA's. We detect and divert the user.
  let iosWarning = $state(false);
  let copied = $state(false);

  onMount(async () => {
    const qs = $page.url.searchParams;
    pairToken = qs.get('pt');
    cloudHost = qs.get('c');
    lanHost = qs.get('l');

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
      // No QR params — user navigated here manually. Show instructions instead of an error.
      return;
    }

    const prev = await loadCredentials();
    if (prev?.device_name) deviceName = prev.device_name;
  });

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // iOS may refuse clipboard without user gesture — button IS a gesture, but if it fails, fall back
      copied = false;
    }
  }

  async function startPair() {
    if (!pairToken) return;
    error = null;
    phase = 'pairing';

    const device_id = await getOrCreateDeviceId();
    // Create a new server entry for this pairing so existing pairings are preserved.
    const serverKey = crypto.randomUUID();
    const provisional: ServerEntry = {
      server_key: serverKey,
      device_id,
      device_token: '',
      device_name: deviceName.trim() || 'Phone',
      cloud_host: cloudHost,
      lan_host: lanHost,
      last_used: Date.now(),
    };
    await saveServer(provisional);
    await switchServer(serverKey); // sets this as the active server

    await remote.pair(
      { pair_token: pairToken, cloud_host: cloudHost, lan_host: lanHost },
      deviceName.trim() || 'Phone'
    );

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
      <li>Open <b>Church Remote</b> from your home screen.</li>
      <li>Back here: copy this link and paste it in the app, or scan the QR again from inside the app.</li>
    </ol>
    <button class="accent fw" onclick={copyLink}>
      {copied ? '✓ Link copied' : 'Copy pair link'}
    </button>
  </section>
{:else if !pairToken && !cloudHost && !lanHost}
  <section class="panel">
    <b>Scan a QR code</b>
    <p class="muted">
      Open the desktop app, go to <b>Settings → Remote</b>,
      and scan the QR code shown there. The link will open this page with the
      pairing information filled in automatically.
    </p>
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
    </div>

    <button class="accent fw" onclick={startPair} disabled={phase === 'pairing'}>
      {phase === 'pairing' ? 'Pairing…' : 'Pair'}
    </button>
  </section>
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
</style>
