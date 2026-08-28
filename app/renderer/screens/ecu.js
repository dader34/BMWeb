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
    ecu._variant = v.toUpperCase();
    ecu._variantSource = 'confirmed'; return;
  }
  // THE VARIANT NAME IS INPAINIT'S GROUND TRUTH. The group's IDENTIFIKATION
  // returns the concrete variant (SM46_4) -- the same thing inpainit checks
  // against its expected list. Record it ALWAYS, even when this build cannot
  // load a separate SGBD for it: a family .prg (sm46 covering SM46_3/_4/C_*)
  // runs one script and inpainit validates the variant INSIDE it, so without
  // the real name inpainit compared its list against the SGBD filename "SM46"
  // -- which matches none of SM46_3/_4/... -- and stopped with a
  // self-contradictory "Requested 'SM46' not found. Found 'SM46'".
  ecu._variant = v.toUpperCase();
  ecu._variantSource = 'confirmed';
  // only RETARGET the SGBD when a concrete variant SGBD actually ships;
  // otherwise keep the family SGBD and just carry the resolved variant name.
  try {
    const jobs = await api(`/api/ecu/${v}/jobs`);
    if (!Array.isArray(jobs) || !jobs.length) return;
  } catch { return; }
  ecu._sgbdBase = ecu._sgbdBase || ecu.sgbd;
  ecu.sgbd = v;
  ecu._variantSource = 'identified';
  // The group ran IDENTIFIKATION and the answer IS the variant name -- the same
  // thing inpainit reads from INITIALISIERUNG. Record it: without
  // this the variant stayed unknown whenever the group answered first, and
  // every per-variant menu guard (menuFor) had nothing to match, so an E46 took
  // the first branch and landed on the E38 pages.
  if (!ecu._variant) ecu._variant = v.toUpperCase();
}



// The set of job names the LOADED variant actually implements, cached on the
// ecu. A shared .IPO offers every family screen, but a variant need not carry
// every job (kombi46r dropped DPRAM_LESEN/ROM_LESEN), and renderIrMenu drops a
// readout tile whose job this ECU lacks. null (never resolved / offline) means
// "don't filter" -- we only hide a tile when we KNOW the job is absent.
async function irLoadJobNames(ecu) {
  if (ecu._jobNames) return ecu._jobNames;
  try {
    const jobs = await api(`/api/ecu/${ecu.sgbd}/jobs`);
    ecu._jobNames = new Set((Array.isArray(jobs) ? jobs : []).map(
      j => String(typeof j === 'string' ? j : (j && j.name) || '').toUpperCase()));
  } catch { /* leave unset: offline -> do not filter */ }
  return ecu._jobNames || null;
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
    // an informational pill showing whether the group's IDENTIFIKATION named
    // this SGBD -- status only, it gates nothing (inpainit is the gate now).
    irShowVariantSource(ecu, bar);
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
    // script ships; inpainit then reads the variant and selects within it.
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
    // the loaded variant's job list, so renderIrMenu can drop readout tiles for
    // jobs this ECU does not implement (kombi46r has no DPRAM_LESEN). Awaited
    // here so it is ready before any menu draws; a failure leaves it unset and
    // nothing is filtered.
    await irLoadJobNames(ecu);
    sbLeft.textContent = `${ecu.sgbd}.prg`;
  } catch { ecu._ir = null; }

  // ENTRY GATE = INPA's inpainit, run LIVE. This is the ONE authority on
  // "is this the right control unit, and does it answer". INPA reads
  // INITIALISIERUNG->VARIANTE and INFO->{REVISION,SPRACHE,...}, compares each to
  // what the script was compiled for, and pops a messagebox on a variant /
  // version / LANGUAGE mismatch -- or "Program will be stopped!" when the ECU
  // cannot be identified. We run that bytecode and show exactly what it draws.
  // There is no JS re-implementation any more (the variant "block", the silence
  // probe, the _variantSource state machine are gone): the .IPO shipped the real
  // check and it works, so we run it instead of guessing. Cable + a runnable
  // inpainit required; with no cable there is nothing to ask and the module
  // opens offline for browsing; demo exempt.
  if (ecu._ir && !(typeof demoMode === 'function' && demoMode())) {
    const p = await api('/api/port').catch(() => null);
    const cable = !!(p && p.port);
    const entry = cable && typeof irRunEntry === 'function'
      ? await irRunEntry(ecu) : { ran: false };
    if (entry.ran) {
      // inpainit IS the variant read -- the live wire answer is the variant.
      if (entry.variant) {
        ecu._variant = String(entry.variant).toUpperCase();
        if (ecu._ir) ecu._ir._variant = ecu._variant;
      }
      const msgs = entry.messages || [];
      // "Program will be stopped!" (variant not found / silent) is BLOCKING:
      // INPA does not open the module.
      const stop = msgs.find(m => /stopped/i.test(m.body || ''));
      if (stop || entry.silent) {
        if (bar) bar.remove();
        grid.className = 'results-panel';
        const m = stop || { title: `${esc(ecu.label)} is not answering`,
          body: 'The cable is connected, but this module did not identify '
              + 'itself. It may not be fitted to this car, or the ignition may '
              + 'need to be on.' };
        // WHY inpainit had nothing better than the SGBD filename to check:
        // the group probe's own verdict (bus-silent, probe-error, ...) is the
        // actionable half of this screen, so say it instead of leaving a
        // self-contradictory "'SM46' not found, found 'SM46'".
        const rd = (typeof webResolveVariantLast === 'function')
          ? webResolveVariantLast() : null;
        const g = String(ecu.group || '').toLowerCase();
        const why = (rd && g && rd.group === g && rd.path !== 'resolved')
          ? `<div style="margin-top:14px;font-size:12px;color:var(--ink-faint)">`
            + `Variant probe ${esc(g)}: <b>${esc(rd.path)}</b>`
            + (rd.empty != null || rd.real != null
              ? ` (${Number(rd.real || 0)} answered, ${Number(rd.empty || 0)} silent)` : '')
            + (rd.error ? ` — ${esc(String(rd.error))}` : '')
            + `. The car did not name this module, so the script checked the `
            + `SGBD filename instead. Ignition on, reopen the module.</div>`
          : '';
        grid.innerHTML = `<div class="empty"><div class="empty-big"`
          + ` style="color:var(--amber)">${esc(irLabel(m.title) || m.title)}`
          + `</div><div>${esc(irLabel(m.body) || m.body || '')}</div>${why}</div>`;
        sbLeft.textContent = `${ecu.sgbd}.prg · ${stop ? 'stopped' : 'no response'}`;
        setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                      kind: 'back', fn: () => backToModules(chassisId) }]);
        return;
      }
      // version / LANGUAGE mismatch ("Malfunction possible!") is a WARNING:
      // INPA shows it, then proceeds. Show each once before the menu.
      for (const m of msgs) {
        if (typeof messageDialog === 'function') {
          await messageDialog({ title: irLabel(m.title) || m.title,
                                body: irLabel(m.body) || m.body || '',
                                danger: true });
        }
      }
    }
    // entry.ran === false means no cable or no runnable inpainit -- open for
    // browsing. We do NOT fabricate a block from a failed JS probe: the .IPO is
    // the source of truth, and not being able to run it is our gap, not a reason
    // to refuse a module that may well answer.
  }

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
    // bookmark). inpainit has already resolved the variant above, so check the link
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
