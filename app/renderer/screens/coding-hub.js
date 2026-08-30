// The Coding hub: the one place coding lives, reached from the chassis Coding
// tile. Two tabs:
//   Features  -- curated owner-facing toggles (showCuratedCoding), only where a
//                chassis has a curated map.
//   Expert    -- every codeable module's raw coding. Desktop: one searchable
//                nested tree (Module > Function > Values). Mobile: a module list
//                that drills into expertModuleScreen.

// Every module of a chassis whose coding the app can show, with its kind:
// 'values' (SGBD names its coding -- editable read) or 'map' (BMW's DATEN
// description of the blob -- reference). Cached per chassis for the session.
const _codeableCache = new Map();
async function codeableModules(chassisId, saCodes) {
  const id = String(chassisId || '').toUpperCase();
  // The cache key carries the equipment, because selection depends on it: the
  // same chassis resolves to different modules on different cars.
  const key = `${id}|${(saCodes || []).join(',')}`;
  if (_codeableCache.has(key)) return _codeableCache.get(key);
  let ch;
  try { ch = await api(`/api/chassis/${id}`); }
  catch { return []; }
  const seen = new Set(); const all = [];
  for (const s of ch.sections || []) {
    for (const e of s.ecus) {
      if (seen.has(e.sgbd)) continue;
      seen.add(e.sgbd);
      all.push({ ...e, section: s.name });
    }
  }
  const kinds = await Promise.all(all.map(async (e) => {
    if (typeof codingFor === 'function' && await codingFor(e.sgbd)) return 'values';
    if (typeof datenFor === 'function' && await datenFor(e.sgbd)) return 'map';
    return null;
  }));
  let out = all.map((e, i) => ({ ...e, kind: kinds[i] })).filter(e => e.kind);

  // WHICH VARIANT OF EACH MODULE THIS CAR ACTUALLY HAS.
  //
  // The chassis config names one module per slot, but a slot is filled by
  // different hardware across the build: E46's cluster is C_KMB46 early and
  // KOMBI46R after the redesign, and an M3 uses a different coding file again.
  // BMW answers that from the VEHICLE ORDER -- every SGET row carries a
  // predicate over the car's equipment codes, and the first row that holds
  // wins. That is what NCS Expert does, and coding-select does the same.
  //
  // Only with equipment codes in hand: without them there is nothing to
  // evaluate and the config's own name stands.
  if (saCodes && saCodes.length && typeof CodingSelect !== 'undefined') {
    try {
      if (typeof loadSget === 'function') await loadSget();
      out = CodingSelect.applySelection(id, out, saCodes);
    } catch (e) { /* no SGET for this chassis: keep the config's names */ }
  }

  _codeableCache.set(key, out);
  return out;
}

// ASK THE CAR WHICH VARIANT EACH MODULE IS, before reading its coding.
//
// applySelection above is BMW's own method and it is right, but it reasons
// from the VEHICLE ORDER -- it needs SA codes, and it never touches the wire.
// The bus knows better: a diagnostic address is shared, and running the
// group's IDENTIFIKATION is what says which of the candidates is actually
// fitted. On a real E46, EDIABAS answered ews3 where the config says ews,
// kombi46r where it says kombi46, and ihka46_3 where it says ihka38 -- three
// wrong coding maps out of fifteen modules.
//
// That matters more here than anywhere else in the app. A coding read still
// ANSWERS on the wrong variant (same address, same job name), so the bytes
// look fine and only the bit-to-meaning mapping is wrong -- and a write is a
// delta spliced onto that image, so a wrong map changes a bit nobody chose.
// assertResolvedForWrite cannot catch it: that guard checks the coding INDEX
// within one SGBD's own DATEN, and never consults the bus.
//
// Sets on each module:
//   sgbd            retargeted to what the car named, when we can read it
//   _codingVariant  'identified' | 'confirmed' | 'unverified' | 'sole'
//   _variantOf      the configured name, when it was replaced
const _codingGroupNames = () => (typeof groupNames === 'function'
  ? groupNames() : Promise.resolve(null));

async function codingResolveVariants(mods) {
  if (typeof demoMode === 'function' && demoMode()) return mods;
  if (typeof webResolveVariant !== 'function') return mods;
  const amb = await _codingGroupNames();
  const cache = new Map();
  for (const m of mods) {
    const g = String(m.group || '').toLowerCase();
    if (!g) { m._codingVariant = 'sole'; continue; }
    // a group that can name only one variant has nothing to resolve
    if (amb && !amb[g]) { m._codingVariant = 'sole'; continue; }
    if (!cache.has(g)) {
      let v = null;
      try { v = await webResolveVariant(g); } catch { v = null; }
      cache.set(g, v);
    }
    const via = cache.get(g);
    if (!via) { m._codingVariant = 'unverified'; continue; }
    if (via === String(m.sgbd).toLowerCase()) {
      m._codingVariant = 'confirmed';
      continue;
    }
    // The car named a DIFFERENT variant. Retarget only when this build has a
    // coding map for it -- otherwise the module is present but undecodable
    // here, which is a different statement from "wrong map applied".
    const entry = typeof codingFor === 'function' ? await codingFor(via) : null;
    const daten = !entry && typeof datenFor === 'function'
      ? await datenFor(via) : null;
    if (!entry && !daten) { m._codingVariant = 'unbuilt'; m._variantVia = via; continue; }
    m._variantOf = m.sgbd;
    m.sgbd = via;
    m.kind = entry ? 'values' : 'map';
    m._codingVariant = 'identified';
  }
  return mods;
}

// Does this chassis have anything to code? Drives the chassis-screen tile.
async function chassisHasCoding(chassisId) {
  return (await codeableModules(chassisId)).length > 0;
}

