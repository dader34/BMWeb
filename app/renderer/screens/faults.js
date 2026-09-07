/**
 * @file Fault rendering: the fault-name database, the shared fault
 * projection every fault view and report draws from, the two fault views
 * (INPA-style and modern card), and the freeze-frame environment blocks.
 *
 * German->English tables and the bmwCode/pCode/phraseText/envLabel helpers
 * live in core/translate.js (loaded before this file).
 */

/**
 * The fault projection shared by the screen rows and the printed reports:
 * one home for the "momentan vorhanden && !nicht vorhanden" logic.
 * @typedef {object} FaultFields
 * @property {string} code - The code shown: the text's own DTC, else the
 *   ECU's P-code, else the location number, else the raw hex.
 * @property {string} hex - The raw fault word when it differs from `code`.
 * @property {string} pcode - The SAE P-code when it differs from `code`.
 * @property {string} name - The English fault name.
 * @property {boolean} present - Present now, as opposed to stored.
 * @property {string} ftype - 'static' / 'intermittent' / the ECU's own text.
 * @property {string|number} count - Occurrence counter (F_HFK, else F_LZ).
 */

/**
 * The module a fault view is drawn for.
 * @typedef {object} FaultEcu
 * @property {string} sgbd - The SGBD.
 * @property {string} [label] - Display label.
 * @property {string} [chassis] - Chassis id, for the printed report.
 */

/**
 * The pending fault-name database load, so screens that kick it off before
 * rendering can await the same promise.
 * @type {Promise<void>|null}
 */
let _faultDbPromise = null;

/**
 * Where faultdb.js (BMW_FAULT_DB / BMW_FAULT_PHRASES) is fetched from when
 * the local build has no copy: it is large BMW-derived data, not shipped in
 * the repo.
 */
const FAULT_DB_HF =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/faults/faultdb.js';

/** The last F_UWn field a detailed read may carry. */
const ENV_FIELDS_MAX = 8;
/** How many F_UWn fields the modern card shows inline. */
const ENV_INLINE_MAX = 4;
/** The unit EDIABAS reports for a unitless value. */
const ENV_NO_UNIT = '0-n';

/**
 * Load the fault-name DB (faultdb.js, generated): a big literal kept out of
 * the initial script list so it isn't parsed before first paint. Injected on
 * demand; resolves once window.BMW_FAULT_DB is set, or once every source has
 * failed (faultName then falls back to phraseText). Screens kick this off
 * before rendering so faultName lookups stay synchronous. Local build copy
 * first, then the dataset mirror.
 * @returns {Promise<void>} Resolves when the DB is present or unavailable.
 */
function loadFaultDb() {
  if (typeof loadPcodes === 'function') loadPcodes();
  if (typeof loadFaultMeta === 'function') loadFaultMeta();
  if (window.BMW_FAULT_DB) return Promise.resolve();
  if (_faultDbPromise) return _faultDbPromise;
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  const urls = [`${base}/data/faultdb.js`, FAULT_DB_HF];
  _faultDbPromise = new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= urls.length) {
        _faultDbPromise = null;
        resolve();
        return;
      } // fall back to phraseText
      const s = document.createElement('script');
      s.src = urls[i++];
      s.onload = () => resolve();
      s.onerror = () => {
        s.remove();
        tryNext();
      };
      document.head.appendChild(s);
    };
    tryNext();
  });
  return _faultDbPromise;
}

/**
 * The reading ECU's own codespace ({ code -> English }), or null. GOTCHA:
 * the flat BMW_FAULT_DB collides across ECU families (27C3 is oil-level on
 * the E46 MS45, something else on an S65) -- the per-SGBD scoped map wins.
 * @param {string|null|undefined} sgbd - The SGBD.
 * @returns {Object<string, string>|null} The scoped map, or null.
 */
