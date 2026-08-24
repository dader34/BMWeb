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
  // One attempt per screen entry, EXCEPT after a failure to verify: a user
  // who plugs the cable in and re-opens the module must get a real answer,
  // not a cached "we never asked".
  if (demoMode()) return;
  if (ecu._groupTried
      && !['unverified', 'unavailable'].includes(ecu._variantSource)) return;
  ecu._groupTried = true;
  // WHY the configured SGBD is still the one on screen. The chassis config
  // lists every variant BMW fitted at an address and the app opens the first
  // -- 609 of the 1000 grouped rows sit behind a group that can name a
  // DIFFERENT variant, so "we did not ask" and "the car confirmed it" are
  // completely different statements and the header must not render them the
  // same way. Set on every early return; cleared only by a real answer.
  ecu._variantSource = null;
  const g = String(ecu.group || '').toLowerCase();
  if (!g) { ecu._variantSource = 'ungrouped'; return; }
  if (typeof webResolveVariant !== 'function') {
    ecu._variantSource = 'unavailable'; return;
  }
  const idx = await ecuGroupIndex();
  if (!idx || !(idx.groups || []).includes(g)) {
    ecu._variantSource = 'nogroup'; return;
  }
  let v = null;
  try { v = await webResolveVariant(g); }
  catch { /* silence: treated as no answer below */ }
  if (!v) {
    // No cable, or the address stayed silent. Either way nothing verified
    // this SGBD, and the screen says so rather than implying the car agreed.
    ecu._variantSource = 'unverified'; return;
  }
  if (v === String(ecu.sgbd).toLowerCase()) {
    ecu._variantSource = 'confirmed'; return;
  }
  // only retarget to a variant this build can actually load ('xyz' catch-all
  // and exotic variants without job-code stay on the configured SGBD)
  try {
    const jobs = await api(`/api/ecu/${v}/jobs`);
    if (!Array.isArray(jobs) || !jobs.length) return;
  } catch { return; }
  ecu._sgbdBase = ecu._sgbdBase || ecu.sgbd;
  ecu.sgbd = v;
  ecu._variantSource = 'identified';
  // The group ran IDENTIFIKATION and the answer IS the variant name -- the same
  // thing irResolveVariant would ask INITIALISIERUNG for. Record it: without
  // this the variant stayed unknown whenever the group answered first, and
  // every per-variant menu guard (menuFor) had nothing to match, so an E46 took
  // the first branch and landed on the E38 pages.
  if (!ecu._variant) ecu._variant = v.toUpperCase();
}

