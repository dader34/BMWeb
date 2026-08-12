// Coding: read what a module is coded to, and stage changes to it. For the
// SGBDs that name their own coding values, CODIERUNG_LESEN returns named
// results (not a blob); tools/decompile/coding_map.py mines those into
// data/codingmap.js and this draws them.
//
// WRITES ARE BLOCKED. The editor stages a change and shows exactly what would
// be sent -- and stops there. A coding write is an EEPROM write; get it wrong
// on a module that gates the immobiliser or airbags and the car does not
// start, or worse. Arming needs a verified round-trip on a recoverable car,
// which has not happened, so the send path deliberately does not exist rather
// than sitting behind a confirm dialog a wrong keypress could clear.

// Coding vocabulary: ONE dictionary translating both the result NAME and BMW's
// German comment. Deliberately NOT deGerman() -- that table is tuned for fault
// prose and half-translates this vocabulary ("Offset auf Mindestdruck" ->
// "Offset up Mindestdruck", because `auf` is "up" in prose, "on" here).
// Longest match must win: German glues nouns together (KALTUEBERWACHUNG is one
// word, not KALT + UEBERWACHUNG) or the parts translate into nonsense.
const COD_VOCAB = {
  FH: 'windows', FENSTERHEBER: 'windows', SHD: 'sunroof', ZV: 'central locking',
  ZAV: 'central locking', DWA: 'alarm', BC: 'on-board computer',
  KOMBI: 'instrument cluster', DME: 'engine ECU', EGS: 'transmission ECU',
  EKS: 'seat module', IHKA: 'climate control', KLR: 'climate control',
  RLS: 'rain sensor', LWR: 'headlight aim', ASP: 'mirror', FB: 'remote',
  FERNBEDIENUNG: 'remote', SITZHEIZUNG: 'seat heating', GURTWARNUNG: 'belt warning',
  NEIGUNGSGEBER: 'tilt sensor', BLS: 'brake light switch', IB: 'interior light',
  STANDLICHT: 'side light', SL: 'side light', ABBLENDLICHT: 'low beam',
  AL: 'low beam', FERNLICHT: 'high beam', FL: 'high beam',
  BREMSLICHT: 'brake light', BL: 'brake light', BREMSLICHTSCHALTER: 'brake light switch',
  NEBELSCHLUSSLICHT: 'rear fog light', NSL: 'rear fog light',
  NEBELSCHEINWERFER: 'front fog light', NSW: 'front fog light',
  KENNZEICHENLICHT: 'plate light', KZL: 'plate light',
  RUECKLICHT: 'tail light', RUECKFAHRSCHEINWERFER: 'reversing light',
  RFS: 'reversing light', BLINKER: 'indicator', WARNBLINKER: 'hazards',
  INNENLICHT: 'interior light', LICHT: 'light',
  TUER: 'door', FAHRERTUER: 'driver door', BEIFAHRERTUER: 'passenger door',
  SCHEIBE: 'window', SCHEIBEN: 'windows', FENSTER: 'window',
  HECKSCHEIBE: 'rear window', HECK: 'tailgate', KOFFERRAUM: 'boot',
  MOTORHAUBE: 'bonnet', SITZ: 'seat', SPIEGEL: 'mirror',
  LENKRAD: 'steering wheel', TANK: 'fuel tank', RAD: 'wheel',
  VK: 'convertible top', CABRIO: 'convertible', TUEREN: 'doors',
  FAHRZEUG: 'vehicle', SCHLOSS: 'lock', SCHLOESSER: 'locks',
  SIGNAL: 'signal', SIGNALE: 'signals', HECKKLAPPE: 'tailgate',
  HECKKLAPPEN: 'tailgate', SCHWEIZ: 'Switzerland', SEPERAT: 'separate',
  SEPARAT: 'separate', ALARMVARIANTE: 'alarm variant', KL15: 'terminal 15',
  BATT: 'battery', SENSOR: 'sensor', DIFF: 'difference', RES: 'reserve',
  STANDHEIZUNG: 'auxiliary heating', KOMPRESSORAUSTAKTUNG: 'compressor cut-out',
  FILTER: 'filter',
  WISCHER: 'wiper', SCHEIBENWISCHER: 'wiper', OPTISCHEM: 'visual',
  SCHIEF: 'skewed', HOEHE: 'height', AUSWERTUNG: 'evaluation',
  VERSCHLEISSFAKTOR: 'wear factor', DERZEIT: 'currently',
  DATENSICHERUNGSBYTE: 'data backup byte', SCHALTGETRIEBE: 'manual gearbox',
  TEMPERATUREINHEIT: 'temperature unit', CODIERUNG: 'coding',
  LENKUNG: 'steering', SCHALTSCHWELLE: 'switching threshold',
  GESCHWINDIGKEITSWARNUNG: 'speed warning', SCHLUESSELWARNUNG: 'key warning',
  LICHTWARNUNG: 'light warning', ZUNDSCHLUESSELWARNUNG: 'ignition key warning',
  SCHWELLWERT: 'threshold', WARTEZEIT: 'wait time', RAEDER: 'wheels',
  HINTERACHSUEBERSETZUNG: 'rear axle ratio', GESCHW: 'speed',
  INDIVIDUALISIERUNG: 'individualisation', VERRIEGELUNG: 'locking',
  PLAUSIBILITAETSABFRAGE: 'plausibility check', BLINKZYKLUS: 'flash cycle',
  ANLERNEN: 'teach-in', LERNEN: 'learn', RUECKSTELLUNG: 'reset',
  ABSCHALTZEIT: 'switch-off time', NACHLAUF: 'run-on', VORLAUF: 'lead',
  SCHLUESSEL: 'key', ZUENDSCHLUESSEL: 'ignition key', WEGFAHRSPERRE: 'immobiliser',
  DREHZAHL: 'engine speed', VERBRAUCH: 'consumption', REICHWEITE: 'range',
  AUSSENTEMPERATUR: 'outside temperature', KUEHLMITTEL: 'coolant',
  GESCHWINDIGKEIT_EINHEIT: 'speed unit', HUPE: 'horn', SIRENE: 'siren',
  INNENRAUM: 'interior', UEBERWACHUNGSZEIT: 'monitoring time',
  FUNKINNENRAUMSCHUTZ: 'radar interior protection',
  ULTRASCHALLINNENRAUMSCHUTZ: 'ultrasonic interior protection',
  TUERE: 'door', ZENTRALSCHALTER: 'central switch',
  AUTOMATISCHEM: 'automatic', AUTOMATISCH: 'automatic',
  ANTRIEBSMOMENTENREGELUNG: 'drive torque control',
  BREMSMOMENTENREGELUNG: 'brake torque control',
  BREMSKRAFTVERTEILUNG: 'brake force distribution',
  HYDRAULISCHE: 'hydraulic', SCHLUPFSCHWELLENOFFSET: 'slip threshold offset',
  INTERMETIEREND: 'intermittent', INTERMITTIEREND: 'intermittent',
  OEFFNET: 'opens', SCHLIESST: 'closes',
  SCHEIBENABSENKUNG: 'window drop', SPERREN: 'inhibit', GESPERRT: 'inhibited',
  KOMFORTSCHLIESSEN: 'comfort close', KOMFORTOEFFNEN: 'comfort open',
  ZENTRAL: 'central', ZENTRALVERRIEGELUNG: 'central locking',
  FT: 'driver', BT: 'passenger',
  MOTORVARIANTE: 'engine variant', FRONTSCHEIBE: 'windscreen',
  EINSCHALT: 'switch-on', AUSSCHALT: 'switch-off', HYSTERESE: 'hysteresis',
  NACHLAUFZEIT: 'run-on time', RUECKMELDUNG: 'feedback',
  BLINKEN: 'flashing', ZUSTAND: 'state', BETRIEB: 'operation',
  ANSCHALTUNG: 'activation', ABSCHALTSCHWELLE: 'switch-off threshold',
  EINSCHALTSCHWELLE: 'switch-on threshold', MOTORTYP: 'engine type',
  GETRIEBE: 'gearbox', ACHSE: 'axle', HINTERACHSE: 'rear axle',
  TEILENUMMER: 'part number', FAHRGESTELLNUMMER: 'chassis number',
  TYPENCODE: 'type code', HARDWARESTAND: 'hardware level',
  AENDERUNGSINDEX: 'revision index', LAENDERCODE: 'country code',
  LAENDERCODIERUNG: 'country coding', KOMBIS: 'cluster',
  SKALENENDWERT: 'scale end value', TACHOMETERS: 'speedometer',
  GRENZDREHZAHL: 'rev limit', DREHZAHLGRENZE: 'rev limit',
  WEGSTRECKEN: 'distance', WEGSTRECKENZAEHLER: 'odometer',
  WEGIMPULSZAHL: 'road-pulse count', WEGEIMPULSE: 'road pulses',
  ZAHL: 'number', VERBRAUCHS: 'consumption', GESCHWINDIGKEITS: 'speed',
  SPRACHVARIANTE: 'language variant', TANKINHALT: 'tank capacity',
  MAXIMALER: 'maximum', MAXIMALE: 'maximum', TANKGEBERS: 'tank sender',
  OELTEMPERATUR: 'oil temperature', ZEITINSPEKTION: 'time service',
  OELSERVICEINTERVALLE: 'oil service intervals',
  OELINSPEKTIONSINTERVALLE: 'oil service intervals',
  CHECKCONTROL: 'check control', HUPENALARM: 'horn alarm',
  GONG: 'chime', ANSTEUERBAR: 'can be driven', SIA: 'service interval',
  MOTORSTART: 'engine start', STUNDENBASIS: 'hour format',
  MEILEN: 'miles', ZYLINDERANZAHL: 'cylinder count',
  ZYLINDERZAHL: 'cylinder count', DIVISION: 'division', DURCH: 'by',
  EINSPRITZKENNLINIE: 'injection curve', EINSPITZKENNLINIE: 'injection curve',
  GRUNDMERKMALESCHLUESSEL: 'basic-feature key',
  ANTRIEBSMERKMALESCHLUESSEL: 'drivetrain-feature key',
  SONDERAUSSTATTUNGSSCHLUESSEL: 'optional-equipment key',
  VERSIONSNUMMERNSCHLUESSEL: 'version-number key',
  AUSSTAUSCHKOMBI: 'replacement cluster', EEPROM: 'EEPROM',
  DATUM: 'date', JAHR: 'year', TAGE: 'days', UHR: 'clock',
  INNENBELEUCHTUNG: 'interior light', GESAMTWEG: 'total travel',
  EMPFINDLICHKEIT: 'sensitivity', ENTSICHERN: 'unlock',
  SCHEIBENUEBERWACHUNG: 'window monitoring', SCHUTZ: 'protection',
  TUERSCHLOSSHEIZUNG: 'door-lock heating', INTERVALLTON: 'intermittent tone',
  GENERELL: 'generally', BLITZT: 'flashes', BLITZ: 'flash',
  LEUCHTET: 'steady', PANICMODUS: 'panic mode',
  DIEBSTAHLWARNANLAGE: 'anti-theft alarm', FUNKFERNBEDIENUNG: 'radio remote',
  INFRAROT: 'infrared', KOMFORTOEFFNUNG: 'comfort open',
  KOMFORTSCHLIESSUNG: 'comfort close', SELEKTIV: 'selective',
  HEULTON: 'wail tone', ELEKTRISCHE: 'electric',
  AUSSTELLFENSTER: 'pop-out window', SCHEINWERFERREINIGUNGSANLAGE: 'headlight washer',
  SCHLUESSELNUMMER: 'key number', WECHSEL: 'change',
  GESCHAERFT: 'armed', FESTCODE: 'fixed code', WECHSELCODE: 'rolling code',
  CODIERTES: 'coded', STATISCHES: 'static', SCHNITTSTELLE: 'interface',
  DUMMYERGEBNIS: 'dummy result', IMMER: 'always',
  ANHAENGER: 'trailer', ANHAENGERLICHT: 'trailer light',
  PARKLICHT: 'parking light', STANDLICHTAUSFALL: 'side-light failure',
  ERSATZFUNKTION: 'substitute function', BEDIMMTE: 'dimmed',
  BETRIEBSSTUNDENZAEHLERLOESCHUNG: 'hour-counter reset',
  LAMPENWECHSEL: 'bulb change', WARNBLINKEN: 'hazard flashing',
  MITTE: 'centre', BLK: 'indicator', ZYKLUSZEIT: 'cycle time',
  ABSCHALTET: 'switches off', VOLT: 'volt',
  ABKLAPP: 'fold', ABKLAPPEN: 'fold', SPIEGELHEIZEN: 'mirror heating',
  PERMANENTES: 'permanent', INVERTIERT: 'inverted', INVERTIERTER: 'inverted',
  LENKSAEULENVERSTELLSCHALTER: 'steering-column adjust switch',
  TIPPTASTENBETRIEB: 'momentary-switch mode', FREI: 'free',
  AKTIVSITZ: 'active seat', SONNENROLLO: 'sun blind',
  UMKEHRZEIT: 'reversal time', VERDECKMOTOR: 'roof motor',
  KLAPPE: 'flap', MOTORHAUBENKONTAKTE: 'bonnet contacts',
  REIFENTOLERANZABGLEICH: 'tyre tolerance calibration',
  BREMSWARNLEUCHTE: 'brake warning lamp', AUSGABE: 'output',
  AKTIVER: 'active', PASSIVER: 'passive', BENZIN: 'petrol',
  AUTOMATIK: 'automatic', HANDSCHALTUNG: 'manual',
  SPERRDIFFERENTIAL: 'limited-slip differential',
  BUSINDEX: 'bus index', CHECKSUMME: 'checksum',
  AUSFEDERWEG: 'rebound travel', EINFEDERWEG: 'compression travel',
  DREHSINN: 'rotation direction', KONSTANTEN: 'constants',
  HEBEN: 'raise', FAHRT: 'drive', VERZOEG: 'delay',
  SOLLGESCHWINDIGKEIT: 'target speed', ZEIGER: 'pointer',
  KODIERDATENSAETZE: 'coding data sets', CODIERDATENSATZ: 'coding data set',
  CODIERINDEX: 'coding index', DATENSATZNUMMER: 'data set number',
  LAUT: 'per', GEBERRAD: 'sensor wheel', KURBELWELLE: 'crankshaft',
  EINZULERNEN: 'to teach in', LINIE: 'line',
  REGELPARAMETER: 'control parameter', EINSATZPUNKT: 'onset point',
  REGELUNG: 'control', BESTIMMT: 'determines', DIESER: 'this',
  ANSPRECHZEIT: 'response time', ABGESCHALTEN: 'switched off',
  ABGEFRAGT: 'polled', KOMMT: 'arrives', GUELTIGER: 'valid',
  SEKUNDEN: 'seconds', SEK: 's', ENTSPRICHT: 'equals',
  DREHWINKEL: 'rotation angle', LEERLAUFANHEBUNG: 'idle raise',
  KLIMAKOMPRESSOR: 'A/C compressor', SENSORIK: 'sensors',
  STEUERGERAET: 'control unit', ALLGEMEIN: 'general',
  UNTERSPANNUNG: 'undervoltage', VARIABEL: 'variable',
  FUSS: 'footwell', FOND: 'rear', UNABHAENGIGER: 'independent',
  REGENSENSOR: 'rain sensor', POTI: 'potentiometer',
  RUECKSCHALTEN: 'switch back', ANTENNEN: 'antennas',
  ANGESCHLOSSENER: 'connected', VERBAUTER: 'fitted',
  UEBERWACHTER: 'monitored', TELEGRAMME: 'telegrams',
  EIGENRADSTATUS: 'own-wheel status', RADIOS: 'radio',
  UNBENUTZT: 'unused', WARNTON: 'warning tone', NIT: 'with',
  SOLANGE: 'while', GURT: 'belt', EINE: 'a', ATEMP: 'ambient temp',
  EINSCHALTDAUER: 'on-time', EINSCHALTVERZOEGERUNG: 'switch-on delay',
  EINSCHALTEN: 'switch on', DEAKTIVIEREN: 'deactivate', WAR: 'was',
  RELEVANT: 'relevant', ALS: 'as', UM: 'to', NEIN: 'no', JA: 'yes',
  MOTOR: 'engine', GRUPPE: 'group',
  EINGANG: 'input', EINGANGES: 'input', SIGNALES: 'signal',
  FAHRZEUGSPEZ: 'vehicle-specific', EINS: 'one',
  // Left as BMW wrote them on purpose: ASC, DSC, EWS, MFL, NIV, AUC, IRS,
  // CCM, SBC, KVA, ECE, CDN and the EHC channel tags (VDD, SIKO, PLAUSI,
  // ABREGEL, ...) are BMW's own abbreviations; a "translation" would only
  // invent a long form nobody uses. Same for the units (MPH, MPG).
  VORN: 'front', VORNE: 'front', HINTEN: 'rear', LINKS: 'left',
  RECHTS: 'right', LI: 'left', RE: 'right', OBEN: 'upper', UNTEN: 'lower',
  LINKSLENKER: 'left-hand drive', RECHTSLENKER: 'right-hand drive',
  EIN: 'on', AUS: 'off', AKTIV: 'active', AKTIVIERT: 'active',
  INAKTIV: 'inactive', DEAKTIV: 'deactivate', DEAKTIVIERT: 'deactivated',
  ZU: 'closed', OFFEN: 'open', GESCHLOSSEN: 'closed',
  VERBAUT: 'fitted', VORHANDEN: 'present', OHNE: 'without', MIT: 'with',
  NICHT: 'not', KEIN: 'no', KEINE: 'no', KOMFORT: 'comfort',
  ENTRIEGELN: 'unlock', VERRIEGELN: 'lock', SCHAERFEN: 'arm',
  ENTSCHAERFEN: 'disarm', ABSENKEN: 'lower', ABSCHALTUNG: 'shutdown',
  UEBERWACHT: 'monitored', UEBERWACHEN: 'monitor', UEBERWACHUNG: 'monitoring',
  KALTUEBERWACHUNG: 'cold-check', FEHLERMELDUNG: 'fault reporting',
  QUITTIERUNG: 'acknowledgement', SPERRE: 'lockout', FREIGABE: 'enable',
  VERZOEGERUNG: 'delay', WARNUNG: 'warning', MELDUNG: 'message',
  ANZEIGE: 'display', FUNKTION: 'function', FUNKTIONEN: 'functions',
  TIPP: 'one-touch', TIPPFUNKTIONEN: 'one-touch', TIPPBETRIEB: 'one-touch',
  ROLLENBETRIEB: 'dyno mode', DAUERTON: 'continuous tone',
  OPTISCHER: 'visual', OPTISCHE: 'visual', AKUSTISCHE: 'audible',
  AKUSTISCHER: 'audible', CODIERT: 'coded', MOEGLICH: 'possible',
  WERT: 'value', EINH: 'unit', EINHEIT: 'unit', TYP: 'type', STUFE: 'level',
  PRUEFSTROM: 'test current', SCHWELLE: 'threshold', ZEIT: 'time',
  EINSCHALTZEIT: 'switch-on time', AUSSCHALTZEIT: 'switch-off time',
  DAUER: 'duration', INTERVALL: 'interval', ANZAHL: 'count',
  LAND: 'country', LAENDERVARIANTE: 'country variant', VARIANTE: 'variant',
  STAND: 'level', DIMMER: 'dimmer', HELLIGKEIT: 'brightness',
  GESCHWINDIGKEIT: 'speed', SPANNUNG: 'voltage', TEMPERATUR: 'temperature',
  SOLLTEMPERATUR: 'target temperature', DRUCK: 'pressure',
  MINDESTDRUCK: 'minimum pressure', STEIGUNG: 'gradient',
  EINSPRITZSTEIGUNG: 'injection gradient', BEREICH: 'range', KURVE: 'curve',
  INHALT: 'content', INKREMENTEN: 'increments', GRAD: 'degrees',
  AUSSTATTUNG: 'equipment', AUSGANGSPEGEL: 'output level',
  ZENTRALCODE: 'central code', CODIERBYTE: 'coding byte',
  CODIERBYTES: 'coding bytes', BAUREIHE: 'model series', GEBIET: 'region',
  REIFENTYP: 'tyre type', FREQUENZVARIANTE: 'frequency variant',
  FAHRZEUGTYP: 'vehicle type', WEGINSPEKTIONSINTERVALLE: 'distance service intervals',
  ZEITINSPEKTIONSINTERVALLE: 'time service intervals',
  // --- connecting words, needed for the comments ---
  FUER: 'for', DER: 'the', DIE: 'the', DAS: 'the', DES: 'of the',
  DEN: 'the', BEI: 'on', BEIM: 'on', NACH: 'after', UEBER: 'via',
  UND: 'and', ODER: 'or', WENN: 'if', WIE: 'as', BIS: 'to', IN: 'in',
  IST: 'is', WIRD: 'is', NUR: 'only', BZW: 'or', LIEFERT: 'returns',
  VON: 'from', ZUM: 'to the', ZUR: 'to the', AM: 'at the', IM: 'in the',
};

