// fault rendering. German→English tables and the bmwCode/pCode/deGerman/
// envLabel helpers live in translate.js (loaded before this file).

// fault-name DB (faultdb.js, generated): a big literal kept out of the initial
// script list so it isn't parsed before first paint. Injected on demand;
// resolves once window.BMW_FAULT_DB is set. Screens kick this off before
// rendering so faultName lookups stay synchronous.
let _faultDbPromise = null;
// faultdb.js (BMW_FAULT_DB / BMW_FAULT_PHRASES) is large BMW-derived data, not
// shipped in the repo: local build copy first, then the Hugging Face dataset.
const FAULT_DB_HF =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/faults/faultdb.js';
function loadFaultDb() {
  if (typeof loadPcodes === 'function') loadPcodes();
  if (typeof loadFaultMeta === 'function') loadFaultMeta();
  if (window.BMW_FAULT_DB) return Promise.resolve();
  if (_faultDbPromise) return _faultDbPromise;
  const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
  const urls = [`${base}/data/faultdb.js`, FAULT_DB_HF];
  _faultDbPromise = new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= urls.length) { _faultDbPromise = null; resolve(); return; } // fall back to deGerman
      const s = document.createElement('script');
      s.src = urls[i++];
      s.onload = () => resolve();
      s.onerror = () => { s.remove(); tryNext(); };
      document.head.appendChild(s);
    };
    tryNext();
  });
  return _faultDbPromise;
}

// the reading ECU's own codespace ({ code -> English }), or null. GOTCHA: the
// flat BMW_FAULT_DB collides across ECU families (27C3 is oil-level on the E46
// MS45, something else on an S65) -- the per-SGBD scoped map wins.
function scopedFaultDb(sgbd) {
  const s = (typeof window !== 'undefined' && window.BMW_FAULT_DB_SCOPED) || null;
  return (s && sgbd && s[String(sgbd).toLowerCase()]) || null;
}

// fault name: look up the BMW code for the English component name (27DA ->
// "Alternator BSD fault"), scoped codespace over flat DB. Falls back to
// translating F_ORT_TEXT; orig (EDIABAS) mode keeps raw German.
function faultName(loc, hex, sgbd) {
  if (lang() === 'orig') return loc || '';
  const code = bmwCode(loc, hex);
  const own = scopedFaultDb(sgbd);
  if (code && own && own[code]) return `${code} ${own[code]}`;
  const db = (typeof window !== 'undefined' && window.BMW_FAULT_DB) || {};
  if (code && db[code]) return `${code} ${db[code]}`;
  return deGerman(loc) || loc || '';
}

