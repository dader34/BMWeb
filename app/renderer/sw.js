// BMWeb Service Worker (offline PWA). CACHING STRATEGY, the split that matters:
//
//   App shell (HTML/CSS/JS/manifest): NETWORK-FIRST. They change every deploy,
//   and cache-first meant an update never showed until a second reload -- the
//   "it never refreshed" loop. Cache is now only the offline fallback.
//
//   Big data (.chassis / .wiring archives, fault DBs, data/ JSON): CACHE-FIRST.
//   Large and effectively immutable per release.
//
// Bumping CACHE_NAME drops the old cache on activate; with skipWaiting +
// clients.claim a new worker takes over immediately.

const CACHE_NAME = 'bmweb-v58';   // v58: remote diag owner-side consent (on top of Tool32 trace/test v57)


const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
];

// Shell requests: the navigation itself and every script/style/font.
function isShellRequest(request, url) {
  if (request.mode === 'navigate') return true;
  return /\.(?:html|css|js|mjs|webmanifest|woff2?|ttf)(?:\?|$)/i.test(url.pathname);
}

// The heavy, per-release data payloads worth caching hard.
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

// let the page tell a waiting worker to take over immediately
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
