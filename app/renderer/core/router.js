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
//   #apps/wiring/vin      the wiring VIN decoder (showWiringVinDecoder)
//   #apps/parts           Parts Catalogue (showEtk)
//   #apps/parts/vin       the VIN Decoder page (showVinDecoder)
//   #apps/tool32          Tool32 (showTool32)

/**
 * Exact route -> opener. Each opener guards on its screen existing, so a
 * build without that app simply ignores the hash.
 * @type {Object<string, () => any>}
 */
const APPS_ROUTES = {
  apps: () => (typeof showApps === 'function' ? showApps() : null),
  'apps/diagnostics': () =>
    typeof showLookup === 'function' ? showLookup() : null,
  'apps/wiring': () =>
    typeof showWiringChassis === 'function' ? showWiringChassis() : null,
  'apps/wiring/vin': () =>
    typeof showWiringVinDecoder === 'function' ? showWiringVinDecoder() : null,
  'apps/parts': () => (typeof showEtk === 'function' ? showEtk() : null),
  'apps/parts/vin': () =>
    typeof showVinDecoder === 'function' ? showVinDecoder() : null,
  'apps/tool32': () => (typeof showTool32 === 'function' ? showTool32() : null),
  'apps/job-search': () =>
    typeof showJobSearch === 'function' ? showJobSearch('') : null,
  'apps/backup': () =>
    typeof showFlasher === 'function' ? showFlasher() : null,
  'apps/tuning': () => (typeof showTuning === 'function' ? showTuning() : null),
  garage: () => (typeof showGarage === 'function' ? showGarage() : null),
  'apps/logging': () =>
    typeof showLogging === 'function' ? showLogging() : null,
  'apps/script': () =>
    typeof showScriptRunner === 'function' ? showScriptRunner() : null,
  'apps/tree': () => (typeof showEcuTree === 'function' ? showEcuTree() : null),
  'apps/service': () =>
    typeof showService === 'function' ? showService() : null,
  'apps/documents': () =>
    typeof showWiringChassis === 'function' ? showWiringChassis() : null,
  // the app's home as an INPA script (screens/ipo-runtime/home.js)
  inpa: () => (typeof showIpoHome === 'function' ? showIpoHome() : null),
  // workshop mode (screens/ista/). Top-level like garage and inpa: it is a
  // mode over the whole app, not one more app under the hub.
  ista: () => (typeof showIsta === 'function' ? showIsta() : null),
};

// The reverse map: which route a given show*() belongs to, so navigating by
// click (not by URL) still updates the hash. Keyed by function name.
/** @type {Object<string, string>} */
const ROUTE_FOR_SCREEN = {
  showApps: 'apps',
  showLookup: 'apps/diagnostics',
  showWiringChassis: 'apps/wiring',
  showEtk: 'apps/parts',
  showVinDecoder: 'apps/parts/vin',
  showTool32: 'apps/tool32',
  showJobSearch: 'apps/job-search',
  showFlasher: 'apps/backup',
  showTuning: 'apps/tuning',
  showGarage: 'garage',
  showLogging: 'apps/logging',
  showScriptRunner: 'apps/script',
  showEcuTree: 'apps/tree',
  showService: 'apps/service',
  showIpoHome: 'inpa',
};

// Some routes carry parameters (a chassis, a specific diagram) so a single
// schematic is shareable. Resolve a route string to an opener, exact table
// first then these patterns. `#apps/wiring/E46` opens the E46 diagrams;
// `#apps/wiring/E46/SP0000014337` opens that exact document.
/**
 * Resolve a route string (the hash without '#') to a screen opener.
 * @param {string} route - e.g. 'apps/parts/E46'.
 * @returns {(() => any)|null} The opener, or null for an unknown route.
 */
