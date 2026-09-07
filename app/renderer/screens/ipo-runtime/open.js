/**
 * @file Entry point: open the live program for a module, and the one-driver
 * rule that pauses it while a remote helper has the cable. This is the last
 * piece of screens/ipo-runtime/ in load order and exports the runtime's
 * public API.
 */

/** @type {IpoProgram|null} the program whose view is showing */
let _ipoCurrent = null;

/**
 * The current program left its view (its UI adapter reports it).
 * @returns {void}
 */
function ipoProgramLeft() {
  _ipoCurrent = null;
}

/**
 * ONE DRIVER AT A TIME. While the owner has admitted a helper, the helper's
 * runtime is what runs on the cable. The owner's own module screens would
 * cycle their jobs on the same K-line every tick and the helper's requests
 * would queue behind them, seconds at a time; so an owner opening a module
 * during a live share sees a notice instead, and a share being admitted
 * closes whatever the owner had running.
 * @returns {boolean}
 */
function ipoRemoteDriving() {
  return (
    typeof Remote !== 'undefined' &&
    Remote &&
    Remote.role === 'owner' &&
    !!Remote.accepted
  );
}

/**
 * Close the owner's running program because a helper was admitted.
 * @returns {void}
 */
function ipoPauseForRemote() {
  if (_ipoCurrent) {
    _ipoCurrent.close();
    _ipoCurrent = null;
  }
}

/**
 * Show a notice in the module container with only a Back key.
 * @param {HTMLElement} container - the view
 * @param {string} html - the notice
 * @param {string} status - the status-bar text
 * @param {() => void} back - leave the module view
 * @returns {void}
 */
function ipoNotice(container, html, status, back) {
  container.className = 'results-panel';
  container.innerHTML = html;
  sbLeft.textContent = status;
  setActions([ipoBackAction(() => back())]);
}

/**
 * The "module did not identify itself" screen: the script's own last
 * message when it stopped itself, else the generic explanation, plus WHY
 * inpainit had nothing better than the SGBD filename to check -- the group
 * probe's own verdict (bus-silent, probe-error, ...) is the actionable half
 * of this screen, so say it instead of leaving a self-contradictory "'SM46'
 * not found, found 'SM46'".
 * @param {object} ecu - the module
 * @param {IpoProgram} program - the program that failed to start
 * @returns {string} HTML
 */
function ipoStoppedHtml(ecu, program) {
  const m = (program.messages || []).slice(-1)[0];
  const rd =
    typeof webResolveVariantLast === 'function'
      ? webResolveVariantLast()
      : null;
  const g = String(ecu.group || '').toLowerCase();
  const why =
    rd && g && rd.group === g && rd.path !== 'resolved'
      ? `<div style="margin-top:14px;font-size:12px;color:var(--ink-faint)">` +
        `Variant probe ${esc(g)}: <b>${esc(rd.path)}</b>` +
        (rd.empty != null || rd.real != null
          ? ` (${Number(rd.real || 0)} answered, ${Number(rd.empty || 0)} silent)`
          : '') +
        (rd.error ? ` — ${esc(String(rd.error))}` : '') +
        `. The car did not name this module, so the script checked the ` +
        `SGBD filename instead. Ignition on, reopen the module.</div>`
      : '';
  return (
    `<div class="empty"><div class="empty-big" style="color:var(--amber)">` +
    `${esc(m ? ipoText(m.title) : `${ecu.label} is not answering`)}</div>` +
    `<div>${esc(
      m
        ? ipoText(m.body || '')
        : 'The cable is connected, but this module did not identify itself. It may not be fitted to this car, or the ignition may need to be on.'
    )}</div>${why}</div>`
  );
}

/**
 * Which shipped SGBDs a script may address explicitly, cached on the module.
 * @param {object} ecu - the module
 * @returns {Promise<void>}
 */
async function ipoLoadKnownSgbds(ecu) {
  if (ecu._ipoKnownSgbds) return;
  try {
    const idx = await fetch('api/ecu-index.json').then((r) =>
      r.ok ? r.json() : null
    );
    ecu._ipoKnownSgbds = new Set(
      Object.keys(idx || {}).map((k) => k.toLowerCase())
    );
  } catch (e) {
    ecu._ipoKnownSgbds = new Set();
  }
}

