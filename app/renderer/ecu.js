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

// some screens ship twice, once per UI mode: `mode:"inpa"` reproduces the .IPO
// page (every result row, one column) and `mode:"modern"` the gauge version
// (numeric values only, two columns). Keep only the active mode's copy so the
// other doesn't show up as a duplicate function. Screens with no mode tag
// predate the split and are used in both.
function pickLayoutMode(layout) {
  if (!layout || !Array.isArray(layout.screens)) return layout;
  const want = inpaMode() ? 'inpa' : 'modern';
  if (!layout.screens.some(s => s.mode)) return layout; // nothing to choose
  // menus address screens by index, so remap them onto the filtered array
  const remap = new Map();
  const screens = [];
  layout.screens.forEach((s, i) => {
    if (s.mode && s.mode !== want) return;
    remap.set(i, screens.length);
    screens.push(s);
  });
  const menus = (layout.menus || []).map(m => ({
    ...m,
    items: (m.items || []).map(it => (Array.isArray(it.screens)
      ? { ...it, screens: it.screens.map(i => remap.get(i)).filter(i => i != null) }
      : it)),
  }));
  return { ...layout, screens, menus };
}

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


// How many entries a section will actually put on screen. Usually that is the
// job count, but a section whose screen reorganises those jobs must say what
// the screen shows: Activations renders INPA's component groups (12 on ZKE5),
// not the two STEUERN_* jobs that drive them, and "2" over a list of twelve is
// simply wrong wherever it appears.
function sectionCount(ecu, sec) {
  const layout = ecu._layout || {};
  if (sec.section === 'Activations') {
    // INPA's nested Activate menu: the top level is what the screen lists
    const tree = layout.activateTree;
    if (tree) {
      const top = Object.values(tree).reduce((n, items) => n + items.length, 0);
      if (top) return top;
    }
    const groups = (layout.activateMenus || [])
      .reduce((n, m) => n + (m.groups || []).length, 0);
    if (groups) return groups;
  }
  // the read-only cards list fields, not jobs
  if (sec.section === 'Identity' && layout.identity)
    return layout.identity.fields.length;
  if (sec.section === 'AIF' && layout.aif)
    return layout.aif.fields.length;
  if (sec.section === 'Coding' && layout.coding && layout.coding.fields)
    return layout.coding.fields.length;
  // Status counts INPA's pages, not the jobs behind them: the section opens
  // the page list, so "38 functions" over a 6-entry menu misdescribes it
  if (sec.section === 'Status' && layout.statusMenu) {
    const pages = (layout.statusMenu.items || []).filter(i => i.resolved).length;
    if (pages) return pages;
  }
  return sec.items.length;
}

