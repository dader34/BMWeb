// whole-vehicle sweep engine (INPA "Functional Jobs"), for ANY chassis.
//
// quickErrorSweep reads fault memory on every module; quickIdentSweep reads
// identification. Both walk the SAME plan, built by sweepPlan() below, so a
// module that is skipped as absent by one is skipped by the other for the
// same reason.
//
// THE UNIT OF SCAN IS THE DIAGNOSTIC-ADDRESS GROUP, NOT THE CONFIG ROW.
// That is BMW's own model and the whole reason this file has no tables in it.
// A chassis config lists every variant BMW ever fitted at an address -- E46
// Engine lists twelve, of which exactly one is in the car. The group SGBD
// (D_0012, D_MOTOR, ...) is the thing that knows which: running its
// IDENTIFIKATION probes the address and reports VARIANTE, the concrete SGBD
// name. So one probe per group answers "is anything here, and what is it",
// and the read then targets what answered.
//
// What this replaces (2026-08-21): a hand-written VARIANT_GROUPS table that
// covered E46 and E36 only, a chassis-config `variantGroups` array that was
// derived by a weaker unvalidated rule, and a nav gate that hid Functional
// Jobs entirely on every other car. All three are gone. The per-ECU `group`
// field written by tools/export/inpa_config.py (Resolver.group_file_for) is
// the formula now, and it is validated at generation time against what the
// group can actually identify -- T_GRTB (BMW's own variant->group table)
// first, then .IPO tokens accepted only when the group's own string pool
// names the resolved SGBD. Every group named by every shipped chassis config
// is present in data/groups (26/26 chassis, 188 distinct groups, 0 missing),
// so the strict path is available on every car, not two.
//
// fillFaultDetail lives in autoscan.js; exportFaultPdf in fault-report.js.

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

// Build the scan plan for a chassis: a list of TARGETS, each of which is one
// bus address to probe once.
//
//   grouped target  -- ecus sharing a `group`. Probed by the group's
//                      IDENTIFIKATION; that answer names the variant to read.
//   ungrouped target -- one ecu whose config row carries no group (the
//                      generator's five-step ladder found nothing that could
//                      identify it). Read directly, and SAID to be read
//                      directly, because there is no presence test for it.
//
// Order is chassis-config order (INPA's own menu order, engine section first)
// and the first row of a group fixes that group's position, so the display
// reads like the car rather than like a hash map.
//
// Dedup is by sgbd within a group and by sgbd globally for ungrouped rows:
// the same module listed in two sections is one module.
function sweepPlan(ch) {
  const targets = [];
  // the car's own names for variants the menu does not list (see nameFor)
  const variantNames = new Map();
  for (const v of (ch.variants || [])) {
    if (v && v.sgbd && v.label) variantNames.set(String(v.sgbd).toLowerCase(), v);
  }
  const byGroup = new Map();
  const seenSolo = new Set();
  for (const sec of (ch.sections || [])) {
    for (const ecu of (sec.ecus || [])) {
      const g = String(ecu.group || '').toLowerCase();
      if (g) {
        let t = byGroup.get(g);
        if (!t) {
          t = { group: g, section: sec.name, ecus: [], label: ecu.label, variantNames };
          byGroup.set(g, t);
          targets.push(t);
        }
        // every candidate variant at this address, so the identified name has
        // a config row to take its label and INPA code from
        if (!t.ecus.some(e => sameSgbd(e.sgbd, ecu.sgbd))) t.ecus.push(ecu);
      } else {
        const key = String(ecu.sgbd || '').toLowerCase();
        if (!key || seenSolo.has(key)) continue;
        seenSolo.add(key);
        targets.push({ group: null, section: sec.name, ecus: [ecu], label: ecu.label, variantNames });
      }
    }
  }
  return targets;
}

const sameSgbd = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// A target's display name. A group is a bus address with several possible
// occupants, so before it answers there is no one right name: use the first
// configured row's label (config order = INPA menu order, so this is the name
// INPA shows too) and let resolution replace it with the real one.
const targetLabel = (t) => t.label || (t.ecus[0] && t.ecus[0].label) || t.group || '?';

