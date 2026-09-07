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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IPO_PLUMBING, ipoWireTarget, ipoNeedsConfirm };
}
