// Actuator release, INPA's way: we do NOT synthesize a stop telegram.
//
// An actuator menu in the .IPO releases (or does not) through its OWN keys.
// On the MS45 MIL menu the release is a key -- "Ansteuerung zurück an DME"
// (STEUERN_MIL_ENDE) -- and its BACK key just navigates: INPA leaves the MIL
// commanded and lets the ECU's own actuator timeout end it. On kombi's
// STEUERN_46 menu the BACK key itself carries DIAGNOSE_ENDE. Either way the
// truth is in the bytecode the IR already carries, so the ONE honest release
// is: run the leaving menu's Back-item job, and only that.
//
// The old registry (activeTests / activeDrives / an "<arg>;0" off form
// replayed on leave) invented releases INPA never sends and guessed the wrong
// telegram when it did -- firing STEUERN_MIL?arg=0, itself a drive command,
// on back-out. Gone. What a menu owes on the way out is what its Back key
// runs; what it owes on ECU exit is inpaexit's DIAGNOSE_ENDE (registerSessionEnd
// below), which is likewise read from the script, not made up.

// ---- the menu's on-leave job -----------------------------------------------
//
// Set by ir.js as it renders a menu: the job the current menu's Back item
// runs (null for a menu whose Back only navigates). Sent once, when a render
// for a DIFFERENT menu (or a real leave) follows -- a same-menu repaint must
// not fire it.
/** The ECU whose menu is open. @type {{sgbd: string}|null} */
let leaveEcu = null;
/** The job the current menu's Back item runs on leave. @type {string|null} */
let leaveJob = null;
/** The Back key's argument (STEUERN_DISPLAY "0"): sent with it. @type {string|null} */
let leaveArg = null;
/** "sgbd:menu", so a repaint of the same menu is a no-op. @type {string|null} */
let leaveKey = null;
/** Did THIS menu fire a drive? (for pagehide only) @type {boolean} */
let _leftEnergized = false;

/**
 * Register what the menu being drawn owes on the way out, first settling what
 * the PREVIOUS menu owed (its composite neutral word and/or its Back job).
 * Called by the runtime as it renders a menu; a same-menu repaint keeps the
 * key and fires nothing.
 * @param {{sgbd: string}|null} ecu - The ECU the menu belongs to.
 * @param {string|null} menuKey - "sgbd:menu" identity of the menu.
 * @param {string|null} job - The Back item's job, or null when Back only navigates.
 * @param {string|number|null} [arg] - The Back item's argument, if any.
 * @returns {void}
 */
function registerMenuLeave(ecu, menuKey, job, arg) {
  // a different menu is being set up: run what the PREVIOUS one owed
  if (leaveKey && leaveKey !== menuKey) {
    if (compEcu?.sgbd && compJob) {
      try {
        api(
          `/api/ecu/${compEcu.sgbd}/run/${compJob}` +
            `?arg=${encodeURIComponent(compArg)}`,
          { method: 'POST' }
        ).catch(() => {});
      } catch (e) {
        /* leaving */
      }
      _clearComposite();
    }
    if (leaveJob && leaveEcu) _sendLeave(leaveEcu, leaveJob, leaveArg);
  }
  leaveEcu = ecu || null;
  leaveJob = job || null;
  leaveArg = arg != null && arg !== '' ? String(arg) : null;
  leaveKey = menuKey || null;
  _leftEnergized = false;
}

// ir.js calls this when a drive is fired in the current menu, so a tab-close
// can run the Back job even for a menu whose release is a separate key.
/**
 * Note that the current menu energized something (drives the pagehide release).
 * @returns {void}
 */
function markEnergized() {
  _leftEnergized = true;
}

// A composite actuator word (LSZ-style: several outputs in one job) releases
// by being RE-COMMANDED to neutral -- INPA's own behavior, not a synthetic
// _ENDE. ir.js registers the neutral word here; runMenuLeave re-sends it.
/** The ECU / job / neutral argument of a registered composite word. */
let compEcu = null,
  compJob = null,
  compArg = null;

/**
 * Register a composite actuator word's neutral form, re-sent on leave.
 * @param {{sgbd: string}|null} ecu - The ECU.
 * @param {string|null} job - The composite job.
 * @param {string} neutralArg - The argument that commands every output to neutral.
 * @returns {void}
 */
function registerCompositeNeutral(ecu, job, neutralArg) {
  compEcu = ecu || null;
  compJob = job || null;
  compArg = neutralArg;
}

/**
 * Forget the registered composite word.
 * @returns {void}
 */
function _clearComposite() {
  compEcu = compJob = compArg = null;
}

/**
 * Fire a leave/end job, best effort: errors are swallowed, we are leaving anyway.
 * @param {{sgbd: string}|null} ecu - The ECU.
 * @param {string|null} job - The job.
 * @param {string|null} [arg] - The argument, if any.
 * @returns {void}
 */
