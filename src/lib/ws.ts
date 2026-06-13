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
  clearPendingListMutations,
  deletePendingMutation,
  getPendingMutations,
  getOrCreateDeviceId,
  loadCredentials,
  mergeServerLists,
  removeUnpairedServer,
  saveCredentials,
  type Credentials,
} from './db';
import {
  connStatus,
  connEndpoint,
  connError,
  exclusiveDeviceId,
  exclusiveDeviceName,
  listsStore,
  liveState,
  queueState,
  serverName,
  canEditKeys,
  canEditSongs,
} from './stores';
import { handleSyncMessage } from './sync';

const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 15000];
const AUTH_TIMEOUT_MS = 8000;

export type PairParams = {
  server_key: string;
  server_id?: string;
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
  private pendingRequests = new Map<string, (payload: any) => void>();
  private heartbeatTimer: number | null = null;
  private lastMessageTime = 0;

  constructor() {
    // iOS Safari kills WebSockets when the PWA moves to background.
    // On return to foreground, reconnect immediately instead of waiting for the backoff timer.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (this.forceClose) return;
        this.tearDown();
        void this.connect();
      });
    }
    // When the device regains network access, reconnect immediately.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (this.forceClose) return;
        this.tearDown();
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
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
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
    let authenticated = false;
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
        connError.set('Auth timed out');
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
        return;
      }

      if (msg.type === 'pong') {
        return;
      }

      if (msg.type === 'auth.ok') {
        authenticated = true;
        if (this.authTimer !== null) { clearTimeout(this.authTimer); this.authTimer = null; }
        const p = (msg.payload ?? {}) as AuthOk;
        const authoritativeServerId = (p.server_id ?? creds.server_id ?? '').trim() || undefined;
        const finalCreds: Credentials = {
          ...creds,
          server_key: creds.server_key,
          server_id: authoritativeServerId,
          device_token: pairToken ? p.device_token : creds.device_token,
          server_name: p.server_name,
          paired_at: creds.paired_at ?? Date.now(),
          can_edit_keys: !!p.can_edit_keys,
          can_edit_songs: !!p.can_edit_songs,
        };
        exclusiveDeviceId.set(p.exclusive_device_id ?? null);
        exclusiveDeviceName.set(null);
        serverName.set(p.server_name || 'ChurchPresenter');
        canEditKeys.set(!!p.can_edit_keys);
        canEditSongs.set(!!p.can_edit_songs);
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
            await clearPendingListMutations();
            const mutations = await getPendingMutations();
            for (const m of mutations) {
              if (!isCurrent() || ws.readyState !== WebSocket.OPEN) return;
              if (m.type.startsWith('list.')) continue;
              const ack = await this.sendRequest(m.type, m.payload, 15000);
              if (ack?.ok !== false) {
                await deletePendingMutation(m.id);
              }
            }
          } catch { /* ignore — stale mutations are harmless */ }
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
          // Token mismatch for the selected server. Do not try other stored
          // servers implicitly; the user chooses the active server now.
          this.forceClose = true;
          try { ws.close(); } catch { /* ignore */ }
          connStatus.set('error');
          connError.set('This server rejected the saved pairing. Choose another server or scan a new QR code.');
        } else if (p.reason === 'wrong_server') {
          this.forceClose = true;
          try { ws.close(); } catch { /* ignore */ }
          connStatus.set('error');
          connError.set('This pairing belongs to a different desktop. Choose the matching server or scan this desktop QR again.');
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

      if (msg.type === 'library.changed') {
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
        const p = msg.payload as { cloud_host?: string };
        if (p?.cloud_host && isCurrent()) {
          void (async () => {
            const c = await loadCredentials();
            if (c && isCurrent()) {
              c.cloud_host = p.cloud_host ?? c.cloud_host ?? null;
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
      if (pairToken && !authenticated) {
        if (creds.server_key) void removeUnpairedServer(creds.server_key);
        if (!this.forceClose) {
          connStatus.set('error');
          connError.set('Pairing connection closed before it finished');
        } else {
          connStatus.set('closed');
        }
        return;
      }
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
}

export const remote = new RemoteClient();
