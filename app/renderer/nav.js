// navigation: chassis select, INPA script picker, sweeps, sections
async function showChassis() {
  cancelSweep();                 // leaving for the chassis list stops any sweep
  lastScreen = showChassis;
  setCrumbs([{ label: 'Vehicles' }]);
  sbLeft.textContent = 'select chassis';
  const ids = await tryApi('/api/chassis', null, view);
  if (!ids) return;

  if (inpaMode()) {
    // INPA vehicle select: Battery/Ignition row + chassis F-key list. main list shows
    // common chassis; rest sit under "Old models" (Shift+F9), plus "Special tests".
    const COMMON = ['E46', 'E39', 'E60', 'E65', 'E83', 'E85', 'E90', 'E70', 'F30'];
    const main = COMMON.filter(id => ids.includes(id));
    const old = ids.filter(id => !main.includes(id)); // everything else

    view.innerHTML = head('Vehicles', 'INPA', 'Select your vehicle.');
    const panel = document.createElement('div');
    panel.className = 'inpa-vsel';
    const fnRow = (i, id, label) => `
      <button class="inpa-fn" data-id="${esc(id)}">
        <span class="inpa-fn-key">&lt; F${i} &gt;</span>
        <span class="inpa-fn-label">${esc(label)}</span>
      </button>`;
    panel.innerHTML = `
      <div class="inpa-klrow">
        <span class="inpa-kl"><span class="inpa-kl-name">Battery :</span><span class="inpa-kl-led" id="vsel-bat"></span><span class="inpa-kl-state" id="vsel-bat-s">off</span></span>
        <span class="inpa-kl"><span class="inpa-kl-name">Ignition :</span><span class="inpa-kl-led" id="vsel-ign"></span><span class="inpa-kl-state" id="vsel-ign-s">off</span></span>
      </div>
      <div class="inpa-vsplit">
        <div class="inpa-vlist">${main.map((id, i) => fnRow(i + 1, id, `${dispChassis(id)}${CHASSIS_TAG[id] ? ` · ${CHASSIS_TAG[id]}` : ''}`)).join('')}</div>
        <div class="inpa-vlist inpa-vlist-right">
          ${old.length ? `<button class="inpa-fn inpa-fn-more" id="vsel-old"><span class="inpa-fn-key">&lt;Shift+F9&gt;</span><span class="inpa-fn-label">Other models …</span></button>` : ''}
          <button class="inpa-fn inpa-fn-more" id="vsel-special"><span class="inpa-fn-key">&lt;Shift+F8&gt;</span><span class="inpa-fn-label">Special tests …</span></button>
        </div>
      </div>`;
    view.appendChild(panel);
    // Picking a chassis opens the Script-selection popup.
    panel.querySelectorAll('.inpa-fn[data-id]').forEach(b => b.onclick = () => showScriptSelection(b.dataset.id));
    const oldBtn = panel.querySelector('#vsel-old');
    if (oldBtn) oldBtn.onclick = () => showOtherModels(old);
    panel.querySelector('#vsel-special').onclick = () => showSpecialTests();
    sbRight.textContent = `${main.length} common · ${old.length} more`;
    syncVselState();
    const acts = main.slice(0, 8).map((id, i) => ({ key: String(i + 1), label: dispChassis(id), fn: () => showScriptSelection(id) }));
    if (old.length) acts.push({ key: '9', label: 'Other models', fn: () => showOtherModels(old) });
    setActions(acts);
    return;
  }

  view.innerHTML = head('Vehicles', 'Select your vehicle',
    'Choose a chassis to load its diagnostic modules.');
  const grid = document.createElement('div');
  grid.className = 'chassis-grid stagger';
  view.appendChild(grid);

  ids.forEach(id => {
    const card = document.createElement('div');
    card.className = 'chassis-card';
    card.innerHTML = `
      <div class="chassis-code">${esc(dispChassis(id))}</div>
      <div class="chassis-tag">${CHASSIS_TAG[id] || 'BMW'}</div>
      <div class="chassis-arrow">→</div>`;
    card.onclick = () => showSections(id);
    grid.appendChild(card);
  });
  stagger(grid, 22);
  sbRight.textContent = `${ids.length} chassis`;

  // Root screen: quick-pick common chassis, no back.
  const quick = ['E46', 'E60', 'E90'].filter(id => ids.includes(id));
  setActions(quick.map((id, i) => ({
    key: String(i + 1), label: id, fn: () => showSections(id),
  })));
}

