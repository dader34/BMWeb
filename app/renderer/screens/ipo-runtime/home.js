/**
 * @file BMWeb's home as an INPA script: the app's front door for any host
 * that runs .IPO (the terminal UI first), written in INPA's own language and
 * compiled by the app's own compiler. Pick a chassis, pick a module, and
 * `scriptchange` hands the screen to that module's script, the way INPA's
 * vehicle selection does.
 *
 * INPA's own start script (STARTUS.IPO) draws the info screen and reads the
 * battery and ignition lamps, but the vehicle list itself lives in INPA.INI
 * and the CFGDAT menus, read by INPA's program rather than by a script. Our
 * script gets that list from the host through one builtin of the app's own,
 * `bmweb_pick`, declared in home/bmweb.h beside the INPA builtins it uses.
 *
 * The source lives in app/renderer/home/ (the .ips and .h are the files a
 * person reads and the CLI ships); the copies below are what the app
 * compiles, and a test pins the two as identical.
 */

/* exported IPO_HOME_SGBD, IPO_HOME_HOST, ipoHomeSource, ipoHomeExec,
   ipoPickHome, ipoHomeEcuFor, showIpoHome */

/** The SGBD name the home is seeded under: no BMW file has it. */
const IPO_HOME_SGBD = 'bmweb_home';

/** home/bmweb.h, verbatim. */
const IPO_HOME_H = `// BMWeb's own include for scripts of its own: the INPA builtins those
// scripts call, declared the way inpa.h declares them (parameter modes are
// what the compiler needs to pass out-parameters by reference), plus the
// two builtins BMWeb adds so a script can ask the app for a pick.
//
// Written by the BMWeb project. Nothing here is copied from BMW's headers.

// INPA builtins used by the home script
extern setmenutitle( in: string title);
extern settitle( in: string title);
extern setmenu( in: menu name);
extern setscreen( in: screen name, in: bool flag);
extern scriptchange( in: string NewScriptFile);
extern printscreen();
extern exit();
extern messagebox( in: string Title, in: string Text);
extern ftextout( in: string text, in: int row, in: int col, in: int attr, in: int mode);

// BMWeb builtins (0xE0 and up; unused by INPA)
//   bmweb_pick("chassis", "", chassis)     the app lists its chassis, the user picks one
//   bmweb_pick("module", chassis, sgbd)    the modules of that chassis, picked one's SGBD
//   bmweb_pick("vehicle", chassis, sgbd)   the chassis's whole-vehicle script, "" if none
//   A cancelled pick leaves the out-string empty.
extern bmweb_pick( in: string what, in: string arg, out: string choice);
//   bmweb_status(text)   one line from the app: cable state, version
extern bmweb_status( out: string text);
`;

/** home/bmweb-home.ips, verbatim. */
const IPO_HOME_IPS = `//**********************************************************************
//*
//* BMWeb home: the app's front door as an INPA script, so a terminal (or
//* any host that runs .IPO) starts where the app starts. Pick a chassis,
//* pick a module, and scriptchange hands the screen to that module's own
//* INPA script, exactly as INPA's vehicle selection does.
//*
//* Written by the BMWeb project.
//*
//**********************************************************************
#include "bmweb.h"

string chassis = "";
string module  = "";
string status  = "";

inpainit()
{
  settitle("BMWeb");
  setscreen(s_main, TRUE);
  setmenu(m_main);
}

MENU m_main()
{
  INIT {
    setmenutitle("BMWeb");
  }
  ITEM( 1 ,"Vehicle")  {
    bmweb_pick("chassis", "", chassis);
    if (chassis != "")
    {
      bmweb_pick("module", chassis, module);
      if (module != "")
      {
        scriptchange(module);
      }
    }
  }
  ITEM( 2 ,"Error scan")  {
    bmweb_pick("chassis", "", chassis);
    if (chassis != "")
    {
      bmweb_pick("vehicle", chassis, module);
      if (module != "")
      {
        scriptchange(module);
      }
      else
      {
        messagebox("Error scan", "INPA ships no whole-vehicle script for this chassis.");
      }
    }
  }
  ITEM( 9 ,"Print")  {
    printscreen();
  }
  ITEM( 20 ,"Exit")  {
    exit();
  }
}

SCREEN s_main()
{
  bmweb_status(status);
  ftextout("BMWeb", 1, 0, 1, 0);
  ftextout("", 3, 0, 0, 0);
  LINE("","")
  {
    ftextout("< F1 >  Vehicle: pick a chassis, then a module", 4, 5, 0, 1);
    ftextout("< F2 >  Error scan: INPA's whole-vehicle script", 6, 5, 0, 1);
    ftextout("< F9 >  Print", 20, 5, 0, 1);
    ftextout("<Shift> + < F10>  Exit", 22, 45, 0, 1);
    ftextout(status, 12, 5, 0, 1);
  }
}
`;

