// Flashing/Backups: the BMWeb Flasher (the macOS app) as a screen of the web
// app, laid out the same way -- a rail of pages down the left, the control
// unit and Identify across the top, the log in the middle with the actions
// beside it, Custom Options pinned under them, and the status line with the
// progress bar along the bottom.
//
// This file is the frame: the layout, the shared state, the log and status
// helpers, the dialogs the flows ask with, the module choice and Identify, and
// the History and Settings pages. The DME flows live in dme.js, the
// transmission's in tcu.js, Custom Options (EWS delete, map switch, no auto
// upshift) in options.js. The engines underneath are core/ms45.js (the DME
// over the SGBD's jobs), core/gs20.js + core/gs20-program.js (the
// transmission over raw DS2), core/mapswitch.js and core/flash-history.js.
/* exported showFlashing, fbState, fbEls, fbSetStatus, fbSetStage, fbSetStatusInPlace, fbLog, fbProgress, fbFlashingBar, fbBusy, fbConfirm, fbMessage, fbChoose, fbConfirmAck, fbPickFile, fbReadBytes, fbReadText, fbSaveBytes, fbEnsureCable, fbDescribeError, fbProgrammingCounter, fbRefreshCustomOptionsGate, fbShowOptions, fbSetEcuBox, fbRefreshAll, fbDevUi, fbWriteAif, fbTesterSerial, fbSessionStart, fbSessionStop */

/** The tester serial every programming-log entry carries. */
const fbTesterSerial = 'BMWEB';
/** How many log lines the screen keeps; the session logs on disk hold the detail. */
const FB_LOG_LINES = 300;
/** Entries a module's programming log holds. */
const FB_AIF_SLOTS = 14;

/** Everything the screen knows, reset when it is opened. */
const fbState = {
  /** 'dme' | 'tcu' | null until chosen. */
  module: null,
  /** True while anything talks to the car. */
  running: false,
  page: 'flashing',
  optionsOpen: false,
  log: [],
  lastInPlace: false,
  dme: null,
  tcu: null,
};

/** The screen's elements, by id without the fb- prefix. @type {Object<string, HTMLElement>} */
let fbEls = {};
/** @type {?function(Event): void} The window's bmweb-cable listener, registered once. */
let fbCableListener = null;

/**
 * Developer conveniences: files can be loaded and Custom Options opened
 * without a car, as the macOS app's development build allows.
 * @returns {boolean}
 */
function fbDevUi() {
  return !!Settings.get('flashDevUi', false);
}

// ---- the screen ------------------------------------------------------------------------------
/**
 * Render the Flashing/Backups screen.
 * @returns {Promise<void>}
 */
