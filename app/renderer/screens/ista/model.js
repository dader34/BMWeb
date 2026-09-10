/**
 * @file The ISTA shell's pure half: the tab model, the route grammar, the
 * favourites store and the banner's description line.
 *
 * Nothing here touches the DOM or the wire. The shell is CHROME AROUND THE
 * APP'S EXISTING SCREENS -- every sub-tab names a screen function the app
 * already has, and opening a tab is calling it. So this file is a table of
 * what exists, what does not, and why; screen.js turns a row into a click.
 *
 * A sub-tab is one of three things:
 *   `open`    a function name the app ships -- the tab calls it
 *   `page`    a page this shell draws itself (only Vehicle details/equipment)
 *   `why`     nothing yet: the tab greys and says this instead
 * `why` is the whole reason a row exists rather than being left out. A
 * workshop tool with a missing tab reads as broken; one that says "CBS
 * readout not built yet" reads as honest.
 */

/* exported ISTA_TABS istaRouteParse istaRouteBuild istaFavourites
   istaFavouriteToggle istaIsFavourite istaCarBits istaTab istaSub
   istaSubsOf istaFirstSub */

/** Settings key holding the pinned sub-tabs, newest first. */
const ISTA_FAVS_KEY = 'bmweb.ista.favourites';

/** How many favourites are kept; the oldest drops past this. */
const ISTA_FAVS_CAP = 24;

/** The tab the shell opens on when a route names none. */
const ISTA_HOME_TAB = 'home';

/**
 * One sub-tab: a row in a tab's strip.
 * @typedef {object} IstaSub
 * @property {string} id - stable id; the third part of the route
 * @property {string} label - what the strip shows
 * @property {string} [desc] - one line, shown on the home cards
 * @property {string} [open] - name of the app screen function this opens
 * @property {string} [page] - a page this shell draws itself
 * @property {string} [why] - greyed instead, with this as the reason
 * @property {boolean} [needsCar] - the opener takes the picked car's id
 */

/**
 * One tab: a group of sub-tabs.
 * @typedef {object} IstaTab
 * @property {string} id - stable id; the second part of the route
 * @property {string} label - what the tab bar shows
 * @property {string} [desc] - one line, shown on the shell's home cards
 * @property {IstaSub[]} subs - its sub-tabs, in strip order
 */

/**
 * The shell's tabs, in bar order.
 *
 * WHAT IS GREY AND WHY. Every `why` below is a fact about this build, not a
 * placeholder: Programming writes to the car and is deliberately not offered.
 * A tab that could work but has no data says so; a tab that WILL NOT work
 * says that instead, so the difference stays visible.
 *
 * WHAT IS DEV-ONLY. A sub-tab with `dev: true` exists only where Coding does
 * (codingReady in core/nav.js: not on the public site): the public build
 * never lists it, never routes to it and never resolves a pin to it.
 * Activation codes are BMW-issued licences and have no row at all.
 * @type {IstaTab[]}
 */
