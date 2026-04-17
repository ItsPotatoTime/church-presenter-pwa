<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import { loadCredentials, saveCredentials, getOrCreateDeviceId } from '$lib/db';
  import { remote } from '$lib/ws';
  import { connStatus, connError } from '$lib/stores';

  let deviceName = $state('Phone');
  let pairToken = $state<string | null>(null);
  let cloudHost = $state<string | null>(null);
  let lanHost = $state<string | null>(null);
  let error = $state<string | null>(null);
  let phase: 'idle' | 'pairing' | 'done' = $state('idle');

  onMount(async () => {
    const qs = $page.url.searchParams;
    pairToken = qs.get('pt');
    cloudHost = qs.get('c');
    lanHost = qs.get('l');

    if (!pairToken || (!cloudHost && !lanHost)) {
      error = 'QR link is missing required fields (pt, c/l). Scan a fresh code.';
      return;
    }

    // Pre-fill the device name from any previous creds (in case we're re-pairing).
    const prev = await loadCredentials();
    if (prev?.device_name) deviceName = prev.device_name;
  });

  async function startPair() {
    if (!pairToken) return;
    error = null;
    phase = 'pairing';

    // Store provisional endpoints BEFORE auth so ws.ts can reconnect on them.
    const device_id = await getOrCreateDeviceId();
    await saveCredentials({
      device_id,
      device_token: '',
      device_name: deviceName.trim() || 'Phone',
      cloud_host: cloudHost,
      lan_host: lanHost,
    });

    await remote.pair(
      { pair_token: pairToken, cloud_host: cloudHost, lan_host: lanHost },
      deviceName.trim() || 'Phone'
    );

    // Wait for auth result
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
  <p class="muted">
    First-time pairing. Give your phone a name so the operator can see who's connected.
  </p>
</header>

{#if error}
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

    <button class="accent" onclick={startPair} disabled={phase === 'pairing'}>
      {phase === 'pairing' ? 'Pairing…' : 'Pair'}
    </button>
  </section>
{/if}

<style>
  header { padding: 8px 0 16px; }
  h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; }
  label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 6px; }
  .endpoints { margin-top: 12px; font-size: 12px; line-height: 1.6; }
  .endpoints code {
    background: var(--elevated);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .panel.ok  { border-color: var(--success); }
  .panel.err { border-color: var(--danger); }
  button.accent { width: 100%; margin-top: 16px; padding: 14px; font-size: 16px; }
</style>