// background scan of E46 engine + transmission, once per session on first open.
// stored faults get a detail read and an attention popup.
let _autoScanRan = false;
let _autoScanning = false;
// engine SGBD used for the battery/ignition read. set when a chassis loads so the
// poll targets the right DME (the server default only works for MS45/E46).
let stateSgbd = null;
async function autoScanE46(force) {
  if (Settings.get('autoScan', 'off') !== 'on') return; // opt-in via settings
  if ((_autoScanRan && !force) || _autoScanning) return; // re-entrancy + once-per-session
  _autoScanning = true;
  loadFaultDb(); // warm the name db for the attention popup
  stateSgbd = 'ms450ds0'; // E46 engine: drive the battery/ignition poll off MS45
  try {
    // engine = MS45; transmission = all E46 variants (only one is installed)
    const targets = [
      { sgbd: 'ms450ds0', label: 'MS45.1 DME (engine)', trans: false },
      { sgbd: 'gsds2',    label: 'GS20/GS8 auto trans', trans: true },
      { sgbd: 'gs30',     label: 'SSG sequential gearbox', trans: true },
      { sgbd: 'smg2',     label: 'SMG2 transmission', trans: true },
    ];
    const findings = [];     // { label, faults:[ detailed codes ] }
    let transFound = false, anyResponse = false;
    for (const t of targets) {
      // trans variants share an address: once one actually answers, skip the rest
      if (t.trans && transFound) continue;
      let data;
      try { data = await api(`/api/ecu/${t.sgbd}/read`, { method: 'POST' }); }
      catch { continue; } // no response = not installed
      anyResponse = true;
      if (t.trans) transFound = true; // a non-throwing read means this variant is on the bus
      const faults = (data.codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
      if (!faults.length) continue;
      await fillFaultDetail(t.sgbd, faults);
      findings.push({ label: t.label, sgbd: t.sgbd, faults });
    }
    if (anyResponse) _autoScanRan = true; // mark done only after the bus answered, so a late connect rescans
    if (findings.length) { await loadFaultDb(); showAttentionPopup(findings); }
  } finally {
    _autoScanning = false;
  }
}

// read FS_LESEN_DETAIL per fault and merge the rich fields (p-code, freq, env)
// onto each entry in place. keeps the short hex/loc from the base read.
async function fillFaultDetail(sgbd, faults) {
  for (const f of faults) {
    if (f.F_ORT_NR == null) continue;
    try {
      const det = await api(`/api/ecu/${sgbd}/run/FS_LESEN_DETAIL?arg=${encodeURIComponent(f.F_ORT_NR)}`, { method: 'POST' });
      const dset = matchDetail(det.sets, f.F_ORT_NR);
      if (dset) { const { F_HEX_CODE, F_ORT_TEXT, ...rich } = dset; Object.assign(f, rich); }
    } catch { /* keep base entry */ }
  }
}

// pick the detail set for fault nr. match F_ORT_NR first; fall back to a p-code/hex
// set only when no set has an F_ORT_NR, so wrong-fault data isnt attached
function matchDetail(sets, nr) {
  const list = sets || [];
  return list.find(s => s.F_ORT_NR == nr)
      || (list.some(s => s.F_ORT_NR != null) ? null
          : list.find(s => s.F_PCODE_STRING || s.F_HEX_CODE));
}

// corner warning badge for stored faults. click expands the detail list; stays
// until dismissed or the screen changes (setActions calls dismissAttention).
let _attDismiss = null;
function dismissAttention() { if (_attDismiss) _attDismiss(); }
function showAttentionPopup(findings) {
  document.getElementById('att-badge')?.remove();   // replace any existing
  document.getElementById('att-panel')?.remove();
  const total = findings.reduce((n, f) => n + f.faults.length, 0);

  const badge = document.createElement('button');
  badge.id = 'att-badge';
  badge.className = 'att-corner';
  badge.title = `${total} stored fault${total === 1 ? '' : 's'} - click for detail`;
  badge.innerHTML = `<span class="att-tri">▲</span><span class="att-count">${total}</span>`;
  document.body.appendChild(badge);
  requestAnimationFrame(() => badge.classList.add('show'));

  // expanded detail panel, built once and toggled
  const blocks = findings.map(g => `
    <div class="att-group">
      <div class="att-ecu">${esc(g.label)} · ${g.faults.length} fault${g.faults.length === 1 ? '' : 's'}</div>
      ${g.faults.map(c => {
        const hex = c.F_HEX_CODE || '';
        const pstr = c.F_PCODE_STRING || pCode(c.F_ORT_TEXT, hex) || '';
        const { name, present } = faultFields(c);
        return `<div class="att-fault${present ? ' present' : ''}">
          <div class="att-name">${esc(name)}${present ? '<span class="att-badge">PRESENT</span>' : ''}</div>
          <div class="att-meta">${esc(`${deGerman(c.F_SYMPTOM_TEXT) || ''}${pstr ? ` · ${pstr}` : ''}${(c.F_HFK || c.F_LZ) ? ` · seen ${c.F_HFK || c.F_LZ}×` : ''}`)}</div>
        </div>`;
      }).join('')}
    </div>`).join('');
  const panel = document.createElement('div');
  panel.id = 'att-panel';
  panel.className = 'att-panel';
  panel.innerHTML = `
    <div class="att-panel-head">
      <span>⚠︎ ${total} stored fault${total === 1 ? '' : 's'}</span>
      <button class="att-x" title="Dismiss">✕</button>
    </div>
    <div class="att-body">${blocks}</div>
    <div class="att-panel-foot"><button class="btn primary att-open">Open faults</button></div>`;
  document.body.appendChild(panel);

  let open = false;
  const setOpen = (v) => { open = v; panel.classList.toggle('show', v); badge.classList.toggle('expanded', v); };
  const onDocClick = (e) => {
    if (open && !panel.contains(e.target) && e.target !== badge && !badge.contains(e.target)) setOpen(false);
  };
  const dismiss = () => {
    document.removeEventListener('click', onDocClick); badge.remove(); panel.remove();
    if (_attDismiss === dismiss) _attDismiss = null;
  };
  _attDismiss = dismiss; // navigation (setActions) tears the popup down
  badge.onclick = () => setOpen(!open);
  panel.querySelector('.att-x').onclick = (e) => { e.stopPropagation(); dismiss(); };
  panel.querySelector('.att-open').onclick = () => {
    const g = findings[0];
    dismiss(); // navigating away, clean up badge + listener
    showEcu('E46', 'Engine', { sgbd: g.sgbd, code: g.sgbd, label: g.label });
  };
  document.addEventListener('click', onDocClick); // removed in dismiss()
}

// INPA script-selection popup, opened on chassis pick. two panes: left lists
// section categories, right shows the section's ECUs. Esc aborts.
async function showScriptSelection(chassisId) {
  if (chassisId.toUpperCase() === 'E46') autoScanE46(); // background scan on E46 open
  let ch;
  try { ch = await api(`/api/chassis/${chassisId}`); }
  catch (e) { showSections(chassisId); return; } // fall back to the full screen

  // INPA semantics: <ESC> aborts script selection back to the vehicle-select
  // screen (not to whatever screen the popup covered). picking an ECU or the
  // functional-jobs entry closes with no value, so those paths don't navigate.
  const modalOpts = {
    onKey: (e, c) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); c('abort'); } },
    onClose: (val) => { if (val === 'abort') showChassis(); },
    backdropValue: 'abort',
  };
  const { overlay, close } = openModal(`
    <div class="inpa-scriptsel" role="dialog" aria-modal="true">
      <div class="inpa-ss-bar">Script selection&nbsp;&nbsp;&nbsp;<span class="inpa-ss-hint">(&lt;TAB&gt; to change listbox, &lt;ESC&gt; to abort)</span></div>
      <div class="inpa-ss-panes">
        <div class="inpa-ss-left" id="ss-left">
          <button class="inpa-ss-item inpa-ss-chassis" data-i="-1">${esc(dispChassis(chassisId))}</button>
          ${ch.sections.map((s, i) => `<button class="inpa-ss-item" data-i="${i}">${esc(s.name)}</button>`).join('')}
        </div>
        <div class="inpa-ss-right" id="ss-right">
          <div class="inpa-ss-head" id="ss-head">Functional jobs</div>
          <div class="inpa-ss-jobs" id="ss-jobs"></div>
        </div>
      </div>
    </div>`, modalOpts);

  const jobsPane = overlay.querySelector('#ss-jobs');
  const headEl = overlay.querySelector('#ss-head');
  const items = overlay.querySelectorAll('.inpa-ss-item');
  // Functional Jobs (whole-vehicle Identify/Fault sweep). enabled for chassis with
  // variant-group + sweep-priority tables, so the sweep skips dead variants.
  const allowFunc = !!VARIANT_GROUPS[chassisId.toUpperCase()];

  // chassis row selected: the single "Functional jobs" header is the entry,
  // clickable, with nothing listed beneath it.
  const showChassisJobs = () => {
    items.forEach(it => it.classList.toggle('active', it.dataset.i === '-1'));
    headEl.hidden = false;
    headEl.textContent = 'Functional jobs';
    jobsPane.innerHTML = '';
    headEl.classList.toggle('func', allowFunc);
    headEl.onclick = allowFunc ? () => { close(); showFunctionalJobs(chassisId); } : null;
  };

  // section row selected: right pane is just that section's ECU modules. no
  // header (it would only repeat the section name already selected on the left).
  const showSection = (i) => {
    items.forEach(it => it.classList.toggle('active', it.dataset.i === String(i)));
    const sec = ch.sections[i];
    headEl.hidden = true;
    headEl.classList.remove('func');
    headEl.onclick = null;
    jobsPane.innerHTML = sec.ecus.length
      ? sec.ecus.map(e => `<button class="inpa-ss-job" data-sgbd="${esc(e.sgbd)}" data-code="${esc(e.code)}" data-label="${esc(e.label)}">${esc(e.label)}</button>`).join('')
      : '<div class="inpa-ss-empty">No modules</div>';
    jobsPane.querySelectorAll('.inpa-ss-job').forEach(b => {
      b.onclick = () => { close(); showEcu(chassisId, sec.name, { sgbd: b.dataset.sgbd, code: b.dataset.code, label: b.dataset.label }); };
    });
  };

  items.forEach(it => {
    const i = Number(it.dataset.i);
    it.onclick = () => (i === -1 ? showChassisJobs() : showSection(i));
  });
  showChassisJobs(); // open on the chassis row: Functional Jobs only
}