/**
 * The home script's source and include, as compiled.
 * @returns {{ips: string, h: string}}
 */
function ipoHomeSource() {
  return { ips: IPO_HOME_IPS, h: IPO_HOME_H };
}

/** @type {object|null} The compiled home, once. */
let _ipoHomeExec = null;

/**
 * Compile the home script (once) and seed it under IPO_HOME_SGBD so the
 * runtime opens it like any shipped module.
 * @returns {object} the exec
 */
function ipoHomeExec() {
  if (_ipoHomeExec) return _ipoHomeExec;
  const src = ipoHomeSource();
  const r = ipofCompileSource(src.ips, { files: { 'bmweb.h': src.h } });
  if (!r.ok || !r.exec) {
    const why = (r.errors || []).map((e) => e.message).join('; ');
    throw new Error(`the home script did not compile: ${why}`);
  }
  _ipoHomeExec = r.exec;
  if (typeof irSeedExec === 'function') irSeedExec(IPO_HOME_SGBD, r.exec);
  return r.exec;
}

/**
 * What the host offers the home script's picks. The browser's default reads
 * the app's own chassis tree; a terminal host replaces it with its own.
 * @typedef {object} IpoHomeHost
 * @property {() => Promise<Array<{value: string, label: string, meta?: string}>>} chassis - every chassis, by id
 * @property {(chassis: string) => Promise<Array<{value: string, label: string, meta?: string}>>} modules - the modules of one chassis; value is the SGBD
 * @property {(chassis: string) => Promise<string>} vehicle - the whole-vehicle script's SGBD stem, '' when none ships
 * @property {() => string} status - one line for the home screen
 */

/** @type {IpoHomeHost} */
const IPO_HOME_HOST = {
  chassis: async () => {
    const ids = await api('/api/chassis');
    return (ids || []).map((id) => ({
      value: id,
      label: typeof dispChassis === 'function' ? dispChassis(id) : id,
      meta: (typeof CHASSIS_TAG !== 'undefined' && CHASSIS_TAG[id]) || '',
    }));
  },
  modules: async (chassis) => {
    const ch = await api(`/api/chassis/${encodeURIComponent(chassis)}`);
    const out = [];
    for (const sec of (ch && ch.sections) || [])
      for (const ecu of sec.ecus || [])
        if (ecu && ecu.sgbd)
          out.push({
            value: String(ecu.sgbd).toLowerCase(),
            label: ecu.label || ecu.code || ecu.sgbd,
            meta: `${sec.name || ''} · ${ecu.sgbd}`,
          });
    return out;
  },
  vehicle: async (chassis) =>
    typeof vehicleScriptShipped === 'function' &&
    (await vehicleScriptShipped(chassis))
      ? String(chassis).toLowerCase()
      : '',
  status: () => {
    const cable =
      typeof webBus !== 'undefined' && webBus && webBus.connected
        ? 'cable connected'
        : 'no cable';
    const ver =
      typeof APP_VERSION !== 'undefined' ? `BMWeb ${APP_VERSION}` : 'BMWeb';
    return `${ver} · ${cable}`;
  },
};

/**
 * The picker for a bmweb_pick suspension: the host's list for `step.what`
 * in a dialog with a filter box; resolves to the chosen value, or null on
 * cancel. A "vehicle" pick has one answer and needs no dialog.
 * @param {object} p - the program
 * @param {{what: string, arg: string}} step - the pick suspension
 * @returns {Promise<string|null>}
 */
