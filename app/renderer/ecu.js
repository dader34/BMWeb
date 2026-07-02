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
    // de-dupe by (job + field), stable pseudo-job id for keys
    const seen = new Set();
    const items = [];
    inputs.forEach((inp, i) => {
      const sig = (inp.job || '') + '|' + (inp.field || '');
      if (seen.has(sig)) return;
      seen.add(sig);
      items.push({
        job: `__input_${i}`,
        label: inp.field || inp.job,
        danger: /steuern|command|throttle|write|store|reset/i.test((inp.field || '') + ' ' + (inp.job || '')),
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

// INPA ECU main menu ("Hauptmenue"): SGBD sub-line + function list with F-key bar.
// each entry opens its section.
function renderInpaHauptmenue(chassisId, sectionName, ecu, menu, grid, bar) {
  if (bar) bar.remove(); // INPA shows SGBD/addr inline, not as pills
  grid.className = 'inpa-haupt';
  const secs = menu.sections;
  const row = (i, sec) => `
    <button class="inpa-fn" data-i="${i}">
      <span class="inpa-fn-key">&lt; F${i + 1} &gt;</span>
      <span class="inpa-fn-label">${esc(sec.section)}</span>
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
  if (layout && Array.isArray(layout.screens) && layout.screens.length) {
    menu = mergeLayoutIntoMenu(menu, layout);
    ecu._layout = layout; // stash for the section/screen renderers
  }
  const total = menu.sections.reduce((n, s) => n + s.items.length, 0);
  document.getElementById('job-count').textContent = `${total} functions`;

  if (inpaMode()) {
    renderInpaHauptmenue(chassisId, sectionName, ecu, menu, grid, bar);
    // F-keys mirror the section list
    const acts = menu.sections.slice(0, 9).map((sec, i) => ({
      key: String(i + 1), label: sec.section,
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
      <div class="group-name">${esc(sec.section)}</div>
      <div class="group-count">${sec.items.length} function${sec.items.length === 1 ? '' : 's'}</div>
      <div class="group-arrow">→</div>`;
    tile.onclick = () => showEcuSection(chassisId, sectionName, ecu, menu, sec.section);
    grid.appendChild(tile);
  });

  stagger(grid, 40);

  // F-keys = section categories, + back
  const acts = menu.sections.slice(0, 8).map((sec, i) => ({
    key: String(i + 1), label: sec.section,
    fn: () => showEcuSection(chassisId, sectionName, ecu, menu, sec.section),
  }));
  acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => backToModules(chassisId) });
  setActions(acts);
}

// flashing. stage 1: identify + read/backup the DME, no writing yet.
