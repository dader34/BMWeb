/**
 * @file The Fault codes rail page: the chosen module's fault memory -- the
 * DME over ms450ds0, the transmission over the SGBD Identify found -- read
 * with the jobs the fault screens and the tuning editor's fault window use
 * (FS_LESEN, FS_LESEN_DETAIL per fault for its freeze frame, FS_LOESCHEN),
 * so the codes and names are the ones the rest of the app shows. Live scan
 * reads the memory again every few seconds; Save CSV keeps what is listed.
 *
 * The page talks to the car the way the rest of this app does: through the
 * job runner (the owner's on a shared car), the cable checked first, the
 * screen marked busy so Identify and a flash cannot start mid-read, and the
 * outcome on the status line and in the log.
 */
/* exported fbFaultsPageHtml, fbFaultsWire, fbFaultsShow, fbFaultsLeave, fbFaultsPaint, fbFaultsReset, fbFaultsClearAfterFlash, fbFaultsClearAfterFlashWanted */

/** The DME's SGBD: the one every DME flow of this app runs on. */
const FB_FAULTS_DME_SGBD = 'ms450ds0';
/** Rest between two reads of a live scan. */
const FB_FAULTS_SCAN_MS = 4000;

/** The page's state: what was read, from which module. */
const fbFaults = {
  /** The SGBD the rows were read from ('' until a read). */
  sgbd: '',
  /** @type {Array<{code:string, pcode:string, name:string, present:boolean, ftype:string, count:string|number, km:string, warn:string, env:Array<[string,string]>}>} */
  rows: [],
  /** @type {?Date} */
  readAt: null,
  reading: false,
  scan: false,
  /** @type {?ReturnType<typeof setTimeout>} */
  timer: null,
  error: '',
  /** The transmission variant a clear after a flash found answering, when Identify had not named one. */
  tcuSgbd: '',
};

/** @returns {string} The page's markup. */
function fbFaultsPageHtml() {
  return `
      <div class="fb-page" id="fb-page-faults" hidden>
        <div class="fb-section">
          <div class="fb-code">FAULT MEMORY</div>
          <div class="fb-row">
            <button class="btn primary" id="fb-dtc-read" disabled>Read Faults</button>
            <button class="btn" id="fb-dtc-csv" disabled>Save CSV</button>
            <button class="btn danger" id="fb-dtc-clear" disabled>Clear Faults</button>
            <span class="fb-faults-status" id="fb-dtc-status"></span>
          </div>
          <div class="fb-faults-opts">
            <label class="fb-check" title="Read each fault's freeze frame as well: P-code, mileage, the values at code entry"><input type="checkbox" id="fb-dtc-detail"> Freeze frames</label>
            <label class="fb-check" title="Read the fault memory again every few seconds while this page is open"><input type="checkbox" id="fb-dtc-scan" disabled> Live scan</label>
          </div>
        </div>
        <div class="fb-table-wrap">
          <div class="fb-dtc-list" id="fb-dtc-list"></div>
        </div>
      </div>`;
}

/** Wire the page's controls once the screen is built. */
function fbFaultsWire() {
  fbEls['dtc-read'].onclick = () => fbFaultsRead();
  fbEls['dtc-clear'].onclick = () => fbFaultsClear();
  fbEls['dtc-csv'].onclick = () => fbFaultsSaveCsv();
  fbEls['dtc-detail'].checked = fbFaultsDetailWanted();
  fbEls['dtc-detail'].onchange = () =>
    Settings.set('flashFaultDetail', fbEls['dtc-detail'].checked);
  fbEls['dtc-scan'].checked = fbFaults.scan;
  fbEls['dtc-scan'].onchange = () => {
    fbFaults.scan = fbEls['dtc-scan'].checked;
    fbFaultsSchedule();
  };
  fbFaultsPaint();
}

/** Whether a read also fetches each fault's freeze frame (off unless switched on). */
function fbFaultsDetailWanted() {
  return Settings.get('flashFaultDetail', false) === true;
}

/**
 * The SGBD the chosen module's faults are read over: the DME's always, the
 * transmission's once Identify has found which variant answers.
 * @returns {string} The SGBD, or '' when there is none to read.
 */
function fbFaultsSgbd() {
  if (fbState.module === 'dme') return FB_FAULTS_DME_SGBD;
  if (fbState.module === 'tcu') return (fbState.tcu && fbState.tcu.sgbd) || '';
  return '';
}

