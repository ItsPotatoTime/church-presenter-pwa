// WebSocket client with cloud-first / LAN-fallback reconnect.
// Authenticates via pair_token (first pair) or device_token (reconnect).
// Pushes updates into stores.ts.
//
// Each open socket gets a generation id; every handler is guarded so that a
// late event from a previous socket can never corrupt the current state.

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
  clearPendingMutations,
  getPendingMutations,
  getOrCreateDeviceId,
  loadAllServers,
  loadCredentials,
  saveCredentials,
  switchServer,
  type Credentials,
} from './db';
import {
  connStatus,
  connEndpoint,
  connError,
  exclusiveDeviceId,
  exclusiveDeviceName,
  serverName,
} from './stores';
import { handleSyncMessage } from './sync';

const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 15000];
const AUTH_TIMEOUT_MS = 8000;

export type PairParams = {
  pair_token: string;
  cloud_host: string | null;
  lan_host: string | null;
};

class RemoteClient {
  private ws: WebSocket | null = null;
  private gen = 0; // incremented every time we (re)create a socket
  private backoffIdx = 0;
  private reconnectTimer: number | null = null;
  private forceClose = false;
  private currentEndpoint: 'cloud' | 'lan' | null = null;
  private alternateNext = false;
  private authTimer: number | null = null;
  // Tracks server_key values tried in the current connection cycle.
  // Prevents infinite loops when all paired servers reject us.
  private _triedServerKeys = new Set<string>();

