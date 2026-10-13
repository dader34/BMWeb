/**
 * @file Tuning screen: the DME's fault memory in a floating window. While
 * live mode is armed, the Faults tick in the live toolbar opens it: read the
 * stored faults, keep reading them while tuning (live scan), save what is
 * listed as CSV, clear the memory.
 *
 * The faults come from the DME's own diagnostic jobs (FS_LESEN, FS_LOESCHEN)
 * through the same route the fault screens use, so the codes and names are
 * the ones the rest of the app shows. A read is a handful of telegrams, so a
 * live scan takes its turn every few seconds and never ahead of an edit.
 */
/* exported tnFaultsBuild, tnFaultsOpened */

/** The DME's SGBD. */
const TN_FAULTS_SGBD = 'ms450ds0';
/** Rest between two reads of a live scan. */
const TN_FAULTS_SCAN_MS = 4000;

/** The window's state. */
const tnFaults = {
  win: null,
  els: null,
  rows: [], // what is listed: [{code, pcode, name, present, ftype, count}]
  readAt: null,
  reading: false,
  scan: false,
  timer: null,
  error: '',
};

/**
 * Build the window (hidden). Called with the gauges' windows.
 * @param {(which:string, title:string, bodyHtml:string, first:object) => HTMLElement} makeWindow
 * @returns {HTMLElement}
 */
function tnFaultsBuild(makeWindow) {
  const win = makeWindow(
    'faults',
    'DME faults',
    `<div class="tn-faults-bar">
       <button type="button" class="btn tn-faults-read">Read</button>
       <label class="tn-tool-check" title="Read the fault memory again every few seconds"><input type="checkbox" class="tn-faults-scan"> Live scan</label>
       <span class="tn-faults-status"></span>
       <button type="button" class="btn tn-faults-csv" disabled>Save CSV</button>
       <button type="button" class="btn tn-faults-clear">Clear faults</button>
     </div>
     <div class="tn-faults-list"></div>`,
    {
      left: Math.max(8, window.innerWidth - 24 - 260 - 12 - 540),
      top: 96,
      width: 540,
      height: 340,
    }
  );
  const q = (sel) => win.querySelector(sel);
  tnFaults.win = win;
  tnFaults.els = {
    read: q('.tn-faults-read'),
    scan: q('.tn-faults-scan'),
    status: q('.tn-faults-status'),
    csv: q('.tn-faults-csv'),
    clear: q('.tn-faults-clear'),
    list: q('.tn-faults-list'),
  };
  tnFaults.els.read.onclick = () => tnFaultsRead();
  tnFaults.els.scan.onchange = () => {
    tnFaults.scan = tnFaults.els.scan.checked;
    tnFaultsSchedule();
  };
  tnFaults.els.csv.onclick = () => tnFaultsSaveCsv();
  tnFaults.els.clear.onclick = () => tnFaultsClear();
  tnFaultsPaint();
  return win;
}

/**
 * The window was opened or closed.
 * @param {boolean} on
 * @returns {void}
 */
function tnFaultsOpened(on) {
  if (on && !tnFaults.readAt && !tnFaults.reading) tnFaultsRead();
  if (!on) clearTimeout(tnFaults.timer);
  else tnFaultsSchedule();
}

/** Whether the line is free for a read: armed, connected, no edit waiting. */
function tnFaultsMayRead() {
  return (
    tnLive.armed &&
    !!tnLive.lt &&
    tnLive.link !== 'lost' &&
    !tnLive.busy &&
    !tnLive.pumping &&
    !tnLive.pending.size
  );
}

/**
 * Queue the next read of a live scan.
 * @returns {void}
 */
function tnFaultsSchedule() {
  clearTimeout(tnFaults.timer);
  if (!tnFaults.scan || !tnFaults.win || tnFaults.win.hidden) return;
  tnFaults.timer = setTimeout(async () => {
    if (!document.hidden && tnFaultsMayRead()) await tnFaultsRead(true);
    tnFaultsSchedule();
  }, TN_FAULTS_SCAN_MS);
}

/**
 * Read the fault memory and list it.
 * @param {boolean} [quiet] - A live scan's read: no "reading" flicker.
 * @returns {Promise<void>}
 */