const ISTA_TABS = [
  {
    id: 'operations',
    label: 'Operations',
    desc: 'Read the car: fault memory, a whole-vehicle test, the test plan',
    subs: [
      {
        id: 'fault-memory',
        label: 'Fault memory',
        desc: 'The whole-car fault menu: its read key scans every module the chassis carries',
        open: 'istaOpenFaultMemory',
        needsCar: true,
      },
      {
        id: 'vehicle-test',
        label: 'Vehicle test',
        desc: 'Start the whole-car read now; the bus map colours in as modules answer',
        open: 'istaOpenVehicleTest',
        needsCar: true,
      },
      {
        id: 'test-plan',
        label: 'Test plan',
        desc: 'Fault codes with the ISTA procedure that diagnoses them',
        open: 'showLookup',
      },
      {
        id: 'service-functions',
        label: 'Service functions',
        desc: 'Calibrations, adaptation resets and service routines',
        open: 'istaOpenService',
        needsCar: true,
      },
      {
        id: 'function-search',
        label: 'Function search',
        desc: "Find any screen or key in INPA's scripts by what it does",
        open: 'showJobSearch',
      },
    ],
  },
  {
    id: 'information',
    label: 'Vehicle information',
    desc: 'What the car is, what it was built with, and what has been read off it',
    subs: [
      {
        id: 'details',
        label: 'Vehicle details',
        desc: 'VIN, chassis, model, engine, body and build date, read off the car',
        page: 'details',
        needsCar: true,
      },
      {
        id: 'equipment',
        label: 'Vehicle equipment',
        desc: 'Every SA option the build record carries, with its name',
        page: 'equipment',
        needsCar: true,
      },
      {
        id: 'history',
        label: 'Repair history',
        desc: 'Every scan kept against this car, newest first',
        open: 'istaOpenHistory',
        needsCar: true,
      },
      {
        id: 'tree',
        label: 'Control unit tree',
        desc: 'Every module the chassis can carry, drawn on its bus',
        open: 'istaOpenTree',
        needsCar: true,
      },
      {
        id: 'unit-list',
        label: 'Control unit list',
        desc: "The whole-car script's menu: its Ident key asks each module what it is",
        open: 'istaOpenIdentScan',
        needsCar: true,
      },
      {
        id: 'report',
        label: 'Operations report',
        desc: 'The newest stored read, as its report',
        open: 'istaOpenLatestReport',
        needsCar: true,
      },
      {
        id: 'service-cases',
        label: 'Information in Service Cases',
        why: "BMW's service-case bulletins are not in this build",
      },
    ],
  },
  {
    id: 'management',
    label: 'Vehicle management',
    desc: 'Identify the car, open a module, and the write paths (mostly closed)',
    subs: [
      {
        id: 'identification',
        label: 'Identification',
        desc: 'What the car reports about its own build',
        open: 'istaOpenIdentity',
        needsCar: true,
      },
      {
        id: 'delete-faults',
        label: 'Delete fault memories',
        why: 'no whole-car clear exists: clearing is per module, behind its own confirm',
      },
      {
        id: 'unit-functions',
        label: 'Control unit functions',
        desc: "The chassis's module list; each one opens its INPA script",
        open: 'istaOpenModules',
        needsCar: true,
      },
      {
        id: 'coding',
        label: 'Coding',
        desc: "The chassis's coding hub: feature toggles and the expert editor",
        open: 'istaOpenCoding',
        needsCar: true,
        dev: true,
      },
      {
        id: 'programming',
        label: 'Programming',
        why: 'deliberately not offered: flashing a module can brick it',
        dev: true,
      },
    ],
  },
  {
    id: 'service-plan',
    label: 'Service plan',
    desc: 'Condition Based Service and the routines that reset it',
    subs: [
      {
        id: 'resets',
        label: 'Service functions',
        desc: 'Only the service-interval resets this chassis carries',
        open: 'istaOpenServiceResets',
        needsCar: true,
      },
    ],
  },
  {
    id: 'workshop',
    label: 'Workshop',
    desc: 'Technical data, tightening torques, operating fluids and special tools',
    subs: [
      {
        id: 'equipment',
        label: 'Workshop / Operating fluids',
        desc: 'Browse the reference documents by category, filtered to this car',
        page: 'techdata',
        needsCar: true,
      },
    ],
  },
  {
    id: 'favourites',
    label: 'Favourites',
    desc: 'The sub-tabs you pinned with the star',
    subs: [],
  },
];

/**
 * A tab by id.
 * @param {string} id - the tab id
 * @returns {IstaTab|null}
 */
function istaTab(id) {
  return ISTA_TABS.find((t) => t.id === id) || null;
}

/**
 * Whether the dev-only sub-tabs show on this host. The gate is the one the
 * module list already uses for its Coding entry, so ISTA and INPA mode agree;
 * a host without that helper (tests, the packaged app) is a dev host.
 * @returns {boolean}
 */
function istaDevHost() {
  return typeof codingReady === 'function' ? codingReady() : true;
}

/**
 * Whether a sub-tab exists on this host.
 * @param {IstaSub} s - the sub-tab
 * @returns {boolean}
 */
function istaSubShown(s) {
  return !s.dev || istaDevHost();
}

/**
 * A sub-tab by tab and sub id.
 * @param {string} tabId - the tab
 * @param {string} subId - the sub-tab
 * @returns {IstaSub|null}
 */
function istaSub(tabId, subId) {
  const t = istaTab(tabId);
  if (!t) return null;
  const s = (t.subs || []).find((x) => x.id === subId) || null;
  return s && istaSubShown(s) ? s : null;
}

/**
 * A tab's sub-tabs. Favourites has none of its own: it resolves the pinned
 * routes back to the sub-tabs they name, so a pin follows a renamed label.
 * @param {string} tabId - the tab
 * @returns {IstaSub[]}
 */
function istaSubsOf(tabId) {
  if (tabId !== 'favourites') {
    const t = istaTab(tabId);
    return t ? (t.subs || []).filter(istaSubShown) : [];
  }
  return istaFavourites()
    .map((f) => {
      const s = istaSub(f.tab, f.sub);
      // carry the owning tab so the strip can route a pinned row back
      return s ? Object.assign({}, s, { _tab: f.tab }) : null;
    })
    .filter(Boolean);
}

/**
 * The sub-tab a tab opens on: its first, whatever that is. A greyed first
 * row still wins -- the tab must land somewhere, and its reason is the
 * honest thing to show.
 * @param {string} tabId - the tab
 * @returns {IstaSub|null}
 */
function istaFirstSub(tabId) {
  return istaSubsOf(tabId)[0] || null;
}

/**
 * Parse an ISTA route.
 *
 * The grammar is `#ista[/<tab>[/<sub>[/<car>]]]`. The car is LAST rather
 * than first (the tree puts it second) because a tab and a sub-tab are what
 * a link is usually about, and a car id is local to one browser -- a link
 * someone sends still opens the right tab when the car id means nothing on
 * the other end.
 * @param {string} route - the hash without its '#'
 * @returns {{tab: string, sub: string|null, car: string|null}|null} null when
 *   the route is not an ISTA one.
 */