// Longest-first (KALTUEBERWACHUNG over KALT + UEBERWACHUNG); built after the
// context-sensitive words below, which it also has to match.
let COD_VOCAB_RE;

// A few words mean different things in a NAME than in a SENTENCE: AUF after a
// part of the car is that part standing open (TUER_AUF, "door open"); in prose
// it is the preposition. Sense is chosen by context, not one global entry that
// would be wrong half the time.
const COD_VOCAB_NAME = { AUF: 'open', ZU: 'closed' };
const COD_VOCAB_TEXT = { AUF: 'on', ZU: 'to' };
COD_VOCAB_RE = new RegExp(
  '\\b(' + [...Object.keys(COD_VOCAB), ...Object.keys(COD_VOCAB_NAME)]
    .sort((a, b) => b.length - a.length).join('|') + ')\\b', 'gi');

// Words this dictionary deliberately outputs capitalised: place names stay
// capitalised mid-sentence, unlike the German nouns around them.
const COD_PROPER = new Set(
  Object.values(COD_VOCAB).flatMap(v => v.split(' '))
    .filter(w => /^[A-ZÄÖÜ][a-zäöüß]+$/.test(w)));

// The one translation entry point for coding text. Handles both the SNAKE_CASE
// result names and BMW's prose comments, because after the underscores become
// spaces they are the same problem: German words this dictionary knows.
// `asName` picks the name sense of the context-dependent words.
function codTranslate(text, asName) {
  if (!text) return '';
  if (typeof lang === 'function' && lang() === 'orig') return text;
  const ctx = asName ? COD_VOCAB_NAME : COD_VOCAB_TEXT;
  return String(text).replace(COD_VOCAB_RE, (m) => {
    const k = m.toUpperCase();
    return ctx[k] || COD_VOCAB[k] || m;
  });
}

