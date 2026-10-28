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
 * @property {string} desc - one-line description
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
    desc: 'Pick a vehicle, then its modules, faults and live values',
    tag: 'INPA',
    open: () => showChassis(),
    hasData: async () => true,
  },
  {
    id: 'ista',
    icon: '▤',
    title: 'Workshop',
    desc: "Every read on one vehicle behind one set of tabs, ISTA's way",
    tag: 'ISTA',
    open: () => (typeof showIsta === 'function' ? showIsta() : null),
    // a shell over screens this build already has -- ready whenever its own
    // code shipped. What each tab can actually do is decided per car, on the
    // shell's own home, where it can say why a tab is dark.
    hasData: async () => typeof showIsta === 'function',
  },
  {
    id: 'lookup',
    icon: '⌕',
    title: 'Fault codes',
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
    desc: 'Interactive wiring and documents search',
    tag: 'WDS · ISTA',
    open: () => showWiringChassis(),
    // present if any chassis carries wiring data (same probe the card used)
    hasData: async () => {
      try {
        const ids =
          typeof wiringChassisList === 'function'
            ? await wiringChassisList()
            : [];
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
    desc: 'Interactive parts search',
    tag: 'ETK',
    open: () => (typeof showEtk === 'function' ? showEtk() : null),
    // present only if at least one chassis actually has an .etk bundle in this
    // build. A "no-parts" offline build sets window.BMWEB_NO_PARTS to hide the
    // catalogue outright -- it ships without ETK support on purpose.
    hasData: async () => {
      if (typeof window !== 'undefined' && window.BMWEB_NO_PARTS) return false;
      if (typeof showEtk !== 'function' || typeof etkChassisList !== 'function')
        return false;
      try {
        return (await etkChassisList()).length > 0;
      } catch (e) {
        return false;
      }
    },
  },
  {
    id: 'backup',
    icon: '↯',
    title: 'Flashing/Tuning & Logging',
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
    desc: 'Two to four apps side by side on one cable: tuning live, logging, fault memory and Web32 at once',
    tag: 'LAYOUT',
    open: () => (typeof showWorkspace === 'function' ? showWorkspace() : null),
  },
  {
    id: 'script',
    icon: '⌁',
    title: 'Script runner',
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
 * One hub card. An absent app renders greyed and disabled with a "not in
 * this build" note.
 * @param {AppEntry} app - the app
 * @param {boolean} ready - its data shipped
 * @returns {HTMLButtonElement}
 */
function appCard(app, ready) {
  const card = document.createElement('button');
  card.className = 'lookup-entry app-entry' + (ready ? '' : ' app-absent');
  card.dataset.app = app.id; // lets the guided tour spotlight a named app
  card.innerHTML = `
      <span class="lookup-entry-icon">${app.icon}</span>
      <span class="lookup-entry-text">
        <span class="lookup-entry-title">${esc(app.title)}</span>
        <span class="lookup-entry-desc">${esc(app.desc)}${
          ready ? '' : ' · not in this build'
        }</span>
      </span>
      <span class="lookup-entry-arrow">${ready ? '→' : ''}</span>`;
  if (ready) card.onclick = () => app.open();
  else card.disabled = true;
  return card;
}

/**
 * The classic launcher's group boxes, WinKFP / NCS Expert style. An app not
 * named here lands in the last group.
 */
const APPS_CLASSIC_GROUPS = [
  { title: 'Diagnose', ids: ['inpa', 'ista', 'lookup', 'wiring', 'etk'] },
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
  view.innerHTML = inpaMode()
    ? ''
    : head(
        'Home',
        APP_NAME,
        'Diagnose, code, flash and look things up: pick a tool.'
      );
  // the root: nothing to go back to
  setActions([]);

  const list = document.createElement('div');
  list.className = 'apps-list stagger';
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
    openable = states.filter((s) => s.ready).map((s) => s.app);
    keys = APPS_CLASSIC_KEYS.slice(0, APPS_FKEY_SLOTS);
    states.forEach(({ app, ready }) => list.appendChild(appCard(app, ready)));
    stagger(list, APPS_STAGGER);
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
