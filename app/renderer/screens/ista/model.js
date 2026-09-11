/**
 * @file The ISTA shell's pure half: the tab model, the route grammar, the
 * favourites store and the banner's description line.
 *
 * Nothing here touches the DOM or the wire. The shell is CHROME AROUND THE
 * APP'S EXISTING SCREENS -- every sub-tab names a screen function the app
 * already has, and opening a tab is calling it. So this file is a table of
 * what exists, what does not, and why; screen.js turns a row into a click.
 *
 * A sub-tab is one of four things:
 *   `open`    a function name the app ships -- the tab calls it
 *   `page`    a page this shell draws itself (see details.js / pages.js)
 *   `subs3`   a level-3 strip: the real leaves are one level further down
 *   `why`     nothing yet: the tab greys and says this instead
 * `why` is the whole reason a row exists rather than being left out. A
 * workshop tool with a missing tab reads as broken; one that says "CBS
 * readout not built yet" reads as honest.
 *
 * THE LABELS ARE BMW'S. The tab and sub-tab names below are the exact
 * strings the real workshop tool shows, including its capitalisation
 * inconsistencies ("Control Unit Replacement" beside "Vehicle modification").
 * They are not ours to tidy: a technician reads them as landmarks, and a
 * renamed landmark is a tool that no longer matches the one they trained on.
 */

/* exported ISTA_TABS istaRouteParse istaRouteBuild istaFavourites
   istaFavouriteToggle istaIsFavourite istaCarBits istaTab istaSub
   istaSubsOf istaFirstSub istaSub3 istaSubs3Of istaFirstSub3 istaLeaf
   ISTA_BOTTOM istaBottomFor */

/** Settings key holding the pinned sub-tabs, newest first. */
const ISTA_FAVS_KEY = 'bmweb.ista.favourites';

/** How many favourites are kept; the oldest drops past this. */
const ISTA_FAVS_CAP = 24;

/** The tab the shell opens on when a route names none. */
const ISTA_HOME_TAB = 'operations';

/** The sub-tab the shell opens on: Operations / New. */
const ISTA_HOME_SUB = 'new';

/** The level-3 the shell opens on: Operations / New / VIN. */
const ISTA_HOME_SUB3 = 'vin';

/**
 * One level-3 tab: a row in the strip under a sub-tab.
 * @typedef {object} IstaSub3
 * @property {string} id - stable id; the fourth part of the route
 * @property {string} label - what the strip shows
 * @property {string} [desc] - one line, shown on the home cards
 * @property {string} [open] - name of the app screen function this opens
 * @property {string} [page] - a page this shell draws itself
 * @property {string} [why] - greyed instead, with this as the reason
 * @property {boolean} [needsCar] - the opener takes the picked car's id
 * @property {boolean} [dev] - dev hosts only
 */

/**
 * One sub-tab: a row in a tab's strip.
 * @typedef {object} IstaSub
 * @property {string} id - stable id; the third part of the route
 * @property {string} label - what the strip shows
 * @property {string} [desc] - one line, shown on the home cards
 * @property {string} [open] - name of the app screen function this opens
 * @property {string} [page] - a page this shell draws itself
 * @property {IstaSub3[]} [subs3] - a level-3 strip under this sub-tab
 * @property {string} [why] - greyed instead, with this as the reason
 * @property {boolean} [needsCar] - the opener takes the picked car's id
 * @property {boolean} [dev] - dev hosts only
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
 * @type {IstaTab[]}
 */
