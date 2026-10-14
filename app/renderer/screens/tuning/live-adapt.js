/**
 * @file Tuning screen: the DME's learned values (its adaptations) in a
 * floating window. While live mode is armed, the Adaptations tick in the
 * live toolbar opens it: the mixture adaptations per bank (what long-term
 * fuel trim the DME has settled on, additive at idle and multiplicative
 * under load), the idle actuator and throttle adaptations, and the camshaft
 * reference and edge adaptations. Read once, or again every few seconds.
 *
 * They come from the DME's own status jobs (STATUS_ADAPTION_GEMISCH,
 * STATUS_ADAPTION_DK_LLSTELLER, STATUS_NOCKENWELLE_ADAPTION) through the
 * same route the fault window uses: a read is a few telegrams, so a live
 * scan takes its turn every few seconds and never ahead of an edit.
 *
 * Clearing goes through the DME's selective clear (ADAP_SELEKTIV_LOESCHEN:
 * KWP routine 31 30 with three selector bytes, a bit per group, 1 clears).
 * The groups are the ones BMW's own MS45 script offers, with its bytes; the
 * DME only takes the routine with the engine stopped (ignition on).
 */
/* exported tnAdaptBuild, tnAdaptOpened, tnAdaptRows, TN_ADAPT_GROUPS, tnAdaptSelector */

/** The DME's SGBD. */
const TN_ADAPT_SGBD = 'ms450ds0';
/** Rest between two reads of a live scan. */
const TN_ADAPT_SCAN_MS = 5000;
/**
 * The jobs and what to show of their answers: [job, [[result, label, unit, decimals]...]].
 * @type {Array<[string, Array<[string, string, string, number]>]>}
 */
const TN_ADAPT_JOBS = [
  [
    'STATUS_ADAPTION_GEMISCH',
    [
      ['STAT_ADD_WERT1', 'Mixture adaptation, additive, bank 1', 'mg/stk', 3],
      ['STAT_ADD_WERT2', 'Mixture adaptation, additive, bank 2', 'mg/stk', 3],
      ['STAT_FAC_WERT1', 'Mixture adaptation, multiplicative, bank 1', '%', 2],
      ['STAT_FAC_WERT2', 'Mixture adaptation, multiplicative, bank 2', '%', 2],
      ['STAT_PWM_UP_WERT1', 'O2 heater front, bank 1', '%', 1],
      ['STAT_PWM_UP_WERT2', 'O2 heater front, bank 2', '%', 1],
      ['STAT_PWM_DOWN_WERT1', 'O2 heater rear, bank 1', '%', 1],
      ['STAT_PWM_DOWN_WERT2', 'O2 heater rear, bank 2', '%', 1],
    ],
  ],
  [
    'STATUS_ADAPTION_DK_LLSTELLER',
    [
      ['STAT_ISA_ADD_WERT', 'Idle actuator adaptation, offset', 'cm²', 3],
      ['STAT_ISA_FAC_WERT', 'Idle actuator adaptation, factor', '%', 2],
      ['STAT_DK_ADD_WERT', 'Throttle adaptation, offset', 'cm²', 3],
      ['STAT_DK_FAC_WERT', 'Throttle adaptation, factor', '%', 2],
    ],
  ],
  [
    'STATUS_NOCKENWELLE_ADAPTION',
    [
      ['STAT_CAM_REF_IN_1', 'Intake cam reference', '°', 2],
      ['STAT_CAM_REF_EX_1', 'Exhaust cam reference', '°', 2],
      ['STAT_CAM_AD_IN_10', 'Intake cam edge adaptation, edge 0', '°', 2],
      ['STAT_CAM_AD_IN_11', 'Intake cam edge adaptation, edge 1', '°', 2],
      ['STAT_CAM_AD_IN_12', 'Intake cam edge adaptation, edge 2', '°', 2],
      ['STAT_CAM_AD_EX_10', 'Exhaust cam edge adaptation, edge 0', '°', 2],
      ['STAT_CAM_AD_EX_11', 'Exhaust cam edge adaptation, edge 1', '°', 2],
      ['STAT_CAM_AD_EX_12', 'Exhaust cam edge adaptation, edge 2', '°', 2],
    ],
  ],
];

/**
 * What the selective clear can clear: name, the three selector bytes. "All"
 * is BMW's own choice of everything but the battery-change registration
 * (byte 2 bit 0x10, which STEUERN_BATTERIETAUSCH_REGISTRIEREN sets).
 * @type {Array<[string, number, number, number]>}
 */
