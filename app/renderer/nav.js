// navigation: chassis select, INPA script picker, sweeps, sections
async function showChassis() {
  lastScreen = showChassis;
  setCrumbs([{ label: 'Vehicles' }]);
  sbLeft.textContent = 'select chassis';
  const ids = await api('/api/chassis');

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
      <button class="inpa-fn" data-id="${id}">
        <span class="inpa-fn-key">&lt; F${i} &gt;</span>
        <span class="inpa-fn-label">${label}</span>
      </button>`;
    panel.innerHTML = `
      <div class="inpa-klrow">
        <span class="inpa-kl"><span class="inpa-kl-name">Battery :</span><span class="inpa-kl-led" id="vsel-bat"></span><span class="inpa-kl-state" id="vsel-bat-s">off</span></span>
        <span class="inpa-kl"><span class="inpa-kl-name">Ignition :</span><span class="inpa-kl-led" id="vsel-ign"></span><span class="inpa-kl-state" id="vsel-ign-s">off</span></span>
      </div>
      <div class="inpa-vsplit">
        <div class="inpa-vlist">${main.map((id, i) => fnRow(i + 1, id, `${dispChassis(id)}${CHASSIS_TAG[id] ? ` · ${CHASSIS_TAG[id]}` : ''}`)).join('')}</div>
        <div class="inpa-vlist inpa-vlist-right">
          ${old.length ? `<button class="inpa-fn inpa-fn-more" id="vsel-old"><span class="inpa-fn-key">&lt;Shift+F9&gt;</span><span class="inpa-fn-label">Old models …</span></button>` : ''}
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
    if (old.length) acts.push({ key: '9', label: 'Old models', fn: () => showOtherModels(old) });
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
      <div class="chassis-code">${dispChassis(id)}</div>
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
  if ((_autoScanRan && !force) || _autoScanning) return; // re-entrancy + once-per-session
  _autoScanning = true;
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
    if (findings.length) showAttentionPopup(findings);
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
// until dismissed.
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
      <div class="att-ecu">${g.label} · ${g.faults.length} fault${g.faults.length === 1 ? '' : 's'}</div>
      ${g.faults.map(c => {
        const hex = c.F_HEX_CODE || '';
        const pstr = c.F_PCODE_STRING || pCode(c.F_ORT_TEXT, hex) || '';
        const present = (c.F_VORHANDEN_TEXT || '').toLowerCase().includes('momentan vorhanden')
          && !(c.F_VORHANDEN_TEXT || '').toLowerCase().includes('nicht vorhanden');
        return `<div class="att-fault${present ? ' present' : ''}">
          <div class="att-name">${faultName(c.F_ORT_TEXT, hex)}${present ? '<span class="att-badge">PRESENT</span>' : ''}</div>
          <div class="att-meta">${deGerman(c.F_SYMPTOM_TEXT) || ''}${pstr ? ` · ${pstr}` : ''}${(c.F_HFK || c.F_LZ) ? ` · seen ${c.F_HFK || c.F_LZ}×` : ''}</div>
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
  const dismiss = () => { document.removeEventListener('click', onDocClick); badge.remove(); panel.remove(); };
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

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="inpa-scriptsel" role="dialog" aria-modal="true">
      <div class="inpa-ss-bar">Script selection&nbsp;&nbsp;&nbsp;<span class="inpa-ss-hint">(&lt;TAB&gt; to change listbox, &lt;ESC&gt; to abort)</span></div>
      <div class="inpa-ss-panes">
        <div class="inpa-ss-left" id="ss-left">
          <button class="inpa-ss-item inpa-ss-chassis" data-i="-1">${dispChassis(chassisId)}</button>
          ${ch.sections.map((s, i) => `<button class="inpa-ss-item" data-i="${i}">${s.name}</button>`).join('')}
        </div>
        <div class="inpa-ss-right" id="ss-right">
          <div class="inpa-ss-head" id="ss-head">Functional jobs</div>
          <div class="inpa-ss-jobs" id="ss-jobs"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  const close = () => { overlay.classList.remove('show'); window.removeEventListener('keydown', onKey, true); setTimeout(() => overlay.remove(), 160); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  window.addEventListener('keydown', onKey, true);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const jobsPane = overlay.querySelector('#ss-jobs');
  const headEl = overlay.querySelector('#ss-head');
  const items = overlay.querySelectorAll('.inpa-ss-item');
  // Functional Jobs (whole-vehicle Identify/Fault sweep) only validated for E46.
  const allowFunc = chassisId.toUpperCase() === 'E46';

  // chassis row selected: right pane is Functional Jobs only, nothing else.
  const showChassisJobs = () => {
    items.forEach(it => it.classList.toggle('active', it.dataset.i === '-1'));
    headEl.textContent = 'Functional jobs';
    jobsPane.innerHTML = allowFunc
      ? `<button class="inpa-ss-job func" data-func="1">Functional Jobs</button>`
      : '<div class="inpa-ss-empty">No functional jobs</div>';
    const fb = jobsPane.querySelector('.inpa-ss-job.func');
    if (fb) fb.onclick = () => { close(); showFunctionalJobs(chassisId); };
  };

  // section row selected: right pane is that section's ECU modules, no jobs.
  const showSection = (i) => {
    items.forEach(it => it.classList.toggle('active', it.dataset.i === String(i)));
    const sec = ch.sections[i];
    headEl.textContent = sec.name;
    jobsPane.innerHTML = sec.ecus.length
      ? sec.ecus.map(e => `<button class="inpa-ss-job" data-sgbd="${e.sgbd}" data-code="${e.code}" data-label="${e.label.replace(/"/g, '&quot;')}">${e.label}</button>`).join('')
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
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal inpa-pop" role="dialog" aria-modal="true">
      <div class="modal-title">Old models</div>
      <div class="inpa-pop-list">${ids.map((id, i) => `
        <button class="inpa-pop-row" data-id="${id}">
          <span class="inpa-pop-key">F${i + 1}</span>
          <span class="inpa-pop-label">${dispChassis(id)}${CHASSIS_TAG[id] ? ` · ${CHASSIS_TAG[id]}` : ''}</span>
        </button>`).join('')}</div>
      <div class="modal-actions"><button class="btn modal-cancel">Close<span class="modal-key">Esc</span></button></div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  const close = () => { overlay.classList.remove('show'); window.removeEventListener('keydown', onKey, true); setTimeout(() => overlay.remove(), 160); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  window.addEventListener('keydown', onKey, true);
  overlay.querySelector('.modal-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelectorAll('.inpa-pop-row').forEach(b => b.onclick = () => { close(); showScriptSelection(b.dataset.id); });
}

// "Special tests" popup (INPA Shift+F8). quick sweeps scan every ECU on the
// chassis; chassis-specific routines not yet safe to run are disabled.
const SPECIAL_TESTS = [
  { id: 'quick-error',  label: 'Quick error memory test', run: (id) => quickErrorSweep(id) },
  { id: 'quick-ident',  label: 'Quick identification test', run: (id) => quickIdentSweep(id) },
  { id: 'quick-test',   label: 'Quick test', run: (id) => quickErrorSweep(id) },
  { id: 'quick-id',     label: 'Quick identification', run: (id) => quickIdentSweep(id) },
  { id: 'abs-bleed',    label: 'ABS/ASC bleeding', disabled: true },
  { id: 'lws-adjust',   label: 'Steering angle adjustment', disabled: true },
  { id: 'rdc-telegram', label: 'RDC telegram recording', disabled: true },
  { id: 'rdc-antenna',  label: 'RDC antenna check', disabled: true },
];

function showSpecialTests(chassisId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal inpa-script" role="dialog" aria-modal="true">
      <div class="inpa-script-bar">Script selection <span class="inpa-script-hint">(&lt;Esc&gt; to abort)</span></div>
      <div class="inpa-script-panes">
        <div class="inpa-script-cats"><div class="inpa-script-cat active">Special tests</div></div>
        <div class="inpa-script-list">${SPECIAL_TESTS.map((t, i) => `
          <button class="inpa-script-row${t.disabled ? ' disabled' : ''}" data-i="${i}"${t.disabled ? ' disabled' : ''}>${t.label}</button>`).join('')}</div>
      </div>
      <div class="modal-actions"><button class="btn modal-cancel">Close<span class="modal-key">Esc</span></button></div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  const close = () => { overlay.classList.remove('show'); window.removeEventListener('keydown', onKey, true); setTimeout(() => overlay.remove(), 160); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  window.addEventListener('keydown', onKey, true);
  overlay.querySelector('.modal-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelectorAll('.inpa-script-row:not(.disabled)').forEach(b => {
    b.onclick = () => { const t = SPECIAL_TESTS[+b.dataset.i]; close(); if (t.run) t.run(chassisId); };
  });
}

// E46 variant groups: ECUs sharing one diagnostic address, only one installed.
// once a member responds the rest are absent (or echoes), so the sweep skips them.
// engine group alone has 12 mutually-exclusive DMEs at ~7s each.
const E46_VARIANT_GROUPS = {
  engine: ['DDE40', 'D50M47', 'D50M57', 'BMS46', 'ME9_4N', 'ME9NG4TU', 'MS420', 'MS430', 'MS450', 'MSS54M3', 'CARB'],
  trans:  ['gsds2', 'gs30', 'smg2'],
  dsc:    ['ascdsc46', 'absasc5', 'dscmk60'],
};
// INPA entry code -> group key (case-insensitive). the groups list ENTRY codes
// (MS450, gsds2), which the chassis API returns as ecu.code; ecu.sgbd is the
// resolved .prg name (ms450ds0) and would never match.
const _groupOf = (code) => {
  const s = (code || '').toLowerCase();
  for (const [k, list] of Object.entries(E46_VARIANT_GROUPS))
    if (list.some(x => x.toLowerCase() === s)) return k;
  return null;
};
// stable fault signature for echo dedup. F_HEX_CODE is globally unique (BMW DTC);
// F_ORT_NR is only an ECU-local index, so fall back to it only if hex is absent.
const _faultSig = (codes) =>
  (codes || []).map(c => c.F_HEX_CODE || `nr:${c.F_ORT_NR}`).join(',');

// quick error memory test (INPA FSQUICK): read fault memory on every chassis ECU,
// combined report of which modules have stored faults.
async function quickErrorSweep(chassisId) {
  const id = chassisId || 'E46';
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id), fn: () => showSections(id) }, { label: 'Quick error sweep' }]);
  view.innerHTML = head('Special tests', 'Quick error memory test', `Scanning every module on the ${dispChassis(id)} for stored faults…`);
  const out = document.createElement('div'); out.className = 'results-panel'; view.appendChild(out);
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showSections(id) }]);
  let ch;
  try { ch = await api(`/api/chassis/${id}`); }
  catch (e) { out.innerHTML = errorBlock(e.message); return; }
  const ecus = dedupEcus(ch); sortByPriority(ecus);
  out.innerHTML = `<div class="quick-sweep"><div class="quick-head">${ecus.length} modules · scanning…</div><div class="quick-rows" id="quick-rows"></div></div>`;
  const rows = out.querySelector('#quick-rows');
  let withFaults = 0, scanned = 0, dupes = 0, skipped = 0;
  // each read costs ~7s (K-line wake-up) whether the ECU answers or not. variant
  // groups share one address, only one installed, so once a group's ECU responds
  // skip the rest. dedup by fault signature catches echoes. cuts the 12 engine
  // variants to ~1-2 reads.
  const seen = new Map();          // fault-signature -> first ECU label
  const groupDone = new Set();     // variant-group key that already responded
  for (const ecu of ecus) {
    const grp = _groupOf(ecu.code);
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
        }
      } else { row.classList.add('clean'); row.querySelector('.quick-status').textContent = 'OK'; }
    } catch (e) {
      row.classList.add('noresp'); row.querySelector('.quick-status').textContent = 'no response';
    }
    scanned++;
    out.querySelector('.quick-head').textContent = `${scanned} read · ${skipped} skipped · ${withFaults} with faults`;
  }
  out.querySelector('.quick-head').textContent =
    `Done · ${scanned} read, ${skipped} skipped · ${withFaults} with stored faults${dupes ? ` · ${dupes} echoes hidden` : ''}`;
  sbLeft.textContent = `quick sweep · ${withFaults} faulty`;
}