// COD_FH_DEAKTIV_NACH_TUER_AUF_EIN -> "Windows deactivate after door open"
function codLabelFromName(name) {
  const bare = String(name).replace(/^(COD|STAT|STATUS|CODIER)_/i, '');
  const parts = bare.split('_').filter(Boolean);
  // a trailing _EIN/_AKTIV on a switch is the boolean marker, not the word
  if (parts.length > 1 && /^(EIN|AKTIV)$/i.test(parts[parts.length - 1])) parts.pop();
  // COD_ names and DATEN FSW keywords share a vocabulary, so NCS Dummy's
  // translations often know the stripped name whole -- try that before word-by-word
  return datI18n(bare) || datI18n(parts.join('_'))
    || codTidy(codTranslate(parts.join(' '), true), name);
}

// Sentence-case, never empty. An unknown word survives as BMW wrote it, which
// in a result name means SHOUTING ("Type SCHLOSS SIGNALE"); lower-case those,
// but leave genuine abbreviations (E36, IRS, K15) alone.
function codTidy(s, fallback) {
  // EDIABAS-faithful mode shows BMW's text verbatim, so the case repair (which
  // only exists to undo German noun capitalisation) must not run.
  if (typeof lang === 'function' && lang() === 'orig') {
    return String(s || '').trim() || fallback;
  }
  const t = String(s || '').replace(/\s+/g, ' ').trim()
    .replace(/\b[A-ZÄÖÜ]{4,}\b/g, w => (/\d/.test(w) ? w : w.toLowerCase()))
    // Lower only plain Capitalised words (German noun caps the translation
    // inherited); leave all-caps abbreviations (AC, IRS), digit words (E36,
    // K15) and this dictionary's own proper nouns (Switzerland) alone.
    .replace(/(?!^)\b[A-ZÄÖÜ][a-zäöüß]{2,}\b/g,
             w => (COD_PROPER.has(w) ? w : w.toLowerCase()))
    // German's bare article between two nouns is an English genitive:
    // "Schwelle DER Geschwindigkeitswarnung" -> "threshold of the speed warning".
    .replace(/\b(\w+) the (\w+)/g,
             (m0, a, b) => (/^(is|not|on|in|to|for|or|and|if|of)$/i.test(a)
                            ? m0 : `${a} of the ${b}`));
  if (!t) return fallback;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Some comments do not DESCRIBE the value, they list what it may hold --
// DWA4's FAHRZEUG_TYP is commented "E31,E32,E34,E36" and its variant
// "/2,/4,/7". Using that as the label puts an enumeration where the name
// should be, so the name is used instead and the list is shown as the hint
// it actually is.
function codIsEnumComment(c) {
  const t = c.trim();
  if (/,/.test(t) && !/\s/.test(t)) return true;          // E31,E32,E34,E36
  if (/^'[^']*'(\s*,\s*'[^']*')*$/.test(t)) return true;  // 'ECE', 'US'
  return false;
}