  constructor() {
    // iOS Safari kills WebSockets when the PWA moves to background.
    // On return to foreground, reconnect immediately instead of waiting for the backoff timer.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (this.forceClose) return;
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
        // Cancel any pending backoff timer so we reconnect now, not after the delay.
        if (this.reconnectTimer !== null) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.backoffIdx = 0; // reset backoff on foreground
        void this.connect();
      });
    }
    // When the device regains network access, reconnect immediately.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (this.forceClose) return;
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
        if (this.reconnectTimer !== null) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.backoffIdx = 0; // reset backoff on network restore
        void this.connect();
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
    this.tearDown();
    const creds = await loadCredentials();
    if (!creds || !creds.device_token) {
      connStatus.set('idle');
      return;
    }
    this.openSocket(creds, null);
  }

  async pair(params: PairParams, deviceName: string): Promise<void> {
    this.tearDown();
    const device_id = await getOrCreateDeviceId();
    const provisional: Credentials = {
      device_id,
      device_token: '',
      device_name: deviceName,
      cloud_host: params.cloud_host,
      lan_host: params.lan_host,
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

  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // ── Internal ─────────────────────────────────────────────────────

  /** Fully reset state and kill any live socket/timer. Safe to call any time. */
  private tearDown(): void {
    this.gen += 1; // invalidate any in-flight handlers from the previous socket
    this.forceClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.forceClose = false;
    this.currentEndpoint = null;
    this.alternateNext = false;
    this.backoffIdx = 0;
    this._triedServerKeys.clear();
  }

  private buildUrl(host: string, endpoint: 'cloud' | 'lan'): string {
    // cloud = wss (Cloudflare terminates TLS). lan = ws (plain origin).
    const scheme = endpoint === 'cloud' ? 'wss' : 'ws';
    return `${scheme}://${host}`;
  }

  private pickEndpoint(creds: Credentials): { host: string; kind: 'cloud' | 'lan' } | null {
    // ws:// is mixed content on HTTPS pages and will be blocked by modern browsers.
    // Skip LAN (ws://) entirely when the page itself is served over HTTPS.
    const pageIsHttps = typeof location !== 'undefined' && location.protocol === 'https:';

    if (this.alternateNext) {
      this.alternateNext = false;
      if (this.currentEndpoint === 'cloud' && creds.lan_host && !pageIsHttps) {
        return { host: creds.lan_host, kind: 'lan' };
      }
      if (this.currentEndpoint === 'lan' && creds.cloud_host) {
        return { host: creds.cloud_host, kind: 'cloud' };
      }
    }
    if (creds.cloud_host) return { host: creds.cloud_host, kind: 'cloud' };
    if (creds.lan_host && !pageIsHttps) return { host: creds.lan_host, kind: 'lan' };
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

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.buildUrl(pick.host, pick.kind));
    } catch (e: any) {
      connStatus.set('error');
      connError.set(e?.message ?? 'WebSocket failed to open');
      this.scheduleReconnect(creds, myGen);
      return;
    }

    this.ws = ws;
    const isCurrent = () => this.gen === myGen && this.ws === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      connStatus.set('authenticating');
      const payload = pairToken
        ? {
            pair_token: pairToken,
            device_id: creds.device_id,
            device_name: creds.device_name,
            platform: navigator.platform || 'web',
          }
        : {
            device_id: creds.device_id,
            device_token: creds.device_token,
          };
      try { ws.send(JSON.stringify({ type: 'auth', payload })); } catch { /* ignore */ }
      if (this.authTimer !== null) clearTimeout(this.authTimer);
      this.authTimer = window.setTimeout(() => {
        if (!isCurrent()) return;
        connError.set('Auth timed out');
        try { ws.close(); } catch { /* ignore */ }
      }, AUTH_TIMEOUT_MS);
    };

    ws.onmessage = (ev) => {
      if (!isCurrent()) return;
      let msg: Envelope;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }

      if (msg.type === 'auth.ok') {
        if (this.authTimer !== null) { clearTimeout(this.authTimer); this.authTimer = null; }
        const p = (msg.payload ?? {}) as AuthOk;
        const finalCreds: Credentials = {
          ...creds,
          device_token: pairToken ? p.device_token : creds.device_token,
          server_name: p.server_name,
          paired_at: creds.paired_at ?? Date.now(),
        };
        this._triedServerKeys.clear(); // successful auth — reset cycling state
        exclusiveDeviceId.set(p.exclusive_device_id ?? null);
        exclusiveDeviceName.set(null);
        serverName.set(p.server_name || 'ChurchPresenter');
        this.backoffIdx = 0;

        // Persist credentials first, THEN flush mutations, THEN mark open.
        // Keeping this sequential ensures credentials survive a page reload
        // triggered by a service-worker update between auth.ok and navigation.
        void (async () => {
          try {
            await saveCredentials(finalCreds);
          } catch { /* ignore — non-fatal; reconnect will retry */ }
          try {
            const mutations = await getPendingMutations();
            for (const m of mutations) {
              if (!isCurrent() || ws.readyState !== WebSocket.OPEN) return;
              ws.send(JSON.stringify({ type: m.type, payload: m.payload }));
            }
            await clearPendingMutations();
          } catch { /* ignore — stale mutations are harmless */ }
          if (!isCurrent()) return;
          connStatus.set('open');
          connError.set(null);
        })();
        return;
      }

      if (msg.type === 'auth.fail') {
        if (this.authTimer !== null) { clearTimeout(this.authTimer); this.authTimer = null; }
        const p = (msg.payload ?? {}) as AuthFail;
        if (p.reason === 'revoked') {
          // Server explicitly kicked this device — remove this server entry
          connStatus.set('error');
          this.forceClose = true;
          try { ws.close(); } catch { /* ignore */ }
          void clearCredentials();
          connError.set('Device revoked by server');
        } else if (p.reason === 'bad_token') {
          // Token mismatch — could be a different laptop at the same tunnel URL.
          // Try other stored server credentials before giving up.
          this.forceClose = true;
          try { ws.close(); } catch { /* ignore */ }
          void (async () => {
            if (!isCurrent()) return;
            const currentKey = creds.server_key ?? '';
            if (currentKey) this._triedServerKeys.add(currentKey);
            const all = await loadAllServers();
            const cloudHost = creds.cloud_host;
            // Find a server we haven't tried yet (same cloud host preferred)
            const next = all.find(
              (s) => !this._triedServerKeys.has(s.server_key) &&
                     (cloudHost === null || s.cloud_host === cloudHost),
            ) ?? all.find((s) => !this._triedServerKeys.has(s.server_key));
            if (next) {
              connStatus.set('connecting');
              connError.set(null);
              const switched = await switchServer(next.server_key);
              if (switched && isCurrent()) {
                this.forceClose = false;
                this.openSocket(switched, null);
              }
            } else {
              // Tried every stored server — ask user to re-pair
              this._triedServerKeys.clear();
              connStatus.set('error');
              connError.set('Different server — scan a new QR code to re-pair');
            }
          })();
        } else {
          connStatus.set('error');
          this.forceClose = true;
          try { ws.close(); } catch { /* ignore */ }
          connError.set(`Auth failed: ${p.reason}`);
        }
        return;
      }

      if (msg.type === 'live.state') {
        liveState.set(msg.payload as LiveState);
        return;
      }

      if (msg.type === 'queue.state') {
        const qs = msg.payload as QueueState;
        queueState.set(qs);
        void cacheQueueState(qs);
        return;
      }

      if (msg.type === 'lists.state') {
        const p = msg.payload as ListsState;
        listsStore.set(p?.lists ?? []);
        return;
      }

      if (msg.type === 'device.exclusive_changed') {
        const p = msg.payload as ExclusiveChanged;
        exclusiveDeviceId.set(p.exclusive_device_id ?? null);
        exclusiveDeviceName.set(p.device_name ?? null);
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
        const p = msg.payload as { cloud_host?: string };
        if (p?.cloud_host && isCurrent()) {
          void (async () => {
            const c = await loadCredentials();
            if (c && isCurrent()) {
              c.cloud_host = p.cloud_host;
              await saveCredentials(c);
            }
          })();
        }
        return;
      }
    };

    ws.onerror = () => {
      if (!isCurrent()) return;
      connError.set('Connection error');
    };

    ws.onclose = () => {
      // Stale close (from a previous socket we superseded): ignore completely.
      if (!isCurrent()) return;
      if (this.authTimer !== null) { clearTimeout(this.authTimer); this.authTimer = null; }
      this.ws = null;
      if (this.forceClose) {
        connStatus.set('closed');
        return;
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
    this.alternateNext = this.backoffIdx % 2 === 0;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.gen !== myGen) return;
      loadCredentials().then((fresh) => {
        if (this.gen !== myGen) return;
        if (fresh && fresh.device_token) this.openSocket(fresh, null);
      });
    }, delay);
  }
}

export const remote = new RemoteClient();
