// WebSocket client with cloud-first / LAN-fallback reconnect.
// Authenticates via pair_token (first pair) or device_token (reconnect).
// Pushes updates into stores.ts.
//
// Each open socket gets a generation id; every handler is guarded so that a
// late event from a previous socket can never corrupt the current state.

import { get } from 'svelte/store';
import type {
  AuthFail,
  AuthOk,
  ClientCommand,
  Envelope,
  ExclusiveChanged,
  ListsState,
  LiveState,
  QueueState,
} from './protocol';
import {
  cacheQueueState,
  clearCredentials,
  deletePendingMutation,
  getPendingMutations,
  getOrCreateDeviceId,
  loadAllServers,
  loadCredentials,
  mergeServerLists,
  removeUnpairedServer,
  saveCredentials,
  switchServer,
  setServerCloudStatus,
  type Credentials,
} from './db';
import {
  connStatus,
  connEndpoint,
  connError,
  desktopOnline,
  exclusiveDeviceId,
  exclusiveDeviceName,
  listsStore,
  liveState,
  pendingSyncError,
  queueDragActive,
  queueState,
  serverName,
  canEditKeys,
  canEditSongs,
  pushCloudDiagnostic,
} from './stores';

// Normalize a host that may or may not carry a scheme. The desktop sends
// `cloud_url`/`cloud_host` already *with* a scheme (e.g. `http://host:port`
// from cloud_sync._normalize_cloud_url, or a `wss://`/cloudflared host), so we
// must strip any existing scheme before prepending the one this transport needs.
// Otherwise we'd build `wss://http://host` and the browser would fail to parse
// the WebSocket URL (this was the "Cloud: offline" bug).
function normalizeWsHost(host: string): { host: string; scheme: 'wss' | 'ws' | null } {
  let h = host.trim();
  const idx = h.indexOf('://');
  let scheme: 'wss' | 'ws' | null = null;
  if (idx >= 0) {
    const s = h.slice(0, idx).toLowerCase();
    // Secure source scheme -> secure ws; everything else -> plain ws.
    scheme = s === 'https' || s === 'wss' ? 'wss' : 'ws';
    h = h.slice(idx + 3);
  }
  return { host: h, scheme };
}
import { handleSyncMessage } from './sync';

const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 15000];
const AUTH_TIMEOUT_MS = 6000;
// Deadline for the WSS handshake itself (new WebSocket() -> onopen).
// Through a cloudflared tunnel in a bad state the upgrade can hang without
// ever firing onopen OR onclose/onerror, leaving connStatus stuck at
// 'connecting' forever. This forces a close -> normal reconnect path.
// 8s keeps the "pairing…" spinner from hanging for the full 12s+ before the
// user can re-scan. The pair page also has its own 20s overall safety net.
//
// For the *reconnect* path (already paired) we give the handshake more grace:
// a Cloudflare-fronted WSS upgrade can take several seconds on a cold TLS
// session, and force-closing at 8s before onopen fires is exactly what produced
// the endless bridge/cloud flap after cloud sync was enabled. The pair page's
// own 20s safety net still bounds the first-pair case.
const CONNECT_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS_RECONNECT = 15000;

export type PairParams = {
  server_key: string;
  server_id?: string;
  pair_token: string;
  cloud_host: string | null;
  lan_host: string | null;
  cloud_url?: string | null;
  cloud_id?: string | null;
};

class RemoteClient {
  private ws: WebSocket | null = null;
  private gen = 0; // incremented every time we (re)create a socket
  private backoffIdx = 0;
  private reconnectTimer: number | null = null;
  private forceClose = false;
   private currentEndpoint: 'cloud' | 'lan' | 'bridge' | null = null;
  private alternateNext = false;
  private authTimer: number | null = null;
  private connectTimer: number | null = null;
  private pendingRequests = new Map<string, (payload: any) => void>();
  private heartbeatTimer: number | null = null;
  private lastMessageTime = 0;
  // Periodic probe of the cloud bridge's /api/status so the per-server dot in
  // Settings reflects reality (and the LIVE tab can disable when the desktop
  // is offline) even if we're currently connected via LAN/tunnel.
  private statusProbeTimer: number | null = null;
  private static readonly STATUS_PROBE_MS = 20_000;
  // Tracks server_keys we've already tried auto-switching to after a
  // wrong_server, so a stale stored entry can't cause an infinite switch loop.
  private _wrongServerTried: Set<string> = new Set();

  // When the cloud *bridge* rejects us with `revoked`, it's almost always
  // because the cloud doesn't yet know this device (the desktop pushes the
  // paired-device registry on a timer / race). Reconnecting straight back to
  // the bridge would just get `revoked` again and again, pinning the status at
  // "Closed (bridge)". We instead fall back to the desktop's own tunnel/LAN and
  // throttle bridge retries for a short window so the desktop's device push has
  // time to teach the cloud about us. `_bridgeBlocked` is a hard stop (cleared
  // only by a *successful bridge auth*); the time-based cooldown softens the
  // retry so we eventually use the bridge once the cloud knows the phone.
  private _bridgeBlocked = false;
  private _lastBridgeRevoked = 0;
  private static readonly BRIDGE_REVOKED_COOLDOWN_MS = 30_000;

  // Set when the cloud tells us a server has been *deliberately unregistered*
  // (the desktop disabled cloud sync). This is NOT a transient miss — the
  // bridge will keep rejecting us with `server_unregistered` until the server
  // re-registers. So we permanently skip the bridge and use the desktop's own
  // stored Cloudflare/LAN fallback instead. Cleared on a successful auth (so a
  // later re-enable that re-registers the server resumes using the bridge).
  private _serverUnregistered = false;