async function showFlashing() {
  lastScreen = showFlashing;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Flashing/Backups' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'flashing';
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: showApps,
    },
  ]);

  fbState.module = null;
  fbState.running = false;
  fbState.page = 'flashing';
  fbState.optionsOpen = false;
  fbState.log = [];
  fbState.lastInPlace = false;
  fbState.dme = fbDmeFreshState();
  fbState.tcu = fbTcuFreshState();

  // no page heading: the breadcrumb names the screen and the Flasher's layout
  // wants the whole window (the log and the pages size themselves to it)
  view.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'fb';
  wrap.innerHTML = `
    <div class="fb-rail">
      <button class="fb-rail-btn current" id="fb-rail-flashing" title="Flashing">&#x21AF;</button>
      <button class="fb-rail-btn" id="fb-rail-history" title="History">&#x27F2;</button>
      <button class="fb-rail-btn" id="fb-rail-settings" title="Settings">&#x2699;&#xFE0E;</button>
    </div>
    <div class="fb-main">
      <div class="fb-topbar">
        <select class="fb-select" id="fb-module">
          <option value="" selected disabled>Control unit...</option>
          <option value="dme">DME (engine)</option>
          <option value="tcu">TCU (transmission)</option>
        </select>
        <div class="fb-ecu" id="fb-ecu">Select a control unit</div>
        <button class="btn primary fb-identify" id="fb-identify" disabled>Identify ECU</button>
      </div>

      <div class="fb-page" id="fb-page-flashing">
        <div class="fb-flashing" id="fb-flashing-main">
          <div class="fb-log-wrap">
            <div class="fb-log" id="fb-log"></div>
            <button class="fb-log-clear" id="fb-log-clear" title="Clear the log">clear</button>
          </div>
          <div class="fb-side">
            <div class="fb-actions" id="fb-actions">
              ${fbDmePanelHtml()}
              ${fbTcuPanelHtml()}
            </div>
            <div class="fb-custom" id="fb-custom" hidden>
              <button class="btn fb-wide" id="fb-custom-open">&#x2699;&#xFE0E; Custom Options</button>
              <div class="fb-faint" id="fb-custom-summary"></div>
            </div>
          </div>
        </div>
        <div class="fb-options" id="fb-options" hidden>
          ${fbOptionsHtml()}
        </div>
      </div>

      <div class="fb-page" id="fb-page-history" hidden>
        <div class="fb-row">
          <button class="btn" id="fb-history-log" disabled>Open Log</button>
          <button class="btn" id="fb-history-files" disabled>Save Files</button>
          <button class="btn danger" id="fb-history-clear">Clear History</button>
          <span class="fb-mono fb-dim" id="fb-history-count"></span>
        </div>
        <div class="fb-table-wrap">
          <table class="fb-table" id="fb-history-table">
            <thead><tr><th>Date</th><th>Operation</th><th>Result</th><th>Car</th><th>Details</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="fb-mono fb-dim" id="fb-history-status">Select a session to see how it ended.</div>
      </div>

      <div class="fb-page" id="fb-page-settings" hidden>
        <div class="fb-section">
          <div class="fb-code">FILES</div>
          <label class="fb-check"><input type="checkbox" id="fb-set-keep"> Keep a copy of every file written to a module</label>
          <div class="fb-dim">Each flash or write session keeps the exact images sent to the module with its History entry; Save Files hands them back. Everything stays in this browser.</div>
        </div>
        <div class="fb-section">
          <div class="fb-code">PROGRAMMING RECORD</div>
          <label class="fb-check"><input type="checkbox" id="fb-set-aif"> Log every flash in the module (AIF)</label>
          <div class="fb-dim">A module keeps 14 entries and they cannot be erased. Before a flash the app says how many are left and asks whether to go on. With this off, nothing is written to the log and no question is asked.</div>
        </div>
        <div class="fb-section">
          <div class="fb-code">TESTING ONLY</div>
          <button class="btn" id="fb-verify-program" disabled>Finish Programming</button>
          <div class="fb-dim">Runs the DME's program and calibration signature checks and resets it; nothing is written. For a DME left in the bootloader by a flash that stopped part-way. Needs an identified DME.</div>
        </div>
        <div class="fb-section">
          <div class="fb-code">DEVELOPMENT</div>
          <label class="fb-check"><input type="checkbox" id="fb-set-dev"> Allow loading files and Custom Options without an identified module</label>
          <div class="fb-dim">For building and checking files on the bench. Every write still needs the car identified.</div>
        </div>
      </div>

      <div class="fb-statusbar">
        <div class="fb-status" id="fb-status">ready</div>
        <div class="fb-bar"><span class="fb-bar-fill" id="fb-fill"></span></div>
      </div>
    </div>`;
  view.appendChild(wrap);

  fbEls = {};
  wrap.querySelectorAll('[id^="fb-"]').forEach((el) => {
    fbEls[el.id.slice(3)] = el;
  });

  fbEls['rail-flashing'].onclick = () => fbShowPage('flashing');
  fbEls['rail-history'].onclick = () => fbShowPage('history');
  fbEls['rail-settings'].onclick = () => fbShowPage('settings');

  fbEls.module.onchange = () => fbModuleChanged();
  fbEls.identify.onclick = () => fbIdentify();
  fbEls['custom-open'].onclick = () => fbOpenOptions();
  fbEls['log-clear'].onclick = () => {
    fbState.log = [];
    fbState.lastInPlace = false;
    fbPaintLog();
  };

  fbEls['set-keep'].checked = !!Settings.get('flashKeepFiles', false);
  fbEls['set-aif'].checked = Settings.get('flashWriteAif', true) !== false;
  fbEls['set-dev'].checked = fbDevUi();
  fbEls['set-keep'].onchange = () =>
    Settings.set('flashKeepFiles', fbEls['set-keep'].checked);
  fbEls['set-aif'].onchange = () =>
    Settings.set('flashWriteAif', fbEls['set-aif'].checked);
  fbEls['set-dev'].onchange = () => {
    Settings.set('flashDevUi', fbEls['set-dev'].checked);
    fbRefreshAll();
  };
  fbEls['verify-program'].onclick = () => fbDmeVerifyProgramming();

  fbEls['history-clear'].onclick = () => fbHistoryClear();
  fbEls['history-log'].onclick = () => fbHistoryOpenLog();
  fbEls['history-files'].onclick = () => fbHistorySaveFiles();
  flashHistory.onChange(() => {
    if (lastScreen === showFlashing) fbHistoryRefresh();
  });

  fbDmeWire();
  fbTcuWire();
  fbOptionsWire();
  fbRefreshAll();
  fbHistoryRefresh();
  fbSetStatus(
    webBus.connected
      ? 'Cable connected'
      : 'No cable connected: Identify will ask for the port'
  );
  // the cable reconnects on its own after a page load, usually a moment after
  // this screen opens; follow it rather than freeze the first answer
  if (!fbCableListener) {
    fbCableListener = (e) => {
      if (lastScreen !== showFlashing || fbState.running || !fbEls.status)
        return;
      fbSetStatus(
        e.detail && e.detail.connected
          ? 'Cable connected'
          : 'Cable disconnected'
      );
    };
    window.addEventListener('bmweb-cable', fbCableListener);
  }
}

