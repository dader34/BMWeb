// fault rendering + German to English translation
const FAULT_PHRASES = [
  // symptom (F_SYMPTOM_TEXT)
  ['kein Signal oder Wert', 'No signal or value'],
  ['Signal oder Wert unterhalb Schwelle', 'Signal or value below threshold'],
  ['Signal oder Wert oberhalb Schwelle', 'Signal or value above threshold'],
  ['Signal oder Wert unplausibel', 'Signal or value implausible'],
  ['Kurzschluss nach Masse', 'Short circuit to ground'],
  ['Kurzschluss nach Plus', 'Short circuit to positive'],
  ['Kurzschluss nach Batterie', 'Short circuit to battery'],
  ['Leitungsunterbrechung', 'Open circuit'],
  ['mechanischer Fehler', 'Mechanical fault'],
  ['elektrischer Fehler', 'Electrical fault'],
  // presence (F_VORHANDEN_TEXT)
  ['Fehler momentan nicht vorhanden, OBD-entprellt', 'Not currently present (OBD-confirmed)'],
  ['Fehler momentan nicht vorhanden, nicht OBD-entprellt', 'Not currently present (not OBD-confirmed)'],
  ['Fehler momentan vorhanden, noch nicht OBD-entprellt', 'Currently present (not yet OBD-confirmed)'],
  ['Fehler momentan vorhanden, nicht OBD-entprellt', 'Currently present (not OBD-confirmed)'],
  ['Fehler momentan vorhanden, OBD-entprellt', 'Currently present (OBD-confirmed)'],
  ['Fehler momentan nicht vorhanden', 'Not currently present'],
  ['Fehler momentan vorhanden', 'Currently present'],
  // warning lamp (F_WARNUNG_TEXT)
  ['Fehler verursacht kein Aufleuchten der Warnlampe (MIL)', 'No MIL'],
  ['Fehler wuerde das Aufleuchten der Warnlampe (MIL) verursachen', 'Would trigger MIL'],
  ['Fehler verursacht das Aufleuchten der Warnlampe (MIL)', 'Triggers MIL'],
  // readiness (F_READY_TEXT)
  ['Testbedingungen erfüllt', 'Test conditions met'],
  ['Testbedingungen nicht erfüllt', 'Test conditions not met'],
];
// German fault/P-code-text word tokens -> English, for phrases not in the exact
// table (e.g. "Luftsystem - Durchsatzfehler erkannt"). order matters: longer
// compounds first so they win before their fragments.
// token-level German -> English, applied in order. multi-word phrases first so
// they win before the single-word tokens below them rewrite a piece.
const DE_TOKENS = [
  // ---- multi-word phrases (must precede their component words) ----
  [/Drehzahlfühler Impulsrad/gi, 'speed sensor reluctor ring'],
  [/periodische Überwachung/gi, 'periodic monitoring'],
  [/CAN Timeout/gi, 'CAN timeout'],
  [/Motormoment nicht einstellbar/gi, 'engine torque not adjustable'],
  [/keine ASC2-Botschaft/gi, 'no ASC2 message'],
  [/keine Antwort/gi, 'no response'],
  [/keine .*?-?Botschaft/gi, 'message missing'],
  [/Kurzschluss gegen Masse/gi, 'short to ground'],
  [/Kurzschluss gegen Plus/gi, 'short to positive'],
  [/Kurzschluss nach Masse/gi, 'short to ground'],
  [/Kurzschluss nach Plus/gi, 'short to positive'],
  [/open circuit Motor oder Relais/gi, 'open circuit, motor or relay'],
  [/Sekundärluftsystem/gi, 'secondary air system'],
  [/Thermischer Ölniveausensor/gi, 'thermal oil level sensor'],
  [/Motorölniveausensor/gi, 'engine oil level sensor'],
  [/Ölniveausensor/gi, 'oil level sensor'],
  [/Durchsatzfehler erkannt/gi, 'flow fault detected'],
  [/Durchsatzfehler/gi, 'flow fault'],
  [/Plausibilitätsfehler/gi, 'plausibility fault'],
  [/unbekannter faultort/gi, 'unknown fault location'],
  [/unbekannter Fehlerort/gi, 'unknown fault location'],
  [/unbekannter Fehler/gi, 'unknown fault'],
  // ---- component nouns ----
  [/Drehzahlfühler/gi, 'speed sensor'], [/Drehzahlsensor/gi, 'speed sensor'],
  [/Lenkwinkel ?[Ss]ensor/gi, 'steering angle sensor'], [/Lenkwinkel/gi, 'steering angle'],
  [/Drucksensor/gi, 'pressure sensor'], [/Druck ?[Ss]ensor/gi, 'pressure sensor'],
  [/Temperatursensor/gi, 'temperature sensor'],
  [/Aussentemperatur|Außentemperatur/gi, 'outside temperature'],
  [/Lichtmodul-EEPROM-Fehler/gi, 'light module EEPROM fault'],
  [/Lichtmodul/gi, 'light module'], [/Lichtmaschine/gi, 'alternator'],
  [/sporadischer Fehler/gi, 'intermittent fault'],
  [/ungültiger Arbeitsbereich|ungueltiger Arbeitsbereich/gi, 'invalid operating range'],
  [/keine CAN ID/gi, 'no CAN ID'], [/CAN ID/gi, 'CAN ID'],
  [/momentan vorhanden/gi, 'currently present'], [/nicht vorhanden/gi, 'not present'],
  [/Sitzheizung/gi, 'seat heating'],
  [/Spritzdüsenheizung|Spritzduesenheizung/gi, 'washer jet heater'],
  [/Spritzdüse|Spritzduese/gi, 'washer jet'],
  [/Linke\b/gi, 'left'], [/Rechte\b/gi, 'right'], [/Linker\b/gi, 'left'], [/Rechter\b/gi, 'right'],
  [/Geblaesesteuerspannung/gi, 'blower control voltage'], [/Gebläse/gi, 'blower'],
  [/Fensterheber/gi, 'window lift'], [/Zentralverriegelung/gi, 'central locking'],
  [/Beifahrerspiegel/gi, 'passenger mirror'], [/Fahrerspiegel/gi, 'driver mirror'],
  [/Beifahrerseite/gi, 'passenger side'], [/Fahrerseite/gi, 'driver side'],
  [/Potentiometer/gi, 'potentiometer'], [/Achse/gi, 'axis'],
  [/Sicherung/gi, 'fuse'], [/Relais/gi, 'relay'], [/Motor/gi, 'motor'],
  [/Schlüssel|Schluessel/gi, 'key'], [/Toleranz/gi, 'tolerance'], [/erhöht|erhoeht/gi, 'increased'],
  [/Impulsrad/gi, 'reluctor ring'], [/Überwachung|Ueberwachung/gi, 'monitoring'],
  [/\bNummer\b/gi, 'number'], [/\bbei\b/gi, 'at'], [/\boder\b/gi, 'or'],
  [/Luftsystem/gi, 'air system'], [/Luftmasse/gi, 'air mass'],
  [/Kraftstoffsystem/gi, 'fuel system'], [/Zündsystem/gi, 'ignition system'],
  [/Generator/gi, 'alternator'], [/Lichtmaschine/gi, 'alternator'],
  [/Botschaft/gi, 'message'], [/Antwort/gi, 'response'],
  // ---- generic tokens ----
  [/Übertemperatur/gi, 'over-temperature'], [/Untertemperatur/gi, 'under-temperature'],
  [/Leitungsunterbrechung/gi, 'open circuit'], [/Unterbrechung/gi, 'open circuit'],
  [/Kurzschluss/gi, 'short circuit'],
  [/unterhalb Schwelle/gi, 'below threshold'], [/oberhalb Schwelle/gi, 'above threshold'],
  [/hinten rechts/gi, 'rear right'], [/hinten links/gi, 'rear left'],
  [/vorne rechts/gi, 'front right'], [/vorne links/gi, 'front left'],
  [/rechts/gi, 'right'], [/links/gi, 'left'], [/hinten/gi, 'rear'], [/vorne/gi, 'front'],
  [/periodische/gi, 'periodic'], [/implausible/gi, 'implausible'], [/falsch/gi, 'wrong'],
  [/keine/gi, 'no'], [/gegen Masse/gi, 'to ground'], [/Masse/gi, 'ground'],
  [/unplausibel/gi, 'implausible'], [/erkannt/gi, 'detected'],
  [/Signal/gi, 'signal'], [/Fehler/gi, 'fault'], [/frei/gi, 'free'],
];
function deGerman(text) {
  if (!text) return text;
  if (lang() === 'orig') return text; // keep German in EDIABAS mode
  let t = text;
  for (const [de, en] of FAULT_PHRASES) if (t === de) return en;
  // token-level fallback for partial/unlisted phrases (P-code text, etc.)
  let out = t;
  for (const [re, en] of DE_TOKENS) out = out.replace(re, en);
  return out;
}

