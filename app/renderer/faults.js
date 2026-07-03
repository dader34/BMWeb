// fault rendering. German→English translation tables and the bmwCode/pCode/
// deGerman/envLabel helpers live in translate.js (loaded before this file).

// fault-name DB (faultdb.js, generated): a big object literal we don't want
// parsed before first paint, so it's not in the initial script list. injected
// on demand; resolves once window.BMW_FAULT_DB is set. fault screens kick this
// off before rendering so faultName lookups stay synchronous.
let _faultDbPromise = null;
function loadFaultDb() {
  if (window.BMW_FAULT_DB) return Promise.resolve();
  if (_faultDbPromise) return _faultDbPromise;
  _faultDbPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'faultdb.js';
    s.onload = () => resolve();
    s.onerror = () => { _faultDbPromise = null; resolve(); }; // lookups fall back to deGerman
    document.head.appendChild(s);
  });
  return _faultDbPromise;
}

// fault name: look up the BMW code in the fault DB for the English component name
// (27DA -> "Alternator BSD fault"). falls back to translating F_ORT_TEXT. Original
// (EDIABAS) mode keeps the raw German. keeps the "27DA " code prefix.
function faultName(loc, hex) {
  if (lang() === 'orig') return loc || '';
  const code = bmwCode(loc, hex);
  const db = (typeof window !== 'undefined' && window.BMW_FAULT_DB) || {};
  if (code && db[code]) return `${code} ${db[code]}`;
  // not in DB: translate the German location text token-wise
  return deGerman(loc) || loc || '';
}

// shared fault projection: code, English name, present/stored. one canonical
// home for the "momentan vorhanden && !nicht vorhanden" logic.
function faultFields(c) {
  const hex = c.F_HEX_CODE || '';
  const code = bmwCode(c.F_ORT_TEXT, hex);
  const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING || pCode(c.F_ORT_TEXT, hex) || '';
  const vt = (c.F_VORHANDEN_TEXT || '').toLowerCase();
  const present = vt.includes('momentan vorhanden') && !vt.includes('nicht vorhanden');
  return { code: code || pstr || hex || '—', name: faultName(c.F_ORT_TEXT, hex), present };
}

const inpaMode = () => Settings.get('inpaScreens', 'off') === 'on';

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

  const now = new Date();
  const present = faults.filter(c => faultFields(c).present).length;
  const body = faultModuleBlock(ecu.label, ecu.sgbd, faults);
  const html = faultReportHtml(
    `${ecu.label} · ${ecu.sgbd}.prg · fault memory`,
    [['Generated', now.toLocaleString()], ['Total faults', faults.length], ['Present', present]],
    body);

  const name = `BMacW-faults-${ecu.sgbd}-${now.toISOString().slice(0, 10)}.pdf`;
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
    const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING || pCode(c.F_ORT_TEXT, hex) || '';
    const ptext = deGerman(c.F_PCODE_TEXT || c.F_PCODE7_TEXT || '');
    const sym = deGerman(c.F_SYMPTOM_TEXT);
    const ready = deGerman(c.F_READY_TEXT);
    const status = deGerman(c.F_VORHANDEN_TEXT);
    const warn = deGerman(c.F_WARNUNG_TEXT);
    const freq = c.F_HFK || c.F_LZ;           // frequency (how many times seen)
    const km = c.F_UW_KM;                       // mileage at first/last entry
    const { present } = faultFields(c);
    return `
      <div class="inpa-fault">
        <div class="inpa-fault-head">
          <span class="inpa-fault-idx">Error: ${i + 1}(${total})</span>
          <span class="inpa-fault-nr">Nr: ${esc(c.F_ORT_NR || '-')}</span>
          <span class="inpa-fault-name">${esc(faultName(c.F_ORT_TEXT, c.F_HEX_CODE) || 'Unknown')}</span>
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
    // 1) normal read -> fault numbers
    const base = await api(`/api/ecu/${ecu.sgbd}/run/FS_LESEN`, { method: 'POST' });
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
    const { present } = faultFields(c);
    const hex = c.F_HEX_CODE || '';
    // prefer the detailed P-code (from FS_LESEN_DETAIL) over our static map
    const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING || pCode(c.F_ORT_TEXT, hex) || '';
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
        <div class="fault-hex">${esc(hex || c.F_ORT_NR || '-')}</div>
        ${pstr ? `<div class="fault-pcode">${esc(pstr)}</div>` : ''}
      </div>
      <div class="fault-main">
        <div class="fault-loc">${esc(faultName(c.F_ORT_TEXT, c.F_HEX_CODE) || 'Unknown location')}</div>
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
