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
  await irUseVariantSgbd(ecu);
}

// INPA's .IPO is one frontend for a family of ECUs (KOMBI.IPO drives KOMBI31
// .. KOMBI85), and the variant name IS the SGBD it then talks to -- there is
// no KOMBI.prg. Jobs aimed at the family name reach no schema, so every row
// came back unanswered ("0 of 16 values"). Point the ECU at the variant's own
// SGBD once, and every job/results/table call follows.
async function irUseVariantSgbd(ecu) {
  const v = ecu._variant;
  if (!v || v.toUpperCase() === String(ecu.sgbd).toUpperCase()) return;
  if (ecu._sgbdBase) return;
  try {
    const jobs = await api(`/api/ecu/${v}/jobs`);
    if (!Array.isArray(jobs) || !jobs.length) return;
  } catch { return; }        // not a real SGBD (a misread variant key)
  ecu._sgbdBase = ecu.sgbd;
  ecu.sgbd = v;
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

  // shimmer placeholders while the IR loads, so the function list has shape
  // from the first frame rather than a blank pane behind "loading…"
  grid.innerHTML = skeletonList(6, false);

  api('/api/port').then(p => {
    document.getElementById('port-pill').textContent =
      p.port ? `cable: ${p.port.replace('/dev/', '')}` : 'no cable';
  }).catch(() => {});

  // THE IR IS THE ONLY SOURCE OF A SCREEN. Three renderers used to compete
  // here -- the mined /layout, the inpa2json menu tree, and a menu built
  // locally from the raw job list (menugen.js) -- each a fallback for the
  // last. They are gone: every ECU the app can open has an IR that yields a
  // root menu (verified 1000/1000 across all 21 chassis), so the fallbacks
  // were unreachable code that could only ever disagree with the interpreter.
  try {
    const codeHint = ecu.code ? `?code=${encodeURIComponent(ecu.code)}` : '';
    ecu._ir = await api(`/api/ecu/${ecu.sgbd}/ir${codeHint}`);
    await irResolveVariant(ecu);
  } catch { ecu._ir = null; }

  // INPA's own keys, in INPA's own order, each opening whatever it opens.
  const irRoot = ecu._ir && typeof irRootMenu === 'function'
    ? irRootMenu(ecu._ir, ecu._variant) : null;
  if (irRoot) {
    const items = typeof irMenuItems === 'function'
      ? irMenuItems(ecu._ir, irRoot) : [];
    document.getElementById('job-count').textContent =
      `${items.length} functions`;
    if (bar) bar.remove();
    grid.className = inpaMode() ? 'inpa-haupt' : 'group-grid stagger';
    // registered BEFORE the first draw, because renderIrMenu redraws the root
    // itself when a submenu returns and the entry has to survive that
    const show = await hasCoding(ecu.sgbd);
    if (typeof setIrRootExtras === 'function') {
      setIrRootExtras(show
        ? (e, c) => addCodingEntry(e, chassisId, sectionName, c)
        : null);
    }
    renderIrMenu(ecu, ecu._ir, irRoot, grid, () => backToModules(chassisId));
    if (show) addCodingEntry(ecu, chassisId, sectionName, grid);
    return;
  }

  // No IR, or an IR with no root menu. Only reachable for the handful of ECUs
  // BMW itself never drew a UI for -- they carry "[OBT_SCREEN] ScreenCount=0"
  // in INPA's own .ini, and INPA shows them nothing either. Say so rather
  // than rendering a menu we invented.
  document.getElementById('job-count').textContent = '0 functions';
  grid.innerHTML = errorBlock(
    'This ECU has no INPA screen definition (ScreenCount=0). '
    + 'Its jobs are shipped in ecus/ but INPA draws no UI for it.');
  sbLeft.textContent = 'no screen';
}

// The Coding entry, appended to an ECU's root menu.
//
// This is OURS, not INPA's. INPA's own Coding key runs its coding sequence --
// on LWS5 it dumps the module to a .COD file on the PC, which is why that key
// opens an empty list here -- and none of that is the labelled, editable page
// the SGBD's own result names make possible. So the app adds a key of its own
// rather than pretending to reproduce one of INPA's.
//
// It appends to the rendered root menu instead of being merged into the IR's
// item list, because the IR is INPA's bytecode and adding an invented key to
// it would put a row on the softkey bar with an F-number INPA never assigned.
function addCodingEntry(ecu, chassisId, sectionName, grid) {
  // called after every draw of the root menu, so never add a second one
  if (grid.querySelector('.app-coding-entry')) return;
  const back = () => showEcu(chassisId, sectionName, ecu);
  const open = () => {
    setCrumbs([
      { label: 'Vehicles', fn: showChassis },
      { label: dispChassis(chassisId), fn: () => backToModules(chassisId) },
      { label: ecu.label, fn: back },
      { label: 'Coding map' },
    ]);
    // the car you are actually looking at, so the coding map opens on its
    // own chassis instead of whichever sorts first
    showCoding(ecu, grid, back, chassisId);
  };

  if (inpaMode()) {
    // the same "< Fn > label" row as the rest of the list, with no F-number:
    // INPA assigns those and this key is not one of INPA's
    const list = grid.querySelector('#ir-list');
    if (!list) return;
    const row = document.createElement('button');
    row.className = 'inpa-fn act-key-row app-coding-entry';
    row.innerHTML = `<span class="inpa-fn-key">&lt; C &gt;</span>`
      + `<span class="inpa-fn-label">Coding map</span>`
      + `<span class="act-key-val">read</span>`
      + `<span class="ir-enter">&#8629;</span>`;
    row.onclick = open;
    list.appendChild(row);
  } else {
    const tile = document.createElement('div');
    tile.className = 'group-tile app-coding-entry';
    tile.innerHTML = `<div class="group-name">Coding map</div>
      <div class="group-count">what every coding bit in this module means</div>
      <div class="group-arrow">→</div>`;
    tile.onclick = open;
    grid.appendChild(tile);
  }

  // "c" opens it from the keyboard. The digits belong to INPA's own F-keys, so
  // this takes a letter and never displaces one of them.
  //
  // Added to the live bar rather than through setActions(): re-running that
  // would clear the shift row renderIrMenu just installed and stop the header's
  // polling, and this key is an addition to that bar, not a new screen.
  if (typeof addAction === 'function')
    addAction({ key: 'c', keyLabel: 'C', label: 'Coding map', fn: open });
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
          + `<span class="act-key-val">${it.items ? '▸' : ''}</span>`;
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