// environment-measurement labels (F_UW*_TEXT) German -> English. skipped when
// Original (EDIABAS) labels are set.
const ENV_LABELS = {
  'Motordrehzahl': 'Engine RPM',
  'Lichtmaschine Sollspannung': 'Alternator target voltage',
  'Spannung Kl.87': 'Terminal 87 voltage',
  'Spannung Kl.30': 'Terminal 30 voltage (battery)',
  'Status Motorsteuerung': 'Engine management status',
  'Motor Status': 'Engine status',
  'Motortemperatur': 'Engine temperature',
  'Motortemperatur beim Start': 'Engine temp at start',
  '(Motor) - Öltemperatur': 'Engine oil temperature',
  'Öltemperatur': 'Oil temperature',
  'Kühlmitteltemperatur': 'Coolant temperature',
  'Ansauglufttemperatur': 'Intake air temperature',
  'Umgebungstemperatur': 'Ambient temperature',
  'Umgebungsdruck': 'Ambient pressure',
  'Ladedruck': 'Boost pressure',
  'Last': 'Engine load',
  'Fahrgeschwindigkeit': 'Vehicle speed',
  'Batteriespannung': 'Battery voltage',
  'Zündwinkel': 'Ignition angle',
  'Lambdawert': 'Lambda value',
  'Saugrohrdruck': 'Manifold pressure',
  'Differenz zwischen Maximum und Minimum SAF': 'Max-min difference, secondary air mass',
  'Mittlere Diagnosewert minimale Luftmasse': 'Mean diagnostic value, minimum air mass',
  'Sekundärluftmasse': 'Secondary air mass',
  'minimale Luftmasse': 'Minimum air mass',
};
// value-phrase fragments seen in F_UW*_WERT (engine-state enums etc.)
const ENV_VALUE_PHRASES = [
  [/Motor steht/gi, 'engine stopped'],
  [/Motor im Leerlauf/gi, 'engine idling'],
  [/Motor l[äa]uft/gi, 'engine running'],
  [/Sy?nchronisiert und Z[üu]ndung ein/gi, 'synchronized, ignition on'],
  [/Z[üu]ndung ein/gi, 'ignition on'],
  [/Z[üu]ndung aus/gi, 'ignition off'],
  [/^(\d+)\s+[EI]S\s*-\s*/, '$1 '],  // strip the "N ES -" / "N IS -" state-code prefix
];
// German measurement-word tokens, for compound labels not in the exact map
const ENV_TOKENS = [
  [/Motortemperatur/gi, 'engine temp'], [/Öltemperatur/gi, 'oil temp'],
  [/temperatur/gi, 'temperature'], [/Spannung/gi, 'voltage'], [/Drehzahl/gi, 'RPM'],
  [/Luftmasse/gi, 'air mass'], [/Sekundärluft/gi, 'secondary air'], [/Druck/gi, 'pressure'],
  [/Diagnosewert/gi, 'diagnostic value'], [/Differenz zwischen/gi, 'difference between'],
  [/Maximum und Minimum/gi, 'max and min'], [/Mittlere?r?/gi, 'mean'],
  [/minimale?/gi, 'minimum'], [/Status/gi, 'status'], [/Motor\b/gi, 'engine'],
  [/Sollspannung/gi, 'target voltage'], [/Umgebung/gi, 'ambient'],
  [/beim Start/gi, 'at start'], [/Lichtmaschine/gi, 'alternator'],
];
// translate an env label or value phrase, gated on Settings language
function envLabel(text) {
  if (lang() === 'orig' || !text) return text;
  const s = String(text).trim();
  if (ENV_LABELS[s]) return ENV_LABELS[s];
  // value phrases (engine-state enums)
  let out = s;
  for (const [re, en] of ENV_VALUE_PHRASES) out = out.replace(re, en);
  if (out !== s) return out.replace(/\s{2,}/g, ' ').trim();
  // token fallback for unmapped compound labels: translate German word parts
  if (/[A-Za-zÄÖÜäöü]/.test(s)) {
    let t = s;
    for (const [re, en] of ENV_TOKENS) t = t.replace(re, en);
    if (t !== s) return t.replace(/\s{2,}/g, ' ').trim();
  }
  return text;
}