// Several root menus, one per ECU variant: INPA runs the variant job and
// matches its VARIANTE result. Both showEcu and showEcuSection need this --
// a section reached straight from the F-key bar never runs showEcu.
async function irResolveVariant(ecu) {
  const ir = ecu._ir;
  if (!ir || !ir.rootVariants || !ir.variantJob) return;
  // already known (the group's IDENTIFIKATION answered it): don't ask the car
  // twice, but DO hand it to the IR -- menu/screen selection reads ir._variant,
  // and returning early here left it unset.
  if (ecu._variant) { ir._variant = ecu._variant; return; }
  const names = Object.values(ir.rootVariants).flat();
  // THE SGBD IS OFTEN THE VARIANT, AND NO JOB REPORTS IT. VARIANTE is an
  // EDIABAS SYSTEM result derived from the loaded .prg, not something a job
  // returns: kombi46's INITIALISIERUNG yields only DONE, and no kombi46 job
  // names VARIANTE at all. Running the variant job to learn it can therefore
  // never work here -- INPA does not need to ask, because it loaded KOMBI46.
  // So when the SGBD we are talking to IS one of the variants this IR serves,
  // that is the answer, and it costs no transaction.
  const self = names.find(n => String(n).toUpperCase()
                               === String(ecu.sgbd).toUpperCase());
  if (self) {
    ecu._variant = self;
    ir._variant = self;
    return;
  }
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
  if (typeof busTrace !== 'undefined') {
    busTrace.add('ir.variant', null,
      `sgbd=${ecu.sgbd} variantJob=${ir.variantJob} -> _variant=${ecu._variant}`);
  }
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
// REFUSE THE MODULE UNTIL THE CAR SAYS WHICH VARIANT IT IS.
//
// A diagnostic address is shared. D_ZKE_GM can identify NINE different
// modules (zke3_gm1/4/5/6, zke4, zke5, zke5_s12, bc1, bc1rd) and the chassis
// config just names the one BMW listed for this shell -- so opening zke5 with
// nothing connected shows one variant's screens, jobs, coding map and fault
// text for a car that may carry another. 364 of the 1014 config rows are in
// that position. Every readout on the wrong variant is a wrong answer that
// looks exactly like a right one, which is the failure this app exists to
// avoid, so the screen does not open at all.
//
// Only where it is genuinely undecidable: a group that can name just ONE
// variant (650 rows) has nothing to resolve, and those open as before. Demo
// mode is exempt -- it says outright that its values are simulated.
let _groupNamesP = null;
const groupNames = () => (_groupNamesP ??=
  fetch('data/groups/variants-by-group.json')
    .then(r => (r.ok ? r.json() : null)).catch(() => null));

async function irBlockUnverified(ecu, chassisId, grid, bar) {
  if (typeof demoMode === 'function' && demoMode()) return false;
  if (!['unverified', 'unavailable'].includes(ecu._variantSource)) return false;
  const g = String(ecu.group || '').toLowerCase();
  if (!g) return false;
  const map = await groupNames();
  const names = (map && map[g]) || [];
  // one candidate (or no table shipped) = nothing the read could change
  if (names.length < 2) return false;

  if (bar) bar.remove();
  grid.className = 'results-panel';
  // SAY WHAT ACTUALLY HAPPENED. "Connect a cable" with a cable already
  // paired reads as a broken app -- the read RAN and the address stayed
  // silent, which is a statement about the car (ignition off, module not
  // fitted, or it answers as a different variant), not about the cable.
  const p = await api('/api/port').catch(() => null);
  const cable = !!(p && p.port);
  // JUST THE HEADLINE. The earlier version spelled out the address, the
  // sibling list and the reasoning; it read as a wall and the mixed
  // centre/left alignment made it worse. The reason belongs in the tooltip,
  // not on the page -- what the user needs is the one action that unblocks it.
  grid.innerHTML = `<div class="empty"><div class="empty-big"
      style="color:var(--amber)"
      title="${esc(ecu.label)} sits on diagnostic address ${esc(ecu.group)}, `
    + `which ${names.length} different modules can answer (${esc(names.join(', '))}). `
    + `Until the car identifies itself, opening one variant's screens for `
    + `another would answer confidently and wrongly.">`
    + (cable
      ? `No answer at address ${esc(ecu.group)}</div>`
        + `<div>The cable is connected, but the module did not identify `
        + `itself. Check the ignition is on -- or this car may carry a `
        + `different variant (${esc(names.slice(0, 6).join(', '))}`
        + `${names.length > 6 ? ` and ${names.length - 6} more` : ''}); `
        + `reopen the module to ask again.</div>`
        + (() => {
          // the resolver's own account of HOW it failed -- a silent bus, an
          // answered-but-unmatched identification, and a probe error are
          // three different problems and the page should say which this was
          const d = (typeof webResolveVariantLast === 'function'
            ? webResolveVariantLast()
            : (window.webResolveVariantLast && window.webResolveVariantLast()))
            || null;
          if (!d || d.group !== String(ecu.group).toLowerCase()) return '';
          const what = {
            'no-probe-shipped': 'this build ships no probe for the address',
            'bus-silent': `nothing on the wire answered `
              + `(${d.empty || 0} probe${d.empty === 1 ? '' : 's'} sent)`,
            'probe-error': `the probe failed: ${esc(d.error || 'unknown')} `
              + `(${d.real || 0} answered, ${d.empty || 0} silent)`,
            'answered-but-unmatched': `the module ANSWERED `
              + `${d.real} telegram${d.real === 1 ? '' : 's'} but the `
              + `identification matched no known variant -- a decode or `
              + `table problem on our side, not a silent car`,
          }[d.path] || d.path;
          return `<div class="mono" style="opacity:.7">probe result: `
            + `${what}</div>`;
        })()
      : `Connect a cable to open this module</div>`)
    + `</div>`;
  sbLeft.textContent = `${ecu.sgbd}.prg · variant unverified · `
    + (cable ? 'address silent' : 'needs a cable');
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: () => backToModules(chassisId) }]);
  return true;
}