// The label to show: BMW's own comment where there is one, otherwise the name
// read as words. Both go through the same dictionary.
function codLabel(f) {
  const c = (f.label || '').trim();
  if (c && !codIsEnumComment(c)) return codTidy(codTranslate(c, false), c);
  return codLabelFromName(f.name);
}

// BMW's comment when it is a list of permitted values rather than a
// description: shown beside the field, because it is exactly what you need to
// know before changing it.
function codHint(f) {
  const c = (f.label || '').trim();
  return c && codIsEnumComment(c) ? c : '';
}

// Is this value on? The ECU answers 1/0, but demo mode and some SGBDs answer in
// words ("ja"/"aktiv"/"ein"). Both spellings of the negatives travel: SGBD text
// says "nicht aktiv", DATEN's PSW keywords say "nicht_aktiv".
const COD_TRUE = new Set(['1', 'ja', 'ein', 'aktiv', 'vorhanden', 'yes', 'on', 'true']);
const COD_FALSE = new Set(['0', 'nein', 'aus', 'inaktiv', 'nicht aktiv', 'nicht_aktiv',
                           'nicht vorhanden', 'nicht_vorhanden', 'no', 'off', 'false']);
function codIsOn(raw) {
  return COD_TRUE.has(String(raw ?? '').trim().toLowerCase());
}
// A value the ECU gave that is neither -- a switch reading "34" means the read
// did not answer this field, and pretending it is "off" would be a lie.
function codKnown(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return COD_TRUE.has(s) || COD_FALSE.has(s);
}