/** The chosen module's name for the status line and the dialogs. */
function fbFaultsModuleName() {
  return fbState.module === 'tcu' ? 'TCU' : 'DME';
}

/**
 * The job runner: on a shared car the owner's (webRunJobAnywhere), else
 * this machine's webRunJob -- the same choice the transmission flows make.
 * @returns {(sgbd: string, job: string, arg: string) => Promise<{sets?: object[]}>}
 */
function fbFaultsRunner() {
  return typeof webRunJobAnywhere === 'function'
    ? webRunJobAnywhere
    : webRunJob;
}

/** Whether the page is open on a module whose memory can be read now. */
function fbFaultsMayRead() {
  return (
    !!fbFaultsSgbd() &&
    !fbFaults.reading &&
    !fbState.running &&
    fbState.page === 'faults'
  );
}

/** The page shown: paint it and start the live scan if it is ticked. */
function fbFaultsShow() {
  fbFaultsPaint();
  fbFaultsSchedule();
}

/** The page left: the live scan rests until it is shown again. */
function fbFaultsLeave() {
  clearTimeout(fbFaults.timer);
  fbFaults.timer = null;
}

/**
 * The module choice changed: the rows belonged to the old one.
 * @returns {void}
 */
function fbFaultsReset() {
  fbFaults.sgbd = '';
  fbFaults.rows = [];
  fbFaults.readAt = null;
  fbFaults.error = '';
  fbFaultsPaint();
}

/** Queue the next read of a live scan. */
function fbFaultsSchedule() {
  clearTimeout(fbFaults.timer);
  fbFaults.timer = null;
  if (!fbFaults.scan || fbState.page !== 'faults') return;
  fbFaults.timer = setTimeout(async () => {
    if (!document.hidden && fbFaultsMayRead()) await fbFaultsRead(true);
    fbFaultsSchedule();
  }, FB_FAULTS_SCAN_MS);
}

/**
 * One fault as the table lists it: the shared projection (code, name,
 * present/stored, type, count) plus what a detail read adds -- the mileage
 * the fault was stored at and the freeze frame.
 * @param {object} c - The fault entry as the job answered it.
 * @param {string} sgbd - The SGBD it was read from.
 * @returns {object} The row.
 */
function fbFaultsRow(c, sgbd) {
  const f = faultFields(c, sgbd);
  let km = '';
  for (const k of ['F_UW_KM', 'F_KM_STAND', 'F_KM']) {
    const v = c[k];
    if (v == null || String(v).trim() === '') continue;
    km = String(v).replace(/[^0-9]/g, '');
    if (km) break;
  }
  return {
    ...f,
    // a module with no type to report answers "-" / "--": nothing to show
    ftype: /^-*$/.test(f.ftype || '') ? '' : f.ftype,
    km,
    warn:
      typeof phraseText === 'function'
        ? phraseText(c.F_WARNUNG_TEXT || '')
        : '',
    env: typeof envPairs === 'function' ? envPairs(c) : [],
  };
}

/**
 * Read FS_LESEN_DETAIL per fault and merge its fields onto the entry: the
 * P-code, the mileage, the freeze frame. A fault whose detail read fails
 * keeps what the base read said.
 * @param {string} sgbd - The SGBD.
 * @param {object[]} faults - The base entries, enriched in place.
 * @returns {Promise<void>}
 */
async function fbFaultsFillDetail(sgbd, faults) {
  const run = fbFaultsRunner();
  for (const f of faults) {
    if (f.F_ORT_NR == null) continue;
    try {
      const det = await run(sgbd, 'FS_LESEN_DETAIL', String(f.F_ORT_NR));
      const sets = det && det.sets ? det.sets : [];
      const dset =
        typeof matchDetail === 'function'
          ? matchDetail(sets, f.F_ORT_NR)
          : sets.find((s) => s && s.F_ORT_NR == f.F_ORT_NR) || null;
      if (dset) {
        const { F_HEX_CODE: _hex, F_ORT_TEXT: _ort, ...rich } = dset;
        Object.assign(f, rich);
      }
    } catch {
      /* the base entry stands */
    }
  }
}

/**
 * Read the fault memory and list it.
 * @param {boolean} [quiet] - A live scan's read: no busy lock on the
 *   screen's clock and buttons, nothing added to the log; the line is still
 *   held so nothing else starts on it.
 * @returns {Promise<void>}
 */