// SAY WHETHER THE CAR CONFIRMED THIS SGBD. A chassis config lists every
// variant BMW fitted at a diagnostic address and the app opens the first that
// matches; on 609 of the 1000 grouped rows the group can name a different one.
// Opening a module with no cable therefore shows a GUESS, and rendering that
// identically to a confirmed read is the same class of error as a fault scan
// reporting "clean" for a module it never spoke to.
//
// The screen is not blocked: reading an IR offline is useful and harmless.
// What changes is that the pill states which of the two it is.
function irShowVariantSource(ecu, bar) {
  if (!bar) return;
  const src = ecu._variantSource;
  if (!src || src === 'ungrouped' || src === 'nogroup') return;
  let el = bar.querySelector('#variant-pill');
  if (!el) {
    el = document.createElement('span');
    el.id = 'variant-pill';
    el.className = 'pill';
    bar.appendChild(el);
  }
  if (src === 'identified' || src === 'confirmed') {
    el.className = 'pill pill-ok';
    el.textContent = `variant ${ecu.sgbd} · confirmed by the car`;
    el.title = 'The diagnostic-address group ran IDENTIFIKATION and the car '
             + 'named this SGBD.';
    return;
  }
  // unverified / unavailable
  el.className = 'pill pill-warn';
  el.textContent = `variant not verified · showing ${ecu.sgbd}`;
  el.title = `${ecu.label} shares diagnostic address ${ecu.group} with other `
    + 'variants. Nothing answered, so this is the configuration\u2019s pick, not '
    + 'the car\u2019s answer -- connect the cable and reopen to confirm.';
}

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
    // THE HEADER WAS WRITTEN BEFORE WE KNEW WHICH MODULE THIS IS. It renders
    // from the chassis config's name 30 lines above, and resolution runs
    // here -- so an E46 whose climate unit identifies as ihka46_3 kept
    // reading "SGBD ihka38.prg", an E38 part, for the whole session. The
    // jobs, screens and fault text below all belong to the resolved variant;
    // only the caption still claimed otherwise.
    if (ecu._sgbdBase && ecu._sgbdBase !== ecu.sgbd) {
      const sub = view.querySelector('.subtitle');
      if (sub) {
        sub.textContent = `SGBD ${ecu.sgbd}.prg · identified by the car `
          + `(configured ${ecu._sgbdBase}) · choose a function group below`;
      }
    }
    irShowVariantSource(ecu, bar);
    if (await irBlockUnverified(ecu, chassisId, grid, bar)) return;
    // THE SGBD IS WHAT WE TALK TO; THE SCRIPT IS WHAT DRAWS. INPA never loads
    // a UI per variant -- it loads ONE script per diagnostic address and picks
    // the matching screens inside it. E46's climate entry is klima_5B, and
    // KLIMA_5B.IPO carries 87 screens covering every IHKA variant, named for
    // the variant they serve (s_eingaenge_ihka46_2, s_steuern_motoren_
    // ihka38_ihka38_2_ihka38_3). BMW ships no IHKA46_3.IPO and never did:
    // ihka46_3 appears in that script's dispatch list and shares IHKA46's
    // pages.
    //
    // So retargeting the SGBD must NOT retarget the UI. Asking for
    // ihka46_3's own IR got "this ECU has no INPA screen definition", which
    // is true and useless -- the right screens were in the script all along.
    // Fall back to the CONFIGURED sgbd's archive, which is where this entry's
    // script ships; irResolveVariant then selects within it by ecu._variant.
    // 1116 of 2942 shipped archives carry no ir.json, most of them this shape.
    const codeHint = ecu.code ? `?code=${encodeURIComponent(ecu.code)}` : '';
    ecu._ir = await api(`/api/ecu/${ecu.sgbd}/ir${codeHint}`).catch(() => null);
    if ((!ecu._ir || !Object.keys(ecu._ir.menus || {}).length)
        && ecu._sgbdBase && ecu._sgbdBase !== ecu.sgbd) {
      const base = await api(`/api/ecu/${ecu._sgbdBase}/ir${codeHint}`)
        .catch(() => null);
      if (base && Object.keys(base.menus || {}).length) {
        ecu._ir = base;
        ecu._irFrom = ecu._sgbdBase;
      }
    }
    if (!ecu._ir) throw new Error('no IR for this module');
    // asking the car which variant it is takes a real transaction; say so
    // rather than leaving the skeleton up with no explanation
    if (!ecu._variant && ecu._ir && ecu._ir.rootVariants
        && !(typeof demoMode === 'function' && demoMode())) {
      sbLeft.textContent = 'reading variant…';
    }
    await irResolveVariant(ecu);
    sbLeft.textContent = `${ecu.sgbd}.prg`;
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
    // A deep link naming a submenu opens it directly, with Back going to the
    // root menu (not out to the module list) so the hierarchy still reads
    // right. But the URL is untrusted: it can name a menu belonging to another
    // variant of this family (a link shared from a different car, or a stale
    // bookmark). irResolveVariant has already run above, so check the link
    // against INPA's own dispatch before honouring it -- otherwise the address
    // bar walks straight past the variant guards.
    if (openMenu && openMenu !== irRoot && irMenuItems(ecu._ir, openMenu).length) {
      const okForVariant = typeof irMenuAllowedForVariant !== 'function'
        || irMenuAllowedForVariant(ecu._ir, openMenu, ecu._variant);
      if (okForVariant) {
        if (renderIrMenu(ecu, ecu._ir, openMenu, grid, toRoot, [])) return;
      } else {
        // land on the root instead of another variant's page, and say why
        sbLeft.textContent = `${openMenu} is not part of ${ecu._variant} — opened the main menu`;
      }
    }
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
