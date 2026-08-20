// whole-vehicle sweep engine (INPA "Functional Jobs"): quickErrorSweep reads
// fault memory on every chassis ECU, quickIdentSweep reads IDENT. Strict group
// resolution (cfe86b07) is the presence test for every ecu with a runnable
// D_xxxx group; server-derived variant groups skip dead siblings; the hand
// table below only bridges the few group-less orphans in. fault-signature
// dedup drops echoes. fillFaultDetail lives in autoscan.js; exportFaultPdf in
// fault-report.js.

// variant groups: ECUs sharing one diagnostic address, only one installed. Once
// a member responds the rest are absent, so the sweep skips them. The server
// derives the groups from the entries' .IPO address references
// (ch.variantGroups); the hand entries below now hold ONLY the ecus whose
// chassis-config `group` is null (.IPO carried no usable token, so they have
// no strict D_xxxx presence test either), each led by one anchor code that IS
// in the derived group so buildGroupLookup merges the orphans into it and a
// strict group answer eliminates them. Every code with a runnable `group` was
// deleted 2026-08-18: strict resolution is its presence test and
// ch.variantGroups already carries its sibling-skip (verified against
// data/chassis-config/E46.json + E36.json vs data/groups/index.json). The old
// E36 cross-address merges (D_0010+D_0012 engines, D_0032+D_006C boxes) went
// with it; cost is one cached group-resolution timeout per absent address
// family, not one per sibling.
const VARIANT_GROUPS = {
  E46: {
    // ME9NG4TU + MS450: `group:null` in E46.json, so they still scan by
    // direct read; MS430 (D_0012, in the derived engine group) anchors them
    // so an identified engine skips both. CARB (also group:null) is gone from
    // the group on the old E36 note's own rationale: it's a dealer interface
    // that coexists with the DME (like the S50 VANOS box VNC), so an engine
    // answer must never mark it absent -- it just scans ungrouped now.
    engine: ['MS430', 'ME9NG4TU', 'MS450'],
    // dscmk60: `group:null` in E46.json; ascdsc46 (D_0056, in the derived
    // DSC group) anchors it.
    dsc: ['ascdsc46', 'dscmk60'],
  },
  E36: {
    // dscmk60: `group:null` in E36.json too (same MK60 box as E46); same
    // ascdsc46 anchor (in the derived D_0056 group).
    dsc: ['ascdsc46', 'dscmk60'],
  },
};
// code -> group lookup for one chassis: the server derives groups from the
// entries' .IPO address references; the hand tables above fill gaps where an
// .IPO carries no usable token (MS450, dscmk60). Hand entries join a derived
// group when they share a member, else form their own. unknown code -> null
// (scanned normally: safe, just slower).
function buildGroupLookup(ch) {
  const groups = (ch.variantGroups || []).map(g => new Set(g.map(c => String(c).toLowerCase())));
  const hand = VARIANT_GROUPS[(ch.id || '').toUpperCase()];
  if (hand) {
    for (const list of Object.values(hand)) {
      const set = new Set(list.map(c => c.toLowerCase()));
      const overlap = groups.find(g => [...set].some(c => g.has(c)));
      if (overlap) set.forEach(c => overlap.add(c));
      else groups.push(set);
    }
  }
  const byCode = new Map();
  // string keys: a numeric 0 would read falsy at the `grp &&` skip checks
  groups.forEach((g, i) => g.forEach(c => byCode.set(c, `g${i}`)));
  return (code) => byCode.get(String(code || '').toLowerCase()) || null;
}
// stable fault signature for echo dedup. F_HEX_CODE is globally unique (BMW
// DTC); F_ORT_NR is only an ECU-local index, so fall back to it only when hex
// is absent.
// hexText: on web F_HEX_CODE is a byte Array, which would splice its own commas
// into a comma-joined signature and let two faults collide with one; '|' can't
// appear in dashed hex.
const _faultSig = (codes) =>
  (codes || []).map(c => hexText(c.F_HEX_CODE) || `nr:${c.F_ORT_NR}`).join('|');