async function showCodingHub(chassisId, initialTab) {
  const id = String(chassisId || '').toUpperCase();
  // STALENESS TOKEN. The read is several awaits long; if the user backs out
  // mid-read, a later screen reassigns lastScreen, and this run must abort
  // rather than paint the coding panel onto whatever is showing now. Every
  // screen fn sets lastScreen at entry, so "is my token still installed?"
  // is the honest test.
  const myToken = () => showCodingHub(chassisId, initialTab);
  lastScreen = myToken;
  const alive = () => lastScreen === myToken;
  const back = () => (typeof backToModules === 'function'
    ? backToModules(chassisId)
    : (typeof showSections === 'function' ? showSections(chassisId) : showChassis()));
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Coding' },
  ]);
  sbLeft.textContent = `${dispChassis(chassisId)} · coding`;

  const curated = typeof hasCurated === 'function' && hasCurated(chassisId);
  let tab = initialTab || (curated ? 'features' : 'expert');

  view.innerHTML = head('Coding', dispChassis(chassisId),
    'Change how the car is configured. Nothing is sent — changes are staged '
    + 'for review.');

  // A CABLE IS REQUIRED TO CODE. Every toggle here is the car's current
  // setting, and a change is staged as a delta against it. With nothing
  // connected the reads all fail and the editor used to draw the whole car
  // anyway, at library defaults -- settings that look read but are invented.
  // Demo mode is exempt: it says outright that its values are simulated.
  if (!(typeof demoMode === 'function' && demoMode())) {
    let port = null;
    try { ({ port } = await api('/api/port')); } catch { /* treated as none */ }
    if (!port) {
      const need = document.createElement('div');
      need.className = 'empty';
      need.innerHTML =
        `<div class="empty-big" style="color:var(--amber)">Connect a cable to code</div>`
        + `<div>Coding shows what the car is set to now, and stages changes `
        + `against it. With nothing connected there is nothing to read.</div>`
        + `<div style="font-size:12px;color:var(--ink-faint);max-width:48ch">`
        + `Showing defaults here would look like the car’s own settings. `
        + `Connect the adapter and open Coding again, or turn on Demo mode to `
        + `explore the screens with simulated values.</div>`;
      view.appendChild(need);
      setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                    kind: 'back', fn: back }]);
      sbLeft.textContent = 'coding needs a cable';
      return;
    }
  }

  // ONE LOADING REGION FOR THE WHOLE READ. Two awaits precede the module
  // scan -- the vehicle SA codes (an identity read) and the scan itself --
  // and both were silent before, so the pane sat blank, then the scan bar
  // appeared mid-render. A single host, shown immediately and replaced
  // atomically, covers the lot: the reader never sees a blank coding page or
  // a progress bar arriving after the toggles.
  const loadHost = document.createElement('div');
  view.appendChild(loadHost);
  const scanShell = (title, sub) => `<div class="coding-scan">`
    + `<div class="coding-scan-title">${esc(title)}</div>`
    + `<div class="coding-scan-bar coding-scan-indef"><span></span></div>`
    + `<div class="coding-scan-mod mono">${esc(sub || '')}</div></div>`;
  loadHost.innerHTML = scanShell('Reading the car…',
    'identifying equipment…');
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                kind: 'back', fn: back }]);

  // THE CAR'S EQUIPMENT FIRST, THEN THE MODULES.
  //
  // Which module fills a slot depends on what the car was built with, so the
  // equipment codes have to be in hand before the module list is built. BMW
  // reads them from the vehicle order (or, on older cars, decodes them out of
  // the coding key) and evaluates each candidate's predicate against them.
  //
  // A car that will not say is not a failure: with no codes the config's own
  // module names stand, exactly as before.
  const saCodes = await readVehicleSaCodes(chassisId);
  if (!alive()) return;                       // backed out during identify

  // Read the whole car up front so both tabs' toggles start at the car's
  // current values without per-module Read buttons. The scan paints its
  // determinate progress into the SAME host, so the bar continues from the
  // indeterminate identify phase with no flash of empty page between.
  let scan = await scanCoding(chassisId, loadHost, saCodes);
  if (!alive()) { loadHost.remove(); return; }   // backed out mid-scan
  loadHost.remove();

  const tabs = document.createElement('div');
  tabs.className = 'coding-tabs';
  tabs.innerHTML =
    (curated ? `<button class="coding-tab" data-tab="features">Features</button>` : '')
    + `<button class="coding-tab" data-tab="expert">Expert</button>`;
  view.appendChild(tabs);
  const panel = document.createElement('div');
  panel.className = 'coding-panel';
  view.appendChild(panel);

  // Re-read the whole car and redraw the active tab. The single Re-read
  // control, surfaced top-right on mobile (kind:'navAction') like Back top-left.
  const reScan = async () => {
    const host = document.createElement('div');
    panel.replaceWith(host);
    host.id = 'coding-panel'; host.className = 'coding-panel';
    scan = await scanCoding(chassisId, host, saCodes);
    if (!alive()) { host.remove(); return; }
    host.replaceWith(panel);
    panel.innerHTML = '';
    select(tab);
  };

  const select = (t) => {
    tab = t;
    tabs.querySelectorAll('.coding-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === t));
    if (t === 'features' && typeof showCuratedCoding === 'function') {
      showCuratedCoding(chassisId, panel, back, scan, reScan);
    } else {
      showExpertCoding(chassisId, panel, back, scan, reScan);
    }
  };
  tabs.querySelectorAll('.coding-tab').forEach(b =>
    b.onclick = () => select(b.dataset.tab));
  select(tab);
}

// Does a coding read carry values we can actually decode into settings?
//
// "Has a read job" is not "has fields". Verified against a real E46: zke5
// declares 41 fields and answers with a single raw COD_DATEN blob; szm46
// declares 1 and answers with raw CODE bytes. Rendering a module's toggles off
// a map it did not fill would show 41 switches backed by nothing, every one of
// them a default rather than the car. A module like that is readable but not
// editable, and has to say so.
function codingDecoded(entry, got) {
  if (!got || !got.size) return 0;
  const names = new Set((entry && entry.fields || []).map((f) => f.name));
  let n = 0;
  for (const k of got.keys()) if (names.has(k)) n++;
  return n;
}

// The modules this car actually has, out of the ones the chassis map lists.
//
// A module that answered with decodable fields is editable. One that answered
// with only a raw blob (zke5's COD_DATEN, szm46's CODE) is present but has no
// decoder here, so it is kept and marked rather than shown as toggles it
// cannot back. One that never answered is dropped: on a real car that is
// almost always hardware this car does not carry.
//
// Demo mode keeps everything -- there is no car to answer, and the point there
// is to see the screens.
function codingPresent(mods, scan) {
  const status = (scan && scan.status) || new Map();
  if (typeof demoMode === 'function' && demoMode()) return mods;
  if (!status.size) return mods;         // pre-scan callers: unchanged
  return mods
    .map((m) => ({ ...m, coding: status.get(m.sgbd) || { state: 'silent' } }))
    .filter((m) => m.coding.state === 'ok' || m.coding.state === 'raw');
}

// Scan the car's coding: read every codeable module's coding job once, return
// { values: Map(sgbd -> Map(result -> value)), status: Map(sgbd -> {...}) }.
//
// THE STATUS IS THE POINT. This used to swallow every failure and return only
// what answered, so with no cable the cache came back EMPTY and the editor
// still drew every toggle -- at library defaults, indistinguishable from the
// car's real settings. Coding writes are a delta against what was read, so a
// phantom baseline makes the diff meaningless. Now each module records whether
// it answered, and with how many decodable fields, and the caller shows only
// what the car really has.
async function scanCoding(chassisId, host, saCodes) {
  const mods = await codingResolveVariants(
    await codeableModules(chassisId, saCodes));
  const cache = new Map();
  const status = new Map();
  cache.status = status;
  // the RESOLVED modules, so every consumer works from the variants the car
  // named rather than re-deriving the config's guess (see showExpertCoding)
  cache.mods = mods;
  const total = mods.length;
  const paint = (done, name) => {
    host.innerHTML = `<div class="coding-scan">`
      + `<div class="coding-scan-title">Reading the car…</div>`
      + `<div class="coding-scan-bar"><span style="width:`
      + `${Math.round(100 * done / Math.max(1, total))}%"></span></div>`
      + `<div class="coding-scan-mod mono">${esc(name || '')}`
      + ` · ${done}/${total} modules</div></div>`;
  };
  paint(0, '');
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    paint(i, m.label);
    const entry = typeof codingFor === 'function'
      ? await codingFor(m.sgbd) : null;
    if (!entry || !entry.read) {
      // described by DATEN only: nothing to read, so nothing to stage against
      status.set(m.sgbd, { state: 'noread' });
      continue;
    }
    try {
      const d = await api(`/api/ecu/${m.sgbd}/run/${entry.read}`,
                          { method: 'POST' });
      const got = new Map(flatResults(d.sets));
      // THE CODING INDEX, WHICH THE READ JOB USUALLY DOES NOT RETURN.
      // Only 3 of 29 coding modules name it in their own read; ZKE5's
      // COD_LESEN hands back the raw COD_DATEN blob and nothing else. The
      // index is what picks which DATEN variant describes those bytes
      // (ZKE5 ships C01/C02/C04/C05+C06), and codDatenField only trusts a
      // field when the index selected it -- so without this EVERY curated
      // feature decoded as "unknown" and drew as an empty toggle, on a car
      // that had answered perfectly well.
      //
      // 23 more modules expose it on IDENT (or C_CI_LESEN). One extra read
      // per module, and only when the coding read did not already carry it.
      if (!CI_RESULTS.some((k) => got.has(k))) {
        for (const j of ['C_CI_LESEN', 'IDENT']) {
          try {
            const names = await codingJobNames(m.sgbd);
            if (!names.includes(j)) continue;
            const idr = await api(`/api/ecu/${m.sgbd}/run/${j}`,
                                  { method: 'POST' });
            for (const [k, v] of flatResults(idr.sets)) {
              if (CI_RESULTS.includes(k) && !got.has(k)) got.set(k, v);
            }
            if (CI_RESULTS.some((k) => got.has(k))) break;
          } catch { /* no index from this job: try the next */ }
        }
      }
      const n = codingDecoded(entry, got);
      cache.set(m.sgbd, got);
      status.set(m.sgbd, {
        state: n ? 'ok' : 'raw',
        fields: n,
        // an ECU that answers a coding read with an error status is present but
        // refusing -- not the same as absent, and worth saying differently
        job: String(got.get('JOB_STATUS') || ''),
      });
    } catch (e) {
      // No answer. On a real car this is overwhelmingly a module the car does
      // not have (the E46 map lists SMG2, RDC, DWA, mirror memory... for cars
      // that carry them); it can also be one that is asleep or on another bus,
      // which is why this is recorded rather than assumed to mean "not fitted".
      status.set(m.sgbd, { state: 'silent', error: String(e && e.message || e) });
    }
  }
  paint(total, '');
  return cache;
}

