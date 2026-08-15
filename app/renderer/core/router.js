// Hash-based routing for the Apps section, so its screens are linkable and the
// browser Back button works. The app is otherwise a pure SPA that swaps screens
// by calling show*() directly; this layer only mirrors those calls into
// location.hash and, on load / back-forward, replays the hash into the matching
// show*() call. Vehicle/ECU screens keep their existing Settings-based deep
// link (startChassis) and are intentionally NOT routed here -- only the Apps
// hub and the apps that live under it.
//
// Routes (all under #apps):
//   #apps                 the hub
//   #apps/diagnostics     Diagnostic Plans and Trouble Codes (showLookup)
//   #apps/wiring          Wiring Diagrams (showWiringChassis)
//   #apps/parts           Parts Catalogue (showEtk)
//   #apps/parts/vin       the VIN Decoder page (showVinDecoder)
//   #apps/tool32          Tool32 (showTool32)

const APPS_ROUTES = {
  'apps': () => (typeof showApps === 'function' ? showApps() : null),
  'apps/diagnostics': () => (typeof showLookup === 'function' ? showLookup() : null),
  'apps/wiring': () => (typeof showWiringChassis === 'function' ? showWiringChassis() : null),
  'apps/parts': () => (typeof showEtk === 'function' ? showEtk() : null),
  'apps/parts/vin': () => (typeof showVinDecoder === 'function' ? showVinDecoder() : null),
  'apps/tool32': () => (typeof showTool32 === 'function' ? showTool32() : null),
};

// The reverse map: which route a given show*() belongs to, so navigating by
// click (not by URL) still updates the hash. Keyed by function name.
const ROUTE_FOR_SCREEN = {
  showApps: 'apps',
  showLookup: 'apps/diagnostics',
  showWiringChassis: 'apps/wiring',
  showEtk: 'apps/parts',
  showVinDecoder: 'apps/parts/vin',
  showTool32: 'apps/tool32',
};