/**
 * Show one page (flashing, history, settings) and light its rail glyph.
 * @param {string} page - The page.
 */
function fbShowPage(page) {
  fbState.page = page;
  for (const p of ['flashing', 'history', 'settings']) {
    fbEls[`page-${p}`].hidden = p !== page;
    fbEls[`rail-${p}`].classList.toggle('current', p === page);
  }
  if (page === 'flashing') fbShowOptions(false);
  if (page === 'history') fbHistoryRefresh();
}

/**
 * Switch between the flashing controls and the Custom Options view.
 * @param {boolean} show - True for Custom Options.
 */
function fbShowOptions(show) {
  fbState.optionsOpen = show;
  fbEls['flashing-main'].hidden = show;
  fbEls.options.hidden = !show;
}

// ---- status, log, progress --------------------------------------------------------------------------
function fbStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}  `;
}

function fbPaintLog() {
  if (fbState.log.length > FB_LOG_LINES)
    fbState.log.splice(0, fbState.log.length - FB_LOG_LINES);
  const el = fbEls.log;
  if (!el) return;
  el.textContent = fbState.log.join('\n');
  el.scrollTop = el.scrollHeight;
}

/**
 * The status line, also appended to the log, and kept by a running session
 * as its outcome.
 * @param {string} text - The status.
 */
function fbSetStatus(text) {
  if (!text) return;
  if (fbEls.status) fbEls.status.textContent = text;
  fbState.log.push(fbStamp() + text);
  fbState.lastInPlace = false;
  fbPaintLog();
  flashLog.status(text);
}

/**
 * An engine stage ("opening session", "battery reading unavailable: ...",
 * "erasing 0x090000"): shown as the status and noted in the session, but
 * NOT judged as the session's outcome. The Flasher keeps these as log notes;
 * routing them through the status let "battery request failed" mark a
 * calibration write that finished as failed.
 * @param {string} text - The stage.
 */
function fbSetStage(text) {
  if (!text) return;
  if (fbEls.status) fbEls.status.textContent = text;
  fbState.log.push(fbStamp() + text);
  fbState.lastInPlace = false;
  fbPaintLog();
  flashLog.note(text);
}

/**
 * A progress line (a percentage, an erase count) that replaces the previous
 * progress line in the log rather than adding to it.
 * @param {string} text - The status.
 */
function fbSetStatusInPlace(text) {
  if (!text) return;
  if (fbEls.status) fbEls.status.textContent = text;
  const line = fbStamp() + text;
  if (fbState.lastInPlace && fbState.log.length)
    fbState.log[fbState.log.length - 1] = line;
  else fbState.log.push(line);
  fbState.lastInPlace = true;
  fbPaintLog();
  flashLog.status(text);
}

/**
 * A log-only line (identify's coding data, notes), not the status.
 * @param {string} text - The line.
 */
function fbLog(text) {
  if (!text) return;
  fbState.log.push(fbStamp() + text);
  fbState.lastInPlace = false;
  fbPaintLog();
}

/**
 * The progress bar, 0..100.
 * @param {number} pct - Percent.
 */
function fbProgress(pct) {
  if (fbEls.fill)
    fbEls.fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

/**
 * Colour the bar for a write, so a flash in progress is never mistaken for a read.
 * @param {boolean} flashing - True while writing.
 */
function fbFlashingBar(flashing) {
  if (fbEls.fill) fbEls.fill.classList.toggle('flashing', !!flashing);
}

/**
 * Mark the screen busy: Identify and the module choice lock while the car is
 * being talked to.
 * @param {boolean} busy - True while running.
 */
function fbBusy(busy) {
  fbState.running = !!busy;
  if (!fbEls.identify) return;
  fbEls.identify.disabled = busy || !fbState.module;
  fbEls.module.disabled = busy;
  fbEls.actions.classList.toggle('fb-locked', !!busy);
}

/**
 * The ECU box across the top.
 * @param {string} text - What to show.
 */
function fbSetEcuBox(text) {
  if (fbEls.ecu) fbEls.ecu.textContent = text;
}

// ---- dialogs ----------------------------------------------------------------------------------------
function fbHtml(text) {
  return esc(String(text || '')).replace(/\n/g, '<br>');
}

/**
 * Yes / No, defaulting to No: every one of these guards against writing the wrong thing.
 * @param {string} message - The question.
 * @param {string} title - The dialog title.
 * @returns {Promise<boolean>}
 */
function fbConfirm(message, title) {
  return confirmDialog({
    title: esc(title),
    body: fbHtml(message),
    confirmLabel: 'Yes',
    cancelLabel: 'No',
  });
}

/**
 * One OK button.
 * @param {string} message - The message.
 * @param {string} [title] - The dialog title.
 * @returns {Promise<void>}
 */
async function fbMessage(message, title = 'Flashing/Backups') {
  await messageDialog({ title: esc(title), body: fbHtml(message) });
}

/**
 * Several named choices. Resolves the index pressed, or -1 when dismissed.
 * @param {string} message - The question.
 * @param {string} title - The dialog title.
 * @param {string[]} choices - The buttons.
 * @returns {Promise<number>}
 */
function fbChoose(message, title, choices) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(
      `<div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${esc(title)}</div>
        <div class="modal-body">${fbHtml(message)}</div>
        <div class="modal-actions fb-modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          ${choices.map((c, i) => `<button class="btn fb-choice" data-i="${i}">${esc(c)}</button>`).join('')}
        </div>
      </div>`,
      { onClose: resolve, backdropValue: -1 }
    );
    overlay.querySelector('.modal-cancel').onclick = () => close(-1);
    overlay.querySelectorAll('.fb-choice').forEach((b) => {
      b.onclick = () => close(Number(b.dataset.i));
    });
  });
}

/**
 * A confirmation that will not proceed until the warning is ticked.
 * @param {string} message - The warning.
 * @param {string} acknowledgement - The checkbox text.
 * @param {string} title - The dialog title.
 * @returns {Promise<boolean>}
 */
function fbConfirmAck(message, acknowledgement, title) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(
      `<div class="modal danger" role="dialog" aria-modal="true">
        <div class="modal-title">${esc(title)}</div>
        <div class="modal-body">${fbHtml(message)}
          <label class="fb-check fb-ack"><input type="checkbox" class="fb-ack-box"> ${esc(acknowledgement)}</label>
        </div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn danger modal-confirm" disabled>Confirm</button>
        </div>
      </div>`,
      { onClose: resolve, backdropValue: false }
    );
    const box = overlay.querySelector('.fb-ack-box');
    const go = overlay.querySelector('.modal-confirm');
    box.onchange = () => {
      go.disabled = !box.checked;
    };
    overlay.querySelector('.modal-cancel').onclick = () => close(false);
    go.onclick = () => close(true);
  });
}

/**
 * The error's message chain as plain text, the inner one not repeated when
 * the outer already quotes it.
 * @param {any} e - The error.
 * @returns {string}
 */
function fbDescribeError(e) {
  const parts = [];
  for (let x = e; x; x = x.cause) {
    const m = ((x && x.message) || String(x) || '').trim();
    if (!m) continue;
    if (parts.length && parts[parts.length - 1].includes(m)) continue;
    parts.push(m);
    if (!(x instanceof Error)) break;
  }
  return parts.join('\n\n') || 'unknown error';
}

// ---- files -----------------------------------------------------------------------------------------
/**
 * Open the browser's file picker.
 * @param {string} accept - The accept attribute.
 * @returns {Promise<File|null>}
 */
function fbPickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept || '';
    input.hidden = true;
    document.body.appendChild(input);
    let done = false;
    const finish = (f) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(f || null);
    };
    input.onchange = () => finish(input.files && input.files[0]);
    // a cancelled picker fires nothing in most browsers: catch the focus coming back
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => finish(input.files && input.files[0]), 400);
      },
      { once: true }
    );
    input.click();
  });
}

/**
 * @param {File} file - A picked file.
 * @returns {Promise<Uint8Array>}
 */
async function fbReadBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * The file as Latin-1 text (BMW's exchange files carry umlauts in their headers).
 * @param {File} file - A picked file.
 * @returns {Promise<string>}
 */
async function fbReadText(file) {
  return new TextDecoder('latin1').decode(await file.arrayBuffer());
}

/**
 * Hand bytes to the browser as a download.
 * @param {string} name - The file name.
 * @param {Uint8Array|string} data - The bytes, or text.
 */
function fbSaveBytes(name, data) {
  const blob = new Blob([data], {
    type: typeof data === 'string' ? 'text/plain' : 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Make sure the cable is connected, asking the browser for the port when it
 * is not (this must run from a click).
 * @returns {Promise<boolean>}
 */
async function fbEnsureCable() {
  if (webBus.connected) return true;
  try {
    await webBus.connect();
  } catch (e) {
    await fbMessage(
      `The cable could not be opened.\n\n${fbDescribeError(e)}`,
      'Cable'
    );
    return false;
  }
  return !!webBus.connected;
}

// ---- sessions ---------------------------------------------------------------------------------------
/**
 * Begin a logged session: every job and every wire trace goes to it until fbSessionStop.
 * @param {string} operation - e.g. flash-tune.
 * @param {{vin?: string, module?: string}} [car] - The car.
 * @returns {Promise<void>}
 */
async function fbSessionStart(operation, car) {
  await flashLog.start(operation, car);
  ms45SetJobTrace((job, arg, status, tx, rx) =>
    flashLog.job(job, arg, status, tx, rx)
  );
}

/** End the session and refresh History. @returns {Promise<void>} */
async function fbSessionStop() {
  ms45SetJobTrace(null);
  await flashLog.stop();
}

// ---- the module choice and Identify ------------------------------------------------------------------
function fbModuleChanged() {
  const m = fbEls.module.value || null;
  fbState.module = m;
  fbShowOptions(false);
  fbDmeReset();
  fbTcuReset();
  fbEls.identify.disabled = !m;
  fbEls.identify.textContent = 'Identify';
  fbSetEcuBox(
    m === 'tcu'
      ? 'TCU not identified'
      : m === 'dme'
        ? 'DME not identified'
        : 'Select a control unit'
  );
  fbRefreshAll();
  if (m)
    fbSetStatus(
      `Module: ${m === 'tcu' ? 'TCU (transmission)' : 'DME (engine)'}`
    );
}

async function fbIdentify() {
  if (!fbState.module || fbState.running) return;
  if (!(await fbEnsureCable())) return;
  fbProgress(0);
  fbBusy(true);
  fbEls.identify.textContent = 'Identifying...';
  fbEls.fill.classList.add('indeterminate');
  fbSetStatus(
    fbState.module === 'tcu'
      ? 'Identifying the TCU...'
      : 'Identifying the DME...'
  );
  try {
    if (fbState.module === 'tcu') await fbTcuIdentify();
    else await fbDmeIdentify();
  } catch (e) {
    fbSetStatus(`Identify failed: ${(e && e.message) || e}`);
    await fbMessage(fbDescribeError(e), 'Identify');
  } finally {
    fbEls.fill.classList.remove('indeterminate');
    fbEls.identify.textContent = 'Identify';
    fbBusy(false);
    fbProgress(0);
    fbRefreshAll();
  }
}

/** Every gate re-evaluated: the panels, the names under the buttons, Custom Options. */
function fbRefreshAll() {
  if (!fbEls.actions) return;
  fbEls['dme-panel'].hidden = fbState.module !== 'dme';
  fbEls['tcu-panel'].hidden = fbState.module !== 'tcu';
  fbDmeRefresh();
  fbTcuRefresh();
  fbRefreshCustomOptionsGate();
  fbEls['verify-program'].disabled = !(fbState.dme && fbState.dme.identified);
}

/**
 * Whether the Custom Options button is offered: a development toggle shows
 * it always; otherwise only an identified MS45.1 on the program the options
 * were built for, or an identified GS20.
 * @returns {boolean}
 */
function fbCustomOptionsAllowed() {
  if (fbDevUi()) return !!fbState.module;
  if (fbState.module === 'tcu') return fbState.tcu.sgbd === 'gs20';
  if (fbState.module === 'dme') {
    const d = fbState.dme;
    return (
      d.identified &&
      d.ident.hwRef === '0044570' &&
      !!d.ident.progRef &&
      d.ident.progRef.includes(ewsDelete.SUPPORTED_PROGRAM_VERSION)
    );
  }
  return false;
}

function fbRefreshCustomOptionsGate() {
  const allowed = fbCustomOptionsAllowed();
  fbEls.custom.hidden = !allowed;
  fbEls['custom-open'].title =
    fbState.module === 'tcu'
      ? 'Remove auto upshift.'
      : 'EWS delete and map switch.';
  if (!allowed) fbShowOptions(false);
  fbOptionsRefreshSummary();
}

function fbOpenOptions() {
  if (!fbCustomOptionsAllowed()) return;
  fbOptionsShowFor(fbState.module);
  fbShowOptions(true);
}

// ---- the programming counter question and the AIF entry ------------------------------------------------
/**
 * The question before a flash: how many programming entries the module has
 * left, whether to go on, and which VIN to put in the entry. Nothing to ask
 * when the programming record is switched off.
 * @param {boolean} tcu - Which module.
 * @returns {Promise<boolean>} Whether to go on; the typed VIN is kept in fbState.aifVin.
 */
function fbProgrammingCounter(tcu) {
  fbState.aifVin = '';
  if (Settings.get('flashWriteAif', true) === false)
    return Promise.resolve(true);
  const module = tcu ? 'transmission' : 'DME';
  const aif = tcu ? fbState.tcu.aif : fbState.dme.aif;
  const free = parseInt((aif && aif.AIF_ANZ_FREI) || '', 10);
  const known = Number.isFinite(free);
  const counter = !known
    ? `The ${module}'s programming counter could not be read; an entry is written if it has room.`
    : free <= 0
      ? `The ${module}'s programming log is full: 0 of ${FB_AIF_SLOTS} entries left. The flash can still go ahead, but no entry can be written for it.`
      : `Remaining programming operations for this ${module}: ${free} of ${FB_AIF_SLOTS}. This flash uses one; the entries cannot be erased.`;
  const dmeAif = (fbState.dme && fbState.dme.aif) || {};
  let suggested = dmeAif.AIF_FG_NR_LANG || '';
  if (!fbIsAlnum(suggested, 17))
    suggested = (aif && (aif.AIF_FG_NR_LANG || aif.AIF_FG_NR)) || '';
  if (!fbIsAlnum(suggested, 17) && !fbIsAlnum(suggested, 7))
    suggested =
      (fbState.dme && fbState.dme.ident && fbState.dme.ident.vin) || '';

  return new Promise((resolve) => {
    const { overlay, close } = openModal(
      `<div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">Programming counter</div>
        <div class="modal-body">${fbHtml(counter)}
          <div class="fb-field-label">VIN for the entry (optional)</div>
          <input class="modal-input fb-vin" type="text" maxlength="17" value="${esc(suggested)}" placeholder="17 characters, or leave empty">
          <div class="fb-dim fb-vin-hint"></div>
        </div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn primary modal-confirm">Continue</button>
        </div>
      </div>`,
      {
        backdropValue: false,
        onClose: (v) => resolve(!!v),
      }
    );
    const box = overlay.querySelector('.fb-vin');
    const hint = overlay.querySelector('.fb-vin-hint');
    const go = overlay.querySelector('.modal-confirm');
    const validate = () => {
      const v = (box.value || '').trim().toUpperCase();
      const ok =
        v.length === 0 || fbIsAlnum(v, 17) || (!tcu && fbIsAlnum(v, 7));
      go.disabled = !ok;
      hint.textContent =
        v.length === 0
          ? tcu
            ? 'Empty: the entry is written with the VIN already known, if there is one.'
            : "Empty: the last entry's VIN is kept."
          : ok
            ? ''
            : tcu
              ? 'A transmission entry needs all 17 characters.'
              : '7 or 17 letters and digits.';
    };
    box.oninput = validate;
    validate();
    overlay.querySelector('.modal-cancel').onclick = () => close(false);
    go.onclick = () => {
      fbState.aifVin = (box.value || '').trim().toUpperCase();
      close(true);
    };
    box.focus();
  });
}