const ISTA_TABS = [
  {
    id: 'operations',
    label: 'Operations',
    desc: 'Open a vehicle: by VIN, off the cable, or by model code',
    subs: [
      {
        id: 'new',
        label: 'New',
        desc: 'Start work on a vehicle',
        subs3: [
          {
            id: 'vin',
            label: 'VIN',
            desc: 'Type a VIN, or pick a car the Garage already holds',
            page: 'vin',
          },
          {
            id: 'readout',
            label: 'Read Out Vehicle Data',
            desc: 'Ask the car on the cable what it is',
            page: 'readout',
          },
          {
            id: 'model-code',
            label: 'Model code',
            why: 'the four-character model code is not indexed in this build: open the car by VIN instead',
          },
          {
            id: 'basic-features',
            label: 'Basic Features',
            why: 'picking a car by series, body and engine alone is not in this build: open it by VIN instead',
          },
        ],
      },
      {
        id: 'finished',
        label: 'Finished',
        desc: 'Every scan the Garage has kept, newest first',
        page: 'finished',
        needsCar: true,
      },
      {
        id: 'active',
        label: 'Active',
        desc: 'The vehicle this session is open on',
        page: 'active',
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
        desc: 'VIN, chassis, model, engine, body and build date',
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
        page: 'history',
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
        desc: 'Every module the chassis carries, with what the newest test found',
        page: 'unit-list',
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
        id: 'service-consultation',
        label: 'Info from Service Consultation',
        why: "BMW's service-consultation feed is a dealer system: this build has no access to it",
      },
    ],
  },
  {
    id: 'management',
    label: 'Vehicle management',
    desc: 'Repair documents, fault memory, service functions and the write paths',
    subs: [
      {
        id: 'repair',
        label: 'Repair/maintenance',
        desc: 'Repair instructions, tightening torques and technical data',
        subs3: [
          {
            id: 'product-structure',
            label: 'Product Structure',
            desc: 'Browse the repair documents by assembly group',
            page: 'repair',
          },
          {
            id: 'text-search',
            label: 'Text Search',
            desc: 'Find a repair document by what it is called',
            page: 'repair',
          },
        ],
      },
      {
        id: 'troubleshooting',
        label: 'Troubleshooting',
        desc: 'Fault memory, fault patterns and the structures that index them',
        subs3: [
          {
            id: 'fault-memory',
            label: 'Fault memory',
            desc: 'Every fault the newest vehicle test found, whichever module it came from',
            page: 'fault-memory',
            needsCar: true,
          },
          {
            id: 'fault-pattern',
            label: 'Fault pattern',
            desc: "BMW's symptom catalogue, and the documents each symptom points at",
            page: 'diag',
            needsCar: true,
          },
          {
            id: 'function-structure',
            label: 'Function Structure',
            desc: "BMW's function net: what the car does, and the documents behind it",
            page: 'diag',
            needsCar: true,
          },
          {
            id: 'component-structure',
            label: 'Component Structure',
            desc: "BMW's component tree: what the car is made of, and its documents",
            page: 'diag',
            needsCar: true,
          },
          {
            id: 'text-search',
            label: 'Text Search',
            desc: "Find any screen or key in INPA's scripts by what it does",
            open: 'showJobSearch',
          },
          {
            id: 'sae-input',
            label: 'SAE fault code input',
            desc: 'Look a fault code up by its SAE number, or the other way round',
            page: 'sae',
          },
        ],
      },
      {
        id: 'service-functions',
        label: 'Service functions',
        desc: 'Calibrations, adaptation resets and service routines',
        subs3: [
          {
            id: 'service-functions',
            label: 'Service Functions',
            desc: 'Calibrations, adaptation resets and service routines, by module',
            page: 'service-tree',
            needsCar: true,
          },
        ],
      },
      {
        id: 'software-update',
        label: 'Software update',
        desc: 'Programming: deliberately not offered',
        subs3: [
          {
            id: 'comfort',
            label: 'Comfort',
            why: 'programming is deliberately not offered: flashing a module can brick it',
          },
          {
            id: 'advanced',
            label: 'Advanced',
            why: 'programming is deliberately not offered: flashing a module can brick it',
          },
          {
            id: 'additional',
            label: 'Additional software',
            why: 'programming is deliberately not offered: flashing a module can brick it',
          },
        ],
      },
      {
        id: 'unit-replacement',
        label: 'Control Unit Replacement',
        desc: 'What a swapped module needs before and after the exchange',
        subs3: [
          {
            id: 'before',
            label: 'Before Replacement',
            why: 'the replacement workflow needs programming, which is deliberately not offered',
          },
          {
            id: 'after',
            label: 'After Replacement',
            why: 'the replacement workflow needs programming, which is deliberately not offered',
          },
        ],
      },
      {
        id: 'modification',
        label: 'Vehicle modification',
        desc: 'Retrofits and conversions',
        subs3: [
          {
            id: 'retrofit',
            label: 'Retrofit',
            why: 'retrofit measures need programming, which is deliberately not offered',
          },
          {
            id: 'conversion',
            label: 'Conversion',
            why: 'conversion measures need programming, which is deliberately not offered',
          },
          {
            id: 'conversion-coding',
            label: 'Conversion (coding only)',
            desc: "The chassis's coding hub: feature toggles and the expert editor",
            open: 'istaOpenCoding',
            needsCar: true,
            dev: true,
          },
          {
            id: 'removal',
            label: 'Removal of Retrofit/Conversion',
            why: 'removal measures need programming, which is deliberately not offered',
          },
          {
            id: 'remove-coding',
            label: 'Remove conversion (coding only)',
            desc: "The chassis's coding hub: feature toggles and the expert editor",
            open: 'istaOpenCoding',
            needsCar: true,
            dev: true,
          },
          {
            id: 'immediate',
            label: 'Immediate actions',
            why: 'immediate-action measures need programming, which is deliberately not offered',
          },
        ],
      },
    ],
  },
  {
    id: 'service-plan',
    label: 'Service plan',
    desc: 'The documents a stored fault points at, and the plans built from them',
    subs: [
      {
        id: 'hit-list',
        label: 'Hit list',
        desc: 'The documents each stored fault points at',
        page: 'plan',
        needsCar: true,
      },
      {
        id: 'test-plan',
        label: 'Test plan',
        desc: 'What this session added from the fault patterns',
        page: 'plan',
      },
      {
        id: 'programming-plan',
        label: 'Programming plan',
        desc: 'Programming is deliberately not offered',
        page: 'plan',
      },
    ],
  },
  {
    id: 'favourites',
    label: 'Favourites',
    desc: 'The sub-tabs you pinned with the star',
    subs: [],
  },
  {
    id: 'workshop',
    label: 'Workshop/\nOperating fluids',
    desc: 'Technical data, tightening torques, operating fluids and special tools',
    subs: [
      {
        id: 'techdata',
        label: 'Workshop/Operating fluids',
        desc: 'Browse the reference documents by category, filtered to this car',
        page: 'techdata',
        needsCar: true,
      },
    ],
  },
];

