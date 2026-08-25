// The actuator write registry. Actuator tests are driven from the IR menu
// (ir.js) now; this owns the shared "what is currently energized" state so any
// running output is released on the next screen change or page unload. Every
// path that energizes an output MUST register here (ir.js does), or "outputs
// are released when you leave" is a lie.
const activeTests = new Set(); // jobs currently on
// job -> the argument that de-energizes it, when the drive path knows one
// ("<component>;0" for component drives). null means the generic ?arg=0 /
// _ENDE fallback in stopAllActivations. Every path that energizes an output
// MUST register here, or "outputs are released when you leave" is a lie.
const activeDrives = new Map();
let activationEcu = null;       // ecu whose tests are active, for cleanup

// THE SCRIPT'S SHUTDOWN JOB (ir.exitJob), taken from INPA's own `inpaexit`
// proc -- a declared function it runs when the script ends, however it ends.
// 877 ECUs declare one; 58 send a real job from it, nearly always
// DIAGNOSE_ENDE. Nothing in the app was sending it, so the ECU stayed in
// diagnostic mode until its own timeout.
//
// Read from the proc rather than from the Back/Exit keys that also carry it:
// those are captioned as plain navigation and sit beside keys whose jobs
// DRIVE OUTPUTS (STEUERN_CFL behind "Deselect"), so choosing them by caption
// would risk energizing something on the way out.
//
// Registered on ECU ENTRY, not on a keypress, so it fires on every exit path:
// screen change, in-app navigation, window close, or reload. Deliberately NOT
// gated on activeTests -- the session needs ending even if nothing was ever
// energized.
let sessionEndEcu = null;
let sessionEndJob = null;

function registerSessionEnd(ecu, job) {
  if (!ecu || !job) return;
  sessionEndEcu = ecu;
  sessionEndJob = job;
}


// Send it and forget it. Fire-and-forget because the common caller is an
// unload handler, where nothing can be awaited; a failure here is not worth a
// dialog the way a failed actuator RELEASE is -- the ECU times out by itself.
function endSession() {
  const ecu = sessionEndEcu;
  const job = sessionEndJob;
  sessionEndEcu = null;
  sessionEndJob = null;
  // Moving between menus of the SAME ECU is not leaving its session. ir.js
  // re-registers on every menu render and setActions runs the leave hook
  // afterwards, so a submenu hop lands here with the registration still
  // pointing at the ECU we are staying on -- remember it, and only send once
  // a render for a DIFFERENT ecu (or no render at all) follows.
  if (!ecu?.sgbd || !job) return;
  _pendingEnd = { ecu, job };
  queueMicrotask(() => {
    const p = _pendingEnd;
    _pendingEnd = null;
    // a re-register for the same ECU happened in between: still here
    if (!p || (sessionEndJob === p.job && sessionEndEcu?.sgbd === p.ecu.sgbd)) {
      return;
    }
    _sendEnd(p.ecu, p.job);
  });
}

let _pendingEnd = null;

function _sendEnd(ecu, job) {
  if (!ecu?.sgbd || !job) return;
  try {
    api(`/api/ecu/${ecu.sgbd}/run/${job}`, { method: 'POST' }).catch(() => {});
  } catch (e) { /* leaving anyway */ }
}


// Redrawing the SAME screen right after a send (ir.js reopens its menu so
// each row shows its armed state) is not a screen change: releasing there
// would replay the off form into the job that was just fired. The redraw
// runs inside this hold; every real navigation still releases (setActions
// in core.js consults activationsHeld before stopping).
let _activationsHeld = false;
function keepActivationsDuring(fn) {
  _activationsHeld = true;
  try { fn(); } finally { _activationsHeld = false; }
}
const activationsHeld = () => _activationsHeld;

const keepAliveTimers = new Map(); // start job -> interval id

function stopKeepAlive(job) {
  const t = keepAliveTimers.get(job);
  if (t) { clearInterval(t); keepAliveTimers.delete(job); }
}

// stop all running actuator tests, on leaving the screen. A failed release is
// not swallowed: if neither the off form nor _ENDE went out, the user is told
// the output may still be commanded rather than being shown nothing.
function stopAllActivations(ecu) {
  if (!activeTests.size) return;
  const ecuSgbd = ecu?.sgbd;
  const failed = [];
  const sends = [];
  for (const start of [...activeTests]) {
    stopKeepAlive(start);
    if (ecuSgbd) {
      // a drive that registered its exact off form gets it; otherwise
      // arg=0 de-energizes, _ENDE only as fallback
      const off = activeDrives.get(start) || '0';
      sends.push(
        api(`/api/ecu/${ecuSgbd}/run/${start}?arg=${encodeURIComponent(off)}`, { method: 'POST' })
          .catch(() => api(`/api/ecu/${ecuSgbd}/run/${start}_ENDE`, { method: 'POST' }))
          .catch(() => { failed.push(start); }));
    }
    activeTests.delete(start);
    activeDrives.delete(start);
  }
  // the composite actuator words (ir.js) were re-commanded to neutral above;
  // forget them so a re-entered menu starts from baseline, not stale flags
  if (typeof irResetCompositeState === 'function') irResetCompositeState();
  Promise.all(sends).then(() => {
    if (!failed.length) return;
    sbLeft.textContent = `release FAILED: ${failed.join(', ')} — outputs may still be driven`;
    confirmDialog({
      title: 'Release failed',
      body: `The release telegram failed for <span class="mono">${esc(failed.join(', '))}</span>. `
          + `<b>The outputs may still be commanded.</b> Check the components; `
          + `if one is still running, switch the ignition off.`,
      confirmLabel: 'OK', cancelLabel: 'Close',
    });
  });
}

// Last-ditch release when the whole page goes away (tab close, reload,
// navigation): the setActions leave hook never fires for those. Nothing can
// be awaited during unload, so the sends are fire-and-forget.
window.addEventListener('pagehide', () => {
  if (activationEcu && activeTests.size) stopAllActivations(activationEcu);
  // SYNCHRONOUS here: the deferral in endSession() rides a microtask, which
  // never runs once the page is going away. On unload there is no "maybe we
  // are staying" case to wait for, so send it outright.
  const ecu = sessionEndEcu;
  const job = sessionEndJob;
  sessionEndEcu = null;
  sessionEndJob = null;
  _pendingEnd = null;
  _sendEnd(ecu, job);
});
// NOT hooked to visibilitychange: the app treats a hidden window as a PAUSE
// (app.js stops the status poller and resumes on return), so minimising or
// switching away from the app is not leaving the screen. Ending the session
// there would drop it out from under a user who is coming straight back.
// ...and warn before closing the tab mid-test. This only prompts: releasing
// here too would kill the test even when the user cancels the close, so the
// actual release stays on pagehide, which fires only when the page really
// goes away.
window.addEventListener('beforeunload', (e) => {
  if (!(activationEcu && activeTests.size)) return;
  e.preventDefault();
  e.returnValue = '';
});