// BMW hex DTC and location text carry BMW's own fault number (e.g. 27DA, 2761).
// map the common ones to OBD-II P-codes; only show a P-code with a real mapping
// (no fabricated codes).
const PCODE_MAP = {
  '2761': 'P0410',  // secondary air system
  '27C3': 'P2563',  // oil level sensor (thermal)
  '27DA': 'P1734',  // BSD bus / alternator comms (BMW-specific)
  '27C2': 'P2562',
  '27C4': 'P2564',
};
// BMW fault number = first token of F_ORT_TEXT ("27DA BSD-Generator" -> 27DA)
function bmwCode(loc, hex) {
  if (loc) { const m = loc.match(/^([0-9A-F]{3,5})\b/i); if (m) return m[1].toUpperCase(); }
  if (hex) return hex.replace(/-/g, '').slice(0, 4).toUpperCase();
  return null;
}
function pCode(loc, hex) {
  const code = bmwCode(loc, hex);
  return code && PCODE_MAP[code] ? PCODE_MAP[code] : null;
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
function exportFaults(ecu, view) {
  const faults = lastFaultRead || [];
  if (!faults.length) { sbLeft.textContent = 'read codes first'; return; }
  if (!(window.bmacw && window.bmacw.startLog)) { sbLeft.textContent = 'export unavailable'; return; }

  // Build the column set. Environment columns only appear if a detailed read
  // captured them (so the header matches the data).
  const hasEnv = faults.some(c => c.F_UW1_TEXT);
  const header = [
    'index', 'fault_nr', 'location', 'f_code', 'bmw_code', 'p_code', 'p_code_text',
    'type_of_error', 'error_status', 'readiness', 'warning_lamp', 'frequency', 'entry_km',
  ];
  if (hasEnv) for (let i = 1; i <= 4; i++) header.push(`env${i}_name`, `env${i}_value`, `env${i}_unit`);

  const name = `bmacw-faults-${ecu.sgbd}-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
  window.bmacw.startLog(name, header).then(res => {
    if (!res || !res.ok) { sbLeft.textContent = 'export cancelled'; return; }
    faults.forEach((c, i) => {
      const hex = c.F_HEX_CODE || '';
      const row = [
        i + 1,
        c.F_ORT_NR || '',
        c.F_ORT_TEXT || '',
        hex,
        bmwCode(c.F_ORT_TEXT, hex) || '',
        c.F_PCODE_STRING || pCode(c.F_ORT_TEXT, hex) || '',
        deGerman(c.F_PCODE_TEXT || ''),
        `${c.F_SYMPTOM_NR ? `(${c.F_SYMPTOM_NR}) ` : ''}${deGerman(c.F_SYMPTOM_TEXT) || ''}`,
        `${c.F_VORHANDEN_NR ? `(${c.F_VORHANDEN_NR}) ` : ''}${deGerman(c.F_VORHANDEN_TEXT) || ''}`,
        `${c.F_READY_NR ? `(${c.F_READY_NR}) ` : ''}${deGerman(c.F_READY_TEXT) || ''}`,
        `${c.F_WARNUNG_NR ? `(${c.F_WARNUNG_NR}) ` : ''}${deGerman(c.F_WARNUNG_TEXT) || ''}`,
        c.F_HFK || c.F_LZ || '',
        c.F_UW_KM || '',
      ];
      if (hasEnv) for (let j = 1; j <= 4; j++) {
        row.push(envLabel(c[`F_UW${j}_TEXT`] || ''), envLabel(String(c[`F_UW${j}_WERT`] ?? '')), c[`F_UW${j}_EINH`] || '');
      }
      window.bmacw.appendLog(res.id, row);
    });
    window.bmacw.stopLog(res.id);
    sbLeft.textContent = `saved → ${res.path.split('/').pop()}`;
  });
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
    rows.push(`<div class="inpa-uw"><span class="inpa-uw-k">${envLabel(t)}</span><span class="inpa-uw-v">${envLabel(String(shown))}${u}</span></div>`);
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
    container.innerHTML = `<div class="inpa-fault-title">${ecu && ecu.sgbd ? ecu.sgbd.toUpperCase() : 'ECU'} error memory</div>
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
    const present = (c.F_VORHANDEN_TEXT || '').toLowerCase().includes('momentan vorhanden')
      && !(c.F_VORHANDEN_TEXT || '').toLowerCase().includes('nicht vorhanden');
    return `
      <div class="inpa-fault">
        <div class="inpa-fault-head">
          <span class="inpa-fault-idx">Error: ${i + 1}(${total})</span>
          <span class="inpa-fault-nr">Nr: ${c.F_ORT_NR || '-'}</span>
          <span class="inpa-fault-name">${faultName(c.F_ORT_TEXT, c.F_HEX_CODE) || 'Unknown'}</span>
          ${present ? '<span class="inpa-fault-present">PRESENT</span>' : ''}
          ${freq ? `<span class="inpa-fault-freq">frequency: ${freq}</span>` : ''}
        </div>
        <div class="inpa-fault-fields">
          <div class="inpa-ff"><span class="inpa-ff-k">type of error:</span><span class="inpa-ff-v">${c.F_SYMPTOM_NR ? `(${c.F_SYMPTOM_NR}) ` : ''}${sym || '-'}</span></div>
          <div class="inpa-ff"><span class="inpa-ff-k">readiness flag:</span><span class="inpa-ff-v">${c.F_READY_NR ? `(${c.F_READY_NR}) ` : ''}${ready || '-'}</span></div>
          <div class="inpa-ff"><span class="inpa-ff-k">error status:</span><span class="inpa-ff-v">${c.F_VORHANDEN_NR ? `(${c.F_VORHANDEN_NR}) ` : ''}${status || '-'}</span></div>
          <div class="inpa-ff"><span class="inpa-ff-k">warning lamp:</span><span class="inpa-ff-v">${c.F_WARNUNG_NR ? `(${c.F_WARNUNG_NR}) ` : ''}${warn || '-'}</span></div>
          ${pstr ? `<div class="inpa-ff"><span class="inpa-ff-k">P-Code:</span><span class="inpa-ff-v mono">${pstr}${ptext ? ` - ${ptext}` : ''}</span></div>` : ''}
          <div class="inpa-ff"><span class="inpa-ff-k">F-Code:</span><span class="inpa-ff-v mono">${hex || '-'}${code ? `  ·  ${code}` : ''}</span></div>
          ${km ? `<div class="inpa-ff"><span class="inpa-ff-k">entry at km:</span><span class="inpa-ff-v">${km}</span></div>` : ''}
        </div>
        ${envBlock(c)}
      </div>`;
  }).join('');
  container.innerHTML = `<div class="inpa-fault-title">${ecu && ecu.sgbd ? ecu.sgbd.toUpperCase() : 'ECU'} error memory with environment</div>${blocks}`;
}