/**
 * The bottom button bar, per page.
 *
 * WHY THIS IS A TABLE. The bars used to be built inline at each call site
 * from one template, which is how every page ended up with the pair of nav
 * arrows. The frames are clear that most pages have no arrows at all: they
 * belong to the two-pane BROWSERS (Product Structure, Service Functions, the
 * Function and Component structures, the fault-pattern hit list) and to the
 * Service plan lists, because those are the pages you step through. A page
 * that is not a list of hits does not get them -- Vehicle details carries
 * four plain buttons, the VIN page carries Keyboard and Open operation, and
 * Fault memory carries its own six.
 *
 * Each entry is a list of button descriptors, left to right:
 *   {id, label}      a button; the screen binds `id` to what it does
 *   {off: true}      drawn greyed, because this build cannot do it
 *   {nav: true}      the pair of black nav blocks, and everything after it
 *                    goes to the right-hand group
 * The ids are bound in screen.js, so this table stays a table: it says WHAT
 * a page offers and in which order, never how any of it works.
 * @type {Object<string, Array<object>>}
 */
const ISTA_BOTTOM = {
  // Operations / New / VIN: no arrows, one greyed left, one live right
  vin: [
    { id: 'keyboard', label: 'Keyboard', off: true },
    { spacer: true },
    { id: 'open-operation', label: 'Open operation' },
  ],
  // Read Out Vehicle Data: the connection manager's own row
  readout: [
    { id: 'cancel', label: 'Cancel' },
    { spacer: true },
    { id: 'ident-only', label: 'Identification without vehicle test' },
    { id: 'ident-full', label: 'Complete identification' },
  ],
  // Vehicle details (key2/t0159.0.jpg): four buttons, no arrows
  details: [
    { spacer: true },
    { id: 'measures-plan', label: 'Display measures plan', off: true },
    { id: 'service-history', label: 'Write service history', off: true },
    { id: 'vehicle-test', label: 'Start vehicle test' },
    { id: 'info-search', label: 'Information search' },
  ],
  equipment: [
    { spacer: true },
    { id: 'measures-plan', label: 'Display measures plan', off: true },
    { id: 'service-history', label: 'Write service history', off: true },
    { id: 'show-test', label: 'Show vehicle test' },
    { id: 'info-search', label: 'Information search' },
  ],
  // Fault memory: its own six, and Calculate test plan alone on the right
  'fault-memory': [
    { id: 'show-code', label: 'Show fault code', off: true },
    { id: 'delete-faults', label: 'Delete fault\nmemory' },
    { id: 'filter-faults', label: 'Filter fault memory' },
    { id: 'delete-filter', label: 'Delete filter', off: true },
    { id: 'show-all', label: 'Show completely' },
    { spacer: true },
    { id: 'calc-plan', label: 'Calculate test plan', off: true },
  ],
  // the two-pane browsers: these DO step through hits, so they keep the arrows
  'service-functions': [
    { id: 'filters', label: 'Filters' },
    { nav: true },
    { id: 'add-plan', label: 'Add to test plan', off: true },
    { id: 'display', label: 'Display' },
  ],
  'product-structure': [
    { id: 'filters', label: 'Filters' },
    { nav: true },
    { id: 'display', label: 'Display' },
  ],
  'fault-pattern': [
    { spacer: true },
    { id: 'add-pattern', label: 'Add fault pattern', off: true },
    { id: 'show-pattern', label: 'Show fault pattern', off: true },
    { id: 'calc-plan', label: 'Calculate test plan', off: true },
  ],
  // the Service plan lists
  'hit-list': [
    { id: 'back', label: 'Back' },
    { id: 'filters', label: 'Filters' },
    { id: 'symptoms', label: 'Show symptoms', off: true },
    { nav: true },
    { id: 'std-filter', label: 'Set standard filter', off: true },
    { id: 'display', label: 'Display' },
  ],
  // a page with nothing of its own: no bar at all rather than a bare pair of
  // arrows that step through nothing
  none: [],
};