// Expert tab. Desktop gets the nested tree, mobile the drill-down list, both
// from the SAME source (DATEN description fused with the scan's current
// values) so a module reads identically on either.
async function showExpertCoding(chassisId, cont, back, scan, reScan) {
  const mobile = window.matchMedia
    && window.matchMedia('(max-width: 760px)').matches;
  // THE SAME LIST THE SCAN READ. This used to call codeableModules without
  // saCodes, so the expert tab built its tree from the UNSELECTED names while
  // the scan had read the selected ones -- the two disagreed about which
  // variant a slot holds. Take the scan's own modules, which are also the
  // ones codingResolveVariants retargeted.
  const all = (scan && scan.mods)
    || await codeableModules(chassisId);
  if (!all.length) {
    cont.innerHTML = errorBlock('No codeable modules on this chassis.');
    return;
  }
  // ONLY WHAT THE CAR ANSWERED. The chassis map lists every module BMW ever
  // fitted to this shell -- on a real E46 that is SMG2, RDC, DWA, mirror
  // memory, cruise, the rollover sensor, none of which this car has. Reading
  // the car found 7 of 15. Offering the other eight means offering settings
  // for hardware that is not there.
  const mods = codingPresent(all, scan);
  if (!mods.length) {
    cont.innerHTML = errorBlock(
      'No module answered a coding read. Check the cable and ignition '
      + '(engine off, key on), then re-read.');
    return;
  }
  if (mobile) expertModuleList(chassisId, mods, cont, back, scan, reScan);
  else expertTree(chassisId, mods, cont, back, scan, reScan);
}

// The ECU's coding index (Cxx), read from the scan. INPA returns it as
// ID_COD_INDEX / CODIER_INDEX alongside the coding read; it's the number
// after the "C" in the variant key (C06 -> 6). Returns null when the scan
// didn't name it (offline, or a module that doesn't report it).
// The result names that carry a coding index, in the order
// codingIndexFromScan reads them. Declared once so the scan can ask "did the
// read already give me one?" with the same vocabulary.
const CI_RESULTS = ['ID_COD_INDEX', 'CODIER_INDEX', 'CODIERINDEX',
                    'COD_INDEX', 'ID_CODIERINDEX'];

// Job names one SGBD declares, cached per session. Used only to avoid running
// a job the module does not have -- a 404 there is noise, not information.
const _codJobNames = new Map();
function codingJobNames(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (!_codJobNames.has(key)) {
    _codJobNames.set(key, api(`/api/ecu/${key}/jobs`).then((j) => {
      const list = Array.isArray(j) ? j : (j && j.jobs) || [];
      return list.map((x) => (typeof x === 'string' ? x : x && x.name))
        .filter(Boolean);
    }).catch(() => []));
  }
  return _codJobNames.get(key);
}

