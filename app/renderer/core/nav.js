/**
 * @file Navigation: chassis select, INPA script picker, functional-jobs menu,
 * sections. Sweeps, the chassis auto-scan and the printed reports live in
 * screens/sweep/.
 */

/**
 * One control module as the chassis config lists it.
 * @typedef {Object} EcuRecord
 * @property {string} sgbd - The SGBD (.prg) that drives it.
 * @property {string} code - The module designation (DME, KOMBI, ...).
 * @property {string} label - Human name.
 * @property {string} [group] - Diagnostic-address group SGBD, when grouped.
 */

// Coding is not ready for the public build yet, so it is hidden on the
// deployed site (bmweb.danner.ink and any *.github.io mirror). It stays
// available everywhere else -- localhost dev and the macOS app -- where it is
// being worked on. Host-based, not build-flag, so the same bundle serves both.
/**
 * Whether the Coding entries may be shown on this host.
 * @returns {boolean}
 */
function codingReady() {
  if (typeof location === 'undefined') return true; // packaged app
  const h = String(location.hostname || '').toLowerCase();
  const hidden = h === 'bmweb.danner.ink' || h.endsWith('.github.io');
  return !hidden;
}

/**
 * Screen 1: the vehicle picker (INPA vehicle-select or the modern card grid).
 * @returns {Promise<void>}
 */
