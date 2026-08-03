// fault rendering. German→English translation tables and the bmwCode/pCode/
// deGerman/envLabel helpers live in translate.js (loaded before this file).

// fault-name DB (faultdb.js, generated): a big object literal we don't want
// parsed before first paint, so it's not in the initial script list. injected
// on demand; resolves once window.BMW_FAULT_DB is set. fault screens kick this
// off before rendering so faultName lookups stay synchronous.
let _faultDbPromise = null;
function loadFaultDb() {
  // P-codes + ISTA variant metadata are needed wherever fault names render.
  if (typeof loadPcodes === 'function') loadPcodes();
  if (typeof loadFaultMeta === 'function') loadFaultMeta();
  if (window.BMW_FAULT_DB) return Promise.resolve();
  if (_faultDbPromise) return _faultDbPromise;
  _faultDbPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'data/faultdb.js';
    s.onload = () => resolve();
    s.onerror = () => { _faultDbPromise = null; resolve(); }; // lookups fall back to deGerman
    document.head.appendChild(s);
  });
  return _faultDbPromise;
}

// the reading ECU's own codespace ({ code -> English }), or null. The flat
// BMW_FAULT_DB collides across ECU families (27C3 = oil-level on the E46 MS45,
// something else on an S65) - the scoped map generated per SGBD variant wins.
function scopedFaultDb(sgbd) {
  const s = (typeof window !== 'undefined' && window.BMW_FAULT_DB_SCOPED) || null;
  return (s && sgbd && s[String(sgbd).toLowerCase()]) || null;
}

// fault name: look up the BMW code in the fault DB for the English component name
// (27DA -> "Alternator BSD fault"). The reading ECU's scoped codespace wins over
// the flat cross-ECU DB. falls back to translating F_ORT_TEXT. Original
// (EDIABAS) mode keeps the raw German. keeps the "27DA " code prefix.
function faultName(loc, hex, sgbd) {
  if (lang() === 'orig') return loc || '';
  const code = bmwCode(loc, hex);
  const own = scopedFaultDb(sgbd);
  if (code && own && own[code]) return `${code} ${own[code]}`;
  const db = (typeof window !== 'undefined' && window.BMW_FAULT_DB) || {};
  if (code && db[code]) return `${code} ${db[code]}`;
  // not in DB: translate the German location text token-wise
  return deGerman(loc) || loc || '';
}

// shared fault projection: code, English name, present/stored. one canonical
// home for the "momentan vorhanden && !nicht vorhanden" logic.
function faultFields(c, sgbd) {
  const hex = c.F_HEX_CODE || '';
  // a real 4-hex DTC only when the fault TEXT leads with one (code-scheme DMEs, e.g.
  // "27DA BSD-Generator"). NOT bmwCode's hex fallback - that would surface the full
  // F_HEX_CODE and defeat the location-byte preference below.
  const textCode = bmwCode(c.F_ORT_TEXT, '');
  const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING
    || (typeof pcodeForHexSgbd === 'function' ? pcodeForHexSgbd(bmwCode(c.F_ORT_TEXT, hex), sgbd) : null) || '';
  const vt = (c.F_VORHANDEN_TEXT || '').toLowerCase();
  const present = vt.includes('momentan vorhanden') && !vt.includes('nicht vorhanden');
  // F_ORT_NR: a 16-bit value is either a real 2-byte DTC (DSC 0x5DC2 - the fault
  // DB knows it, show the whole code) or a text-scheme location+detail word
  // (LWS 0x0B3F - unknown as a code, show the location byte the FORTTEXTE table
  // keys on). The reading ECU's scoped codespace decides; flat DB as fallback.
  const ortFull = ortNrFull(c.F_ORT_NR);
  const own = scopedFaultDb(sgbd);
  const flat = (typeof window !== 'undefined' && window.BMW_FAULT_DB) || {};
  const knownFull = ortFull && ((own && own[ortFull]) || (!own && flat[ortFull]));
  const ortNr = knownFull ? ortFull : ortNrCode(c.F_ORT_NR);
  // fault type (Fehlerart: static vs sporadic) + occurrence counter (F_HFK,
  // falling back to the logistic counter) — the decoded form of the detail
  // byte that trails the location in the raw fault entry (e.g. 0B3F -> 3F)
  const art = c.F_ART1_TEXT || '';
  const ftype = /statisch/i.test(art) ? 'static'
    : /sporadisch/i.test(art) ? 'intermittent'
    : (deGerman(art) || art || '');
  const count = c.F_HFK || c.F_LZ || '';
  // SAE P-code, stacked above the hex where known: the ECU's own F_PCODE_STRING
  // (a live detail read) is authoritative; otherwise the ISTA BMW-hex -> P-code
  // table, scoped to the reading SGBD. No more hand-coded map.
  const code = textCode || pstr || ortNr || hex || '—';
  const lookupHex = textCode || (knownFull ? ortFull : (ortNr && ortNr.length > 2 ? ortNr : null));
  const pcode = c.F_PCODE_STRING || c.F_PCODE7_STRING ||
    (typeof pcodeForHexSgbd === 'function' ? pcodeForHexSgbd(lookupHex, sgbd) : null) || '';
  return { code, pcode: pcode !== code ? pcode : '',
           name: faultName(c.F_ORT_TEXT, hex, sgbd), present, ftype, count };
}

