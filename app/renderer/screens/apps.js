/**
 * @file The Apps hub: reference tools ported from BMW's own dealer software,
 * each its own self-contained screen with its own data bundle. WDS wiring was
 * the first; this section is where the rest land. A port here is always the
 * wiring shape: raw BMW data stripped of its viewer, packed into archives the
 * renderer inflates, drawn by a dedicated screen.
 *
 * APP_REGISTRY is the single list. To add a ported app: give it an id, the
 * card copy, the screen function to open, and (optionally) an async check for
 * whether its data actually shipped in this build -- an app with no data is
 * shown greyed with a "not in this build" note rather than hidden, so the
 * section reads the same whether or not the heavy bundles are present.
 */

/* exported showApps */

/**
 * One ported app on the hub.
 * @typedef {object} AppEntry
 * @property {string} id - stable id; also the card's data-app, which the guided tour spotlights
 * @property {string} icon - a single glyph for the card
 * @property {string} title - card title
 * @property {string} desc - one-line description (the classic status line, the card's tooltip, search)
 * @property {string} [short] - a few words that fit a home row
 * @property {string} tag - the BMW tool it was ported from ("ETK", "WDS · ISTA"); kept on the entry, not drawn
 * @property {() => void} open - opens the app's screen
 * @property {() => Promise<boolean>} [hasData] - did the app's data ship in this build? Absent = always
 */

/** How many openable apps get a number key. */
const APPS_FKEY_SLOTS = 8;

/** Stagger step (ms) of the app cards. */
const APPS_STAGGER = 20;