function scopedFaultDb(sgbd) {
  const s =
    (typeof window !== 'undefined' && window.BMW_FAULT_DB_SCOPED) || null;
  return (s && sgbd && s[String(sgbd).toLowerCase()]) || null;
}

/**
 * Fault name: look up the BMW code for the English component name (27DA ->
 * "Alternator BSD fault"), scoped codespace over flat DB. Falls back to
 * translating F_ORT_TEXT; orig (EDIABAS) mode keeps raw German.
 * @param {string|null|undefined} loc - F_ORT_TEXT.
 * @param {string} hex - The raw fault word as dashed hex.
 * @param {string|null|undefined} sgbd - The SGBD, for the scoped map.
 * @returns {string} The name, "CODE Name" where the DB knows it.
 */
function faultName(loc, hex, sgbd) {
  if (lang() === 'orig') return loc || '';
  const code = bmwCode(loc, hex);
  const own = scopedFaultDb(sgbd);
  if (code && own && own[code]) return `${code} ${own[code]}`;
  const db = (typeof window !== 'undefined' && window.BMW_FAULT_DB) || {};
  if (code && db[code]) return `${code} ${db[code]}`;
  return phraseText(loc) || loc || '';
}

/**
 * The ECU's fault-type list (F_ART1..F_ART_ANZ), "--" entries dropped,
 * joined for a one-line display. This is what a body module reports in
 * place of the DME's F_SYMPTOM -- IHKA46_3's 0x20 comes back as
 * "Kurzschluss gegen U-Batt".
 * @param {FaultEntry} c - The fault entry.
 * @returns {string} The types, comma-joined; '' when none.
 */
function faultTypeText(c) {
  const n = parseInt(c.F_ART_ANZ, 10) || 0;
  const parts = [];
  for (let a = 1; a <= n; a++) {
    const t = c[`F_ART${a}_TEXT`];
    if (t != null && String(t).trim() && String(t).trim() !== '--') {
      parts.push(phraseText(t));
    }
  }
  return parts.join(', ');
}

/**
 * The shared fault projection: code, English name, present/stored, type
 * and count.
 *
 * F_ORT_NR: a 16-bit value is either a real 2-byte DTC (DSC 0x5DC2, in the
 * DB -- show the whole code) or a text-scheme location+detail word (LWS
 * 0x0B3F, unknown as a code -- show the location byte FORTTEXTE keys on).
 * The scoped codespace decides; flat DB as fallback.
 *
 * SAE P-code: the ECU's own F_PCODE_STRING (a live detail read) is the ONLY
 * source. No BMW-hex -> P-code mapping on our side during a fault read: the
 * module is the authority, and a plain read that carries no P-code simply
 * shows none rather than a value we inferred.
 * @param {FaultEntry} c - The fault entry.
 * @param {string|null|undefined} sgbd - The SGBD it was read from.
 * @returns {FaultFields} The projection.
 */
function faultFields(c, sgbd) {
  const hex = hexText(c.F_HEX_CODE);
  // a real 4-hex DTC only when the fault TEXT leads with one ("27DA
  // BSD-Generator"). NOT bmwCode's hex fallback -- that would surface the full
  // F_HEX_CODE and defeat the location-byte preference below.
  const textCode = bmwCode(c.F_ORT_TEXT, '');
  const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING || '';
  const vt = String(c.F_VORHANDEN_TEXT || '').toLowerCase();
  const present =
    vt.includes('momentan vorhanden') && !vt.includes('nicht vorhanden');
  const ortFull = ortNrFull(c.F_ORT_NR);
  const own = scopedFaultDb(sgbd);
  const flat = (typeof window !== 'undefined' && window.BMW_FAULT_DB) || {};
  const knownFull =
    ortFull && ((own && own[ortFull]) || (!own && flat[ortFull]));
  const ortNr = knownFull ? ortFull : ortNrCode(c.F_ORT_NR);
  // fault type (static vs sporadic) + occurrence counter (F_HFK, falling back to
  // the logistic counter)
  const art = c.F_ART1_TEXT || '';
  const ftype = /statisch/i.test(art)
    ? 'static'
    : /sporadisch/i.test(art)
      ? 'intermittent'
      : phraseText(art) || art || '';
  const count = c.F_HFK || c.F_LZ || '';
  const code = textCode || pstr || ortNr || hex || '—';
  const pcode = c.F_PCODE_STRING || c.F_PCODE7_STRING || '';
  // `hex` is the ECU's raw fault word ("F6-88-A6"); `code` is the shorter
  // location byte the DB keys on. The screen shows both, so the report can too.
  return {
    code,
    hex: hex !== code ? hex : '',
    pcode: pcode !== code ? pcode : '',
    name: faultName(c.F_ORT_TEXT, hex, sgbd),
    present,
    ftype,
    count,
  };
}