// INPA "Functional Jobs" menu: F2 Identification (quickIdentSweep), F4 Fault
// Memory (quickErrorSweep).
function showFunctionalJobs(chassisId) {
  const id = chassisId || 'E46';
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id) }, { label: 'Functional Jobs' }]);
  sbLeft.textContent = 'functional jobs';
  view.innerHTML = head('Functional Jobs', `${dispChassis(id)} · all modules`,
    'Whole-vehicle operations across every control unit.');
  const grid = document.createElement('div');
  grid.className = 'group-grid stagger';
  view.appendChild(grid);

  const jobs = [
    { key: '2', name: 'Identification', desc: 'Identify every module on the car (SGBD, HW/SW)', fn: () => quickIdentSweep(id) },
    { key: '4', name: 'Fault Memory', desc: 'Read fault memory across all modules, which have stored faults', fn: () => quickErrorSweep(id) },
  ];
  jobs.forEach(j => {
    const tile = document.createElement('div');
    tile.className = 'group-tile';
    tile.innerHTML = `<div class="group-name">F${j.key} · ${j.name}</div>
      <div class="group-count">${j.desc}</div><div class="group-arrow">→</div>`;
    tile.onclick = j.fn;
    grid.appendChild(tile);
  });
  stagger(grid, 40);
  setActions([
    { key: '2', label: 'Identification', kind: 'primary', fn: () => quickIdentSweep(id) },
    { key: '4', label: 'Fault Memory', fn: () => quickErrorSweep(id) },
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showChassis() },
  ]);
}

