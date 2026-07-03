// whole-vehicle sweep engine (INPA "Functional Jobs" / "Special tests"):
// quickErrorSweep reads fault memory on every chassis ECU, quickIdentSweep reads
// IDENT. variant-group + priority tables let the sweep claim each shared-address
// group early and skip its dead siblings, and fault-signature dedup drops echoes.
// fillFaultDetail lives in autoscan.js; exportFaultPdf in fault-report.js.

// variant groups: ECUs sharing one diagnostic address, only one installed. once a
// member responds the rest are absent (or echoes), so the sweep skips them. keyed
// by chassis since the variant sets differ. the engine group is the big win: E46
// has ~11 mutually-exclusive DMEs, E36 ~14, each ~7s whether it answers or not.
const VARIANT_GROUPS = {
  E46: {
    engine: ['DDE40', 'D50M47', 'D50M57', 'BMS46', 'ME9_4N', 'ME9NG4TU', 'MS420', 'MS430', 'MS450', 'MSS54M3', 'CARB'],
    trans:  ['gsds2', 'gs30', 'smg2'],
    dsc:    ['ascdsc46', 'absasc5', 'dscmk60'],
  },
  // E36: one DME (VNC/CARB excluded - VNC is the S50 VANOS box that coexists with
  // a DME, CARB is a dealer interface, neither shares the DME address). one
  // gearbox; one ABS/ASC/DSC brake controller (Mk4..Mk60).
  E36: {
    engine: ['DDE21', 'DME17', 'BMS43', 'BMS46', 'DME338K2', 'MSS50', 'MSS54M3',
             'DME331', 'DME524', 'MS401', 'MS410', 'MS411', 'MS420', 'MS430'],
    trans:  ['gsds2', 'gs41x', 'gs7x_k', 'jatco', 'smg'],
    dsc:    ['absasc4', 'absasc4g', 'ascdsc46', 'absasc5', 'dscmk60'],
  },
};
// INPA entry code -> group key (case-insensitive), within a chassis. the groups
// list ENTRY codes (MS450, gsds2), which the chassis API returns as ecu.code;
// ecu.sgbd is the resolved .prg name (ms450ds0) and would never match. unknown
// chassis -> no grouping (every ECU scanned), which is safe, just slower.
const _groupOf = (code, chassisId) => {
  const groups = VARIANT_GROUPS[(chassisId || '').toUpperCase()];
  if (!groups) return null;
  const s = (code || '').toLowerCase();
  for (const [k, list] of Object.entries(groups))
    if (list.some(x => x.toLowerCase() === s)) return k;
  return null;
};
// stable fault signature for echo dedup. F_HEX_CODE is globally unique (BMW DTC);
// F_ORT_NR is only an ECU-local index, so fall back to it only if hex is absent.
const _faultSig = (codes) =>
  (codes || []).map(c => c.F_HEX_CODE || `nr:${c.F_ORT_NR}`).join(',');

// a sweep ties up the K-line for a while. each sweep takes a token; navigating
// away (or starting another sweep) bumps it, and the running loop bails on its
// next iteration so we stop hammering the bus after the user leaves.
let _sweepToken = 0;
const cancelSweep = () => { _sweepToken++; };