/**
 * The free-text note attached to the current fault read (INPA "Comment").
 * @type {string}
 */
let faultComment = '';

/**
 * INPA "Comment" (F7): attach a free-text note to the current fault read,
 * stored locally so it shows in the export/print.
 * @param {FaultEcu} ecu - The module.
 * @param {HTMLElement} container - The fault view, to show the note in.
 * @returns {Promise<void>} Resolves once the note is saved or cancelled.
 */
async function addFaultComment(ecu, container) {
  const note = await inputDialog({
    title: 'Add comment',
    kind: 'text',
    body: 'Attach a note to this fault read (e.g. "replaced O2 sensor").',
    example: 'replaced O2 sensor 2026-06',
    confirmLabel: 'Save',
  });
  if (note == null) return;
  faultComment = note;
  const tag = container.querySelector('.fault-comment');
  if (tag) tag.textContent = `Note: ${note}`;
  else {
    const d = document.createElement('div');
    d.className = 'fault-comment';
    d.textContent = `Note: ${note}`;
    container.prepend(d);
  }
  sbLeft.textContent = 'comment saved';
}

/**
 * INPA "Printing" (F9): single-ECU fault report PDF from the last fault
 * read. Native saves through the bridge; the web build prints the shared
 * sheet.
 * @param {FaultEcu} ecu - The module.
 * @param {HTMLElement} view - The current view (unused; kept for the F-key
 *   handler signature).
 * @param {{ viaHotkey?: boolean }} [opts] - Set when Cmd/Ctrl+P routed here.
 * @returns {Promise<void>} Resolves once the export finishes or is refused.
 */
async function exportFaults(ecu, view, opts = {}) {
  const faults = lastFaultRead || [];
  if (!faults.length) {
    // Nothing read yet. An explicit Print (F-key / click) gets the hint; but
    // Cmd+P is the OS print gesture and must never be swallowed into a no-op --
    // the handler already suppressed the native dialog to route here, so hand
    // the user a real print dialog of the current view instead of silence.
    if (
      (opts.viaHotkey || window.__printViaHotkey) &&
      typeof window.print === 'function'
    ) {
      window.print();
      return;
    }
    sbLeft.textContent = 'read codes first';
    return;
  }
  // Web build has no savePdf bridge: print a clean sheet for this one module
  // through the shared helper instead (reuses the whole-car report builder).
  if (!(window.bmacw && window.bmacw.savePdf)) {
    if (typeof printFaultReport === 'function') {
      const present = faults.filter(
        (c) => faultFields(c, ecu.sgbd).present
      ).length;
      printFaultReport(ecu.chassis || '', [{ ecu, codes: faults }], {
        scanned: 1,
        skipped: 0,
        withFaults: 1,
        present,
      });
    } else {
      sbLeft.textContent = 'export unavailable';
    }
    return;
  }

  // load ISTA P-code / name data so the report shows P-codes
  if (typeof loadFaultMeta === 'function') await loadFaultMeta();
  if (typeof loadPcodes === 'function') await loadPcodes();

  const now = new Date();
  const present = faults.filter((c) => faultFields(c, ecu.sgbd).present).length;
  const body = faultModuleBlock(ecu.label, ecu.sgbd, faults);
  const rows = [
    ['Generated', now.toLocaleString()],
    ['Total faults', faults.length],
    ['Present', present],
  ];
  const html = faultReportHtml(
    `${ecu.label} · ${ecu.sgbd}.prg · fault memory`,
    rows,
    body
  );

  const name = `${APP_NAME}-faults-${ecu.sgbd}-${now.toISOString().slice(0, 10)}.pdf`;
  sbLeft.textContent = 'saving…';
  try {
    const res = await window.bmacw.savePdf(name, html);
    sbLeft.textContent =
      res && res.ok
        ? `saved → ${res.path.split('/').pop()}`
        : 'export cancelled';
  } catch (e) {
    sbLeft.textContent = 'export failed';
  }
}