// shared fault projection: code, English name, present/stored. one home for the
// "momentan vorhanden && !nicht vorhanden" logic.
function faultFields(c, sgbd) {
  const hex = c.F_HEX_CODE || '';
  // a real 4-hex DTC only when the fault TEXT leads with one ("27DA
  // BSD-Generator"). NOT bmwCode's hex fallback -- that would surface the full
  // F_HEX_CODE and defeat the location-byte preference below.
  const textCode = bmwCode(c.F_ORT_TEXT, '');
  const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING
    || (typeof pcodeForHexSgbd === 'function' ? pcodeForHexSgbd(bmwCode(c.F_ORT_TEXT, hex), sgbd) : null) || '';
  const vt = (c.F_VORHANDEN_TEXT || '').toLowerCase();
  const present = vt.includes('momentan vorhanden') && !vt.includes('nicht vorhanden');
  // F_ORT_NR: a 16-bit value is either a real 2-byte DTC (DSC 0x5DC2, in the DB
  // -- show the whole code) or a text-scheme location+detail word (LWS 0x0B3F,
  // unknown as a code -- show the location byte FORTTEXTE keys on). The scoped
  // codespace decides; flat DB as fallback.
  const ortFull = ortNrFull(c.F_ORT_NR);
  const own = scopedFaultDb(sgbd);
  const flat = (typeof window !== 'undefined' && window.BMW_FAULT_DB) || {};
  const knownFull = ortFull && ((own && own[ortFull]) || (!own && flat[ortFull]));
  const ortNr = knownFull ? ortFull : ortNrCode(c.F_ORT_NR);
  // fault type (static vs sporadic) + occurrence counter (F_HFK, falling back to
  // the logistic counter)
  const art = c.F_ART1_TEXT || '';
  const ftype = /statisch/i.test(art) ? 'static'
    : /sporadisch/i.test(art) ? 'intermittent'
    : (deGerman(art) || art || '');
  const count = c.F_HFK || c.F_LZ || '';
  // SAE P-code: the ECU's own F_PCODE_STRING (a live detail read) is
  // authoritative, else the ISTA BMW-hex -> P-code table scoped to the SGBD.
  const code = textCode || pstr || ortNr || hex || '—';
  const lookupHex = textCode || (knownFull ? ortFull : (ortNr && ortNr.length > 2 ? ortNr : null));
  const pcode = c.F_PCODE_STRING || c.F_PCODE7_STRING ||
    (typeof pcodeForHexSgbd === 'function' ? pcodeForHexSgbd(lookupHex, sgbd) : null) || '';
  return { code, pcode: pcode !== code ? pcode : '',
           name: faultName(c.F_ORT_TEXT, hex, sgbd), present, ftype, count };
}

// INPA layout is a desktop mode: it reproduces a keyboard-driven Windows UI, and
// INPA "Comment" (F7): attach a free-text note to the current fault read, stored
// locally so it shows in the export/print.
async function addFaultComment(ecu, container) {
  const note = await inputDialog({
    title: 'Add comment', kind: 'text',
    body: 'Attach a note to this fault read (e.g. "replaced O2 sensor").',
    example: 'replaced O2 sensor 2026-06', confirmLabel: 'Save',
  });
  if (note == null) return;
  faultComment = note;
  const tag = container.querySelector('.fault-comment');
  if (tag) tag.textContent = `Note: ${note}`;
  else {
    const d = document.createElement('div');
    d.className = 'fault-comment'; d.textContent = `Note: ${note}`;
    container.prepend(d);
  }
  sbLeft.textContent = 'comment saved';
}
let faultComment = '';

// INPA "Printing" (F9): single-ECU fault report PDF from the last fault read.
async function exportFaults(ecu, view) {
  const faults = lastFaultRead || [];
  if (!faults.length) { sbLeft.textContent = 'read codes first'; return; }
  // Web build has no savePdf bridge: print a clean sheet for this one module
  // through the shared helper instead (reuses the whole-car report builder).
  if (!(window.bmacw && window.bmacw.savePdf)) {
    if (typeof printFaultReport === 'function') {
      const present = faults.filter(c => faultFields(c, ecu.sgbd).present).length;
      printFaultReport(ecu.chassis || '', [{ ecu, codes: faults }],
        { scanned: 1, skipped: 0, withFaults: 1, present });
    } else { sbLeft.textContent = 'export unavailable'; }
    return;
  }

  // load ISTA P-code / name data so the report shows P-codes
  if (typeof loadFaultMeta === 'function') await loadFaultMeta();
  if (typeof loadPcodes === 'function') await loadPcodes();

  const now = new Date();
  const present = faults.filter(c => faultFields(c, ecu.sgbd).present).length;
  const body = faultModuleBlock(ecu.label, ecu.sgbd, faults);
  // A PDF outlives the app: once exported nothing about the page says where
  // the faults came from, so a demo export declares it in the TITLE and in the
  // summary rows, both of which survive printing and cropping.
  const isDemo = faults.some(c => c._DEMO);
  const rows = [['Generated', now.toLocaleString()],
                ['Total faults', faults.length], ['Present', present]];
  if (isDemo) rows.push(['Source', 'DEMO — simulated, no car was read']);
  const html = faultReportHtml(
    `${ecu.label} · ${ecu.sgbd}.prg · fault memory${isDemo ? ' (DEMO)' : ''}`,
    rows,
    body);

  const name = `${APP_NAME}-faults-${isDemo ? 'DEMO-' : ''}${ecu.sgbd}-${now.toISOString().slice(0, 10)}.pdf`;
  sbLeft.textContent = 'saving…';
  try {
    const res = await window.bmacw.savePdf(name, html);
    sbLeft.textContent = res && res.ok ? `saved → ${res.path.split('/').pop()}` : 'export cancelled';
  } catch (e) {
    sbLeft.textContent = 'export failed';
  }
}

