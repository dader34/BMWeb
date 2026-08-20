// ECU menu: job labels, variant resolution, showEcu.
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


// BEFORE the IR loads: let the ecu's diagnostic-address group name the real
// variant, exactly like the scan does (and like INPA does on open). The
// configured SGBD can be a wrong-generation sibling that happily answers --
// the E46 config maps Airbag to zae while the car carries an MRS, and zae
// decodes the MRS's answer as a false 0 faults. The group's IDENTIFIKATION
// (D_00A4 bytecode in the VM) is immune to that mixup. One attempt per ecu
// per screen entry; webResolveVariant caches per session underneath, so the
// wire sees one ident exchange per group per connection.
let _ecuGroupIndexP = null;
const ecuGroupIndex = () => (_ecuGroupIndexP ??=
  fetch('data/groups/index.json').then(r => (r.ok ? r.json() : null)).catch(() => null));
async function irResolveGroupVariant(ecu) {
  if (ecu._groupTried || demoMode()) return;
  ecu._groupTried = true;
  const g = String(ecu.group || '').toLowerCase();
  if (!g || typeof webResolveVariant !== 'function') return;
  const idx = await ecuGroupIndex();
  if (!idx || !(idx.groups || []).includes(g)) return;
  let v = null;
  try { v = await webResolveVariant(g); } catch { /* silence = keep configured */ }
  if (!v || v === String(ecu.sgbd).toLowerCase()) return;
  // only retarget to a variant this build can actually load ('xyz' catch-all
  // and exotic variants without job-code stay on the configured SGBD)
  try {
    const jobs = await api(`/api/ecu/${v}/jobs`);
    if (!Array.isArray(jobs) || !jobs.length) return;
  } catch { return; }
  ecu._sgbdBase = ecu._sgbdBase || ecu.sgbd;
  ecu.sgbd = v;
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

// Deep link (#car/<CHASSIS>/<SGBD>[/<MENU>]): the URL names an SGBD, not the
// in-memory ECU object the card click would have passed, so look it up in the
// chassis config first. Falls back to the module list when the SGBD isn't in
// this chassis (a stale or hand-edited link).
async function showEcuDeep(chassisId, sgbd, menuName) {
  const ch = await tryApi(`/api/chassis/${chassisId}`, null, view,
                          `failed to load ${dispChassis(chassisId)}`);
  if (!ch) return;
  const want = String(sgbd).toLowerCase();
  for (const sec of (ch.sections || [])) {
    const hit = (sec.ecus || []).find(e => String(e.sgbd).toLowerCase() === want);
    if (hit) return showEcu(chassisId, sec.name, hit, menuName);
  }
  sbLeft.textContent = `${sgbd} not in ${dispChassis(chassisId)}`;
  return showSections(chassisId);
}

// ECU main menu: section categories on the F-key bar, each opens a sub-screen.
// openMenu (optional) is an IR menu name to descend into once the IR is loaded,
// so a deep link lands on the submenu rather than the root.
async function showEcu(chassisId, sectionName, ecu, openMenu) {
  lastScreen = () => showEcu(chassisId, sectionName, ecu, openMenu);
  // the ECU object comes from the chassis config and doesn't know which chassis
  // it came from; screens that build links/reports off it need that (exportFaults
  // already read ecu.chassis, which was always undefined until now)
  ecu.chassis = chassisId;
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
    // group first, so the IR fetched below already belongs to the variant
    // the car actually carries (zae's IR is useless against an MRS4)
    await irResolveGroupVariant(ecu);
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
    const toRoot = () =>
      renderIrMenu(ecu, ecu._ir, irRoot, grid, () => backToModules(chassisId));
    // a deep link naming a submenu opens it directly, with Back going to the
    // root menu (not out to the module list) so the hierarchy still reads right
    if (openMenu && openMenu !== irRoot
        && irMenuItems(ecu._ir, openMenu).length
        && renderIrMenu(ecu, ecu._ir, openMenu, grid, toRoot, [])) return;
    toRoot();
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
