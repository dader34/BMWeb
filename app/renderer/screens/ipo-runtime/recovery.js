/**
 * @file BMWeb's DME recoveries (MS45.1, MS45.0) as one INPA script: a bare screen that
 * identifies the DME and, when it is not on a working program, offers one
 * key that flashes the newest program and data for it.
 *
 * The script is written in INPA's own language and compiled by the app's
 * own compiler, like the home script (home.js). What it starts and shows
 * is the Flashing app's work, reached through two builtins of the app's
 * own (core/ipovm/builtins-api.js) and their host
 * (screens/flashing/recovery.js).
 *
 * The source lives in app/renderer/home/ (the .ips and .h are the files a
 * person reads); the copies below are what the app compiles, and a test
 * pins the two as identical.
 */

/* exported IPO_RECOVERY_SGBD, ipoRecoverySource, ipoRecoveryExec, showIpoRecovery, showIpoRecoveryMs450 */

/** The SGBD name the script is seeded under: no BMW file has it. */
const IPO_RECOVERY_SGBD = 'bmweb_recovery';

/** home/bmweb-recovery.h, verbatim. */
const IPO_RECOVERY_H = `// The include of BMWeb's DME recovery script: the INPA builtins it
// calls, declared the way inpa.h declares them (parameter modes are what
// the compiler needs to pass out-parameters by reference), and the two
// builtins BMWeb adds so the script can run the recovery and show it.
//
// Written by the BMWeb project. Nothing here is copied from BMW's headers.

// INPA builtins used by the recovery script
extern setmenutitle( in: string title);
extern settitle( in: string title);
extern setmenu( in: menu name);
extern setscreen( in: screen name, in: bool flag);
extern exit();
extern ftextout( in: string text, in: int row, in: int col, in: int attr, in: int mode);

// BMWeb builtins (0xE0 and up; unused by INPA)
//   bmweb_recovery("ident")     identify the DME
//   bmweb_recovery("watch")     the same, quietly, and only when no DME is
//                               identified and a try is due: for a screen
//                               that looks for the DME by itself
//   bmweb_recovery("recover")   fetch the newest program and data for it
//                               and flash them, after asking
//   Both start the step and return at once; the screen shows it running.
extern bmweb_recovery( in: string what);
//   bmweb_recovery_read(field, text)   one field of the recovery, as text:
//     state     "" nothing read yet, "busy" a step is running, "ok" the
//               DME is fine, "recover" it needs its program, "silent" it
//               did not answer, "other" it is not this recovery's DME
//     title     the recovery's name, for the title bar ("MS45.1 recovery")
//     headline  one line saying the same in words
//     dme vin program data assembly status   what the DME identified as
//     newest    the program and data a recovery would flash, once found
//     step      what the running step is doing
//     bar       its progress, drawn
extern bmweb_recovery_read( in: string field, out: string text);
`;

/** home/bmweb-recovery.ips, verbatim. */
const IPO_RECOVERY_IPS = `//**********************************************************************
//*
//* BMWeb DME recovery: identify the DME and, when it is not on a
//* working program (program missing, in its loader, in a flasher), flash
//* the newest program and data for it. A DME that is fine is offered
//* nothing but the identification.
//*
//* One script for every DME that has a recovery (MS45.1, MS45.0): which
//* one this run is for is the host's, and so is the title.
//*
//* The script draws the screen and owns the keys; the identification and
//* the flash are the Flashing app's own, started through bmweb_recovery
//* and read back, a field at a time, through bmweb_recovery_read.
//*
//* Written by the BMWeb project.
//*
//**********************************************************************
#include "bmweb-recovery.h"

string state = "";
string text  = "";
string title = "";

inpainit()
{
  bmweb_recovery_read("title", title);
  settitle(title);
  setscreen(s_main, TRUE);
  setmenu(m_main);
}

// a DME that is fine, not read yet, or busy: the identification only
MENU m_main()
{
  INIT {
    bmweb_recovery_read("title", title);
    setmenutitle(title);
  }
  ITEM( 1 ,"Ident")  {
    bmweb_recovery("ident");
  }
  ITEM( 20 ,"Exit")  {
    exit();
  }
}

// a DME that needs its program: the identification, and the recovery
MENU m_recover()
{
  INIT {
    bmweb_recovery_read("title", title);
    setmenutitle(title);
  }
  ITEM( 1 ,"Ident")  {
    bmweb_recovery("ident");
  }
  ITEM( 2 ,"Recover")  {
    bmweb_recovery("recover");
  }
  ITEM( 20 ,"Exit")  {
    exit();
  }
}

SCREEN s_main()
{
  // no DME identified: the screen looks for one by itself, a try at a
  // time, saying nothing when a try goes unanswered
  bmweb_recovery_read("state", state);
  if (state == "")
  {
    bmweb_recovery("watch");
  }
  if (state == "silent")
  {
    bmweb_recovery("watch");
  }
  // the keys follow the DME: Recover is there only while it is needed
  setscreen(s_main, TRUE);
  if (state == "recover")
  {
    setmenu(m_recover);
  }
  else
  {
    setmenu(m_main);
  }
  bmweb_recovery_read("title", title);
  ftextout(title, 1, 0, 1, 0);
  ftextout("", 3, 0, 0, 0);
  LINE("","")
  {
    bmweb_recovery_read("headline", text);
    ftextout(text, 4, 5, 0, 1);

    ftextout("DME", 6, 5, 0, 1);
    bmweb_recovery_read("dme", text);
    ftextout(text, 6, 25, 0, 1);
    ftextout("VIN", 7, 5, 0, 1);
    bmweb_recovery_read("vin", text);
    ftextout(text, 7, 25, 0, 1);
    ftextout("Program", 8, 5, 0, 1);
    bmweb_recovery_read("program", text);
    ftextout(text, 8, 25, 0, 1);
    ftextout("Data", 9, 5, 0, 1);
    bmweb_recovery_read("data", text);
    ftextout(text, 9, 25, 0, 1);
    ftextout("Assembly number", 10, 5, 0, 1);
    bmweb_recovery_read("assembly", text);
    ftextout(text, 10, 25, 0, 1);
    ftextout("Programming status", 11, 5, 0, 1);
    bmweb_recovery_read("status", text);
    ftextout(text, 11, 25, 0, 1);

    ftextout("Newest", 13, 5, 0, 1);
    bmweb_recovery_read("newest", text);
    ftextout(text, 13, 25, 0, 1);

    bmweb_recovery_read("step", text);
    ftextout(text, 15, 5, 0, 1);
    bmweb_recovery_read("bar", text);
    ftextout(text, 16, 5, 0, 1);

    ftextout("< F1 >  Ident", 19, 5, 0, 1);
    if (state == "recover")
    {
      ftextout("< F2 >  Recover: flash the newest program and data", 20, 5, 0, 1);
    }
    ftextout("<Shift> + < F10>  Exit", 22, 45, 0, 1);
  }
}
`;