// quick error memory test (INPA FSQUICK): read fault memory on every chassis ECU,
// combined report of which modules have stored faults.
async function quickErrorSweep(chassisId) {
  const id = chassisId || 'E46';
  const token = ++_sweepToken;            // claim this run
  const alive = () => token === _sweepToken;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id), fn: () => { cancelSweep(); showSections(id); } }, { label: 'Quick error sweep' }]);
  view.innerHTML = head('Special tests', 'Quick error memory test', `Scanning every module on the ${dispChassis(id)} for stored faults…`);
  const out = document.createElement('div'); out.className = 'results-panel'; view.appendChild(out);
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => { cancelSweep(); showSections(id); } }]);
  loadFaultDb(); // warm the name db before detail rows render
  const ch = await tryApi(`/api/chassis/${id}`, null, out);
  if (!ch) return;
  const ecus = dedupEcus(ch); sortByPriority(ecus, id);
  out.innerHTML = `<div class="quick-sweep">
    <div class="quick-bar">
      <div class="quick-head">${ecus.length} modules · scanning…</div>
      <div class="quick-bar-btns">
        <button class="quick-pdf" id="quick-pdf" disabled>Export PDF</button>
        <button class="quick-clear-all" id="quick-clear-all" disabled>Clear all</button>
      </div>
    </div>
    <div class="quick-rows" id="quick-rows"></div></div>`;
  const rows = out.querySelector('#quick-rows');
  const headEl = out.querySelector('.quick-head');
  let withFaults = 0, scanned = 0, dupes = 0, skipped = 0;
  // each read costs ~7s (K-line wake-up) whether the ECU answers or not. variant
  // groups share one address, only one installed, so once a group's ECU responds
  // skip the rest. dedup by fault signature catches echoes. cuts the 12 engine
  // variants to ~1-2 reads.
  const seen = new Map();          // fault-signature -> first ECU label
  const groupDone = new Set();     // variant-group key that already responded
  const faulty = [];               // modules that reported faults, for the deep pass
  for (const ecu of ecus) {
    if (!alive()) return;          // user left the sweep; stop reading the bus
    const grp = _groupOf(ecu.code, id);
    const row = addSweepRow(rows, ecu.label);

    if (grp && groupDone.has(grp)) {
      // another variant in this group answered, so this one not installed
      skipped++; row.classList.add('noresp');
      row.querySelector('.quick-status').textContent = 'skipped (variant)';
      continue;
    }
    try {
      const data = await api(`/api/ecu/${ecu.sgbd}/read`, { method: 'POST' });
      const n = data.count || 0;
      // any answer (even 0 faults) claims the variant group
      if (grp && typeof data.count === 'number') groupDone.add(grp);
      if (n > 0) {
        const sig = _faultSig(data.codes);
        if (seen.has(sig)) {
          dupes++; row.classList.add('noresp');
          row.querySelector('.quick-status').textContent = `echo of ${seen.get(sig)}`;
        } else {
          seen.set(sig, ecu.label);
          withFaults++; row.classList.add('has-faults');
          row.querySelector('.quick-status').innerHTML = `<b>${n} fault${n === 1 ? '' : 's'}</b>`;
          const codes = (data.codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
          faulty.push({ ecu, row, codes });
        }
      } else { row.classList.add('clean'); row.querySelector('.quick-status').textContent = 'OK'; }
    } catch (e) {
      row.classList.add('noresp'); row.querySelector('.quick-status').textContent = 'no response';
    }
    scanned++;
    headEl.textContent = `${scanned} read · ${skipped} skipped · ${withFaults} with faults`;
  }

  // deep pass: every module that reported faults gets a detailed read for the
  // specific DTCs (FS_LESEN_DETAIL), shown inline under its row.
  if (faulty.length) {
    await loadFaultDb(); // names resolve synchronously in the detail rows
    headEl.textContent =
      `${scanned} read, ${skipped} skipped · ${withFaults} with faults · reading details…`;
    let done = 0;
    for (const f of faulty) {
      if (!alive()) return;        // user left mid deep-read; stop
      f.row.classList.add('scanning-detail');
      f.row.querySelector('.quick-status').innerHTML =
        `<b>${f.codes.length} fault${f.codes.length === 1 ? '' : 's'}</b> · reading…`;
      try { await fillFaultDetail(f.ecu.sgbd, f.codes); } catch { /* keep base codes */ }
      f.row.classList.remove('scanning-detail');
      setRowFaultStatus(f);
      appendFaultDetailRows(f.row, f.codes);
      done++;
      headEl.textContent =
        `${scanned} read, ${skipped} skipped · ${withFaults} with faults · details ${done}/${faulty.length}`;
    }
  }

  // wire up Clear all (clears every faulty module in turn) once we know them.
  const clearAllBtn = out.querySelector('#quick-clear-all');
  if (faulty.length) {
    clearAllBtn.disabled = false;
    clearAllBtn.onclick = async () => {
      const ok = await confirmDialog({
        title: 'Clear all fault memory?',
        body: `Erase stored faults on ${faulty.length} module${faulty.length === 1 ? '' : 's'}. This cannot be undone.`,
        confirmLabel: 'Clear all', danger: true,
      });
      if (!ok) return;
      clearAllBtn.disabled = true; clearAllBtn.textContent = 'Clearing…';
      for (const f of faulty) await clearModule(f);
      clearAllBtn.textContent = 'Cleared';
    };
  }

  // Export PDF: a clean per-module fault report. available even with no faults
  // (records a clean bill of health).
  const pdfBtn = out.querySelector('#quick-pdf');
  if (pdfBtn && window.bmacw && window.bmacw.savePdf) {
    pdfBtn.disabled = false;
    pdfBtn.onclick = () => exportFaultPdf(id, faulty, { scanned, skipped, withFaults });
  } else if (pdfBtn) {
    pdfBtn.remove(); // PDF export needs the Electron bridge
  }

  headEl.textContent =
    `Done · ${scanned} read, ${skipped} skipped · ${withFaults} with stored faults${dupes ? ` · ${dupes} echoes hidden` : ''}`;
  sbLeft.textContent = `quick sweep · ${withFaults} faulty`;
}