// The coding map, once. Returns the entry for an SGBD or null.
async function codingFor(sgbd) {
  if (typeof loadCodingMap !== 'function') return null;
  await loadCodingMap();
  const map = (typeof window !== 'undefined' && window.BMW_CODING_MAP) || null;
  if (!map || !sgbd) return null;
  return map[String(sgbd).toLowerCase()] || null;
}

// BMW's DATEN description of a module, for the ECUs whose SGBD names nothing:
// which bit at which address is which function, and what the settings are
// CALLED (aktiv / nicht_aktiv). A module ships several coding variants and
// only the car's own coding index (car-connected) says which it wants, so the
// reference lists every variant rather than picking one.
async function datenFor(sgbd) {
  if (typeof loadDatenMap !== 'function') return null;
  await loadDatenMap();
  const map = (typeof window !== 'undefined' && window.BMW_DATEN_MAP) || null;
  if (!map || !sgbd) return null;
  return map[String(sgbd).toLowerCase()] || null;
}

// NCS Dummy's community translations, keyed by lowercased keyword. Returned as
// written -- already plain English, and codTidy's case repair would turn
// "(Japan)" into "(japan)". EDIABAS-faithful mode shows BMW's keyword untouched.
function datI18n(name) {
  if (typeof lang === 'function' && lang() === 'orig') return '';
  const t = (typeof window !== 'undefined' && window.BMW_DATEN_I18N) || null;
  return (t && name && t[String(name).toLowerCase()]) || '';
}

