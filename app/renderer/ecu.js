// ECU menu: job labels, layout merge, showEcu, Hauptmenue
// English labels for common EDIABAS jobs.
const JOB_LABELS = {
  FS_LESEN: 'Read fault codes',
  FS_LESEN_DETAIL: 'Read fault codes (detail)',
  FS_LOESCHEN: 'Clear fault codes',
  IDENT: 'Identify ECU',
  INFO: 'ECU info',
  STATUS_LESEN: 'Read status',
  SERIENNUMMER_LESEN: 'Read serial number',
  CBS_DATEN_LESEN: 'Read CBS service data',
};
// EDIABAS internal jobs, hidden from the function list
const HIDDEN_JOBS = new Set([
  '_JOBS', '_JOBCOMMENTS', '_ARGUMENTS', '_RESULTS', '_VERSIONINFO', '_TABLES', '_TABLE',
  'INITIALISIERUNG', 'ENDE',
]);
// destructive/flash/security jobs: shown but flagged, never auto-run
const DANGEROUS_JOBS = /FLASH|LOESCHEN|SCHREIBEN|RESET|AUTHENTISIERUNG|PROGRAMMIER|BAUDRATE|PARAMETER_SETZEN/;

const jobLabel = (j) => {
  if (JOB_LABELS[j]) return JOB_LABELS[j];
  // humanize SNAKE_CASE then translate any German verbs/nouns left in the name
  let s = j.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  if (typeof deGerman === 'function') s = deGerman(s) || s;
  return s;
};