/**
 * Open the live program for a module. Returns true when it took the view
 * (even if the script stopped itself: the reason is shown), false when this
 * module cannot run live (no exec) so the caller falls back.
 * @param {object} ecu - the module
 * @param {HTMLElement} container - where the view is drawn
 * @param {() => void} back - leave the module view
 * @param {string|null} [openMenu] - a menu to open (a deep link)
 * @returns {Promise<boolean>}
 */
async function ipoProgramOpen(ecu, container, back, openMenu) {
  if (typeof IpoVm === 'undefined' || typeof FeedHost === 'undefined')
    return false;
  if (ipoRemoteDriving()) {
    ipoNotice(
      container,
      `<div class="empty"><div class="empty-big" style="color:var(--amber)">A helper is driving your car</div>` +
        `<div>Your own module screens stay off while the remote session is live, so the helper's reads are not queued behind them. End the session to use this module yourself.</div></div>`,
      `${ecu.sgbd}.prg · remote session live`,
      back
    );
    return true;
  }
  if (typeof irLiveExec !== 'function' || typeof irExecSgbd !== 'function')
    return false;
  const exec = await irLiveExec(irExecSgbd(ecu));
  if (!exec || !exec.procs || !Object.keys(exec.procs).length) return false;
  if (!(exec.procs.inpainit || exec.procs.SgbdInpaCheck)) return false;
  if (_ipoCurrent) _ipoCurrent.close();
  if (ecu._ir && typeof irUseTranslations === 'function')
    irUseTranslations(ecu._ir);
  await ipoLoadKnownSgbds(ecu);
  // the fault dictionaries the fed results are translated through
  // (faultdb.js: large, injected on demand, absent from a build that opted
  // out of the fault tables -- then the ECU's German is what shows)
  if (ipoTranslating() && typeof loadFaultDb === 'function') {
    try {
      await loadFaultDb();
    } catch (e) {
      /* results stay as sent */
    }
  }
  const ui = ipoMakeUi(ecu, container, back);
  const program = new IpoProgram(ecu, exec, ui);
  _ipoCurrent = program;
  sbLeft.textContent = `${ecu.sgbd}.prg · starting`;
  const r = await program.start();
  if (!r.ok) {
    _ipoCurrent = null;
    if (program.noCable) {
      ipoNotice(
        container,
        errorBlock('no cable connected'),
        `${ecu.sgbd}.prg · no cable`,
        back
      );
      return true;
    }
    if (program.silent || r.reason === 'stopped') {
      ipoNotice(
        container,
        ipoStoppedHtml(ecu, program),
        `${ecu.sgbd}.prg · ${program.silent ? 'no response' : 'stopped'}`,
        back
      );
      return true;
    }
    if (r.reason === 'cancelled') {
      back();
      return true;
    }
    // the script itself failed before its root menu opened: an app error,
    // not the car -- say which, there is no other renderer to fall back to
    ipoNotice(
      container,
      errorBlock(
        `vm error: INPA's script for ${ecu.sgbd} did not start (${r.reason})`
      ),
      `${ecu.sgbd}.prg · failed`,
      back
    );
    return true;
  }
  if (openMenu && openMenu !== program.menu && exec.procs[openMenu]) {
    await program.openMenu(openMenu);
  }
  return true;
}

if (typeof window !== 'undefined') {
  window.ipoProgramOpen = ipoProgramOpen;
  window.ipoPauseForRemote = ipoPauseForRemote;
  window.IpoProgram = IpoProgram;
  window.ipoMenuItems = ipoMenuItems;
  window.ipoWireTarget = ipoWireTarget;
  window.ipoScreenForMenu = ipoScreenForMenu;
  window.ipoNeedsConfirm = ipoNeedsConfirm;
  window.ipoMakeUi = ipoMakeUi;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipoNeedsConfirm,
    IpoProgram,
    ipoMenuItems,
    ipoWireTarget,
    ipoProgramOpen,
    ipoMakeUi,
    ipoLineRows,
    ipoMenuTiles,
    ipoScreenComponents,
    ipoLampHtml,
    ipoGaugeHtml,
    ipoScreenLineNames,
    ipoProgramLeft,
    ipoPauseForRemote,
  };
}