// Which config row does an identified variant correspond to? The ident names
// an SGBD; match it against each candidate's own sgbd and its declared
// `variants` aliases.
//
// NO MATCH RETURNS NULL, NOT ecus[0]. A group's rows are the variants the
// MENU lists, and an ident can legitimately name one the menu never had --
// E46's D_MOTOR probes the broadcast address FF, so on an MS45 car it
// answers ms450ds0 while its only rows are d50m47b1 and ME9N45. Falling back
// to the first row labelled that car's engine "DDE 5.0 for M47 new" and
// showed its faults under a diesel it does not have. When nothing matches,
// the identified SGBD name IS the honest label.
// The name to print for what answered. A matching config row wins. With no
// match, the ADDRESS still tells us what the module is when every row on it
// carries the same name -- the config disambiguates same-name rows with a
// "(variant)" suffix ("GS20/GS8.xx for GM or ZF (gs855)", "... (smg)"), so
// strip that and compare. One name across the rows -> that is the module
// (Airbag, Sunroof module, Instrument cluster) whichever variant identified.
// Different names (the engine address mixes "DDE 4.0 for M57" with "ME9.2
// for N42/N45") -> the identified SGBD stays the honest label.
const baseLabel = (label, sgbd) => {
  // only the suffix that names the row's OWN sgbd is a variant tag, and the
  // config writes those lowercase, as the sgbd is: "(gs855)". An uppercase
  // abbreviation that happens to equal the sgbd -- "Electronic vehicle
  // immobilization (EWS)" on ews -- is part of the name and stays.
  const l = String(label || '').trim();
  const m = /^(.*?)\s*\(([^)]+)\)$/.exec(l);
  return m && m[2] === String(sgbd || '') ? m[1].trim() : l;
};
function familyLabel(t) {
  const names = new Set((t.ecus || []).map(e => baseLabel(e.label, e.sgbd)).filter(Boolean));
  return names.size === 1 ? [...names][0] : null;
}
// The identified variant's OWN record. The menu lists three transmissions
// for an E46, but the build ships a record for every variant the address
// can answer with -- gs20's says "GS20/GS8.xx for GM or ZF (gs20)".
const variantLabels = new Map();
async function variantLabel(sgbd) {
  const key = String(sgbd || '').toLowerCase();
  if (!key) return null;
  if (!variantLabels.has(key)) {
    variantLabels.set(key, api(`/api/ecu/${key}/ecu`)
      .then(info => (info && info.label) ? baseLabel(info.label, key) : null)
      .catch(() => null));
  }
  return variantLabels.get(key);
}
async function nameFor(t, r) {
  if (r.ecu && r.ecu.label) return r.ecu.label;
  // this car's own record for the variant (chassis config `variants`)
  const own = t.variantNames && t.variantNames.get(String(r.sgbd || '').toLowerCase());
  if (own) return baseLabel(own.label, own.sgbd);
  return (await variantLabel(r.sgbd)) || familyLabel(t) || r.sgbd;
}

function rowForVariant(t, via) {
  return t.ecus.find(e => sameSgbd(e.sgbd, via)
      || (e.variants || []).some(v => sameSgbd(v, via)))
    || null;
}

// ---------------------------------------------------------------------------
// probing one target
// ---------------------------------------------------------------------------

// The shipped-groups index gates the strict path: a group whose bytecode this
// build ships can be run, and running it IS the presence test. One fetch per
// session, shared by both sweeps (ecu.js and autoscan.js keep their own for
// the same reason -- it is a small static file and the browser caches it).
let _groupIndexP = null;
const groupIndex = () => (_groupIndexP ??= fetch('data/groups/index.json')
  .then(r => (r.ok ? r.json() : null)).catch(() => null));
async function groupRunnable(g) {
  if (!g || typeof webResolveVariant !== 'function') return false;
  const idx = await groupIndex();
  return !!(idx && (idx.groups || []).includes(g));
}

// group -> variant, once per sweep run. webResolveVariant caches successful
// resolutions per session underneath (and drops them on disconnect), so this
// layer only stops a single run from re-probing when two sections list the
// same group.
function variantResolver() {
  const cache = new Map();
  return async (g) => {
    if (!cache.has(g)) {
      let v = null;
      try { v = await webResolveVariant(g); } catch { v = null; }
      cache.set(g, v);
    }
    return cache.get(g);
  };
}

