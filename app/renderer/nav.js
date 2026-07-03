// navigation: chassis select, INPA script picker, functional-jobs menu, sections.
// the whole-vehicle sweeps live in sweep.js, the background E46 auto-scan +
// attention popup in autoscan.js, and the PDF fault report in fault-report.js.
async function showChassis() {
  cancelSweep();                 // leaving for the chassis list stops any sweep (sweep.js)
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

// INPA script-selection popup, opened on chassis pick. two panes: left lists
// section categories, right shows the section's ECUs. Esc aborts.
async function showScriptSelection(chassisId) {
  if (chassisId.toUpperCase() === 'E46') autoScanE46(); // background scan on E46 open (autoscan.js)
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
  // variant-group + sweep-priority tables (sweep.js), so the sweep skips dead variants.
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
// Memory (quickErrorSweep). the sweeps themselves live in sweep.js.
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
// chassis; chassis-specific routines not yet safe to run are disabled. the sweep
// runners (quickErrorSweep/quickIdentSweep) live in sweep.js.
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
  cancelSweep();                 // entering the section list stops any sweep (sweep.js)
  lastScreen = () => showSections(id, selectIndex);
  if (id.toUpperCase() === 'E46') autoScanE46(); // background scan on E46 open (autoscan.js)
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