function codingIndexFromScan(scan, sgbd) {
  const res = scan && scan.get(String(sgbd).toLowerCase());
  if (!res) return null;
  for (const k of ['ID_COD_INDEX', 'CODIER_INDEX', 'CODIERINDEX',
                   'COD_INDEX', 'ID_CODIERINDEX']) {
    if (res.has(k)) {
      const n = parseInt(String(res.get(k)).replace(/^0x/i, ''), 16);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// A variant key ("C06", or a folded "C06+C07") contains coding index n?
function variantHasCI(key, n) {
  return String(key).split('+').some(k => {
    const m = /C0*(\d+)/i.exec(k);
    return m && parseInt(m[1], 10) === n;
  });
}

// BMW's name for a coding block, e.g. block 12288 of alc_ds2 ->
// "Grundkonfiguration_ALC-SG" / "Basic configuration adaptive headlights
// (AHL) control unit". Returns {name, en} or null when the module ships no
// block table (15 of 83 do not) -- the caller then simply omits the header
// rather than showing a bare number, which is what we did before.
//
// Synchronous on purpose: it runs inside the tree's redraw loop, and the
// datenmap is already resident by then (moduleFunctions awaited it).
const _blockNameCache = new Map();
function blockName(sgbd, block) {
  if (block == null) return null;
  const key = `${sgbd}:${block}`;
  if (_blockNameCache.has(key)) return _blockNameCache.get(key);
  const map = (typeof window !== 'undefined' && window.BMW_DATEN_MAP) || null;
  const entry = map && map[String(sgbd).toLowerCase()];
  const raw = entry && entry.blocks && entry.blocks[String(block)];
  const out = raw
    ? { name: raw, en: (typeof datI18n === 'function' ? datI18n(raw) : '') }
    : null;
  _blockNameCache.set(key, out);
  return out;
}

// FA/ZCS MODULE FILTER. BMW's SGET rows say which ECUs a chassis CAN carry;
// each row's AUFTRAGSAUSDRUCK is a boolean expression over the car's equipment
// codes deciding whether THIS car carries it. Evaluating it is what turns
// "every module an E46 could ever have" into "the modules in front of you".
//
// This filters MODULES, not fields. SGET is the ECU-selection table -- field
// visibility is a different mechanism, and the old field-level `asw` matcher
// never had data behind it (BMW's DATEN carries no asw column, so it passed
// everything through and did nothing).
//
// FAIL OPEN, ALWAYS. No SGET for the chassis, no SA codes read from the car,
// or a module SGET simply does not mention -> SHOW IT. A filter that hides a
// module the car really has is worse than one that shows a spare: the user
// loses access to real coding with no way to tell why. Only an explicit
// predicate that evaluates FALSE against known codes hides anything.
async function filterModulesByFa(chassisId, mods, saCodes) {
  // DISABLED PENDING THE ASW MAPPING -- do not turn on without it.
  //
  // The predicates are real and the evaluator is verified (439 SGET rows,
  // 508/508 parse; test_coding_auftrag.js). What is missing is the NUMBERING
  // BRIDGE between the two sides:
  //
  //   CodingZcs.extractSaCodes() yields BIT INDICES of the 64-bit ZCS SA
  //   field -- 0..63, and only ever 0..63.
  //   SGET predicates reference BMW's SA CATALOG numbers -- observed 2..512
  //   across the shipped corpus, 304 distinct.
  //
  // Those are different numbering systems. Comparing them directly is not a
  // near-miss, it is a category error: measured on real E46 data it hid 37 of
  // 44 modules, including DSC and airbag. Failing open here costs nothing
  // (the user sees the same list as before); failing closed silently removes
  // real coding from a real car.
  //
  // To finish: BMW resolves codes through the chassis dictionaries
  // (<BR>AT.000 / AT.M00 / ZST.000, which we DO ship -- see E46AT.000,
  // E46ZST.*) in coapiGetAswFromAuftrag, building the ASW bit-vector the
  // predicates are actually written against. Parse those into a
  // bit-index -> SA-code map, map extractSaCodes() through it, then delete
  // this early return and re-run the measurement above: a correct mapping
  // should hide few modules on a well-equipped car, not most of them.
  return mods;

  /* eslint-disable no-unreachable */
  if (!saCodes || !saCodes.length) return mods;          // nothing to test against
  if (typeof loadSget !== 'function'
      || typeof CodingAuftrag === 'undefined') return mods;
  try { await loadSget(); } catch { return mods; }
  const all = (typeof window !== 'undefined' && window.BMW_SGET) || null;
  const ch = all && all[String(chassisId || '').toUpperCase()];
  if (!ch || !ch.rows || !ch.rows.length) return mods;

  // sgbd -> its rows (a module can appear once per coding index)
  const bySgbd = new Map();
  for (const r of ch.rows) {
    const k = String(r.SGBD || '').toLowerCase();
    if (!k) continue;
    if (!bySgbd.has(k)) bySgbd.set(k, []);
    bySgbd.get(k).push(r);
  }

  return mods.filter((m) => {
    const rows = bySgbd.get(String(m.sgbd || '').toLowerCase());
    if (!rows || !rows.length) return true;     // not in SGET: fail open
    // ANY row passing means the car can carry this module (rows are per
    // coding index / build variant, and only one needs to apply).
    return rows.some((r) => {
      if (!r.exprHex) return true;
      try {
        const bytes = r.exprHex.match(/../g).map((h) => parseInt(h, 16));
        return CodingAuftrag.matchesAuftrag(bytes, saCodes);
      } catch {
        return true;                            // unreadable predicate: fail open
      }
    });
  });
  /* eslint-enable no-unreachable */
}

// THE CAR'S OWN EQUIPMENT CODES, read before anything else.
//
// These are BMW's SA catalogue numbers (205 automatic, 210 DSC), the namespace
// every SGET predicate is written against. Two sources, by generation:
//
//   the vehicle order (FA)  E60+   its `$` tokens ARE catalogue numbers
//   the coding key (ZCS)    older  bit indices, translated through BMW's own
//                                  ZST + AT tables (see vehicle-identity.js)
//
// Returns [] when the car will not say -- no cable, no identity module, or a
// key whose bits carry no catalogue number. That is not a failure: callers
// treat an empty list as "nothing known", which leaves the configured module
// names in place rather than selecting on a guess.
async function readVehicleSaCodes(chassisId) {
  if (typeof showVehicleIdentity !== 'function'
      || typeof VehicleIdentity === 'undefined') return [];
  // Demo mode has no car to ask, and inventing an equipment list there would
  // silently re-point modules against codes nothing measured.
  if (typeof demoMode === 'function' && demoMode()) return [];
  try {
    const got = await readIdentityCodes(chassisId);
    return (got && got.codes) || [];
  } catch (e) { return []; }
}

// Extract SA codes from scan results for FA/ZCS filtering. Looks for ZCS
// read results (typically from KMB/IKE) and parses the SA key.
function extractSaCodesFromScan(scan) {
  if (!scan || typeof CodingZcs === 'undefined') return null;

  // Common modules that hold ZCS: KMB (kombi), IKE (instrument cluster)
  const zcsModules = ['kmb', 'ike', 'kombi', 'ih'];

  for (const mod of zcsModules) {
    const res = scan.get(mod) || scan.get(mod + '46');
    if (!res) continue;

    // Look for SA key result names
    for (const k of ['SA_SCHLUESSEL', 'SA_WERT', 'ZCS_SA']) {
      if (res.has(k)) {
        const val = String(res.get(k)).replace(/^0x/i, '').replace(/\s/g, '');
        // SA body is 16 hex chars; with check digit it's 17
        const body = val.length >= 16 ? val.slice(0, 16) : null;
        // an all-FF / all-00 body is an erased or "no special equipment" key,
        // not a bitfield -- decoding it would invent ~60 phantom SA codes
        if (body && /^[0-9A-F]{16}$/i.test(body)
            && !CodingZcs.isBlankKeyBody(body)) {
          return CodingZcs.extractSaCodes(body);
        }
      }
    }
  }

  return null;
}

// One module's DATEN functions for a chassis. CI-AWARE: when the scan named
// the ECU's coding index, use ONLY the variant that carries it -- addresses
// move between indices (E46 KMB's ZCS region is word 104 on C02-C06 but 368
// on C07-C08), so unioning would show a field twice and a write off the wrong
// stamp lands in the wrong memory. Without a known index, fall back to the
// union across variants (a reference, not a write target).
// FA/ZCS-AWARE: when saCodes is provided, filter out fields that don't match
// the car's equipment (field.asw requirement).
async function moduleFunctions(chassisId, sgbd, ci = null, saCodes = null) {
  const daten = typeof datenFor === 'function' ? await datenFor(sgbd) : null;
  const byKey = new Map();
  let resolved = false;    // did ci pick exactly the variants carrying it?
  let variants = [];       // which variant keys the fields came from

  if (daten) {
    const chId = String(chassisId || '').toUpperCase();
    const chassis = daten.chassis[chId]
      || daten.chassis[Object.keys(daten.chassis)[0]];
    if (chassis) {
      const keys = Object.keys(chassis);
      const pick = (ci != null) ? keys.filter(k => variantHasCI(k, ci)) : [];
      const use = pick.length ? pick : keys;   // matched index, else all
      // Did the coding index actually resolve to ONE stamp? Only then are the
      // addresses below provably this ECU's. codingIsResolved is what the
      // write path gates on -- see assertResolvedForWrite().
      resolved = pick.length > 0;
      variants = use.slice();
      for (const vk of use) {
        for (const f of chassis[vk]) {
          const key = `${f.block || 0}:${f.word || 0}:${f.byte || 0}:${f.mask || 0}`;
          if (!byKey.has(key)) {
            byKey.set(key, f);
          }
        }
      }
    }
  }

  let fns = [...byKey.values()];

  // The user's own parameters, overlaid on BMW's description. Scoped to the
  // variant actually in use, so a row defined against C04's layout never
  // shows up on C07's. mergeCustom returns the input untouched when there is
  // no overlay, so this costs nothing for the common case.
  if (typeof CodingCustom !== 'undefined' && variants.length) {
    fns = CodingCustom.mergeCustom(fns, sgbd, chassisId, variants.join('+'));
  }

  // Apply FA/ZCS filtering if we have SA codes
  if (saCodes && typeof CodingZcs !== 'undefined' && CodingZcs.matchesAsw) {
    fns = fns.filter(f => CodingZcs.matchesAsw(f, saCodes));
  }

  // Carry HOW this list was resolved alongside it. Non-enumerable so the
  // array still serialises / spreads / maps exactly as before -- every
  // existing caller keeps working, and the write path can ask.
  Object.defineProperty(fns, 'codingIsResolved', { value: resolved });
  Object.defineProperty(fns, 'codingIndex', { value: ci });
  Object.defineProperty(fns, 'codingVariants', { value: variants });
  return fns;
}

// THE UNION IS NOT A WRITE TARGET. When the coding index did not resolve to a
// single stamp, moduleFunctions unions every variant and de-dupes first-wins
// by address -- so a field whose address MOVED between indices resolves to
// whichever variant enumerated first. E46 KMB's ZCS region is word 104 on
// C02-C06 but 368 on C07-C08: writing off the wrong stamp puts bytes into the
// wrong ECU memory. Reading that view is fine; transmitting from it is not.
// Throws with a message naming the ECU, so the caller's catch reports it.
function assertResolvedForWrite(sgbd, fns, mod) {
  // WHICH MODULE, before which layout. The check below verifies the coding
  // INDEX picked one variant stamp inside this SGBD's own DATEN -- it says
  // nothing about whether this SGBD is the module on the wire. Those are two
  // different axes and only one of them was ever guarded: a diagnostic
  // address is shared, and writing ews's map into an EWS3 changes bits nobody
  // chose. codingResolveVariants asks the group; if it could not, refuse.
  if (mod && ['unverified', 'unbuilt'].includes(mod._codingVariant)) {
    throw new Error(
      `refusing to write ${sgbd}: nothing confirmed this is the variant `
      + `fitted. ${mod.label || sgbd} shares diagnostic address `
      + `${mod.group || '?'} with other modules, and a coding write is a `
      + `delta against the layout of whichever one answers. Reconnect and `
      + `re-read so the address group can identify itself.`);
  }
  if (fns && fns.codingIsResolved) return;
  const ci = fns ? fns.codingIndex : null;
  const vs = (fns && fns.codingVariants) || [];
  throw new Error(
    `refusing to write ${sgbd}: coding index unresolved`
    + (ci == null
        ? ' (the scan did not report one)'
        : ` (C${String(ci).padStart(2, '0')} matches no shipped variant)`)
    + (vs.length > 1 ? `; showing a union of ${vs.join(', ')}` : '')
    + '. Addresses move between coding indices, so this view is a reference '
    + 'only -- re-scan with the ECU connected to resolve its index.');
}

// Seed per-function state {current, staged} for one module's functions from
// the scan. Every choosable function gets a current (the read value where the
// scan named it, else a stable deterministic pick) so options render selected
// from the first frame -- no Read buttons, same rule on desktop and mobile.
function seedState(state, sgbd, fns, read) {
  for (const f of fns) {
    const vals = f.values || [];
    const opts = treeOptions(vals);
    // numeric fields are choosable too, even with ONE shipped value: expert
    // mode lets any of them take a hand-typed byte (treeNumeric + the edit
    // chip), so they need a current like every other choice
    const numeric = treeNumericField(vals);
    if (!opts.length && !numeric) continue;
    const fkey = `${sgbd}:${f.name}`;
    let cur = read ? treeMatchRead(f.name, opts, read) : null;
    if (cur == null && numeric && read) {
      // a numeric field accepts ANY byte the read names, not just shipped ones
      const num = typeof codMatchRead === 'function' ? codMatchRead(f.name, read) : null;
      const w = String(vals[0][1]).length;
      if (num != null && num >= 0 && num <= parseInt('f'.repeat(w), 16)) {
        cur = num.toString(16).padStart(w, '0');
      }
    }
    if (cur == null) {
      if (opts.length) {
        let h = 0;
        for (const c of f.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        cur = opts[h % opts.length][1];
      } else {
        cur = String(vals[0][1]).toLowerCase();   // the factory default
      }
    }
    state.set(fkey, { current: cur, staged: null });
  }
}

// all-numeric-named, byte-sized values: the shape that takes free entry
function treeNumericField(vals) {
  return vals.length > 0
    && vals.every(([n]) => treeIsNumericName(n))
    && vals.every(([, v]) => typeof v === 'string' && v.length <= 4);
}

// the ✎ chip tapped: prompt for a value (decimal, or 0x.. hex), bound it by
// the field's mask, stage it like any picked option. Shared by the desktop
// tree and the mobile module view so the two stay identical.
function treeEditPrompt(opt, s, draw) {
  const max = parseInt(opt.dataset.max || '255', 10);
  const w = parseInt(opt.dataset.w || '2', 10);
  inputDialog({
    title: 'Set value',
    body: `Any value 0–${max} can be staged. Only values BMW shipped are `
      + `proven on real cars — a hand-typed one is on you.`,
    kind: 'text', example: String(max), confirmLabel: 'Stage',
  }).then((val) => {
    if (val == null || String(val).trim() === '') return;
    const t = String(val).trim().toLowerCase();
    const n = t.startsWith('0x') ? parseInt(t.slice(2), 16) : parseInt(t, 10);
    if (!Number.isFinite(n) || n < 0 || n > max) return;
    const hex = n.toString(16).padStart(w, '0');
    s.staged = hex === String(s.current).toLowerCase() ? null : hex;
    draw();
  });
}

// MOBILE: a list of modules; tapping one opens that module's coding as the
// same DATEN function list the desktop tree shows, so a module matches its
// desktop view.
function expertModuleList(chassisId, mods, cont, back, scan, reScan) {
  cont.className = 'coding-panel';
  cont.innerHTML = `<div class="cur-list" id="exp-list"></div>`;
  const list = cont.querySelector('#exp-list');
  mods.forEach((m) => {
    const row = document.createElement('button');
    row.className = 'cur-row exp-row'; row.type = 'button';
    row.innerHTML = `<span class="cur-label">${esc(m.label)}`
      + `<span class="exp-sgbd mono">${esc(m.sgbd)}.prg</span></span>`
      + `<span class="exp-arrow">›</span>`;
    row.onclick = () => expertModuleScreen(chassisId, m, back, scan);
    list.appendChild(row);
  });
  const acts = [];
  if (reScan) acts.push({ key: '1', keyLabel: 'F1', kind: 'navAction',
    label: 'Re-read', fn: reScan });
  acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
              fn: back });
  setActions(acts);
}

// MOBILE per-module screen: one module's DATEN functions as selectable value
// groups. Identical data and rules to an expanded module in the desktop tree.
async function expertModuleScreen(chassisId, m, back, scan) {
  const reopen = () => showCodingHub(chassisId, 'expert');
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Coding', fn: reopen },
    { label: m.label },
  ]);
  lastScreen = () => expertModuleScreen(chassisId, m, back, scan);
  view.innerHTML = head('Coding', m.label, `${m.sgbd}.prg`);
  const host = document.createElement('div');
  host.className = 'coding-panel coding-tree-wrap';
  view.appendChild(host);
  host.innerHTML = skeletonList ? skeletonList(6) : '';

  const ci = codingIndexFromScan(scan, m.sgbd);
  const fns = await moduleFunctions(chassisId, m.sgbd, ci);
  const label = (name) => (typeof datLabel === 'function' ? datLabel(name) : name);
  const state = new Map();
  const read = scan && scan.get(m.sgbd);
  seedState(state, m.sgbd, fns, read);

  // only functions that are a real multiple-choice show as editable groups;
  // the rest (numeric fields, buffers, defaults) render as static reference.
  const rows = fns.filter(f => (f.values || []).length);
  if (!rows.length) {
    host.innerHTML = errorBlock('No coding functions in this module.');
    return;
  }

  const stagedCount = () =>
    [...state.values()].filter(s => s.staged != null).length;

  // expanded functions, preserved across the redraw a value tap triggers.
  // Start collapsed: the list opens as a scannable index of function names.
  const openFns = new Set();

  const draw = () => {
    host.innerHTML = '<div class="coding-tree" id="m-tree"></div>';
    const tree = host.querySelector('#m-tree');
    for (const f of rows) {
      const fkey = `${m.sgbd}:${f.name}`;
      const valsHtml = treeValues(f.values || [], label, fkey, state, f);
      const fl = document.createElement('details');
      fl.className = 'tree-fn'; fl.dataset.fkey = fkey;
      fl.open = openFns.has(fkey);
      fl.ontoggle = () => fl.open ? openFns.add(fkey) : openFns.delete(fkey);
      fl.innerHTML = `<summary class="tree-fn-h">`
        + `<span class="tree-name">${esc(label(f.name))}`
        + `${state.has(fkey) && state.get(fkey).staged != null
            ? '<span class="tree-staged-dot"></span>' : ''}</span>`
        + `<span class="tree-key mono">blk ${f.block} · byte ${f.byte} · `
        + `mask 0x${f.mask.toString(16).padStart(2, '0')}</span></summary>`
        + `<div class="tree-vals">${valsHtml}</div>`;
      tree.appendChild(fl);
    }
    updateBar();
  };

  host.addEventListener('click', (e) => {
    const opt = e.target.closest('.tree-opt');
    if (!opt) return;
    const wrap = opt.closest('.tree-opts');
    const fkey = wrap && wrap.dataset.fkey;
    const s = fkey && state.get(fkey);
    if (!s) return;
    if (opt.dataset.edit != null) { treeEditPrompt(opt, s, draw); return; }
    const v = opt.dataset.v;
    s.staged = (String(v).toLowerCase() === String(s.current).toLowerCase())
      ? null : v;
    draw();
  });

  const built = [{ ...m, fns: rows }];
  // No F-key bar on mobile (CSS hides it for .coding-panel); controls live in
  // the nav bar -- Back top-left, and once staged an Apply (Review) top-right.
  const updateBar = () => {
    const n = stagedCount();
    const acts = [];
    if (n) {
      acts.push({ key: '2', keyLabel: 'F2', kind: 'navAction',
        label: `Apply (${n})`, fn: () => treeReview(built, state, label) });
      acts.push({ key: '3', keyLabel: 'F3', label: 'Discard',
        fn: () => { for (const s of state.values()) s.staged = null; draw(); } });
    }
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: reopen });
    setActions(acts);
    sbLeft.textContent = `${dispChassis(chassisId)} · ${m.label}`
      + `${n ? ` · ${n} staged` : ''}`;
  };

  draw();
}