function istaRouteParse(route) {
  const m =
    /^ista(?:\/([A-Za-z0-9_-]+))?(?:\/([A-Za-z0-9_-]+))?(?:\/([A-Za-z0-9_-]+))?$/.exec(
      String(route || '')
    );
  if (!m) return null;
  return {
    tab: m[1] ? decodeURIComponent(m[1]) : ISTA_HOME_TAB,
    sub: m[2] ? decodeURIComponent(m[2]) : null,
    car: m[3] ? decodeURIComponent(m[3]) : null,
  };
}

/**
 * Build an ISTA route. Trailing empties are dropped, so the home tab with no
 * car is the bare `ista` and round-trips through istaRouteParse.
 * @param {string|null} [tab] - the tab id
 * @param {string|null} [sub] - the sub-tab id
 * @param {string|null} [car] - the picked car's id
 * @returns {string} the route, without its '#'
 */
function istaRouteBuild(tab, sub, car) {
  const parts = ['ista'];
  const t = tab && tab !== ISTA_HOME_TAB ? String(tab) : '';
  // a car with no sub-tab still needs the slots before it filled, so the
  // three parts stay positional
  if (car && !t) return 'ista';
  if (!t) return 'ista';
  parts.push(encodeURIComponent(t));
  if (sub) parts.push(encodeURIComponent(String(sub)));
  else if (car) return parts.join('/');
  if (car) parts.push(encodeURIComponent(String(car)));
  return parts.join('/');
}

/**
 * Read a JSON value from Settings, guarding its shape. A hand-edited value
 * must not take the shell down.
 * @param {string} key - the Settings key
 * @param {*} fallback - value when unset or the wrong shape
 * @param {(v: *) => boolean} shapeOk - shape guard
 * @returns {*}
 */
function istaRead(key, fallback, shapeOk) {
  if (typeof Settings !== 'object' || !Settings || !Settings.get)
    return fallback;
  const v = Settings.get(key, fallback);
  return shapeOk(v) ? v : fallback;
}

/**
 * The pinned sub-tabs, newest first. A pin that names a tab or sub-tab this
 * build no longer has is dropped on read rather than drawn as a dead row.
 * @returns {Array<{tab: string, sub: string}>}
 */
function istaFavourites() {
  const raw = istaRead(ISTA_FAVS_KEY, [], Array.isArray);
  return raw
    .filter((f) => f && typeof f.tab === 'string' && typeof f.sub === 'string')
    .filter((f) => !!istaSub(f.tab, f.sub))
    .slice(0, ISTA_FAVS_CAP);
}

/**
 * Is this sub-tab pinned?
 * @param {string} tab - the tab id
 * @param {string} sub - the sub-tab id
 * @returns {boolean}
 */
function istaIsFavourite(tab, sub) {
  return istaFavourites().some((f) => f.tab === tab && f.sub === sub);
}

/**
 * Pin or unpin a sub-tab; returns its state after the toggle.
 * @param {string} tab - the tab id
 * @param {string} sub - the sub-tab id
 * @returns {boolean} true when it is now pinned
 */
function istaFavouriteToggle(tab, sub) {
  const now = istaFavourites();
  const at = now.findIndex((f) => f.tab === tab && f.sub === sub);
  let next;
  let pinned;
  if (at >= 0) {
    next = now.filter((_, i) => i !== at);
    pinned = false;
  } else {
    next = [{ tab, sub }, ...now].slice(0, ISTA_FAVS_CAP);
    pinned = true;
  }
  if (typeof Settings === 'object' && Settings && Settings.set)
    Settings.set(ISTA_FAVS_KEY, next);
  return pinned;
}

/**
 * The banner's description line for a car: what it is, in one line.
 *
 * Deliberately NOT garageCarBits: the banner has the chassis on its own
 * line already, so repeating it here would waste the width the model and
 * engine need. Everything else comes from the same Garage fields, through
 * the same formatters, so a date reads the same in both places.
 * @param {object|null} car - a GarageCar, or null
 * @returns {string} the line, empty when nothing is known
 */
function istaCarBits(car) {
  if (!car) return '';
  const date =
    car.prod && typeof etkYearMonth === 'function'
      ? etkYearMonth(String(car.prod))
      : '';
  const body =
    car.body && typeof bodyLabel === 'function' ? bodyLabel(car.body) : '';
  return [car.model, body, car.motor, date].filter(Boolean).join(' · ');
}

if (typeof window !== 'undefined') {
  window.ISTA_TABS = ISTA_TABS;
  window.istaRouteParse = istaRouteParse;
  window.istaRouteBuild = istaRouteBuild;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_TABS,
    ISTA_HOME_TAB,
    ISTA_FAVS_KEY,
    ISTA_FAVS_CAP,
    istaTab,
    istaSub,
    istaSubsOf,
    istaFirstSub,
    istaRouteParse,
    istaRouteBuild,
    istaFavourites,
    istaIsFavourite,
    istaFavouriteToggle,
    istaCarBits,
  };
}
