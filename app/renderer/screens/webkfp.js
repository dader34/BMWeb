/* exported showWebKfp, wkfpHasData, wkfpDraggable */

// WebKFP: WinKFP in the browser, laid out and worked the way WinKFP 5.3 is.
// Its window: the menu bar, the module panel (address, VIN, ZB, hardware
// number, interface, protocol), the message panel (Bootsectorupdate, PABD,
// P-SGBD), the progress bar, the F-key panel and the status line. Comfort
// mode's keys -- Enter ZUSB, Choose ZUSB, Update ZUSB, Enter VIN, Done -- and
// its dialogs: Choose assembly identification number / integration
// position, Ini Options, the Info box and the COAPI error list.
//
// What happens on Update ZUSB is WinKFP's (core/kfp/run.js): the module's
// current ZB is read (SG_IDENT_LESEN's ID_BMW_NR) and looked up in the ZB
// table; when its hardware number differs from the new ZB's, or the module
// cannot say, the program is new (HWNR_IS_NEW); then BMW's programming
// script programs what the module asks for.
//
// The scripts, their SGBDs and the COAPI error texts ship in data/kfp. The
// SP-Daten come from bmw-files on Hugging Face, one loose file each
// (tools/export/kfp_spdaten.py): its index.json, listing every file, is
// fetched when the screen opens; a module's ZB table when its ZB numbers are
// first shown; the program and data files only when a ZB is programmed.
// Import/Export > Import reads the reader's own folder instead.

/** The Ini Options, as WinKFP keeps them in Winkfpt.ini. */
const WKFP_INI_STORE = 'bmweb.webkfp.ini';

/** Bumped when a default changes, so saved options pick it up. */
const WKFP_INI_VERSION = 2;

/** Winkfpt.ini's defaults, by its own key names. */
const WKFP_INI_DEFAULTS = {
  U_PROG: true,
  ANZEIGE_U_PROG: true,
  // on, unlike Winkfpt.ini: the block writes go at the module's fast rate
  SCHNELLE_BAUDRATE: true,
  TEST_CHECKSUMME: true,
  PROGRAMM_ERZWINGEN: false,
  BSU_ZULASSEN: false,
  AIF_SCHREIBEN_NACH_DATEN: true,
  AIF_SCHREIBEN_NACH_PROGRAMM: true,
  EXPERT_MIT_AIF: false,
  KOMFORT_MIT_AIF: true,
  // WebKFP's own (EDIABAS's UbattHandling, in WinKFP's options): warn before
  // programming when the cable reads KL15 low. Off for a cable that never
  // wired that line, which reads "off" on a car whose ignition is on.
  UBATT_PRUEFEN: true,
};

/** WinKFP's own error for a programming that failed. */
const WKFP_ERR_FLASH = { code: 211, text: 'Error on flash programming!' };

/** The script and SGBD loads, once per module. @type {Map<string, Promise<object>>} */
const wkfpScripts = new Map();
/** The COAPI error texts, loaded once. @type {Promise<Record<string, string>>|null} */
let wkfpCoapiTexts = null;

function wkfpIni() {
  try {
    const saved =
      JSON.parse(localStorage.getItem(WKFP_INI_STORE) || '{}') || {};
    // options saved before fast baud became the default take the new default once
    if (saved.v !== WKFP_INI_VERSION) delete saved.SCHNELLE_BAUDRATE;
    return { ...WKFP_INI_DEFAULTS, ...saved };
  } catch (e) {
    return { ...WKFP_INI_DEFAULTS };
  }
}
function wkfpSaveIni(ini) {
  try {
    localStorage.setItem(
      WKFP_INI_STORE,
      JSON.stringify({ ...ini, v: WKFP_INI_VERSION })
    );
  } catch (e) {
    /* storage unavailable: the options last for this visit */
  }
}

/**
 * Keep what was chosen -- the ZB, the VIN, the expert's files -- so a
 * reload comes back to it. Names only: the files are fetched again (from
 * the cache) or, for an imported folder, the folder is asked for again.
 * @param {object} st - WebKFP's state.
 * @returns {void}
 */
function wkfpSaveChoice(st) {
  const f = (x) => (x ? { mod: x.mod.id, name: x.name } : null);
  const e = st.exp;
  const choice = {
    v: 1,
    source: st.source,
    folderName: st.folderName,
    vin: st.vin,
    mod: st.mod ? st.mod.id : null,
    zb: st.row ? st.row.zb : null,
    exp: e
      ? {
          pabd: e.pabd ? e.pabd.id : null,
          sgbd: e.sgbd,
          address: e.address,
          data: f(e.data),
          program: f(e.program),
          naab: f(e.naab),
        }
      : null,
  };
  try {
    localStorage.setItem(WKFP_CHOICE_STORE, JSON.stringify(choice));
  } catch (err) {
    /* storage unavailable: the choice lasts for this visit */
  }
}

/** @returns {object|null} What wkfpSaveChoice kept, or null. */
function wkfpLoadChoice() {
  try {
    const c = JSON.parse(localStorage.getItem(WKFP_CHOICE_STORE) || 'null');
    return c && c.v === 1 ? c : null;
  } catch (err) {
    return null;
  }
}

/**
 * Whether this build carries the engine and the programming scripts.
 * @returns {Promise<boolean>}
 */
async function wkfpHasData() {
  if (typeof kfp === 'undefined' || typeof kfpDaten === 'undefined')
    return false;
  try {
    const r = await fetch('data/kfp/families.json', { method: 'HEAD' });
    return !!(r && r.ok);
  } catch (e) {
    return false;
  }
}

/**
 * A module's programming script, with its SGBD handed to the job runner.
 * @param {KfpModule} mod - The module.
 * @returns {Promise<object>} The script.
 * @throws {Error} When the build does not carry it.
 */
function wkfpScript(mod) {
  // expert mode may pair any PABD with any P-SGBD
  const key = `${mod.pabd}|${mod.sgbd}`;
  if (!wkfpScripts.has(key)) {
    const p = (async () => {
      const [exec, code, tables] = await Promise.all([
        webFetchJson(`data/kfp/${mod.pabd}.json`),
        webFetchGz(`data/kfp/${mod.sgbd}.job-code.json.gz`),
        webFetchGz(`data/kfp/${mod.sgbd}.tables.json.gz`),
      ]);
      const missing = [
        !exec && `data/kfp/${mod.pabd}.json (${mod.pabd.toUpperCase()}.IPO)`,
        !code &&
          `data/kfp/${mod.sgbd}.job-code.json.gz (${mod.sgbd.toUpperCase()}.PRG)`,
      ].filter(Boolean);
      if (missing.length)
        throw new Error(`could not load ${missing.join(' or ')}`);
      webProvideJobCode(mod.sgbd, code, tables || {});
      return exec;
    })();
    // a failed load is tried again next time
    p.catch(() => wkfpScripts.delete(key));
    wkfpScripts.set(key, p);
  }
  return wkfpScripts.get(key);
}

/**
 * Where the SP-Daten are online: the module folders, loose, on each
 * bmw-files mirror. Tried in order; a mirror that is behind 404s.
 * @type {string[]}
 */
const WKFP_SPD_MIRRORS = [
  'https://huggingface.co/datasets/CraigFf/bmw-files/resolve/main/sp-daten/',
  'https://huggingface.co/datasets/HarryG8/bmw-files/resolve/main/sp-daten/',
  'https://huggingface.co/datasets/VerilP0/bmw-files/resolve/main/sp-daten/',
];

/**
 * How many exchanges one of a flash's jobs may take. A flash SGBD polls a
 * module that answers BUSY for as long as it says so (MDS43's
 * FLASH_SCHREIBEN_ENDE while the DME checks the new program: no counter in
 * the SGBD); the job runner's own limit (64) is far below that. 2048 is
 * about 3.5 minutes of polling at DS2's pace.
 */
const WKFP_JOB_PASSES = 2048;

/** Where fetched SP-Daten files are kept between visits. */
const WKFP_SPD_CACHE = 'bmweb-webkfp-spdaten-v1';

/** Display > ERROR.LOG, kept between visits. */
const WKFP_LOG_STORE = 'bmweb.webkfp.errorlog';

/** The most of it that is kept: the newest lines. */
const WKFP_LOG_KEEP = 5000;

/**
 * Keep ERROR.LOG for the next visit (the newest WKFP_LOG_KEEP lines).
 * @param {string[]} lines - The log.
 * @returns {void}
 */
function wkfpSaveLog(lines) {
  try {
    localStorage.setItem(
      WKFP_LOG_STORE,
      JSON.stringify(lines.slice(-WKFP_LOG_KEEP))
    );
  } catch (e) {
    /* storage unavailable or full: the log lasts for this visit */
  }
}

/** @returns {string[]} ERROR.LOG as the last visit left it ([] for none). */
function wkfpLoadLog() {
  try {
    const lines = JSON.parse(localStorage.getItem(WKFP_LOG_STORE) || '[]');
    return Array.isArray(lines) ? lines.map(String) : [];
  } catch (e) {
    return [];
  }
}

/** What was chosen, kept between visits (wkfpSaveChoice). */
const WKFP_CHOICE_STORE = 'bmweb.webkfp.choice';

/** The online index, loaded once. @type {Promise<object|null>|null} */
let wkfpSpdIndexP = null;

/**
 * One SP-Daten file from the first mirror that has it.
 * @param {string} rel - Its path under sp-daten/ (E46/GD20/GD20.DAT).
 * @returns {Promise<ArrayBuffer>}
 * @throws {Error} When no mirror answered.
 */
async function wkfpSpdFetch(rel) {
  // A module's files never change under their name, so each is fetched
  // once and kept (Cache API); the index is always asked for fresh, so a
  // new upload shows. Storage that is refused or full only costs a fetch.
  const keep = rel !== 'index.json';
  const key = WKFP_SPD_MIRRORS[0] + rel;
  let cache = null;
  if (keep && typeof caches !== 'undefined') {
    try {
      cache = await caches.open(WKFP_SPD_CACHE);
      const hit = await cache.match(key);
      if (hit) return await hit.arrayBuffer();
    } catch (e) {
      cache = null;
    }
  }
  // plain CDN files: past the shim that answers /api from the ECU archives
  const real = typeof webRealFetch === 'function' ? webRealFetch : fetch;
  for (const base of WKFP_SPD_MIRRORS) {
    try {
      const r = await real(base + rel);
      if (!r || !r.ok) continue;
      const buf = await r.arrayBuffer();
      if (cache) cache.put(key, new Response(buf.slice(0))).catch(() => {});
      return buf;
    } catch (e) {
      /* the next mirror */
    }
  }
  throw new Error(`${rel} could not be fetched from Hugging Face`);
}

/**
 * The online index: per module folder, per chassis, its files and sizes.
 * @returns {Promise<{modules: Record<string, Record<string, {path: string,
 *   table: string, files: Record<string, number>}>>}|null>} null offline.
 */
function wkfpSpdIndex() {
  if (!wkfpSpdIndexP) {
    wkfpSpdIndexP = wkfpSpdFetch('index.json')
      .then((b) => JSON.parse(new TextDecoder().decode(b)))
      .catch(() => null);
    // offline now is not offline forever: ask again next time
    wkfpSpdIndexP.then((i) => {
      if (!i) wkfpSpdIndexP = null;
    });
  }
  return wkfpSpdIndexP;
}

/**
 * An online file that reads like a picked File, fetched on first read only.
 * @param {string} rel - Its path under sp-daten/.
 * @param {string} name - Its name.
 * @param {number} size - Its size, from the index.
 * @returns {{name: string, size: number, remote: true,
 *   arrayBuffer: () => Promise<ArrayBuffer>}}
 */
function wkfpRemoteFile(rel, name, size) {
  let p = null;
  return {
    name,
    size,
    remote: true,
    arrayBuffer() {
      if (!p) {
        p = wkfpSpdFetch(rel);
        p.catch(() => (p = null));
      }
      return p;
    },
  };
}

/** The family list, loaded once. @type {Promise<KfpModule[]>|null} */
let wkfpFamiliesP = null;

