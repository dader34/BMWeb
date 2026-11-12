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
 * The home's line icons, one per app id (24 px grid, drawn for this page):
 * the inner markup of an <svg>. Both the modern and the classic home draw
 * them (appIconSvg).
 */
const APP_ICONS = {
  inpa: '<path d="M4 13a8 8 0 0 1 16 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13" r="1.2"/><path d="M5 18h14"/>',
  ista: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 5v4.5"/><path d="M13 5v4.5"/>',
  scanner:
    '<path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M4 12h16"/>',
  lookup:
    '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17" r=".6"/>',
  'job-search': '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  // a page with a wire run drawn on it: two terminals and the lead between
  wiring:
    '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><circle cx="9.5" cy="12" r="1.3"/><circle cx="14.5" cy="17" r="1.3"/><path d="M10.8 12h3.7v3.7"/>',
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
 * AN EXPERIMENT: the classic home's icons in the BMWeb Scanner's own style --
 * small colour pictures with a black outline, as Windows programs of its day
 * drew them (24 px grid, one screen pixel a unit, edges left crisp). The
 * inner markup of an <svg>, one per app id. Taking this table away puts the
 * line icons back (appIconClassic).
 */
const APP_ICONS_RETRO = {
  inpa: '<circle cx="12" cy="13" r="9.5" fill="#c0c0c0" stroke="#000"/><circle cx="12" cy="13" r="7" fill="#fff" stroke="#808080"/><rect x="6" y="12" width="2" height="1"/><rect x="12" y="7" width="1" height="2"/><rect x="17" y="12" width="2" height="1"/><path d="M12 13l4-5" stroke="#e00000" stroke-width="2"/><rect x="11" y="12" width="2" height="2"/>',
  ista: '<rect x="2.5" y="3.5" width="19" height="17" fill="#fff" stroke="#000"/><rect x="3" y="4" width="18" height="3" fill="#000080"/><rect x="18" y="5" width="2" height="1" fill="#c0c0c0"/><rect x="5" y="9" width="3" height="2" fill="#e00000"/><rect x="9" y="9" width="10" height="2" fill="#808080"/><rect x="5" y="13" width="3" height="2" fill="#008000"/><rect x="9" y="13" width="10" height="2" fill="#808080"/><rect x="5" y="17" width="3" height="2" fill="#ffcc00"/><rect x="9" y="17" width="7" height="2" fill="#808080"/>',
  scanner:
    '<path d="M15 15l6 6" stroke="#000" stroke-width="5"/><path d="M16 16l5 5" stroke="#c08040" stroke-width="3"/><circle cx="10" cy="10" r="7" fill="#80e0ff" stroke="#000" stroke-width="2"/><rect x="6" y="6" width="4" height="1" fill="#fff"/><rect x="6" y="7" width="1" height="3" fill="#fff"/>',
  lookup:
    '<polygon points="12,2.5 22.5,20.5 1.5,20.5" fill="#ffcc00" stroke="#000"/><rect x="11" y="8" width="2" height="7"/><rect x="11" y="17" width="2" height="2"/>',
  wiring:
    '<polygon points="5.5,2.5 14.5,2.5 18.5,6.5 18.5,21.5 5.5,21.5" fill="#fff" stroke="#000"/><polygon points="14.5,2.5 14.5,6.5 18.5,6.5" fill="#c0c0c0" stroke="#000"/><path d="M8 10h7v4" fill="none" stroke="#e00000" stroke-width="2"/><path d="M8 14h3v5h5" fill="none" stroke="#0000e0" stroke-width="2"/><rect x="7" y="9" width="2" height="2"/><rect x="7" y="13" width="2" height="2"/>',
  etk: '<polygon points="12,2.5 21.5,7 12,11.5 2.5,7" fill="#e8b878" stroke="#000"/><polygon points="2.5,7 12,11.5 12,21.5 2.5,17" fill="#c08040" stroke="#000"/><polygon points="12,11.5 21.5,7 21.5,17 12,21.5" fill="#a06020" stroke="#000"/><path d="M7.5 4.5l9.5 4.5v4" fill="none" stroke="#fff0c0" stroke-width="2"/>',
  backup:
    '<polygon points="13.5,1.5 4.5,13.5 10.5,13.5 8.5,22.5 19.5,9.5 13.5,9.5" fill="#ffcc00" stroke="#000"/><path d="M13 4l-5 7" fill="none" stroke="#fff8c0"/>',
  webkfp:
    '<g fill="#c0c0c0" stroke="#000"><rect x="7.5" y="2.5" width="2" height="3"/><rect x="11" y="2.5" width="2" height="3"/><rect x="14.5" y="2.5" width="2" height="3"/><rect x="7.5" y="18.5" width="2" height="3"/><rect x="11" y="18.5" width="2" height="3"/><rect x="14.5" y="18.5" width="2" height="3"/><rect x="2.5" y="7.5" width="3" height="2"/><rect x="2.5" y="11" width="3" height="2"/><rect x="2.5" y="14.5" width="3" height="2"/><rect x="18.5" y="7.5" width="3" height="2"/><rect x="18.5" y="11" width="3" height="2"/><rect x="18.5" y="14.5" width="3" height="2"/></g><rect x="5.5" y="5.5" width="13" height="13" fill="#404040" stroke="#000"/><rect x="7" y="7" width="2" height="2" fill="#fff"/><polygon points="11,9 14,9 14,12 16,12 12.5,16 9,12 11,12" fill="#00d000"/>',
  coding:
    '<rect x="2.5" y="3.5" width="19" height="17" fill="#c0c0c0" stroke="#000"/><rect x="3" y="4" width="18" height="1" fill="#fff"/><rect x="5" y="8" width="14" height="1"/><rect x="5" y="12" width="14" height="1"/><rect x="5" y="16" width="14" height="1"/><rect x="13.5" y="6.5" width="3" height="4" fill="#2040ff" stroke="#000"/><rect x="7.5" y="10.5" width="3" height="4" fill="#2040ff" stroke="#000"/><rect x="15.5" y="14.5" width="3" height="4" fill="#2040ff" stroke="#000"/>',
  tool32:
    '<rect x="1.5" y="3.5" width="21" height="17" fill="#c0c0c0" stroke="#000"/><rect x="3" y="5" width="18" height="2" fill="#000080"/><rect x="3" y="8" width="18" height="11"/><path d="M5 11l3 2-3 2" fill="none" stroke="#00ff00"/><rect x="10" y="15" width="5" height="1" fill="#00ff00"/>',
  script:
    '<rect x="3.5" y="2.5" width="15" height="19" fill="#fff" stroke="#000"/><rect x="6" y="5" width="6" height="1" fill="#0000e0"/><rect x="8" y="8" width="8" height="1"/><rect x="8" y="11" width="5" height="1"/><rect x="6" y="14" width="4" height="1" fill="#0000e0"/><rect x="6" y="17" width="5" height="1" fill="#808080"/><polygon points="13.5,12.5 22.5,17.5 13.5,22.5" fill="#00c000" stroke="#000"/>',
  'job-search':
    '<rect x="2.5" y="2.5" width="13" height="17" fill="#fff" stroke="#000"/><rect x="5" y="5" width="8" height="1" fill="#808080"/><rect x="5" y="8" width="8" height="1" fill="#808080"/><rect x="5" y="11" width="4" height="1" fill="#808080"/><path d="M18 18l4 4" stroke="#000" stroke-width="4"/><path d="M19 19l3 3" stroke="#c08040" stroke-width="2"/><circle cx="15" cy="14" r="5" fill="#80e0ff" stroke="#000" stroke-width="2"/><rect x="13" y="11" width="2" height="1" fill="#fff"/>',
  workspace:
    '<rect x="2.5" y="2.5" width="9" height="9" fill="#e84020" stroke="#000"/><rect x="12.5" y="2.5" width="9" height="9" fill="#40b020" stroke="#000"/><rect x="2.5" y="12.5" width="9" height="9" fill="#2060f0" stroke="#000"/><rect x="12.5" y="12.5" width="9" height="9" fill="#ffc000" stroke="#000"/><rect x="4" y="4" width="4" height="1" fill="#fff"/><rect x="14" y="4" width="4" height="1" fill="#fff"/><rect x="4" y="14" width="4" height="1" fill="#fff"/><rect x="14" y="14" width="4" height="1" fill="#fff"/>',
};

/**
 * The classic home's icon for an app: its colour picture, or its line icon
 * when no picture is drawn for it.
 * @param {{id: string, icon: string}} app
 * @returns {string} Markup.
 */
const appIconClassic = (app) =>
  APP_ICONS_RETRO[app.id]
    ? `<svg class="apps-ico-retro" viewBox="0 0 24 24" aria-hidden="true">${APP_ICONS_RETRO[app.id]}</svg>`
    : appIconSvg(app);

/**
 * An app's line icon as an <svg>, or its single glyph when no icon is drawn
 * for it.
 * @param {{id: string, icon: string}} app
 * @returns {string} Markup.
 */
const appIconSvg = (app) =>
  APP_ICONS[app.id]
    ? `<svg viewBox="0 0 24 24" aria-hidden="true">${APP_ICONS[app.id]}</svg>`
    : esc(app.icon);

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
 * One home card: icon tile, title and description. An absent app renders
 * greyed and disabled with a "not in this build" note. (.app-entry / data-app are what the guided
 * tour spotlights.)
 * @param {AppEntry} app - the app
 * @param {boolean} ready - its data shipped
 * @returns {HTMLButtonElement}
 */
function appCard(app, ready) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'home-card app-entry' + (ready ? '' : ' app-absent');
  card.dataset.app = app.id;
  card.title = app.desc;
  card.dataset.find =
    `${app.title} ${app.short || ''} ${app.desc} ${app.tag || ''}`.toLowerCase();
  card.innerHTML = `
      <span class="home-card-ico">${appIconSvg(app)}</span>
      <span class="home-card-text">
        <span class="home-card-title">${esc(app.title)}</span>
        <span class="home-card-desc">${esc(app.short || app.desc)}</span>
      </span>
      <span class="home-card-side">${
        ready
          ? '<span class="home-card-go" aria-hidden="true">→</span>'
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
 * @returns {void}
 */
function appsHome(list, states) {
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
    for (const { app, ready } of members) grid.appendChild(appCard(app, ready));
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
 * Arrow keys walk the buttons.
 * @param {{title: string, members: {app: AppEntry, ready: boolean}[]}[]} groups
 * @param {number} openable - how many of them can be opened in this build
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
      <span class="apps-win-status-count">${openable} of ${total} apps</span>
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
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'apps-win-btn';
      btn.dataset.app = app.id; // the guided tour spotlights it
      btn.innerHTML = `
        <span class="apps-win-icon">${appIconClassic(app)}</span>
        <span class="apps-win-label">${esc(app.title)}</span>`;
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

  const openable = states.filter((s) => s.ready).length;
  if (inpaMode()) {
    // the INPA-style layout: the hub as a classic launcher window
    list.replaceWith(appsClassicWindow(appsClassicGroups(states), openable));
  } else {
    appsHome(list, states);
  }
  sbRight.textContent = `${openable} app${openable === 1 ? '' : 's'}`;

  // the home has no keys of its own: its tools are opened by click, by the
  // search box, or (classic) by walking the buttons
  if (_mine()) setActions([]);
}