/**
 * @param {string} s - A string.
 * @param {number} n - The exact length wanted.
 * @returns {boolean}
 */
function fbIsAlnum(s, n) {
  return !!s && s.length === n && /^[0-9A-Za-z]+$/.test(s);
}

/**
 * Append the DME's programming entry through the SGBD's own job. The previous
 * entry's values are carried forward; today's date, the program reference and
 * the typed VIN fill in what changed. Never fatal: the flash itself is done.
 *
 * Must run while the DME is still in programming mode (security access +
 * diagnose_mode ECUPM), i.e. after the last block is written and before
 * ms45FinishFlash: the job's $3D WriteMemoryByAddress into the AIF area is
 * refused with ERROR_ECU_SERVICE_NOT_SUPPORTED_IN_ACTIVE_DIAGNOSTIC_MODE in
 * the default session, before or after the reset and whether or not the
 * SGBD's INITIALISIERUNG ran again (seen on the car, and reproduced against
 * the firmware in the emulator: only 10 85 opens the service).
 * @param {string} [progRef] - The program reference of the image just
 *   written, when it differs from the one identified before the flash.
 * @returns {Promise<void>}
 */
async function fbWriteAif(progRef) {
  if (Settings.get('flashWriteAif', true) === false) return;
  const d = fbState.dme;
  const aif = d.aif || {};
  const a = (f) => aif[f] || '';
  const sevenOrNine = (s, fb) => (fbIsAlnum(s, 7) || fbIsAlnum(s, 9) ? s : fb);
  let vin = fbState.aifVin || '';
  if (!fbIsAlnum(vin, 17) && !fbIsAlnum(vin, 7)) vin = a('AIF_FG_NR_LANG');
  if (!fbIsAlnum(vin, 17)) vin = d.ident.vin || '';
  if (!fbIsAlnum(vin, 17) && !fbIsAlnum(vin, 7)) {
    flashLog.note(`AIF not written: no usable VIN (${vin})`);
    return;
  }
  const zb = sevenOrNine(a('AIF_ZB_NR'), '0000000');
  const sw = sevenOrNine(a('AIF_SW_NR'), sevenOrNine(d.ident.swRef, '0000000'));
  const approval = sevenOrNine(a('AIF_BEHOERDEN_NR'), '0000000');
  const dealer = /^\d{6}$/.test(a('AIF_HAENDLER_NR'))
    ? a('AIF_HAENDLER_NR')
    : '000000';
  if (!fbIsAlnum(progRef, 12)) {
    progRef = fbIsAlnum(d.ident.progRef, 12)
      ? d.ident.progRef
      : fbIsAlnum(a('AIF_PROG_NR'), 12)
        ? a('AIF_PROG_NR')
        : '000000000000';
  }
  let km = parseInt(a('AIF_KM'), 10);
  if (!Number.isFinite(km) || km < 0) km = 0;
  if (km > 152999) km = 152999;
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const args = [
    vin,
    `${p(now.getDate())}.${p(now.getMonth() + 1)}.${now.getFullYear()}`,
    zb,
    sw,
    approval,
    dealer,
    fbTesterSerial,
    String(km),
    progRef,
  ].join(';');
  fbSetStatus('Writing the programming record (AIF)');
  const r = await ms45WriteAif(args);
  const outcome = r.ok
    ? `AIF written${r.number ? ` (entry ${r.number})` : ''}`
    : `AIF not written: ${r.status}`;
  flashLog.note(`${outcome} [${args}]`);
  fbSetStatus(outcome);
}