/**
 * Every family this build carries a script for (data/kfp/families.json:
 * KFCONF10.DA2's families whose folder the SP-Daten have), in its order.
 * @returns {Promise<KfpModule[]>}
 */
function wkfpFamilies() {
  if (!wkfpFamiliesP) {
    wkfpFamiliesP = webFetchJson('data/kfp/families.json').then((list) =>
      Array.isArray(list) && list.length
        ? list.map(kfp.moduleOf)
        : Object.values(kfp.MODULES)
    );
  }
  return wkfpFamiliesP;
}

/** @returns {Promise<Record<string, string>>} COAPI error number -> text. */
function wkfpCoapi() {
  if (!wkfpCoapiTexts)
    wkfpCoapiTexts = webFetchJson('data/kfp/coapierr.json').then(
      (t) => t || {}
    );
  return wkfpCoapiTexts;
}

/**
 * A module's files among those imported: the folder may be the SP-Daten tree
 * (data/GD20/...), the chassis folder, or the module's own folder. The
 * module's folder is the one holding its ZB table.
 * @param {KfpModule} mod - The module.
 * @param {File[]} picked - The imported files.
 * @returns {{table: File, files: Map<string, File>}|null} The table and the
 *   folder's files by name, or null when no ZB table is among them.
 */
function wkfpModuleFiles(mod, picked) {
  const rel = (f) => (f.webkitRelativePath || f.name).replace(/\\/g, '/');
  const table = picked.find((f) => {
    const parts = rel(f).split('/');
    if (parts.pop().toUpperCase() !== mod.table.toUpperCase()) return false;
    // inside the module's folder, or the folder itself was picked
    const dir = parts.length ? parts[parts.length - 1].toUpperCase() : '';
    return dir === mod.folder.toUpperCase() || parts.length <= 1;
  });
  if (!table) return null;
  const dir = rel(table).split('/').slice(0, -1).join('/');
  const files = new Map();
  for (const f of picked) {
    const parts = rel(f).split('/');
    const name = parts.pop();
    if (parts.join('/') === dir) files.set(name, f);
  }
  return { table, files };
}

/** @param {File} f @returns {Promise<string>} its text, as WinKFP reads it (latin-1). */
async function wkfpText(f) {
  return new TextDecoder('latin1').decode(await f.arrayBuffer());
}

// ---- the window's dialogs ----------------------------------------------------
/**
 * Let a dialog be moved by its title bar, as a Windows dialog is. It moves
 * by a translate, so it starts where the layout centres it, and its title
 * bar stays on screen.
 * @param {HTMLElement} dlg - the dialog (.wkfp-dlg).
 */