/** @type {AppEntry[]} */
const APP_REGISTRY = [
  {
    // what the app used to open on: the vehicle picker, then a car's
    // modules, fault memory and live values the way INPA lays them out
    id: 'inpa',
    icon: '▣',
    title: 'Diagnostics',
    short: 'Modules, faults, live values',
    desc: 'Pick a vehicle, then its modules, faults and live values',
    tag: 'INPA',
    open: () => showChassis(),
    hasData: async () => true,
  },
  {
    id: 'ista',
    icon: '▤',
    title: 'Workshop',
    short: 'Dealership diagnostics',
    desc: "Every read on one vehicle behind one set of tabs, ISTA's way",
    tag: 'ISTA',
    open: () => (typeof showIsta === 'function' ? showIsta() : null),
    // a shell over screens this build already has -- ready whenever its own
    // code shipped. What each tab can actually do is decided per car, on the
    // shell's own home, where it can say why a tab is dark.
    hasData: async () => typeof showIsta === 'function',
  },
  {
    // the reference scanner's full car scan (BMW Scanner 1.4.0.7), rebuilt
    // on this cable: every module identified, its faults counted, one log
    id: 'scanner',
    icon: '⌖',
    title: 'BMWeb Scanner',
    short: 'Scan every module on the car',
    desc: 'Scan every module on the car and log what it reports',
    tag: 'PA Soft',
    open: () => (typeof showScanner === 'function' ? showScanner() : null),
    hasData: async () => typeof showScanner === 'function',
  },
  {
    id: 'lookup',
    icon: '⌕',
    title: 'Fault codes',
    short: 'Fault codes and service data',
    desc: 'Search fault codes, read ISTA service data and diagnostic procedures',
    tag: 'DTC',
    open: () => showLookup(),
    // always available: the fault database ships with the app shell
    hasData: async () => true,
  },
  {
    id: 'job-search',
    icon: '⌕',
    title: 'Job search',
    short: 'Find any INPA screen or job',
    desc: "Find any screen or key in INPA's scripts by what it does, and open it",
    tag: 'IPO',
    open: () => (typeof showJobSearch === 'function' ? showJobSearch() : null),
    // the index is an export artifact; a build without it shows the card
    // greyed rather than opening a screen that can only say "no index".
    // Asks whether the file is THERE -- downloading 2 MB to draw a hub card
    // would make opening Apps cost as much as opening the app.
    hasData: async () =>
      typeof showJobSearch === 'function' &&
      typeof searchIndexPresent === 'function' &&
      (await searchIndexPresent()),
  },
  {
    id: 'wiring',
    icon: '⌁',
    title: 'Wiring & Documents',
    short: 'Wiring diagrams and documents',
    desc: 'Interactive wiring and documents search',
    tag: 'WDS · ISTA',
    open: () => wiring.showWiringChassis(),
    // present if any chassis carries wiring data (same probe the card used)
    hasData: async () => {
      try {
        const ids =
          typeof wiring !== 'undefined' ? await wiring.wiringChassisList() : [];
        return ids.length > 0;
      } catch (e) {
        return false;
      }
    },
  },
  {
    id: 'etk',
    icon: '⊞',
    title: 'Parts Catalogue',
    short: 'Parts search',
    desc: 'Interactive parts search',
    tag: 'ETK',
    open: () => etk.showEtk(),
    // present only if at least one chassis actually has an .etk bundle in this
    // build. A "no-parts" offline build sets window.BMWEB_NO_PARTS to hide the
    // catalogue outright -- it ships without ETK support on purpose.
    hasData: async () => {
      if (typeof window !== 'undefined' && window.BMWEB_NO_PARTS) return false;
      if (typeof etk === 'undefined') return false;
      try {
        return (await etk.etkChassisList()).length > 0;
      } catch (e) {
        return false;
      }
    },
  },
  {
    id: 'backup',
    icon: '↯',
    title: 'Flashing/Tuning & Logging',
    short: 'Read, write, tune and log',
    desc: 'Read/Write control units, tune files, and log data',
    tag: 'FLASH',
    open: () => (typeof showFlashing === 'function' ? showFlashing() : null),
    // the engines ship with the app shell; the car's SGBDs come with the ECU data
    hasData: async () => typeof showFlashing === 'function',
  },
  {
    id: 'webkfp',
    icon: '↯',
    title: 'WebKFP',
    short: 'Flash stock programs',
    desc: 'Flash stock programs',
    tag: 'WinKFP',
    open: () => (typeof showWebKfp === 'function' ? showWebKfp() : null),
    // the scripts ship in data/kfp; the SP-Daten are the reader's own
    hasData: async () =>
      typeof showWebKfp === 'function' && (await wkfpHasData()),
  },
  {
    id: 'coding',
    icon: '⚙',
    title: 'Coding',
    short: 'Change car configuration',
    desc: 'Change car configurations',
    tag: 'NCS',
    // NCS Expert's flow either way; it draws its own window in the INPA-style
    // layout and a BMWeb screen in the modern one (ncs.js)
    open: () => (typeof showNcsExpert === 'function' ? showNcsExpert() : null),
    // ships with the coding screens; the car decides which modules it reads
    hasData: async () =>
      typeof showNcsExpert === 'function' &&
      (typeof codingReady !== 'function' || codingReady()),
  },
  {
    id: 'tool32',
    icon: '⌗',
    title: 'Web32',
    short: 'Run any SGBD job',
    desc: 'Run any SGBD job directly and read its raw result registers',
    tag: 'SGBD',
    open: () => (typeof showTool32 === 'function' ? showTool32() : null),
    // present if the ECU index shipped (its keys are the runnable SGBDs)
    hasData: async () => {
      if (
        typeof showTool32 !== 'function' ||
        typeof tool32SgbdList !== 'function'
      )
        return false;
      try {
        return (await tool32SgbdList()).length > 0;
      } catch (e) {
        return false;
      }
    },
  },
  {
    id: 'workspace',
    icon: '▦',
    title: 'Workspace',
    short: 'Apps side by side',
    desc: 'Two to four apps side by side on one cable: tuning live, logging, fault memory and Web32 at once',
    tag: 'LAYOUT',
    open: () => (typeof showWorkspace === 'function' ? showWorkspace() : null),
  },
  {
    id: 'script',
    icon: '⌁',
    title: 'Script runner',
    short: 'Run your own INPA script',
    desc: 'Run an INPA script of your own: a compiled .IPO, or a .IPS / .SRC compiled in the browser',
    tag: 'INPA',
    open: () =>
      typeof showScriptRunner === 'function' ? showScriptRunner() : null,
    // reads the file the user supplies -- nothing to ship, so it is ready
    // whenever its code and the live runtime did
    hasData: async () =>
      typeof showScriptRunner === 'function' &&
      typeof ipoProgramOpen === 'function',
  },
];

/**
 * Resolve whether an app's data shipped; a throwing check counts as absent.
 * @param {AppEntry} app - the app
 * @returns {Promise<boolean>}
 */
/**
 * How long an availability probe may take before the card is drawn as
 * absent. A probe that goes to the internet (the parts catalogue's) never
 * answers on an adapter's own WiFi, and the hub must not wait on it.
 */
const APP_PROBE_MS = 2500;

async function appIsReady(app) {
  if (typeof app.hasData !== 'function') return true;
  try {
    return await Promise.race([
      app.hasData(),
      new Promise((resolve) => setTimeout(() => resolve(false), APP_PROBE_MS)),
    ]);
  } catch (e) {
    return false;
  }
}