// "Old models" popup (INPA Shift+F9): chassis hidden from the main list
function showOtherModels(ids) {
  const { overlay, close } = openModal(`
    <div class="modal inpa-pop" role="dialog" aria-modal="true">
      <div class="modal-title">Other models</div>
      <div class="inpa-pop-list">${ids.map((id, i) => `
        <button class="inpa-pop-row" data-id="${esc(id)}">
          <span class="inpa-pop-key">F${i + 1}</span>
          <span class="inpa-pop-label">${esc(dispChassis(id))}${CHASSIS_TAG[id] ? ` · ${CHASSIS_TAG[id]}` : ''}</span>
        </button>`).join('')}</div>
      <div class="modal-actions"><button class="btn modal-cancel">Close<span class="modal-key">Esc</span></button></div>
    </div>`);
  overlay.querySelector('.modal-cancel').onclick = () => close();
  overlay.querySelectorAll('.inpa-pop-row').forEach(b => b.onclick = () => { close(); showScriptSelection(b.dataset.id); });
}

// "Special tests" popup (INPA Shift+F8). quick sweeps scan every ECU on the
// chassis; chassis-specific routines not yet safe to run are disabled.
const SPECIAL_TESTS = [
  { id: 'quick-error',  label: 'Quick error memory test', run: (id) => quickErrorSweep(id) },
  { id: 'quick-ident',  label: 'Quick identification test', run: (id) => quickIdentSweep(id) },
  { id: 'abs-bleed',    label: 'ABS/ASC bleeding', disabled: true },
  { id: 'lws-adjust',   label: 'Steering angle adjustment', disabled: true },
  { id: 'rdc-telegram', label: 'RDC telegram recording', disabled: true },
  { id: 'rdc-antenna',  label: 'RDC antenna check', disabled: true },
];

