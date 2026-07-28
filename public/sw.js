// RSG Agency Portal — service worker.
//
// Scope is deliberately narrow. This portal is a live operations dashboard:
// renewals, task queues, case progress, money. A cached-but-stale number here is
// worse than no number at all, because it looks authoritative. So this worker
// caches the SHELL ONLY and never the data.
//
// Never cached, always straight to network:
//   /api/*     — every dashboard and intake call
//   /intake*   — the proxied intake gateway, a write path
//   /healthz   — a liveness probe that must reflect the live process
//
// Bumping CACHE invalidates the old shell on the next activate.
const CACHE = 'rsg-portal-shell-v4';

const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  // addAll rejects the whole install if any entry 404s; tolerate partial precache
  // so one renamed icon can never wedge the worker in a failed state.
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isLive(url) {
  return url.pathname.indexOf('/api/') === 0
      || url.pathname.indexOf('/intake') === 0
      || url.pathname === '/healthz';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // writes never touch the cache

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let cross-origin (fonts) pass through
  if (isLive(url)) return;                          // live data: no interception at all

  // Navigations: network-first so a redeploy is picked up immediately, falling
  // back to the cached shell only when the network genuinely fails (off-tailnet).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || Response.error()))
    );
    return;
  }

  // Static shell assets: cache-first, refreshed in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit || Response.error());
      return hit || net;
    })
  );
});
