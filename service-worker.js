/* MSD — THE LEGEND · service worker
 * Strategy:
 *  - App shell (index.html + icons + offline page) is pre-cached on install.
 *  - Navigations: network-first (4s timeout) → cached shell → offline.html.
 *  - Same-origin assets: stale-while-revalidate.
 *  - Cross-origin media/fonts (Wikimedia Commons photos, Google Fonts): cached at runtime
 *    after the first successful view. They are NOT available offline before they were viewed once.
 *  - Updates: a new worker waits; the page shows an "update ready" notice and asks it to SKIP_WAITING.
 */
const VERSION = '1.0.0';
const SHELL_CACHE = `msd-shell-v${VERSION}`;
const RUNTIME_CACHE = `msd-runtime-v${VERSION}`;
const MEDIA_CACHE = 'msd-media-v1'; // survives app version bumps (images rarely change)
const SHELL = ['./', './index.html', './offline.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL_CACHE, RUNTIME_CACHE, MEDIA_CACHE];
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('msd-') && !keep.includes(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
  if (data.type === 'CLEAR_CACHES') {
    event.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('msd-')).map((k) => caches.delete(k)))));
  }
});

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
}

async function networkFirstNav(request) {
  try {
    const res = await Promise.race([fetch(request), timeout(4000)]);
    if (res && res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('./index.html', res.clone()).catch(() => undefined);
    }
    return res;
  } catch (e) {
    const cached = (await caches.match('./index.html')) || (await caches.match('./'));
    if (cached) return cached;
    const offline = await caches.match('./offline.html');
    return offline || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone()).catch(() => undefined);
      return res;
    })
    .catch(() => undefined);
  if (cached) return cached;
  const res = await network;
  return res || new Response('', { status: 504, statusText: 'Offline and not cached' });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!/^https?:$/.test(url.protocol)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNav(request));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
    return;
  }
  if (/(^|\.)wikimedia\.org$/.test(url.hostname) || /(^|\.)googleapis\.com$/.test(url.hostname) || /(^|\.)gstatic\.com$/.test(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request, MEDIA_CACHE));
  }
});