/**
 * The modern home's line icons, one per app id (24 px grid, drawn for this
 * page): the inner markup of an <svg>.
 */
const APP_ICONS = {
  inpa: '<path d="M4 13a8 8 0 0 1 16 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13" r="1.2"/><path d="M5 18h14"/>',
  ista: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 5v4.5"/><path d="M13 5v4.5"/>',
  scanner:
    '<path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M4 12h16"/>',
  lookup:
    '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17" r=".6"/>',
  'job-search': '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  wiring:
    '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h5a3 3 0 0 1 3 3v7"/><path d="M6 8v5a3 3 0 0 0 3 3h3"/>',
  etk: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>',
  backup: '<path d="M13 3L5 13.5h6L10 21l9-11h-6.5z"/>',
  webkfp:
    '<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
  coding:
    '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/>',
  tool32:
    '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7.5 10l3 2.5-3 2.5"/><path d="M12.5 15h4"/>',
  workspace:
    '<rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="4" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  script:
    '<path d="M8 5l-5 7 5 7"/><path d="M16 5l5 7-5 7"/><path d="M13.5 4l-3 16"/>',
};

/**
 * The modern home's sections, in reading order. An app not named here lands
 * in the last one.
 */
const APPS_HOME_GROUPS = [
  { title: 'Diagnose', ids: ['inpa', 'ista', 'scanner', 'lookup'] },
  { title: 'Reference', ids: ['wiring', 'etk', 'job-search'] },
  { title: 'Program', ids: ['backup', 'webkfp', 'coding'] },
  { title: 'Expert', ids: ['tool32', 'workspace', 'script'] },
];

/**
 * One home card: icon tile, title and description, and at the right the
 * number key that opens it. An absent app renders greyed and disabled with
 * a "not in this build" note. (.app-entry / data-app are what the guided
 * tour spotlights.)
 * @param {AppEntry} app - the app
 * @param {boolean} ready - its data shipped
 * @param {string} [key] - the number key that opens it, when it has one
 * @returns {HTMLButtonElement}
 */
function appCard(app, ready, key) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'home-card app-entry' + (ready ? '' : ' app-absent');
  card.dataset.app = app.id;
  card.title = app.desc;
  card.dataset.find =
    `${app.title} ${app.short || ''} ${app.desc} ${app.tag || ''}`.toLowerCase();
  card.innerHTML = `
      <span class="home-card-ico"><svg viewBox="0 0 24 24" aria-hidden="true">${APP_ICONS[app.id] || ''}</svg></span>
      <span class="home-card-text">
        <span class="home-card-title">${esc(app.title)}</span>
        <span class="home-card-desc">${esc(app.short || app.desc)}</span>
      </span>
      <span class="home-card-side">${
        ready
          ? (key ? `<kbd class="home-key">${esc(key)}</kbd>` : '') +
            '<span class="home-card-go" aria-hidden="true">→</span>'
          : '<span class="home-pill">Not in this build</span>'
      }</span>`;
  if (ready) card.onclick = () => app.open();
  else card.disabled = true;
  return card;
}

/**
 * The modern home: a search box over the tools, then the tools in labelled
 * sections. Typing filters the cards as it goes ("/" puts the cursor in the
 * box, Enter opens the first match, Escape clears it).
 * @param {HTMLElement} list - The .apps-list container.
 * @param {{app: AppEntry, ready: boolean}[]} states
 * @param {AppEntry[]} openable - in number-key order
 * @param {string[]} keys - the number keys, in the same order
 * @returns {void}
 */