/**
 * One freeze-frame value as shown: long decimals rounded
 * (13.1015625 -> 13.10), the unit appended unless it is the unitless
 * marker. String(): on web the VM hands back live numbers, and the
 * leading-digit test needs a string.
 * @param {unknown} val - F_UWn_WERT.
 * @param {unknown} unit - F_UWn_EINH.
 * @returns {string} The translated value text with its unit.
 */
function envValueText(val, unit) {
  const s = String(val);
  let shown = s;
  const n = parseFloat(s);
  if (isFinite(n) && !Number.isInteger(n) && /^-?\d/.test(s))
    shown = n.toFixed(2);
  const u = unit && String(unit) !== ENV_NO_UNIT ? ` ${unit}` : '';
  return envLabel(String(shown)) + u;
}

/**
 * The environment snapshot the DME captured when the fault was logged (RPM,
 * voltages, engine state, mileage), only present after a detailed read
 * (F_UW*), as [label, value] pairs. Shared by the screen and the printed
 * report so both show the same environment, formatted the same way.
 * @param {FaultEntry} c - The fault entry.
 * @returns {[string, string][]} The pairs; empty without a detailed read.
 */
function envPairs(c) {
  const out = [];
  for (let i = 1; i <= ENV_FIELDS_MAX; i++) {
    const t = c[`F_UW${i}_TEXT`];
    if (t == null) continue;
    const val = c[`F_UW${i}_WERT`];
    if (val == null) continue;
    out.push([envLabel(t), envValueText(val, c[`F_UW${i}_EINH`])]);
  }
  return out;
}

/**
 * The INPA-style environment block for one fault.
 * @param {FaultEntry} c - The fault entry.
 * @returns {string} The block HTML, '' without a snapshot.
 */
function envBlock(c) {
  const rows = envPairs(c).map(
    ([k, v]) =>
      `<div class="inpa-uw"><span class="inpa-uw-k">${esc(k)}</span><span class="inpa-uw-v">${esc(v)}</span></div>`
  );
  if (!rows.length) return '';
  return `<div class="inpa-env"><div class="inpa-env-head">environment: values at code entry</div>${rows.join('')}</div>`;
}

/**
 * INPA fault view: mirrors the "MS45 error memory with environment" screen
 * -- a numbered block per fault with the BMW fault title and MIL state.
 *
 * DRAW THE FIELDS THE ECU ACTUALLY RETURNED, not a fixed OBD template. A
 * DME's FS_LESEN declares F_SYMPTOM/F_READY/F_VORHANDEN/F_WARNUNG; a body
 * module (IHKA46_3) declares none of those -- it reports the fault type in
 * F_ART1..F_ART_ANZ_TEXT instead. Showing the DME labels as "-" on an IHKA
 * both hid its real type field and invented four the module never sends.
 * Each row is emitted only if its result is present.
 * @param {FaultEntry[]|null|undefined} codes - The fault list.
 * @param {HTMLElement} container - The view to draw into.
 * @param {FaultEcu|null|undefined} ecu - The module.
 * @returns {void}
 */