function wkfpDraggable(dlg) {
  const bar = dlg.querySelector('.wkfp-dlg-title');
  if (!bar) return;
  bar.classList.add('wkfp-drag');
  let dx = 0;
  let dy = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const x0 = e.clientX - dx;
    const y0 = e.clientY - dy;
    // the layout's own place, without the move so far
    const r = dlg.getBoundingClientRect();
    const left0 = r.left - dx;
    const top0 = r.top - dy;
    const titleH = bar.offsetHeight;
    bar.setPointerCapture(e.pointerId);
    const move = (ev) => {
      // keep the title bar reachable: at least 60px of it in view
      const minX = 60 - r.width - left0;
      const maxX = window.innerWidth - 60 - left0;
      const minY = -top0;
      const maxY = window.innerHeight - titleH - top0;
      dx = Math.min(maxX, Math.max(minX, ev.clientX - x0));
      dy = Math.min(maxY, Math.max(minY, ev.clientY - y0));
      dlg.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
}

/**
 * A WinKFP dialog over the window: a title bar, the body, the buttons.
 * Enter presses the first button, Esc the last (or closes with null).
 * @param {HTMLElement} win - The window it sits over.
 * @param {{title: string, body: HTMLElement|string, buttons: string[],
 *   cls?: string, onOpen?: (el: HTMLElement) => void,
 *   check?: (button: string, el: HTMLElement) => boolean}} o
 * @returns {Promise<string|null>} The button pressed.
 */
function wkfpDialog(win, o) {
  return new Promise((resolve) => {
    const shade = document.createElement('div');
    shade.className = 'wkfp-shade';
    const dlg = document.createElement('div');
    dlg.className = 'wkfp-dlg' + (o.cls ? ' ' + o.cls : '');
    dlg.setAttribute('role', 'dialog');
    dlg.innerHTML = `
      <div class="wkfp-dlg-title"><span>${esc(o.title)}</span><button class="wkfp-x" aria-label="Close">&#x2715;</button></div>
      <div class="wkfp-dlg-body"></div>
      <div class="wkfp-dlg-btns">${o.buttons
        .map((b) => `<button class="wkfp-btn">${esc(b)}</button>`)
        .join('')}</div>`;
    const body = dlg.querySelector('.wkfp-dlg-body');
    if (typeof o.body === 'string') body.innerHTML = o.body;
    else body.appendChild(o.body);
    shade.appendChild(dlg);
    win.appendChild(shade);
    wkfpDraggable(dlg);
    const close = (v) => {
      if (v != null && o.check && !o.check(v, dlg)) return;
      shade.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(o.buttons.length > 1 ? o.buttons[o.buttons.length - 1] : null);
      } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        e.preventDefault();
        e.stopPropagation();
        close(o.buttons[0]);
      } else if (/^F\d$/.test(e.key)) {
        // the window's F-keys wait while a dialog is open
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    dlg.querySelector('.wkfp-x').onclick = () =>
      close(o.buttons.length > 1 ? o.buttons[o.buttons.length - 1] : null);
    dlg
      .querySelectorAll('.wkfp-dlg-btns .wkfp-btn')
      .forEach((b, i) => (b.onclick = () => close(o.buttons[i])));
    if (o.onOpen) o.onOpen(dlg);
    const first =
      dlg.querySelector('input:not([disabled]), select') ||
      dlg.querySelector('.wkfp-dlg-btns .wkfp-btn');
    if (first) first.focus();
  });
}

/**
 * WinKFP's message box.
 * @param {HTMLElement} win - The window.
 * @param {'info'|'error'|'warn'|'question'} kind - Its icon.
 * @param {string} text - What it says (plain text).
 * @param {string[]} [buttons] - OK by default.
 * @param {string} [title] - Its own title, where WinKFP gives one.
 * @returns {Promise<string|null>}
 */
function wkfpMessage(win, kind, text, buttons, title) {
  const titles = {
    info: 'Info',
    error: 'Error',
    warn: 'Warning',
    question: 'Info',
  };
  const glyph = { info: 'i', error: '✕', warn: '!', question: '?' };
  return wkfpDialog(win, {
    title: title || titles[kind],
    cls: 'wkfp-msg',
    body: `<div class="wkfp-msg-row"><span class="wkfp-icon wkfp-icon-${kind}">${glyph[kind]}</span><div class="wkfp-msg-text">${esc(text)}</div></div>`,
    buttons: buttons || ['OK'],
  });
}

/**
 * A programming outlives the screen: it keeps running when the reader goes
 * elsewhere in BMWeb, and coming back finds it. `state` is WebKFP's state
 * (one per page), `win` the window currently showing it (the newest render),
 * `pending` WinKFP's answer to a programming that ended while nobody was
 * looking, shown on the way back in.
 * `restored` is true once an earlier visit's choice has been brought back
 * ('restoring' while it is).
 * @type {{state: object|null, win: HTMLElement|null,
 *   pending: (() => void)|null, restored: boolean|string}}
 */
const wkfpLive = {
  state: null,
  win: null,
  pending: null,
  restored: false,
  /** The current screen's painter: a flow from an earlier build paints through it. */
  paint: null,
};

/** @returns {boolean} Whether WebKFP's window is the one on screen. */
function wkfpOnScreen() {
  return !!(wkfpLive.win && document.body.contains(wkfpLive.win));
}

/**
 * The badge that follows a programming around BMWeb: on any other screen it
 * shows how far it is and takes the reader back; on WebKFP, or with nothing
 * running, it is gone.
 * @returns {void}
 */
function wkfpBadge() {
  const st = wkfpLive.state;
  const want = !!(st && (st.running || wkfpLive.pending)) && !wkfpOnScreen();
  let b = document.getElementById('wkfp-badge');
  if (!want) {
    if (b) b.remove();
    return;
  }
  if (!b) {
    b = document.createElement('button');
    b.id = 'wkfp-badge';
    b.className = 'wkfp-badge';
    b.onclick = () => showWebKfp();
    document.body.appendChild(b);
  }
  b.textContent = st.running
    ? `WebKFP programming${st.pct != null ? ` ${st.pct}%` : '...'}`
    : 'WebKFP finished: open';
}

if (typeof window !== 'undefined')
  // a reload or a closed tab would cut the module off mid-flash
  window.addEventListener('beforeunload', (e) => {
    if (wkfpLive.state) wkfpSaveLog(wkfpLive.state.log);
    if (wkfpLive.state && wkfpLive.state.running) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

/**
 * Render WebKFP.
 * @returns {void}
 */
function showWebKfp() {
  lastScreen = showWebKfp;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'WebKFP' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'webkfp';
  view.innerHTML = '';

  // one state per page: a programming started on an earlier visit is still it
  const state =
    wkfpLive.state ||
    (wkfpLive.state = {
      /** 'main' | 'comfort' | 'expert' | 'diag' | 'special' | 'vs20' */
      mode: 'main',
      /**
       * expert mode's configuration: {pabd: KfpModule (the family whose PABD),
       * sgbd, address, data, program, naab: {mod, name, file}}; null outside it
       */
      exp: null,
      ini: wkfpIni(),
      picked: [],
      folderName: '',
      /** where the SP-Daten come from: 'hf' (bmw-files) or 'local' (imported) */
      source: 'hf',
      /** per module id: {rows, files} once its table is read */
      tables: {},
      mod: null,
      row: null,
      vin: '',
      running: false,
      ubattWaived: false,
      pct: null,
      /** the last programming's steps and jobs: Display > ERROR.LOG */
      log: wkfpLoadLog(),
      /** the module and ZB being programmed, for the info panel meanwhile */
      prog: null,
      /** what the message panel and the status line say, kept for a return */
      stage: '',
      status: '',
    });

  // leaving is fine while programming: it goes on, and the badge follows it
  const leave = () => showApps();
  setActions([
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: leave },
  ]);

  // The INPA-style layout is WinKFP's own window; the modern one is the same
  // flow -- the same keys, menus, dialogs and programming, bound to the same
  // ids -- drawn as a BMWeb screen (styles.css: .ncs-modern is the modern
  // skin NCS and WebKFP share, .wkfp-modern WebKFP's own panels)
  const modern = !inpaMode();
  const win = document.createElement('div');
  win.className = modern ? 'ncs-modern wkfp-modern' : 'wkfp-win';
  win.innerHTML = modern
    ? `
    <div class="ncsm-head">
      <div><div class="ncsm-eyebrow">Programming</div><div class="ncsm-title" id="wkfp-title"></div></div>
      <div class="ncsm-menubar" id="wkfp-menubar"></div>
    </div>
    <div class="wkfpm-mode" id="wkfpm-mode"></div>
    <div class="ncsm-grid">
      <section class="ncsm-card">
        <div class="ncsm-label">Control unit</div>
        <div class="wkfpm-kv">
          <span>Address</span><span id="wkfp-adr"></span>
          <span>VIN</span><span id="wkfp-fg"></span>
          <span>Assembly (ZB)</span><span id="wkfp-zb"></span>
          <span>Hardware</span><span id="wkfp-hw"></span>
          <span>Interface</span><span id="wkfp-hwif">STD:OBD</span>
          <span>Protocol</span><span id="wkfp-prot"></span>
        </div>
      </section>
      <section class="ncsm-card">
        <div class="ncsm-label">Programming</div>
        <div class="wkfpm-bsu">Boot sector update: <span id="wkfp-bsu"></span></div>
        <div class="wkfpm-kv" id="wkfp-pabd" hidden>
          <span>PABD</span><span id="wkfp-pabd-name"></span>
          <span>P-SGBD</span><span id="wkfp-psgbd-name"></span>
        </div>
        <div class="wkfpm-kv" id="wkfp-expfiles" hidden></div>
        <div class="wkfpm-stage" id="wkfp-stage"></div>
        <div class="wkfpm-bar" id="wkfp-bar" hidden><div class="wkfpm-fill" id="wkfp-fill"></div><div class="wkfpm-pct" id="wkfp-pct"></div></div>
      </section>
    </div>
    <div class="ncsm-actions wkfpm-actions" id="wkfp-fkeys"></div>
    <div class="ncsm-status"><span id="wkfp-status">Ready</span></div>
    <input type="file" id="wkfp-picker" multiple webkitdirectory hidden>`
    : `
    <div class="wkfp-titlebar" id="wkfp-title"></div>
    <div class="wkfp-menubar" id="wkfp-menubar"></div>
    <div class="wkfp-client">
      <fieldset class="wkfp-panel wkfp-info">
        <div class="wkfp-grid">
          <span>ECU address/integration position:</span><span id="wkfp-adr"></span>
          <span>Vehicle identification number :</span><span id="wkfp-fg"></span>
          <span>Assembly identification number :</span><span id="wkfp-zb"></span>
          <span>Hardware number :</span><span id="wkfp-hw"></span>
        </div>
        <div class="wkfp-ifrow">
          <span>HW interface:&nbsp; <span id="wkfp-hwif">STD:OBD</span></span>
          <span>Diagnosis protocol:&nbsp; <span id="wkfp-prot"></span></span>
        </div>
      </fieldset>
      <fieldset class="wkfp-panel wkfp-msgpanel">
        <div>Bootsectorupdate</div>
        <div id="wkfp-bsu"></div>
        <div class="wkfp-pabd" id="wkfp-pabd" hidden>
          <span>PABD:</span><span id="wkfp-pabd-name"></span>
          <span>P-SGBD:</span><span id="wkfp-psgbd-name"></span>
        </div>
        <div class="wkfp-pabd wkfp-expfiles" id="wkfp-expfiles" hidden></div>
        <div class="wkfp-stage" id="wkfp-stage"></div>
      </fieldset>
      <fieldset class="wkfp-panel wkfp-progpanel">
        <div class="wkfp-bar" id="wkfp-bar" hidden><div class="wkfp-bar-fill" id="wkfp-fill"></div><div class="wkfp-bar-text" id="wkfp-pct"></div></div>
      </fieldset>
      <fieldset class="wkfp-panel wkfp-fkeys" id="wkfp-fkeys"></fieldset>
    </div>
    <div class="wkfp-statusbar"><span id="wkfp-status">Ready</span><span class="wkfp-lock">CAP</span><span class="wkfp-lock">NUM</span><span class="wkfp-lock">SCRL</span></div>
    <input type="file" id="wkfp-picker" multiple webkitdirectory hidden>`;
  view.appendChild(win);
  wkfpLive.win = win;
  wkfpLive.paint = paint;
  if (!modern) winMaximizable(win);
  // the live window, not this render's: a programming started on an earlier
  // visit paints here
  const $ = (id) => wkfpLive.win.querySelector('#' + id);
  const picker = $('wkfp-picker');

  // ---- painting ----------------------------------------------------------------
  function paint() {
    // a flow that started on an earlier build of this screen (the reader
    // went elsewhere during a programming and came back) paints THIS one
    if (wkfpLive.paint && wkfpLive.paint !== paint) return wkfpLive.paint();
    // not before the earlier visit's choice is back: it would be overwritten
    if (wkfpLive.restored === true) wkfpSaveChoice(state);
    const exp = state.exp;
    // while a ZB is programmed, the panel names it, however it was picked
    const prog = state.running && state.prog;
    const mod = prog
      ? prog.mod
      : exp
        ? exp.pabd && expReady() && expModule()
        : state.mod;
    const row = prog ? prog.row : exp ? null : state.row;
    $('wkfp-title').textContent =
      'WebKFP' + (state.pct != null ? ` (${state.pct}%)` : '');
    $('wkfp-adr').innerHTML = mod
      ? `${esc(mod.address)}&nbsp;&nbsp;&nbsp;${exp ? '' : '&lt;default&gt;'}`
      : '';
    $('wkfp-fg').textContent = state.vin;
    $('wkfp-zb').textContent = row ? row.zb : '';
    $('wkfp-hw').textContent = row ? row.hw : '';
    $('wkfp-prot').textContent = mod ? mod.protocol : '';
    $('wkfp-bsu').textContent = state.ini.BSU_ZULASSEN
      ? 'ACTIVATED'
      : 'NOT ACTIVATED';
    const pabd = exp ? exp.pabd && exp.pabd.pabd : mod && mod.pabd;
    const sgbd = exp ? exp.sgbd : mod && mod.sgbd;
    $('wkfp-pabd').hidden = !pabd && !sgbd;
    $('wkfp-pabd-name').textContent = pabd ? `${pabd.toUpperCase()}.IPO` : '';
    $('wkfp-psgbd-name').textContent = sgbd ? `${sgbd.toUpperCase()}.PRG` : '';
    const files = $('wkfp-expfiles');
    files.hidden = !exp;
    if (exp)
      files.innerHTML = [
        ['Data file:', exp.data],
        ['Program file:', exp.program],
        ['NAAB file:', exp.naab],
      ]
        .map(
          ([label, f]) =>
            `<span>${label}</span><span>${f ? `${esc(f.mod.folder)}/${esc(f.name)}` : ''}</span>`
        )
        .join('');
    $('wkfp-bar').hidden = state.pct == null;
    if (state.pct != null) {
      $('wkfp-fill').style.width = `${state.pct}%`;
      $('wkfp-pct').textContent = `${state.pct}%`;
    }
    $('wkfp-stage').textContent = state.stage;
    $('wkfp-status').textContent = state.status || 'Ready';
    if (modern) {
      // which of WinKFP's modes the keys belong to: its window says it only
      // by the keys themselves
      const names = {
        main: 'Choose a mode',
        comfort: 'Comfort mode · program by assembly number (ZUSB)',
        expert: 'Expert mode · choose the PABD, SGBD and files yourself',
        diag: 'Diagnosis',
        special: 'Special functions',
        vs20: 'Special functions · VS20/DS2 mode',
      };
      $('wkfpm-mode').textContent = names[state.mode] || state.mode;
    }
    paintKeys();
    paintMenu();
    wkfpBadge();
  }

  function setStatus(text) {
    state.status = text || '';
    $('wkfp-status').textContent = state.status || 'Ready';
  }
  function setStage(text) {
    state.stage = text || '';
    $('wkfp-stage').textContent = state.stage;
    wkfpBadge();
  }

  // ---- the F-keys ----------------------------------------------------------------
  function keys() {
    const idle = !state.running;
    // WinKFP fills the keys in order, each in the next free slot
    const fill = (list) => [
      ...list,
      ...Array.from({ length: 8 - list.length }, () => ['', false]),
    ];
    if (state.mode === 'comfort')
      return [
        ['Enter ZUSB', idle, enterZusb],
        ['Choose ZUSB', idle, chooseZusb],
        ['Update ZUSB', idle, comfortUpdate],
        ['Enter VIN', idle, enterVin],
        ['', false],
        ['', false],
        ['', false],
        ['Done', idle, () => setMode('main')],
      ];
    if (state.mode === 'diag')
      return [
        ['ECU Status', idle, diagStatus],
        ['ECU Ident', idle, diagIdent],
        ['ECU intern. Temp.', idle, diagTemp],
        ['', false],
        ['', false],
        ['', false],
        ['', false],
        ['Done', idle, () => setMode('main')],
      ];
    if (state.mode === 'special')
      return [
        ['Read UIF', idle, specialAif],
        ['ECU baudrates', idle, specialBaud],
        ['Adjustment values', idle, notImplemented],
        ['VS20/DS2 mode', idle, () => setMode('vs20')],
        ['EWS adjustment', idle, notImplemented],
        ['HD download', idle, notImplemented],
        ['', false],
        ['Done', idle, () => setMode('main')],
      ];
    if (state.mode === 'vs20')
      return [
        ['VS20 mode', idle, () => specialMode('VS20_MODE', 'VS20')],
        ['DS2 mode', idle, () => specialMode('D2_MODE', 'DS2')],
        ['', false],
        ['', false],
        ['', false],
        ['', false],
        ['', false],
        ['Done', idle, () => setMode('special')],
      ];
    if (state.mode === 'expert') {
      const list = [
        ['PABD', idle, expPabd],
        ['P-SGBD', idle, expSgbd],
      ];
      if (expReady())
        list.push(
          ['ECU Address', idle, expAddress],
          ['Data file', idle, () => expFile('data')],
          ['Program file', idle, () => expFile('program')],
          ['NAAB file', idle, () => expFile('naab')]
        );
      list.push(['Done', idle, () => setMode('main')]);
      return fill(list);
    }
    const list = [
      ['Comfort mode', idle, () => setMode('comfort')],
      ['Expert mode', idle, () => setMode('expert')],
    ];
    const e = state.exp;
    if (e && expReady()) {
      // NAAB files (boot sector updates) WebKFP does not program
      if (e.naab) list.push(['Prog. NAAB', false]);
      if (e.program)
        list.push(['Prog. Program', idle, () => expProgram('program')]);
      if (e.data) list.push(['Prog. Data', idle, () => expProgram('data')]);
      list.push([
        'Program',
        idle && !!(e.program || e.data),
        () => expProgram(null),
      ]);
    } else {
      // a ZB set in comfort mode is programmed as it is; none, and the
      // module's own is updated
      list.push(
        state.row
          ? ['Program', idle, () => programZb(state.mod, state.row)]
          : ['Prog. ZB-Update', idle, progZbUpdate]
      );
    }
    list.push(
      ['Special', idle && !!diagModule(), () => setMode('special')],
      ['Diagnosis', idle && !!diagModule(), () => setMode('diag')]
    );
    return fill(list);
  }
  function paintKeys() {
    const box = $('wkfp-fkeys');
    box.innerHTML = '';
    if (modern) {
      // the same eight keys as buttons, their F-key beside the name; the
      // writes stand out, WinKFP's blank slots are left out
      keys().forEach(([label, on, fn], i) => {
        if (!label) return;
        const b = document.createElement('button');
        const write = /^Prog|^Program$|^Update ZUSB$/.test(label);
        b.className = 'btn ncsm-key' + (write ? ' primary' : '');
        b.innerHTML = `<kbd>F${i + 1}</kbd><span>${esc(label)}</span>`;
        b.disabled = !on;
        if (on && fn) b.onclick = fn;
        box.appendChild(b);
      });
      return;
    }
    keys().forEach(([label, on, fn], i) => {
      const cell = document.createElement('div');
      cell.className = 'wkfp-fkey';
      const b = document.createElement('button');
      b.className = 'wkfp-btn';
      b.textContent = label;
      b.disabled = !on;
      if (on && fn) b.onclick = fn;
      cell.append(`F${i + 1}`, b);
      box.appendChild(cell);
    });
  }
  function setMode(mode) {
    // one configuration at a time: a ZB number, or the expert's own choice
    if (mode === 'expert' && !state.exp) {
      state.exp = {
        pabd: null,
        sgbd: '',
        address: '',
        data: null,
        program: null,
        naab: null,
      };
      state.mod = null;
      state.row = null;
    }
    if (mode === 'comfort') state.exp = null;
    state.mode = mode;
    paint();
  }
  const onKey = (e) => {
    if (!document.body.contains(win)) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    const m = /^F([1-8])$/.exec(e.key);
    if (!m) return;
    e.preventDefault();
    const k = keys()[Number(m[1]) - 1];
    if (k && k[1] && k[2]) k[2]();
  };
  document.addEventListener('keydown', onKey);

  // ---- the menu bar --------------------------------------------------------------
  function menus() {
    const idle = !state.running;
    const display = [['ERROR.LOG', true, showLog]];
    const importExport = [
      ['Import assembly line data...', idle, importData],
      ['Use online SP-Daten', idle && state.source === 'local', useOnline],
    ];
    const communication = [
      ['HW interface...', true, showInterface],
      ['Diagnosis protocol...', true, showProtocol],
    ];
    const configuration = [
      ['Ini Options...', idle, iniOptions],
      ['Clear fields', idle, clearFields],
    ];
    const list = [
      ['Display', display],
      ['Import/Export', importExport],
      ['Communication', communication],
      ['Configuration', configuration],
    ];
    if (state.mode !== 'main') list.push(['End', () => setMode('main')]);
    else list.unshift(['File', [['Exit', idle, leave]]]);
    return list;
  }
  let openMenu = null;
  function closeMenu() {
    if (openMenu) openMenu.remove();
    openMenu = null;
  }
  function paintMenu() {
    const bar = $('wkfp-menubar');
    bar.innerHTML = '';
    for (const [name, items] of menus()) {
      const b = document.createElement('button');
      b.className = modern ? 'btn ncsm-menu' : 'wkfp-menu';
      // an entry that acts at once (no list) carries no drop-down arrow
      b.textContent =
        modern && typeof items !== 'function' ? `${name} ▾` : name;
      b.onclick = (e) => {
        e.stopPropagation();
        const wasMine = openMenu && openMenu.dataset.menu === name;
        closeMenu();
        if (typeof items === 'function') {
          if (!state.running) items();
          return;
        }
        if (wasMine) return;
        const drop = document.createElement('div');
        drop.className = 'wkfp-drop';
        drop.dataset.menu = name;
        for (const [label, on, fn] of items) {
          const it = document.createElement('button');
          it.className = 'wkfp-drop-item';
          it.textContent = label;
          it.disabled = !on;
          it.onclick = (ev) => {
            ev.stopPropagation();
            closeMenu();
            fn();
          };
          drop.appendChild(it);
        }
        drop.style.left = `${b.offsetLeft}px`;
        bar.appendChild(drop);
        openMenu = drop;
      };
      bar.appendChild(b);
    }
  }
  win.addEventListener('click', closeMenu);

  // ---- Import: the SP-Daten folder -------------------------------------------------
  function importData() {
    picker.click();
  }
  picker.onchange = async () => {
    const files = Array.from(picker.files || []);
    picker.value = '';
    if (!files.length) return;
    state.picked = files;
    state.source = 'local';
    state.folderName = (files[0].webkitRelativePath || '').split('/')[0];
    state.tables = {};
    state.mod = null;
    state.row = null;
    // expert file picks name files of the source being left
    if (state.exp) state.exp.data = state.exp.program = state.exp.naab = null;
    setStatus('Reading the assembly line data...');
    const found = [];
    const all = await wkfpFamilies();
    for (const mod of all) {
      const m = wkfpModuleFiles(mod, files);
      if (!m) continue;
      try {
        const names = Array.from(m.files.keys());
        const rows = kfpDaten
          .parseZbTable(await wkfpText(m.table))
          .map((r) => ({ ...r, ...kfpDaten.filesFor(r, names) }));
        state.tables[mod.id] = { rows, files: m.files };
        found.push(`${mod.folder}: ${rows.length} ZB numbers`);
      } catch (e) {
        found.push(
          `${mod.folder}: ${mod.table} unreadable (${e.message || e})`
        );
      }
    }
    // a folder with nothing WebKFP programs leaves the online SP-Daten in place
    if (!Object.keys(state.tables).length) state.source = 'hf';
    setStatus('');
    paint();
    await wkfpMessage(
      wkfpLive.win,
      found.length ? 'info' : 'error',
      found.length
        ? `Imported from ${state.folderName || 'the folder'}:\n${found.join('\n')}`
        : `No ZB table of any module family (${all
            .map((m) => m.table)
            .join(
              ', '
            )}) in ${state.folderName || 'the folder'}.\n\nChoose the SP-Daten "data" folder, the chassis folder, or the module's own folder.`
    );
  };

  /**
   * The modules there are SP-Daten for: the imported folder's, or the
   * online index's. Asks to import a folder when there are none.
   * @returns {Promise<KfpModule[]>}
   */
  async function families() {
    const all = await wkfpFamilies();
    if (state.source === 'local') {
      const mods = all.filter((m) => state.tables[m.id]);
      if (mods.length) return mods;
    } else {
      setStatus('Fetching the SP-Daten list...');
      const idx = await wkfpSpdIndex();
      setStatus('');
      const mods = idx ? all.filter((m) => idx.modules[m.folder]) : [];
      if (mods.length) return mods;
    }
    const b = await wkfpMessage(
      wkfpLive.win,
      'warn',
      state.source === 'local'
        ? 'No assembly line data imported.\n\nImport the SP-Daten folder now?'
        : 'The SP-Daten could not be fetched from Hugging Face.\n\nImport an SP-Daten folder from this computer instead?',
      ['OK', 'Cancel']
    );
    if (b === 'OK') importData();
    return [];
  }

  /**
   * A module's ZB table, fetched the first time it is needed (imported
   * folders have theirs already). The program and data files it names are
   * listed, not fetched.
   * @param {KfpModule} mod - The module.
   * @param {boolean} [quiet] - a failure is not shown (a lookup across
   *   many tables, where one missing table is no error).
   * @returns {Promise<boolean>} whether its table is there.
   */
  async function ensureTable(mod, quiet) {
    if (state.tables[mod.id]) return true;
    if (state.source !== 'hf') return false;
    const idx = await wkfpSpdIndex();
    const byChassis = idx && idx.modules[mod.folder];
    const chassis = byChassis && Object.keys(byChassis).sort()[0];
    if (!chassis) return false;
    const entry = byChassis[chassis];
    const files = new Map(
      Object.entries(entry.files).map(([name, size]) => [
        name,
        wkfpRemoteFile(entry.path + name, name, size),
      ])
    );
    if (!quiet) setStatus(`Fetching ${entry.table}...`);
    try {
      const names = Array.from(files.keys());
      const rows = kfpDaten
        .parseZbTable(await wkfpText(files.get(entry.table)))
        .map((r) => ({ ...r, ...kfpDaten.filesFor(r, names) }));
      state.tables[mod.id] = { rows, files };
      return true;
    } catch (e) {
      if (!quiet)
        await wkfpMessage(wkfpLive.win, 'error', (e && e.message) || String(e));
      return false;
    } finally {
      if (!quiet) setStatus('');
    }
  }

  /** Back to the online SP-Daten after an import. */
  function useOnline() {
    state.source = 'hf';
    state.folderName = '';
    state.tables = {};
    state.mod = null;
    state.row = null;
    // expert file picks name files of the source being left
    if (state.exp) state.exp.data = state.exp.program = state.exp.naab = null;
    paint();
  }

  // ---- comfort mode ----------------------------------------------------------------
  /**
   * Make a ZB number the one Update ZUSB programs.
   * @param {KfpModule} mod - Its module.
   * @param {object} row - Its ZB table row.
   * @returns {void}
   */
  function choose(mod, row) {
    state.mod = mod;
    state.row = row;
    paint();
  }

  /** Choose assembly identification number / integration position. */
  async function chooseZusb() {
    const fams = await families();
    if (!fams.length) return;
    const first = state.mod && fams.includes(state.mod) ? state.mod : fams[0];
    if (!(await ensureTable(first))) return;
    const byId = (id) => fams.find((m) => m.id === id);
    const body = document.createElement('div');
    body.className = 'wkfp-choose';
    body.innerHTML = `
      <label>ECU family:<select size="12" id="wkfp-c-fam"></select></label>
      <label>ZB-Number:<select size="12" id="wkfp-c-zb"></select></label>
      <label class="wkfp-choose-pos">Integration position:<select size="12" id="wkfp-c-pos"></select></label>`;
    const fam = body.querySelector('#wkfp-c-fam');
    const zb = body.querySelector('#wkfp-c-zb');
    const pos = body.querySelector('#wkfp-c-pos');
    fam.innerHTML = fams
      .map((m) => `<option value="${m.id}">${esc(m.folder)}</option>`)
      .join('');
    const fillZb = () => {
      const t = state.tables[fam.value];
      zb.innerHTML = (t ? t.rows : [])
        .map(
          (r, i) =>
            `<option value="${i}"${r.program || r.data ? '' : ' class="wkfp-nofile"'}>${esc(r.zb)}</option>`
        )
        .join('');
      pos.innerHTML = '';
    };
    const fillPos = () => {
      pos.innerHTML =
        zb.value === '' ? '' : '<option selected>&lt;default&gt;</option>';
    };
    fam.onchange = async () => {
      zb.innerHTML = '';
      pos.innerHTML = '';
      if (await ensureTable(byId(fam.value))) fillZb();
    };
    zb.onchange = fillPos;
    fam.value = first.id;
    fillZb();
    if (state.row && state.mod && state.mod.id === fam.value) {
      zb.value = String(state.tables[fam.value].rows.indexOf(state.row));
      fillPos();
    }
    const b = await wkfpDialog(wkfpLive.win, {
      title: 'Choose assembly identification number / integration position',
      cls: 'wkfp-choose-dlg',
      body,
      buttons: ['OK', 'Cancel'],
      check: (btn) =>
        btn !== 'OK' || (zb.value !== '' && !!state.tables[fam.value]),
    });
    if (b !== 'OK') return;
    const mod = byId(fam.value);
    choose(mod, state.tables[mod.id].rows[Number(zb.value)]);
  }

  /** Enter ZUSB: the ZB number typed, looked up in every imported table. */
  async function enterZusb() {
    const fams = await families();
    if (!fams.length) return;
    const body = document.createElement('div');
    body.className = 'wkfp-form';
    body.innerHTML = `<label>Assembly identification number:<input class="wkfp-input" id="wkfp-e-zb" maxlength="7" inputmode="numeric" value="${state.row ? esc(state.row.zb) : ''}"></label>`;
    const input = body.querySelector('input');
    const b = await wkfpDialog(wkfpLive.win, {
      title: 'Enter assembly identification number',
      body,
      buttons: ['OK', 'Cancel'],
      check: (btn) => btn !== 'OK' || /^\d{7}$/.test(input.value.trim()),
    });
    if (b !== 'OK') return;
    const want = input.value.trim();
    const hit = (mod) => {
      const t = state.tables[mod.id];
      return t && t.rows.find((r) => r.zb === want);
    };
    // WinKFP looks the number up in tables on disk; here they come from
    // Hugging Face, so look where it most likely is first -- the family in
    // use, then the ones at its address -- and fetch the rest a few at a
    // time, stopping at the first table that has it. Fetched tables stay.
    const cur = state.mod && fams.includes(state.mod) ? state.mod : null;
    const order = [
      ...(cur ? [cur] : []),
      ...fams.filter((m) => m !== cur && cur && m.address === cur.address),
      ...fams.filter((m) => m !== cur && !(cur && m.address === cur.address)),
    ];
    for (const mod of order.filter((m) => state.tables[m.id])) {
      const row = hit(mod);
      if (row) return choose(mod, row);
    }
    const todo = order.filter((m) => !state.tables[m.id]);
    const BATCH = 6;
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      setStatus(
        `Looking for ${want} in ${batch.map((m) => m.folder).join(', ')}...`
      );
      await Promise.all(batch.map((m) => ensureTable(m, true)));
      for (const mod of batch) {
        const row = hit(mod);
        if (row) {
          setStatus('');
          return choose(mod, row);
        }
      }
    }
    setStatus('');
    await wkfpMessage(
      wkfpLive.win,
      'error',
      `Assembly identification number ${want} not found.`
    );
  }

  /** Enter VIN: 17 characters, or the last 7. */
  async function enterVin() {
    const body = document.createElement('div');
    body.className = 'wkfp-form';
    body.innerHTML = `<label>Vehicle identification number:<input class="wkfp-input wkfp-vin" maxlength="17" spellcheck="false" value="${esc(state.vin)}"></label>`;
    const input = body.querySelector('input');
    input.oninput = () => (input.value = input.value.toUpperCase());
    const b = await wkfpDialog(wkfpLive.win, {
      title: 'Enter vehicle identification number',
      body,
      buttons: ['OK', 'Cancel'],
      check: (btn) =>
        btn !== 'OK' ||
        /^([A-HJ-NPR-Z0-9]{7}|[A-HJ-NPR-Z0-9]{17})$/.test(input.value.trim()),
    });
    if (b !== 'OK') return false;
    state.vin = input.value.trim();
    paint();
    return true;
  }

  // ---- programming a ZB --------------------------------------------------------------
  // WinKFP's main window: with a ZB set in comfort mode, F3 is Program (that
  // ZB); with none, Prog. ZB-Update (the module says which ZB it carries,
  // the family's history says what replaced it, and the operator is asked).
  // Comfort mode's own keys only set the job up.

  /**
   * The module's identification, the way WinKFP reads it
   * (coapiKfGetHwNrFromSgD2: SG_IDENT_LESEN's ID_BMW_NR and ID_HW_NR).
   * @param {object} exec - The script.
   * @param {object} base - The job options.
   * @returns {Promise<{zb: string, hw: string}>} '' where the module cannot say.
   */
  async function identifyModule(exec, base) {
    try {
      const r = await kfp.runJob(exec, 'SG_IDENT_LESEN', base);
      if (!r.ok) return { zb: '', hw: '' };
      return {
        zb: String(r.params.ID_BMW_NR || '').trim(),
        hw: String(r.params.ID_HW_NR || '').trim(),
      };
    } catch (e) {
      return { zb: '', hw: '' };
    }
  }

  /** @returns {Promise<string>} The module's current ZB, '' when it cannot say. */
  async function identify(exec, base) {
    return (await identifyModule(exec, base)).zb;
  }

  /** The job options every WebKFP job runs with, as on an EDIC. */
  function jobBase(mod) {
    return {
      sgbd: mod.sgbd,
      address: mod.address,
      runJob: async (sgbd, job, arg) =>
        (await webRunJob(sgbd, job, arg, { interfaceType: 'EDIC' })).sets,
    };
  }

  /** Choose ECU family / integration position (WinKFP's dialog 120). */
  async function chooseFamily() {
    const fams = await families();
    if (!fams.length) return null;
    const body = document.createElement('div');
    body.className = 'wkfp-choose wkfp-choose-file';
    body.innerHTML = `
      <label>ECU familiy:<select size="14" id="wkfp-cf-fam">${fams
        .map(
          (m) =>
            `<option value="${m.id}"${state.mod && state.mod.id === m.id ? ' selected' : ''}>${esc(m.folder)}</option>`
        )
        .join('')}</select></label>
      <label>Integration position:<select size="14"><option selected>&lt;default&gt;</option></select></label>`;
    const fam = body.querySelector('#wkfp-cf-fam');
    const b = await wkfpDialog(wkfpLive.win, {
      title: 'Choose ECU family / integration position',
      body,
      buttons: ['OK', 'Cancel'],
      check: (btn) => btn !== 'OK' || !!fam.value,
    });
    return b === 'OK' ? fams.find((m) => m.id === fam.value) : null;
  }

  /**
   * What the module carries and what replaced it, the way WinKFP's
   * Prog. ZB-Update works it out: the ZB in its programming record
   * (SG_AIF_LESEN's AIF_ZB_NR, "ZBNr. from UIF"), or, with none there, the
   * one its identification names; then the family's history (<family>.HIS)
   * to the newest ZB the table lists.
   * @param {KfpModule} mod - The family.
   * @returns {Promise<{uif: string, row: object|null}|null>} null when it
   *   could not be asked (no table, no script).
   */
  async function findUpdate(mod) {
    if (!(await ensureTable(mod))) return null;
    const t = state.tables[mod.id];
    const hisName = [...t.files.keys()].find(
      (n) => n.toUpperCase() === `${mod.folder.toUpperCase()}.HIS`
    );
    setStatus('Reading the user info field...');
    try {
      const exec = await wkfpScript(mod);
      const base = jobBase(mod);
      let uif = '';
      try {
        const r = await kfp.runJob(exec, 'SG_AIF_LESEN', {
          ...base,
          params: { AIF_NUMMER: '0' },
        });
        if (r.ok) uif = String(r.params.AIF_ZB_NR || '').trim();
      } catch (e) {
        /* no record: WinKFP shows the field empty */
      }
      setStatus('Identifying the module...');
      const id = await identifyModule(exec, base);
      const from = /^\d{7}$/.test(uif) ? uif : id.zb;
      const history = hisName
        ? kfpDaten.parseHistory(await wkfpText(t.files.get(hisName)))
        : new Map();
      return {
        uif,
        row: from ? kfpDaten.latestZb(history, from, t.rows) : null,
      };
    } catch (e) {
      await wkfpMessage(wkfpLive.win, 'error', (e && e.message) || String(e));
      return null;
    } finally {
      setStatus('');
    }
  }

  /** WinKFP's result text: the record's ZB, and the update ("0" for none). */
  function updateText(found) {
    return (
      `ECU -> ZBNr. from UIF: ${found.uif}\n` +
      `Update -> current ZBNr.: ${found.row ? found.row.zb : '0'}`
    );
  }

  /** Comfort mode's Update ZUSB: the ZUSB becomes the module's newest ZB. */
  async function comfortUpdate() {
    const mod = state.mod || (await chooseFamily());
    if (!mod) return;
    const found = await findUpdate(mod);
    if (!found) return;
    if (found.row) choose(mod, found.row);
    await wkfpMessage(
      wkfpLive.win,
      'info',
      updateText(found),
      ['OK'],
      'Result - Assembly identification number update'
    );
  }

  /** Main window, no ZB set: Prog. ZB-Update. */
  async function progZbUpdate() {
    const mod = state.mod || (await chooseFamily());
    if (!mod) return;
    const found = await findUpdate(mod);
    if (!found) return;
    // asked whatever was found, as WinKFP asks: "0" when nothing was
    const b = await wkfpMessage(
      wkfpLive.win,
      'question',
      `${updateText(found)}\n\nProgram current ZBNr.?`,
      ['Yes', 'No'],
      'Result - Assembly identification number update'
    );
    if (b !== 'Yes') return;
    if (!found.row)
      return wkfpMessage(wkfpLive.win, 'error', 'Programming not possible!');
    await programZb(mod, found.row, { okText: 'ZUSB-Update programming OK' });
  }

  /**
   * Program one ZB: its program and data files, as the script asks for them.
   * @param {KfpModule} mod - The family.
   * @param {object} row - The ZB's table row.
   * @param {{okText?: string}} [o] - WinKFP's answer when it is done.
   */
  async function programZb(mod, row, o = {}) {
    if (!mod || !row || state.running) return;
    if (!row.program && !row.data) {
      await wkfpMessage(
        wkfpLive.win,
        'error',
        `No program or data file for ZB ${row.zb} in ${mod.folder}.`
      );
      return;
    }
    const withAif = state.ini.KOMFORT_MIT_AIF;
    if (withAif && !state.vin && !(await enterVin())) return;
    const files = state.tables[mod.id].files;
    const pick = {};
    for (const kind of ['program', 'data'])
      if (row[kind])
        pick[kind] = { name: row[kind], file: files.get(row[kind]) };
    state.prog = { mod, row };
    try {
      await runProgramming({
        mod,
        what: `ZB ${row.zb} into the ${mod.label}`,
        files: pick,
        // WinKFP: a module that cannot say, or one on other hardware, takes the program
        programIsNew: async (exec, base, log) => {
          const cur = await identify(exec, base);
          const curRow =
            cur && state.tables[mod.id].rows.find((r) => r.zb === cur);
          const isNew = !curRow || curRow.hw !== row.hw;
          log(
            `  current ZB ${cur || '?'}${curRow ? ` (hardware ${curRow.hw})` : ''}: program ${isNew ? 'is new' : 'unchanged'}`
          );
          return isNew;
        },
        forceProgram: state.ini.PROGRAMM_ERZWINGEN,
        aif: withAif
          ? {
              vin: state.vin,
              zb: row.zb,
              sw: row.sw,
              changeIndex: row.swIndex,
              approval: row.typ,
            }
          : null,
        okText: o.okText || 'Programming OK',
      });
    } finally {
      state.prog = null;
    }
  }

  /**
   * How many more programming records the module takes, for WinKFP's
   * UIF-Info question.
   * @param {KfpModule} mod - The module.
   * @returns {Promise<number|null>} AIF_ANZ_FREI, or null when it cannot say.
   */
  async function freeRecords(mod) {
    setStatus('Reading the user info field...');
    try {
      const r = await kfp.runJob(await wkfpScript(mod), 'SG_AIF_LESEN', {
        ...jobBase(mod),
        params: { AIF_NUMMER: '0' },
      });
      const n = Number(r.params.AIF_ANZ_FREI);
      return r.ok && Number.isFinite(n) ? n : null;
    } catch (e) {
      return null;
    } finally {
      setStatus('');
    }
  }

  /**
   * The cable's KL15 line before a programming. WinKFP refuses outright when
   * EDIABAS reads the ignition off (its 2022 / UbattHandling); here it is a
   * warning the reader can wave through, because a clone cable that never
   * wired the line reads off on a car whose ignition is on. A cable that
   * cannot report the line at all, or no cable, passes silently: no reading
   * is not evidence of ignition off.
   * @returns {Promise<boolean>} Whether to go on.
   */
  async function ignitionPreflight() {
    let st;
    try {
      st = await api('/api/state');
    } catch {
      return true;
    }
    if (!st || !st.connected || st.derived || st.ignition !== false)
      return true;
    // the reader said this cable's KL15 reading means nothing (Ini Options,
    // or "don't ask again" below): a programming is not held up by it
    if (state.ini.UBATT_PRUEFEN === false) {
      state.ubattWaived = true;
      return true;
    }
    const DONT_ASK = "Yes, don't ask again";
    const go = await wkfpMessage(
      wkfpLive.win,
      'warn',
      'The cable reports the ignition OFF (its KL15 line is low).\n\n' +
        'If the ignition really is off, stop here: a programming needs it on ' +
        'until the end. If it is on, this cable does not wire the KL15 line ' +
        'and the reading means nothing.\n\n' +
        `Program ECU anyway? "${DONT_ASK}" turns the check off for this ` +
        'browser (Options > Ini Options > Check battery / ignition).',
      ['Yes', DONT_ASK, 'No'],
      'Ignition'
    );
    if (go === DONT_ASK) {
      state.ini.UBATT_PRUEFEN = false;
      wkfpSaveIni(state.ini);
    }
    state.ubattWaived = go === 'Yes' || go === DONT_ASK;
    return state.ubattWaived;
  }

  /**
   * Program a module: the confirmation, the files fetched, BMW's script run,
   * WinKFP's answer. The main window's Program and Prog. ZB-Update and
   * expert mode's Prog. Program / Prog. Data / Program all come here.
   * @param {{mod: KfpModule, what: string,
   *   files: {program?: {name: string, file: object},
   *     data?: {name: string, file: object}},
   *   only?: 'program'|'data', forceProgram?: boolean,
   *   programIsNew: boolean|((exec: object, base: object,
   *     log: (s: string) => void) => Promise<boolean>),
   *   aif: KfpAif|null, okText: string, expert?: boolean}} job - `expert`
   *   for expert mode's keys, where the after-data / after-program record
   *   options apply.
   */
  async function runProgramming(job) {
    const mod = job.mod;
    if (state.running) return;
    if (typeof webOnSharedCar === 'function' && webOnSharedCar()) {
      await wkfpMessage(
        wkfpLive.win,
        'error',
        "WebKFP programs over this computer's own cable only, not over a shared car."
      );
      return;
    }
    // WinKFP's question before it programs: how many more records the
    // module takes (SG_AIF_LESEN's AIF_ANZ_FREI), then Program ECU?
    const free = await freeRecords(mod);
    const go = await wkfpMessage(
      wkfpLive.win,
      'question',
      (free != null
        ? `The user info field can still be programmed ${free} times\n\n`
        : '') + 'Program ECU?',
      ['Yes', 'No'],
      'UIF-Info'
    );
    if (go !== 'Yes') return;
    state.ubattWaived = false;
    if (!(await ignitionPreflight())) return;

    state.running = true;
    state.log = [];
    state.pct = 0;
    paint();
    const t0 = Date.now();
    const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
    const log = (line) => state.log.push(`${stamp()}  ${line}`);
    if (state.ubattWaived)
      log('The cable reads KL15 (ignition) low; programming anyway, as asked');
    const stage = (s) => {
      wkfpSaveLog(state.log);
      setStage(s);
      setStatus(s);
      log(s);
    };
    let result;
    let claim = null;
    try {
      stage('Loading the programming script');
      const exec = await wkfpScript(mod);
      const parsed = {};
      for (const kind of ['program', 'data']) {
        const pick = job.files[kind];
        if (!pick) continue;
        const f = pick.file;
        stage(
          f.remote
            ? `Fetching ${pick.name} (${Math.round(f.size / 1024)} KB)`
            : `Reading ${pick.name}`
        );
        parsed[kind] = {
          name: pick.name,
          file: kfpDaten.parseFile(await wkfpText(f)),
        };
      }
      // as on an EDIC: the flash SGBDs move the wire to the module's fast
      // rate (SET_EDIC_BAUDRATE) only on BMW's programming interface
      // the whole cable, until the end: nothing else in BMWeb may put a
      // telegram between two of the flash's
      claim = await webClaimBus('WebKFP');
      const exchange = claim.exchange;
      const runJob = async (sgbd, job, arg) =>
        (
          await webRunJob(sgbd, job, arg, {
            interfaceType: 'EDIC',
            exchange,
            maxPasses: WKFP_JOB_PASSES,
          })
        ).sets;
      const onJob = (e) => {
        if (e.job === 'FLASH_SCHREIBEN' && e.status === 'OKAY') return;
        log(
          `  ${e.job} [${e.arg.slice(0, 60)}] -> ${e.status}${e.error ? ` (${e.error})` : ''}`
        );
      };
      let programIsNew = job.programIsNew;
      if (typeof programIsNew === 'function') {
        stage('Identifying the module');
        programIsNew = await programIsNew(
          exec,
          { sgbd: mod.sgbd, address: mod.address, runJob, onJob },
          log
        );
      }
      result = await kfp.program({
        confirmed: true,
        module: mod,
        exec,
        files: parsed,
        only: job.only,
        programIsNew,
        fast: state.ini.SCHNELLE_BAUDRATE,
        testChecksum: state.ini.TEST_CHECKSUMME,
        forceProgram: !!job.forceProgram,
        // WinKFP's comfort mode writes one record, after the last file
        // ("UIF write in comfort mode" decides whether); the after-data and
        // after-program options are expert mode's
        aifLastOnly: !job.expert,
        aifAfterData: job.expert ? state.ini.AIF_SCHREIBEN_NACH_DATEN : true,
        aifAfterProgram: job.expert
          ? state.ini.AIF_SCHREIBEN_NACH_PROGRAMM
          : true,
        aif: job.aif,
        runJob,
        onStage: stage,
        onJob,
        onProgress: (sent, total) => {
          const pct = total ? Math.floor((sent * 100) / total) : 0;
          if (pct !== state.pct) {
            state.pct = pct;
            paintProgress();
          }
        },
      });
    } catch (e) {
      result = {
        ok: false,
        step: 'WebKFP',
        info: (e && e.message) || String(e),
        errors: [],
        written: [],
      };
    } finally {
      if (claim) claim.release();
    }
    state.running = false;
    state.pct = null;
    log(
      result.ok
        ? `OK: ${result.written.join(', ')}`
        : `FAILED at ${result.step}: ${result.info}`
    );
    wkfpSaveLog(state.log);
    setStage('');
    setStatus('');
    paint();
    // WinKFP's answer, now or, when the reader is elsewhere, on the way back
    const answer = () =>
      result.ok
        ? wkfpMessage(wkfpLive.win, 'info', job.okText)
        : showError(result);
    if (wkfpOnScreen()) await answer();
    else {
      wkfpLive.pending = answer;
      wkfpBadge();
    }
  }

  // ---- expert mode -----------------------------------------------------------------
  // WinKFP's expert mode: no ZB number, the operator names everything --
  // the PABD, the P-SGBD, the ECU address, the data and program files --
  // and then programs one file (Prog. Data, Prog. Program) or lets the
  // script decide (Program).

  /** @returns {boolean} whether the PABD and P-SGBD are set. */
  function expReady() {
    return !!(state.exp && state.exp.pabd && state.exp.sgbd);
  }

  /** @returns {KfpModule} the module the expert configuration programs. */
  function expModule() {
    const e = state.exp;
    return {
      ...e.pabd,
      sgbd: e.sgbd,
      address: e.address || e.pabd.address,
    };
  }

  /**
   * WinKFP's Choose list (TITLE_LISTBOX).
   * @param {string} label - What is chosen.
   * @param {string[]} items - The choices.
   * @param {string} [current] - The one selected.
   * @returns {Promise<string|null>}
   */
  async function chooseOne(label, items, current) {
    const body = document.createElement('div');
    body.className = 'wkfp-form';
    body.innerHTML = `<label>${esc(label)}<select size="14" class="wkfp-pick">${items
      .map(
        (it) =>
          `<option${it === current ? ' selected' : ''}>${esc(it)}</option>`
      )
      .join('')}</select></label>`;
    const sel = body.querySelector('select');
    sel.ondblclick = () =>
      sel.value &&
      body
        .closest('.wkfp-dlg')
        .querySelector('.wkfp-dlg-btns .wkfp-btn')
        .click();
    const b = await wkfpDialog(wkfpLive.win, {
      title: 'Choose',
      body,
      buttons: ['OK', 'Cancel'],
      check: (btn) => btn !== 'OK' || !!sel.value,
    });
    return b === 'OK' ? sel.value : null;
  }

  async function expPabd() {
    const fams = await wkfpFamilies();
    const names = [...new Set(fams.map((m) => `${m.pabd.toUpperCase()}.IPO`))];
    const cur = state.exp.pabd && `${state.exp.pabd.pabd.toUpperCase()}.IPO`;
    const pick = await chooseOne('PABD:', names, cur);
    if (!pick) return;
    state.exp.pabd = fams.find((m) => `${m.pabd.toUpperCase()}.IPO` === pick);
    state.exp.address = state.exp.pabd.address;
    paint();
  }

  async function expSgbd() {
    const fams = await wkfpFamilies();
    const names = [...new Set(fams.map((m) => `${m.sgbd.toUpperCase()}.PRG`))];
    // the PABD's own P-SGBD is offered first, as KFCONF pairs them
    const cur = state.exp.sgbd
      ? `${state.exp.sgbd.toUpperCase()}.PRG`
      : state.exp.pabd && `${state.exp.pabd.sgbd.toUpperCase()}.PRG`;
    const pick = await chooseOne('P-SGBD:', names, cur);
    if (!pick) return;
    state.exp.sgbd = pick.slice(0, -4).toLowerCase();
    paint();
  }

  async function expAddress() {
    const body = document.createElement('div');
    body.className = 'wkfp-form';
    body.innerHTML = `<label>ECU-Address<input class="wkfp-input wkfp-adr-in" maxlength="2" spellcheck="false" value="${esc(state.exp.address || '')}"></label><div class="wkfp-hint">Range: 00 - FF&nbsp;&nbsp;&nbsp;&nbsp;hexadecimal</div>`;
    const input = body.querySelector('input');
    input.oninput = () => (input.value = input.value.toUpperCase());
    const b = await wkfpDialog(wkfpLive.win, {
      title: 'Enter ECU-Address',
      body,
      buttons: ['OK', 'Cancel'],
      check: (btn) =>
        btn !== 'OK' || /^[0-9A-F]{1,2}$/.test(input.value.trim()),
    });
    if (b !== 'OK') return;
    state.exp.address = input.value.trim().padStart(2, '0');
    paint();
  }

  /**
   * A family's files by name, without its ZB table: the imported folder's,
   * or the online index's (fetched only when one is programmed).
   * @param {KfpModule} mod - The family.
   * @returns {Promise<Map<string, object>|null>}
   */
  async function familyFiles(mod) {
    if (state.tables[mod.id]) return state.tables[mod.id].files;
    if (state.source !== 'hf') return null;
    const idx = await wkfpSpdIndex();
    const byChassis = idx && idx.modules[mod.folder];
    const chassis = byChassis && Object.keys(byChassis).sort()[0];
    if (!chassis) return null;
    const entry = byChassis[chassis];
    return new Map(
      Object.entries(entry.files).map(([name, size]) => [
        name,
        wkfpRemoteFile(entry.path + name, name, size),
      ])
    );
  }

  /**
   * Data file / Program file / NAAB file: a family, then one of its files.
   * @param {'data'|'program'|'naab'} kind
   */
  async function expFile(kind) {
    const ext = { data: /\.0DA$/i, program: /\.0PA$/i, naab: /\.0BA$/i }[kind];
    const title = {
      data: 'Data file:',
      program: 'Program file:',
      naab: 'NAAB file:',
    }[kind];
    const fams = await families();
    if (!fams.length) return;
    const body = document.createElement('div');
    body.className = 'wkfp-choose wkfp-choose-file';
    body.innerHTML = `
      <label>ECU familiy:<select size="14" id="wkfp-f-fam"></select></label>
      <label>${esc(title)}<select size="14" id="wkfp-f-file"></select></label>`;
    const fam = body.querySelector('#wkfp-f-fam');
    const file = body.querySelector('#wkfp-f-file');
    fam.innerHTML = fams
      .map((m) => `<option value="${m.id}">${esc(m.folder)}</option>`)
      .join('');
    let map = null;
    const fill = async () => {
      file.innerHTML = '';
      map = await familyFiles(fams.find((m) => m.id === fam.value));
      const names = map
        ? [...map.keys()].filter((n) => ext.test(n)).sort()
        : [];
      file.innerHTML = names.length
        ? names.map((n) => `<option>${esc(n)}</option>`).join('')
        : '<option disabled>No file found</option>';
    };
    fam.onchange = fill;
    const cur = state.exp[kind];
    const start =
      (cur && cur.mod) ||
      fams.find((m) => state.exp.pabd && m.folder === state.exp.pabd.folder) ||
      fams[0];
    fam.value = start.id;
    await fill();
    if (cur && cur.mod.id === fam.value) file.value = cur.name;
    const b = await wkfpDialog(wkfpLive.win, {
      title: 'Choose',
      body,
      buttons: ['OK', 'Cancel'],
      check: (btn) => btn !== 'OK' || !!file.value,
    });
    if (b !== 'OK') return;
    state.exp[kind] = {
      mod: fams.find((m) => m.id === fam.value),
      name: file.value,
      file: map.get(file.value),
    };
    paint();
  }

  /**
   * The record for an expert-mode programming: WinKFP writes it there only
   * with "UIF write in expert mode", and it needs the ZB the files belong to.
   * @returns {Promise<KfpAif|null|false>} null for none, false to stop.
   */
  async function expAif() {
    if (!state.ini.EXPERT_MIT_AIF) return null;
    if (!state.vin && !(await enterVin())) return false;
    const pick = state.exp.data || state.exp.program;
    if (!(await ensureTable(pick.mod))) return false;
    const row = state.tables[pick.mod.id].rows.find(
      (r) => r.data === pick.name || r.program === pick.name
    );
    if (!row) {
      await wkfpMessage(
        wkfpLive.win,
        'error',
        `${pick.name} belongs to no ZB number in ${pick.mod.table}, so the record has none to name. Turn off "UIF write in expert mode" to program it without one.`
      );
      return false;
    }
    return {
      vin: state.vin,
      zb: row.zb,
      sw: row.sw,
      changeIndex: row.swIndex,
      approval: row.typ,
    };
  }

  /** Prog. Data / Prog. Program / Program. */
  async function expProgram(only) {
    const e = state.exp;
    const files = {};
    if (e.program && only !== 'data')
      files.program = { name: e.program.name, file: e.program.file };
    if (e.data && only !== 'program')
      files.data = { name: e.data.name, file: e.data.file };
    const aif = await expAif();
    if (aif === false) return;
    const mod = expModule();
    await runProgramming({
      mod,
      what: `the ${only || 'program and data'} into the ECU at address ${mod.address}`,
      files,
      only,
      expert: true,
      // with a program file chosen, the script may ask for it
      programIsNew: !!files.program,
      aif,
      okText:
        only === 'data'
          ? 'Data programming OK'
          : only === 'program'
            ? 'Program programming OK'
            : 'Programming OK',
    });
  }

  /** Just the bar and the title, so a flash does not repaint the window per block. */
  function paintProgress() {
    wkfpBadge();
    $('wkfp-title').textContent = `WebKFP (${state.pct}%)`;
    $('wkfp-bar').hidden = false;
    $('wkfp-fill').style.width = `${state.pct}%`;
    $('wkfp-pct').textContent = `${state.pct}%`;
  }

  /**
   * WinKFP's Error box: its own error, then the COAPI error entries -- the
   * script's (PABD), then where WinKFP stopped (Error).
   * @param {{step: string, info: string, errors: KfpError[]}} r
   */
  async function showError(r) {
    const texts = await wkfpCoapi().catch(() => ({}));
    const text = (code) => texts[String(code)] || `COAPI error ${code}`;
    const rows = r.errors.map((e) => ({
      code: e.code,
      level: 'PABD',
      text: `${text(e.code)}  ${e.file}, ${e.info}`,
      where: `${e.proc}:${e.line}`,
    }));
    const last = r.errors.length ? r.errors[r.errors.length - 1].code : 0;
    if (last) {
      rows.push({
        code: last,
        level: 'Error',
        text: `${text(last)}  ${r.step}`,
        where: '',
      });
      rows.push({ code: last, level: 'Error', text: text(last), where: '' });
    } else {
      rows.push({
        code: '',
        level: 'Error',
        text: `${r.step}: ${r.info}`,
        where: '',
      });
    }
    const body = document.createElement('div');
    body.className = 'wkfp-err';
    body.innerHTML = `
      <div class="wkfp-err-head">Error ${WKFP_ERR_FLASH.code}:<br><br>${esc(WKFP_ERR_FLASH.text)}</div>
      <div>COAPI error entries:</div>
      <div class="wkfp-list"><table>
        <thead><tr><th>Code</th><th>Level</th><th class="wkfp-ext">Procedure</th><th>Text</th></tr></thead>
        <tbody>${rows
          .map(
            (x) =>
              `<tr><td>${esc(String(x.code))}</td><td>${esc(x.level)}</td><td class="wkfp-ext">${esc(x.where)}</td><td>${esc(x.text)}</td></tr>`
          )
          .join('')}</tbody></table></div>
      <div class="wkfp-views">
        <label><input type="radio" name="wkfp-view" value="n" checked> Normal view</label>
        <label><input type="radio" name="wkfp-view" value="x"> Extended view</label>
      </div>`;
    const list = body.querySelector('.wkfp-list');
    body
      .querySelectorAll('input[name="wkfp-view"]')
      .forEach(
        (i) =>
          (i.onchange = () =>
            list.classList.toggle(
              'wkfp-extended',
              i.value === 'x' && i.checked
            ))
      );
    await wkfpDialog(wkfpLive.win, {
      title: 'Error',
      cls: 'wkfp-err-dlg',
      body,
      buttons: ['OK'],
    });
  }

  // ---- Diagnosis mode ------------------------------------------------------------------
  // WinKFP's F5: ECU Status, ECU Ident, ECU intern. Temp. Each runs the
  // programming script's own read jobs and shows what it wrote (REF.OUT,
  // IDENT.OUT, INNENTMP.OUT), labelled as winkfpt.eng labels it.

  const DIAG_RULE = '--------------------------------------';

  /** @returns {KfpModule|null} The module Diagnosis talks to: the expert's, or the chosen family's. */
  function diagModule() {
    if (state.exp) return expReady() ? expModule() : null;
    return state.mod;
  }

  /**
   * Run the script's read jobs, in order, as on an EDIC.
   * @param {KfpModule} mod - The module.
   * @param {Array<string|[string, object]>} jobs - The script's jobs (its
   *   cabimain JOBNAMEs), each alone or with its parameters.
   * @returns {Promise<Array<object|null>>} Each job's result; null for one
   *   the script does not have.
   */
  async function diagJobs(mod, jobs) {
    const exec = await wkfpScript(mod);
    const base = jobBase(mod);
    // the jobs the script's dispatcher (cabimain) names: one it does not
    // know only fails, so it is not run
    const known = new Set(
      ((exec.procs && exec.procs.cabimain) || [])
        .map((t) => t && t.v)
        .filter((v) => typeof v === 'string')
    );
    const out = [];
    for (const entry of jobs) {
      const [job, params] = Array.isArray(entry) ? entry : [entry, null];
      if (!known.has(job)) {
        out.push(null);
        continue;
      }
      setStatus(`${job}...`);
      const r = await kfp.runJob(exec, job, {
        ...base,
        params: params || (job === 'SG_STATUS_LESEN' ? { HWNR_IS_NEW: 0 } : {}),
      });
      out.push(r.unsupported ? null : r);
    }
    return out;
  }

  /** "label: value" for each result the job set, skipping the ones it did not. */
  function diagLines(params, fields) {
    const lines = [];
    for (const f of fields) {
      if (f === '') {
        if (lines.length && lines[lines.length - 1] !== '') lines.push('');
        continue;
      }
      const [label, names, fmt] = f;
      const name = names.find(
        (n) => params[n] !== undefined && params[n] !== ''
      );
      if (!name) continue;
      const v = params[name];
      lines.push(`${label}: ${fmt ? fmt(v) : String(v).trim()}`);
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  const hex = (n) => (v) =>
    Number(v).toString(16).toUpperCase().padStart(n, '0');

  /** Show what a Diagnosis key read, the way WinKFP shows its .OUT file. */
  function diagShow(text) {
    const pre = document.createElement('pre');
    pre.className = 'wkfp-logview';
    pre.textContent = text;
    return wkfpDialog(wkfpLive.win, {
      title: 'Show file content',
      cls: 'wkfp-log-dlg',
      body: pre,
      buttons: ['OK'],
    });
  }

  /**
   * Run a Diagnosis or Special key: the jobs, then the text, or WinKFP's
   * errors.
   * @param {string[]|((mod: KfpModule) => Promise<Array<object|null>>)} jobs -
   *   The script's jobs, or a run of them that decides as it reads (each
   *   result carrying its `job`).
   * @param {(results: Array<object|null>) => string|null} render - The
   *   text, or null when none of the jobs is the script's.
   */
  async function diagRun(jobs, render) {
    const mod = diagModule();
    if (!mod || state.running) return;
    state.running = true;
    paint();
    let text = null;
    let fail = null;
    try {
      const results =
        typeof jobs === 'function'
          ? await jobs(mod)
          : await diagJobs(mod, jobs);
      const failed = results.find((r) => r && !r.ok);
      if (failed && results.every((r) => !r || !r.ok))
        fail = {
          step:
            typeof jobs === 'function'
              ? failed.job
              : jobs[results.indexOf(failed)],
          ...failed,
        };
      else text = render(results);
    } catch (e) {
      fail = {
        step: 'WebKFP',
        info: (e && e.message) || String(e),
        errors: [],
      };
    }
    state.running = false;
    setStatus('');
    paint();
    if (fail) return showError(fail);
    if (text == null)
      return wkfpMessage(
        wkfpLive.win,
        'info',
        'The function is not implemented at the moment!'
      );
    return diagShow(text);
  }

  /** ECU Status: the references, the ZIF and its backup, the status byte (REF.OUT). */
  function diagStatus() {
    const blocks = [
      ['Entries of data reference', 'DATEN_REF'],
      ['Entries of HW reference', 'HW_REF'],
      ['Entries of ZIF', 'ZIF'],
      ['Entries of ZIF-Backup', 'ZIF_BACKUP'],
    ];
    return diagRun(
      ['DATEN_REFERENZ', 'HW_REFERENZ', 'ZIF', 'ZIF_BACKUP', 'SG_STATUS_LESEN'],
      (rs) => {
        if (rs.every((r) => !r)) return null;
        const out = [];
        blocks.forEach(([title, p], i) => {
          const r = rs[i];
          if (!r || !r.ok) return;
          out.push(
            `${title}:`,
            DIAG_RULE,
            ...diagLines(r.params, [
              ['ECU identifier', [`${p}_SG_KENNUNG`]],
              ['Project', [`${p}_PROJEKT`]],
              ['Program version', [`${p}_PROGRAMM_STAND`]],
              ['Data version', [`${p}_DATENSATZ`]],
              ['BMW hardware number', [`${p}_BMW_HW`]],
              ['BMW program version', [`${p}_BMW_PST`]],
              ['Status', [`${p}_STATUS`], hex(2)],
            ]),
            DIAG_RULE,
            ''
          );
        });
        const st = rs[4];
        if (st && st.ok && st.params.SG_STATUS !== undefined)
          out.push(`ECU-Status: ${hex(2)(st.params.SG_STATUS)}`, DIAG_RULE);
        return out.join('\n');
      }
    );
  }

  /** ECU Ident: the identification, then the physical hardware number (IDENT.OUT). */
  function diagIdent() {
    return diagRun(['SG_IDENT_LESEN', 'SG_PHYS_HWNR_LESEN'], ([id, phys]) => {
      if (!id && !phys) return null;
      const out = ['Entries of ECU identification:', DIAG_RULE];
      if (id && id.ok) {
        const p = { ...id.params };
        // the KWP scripts give the date; the DS2 ones give its parts
        if (p.ID_DATUM === undefined && p.ID_DATUM_TAG !== undefined)
          p.ID_DATUM = `${p.ID_DATUM_TAG}.${p.ID_DATUM_MONAT}.${p.ID_DATUM_JAHR}`;
        if (p.ID_DATUM === undefined && p.ID_DATUM_KW !== undefined)
          p.ID_DATUM_WOCHE = `week ${p.ID_DATUM_KW}, ${p.ID_DATUM_JAHR}`;
        out.push(
          ...diagLines(p, [
            ['BMW part number', ['ID_BMW_NR']],
            ['BMW hardware number', ['ID_HW_NR']],
            '',
            ['Coding index', ['ID_COD_INDEX', 'ID_CODE_IND']],
            ['Diagnosis index', ['ID_DIAG_INDEX', 'ID_DIAG_IND']],
            ['Variant index', ['ID_VAR_INDEX']],
            ['Bus index', ['ID_BUS_INDEX']],
            '',
            ['Manufacturing date (DD.MM.YYYY)', ['ID_DATUM']],
            ['Manufacturing date', ['ID_DATUM_WOCHE']],
            '',
            ['Supplier number', ['ID_LIEF_NR']],
            ['Supplier', ['ID_LIEF_TEXT']],
            '',
            ['Software number', ['ID_SW_NR']],
            ['Software number (message catalogue version)', ['ID_SW_NR_MCV']],
            ['Software number (functional software version)', ['ID_SW_NR_FSV']],
            ['Software number (operating system version)', ['ID_SW_NR_OSV']],
            ['Software number (reserved - currently unused)', ['ID_SW_NR_RES']],
          ]),
          DIAG_RULE
        );
      }
      if (phys && phys.ok)
        out.push(
          '',
          ...diagLines(phys.params, [
            ['Physical Hardware number', ['PHYSIKALISCHE_HW_NR']],
          ]),
          DIAG_RULE
        );
      return out.join('\n');
    });
  }

  /** ECU intern. Temp. (INNENTMP.OUT). */
  function diagTemp() {
    return diagRun(['SG_INNENTEMP_LESEN'], ([t]) => {
      if (!t) return null;
      const unit = String(t.params.SG_INNENTEMP_EINH || '').trim();
      return [
        'Entries of ECU internal temperature:',
        DIAG_RULE,
        ...diagLines(t.params, [
          [
            'internal ECU temperature',
            ['SG_INNENTEMP'],
            (v) =>
              `${v} ${!unit || /^(°?C|degC|Grad C)$/i.test(unit) ? 'degrees C' : unit}`,
          ],
        ]),
      ].join('\n');
    });
  }

  // ---- Special mode --------------------------------------------------------------------
  // WinKFP's F4: the user info field, the baudrates and VS20/DS2 mode, each
  // one of the programming script's own jobs (AIF.OUT, BDR.OUT). A script
  // without the job answers as WinKFP does. EWS adjustment is WinKFP's own
  // "not implemented" box and nothing more; adjustment values and HD
  // download go through BMW's programming library, which WebKFP lacks.

  /** WinKFP's answer for a function the script (or WebKFP) does not have. */
  function notImplemented() {
    return wkfpMessage(
      wkfpLive.win,
      'info',
      'The function is not implemented at the moment!'
    );
  }

  /**
   * Read numbered records, 1 up, until the script refuses one or `more`
   * says there are no others.
   * @param {KfpModule} mod - The module.
   * @param {string} job - The script's job.
   * @param {string} arg - The record-number parameter.
   * @param {(r: object) => boolean} more - Whether to read the next one.
   * @returns {Promise<Array<object|null>>} The records read (a refusal of
   *   the first included, so it is reported); [null] when the script has
   *   no such job.
   */
  async function specialRecords(mod, job, arg, more) {
    const out = [];
    for (let n = 1; n <= 16; n++) {
      const [r] = await diagJobs(mod, [[job, { [arg]: String(n) }]]);
      if (!r) return out.length ? out : [null];
      if (!r.ok) {
        if (!out.length) out.push({ ...r, job });
        break;
      }
      out.push({ ...r, job });
      if (!more(r)) break;
    }
    return out;
  }

  /** Read UIF: every entry of the user info field (AIF.OUT). */
  function specialAif() {
    return diagRun(
      (mod) =>
        specialRecords(mod, 'SG_AIF_LESEN', 'AIF_NUMMER', (r) => {
          const free = Number(r.params.AIF_ANZ_FREI);
          return Number.isFinite(free) && free !== 0;
        }),
      (records) => {
        if (!records[0]) return null;
        const out = ['Entries of user info field:', '', DIAG_RULE];
        records.forEach((r, i) => {
          out.push(
            ` Entry ${i + 1}:`,
            '',
            ...diagLines(r.params, [
              ['VIN', ['AIF_FG_NR']],
              ['Date', ['AIF_DATUM']],
              ['Change index', ['AIF_AENDERUNGS_INDEX']],
              ['Software number', ['AIF_SW_NR']],
              ['Authority number', ['AIF_BEHOERDEN_NR']],
              ['Assembly number', ['AIF_ZB_NR']],
              ['Serial number', ['AIF_SERIEN_NR']],
              ['Programming number', ['AIF_PROG_NR']],
              ['Mileage', ['AIF_KM']],
              ['Dealer number', ['AIF_HAENDLER_NR']],
            ]),
            '',
            DIAG_RULE
          );
        });
        const free = records[records.length - 1].params.AIF_ANZ_FREI;
        if (free !== undefined && free !== '')
          out.push(`Free entries: ${free}`);
        return out.join('\n');
      }
    );
  }

  /** ECU baudrates: each baudrate the module can talk at (BDR.OUT). */
  function specialBaud() {
    return diagRun(
      (mod) =>
        specialRecords(
          mod,
          'BAUDRATE_LESEN',
          'BAUDRATE_NUMMER',
          (r) => String(r.params.BAUDRATE ?? '').trim() !== ''
        ),
      (records) => {
        if (!records[0]) return null;
        const out = ['Possible baudrates of the ECU:', DIAG_RULE];
        records.forEach((r, i) => {
          const bd = String(r.params.BAUDRATE ?? '').trim();
          if (bd) out.push(`Baudrate ${i + 1}: ${bd} Bd`, DIAG_RULE);
        });
        return out.join('\n');
      }
    );
  }

  /**
   * Run one of the script's writing jobs after asking, and say how it went.
   * @param {string} job - The script's job.
   * @param {string} question - What is asked first.
   * @param {string} done - What is said when it worked.
   */
  async function specialWrite(job, question, done) {
    const mod = diagModule();
    if (!mod || state.running) return;
    if (typeof webOnSharedCar === 'function' && webOnSharedCar())
      return wkfpMessage(
        wkfpLive.win,
        'error',
        "WebKFP writes over this computer's own cable only, not over a shared car."
      );
    const go = await wkfpMessage(wkfpLive.win, 'question', question, [
      'Yes',
      'No',
    ]);
    if (go !== 'Yes') return;
    state.running = true;
    paint();
    let r = null;
    let fail = null;
    try {
      [r] = await diagJobs(mod, [job]);
      if (r && !r.ok) fail = { step: job, ...r };
    } catch (e) {
      fail = {
        step: 'WebKFP',
        info: (e && e.message) || String(e),
        errors: [],
      };
    }
    state.running = false;
    setStatus('');
    paint();
    if (fail) return showError(fail);
    if (!r) return notImplemented();
    return wkfpMessage(wkfpLive.win, 'info', done);
  }

  /**
   * VS20 mode / DS2 mode: switch the module's diagnosis protocol.
   * @param {string} job - VS20_MODE or D2_MODE.
   * @param {string} name - The mode, as the keys say it.
   */
  function specialMode(job, name) {
    return specialWrite(
      job,
      `Switch the ECU to ${name} mode?`,
      `ECU switched to ${name} mode.`
    );
  }

  // ---- the menus' other dialogs ----------------------------------------------------
  /** Display > ERROR.LOG: every step and job of the last programming. */
  function showLog() {
    const pre = document.createElement('pre');
    pre.className = 'wkfp-logview';
    pre.textContent = state.log.length ? state.log.join('\n') : '(empty)';
    wkfpDialog(wkfpLive.win, {
      title: 'ERROR.LOG',
      cls: 'wkfp-log-dlg',
      body: pre,
      buttons: ['OK'],
    });
  }

  /** Configuration > Ini Options, laid out as WinKFP's. */
  /**
   * Configuration > Clear fields: no ZB, no VIN, no expert setup, back to
   * the main window -- and the cleared choice is what a reload brings back.
   * The Ini Options, ERROR.LOG and the SP-Daten already read stay.
   */
  function clearFields() {
    if (state.running) return;
    state.mod = null;
    state.row = null;
    state.vin = '';
    state.exp = null;
    state.mode = 'main';
    setStage('');
    setStatus('');
    paint();
  }

  async function iniOptions() {
    const ini = state.ini;
    const cb = (key, label, off) =>
      `<label class="wkfp-cb${off ? ' wkfp-off' : ''}"><input type="checkbox" data-k="${key}"${ini[key] ? ' checked' : ''}${off ? ' disabled' : ''}> ${label}</label>`;
    const dir = (label, value) =>
      `<div class="wkfp-dir">${esc(label)}<div><input class="wkfp-input" value="${esc(value)}" disabled><button class="wkfp-btn" disabled>...</button></div></div>`;
    const body = document.createElement('div');
    body.className = 'wkfp-ini';
    body.innerHTML = `
      <div class="wkfp-group wkfp-lang">Sprache / Language <select class="wkfp-input"><option>English</option></select></div>
      <div class="wkfp-ini-cols">
        <div class="wkfp-group">
          ${cb('U_PROG', 'Programming voltage', true)}
          ${cb('ANZEIGE_U_PROG', 'Show programming voltage', true)}
          ${cb('SCHNELLE_BAUDRATE', 'Fast baudrate')}
          ${cb('TEST_CHECKSUMME', 'Test Checksum')}
          <div class="wkfp-gap"></div>
          ${cb('PROGRAMM_ERZWINGEN', 'Force program programming in comfort mode')}
          <div class="wkfp-gap"></div>
          ${cb('BSU_ZULASSEN', 'activate Bootsectorupdate', true)}
          <div class="wkfp-gap"></div>
          ${cb('UBATT_PRUEFEN', 'Check battery / ignition (KL15) from the cable')}
        </div>
        <div class="wkfp-group">
          ${cb('AIF_SCHREIBEN_NACH_DATEN', 'UIF write after data')}
          ${cb('AIF_SCHREIBEN_NACH_PROGRAMM', 'UIF write after program')}
          ${cb('EXPERT_MIT_AIF', 'UIF write in expert mode')}
          ${cb('KOMFORT_MIT_AIF', 'UIF write in comfort mode')}
        </div>
      </div>
      <div class="wkfp-group wkfp-levels">
        <label>PABD format<select class="wkfp-input" disabled><option>IPO</option></select></label>
        <label>API tracelevel<select class="wkfp-input" disabled><option>1</option></select></label>
        <label>IFH tracelevel<select class="wkfp-input" disabled><option>1</option></select></label>
      </div>
      <div class="wkfp-group">
        ${dir('Directory for error file "error.log"', '(this browser)')}
        ${dir('Base directory for working directories of WinKFPT', state.source === 'hf' ? 'Hugging Face: bmw-files/sp-daten' : state.folderName)}
      </div>`;
    const b = await wkfpDialog(wkfpLive.win, {
      title: 'Ini Options',
      cls: 'wkfp-ini-dlg',
      body,
      buttons: ['OK', 'Cancel'],
    });
    if (b !== 'OK') return;
    body.querySelectorAll('input[data-k]:not([disabled])').forEach((i) => {
      ini[i.dataset.k] = i.checked;
    });
    wkfpSaveIni(ini);
    paint();
  }

  function showInterface() {
    const gw = new URLSearchParams(location.search).get('gateway');
    wkfpMessage(
      wkfpLive.win,
      'info',
      `HW interface: STD:OBD\n\n${gw ? `Gateway: ${gw}` : "This computer's own cable."}`
    );
  }
  async function showProtocol() {
    const mods = state.mod ? [state.mod] : await wkfpFamilies();
    wkfpMessage(
      wkfpLive.win,
      'info',
      mods
        .map(
          (m) =>
            `${m.folder}: address ${m.address}${m.protocol ? `, ${m.protocol}` : ''}`
        )
        .join('\n')
    );
  }

  /**
   * Bring back what was chosen on an earlier visit (wkfpSaveChoice): the
   * ZB's table and the expert's files come from the online SP-Daten (the
   * cache, mostly); an imported folder has to be imported again.
   * @returns {Promise<void>}
   */
  async function restoreChoice() {
    const c = wkfpLoadChoice();
    if (!c) return;
    state.vin = c.vin || '';
    if (c.source === 'local') {
      state.folderName = c.folderName || '';
      setStatus(
        `Import ${state.folderName || 'the SP-Daten folder'} again to continue where you left off`
      );
      return;
    }
    const fams = await wkfpFamilies();
    const fam = (id) => fams.find((m) => m.id === id) || null;
    setStatus('Restoring the last selection...');
    try {
      if (c.exp) {
        const file = async (x) => {
          const mod = x && fam(x.mod);
          const map = mod && (await familyFiles(mod));
          return map && map.has(x.name)
            ? { mod, name: x.name, file: map.get(x.name) }
            : null;
        };
        state.exp = {
          pabd: fam(c.exp.pabd),
          sgbd: c.exp.sgbd || '',
          address: c.exp.address || '',
          data: await file(c.exp.data),
          program: await file(c.exp.program),
          naab: await file(c.exp.naab),
        };
      } else if (c.mod && fam(c.mod)) {
        const mod = fam(c.mod);
        state.mod = mod;
        if (c.zb && (await ensureTable(mod)))
          state.row =
            state.tables[mod.id].rows.find((r) => r.zb === c.zb) || null;
      }
    } finally {
      setStatus('');
    }
  }

  paint();
  if (wkfpLive.pending) {
    const answer = wkfpLive.pending;
    wkfpLive.pending = null;
    answer();
  }
  // once a page: what an earlier visit chose
  if (!wkfpLive.restored) {
    wkfpLive.restored = 'restoring';
    const done = () => {
      wkfpLive.restored = true;
      paint();
    };
    restoreChoice().then(done, done);
  }
  // the list only: what is online, so Choose ZUSB opens without a wait
  wkfpSpdIndex();
}