// correct the section header's subtitle once a screen knows what it is really
// showing. `head()` writes it from the job count before any renderer has run.
function setSectionCount(text) {
  const el = document.querySelector('.view .screen-head .subtitle');
  if (el) el.textContent = text;
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
// INPA root-menu caption -> the app section that serves it. The captions are
// INPA's own (mined from the .IPO); the sections are ours.
const ROOT_SECTION = [
  [/^Information$/i, 'Identity'],
  [/^Identification$|^Identifikation$/i, 'Identity'],
  [/^Coding$|^Codierung$/i, 'Coding'],
  [/^Error memory$|^Fehlerspeicher$/i, 'Faults'],
  [/^Read status$|^Status lesen$/i, 'Status'],
  [/^Activate$|^Ansteuern$/i, 'Activations'],
  [/^Read memory$|^Speicher lesen$/i, 'Special'],
];

// Does INPA really open this screen, or is the key dead?
//
// A root key can be listed and still lead nowhere. GSDS2 prints
// "< F3 >  Coding", but its file declares no s_code screen: the main menu's
// dispatch sends F3 to m_status, and INPA ships a second root menu for the
// same ECU named m_main_nocode -- "main, no coding" -- omitting F3 entirely.
//
// We showed the key anyway because MenuGen sorts SGBD jobs into sections by
// name substring, so an ECU that merely OWNS a job called
// CODIER_CHECKSUM_PRUEFEN gets a "Coding" section. That satisfied a plain
// has('Coding') test, which is how GSDS2 came to show a Coding key opening a
// single "Coding Checksum Check" tile.
//
// `deadRootKeys` is mined per ECU (tools/ipo_rootmenu.py) from the screen
// DECLARATIONS, not from whether our miner could read the screen's contents:
// of the 89 ECUs listing a Coding key, 50 declare a real screen and 39 do not,
// but only 17 of the 50 are currently readable. Gating on readability would
// have hidden 33 live screens.
function screenIsReal(ecu, sec) {
  const layout = ecu._layout;
  const dead = layout && layout.deadRootKeys;
  if (!dead || !dead.length || !layout.rootMenu) return true;
  return !layout.rootMenu.some(it =>
    dead.includes(it.fkey) &&
    ROOT_SECTION.some(([re, name]) => name === sec.section && re.test(it.label)));
}

// A hand-verified layout outranks a fresh decode: someone checked those
// screens against a real car. Generated layouts carry `generated: true`, so
// the distinction is a property of the data, not a list of ECU names.
// Should this layout outrank the decompiled UI?
//
// Not a question about provenance -- markers proved useless. Three different
// producers write these files and they agree on nothing: ipo_enrich sets
// `generated`, PrgLayout.cs sets `parser: prg-layout/1.0`, and older
// artifacts set neither. IHKA's stayed on the legacy renderer through two
// attempts at reading markers, because enriched/KLIMA_5B.json carries no
// marker at all and yet holds four screens with no proc names and zero
// result keys.
//
// So ask what the file actually CONTAINS. A layout earns priority only by
// having screens with real rows -- which is exactly what a hand-verified
// layout has and what these machine artifacts lack.
function layoutIsHandBuilt(layout) {
  if (!layout || layout.generated || layout.parser || layout.format) {
    return false;
  }
  const screens = Array.isArray(layout.screens) ? layout.screens : [];
  return screens.some(s => (s.rows || s.result_keys || []).length > 0);
}

// Does this layout describe ACTUATORS? A layout can be a good readout layout
// and have nothing for Activate -- IHKA's enriched file is exactly that: 53
// analog inputs, 15 flap positions, and no actuator description at all. Such
// a layout must keep serving its readouts while the decompiled Activate menu
// serves the actuators, rather than suppressing it and leaving that screen on
// the legacy renderer with "no job mapped".
function layoutHasActuators(layout) {
  if (!layout) return false;
  return !!(layout.activateTree || layout.activateMenus
    || (layout.menus || []).some(m => /steuern|activate/i.test(m.name || '')));
}

function renderInpaHauptmenue(chassisId, sectionName, ecu, menu, grid, bar) {
  if (bar) bar.remove(); // INPA shows SGBD/addr inline, not as pills
  grid.className = 'inpa-haupt';
  const secs = menu.sections;
  const has = (name) => secs.find(s => s.section === name);

  // INPA's own root menu for this ECU, when the .IPO gave us one: its entries,
  // with ITS F-key numbers. 343 of 458 ECUs leave gaps — an ECU without Coding
  // keeps Error memory on F4 — so numbering a filtered list 1..n is wrong.
  const root = (ecu._layout && ecu._layout.rootMenu) || [];
  const entries = [];
  root.forEach(it => {
    const hit = ROOT_SECTION.find(([re]) => re.test(it.label));
    const sec = hit && has(hit[1]);
    if (!sec) return;                       // INPA lists it, we have nothing
    if (!screenIsReal(ecu, sec)) return;            // key exists, screen doesn't
    if (entries.some(e => e.sec === sec)) return;   // Info+Ident both map to Identity
    entries.push({ fkey: it.fkey, label: deGerman(it.label) || it.label, sec });
  });

  // no mined root menu: fall back to our own sections, numbered in order
  const list = entries.length
    ? entries
    : secs.map((sec, i) => ({ fkey: i + 1, label: sectionLabel(sec.section), sec }));

  const row = (i, e) => `
    <button class="inpa-fn" data-i="${i}">
      <span class="inpa-fn-key">&lt; F${e.fkey} &gt;</span>
      <span class="inpa-fn-label">${esc(e.label)}</span>
      <span class="inpa-fn-count">${sectionCount(ecu, e.sec)}</span>
    </button>`;
  grid.innerHTML = `
    <div class="inpa-haupt-sub">SGBD = ${esc(ecu.sgbd.toUpperCase())}</div>
    <div class="inpa-haupt-list">${list.map((e, i) => row(i, e)).join('')}</div>`;
  grid.querySelectorAll('.inpa-fn').forEach(btn => {
    const e = list[+btn.dataset.i];
    btn.onclick = () => showEcuSection(chassisId, sectionName, ecu, menu, e.sec.section);
  });
  return list;
}

// Several root menus, one per ECU variant: INPA runs the variant job and
// matches its VARIANTE result. Both showEcu and showEcuSection need this --
// a section reached straight from the F-key bar never runs showEcu.
async function irResolveVariant(ecu) {
  const ir = ecu._ir;
  if (!ir || !ir.rootVariants || !ir.variantJob || ecu._variant) return;
  const names = Object.values(ir.rootVariants).flat();
  if (demoMode()) {
    // no car to ask: pick a variant INPA itself lists, so the screens belong
    // to a real variant rather than an invented mixture
    ecu._variant = names[Math.floor(Math.random() * names.length)];
  } else {
    try {
      const d = await api(`/api/ecu/${ecu.sgbd}/run/${ir.variantJob}`,
                          { method: 'POST' });
      const key = ir.variantKey || 'VARIANTE';
      ecu._variant = (flatResults(d.sets).find(([k]) => k === key) || [])[1];
    } catch { /* no cable: irRootMenu falls back to the widest root */ }
  }
  if (ecu._variant) ir._variant = ecu._variant;
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
    layout = pickLayoutMode(layout);
  } catch { /* no layout, fall back below */ }
  // the decompiled INPA UI, when this ECU has one. Interpreted directly by
  // ir.js; a hand-built or generated layout still wins where it has content,
  // so this only takes over screens nothing else serves.
  try {
    const codeHint = ecu.code ? `?code=${encodeURIComponent(ecu.code)}` : '';
    ecu._ir = await api(`/api/ecu/${ecu.sgbd}/ir${codeHint}`);
    await irResolveVariant(ecu);
  } catch { ecu._ir = null; }
  try {
    menu = await api(`/api/ecu/${ecu.sgbd}/menu`);
  } catch (e) {
    if (!layout) { grid.innerHTML = errorBlock(e.message); sbLeft.textContent = 'failed'; return; }
    menu = { sgbd: ecu.sgbd, sections: [] };
  }
  // two menu dialects exist: inpa2json trees carry {screen, submenu} refs and
  // route through the adapter; .IPO-decoded F-key menus ({fkey, target}) only
  // augment the screen layout (Status F-key pages) and keep the classic merge.
  const isMenuTree = layout && Array.isArray(layout.menus) &&
    layout.menus.some(m => (m.items || []).some(i => i.screen || i.submenu));
  if (isMenuTree) {
    // INPA's own MENU tree (inpa2json layouts): adapt it on the fly
    menu = menuTreeToSections(layout, menu);
    ecu._layout = layout;
  } else if (layout && Array.isArray(layout.screens) && layout.screens.length) {
    menu = mergeLayoutIntoMenu(menu, layout);
    ecu._layout = layout; // stash for the section/screen renderers
  } else if (layout) {
    // a generated layout carries no `screens` array -- its content is the
    // mined sections (rootMenu, identity, aif, coding, activateTree,
    // gaugeSpecs). Both branches above miss it, and without this the whole
    // ECU silently falls back to the raw job list even though every screen
    // was mined.
    ecu._layout = layout;
  }
  // drop mined sections INPA has no screen for, so both UIs agree and the
  // function count doesn't include a screen you cannot open
  if (ecu._layout)
    menu = { ...menu, sections: menu.sections.filter(s => screenIsReal(ecu, s)) };

  const total = menu.sections.reduce((n, s) => n + s.items.length, 0);
  document.getElementById('job-count').textContent = `${total} functions`;

  // The decompiled root menu, when this ECU has one: INPA's own keys, in
  // INPA's own order, each opening whatever it opens. This replaces the
  // label->section mapping entirely -- no table of regexes, nothing dropped
  // for want of a rule, and no two keys collapsing onto one section. The
  // hand-built and generated layouts stay the fallback for ECUs with no IR.
  const irRoot = ecu._ir && typeof irRootMenu === 'function'
    ? irRootMenu(ecu._ir, ecu._variant) : null;
  if (irRoot && !layoutIsHandBuilt(layout)) {
    if (bar) bar.remove();
    grid.className = inpaMode() ? 'inpa-haupt' : 'group-grid stagger';
    renderIrMenu(ecu, ecu._ir, irRoot, grid, () => backToModules(chassisId));
    return;
  }

  if (inpaMode()) {
    const rootList = renderInpaHauptmenue(chassisId, sectionName, ecu, menu, grid, bar);
    // the softkey bar mirrors the list exactly, INPA's F-key numbers included:
    // renumbering here would disagree with the screen it is labelling
    const acts = rootList.slice(0, 9).map(e => ({
      key: String(e.fkey), keyLabel: `F${e.fkey}`, label: e.label,
      fn: () => showEcuSection(chassisId, sectionName, ecu, menu, e.sec.section),
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
      <div class="group-count">${sectionCount(ecu, sec)} function${sectionCount(ecu, sec) === 1 ? '' : 's'}</div>
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

// INPA softkey captions, kept verbatim in both UI modes — except the
// German-only ones, which read in English
const FKEY_LABEL = {
  'Abgas': 'Exhaust', 'Laufunruhe': 'Rough running',
  'Überdrehzahl': 'Overrev', 'Übertemp': 'Overtemp',
};
const fkeyLabel = (l) => FKEY_LABEL[l] || deGerman(l) || l;

// number keys 1..9 bind to footer F-keys; anything past that needs another selector
const FKEY_SLOTS = 9;

// stand-in for a decoded m_status menu: one F-key page per mined screen, so
// ECUs without an .IPO menu still get MS45's paged gauge display
function synthStatusMenu(screenItems, layout) {
  const idxOf = new Map(layout.screens.map((s, i) => [s, i]));
  const items = [];
  let fkey = 1;
  const seen = new Set();
  for (const it of screenItems) {
    const scr = it._screen;
    const idx = idxOf.has(scr) ? idxOf.get(scr) : layout.screens.indexOf(scr);
    if (idx < 0) continue;
    // label: the screen's group, the item label, else the job name
    const label = (deGerman(scr.group) || it.label || jobLabel(scr.job) || `Screen ${fkey}`).trim();
    const sig = label.toLowerCase();
    if (seen.has(sig)) continue; // fold identical-labelled screens into one page
    seen.add(sig);
    items.push({ fkey: fkey++, label, screens: [idx], nav: false });
  }
  return { name: 'm_status', items };
}

// INPA-faithful Status view: the decoded m_status F-key bar (F1 Digital,
// F2 Analog, F3 DK/LL, F4 VANOS, ...) drives one live category readout at a
// time, rendered as paged 2-column gauges (live.js showInpaCategory).
function renderStatusFkeyPages(chassisId, sectionName, ecu, menu, layout, mStatus, view, results) {
  const cats = mStatus.items.filter(i => Array.isArray(i.screens) && i.screens.length);

  // the 9 footer F-keys can't reach more than 9 pages, so beyond that add a
  // scrollable on-screen bar as the selector
  const needsBar = cats.length > FKEY_SLOTS;
  let bar = null;

  // the readout selector keys, shared by the list and each open readout so the
  // softkeys keep switching pages once you are inside one
  const catKeys = () => cats.slice(0, FKEY_SLOTS).map((item, n) => ({
    key: String(n + 1), keyLabel: `F${item.fkey}`,
    label: fkeyLabel(item.label),
    fn: () => open(item, bar && bar.children[n]),
  }));

  const open = (item, btn) => {
    const screens = item.screens.map(i => layout.screens[i]).filter(Boolean);
    showInpaCategory(ecu, screens, results, fkeyLabel(item.label));
    sbLeft.textContent = `${ecu.sgbd}.prg · ${item.label}`;
    if (bar) {
      bar.querySelectorAll('.inpa-cat-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
    }
    // Esc unwinds one level: back to the readout list, not out to the ECU menu.
    // Without this the page keeps the list's own Back and skips a level.
    setActions([...catKeys(), {
      key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
      fn: () => renderStatusFkeyPages(chassisId, sectionName, ecu, menu,
                                      layout, mStatus, view, results),
    }]);
  };

  if (needsBar) {
    bar = document.createElement('div');
    bar.className = 'inpa-cat-bar';
    cats.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'inpa-cat-btn';
      btn.innerHTML = `<span class="inpa-cat-key">F${item.fkey}</span>`
        + `<span class="inpa-cat-label">${esc(fkeyLabel(item.label))}</span>`;
      btn.onclick = () => open(item, btn);
      bar.appendChild(btn);
    });
    view.insertBefore(bar, results);
  }

  // land on the list of readouts, don't auto-open one. INPA's F5 "Read status"
  // opens a submenu (Analog values / Inputs / Outputs / K-bus / ...) and waits
  // for a pick; jumping straight into the first page hides that there are
  // others. renderStatusTree already behaves this way — this matches it.
  const rowsOf = (item) => item.screens
    .map(i => (layout.screens[i] || {}).rows || []).flat().length;

  if (inpaMode()) {
    // the same "< Fn > label" list the ECU home page and the System/Service
    // screens use, rather than an empty panel telling you to press a softkey
    results.className = 'results-panel';
    results.innerHTML = `<div class="act-key-list" id="stat-list"></div>`;
    const list = results.querySelector('#stat-list');
    cats.forEach((item, n) => {
      const rows = rowsOf(item);
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row';
      row.innerHTML = `<span class="inpa-fn-key">&lt; F${item.fkey} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(fkeyLabel(item.label))}</span>`
        + `<span class="act-key-val">${rows} value${rows === 1 ? '' : 's'}</span>`;
      row.onclick = () => open(item, bar && bar.children[n]);
      list.appendChild(row);
    });
  } else {
    results.className = 'group-grid stagger';
    results.innerHTML = '';
    cats.forEach((item, n) => {
      const tile = document.createElement('div');
      tile.className = 'group-tile';
      const rows = rowsOf(item);
      tile.innerHTML = `
        <div class="group-name">${esc(fkeyLabel(item.label))}</div>
        <div class="group-count">${rows} value${rows === 1 ? '' : 's'}</div>
        <div class="group-arrow">→</div>`;
      tile.onclick = () => open(item, bar && bar.children[n]);
      results.appendChild(tile);
    });
    stagger(results, 30);
  }

  // footer F-keys select the first 9 pages. From the list, Esc leaves Status.
  setActions([...catKeys(), {
    key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
    fn: () => showEcu(chassisId, sectionName, ecu),
  }]);
}

// INPA's Read status MENU, mined from the .IPO (tools/ipo_status.py).
//
// INPA does not put every STATUS_* job on one screen: F5 opens a list of pages
// (GSDS2: Switches / Valves / Internal / Gear / System / Analog) and waits for
// a pick. Our Status section was that flat job list, which is the "fallback"
// look -- 135 ECUs now carry the real menu.
//
// What is NOT mined is which readouts sit on each page: a screen's declaration
// body holds only its dispatch, and the captions live in a separate section of
// the file. So a page shows the ECU's gauges (gaugeSpecs, which do carry INPA's
// own unit and range) rather than a per-page split we cannot justify. The menu
// gives INPA's grouping and order; the values come from the jobs as before.
//
// An entry can name several targets: GSDS2's "Analog" resolves to seven
// screens, one per gearbox variant (s_ana2_834, s_ana2_860, ...), because INPA
// picks at runtime from the gearbox type. We cannot know the variant offline,
// so the entry opens once and the count reflects the whole section.
// Which readouts belong on one of INPA's status pages.
//
// INPA's own per-page field list is not decoded (a screen's declaration body
// holds its dispatch; the captions live in another section of the file). But
// the page's NAME says what kind of page it is -- s_schalter is switches,
// s_ventile_834 is valves, s_ana2_860 is analog -- and the ECU's result keys
// carry the same distinction:
//
//     Valves   STAT_MV1_EIN .. STAT_MV6_EIN, STAT_MVSL_EIN, STAT_L1..L4_EIN
//     Analog   STAT_*_WERT  (the seven gauges with a unit and a range)
//     Switches STAT_BREMSSIGNAL_EIN, STAT_KICK_DOWN_EIN, STAT_TIP_UP_EIN ...
//     Gear     STAT_GANG, STAT_WAEHLHEBEL_POSITION, STAT_SCHALTUNGSART_*
//
// so a page can be filtered by kind even without INPA's exact list. This is
// deliberately a KIND match, not a claim to reproduce INPA's page exactly:
// where the name says nothing recognisable the filter is null and the page
// shows every readout, which is what all six keys did before.
// Order matters and each kind EXCLUDES the ones above it: the solenoid keys
// end in _EIN just like the switches do, so an unordered match put MV1..MV6 on
// the Switches page as well as on Valves. A page therefore takes what it owns
// minus what a more specific page already claimed.
const STATUS_PAGE_KINDS = [
  ['valves',   /ventil|valve/i,            /_MV[0-9A-Z]*_|^STAT_L[0-9]+_/i],
  ['analog',   /ana|analog|mwb|messwert/i, /_WERT$/i],
  ['gear',     /gang|gear|getriebe/i,      /GANG|WAEHLHEBEL|SCHALTUNGSART|PROG_MODUS/i],
  ['switches', /schalter|switch|digital/i, /_EIN$|_TASTER|_SIGNAL/i],
];

function pageFilter(item) {
  const names = [item.label, ...(item.targets || [])].join(' ');
  const i = STATUS_PAGE_KINDS.findIndex(([, name]) => name.test(names));
  if (i < 0) return null;
  const mine = STATUS_PAGE_KINDS[i][2];
  const claimedAbove = STATUS_PAGE_KINDS.slice(0, i).map(k => k[2]);
  return { test: (k) => mine.test(k) && !claimedAbove.some(re => re.test(k)) };
}

function renderStatusMenu(chassisId, sectionName, ecu, menu, sec, layout, view, results) {
  const items = (layout.statusMenu.items || []).filter(i => i.resolved);
  const backToEcu = () => showEcu(chassisId, sectionName, ecu);

  // The page's rows. INPA's own per-page split is not decoded (see above), so
  // a page shows the ECU's gauges -- INPA's captions, units and ranges -- read
  // from the section's own status jobs.
  //
  // Passing an empty screens array here is what produced "Something went
  // wrong": showInpaScreens had no job to poll and fell through to the error
  // panel, so every page in the mined menu was a dead end.
  //
  // The job comes from the section's job list, not from the gauge specs: the
  // .IPO names a readout but not the job that reads it, and pairing an ECU to
  // its SGBD offline to recover that was tried and reverted -- matching on
  // shared result keys put GSDS2 on GS832 rather than ags732, and collapsed
  // unrelated modules (ACSM3 airbag onto a DME) because generic STAT_* names
  // recur across the whole ECU family. The app already resolves the right
  // SGBD at runtime, so take the job from what the section actually offers.
  const specs = layout.gaugeSpecs || [];
  const jobs = [...new Set(sec.items.map(i => i.job).filter(Boolean))]
    .filter(j => /STATUS|MESSWERT|STAT_/i.test(j));

  // gaugeSpecs only covers readouts INPA gives a [unit] -- on GSDS2 that is 19
  // analog values and none of the switches, solenoids or gear positions. So
  // the rows come from the JOB's own result list (offline, via _RESULTS) and
  // gaugeSpecs supplies INPA's label/unit/range for the keys it knows.
  const byKey = new Map(specs.map(g => [g.key, g]));
  const resultCache = new Map();

  const jobResults = async (job) => {
    if (resultCache.has(job)) return resultCache.get(job);
    let keys = [];
    try {
      // ResultsOf returns plain strings, formatted "NAME : comment"
      const d = await api(`/api/ecu/${ecu.sgbd}/results/${job}`);
      keys = (Array.isArray(d) ? d : [])
        .map(s => String(s).split(':')[0].trim())
        .filter(Boolean);
    } catch { keys = []; }
    resultCache.set(job, keys);
    return keys;
  };

  const pageScreens = async (item) => {
    // the decompiled page (tools/ipo_disasm.py): INPA's own rows for THIS
    // page -- key, caption, unit, range -- plus the job that reads them.
    // This is the real per-page split; the kind-filter below only remains
    // for ECUs the decompiler cannot bound.
    if (Array.isArray(item.fields) && item.fields.length) {
      const pageJobs = (item.jobs && item.jobs.length) ? item.jobs : jobs;
      // pool strings carry whatever language the .IPO was compiled in --
      // BMW resolved @...@ at build time and shipped no dictionary -- so
      // German-built files reach us German and go through deGerman like
      // every other mined label in the app
      const state = (s) => {
        if (s == null) return s;
        const t = s.trim();
        if (/^EIN$/i.test(t)) return 'ON';
        if (/^AUS$/i.test(t)) return 'OFF';
        if (/^JA$/i.test(t)) return 'YES';
        if (/^NEIN$/i.test(t)) return 'NO';
        return deGerman(t) || t;
      };
      const rows = item.fields.map(f => ({
        key: f.key,
        label: f.label ? (deGerman(f.label) || f.label) : jobLabel(f.key),
        unit: f.unit && (deGerman(f.unit) || f.unit),
        min: f.min, max: f.max,
        on: state(f.on), off: state(f.off), kind: f.kind,
      }));
      return pageJobs.slice(0, 1).map(job => ({ job, group: 'Status', rows }));
    }
    if (!jobs.length) return [];
    const want = pageFilter(item);
    const out = [];
    for (const job of jobs) {
      const keys = await jobResults(job);
      const rows = keys
        // the _EINH companion carries a key's unit, not a reading of its own
        .filter(k => !/_EINH$/.test(k))
        .filter(k => !want || want.test(k))
        .map(k => {
          const g = byKey.get(k);
          return g ? { key: k, label: g.label, unit: g.unit,
                       min: g.min, max: g.max }
                   : { key: k, label: jobLabel(k) };
        });
      if (rows.length) out.push({ job, group: 'Status', rows });
    }
    return out;
  };

  // if any page carries decompiled fields, this ECU's menu is fully decoded;
  // a field-less sibling is then an ACTION (RDC's "WE reset"), and dumping
  // every result key from the section's job buckets onto it — 100 raw
  // STAT_* names — is exactly the un-INPA fallback this menu replaces
  const decoded = items.some(i => Array.isArray(i.fields) && i.fields.length);

  const open = async (item, n) => {
    const screens = (decoded && !(item.fields || []).length)
      ? [] : await pageScreens(item);
    if (screens.length) {
      showInpaCategory(ecu, screens, results, fkeyLabel(item.label));
    } else {
      // an action page, or nothing decodable: say so, don't dump keys
      results.className = 'results-panel';
      results.innerHTML = `<div class="empty"><div>`
        + (decoded
          ? `In INPA this entry performs an action, not a readout — it is `
            + `not offered here until verified on a car.`
          : `INPA lists this page, but its readouts are not decoded for this ECU.`)
        + `</div></div>`;
    }
    sbLeft.textContent = `${ecu.sgbd}.prg · ${item.label}`;
    setActions([...keys(), {
      key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
      fn: () => renderStatusMenu(chassisId, sectionName, ecu, menu, sec,
                                 layout, view, results),
    }]);
  };
  const keys = () => items.slice(0, FKEY_SLOTS).map((item, n) => ({
    key: String(n + 1), keyLabel: `F${n + 1}`, label: fkeyLabel(item.label),
    fn: () => open(item, n),
  }));

  // decompiled pages show their real row count; multi-target pages are
  // variant-selected at runtime and show as such
  const note = (item) => {
    if (Array.isArray(item.fields) && item.fields.length)
      return `${item.fields.length} value${item.fields.length === 1 ? '' : 's'}`;
    return item.targets.length > 1 ? `${item.targets.length} variants` : '';
  };

  if (inpaMode()) {
    results.className = 'results-panel';
    results.innerHTML = `<div class="act-key-list" id="stat-list"></div>`;
    const list = results.querySelector('#stat-list');
    items.forEach((item, n) => {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row';
      row.innerHTML = `<span class="inpa-fn-key">&lt; F${n + 1} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(fkeyLabel(item.label))}</span>`
        + `<span class="act-key-val">${esc(note(item))}</span>`;
      row.onclick = () => open(item, n);
      list.appendChild(row);
    });
  } else {
    results.className = 'group-grid stagger';
    results.innerHTML = '';
    items.forEach((item, n) => {
      const tile = document.createElement('div');
      tile.className = 'group-tile';
      tile.innerHTML = `
        <div class="group-name">${esc(fkeyLabel(item.label))}</div>
        <div class="group-count">${esc(note(item))}</div>
        <div class="group-arrow">→</div>`;
      tile.onclick = () => open(item, n);
      results.appendChild(tile);
    });
    stagger(results, 30);
  }

  setActions([...keys(), {
    key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: backToEcu,
  }]);
}

// INPA's nested status hierarchy. Each level is an F-key page: entries with
// `items` open a submenu (Digital/, Analog/, System/), entries with `job` open
// that screen's gauges. Esc walks back up one level, exactly like INPA's F10.
function renderStatusTree(chassisId, sectionName, ecu, layout, view, results) {
  const byJob = new Map(layout.screens.map(s => [s.job, s]));
  const backToEcu = () => showEcu(chassisId, sectionName, ecu);

  // `up` reopens the parent level, so Esc unwinds one step at a time
  const openLevel = (items, trail, up) => {
    sbLeft.textContent = [`${ecu.sgbd}.prg`, ...trail].join(' · ');
    const back = up || backToEcu;
    const enter = (it) => {
      const here = [...trail, it.label];
      const reopen = () => openLevel(items, trail, up);
      if (it.items) openLevel(it.items, here, reopen);
      else openScreen(it, here, reopen);
    };

    // INPA drives this from the softkey bar alone; modern mode shows the same
    // grouping as clickable tiles (and keeps the keys as a shortcut)
    if (inpaMode()) {
      // same "< Fn > label" list as the ECU home page — a submenu level is a
      // list of choices, not an empty panel pointing at the softkey bar
      results.className = 'results-panel';
      results.innerHTML = `<div class="act-key-list" id="tree-list"></div>`;
      const list = results.querySelector('#tree-list');
      items.forEach(it => {
        const row = document.createElement('button');
        row.className = 'inpa-fn act-key-row';
        row.innerHTML = `<span class="inpa-fn-key">&lt; F${it.fkey} &gt;</span>`
          + `<span class="inpa-fn-label">${esc(fkeyLabel(it.label))}</span>`
          + `<span class="act-key-val">${it.items ? `${it.items.length} readouts ▸` : 'live values'}</span>`;
        row.onclick = () => enter(it);
        list.appendChild(row);
      });
    } else {
      results.className = 'group-grid stagger';
      results.innerHTML = '';
      items.forEach(it => {
        const tile = document.createElement('div');
        tile.className = 'group-tile';
        tile.innerHTML = `
          <div class="group-name">${esc(fkeyLabel(it.label))}</div>
          <div class="group-count">${it.items ? `${it.items.length} readouts` : 'live values'}</div>
          <div class="group-arrow">${it.items ? '▸' : '→'}</div>`;
        tile.onclick = () => enter(it);
        results.appendChild(tile);
      });
      stagger(results, 30);
    }

    const acts = items.slice(0, FKEY_SLOTS).map((it, n) => ({
      key: String(n + 1),
      keyLabel: `F${it.fkey}`,
      label: fkeyLabel(it.label) + (it.items ? ' ▸' : ''),
      fn: () => enter(it),
    }));
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: back });
    setActions(acts);
  };

  // a leaf: gauges, with Esc returning to the menu it was opened from
  const openScreen = (it, trail, up) => {
    const scr = byJob.get(it.job);
    if (!scr) { results.innerHTML = errorBlock(`no screen for ${it.job}`); return; }
    setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: up }]);
    showInpaScreens(ecu, [scr], results, fkeyLabel(it.label));
    sbLeft.textContent = [`${ecu.sgbd}.prg`, ...trail].join(' · ');
  };

  openLevel(layout.statusTree, [], null);
}