// The label for a DATEN keyword: the community translation where one
// exists, else the coding dictionary's word-by-word attempt, else the
// keyword itself.
function datLabel(name) {
  return datI18n(name) || codTidy(codTranslate(name, true), name);
}

// FSW stem -> the module's legal values, merged across every chassis/variant:
// [[psw, value], ...] sorted by value. Only real choices travel -- a single
// wert_NN default is a number, a hex buffer is not a pick list.
async function codDatEnums(sgbd) {
  const daten = await datenFor(sgbd);
  if (!daten) return null;
  const acc = {};
  for (const variants of Object.values(daten.chassis)) {
    for (const fields of Object.values(variants)) {
      for (const f of fields) {
        // plain settings carry the mask-normalised byte as a short hex
        // string ("00", "01"); anything longer is a buffer, not a choice
        const vals = (f.values || [])
          .filter(([, v]) => typeof v === 'string' && /^[0-9a-f]{1,4}$/i.test(v))
          .map(([n, v]) => [n, parseInt(v, 16)]);
        if (vals.length < 2) continue;
        const m = acc[f.name.toUpperCase()]
          || (acc[f.name.toUpperCase()] = new Map());
        for (const [n, v] of vals) {
          const k = `${String(n).toLowerCase()}=${v}`;
          if (!m.has(k)) m.set(k, [n, v]);
        }
      }
    }
  }
  const out = {};
  for (const [k, m] of Object.entries(acc)) {
    out[k] = [...m.values()].sort((a, b) => a[1] - b[1]);
  }
  return Object.keys(out).length ? out : null;
}