// status cell for a faulty module: fault count plus a Clear button.
function setRowFaultStatus(f) {
  const n = f.codes.length;
  const st = f.row.querySelector('.quick-status');
  st.innerHTML = `<b>${n} fault${n === 1 ? '' : 's'}</b><button class="quick-clear" title="Clear ${esc(f.ecu.label)}">Clear</button>`;
  st.querySelector('.quick-clear').onclick = () => clearModule(f);
}

// erase one module's fault memory (FS_LOESCHEN), then mark the row cleared.
async function clearModule(f) {
  const st = f.row.querySelector('.quick-status');
  st.innerHTML = '<span class="quick-clearing">clearing…</span>';
  try {
    await api(`/api/ecu/${f.ecu.sgbd}/clear`, { method: 'POST' });
    f.row.classList.remove('has-faults'); f.row.classList.add('clean');
    st.innerHTML = '<span class="quick-cleared">cleared</span>';
    if (f.row.nextElementSibling?.classList.contains('quick-detail')) f.row.nextElementSibling.remove();
  } catch (e) {
    setRowFaultStatus(f); // rebuild the count + working Clear button
    const fail = document.createElement('span');
    fail.className = 'quick-clear-fail'; fail.textContent = ' clear failed';
    fail.title = e.message;
    st.appendChild(fail);
    setTimeout(() => fail.remove(), 4000);
  }
}

// render the specific DTCs for one faulty module beneath its sweep row, using
// the shared faultFields projection (translate.js) so the rows and the PDF report
// read the same.
function appendFaultDetailRows(row, codes) {
  const wrap = document.createElement('div');
  wrap.className = 'quick-detail';
  wrap.innerHTML = codes.map(c => {
    const { code, name, present } = faultFields(c);
    return `<div class="quick-detail-row${present ? ' present' : ''}">
      <span class="quick-detail-code">${esc(code)}</span>
      <span class="quick-detail-name">${esc(name)}</span>
      <span class="quick-detail-state">${present ? 'PRESENT' : 'stored'}</span>
    </div>`;
  }).join('');
  row.insertAdjacentElement('afterend', wrap);
}