// fold the mined .IPO screen layout into the menu. each layout screen becomes a
// function item (definition under `_screen`), bucketed into INPA sections by
// group-title keyword.
function mergeLayoutIntoMenu(menu, layout) {
  const buckets = new Map(); // sectionName -> items[]
  const put = (section, item) => {
    if (!buckets.has(section)) buckets.set(section, []);
    buckets.get(section).push(item);
  };
  // every mined .IPO screen is a Status readout, so they all live under Status
  // (matches INPA, which lists them in one status list rather than split buckets).
  const sectionFor = () => 'Status';
  layout.screens.forEach((scr, i) => {
    const label = scr.group || (scr.job ? jobLabel(scr.job) : `Screen ${i + 1}`);
    put(sectionFor(scr.group), { job: scr.job || `__screen_${i}`, label, danger: false, _screen: scr });
  });

  // keep the real job sections (Fault memory, Info, Service, Activations). drop the
  // auto-generated Status, the layout replaces it.
  const kept = (menu.sections || []).filter(s => !/^status$/i.test(s.section));
  const layoutSections = [...buckets.entries()].map(([section, items]) => ({ section, items }));

  // input-requiring functions become an "Inputs" section, spec under `_input`.
  // clicking opens a value dialog.
  const inputs = Array.isArray(layout.inputs) ? layout.inputs : [];
  if (inputs.length) {
    // these are real jobs that take a typed argument. the tile must show the
    // JOB (translated), not the arg-entry hint (inp.field) — that hint belongs
    // in the input dialog. de-dupe by job so one job isn't listed twice.
    const seen = new Set();
    const items = [];
    inputs.forEach((inp, i) => {
      const job = inp.job || '';
      if (!job || seen.has(job.toUpperCase())) return;
      seen.add(job.toUpperCase());
      items.push({
        job: `__input_${i}`,
        label: jobLabel(job),
        danger: /steuern|schreiben|_setzen|programmier|reset|command|throttle|write|store/i.test(job),
        _input: inp,
      });
    });
    if (items.length) layoutSections.push({ section: 'Inputs', items });
  }

  // Status first, then layout buckets, then kept job sections
  const order = ['Status', 'Engine values', 'Fuel & lambda', 'Adaptations', 'Timing & VANOS', 'Configuration', 'Inputs'];
  layoutSections.sort((a, b) => {
    const ia = order.indexOf(a.section), ib = order.indexOf(b.section);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return { sgbd: menu.sgbd, sections: [...layoutSections, ...kept], _hasLayout: true };
}


// section display label: translate + capitalize ("Fehler" -> "Fault")
function sectionLabel(name) {
  const t = deGerman(name) || name;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// what kind of caution a flagged job actually is, so the badge tells the truth.
// a flash READ (FLASH_..._LESEN, read programming status) is only dangerous in
// context, not a write — call that "flash", not "write".
function dangerBadge(job) {
  const j = (job || '').toUpperCase();
  if (/LOESCHEN/.test(j)) return 'clear';
  if (/LESEN/.test(j)) return 'flash';                 // flash-session read
  if (/SCHREIBEN|_SETZEN|PROGRAMMIER|WRITE/.test(j)) return 'write';
  if (/FLASH|SIGNATUR|AUTHENTIS|CRC/.test(j)) return 'flash';
  if (/RESET|BAUDRATE/.test(j)) return 'reset';
  if (/STEUERN|STELLGLIED/.test(j)) return 'drives';   // actuator
  return 'caution';
}

// ---- INPA menu-tree adapter -------------------------------------------------
// newer layouts (inpa2json) carry INPA's real MENU/ITEM navigation tree. adapt
// it on the fly into the app's sections model so every existing renderer
// (Hauptmenue, showEcuSection, fault screen, gauges) works unchanged.

// items that are UI chrome in INPA but native app features here (back button,
// PDF export, CSV save) — dropped from the adapted menu.
const MENU_SKIP = /^(zur(ü|ue)ck|exit|ende|druck(en)?|speichern|auswahl|abbruch)$/i;
// label → app action mapping for non-screen items INPA handles in code
const MENU_ACTIONS = [
  [/l(ö|oe)schen/i, { job: 'FS_LOESCHEN', danger: true }], // FS/IS/HS löschen
  [/^(fs|fehler(speicher)?)( |$)|lesen.*fehler|^fehler lesen$/i, { job: 'FS_LESEN' }],
  [/^ident/i, { job: 'IDENT' }],
  [/^info/i, { job: 'INFO' }],
];

// root of the (cyclic — "Zurück" back-links) menu graph: m_main/m_haupt* by
// convention, else the first menu in file order
function menuRoot(menus) {
  return menus.find(m => /^m_(main|haupt)/i.test(m.name)) || menus[0];
}

// flatten one menu subtree into app function items. leaf screen items resolve
// via screens[].proc (a proc may have split into several one-job screens);
// non-screen items fall back to the action table; nested submenus recurse.
function menuItemsOf(menuName, layout, byName, seen) {
  if (seen.has(menuName)) return []; // cycle guard (Zurück links)
  seen.add(menuName);
  const menu = byName.get(menuName);
  if (!menu) return [];
  const out = [];
  menu.items.forEach((it, idx) => {
    const label = (it.label || '').trim();
    if (!label || MENU_SKIP.test(label)) return;
    if (it.submenu && byName.has(it.submenu)) {
      out.push(...menuItemsOf(it.submenu, layout, byName, seen));
      return;
    }
    if (it.screen) {
      const parts = layout.screens.filter(s => s.proc === it.screen);
      if (parts.length) {
        parts.forEach((scr, pi) => out.push({
          job: scr.job || `__screen_${menuName}_${idx}_${pi}`,
          label: parts.length > 1 ? (scr.group || label) : label,
          danger: false, _screen: scr,
        }));
        return;
      }
    }
    // no resolvable screen: map known actions, otherwise drop (screens whose
    // rows the miner can't extract yet — text/digital-only INPA screens)
    const action = MENU_ACTIONS.find(([re]) => re.test(label));
    if (action) out.push({ job: action[1].job, label, danger: !!action[1].danger });
  });
  // de-dupe: flattening + action mapping can repeat a job (FS lesen in two menus)
  const seenSig = new Set();
  return out.filter(i => {
    const sig = i._screen ? `s:${i.job}:${i.label}` : `j:${i.job}`;
    if (seenSig.has(sig)) return false;
    seenSig.add(sig);
    return true;
  });
}

// adapt the INPA menu tree into the app's sections model. root items with
// submenus become sections (their subtree flattened to items); loose root
// leaves collect into a leading section named by the root title. keeps the
// job-menu's Activations section (real actuator tests) when present.
function menuTreeToSections(layout, baseMenu) {
  const byName = new Map(layout.menus.map(m => [m.name, m]));
  const root = menuRoot(layout.menus);
  const sections = [];
  const loose = [];
  root.items.forEach((it, idx) => {
    const label = (it.label || '').trim();
    if (!label || MENU_SKIP.test(label)) return;
    if (it.submenu && byName.has(it.submenu)) {
      const items = menuItemsOf(it.submenu, layout, byName, new Set([root.name]));
      if (items.length) sections.push({ section: label, items });
      return;
    }
    // leaf on the root menu (Info, Ident, ...)
    const parts = it.screen ? layout.screens.filter(s => s.proc === it.screen) : [];
    if (parts.length) {
      parts.forEach((scr, pi) => loose.push({
        job: scr.job || `__screen_root_${idx}_${pi}`,
        label: parts.length > 1 ? (scr.group || label) : label,
        danger: false, _screen: scr,
      }));
    } else {
      const action = MENU_ACTIONS.find(([re]) => re.test(label));
      if (action) loose.push({ job: action[1].job, label, danger: !!action[1].danger });
    }
  });
  if (loose.length) sections.unshift({ section: root.title || 'Functions', items: loose });

  // real actuator tests come from the job menu, not the mined tree
  const acts = (baseMenu.sections || []).find(s => /^activations$/i.test(s.section));
  if (acts) sections.push(acts);
  return { sgbd: baseMenu.sgbd, sections, _hasLayout: true, _menuTree: true };
}

// INPA ECU main menu ("Hauptmenue"): SGBD sub-line + function list with F-key bar.
// each entry opens its section.
function renderInpaHauptmenue(chassisId, sectionName, ecu, menu, grid, bar) {
  if (bar) bar.remove(); // INPA shows SGBD/addr inline, not as pills
  grid.className = 'inpa-haupt';
  const secs = menu.sections;
  const row = (i, sec) => `
    <button class="inpa-fn" data-i="${i}">
      <span class="inpa-fn-key">&lt; F${i + 1} &gt;</span>
      <span class="inpa-fn-label">${esc(sectionLabel(sec.section))}</span>
      <span class="inpa-fn-count">${sec.items.length}</span>
    </button>`;
  grid.innerHTML = `
    <div class="inpa-haupt-sub">SGBD = ${esc(ecu.sgbd.toUpperCase())}</div>
    <div class="inpa-haupt-list">${secs.map((s, i) => row(i, s)).join('')}</div>`;
  grid.querySelectorAll('.inpa-fn').forEach(btn => {
    const i = +btn.dataset.i;
    btn.onclick = () => showEcuSection(chassisId, sectionName, ecu, menu, secs[i].section);
  });
}

// ECU main menu: section categories on the F-key bar, each opens a sub-screen
async function showEcu(chassisId, sectionName, ecu) {
  lastScreen = () => showEcu(chassisId, sectionName, ecu);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: () => backToModules(chassisId) },
    { label: ecu.label },
  ]);
  sbLeft.textContent = `${ecu.sgbd}.prg`;
  view.innerHTML = head(`${sectionName} · ${ecu.code}`, ecu.label,
    `SGBD ${ecu.sgbd}.prg · choose a function group below`);

  const bar = document.createElement('div');
  bar.className = 'toolbar';
  bar.innerHTML = `<span class="pill" id="port-pill">cable: …</span>
                   <span class="pill" id="job-count">loading…</span>`;
  view.appendChild(bar);

  const grid = document.createElement('div');
  grid.className = 'group-grid stagger';
  view.appendChild(grid);

  api('/api/port').then(p => {
    document.getElementById('port-pill').textContent =
      p.port ? `cable: ${p.port.replace('/dev/', '')}` : 'no cable';
  }).catch(() => {});

  // mined .IPO layout when this ECU is mapped, else the job-name menu. pass the
  // INPA code (e.g. MS450) so the server can match MS450.json even though the
  // SGBD is ms450ds0.
  let menu, layout = null;
  try {
    const codeHint = ecu.code ? `?code=${encodeURIComponent(ecu.code)}` : '';
    layout = await api(`/api/ecu/${ecu.sgbd}/layout${codeHint}`);
  } catch { /* no layout, fall back below */ }
  try {
    menu = await api(`/api/ecu/${ecu.sgbd}/menu`);
  } catch (e) {
    if (!layout) { grid.innerHTML = errorBlock(e.message); sbLeft.textContent = 'failed'; return; }
    menu = { sgbd: ecu.sgbd, sections: [] };
  }
  if (layout && Array.isArray(layout.menus) && layout.menus.length) {
    // INPA's own MENU tree (inpa2json layouts): adapt it on the fly
    menu = menuTreeToSections(layout, menu);
    ecu._layout = layout;
  } else if (layout && Array.isArray(layout.screens) && layout.screens.length) {
    menu = mergeLayoutIntoMenu(menu, layout);
    ecu._layout = layout; // stash for the section/screen renderers
  }
  const total = menu.sections.reduce((n, s) => n + s.items.length, 0);
  document.getElementById('job-count').textContent = `${total} functions`;

  if (inpaMode()) {
    renderInpaHauptmenue(chassisId, sectionName, ecu, menu, grid, bar);
    // F-keys mirror the section list
    const acts = menu.sections.slice(0, 9).map((sec, i) => ({
      key: String(i + 1), label: sectionLabel(sec.section),
      fn: () => showEcuSection(chassisId, sectionName, ecu, menu, sec.section),
    }));
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => backToModules(chassisId) });
    setActions(acts);
    return;
  }

  // category tiles, also reachable via the F-key bar
  menu.sections.forEach(sec => {
    const tile = document.createElement('div');
    tile.className = 'group-tile';
    tile.innerHTML = `
      <div class="group-name">${esc(sectionLabel(sec.section))}</div>
      <div class="group-count">${sec.items.length} function${sec.items.length === 1 ? '' : 's'}</div>
      <div class="group-arrow">→</div>`;
    tile.onclick = () => showEcuSection(chassisId, sectionName, ecu, menu, sec.section);
    grid.appendChild(tile);
  });

  stagger(grid, 40);

  // F-keys = section categories, + back
  const acts = menu.sections.slice(0, 8).map((sec, i) => ({
    key: String(i + 1), label: sectionLabel(sec.section),
    fn: () => showEcuSection(chassisId, sectionName, ecu, menu, sec.section),
  }));
  acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => backToModules(chassisId) });
  setActions(acts);
}