// ---- History ----------------------------------------------------------------------------------------
let fbHistoryRows = [];
let fbHistorySelected = null;

async function fbHistoryRefresh() {
  if (!fbEls['history-table']) return;
  fbHistoryRows = await flashHistory.load();
  const tbody = fbEls['history-table'].querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of fbHistoryRows) {
    const tr = document.createElement('tr');
    const when = new Date(r.started);
    const p = (n) => String(n).padStart(2, '0');
    tr.innerHTML =
      `<td class="fb-mono">${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}:${p(when.getMinutes())}</td>` +
      `<td>${esc(flashHistory.describe(r.operation))}</td>` +
      `<td class="fb-result-${esc(r.result || 'ended')}">${esc(r.result || '')}</td>` +
      `<td class="fb-mono">${esc([r.vin, r.module].filter(Boolean).join(' '))}</td>` +
      `<td class="fb-details">${esc(r.details || '')}</td>`;
    tr.onclick = () => {
      tbody.querySelectorAll('tr').forEach((x) => x.classList.remove('active'));
      tr.classList.add('active');
      fbHistorySelected = r;
      fbEls['history-status'].textContent =
        (r.status || '') + (r.seconds > 0 ? `  (${r.seconds} s)` : '');
      fbEls['history-log'].disabled = !r.hasLog;
      fbEls['history-files'].disabled = !r.fileCount;
    };
    tbody.appendChild(tr);
  }
  fbHistorySelected = null;
  fbEls['history-count'].textContent =
    fbHistoryRows.length === 1
      ? '1 session'
      : `${fbHistoryRows.length} sessions`;
  fbEls['history-log'].disabled = true;
  fbEls['history-files'].disabled = true;
  fbEls['history-status'].textContent = 'Select a session to see how it ended.';
}

async function fbHistoryOpenLog() {
  if (!fbHistorySelected) return;
  const full = await flashHistory.get(fbHistorySelected.id);
  if (!full || !full.log) return;
  const d = new Date(full.started);
  const p = (n) => String(n).padStart(2, '0');
  const name = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${full.operation}.log`;
  fbSaveBytes(name, full.log);
}

async function fbHistorySaveFiles() {
  if (!fbHistorySelected) return;
  const full = await flashHistory.get(fbHistorySelected.id);
  if (!full || !full.files || !full.files.length) return;
  for (const f of full.files) fbSaveBytes(f.name, f.bytes);
}

async function fbHistoryClear() {
  if (
    !(await fbConfirm(
      'Forget every session in the history, with its log and the saved copies of the flashed files?',
      'Clear History'
    ))
  )
    return;
  await flashHistory.clear();
}

if (typeof window !== 'undefined') {
  window.showFlashing = showFlashing;
}