async function tnFaultsRead(quiet = false) {
  if (tnFaults.reading) return;
  tnFaults.reading = true;
  tnFaults.error = '';
  if (!quiet) tnFaultsPaint();
  try {
    if (typeof loadFaultDb === 'function') loadFaultDb(); // names, while the bus works
    const base = await api(`/api/ecu/${TN_FAULTS_SGBD}/run/FS_LESEN`, {
      method: 'POST',
    });
    const faults = dataSets(base.sets).filter(
      (c) => c.F_HEX_CODE || c.F_ORT_NR
    );
    if (typeof loadFaultDb === 'function') await loadFaultDb();
    tnFaults.rows = faults.map((c) => faultFields(c, TN_FAULTS_SGBD));
    tnFaults.readAt = new Date();
  } catch (e) {
    tnFaults.error = (e && e.message) || String(e);
  } finally {
    tnFaults.reading = false;
    tnFaultsPaint();
  }
}

/**
 * Clear the fault memory (asked first), then read it again.
 * @returns {Promise<void>}
 */
async function tnFaultsClear() {
  if (tnFaults.reading) return;
  const ok = await confirmDialog({
    title: 'Clear the DME’s fault memory?',
    body: '<p>Every stored fault and its freeze frame is erased. Save the list first if you want a record.</p>',
    confirmLabel: 'Clear faults',
    cancelLabel: 'Cancel',
  });
  if (!ok) return;
  tnFaults.reading = true;
  tnFaults.error = '';
  tnFaultsPaint();
  try {
    await api(`/api/ecu/${TN_FAULTS_SGBD}/run/FS_LOESCHEN`, { method: 'POST' });
  } catch (e) {
    tnFaults.error = `could not clear: ${(e && e.message) || e}`;
  } finally {
    tnFaults.reading = false;
  }
  if (!tnFaults.error) await tnFaultsRead();
  else tnFaultsPaint();
}

/**
 * What is listed, as CSV text.
 * @returns {string}
 */
function tnFaultsCsv() {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const at = tnFaults.readAt ? tnFaults.readAt.toISOString() : '';
  const lines = [
    ['code', 'p_code', 'fault', 'status', 'type', 'count', 'read_at'].join(','),
  ];
  for (const r of tnFaults.rows)
    lines.push(
      [
        r.code,
        r.pcode,
        r.name,
        r.present ? 'present' : 'stored',
        r.ftype,
        r.count,
        at,
      ]
        .map(cell)
        .join(',')
    );
  return lines.join('\n') + '\n';
}

/**
 * Download the list as a CSV file.
 * @returns {void}
 */
function tnFaultsSaveCsv() {
  const stamp = (tnFaults.readAt || new Date())
    .toISOString()
    .replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([tnFaultsCsv()], { type: 'text/csv' }));
  a.download = `dme-faults-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Redraw the window from its state.
 * @returns {void}
 */
function tnFaultsPaint() {
  const e = tnFaults.els;
  if (!e) return;
  e.read.disabled = tnFaults.reading;
  e.clear.disabled = tnFaults.reading;
  e.csv.disabled = !tnFaults.readAt;
  e.status.className = 'tn-faults-status' + (tnFaults.error ? ' err' : '');
  e.status.textContent = tnFaults.error
    ? tnFaults.error
    : tnFaults.reading
      ? 'reading…'
      : tnFaults.readAt
        ? `${tnFaults.rows.length} fault${tnFaults.rows.length === 1 ? '' : 's'} · ${tnFaults.readAt.toLocaleTimeString()}`
        : '';
  if (!tnFaults.readAt) {
    e.list.innerHTML = '<div class="tn-faults-empty">Not read yet.</div>';
    return;
  }
  if (!tnFaults.rows.length) {
    e.list.innerHTML = '<div class="tn-faults-empty">No faults stored.</div>';
    return;
  }
  e.list.innerHTML =
    '<table class="tn-faults-table"><thead><tr><th>Code</th><th>Fault</th><th>Status</th><th>Count</th></tr></thead><tbody>' +
    tnFaults.rows
      .map(
        (r) =>
          `<tr class="${r.present ? 'present' : ''}"><td class="mono">${esc(r.code)}${r.pcode ? ` <span class="tn-faults-p">${esc(r.pcode)}</span>` : ''}</td>` +
          `<td>${esc(r.name || '')}</td>` +
          `<td>${r.present ? 'present' : 'stored'}${r.ftype ? ` · ${esc(r.ftype)}` : ''}</td>` +
          `<td class="mono">${esc(String(r.count || ''))}</td></tr>`
      )
      .join('') +
    '</tbody></table>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tnFaults, tnFaultsCsv };
}