// A value NAME that is a bare number (or wert_NN) is not a real setting name
// -- it is a numeric field's raw byte from another variant, not an enum label.
function treeIsNumericName(n) {
  return typeof n === 'number'
    || /^-?\d+$/.test(String(n)) || /^wert_\d+$/i.test(String(n));
}

// The pickable options of a function: [[name, hexValue], ...] excluding
// buffers. Two shapes qualify: real setting names (aktiv/nicht_aktiv/
// automatik...), and NUMERIC fields whose variants disagree -- EWS's
// ABSCHALTDREHZAHL_ANLASSER ships 0a/0e/0b across engine fits, and those
// bytes ARE the choice BMW's tool offers, so they render as picks labelled
// by their decimal value (the names in the DATEN blob are meaningless line
// ids there). Empty when the function is not a choice at all -- including
// named options that all collapse to ONE byte (E46 EWS codes gasoline and
// diesel cut-off time identically: nothing to pick, so no buttons to show).
// Entries are [label, hexValue, final] -- `final` marks a label that is
// already display text (a decimal, or a merged "12 · Alpina") that must NOT
// go through the keyword translator.
function treeOptions(vals) {
  if (!vals.length) return [];
  if (vals.some(([, v]) => typeof v === 'string' && v.length > 4)) return [];
  const anyNumeric = vals.some(([n]) => treeIsNumericName(n));

  // ONE DATEN ROW, ONE OPTION. BMW's PARZUWEISUNG_PSW1 rows ARE the choices
  // the tool offers, and several legitimately share a byte:
  // ABSCHALTDREHZAHL_ANLASSER lists 4/6/8/12-cylinder gasoline all at 0x0A,
  // because the engine variant is what the installer picks -- the byte just
  // happens to be equal. NCS-Expert lists all nine; so do we.
  //
  // We used to dedupe by hex and merge the names into one chip
  // ("4_zylinder_benziner / 6_zylinder_benziner / ..."), which collapsed
  // nine real choices into three and read as data loss. Values that share a
  // byte stay separate rows; picking any of them stages the same byte, which
  // is correct and is what the ECU sees either way.
  const named = vals.filter(([n]) => !treeIsNumericName(n));

  // A purely numeric field (every "name" is an unresolved id) has no labels
  // to show, so it collapses to its distinct VALUES -- there is nothing to
  // tell two rows apart but the byte.
  if (!named.length) {
    const seen = new Map();
    for (const [, v] of vals) seen.set(String(v).toLowerCase(), true);
    if (seen.size < 2) return [];
    return [...seen.keys()]
      .map(v => [String(parseInt(v, 16)), v, true])
      .sort((a, b) => parseInt(a[1], 16) - parseInt(b[1], 16));
  }

  // Mixed (some rows named, some bare ids): keep the named rows as labelled
  // options and fold the anonymous ids into whichever value they name, so a
  // bare id never renders as a chip of its own next to a real label.
  const out = [];
  const emitted = new Set();
  for (const [n, v] of vals) {
    const key = String(v).toLowerCase();
    if (treeIsNumericName(n)) {
      // only surface an id-only value when NO named row shares that byte
      if (named.some(([, nv]) => String(nv).toLowerCase() === key)) continue;
      if (emitted.has('#' + key)) continue;
      emitted.add('#' + key);
      out.push([String(parseInt(key, 16)), key, true]);
      continue;
    }
    const dedupe = n + '\u0000' + key;         // identical row twice: once
    if (emitted.has(dedupe)) continue;
    emitted.add(dedupe);
    out.push([String(n), key]);                 // label(): keeps translation
  }
  if (out.length < 2) return [];
  if (anyNumeric) out.sort((a, b) => parseInt(a[1], 16) - parseInt(b[1], 16));
  return out;
}