function appsHome(list, states, openable, keys) {
  list.classList.add('home');
  const bar = document.createElement('div');
  bar.className = 'home-bar';
  bar.innerHTML = `
    <div class="home-head">
      <h1 class="home-title">${esc(APP_NAME)}</h1>
      <span class="home-count"></span>
    </div>
    <label class="home-search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
      <input type="search" placeholder="Search tools" aria-label="Search tools" autocomplete="off" spellcheck="false">
      <kbd class="home-key">/</kbd>
    </label>`;
  list.appendChild(bar);
  const cols = document.createElement('div');
  cols.className = 'home-cols';
  list.appendChild(cols);
  const input = bar.querySelector('input');
  const count = bar.querySelector('.home-count');

  const grouped = (id) => APPS_HOME_GROUPS.some((g) => g.ids.includes(id));
  const sections = [];
  APPS_HOME_GROUPS.forEach((g, gi) => {
    const last = gi === APPS_HOME_GROUPS.length - 1;
    const members = states
      .filter((s) => g.ids.includes(s.app.id) || (last && !grouped(s.app.id)))
      .sort((a, b) => {
        const at = (s) => {
          const i = g.ids.indexOf(s.app.id);
          return i < 0 ? g.ids.length : i;
        };
        return at(a) - at(b);
      });
    if (!members.length) return;
    const sec = document.createElement('section');
    sec.className = 'home-group';
    sec.innerHTML = `<h2 class="home-group-title">${esc(g.title)}<span>${members.length}</span></h2><div class="home-grid stagger"></div>`;
    const grid = sec.querySelector('.home-grid');
    for (const { app, ready } of members) {
      const k = openable.indexOf(app);
      grid.appendChild(appCard(app, ready, k >= 0 ? keys[k] : ''));
    }
    cols.appendChild(sec);
    stagger(grid, APPS_STAGGER);
    sections.push(sec);
  });
  const none = document.createElement('div');
  none.className = 'home-none';
  none.hidden = true;
  list.appendChild(none);

  const cards = () => [...list.querySelectorAll('.home-card')];
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const c of cards()) {
      const hit = !q || q.split(/\s+/).every((w) => c.dataset.find.includes(w));
      c.hidden = !hit;
      if (hit) shown++;
    }
    for (const sec of sections)
      sec.hidden = !sec.querySelector('.home-card:not([hidden])');
    none.hidden = shown > 0;
    none.textContent = shown ? '' : `No tool matches "${input.value.trim()}".`;
    count.textContent = q
      ? `${shown} of ${states.length}`
      : `${states.length} tools`;
  };
  input.oninput = filter;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const first = cards().find((c) => !c.hidden && !c.disabled);
      if (first) first.click();
    } else if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      filter();
    }
  };
  // "/" from anywhere on the page puts the cursor in the box
  const slash = (e) => {
    if (!document.body.contains(input)) {
      document.removeEventListener('keydown', slash);
      return;
    }
    const t = e.target;
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    e.preventDefault();
    input.focus();
  };
  document.addEventListener('keydown', slash);
  filter();
}

/**
 * The classic launcher's group boxes, WinKFP / NCS Expert style. An app not
 * named here lands in the last group.
 */
const APPS_CLASSIC_GROUPS = [
  {
    title: 'Diagnose',
    ids: ['inpa', 'ista', 'scanner', 'lookup', 'wiring', 'etk'],
  },
  { title: 'Program', ids: ['backup', 'webkfp', 'coding'] },
  { title: 'Expert', ids: ['tool32', 'script', 'job-search'] },
];

/** The classic launcher numbers its buttons 1-9 then 0, in reading order. */
const APPS_CLASSIC_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/**
 * The apps sorted into the classic launcher's group boxes, in reading order.
 * @param {{app: AppEntry, ready: boolean}[]} states
 * @returns {{title: string, members: {app: AppEntry, ready: boolean}[]}[]}
 */
function appsClassicGroups(states) {
  const grouped = (id) => APPS_CLASSIC_GROUPS.some((g) => g.ids.includes(id));
  return APPS_CLASSIC_GROUPS.map((g, i) => {
    const last = i === APPS_CLASSIC_GROUPS.length - 1;
    const order = (s) => {
      const at = g.ids.indexOf(s.app.id);
      return at < 0 ? g.ids.length : at;
    };
    const members = states
      .filter((s) => g.ids.includes(s.app.id) || (last && !grouped(s.app.id)))
      .sort((a, b) => order(a) - order(b));
    return { title: g.title, members };
  }).filter((g) => g.members.length);
}

/**
 * The Apps hub as a classic Windows launcher, for the INPA-style layout: a
 * window in Web32's grey (.t32-win), group boxes of raised buttons, and a
 * status bar that reads out the focused app the way Windows status lines did.
 * Arrow keys walk the buttons; the number keys still open them (setActions).
 * @param {{title: string, members: {app: AppEntry, ready: boolean}[]}[]} groups
 * @param {AppEntry[]} openable - in number-key order
 * @returns {HTMLElement}
 */
