// BMWeb service worker: offline shell + cached data.
//
// Two caches, two lifetimes:
//   SHELL (index.html, scripts, styles, fonts): NETWORK-FIRST, revalidated
//   past the browser's HTTP cache, so a deploy shows up on the next load;
//   the cached copy serves offline. Named by the commit, dropped and refilled
//   on every release.
//   DATA (.chassis / .wiring / .docs archives, /data/ and /api/ payloads,
//   images): CACHE-FIRST, with a background revalidation when the cached
//   copy carries an ETag or Last-Modified, so an unchanged 110 MB wiring
//   archive is never downloaded twice and a changed one is picked up on the
//   next load. Named on its own and KEPT across releases: this cache used to
//   share the shell's name, so bumping the version threw away every chassis
//   archive, every wiring archive and the fault dictionaries, and each
//   release re-downloaded hundreds of MB that had not changed.
//
// Bumping SHELL_CACHE drops the old shell cache on activate; with
// skipWaiting + clients.claim the new worker takes over at once.
// Stamped with the commit at deploy (.github/workflows/pages.yml), so every
// release drops the previous shell; the dev server keeps this name.
const SHELL_CACHE = 'bmweb-shell-dev';
// Bump only to force every cached payload to be fetched again (a wholesale
// data format change); a changed file is otherwise picked up by revalidation.
const DATA_CACHE = 'bmweb-data-v1';

const CORE_ASSETS = ['./', './index.html', './manifest.webmanifest'];

// The heavy, per-release data payloads worth caching hard. Checked BEFORE
// the shell test: the generated dictionaries under data/ are .js files
// (faultinfo.js is 60 MB) and belong with the data, not the shell.
function isDataRequest(url) {
  return (
    /\.(?:chassis|wiring|docs)$/i.test(url.pathname) ||
    url.pathname.includes('/api/chassis/') ||
    url.pathname.includes('/data/') ||
    /\.(?:json|json\.gz|png|jpg|jpeg|svg|gif|ico|pdf)(?:\?|$)/i.test(
      url.pathname
    )
  );
}

// Shell requests: the navigation itself and every script/style/font.
function isShellRequest(request, url) {
  if (request.mode === 'navigate') return true;
  return /\.(?:html|css|js|mjs|webmanifest|woff2?|ttf)(?:\?|$)/i.test(
    url.pathname
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// let the page tell a waiting worker to take over immediately
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function cacheable(res) {
  return res && res.status === 200 && res.type === 'basic';
}

async function networkFirst(request) {
  try {
    // Our own files go past the HTTP cache: a host's max-age would otherwise
    // hand back the previous release's bundle for minutes after a deploy (a
    // 304 when nothing changed). By URL, so a navigation's request needs no
    // rebuilding. Another origin's (fonts) is fetched as the page asked.
    const own = new URL(request.url).origin === self.location.origin;
    // A navigation keeps its manual redirects: the browser refuses a
    // followed redirect as the answer to one.
    const fresh = own
      ? await fetch(request.url, {
          cache: 'no-cache',
          credentials: 'same-origin',
          redirect: request.mode === 'navigate' ? 'manual' : 'follow',
        })
      : await fetch(request);
    if (cacheable(fresh)) {
      const copy = fresh.clone();
      caches
        .open(SHELL_CACHE)
        .then((c) => c.put(request, copy))
        .catch(() => {});
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    // a navigation that failed offline falls back to the cached shell
    if (request.mode === 'navigate') {
      const shell =
        (await caches.match('./index.html')) || (await caches.match('./'));
      if (shell) return shell;
    }
    throw e;
  }
}

// Ask the host whether the cached copy is still current, with the
// validators it gave us; a 304 costs one round trip and no payload. A copy
// without validators is left alone: revalidating it would mean downloading
// the whole file again every load, which is what this cache exists to stop.
async function revalidate(request, cached) {
  const etag = cached.headers.get('etag');
  const modified = cached.headers.get('last-modified');
  if (!etag && !modified) return;
  const headers = new Headers();
  if (etag) headers.set('If-None-Match', etag);
  if (modified) headers.set('If-Modified-Since', modified);
  try {
    const res = await fetch(request, { headers, cache: 'no-cache' });
    if (cacheable(res)) {
      const c = await caches.open(DATA_CACHE);
      await c.put(request, res);
    }
    // 304: current; anything else: keep what we have
  } catch {
    /* offline: the cached copy stands */
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: DATA_CACHE });
  if (cached) {
    revalidate(request, cached);
    return cached;
  }
  const fresh = await fetch(request);
  if (cacheable(fresh)) {
    const copy = fresh.clone();
    caches
      .open(DATA_CACHE)
      .then((c) => c.put(request, copy))
      .catch(() => {});
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.url.startsWith('ws')) return;

  const url = new URL(request.url);
  if (request.mode !== 'navigate' && isDataRequest(url)) {
    event.respondWith(cacheFirst(request));
  } else if (isShellRequest(request, url)) {
    event.respondWith(networkFirst(request));
  }
  // everything else: let the browser handle it normally (no respondWith)
});