// Pair a DATEN function to its value in a module's coding read. The read names
// results differently (COD_* / STAT_*), so match on shared tokens, then reduce
// the answer to one of the function's known option hex values. Returns the
// matched hex value string, or null.
function treeMatchRead(kw, opts, read) {
  const num = typeof codMatchRead === 'function' ? codMatchRead(kw, read) : null;
  if (num == null) return null;
  const hex = num.toString(16).padStart(2, '0');
  // only accept if it is actually one of this function's options
  return opts.some(([, v]) => String(v).toLowerCase() === hex) ? hex : null;
}

// Render a function's value list as DATEN means it. A real multiple-choice with
// a read current renders as SELECTABLE chips (current marked, picking another
// Render one coded byte as its DATEN unit says: 'd' decimal, 'a'/'A' the
// ASCII character it stands for, 'b' binary, else hex. The raw 0x byte rides
// along as a tooltip so it can still be cross-checked against another tool.
// Ops-carrying (DIR "property") fields keep the raw byte -- the transform
// needs the full field value, not a per-byte gloss, so we don't fake it.
function treeFmt(hex, f) {
  const raw = '0x' + hex;
  const u = f && f.unit;
  if (!u || u === 'h' || (f && f.ops && f.ops.length)) return { text: raw, tip: '' };
  const n = parseInt(hex, 16);
  if (u === 'd') return { text: String(n), tip: raw };
  if (u === 'b') return { text: n.toString(2).padStart(hex.length * 4, '0'), tip: raw };
  if (u === 'a' || u === 'A') {
    const ch = (n >= 0x20 && n < 0x7f) ? String.fromCharCode(n) : '.';
    return { text: `'${ch}'`, tip: raw };
  }
  return { text: raw, tip: '' };
}

// stages it); otherwise static reference (numeric field, default, or buffer).
function treeValues(vals, label, fkey, state, f) {
  if (!vals.length) return '<span class="ink-faint">—</span>';
  let opts = treeOptions(vals);
  const numeric = treeNumericField(vals);
  // a single-value numeric field is still choosable in expert mode: its one
  // shipped default renders as a chip, and the ✎ chip takes any hand-typed
  // byte -- full access, same staging as everything else
  if (!opts.length && numeric && state && state.has(fkey)) {
    opts = [...new Set(vals.map(([, v]) => String(v).toLowerCase()))]
      .map(v => [String(parseInt(v, 16)), v, true]);
  }
  if (opts.length && state && state.has(fkey)) {
    const s = state.get(fkey);                 // {current, staged}
    const sel = s.staged != null ? s.staged : s.current;
    // a hand-typed value isn't among the shipped chips: show it as one
    if (numeric && sel
        && !opts.some(([, v]) => v.toLowerCase() === String(sel).toLowerCase())) {
      opts = [...opts, [String(parseInt(sel, 16)), String(sel).toLowerCase(), true]]
        .sort((a, b) => parseInt(a[1], 16) - parseInt(b[1], 16));
    }
    // DIR "property" fields (VIN, date, keys) are computed/read-only -- no
    // free-entry chip; a raw hand-typed byte would bypass their transform
    const edit = numeric && f && !f.dir
      ? `<button class="tree-opt tree-opt-editbtn" data-edit="1" type="button"
           data-max="${String(vals[0][1]).length > 2 ? 65535 : ((f.mask || 255) >> (f.shift || 0))}"
           data-w="${String(vals[0][1]).length}"
           title="Stage any value (expert)">✎ set…</button>`
      : '';
    // FIRST MATCH WINS. Several options can share a byte -- 4/6/8/12-cylinder
    // gasoline are all 0x0A -- and the ECU only ever tells us the byte, never
    // which of them the installer meant. Marking every match lit four chips
    // "current" at once, which reads as a bug. NCS-Expert resolves it the
    // same way (decodeCurrentPsw returns the FIRST parameter whose bytes
    // match), so the first option in BMW's file order carries the marker and
    // the rest stay pickable.
    const lc = (x) => String(x == null ? '' : x).toLowerCase();
    const firstAt = (want) => {
      const w = lc(want);
      if (!w) return -1;
      return opts.findIndex(([, v]) => lc(v) === w);
    };
    const selIdx = firstAt(sel);
    const curIdx = firstAt(s.current);

    return `<div class="tree-opts" data-fkey="${esc(fkey)}">`
      + opts.map(([n, v, final], oi) => {
        const on = oi === selIdx;
        const isCur = oi === curIdx;
        // a numeric chip shows its unit-formatted value; a named option keeps
        // its label. The mono suffix is the raw byte either way.
        const { text, tip } = numeric ? treeFmt(v, f) : { text: '0x' + v, tip: '' };
        const nm = final ? n : (numeric ? text : label(n));
        return `<button class="tree-opt${on ? ' sel' : ''}" `
          + `data-v="${esc(v)}" type="button">`
          + `<span class="tree-opt-n">${esc(nm)}</span>`
          + `<span class="tree-opt-v mono"${tip ? ` title="${tip}"` : ''}>`
          + `0x${esc(v)}</span>`
          + `${isCur ? '<span class="tree-opt-cur">current</span>' : ''}`
          + `</button>`;
      }).join('') + edit + `</div>`;
  }
  // ---- static reference (numeric / default / buffer / unread) ----
  const long = vals.filter(([, v]) => typeof v === 'string' && v.length > 4);
  if (long.length === vals.length && vals.length > 1) {
    const bytes = String(vals[0][1]).length / 2;
    return `<span class="tree-val" title="${esc(
      vals.map(([n, v]) => `${n}: ${v}`).join('\n'))}">`
      + `<span class="tree-val-n">${vals.length} variants</span>`
      + `<span class="tree-val-v mono">${bytes} bytes each</span></span>`;
  }
  if (vals.every(([n]) => treeIsNumericName(n))) {
    // numeric quantities read in their DATEN unit -- decimal by default (an
    // RPM threshold is 10, not 0x0a), the character for an ASCII field, the
    // raw byte for hex. A DIR property field (VIN/date/key) is read-only.
    const uniq = [...new Set(vals.map(([, v]) => String(v)))]
      .sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
    const tag = (f && f.dir) ? 'property'
      : uniq.length === 1 ? 'default' : 'value';
    return `<span class="tree-val"><span class="tree-val-n">${tag}</span>`
      + uniq.map(v => {
        const { text, tip } = treeFmt(v, f);
        return `<span class="tree-val-v mono"${tip ? ` title="${tip}"` : ''}>`
          + `${esc(text)}</span>`;
      }).join('')
      + `</span>`;
  }
  // named options that all hold the SAME byte are one fact, not a choice --
  // two chips read as broken buttons (E46 EWS: gasoline and diesel cut-off
  // time both 0x01), so fold the names into a single reference chip
  const uniqV = [...new Set(vals.map(([, v]) => String(v).toLowerCase()))];
  if (uniqV.length === 1 && vals.length > 1 && String(vals[0][1]).length <= 4) {
    return `<span class="tree-val">`
      + `<span class="tree-val-n">${esc(vals.map(([n]) => label(n)).join(' / '))}</span>`
      + `<span class="tree-val-v mono">0x${esc(vals[0][1])}</span></span>`;
  }
  return vals.map(([n, v]) => {
    const big = typeof v === 'string' && v.length > 4;
    return `<span class="tree-val"${big ? ` title="${esc(v)}"` : ''}>`
      + `<span class="tree-val-n">${esc(label(n))}</span>`
      + `<span class="tree-val-v mono">`
      + `${big ? `${String(v).length / 2} bytes` : '0x' + esc(v)}</span></span>`;
  }).join('');
}