// ECU section view: the top-level router for a module's function categories.
// dispatches to the fault-memory F-key screen, the status multi-watch list, the
// mined gauge/input screens (live.js), or the actuator-test panel (activations.js).
async function showEcuSection(chassisId, sectionName, ecu, menu, sectionKey) {
  const sec = menu.sections.find(s => s.section === sectionKey);
  lastScreen = () => showEcuSection(chassisId, sectionName, ecu, menu, sectionKey);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: () => backToModules(chassisId) },
    { label: ecu.label, fn: () => showEcu(chassisId, sectionName, ecu) },
    { label: sectionLabel(sec.section) },
  ]);
  sbLeft.textContent = `${ecu.sgbd}.prg`;
  // the subtitle starts as the raw job count, but a screen that reorganises
  // those jobs into something else (Activations shows INPA's component groups,
  // not STEUERN_* job names) corrects it via setSectionCount — otherwise the
  // header says "2 functions" over a list of twelve.
  const shown = sectionCount(ecu, sec);
  view.innerHTML = head(`${ecu.label} · ${ecu.code}`, sectionLabel(sec.section),
    `${shown} function${shown === 1 ? '' : 's'}`);

  const results = document.createElement('div');
  results.className = 'results-panel';
  view.appendChild(results);

  const IR_SECTION_KEY = {
    Activations: /^(Activate|Ansteuern|Steuern)$/i,
    Special: /^(Memory|Speicher|Read memory|Speicher lesen)$/i,
    Coding: /^(Cod(e|ing)|Codierung)$/i,
    Status: /^(Status|Read status|Status lesen)$/i,
    Identity: /^(Ident|Identification|Identifikation)$/i,
  };
  const irKey = IR_SECTION_KEY[sec.section];
  if (irKey && ecu._ir === undefined) {
    try {
      const hint = ecu.code ? `?code=${encodeURIComponent(ecu.code)}` : '';
      ecu._ir = await api(`/api/ecu/${ecu.sgbd}/ir${hint}`);
      await irResolveVariant(ecu);
    } catch { ecu._ir = null; }
  }
  if (irKey && ecu._ir && typeof renderIrMenu === 'function') {
    const root = irRootMenu(ecu._ir, ecu._variant);
    const hit = root && irMenuItems(ecu._ir, root, ecu._variant)
      .find(i => irKey.test(i.label));
    if (hit && irOpenItem(ecu, ecu._ir, root, hit, results,
        () => showEcu(chassisId, sectionName, ecu))) return;
  }

  // layout-mined sections (have _screen) render as gauge panels, not the
  // checkbox multi-watch list
  const isLayoutScreens = sec.items.some(i => i._screen);
  const isStatus = sec.section === 'Status' && !isLayoutScreens;

  // INPA's own nested status hierarchy (statusTree, decoded from the .IPO):
  // Digital/ and Analog/ open submenus, everything else is a page. Both UI
  // modes use it — the grouping is how the ECU's screens are actually
  // organised, so it beats a flat list of 38 either way. Only the readout
  // itself differs (INPA bars/lamps vs the modern gauge panel).
  const layout = ecu._layout;
  if (sec.section === 'Status' && layout
      && Array.isArray(layout.statusTree) && layout.statusTree.length) {
    renderStatusTree(chassisId, sectionName, ecu, layout, view, results);
    return;
  }
  // No IR branch here on purpose. An ECU with a decompiled root menu never
  // reaches this function -- showEcu renders INPA's own menu and every key
  // navigates through renderIrMenu. This path serves ECUs whose .IPO did not
  // decompile, and hand-verified layouts, which keep their sections.
  // INPA's mined Read status menu. After statusTree (hand-built layouts win)
  // and before the flat job list, which is what this replaces. Both UI modes:
  // the grouping is the ECU's own, so it beats an undifferentiated list either
  // way — only the readout presentation differs.
  if (sec.section === 'Status' && layout && layout.statusMenu
      && (layout.statusMenu.items || []).some(i => i.resolved)) {
    renderStatusMenu(chassisId, sectionName, ecu, menu, sec, layout, view, results);
    return;
  }
  // the remaining F-key page layouts are INPA's, so they too only apply when
  // INPA screens are switched on — modern mode falls through to the tile list
  const mStatus = inpaMode() && sec.section === 'Status' && layout && Array.isArray(layout.menus)
    ? layout.menus.find(m => m.name === 'm_status' &&
        m.items.some(i => Array.isArray(i.screens) && i.screens.length))
    : null;
  if (mStatus) {
    renderStatusFkeyPages(chassisId, sectionName, ecu, menu, layout, mStatus, view, results);
    return;
  }
  // synthesize F-key pages from mined screen items (non-MS45 ECUs)
  const screenItems = inpaMode()
    ? sec.items.filter(i => i._screen && (i._screen.rows || []).length) : [];
  if (screenItems.length && layout && Array.isArray(layout.screens)) {
    const synth = synthStatusMenu(screenItems, layout);
    if (synth.items.some(i => i.screens.length)) {
      renderStatusFkeyPages(chassisId, sectionName, ecu, menu, layout, synth, view, results);
      return;
    }
  }
  // the decompiled Activate menu beats the mined activateTree, which lists
  // submenus it has no items for and jobs it never resolved
  // Sections the decompiled UI serves better than the job buckets. Each maps
  // to the INPA root key that opens it, and the interpreter takes it from
  // there -- menu, card, memory dump, whatever that key really is.
  const isActivations = sec.section === 'Activations';
  const selected = new Set();

  // System check (INPA F9 "System"): the ECU's own START_/STOP_ diagnostic
  // routines, which are a different shape from the actuator toggles above
  const sysChecks = (layout && layout.systemChecks) || [];
  if (sec.section === 'System Check' && sysChecks.length) {
    const back = { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                   fn: () => showEcu(chassisId, sectionName, ecu) };
    setActions([back]);
    renderSystemChecks(ecu, sysChecks, results, back);
    return;
  }

  // Identity: INPA's ID-data card — part number, versions, build date
  if (sec.section === 'Identity' && layout && layout.identity) {
    const back = { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                   fn: () => showEcu(chassisId, sectionName, ecu) };
    setActions([back]);
    renderIdentity(ecu, layout.identity, results, back);
    return;
  }

  // Special: INPA's Speicher (memory dump) + EWS/CAS start-value alignment
  if (sec.section === 'Special' && layout && layout.special) {
    const back = { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                   fn: () => showEcu(chassisId, sectionName, ecu) };
    setActions([back]);
    renderSpecial(ecu, layout.special, results, back);
    return;
  }

  // Service: CBS data and ECU commands (no INPA original — see service.js)
  if (sec.section === 'Service' && layout && layout.service) {
    const back = { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                   fn: () => showEcu(chassisId, sectionName, ecu) };
    setActions([back]);
    renderService(ecu, layout.service, results, back);
    return;
  }

  // Adaption: INPA's selective adaptation clearing (root F8)
  if (sec.section === 'Adaption' && layout && layout.adaption) {
    const back = { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                   fn: () => showEcu(chassisId, sectionName, ecu) };
    setActions([back]);
    renderAdaption(ecu, layout.adaption, results, back);
    return;
  }

  // AIF: INPA's user-information field — the DME's programming history
  if (sec.section === 'AIF' && layout && layout.aif) {
    const back = { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                   fn: () => showEcu(chassisId, sectionName, ecu) };
    setActions([back]);
    renderAif(ecu, layout.aif, results, back);
    return;
  }

  // Coding: the ECU's vehicle-option flags (ECU_CONFIG), drawn as lamps
  // INPA's mined Coding screen is a labelled read (it has `fields`); the
  // hand-built one is the ECU_CONFIG option lamps (it has `options`).
  if (sec.section === 'Coding' && layout && layout.coding
      && Array.isArray(layout.coding.fields)) {
    const back = { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                   fn: () => showEcu(chassisId, sectionName, ecu) };
    setActions([back]);
    renderCodingRead(ecu, layout.coding, results, back);
    return;
  }

  if (sec.section === 'Coding' && layout && layout.coding) {
    const back = { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                   fn: () => showEcu(chassisId, sectionName, ecu) };
    setActions([back]);
    renderCoding(ecu, layout.coding, results, back);
    return;
  }

  // activations get a dedicated actuator-test panel (activations.js)
  if (isActivations) {
    // set the Back action first: showActivations is async and the INPA renderer
    // re-issues setActions with its own F-keys, which must not be overwritten
    // pass the section's Back explicitly: showActivations is async and every
    // renderer under it re-issues setActions, so by the time one needs the exit
    // it can no longer read it back out of currentActions
    const back = { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                   fn: () => showEcu(chassisId, sectionName, ecu) };
    setActions([back]);
    showActivations(ecu, sec, results, back);
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
      row.onclick = () => showInpaScreens(ecu, [it._screen], results, null, { scroll: true });
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