// The job names one SGBD declares.
//
// /api/ecu/<s>/jobs has TWO shapes, because two exporters write it:
// web_export.py writes `sorted(jobs.keys())` (a string array) and
// sgbd_export.py writes the lifted spec object `{jobs:[{name,...}]}`. Reading
// only one of them silently sees zero jobs on every module the other exported
// -- which here would report a present module as "not in build". This is the
// same normalisation viJobs (vehicle-identity.js) and tool32.js already do.
//
// Cached per SGBD for the session: this is a fact about the BUILD (which job
// code was exported), not about the car, so it cannot go stale on reconnect.
const _jobNames = new Map();
function jobNamesFor(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (!_jobNames.has(key)) {
    _jobNames.set(key, api(`/api/ecu/${key}/jobs`).then((j) => {
      const list = Array.isArray(j) ? j : (j && j.jobs) || [];
      return list.map(x => (typeof x === 'string' ? x : x && x.name))
        .filter(Boolean);
    }).catch(() => []));
  }
  return _jobNames.get(key);
}

// Can this build actually run jobs on this SGBD? The ident can name a variant
// whose job code was never exported ('xyz' is BMW's own catch-all, and exotic
// variants exist that no chassis config lists). Asking first is what lets the
// row say "identified but not in this build" instead of "no response", which
// are completely different facts about the car. Same test ecu.js uses before
// it retargets a screen.
const buildHasVariant = async (sgbd) => (await jobNamesFor(sgbd)).length > 0;

// Resolve one target to the SGBD to talk to.
//
// Returns one of:
//   { state:'ok',      sgbd, ecu, strict }  talk to sgbd
//   { state:'absent'                     }  nothing answered this address
//   { state:'unbuilt', via              }  module answered, build can't read it
//
// STRICT MEANS STRICT: when a group is runnable and stays silent, the module
// is absent and we do NOT fall back to reading a configured sibling. That
// fallback is the exact trap this design exists to close -- the E46 config
// maps Airbag to `zae` while many cars carry an MRS, and `zae` will happily
// answer an MRS and decode its reply as a confident "0 faults". A diagnostic
// tool reporting a clean airbag module that it never actually spoke to is the
// worst failure available to it, so silence is reported as silence.
async function resolveTarget(t, resolve) {
  if (await groupRunnable(t.group)) {
    const via = await resolve(t.group);
    if (!via) return { state: 'absent' };
    if (!await buildHasVariant(via)) return { state: 'unbuilt', via };
    return { state: 'ok', sgbd: via, ecu: rowForVariant(t, via), strict: true };
  }
  // No runnable group: the only thing left is the configured SGBD, read
  // directly. This is a weaker statement and the UI says so.
  const ecu = t.ecus[0];
  if (!ecu || !ecu.sgbd) return { state: 'absent' };
  return { state: 'ok', sgbd: ecu.sgbd, ecu, strict: false };
}

// ---------------------------------------------------------------------------
// wire helpers
// ---------------------------------------------------------------------------

// Read fault memory. FS_LESEN is the job every fault-capable SGBD declares;
// set 0 is the EDIABAS system summary, the rest are fault entries. This is
// the same call faults.js and live.js make -- the old `/api/ecu/<s>/read`
// endpoint here was a C#-server route that the web build never implemented,
// so it 404'd and every module in the sweep reported "no response".
async function readFaults(sgbd) {
  const d = await api(`/api/ecu/${sgbd}/run/FS_LESEN`, { method: 'POST' });
  return dataSets(d.sets).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
}

// A module answers "no faults" and a module that is not there both produce a
// short reply, so the difference has to come from the transport: api() throws
// on a wire failure and returns sets on an answer. `count` (the old field
// read here) never existed outside the C# server.
const isMissingJob = (e) =>
  /404|not found|no job|unknown sgbd|no job code|no static route/i.test(String((e && e.message) || e));

// stable fault signature for echo dedup. F_HEX_CODE is globally unique (BMW
// DTC); F_ORT_NR is only an ECU-local index, so fall back to it only when hex
// is absent.
// hexText: on web F_HEX_CODE is a byte Array, which would splice its own commas
// into a comma-joined signature and let two faults collide with one; '|' can't
// appear in dashed hex.
const _faultSig = (codes) =>
  (codes || []).map(c => hexText(c.F_HEX_CODE) || `nr:${c.F_ORT_NR}`).join('|');