// Variant resolution is INPA's own model, with no per-module lists: the
// ecu's diagnostic-address group (D_00A4...) runs its IDENTIFIKATION in the
// VM (webResolveVariant, available in web AND native builds -- both run jobs
// through webshim/bestvm) and names the concrete SGBD from the ident bytes.
// The probeAirbag richest-read hack and its AIRBAG_VARIANTS list are gone:
// they existed because the configured zae ANSWERS an MRS module and decodes
// a false 0 faults -- the group's ident chain makes that mixup impossible.

// each sweep takes a token; navigating away or starting another bumps it, and
// the running loop bails on its next iteration -- stops hammering the K-line
// once the user leaves.
let _sweepToken = 0;
const cancelSweep = () => { _sweepToken++; };

// quick error memory test (INPA FSQUICK): read fault memory on every chassis
// ECU, report which modules have stored faults.
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
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id), fn: () => { cancelSweep(); showSections(id); } }, { label: 'Full Module Error Scan' }]);
  view.innerHTML = head('Whole vehicle', 'Full Module Error Scan', `Scanning every module on the ${dispChassis(id)} for stored faults…`);
  const out = document.createElement('div'); out.className = 'results-panel'; view.appendChild(out);
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => { cancelSweep(); showSections(id); } }]);
  loadFaultDb(); // warm the name db before detail rows render
  const ch = await tryApi(`/api/chassis/${id}`, null, out);
  if (!ch) return;
  const ecus = dedupEcus(ch);      // config order: engine section first
  const groupOf = buildGroupLookup(ch);
  // The ecu's address group (D_00A4...) runs its own IDENTIFIKATION and
  // names the concrete variant; the fault read then targets THAT SGBD.
  // One resolution per group per run (webshim caches per session too).
  // The shipped-groups index decides which ecus get the strict semantics:
  // a group we CAN run is the presence test (no identification -> no read),
  // a group we can't run leaves the legacy direct read in place.
  const groupIndex = await fetch('data/groups/index.json')
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  const groupRunnable = (g) => !!(g && typeof webResolveVariant === 'function'
    && groupIndex && (groupIndex.groups || []).includes(g));
  const resolvedVariant = new Map();
  const resolveVia = async (g) => {
    if (!resolvedVariant.has(g)) {
      let v = null;
      try { v = await webResolveVariant(g); } catch { v = null; }
      resolvedVariant.set(g, v);
    }
    return resolvedVariant.get(g);
  };
  out.innerHTML = `<div class="quick-sweep">
    <div class="quick-bar">
      <div class="quick-head">${ecus.length} modules · scanning…</div>
      <div class="quick-bar-btns">
        <button class="quick-pdf" id="quick-pdf" disabled>Export PDF</button>
        <button class="quick-clear-all" id="quick-clear-all" disabled>Clear all</button>
      </div>
    </div>
    <div class="quick-rows" id="quick-rows"></div></div>`;
  const rows = out.querySelector('#quick-rows');
  const headEl = out.querySelector('.quick-head');
  let withFaults = 0, scanned = 0, dupes = 0, skipped = 0;
  const seen = new Map();          // fault-signature -> first ECU label
  const groupDone = new Set();     // variant-group key that already responded
  const faulty = [];               // modules with faults, for the deep pass
  for (const ecu of ecus) {
    if (!alive()) return;          // user left the sweep; stop reading the bus
    const grp = groupOf(ecu.code);
    const row = addSweepRow(rows, ecu.label);

    if (grp && groupDone.has(grp)) {
      // another variant in this group answered, so this one isn't installed
      skipped++; row.classList.add('noresp');
      row.querySelector('.quick-status').textContent = 'skipped (variant)';
      continue;
    }
    try {
      // legacy hint for the no-group path only; the strict path below runs
      // the group's own bytecode instead of hinting at a server
      const gq = groupQuery(ecu);
      let data;
      const g = String(ecu.group || '').toLowerCase();
      if (groupRunnable(g)) {
        // STRICT group semantics, exactly INPA's: the group's IDENTIFIKATION
        // is the module-present test, and the fault read runs on the variant
        // it names. NO fallback to the configured SGBD here -- a wrong-
        // generation sibling (zae for an MRS airbag) happily answers with a
        // false 0 faults, which is the exact trap this replaces.
        const via = await resolveVia(g);
        if (!via) throw new Error(`no identification from ${g}`);
        try {
          data = await api(`/api/ecu/${via}/read`, { method: 'POST' });
          ecu.sgbd = via;                 // deep read and Clear target it
        } catch (e) {
          // identified, but this build can't read that variant ('xyz'
          // catch-all or missing job-code): say so, don't mis-read a sibling
          if (/404|not found|no job|unknown sgbd/i.test(String(e.message || e))) {
            row.classList.add('noresp');
            row.querySelector('.quick-status').textContent = `variant ${via} not in build`;
            skipped++; scanned++;
            headEl.textContent = `${scanned} read · ${skipped} skipped · ${withFaults} with faults`;
            continue;
          }
          throw e;                        // real wire failure stays a failure
        }
      } else {
        // no runnable group for this ecu: the configured direct read
        data = await api(`/api/ecu/${ecu.sgbd}/read${gq}`, { method: 'POST' });
      }
      const n = data.count || 0;
      // any answer (even 0 faults) claims the variant group
      if (grp && typeof data.count === 'number') groupDone.add(grp);
      if (n > 0) {
        const sig = _faultSig(data.codes);
        if (seen.has(sig)) {
          dupes++; row.classList.add('noresp');
          row.querySelector('.quick-status').textContent = `echo of ${seen.get(sig)}`;
        } else {
          seen.set(sig, ecu.label);
          withFaults++; row.classList.add('has-faults');
          row.querySelector('.quick-status').innerHTML = `<b>${n} fault${n === 1 ? '' : 's'}</b>`;
          const codes = (data.codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
          faulty.push({ ecu, row, codes });
        }
      } else { row.classList.add('clean'); row.querySelector('.quick-status').textContent = 'OK'; }
    } catch (e) {
      row.classList.add('noresp'); row.querySelector('.quick-status').textContent = 'no response';
    }
    scanned++;
    headEl.textContent = `${scanned} read · ${skipped} skipped · ${withFaults} with faults`;
  }

  // deep pass: each faulty module gets a detailed read (FS_LESEN_DETAIL), shown
  // inline under its row.
  if (faulty.length) {
    await loadFaultDb(); // names resolve synchronously in the detail rows
    headEl.textContent =
      `${scanned} read, ${skipped} skipped · ${withFaults} with faults · reading details…`;
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
        `${scanned} read, ${skipped} skipped · ${withFaults} with faults · details ${done}/${faulty.length}`;
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
  const pdfBtn = out.querySelector('#quick-pdf');
  if (pdfBtn && window.bmacw && window.bmacw.savePdf) {
    pdfBtn.disabled = false;
    pdfBtn.onclick = () => exportFaultPdf(id, faulty, { scanned, skipped, withFaults });
  } else if (pdfBtn) {
    pdfBtn.textContent = 'Print report';
    pdfBtn.disabled = false;
    pdfBtn.onclick = () => printFaultReport(id, faulty, { scanned, skipped, withFaults });
    // register it as the screen's print action too: Cmd/Ctrl+P routes through
    // the current action list (core/print.js), and the mobile functions sheet
    // reads the same list -- without this, both print the live page instead
    setActions([
      { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
        fn: () => { cancelSweep(); showSections(id); } },
      { key: 'p', keyLabel: 'P', label: 'Print report', kind: 'print',
        fn: () => printFaultReport(id, faulty, { scanned, skipped, withFaults }) },
    ]);
  }

  headEl.textContent =
    `Done · ${scanned} read, ${skipped} skipped · ${withFaults} with stored faults${dupes ? ` · ${dupes} echoes hidden` : ''}`;
  sbLeft.textContent = `full module error scan · ${withFaults} faulty`;
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
    await api(`/api/ecu/${f.ecu.sgbd}/clear`, { method: 'POST' });
    // trust the re-read, not the clear
    st.innerHTML = '<span class="quick-clearing">re-reading…</span>';
    let remaining = null;
    try {
      const d = await api(`/api/ecu/${f.ecu.sgbd}/read`, { method: 'POST' });
      const codes = (d.codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
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

// quick identification (INPA IDQUICK): read IDENT on every chassis ECU
async function quickIdentSweep(chassisId) {
  const id = chassisId || 'E46';
  const token = ++_sweepToken;
  const alive = () => token === _sweepToken;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: dispChassis(id), fn: () => { cancelSweep(); showSections(id); } }, { label: 'Quick identification' }]);
  view.innerHTML = head('Whole vehicle', 'Quick identification', `Identifying every module on the ${dispChassis(id)}…`);
  const out = document.createElement('div'); out.className = 'results-panel'; view.appendChild(out);
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => { cancelSweep(); showSections(id); } }]);
  let ch;
  try { ch = await api(`/api/chassis/${id}`); }
  catch (e) { out.innerHTML = errorBlock(e.message); return; }
  const ecus = dedupEcus(ch);      // config order: engine section first
  const groupOf = buildGroupLookup(ch);
  out.innerHTML = `<div class="quick-sweep"><div class="quick-head">${ecus.length} modules · identifying…</div><div class="quick-rows" id="quick-rows"></div></div>`;
  const rows = out.querySelector('#quick-rows');
  const head_ = out.querySelector('.quick-head');
  let present = 0, scanned = 0;
  const groupDone = new Set();
  for (const ecu of ecus) {
    if (!alive()) return;          // user left the sweep; stop reading the bus
    const grp = groupOf(ecu.code);
    const row = addSweepRow(rows, ecu.label);
    if (grp && groupDone.has(grp)) { row.classList.add('noresp'); row.querySelector('.quick-status').textContent = 'skipped (variant)'; continue; }
    try {
      const data = await api(`/api/ecu/${ecu.sgbd}/run/IDENT`, { method: 'POST' });
      if (grp) groupDone.add(grp);
      const set = dataSets(data.sets).find(s => Object.keys(s).some(k => !k.startsWith('_')));
      const idtxt = set ? (set.SG_VARIANTE || set.VARIANTE || set.AIF_TYP || set.HARDWARE_NUMMER || 'present') : 'present';
      present++; row.classList.add('clean'); row.querySelector('.quick-status').textContent = String(idtxt).slice(0, 28);
    } catch {
      row.classList.add('noresp'); row.querySelector('.quick-status').textContent = 'no response';
    }
    scanned++;
    head_.textContent = `${scanned} identified · ${present} present`;
  }
  head_.textContent = `Done · ${present} modules present`;
  sbLeft.textContent = `quick ident · ${present} present`;
}

// shared sweep helpers

// sweep order IS chassis-config order: sections come engine-first in the
// configs (INPA's own menu order), so the big mutually-exclusive engine group
// is claimed before the long tail, and dedup keeps the first occurrence. The
// hand-typed SWEEP_PRIORITY table + sortByPriority (deleted 2026-08-18) bet
// on likeliest-installed variants per chassis; strict group resolution makes
// that moot -- one cached IDENTIFIKATION per D_xxxx group names the installed
// variant no matter which member row runs first -- and the bet was actively
// wrong under it: it ran group-less legacy reads (MS450 first on E46) BEFORE
// the strict members, letting a direct read claim the merged variant group
// ahead of identification.
function dedupEcus(ch) {
  const ecus = [];
  ch.sections.forEach(s => s.ecus.forEach(e => { if (!ecus.find(x => x.sgbd === e.sgbd)) ecus.push(e); }));
  return ecus;
}
function addSweepRow(rows, label) {
  const row = document.createElement('div'); row.className = 'quick-row';
  row.innerHTML = `<span class="quick-ecu">${esc(label)}</span><span class="quick-status">scanning…</span>`;
  rows.appendChild(row);
  return row;
}
