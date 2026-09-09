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
    id: 'lookup',
    icon: '⌕',
    title: 'Diagnostic Plans and Trouble Codes',
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
    id: 'tree',
    icon: '⌗',
    title: 'Control unit tree',
    desc: "ISTA's bus map of every module, coloured by the last fault scan",
    tag: 'ISTA',
    open: () => (typeof showEcuTree === 'function' ? showEcuTree() : null),
    // the trees are an ISTA extract hosted beside the ETK data; the card
    // greys when neither a local copy nor the dataset answers
    hasData: async () =>
      typeof showEcuTree === 'function' &&
      typeof ecuTreeIndexPresent === 'function' &&
      (await ecuTreeIndexPresent()),
  },
  {
    id: 'wiring',
    icon: '⌁',
    title: 'Wiring & Documents',
    desc: "BMW's schematics plus ISTA repair steps, pin assignments and tech data",
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
    desc: "BMW's ETK: part numbers, diagrams and supersessions by chassis",
    tag: 'ETK',
    open: () => (typeof showEtk === 'function' ? showEtk() : null),
    // present only if at least one chassis actually has an .etk bundle in this
    // build. A "no-parts" offline build sets window.BMACW_NO_PARTS to hide the
    // catalogue outright -- it ships without ETK support on purpose.
    hasData: async () => {
      if (typeof window !== 'undefined' && window.BMACW_NO_PARTS) return false;
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
    icon: '⇩',
    title: 'ECU Backup',
    desc: 'Read a control unit’s firmware off the car and save it (read only)',
    tag: 'BIN',
    open: () => (typeof showFlasher === 'function' ? showFlasher() : null),
    // present whenever the engine shipped with at least one profile
    hasData: async () =>
      typeof showFlasher === 'function' &&
      typeof FLASH_PROFILES !== 'undefined' &&
      FLASH_PROFILES.length > 0,
  },
  {
    id: 'tool32',
    icon: '⌗',
    title: 'Tool32',
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
    id: 'tuning',
    icon: '⛃',
    title: 'Tuning',
    desc: 'Edit ECU firmware BINs: raw hex plus TunerPro .xdf constants, flags and tables',
    tag: 'XDF',
    open: () => (typeof showTuning === 'function' ? showTuning() : null),
    // pure client-side editor -- available whenever its code shipped (no data bundle)
    hasData: async () =>
      typeof showTuning === 'function' && typeof window.XDF !== 'undefined',
  },
  {
    id: 'logging',
    icon: '∿',
    title: 'Data logging',
    desc: 'Chart live readings from any module while you drive (read only)',
    tag: 'LIVE',
    open: () => (typeof showLogging === 'function' ? showLogging() : null),
    // no data bundle of its own: it polls whatever modules this build ships
    hasData: async () => typeof showLogging === 'function',
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
async function appIsReady(app) {
  if (typeof app.hasData !== 'function') return true;
  try {
    return await app.hasData();
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
 * Show the Apps hub.
 * @returns {Promise<void>}
 */
async function showApps() {
  lastScreen = showApps;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Apps' }]);
  document.body.classList.add('apps-section'); // hides the F-key bar on mobile (touch nav)
  sbLeft.textContent = 'apps';
  view.innerHTML = head('Apps', 'Apps', '');
  const backAction = {
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'Back',
    kind: 'back',
    fn: showChassis,
  };
  setActions([backAction]);

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

  const openable = [];
  states.forEach(({ app, ready }) => {
    list.appendChild(appCard(app, ready));
    if (ready) openable.push(app);
  });
  stagger(list, APPS_STAGGER);
  sbRight.textContent = `${openable.length} app${openable.length === 1 ? '' : 's'}`;

  setActions([
    ...openable.slice(0, APPS_FKEY_SLOTS).map((a, i) => ({
      key: String(i + 1),
      label: a.title.split(' ')[0],
      fn: () => a.open(),
    })),
    backAction,
  ]);
}