function renderFaultsInpa(codes, container, ecu) {
  const faults = (codes || []).filter((c) => c.F_HEX_CODE || c.F_ORT_NR);
  container.className = 'inpa-faults';
  if (faults.length === 0) {
    container.innerHTML = `<div class="inpa-fault-title">${esc(ecu && ecu.sgbd ? ecu.sgbd.toUpperCase() : 'ECU')} error memory</div>
      <div class="inpa-noerr">No faults stored. Fault memory is clean.</div>`;
    return;
  }
  const total = faults.length;
  const blocks = faults
    .map((c, i) => {
      const hex = hexText(c.F_HEX_CODE);
      const code = bmwCode(c.F_ORT_TEXT, hex);
      // P-code from the ECU's own detailed read only -- no local hex->P mapping.
      const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING || '';
      const ptext = phraseText(c.F_PCODE_TEXT || c.F_PCODE7_TEXT || '');
      const freq = c.F_HFK || c.F_LZ; // how many times seen
      const km = c.F_UW_KM; // mileage at entry
      const { present } = faultFields(c, ecu && ecu.sgbd);
      const has = (k) => c[k] != null && String(c[k]).trim() !== '';
      const row = (label, k, nrKey) =>
        has(k)
          ? `<div class="inpa-ff"><span class="inpa-ff-k">${label}</span><span class="inpa-ff-v">` +
            `${esc(`${nrKey && c[nrKey] != null ? `(${c[nrKey]}) ` : ''}${phraseText(c[k])}`)}</span></div>`
          : '';
      // F_ART1..N: the fault-type list (F_ART_ANZ counts them). "--" entries
      // are the ECU's own "not this type", so drop them.
      const artN = parseInt(c.F_ART_ANZ, 10) || 0;
      const artRows = [];
      for (let a = 1; a <= artN; a++) {
        const t = c[`F_ART${a}_TEXT`];
        if (t != null && String(t).trim() && String(t).trim() !== '--') {
          artRows.push(
            `<div class="inpa-ff"><span class="inpa-ff-k">` +
              `${artRows.length ? '' : 'type of error:'}</span>` +
              `<span class="inpa-ff-v">${esc(phraseText(t))}</span></div>`
          );
        }
      }
      return `
      <div class="inpa-fault">
        <div class="inpa-fault-head">
          <span class="inpa-fault-idx">Error: ${i + 1}(${total})</span>
          <span class="inpa-fault-nr">Nr: ${esc(c.F_ORT_NR || '-')}</span>
          <span class="inpa-fault-name">${esc(faultName(c.F_ORT_TEXT, hexText(c.F_HEX_CODE), ecu && ecu.sgbd) || 'Unknown')}</span>
          ${present ? '<span class="inpa-fault-present">PRESENT</span>' : ''}
          ${freq ? `<span class="inpa-fault-freq">frequency: ${esc(freq)}</span>` : ''}
        </div>
        <div class="inpa-fault-fields">
          ${c.F_SYMPTOM_TEXT != null ? row('type of error:', 'F_SYMPTOM_TEXT', 'F_SYMPTOM_NR') : artRows.join('')}
          ${row('readiness flag:', 'F_READY_TEXT', 'F_READY_NR')}
          ${row('error status:', 'F_VORHANDEN_TEXT', 'F_VORHANDEN_NR')}
          ${row('warning lamp:', 'F_WARNUNG_TEXT', 'F_WARNUNG_NR')}
          ${pstr ? `<div class="inpa-ff"><span class="inpa-ff-k">P-Code:</span><span class="inpa-ff-v mono">${esc(`${pstr}${ptext ? ` - ${ptext}` : ''}`)}</span></div>` : ''}
          <div class="inpa-ff"><span class="inpa-ff-k">F-Code:</span><span class="inpa-ff-v mono">${esc(`${hex || '-'}${code ? `  ·  ${code}` : ''}`)}</span></div>
          ${km ? `<div class="inpa-ff"><span class="inpa-ff-k">entry at km:</span><span class="inpa-ff-v">${esc(km)}</span></div>` : ''}
        </div>
        ${envBlock(c)}
      </div>`;
    })
    .join('');
  container.innerHTML = `<div class="inpa-fault-title">${esc(ecu && ecu.sgbd ? ecu.sgbd.toUpperCase() : 'ECU')} error memory with environment</div>${blocks}`;
}