// each sweep takes a token; navigating away or starting another bumps it, and
// the running loop bails on its next iteration -- stops hammering the K-line
// once the user leaves.
let _sweepToken = 0;
const cancelSweep = () => { _sweepToken++; };

// ---------------------------------------------------------------------------
// F4 -- Full Module Error Scan (INPA FSQUICK)
// ---------------------------------------------------------------------------

async function quickErrorSweep(chassisId) {
  const id = chassisId || 'E46';
  // scanning every module holds the bus; confirm before touching the K-line
  const ok = await confirmDialog({
    title: 'Scan all modules?',
    body: `Reads the fault memory of every module on the ${esc(dispChassis(id))}. `
        + 'Each module takes a few seconds to answer, so a full scan can take '
        + 'several minutes. You can leave the scan at any time with Esc.',
    confirmLabel: 'Start scan',
  });
  if (!ok) return;
  const token = ++_sweepToken;            // claim this run
  const alive = () => token === _sweepToken;
  const leave = () => { cancelSweep(); showSections(id); };
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id), fn: leave }, { label: 'Full Module Error Scan' }]);
  view.innerHTML = head('Whole vehicle', 'Full Module Error Scan', `Scanning every module on the ${dispChassis(id)} for stored faults…`);
  const out = document.createElement('div'); out.className = 'results-panel'; view.appendChild(out);
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: leave }]);
  loadFaultDb(); // warm the name db before detail rows render
  const ch = await tryApi(`/api/chassis/${id}`, null, out);
  if (!ch) return;
  const targets = sweepPlan(ch);
  const resolve = variantResolver();

  out.innerHTML = `<div class="quick-sweep">
    <div class="quick-bar">
      <div class="quick-head">${targets.length} modules · scanning…</div>
      <div class="quick-bar-btns">
        <button class="quick-pdf" id="quick-pdf" disabled>Export PDF</button>
        <button class="quick-clear-all" id="quick-clear-all" disabled>Clear all</button>
      </div>
    </div>
    <div class="quick-rows" id="quick-rows"></div></div>`;
  const rows = out.querySelector('#quick-rows');
  const headEl = out.querySelector('.quick-head');
  let withFaults = 0, read = 0, absent = 0, dupes = 0, unbuilt = 0;
  const seen = new Map();          // fault-signature -> first ECU label
  const faulty = [];               // modules with faults, for the deep pass
  // ONE PHYSICAL MODULE, ONE ROW. Several groups can reach the same ECU --
  // E46 lists both D_0012 (address 12) and D_MOTOR (broadcast FF), and on an
  // MS45 car BOTH identify ms450ds0. Reading it twice showed the same faults
  // under two names, one of them an engine the car does not have.
  const readSgbds = new Map();     // resolved sgbd -> the row that claimed it
  const progress = () => {
    headEl.textContent = `${read} read · ${absent} absent · ${withFaults} with faults`;
  };

  for (const t of targets) {
    if (!alive()) return;          // user left the sweep; stop reading the bus
    const row = addSweepRow(rows, targetLabel(t));
    const status = row.querySelector('.quick-status');

    let r;
    try { r = await resolveTarget(t, resolve); }
    catch { r = { state: 'absent' }; }

    if (r.state === 'absent') {
      absent++; row.classList.add('noresp');
      status.textContent = t.group ? 'not installed' : 'no response';
      progress(); continue;
    }
    if (r.state === 'unbuilt') {
      // The car answered and named itself; this build just has no job code
      // for that variant. Say exactly that -- reading a sibling instead is
      // what produces confident wrong answers.
      unbuilt++; row.classList.add('noresp');
      status.textContent = `${r.via} not in build`;
      progress(); continue;
    }

    const key = String(r.sgbd).toLowerCase();
    if (readSgbds.has(key)) {
      // another group already reached this exact module
      row.classList.add('noresp');
      setRowLabel(row, r.sgbd);
      status.textContent = `same module as ${readSgbds.get(key)}`;
      progress(); continue;
    }
    readSgbds.set(key, await nameFor(t, r));

    // resolution succeeded: name the row for what actually answered -- the
    // matching config row, else the address's one shared name, else the
    // identified SGBD; never a differently-named sibling (see nameFor).
    setRowLabel(row, await nameFor(t, r), r.strict ? null : 'direct read');

    // A module with no FS_LESEN keeps no fault memory at all -- CARB's whole
    // job list is INFO/INITIALISIERUNG/SET_PARAMETER/START_BUS_COMMUNICATION/
    // DIAGNOSTICEND, because it is the emissions interface, not a control
    // unit. There is no fault question to ask it, so it is not a row in a
    // FAULT scan: drop it rather than print a status that means "not asked".
    // Checked BEFORE the read so it costs no wire traffic.
    if (!(await jobNamesFor(r.sgbd)).includes('FS_LESEN')) {
      row.remove();
      continue;
    }

    let codes;
    try {
      codes = await readFaults(r.sgbd);
    } catch (e) {
      // The job exists but the wire failed: that is a dead address, and it
      // must never be confused with a module that answered clean.
      row.classList.add('noresp');
      absent++; status.textContent = 'no response';
      progress(); continue;
    }

    read++;
    const n = codes.length;
    if (n > 0) {
      const sig = _faultSig(codes);
      if (seen.has(sig)) {
        // the identical fault list from two addresses is one module answering
        // twice (a gateway echoing, a satellite mirrored onto its master)
        dupes++; row.classList.add('noresp');
        status.textContent = `echo of ${seen.get(sig)}`;
      } else {
        seen.set(sig, await nameFor(t, r));
        withFaults++; row.classList.add('has-faults');
        status.innerHTML = `<b>${n} fault${n === 1 ? '' : 's'}</b>`;
        faulty.push({ ecu: { ...(r.ecu || {}), sgbd: r.sgbd, label: await nameFor(t, r) }, row, codes });
      }
    } else {
      row.classList.add('clean');
      status.textContent = 'OK';
    }
    progress();
  }

  // deep pass: each faulty module gets a detailed read (FS_LESEN_DETAIL), shown
  // inline under its row.
  if (faulty.length) {
    await loadFaultDb(); // names resolve synchronously in the detail rows
    let done = 0;
    for (const f of faulty) {
      if (!alive()) return;        // user left mid deep-read; stop
      f.row.classList.add('scanning-detail');
      f.row.querySelector('.quick-status').innerHTML =
        `<b>${f.codes.length} fault${f.codes.length === 1 ? '' : 's'}</b> · reading…`;
      try { await fillFaultDetail(f.ecu.sgbd, f.codes); } catch { /* keep base codes */ }
      f.row.classList.remove('scanning-detail');
      setRowFaultStatus(f);
      appendFaultDetailRows(f.row, f.codes, f.ecu.sgbd);
      done++;
      headEl.textContent =
        `${read} read · ${absent} absent · ${withFaults} with faults · details ${done}/${faulty.length}`;
    }
  }

  // Clear all: clears every faulty module in turn
  const clearAllBtn = out.querySelector('#quick-clear-all');
  if (faulty.length) {
    clearAllBtn.disabled = false;
    clearAllBtn.onclick = async () => {
      const ok = await confirmDialog({
        title: 'Clear all fault memory?',
        body: `Erase stored faults on ${faulty.length} module${faulty.length === 1 ? '' : 's'}. This cannot be undone.`,
        confirmLabel: 'Clear all', danger: true,
      });
      if (!ok) return;
      clearAllBtn.disabled = true; clearAllBtn.textContent = 'Clearing…';
      for (const f of faulty) await clearModule(f);
      clearAllBtn.textContent = 'Cleared';
    };
  }

  // Fault report, available even with no faults. Native saves a PDF via the
  // Electron bridge; the web build prints a clean sheet via the shared helper.
  const stats = { scanned: read, skipped: absent + unbuilt, withFaults };
  const pdfBtn = out.querySelector('#quick-pdf');
  if (pdfBtn && window.bmacw && window.bmacw.savePdf) {
    pdfBtn.disabled = false;
    pdfBtn.onclick = () => exportFaultPdf(id, faulty, stats);
  } else if (pdfBtn) {
    pdfBtn.textContent = 'Print report';
    pdfBtn.disabled = false;
    pdfBtn.onclick = () => printFaultReport(id, faulty, stats);
    // register it as the screen's print action too: Cmd/Ctrl+P routes through
    // the current action list (core/print.js), and the mobile functions sheet
    // reads the same list -- without this, both print the live page instead
    setActions([
      { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: leave },
      { key: 'p', keyLabel: 'P', label: 'Print report', kind: 'print',
        fn: () => printFaultReport(id, faulty, stats) },
    ]);
  }

  const extra = [
    dupes ? `${dupes} echo${dupes === 1 ? '' : 'es'} hidden` : null,
    unbuilt ? `${unbuilt} not in build` : null,
  ].filter(Boolean);
  headEl.textContent = `Done · ${read} read, ${absent} absent · `
    + `${withFaults} with stored faults${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
  sbLeft.textContent = `full module error scan · ${withFaults} faulty`;
}

// ---------------------------------------------------------------------------
// F2 -- Identification (INPA IDQUICK)
// ---------------------------------------------------------------------------

// Identification fields, in the order INPA prints them. Every one of these is
// a real EDIABAS result name; the first present wins.
const IDENT_FIELDS = ['SG_VARIANTE', 'VARIANTE', 'AIF_SG_VARIANTE', 'ID_SG_VARIANTE',
                      'AIF_TYP', 'ID_TYP', 'HARDWARE_NUMMER', 'ID_HW_NR'];
// Build/version fields shown after the variant name, same rule.
const IDENT_BUILD = ['AIF_SW_NR', 'ID_SW_NR', 'SOFTWARE_NUMMER', 'AIF_DATEN_NR',
                     'ID_DATEN_NR', 'AIF_ZB_NR', 'ID_ZB_NR', 'BMW_NUMMER'];

const identValue = (sets, keys) => {
  for (const s of dataSets(sets)) {
    for (const k of keys) {
      const v = s[k];
      if (v != null && String(v).trim() && !String(v).startsWith('_')) return String(v).trim();
    }
  }
  return null;
};

// The ident job this SGBD actually declares. IDENT is the usual name and 84%
// of the shipped corpus has it, but 16% do not -- the F-series modules use
// IDENT_FUNKTIONAL, and others name it differently again. Asking the module
// what it declares is the formula; assuming IDENT is what made a present
// F01 module report "no response".
//
// INITIALISIERUNG is deliberately NOT a candidate even though every one of
// those modules declares it: bestvm's classifier reads it as a WRITE (it
// starts a session and can change module state), and an identification sweep
// must stay read-only end to end.
const IDENT_JOB_RE = /^(IDENT|IDENTIFIKATION)(_|$)/i;
// The corpus really does ship IDENT_SCHREIBEN, IDENT_VIN_SCHREIBEN,
// IDENT_PRODUCTION_DATA_SCHREIBEN and friends -- jobs that WRITE the module's
// identity. bestvm's isWriteJob() clears all of them, and correctly so for its
// own contract: a read token anywhere wins, and IDENT is a strong read token
// (that rule is what stops FS_LESEN_DETAIL being guarded). It is the wrong
// gate HERE, where the name is already known to start with IDENT, so the
// write verb has to be excluded explicitly. Getting this backwards would let
// an identification sweep write identity data to every module on the car.
const IDENT_WRITE_RE = /(SCHREIBEN|_SETZEN|_WRITE|PROGRAMMIER)/i;
const isIdentReadJob = (n) =>
  IDENT_JOB_RE.test(n) && !IDENT_WRITE_RE.test(n) && !isWriteJob(n);

async function identJobFor(sgbd) {
  const names = await jobNamesFor(sgbd);
  const cands = names.filter(isIdentReadJob);
  if (!cands.length) return null;
  // exact IDENT first, then the narrowest prefixed variant -- shortest name
  // wins, so IDENT_FUNKTIONAL is preferred over IDENT_READ_CURRENT_UIF_TABLE
  return cands.includes('IDENT') ? 'IDENT'
    : cands.slice().sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

async function quickIdentSweep(chassisId) {
  const id = chassisId || 'E46';
  const token = ++_sweepToken;
  const alive = () => token === _sweepToken;
  const leave = () => { cancelSweep(); showSections(id); };
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id), fn: leave }, { label: 'Identification' }]);
  view.innerHTML = head('Whole vehicle', 'Identification', `Identifying every module on the ${dispChassis(id)}…`);
  const out = document.createElement('div'); out.className = 'results-panel'; view.appendChild(out);
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: leave }]);
  const ch = await tryApi(`/api/chassis/${id}`, null, out);
  if (!ch) return;
  const targets = sweepPlan(ch);
  const resolve = variantResolver();

  out.innerHTML = `<div class="quick-sweep">
    <div class="quick-bar">
      <div class="quick-head">${targets.length} modules · identifying…</div>
      <div class="quick-bar-btns">
        <button class="quick-pdf" id="quick-print" disabled>Print</button>
      </div>
    </div>
    <div class="quick-rows" id="quick-rows"></div></div>`;
  const rows = out.querySelector('#quick-rows');
  const headEl = out.querySelector('.quick-head');
  let present = 0, absent = 0, unbuilt = 0, dupes = 0;
  const found = [];                // for the printable report
  const seenSgbds = new Map();     // resolved sgbd -> row that claimed it (see error sweep)
  const progress = () => { headEl.textContent = `${present} present · ${absent} absent`; };

  for (const t of targets) {
    if (!alive()) return;          // user left the sweep; stop reading the bus
    const row = addSweepRow(rows, targetLabel(t));
    const status = row.querySelector('.quick-status');

    let r;
    try { r = await resolveTarget(t, resolve); }
    catch { r = { state: 'absent' }; }

    if (r.state === 'absent') {
      absent++; row.classList.add('noresp');
      status.textContent = t.group ? 'not installed' : 'no response';
      progress(); continue;
    }
    if (r.state === 'unbuilt') {
      // Present and named, just not readable here. That IS an identification
      // -- the group told us the variant -- so count it as present and show
      // the name the car gave.
      unbuilt++; present++;
      row.classList.add('clean');
      setRowLabel(row, r.via);
      status.textContent = `${r.via} · not in build`;
      found.push({ label: r.via, section: t.section, sgbd: r.via, variant: r.via, build: null });
      progress(); continue;
    }

    const key = String(r.sgbd).toLowerCase();
    if (seenSgbds.has(key)) {
      dupes++; row.classList.add('noresp');
      setRowLabel(row, r.sgbd);
      status.textContent = `same module as ${seenSgbds.get(key)}`;
      progress(); continue;
    }
    seenSgbds.set(key, await nameFor(t, r));
    setRowLabel(row, await nameFor(t, r),
                r.strict ? null : 'direct read');

    // A strict resolution has ALREADY identified this module -- the group ran
    // IDENTIFIKATION and named the variant. Running a second ident job over
    // the wire to learn the same thing is pure traffic, so the job below only
    // fills in the build/version detail, and its absence is not a failure.
    let variant = r.strict ? r.sgbd.toUpperCase() : null;
    let build = null;
    try {
      const job = await identJobFor(r.sgbd);
      if (job) {
        const d = await api(`/api/ecu/${r.sgbd}/run/${job}`, { method: 'POST' });
        variant = identValue(d.sets, IDENT_FIELDS) || variant;
        build = identValue(d.sets, IDENT_BUILD);
      } else if (!r.strict) {
        // Ungrouped and no ident job to run: nothing here has spoken to the
        // car, so claiming it is present would be a guess. Report the gap.
        row.classList.add('noresp');
        status.textContent = 'no ident job';
        progress(); continue;
      }
    } catch (e) {
      if (!r.strict) {
        // Direct read, and the wire refused: the module is not answering.
        absent++; row.classList.add('noresp');
        status.textContent = isMissingJob(e) ? 'no ident job' : 'no response';
        progress(); continue;
      }
      // Strict path: the group already proved presence. A failed detail read
      // downgrades the row's detail, never its presence.
    }

    present++; row.classList.add('clean');
    status.textContent = [variant || r.sgbd, build].filter(Boolean).join(' · ').slice(0, 40);
    found.push({ label: await nameFor(t, r), section: t.section,
                 sgbd: r.sgbd, variant: variant || r.sgbd, build });
    progress();
  }

  const printBtn = out.querySelector('#quick-print');
  if (printBtn) {
    printBtn.disabled = false;
    printBtn.onclick = () => printIdentReport(id, found, { present, absent });
    setActions([
      { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: leave },
      { key: 'p', keyLabel: 'P', label: 'Print report', kind: 'print',
        fn: () => printIdentReport(id, found, { present, absent }) },
    ]);
  }

  headEl.textContent = `Done · ${present} present, ${absent} absent`
    + (unbuilt ? ` · ${unbuilt} not in build` : '')
    + (dupes ? ` · ${dupes} duplicate address${dupes === 1 ? '' : 'es'}` : '');
  sbLeft.textContent = `identification · ${present} present`;
}

// ---------------------------------------------------------------------------
// shared row + clear helpers
// ---------------------------------------------------------------------------

function addSweepRow(rows, label) {
  const row = document.createElement('div'); row.className = 'quick-row';
  row.innerHTML = `<span class="quick-ecu">${esc(label)}</span><span class="quick-status">scanning…</span>`;
  rows.appendChild(row);
  return row;
}

// Rename a row once resolution names the module that actually answered. The
// note is for the weaker path: an ungrouped row was read without a presence
// test, and the display should not look identical to one that had one.
function setRowLabel(row, label, note) {
  const el = row.querySelector('.quick-ecu');
  if (!el || !label) return;
  el.textContent = label;
  if (note) el.title = note;
}

// status cell for a faulty module: fault count plus a Clear button.
function setRowFaultStatus(f) {
  const n = f.codes.length;
  const st = f.row.querySelector('.quick-status');
  st.innerHTML = `<b>${n} fault${n === 1 ? '' : 's'}</b><button class="quick-clear" title="Clear ${esc(f.ecu.label)}">Clear</button>`;
  st.querySelector('.quick-clear').onclick = () => clearModule(f);
}

// erase one module's fault memory (FS_LOESCHEN): confirm, clear, then RE-READ
// to prove it -- "cleared" without evidence hides a live fault that re-enters
// the memory the moment the ECU sees it again.
async function clearModule(f) {
  const n = f.codes.length;
  const ok = await confirmDialog({
    title: `Clear ${esc(f.ecu.label)} fault memory?`,
    body: `Erases ${n} stored fault${n === 1 ? '' : 's'} on `
        + `<b>${esc(f.ecu.label)}</b> (<span class="mono">FS_LOESCHEN</span>). `
        + `The memory is re-read afterwards; anything still present will `
        + `show again.`,
    confirmLabel: 'Clear', danger: true,
  });
  if (!ok) return;
  const st = f.row.querySelector('.quick-status');
  st.innerHTML = '<span class="quick-clearing">clearing…</span>';
  try {
    await api(`/api/ecu/${f.ecu.sgbd}/run/FS_LOESCHEN`, { method: 'POST' });
    // trust the re-read, not the clear
    st.innerHTML = '<span class="quick-clearing">re-reading…</span>';
    let remaining = null;
    try {
      const codes = await readFaults(f.ecu.sgbd);
      remaining = codes.length;
      if (remaining) f.codes = codes;
    } catch { /* re-read failed; report the clear alone below */ }
    if (remaining) {
      setRowFaultStatus(f);
      const back = document.createElement('span');
      back.className = 'quick-clear-fail';
      back.textContent = ' still present after clear';
      st.appendChild(back);
      return;
    }
    f.row.classList.remove('has-faults'); f.row.classList.add('clean');
    st.innerHTML = remaining === null
      ? '<span class="quick-cleared">cleared (re-read failed)</span>'
      : '<span class="quick-cleared">cleared · re-read clean</span>';
    if (f.row.nextElementSibling?.classList.contains('quick-detail')) f.row.nextElementSibling.remove();
  } catch (e) {
    setRowFaultStatus(f); // rebuild the count + working Clear button
    const fail = document.createElement('span');
    fail.className = 'quick-clear-fail'; fail.textContent = ' clear failed';
    fail.title = e.message;
    st.appendChild(fail);
    setTimeout(() => fail.remove(), 4000);
  }
}

// render the DTCs for one faulty module beneath its sweep row, via the shared
// faultFields projection (faults.js) so rows and PDF read the same.
function appendFaultDetailRows(row, codes, sgbd) {
  const wrap = document.createElement('div');
  wrap.className = 'quick-detail';
  wrap.innerHTML = codes.map(c => {
    const { code, name, present } = faultFields(c, sgbd);
    return `<div class="quick-detail-row${present ? ' present' : ''}">
      <span class="quick-detail-code">${esc(code)}</span>
      <span class="quick-detail-name">${esc(name)}</span>
      <span class="quick-detail-state">${present ? 'PRESENT' : 'stored'}</span>
    </div>`;
  }).join('');
  row.insertAdjacentElement('afterend', wrap);
}