function showSpecialTests(chassisId) {
  const { overlay, close } = openModal(`
    <div class="modal inpa-script" role="dialog" aria-modal="true">
      <div class="inpa-script-bar">Script selection <span class="inpa-script-hint">(&lt;Esc&gt; to abort)</span></div>
      <div class="inpa-script-panes">
        <div class="inpa-script-cats"><div class="inpa-script-cat active">Special tests</div></div>
        <div class="inpa-script-list">${SPECIAL_TESTS.map((t, i) => `
          <button class="inpa-script-row${t.disabled ? ' disabled' : ''}" data-i="${i}"${t.disabled ? ' disabled' : ''}>${t.label}</button>`).join('')}</div>
      </div>
      <div class="modal-actions"><button class="btn modal-cancel">Close<span class="modal-key">Esc</span></button></div>
    </div>`);
  overlay.querySelector('.modal-cancel').onclick = () => close();
  overlay.querySelectorAll('.inpa-script-row:not(.disabled)').forEach(b => {
    b.onclick = () => { const t = SPECIAL_TESTS[+b.dataset.i]; close(); if (t.run) t.run(chassisId); };
  });
}

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
// the shared faultFields projection (faults.js) so the rows and the PDF report
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

// build a clean, self-contained fault-report PDF and save it via the Electron
// bridge. groups faults by module, shows code + English name + present/stored.
// shared fault-report styling for the PDF exports. one <style> block used by both
// the whole-car quick sweep and the single-ECU export so they look identical.
const FAULT_REPORT_CSS = `
    * { box-sizing: border-box; }
    body { font: 13px -apple-system, "Helvetica Neue", Arial, sans-serif; color: #14181d; margin: 0; padding: 0 4px; }
    header { border-bottom: 2px solid #14181d; padding-bottom: 10px; margin-bottom: 16px; }
    .brand { font-size: 22px; font-weight: 800; letter-spacing: .04em; }
    .sub { color: #555; font-size: 12px; margin-top: 2px; }
    .meta { margin-top: 8px; font-size: 11.5px; color: #333; display: flex; gap: 22px; flex-wrap: wrap; }
    .meta b { color: #14181d; }
    .mod { margin: 0 0 16px; page-break-inside: avoid; }
    .mod h2 { font-size: 14px; margin: 0 0 5px; border-left: 4px solid #c0392b; padding-left: 8px; }
    .mod .sgbd { font: 600 10.5px "SF Mono", Menlo, monospace; color: #888; }
    .mod .modcount { float: right; font-size: 11px; color: #c0392b; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #777;
         border-bottom: 1px solid #ccc; padding: 4px 6px; }
    td { padding: 5px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
    .c-code { font: 700 12px "SF Mono", Menlo, monospace; white-space: nowrap; width: 72px; }
    .c-state { font: 600 10.5px "SF Mono", Menlo, monospace; color: #777; white-space: nowrap; width: 64px; text-align: right; }
    tr.present .c-code, tr.present .c-state { color: #c0392b; }
    .clean-note { padding: 24px; text-align: center; color: #2e7d32; font-size: 15px; font-weight: 600;
                  border: 1px solid #cde6cd; border-radius: 6px; background: #f3faf3; }
    footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 10px; color: #999; }`;