  constructor() {
    // iOS Safari kills WebSockets when the PWA moves to background.
    // On return to foreground, reconnect immediately instead of waiting for the backoff timer.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (this.forceClose) return;
        // Use reconnectActive() (not connect()) so a socket stuck in the
        // CONNECTING state is forcibly torn down instead of short-circuited
        // by connect()'s idempotency check. This is the recovery path for a
        // hung WSS handshake discovered after returning to the app.
        void this.reconnectActive();
      });
    }
    // When the device regains network access, reconnect immediately.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (this.forceClose) return;
        void this.reconnectActive();
      });
    }
  }

  // ── Public API ───────────────────────────────────────────────────

  async connect(): Promise<void> {
    // Idempotent: if we're already connected or connecting, keep the live socket
    // so tab switches don't churn the connection. Only tear down when fully closed.
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      return;
    }
    await this.reconnectActive();
  }

  async reconnectActive(): Promise<void> {
    this.tearDown();
    const creds = await loadCredentials();
    if (!creds || !creds.device_token) {
      connStatus.set('idle');
      return;
    }
    canEditKeys.set(!!creds.can_edit_keys);
    canEditSongs.set(!!creds.can_edit_songs);
    this.openSocket(creds, null);
  }

  async pair(params: PairParams, deviceName: string): Promise<void> {
    this.tearDown();
    const device_id = await getOrCreateDeviceId();
    const provisional: Credentials = {
      server_key: params.server_key,
      device_id,
      device_token: '',
      device_name: deviceName,
      cloud_host: params.cloud_host,
      lan_host: params.lan_host,
      cloud_url: params.cloud_url ?? null,
      cloud_id: params.cloud_id ?? null,
      server_id: params.server_id,
    };
    this.openSocket(provisional, params.pair_token);
  }

  disconnect(): void {
    this.tearDown();
    connStatus.set('closed');
  }

  async unpair(): Promise<void> {
    this.disconnect();
    await clearCredentials();
    liveState.set(null);
  }

  send(cmd: ClientCommand): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(cmd));
  }

  /** Low-level send for request/response envelopes (used by sync.ts). */
  sendRaw(envelope: { type: string; id?: string; payload?: unknown }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.ws.send(JSON.stringify(envelope));
  }

  /** Send a request envelope and await the ack response payload. */
  sendRequest(type: string, payload: any, timeoutMs = 25000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Connection is not open'));
        return;
      }
      const id = crypto.randomUUID();
      const timer = window.setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error(`Request ${type} timed out`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, (res: any) => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        resolve(res);
      });

      try {
        this.ws.send(JSON.stringify({ type, id, payload }));
      } catch (e) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(e);
      }
    });
  }

  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // ── Internal ─────────────────────────────────────────────────────

  /** Fully reset state and kill any live socket/timer. Safe to call any time. */
  private tearDown(): void {
    this.gen += 1; // invalidate any in-flight handlers from the previous socket
    this.forceClose = true;
    this.stopHeartbeat();
    this.stopStatusProbe();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    // Clear desktop liveness; it is only meaningful while a cloud socket is live.
    desktopOnline.set(null);
    for (const [id, resolve] of this.pendingRequests.entries()) {
      resolve({ ok: false, error: 'connection_lost' });
    }
    this.pendingRequests.clear();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.forceClose = false;
    this.currentEndpoint = null;
    this.alternateNext = false;
    this.backoffIdx = 0;
  }

  private buildUrl(rawHost: string, endpoint: 'cloud' | 'lan' | 'bridge'): { url: string; scheme: 'wss' | 'ws'; host: string } {
    // bridge/cloud = wss (TLS-terminated by the cloud proxy / Cloudflare).
    // lan = ws (plain origin, skipped on HTTPS pages).
    // The desktop sends cloud_url/cloudflared hosts *with* a scheme; strip it
    // first and re-derive the correct scheme from the endpoint so we never emit
    // a double scheme like `wss://http://host`.
    const { host: clean, scheme: sourceScheme } = normalizeWsHost(rawHost);
    const wantWss = endpoint !== 'lan';
    // If the source carried an explicit scheme, prefer its security (a plain
    // http:// cloud is still ws://, an https/wss cloudflared host stays wss).
    let scheme: 'wss' | 'ws' = wantWss ? 'wss' : 'ws';
    if (sourceScheme) scheme = sourceScheme;
    else if (!wantWss) scheme = 'ws';
    return { url: `${scheme}://${clean}`, scheme, host: clean };
  }

  private pickEndpoint(creds: Credentials): { host: string; kind: 'cloud' | 'lan' | 'bridge' } | null {
    // ws:// is mixed content on HTTPS pages and will be blocked by modern browsers.
    // Skip LAN (ws://) entirely when the page itself is served over HTTPS.
    const pageIsHttps = typeof location !== 'undefined' && location.protocol === 'https:';

    // Endpoint priority (most-resilient first):
    //   1. cloud_url (the "big server" bridge) — always-on, survives desktop
    //      outage; forwards live control when the desktop is online.
    //   2. cloud_host (the desktop's own cloudflared tunnel) — dies with the
    //      desktop but is otherwise a direct path.
    //   3. lan_host (same WiFi) — 0-latency fallback.
    // We prefer the bridge so phones keep working (and can reach the live
    // desktop) even when the desktop's tunnel/LAN is unreachable.
    //
    // CRITICAL: the desktop used to echo the cloud URL into BOTH cloud_url and
    // cloud_host. That made the two "endpoints" the *same host*, so the
    // alternateNext flip below would ping-pong between two identical sockets and
    // never settle into a stable open connection ("not connecting after cloud").
    // We now strip any scheme and treat two endpoints as distinct only if their
    // normalized host differs — so a bridge->cloud flip that leads back to the
    // same host is a no-op and we stay put (retry same host) instead of looping.

    const normHost = (h: string | null | undefined): string => {
      if (!h) return '';
      const { host } = normalizeWsHost(h);
      return host.toLowerCase();
    };
    const bridgeHost = normHost(creds.cloud_url);
    const cloudHost = normHost(creds.cloud_host);
    const lanHost = normHost(creds.lan_host);

    // When the alternateNext flip would just send us to an endpoint whose host
    // equals the one we're already on, do NOT switch — pick the still-available
    // distinct fallback instead, or (if none) stay on the current host.
    const distinctHosts = [bridgeHost, cloudHost].filter((h, i, a) => h && a.indexOf(h) === i);
    const bridgeIsDistinct = !!bridgeHost && distinctHosts.length > 1;
    const cloudIsDistinct = !!cloudHost && distinctHosts.length > 1;

    if (this.alternateNext) {
      this.alternateNext = false;
      // Bridge -> desktop cloud, but only if the desktop cloud is a DIFFERENT
      // host (otherwise we'd just reconnect to the same place).
      if (this.currentEndpoint === 'bridge' && creds.cloud_host && cloudIsDistinct) {
        console.info('[ws] endpoint: falling back from bridge to desktop cloud %s', creds.cloud_host);
        return { host: creds.cloud_host, kind: 'cloud' };
      }
      // Desktop cloud -> LAN (distinct only if LAN is a different host).
      if (this.currentEndpoint === 'cloud' && creds.lan_host && !pageIsHttps && lanHost !== cloudHost) {
        console.info('[ws] endpoint: falling back to LAN %s', creds.lan_host);
        return { host: creds.lan_host, kind: 'lan' };
      }
      // LAN -> back to desktop cloud (distinct).
      if (this.currentEndpoint === 'lan' && creds.cloud_host && lanHost !== cloudHost) {
        console.info('[ws] endpoint: switching back to desktop cloud %s', creds.cloud_host);
        return { host: creds.cloud_host, kind: 'cloud' };
      }
      // LAN -> back to bridge (distinct).
      if (this.currentEndpoint === 'lan' && creds.cloud_url && lanHost !== bridgeHost) {
        console.info('[ws] endpoint: switching back to cloud bridge %s', creds.cloud_url);
        return { host: creds.cloud_url, kind: 'bridge' };
      }
      // Both cloud endpoints are the same host: alternateNext should NOT move us
      // to the identical host. Re-open the current (or bridge) endpoint so the
      // retry makes progress instead of looping forever.
      if (creds.cloud_url && !this._bridgeBlocked && !this._serverUnregistered) {
        console.info('[ws] endpoint: bridge/cloud share a host — staying on cloud bridge %s', creds.cloud_url);
        return { host: creds.cloud_url, kind: 'bridge' };
      }
      if (creds.cloud_host) {
        console.info('[ws] endpoint: staying on desktop cloud %s', creds.cloud_host);
        return { host: creds.cloud_host, kind: 'cloud' };
      }
      if (creds.lan_host && !pageIsHttps) {
        return { host: creds.lan_host, kind: 'lan' };
      }
    }

    // The bridge is *available* but recently rejected this device with
    // `revoked` (the cloud doesn't know us yet). Don't immediately re-choose it
    // or we'd spin forever on "Closed (bridge)". Prefer the desktop's own
    // tunnel/LAN for now; the cooldown below lets the desktop's device push
    // catch up and we retry the bridge after the window elapses.
    const bridgeUrl = creds.cloud_url;
    const bridgeCoolingDown =
      bridgeUrl && this._bridgeBlocked === false &&
      Date.now() - this._lastBridgeRevoked < RemoteClient.BRIDGE_REVOKED_COOLDOWN_MS;

    if (bridgeCoolingDown) {
      console.info('[ws] endpoint: bridge recently revoked (cooldown) — using desktop fallback');
      // Only fall back to cloud_host if it's a DIFFERENT host than the bridge;
      // otherwise we'd still be retrying the (revoked) cloud.
      if (creds.cloud_host && cloudHost !== bridgeHost) {
        return { host: creds.cloud_host, kind: 'cloud' };
      }
      if (creds.lan_host && !pageIsHttps && lanHost !== bridgeHost) {
        return { host: creds.lan_host, kind: 'lan' };
      }
      // No distinct desktop fallback at all: the bridge is the only path, so we
      // must try it (better a retry than a permanent dead-end). Don't hard-block.
      if (this._bridgeBlocked) {
        return { host: bridgeUrl, kind: 'bridge' };
      }
    }

    if (creds.cloud_url && !this._bridgeBlocked) {
      console.info('[ws] endpoint: using cloud bridge %s', creds.cloud_url);
      return { host: creds.cloud_url, kind: 'bridge' };
    }
    if (creds.cloud_host) {
      console.info('[ws] endpoint: using desktop cloud %s', creds.cloud_host);
      return { host: creds.cloud_host, kind: 'cloud' };
    }
    if (creds.lan_host && !pageIsHttps) {
      console.info('[ws] endpoint: using LAN %s', creds.lan_host);
      return { host: creds.lan_host, kind: 'lan' };
    }
    console.warn('[ws] endpoint: no usable endpoint (cloud_url=%s cloud_host=%s lan_host=%s pageHttps=%s)', creds.cloud_url, creds.cloud_host, creds.lan_host, pageIsHttps);
    return null;
  }

  private openSocket(creds: Credentials, pairToken: string | null): void {
    const pick = this.pickEndpoint(creds);
    if (!pick) {
      connStatus.set('error');
      connError.set('No endpoint (cloud or LAN) available');
      return;
    }

    // Each socket carries a generation id; all handlers bail out if gen bumped.
    const myGen = ++this.gen;
    this.currentEndpoint = pick.kind;
    connEndpoint.set(pick.kind);
    connStatus.set('connecting');
    connError.set(null);
    // Probe the cloud bridge liveness for the Settings dot (and to refine
    // desktopOnline even when we're currently on the desktop's own tunnel).
    this.startStatusProbe(myGen);

    let ws: WebSocket;
    let authenticated = false;
    const built = this.buildUrl(pick.host, pick.kind);
    try {
      console.info('[ws] building %s socket -> %s (host=%s)', pick.kind, built.url, built.host);
      pushCloudDiagnostic('endpoint', `Connecting via ${pick.kind}`, `ws=${built.url}`);
      ws = new WebSocket(built.url);
    } catch (e: any) {
      connStatus.set('error');
      connError.set(e?.message ?? 'WebSocket failed to open');
      pushCloudDiagnostic('error', `Failed to open ${pick.kind} socket`, e?.message ?? String(e));
      this.scheduleReconnect(creds, myGen);
      return;
    }

    this.ws = ws;
    const isCurrent = () => this.gen === myGen && this.ws === ws;

    // While connected through a cloud path we know whether the *desktop* is up
    // only once the server tells us. Default to "unknown" (not null, which the
    // UI reads as LAN); the probe/auth.ok/status_changed will refine it.
    if (pick.kind === 'bridge' || pick.kind === 'cloud') {
      desktopOnline.set(null);
    }

    // Handshake deadline: if onopen doesn't fire within CONNECT_TIMEOUT_MS
    // (e.g. a cloudflared tunnel that accepts the upgrade then stalls, never
    // delivering onopen OR onclose), force the socket closed so onclose runs
    // the normal reconnect path. Without this, connStatus sticks at
    // 'connecting' indefinitely and connect() short-circuits on every retry.
    // Reconnects (already-paired, holding a device token) get more grace than
    // first-pair: a cold Cloudflare TLS handshake can take seconds, and
    // force-closing it prematurely is what caused the endless bridge/cloud flap.
    const handshakeTimeout =
      pairToken == null ? CONNECT_TIMEOUT_MS_RECONNECT : CONNECT_TIMEOUT_MS;
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => {
      if (!isCurrent()) return;
      if (ws.readyState === WebSocket.OPEN) return; // opened, just racing
      console.warn('[ws] Connect handshake timed out; closing to trigger reconnect.');
      connError.set('Connection timed out');
      try { ws.close(); } catch { /* ignore */ }
    }, handshakeTimeout);

    ws.onopen = () => {
      if (!isCurrent()) return;
      // Handshake completed — disarm the connect timer.
      if (this.connectTimer !== null) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      console.info('[ws] socket opened to %s (%s)', pick.host, pick.kind);
      connStatus.set('authenticating');
      const payload = pairToken
        ? {
            pair_token: pairToken,
            device_id: creds.device_id,
            device_name: creds.device_name,
            platform: navigator.platform || 'web',
            ...(creds.server_id ? { server_id: creds.server_id } : {}),
          }
        : {
            device_id: creds.device_id,
            device_token: creds.device_token,
            ...(creds.server_id ? { server_id: creds.server_id } : {}),
          };
      try { ws.send(JSON.stringify({ type: 'auth', payload })); } catch { /* ignore */ }
      if (this.authTimer !== null) clearTimeout(this.authTimer);
      this.authTimer = window.setTimeout(() => {
        if (!isCurrent()) return;
        // Silent auth timeout (auth sent, no auth.ok/auth.fail reply) is the
        // signature of a server that never decoded our frame. Surface it so a
        // future hang is self-explanatory instead of an infinite "Authenticating".
        console.warn('[ws] auth timed out on %s (%s) — sent auth but got no reply in %dms', pick.host, pick.kind, AUTH_TIMEOUT_MS);
        pushCloudDiagnostic('error', `Auth timed out on ${pick.kind}`, `Sent auth to ${pick.host} but received no reply in ${AUTH_TIMEOUT_MS}ms — server may not be decoding frames`);
        connError.set('Authentication timed out — server did not respond');
        try { ws.close(); } catch { /* ignore */ }
      }, AUTH_TIMEOUT_MS);
    };

    ws.onmessage = (ev) => {
      if (!isCurrent()) return;
      this.lastMessageTime = Date.now();
      let msg: Envelope;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        // Malformed server reply — log it so we can see what the server sent.
        const snippet = typeof ev.data === 'string' ? ev.data.slice(0, 200) : `[${typeof ev.data}]`;
        console.warn('[ws] received non-JSON message from %s (%s): %s', pick?.host ?? this.currentEndpoint, this.currentEndpoint, snippet);
        return;
      }

      if (msg.type === 'pong') {
        return;
      }

      if (msg.type === 'auth.ok') {
        authenticated = true;
        if (this.authTimer !== null) { clearTimeout(this.authTimer); this.authTimer = null; }
        // Successful auth clears any bridge-revoked block: now that this
        // endpoint accepted us, the cloud knows the device, so future bridge
        // attempts are fine again (incl. when the desktop later goes offline).
        if (this._bridgeBlocked) {
          console.info('[ws] auth.ok cleared bridge-revoked block (endpoint=%s)', this.currentEndpoint);
          this._bridgeBlocked = false;
          this._lastBridgeRevoked = 0;
        }
        // A successful bridge auth proves the server re-registered with the
        // cloud — resume using the bridge (drop the unregistered block). A
        // success on the desktop tunnel doesn't prove re-registration, so only
        // clear this on the bridge.
        if (this._serverUnregistered && this.currentEndpoint === 'bridge') {
          console.info('[ws] auth.ok (bridge) cleared server-unregistered block');
          this._serverUnregistered = false;
        }
        // Successful auth — clear any prior wrong_server switch attempts so a
        // future wrong_server (in a later session) can try the same server again.
        this._wrongServerTried.clear();
        const p = (msg.payload ?? {}) as AuthOk;
        const authoritativeServerId = (p.server_id ?? creds.server_id ?? '').trim() || undefined;
        // The cloud server is authoritative for its own public URL. Capture it
        // straight from auth.ok (in case it arrived before any server.url_changed)
        // so the phone always knows the bridge to fall back to when the desktop
        // closes. Prefer an explicit value; otherwise keep whatever we had.
        const cloudUrlFromAuth = p.cloud_url ?? p.cloud_host ?? null;
        const finalCreds: Credentials = {
          ...creds,
          server_key: creds.server_key,
          server_id: authoritativeServerId,
          device_token: pairToken ? p.device_token : creds.device_token,
          server_name: p.server_name,
          paired_at: creds.paired_at ?? Date.now(),
          can_edit_keys: !!p.can_edit_keys,
          can_edit_songs: !!p.can_edit_songs,
          // cloud_host is the desktop's OWN tunnel (scanned from the QR `c`
          // param) — a distinct host from the cloud bridge (`cloud_url`). The
          // cloud server only knows its own public URL, so it must NOT be
          // allowed to overwrite cloud_host with it. Keep the tunnel if we have
          // one; only fall back to the cloud URL if we genuinely have no tunnel.
          cloud_host: creds.cloud_host || cloudUrlFromAuth || null,
          cloud_url: p.cloud_url ?? creds.cloud_url ?? null,
          cloud_id: p.cloud_id ?? creds.cloud_id ?? null,
        };
        exclusiveDeviceId.set(p.exclusive_device_id ?? null);
        exclusiveDeviceName.set(null);
        serverName.set(p.server_name || 'ChurchPresenter');
        canEditKeys.set(!!p.can_edit_keys);
        canEditSongs.set(!!p.can_edit_songs);
        // Cloud bridge tells us whether the live desktop is up. `connEndpoint`
        // is 'bridge' when we reached the cloud "big server" and 'cloud' when
        // we reached the desktop's own tunnel. In both cloud cases the field
        // (if present) reflects the live desktop; direct LAN has none.
        if (
          (this.currentEndpoint === 'bridge' || this.currentEndpoint === 'cloud') &&
          typeof p.desktop_online === 'boolean'
        ) {
          desktopOnline.set(p.desktop_online);
          console.info('[ws] auth.ok via %s: desktop_online=%s server=%s', this.currentEndpoint, p.desktop_online, p.server_name);
        } else {
          desktopOnline.set(null);
          console.info('[ws] auth.ok via %s: server=%s (no cloud desktop liveness)', this.currentEndpoint, p.server_name);
        }
        this.backoffIdx = 0;

        // Persist credentials first so they survive a reload triggered by a
        // service-worker update, then mark the authenticated socket usable.
        // Offline replay is best-effort and must not keep the UI connecting.
        void (async () => {
          try {
            await saveCredentials(finalCreds);

            if (!isCurrent()) return;
            connStatus.set('open');
            connError.set(null);
            this.startHeartbeat(myGen, ws);
          } catch (err) {
            console.warn('[ws] Failed to persist credentials:', err);
            if (isCurrent()) {
              connStatus.set('error');
              connError.set('Failed to save pairing on this device');
            }
            return;
          }

          try {
            const { flushPendingLists } = await import('./sync');
            await flushPendingLists();
            pendingSyncError.set(null);
            const mutations = await getPendingMutations();
            for (const m of mutations) {
              if (!isCurrent() || ws.readyState !== WebSocket.OPEN) return;
              if (m.type.startsWith('list.')) continue;          // already flushed above
              const ack = await this.sendRequest(m.type, m.payload, 15000);
              if (ack?.ok !== false) {
                await deletePendingMutation(m.id);
              }
            }
          } catch (err) {
            // Pending-list sync failed (server unavailable, missing confirmation, …).
            // Keep mutations in IDB so the next reconnect retries them. Surface to UI.
            const msg = err instanceof Error ? err.message : String(err);
            console.warn('[ws] Pending list sync failed (will retry next connect):', msg);
            pendingSyncError.set(msg ?? 'pending-list sync failed');
          }
        })();
        return;
      }

      if (msg.type === 'auth.fail') {
        if (this.authTimer !== null) { clearTimeout(this.authTimer); this.authTimer = null; }
        const p = (msg.payload ?? {}) as AuthFail;
        if (p.reason === 'server_unregistered') {
          // The desktop deliberately unregistered from the cloud (cloud sync
          // disabled). The bridge will keep rejecting us until it re-registers,
          // so stop using the bridge and rotate to our stored Cloudflare/LAN
          // fallback — keeping the pairing intact (unlike `revoked`). This is
          // the desired swap from "Desktop is offline" to the live desktop.
          console.warn('[ws] server unregistered from cloud — blocking bridge + using desktop fallback');
          this._serverUnregistered = true;
          this._bridgeBlocked = true;
          this._lastBridgeRevoked = Date.now();
          this.forceClose = true;
          try { ws.close(); } catch { /* ignore */ }
          connStatus.set('connecting');
          connError.set(null);
          void this.reconnectActive();
        } else if (p.reason === 'revoked') {
          // Server explicitly kicked this device. There are two very different
          // situations here:
          //   1. The device was genuinely removed from the desktop's paired
          //      list — we should drop this server entry.
          //   2. We just paired against the desktop tunnel and the desktop
          //      handed us the cloud bridge URL, but the cloud hasn't learned
          //      about this device yet (its registry is pushed on a timer /
          //      race). The bridge then rejects us with `revoked`. Deleting the
          //      just-paired server here is the "back to Choose a server" bug.
          // If we're on the bridge and the desktop's own tunnel (cloud_host) is
          // still available, treat this as a transient bridge miss: block the
          // bridge briefly + fall back to the desktop tunnel instead of wiping
          // the pairing. A genuine revoke while on the desktop tunnel still
          // deletes as before.
          if (
            this.currentEndpoint === 'bridge' &&
            creds.cloud_host &&
            (this.forceClose === false)
          ) {
            console.warn('[ws] revoked on bridge but desktop tunnel available — blocking bridge + falling back instead of deleting');
            // Mark the bridge as blocked and start the cooldown so
            // pickEndpoint() stops re-choosing it on the next immediate retry
            // (which would just get `revoked` again and pin us at
            // "Closed (bridge)"). The desktop's periodic device push teaches the
            // cloud about this phone; after the cooldown we retry the bridge.
            this._bridgeBlocked = true;
            this._lastBridgeRevoked = Date.now();
            this.forceClose = true;
            try { ws.close(); } catch { /* ignore */ }
            connStatus.set('connecting');
            connError.set(null);
            void this.reconnectActive();
          } else {
            connStatus.set('error');
            this.forceClose = true;
            try { ws.close(); } catch { /* ignore */ }
            void clearCredentials();
            connError.set('Device revoked by server');
          }
        } else if (p.reason === 'bad_token') {
          // Token mismatch for the selected server. Do not try other stored
          // servers implicitly; the user chooses the active server now.
          this.forceClose = true;
          try { ws.close(); } catch { /* ignore */ }
          connStatus.set('error');
          connError.set('This server rejected the saved pairing. Choose another server or scan a new QR code.');
        } else if (p.reason === 'wrong_server') {
          // Server reports a different identity than our stored creds.
          // Try to auto-switch to a stored server entry whose server_id matches
          // the server's reported identity. If we can't find one (or we already
          // tried switching and it didn't help), surface a clear re-pair CTA.
          //
          // Critical: never auto-delete stored servers on wrong_server — the
          // device_token may simply be stale for this backend of a shared
          // cloudflared hostname, and the same stored entry could still work
          // against another backend or after a re-pair.
          if (this.authTimer !== null) { clearTimeout(this.authTimer); this.authTimer = null; }
          const serverHint = p.server_id;
          // Bump gen so this socket's onclose doesn't schedule a reconnect
          // with the (wrong) creds we just used. Capture it as our own
          // "current" gen for the async chain below.
          const switchGen = ++this.gen;
          try { ws.close(); } catch { /* ignore */ }
          this.ws = null;

          void (async () => {
            if (serverHint) {
              try {
                const all = await loadAllServers();
                if (this.gen !== switchGen) return; // superseded while awaiting
                const match = all.find(
                  (s) =>
                    s.server_id === serverHint &&
                    s.server_id !== creds.server_id &&
                    !this._wrongServerTried.has(s.server_key),
                );
                if (match) {
                  this._wrongServerTried.add(match.server_key);
                  console.info(
                    `[ws] wrong_server: auto-switching to stored server "${match.server_name || match.server_key}" (id=${serverHint.slice(0, 8)})`,
                  );
                  await switchServer(match.server_key);
                  if (this.gen !== switchGen) return; // superseded while awaiting
                  connStatus.set('connecting');
                  connError.set(null);
                  // reconnectActive() will call openSocket() which bumps gen
                  // again and creates the new socket — our async chain stops here.
                  await this.reconnectActive();
                  return;
                }
              } catch (err) {
                console.warn('[ws] wrong_server auto-switch failed:', err);
              }
            }
            // No eligible stored match — surface a clear re-pair message.
            if (this.gen !== switchGen) return; // superseded by another switch
            this.forceClose = true;
            connStatus.set('error');
            connError.set(
              'This pairing belongs to a different desktop. Open Settings → Servers and pick the matching one, or scan this desktop QR again.',
            );
          })();
        } else {
          connStatus.set('error');
          this.forceClose = true;
          try { ws.close(); } catch { /* ignore */ }
          if (pairToken && creds.server_key) {
            void removeUnpairedServer(creds.server_key);
          }
          connError.set(`Auth failed: ${p.reason}`);
        }
        return;
      }

      if (msg.type === 'live.state') {
        liveState.set(msg.payload as LiveState);
        return;
      }

      if (msg.type === 'queue.state') {
        // While this device is mid-drag reordering, ignore echoes so a re-render
        // can't corrupt the drop-index calculation (see queue/+page.svelte).
        if (get(queueDragActive)) return;
        const qs = msg.payload as QueueState;
        queueState.set(qs);
        void cacheQueueState(qs);
        return;
      }

      if (msg.type === 'lists.state') {
        const p = msg.payload as ListsState;
        const lists = p?.lists ?? [];
        void (async () => {
          if (!isCurrent()) return;
          const merged = await mergeServerLists(lists);
          if (!isCurrent()) return;
          listsStore.set(merged);
        })().catch((err) => {
          console.warn('[ws] Failed to cache list state:', err);
        });
        return;
      }

      if (msg.type === 'device.exclusive_changed') {
        const p = msg.payload as ExclusiveChanged;
        exclusiveDeviceId.set(p.exclusive_device_id ?? null);
        exclusiveDeviceName.set(p.device_name ?? null);
        return;
      }

      if (msg.type === 'device.permission_changed') {
        const p = msg.payload as { can_edit_keys: boolean; can_edit_songs: boolean };
        canEditKeys.set(!!p.can_edit_keys);
        canEditSongs.set(!!p.can_edit_songs);
        void (async () => {
          const c = await loadCredentials();
          if (c && isCurrent()) {
            c.can_edit_keys = !!p.can_edit_keys;
            c.can_edit_songs = !!p.can_edit_songs;
            await saveCredentials(c);
          }
        })();
        return;
      }

      if (msg.type === 'ack') {
        const id = msg.id;
        if (id) {
          const resolver = this.pendingRequests.get(id);
          if (resolver) {
            resolver(msg.payload);
            return;
          }
        }
      }

      if (msg.type === 'song.key_changed') {
        const p = msg.payload as { song_path: string; key: string | null; key_ts?: number | null };
        import('./sync').then(({ applyRemoteKeyChange }) => {
          void applyRemoteKeyChange(p.song_path, p.key, p.key_ts);
        });
        return;
      }

      if (msg.type === 'library.changed') {
        console.info('[ws] library.changed received — triggering syncNow()');
        import('./sync').then(({ syncNow }) => {
          void syncNow();
        });
        return;
      }

      if (msg.type === 'sync.full' || msg.type === 'sync.delta') {
        handleSyncMessage(msg as any);
        return;
      }

      if (msg.type === 'device.revoked') {
        this.forceClose = true;
        void clearCredentials();
        connError.set('Device revoked from desktop');
        connStatus.set('error');
        return;
      }

      if (msg.type === 'server.url_changed') {
        const p = msg.payload as { cloud_host?: string; cloud_url?: string; cloud_id?: string };
        if (isCurrent()) {
          const cloudUrl = p?.cloud_url ?? p?.cloud_host ?? null;
          console.info('[ws] server.url_changed: cloud_url=%s cloud_id=%s', cloudUrl, p?.cloud_id);
          void (async () => {
            const c = await loadCredentials();
            if (!c || !isCurrent()) return;
            c.cloud_host = p?.cloud_host ?? c.cloud_host ?? null;
            c.cloud_url = cloudUrl ?? c.cloud_url ?? null;
            c.cloud_id = p?.cloud_id ?? c.cloud_id ?? null;
            await saveCredentials(c);
            // If the desktop just told us it has a cloud bridge, switch to the
            // bridge so library/queue/lists (and live control, when the desktop
            // is online) go through it — BUT only when we are not already on
            // that same bridge host. Reconnecting to the identical host every
            // time this message arrives is what caused the old bridge↔cloud
            // ping-pong: server.url_changed flipped us to the bridge, then
            // alternateNext (set on close) flipped us straight back to the
            // tunnel, which re-sent server.url_changed, and so on forever.
            if (cloudUrl && this.currentEndpoint !== 'bridge') {
              const current = this.ws?.url ? normalizeWsHost(this.ws.url).host.toLowerCase() : '';
              const target = normalizeWsHost(cloudUrl).host.toLowerCase();
              if (current === target) {
                // Same host we're already connected to — nothing to do. Keep the
                // bridge as the preferred endpoint so alternateNext doesn't
                // bounce us back to the tunnel on the next reconnect.
                console.info('[ws] server.url_changed: already on bridge host %s — staying put', target);
                this.currentEndpoint = 'bridge';
                this.alternateNext = false;
                return;
              }
              console.info('[ws] server gained cloud bridge on new host %s — reconnecting to it', target);
              this.currentEndpoint = 'bridge';
              this.alternateNext = false;
              void this.reconnectActive();
            }
          })();
        }
        return;
      }

      if (msg.type === 'server.status_changed') {
        // Desktop liveness on the cloud bridge flipped (e.g. the live desktop
        // went offline or came back, via /api/heartbeat or TTL expiry). Only
        // meaningful while we're connected through a cloud path.
        if (isCurrent() && (this.currentEndpoint === 'bridge' || this.currentEndpoint === 'cloud')) {
          const p = msg.payload as { desktop_online?: boolean };
          if (typeof p.desktop_online === 'boolean') {
            console.info('[ws] desktop_online changed -> %s (%s)', p.desktop_online, this.currentEndpoint);
            desktopOnline.set(p.desktop_online);
          }
        }
        return;
      }

      if (msg.type === 'server.unregistered') {
        // The desktop just disabled cloud sync. We're currently on the bridge
        // (or cloud path), so rotate NOW to the stored Cloudflare/LAN fallback
        // before the bridge closes under us — keeping the pairing intact.
        if (isCurrent() && (this.currentEndpoint === 'bridge' || this.currentEndpoint === 'cloud')) {
          console.warn('[ws] server.unregistered broadcast — rotating to desktop fallback');
          this._serverUnregistered = true;
          this._bridgeBlocked = true;
          this._lastBridgeRevoked = Date.now();
          this.forceClose = true;
          try { ws.close(); } catch { /* ignore */ }
          connStatus.set('connecting');
          desktopOnline.set(null);
          void this.reconnectActive();
        }
        return;
      }
    };

    ws.onerror = () => {
      if (!isCurrent()) return;
      connError.set('Connection error');
    };

    ws.onclose = (ev?: CloseEvent) => {
      // Stale close (from a previous socket we superseded): ignore completely.
      if (!isCurrent()) return;
      if (this.authTimer !== null) { clearTimeout(this.authTimer); this.authTimer = null; }
      if (this.connectTimer !== null) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.ws = null;
      if (pairToken && !authenticated) {
        // Pairing socket closed before auth completed. Always surface an
        // error so the pair page's spinner (phase='pairing') resolves and the
        // user can re-scan. Using 'closed' here (the old behaviour under
        // forceClose) left the user permanently stuck on "pairing…".
        if (creds.server_key) void removeUnpairedServer(creds.server_key);
        connStatus.set('error');
        connError.set(
          this.forceClose
            ? 'Pairing failed — connection closed'
            : 'Pairing connection closed before it finished'
        );
        return;
      }
      if (this.forceClose) {
        connStatus.set('closed');
        return;
      }
      // Surface the close code/reason so a flapping socket is diagnosable
      // instead of a silent infinite "reconnecting" spin. 1000 = clean,
      // 1006 = abnormal (proxy/TLS dropped the upgrade — the classic
      // nginx-without-Upgrade-headers symptom).
      const code = ev?.code;
      if (code !== undefined && code !== 1000 && code !== 1005) {
        connError.set(`Connection closed (code ${code}${ev?.reason ? ': ' + ev.reason : ''}) — retrying`);
      }
      connStatus.set('closed');
      this.scheduleReconnect(creds, myGen);
    };
  }

  private scheduleReconnect(creds: Credentials, myGen: number): void {
    if (this.forceClose) return;
    if (this.gen !== myGen) return; // superseded; do nothing
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.backoffIdx, RECONNECT_BACKOFF_MS.length - 1)];
    this.backoffIdx += 1;
    // Only flip to an alternate endpoint when the socket we just lost was a
    // FALLBACK (desktop tunnel / LAN), so we migrate back toward the preferred
    // cloud bridge. If we were already on the bridge, never flip to the tunnel
    // — that was the old bridge<->cloud ping-pong: a bridge close with even
    // backoff parity flipped us to the tunnel, which re-sent server.url_changed,
    // flipping us back to the bridge, forever. A healthy bridge that drops
    // should simply be retried, not bounce to the tunnel.
    this.alternateNext = this.currentEndpoint !== 'bridge' && this.backoffIdx % 2 === 0;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.gen !== myGen) return;
      loadCredentials().then((fresh) => {
        if (this.gen !== myGen) return;
        if (fresh && fresh.device_token) this.openSocket(fresh, null);
      });
    }, delay);
  }

  private startHeartbeat(myGen: number, ws: WebSocket): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
    }
    this.lastMessageTime = Date.now();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.gen !== myGen || this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }
      const now = Date.now();
      if (now - this.lastMessageTime > 30000) {
        console.warn('[ws] Heartbeat lost. Closing connection.');
        this.stopHeartbeat();
        try {
          ws.close();
        } catch { /* ignore */ }
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* ignore */
      }
    }, 10000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Cloud bridge status probe ──────────────────────────────────────
  // Every STATUS_PROBE_MS we GET {cloud_url}/api/status. This keeps the
  // per-server status dot in Settings accurate and lets the LIVE tab disable
  // its buttons when the desktop is offline, even if we're connected through
  // a different transport (desktop tunnel / LAN) right now.
  private async startStatusProbe(myGen: number): Promise<void> {
    this.stopStatusProbe();
    const creds = await loadCredentials();
    if (!creds || !creds.cloud_url) return;
    const cloudUrl = creds.cloud_url;
    const serverKey = creds.server_key;
    const apply = async () => {
      if (this.gen !== myGen) return;
      await this.probeCloudStatus(cloudUrl, serverKey);
    };
    await apply();
    this.statusProbeTimer = window.setInterval(apply, RemoteClient.STATUS_PROBE_MS);
  }

  private stopStatusProbe(): void {
    if (this.statusProbeTimer !== null) {
      clearInterval(this.statusProbeTimer);
      this.statusProbeTimer = null;
    }
  }

  private async probeCloudStatus(cloudUrl: string, serverKey: string | undefined): Promise<void> {
    // cloudUrl arrives *with* a scheme (desktop sends `http://host:port` from
    // cloud_sync._normalize_cloud_url, or a `wss://`/cloudflared host). The
    // cloud server is a plain `http.createServer`, so a scheme-less or `http://`
    // cloud must be probed over `http://` — NOT `https://`. Building the probe
    // from the source scheme (via normalizeWsHost) means a plain-HTTP cloud is
    // probed over http and a cloudflared/wss cloud over https. We also append
    // `server_id` so the bridge can report whether the *desktop* is live.
    const { host, scheme } = normalizeWsHost(cloudUrl);
    const httpScheme = scheme === 'wss' ? 'https' : 'http';
    const serverId = (await loadCredentials())?.server_id ?? '';
    const query = serverId ? `?server_id=${encodeURIComponent(serverId)}` : '';
    const probeUrl = `${httpScheme}://${host}/api/status${query}`;
    try {
      console.info('[ws] probing cloud status -> %s', probeUrl);
      pushCloudDiagnostic('status', `Probing ${probeUrl}`);
      const res = await fetch(probeUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        pushCloudDiagnostic('error', `Cloud status probe returned HTTP ${res.status}`, probeUrl);
        // A probe miss must NEVER tear down an established socket — that's what
        // made the phone appear to "reconnect forever" when only the probe path
        // was unhealthy. The live connection is the source of truth for usability.
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        await setServerCloudStatus(serverKey ?? '', 'offline');
        return;
      }
      const data = (await res.json()) as {
        online?: boolean;
        desktop_online?: boolean;
        server_ts?: number;
      };
      const bridgeUp = data.online !== false;
      await setServerCloudStatus(serverKey ?? '', bridgeUp ? 'online' : 'offline');
      pushCloudDiagnostic('status', `Cloud status OK (online=${bridgeUp}, desktop_online=${data.desktop_online})`, probeUrl);
      // If we're currently connected through a cloud path, reflect the
      // desktop liveness the bridge reports.
      if (this.currentEndpoint === 'bridge' || this.currentEndpoint === 'cloud') {
        desktopOnline.set(data.desktop_online === true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Network error reaching the bridge — cloud itself is unreachable.
      pushCloudDiagnostic('error', `Cloud status probe failed: ${msg}`, probeUrl);
      // Don't flip the status dot to offline if a real socket is live; the probe
      // path can fail independently of the control socket.
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      await setServerCloudStatus(serverKey ?? '', 'offline');
    }
  }
}

export const remote = new RemoteClient();