function appsClassicWindow(groups, openable) {
  const total = groups.reduce((n, g) => n + g.members.length, 0);
  const win = document.createElement('div');
  win.className = 't32-win apps-win';
  win.innerHTML = `
    <div class="t32-titlebar">${esc(APP_NAME)} - Home</div>
    <div class="apps-win-body"></div>
    <div class="apps-win-status">
      <span class="apps-win-status-text">Ready</span>
      <span class="apps-win-status-count">${openable.length} of ${total} apps</span>
    </div>`;
  const body = win.querySelector('.apps-win-body');
  const status = win.querySelector('.apps-win-status-text');
  const say = (text) => {
    status.textContent = text || 'Ready';
  };
  const buttons = [];
  for (const g of groups) {
    const box = document.createElement('fieldset');
    box.className = 'apps-win-group';
    box.innerHTML = `<legend>${esc(g.title)}</legend>`;
    for (const { app, ready } of g.members) {
      const key = openable.indexOf(app);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'apps-win-btn';
      btn.dataset.app = app.id; // the guided tour spotlights it
      btn.innerHTML = `
        <span class="apps-win-icon">${app.icon}</span>
        <span class="apps-win-label">${esc(app.title)}</span>
        ${key >= 0 && key < APPS_CLASSIC_KEYS.length ? `<span class="apps-win-key">${APPS_CLASSIC_KEYS[key]}</span>` : ''}`;
      const line = ready
        ? `${app.title}: ${app.desc}`
        : `${app.title}: not in this build`;
      btn.onmouseenter = () => say(line);
      btn.onfocus = () => say(line);
      btn.onmouseleave = () => {
        if (document.activeElement !== btn) say('');
      };
      btn.onblur = () => say('');
      if (ready) btn.onclick = () => app.open();
      else btn.disabled = true;
      box.appendChild(btn);
      buttons.push(btn);
    }
    body.appendChild(box);
  }
  // arrow keys walk the buttons in reading order, as a dialog's tab order did
  body.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
      e.key
    ];
    if (!step) return;
    const live = buttons.filter((b) => !b.disabled);
    const at = live.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    live[(at + step + live.length) % live.length].focus();
  });
  if (typeof winMaximizable === 'function') winMaximizable(win);
  return win;
}

/**
 * Show the home screen: every BMWeb tool, INPA among them. The app boots
 * here; it is the root every screen's crumbs lead back to.
 * @returns {Promise<void>}
 */
async function showApps() {
  lastScreen = showApps;
  setCrumbs([{ label: 'Home' }]);
  // the reader may leave while this screen loads (screenOwner)
  const _mine = screenOwner();
  document.body.classList.add('apps-section'); // hides the F-key bar on mobile (touch nav)
  sbLeft.textContent = 'home';
  // the classic launcher's title bar names the screen: no page heading over it
  view.innerHTML = '';
  // the root: nothing to go back to
  setActions([]);

  const list = document.createElement('div');
  list.className = 'apps-list';
  view.appendChild(list);

  // availability checks may hit the network (ETK probes Hugging Face), so show
  // a spinner instead of a blank pane while they resolve.
  const loading = document.createElement('div');
  loading.className = 'wiring-loading etk-loading';
  loading.innerHTML = `<span class="wiring-spinner"></span><span>Loading apps…</span>`;
  view.appendChild(loading);

  // resolve availability once, in parallel; a card renders as soon as we know
  const states = await Promise.all(
    APP_REGISTRY.map(async (app) => ({ app, ready: await appIsReady(app) }))
  );
  loading.remove();
  if (!_mine()) return;

  const classic = inpaMode();
  let openable;
  let keys;
  if (classic) {
    // the INPA-style layout: the hub as a classic launcher window, its
    // buttons numbered in reading order
    const groups = appsClassicGroups(states);
    openable = groups.flatMap((g) =>
      g.members.filter((s) => s.ready).map((s) => s.app)
    );
    keys = APPS_CLASSIC_KEYS;
    list.replaceWith(appsClassicWindow(groups, openable));
  } else {
    // number keys follow the page's reading order, section by section
    const order = APPS_HOME_GROUPS.flatMap((g) => g.ids);
    const at = (s) => {
      const i = order.indexOf(s.app.id);
      return i < 0 ? order.length : i;
    };
    openable = states
      .filter((s) => s.ready)
      .sort((a, b) => at(a) - at(b))
      .map((s) => s.app);
    keys = APPS_CLASSIC_KEYS.slice(0, APPS_FKEY_SLOTS);
    appsHome(list, states, openable, keys);
  }
  sbRight.textContent = `${openable.length} app${openable.length === 1 ? '' : 's'}`;

  if (!_mine()) return;
  setActions([
    ...openable.slice(0, keys.length).map((a, i) => ({
      key: keys[i],
      label: a.title.split(' ')[0],
      fn: () => a.open(),
    })),
  ]);
}
