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
let leaveEcu = null;
let leaveJob = null;
let leaveKey = null; // "sgbd:menu", so a repaint of the same menu is a no-op
let _leftEnergized = false; // did THIS menu fire a drive? (for pagehide only)

function registerMenuLeave(ecu, menuKey, job) {
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
      if (typeof irResetCompositeState === 'function') irResetCompositeState();
      _clearComposite();
    }
    if (leaveJob && leaveEcu) _sendLeave(leaveEcu, leaveJob);
  }
  leaveEcu = ecu || null;
  leaveJob = job || null;
  leaveKey = menuKey || null;
  _leftEnergized = false;
}

// ir.js calls this when a drive is fired in the current menu, so a tab-close
// can run the Back job even for a menu whose release is a separate key.
function markEnergized() {
  _leftEnergized = true;
}

// A composite actuator word (LSZ-style: several outputs in one job) releases
// by being RE-COMMANDED to neutral -- INPA's own behavior, not a synthetic
// _ENDE. ir.js registers the neutral word here; runMenuLeave re-sends it.
let compEcu = null,
  compJob = null,
  compArg = null;
function registerCompositeNeutral(ecu, job, neutralArg) {
  compEcu = ecu || null;
  compJob = job || null;
  compArg = neutralArg;
}
function _clearComposite() {
  compEcu = compJob = compArg = null;
}

function _sendLeave(ecu, job) {
  if (!ecu?.sgbd || !job) return;
  try {
    api(`/api/ecu/${ecu.sgbd}/run/${job}`, { method: 'POST' }).catch(() => {});
  } catch (e) {
    /* leaving anyway */
  }
}

// Called from the setActions leave hook (core.js). A same-menu repaint keeps
// leaveKey unchanged and is held, so nothing fires; a real navigation has
// already re-registered (or cleared) leaveKey via ir.js, so run what the menu
// we are leaving owed.
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
    if (typeof irResetCompositeState === 'function') irResetCompositeState();
    _clearComposite();
  }
  if (leaveJob && leaveEcu) {
    const ecu = leaveEcu,
      job = leaveJob;
    _sendLeave(ecu, job);
  }
  leaveEcu = leaveJob = leaveKey = null;
}

// ---- ECU session end (inpaexit's DIAGNOSE_ENDE) ----------------------------
// Unchanged in spirit: read from the script, sent on ECU exit however it
// happens. Registered on ENTRY so it fires even when the user leaves by a
// path we do not draw.
let sessionEndEcu = null;
let sessionEndJob = null;
let _pendingEnd = null;

function registerSessionEnd(ecu, job) {
  if (!ecu || !job) return;
  sessionEndEcu = ecu;
  sessionEndJob = job;
}

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
let _activationsHeld = false;
function keepActivationsDuring(fn) {
  _activationsHeld = true;
  try {
    fn();
  } finally {
    _activationsHeld = false;
  }
}
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
    if (leaveEcu && leaveJob) _sendLeave(leaveEcu, leaveJob);
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