// Pair DATEN's function names to a module's result names, which spell the same
// thing differently (COD_BL_LI_RE_KALTUEBERWACHUNG_EIN vs KALTUEBERWACHUNG_BL),
// so equality alone finds almost nothing. Two rules, in order:
//
//   1. exact stem equality (prefix and boolean-marker stripped) -- wins
//   2. every DATEN token appears in the field's tokens, the DATEN name has
//      >=2 tokens (one-token names like "BC" claim half a module), and the
//      pairing is UNIQUE both ways
//
// An ambiguous claim matches nothing: a wrong pairing puts another function's
// value list on a field, worse than no list.
function codEnumMatch(names, enums) {
  const strip = (n) => String(n)
    .replace(/^(COD|STAT|STATUS|CODIER)_/i, '').toUpperCase();
  const toks = (n) => new Set(
    strip(n).split('_').filter(t => t && !/^(EIN|AKTIV)$/.test(t)));
  const out = new Map();
  const fields = names.map(n => ({ n, stem: strip(n), t: toks(n) }));
  const claims = new Map();          // field name -> [enum, enum...]
  for (const [dn, en] of Object.entries(enums)) {
    const exact = fields.filter(x => x.stem === dn);
    if (exact.length === 1) { out.set(exact[0].n, en); continue; }
    const dt = toks(dn);
    if (dt.size < 2) continue;
    const cands = fields.filter(x => [...dt].every(t => x.t.has(t)));
    if (cands.length !== 1) continue;
    const a = claims.get(cands[0].n) || [];
    a.push(en);
    claims.set(cands[0].n, a);
  }
  for (const [fname, list] of claims) {
    if (list.length === 1 && !out.has(fname)) out.set(fname, list[0]);
  }
  return out;
}

