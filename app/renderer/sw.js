// BMWeb Service Worker for Offline PWA Support
//
// CACHING STRATEGY -- the split that matters:
//
//   App shell (HTML, CSS, JS, the manifest): NETWORK-FIRST. These change on
//   every deploy, so serving them from cache first meant an update never
//   showed until a second reload -- the "it never refreshed" loop. Now the
//   network wins when reachable and the cache is only the offline fallback,
//   so a fresh deploy shows on the next load.
//
//   Big data (the per-chassis .chassis archives, .wiring diagrams, the fault
//   databases, generated data/ JSON): CACHE-FIRST. These are large and
//   effectively immutable per release -- exactly what offline caching is for.
//
// Bumping CACHE_NAME still drops the old cache on activate; combined with
// skipWaiting + clients.claim, a new worker takes over immediately.
const CACHE_NAME = 'bmweb-v13';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
];

// Requests that must always try the network first (the app shell). Matched on
// the URL, so it covers the navigation itself and every script/style/font.
function isShellRequest(request, url) {
  if (request.mode === 'navigate') return true;
  return /\.(?:html|css|js|mjs|webmanifest|woff2?|ttf)(?:\?|$)/i.test(url.pathname);
}

// Requests worth caching hard: the heavy, per-release data payloads.
function isDataRequest(url) {
  return /\.(?:chassis|wiring)$/i.test(url.pathname)
    || url.pathname.includes('/api/chassis/')
    || url.pathname.includes('/data/')
    || /\.(?:json|json\.gz|png|jpg|jpeg|svg|gif|ico|pdf)(?:\?|$)/i.test(url.pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// let the page tell a waiting worker to take over immediately (belt and
// braces alongside skipWaiting in install)
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200 && fresh.type === 'basic') {
      const copy = fresh.clone();
      caches.open(CACHE_NAME).then((c) => c.put(request, copy)).catch(() => {});
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    // a navigation that failed offline falls back to the cached shell
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html') || await caches.match('./');
      if (shell) return shell;
    }
    throw e;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.status === 200 && fresh.type === 'basic') {
    const copy = fresh.clone();
    caches.open(CACHE_NAME).then((c) => c.put(request, copy)).catch(() => {});
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.url.startsWith('ws')) return;

  const url = new URL(request.url);
  if (isShellRequest(request, url)) {
    event.respondWith(networkFirst(request));
  } else if (isDataRequest(url)) {
    event.respondWith(cacheFirst(request));
  }
  // everything else: let the browser handle it normally (no respondWith)
});