async function ipoPickHome(p, step) {
  const host = IPO_HOME_HOST;
  if (step.what === 'vehicle') return host.vehicle(step.arg);
  let options = [];
  try {
    options =
      step.what === 'module'
        ? await host.modules(step.arg)
        : await host.chassis();
  } catch (e) {
    options = [];
  }
  const title = step.what === 'module' ? `Modules of ${step.arg}` : 'Vehicles';
  return new Promise((resolve) => {
    const rows = (list) =>
      list
        .map(
          (o, i) =>
            `<label class="ipo-pick-row" data-i="${i}"><input type="radio" name="ipo-home" value="${i}"/> ` +
            `<span>${esc(o.label)}${o.meta ? ` <span class="ipo-pick-n">${esc(o.meta)}</span>` : ''}</span></label>`
        )
        .join('');
    const { overlay, close } = openModal(
      `<div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${esc(title)}</div>
        <div class="modal-body ipo-pick">
          <input class="modal-input ipo-home-filter" type="text" placeholder="Filter…" spellcheck="false" autocomplete="off"/>
          <div class="ipo-home-rows">${rows(options)}</div>
        </div>
        <div class="modal-actions">
          <button class="btn" data-x="cancel">Cancel</button>
          <button class="btn primary" data-x="ok">Open</button>
        </div></div>`,
      { onClose: () => resolve(null) }
    );
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      close();
    };
    const filter = overlay.querySelector('.ipo-home-filter');
    const rowsEl = overlay.querySelector('.ipo-home-rows');
    filter.oninput = () => {
      const q = filter.value.trim().toLowerCase();
      rowsEl.querySelectorAll('.ipo-pick-row').forEach((row) => {
        const o = options[Number(row.dataset.i)];
        row.hidden =
          !!q &&
          !`${o.label} ${o.meta || ''} ${o.value}`.toLowerCase().includes(q);
      });
    };
    rowsEl.ondblclick = (ev) => {
      const row = ev.target.closest('.ipo-pick-row');
      if (row) done(options[Number(row.dataset.i)].value);
    };
    overlay.querySelectorAll('[data-x]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.x === 'cancel') return done(null);
        const picked = overlay.querySelector('input[name="ipo-home"]:checked');
        if (picked) done(options[Number(picked.value)].value);
      };
    });
    setTimeout(() => filter.focus(), 10);
  });
}

/**
 * The module record a home pick names, for the runtime's scriptchange: the
 * car's own row from the chassis config (so the module identifies itself on
 * entry the way opening it from the module list does), or the whole-vehicle
 * script's synthetic record.
 * @param {object} from - the home program's ecu (its chassis is the pick)
 * @param {string} script - the SGBD the script named
 * @returns {Promise<object|null>}
 */
async function ipoHomeEcuFor(from, script) {
  const chassis = from && from.chassis ? String(from.chassis) : '';
  const want = String(script || '').toLowerCase();
  if (!chassis || !want) return null;
  if (want === chassis.toLowerCase()) {
    return {
      code: chassis,
      sgbd: want,
      label: `INPA ${typeof dispChassis === 'function' ? dispChassis(chassis) : chassis} script`,
      group: null,
      kind: 'vehicle',
      chassis,
    };
  }
  const ch = await api(`/api/chassis/${encodeURIComponent(chassis)}`);
  for (const sec of (ch && ch.sections) || [])
    for (const ecu of sec.ecus || [])
      if (ecu && String(ecu.sgbd || '').toLowerCase() === want)
        return Object.assign({}, ecu, { chassis, section: sec.name || '' });
  return null;
}

/**
 * The home script as a screen of the app (#inpa): the same runtime and the
 * same picker a terminal host uses, so the script is exercised where it can
 * be seen.
 * @returns {Promise<void>}
 */
async function showIpoHome() {
  lastScreen = showIpoHome;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'INPA home' }]);
  sbLeft.textContent = 'bmweb home';
  view.innerHTML = head('INPA', 'BMWeb', 'The app as an INPA script.');
  const host = document.createElement('div');
  host.className = 'results-panel';
  view.appendChild(host);
  let exec;
  try {
    exec = ipoHomeExec();
  } catch (e) {
    host.innerHTML = errorBlock(String(e.message || e));
    return;
  }
  const ecu = {
    sgbd: IPO_HOME_SGBD,
    code: 'BMWEB',
    label: 'BMWeb',
    _variant: IPO_HOME_SGBD.toUpperCase(),
    _homeExec: exec,
  };
  if (typeof ipoProgramOpen === 'function')
    await ipoProgramOpen(ecu, host, showChassis);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IPO_HOME_SGBD,
    IPO_HOME_HOST,
    ipoHomeSource,
    ipoHomeExec,
    ipoHomeEcuFor,
  };
}
