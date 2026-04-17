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
  LiveState,
  QueueState,
} from './protocol';
import {
  clearCredentials,
  getOrCreateDeviceId,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from './db';
import {
  connEndpoint,
  connError,
  connStatus,
  liveState,
  queueState,
} from './stores';
import { handleSyncMessage } from './sync';

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
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
  }

  private buildUrl(host: string, endpoint: 'cloud' | 'lan'): string {
    // cloud = wss (Cloudflare terminates TLS). lan = ws (plain origin).
    const scheme = endpoint === 'cloud' ? 'wss' : 'ws';
    return `${scheme}://${host}`;
  }

  private pickEndpoint(creds: Credentials): { host: string; kind: 'cloud' | 'lan' } | null {
    if (this.alternateNext) {
      this.alternateNext = false;
      if (this.currentEndpoint === 'cloud' && creds.lan_host) {
        return { host: creds.lan_host, kind: 'lan' };
      }
      if (this.currentEndpoint === 'lan' && creds.cloud_host) {
        return { host: creds.cloud_host, kind: 'cloud' };
      }
    }
    if (creds.cloud_host) return { host: creds.cloud_host, kind: 'cloud' };
    if (creds.lan_host) return { host: creds.lan_host, kind: 'lan' };
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
        if (pairToken) {
          const finalCreds: Credentials = {
            ...creds,
            device_token: p.device_token,
            server_name: p.server_name,
            paired_at: Date.now(),
          };
          void saveCredentials(finalCreds);
        }
        connStatus.set('open');
        connError.set(null);
        this.backoffIdx = 0;
        return;
      }

      if (msg.type === 'auth.fail') {
        if (this.authTimer !== null) { clearTimeout(this.authTimer); this.authTimer = null; }
        const p = (msg.payload ?? {}) as AuthFail;
        connError.set(`auth.fail: ${p.reason}`);
        connStatus.set('error');
        // Block reconnects for this socket
        this.forceClose = true;
        try { ws.close(); } catch { /* ignore */ }
        if (p.reason === 'revoked' || p.reason === 'bad_token') {
          void clearCredentials();
        }
        return;
      }

      if (msg.type === 'live.state') {
        liveState.set(msg.payload as LiveState);
        return;
      }

      if (msg.type === 'queue.state') {
        queueState.set(msg.payload as QueueState);
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
