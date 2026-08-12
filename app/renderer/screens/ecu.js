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

const jobLabel = (j) => {
  if (JOB_LABELS[j]) return JOB_LABELS[j];
  // humanize SNAKE_CASE then translate any German verbs/nouns left in the name
  let s = j.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  if (typeof deGerman === 'function') s = deGerman(s) || s;
  return s;
};


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
    // Coding no longer hangs off the per-ECU menu -- it is a chassis-level
    // destination (the Coding tile -> Coding hub). So no root-menu extras here.
    if (typeof setIrRootExtras === 'function') setIrRootExtras(null);
    renderIrMenu(ecu, ecu._ir, irRoot, grid, () => backToModules(chassisId));
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

// INPA softkey captions, kept verbatim in both UI modes — except the
// German-only ones, which read in English
const FKEY_LABEL = {
  'Abgas': 'Exhaust', 'Laufunruhe': 'Rough running',
  'Überdrehzahl': 'Overrev', 'Übertemp': 'Overtemp',
};
const fkeyLabel = (l) => FKEY_LABEL[l] || deGerman(l) || l;

// number keys 1..9 bind to footer F-keys; anything past that needs another selector
const FKEY_SLOTS = 9;