// ECU section view: the top-level router for a module's function categories.
// dispatches to the fault-memory F-key screen, the status multi-watch list, the
// mined gauge/input screens (live.js), or the actuator-test panel (activations.js).
function showEcuSection(chassisId, sectionName, ecu, menu, sectionKey) {
  const sec = menu.sections.find(s => s.section === sectionKey);
  lastScreen = () => showEcuSection(chassisId, sectionName, ecu, menu, sectionKey);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: () => backToModules(chassisId) },
    { label: ecu.label, fn: () => showEcu(chassisId, sectionName, ecu) },
    { label: sectionLabel(sec.section) },
  ]);
  sbLeft.textContent = `${ecu.sgbd}.prg`;
  view.innerHTML = head(`${ecu.label} · ${ecu.code}`, sectionLabel(sec.section),
    `${sec.items.length} function${sec.items.length === 1 ? '' : 's'}`);

  const results = document.createElement('div');
  results.className = 'results-panel';
  view.appendChild(results);

  // layout-mined sections (have _screen) render as gauge panels, not the
  // checkbox multi-watch list
  const isLayoutScreens = sec.items.some(i => i._screen);
  const isStatus = sec.section === 'Status' && !isLayoutScreens;
  const isActivations = sec.section === 'Activations';
  const selected = new Set();

  // activations get a dedicated actuator-test panel (activations.js)
  if (isActivations) {
    showActivations(ecu, sec, results);
    setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showEcu(chassisId, sectionName, ecu) }]);
    return;
  }

  // fault memory, INPA-style: actions only in the footer F-key bar (Read, Detail,
  // Clear, etc.), no in-body job rows
  const jobs0 = sec.items.map(i => i.job);
  const isFaults = jobs0.includes('FS_LESEN') && !isStatus;
  if (isFaults) {
    loadFaultDb(); // warm the name db before any read renders
    const backToEcu = () => showEcu(chassisId, sectionName, ecu);
    const hasJob = (j) => jobs0.includes(j);
    // only the jobs MS45 has
    const acts = [
      { key: '1', label: 'Read codes', kind: 'primary', fn: () => runJob(ecu, 'FS_LESEN', results, false) },
    ];
    if (hasJob('FS_LESEN_DETAIL'))        acts.push({ key: '2', label: 'Detail', fn: () => readFaultsDetailed(ecu, results) });
    if (hasJob('FS_LESEN_FREEZE_FRAME'))  acts.push({ key: '3', label: 'Freeze', fn: () => runJob(ecu, 'FS_LESEN_FREEZE_FRAME', results, false) });
    if (hasJob('FS_LESEN_HEX'))           acts.push({ key: '4', label: 'Hex', fn: () => runJob(ecu, 'FS_LESEN_HEX', results, false) });
    if (hasJob('FS_LOESCHEN'))            acts.push({ key: '5', label: 'Clear', kind: 'danger', fn: () => runJob(ecu, 'FS_LOESCHEN', results, true) });
    acts.push({ key: '7', label: 'Comment', fn: () => addFaultComment(ecu, results) });
    acts.push({ key: '9', label: 'Export', fn: () => exportFaults(ecu, view) });
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: backToEcu });
    setActions(acts);
    // prompt only, actions live in the footer F-key bar
    results.className = 'results-panel';
    results.innerHTML = `<div class="empty"><div>Press a function key below to read the fault memory: <b>1 Read</b>, <b>2 Detail</b>, <b>3 Freeze frame</b>, <b>4 Hex</b>.</div></div>`;
    return;
  }

  // status sections get a multi-watch toolbar
  let watchBtn, watchAllBtn;
  if (isStatus) {
    const bar = document.createElement('div');
    bar.className = 'watch-toolbar';
    bar.innerHTML = `
      <span class="watch-hint">Select values, then watch them together · stream to CSV with timestamps</span>
      <button class="btn watch-selected" disabled>Watch selected</button>
      <button class="btn primary watch-all">Watch all</button>`;
    view.appendChild(bar);
    watchBtn = bar.querySelector('.watch-selected');
    watchAllBtn = bar.querySelector('.watch-all');
    watchBtn.onclick = () => { if (selected.size) watchMulti(ecu, [...selected], results, view); };
    watchAllBtn.onclick = () => watchMulti(ecu, sec.items.map(i => i.job), results, view);
  }

  const list = document.createElement('div');
  list.className = 'job-list stagger';
  view.appendChild(list);

  const rowByJob = new Map(); // job -> row element, for watched highlighting
  sec.items.forEach(it => {
    const isLive = isStatus || /^STATUS|^MW_|MESSWERT/.test(it.job);
    const row = document.createElement('div');
    row.className = 'job-row' + (it.danger ? ' danger' : '') + (isStatus ? ' selectable' : '');
    row.innerHTML = `
      ${isStatus ? '<span class="job-check" role="checkbox" aria-checked="false"></span>' : '<span class="job-bullet"></span>'}
      <span class="job-label">${esc(itemLabel(it))}</span>
      ${it.danger ? `<span class="job-warn">${dangerBadge(it.job)}</span>` : ''}`;
    if (isStatus) {
      rowByJob.set(it.job, row);
      // row click toggles selection
      row.onclick = () => {
        const check = row.querySelector('.job-check');
        if (selected.has(it.job)) { selected.delete(it.job); row.classList.remove('checked'); check.setAttribute('aria-checked', 'false'); }
        else { selected.add(it.job); row.classList.add('checked'); check.setAttribute('aria-checked', 'true'); }
        watchBtn.disabled = selected.size === 0;
        watchBtn.textContent = selected.size ? `Watch ${selected.size} selected` : 'Watch selected';
      };
    } else if (it._screen) {
      // mined gauge screen
      row.onclick = () => showInpaScreen(ecu, it._screen, results);
    } else if (it._input) {
      // mined input function
      row.onclick = () => runInputFunction(ecu, it._input, results);
    } else {
      row.onclick = () => isLive ? runJobLive(ecu, it.job, results) : runJob(ecu, it.job, results, it.danger);
    }
    list.appendChild(row);
  });
  // exposed so watchMulti can highlight watched rows
  view._rowByJob = rowByJob;
  stagger(list, 14);

  // quick keys for common jobs + back to ECU menu
  const jobsHere = sec.items.map(i => i.job);
  const has = (j) => jobsHere.includes(j);
  const acts = [];
  if (has('FS_LESEN')) acts.push({ key: '1', label: 'Read codes', kind: 'primary', fn: () => runJob(ecu, 'FS_LESEN', results, false) });
  if (has('FS_LOESCHEN')) acts.push({ key: '2', label: 'Clear codes', kind: 'danger', fn: () => runJob(ecu, 'FS_LOESCHEN', results, true) });
  if (isStatus) acts.push({ key: '1', label: 'Watch all', kind: 'primary', fn: () => watchMulti(ecu, sec.items.map(i => i.job), results, view) });
  acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showEcu(chassisId, sectionName, ecu) });
  setActions(acts);
}
