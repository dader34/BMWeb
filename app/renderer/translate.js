// German → English translation tables and helpers, shared across the renderer
// (faults.js rendering, ecu.js job labels, live.js measurement keys). Pure
// lookup/rewrite logic — no DOM. All translation is gated on the Settings
// language (lang() === 'orig' keeps the raw German for EDIABAS-faithful mode).
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
  // ---- job-name verbs/nouns (humanized SGBD job names, e.g. "Flash Crc Pruefen") ----
  [/\bPruefen\b|\bPrüfen\b/gi, 'Check'], [/\bLesen\b/gi, 'Read'],
  [/\bSchreiben\b/gi, 'Write'], [/\bSetzen\b/gi, 'Set'], [/\bLoeschen\b|\bLöschen\b/gi, 'Clear'],
  [/\bSteuern\b/gi, 'Activate'], [/\bSignatur\b/gi, 'Signature'],
  [/\bBlocklaenge\b|\bBlocklänge\b/gi, 'Block length'], [/\bZeiten\b/gi, 'Times'],
  // ---- job-argument dialog terms (from the SGBD _ARGUMENTS schema) ----
  [/Datum der SG-Programmierung/gi, 'date of ECU programming'],
  [/Zusammenbaunummer/gi, 'assembly number'],
  [/Datensatznummer/gi, 'dataset number'], [/Softwarenummer/gi, 'software number'],
  [/Behoerdennummer|Behördennummer/gi, 'authority number'],
  [/Haendlernummer|Händlernummer/gi, 'dealer number'],
  [/Fahrgestellnummer/gi, 'chassis number (VIN)'],
  [/Tester Seriennummer/gi, 'tester serial number'],
  [/Seriennummer/gi, 'serial number'],
  [/Zeit in Sekunden/gi, 'time in seconds'],
  [/Einschaltzeit/gi, 'on-time'], [/Periodendauer/gi, 'period'],
  [/Tastverhältnis|Tastverhaeltnis/gi, 'duty cycle'],
  [/Abgleichs?wert/gi, 'adjustment value'], [/rueckwaerts|rückwärts/gi, 'backwards'],
  [/Sollwert/gi, 'target value'],
  [/ohne Argument/gi, 'without argument'], [/Wechsel/gi, 'toggle'],
  [/Klima und Fahrbedingung/gi, 'A/C and driving condition'],
  [/mit Klimaanlage/gi, 'with A/C'], [/mit Fahrstufe/gi, 'with gear engaged'],
  [/niedriger UBatt/gi, 'low battery voltage'],
  [/Ein=1 Aus=0|1=Ein 0=Aus|1=Ein, 0=Aus/gi, '1=on 0=off'],
  [/\bEin\b/gi, 'on'], [/\bAus\b/gi, 'off'], [/\bZeit\b/gi, 'time'],
  [/\bDauer\b/gi, 'duration'], [/\bFaktor\b/gi, 'factor'], [/\bbis\b/gi, 'to'],
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
// memoized: the token pass runs ~120 regexes per string and fault renders /
// sweeps hit the same strings repeatedly. capped to bound memory.
const _deCache = new Map();
function deGerman(text) {
  if (!text) return text;
  if (lang() === 'orig') return text; // keep German in EDIABAS mode
  if (_deCache.has(text)) return _deCache.get(text);
  let out = null;
  for (const [de, en] of FAULT_PHRASES) if (text === de) { out = en; break; }
  if (out === null) {
    // token-level fallback for partial/unlisted phrases (P-code text, etc.)
    out = text;
    for (const [re, en] of DE_TOKENS) out = out.replace(re, en);
  }
  if (_deCache.size > 5000) _deCache.clear();
  _deCache.set(text, out);
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
