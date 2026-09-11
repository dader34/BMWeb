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

const CACHE_NAME = 'bmweb-v181'; // bmweb-v181: the lightbox loupe magnifies the lit callout with the drawing (bmweb-v180: the parts diagram's callout numbers and its parts rows highlight each other (bmweb-v179: build dates read 09/2004, not 2004-09 (bmweb-v178: the Parts VIN card drops its icon (bmweb-v177: schematic labels take the pointer (the drawing was pointer-events none, so no label could be hovered or clicked) (bmweb-v176: the VIN decoder leaves the vehicle screen, it lives under Parts (bmweb-v175: schematic labels open the component's document, the VIN box on the home screen, ETK years run to the VIN index's newest production block (bmweb-v174: a cable another machine serves (bmweb gateway) drives the app over a WebSocket (bmweb-v173: the Workshop tab -- ISTA technical data, tightening torques, operating fluids and special tools, filtered to the car (bmweb-v172: the ISTA shell -- workshop mode wraps the app's own screens in a banner and tabs (bmweb-v171: the tree's car picker is the app's dropdown (bmweb-v170: bmweb-v170: the tree colours only from a read run on it (bmweb-v169: bmweb-v169: Service functions app -- curated service tasks resolved to the INPA key that performs them, per chassis; dropdown popup anchors by measurement; the tree runs the fault scan in place (bmweb-v167: bmweb-v167: Control unit tree app (ISTA topology, Garage scan colours) (bmweb-v166: bmweb-v166: IR rebuilt with the current decoder (14 ECUs' state-screen substrings corrected) (bmweb-v165: bmweb-v165: the VM paints hexdump tables, prints protocol files, closes the viewer, carries colours (bmweb-v140: the Garage -- saved cars, their scan history, freeze frames with cited range checks (bmweb-v126: an empty Select box names the keys that lead to selectable screens (bmweb-v124: tick centred, radios round on the flat skin, Select opens its box on every screen (bmweb-v123: print sheet keys as the F-key bar under the screen (bmweb-v122: radios and checkboxes drawn by the app (bmweb-v121: measurement-block labels pair with their bars in the modern layout (bmweb-v120: wiring's WDS chrome follows the INPA skin, not the layout mode (bmweb-v119: modern status rows pair captions with the lamps under them (bmweb-v118: INPA layout is the default on desktop (bmweb-v117: Identity entry appears at the first module that answers, sections never wait on it (bmweb-v116: stylesheet repaired (three comment stubs swallowed the button rules) (bmweb-v115: battery/ignition chips removed; the cable chip hears unplug/replug (bmweb-v114: a key's scriptchange is followed (SM46 -> passenger seat B_SM46); script-only stems ship (bmweb-v113: Print screen builds a clean sheet in both modes; chrome-free print fallback (bmweb-v112: INPA's stop keyword ends the line body (MS45 injector screen no longer sends a bogus job) (bmweb-v111: MS45 measurement-block labels in English, 'Send immediately' honoured by the runtime (bmweb-v110: renderer split into per-concern folders, JSDoc everywhere, dead files/CSS removed (bmweb-v109: the derived renderer is gone, the module view always runs the script (bmweb-v108: catch-all repacked; component picker (bmweb-v107: demo mode, the adapter choice and the keep-cable setting removed -- K+DCAN over Web Serial, always reconnecting (v106: instrument cells (lamps, bars), runtime text translation, fault list fixes (v105: i18n regenerated without the word-rule fallback, modern skin for the live runtime (v104: live .IPO runtime is the module view; (v103: identity FA decode, IHKA scriptchange, tuning read dialog)

const CORE_ASSETS = ['./', './index.html', './manifest.webmanifest'];

// Shell requests: the navigation itself and every script/style/font.
function isShellRequest(request, url) {
  if (request.mode === 'navigate') return true;
  return /\.(?:html|css|js|mjs|webmanifest|woff2?|ttf)(?:\?|$)/i.test(
    url.pathname
  );
}

// The heavy, per-release data payloads worth caching hard.
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

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
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
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      )
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
      caches
        .open(CACHE_NAME)
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

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.status === 200 && fresh.type === 'basic') {
    const copy = fresh.clone();
    caches
      .open(CACHE_NAME)
      .then((c) => c.put(request, copy))
      .catch(() => {});
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