async function showChassis() {
  cancelSweep(); // leaving the chassis list stops any sweep (sweep.js)
  lastScreen = showChassis;
  setCrumbs([{ label: 'Vehicles' }]);
  sbLeft.textContent = 'select chassis';
  const ids = await tryApi('/api/chassis', null, view);
  if (!ids) return;

  if (inpaMode()) {
    // INPA vehicle select: common chassis on F1-F8, rest under "Other models" (F9). Keep COMMON at 8 so F9 stays free.
    const COMMON = ['E46', 'E39', 'E60', 'E65', 'E83', 'E85', 'E90', 'E70'];
    const main = COMMON.filter((id) => ids.includes(id));
    const old = ids.filter((id) => !main.includes(id));

    view.innerHTML = head('Vehicles', '', 'Select your vehicle.');
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
          ${old.length ? `<button class="inpa-fn inpa-fn-more" id="vsel-old"><span class="inpa-fn-key">&lt; F9 &gt;</span><span class="inpa-fn-label">Other models …</span></button>` : ''}
          <button class="inpa-fn inpa-fn-lookup" id="vsel-garage"><span class="inpa-fn-key">⌂</span><span class="inpa-fn-label">Garage …</span></button>
          <button class="inpa-fn inpa-fn-lookup" id="vsel-apps"><span class="inpa-fn-key">▦</span><span class="inpa-fn-label">Apps …</span></button>
        </div>
      </div>`;
    view.appendChild(panel);
    panel
      .querySelectorAll('.inpa-fn[data-id]')
      .forEach((b) => (b.onclick = () => showScriptSelection(b.dataset.id)));
    const oldBtn = panel.querySelector('#vsel-old');
    if (oldBtn) oldBtn.onclick = () => showOtherModels(old);
    panel.querySelector('#vsel-apps').onclick = () => showApps();
    // the Garage sits beside Apps here so the INPA layout reaches it too:
    // the modern layout draws it as a card above the chassis grid
    const garageBtn = panel.querySelector('#vsel-garage');
    if (typeof showGarage === 'function')
      garageBtn.onclick = () => showGarage();
    else garageBtn.remove();
    sbRight.textContent = `${main.length} common · ${old.length} more`;
    syncVselState();
    const acts = main.slice(0, 8).map((id, i) => ({
      key: String(i + 1),
      label: dispChassis(id),
      fn: () => showScriptSelection(id),
    }));
    if (old.length)
      acts.push({
        key: '9',
        label: 'Other models',
        fn: () => showOtherModels(old),
      });
    acts.push({ key: '0', label: 'Apps', fn: () => showApps() });
    setActions(acts);
    return;
  }

  view.innerHTML = head(
    'Vehicles',
    'Select your vehicle',
    'Choose a chassis to load its diagnostic modules.'
  );

  // Apps: reference tools, offline. Fault lookup and the ported dealer-software
  // apps (WDS wiring, ETK parts catalogue, ...) all live under one hub card. It
  // sits at the TOP of the home screen (like the VIN Decoder card atop the
  // parts page) so the door to everything is the first thing in reach.
  const appsCard = document.createElement('button');
  appsCard.className = 'lookup-entry etk-vin-entry';
  appsCard.innerHTML = `
    <span class="lookup-entry-icon">▦</span>
    <span class="lookup-entry-text">
      <span class="lookup-entry-title">Apps</span>
      <span class="lookup-entry-desc">Fault lookup, wiring diagrams, parts catalogue and more</span>
    </span>
    <span class="lookup-entry-arrow">→</span>`;
  appsCard.onclick = () => showApps();
  view.appendChild(appsCard);

  // Garage: the cars this user keeps, and the scan history read from each.
  // Above the chassis grid because a returning owner wants their own car, not
  // the list of every chassis the app supports.
  if (typeof showGarage === 'function') {
    const garageCard = document.createElement('button');
    garageCard.className = 'lookup-entry etk-vin-entry';
    const n = typeof garageCars === 'function' ? garageCars().length : 0;
    garageCard.innerHTML = `
      <span class="lookup-entry-icon">⌂</span>
      <span class="lookup-entry-text">
        <span class="lookup-entry-title">Garage</span>
        <span class="lookup-entry-desc">${esc(
          n
            ? `${n} saved vehicle${n === 1 ? '' : 's'} and their scan history`
            : 'Save your car and keep the scans read from it'
        )}</span>
      </span>
      <span class="lookup-entry-arrow">→</span>`;
    garageCard.onclick = () => showGarage();
    view.appendChild(garageCard);
  }

  const filterRow = document.createElement('div');
  filterRow.className = 'chassis-filter-row';
  // CHASSIS_TAG is lower-case, so match case-insensitively: an earlier .includes('3-SERIES') never matched and left the tag clause dead
  const tag = (id) => (CHASSIS_TAG[id] || '').toLowerCase();
  const filters = [
    { label: 'All', match: () => true },
    {
      label: '3-Series',
      match: (id) =>
        ['E30', 'E36', 'E46', 'E90', 'F030'].includes(id) ||
        tag(id).includes('3-series'),
    },
    {
      label: '5-Series',
      match: (id) =>
        ['E34', 'E39', 'E60', 'F010'].includes(id) ||
        tag(id).includes('5-series') ||
        tag(id).includes('5 gt'),
    },
    {
      label: '7-Series',
      match: (id) =>
        ['E32', 'E38', 'E65', 'F001', 'F01'].includes(id) ||
        tag(id).includes('7-series'),
    },
    {
      label: 'X-Series',
      match: (id) =>
        id.startsWith('E53') ||
        id.startsWith('E70') ||
        id.startsWith('E83') ||
        /^x\d/.test(tag(id)),
    },
    {
      label: 'Z / Mini',
      match: (id) =>
        id.startsWith('E52') ||
        id.startsWith('E85') ||
        id.startsWith('E89') ||
        id.startsWith('R5') ||
        tag(id).startsWith('z') ||
        tag(id).includes('mini'),
    },
  ];

  let activeFilter = filters[0];
  const grid = document.createElement('div');
  grid.className = 'chassis-grid stagger';

  function renderGrid() {
    grid.innerHTML = '';
    const filtered = ids.filter((id) => activeFilter.match(id));
    filtered.forEach((id) => {
      const card = document.createElement('div');
      card.className = 'chassis-card';
      card.innerHTML = `
        <div class="chassis-code">${esc(dispChassis(id))}</div>
        <div class="chassis-tag">${CHASSIS_TAG[id] || 'BMW'}</div>
        <div class="chassis-arrow">→</div>`;
      card.onclick = () => showSections(id);
      grid.appendChild(card);
    });
    stagger(grid, 18);
    sbRight.textContent = `${filtered.length} chassis`;
  }

  filters.forEach((f) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className =
      'chassis-filter-chip' + (f === activeFilter ? ' active' : '');
    chip.textContent = f.label;
    chip.onclick = () => {
      activeFilter = f;
      filterRow
        .querySelectorAll('.chassis-filter-chip')
        .forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderGrid();
    };
    filterRow.appendChild(chip);
  });

  view.appendChild(filterRow);
  view.appendChild(grid);
  renderGrid();

  const quick = ['E46', 'E60', 'E90'].filter((id) => ids.includes(id));
  const acts = quick.map((id, i) => ({
    key: String(i + 1),
    label: id,
    fn: () => showSections(id),
  }));
  acts.push({
    key: String(quick.length + 1),
    label: 'Apps',
    fn: () => showApps(),
  });
  setActions(acts);
}

// INPA script-selection popup: left lists section categories, right shows the section's ECUs
/**
 * The INPA script-selection popup for a chassis (falls back to the sections
 * screen when the config cannot load).
 * @param {string} chassisId - Chassis id (E46, ...).
 * @returns {Promise<void>}
 */
async function showScriptSelection(chassisId) {
  setStateSgbd(null); // reset the battery/ignition poll target now, re-aim below (screens/sweep/autoscan.js)
  let ch;
  try {
    ch = await api(`/api/chassis/${chassisId}`);
  } catch (e) {
    showSections(chassisId);
    return;
  } // fall back to the full screen
  setStateSgbd(ch); // retarget the battery/ignition poll at this chassis's DME (screens/sweep/autoscan.js)
  autoScan(chassisId, ch).catch(() => {}); // background engine/trans scan; no-ops when the config has no grouped targets

  // INPA semantics: <ESC> aborts to the vehicle-select screen (not whatever the popup covered); picking an ECU closes with no value so it doesn't navigate
  const modalOpts = {
    onKey: (e, c) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        c('abort');
      }
    },
    onClose: (val) => {
      if (val === 'abort') showChassis();
    },
    backdropValue: 'abort',
  };
  const { overlay, close } = openModal(
    `
    <div class="inpa-scriptsel" role="dialog" aria-modal="true">
      <div class="inpa-ss-bar">Script selection&nbsp;&nbsp;&nbsp;<span class="inpa-ss-hint">(&lt;TAB&gt; to change listbox, &lt;ESC&gt; to abort)</span></div>
      <div class="inpa-ss-panes">
        <div class="inpa-ss-left" id="ss-left">
          <button class="inpa-ss-item inpa-ss-chassis" data-i="-1">${esc(dispChassis(chassisId))}</button>
          ${ch.sections.map((s, i) => `<button class="inpa-ss-item" data-i="${i}">${esc(s.name)}</button>`).join('')}
          ${typeof showCodingHub === 'function' && codingReady() ? '<button class="inpa-ss-item inpa-ss-coding" data-i="-2">Coding</button>' : ''}
          ${typeof showVehicleIdentity === 'function' ? '<button class="inpa-ss-item inpa-ss-identity" data-i="-3" hidden>Identity</button>' : ''}
        </div>
        <div class="inpa-ss-right" id="ss-right">
          <div class="inpa-ss-head" id="ss-head">Functional jobs</div>
          <div class="inpa-ss-jobs" id="ss-jobs"></div>
        </div>
      </div>
    </div>`,
    modalOpts
  );

  const jobsPane = overlay.querySelector('#ss-jobs');
  const headEl = overlay.querySelector('#ss-head');
  const items = overlay.querySelectorAll('.inpa-ss-item');
  // Functional Jobs works on any chassis whose config lists modules: the sweep
  // resolves each diagnostic-address group over the wire (sweep.js), so there
  // is nothing per-chassis to know in advance. This used to be gated on a
  // hand-written variant-group table that named E46 and E36 only, which hid
  // whole-vehicle scanning on the other 24 shipped chassis.
  const allowFunc = (ch.sections || []).some((s) => (s.ecus || []).length > 0);

  // chassis row selected: the "Functional jobs" header itself is the clickable entry
  const showChassisJobs = () => {
    items.forEach((it) => it.classList.toggle('active', it.dataset.i === '-1'));
    headEl.hidden = false;
    headEl.textContent = 'Functional jobs';
    jobsPane.innerHTML = '';
    headEl.classList.toggle('func', allowFunc);
    headEl.onclick = allowFunc
      ? () => {
          close();
          showFunctionalJobs(chassisId);
        }
      : null;
  };

  // section row selected: right pane is just that section's ECU modules, no header
  const showSection = (i) => {
    items.forEach((it) =>
      it.classList.toggle('active', it.dataset.i === String(i))
    );
    const sec = ch.sections[i];
    headEl.hidden = true;
    headEl.classList.remove('func');
    headEl.onclick = null;
    jobsPane.innerHTML = sec.ecus.length
      ? sec.ecus.map(() => '<button class="inpa-ss-job"></button>').join('')
      : '<div class="inpa-ss-empty">No modules</div>';
    // Close over the FULL config row, not a {sgbd,code,label} rebuilt from
    // data- attributes: that rebuild dropped `group`, so on this INPA-layout
    // path irResolveGroupVariant saw an ungrouped ECU and never re-identified
    // the variant (an E46 IHKA stayed ihka38 instead of resolving ihka46_3).
    // The modern card already passes the whole object; match it.
    jobsPane.querySelectorAll('.inpa-ss-job').forEach((b, i) => {
      const e = sec.ecus[i];
      b.textContent = e.label;
      b.onclick = () => {
        close();
        showEcu(chassisId, sec.name, e);
      };
    });
  };

  // Coding row: open the Coding hub (Features + Expert)
  const openCoding = () => {
    close();
    showCodingHub(chassisId);
  };
  const openIdentity = () => {
    close();
    showVehicleIdentity(chassisId);
  };

  items.forEach((it) => {
    const i = Number(it.dataset.i);
    it.onclick = () =>
      i === -1
        ? showChassisJobs()
        : i === -2
          ? openCoding()
          : i === -3
            ? openIdentity()
            : showSection(i);
  });

  // The Identity row is built hidden and revealed only once a module on this
  // chassis is confirmed to answer with a build record. The list is drawn
  // synchronously and the probe is async, so revealing beats inserting: the
  // dialog never reflows under the pointer, and a chassis with no identity
  // source simply never shows the row rather than showing a dead end.
  const identRow = overlay.querySelector('.inpa-ss-identity');
  if (identRow && typeof chassisHasIdentity === 'function') {
    chassisHasIdentity(chassisId)
      .then((has) => {
        if (has) identRow.hidden = false;
      })
      .catch(() => {
        /* no identity source: the row stays hidden */
      });
  }
  showChassisJobs(); // open on the chassis row: Functional Jobs only
}

// INPA "Functional Jobs" menu: F2 Identification, F4 Fault Memory (sweeps in sweep.js)
/**
 * Functional Jobs: INPA's own whole-vehicle script where one ships (E46.IPO
 * reads every module's fault memory and writes the protocol), else the
 * identification sweep.
 * @param {string} chassisId - Chassis id.
 * @returns {Promise<void>}
 */
async function showFunctionalJobs(chassisId) {
  const id = chassisId || 'E46';
  if (await vehicleScriptShipped(id)) return showVehicleScript(id);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(id) },
    { label: 'Functional Jobs' },
  ]);
  sbLeft.textContent = 'functional jobs';
  view.innerHTML = head(
    'Functional Jobs',
    `${dispChassis(id)} · all modules`,
    'Whole-vehicle operations across every control unit.'
  );
  const grid = document.createElement('div');
  grid.className = 'group-grid stagger';
  view.appendChild(grid);
  const tile = document.createElement('div');
  tile.className = 'group-tile';
  tile.innerHTML = `<div class="group-name">F2 · Identification</div>
      <div class="group-count">Identify every module on the car: which are fitted, and each one\u2019s variant and build</div><div class="group-arrow">→</div>`;
  tile.onclick = () => quickIdentSweep(id);
  grid.appendChild(tile);
  stagger(grid, 40);
  setActions([
    {
      key: '2',
      label: 'Identification',
      kind: 'primary',
      fn: () => quickIdentSweep(id),
    },
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: () => showChassis(),
    },
  ]);
}

/** the whole-vehicle scripts' fault-memory menu (E46.IPO: m_fs) */
const IPO_VEHICLE_FAULT_MENU = 'm_fs';

/**
 * Whether INPA's whole-vehicle script for a chassis ships (e46.prg-less
 * E46.IPO packed under the chassis stem by the export).
 * @param {string} chassisId - Chassis id.
 * @returns {Promise<boolean>}
 */
async function vehicleScriptShipped(chassisId) {
  try {
    const idx = await fetch('api/ecu-index.json').then((r) =>
      r.ok ? r.json() : null
    );
    return !!(idx && idx[String(chassisId).toLowerCase()]);
  } catch (e) {
    return false;
  }
}

/**
 * The whole-vehicle script as a module: INPA's E46.IPO opens like any
 * other script, its keys send to the groups and the run route resolves
 * each group to the module on the wire.
 * @param {string} chassisId - Chassis id.
 * @param {string|null} [openMenu] - a menu to open (a deep link)
 * @returns {Promise<void>}
 */
function showVehicleScript(chassisId, openMenu) {
  const id = String(chassisId);
  return showEcu(
    id,
    'Functional Jobs',
    {
      code: id,
      sgbd: id.toLowerCase(),
      label: `INPA ${dispChassis(id)} script`,
      group: null,
      kind: 'vehicle',
    },
    openMenu || null
  );
}

// "Old models" popup (INPA Shift+F9): chassis hidden from the main list
/**
 * The "Other models" popup listing the chassis not on the INPA main list.
 * @param {string[]} ids - Chassis ids to list.
 * @returns {void}
 */
function showOtherModels(ids) {
  const { overlay, close } = openModal(`
    <div class="modal inpa-pop" role="dialog" aria-modal="true">
      <div class="modal-title">Other models</div>
      <div class="inpa-pop-list">${ids
        .map(
          (id, i) => `
        <button class="inpa-pop-row" data-id="${esc(id)}">
          <span class="inpa-pop-key">F${i + 1}</span>
          <span class="inpa-pop-label">${esc(dispChassis(id))}${CHASSIS_TAG[id] ? ` · ${CHASSIS_TAG[id]}` : ''}</span>
        </button>`
        )
        .join('')}</div>
      <div class="modal-actions"><button class="btn modal-cancel">Close<span class="modal-key">Esc</span></button></div>
    </div>`);
  overlay.querySelector('.modal-cancel').onclick = () => close();
  overlay.querySelectorAll('.inpa-pop-row').forEach(
    (b) =>
      (b.onclick = () => {
        close();
        showScriptSelection(b.dataset.id);
      })
  );
}

/**
 * INPA's start screen shows Battery / Ignition lamps; paint them from the
 * cable's modem lines (/api/state, the same DSR read INPA makes). No-op when
 * that screen is not up; off with no cable.
 * @returns {Promise<void>}
 */
async function syncVselState() {
  const bs = document.getElementById('vsel-bat'),
    bv = document.getElementById('vsel-bat-s');
  const is = document.getElementById('vsel-ign'),
    iv = document.getElementById('vsel-ign-s');
  if (!bs) return;
  let st = { battery: null, ignition: null };
  try {
    st = await api('/api/state');
  } catch {
    /* no engine: lamps off */
  }
  if (!document.getElementById('vsel-bat')) return; // screen changed meanwhile
  const batOn = st.battery != null;
  const ignOn = st.ignition === true;
  bs.className = 'inpa-kl-led' + (batOn ? ' on' : '');
  bv.textContent = batOn ? 'on' : 'off';
  is.className = 'inpa-kl-led' + (ignOn ? ' on' : '');
  iv.textContent = ignOn ? 'on' : 'off';
}

// where "Back" from an ECU should land. in INPA mode the module list is the
// Script selection popup, so return there; in modern mode, the sections screen.
/**
 * Return from a module to its chassis's module list, per layout mode.
 * @param {string} chassisId - Chassis id.
 * @returns {void}
 */
function backToModules(chassisId) {
  if (typeof inpaMode === 'function' && inpaMode())
    showScriptSelection(chassisId);
  else showSections(chassisId);
}

// screen 2: sections sidebar + ECU list
/**
 * Screen 2: the system rail and the selected section's module cards.
 * @param {string} id - Chassis id.
 * @param {number} [selectIndex=0] - Section to open first.
 * @returns {Promise<void>}
 */
async function showSections(id, selectIndex = 0) {
  let wiringKey = null; // the F-key, added only if WDS data is here
  cancelSweep(); // entering the section list stops any sweep (sweep.js)
  lastScreen = () => showSections(id, selectIndex);
  setStateSgbd(null); // reset the battery/ignition poll target now, re-aim once the config is here (screens/sweep/autoscan.js)
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(id) },
  ]);
  if (typeof routeSetCarList === 'function') routeSetCarList(id);
  sbLeft.textContent = `loading ${dispChassis(id)}…`;
  // name neither side: below 760px the system rail sits ABOVE its modules, not left
  view.innerHTML = head(
    'Control modules',
    dispChassis(id),
    'Pick a system, then a module.'
  );

  const split = document.createElement('div');
  split.className = 'split';
  split.innerHTML = `<nav class="split-nav" id="split-nav"></nav>
                     <div class="split-content" id="split-content"></div>`;
  view.appendChild(split);

  // placeholders while the chassis archive loads: on a phone that fetch is a real download, and a blank pane reads as broken
  split.querySelector('#split-nav').innerHTML = skeletonList(6, false);
  split.querySelector('#split-content').innerHTML = skeletonList(7, true);

  const ch = await tryApi(
    `/api/chassis/${id}`,
    null,
    view,
    `failed to load ${dispChassis(id)}`
  );
  if (!ch) return;
  setStateSgbd(ch); // retarget the battery/ignition poll at this chassis's DME (screens/sweep/autoscan.js)
  autoScan(id, ch).catch(() => {}); // background engine/trans scan; no-ops when the config has no grouped targets
  const nav = split.querySelector('#split-nav');
  const content = split.querySelector('#split-content');

  function selectSection(idx) {
    selectIndex = idx;
    const sec = ch.sections[idx];
    [...nav.children].forEach((n, i) =>
      n.classList.toggle('active', i === idx)
    );
    content.innerHTML = '';
    const listWrap = document.createElement('div');
    listWrap.className = 'ecu-grid stagger';
    sec.ecus.forEach((ecu) => {
      // module card laid out like the ECU housing label: designation, application name, part number
      const card = document.createElement('div');
      card.className = 'ecu-card';
      card.innerHTML = `
        <span class="ecu-code">${esc(ecu.code)}</span>
        <span class="ecu-name">${esc(ecu.label)}</span>
        <span class="ecu-prg">${esc(ecu.sgbd)}.prg</span>`;
      card.onclick = () => showEcu(id, sec.name, ecu);
      listWrap.appendChild(card);
    });
    content.appendChild(listWrap);
    stagger(listWrap, 14);
    sbRight.textContent = `${sec.ecus.length} module${sec.ecus.length === 1 ? '' : 's'}`;
  }

  nav.innerHTML = '';
  ch.sections.forEach((sec, idx) => {
    const item = document.createElement('button');
    item.className = 'sys-item';
    item.innerHTML = `<span class="nav-name">${esc(sec.name)}</span>
                      <span class="nav-count">${sec.ecus.length}</span>`;
    item.onclick = () => selectSection(idx);
    nav.appendChild(item);
  });

  // Coding hub entry, shown only when the chassis has codeable modules
  if (
    codingReady() &&
    typeof chassisHasCoding === 'function' &&
    (await chassisHasCoding(id))
  ) {
    const code = document.createElement('button');
    code.className = 'sys-item sys-coding';
    code.innerHTML = `<span class="nav-name">Coding</span>
                      <span class="nav-count">edit</span>`;
    code.onclick = () => showCodingHub(id);
    nav.appendChild(code);
  }

  // Vehicle identity, shown only where a module can actually answer. The test
  // is the same one the screen uses -- an ECU declaring a job that returns the
  // coding key or the vehicle order -- so the tile never opens a dead end.
  // Drawn hidden in its place and revealed when the probe answers (it
  // settles at the first module that carries an identity job), so the
  // sections never wait on it.
  if (typeof chassisHasIdentity === 'function') {
    const ident = document.createElement('button');
    ident.className = 'sys-item sys-identity';
    ident.hidden = true;
    ident.innerHTML = `<span class="nav-name">Identity</span>
                      <span class="nav-count">read</span>`;
    ident.onclick = () => showVehicleIdentity(id);
    nav.appendChild(ident);
    chassisHasIdentity(id)
      .then((has) => {
        if (has) ident.hidden = false;
      })
      .catch(() => {
        /* the row stays hidden */
      });
  }

  // INPA's whole-vehicle script (every module's fault memory as a report),
  // reachable from the modern layout too, where one ships for this car
  const hasScript = await vehicleScriptShipped(id);
  if (hasScript) {
    const scan = document.createElement('button');
    scan.className = 'sys-item sys-scan';
    scan.innerHTML = `<span class="nav-name">Error scan</span>
                    <span class="nav-count">all</span>`;
    scan.onclick = () => showVehicleScript(id, IPO_VEHICLE_FAULT_MENU);
    nav.appendChild(scan);
  }

  // Wiring shortcut so an already-open car doesn't have to go back out to reach its diagrams
  if (typeof hasWiring === 'function' && (await hasWiring(id))) {
    const wire = document.createElement('button');
    wire.className = 'sys-item sys-wiring';
    wire.innerHTML = `<span class="nav-name">Wiring</span>
                      <span class="nav-count">WDS</span>`;
    wire.onclick = () => showWiring(id);
    nav.appendChild(wire);
    wiringKey = { key: '0', label: 'Wiring', fn: () => showWiring(id) };
  }

  sbLeft.textContent = ch.description;
  selectSection(Math.min(selectIndex, ch.sections.length - 1));

  const actions = ch.sections.slice(0, 8).map((s, i) => ({
    key: String(i + 1),
    label: s.name,
    fn: () => selectSection(i),
  }));
  if (hasScript) {
    actions.push({
      key: '9',
      label: 'Error scan',
      fn: () => showVehicleScript(id, IPO_VEHICLE_FAULT_MENU),
    });
  }
  if (wiringKey) actions.push(wiringKey);
  actions.push({
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'Vehicles',
    kind: 'back',
    fn: showChassis,
  });
  setActions(actions);
}