/**
 * The bottom bar a page offers.
 * @param {string} id - the leaf's id, or a page name
 * @returns {Array<object>} the button descriptors, possibly empty
 */
function istaBottomFor(id) {
  return ISTA_BOTTOM[id] || ISTA_BOTTOM.none;
}

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
 * @param {IstaSub|IstaSub3} s - the sub-tab
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
      if (!s) return null;
      // carry the owning tab and level-3 so the strip can route a pin back
      return Object.assign({}, s, { _tab: f.tab, _sub3: f.sub3 || null });
    })
    .filter(Boolean);
}

/**
 * A sub-tab's level-3 strip, empty when it has none.
 * @param {string} tabId - the tab
 * @param {string} subId - the sub-tab
 * @returns {IstaSub3[]}
 */
function istaSubs3Of(tabId, subId) {
  const s = istaSub(tabId, subId);
  return s && s.subs3 ? s.subs3.filter(istaSubShown) : [];
}

/**
 * A level-3 tab by tab, sub and sub3 id.
 * @param {string} tabId - the tab
 * @param {string} subId - the sub-tab
 * @param {string} sub3Id - the level-3 tab
 * @returns {IstaSub3|null}
 */
function istaSub3(tabId, subId, sub3Id) {
  return istaSubs3Of(tabId, subId).find((x) => x.id === sub3Id) || null;
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
 * The level-3 tab a sub-tab opens on: its first, or null when it has no
 * level-3 strip at all.
 * @param {string} tabId - the tab
 * @param {string} subId - the sub-tab
 * @returns {IstaSub3|null}
 */
function istaFirstSub3(tabId, subId) {
  return istaSubs3Of(tabId, subId)[0] || null;
}

/**
 * The row a route actually lands on: the level-3 tab when the sub-tab has a
 * strip, else the sub-tab itself.
 *
 * This is the one place that knows a two-level route and a three-level route
 * mean the same kind of thing. Everything downstream -- readiness, opening,
 * the favourites star -- works on the leaf this returns and never has to ask
 * how deep it was.
 * @param {string} tabId - the tab
 * @param {string} subId - the sub-tab
 * @param {string|null} [sub3Id] - the level-3 tab, when the route named one
 * @returns {IstaSub|IstaSub3|null}
 */
function istaLeaf(tabId, subId, sub3Id) {
  const s = istaSub(tabId, subId);
  if (!s) return null;
  if (!s.subs3) return s;
  return (
    (sub3Id && istaSub3(tabId, subId, sub3Id)) || istaFirstSub3(tabId, subId)
  );
}

/**
 * Parse an ISTA route.
 *
 * The grammar is `#ista[/<tab>[/<sub>[/<sub3>[/<car>[/<view>[/<item>]]]]]]`.
 *
 * The car sits FOURTH rather than first (the tree puts it second) because a
 * tab and a sub-tab are what a link is usually about, and a car id is local
 * to one browser -- a link someone sends still opens the right tab when the
 * car id means nothing on the other end.
 *
 * The last two slots belong to the SUB-TAB, not the shell: a page that is
 * really a browser with documents under it (Repair/maintenance, the
 * diagnosis structures, Workshop) needs to say which view and which
 * document, and nothing above it can express that. They sit after the car so
 * every shorter route keeps its exact shape, and a page that wants no view
 * simply never fills them.
 *
 * THREE-PART ROUTES STILL PARSE. A route written before the level-3 strips
 * existed put the car where the sub3 now sits. Telling them apart by shape
 * alone is not possible, so the third part is read as a sub3 when the tab
 * and sub name a real strip that has it, and as a car otherwise -- which is
 * what every old link was.
 * @param {string} route - the hash without its '#'
 * @returns {{tab: string, sub: string|null, sub3: string|null,
 *   car: string|null, view: string|null, item: string|null}|null} null when
 *   the route is not an ISTA one.
 */
function istaRouteParse(route) {
  const part = '(?:\\/([A-Za-z0-9_-]+))?';
  const m = new RegExp(`^ista${part}${part}${part}${part}${part}${part}$`).exec(
    String(route || '')
  );
  if (!m) return null;
  // '-' is the placeholder the builder writes for a slot a route skips, so
  // the ones after it keep their positions
  const at = (i) => {
    const v = m[i] ? decodeURIComponent(m[i]) : null;
    return v === '-' ? null : v;
  };
  const tab = at(1) || ISTA_HOME_TAB;
  const sub = at(2);
  const third = at(3);
  const rest = { view: at(5), item: at(6) };
  // FOUR OR MORE PARTS: the slots are exactly what they look like.
  if (m[4]) return Object.assign({ tab, sub, sub3: third, car: at(4) }, rest);
  // THREE PARTS: a route written before the level-3 strips existed put the
  // car where the sub3 now sits, and the two cannot be told apart by shape.
  // The third part is a sub3 only when the tab and sub ahead of it really
  // have one of that name -- which no old link ever did.
  const isSub3 = !!(third && sub && istaSub3(tab, sub, third));
  return Object.assign(
    { tab, sub, sub3: isSub3 ? third : null, car: isSub3 ? null : third },
    rest
  );
}

/**
 * Build an ISTA route. Trailing empties are dropped, so the home tab with no
 * car is the bare `ista` and round-trips through istaRouteParse.
 *
 * The slots are positional, so a later one can only be filled when every
 * earlier one is: a view with no car would land in the car's slot and read
 * back as a car. A sub-tab that wants a view on a car the Garage has not
 * saved therefore gets no view in the URL, which costs it the deep link but
 * never sends the reader to the wrong place.
 * @param {string|null} [tab] - the tab id
 * @param {string|null} [sub] - the sub-tab id
 * @param {string|null} [sub3] - the level-3 tab id
 * @param {string|null} [car] - the picked car's id
 * @param {string|null} [view] - the sub-tab's own page, when it has pages
 * @param {string|null} [item] - what that page has open
 * @returns {string} the route, without its '#'
 */
function istaRouteBuild(tab, sub, sub3, car, view, item) {
  const t = tab ? String(tab) : '';
  if (!t) return 'ista';
  const parts = ['ista', encodeURIComponent(t)];
  if (!sub) return parts.join('/');
  parts.push(encodeURIComponent(String(sub)));
  // every slot after this is positional, so a route that skips one still has
  // to fill it; '-' is not a legal id, so it reads back as "none" rather
  // than as a level-3 tab or a car nobody has
  const tail = [sub3 || '', car || '', view || '', item || ''];
  while (tail.length && !tail[tail.length - 1]) tail.pop();
  for (const v of tail) parts.push(v ? encodeURIComponent(String(v)) : '-');
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
 * @returns {Array<{tab: string, sub: string, sub3?: string}>}
 */
function istaFavourites() {
  const raw = istaRead(ISTA_FAVS_KEY, [], Array.isArray);
  return (
    raw
      .filter(
        (f) => f && typeof f.tab === 'string' && typeof f.sub === 'string'
      )
      .filter((f) => !!istaSub(f.tab, f.sub))
      // a pin naming a level-3 must still find it; one naming none is fine
      .filter((f) => !f.sub3 || !!istaSub3(f.tab, f.sub, f.sub3))
      .slice(0, ISTA_FAVS_CAP)
  );
}

/**
 * Is this sub-tab pinned?
 * @param {string} tab - the tab id
 * @param {string} sub - the sub-tab id
 * @param {string|null} [sub3] - the level-3 tab id
 * @returns {boolean}
 */
function istaIsFavourite(tab, sub, sub3) {
  return istaFavourites().some(
    (f) => f.tab === tab && f.sub === sub && (f.sub3 || null) === (sub3 || null)
  );
}

/**
 * Pin or unpin a sub-tab; returns its state after the toggle.
 * @param {string} tab - the tab id
 * @param {string} sub - the sub-tab id
 * @param {string|null} [sub3] - the level-3 tab id
 * @returns {boolean} true when it is now pinned
 */
function istaFavouriteToggle(tab, sub, sub3) {
  const s3 = sub3 || null;
  const now = istaFavourites();
  const at = now.findIndex(
    (f) => f.tab === tab && f.sub === sub && (f.sub3 || null) === s3
  );
  let next;
  let pinned;
  if (at >= 0) {
    next = now.filter((_, i) => i !== at);
    pinned = false;
  } else {
    const entry = s3 ? { tab, sub, sub3: s3 } : { tab, sub };
    next = [entry, ...now].slice(0, ISTA_FAVS_CAP);
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
    ISTA_HOME_SUB,
    ISTA_HOME_SUB3,
    ISTA_FAVS_KEY,
    ISTA_FAVS_CAP,
    ISTA_BOTTOM,
    istaBottomFor,
    istaTab,
    istaSub,
    istaSub3,
    istaSubsOf,
    istaSubs3Of,
    istaFirstSub,
    istaFirstSub3,
    istaLeaf,
    istaRouteParse,
    istaRouteBuild,
    istaFavourites,
    istaIsFavourite,
    istaFavouriteToggle,
    istaCarBits,
  };
}