async function fbFaultsRead(quiet = false) {
  if (fbFaults.reading || fbState.running) return;
  const sgbd = fbFaultsSgbd();
  if (!sgbd) return;
  if (!(await fbEnsureCable())) return;
  const shared = fbOnSharedCar();
  fbFaults.reading = true;
  fbFaults.error = '';
  if (quiet) fbState.running = true;
  else fbBusy(true);
  if (shared) webSetRemoteAction(fbRemoteAction('read-faults'));
  if (!quiet)
    fbSetStatus(`Reading the ${fbFaultsModuleName()}'s fault memory...`);
  fbFaultsPaint();
  try {
    if (typeof loadFaultDb === 'function') loadFaultDb(); // names, while the bus works
    const arg =
      typeof faultReadArg === 'function' ? await faultReadArg(sgbd) : '';
    const base = await fbFaultsRunner()(sgbd, 'FS_LESEN', arg || '');
    const faults = dataSets(base.sets).filter(
      (c) => c.F_HEX_CODE || c.F_ORT_NR
    );
    if (fbFaultsDetailWanted()) await fbFaultsFillDetail(sgbd, faults);
    if (typeof loadFaultDb === 'function') await loadFaultDb();
    fbFaults.rows = faults.map((c) => fbFaultsRow(c, sgbd));
    fbFaults.sgbd = sgbd;
    fbFaults.readAt = new Date();
    if (!quiet) {
      for (const r of fbFaults.rows)
        fbLog(
          `  ${r.code}${r.pcode ? ` (${r.pcode})` : ''}  ${r.name || ''}  ·  ${r.present ? 'present' : 'stored'}${r.count ? ` · ${r.count}x` : ''}${r.km ? ` · ${r.km} km` : ''}`
        );
      const n = fbFaults.rows.length;
      fbSetStatus(
        n
          ? `${n} fault${n === 1 ? '' : 's'} stored in the ${fbFaultsModuleName()}`
          : `No faults stored in the ${fbFaultsModuleName()}`
      );
    }
  } catch (e) {
    fbFaults.error = fbDescribeError(e);
    if (!quiet) fbSetStatus(`Fault read failed: ${fbFaults.error}`);
  } finally {
    fbFaults.reading = false;
    if (shared) webSetRemoteAction(null);
    if (quiet) fbState.running = false;
    else fbBusy(false);
    fbFaultsPaint();
  }
}

/**
 * Clear the fault memory (asked first), then read it again so a fault that
 * set itself straight back shows instead of hiding behind "cleared".
 * @returns {Promise<void>}
 */
async function fbFaultsClear() {
  if (fbFaults.reading || fbState.running) return;
  const sgbd = fbFaultsSgbd();
  if (!sgbd) return;
  const name = fbFaultsModuleName();
  const ok = await fbConfirm(
    `Clear the ${name}'s fault memory?\n\nEvery stored fault and its freeze frame is erased. Save the list first if you want a record.`,
    'Clear faults'
  );
  if (!ok) return;
  if (!(await fbEnsureCable())) return;
  const shared = fbOnSharedCar();
  fbFaults.reading = true;
  fbFaults.error = '';
  fbBusy(true);
  if (shared) webSetRemoteAction(fbRemoteAction('clear-faults'));
  fbSetStatus(`Clearing the ${name}'s fault memory...`);
  fbFaultsPaint();
  try {
    await fbFaultsRunner()(sgbd, 'FS_LOESCHEN', '');
    fbSetStatus(`${name} fault memory cleared`);
  } catch (e) {
    fbFaults.error = `could not clear: ${fbDescribeError(e)}`;
    fbSetStatus(`Clear failed: ${fbDescribeError(e)}`);
  } finally {
    fbFaults.reading = false;
    if (shared) webSetRemoteAction(null);
    fbBusy(false);
    fbFaultsPaint();
  }
  if (!fbFaults.error) await fbFaultsRead();
}

/**
 * What is listed, as CSV text.
 * @returns {string}
 */
function fbFaultsCsv() {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const at = fbFaults.readAt ? fbFaults.readAt.toISOString() : '';
  const lines = [
    [
      'module',
      'code',
      'p_code',
      'fault',
      'status',
      'type',
      'count',
      'mileage_km',
      'freeze_frame',
      'read_at',
    ].join(','),
  ];
  for (const r of fbFaults.rows)
    lines.push(
      [
        fbFaults.sgbd,
        r.code,
        r.pcode,
        r.name,
        r.present ? 'present' : 'stored',
        r.ftype,
        r.count,
        r.km,
        r.env.map(([k, v]) => `${k}: ${v}`).join('; '),
        at,
      ]
        .map(cell)
        .join(',')
    );
  return lines.join('\n') + '\n';
}