// Some routes carry parameters (a chassis, a specific diagram) so a single
// schematic is shareable. Resolve a route string to an opener, exact table
// first then these patterns. `#apps/wiring/E46` opens the E46 diagrams;
// `#apps/wiring/E46/SP0000014337` opens that exact document.
function resolveRoute(route) {
  const exact = APPS_ROUTES[route];
  if (exact) return exact;
  // #apps/wiring/<CHASSIS>[/<DOC>]
  const w = /^apps\/wiring\/([A-Za-z0-9]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(route);
  if (w && typeof showWiring === 'function') {
    const chassis = w[1].toUpperCase();
    const doc = w[2] ? decodeURIComponent(w[2]) : null;
    return () => showWiring(chassis, doc);
  }
  // #apps/parts/<CHASSIS>[/<HG>[/<BTNR>]]  (vin is an exact route, handled above)
  const p = /^apps\/parts\/([A-Za-z0-9]+)(?:\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?)?$/.exec(route);
  if (p && p[1].toLowerCase() !== 'vin') {
    const chassis = p[1].toUpperCase();
    const hg = p[2] ? decodeURIComponent(p[2]) : null;
    const btnr = p[3] ? decodeURIComponent(p[3]) : null;
    if (hg && typeof showEtkDeep === 'function') return () => showEtkDeep(chassis, hg, btnr);
    if (typeof showEtkChassis === 'function') return () => showEtkChassis(chassis);
  }
  return null;
}

// Screens that mean "left the Apps section" -- reaching one clears the apps
// hash. Deeper un-named sub-screens (chassis grid inside Parts, a single wiring
// diagram) are NOT here: they keep the section's hash rather than clearing it.
const EXIT_APPS_SCREEN = new Set(['showChassis', 'showSettings']);

// true while the router itself is driving navigation, so the hashchange it
// causes doesn't loop back into another navigation.
let _routing = false;
// the route we last actually opened, so a redundant hashchange/popstate (e.g.
// the ones our own replaceState+pushState seeding can emit) doesn't re-render
// the same screen -- which, for an async screen like showLookup, double-appends
// its body and shows the search UI twice.
let _openRoute = null;

function currentRoute() {
  const h = (location.hash || '').replace(/^#\/?/, '').replace(/\/$/, '');
  return h;
}

// Update the URL to reflect a screen the app opened by a direct call. Called
// from setCrumbs (once per screen render) so every navigation path is covered
// without touching each show*(). push vs replace: a genuinely new screen pushes
// a history entry (so Back returns to the previous one); re-rendering the same
// route replaces, so Back doesn't get stuck on duplicates.
function routeSyncFromScreen(fn) {
  if (_routing) return;                       // we are already navigating by URL
  const name = fn && fn.name;
  const route = ROUTE_FOR_SCREEN[name];
  if (route === undefined) {
    // Not a routed Apps screen. If it's an explicit exit (home / settings),
    // clear the apps hash so Back lands on a clean URL rather than a stale
    // #apps route. Un-named sub-screens (chassis grid, a wiring diagram) leave
    // the hash as-is -- they live under an app but aren't top-level routes.
    if (EXIT_APPS_SCREEN.has(name) && currentRoute().startsWith('apps')) {
      _routing = true; _openRoute = null;
      try { history.replaceState(null, '', location.pathname + location.search); }
      finally { _routing = false; }
    }
    return;
  }
  if (currentRoute() === route) { _openRoute = route; return; }  // already there
  _routing = true;
  try {
    // Backing out of any app should land on the hub, not skip past it to the
    // vehicle grid. So when moving to a SUB-app route (not the hub itself) from
    // a spot that isn't already inside the Apps section, seed a '#apps' history
    // entry first, then push the sub-route on top of it. Now browser Back ->
    // the hub -> (Back again) -> home.
    const from = currentRoute();
    if (route !== 'apps' && !from.startsWith('apps')) {
      location.hash = '#apps';
    }
    location.hash = '#' + route;               // pushes a history entry
    _openRoute = route;
  } finally { _routing = false; }
}

// Navigate to whatever the current hash names. Returns true if it handled an
// Apps route, false if the hash is empty/unknown (caller does its default).
// On a deep link into a sub-app, seed the hub behind it so Back reaches it.
function routeApplyHash() {
  const route = currentRoute();
  const open = resolveRoute(route);
  if (!open) return false;
  _routing = true;
  try {
    if (route !== 'apps') {
      // rewrite history so the stack is [..., #apps, #<route>] even on a cold
      // deep link: replace current entry with the hub, push the target on top.
      history.replaceState(null, '', '#apps');
      history.pushState(null, '', '#' + route);
    }
    _openRoute = route;
    open();
  } finally { _routing = false; }
  return true;
}

// Replay the current hash into the app (used by both hashchange and popstate,
// since pushState-created entries fire popstate but not hashchange on Back).
function _onLocationChange() {
  if (_routing) return;                        // our own hash write; ignore
  const route = currentRoute();
  if (route === _openRoute) return;            // already on this screen; no-op
  const open = resolveRoute(route);
  if (open) {
    _routing = true; _openRoute = route;
    try { open(); } finally { _routing = false; }
  } else if (route === '' && typeof showChassis === 'function') {
    // hash cleared (Back out of the Apps section) -> home
    _routing = true; _openRoute = null;
    try { showChassis(); } finally { _routing = false; }
  }
}

// Back/forward and manual hash edits replay into the app.
function installRouter() {
  window.addEventListener('hashchange', _onLocationChange);
  window.addEventListener('popstate', _onLocationChange);
}

// Called by the wiring viewer when a specific document opens, so the URL
// becomes a shareable deep link (#apps/wiring/<CHASSIS>/<DOC>). replaceState,
// not a hash push: browsing diagram-to-diagram shouldn't stack history, and
// Back should still leave the wiring section, not step through every schematic
// viewed. Marks _openRoute so the resulting no-op location check stays quiet.
function routeSetWiringDoc(chassis, doc) {
  if (_routing || !chassis || !doc) return;
  const route = `apps/wiring/${String(chassis).toUpperCase()}/${encodeURIComponent(doc)}`;
  if (currentRoute() === route) return;
  _routing = true;
  try { history.replaceState(null, '', '#' + route); _openRoute = route; }
  finally { _routing = false; }
}

// Same, for an open ETK diagram: #apps/parts/<CHASSIS>/<HG>/<BTNR>.
function routeSetEtkDiagram(chassis, hg, btnr) {
  if (_routing || !chassis || !hg || !btnr) return;
  const route = `apps/parts/${String(chassis).toUpperCase()}/`
    + `${encodeURIComponent(hg)}/${encodeURIComponent(btnr)}`;
  if (currentRoute() === route) return;
  _routing = true;
  try { history.replaceState(null, '', '#' + route); _openRoute = route; }
  finally { _routing = false; }
}

if (typeof window !== 'undefined') {
  window.installRouter = installRouter;
  window.routeApplyHash = routeApplyHash;
  window.routeSyncFromScreen = routeSyncFromScreen;
  window.routeSetWiringDoc = routeSetWiringDoc;
  window.routeSetEtkDiagram = routeSetEtkDiagram;
}
