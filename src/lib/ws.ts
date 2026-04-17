// WebSocket client with cloud-first / LAN-fallback reconnect.
// Authenticates via pair_token (first pair) or device_token (reconnect).
// Pushes updates into stores.ts.

import type {
  AuthFail,
  AuthOk,
  ClientCommand,
  Envelope,
  LiveState,
} from './protocol';
import {
  clearCredentials,
  getOrCreateDeviceId,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from './db';
import { connEndpoint, connError, connStatus, liveState } from './stores';

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const AUTH_TIMEOUT_MS = 8000;

export type PairParams = {
  pair_token: string;
  cloud_host: string | null;
  lan_host: string | null;
};

class RemoteClient {
  private ws: WebSocket | null = null;
  private backoffIdx = 0;
  private reconnectTimer: number | null = null;
  private forceClose = false;
  private currentEndpoint: 'cloud' | 'lan' | null = null;
  private authTimer: number | null = null;
  private pending?: PairParams;

  // ── Public API ───────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.forceClose = false;
    const creds = await loadCredentials();
    if (!creds) {
      connStatus.set('idle');
      return;
    }
    this.openSocket(creds, null);
  }

  async pair(params: PairParams, deviceName: string): Promise<void> {
    this.forceClose = false;
    this.pending = params;
    const device_id = await getOrCreateDeviceId();
    // We don't have permanent creds yet; use pending pair params as endpoints.
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
    this.forceClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
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

  // ── Internal ─────────────────────────────────────────────────────

  private buildUrl(host: string, endpoint: 'cloud' | 'lan'): string {
    // cloud = wss (Cloudflare terminates TLS). lan = ws (plain origin).
    const scheme = endpoint === 'cloud' ? 'wss' : 'ws';
    return `${scheme}://${host}`;
  }

  private pickEndpoint(creds: Credentials): { host: string; kind: 'cloud' | 'lan' } | null {
    // Prefer the one we weren't just on. Fall back to the other.
    if (this.currentEndpoint === 'cloud' && creds.lan_host) {
      return { host: creds.lan_host, kind: 'lan' };
    }
    if (this.currentEndpoint === 'lan' && creds.cloud_host) {
      return { host: creds.cloud_host, kind: 'cloud' };
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
      this.scheduleReconnect(creds);
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
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
      ws.send(JSON.stringify({ type: 'auth', payload }));
      this.authTimer = window.setTimeout(() => {
        if (this.ws === ws) {
          connError.set('Auth timed out');
          try { ws.close(); } catch { /* ignore */ }
        }
      }, AUTH_TIMEOUT_MS);
    };

    ws.onmessage = (ev) => {
      let msg: Envelope;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }

      if (msg.type === 'auth.ok') {
        if (this.authTimer !== null) { clearTimeout(this.authTimer); this.authTimer = null; }
        const p = (msg.payload ?? {}) as AuthOk;
        // If we were pairing, persist the new device_token.
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

      if (msg.type === 'device.revoked') {
        this.forceClose = true;
        void clearCredentials();
        connError.set('Device revoked from desktop');
        connStatus.set('error');
        return;
      }
    };

    ws.onerror = () => {
      connError.set('Connection error');
    };

    ws.onclose = () => {
      if (this.authTimer !== null) { clearTimeout(this.authTimer); this.authTimer = null; }
      this.ws = null;
      if (this.forceClose) {
        connStatus.set('closed');
        return;
      }
      connStatus.set('closed');
      this.scheduleReconnect(creds);
    };
  }

  private scheduleReconnect(creds: Credentials): void {
    if (this.forceClose) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.backoffIdx, RECONNECT_BACKOFF_MS.length - 1)];
    this.backoffIdx += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      // Alternate endpoint if both are available
      loadCredentials().then((fresh) => {
        if (fresh) this.openSocket(fresh, null);
      });
    }, delay);
  }
}

export const remote = new RemoteClient();