/**
 * The recovery script's source and include, as compiled.
 * @returns {{ips: string, h: string}}
 */
function ipoRecoverySource() {
  return { ips: IPO_RECOVERY_IPS, h: IPO_RECOVERY_H };
}

/** @type {object|null} The compiled script, once. */
let _ipoRecoveryExec = null;

/**
 * Compile the recovery script (once) and seed it under IPO_RECOVERY_SGBD so
 * the runtime opens it like any shipped module.
 * @returns {object} the exec
 */
function ipoRecoveryExec() {
  if (_ipoRecoveryExec) return _ipoRecoveryExec;
  const src = ipoRecoverySource();
  const r = ipofCompileSource(src.ips, {
    files: { 'bmweb-recovery.h': src.h },
  });
  if (!r.ok || !r.exec) {
    const why = (r.errors || []).map((e) => e.message).join('; ');
    throw new Error(`the recovery script did not compile: ${why}`);
  }
  _ipoRecoveryExec = r.exec;
  if (typeof irSeedExec === 'function') irSeedExec(IPO_RECOVERY_SGBD, r.exec);
  return r.exec;
}

/**
 * The recovery script as a screen of the app, for one of the DMEs that has
 * a recovery (screens/flashing/recovery.js, fbRecoveryFor).
 * @param {string} kind - Which DME.
 * @param {Function} self - The screen's own opener: what a redraw calls,
 *   and what the address bar is named after.
 * @returns {Promise<void>}
 */
async function ipoRecoveryShow(kind, self) {
  lastScreen = self;
  // the script asks its host which DME it is for
  const recovery = await fbRecoveryFor(kind);
  ipoRecoverySetHost(recovery.host);
  const name = `${recovery.name} recovery`;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: name }]);
  sbLeft.textContent = name.toLowerCase();
  view.innerHTML = head(
    'INPA',
    name,
    'Identify the DME; recover it when it has lost its program.'
  );
  const host = document.createElement('div');
  host.className = 'results-panel';
  view.appendChild(host);
  try {
    ipoRecoveryExec();
  } catch (e) {
    host.innerHTML = errorBlock(String(e.message || e));
    return;
  }
  const ecu = {
    sgbd: IPO_RECOVERY_SGBD,
    code: recovery.name,
    label: name,
    _variant: IPO_RECOVERY_SGBD.toUpperCase(),
  };
  if (typeof ipoProgramOpen === 'function')
    await ipoProgramOpen(ecu, host, showChassis);
}

/**
 * The MS45.1 recovery (#recovery).
 * @returns {Promise<void>}
 */
function showIpoRecovery() {
  return ipoRecoveryShow('ms451', showIpoRecovery);
}

/**
 * The MS45.0 recovery (#recovery/ms450): the same screen, the flash always
 * through the DME's own loader.
 * @returns {Promise<void>}
 */
function showIpoRecoveryMs450() {
  return ipoRecoveryShow('ms450', showIpoRecoveryMs450);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IPO_RECOVERY_SGBD,
    ipoRecoverySource,
    ipoRecoveryExec,
  };
}