/** Save the list as a CSV file. */
function fbFaultsSaveCsv() {
  if (!fbFaults.readAt) return;
  const stamp = fbFaults.readAt.toISOString().replace(/[:.]/g, '-');
  fbSaveBytes(
    `${fbFaultsModuleName().toLowerCase()}-faults-${stamp}.csv`,
    fbFaultsCsv()
  );
}

/**
 * A fault's name without the code the database prefixes it with ("27DA
 * BSD-Generator" -> "BSD-Generator"): the code has its own column.
 * @param {{code: string, name: string}} r - The row.
 * @returns {string}
 */
function fbFaultsNameText(r) {
  const name = r.name || '';
  return r.code && name.startsWith(`${r.code} `)
    ? name.slice(r.code.length + 1)
    : name;
}

/**
 * A mileage with thousands separators ("183432" -> "183,432").
 * @param {string} km - Digits.
 * @returns {string}
 */
function fbFaultsKmText(km) {
  const n = Number(km);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : km;
}

/**
 * One fault as the table lists it -- the tuning editor's fault window's
 * row: code with the P-code beside it, the name, present/stored with the
 * type and the lamp, the count; the mileage when a detail read gave one,
 * and under the row its freeze frame as one faint line.
 * @param {object} r - The row (fbFaultsRow).
 * @param {boolean} km - Whether the table has a mileage column.
 * @returns {string} The markup.
 */
function fbFaultsRowHtml(r, km) {
  const cols = km ? 5 : 4;
  const warn = r.warn && !/^(no|keine) mil/i.test(r.warn) ? r.warn : '';
  const status = [r.present ? 'present' : 'stored', r.ftype, warn]
    .filter(Boolean)
    .join(' · ');
  const env = r.env.length
    ? `<tr class="fb-faults-env"><td colspan="${cols}">${r.env
        .map(
          ([k, v]) =>
            `<span class="fb-faults-kv"><span class="fb-faults-k">${esc(k)}</span> ${esc(v)}</span>`
        )
        .join('')}</td></tr>`
    : '';
  return (
    `<tr class="${r.present ? 'present' : ''}${env ? ' fb-faults-has-env' : ''}">` +
    `<td class="mono">${esc(r.code)}${r.pcode ? ` <span class="tn-faults-p">${esc(r.pcode)}</span>` : ''}</td>` +
    `<td>${esc(fbFaultsNameText(r))}</td>` +
    `<td>${esc(status)}</td>` +
    `<td class="mono">${esc(String(r.count || ''))}</td>` +
    (km
      ? `<td class="mono">${r.km ? esc(fbFaultsKmText(r.km)) : ''}</td>`
      : '') +
    '</tr>' +
    env
  );
}

/** Whether a finished flash clears the module's fault memory (Settings, off unless switched on). */
function fbFaultsClearAfterFlashWanted() {
  return Settings.get('flashClearFaults', false) === true;
}

/**
 * The transmission SGBDs a clear after a flash tries: the one Identify
 * found, else the E46 auto-TCU variants (tcu.js's list), the one that
 * answered last time first.
 * @returns {string[]}
 */
function fbFaultsTcuCandidates() {
  const t = fbState.tcu;
  if (t && t.sgbd) return [t.sgbd];
  const all =
    typeof FB_TCU_VARIANTS !== 'undefined' ? FB_TCU_VARIANTS : ['gs20'];
  const known = fbFaults.tcuSgbd;
  return known ? [known, ...all.filter((v) => v !== known)] : all.slice();
}

/**
 * Whether a job's answer is a success: no JOB_STATUS, or OKAY.
 * @param {{sets?: object[]}} r - The job result.
 * @returns {boolean}
 */
function fbFaultsJobOk(r) {
  for (const set of (r && r.sets) || [])
    if (set && set.JOB_STATUS != null)
      return String(set.JOB_STATUS).trim() === 'OKAY';
  return true;
}

/**
 * After a write that succeeded: clear BOTH modules' fault memories, when
 * the setting asks for it -- the one just written first, then the other,
 * which lost it on the bus meanwhile and logged that. Called inside the
 * flash session (so the jobs are logged with it) once the module answers
 * again, and never touches the session's outcome: a clear that fails is a
 * log line, not a failed flash.
 * @param {'dme'|'tcu'} module - The module just written.
 * @returns {Promise<boolean>} True when at least one memory was cleared.
 */