// BMW's DATEN coding sheet for a module, as a reference.
//
// A READING, NOT A READOUT: everything here is off the disk -- what the coding
// memory MEANS, not what this car holds. The screen says so. The address
// (block/word/byte/mask) is shown because it is what another coding tool wants
// and what makes a value checkable against a known-good car.
function showDatenReference(ecu, daten, cont, setPanel, back, chassisId) {
  const chassis = Object.keys(daten.chassis);
  // open on the car being worked on, not on whichever chassis sorts first
  const want = String(chassisId || '').toUpperCase();
  let ch = chassis.includes(want) ? want : chassis[0];
  let vname = Object.keys(daten.chassis[ch])[0];
  let filter = '';

  const draw = () => {
    const variants = Object.keys(daten.chassis[ch]);
    if (!variants.includes(vname)) vname = variants[0];
    const all = daten.chassis[ch][vname];

    // SEARCH, because these lists got long (LCM: 10,415 functions). Matches
    // BMW's keyword as well as the English label -- the keyword is what
    // another coding tool shows.
    const q = filter.trim().toLowerCase();
    const fields = q
      ? all.filter(f => f.name.toLowerCase().includes(q)
          || datLabel(f.name).toLowerCase().includes(q))
      : all;

    // DROPDOWNS, not one-at-a-time cycling: a module may describe nine chassis
    // and thirty-three coding indices, unusable via a stepping softkey.
    const opt = (v, sel) =>
      `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v)}</option>`;

    setPanel();
    cont.innerHTML = `
      <div class="act-menu">
        <div class="act-menu-title">Coding map</div>
        <div class="act-menu-sub mono">${esc(ecu.sgbd)}.prg · DATEN `
      + `${esc(daten.daten)}</div>
        <div class="dat-bar">
          ${chassis.length > 1 ? `<label class="dat-pick">Chassis
            <select id="dat-ch">${chassis.map(c => opt(c, ch)).join('')}</select>
          </label>` : `<span class="dat-pick-fixed mono">${esc(ch)}</span>`}
          ${variants.length > 1 ? `<label class="dat-pick">Index
            <select id="dat-var">${variants.map(v => opt(v, vname)).join('')}</select>
          </label>` : `<span class="dat-pick-fixed mono">index ${esc(vname)}</span>`}
          <input class="wiring-search dat-search" id="dat-q" type="search"
                 placeholder="Search functions…" value="${esc(filter)}"
                 autocomplete="off">
        </div>
        <div class="cod-note">
          <span class="cod-note-dim">${fields.length}`
      + `${q ? ` of ${all.length}` : ''} function`
      + `${fields.length === 1 ? '' : 's'} BMW's coding tool knows for this `
      + `module. This is the map, read from disk — not this car's settings.`
      + `</span>
        </div>
        <div class="cod-list" id="dat-list"></div>
      </div>`;
    const list = cont.querySelector('#dat-list');

    fields.forEach(f => {
      const row = document.createElement('div');
      row.className = 'cod-row dat-row';
      // BMW lists three different things:
      //   several named settings   aktiv=00 / nicht_aktiv=01, a real choice
      //   one wert_NN entry        a numeric field, byte is its DEFAULT (not a
      //                            choice); 5,562 rows are this
      //   a long hex value         a buffer (curve or country block): show the
      //                            NAMES, bytes as a tooltip -- whole is
      //                            unreadable, dropping lost variants entirely
      const vals = f.values || [];
      const isDefault = vals.length === 1 && /^wert_\d+$/i.test(vals[0][0]);
      const shown = !vals.length
        ? '<span class="ink-faint">—</span>'
        : isDefault
          ? `<span class="dat-val"><span class="dat-val-n">default</span>`
            + `<span class="dat-val-v mono">0x${esc(vals[0][1])}</span></span>`
          : (() => {
              // A buffer parameter is not a pick list: LWS5's KENNFELD carries
              // the same curve once per chassis, so nine "16 bytes" chips say
              // nothing. Summarise those; a real choice still lists its settings.
              const long = vals.filter(([, v]) =>
                typeof v === 'string' && v.length > 4);
              if (long.length === vals.length && vals.length > 2) {
                const bytes = vals[0][1].length / 2;
                return `<span class="dat-val" title="${esc(
                  vals.map(([n, v]) => `${n}: ${v}`).join('\n'))}">`
                  + `<span class="dat-val-n">${vals.length} variants</span>`
                  + `<span class="dat-val-v mono">${bytes} bytes each</span>`
                  + `</span>`;
              }
              return vals.map(([n, v]) => {
                const big = typeof v === 'string' && v.length > 4;
                return `<span class="dat-val"${big ? ` title="${esc(v)}"` : ''}>`
                  + `<span class="dat-val-n">${esc(datI18n(n) || codTranslate(n, true))}</span>`
                  + `<span class="dat-val-v mono">`
                  + `${big ? `${v.length / 2} bytes` : esc(v)}</span></span>`;
              }).join('');
            })();
      // BMW's keyword under the English label, but only when translating said
      // something -- a second line repeating the first is noise, not context.
      const label = datLabel(f.name);
      const same = label.toUpperCase().replace(/ /g, '_') === f.name.toUpperCase();
      row.innerHTML = `
        <span class="cod-name">${esc(same ? f.name : label)}
          ${same ? '' : `<span class="cod-hint mono">${esc(f.name)}</span>`}</span>
        <span class="cod-key mono">blk ${f.block} · word ${f.word}`
        + ` · byte ${f.byte} · mask 0x${f.mask.toString(16).padStart(2, '0')}</span>
        <span class="dat-vals">${shown}</span>`;
      list.appendChild(row);
    });

    const chSel = cont.querySelector('#dat-ch');
    if (chSel) chSel.onchange = () => { ch = chSel.value; vname = null; draw(); };
    const vSel = cont.querySelector('#dat-var');
    if (vSel) vSel.onchange = () => { vname = vSel.value; draw(); };

    // redraw on input, restoring the caret: the panel rebuild would otherwise
    // drop focus on every keystroke
    const qEl = cont.querySelector('#dat-q');
    if (qEl) {
      qEl.oninput = () => {
        const at = qEl.selectionStart;
        filter = qEl.value;
        draw();
        const again = cont.querySelector('#dat-q');
        if (again) { again.focus(); again.setSelectionRange(at, at); }
      };
    }

    const acts = [];
    if (q) {
      acts.push({ key: '1', keyLabel: 'F1', label: 'Clear search',
                  fn: () => { filter = ''; draw(); } });
    }
    if (back) acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                          kind: 'back', fn: back });
    setActions(acts);
    sbLeft.textContent = `${ecu.sgbd}.prg · DATEN ${ch}/${vname} · `
      + `${fields.length} function${fields.length === 1 ? '' : 's'}`;
    tipify(cont);
  };

  draw();
}