const TN_ADAPT_GROUPS = [
  ['Idle speed', 1, 0, 0],
  ['Knock', 2, 0, 0],
  ['O2 sensors and mixture', 4, 0, 0],
  ['Throttle valve', 32, 0, 0],
  ['Air intake model', 64, 0, 0],
  ['Fuel in oil', 0, 2, 0],
  ['Secondary air', 0, 4, 0],
  ['Octane value', 0, 32, 0],
  ['Learned variant', 0, 64, 0],
  ['VANOS', 0, 0, 1],
  ['Segment time and misfire', 0, 0, 2],
];
const TN_ADAPT_ALL = [0xff, 0xef, 0xff];

/**
 * The job argument for a set of groups: the three bytes, OR-ed.
 * @param {number[]} picked - Indexes into TN_ADAPT_GROUPS; empty means all.
 * @returns {string} "b1;b2;b3" as the job takes it.
 */
function tnAdaptSelector(picked) {
  const bytes = picked.length ? [0, 0, 0] : TN_ADAPT_ALL.slice();
  for (const i of picked)
    for (let k = 0; k < 3; k++) bytes[k] |= TN_ADAPT_GROUPS[i][k + 1];
  return bytes.join(';');
}

/** The window's state. */
const tnAdapt = {
  win: null,
  els: null,
  rows: [], // what is listed: [{label, value, unit, dp, job}]
  readAt: null,
  prev: null, // label -> value at the read before, for the change markers
  reading: false,
  scan: false,
  timer: null,
  error: '',
};

/**
 * The rows to list out of the jobs' answers.
 * @param {Object<string, Object<string, *>>} answers - job -> the first data set.
 * @returns {Array<{label: string, value: number|null, unit: string, dp: number, job: string}>}
 */
function tnAdaptRows(answers) {
  const out = [];
  for (const [job, fields] of TN_ADAPT_JOBS) {
    const set = answers[job];
    if (!set) continue;
    for (const [key, label, unit, dp] of fields) {
      const raw = set[key];
      const n = raw == null || raw === '' ? NaN : Number(raw);
      out.push({ label, value: Number.isFinite(n) ? n : null, unit, dp, job });
    }
  }
  return out;
}

/**
 * Build the window (hidden). Called with the gauges' windows.
 * @param {(which:string, title:string, bodyHtml:string, first:object) => HTMLElement} makeWindow
 * @returns {HTMLElement}
 */
function tnAdaptBuild(makeWindow) {
  const win = makeWindow(
    'adapt',
    'DME adaptations',
    `<div class="tn-faults-bar">
       <button type="button" class="btn tn-adapt-read">Read</button>
       <label class="tn-tool-check" title="Read the adaptations again every few seconds"><input type="checkbox" class="tn-adapt-scan"> Live scan</label>
       <span class="tn-faults-status tn-adapt-status"></span>
       <button type="button" class="btn tn-adapt-csv" disabled>Save CSV</button>
       <span class="tn-adapt-clear-wrap">
         <button type="button" class="btn tn-adapt-clear-open" aria-haspopup="true" aria-expanded="false" title="Clear what the DME has learned, a group at a time or all of it">Clear ▾</button>
         <div class="tn-adapt-menu" hidden>
           <button type="button" class="tn-adapt-menu-item" data-groups="">All adaptations</button>
           <hr />
           ${TN_ADAPT_GROUPS.map(
             ([name], i) =>
               `<button type="button" class="tn-adapt-menu-item" data-groups="${i}">${name}</button>`
           ).join('')}
         </div>
       </span>
     </div>
     <div class="tn-faults-list tn-adapt-list"></div>`,
    {
      left: Math.max(8, window.innerWidth - 24 - 260 - 12 - 440),
      top: 140,
      width: 440,
      height: 380,
    }
  );
  const q = (sel) => win.querySelector(sel);
  tnAdapt.win = win;
  tnAdapt.els = {
    read: q('.tn-adapt-read'),
    scan: q('.tn-adapt-scan'),
    status: q('.tn-adapt-status'),
    csv: q('.tn-adapt-csv'),
    list: q('.tn-adapt-list'),
    menu: q('.tn-adapt-menu'),
    clearOpen: q('.tn-adapt-clear-open'),
  };
  // the Clear menu: one press an intention, closed by a press anywhere else
  const showMenu = (on) => {
    tnAdapt.els.menu.hidden = !on;
    tnAdapt.els.clearOpen.setAttribute('aria-expanded', on ? 'true' : 'false');
  };
  tnAdapt.els.clearOpen.onclick = () => showMenu(tnAdapt.els.menu.hidden);
  tnAdapt.els.menu.onclick = (e) => {
    const item = e.target.closest('.tn-adapt-menu-item');
    if (!item) return;
    showMenu(false);
    const groups =
      item.dataset.groups === '' ? [] : [Number(item.dataset.groups)];
    tnAdaptClear(groups);
  };
  document.addEventListener('mousedown', (e) => {
    if (!tnAdapt.els.menu.hidden && !win.contains(e.target)) showMenu(false);
  });
  // the list's section headers clear their own group in one press
  tnAdapt.els.list.onclick = (e) => {
    const b = e.target.closest('.tn-adapt-section-clear');
    if (b) tnAdaptClear(b.dataset.groups.split(',').map(Number));
  };
  tnAdapt.els.read.onclick = () => tnAdaptRead();
  tnAdapt.els.scan.onchange = () => {
    tnAdapt.scan = tnAdapt.els.scan.checked;
    tnAdaptSchedule();
  };
  tnAdapt.els.csv.onclick = () => tnAdaptSaveCsv();
  tnAdaptPaint();
  return win;
}