function _sendLeave(ecu, job, arg) {
  if (!ecu?.sgbd || !job) return;
  try {
    const q = arg != null ? `?arg=${encodeURIComponent(arg)}` : '';
    api(`/api/ecu/${ecu.sgbd}/run/${job}${q}`, { method: 'POST' }).catch(
      () => {}
    );
  } catch (e) {
    /* leaving anyway */
  }
}

// Called from the setActions leave hook (core.js). A same-menu repaint keeps
// leaveKey unchanged and is held, so nothing fires; a real navigation has
// already re-registered (or cleared) leaveKey via ir.js, so run what the menu
// we are leaving owed.
/**
 * Run what the menu being left owed: the composite neutral word, then the
 * Back item's job; then forget both.
 * @returns {void}
 */
function runMenuLeave() {
  // a composite word: re-command it to neutral, then forget the flags
  if (compEcu?.sgbd && compJob) {
    try {
      api(
        `/api/ecu/${compEcu.sgbd}/run/${compJob}` +
          `?arg=${encodeURIComponent(compArg)}`,
        { method: 'POST' }
      ).catch(() => {});
    } catch (e) {
      /* leaving */
    }
    _clearComposite();
  }
  if (leaveJob && leaveEcu) {
    const ecu = leaveEcu,
      job = leaveJob,
      arg = leaveArg;
    _sendLeave(ecu, job, arg);
  }
  leaveEcu = leaveJob = leaveArg = leaveKey = null;
}

// ---- ECU session end (inpaexit's DIAGNOSE_ENDE) ----------------------------
// Unchanged in spirit: read from the script, sent on ECU exit however it
// happens. Registered on ENTRY so it fires even when the user leaves by a
// path we do not draw.
/** The ECU whose session-end job is registered. @type {{sgbd: string}|null} */
let sessionEndEcu = null;
/** The registered session-end job (inpaexit's DIAGNOSE_ENDE). @type {string|null} */
let sessionEndJob = null;
/** An end deferred to the microtask, so a submenu hop can cancel it. @type {{ecu: {sgbd: string}, job: string}|null} */
let _pendingEnd = null;

/**
 * Register the ECU's session-end job on ENTRY, so it fires however the user
 * leaves.
 * @param {{sgbd: string}|null} ecu - The ECU.
 * @param {string|null} job - The session-end job.
 * @returns {void}
 */
function registerSessionEnd(ecu, job) {
  if (!ecu || !job) return;
  sessionEndEcu = ecu;
  sessionEndJob = job;
}

/**
 * Send the registered session-end job, deferred one microtask so a submenu
 * hop that re-registers the same ECU cancels it.
 * @returns {void}
 */
function endActivationSession() {
  const ecu = sessionEndEcu;
  const job = sessionEndJob;
  sessionEndEcu = null;
  sessionEndJob = null;
  if (!ecu?.sgbd || !job) return;
  // a submenu hop re-registers the same ECU before this microtask runs, so
  // only send once we are truly off this ECU.
  _pendingEnd = { ecu, job };
  queueMicrotask(() => {
    const p = _pendingEnd;
    _pendingEnd = null;
    if (!p || (sessionEndJob === p.job && sessionEndEcu?.sgbd === p.ecu.sgbd)) {
      return;
    }
    _sendLeave(p.ecu, p.job);
  });
}

// ---- same-screen repaint hold ----------------------------------------------
// ir.js reopens its menu after a drive so each row shows its armed state.
// That repaint must not count as leaving: registerMenuLeave keeps the same
// leaveKey, and this hold stops the leave hook from running mid-repaint.
/** True while a same-menu repaint runs, so the leave hook stays quiet. @type {boolean} */
let _activationsHeld = false;

/**
 * Run a same-menu repaint with the leave hook held off.
 * @param {() => void} fn - The repaint.
 * @returns {void}
 */
function keepActivationsDuring(fn) {
  _activationsHeld = true;
  try {
    fn();
  } finally {
    _activationsHeld = false;
  }
}

/**
 * Whether a repaint hold is active (read by the action bar's leave hook).
 * @returns {boolean}
 */
const activationsHeld = () => _activationsHeld;

// ---- page teardown ---------------------------------------------------------
// Tab close / reload / navigation: the setActions leave hook never fires.
// Run the leaving menu's Back job (if it had one and we energized something)
// and the ECU session end, synchronously -- microtasks never run on unload.
window.addEventListener('pagehide', () => {
  if (_leftEnergized) {
    if (compEcu?.sgbd && compJob) {
      _sendLeave(compEcu, compJob); // best effort; arg lost on unload, but neutral job runs
    }
    if (leaveEcu && leaveJob) _sendLeave(leaveEcu, leaveJob, leaveArg);
  }
  const ecu = sessionEndEcu,
    job = sessionEndJob;
  sessionEndEcu = sessionEndJob = _pendingEnd = null;
  _sendLeave(ecu, job);
});

// Warn before closing the tab while an actuator is energized -- only prompts;
// the actual release rides pagehide so a cancelled close does not kill it.
window.addEventListener('beforeunload', (e) => {
  if (!_leftEnergized) return;
  e.preventDefault();
  e.returnValue = '';
});