// INPA "Detail" (F2): normal read to get every fault number, then FS_LESEN_DETAIL
// per number, merging rich detail (P-code, frequency, mileage, environment) onto
// each. FS_LESEN_DETAIL needs the fault number as arg; with none it returns
// nothing (hence "0 codes").
async function readFaultsDetailed(ecu, container) {
  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading fault memory…</span></div>`;
  try {
    // 1) normal read -> fault numbers
    const base = await api(`/api/ecu/${ecu.sgbd}/run/FS_LESEN`, { method: 'POST' });
    const faults = (base.sets || []).slice(1).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
    if (!faults.length) { renderFaults([], container, ecu); sbLeft.textContent = '0 faults'; return; }
    // 2) per-fault detail, merged onto the base entry
    container.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading detail for ${faults.length} fault(s)…</span></div>`;
    await fillFaultDetail(ecu.sgbd, faults);
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
    const present = (c.F_VORHANDEN_TEXT || '').toLowerCase().includes('momentan vorhanden')
      && !(c.F_VORHANDEN_TEXT || '').toLowerCase().includes('nicht vorhanden');
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
        <div class="fault-hex">${hex || c.F_ORT_NR || '-'}</div>
        ${pstr ? `<div class="fault-pcode">${pstr}</div>` : ''}
      </div>
      <div class="fault-main">
        <div class="fault-loc">${faultName(c.F_ORT_TEXT, c.F_HEX_CODE) || 'Unknown location'}</div>
        <div class="fault-symptom">${deGerman(c.F_SYMPTOM_TEXT) || ''}</div>
        ${detailed ? `
          <div class="fault-detail">
            ${ptext ? `<div class="fd-row"><span class="fd-k">Meaning</span><span class="fd-v">${ptext}</span></div>` : ''}
            <div class="fd-row"><span class="fd-k">Status</span><span class="fd-v">${deGerman(c.F_VORHANDEN_TEXT) || '-'}</span></div>
            ${freq ? `<div class="fd-row"><span class="fd-k">Frequency</span><span class="fd-v">${freq}</span></div>` : ''}
            ${km ? `<div class="fd-row"><span class="fd-k">At mileage</span><span class="fd-v">${km} km</span></div>` : ''}
            ${faultEnvInline(c)}
          </div>` : ''}
      </div>
      <div class="fault-flags">
        ${present ? '<span class="flag present">present</span>' : '<span class="flag">stored</span>'}
        ${warn ? `<span class="flag">${warn}</span>` : ''}
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
    items.push(`<span class="fd-env"><span class="fd-env-k">${envLabel(t)}:</span> ${envLabel(String(shown))}${unit}</span>`);
  }
  return items.length ? `<div class="fd-env-row">${items.join('')}</div>` : '';
}

// ---------- settings screen ----------