// DESKTOP: one searchable nested tree, Module > Function > Values, expand in
// place. Data is BMW's DATEN description (datenFor); a filter narrows across
// every level.
async function expertTree(chassisId, mods, cont, back, scan, reScan, showAll) {
  cont.className = 'coding-panel coding-tree-wrap';
  cont.innerHTML = `
    <div class="tree-bar">
      <input class="wiring-search tree-filter" id="tree-filter" type="search"
             placeholder="Filter modules and functions…" autocomplete="off">
    </div>
    <div class="coding-tree" id="coding-tree"></div>`;
  const treeEl = cont.querySelector('#coding-tree');
  const filterEl = cont.querySelector('#tree-filter');

  // Extract SA codes from ZCS for FA/ZCS filtering
  const saCodes = extractSaCodesFromScan(scan);
  // ...and drop modules this car's equipment codes say it does not carry.
  const shown = showAll
    ? mods
    : await filterModulesByFa(chassisId, mods, saCodes);
  const hidden = mods.length - shown.length;

  // pull each module's DATEN functions (chassis variant union) once; skip
  // modules with no functions -- a 0-function row is a dead expand.
  const built = [];
  for (const m of shown) {
    const fns = await moduleFunctions(chassisId, m.sgbd,
      codingIndexFromScan(scan, m.sgbd), saCodes);
    if (fns.length) built.push({ ...m, fns, chassisId });
  }

  // Never filter silently: say what the car's equipment codes hid, and offer
  // the way back. A module missing with no explanation reads as a bug.
  if (hidden > 0) {
    const note = document.createElement('div');
    note.className = 'cod-fa-note';
    note.innerHTML = `${hidden} module${hidden === 1 ? '' : 's'} hidden — `
      + `this car's equipment codes say it doesn't have `
      + `${hidden === 1 ? 'it' : 'them'}. `
      + `<button class="linklike" id="fa-show-all">Show all</button>`;
    cont.querySelector('.tree-bar').insertAdjacentElement('afterend', note);
    note.querySelector('#fa-show-all').onclick = () =>
      expertTree(chassisId, mods, cont, back, scan, reScan, true);
  }

  const label = (name) => (typeof datLabel === 'function'
    ? datLabel(name) : name);

  // Per-function state: fkey "sgbd:name" -> {current, staged}, seeded from the
  // scan (seedState), so a function shows the same current + options everywhere.
  const state = new Map();
  const fkeyOf = (sgbd, name) => `${sgbd}:${name}`;
  for (const m of built) {
    seedState(state, m.sgbd, m.fns, scan && scan.get(m.sgbd));
  }

  // which modules/functions are expanded, preserved across redraws
  const openMods = new Set();
  const openFns = new Set();
  const stagedCount = () =>
    [...state.values()].filter(s => s.staged != null).length;

  const draw = () => {
    const q = filterEl.value.trim().toLowerCase();
    treeEl.innerHTML = '';
    for (const m of built) {
      const fns = q
        ? m.fns.filter(f => f.name.toLowerCase().includes(q)
            || label(f.name).toLowerCase().includes(q))
        : m.fns;
      const moduleMatches = !q || m.label.toLowerCase().includes(q)
        || m.sgbd.toLowerCase().includes(q);
      if (!fns.length && !moduleMatches) continue;

      const node = document.createElement('details');
      node.className = 'tree-mod';
      node.dataset.sgbd = m.sgbd;
      // keep whatever was open across a redraw; a filter also expands hits
      if (q || openMods.has(m.sgbd)) node.open = true;
      node.ontoggle = () => node.open ? openMods.add(m.sgbd) : openMods.delete(m.sgbd);
      const shownFns = fns.length ? fns : m.fns;
      node.innerHTML = `<summary class="tree-mod-h">`
        + `<span class="tree-name">${esc(m.label)}</span>`
        + `<span class="tree-meta mono">${esc(m.sgbd)}.prg · `
        + `${shownFns.length} function${shownFns.length === 1 ? '' : 's'}</span>`
        + `</summary>`;
      const body = document.createElement('div');
      body.className = 'tree-fns';
      // cap very large modules for performance; a filter reveals the rest
      const cap = q ? shownFns.length : Math.min(shownFns.length, 400);
      let lastBlock = null;   // emit a group header when the block changes
      for (let i = 0; i < cap; i++) {
        const f = shownFns[i];
        // BMW names each coding block ("Grundkonfiguration_ALC-SG"). Heading
        // the run of fields with it turns a flat list of 83 into the labelled
        // sections NCS-Expert shows. Fields arrive grouped by address, so a
        // simple change-detect is enough -- no re-sorting, which would break
        // the address order the rest of the screen relies on.
        if (f.block !== lastBlock) {
          lastBlock = f.block;
          const bn = blockName(m.sgbd, f.block);
          if (bn) {
            const h = document.createElement('div');
            h.className = 'tree-blk-h';
            h.innerHTML = `<span class="tree-blk-key mono">CODING</span>`
              + `<span class="tree-blk-name">${esc(bn.name)}</span>`
              + (bn.en ? `<span class="tree-blk-en">${esc(bn.en)}</span>` : '');
            body.appendChild(h);
          }
        }
        const fkey = fkeyOf(m.sgbd, f.name);
        const valsHtml = treeValues(f.values || [], label, fkey, state, f);
        const fl = document.createElement('details');
        fl.className = 'tree-fn';
        fl.dataset.fkey = fkey;
        if (openFns.has(fkey)) fl.open = true;
        fl.ontoggle = () => fl.open ? openFns.add(fkey) : openFns.delete(fkey);
        fl.innerHTML = `<summary class="tree-fn-h">`
          + `<span class="tree-name">${esc(label(f.name))}`
          + `${state.has(fkey) && state.get(fkey).staged != null
              ? '<span class="tree-staged-dot"></span>' : ''}</span>`
          + `<span class="tree-key mono">len ${f.byte} · `
          + `mask 0x${f.mask.toString(16).padStart(2, '0')}</span></summary>`
          + `<div class="tree-vals">${valsHtml}</div>`;
        body.appendChild(fl);
      }
      if (cap < shownFns.length) {
        const more = document.createElement('div');
        more.className = 'tree-more';
        more.textContent = `${shownFns.length - cap} more — filter to narrow`;
        body.appendChild(more);
      }
      node.appendChild(body);
      treeEl.appendChild(node);
    }
    if (!treeEl.children.length) {
      treeEl.innerHTML = `<div class="empty"><div>Nothing matches `
        + `“${esc(filterEl.value)}”.</div></div>`;
    }
    updateBar();
  };

  // pick a value option: stage it (values were read up front by the scan)
  treeEl.addEventListener('click', (e) => {
    const opt = e.target.closest('.tree-opt');
    if (opt) {
      const wrap = opt.closest('.tree-opts');
      const fkey = wrap && wrap.dataset.fkey;
      const s = fkey && state.get(fkey);
      if (!s) return;
      if (opt.dataset.edit != null) { treeEditPrompt(opt, s, draw); return; }
      const v = opt.dataset.v;
      s.staged = (String(v).toLowerCase()
        === String(s.current).toLowerCase()) ? null : v;
      draw();
    }
  });

  filterEl.oninput = () => {
    const at = filterEl.selectionStart;
    draw();
    const again = cont.querySelector('#tree-filter');
    if (again) { again.focus(); again.setSelectionRange(at, at); }
  };

  // the softkey bar reflects the staged count: Review / Discard appear once
  // something is changed, the same shape the coding editor keeps.
  const updateBar = () => {
    const n = stagedCount();
    const acts = [];
    if (reScan) acts.push({ key: '1', keyLabel: 'F1', kind: 'navAction',
      label: 'Re-read', fn: reScan });
    if (n) {
      acts.push({ key: '2', keyLabel: 'F2', label: `Review (${n})`,
        fn: () => treeReview(built, state, label) });
      acts.push({ key: '3', keyLabel: 'F3', label: 'Discard',
        fn: () => { for (const s of state.values()) s.staged = null; draw(); } });
    }
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: back });
    setActions(acts);
    sbLeft.textContent = `${dispChassis(chassisId)} · coding`
      + `${n ? ` · ${n} staged` : ''}`;
  };

  draw();
}