/**
 * INPA "Detail" (F2): normal read for every fault number, then
 * FS_LESEN_DETAIL per number, merging rich detail onto each. GOTCHA:
 * FS_LESEN_DETAIL needs the fault number as arg; with none it returns
 * nothing (hence "0 codes").
 * @param {FaultEcu} ecu - The module.
 * @param {HTMLElement} container - The view to draw into.
 * @returns {Promise<void>} Resolves once the view is drawn.
 */
async function readFaultsDetailed(ecu, container) {
  loadFaultDb(); // warm the name db while the bus works
  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading fault memory…</span></div>`;
  try {
    // normal read -> fault numbers (via the address group so EDIABAS picks the
    // exact variant)
    const gq = groupQuery(ecu);
    const base = await api(`/api/ecu/${ecu.sgbd}/run/FS_LESEN${gq}`, {
      method: 'POST',
    });
    const faults = dataSets(base.sets).filter(
      (c) => c.F_HEX_CODE || c.F_ORT_NR
    );
    if (!faults.length) {
      renderFaults([], container, ecu);
      sbLeft.textContent = '0 faults';
      return;
    }
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

/**
 * The most recent fault list, for Comment/Print/export.
 * @type {FaultEntry[]}
 */
let lastFaultRead = [];

/**
 * Draw a fault list in the current UI mode. The UI mode is STYLE ONLY --
 * modern must show the same fields INPA mode does, just as a card. A detail
 * row is emitted only when the ECU returned that field (numbered `(NN) text`
 * like INPA), so nothing is invented or hidden.
 * @param {FaultEntry[]|null|undefined} codes - The fault list; only real
 *   fault entries (with a hex/ort code) are drawn, which filters the
 *   telegram/summary sets.
 * @param {HTMLElement} container - The view to draw into.
 * @param {FaultEcu|null|undefined} ecu - The module.
 * @returns {void}
 */
function renderFaults(codes, container, ecu) {
  lastFaultRead = (codes || []).filter((c) => c.F_HEX_CODE || c.F_ORT_NR);
  if (inpaMode()) return renderFaultsInpa(codes, container, ecu);
  container.className = 'faults';
  const faults = (codes || []).filter((c) => c.F_HEX_CODE || c.F_ORT_NR);
  if (faults.length === 0) {
    container.innerHTML = `<div class="empty">
      <div class="empty-big">No stored faults</div>
      <div>The module reported a clean fault memory.</div></div>`;
    return;
  }
  container.innerHTML = '';
  container.className = 'faults stagger';
  faults.forEach((c) => {
    container.appendChild(faultCard(c, ecu));
  });
  stagger(container, 40);
}

/**
 * One fault as a modern card.
 * @param {FaultEntry} c - The fault entry.
 * @param {FaultEcu|null|undefined} ecu - The module.
 * @returns {HTMLElement} The card.
 */
function faultCard(c, ecu) {
  const ff = faultFields(c, ecu && ecu.sgbd);
  const present = ff.present;
  const hex = hexText(c.F_HEX_CODE);
  // prefer the detailed P-code (FS_LESEN_DETAIL) over our static map
  const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING || ff.pcode || '';
  const ptext = phraseText(c.F_PCODE_TEXT || c.F_PCODE7_TEXT || '');
  const warn = phraseText(c.F_WARNUNG_TEXT);
  const freq = c.F_HFK || c.F_LZ;
  const km = c.F_UW_KM;
  const has = (k) => c[k] != null && String(c[k]).trim() !== '';
  const numbered = (k, nrKey) =>
    `${nrKey && c[nrKey] != null ? `(${c[nrKey]}) ` : ''}${phraseText(c[k])}`;
  const detRow = (label, k, nrKey) =>
    has(k)
      ? `<div class="fd-row"><span class="fd-k">${label}</span>` +
        `<span class="fd-v">${esc(numbered(k, nrKey))}</span></div>`
      : '';
  // fault-type: F_SYMPTOM, or the F_ART1..N list (body modules use that)
  const typeText = has('F_SYMPTOM_TEXT')
    ? numbered('F_SYMPTOM_TEXT', 'F_SYMPTOM_NR')
    : faultTypeText(c) || '';
  const rows = [
    typeText
      ? `<div class="fd-row"><span class="fd-k">Type of error</span><span class="fd-v">${esc(typeText)}</span></div>`
      : '',
    detRow('Readiness flag', 'F_READY_TEXT', 'F_READY_NR'),
    detRow('Error status', 'F_VORHANDEN_TEXT', 'F_VORHANDEN_NR'),
    detRow('Warning lamp', 'F_WARNUNG_TEXT', 'F_WARNUNG_NR'),
    ptext
      ? `<div class="fd-row"><span class="fd-k">Meaning</span><span class="fd-v">${esc(ptext)}</span></div>`
      : '',
    `<div class="fd-row"><span class="fd-k">F-Code</span><span class="fd-v mono">${esc(`${hex || '-'}${ff.code ? `  ·  ${ff.code}` : ''}`)}</span></div>`,
    freq
      ? `<div class="fd-row"><span class="fd-k">Frequency</span><span class="fd-v">${esc(freq)}</span></div>`
      : '',
    km
      ? `<div class="fd-row"><span class="fd-k">At mileage</span><span class="fd-v">${esc(km)} km</span></div>`
      : '',
    faultEnvInline(c),
  ]
    .filter(Boolean)
    .join('');
  const el = document.createElement('div');
  el.className = 'fault';
  el.innerHTML = `
      <div class="fault-code">
        <div class="fault-hex">${esc(ff.code)}</div>
        ${pstr ? `<div class="fault-pcode">${esc(pstr)}</div>` : ''}
      </div>
      <div class="fault-main">
        <div class="fault-loc">${esc(ff.name || 'Unknown location')}</div>
        <div class="fault-symptom">${esc(phraseText(c.F_SYMPTOM_TEXT) || faultTypeText(c) || '')}</div>
        ${rows ? `<div class="fault-detail">${rows}</div>` : ''}
      </div>
      <div class="fault-flags">
        ${present ? '<span class="flag present">present</span>' : '<span class="flag">stored</span>'}
        ${warn ? `<span class="flag">${esc(warn)}</span>` : ''}
      </div>`;
  return el;
}

/**
 * Inline environment values for the modern fault card, shown only when a
 * detailed read captured them.
 * @param {FaultEntry} c - The fault entry.
 * @returns {string} The row HTML, '' without a snapshot.
 */
function faultEnvInline(c) {
  const items = [];
  for (let i = 1; i <= ENV_INLINE_MAX; i++) {
    const t = c[`F_UW${i}_TEXT`];
    if (t == null) continue;
    const v = c[`F_UW${i}_WERT`];
    if (v == null) continue;
    items.push(
      `<span class="fd-env"><span class="fd-env-k">${esc(envLabel(t))}:</span> ${esc(envValueText(v, c[`F_UW${i}_EINH`]))}</span>`
    );
  }
  return items.length ? `<div class="fd-env-row">${items.join('')}</div>` : '';
}
