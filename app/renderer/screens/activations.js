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
});
// ...and warn before closing the tab mid-test. This only prompts: releasing
// here too would kill the test even when the user cancels the close, so the
// actual release stays on pagehide, which fires only when the page really
// goes away.
window.addEventListener('beforeunload', (e) => {
  if (!(activationEcu && activeTests.size)) return;
  e.preventDefault();
  e.returnValue = '';
});