/**
 * The window was opened or closed.
 * @param {boolean} on
 * @returns {void}
 */
function tnAdaptOpened(on) {
  if (on && !tnAdapt.readAt && !tnAdapt.reading) tnAdaptRead();
  if (!on) clearTimeout(tnAdapt.timer);
  else tnAdaptSchedule();
}

/** Whether the line is free for a read: armed, connected, no edit waiting. */
function tnAdaptMayRead() {
  return (
    tnLive.armed && !!tnLive.lt && tnLive.link !== 'lost' && !tnLiveLineBusy()
  );
}

/**
 * Queue the next read of a live scan.
 * @returns {void}
 */
function tnAdaptSchedule() {
  clearTimeout(tnAdapt.timer);
  if (!tnAdapt.scan || !tnAdapt.win || tnAdapt.win.hidden) return;
  tnAdapt.timer = setTimeout(async () => {
    if (!document.hidden && tnAdaptMayRead()) await tnAdaptRead(true);
    tnAdaptSchedule();
  }, TN_ADAPT_SCAN_MS);
}

/**
 * Read the adaptations and list them.
 * @param {boolean} [quiet] - A live scan's read: no "reading" flicker.
 * @returns {Promise<void>}
 */
async function tnAdaptRead(quiet = false) {
  if (tnAdapt.reading) return;
  tnAdapt.reading = true;
  tnAdapt.error = '';
  if (!quiet) tnAdaptPaint();
  try {
    const answers = {};
    const failed = [];
    for (const [job] of TN_ADAPT_JOBS) {
      try {
        const base = await api(`/api/ecu/${TN_ADAPT_SGBD}/run/${job}`, {
          method: 'POST',
        });
        const sets = dataSets(base.sets);
        if (sets.length) answers[job] = sets[0];
        else failed.push(job);
      } catch (e) {
        failed.push(job);
      }
    }
    // what moved since the last read: the DME learning, or a clear landing
    tnAdapt.prev = new Map(tnAdapt.rows.map((r) => [r.label, r.value]));
    tnAdapt.rows = tnAdaptRows(answers);
    tnAdapt.readAt = new Date();
    if (failed.length === TN_ADAPT_JOBS.length)
      tnAdapt.error = 'the DME did not answer';
    else if (failed.length)
      tnAdapt.error = `not answered: ${failed.join(', ')}`;
  } catch (e) {
    tnAdapt.error = (e && e.message) || String(e);
  } finally {
    tnAdapt.reading = false;
    tnAdaptPaint();
  }
}

/**
 * Clear some groups (all when none is named), asked first, then read again.
 * @param {number[]} picked - Indexes into TN_ADAPT_GROUPS.
 * @returns {Promise<void>}
 */