async function fbFaultsClearAfterFlash(module) {
  if (!fbFaultsClearAfterFlashWanted()) return false;
  const note = (text) => {
    if (typeof flashLog !== 'undefined') flashLog.note(text);
  };
  const run = fbFaultsRunner();
  let cleared = false;
  const dme = async () => {
    try {
      if (fbFaultsJobOk(await run(FB_FAULTS_DME_SGBD, 'FS_LOESCHEN', ''))) {
        cleared = true;
        fbLog('DME fault memory cleared after the flash');
        note(`${FB_FAULTS_DME_SGBD} FS_LOESCHEN: DME fault memory cleared`);
      } else {
        fbLog('DME fault memory not cleared after the flash: the DME refused');
        note(`${FB_FAULTS_DME_SGBD} FS_LOESCHEN refused`);
      }
    } catch (e) {
      fbLog(
        `DME fault memory not cleared after the flash: ${fbDescribeError(e)}`
      );
      note(`DME fault clear failed: ${(e && e.message) || e}`);
    }
  };
  const tcu = async () => {
    let answered = '';
    for (const sgbd of fbFaultsTcuCandidates()) {
      try {
        if (fbFaultsJobOk(await run(sgbd, 'FS_LOESCHEN', ''))) {
          cleared = true;
          fbFaults.tcuSgbd = sgbd;
          fbLog(`TCU (${sgbd}) fault memory cleared after the flash`);
          note(`${sgbd} FS_LOESCHEN: TCU fault memory cleared`);
          return;
        }
        answered = `${sgbd} refused`;
      } catch (e) {
        /* this variant is not on the car: the next is tried */
      }
    }
    const why = answered || 'no transmission answered';
    fbLog(`TCU fault memory not cleared after the flash: ${why}`);
    note(`TCU fault clear failed: ${why}`);
  };
  if (module === 'tcu') {
    await tcu();
    await dme();
  } else {
    await dme();
    await tcu();
  }
  fbFaultsReset(); // what the page listed was the memory before the flash
  return cleared;
}

/** Redraw the page from its state: the gates, the status line, the table. */
function fbFaultsPaint() {
  const e = fbEls;
  if (!e || !e['dtc-read']) return;
  const sgbd = fbFaultsSgbd();
  const busy = fbFaults.reading || fbState.running;
  e['dtc-read'].disabled = !sgbd || busy;
  e['dtc-clear'].disabled = !sgbd || busy;
  e['dtc-scan'].disabled = !sgbd;
  e['dtc-csv'].disabled = !fbFaults.readAt;
  const n = fbFaults.rows.length;
  const present = fbFaults.rows.filter((r) => r.present).length;
  e['dtc-status'].className =
    'fb-faults-status' + (fbFaults.error ? ' err' : '');
  e['dtc-status'].textContent = fbFaults.error
    ? fbFaults.error
    : fbFaults.reading
      ? 'reading...'
      : fbFaults.readAt
        ? `${n} fault${n === 1 ? '' : 's'}${present ? ` · ${present} present` : ''} · ${fbFaults.sgbd} · ${fbFaults.readAt.toLocaleTimeString()}`
        : !fbState.module
          ? 'Choose a control unit above.'
          : !sgbd
            ? 'Identify the TCU first.'
            : '';
  const list = e['dtc-list'];
  if (!fbFaults.readAt) {
    list.innerHTML = `<div class="tn-faults-empty">${fbFaults.reading ? 'Reading the fault memory...' : 'Not read yet.'}</div>`;
    return;
  }
  if (!n) {
    list.innerHTML = '<div class="tn-faults-empty">No faults stored.</div>';
    return;
  }
  // the mileage column only when a detail read filled it
  const km = fbFaults.rows.some((r) => r.km);
  list.innerHTML =
    `<table class="tn-faults-table fb-faults-table"><thead><tr><th>Code</th><th>Fault</th><th>Status</th><th>Count</th>${km ? '<th>Mileage</th>' : ''}</tr></thead><tbody>` +
    fbFaults.rows.map((r) => fbFaultsRowHtml(r, km)).join('') +
    '</tbody></table>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fbFaults,
    fbFaultsCsv,
    fbFaultsRow,
    fbFaultsRowHtml,
    fbFaultsPaint,
    fbFaultsClearAfterFlash,
  };
}