// one module -> a <section> block of its faults
function faultModuleBlock(label, sgbd, codes) {
  const rows = codes.map(c => {
    const { code, name, present } = faultFields(c);
    return `<tr class="${present ? 'present' : ''}">
      <td class="c-code">${esc(code)}</td>
      <td class="c-name">${esc(name)}</td>
      <td class="c-state">${present ? 'PRESENT' : 'stored'}</td></tr>`;
  }).join('');
  return `<section class="mod">
    <h2>${esc(label)} <span class="sgbd">${esc(sgbd)}</span>
      <span class="modcount">${codes.length} fault${codes.length === 1 ? '' : 's'}</span></h2>
    <table><thead><tr><th>Code</th><th>Description</th><th>State</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </section>`;
}

// assemble the full report document. metaPairs: [[label, value], ...]
function faultReportHtml(sub, metaPairs, bodyHtml) {
  const meta = metaPairs.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FAULT_REPORT_CSS}</style></head><body>
    <header>
      <div class="brand">BMacW Fault Report</div>
      <div class="sub">${esc(sub)}</div>
      <div class="meta">${meta}</div>
    </header>
    ${bodyHtml}
    <footer>BMacW · native macOS BMW diagnostics. Codes read over K+DCAN; descriptions are best-effort translations.</footer>
  </body></html>`;
}

async function exportFaultPdf(chassisId, faulty, stats) {
  const now = new Date();
  const totalFaults = faulty.reduce((n, f) => n + f.codes.length, 0);
  const body = faulty.length
    ? faulty.map(f => faultModuleBlock(f.ecu.label, f.ecu.sgbd, f.codes)).join('')
    : `<div class="clean-note">No stored faults. ${stats.scanned} module${stats.scanned === 1 ? '' : 's'} read, ${stats.skipped} skipped.</div>`;
  const html = faultReportHtml(
    `${dispChassis(chassisId)} · fault memory across all modules`,
    [['Generated', now.toLocaleString()], ['Modules with faults', faulty.length],
     ['Total faults', totalFaults], ['Read', `${stats.scanned} · skipped ${stats.skipped}`]],
    body);

  const name = `BMacW-faults-${dispChassis(chassisId)}-${now.toISOString().slice(0, 10)}.pdf`;
  const btn = document.getElementById('quick-pdf');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const res = await window.bmacw.savePdf(name, html);
    if (btn) btn.textContent = res && res.ok ? 'Saved' : 'Export PDF';
    if (btn) btn.disabled = false;
  } catch {
    if (btn) { btn.textContent = 'Export PDF'; btn.disabled = false; }
  }
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

// mirror topbar Battery/Ignition state into the INPA vehicle-select indicators
function syncVselState() {
  const bs = document.getElementById('vsel-bat'), bv = document.getElementById('vsel-bat-s');
  const is = document.getElementById('vsel-ign'), iv = document.getElementById('vsel-ign-s');
  if (!bs) return;
  const batOn = batLed && batLed.classList.contains('on');
  const ignOn = ignLed && ignLed.classList.contains('on');
  bs.className = 'inpa-kl-led' + (batOn ? ' on' : ''); bv.textContent = batOn ? (batVal.textContent) : 'off';
  is.className = 'inpa-kl-led' + (ignOn ? ' on' : ''); iv.textContent = ignOn ? 'on' : 'off';
}

// where "Back" from an ECU should land. in INPA mode the module list is the
// Script selection popup, so return there; in modern mode, the sections screen.
function backToModules(chassisId) {
  if (typeof inpaMode === 'function' && inpaMode()) showScriptSelection(chassisId);
  else showSections(chassisId);
}

// screen 2: sections sidebar + ECU list
async function showSections(id, selectIndex = 0) {
  cancelSweep();                 // entering the section list stops any sweep
  lastScreen = () => showSections(id, selectIndex);
  if (id.toUpperCase() === 'E46') autoScanE46(); // background scan on E46 open
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id) }]);
  sbLeft.textContent = `loading ${dispChassis(id)}…`;
  view.innerHTML = head('Control modules', dispChassis(id), 'Pick a system on the left, then a module.');

  const split = document.createElement('div');
  split.className = 'split';
  split.innerHTML = `<nav class="split-nav" id="split-nav"></nav>
                     <div class="split-content" id="split-content"></div>`;
  view.appendChild(split);

  const ch = await tryApi(`/api/chassis/${id}`, null, view, `failed to load ${dispChassis(id)}`);
  if (!ch) return;
  const nav = split.querySelector('#split-nav');
  const content = split.querySelector('#split-content');

  function selectSection(idx) {
    selectIndex = idx;
    const sec = ch.sections[idx];
    [...nav.children].forEach((n, i) => n.classList.toggle('active', i === idx));
    content.innerHTML = '';
    const listWrap = document.createElement('div');
    listWrap.className = 'ecu-list stagger';
    sec.ecus.forEach(ecu => {
      const row = document.createElement('div');
      row.className = 'ecu-row';
      row.innerHTML = `
        <span class="ecu-bullet"></span>
        <span class="ecu-label">${esc(ecu.label)}</span>
        <span class="ecu-sgbd">${esc(ecu.sgbd)}</span>`;
      row.onclick = () => showEcu(id, sec.name, ecu);
      listWrap.appendChild(row);
    });
    content.appendChild(listWrap);
    stagger(listWrap, 14);
    sbRight.textContent = `${sec.ecus.length} module${sec.ecus.length === 1 ? '' : 's'}`;
  }

  ch.sections.forEach((sec, idx) => {
    const item = document.createElement('button');
    item.className = 'split-nav-item';
    // badge = shortcut key (1..N), matching the footer F-key bar
    item.innerHTML = `<span class="nav-key">${idx + 1}</span>
                      <span class="nav-name">${esc(sec.name)}</span>`;
    item.onclick = () => selectSection(idx);
    nav.appendChild(item);
  });

  sbLeft.textContent = ch.description;
  selectSection(Math.min(selectIndex, ch.sections.length - 1));

  // number keys select a system, Esc goes back
  const actions = ch.sections.slice(0, 8).map((s, i) => ({
    key: String(i + 1), label: s.name, fn: () => selectSection(i),
  }));
  actions.push({ key: 'Escape', keyLabel: 'Esc', label: 'Vehicles', kind: 'back', fn: showChassis });
  setActions(actions);
}

// screen 3: ECU fault dashboard.