async function tnAdaptClear(picked) {
  if (tnAdapt.reading) return;
  const what = picked.length
    ? picked.map((i) => TN_ADAPT_GROUPS[i][0]).join(', ')
    : 'every adaptation';
  const ok = await confirmDialog({
    title: 'Clear the DME’s adaptations?',
    body: `<p>Clears: ${esc(what)}. The DME learns them again as it runs; idle and mixture may be off until it has. The engine must be stopped with the ignition on.</p>`,
    confirmLabel: 'Clear',
    cancelLabel: 'Cancel',
  });
  if (!ok) return;
  tnAdapt.reading = true;
  tnAdapt.error = '';
  tnAdaptPaint();
  try {
    const base = await api(
      `/api/ecu/${TN_ADAPT_SGBD}/run/ADAP_SELEKTIV_LOESCHEN?arg=${encodeURIComponent(tnAdaptSelector(picked))}`,
      { method: 'POST' }
    );
    const set = dataSets(base.sets)[0] || {};
    if (set.JOB_STATUS !== 'OKAY')
      tnAdapt.error = `not cleared: ${set.JOB_STATUS || 'no answer'}${/ERROR_ECU_CONDITIONS/.test(set.JOB_STATUS || '') ? ' (is the engine stopped?)' : ''}`;
  } catch (e) {
    tnAdapt.error = `could not clear: ${(e && e.message) || e}`;
  } finally {
    tnAdapt.reading = false;
  }
  if (!tnAdapt.error) await tnAdaptRead();
  else tnAdaptPaint();
}

/**
 * What is listed, as CSV text.
 * @returns {string}
 */
function tnAdaptCsv() {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const at = tnAdapt.readAt ? tnAdapt.readAt.toISOString() : '';
  const lines = [['adaptation', 'value', 'unit', 'job', 'read_at'].join(',')];
  for (const r of tnAdapt.rows)
    lines.push(
      [r.label, r.value == null ? '' : r.value, r.unit, r.job, at]
        .map(cell)
        .join(',')
    );
  return lines.join('\n') + '\n';
}

/**
 * Download the list as a CSV file.
 * @returns {void}
 */
function tnAdaptSaveCsv() {
  const stamp = (tnAdapt.readAt || new Date())
    .toISOString()
    .replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([tnAdaptCsv()], { type: 'text/csv' }));
  a.download = `dme-adaptations-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Redraw the window from its state.
 * @returns {void}
 */
function tnAdaptPaint() {
  const e = tnAdapt.els;
  if (!e) return;
  e.read.disabled = tnAdapt.reading;
  e.clearOpen.disabled = tnAdapt.reading;
  e.csv.disabled = !tnAdapt.readAt;
  e.status.className =
    'tn-faults-status tn-adapt-status' + (tnAdapt.error ? ' err' : '');
  e.status.textContent = tnAdapt.error
    ? tnAdapt.error
    : tnAdapt.reading
      ? 'reading…'
      : tnAdapt.readAt
        ? `read ${tnAdapt.readAt.toLocaleTimeString()}`
        : '';
  if (!tnAdapt.readAt) {
    e.list.innerHTML = '<div class="tn-faults-empty">Not read yet.</div>';
    return;
  }
  if (!tnAdapt.rows.length) {
    e.list.innerHTML =
      '<div class="tn-faults-empty">The DME answered none of the adaptation jobs.</div>';
    return;
  }
  let job = '';
  const body = tnAdapt.rows
    .map((r) => {
      const [title, groups] =
        r.job === 'STATUS_ADAPTION_GEMISCH'
          ? ['Mixture', '2']
          : r.job === 'STATUS_ADAPTION_DK_LLSTELLER'
            ? ['Idle and throttle', '0,3']
            : ['Camshafts', '9'];
      const head =
        r.job !== job
          ? `<tr class="tn-adapt-group"><td>${esc(title)}</td><td><button type="button" class="tn-adapt-section-clear" data-groups="${groups}" title="Clear these and let the DME learn them again">clear</button></td></tr>`
          : '';
      job = r.job;
      const was = tnAdapt.prev ? tnAdapt.prev.get(r.label) : undefined;
      const moved =
        was != null &&
        r.value != null &&
        Math.abs(r.value - was) >= 10 ** -r.dp / 2;
      const delta = moved
        ? `<span class="tn-adapt-delta">${r.value > was ? '▲' : '▼'} ${fmtNum(Math.abs(r.value - was), r.dp)}</span>`
        : '';
      const value =
        r.value == null
          ? '–'
          : `${delta}${fmtNum(r.value, r.dp)} ${esc(r.unit)}`;
      return `${head}<tr><td>${esc(r.label)}</td><td class="mono">${value}</td></tr>`;
    })
    .join('');
  e.list.innerHTML = `<table class="tn-faults-table tn-adapt-table"><tbody>${body}</tbody></table>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TN_ADAPT_JOBS,
    TN_ADAPT_GROUPS,
    tnAdaptSelector,
    tnAdaptRows,
    tnAdaptCsv,
    tnAdapt,
  };
}
