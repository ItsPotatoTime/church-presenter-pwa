/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

import { build, files, prerendered, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = `cache-${version}`;
const FONT_CACHE_NAME = 'google-fonts-cache';

// Dynamically determine base path from the assets list (since SvelteKit prefix paths with it)
let base = '';
if (files.length > 0) {
  const sample = files[0];
  const filename = sample.split('/').pop() || '';
  base = sample.substring(0, sample.length - filename.length - 1);
} else if (build.length > 0) {
  const sample = build[0];
  const idx = sample.indexOf('/_app/');
  if (idx !== -1) {
    base = sample.substring(0, idx);
  }
}

// Combine all assets to precache, filtering out backups and .nojekyll to save space/bandwidth
const ASSETS = [
  base + '/',
  base + '/index.html',
  ...build,
  ...files.filter((f) => !f.includes('icon-backup') && !f.endsWith('.nojekyll')),
  ...prerendered
];

// Deduplicate assets
const UNIQUE_ASSETS = Array.from(new Set(ASSETS));

type InstallProgressMessage =
  | { type: 'SW_INSTALL_PROGRESS'; done: number; total: number; asset: string }
  | { type: 'SW_INSTALL_COMPLETE'; total: number }
  | { type: 'SW_INSTALL_ERROR'; message: string };

async function broadcastInstallProgress(message: InstallProgressMessage) {
  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: 'window'
  });

  for (const client of clients) {
    client.postMessage(message);
  }
}

async function precacheAssets() {
  const cache = await caches.open(CACHE_NAME);
  const total = UNIQUE_ASSETS.length;

  await broadcastInstallProgress({
    type: 'SW_INSTALL_PROGRESS',
    done: 0,
    total,
    asset: ''
  });

  for (let i = 0; i < UNIQUE_ASSETS.length; i += 1) {
    const asset = UNIQUE_ASSETS[i];
    await cache.add(asset);
    await broadcastInstallProgress({
      type: 'SW_INSTALL_PROGRESS',
      done: i + 1,
      total,
      asset
    });
  }

  await broadcastInstallProgress({
    type: 'SW_INSTALL_COMPLETE',
    total
  });
}

// 1. Install event: Precache all assets and force immediate takeover
self.addEventListener('install', (event) => {
  event.waitUntil(
    precacheAssets()
      .then(() => self.skipWaiting())
      .catch(async (err) => {
        console.error('[ServiceWorker] Pre-caching failed during install:', err);
        await broadcastInstallProgress({
          type: 'SW_INSTALL_ERROR',
          message: err instanceof Error ? err.message : String(err)
        });
        throw err;
      })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

// 2. Activate event: Clean up old application caches and claim all clients.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        return Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME && key !== FONT_CACHE_NAME) {
              console.log('[ServiceWorker] Deleting old cache:', key);
              return caches.delete(key);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// 3. Fetch event: Cache-First for static assets/fonts, Fallback SPA routing for navigations
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Bypass WebSockets and other non-http protocols
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Handle Google Fonts dynamically (Cache First, cache indefinitely since they are versioned/static)
  const isFontRequest = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (isFontRequest) {
    event.respondWith(
      caches.open(FONT_CACHE_NAME).then(async (cache) => {
        const cachedResponse = await cache.match(event.request);
        if (cachedResponse) {
          return cachedResponse;
        }
        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse.status === 200) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          console.error('[ServiceWorker] Failed to fetch Google Font offline:', err);
          throw err;
        }
      })
    );
    return;
  }

  // Handle Navigation Requests (Offline SPA Shell Fallback)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);

        // A. Match the exact pathname (ignoring query parameters for pairing/tokens)
        const exactMatch = await cache.match(url.pathname);
        if (exactMatch) return exactMatch;

        // B. Match pathname with trailing index.html (SvelteKit static folder routes)
        const indexPath = url.pathname.endsWith('/') ? `${url.pathname}index.html` : `${url.pathname}/index.html`;
        const indexMatch = await cache.match(indexPath);
        if (indexMatch) return indexMatch;

        // C. Match fallback index.html at root base
        const fallbackMatch = await cache.match(`${base}/index.html`) || await cache.match(`${base}/`);
        if (fallbackMatch) return fallbackMatch;

        // D. Fallback to network if cache misses
        return fetch(event.request);
      })()
    );
    return;
  }

  // Handle standard resource requests (Cache-First, Network-Fallback)
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cachedResponse = await cache.match(event.request);
      if (cachedResponse) {
        return cachedResponse;
      }
      try {
        const networkResponse = await fetch(event.request);
        // Cache newly fetched same-origin assets
        if (networkResponse.status === 200 && url.origin === self.location.origin) {
          cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      } catch (err) {
        // Return cached request as absolute final fallback
        const fallback = await cache.match(event.request);
        if (fallback) return fallback;
        throw err;
      }
    })
  );
});
