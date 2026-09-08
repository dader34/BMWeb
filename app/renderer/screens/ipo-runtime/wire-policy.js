/**
 * @file The runtime's wire policy: which SGBD a script's job goes to, and
 * which jobs are a USER ACTION that must be confirmed before they are sent.
 *
 * SAFETY. Confirm before any key whose body can send a job the write
 * classifier flags; a screen's own writes are confirmed once per screen.
 * Release on leave is the script's own Back ITEM (that is how INPA releases
 * what it energised) plus `inpaexit` on module exit; the Back job is also
 * registered with registerMenuLeave so a route change still sends it. Reads
 * never prompt. Jobs go to the SGBD the car identified.
 */

/**
 * The session plumbing INPA sends without asking anyone: the write
 * classifier is default-deny (it guards the raw job route, where an unknown
 * name must never reach the car unasked), and inside a running script most
 * of what it flags is the session INITIALISIERUNG, the DIAGNOSE_AUFRECHT
 * keep-alive, the closing DIAGNOSE_ENDE -- prompting for each turns opening
 * a module into a wall of dialogs. What is worth confirming is an ACTUATOR
 * COMMAND: a job that energises something, writes, resets or clears -- what
 * INPA itself warns about. So the script's own plumbing goes silently and
 * everything else the classifier flags still asks (an unknown write stays
 * guarded).
 * @type {RegExp}
 */
const IPO_PLUMBING =
  /^(INITIALISIERUNG|IDENT|IDENT_\w+|INFO|DIAGNOSE_(AUFRECHT|ENDE|MODE)|ENDE)$/i;

/** a group SGBD's name: D_ + the diagnostic address or a family (D_MOTOR) */
const IPO_GROUP_SGBD_RE = /^d_[a-z0-9_]+$/;

/**
 * The wire target for a job the script addresses. The script's own variable
 * holds INPA's dispatch LIST ("IHKA46,IHKA46_2,IHKA46_3") until inpainit
 * stores the resolved variant; the car's identified SGBD is what we talk to.
 * A script that names ANOTHER shipped module explicitly (a DME screen asking
 * the EGS) keeps that name.
 * @param {object} ecu - the module ({sgbd, _sgbdBase, _ipoKnownSgbds})
 * @param {string|null} sgbd - the SGBD the script named
 * @returns {string} the SGBD to send to, lower-case
 */
function ipoWireTarget(ecu, sgbd) {
  const mine = String((ecu && ecu.sgbd) || '').toLowerCase();
  const s = String(sgbd || '')
    .toLowerCase()
    .trim();
  if (!s || s.includes(',') || s === mine) return mine;
  const base = String((ecu && ecu._sgbdBase) || '').toLowerCase();
  if (s === base) return mine;
  const known = ecu && ecu._ipoKnownSgbds;
  if (known && known.has(s)) return s;
  // a group SGBD (D_0044, D_MOTOR): a script addresses a module by its group
  // and lets EDIABAS find the variant on the wire -- the whole-vehicle
  // scripts do it for every module, a module's script for its own startup
  // (IHKA46 goes through D_005B) or a neighbour (GS30 asks D_0044). The
  // shim's run route resolves the group the same way EDIABAS does and
  // caches the answer, so the group stays the target (api-router.js).
  if (IPO_GROUP_SGBD_RE.test(s)) return s;
  return mine;
}

/**
 * Does sending this job need the user's confirmation: a write by the
 * classifier's verdict that is not the script's own session plumbing.
 * @param {string|null|undefined} job - job name
 * @returns {boolean}
 */
function ipoNeedsConfirm(job) {
  const n = String(job || '').trim();
  if (!n) return false;
  if (typeof isWriteJob === 'function' && !isWriteJob(n)) return false;
  if (IPO_PLUMBING.test(n)) return false;
  return true;
}

/**
 * Writes that change the module for good, whatever the setting says: coding,
 * flashing, EEPROM/adaptation writes, resets, clears. An actuator drive is
 * not one of these (STEUERN_*, START_/STOP_*, AKTIVIER*): it energises a
 * component for the moment and releases when the key or screen is left.
 * @type {RegExp}
 */
const IPO_PERMANENT_WRITE_RE = new RegExp(
  '(SCHREIB|LOESCH|FLASH|PROGRAMMIER|RESET|CODIER|WRITE|DOWNLOAD|UPLOAD' +
    '|ABGLEICH|ADAPTION|ANLERN|TEACH|CLEAR|SETZEN|(?:\\b|_)SET(?:\\b|_)|EINSTELL|TILGUNG' +
    '|AUTHENTIS|SLEEP|WAKEUP|POWER_?DOWN)',
  'i'
);

/**
 * Does this write still ask, given Settings 'confirmActuators'? "Send
 * immediately (like INPA)" turns the prompt off for actuator drives only; a
 * permanent write asks whatever the setting says (the README's promise).
 * @param {string} job - job name
 * @returns {boolean} true when the prompt must be shown
 */
function ipoConfirmWanted(job) {
  const n = String(job || '').trim();
  if (IPO_PERMANENT_WRITE_RE.test(n)) return true;
  if (typeof Settings === 'undefined' || !Settings || !Settings.get)
    return true;
  return Settings.get('confirmActuators', 'on') !== 'off';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IPO_PLUMBING,
    IPO_PERMANENT_WRITE_RE,
    ipoWireTarget,
    ipoNeedsConfirm,
    ipoConfirmWanted,
  };
}