// environment snapshot the DME captured when the fault was logged (RPM,
// voltages, engine state, mileage), only present after a detailed read (F_UW*).
function envBlock(c) {
  const rows = [];
  for (let i = 1; i <= 8; i++) {
    const t = c[`F_UW${i}_TEXT`];
    if (t == null) continue;
    const val = c[`F_UW${i}_WERT`];
    const unit = c[`F_UW${i}_EINH`];
    if (val == null) continue;
    // round long decimals (13.1015625 -> 13.10)
    let shown = val;
    const n = parseFloat(val);
    if (isFinite(n) && !Number.isInteger(n) && /^-?\d/.test(val)) shown = n.toFixed(2);
    const u = unit && unit !== '0-n' ? ` ${unit}` : '';
    rows.push(`<div class="inpa-uw"><span class="inpa-uw-k">${esc(envLabel(t))}</span><span class="inpa-uw-v">${esc(envLabel(String(shown)) + u)}</span></div>`);
  }
  if (!rows.length) return '';
  return `<div class="inpa-env"><div class="inpa-env-head">environment: values at code entry</div>${rows.join('')}</div>`;
}

// INPA fault view: mirrors the "MS45 error memory with environment" screen --
// a numbered block per fault with the BMW fault title and MIL state.
function renderFaultsInpa(codes, container, ecu) {
  const faults = (codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
  container.className = 'inpa-faults';
  if (faults.length === 0) {
    container.innerHTML = `<div class="inpa-fault-title">${esc(ecu && ecu.sgbd ? ecu.sgbd.toUpperCase() : 'ECU')} error memory</div>
      <div class="inpa-noerr">No faults stored. Fault memory is clean.</div>`;
    return;
  }
  const total = faults.length;
  const blocks = faults.map((c, i) => {
    const hex = c.F_HEX_CODE || '';
    const code = bmwCode(c.F_ORT_TEXT, hex);
    // prefer the real P-code from the detailed read, else our map
    const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING
      || (typeof pcodeForHexSgbd === 'function' ? pcodeForHexSgbd(code, ecu && ecu.sgbd) : null) || '';
    const ptext = deGerman(c.F_PCODE_TEXT || c.F_PCODE7_TEXT || '');
    const sym = deGerman(c.F_SYMPTOM_TEXT);
    const ready = deGerman(c.F_READY_TEXT);
    const status = deGerman(c.F_VORHANDEN_TEXT);
    const warn = deGerman(c.F_WARNUNG_TEXT);
    const freq = c.F_HFK || c.F_LZ;           // how many times seen
    const km = c.F_UW_KM;                       // mileage at entry
    const { present } = faultFields(c, ecu && ecu.sgbd);
    return `
      <div class="inpa-fault">
        <div class="inpa-fault-head">
          <span class="inpa-fault-idx">Error: ${i + 1}(${total})</span>
          <span class="inpa-fault-nr">Nr: ${esc(c.F_ORT_NR || '-')}</span>
          <span class="inpa-fault-name">${esc(faultName(c.F_ORT_TEXT, c.F_HEX_CODE, ecu && ecu.sgbd) || 'Unknown')}</span>
          ${present ? '<span class="inpa-fault-present">PRESENT</span>' : ''}
          ${freq ? `<span class="inpa-fault-freq">frequency: ${esc(freq)}</span>` : ''}
        </div>
        <div class="inpa-fault-fields">
          <div class="inpa-ff"><span class="inpa-ff-k">type of error:</span><span class="inpa-ff-v">${esc(`${c.F_SYMPTOM_NR ? `(${c.F_SYMPTOM_NR}) ` : ''}${sym || '-'}`)}</span></div>
          <div class="inpa-ff"><span class="inpa-ff-k">readiness flag:</span><span class="inpa-ff-v">${esc(`${c.F_READY_NR ? `(${c.F_READY_NR}) ` : ''}${ready || '-'}`)}</span></div>
          <div class="inpa-ff"><span class="inpa-ff-k">error status:</span><span class="inpa-ff-v">${esc(`${c.F_VORHANDEN_NR ? `(${c.F_VORHANDEN_NR}) ` : ''}${status || '-'}`)}</span></div>
          <div class="inpa-ff"><span class="inpa-ff-k">warning lamp:</span><span class="inpa-ff-v">${esc(`${c.F_WARNUNG_NR ? `(${c.F_WARNUNG_NR}) ` : ''}${warn || '-'}`)}</span></div>
          ${pstr ? `<div class="inpa-ff"><span class="inpa-ff-k">P-Code:</span><span class="inpa-ff-v mono">${esc(`${pstr}${ptext ? ` - ${ptext}` : ''}`)}</span></div>` : ''}
          <div class="inpa-ff"><span class="inpa-ff-k">F-Code:</span><span class="inpa-ff-v mono">${esc(`${hex || '-'}${code ? `  ·  ${code}` : ''}`)}</span></div>
          ${km ? `<div class="inpa-ff"><span class="inpa-ff-k">entry at km:</span><span class="inpa-ff-v">${esc(km)}</span></div>` : ''}
        </div>
        ${envBlock(c)}
      </div>`;
  }).join('');
  container.innerHTML = `<div class="inpa-fault-title">${esc(ecu && ecu.sgbd ? ecu.sgbd.toUpperCase() : 'ECU')} error memory with environment</div>${blocks}`;
}

// INPA "Detail" (F2): normal read for every fault number, then FS_LESEN_DETAIL
// per number, merging rich detail onto each. GOTCHA: FS_LESEN_DETAIL needs the
// fault number as arg; with none it returns nothing (hence "0 codes").
async function readFaultsDetailed(ecu, container) {
  loadFaultDb(); // warm the name db while the bus works
  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading fault memory…</span></div>`;
  try {
    // normal read -> fault numbers (via the address group so EDIABAS picks the
    // exact variant)
    const gq = groupQuery(ecu);
    const base = await api(`/api/ecu/${ecu.sgbd}/run/FS_LESEN${gq}`, { method: 'POST' });
    const faults = dataSets(base.sets).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
    if (!faults.length) { renderFaults([], container, ecu); sbLeft.textContent = '0 faults'; return; }
    // per-fault detail, merged onto the base entry
    container.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading detail for ${faults.length} fault(s)…</span></div>`;
    await fillFaultDetail(ecu.sgbd, faults);
    await loadFaultDb();
    renderFaults(faults, container, ecu);
    sbLeft.textContent = `${faults.length} fault(s) · detailed`;
  } catch (e) {
    container.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'failed';
  }
}