// The staged-changes review for the Expert tree, sharing the curated review's
// readable row + demo-aware footer.
async function treeReview(built, state, label) {
  // Gather staged changes per module: sgbd -> [{rule, value}]
  const byMod = new Map();
  for (const m of built) {
    for (const f of m.fns) {
      const s = state.get(`${m.sgbd}:${f.name}`);
      if (!s || s.staged == null) continue;
      if (!byMod.has(m.sgbd)) byMod.set(m.sgbd, []);
      byMod.get(m.sgbd).push({ rule: f, value: parseInt(s.staged, 16) });
    }
  }

  // Build review rows for the dialog
  const rows = [];
  for (const m of built) {
    for (const f of m.fns) {
      const s = state.get(`${m.sgbd}:${f.name}`);
      if (!s || s.staged == null) continue;
      rows.push(codingReviewRow(label(f.name), `${m.sgbd}.prg · ${f.name}`,
        `0x${s.current}`, `0x${s.staged}`));
    }
  }

  const demo = typeof demoMode === 'function' && demoMode();
  const foot = demo
    ? `<b>Demo mode.</b> No car is connected, so "Write" only simulates the `
      + `coding write — nothing leaves the app and no ECU is touched.`
    : `<b>Ready to write.</b> This will send the changes to the car's ECUs. `
      + `Each module is written, then re-read to verify the write succeeded.`;

  const ok = await confirmDialog({
    title: 'Review coding changes',
    body: `<div class="cod-rev-list">${rows.join('')}</div>`
      + `<div class="cod-rev-foot">${foot}</div>`,
    confirmLabel: demo ? 'Write (demo)' : 'Write to car',
    cancelLabel: 'Cancel',
    danger: !demo,
  });

  if (!ok) return;

  // Execute writes per module
  const results = [];
  for (const [sgbd, edits] of byMod.entries()) {
    const mod = built.find(m => m.sgbd === sgbd);
    if (!mod) continue;

    try {
      // The union view is a reference, not a write target -- refuse before
      // anything touches the wire.
      assertResolvedForWrite(sgbd, mod.fns, mod);

      // Read current netto
      const entry = typeof codingFor === 'function' ? await codingFor(sgbd) : null;
      if (!entry || !entry.read) {
        results.push({ sgbd, ok: false, err: 'No read job defined' });
        continue;
      }

      const readRes = await api(`/api/ecu/${sgbd}/run/${entry.read}`, { method: 'POST' });
      const flatRes = new Map(flatResults(readRes.sets));
      const nettoHex = flatRes.get('COD_WERT_NETTO') || flatRes.get('CODIER_WERT_NETTO');
      if (!nettoHex) {
        results.push({ sgbd, ok: false, err: 'Read did not return netto' });
        continue;
      }

      // Build the new netto by splicing edits onto the read image
      const netto = [];
      const hex = String(nettoHex).replace(/^0x/i, '').replace(/\s/g, '');
      for (let i = 0; i + 1 < hex.length; i += 2) {
        netto.push(parseInt(hex.substr(i, 2), 16));
      }

      const CodingEncode = typeof window !== 'undefined' && window.CodingEncode
        ? window.CodingEncode
        : require('../../core/coding-encode.js');
      const modified = CodingEncode.spliceEdits(new Uint8Array(netto), edits);
      const modHex = Array.from(modified, b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');

      // Write via webWriteCoding
      if (typeof webWriteCoding !== 'function') {
        results.push({ sgbd, ok: false, err: 'webWriteCoding not available' });
        continue;
      }

      // BACKUP BEFORE TRANSMIT. nettoHex is what the ECU holds right now;
      // once the write lands it is unrecoverable. Persist it here, while it
      // still exists. A failure to store is reported, never fatal.
      const backup = (typeof saveCodingBackup === 'function')
        ? saveCodingBackup(sgbd, nettoHex, {
            chassis: mod.chassisId || null,
            ci: mod.fns ? mod.fns.codingIndex : null,
            note: 'pre-write (coding)',
          })
        : null;

      await webWriteCoding(sgbd, modHex, { confirmed: true });
      results.push({ sgbd, ok: true, backup: !!backup });

      // Update state: staged becomes current
      for (const f of mod.fns) {
        const s = state.get(`${sgbd}:${f.name}`);
        if (s && s.staged != null) {
          s.current = s.staged;
          s.staged = null;
        }
      }

    } catch (err) {
      results.push({ sgbd, ok: false, err: String(err.message || err) });
    }
  }

  // Show results
  const allOk = results.every(r => r.ok);
  const body = results.map(r => {
    const icon = r.ok ? '✓' : '✗';
    const msg = r.ok
      ? (r.backup ? 'Written and verified (previous coding backed up)'
                  : 'Written and verified — NO BACKUP SAVED')
      : `Failed: ${r.err}`;
    return `<div class="cod-result-row">`
      + `<span class="cod-result-icon ${r.ok ? 'ok' : 'err'}">${icon}</span>`
      + `<span class="cod-result-sgbd mono">${esc(r.sgbd)}.prg</span>`
      + `<span class="cod-result-msg">${esc(msg)}</span></div>`;
  }).join('');

  await confirmDialog({
    title: allOk ? 'Coding written' : 'Write completed with errors',
    body: `<div class="cod-result-list">${body}</div>`,
    confirmLabel: 'OK',
    cancelLabel: null,
  });
}

if (typeof window !== 'undefined') {
  window.showCodingHub = showCodingHub;
  window.chassisHasCoding = chassisHasCoding;
  window.codeableModules = codeableModules;
}