// quick identification (INPA IDQUICK): read IDENT on every chassis ECU
async function quickIdentSweep(chassisId) {
  const id = chassisId || 'E46';
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id), fn: () => showSections(id) }, { label: 'Quick identification' }]);
  view.innerHTML = head('Special tests', 'Quick identification', `Identifying every module on the ${dispChassis(id)}…`);
  const out = document.createElement('div'); out.className = 'results-panel'; view.appendChild(out);
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showSections(id) }]);
  let ch;
  try { ch = await api(`/api/chassis/${id}`); }
  catch (e) { out.innerHTML = errorBlock(e.message); return; }
  const ecus = dedupEcus(ch); sortByPriority(ecus);
  out.innerHTML = `<div class="quick-sweep"><div class="quick-head">${ecus.length} modules · identifying…</div><div class="quick-rows" id="quick-rows"></div></div>`;
  const rows = out.querySelector('#quick-rows');
  const head_ = out.querySelector('.quick-head');
  let present = 0, scanned = 0;
  const groupDone = new Set();
  for (const ecu of ecus) {
    const grp = _groupOf(ecu.code);
    const row = addSweepRow(rows, ecu.label);
    if (grp && groupDone.has(grp)) { row.classList.add('noresp'); row.querySelector('.quick-status').textContent = 'skipped (variant)'; continue; }
    try {
      const data = await api(`/api/ecu/${ecu.sgbd}/run/IDENT`, { method: 'POST' });
      if (grp) groupDone.add(grp);
      const set = (data.sets || []).slice(1).find(s => Object.keys(s).some(k => !k.startsWith('_')));
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
const SWEEP_PRIORITY = ['MS450', 'MS430', 'MS420', 'ME9_4N', 'MSS54M3', 'BMS46', 'gsds2', 'smg2', 'ascdsc46', 'absasc5'];
function sortByPriority(ecus) {
  const prio = (e) => { const i = SWEEP_PRIORITY.findIndex(p => p.toLowerCase() === (e.code || '').toLowerCase()); return i < 0 ? 99 : i; };
  ecus.sort((a, b) => prio(a) - prio(b));
}
function addSweepRow(rows, label) {
  const row = document.createElement('div'); row.className = 'quick-row';
  row.innerHTML = `<span class="quick-ecu">${label}</span><span class="quick-status">scanning…</span>`;
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

// screen 2: sections sidebar + ECU list
async function showSections(id, selectIndex = 0) {
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

  const ch = await api(`/api/chassis/${id}`);
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
        <span class="ecu-label">${ecu.label}</span>
        <span class="ecu-sgbd">${ecu.sgbd}</span>`;
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
                      <span class="nav-name">${sec.name}</span>`;
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