let lastFaultRead = []; // most recent fault list (for Comment/Print/export)
function renderFaults(codes, container, ecu) {
  lastFaultRead = (codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
  if (inpaMode()) return renderFaultsInpa(codes, container, ecu);
  container.className = 'faults';
  // only real fault entries have a hex/ort code (filters telegram/summary sets)
  const faults = (codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
  if (faults.length === 0) {
    container.innerHTML = `<div class="empty">
      <div class="empty-big">No stored faults</div>
      <div>The module reported a clean fault memory.</div></div>`;
    return;
  }
  container.innerHTML = '';
  container.className = 'faults stagger';
  // A fabricated fault names a component and gets screenshotted, so a demo
  // read says so ABOVE the list -- not only in Settings, which is off-screen
  // by the time anyone is looking at this.
  if (faults.some(c => c._DEMO)) {
    const b = document.createElement('div');
    b.className = 'fault-demo-banner';
    b.innerHTML = '<b>Demo faults.</b> Simulated from this module\'s fault '
      + 'table. No car was read.';
    container.appendChild(b);
  }
  faults.forEach(c => {
    const ff = faultFields(c, ecu && ecu.sgbd);
    const present = ff.present;
    // prefer the detailed P-code (FS_LESEN_DETAIL) over our static map
    const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING || ff.pcode || '';
    const ptext = deGerman(c.F_PCODE_TEXT || c.F_PCODE7_TEXT || '');
    const warn = deGerman(c.F_WARNUNG_TEXT);
    const freq = c.F_HFK || c.F_LZ;
    const km = c.F_UW_KM;
    // a detailed read merged the rich fields
    const detailed = !!(c.F_PCODE_STRING || c.F_UW1_TEXT || c.F_HFK);
    const el = document.createElement('div');
    el.className = 'fault';
    el.innerHTML = `
      <div class="fault-code">
        <div class="fault-hex">${esc(ff.code)}</div>
        ${pstr ? `<div class="fault-pcode">${esc(pstr)}</div>` : ''}
      </div>
      <div class="fault-main">
        <div class="fault-loc">${esc(ff.name || 'Unknown location')}</div>
        <div class="fault-symptom">${esc(deGerman(c.F_SYMPTOM_TEXT) || '')}</div>
        ${detailed ? `
          <div class="fault-detail">
            ${ptext ? `<div class="fd-row"><span class="fd-k">Meaning</span><span class="fd-v">${esc(ptext)}</span></div>` : ''}
            <div class="fd-row"><span class="fd-k">Status</span><span class="fd-v">${esc(deGerman(c.F_VORHANDEN_TEXT) || '-')}</span></div>
            ${freq ? `<div class="fd-row"><span class="fd-k">Frequency</span><span class="fd-v">${esc(freq)}</span></div>` : ''}
            ${km ? `<div class="fd-row"><span class="fd-k">At mileage</span><span class="fd-v">${esc(km)} km</span></div>` : ''}
            ${faultEnvInline(c)}
          </div>` : ''}
      </div>
      <div class="fault-flags">
        ${c._DEMO ? '<span class="flag demo">demo</span>' : ''}
        ${present ? '<span class="flag present">present</span>' : '<span class="flag">stored</span>'}
        ${warn ? `<span class="flag">${esc(warn)}</span>` : ''}
      </div>`;
    container.appendChild(el);
  });
  stagger(container, 40);
}

// inline environment values for the modern fault card, shown only when a
// detailed read captured them
function faultEnvInline(c) {
  const items = [];
  for (let i = 1; i <= 4; i++) {
    const t = c[`F_UW${i}_TEXT`]; if (t == null) continue;
    const v = c[`F_UW${i}_WERT`]; if (v == null) continue;
    const u = c[`F_UW${i}_EINH`]; const unit = u && u !== '0-n' ? ` ${u}` : '';
    let shown = v; const n = parseFloat(v);
    if (isFinite(n) && !Number.isInteger(n) && /^-?\d/.test(String(v))) shown = n.toFixed(2);
    items.push(`<span class="fd-env"><span class="fd-env-k">${esc(envLabel(t))}:</span> ${esc(envLabel(String(shown)) + unit)}</span>`);
  }
  return items.length ? `<div class="fd-env-row">${items.join('')}</div>` : '';
}