function resolveRoute(route) {
  const exact = APPS_ROUTES[route];
  if (exact) return exact;
  // #ista/<TAB>[/<SUB>[/<CAR>]] -- workshop mode, on a tab. The car is last
  // and optional: a link someone sends should still open the right tab on a
  // machine where that local car id means nothing.
  const is =
    /^ista\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?(?:\/([A-Za-z0-9_-]+))?$/.exec(
      route
    );
  if (is && typeof showIsta === 'function') {
    const tab = decodeURIComponent(is[1]);
    const sub = is[2] ? decodeURIComponent(is[2]) : null;
    const car = is[3] ? decodeURIComponent(is[3]) : null;
    return () => showIsta(tab, sub, null, car);
  }
  // #car/<CHASSIS>[/<SGBD>[/<MENU>[/<SCREEN>]]] -- the vehicle side. The
  // module is keyed by SGBD (stable, unlike a display label) and the submenu
  // by its IR menu name, which is the same key the live runtime navigates by.
  //
  // The optional SCREEN is what a job-search result lands on: a menu can show
  // several screens and the row the user clicked names one of them. Menu and
  // screen proc names are identifiers (m_fehlersp, s_fs_detail), never
  // slashed, so splitting the tail on '/' cannot break a link written before
  // the screen part existed -- a two-part tail is still menu-only.
  const c = /^car\/([A-Za-z0-9]+)(?:\/([A-Za-z0-9_-]+)(?:\/(.+))?)?$/.exec(
    route
  );
  if (c) {
    const chassis = c[1].toUpperCase();
    const sgbd = c[2] ? decodeURIComponent(c[2]).toLowerCase() : null;
    const tail = c[3] ? c[3].split('/') : [];
    // an empty menu part (#car/E46/kombi46//s_fs) is how a link names a
    // screen with no menu of its own: the script's entry menu stands
    const menu = tail[0] ? decodeURIComponent(tail[0]) : null;
    const screen = tail[1] ? decodeURIComponent(tail[1]) : null;
    if (sgbd && typeof showEcuDeep === 'function') {
      return () => showEcuDeep(chassis, sgbd, menu, screen);
    }
    // the car's module list in the layout the user chose: INPA's script
    // selection or the modern sections (backToModules picks)
    if (typeof backToModules === 'function')
      return () => backToModules(chassis);
    if (typeof showSections === 'function') return () => showSections(chassis);
  }
  // #garage/<CAR>[/<SCAN>] -- a saved vehicle, or one of its stored scans.
  // Both ids are local and opaque, so they are matched as-is rather than
  // upper-cased the way a chassis is.
  const g = /^garage\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(route);
  if (g) {
    const carId = decodeURIComponent(g[1]);
    const scanId = g[2] ? decodeURIComponent(g[2]) : null;
    if (scanId && typeof showGarageScan === 'function')
      return () => showGarageScan(carId, scanId);
    if (typeof showGarageCar === 'function') return () => showGarageCar(carId);
  }
  // #report/<payload> -- a stored scan someone sent as a link; the payload
  // IS the report (deflated, base64url), nothing is fetched
  const rp = /^report\/([A-Za-z0-9_-]+)$/.exec(route);
  if (rp && typeof showGarageSharedReport === 'function') {
    const payload = rp[1];
    return () => showGarageSharedReport(payload);
  }
  // #apps/job-search/<QUERY> -- a search someone can send as a link. The
  // query is the whole tail, encoded, so it may hold spaces and slashes.
  const js = /^apps\/job-search\/(.+)$/.exec(route);
  if (js && typeof showJobSearch === 'function') {
    const q = decodeURIComponent(js[1]);
    return () => showJobSearch(q);
  }
  // #apps/service/<CHASSIS>[/<TASK>] -- the service functions for one car,
  // and optionally one task on it, so a specific procedure is a link someone
  // can send. The task id is our own (lws-calibration), so it is matched as
  // the slug it is rather than upper-cased the way a chassis is.
  const sv = /^apps\/service\/([A-Za-z0-9]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(
    route
  );
  if (sv && typeof showService === 'function') {
    const chassis = sv[1].toUpperCase();
    const task = sv[2] ? decodeURIComponent(sv[2]) : null;
    return () => showService(chassis, task);
  }
  // #apps/wiring/<CHASSIS>[/<DOC>]
  const w = /^apps\/wiring\/([A-Za-z0-9]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(route);
  if (w && typeof showWiring === 'function') {
    const chassis = w[1].toUpperCase();
    const doc = w[2] ? decodeURIComponent(w[2]) : null;
    return () => showWiring(chassis, doc);
  }
  // #apps/tree/<CHASSIS>[/<CAR>] -- the control unit tree of a chassis, the
  // boxes coloured by a saved car's last fault scan when a car id follows
  const tr = /^apps\/tree\/([A-Za-z0-9]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(route);
  if (tr && typeof showEcuTreeChassis === 'function') {
    const chassis = tr[1].toUpperCase();
    const carId = tr[2] ? decodeURIComponent(tr[2]) : null;
    return () => showEcuTreeChassis(chassis, carId);
  }
  // #apps/logging/<CHASSIS> -- the logging workspace for one car. The
  // selection itself is not in the URL: it is a preset, saved by name.
  const lg = /^apps\/logging\/([A-Za-z0-9]+)$/.exec(route);
  if (lg && typeof showLoggingChassis === 'function') {
    const chassis = lg[1].toUpperCase();
    return () => showLoggingChassis(chassis);
  }
  // #apps/documents/<CHASSIS>[/<DOCID>] -> the merged wiring/docs screen, doc
  // category; the doc id ("d:"-prefixed internally) opens that document
  const dq = /^apps\/documents\/([A-Za-z0-9]+)(?:\/([0-9]+))?$/.exec(route);
  if (dq && typeof showWiring === 'function') {
    const chassis = dq[1].toUpperCase();
    const docId = dq[2] ? 'd:' + dq[2] : null;
    return () => showWiring(chassis, docId, null, 'repair');
  }
  // #apps/parts/<CHASSIS>[/<HG>[/<BTNR>]]  (vin is an exact route, handled above)
  const p =
    /^apps\/parts\/([A-Za-z0-9]+)(?:\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?)?$/.exec(
      route
    );
  if (p && p[1].toLowerCase() !== 'vin') {
    const chassis = p[1].toUpperCase();
    const hg = p[2] ? decodeURIComponent(p[2]) : null;
    const btnr = p[3] ? decodeURIComponent(p[3]) : null;
    if (hg && typeof showEtkDeep === 'function')
      return () => showEtkDeep(chassis, hg, btnr);
    if (typeof showEtkChassis === 'function')
      return () => showEtkChassis(chassis);
  }
  return null;
}

// Screens that mean "left the Apps section" -- reaching one clears the apps
// hash. Deeper un-named sub-screens (chassis grid inside Parts, a single wiring
// diagram) are NOT here: they keep the section's hash rather than clearing it.
/** @type {Set<string>} */
const EXIT_APPS_SCREEN = new Set(['showChassis', 'showSettings']);

// true while the router itself is driving navigation, so the hashchange it
// causes doesn't loop back into another navigation.
/** @type {boolean} */
let _routing = false;
// the route we last actually opened, so a redundant hashchange/popstate (e.g.
// the ones our own replaceState+pushState seeding can emit) doesn't re-render
// the same screen -- which, for an async screen like showLookup, double-appends
// its body and shows the search UI twice.
/** @type {string|null} */
let _openRoute = null;

/**
 * The current hash as a route: no '#', no leading or trailing slash.
 * @returns {string}
 */
function currentRoute() {
  const h = (location.hash || '').replace(/^#\/?/, '').replace(/\/$/, '');
  return h;
}

// Update the URL to reflect a screen the app opened by a direct call. Called
// from setCrumbs (once per screen render) so every navigation path is covered
// without touching each show*(). push vs replace: a genuinely new screen pushes
// a history entry (so Back returns to the previous one); re-rendering the same
// route replaces, so Back doesn't get stuck on duplicates.
/**
 * Mirror a screen the app opened by direct call into the URL hash.
 * @param {Function|null|undefined} fn - The screen function (matched by name).
 * @returns {void}
 */
function routeSyncFromScreen(fn) {
  if (_routing) return; // we are already navigating by URL
  const name = fn && fn.name;
  // Leaving workshop mode. The ISTA shell is chrome around #view rather than
  // a screen in it, so nothing about a normal screen render would take it
  // down -- it would sit there describing a car the user has left. Every
  // screen passes through here exactly once per render, which makes this the
  // one place that always notices.
  //
  // The shell's OWN wrapped screens come through here too, and they must not
  // trip it: istaOpening is set while the shell is deliberately opening one.
  // So the rule is "a screen rendered while the shell is up, that the shell
  // did not ask for, means the user left".
  if (
    typeof istaChromeActive === 'function' &&
    istaChromeActive() &&
    !(typeof istaOpening === 'function' && istaOpening())
  ) {
    istaChromeHide();
  }
  const route = ROUTE_FOR_SCREEN[name];
  if (route === undefined) {
    // Not a routed Apps screen. If it's an explicit exit (home / settings),
    // clear the apps hash so Back lands on a clean URL rather than a stale
    // #apps route. Un-named sub-screens (chassis grid, a wiring diagram) leave
    // the hash as-is -- they live under an app but aren't top-level routes.
    // showSections owns its own #car hash (routeSetCarList); don't clear it here
    if (name === 'showSections') return;
    const here = currentRoute();
    if (
      EXIT_APPS_SCREEN.has(name) &&
      (here.startsWith('apps') ||
        here.startsWith('car') ||
        here.startsWith('garage'))
    ) {
      _routing = true;
      _openRoute = null;
      try {
        history.replaceState(null, '', location.pathname + location.search);
      } finally {
        _routing = false;
      }
    }
    return;
  }
  if (currentRoute() === route) {
    _openRoute = route;
    return;
  } // already there
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
    location.hash = '#' + route; // pushes a history entry
    _openRoute = route;
  } finally {
    _routing = false;
  }
}

// Navigate to whatever the current hash names. Returns true if it handled an
// Apps route, false if the hash is empty/unknown (caller does its default).
// On a deep link into a sub-app, seed the hub behind it so Back reaches it.
/**
 * Open whatever the current hash names.
 * @returns {boolean} true when a route was handled; false for an empty/unknown hash.
 */
function routeApplyHash() {
  const route = currentRoute();
  const open = resolveRoute(route);
  if (!open) return false;
  _routing = true;
  try {
    // Apps sub-routes seed the hub behind them so Back reaches it. A #car route
    // must NOT: its Back belongs to the vehicle hierarchy (the in-app Back key
    // walks menu -> ECU -> modules), and seeding #apps would strand the user in
    // the Apps hub on the first Back out of a shared module link.
    if (route !== 'apps' && route.startsWith('apps')) {
      // rewrite history so the stack is [..., #apps, #<route>] even on a cold
      // deep link: replace current entry with the hub, push the target on top.
      history.replaceState(null, '', '#apps');
      history.pushState(null, '', '#' + route);
    }
    _openRoute = route;
    open();
  } finally {
    _routing = false;
  }
  return true;
}

// Replay the current hash into the app (used by both hashchange and popstate,
// since pushState-created entries fire popstate but not hashchange on Back).
/**
 * hashchange/popstate handler: replay the hash into the app, or go home when
 * it was cleared.
 * @returns {void}
 */
function _onLocationChange() {
  if (_routing) return; // our own hash write; ignore
  const route = currentRoute();
  if (route === _openRoute) return; // already on this screen; no-op
  // the ISTA shell opening a wrapped screen: that screen writes its own
  // route mid-render and the shell re-stamps it after; replaying either
  // here would open the screen a second time, without what the shell asked
  // for (the tree's live read was lost this way)
  if (typeof istaOpening === 'function' && istaOpening()) {
    _openRoute = route;
    return;
  }
  const open = resolveRoute(route);
  if (open) {
    _routing = true;
    _openRoute = route;
    try {
      open();
    } finally {
      _routing = false;
    }
  } else if (route === '' && typeof showChassis === 'function') {
    // hash cleared (Back out of the Apps section) -> home
    _routing = true;
    _openRoute = null;
    try {
      showChassis();
    } finally {
      _routing = false;
    }
  }
}

// Back/forward and manual hash edits replay into the app.
/**
 * Start listening for hash and history changes. Called once at boot.
 * @returns {void}
 */
function installRouter() {
  window.addEventListener('hashchange', _onLocationChange);
  window.addEventListener('popstate', _onLocationChange);
}

// Called by the vehicle screens as they navigate, so a module and the submenu
// inside it become shareable links (#car/E46/kombi46/MENU_FS). replaceState:
// walking a menu tree shouldn't stack a history entry per level -- Back should
// leave the ECU, which is what the in-app Back key already does.
// Pass menu = null for the ECU root, and call with chassis = null to clear.
/**
 * Set the hash to a module (and submenu) link: #car/<CHASSIS>/<SGBD>[/<MENU>].
 * @param {string|null} chassis - Chassis id.
 * @param {string|null} sgbd - The module's SGBD.
 * @param {string|null} [menu] - The open submenu's IR name, or null for the root.
 * @param {string|null} [screen] - The screen shown on that menu, when known.
 * @returns {void}
 */
function routeSetCar(chassis, sgbd, menu, screen) {
  if (_routing) return;
  if (!chassis || !sgbd) return;
  const parts = [
    'car',
    String(chassis).toUpperCase(),
    encodeURIComponent(sgbd),
  ];
  if (menu) {
    parts.push(encodeURIComponent(menu));
    if (screen) parts.push(encodeURIComponent(screen));
  }
  const route = parts.join('/');
  if (currentRoute() === route) {
    _openRoute = route;
    return;
  }
  _routing = true;
  try {
    history.replaceState(null, '', '#' + route);
    _openRoute = route;
  } finally {
    _routing = false;
  }
}

// The chassis module list (#car/<CHASSIS>), so picking a car is linkable too.
/**
 * Set the hash to a chassis's module list: #car/<CHASSIS>.
 * @param {string|null} chassis - Chassis id.
 * @returns {void}
 */
function routeSetCarList(chassis) {
  if (_routing || !chassis) return;
  const route = `car/${String(chassis).toUpperCase()}`;
  if (currentRoute() === route) {
    _openRoute = route;
    return;
  }
  _routing = true;
  try {
    history.replaceState(null, '', '#' + route);
    _openRoute = route;
  } finally {
    _routing = false;
  }
}

// The Job search app writes its query back into the hash as the user types,
// so a search is a link someone can send. replaceState: a keystroke must not
// stack a history entry, and Back should leave the app rather than step
// backwards through every prefix of the query.
/**
 * Set the hash to a Job search query: #apps/job-search[/<QUERY>].
 * @param {string} q - the query; empty clears it back to the bare route
 * @returns {void}
 */
function routeSetJobSearch(q) {
  if (_routing) return;
  const query = String(q || '').trim();
  const route = query
    ? `apps/job-search/${encodeURIComponent(query)}`
    : 'apps/job-search';
  if (currentRoute() === route) {
    _openRoute = route;
    return;
  }
  _routing = true;
  try {
    history.replaceState(null, '', '#' + route);
    _openRoute = route;
  } finally {
    _routing = false;
  }
}

// The Service functions app writes its chosen vehicle back into the hash, so
// a car's task list is a link someone can send. replaceState: picking a car
// from the dropdown must not stack a history entry, and Back should leave the
// app rather than step backwards through every car looked at.
/**
 * Set the hash to a Service functions vehicle: #apps/service[/<CHASSIS>].
 * @param {string|null} chassis - the chassis id; empty clears it to the bare route
 * @returns {void}
 */
function routeSetService(chassis) {
  if (_routing) return;
  const cid = String(chassis || '')
    .trim()
    .toUpperCase();
  const route = cid ? `apps/service/${cid}` : 'apps/service';
  if (currentRoute() === route) {
    _openRoute = route;
    return;
  }
  _routing = true;
  try {
    history.replaceState(null, '', '#' + route);
    _openRoute = route;
  } finally {
    _routing = false;
  }
}

// Called by the wiring viewer when a specific document opens, so the URL
// becomes a shareable deep link (#apps/wiring/<CHASSIS>/<DOC>). replaceState,
// not a hash push: browsing diagram-to-diagram shouldn't stack history, and
// Back should still leave the wiring section, not step through every schematic
// viewed. Marks _openRoute so the resulting no-op location check stays quiet.
/**
 * Set the hash to an open wiring diagram: #apps/wiring/<CHASSIS>/<DOC>.
 * @param {string|null} chassis - Chassis id.
 * @param {string|null} doc - The schematic id.
 * @returns {void}
 */
function routeSetWiringDoc(chassis, doc) {
  if (_routing || !chassis || !doc) return;
  const route = `apps/wiring/${String(chassis).toUpperCase()}/${encodeURIComponent(doc)}`;
  if (currentRoute() === route) return;
  _routing = true;
  try {
    history.replaceState(null, '', '#' + route);
    _openRoute = route;
  } finally {
    _routing = false;
  }
}

// The garage's own sub-routes. showGarage is in ROUTE_FOR_SCREEN and syncs
// itself, but a car and a scan carry ids the crumb sync cannot know, so those
// screens set the hash themselves -- replaceState, like the other deep links,
// so walking a car's history doesn't stack an entry per scan opened.
/**
 * Set the hash to a garage route: #garage/<CAR>[/<SCAN>].
 * @param {string} route - the route, without the leading '#'
 * @returns {void}
 */
function garageRouteSet(route) {
  if (_routing || !route) return;
  if (currentRoute() === route) {
    _openRoute = route;
    return;
  }
  _routing = true;
  try {
    history.replaceState(null, '', '#' + route);
    _openRoute = route;
  } finally {
    _routing = false;
  }
}

/**
 * Set the hash to an open reference document: #apps/documents/<CHASSIS>/<DOCID>.
 * @param {string|null} chassis - Chassis id.
 * @param {string|null} docId - The document id.
 * @returns {void}
 */
function routeSetDocsDoc(chassis, docId) {
  if (_routing || !chassis || !docId) return;
  const route = `apps/documents/${String(chassis).toUpperCase()}/${encodeURIComponent(docId)}`;
  if (currentRoute() === route) return;
  _routing = true;
  try {
    history.replaceState(null, '', '#' + route);
    _openRoute = route;
  } finally {
    _routing = false;
  }
}

// Same, for an open ETK diagram: #apps/parts/<CHASSIS>/<HG>/<BTNR>.
/**
 * Set the hash to an open parts diagram: #apps/parts/<CHASSIS>/<HG>/<BTNR>.
 * @param {string|null} chassis - Chassis id.
 * @param {string|null} hg - The main group.
 * @param {string|null} btnr - The diagram number.
 * @returns {void}
 */
function routeSetEtkDiagram(chassis, hg, btnr) {
  if (_routing || !chassis || !hg || !btnr) return;
  const route =
    `apps/parts/${String(chassis).toUpperCase()}/` +
    `${encodeURIComponent(hg)}/${encodeURIComponent(btnr)}`;
  if (currentRoute() === route) return;
  _routing = true;
  try {
    history.replaceState(null, '', '#' + route);
    _openRoute = route;
  } finally {
    _routing = false;
  }
}

if (typeof window !== 'undefined') {
  window.installRouter = installRouter;
  window.routeApplyHash = routeApplyHash;
  window.routeSyncFromScreen = routeSyncFromScreen;
  window.routeSetWiringDoc = routeSetWiringDoc;
  window.routeSetDocsDoc = routeSetDocsDoc;
  window.routeSetEtkDiagram = routeSetEtkDiagram;
  window.routeSetCar = routeSetCar;
  window.routeSetCarList = routeSetCarList;
  window.garageRouteSet = garageRouteSet;
  window.routeSetJobSearch = routeSetJobSearch;
  window.routeSetService = routeSetService;
}