// quick identification (INPA IDQUICK): read IDENT on every chassis ECU
async function quickIdentSweep(chassisId) {
  const id = chassisId || 'E46';
  const token = ++_sweepToken;
  const alive = () => token === _sweepToken;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id), fn: () => { cancelSweep(); showSections(id); } }, { label: 'Quick identification' }]);
  view.innerHTML = head('Special tests', 'Quick identification', `Identifying every module on the ${dispChassis(id)}…`);
  const out = document.createElement('div'); out.className = 'results-panel'; view.appendChild(out);
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => { cancelSweep(); showSections(id); } }]);
  let ch;
  try { ch = await api(`/api/chassis/${id}`); }
  catch (e) { out.innerHTML = errorBlock(e.message); return; }
  const ecus = dedupEcus(ch); sortByPriority(ecus, id);
  out.innerHTML = `<div class="quick-sweep"><div class="quick-head">${ecus.length} modules · identifying…</div><div class="quick-rows" id="quick-rows"></div></div>`;
  const rows = out.querySelector('#quick-rows');
  const head_ = out.querySelector('.quick-head');
  let present = 0, scanned = 0;
  const groupDone = new Set();
  for (const ecu of ecus) {
    if (!alive()) return;          // user left the sweep; stop reading the bus
    const grp = _groupOf(ecu.code, id);
    const row = addSweepRow(rows, ecu.label);
    if (grp && groupDone.has(grp)) { row.classList.add('noresp'); row.querySelector('.quick-status').textContent = 'skipped (variant)'; continue; }
    try {
      const data = await api(`/api/ecu/${ecu.sgbd}/run/IDENT`, { method: 'POST' });
      if (grp) groupDone.add(grp);
      const set = dataSets(data.sets).find(s => Object.keys(s).some(k => !k.startsWith('_')));
      const idtxt = set ? (set.SG_VARIANTE || set.VARIANTE || set.AIF_TYP || set.HARDWARE_NUMMER || 'present') : 'present';
      present++; row.classList.add('clean'); row.querySelector('.quick-status').textContent = String(idtxt).slice(0, 28);
    } catch {
      row.classList.add('noresp'); row.querySelector('.quick-status').textContent = 'no response';
    }
    scanned++;
    head_.textContent = `${scanned} identified · ${present} present`;
  }
  head_.textContent = `Done · ${present} modules present`;
  sbLeft.textContent = `quick ident · ${present} present`;
}

// shared sweep helpers
function dedupEcus(ch) {
  const ecus = [];
  ch.sections.forEach(s => s.ecus.forEach(e => { if (!ecus.find(x => x.sgbd === e.sgbd)) ecus.push(e); }));
  return ecus;
}
// likeliest-installed variant first, so the sweep claims each group early and
// skips its dead siblings. per chassis; unknown chassis -> original order.
const SWEEP_PRIORITY = {
  E46: ['MS450', 'MS430', 'MS420', 'ME9_4N', 'MSS54M3', 'BMS46', 'gsds2', 'smg2', 'ascdsc46', 'absasc5'],
  E36: ['MS420', 'MS430', 'MS410', 'MS411', 'DME331', 'MSS54M3', 'MSS50', 'DME338K2', 'DME524', 'DME17',
        'gsds2', 'gs41x', 'smg', 'absasc4', 'absasc4g', 'ascdsc46', 'absasc5'],
};
function sortByPriority(ecus, chassisId) {
  const order = SWEEP_PRIORITY[(chassisId || '').toUpperCase()] || [];
  const prio = (e) => { const i = order.findIndex(p => p.toLowerCase() === (e.code || '').toLowerCase()); return i < 0 ? 99 : i; };
  ecus.sort((a, b) => prio(a) - prio(b));
}
function addSweepRow(rows, label) {
  const row = document.createElement('div'); row.className = 'quick-row';
  row.innerHTML = `<span class="quick-ecu">${esc(label)}</span><span class="quick-status">scanning…</span>`;
  rows.appendChild(row);
  return row;
}