// INPA LAYOUT IS A DESKTOP MODE, and off on a phone whatever the setting
// says. It reproduces a keyboard-driven Windows UI: ten fixed F-key slots,
// printed key numbers, Shift for the second row, dense tables sized for a
// mouse. The mobile stylesheet already strips the parts that make it
// itself -- the number row, the ten-across bar -- so honouring the setting
// below 760px would ship the awkward half of INPA with none of the point
// of it. One reader, so every screen follows.
const inpaMode = () => Settings.get('inpaScreens', 'off') === 'on'
  && !window.matchMedia('(max-width: 760px)').matches;

// INPA "Comment" (F7): attach a free-text note to the current fault read.
// stored locally with the read so it shows in the export/print.
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

// INPA "Printing" (F9): export faults as CSV, one fault per row, fields in their
// own columns. includes detailed fields + environment values when present.
// single-ECU fault report, styled like the whole-car quick-sweep PDF but for just
// this module (e.g. the DME). uses the last fault read.
async function exportFaults(ecu, view) {
  const faults = lastFaultRead || [];
  if (!faults.length) { sbLeft.textContent = 'read codes first'; return; }
  if (!(window.bmacw && window.bmacw.savePdf)) { sbLeft.textContent = 'export unavailable'; return; }

  // ensure the ISTA P-code / name data is loaded so the printed report shows P-codes
  if (typeof loadFaultMeta === 'function') await loadFaultMeta();
  if (typeof loadPcodes === 'function') await loadPcodes();

  const now = new Date();
  const present = faults.filter(c => faultFields(c, ecu.sgbd).present).length;
  const body = faultModuleBlock(ecu.label, ecu.sgbd, faults);
  const html = faultReportHtml(
    `${ecu.label} · ${ecu.sgbd}.prg · fault memory`,
    [['Generated', now.toLocaleString()], ['Total faults', faults.length], ['Present', present]],
    body);

  const name = `${APP_NAME}-faults-${ecu.sgbd}-${now.toISOString().slice(0, 10)}.pdf`;
  sbLeft.textContent = 'saving…';
  try {
    const res = await window.bmacw.savePdf(name, html);
    sbLeft.textContent = res && res.ok ? `saved → ${res.path.split('/').pop()}` : 'export cancelled';
  } catch (e) {
    sbLeft.textContent = 'export failed';
  }
}

// environment snapshot captured by the DME when the fault was logged: RPM,
// voltages (alternator setpoint, KL87), engine state, mileage. only present
// after a detailed read (F_UW* fields). German to English.
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

// INPA fault view: mirrors the "MS45 error memory with environment" screen.
// numbered block per fault (type of error, readiness flag, error status,
// F-Code), with the BMW fault title and MIL state.
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
    // prefer the real P-code from the detailed read (F_PCODE_STRING), else our map
    const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING
      || (typeof pcodeForHexSgbd === 'function' ? pcodeForHexSgbd(code, ecu && ecu.sgbd) : null) || '';
    const ptext = deGerman(c.F_PCODE_TEXT || c.F_PCODE7_TEXT || '');
    const sym = deGerman(c.F_SYMPTOM_TEXT);
    const ready = deGerman(c.F_READY_TEXT);
    const status = deGerman(c.F_VORHANDEN_TEXT);
    const warn = deGerman(c.F_WARNUNG_TEXT);
    const freq = c.F_HFK || c.F_LZ;           // frequency (how many times seen)
    const km = c.F_UW_KM;                       // mileage at first/last entry
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

// INPA "Detail" (F2): normal read to get every fault number, then FS_LESEN_DETAIL
// per number, merging rich detail (P-code, frequency, mileage, environment) onto
// each. FS_LESEN_DETAIL needs the fault number as arg; with none it returns
// nothing (hence "0 codes").
async function readFaultsDetailed(ecu, container) {
  loadFaultDb(); // warm the name db while the bus works
  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading fault memory…</span></div>`;
  try {
    // 1) normal read -> fault numbers (via the address group so EDIABAS picks the
    // exact variant; see server LoadForJob)
    const gq = groupQuery(ecu);
    const base = await api(`/api/ecu/${ecu.sgbd}/run/FS_LESEN${gq}`, { method: 'POST' });
    const faults = dataSets(base.sets).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
    if (!faults.length) { renderFaults([], container, ecu); sbLeft.textContent = '0 faults'; return; }
    // 2) per-fault detail, merged onto the base entry
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
  // only real fault entries have a hex code (filters telegram/summary sets)
  const faults = (codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
  if (faults.length === 0) {
    container.innerHTML = `<div class="empty">
      <div class="empty-big">No stored faults</div>
      <div>The module reported a clean fault memory.</div></div>`;
    return;
  }
  container.innerHTML = '';
  container.className = 'faults stagger';
  faults.forEach(c => {
    const ff = faultFields(c, ecu && ecu.sgbd);
    const present = ff.present;
    // prefer the detailed P-code (from FS_LESEN_DETAIL) over our static map
    const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING || ff.pcode || '';
    const ptext = deGerman(c.F_PCODE_TEXT || c.F_PCODE7_TEXT || '');
    const warn = deGerman(c.F_WARNUNG_TEXT);
    const freq = c.F_HFK || c.F_LZ;
    const km = c.F_UW_KM;
    // detail present? (a detailed read merged the rich fields)
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
        ${present ? '<span class="flag present">present</span>' : '<span class="flag">stored</span>'}
        ${warn ? `<span class="flag">${esc(warn)}</span>` : ''}
      </div>`;
    container.appendChild(el);
  });
  stagger(container, 40);
}

// inline environment values for the modern fault card (RPM / voltages / state at
// code entry), shown only when a detailed read captured them
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
