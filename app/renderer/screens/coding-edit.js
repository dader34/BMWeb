// Coding: read what a module is coded to, and stage changes to it.
//
// WRITES ARE BLOCKED. The editor stages a change and shows exactly what would
// be sent -- and stops there. A coding write is an EEPROM write; get it wrong
// on a module that gates the immobiliser or airbags and the car does not
// start, or worse. The send path deliberately does not exist rather than
// sitting behind a confirm dialog a wrong keypress could clear.

// ONE dictionary translating both the result NAME and BMW's German comment.
// NOT deGerman() -- that's tuned for fault prose and mistranslates this
// vocabulary ("auf" is "up" in prose, "on" here). Longest match must win:
// German glues nouns together (KALTUEBERWACHUNG is one word, not KALT +
// UEBERWACHUNG).
const COD_VOCAB = {
  FH: 'windows',
  FENSTERHEBER: 'windows',
  SHD: 'sunroof',
  ZV: 'central locking',
  ZAV: 'central locking',
  DWA: 'alarm',
  BC: 'on-board computer',
  KOMBI: 'instrument cluster',
  DME: 'engine ECU',
  EGS: 'transmission ECU',
  EKS: 'seat module',
  IHKA: 'climate control',
  KLR: 'climate control',
  RLS: 'rain sensor',
  LWR: 'headlight aim',
  ASP: 'mirror',
  FB: 'remote',
  FERNBEDIENUNG: 'remote',
  SITZHEIZUNG: 'seat heating',
  GURTWARNUNG: 'belt warning',
  NEIGUNGSGEBER: 'tilt sensor',
  BLS: 'brake light switch',
  IB: 'interior light',
  STANDLICHT: 'side light',
  SL: 'side light',
  ABBLENDLICHT: 'low beam',
  AL: 'low beam',
  FERNLICHT: 'high beam',
  FL: 'high beam',
  BREMSLICHT: 'brake light',
  BL: 'brake light',
  BREMSLICHTSCHALTER: 'brake light switch',
  NEBELSCHLUSSLICHT: 'rear fog light',
  NSL: 'rear fog light',
  NEBELSCHEINWERFER: 'front fog light',
  NSW: 'front fog light',
  KENNZEICHENLICHT: 'plate light',
  KZL: 'plate light',
  RUECKLICHT: 'tail light',
  RUECKFAHRSCHEINWERFER: 'reversing light',
  RFS: 'reversing light',
  BLINKER: 'indicator',
  WARNBLINKER: 'hazards',
  INNENLICHT: 'interior light',
  LICHT: 'light',
  TUER: 'door',
  FAHRERTUER: 'driver door',
  BEIFAHRERTUER: 'passenger door',
  SCHEIBE: 'window',
  SCHEIBEN: 'windows',
  FENSTER: 'window',
  HECKSCHEIBE: 'rear window',
  HECK: 'tailgate',
  KOFFERRAUM: 'boot',
  MOTORHAUBE: 'bonnet',
  SITZ: 'seat',
  SPIEGEL: 'mirror',
  LENKRAD: 'steering wheel',
  TANK: 'fuel tank',
  RAD: 'wheel',
  VK: 'convertible top',
  CABRIO: 'convertible',
  TUEREN: 'doors',
  FAHRZEUG: 'vehicle',
  SCHLOSS: 'lock',
  SCHLOESSER: 'locks',
  SIGNAL: 'signal',
  SIGNALE: 'signals',
  HECKKLAPPE: 'tailgate',
  HECKKLAPPEN: 'tailgate',
  SCHWEIZ: 'Switzerland',
  SEPERAT: 'separate',
  SEPARAT: 'separate',
  ALARMVARIANTE: 'alarm variant',
  KL15: 'terminal 15',
  BATT: 'battery',
  SENSOR: 'sensor',
  DIFF: 'difference',
  RES: 'reserve',
  STANDHEIZUNG: 'auxiliary heating',
  KOMPRESSORAUSTAKTUNG: 'compressor cut-out',
  FILTER: 'filter',
  WISCHER: 'wiper',
  SCHEIBENWISCHER: 'wiper',
  OPTISCHEM: 'visual',
  SCHIEF: 'skewed',
  HOEHE: 'height',
  AUSWERTUNG: 'evaluation',
  VERSCHLEISSFAKTOR: 'wear factor',
  DERZEIT: 'currently',
  DATENSICHERUNGSBYTE: 'data backup byte',
  SCHALTGETRIEBE: 'manual gearbox',
  TEMPERATUREINHEIT: 'temperature unit',
  CODIERUNG: 'coding',
  LENKUNG: 'steering',
  SCHALTSCHWELLE: 'switching threshold',
  GESCHWINDIGKEITSWARNUNG: 'speed warning',
  SCHLUESSELWARNUNG: 'key warning',
  LICHTWARNUNG: 'light warning',
  ZUNDSCHLUESSELWARNUNG: 'ignition key warning',
  SCHWELLWERT: 'threshold',
  WARTEZEIT: 'wait time',
  RAEDER: 'wheels',
  HINTERACHSUEBERSETZUNG: 'rear axle ratio',
  GESCHW: 'speed',
  INDIVIDUALISIERUNG: 'individualisation',
  VERRIEGELUNG: 'locking',
  PLAUSIBILITAETSABFRAGE: 'plausibility check',
  BLINKZYKLUS: 'flash cycle',
  ANLERNEN: 'teach-in',
  LERNEN: 'learn',
  RUECKSTELLUNG: 'reset',
  ABSCHALTZEIT: 'switch-off time',
  NACHLAUF: 'run-on',
  VORLAUF: 'lead',
  SCHLUESSEL: 'key',
  ZUENDSCHLUESSEL: 'ignition key',
  WEGFAHRSPERRE: 'immobiliser',
  DREHZAHL: 'engine speed',
  VERBRAUCH: 'consumption',
  REICHWEITE: 'range',
  AUSSENTEMPERATUR: 'outside temperature',
  KUEHLMITTEL: 'coolant',
  GESCHWINDIGKEIT_EINHEIT: 'speed unit',
  HUPE: 'horn',
  SIRENE: 'siren',
  INNENRAUM: 'interior',
  UEBERWACHUNGSZEIT: 'monitoring time',
  FUNKINNENRAUMSCHUTZ: 'radar interior protection',
  ULTRASCHALLINNENRAUMSCHUTZ: 'ultrasonic interior protection',
  TUERE: 'door',
  ZENTRALSCHALTER: 'central switch',
  AUTOMATISCHEM: 'automatic',
  AUTOMATISCH: 'automatic',
  ANTRIEBSMOMENTENREGELUNG: 'drive torque control',
  BREMSMOMENTENREGELUNG: 'brake torque control',
  BREMSKRAFTVERTEILUNG: 'brake force distribution',
  HYDRAULISCHE: 'hydraulic',
  SCHLUPFSCHWELLENOFFSET: 'slip threshold offset',
  INTERMETIEREND: 'intermittent',
  INTERMITTIEREND: 'intermittent',
  OEFFNET: 'opens',
  SCHLIESST: 'closes',
  SCHEIBENABSENKUNG: 'window drop',
  SPERREN: 'inhibit',
  GESPERRT: 'inhibited',
  KOMFORTSCHLIESSEN: 'comfort close',
  KOMFORTOEFFNEN: 'comfort open',
  ZENTRAL: 'central',
  ZENTRALVERRIEGELUNG: 'central locking',
  FT: 'driver',
  BT: 'passenger',
  MOTORVARIANTE: 'engine variant',
  FRONTSCHEIBE: 'windscreen',
  EINSCHALT: 'switch-on',
  AUSSCHALT: 'switch-off',
  HYSTERESE: 'hysteresis',
  NACHLAUFZEIT: 'run-on time',
  RUECKMELDUNG: 'feedback',
  BLINKEN: 'flashing',
  ZUSTAND: 'state',
  BETRIEB: 'operation',
  ANSCHALTUNG: 'activation',
  ABSCHALTSCHWELLE: 'switch-off threshold',
  EINSCHALTSCHWELLE: 'switch-on threshold',
  MOTORTYP: 'engine type',
  GETRIEBE: 'gearbox',
  ACHSE: 'axle',
  HINTERACHSE: 'rear axle',
  TEILENUMMER: 'part number',
  FAHRGESTELLNUMMER: 'chassis number',
  TYPENCODE: 'type code',
  HARDWARESTAND: 'hardware level',
  AENDERUNGSINDEX: 'revision index',
  LAENDERCODE: 'country code',
  LAENDERCODIERUNG: 'country coding',
  KOMBIS: 'cluster',
  SKALENENDWERT: 'scale end value',
  TACHOMETERS: 'speedometer',
  GRENZDREHZAHL: 'rev limit',
  DREHZAHLGRENZE: 'rev limit',
  WEGSTRECKEN: 'distance',
  WEGSTRECKENZAEHLER: 'odometer',
  WEGIMPULSZAHL: 'road-pulse count',
  WEGEIMPULSE: 'road pulses',
  ZAHL: 'number',
  VERBRAUCHS: 'consumption',
  GESCHWINDIGKEITS: 'speed',
  SPRACHVARIANTE: 'language variant',
  TANKINHALT: 'tank capacity',
  MAXIMALER: 'maximum',
  MAXIMALE: 'maximum',
  TANKGEBERS: 'tank sender',
  OELTEMPERATUR: 'oil temperature',
  ZEITINSPEKTION: 'time service',
  OELSERVICEINTERVALLE: 'oil service intervals',
  OELINSPEKTIONSINTERVALLE: 'oil service intervals',
  CHECKCONTROL: 'check control',
  HUPENALARM: 'horn alarm',
  GONG: 'chime',
  ANSTEUERBAR: 'can be driven',
  SIA: 'service interval',
  MOTORSTART: 'engine start',
  STUNDENBASIS: 'hour format',
  MEILEN: 'miles',
  ZYLINDERANZAHL: 'cylinder count',
  ZYLINDERZAHL: 'cylinder count',
  DIVISION: 'division',
  DURCH: 'by',
  EINSPRITZKENNLINIE: 'injection curve',
  EINSPITZKENNLINIE: 'injection curve',
  GRUNDMERKMALESCHLUESSEL: 'basic-feature key',
  ANTRIEBSMERKMALESCHLUESSEL: 'drivetrain-feature key',
  SONDERAUSSTATTUNGSSCHLUESSEL: 'optional-equipment key',
  VERSIONSNUMMERNSCHLUESSEL: 'version-number key',
  AUSSTAUSCHKOMBI: 'replacement cluster',
  EEPROM: 'EEPROM',
  DATUM: 'date',
  JAHR: 'year',
  TAGE: 'days',
  UHR: 'clock',
  INNENBELEUCHTUNG: 'interior light',
  GESAMTWEG: 'total travel',
  EMPFINDLICHKEIT: 'sensitivity',
  ENTSICHERN: 'unlock',
  SCHEIBENUEBERWACHUNG: 'window monitoring',
  SCHUTZ: 'protection',
  TUERSCHLOSSHEIZUNG: 'door-lock heating',
  INTERVALLTON: 'intermittent tone',
  GENERELL: 'generally',
  BLITZT: 'flashes',
  BLITZ: 'flash',
  LEUCHTET: 'steady',
  PANICMODUS: 'panic mode',
  DIEBSTAHLWARNANLAGE: 'anti-theft alarm',
  FUNKFERNBEDIENUNG: 'radio remote',
  INFRAROT: 'infrared',
  KOMFORTOEFFNUNG: 'comfort open',
  KOMFORTSCHLIESSUNG: 'comfort close',
  SELEKTIV: 'selective',
  HEULTON: 'wail tone',
  ELEKTRISCHE: 'electric',
  AUSSTELLFENSTER: 'pop-out window',
  SCHEINWERFERREINIGUNGSANLAGE: 'headlight washer',
  SCHLUESSELNUMMER: 'key number',
  WECHSEL: 'change',
  GESCHAERFT: 'armed',
  FESTCODE: 'fixed code',
  WECHSELCODE: 'rolling code',
  CODIERTES: 'coded',
  STATISCHES: 'static',
  SCHNITTSTELLE: 'interface',
  DUMMYERGEBNIS: 'dummy result',
  IMMER: 'always',
  ANHAENGER: 'trailer',
  ANHAENGERLICHT: 'trailer light',
  PARKLICHT: 'parking light',
  STANDLICHTAUSFALL: 'side-light failure',
  ERSATZFUNKTION: 'substitute function',
  BEDIMMTE: 'dimmed',
  BETRIEBSSTUNDENZAEHLERLOESCHUNG: 'hour-counter reset',
  LAMPENWECHSEL: 'bulb change',
  WARNBLINKEN: 'hazard flashing',
  MITTE: 'centre',
  BLK: 'indicator',
  ZYKLUSZEIT: 'cycle time',
  ABSCHALTET: 'switches off',
  VOLT: 'volt',
  ABKLAPP: 'fold',
  ABKLAPPEN: 'fold',
  SPIEGELHEIZEN: 'mirror heating',
  PERMANENTES: 'permanent',
  INVERTIERT: 'inverted',
  INVERTIERTER: 'inverted',
  LENKSAEULENVERSTELLSCHALTER: 'steering-column adjust switch',
  TIPPTASTENBETRIEB: 'momentary-switch mode',
  FREI: 'free',
  AKTIVSITZ: 'active seat',
  SONNENROLLO: 'sun blind',
  UMKEHRZEIT: 'reversal time',
  VERDECKMOTOR: 'roof motor',
  KLAPPE: 'flap',
  MOTORHAUBENKONTAKTE: 'bonnet contacts',
  REIFENTOLERANZABGLEICH: 'tyre tolerance calibration',
  BREMSWARNLEUCHTE: 'brake warning lamp',
  AUSGABE: 'output',
  AKTIVER: 'active',
  PASSIVER: 'passive',
  BENZIN: 'petrol',
  AUTOMATIK: 'automatic',
  HANDSCHALTUNG: 'manual',
  SPERRDIFFERENTIAL: 'limited-slip differential',
  BUSINDEX: 'bus index',
  CHECKSUMME: 'checksum',
  AUSFEDERWEG: 'rebound travel',
  EINFEDERWEG: 'compression travel',
  DREHSINN: 'rotation direction',
  KONSTANTEN: 'constants',
  HEBEN: 'raise',
  FAHRT: 'drive',
  VERZOEG: 'delay',
  SOLLGESCHWINDIGKEIT: 'target speed',
  ZEIGER: 'pointer',
  KODIERDATENSAETZE: 'coding data sets',
  CODIERDATENSATZ: 'coding data set',
  CODIERINDEX: 'coding index',
  DATENSATZNUMMER: 'data set number',
  LAUT: 'per',
  GEBERRAD: 'sensor wheel',
  KURBELWELLE: 'crankshaft',
  EINZULERNEN: 'to teach in',
  LINIE: 'line',
  REGELPARAMETER: 'control parameter',
  EINSATZPUNKT: 'onset point',
  REGELUNG: 'control',
  BESTIMMT: 'determines',
  DIESER: 'this',
  ANSPRECHZEIT: 'response time',
  ABGESCHALTEN: 'switched off',
  ABGEFRAGT: 'polled',
  KOMMT: 'arrives',
  GUELTIGER: 'valid',
  SEKUNDEN: 'seconds',
  SEK: 's',
  ENTSPRICHT: 'equals',
  DREHWINKEL: 'rotation angle',
  LEERLAUFANHEBUNG: 'idle raise',
  KLIMAKOMPRESSOR: 'A/C compressor',
  SENSORIK: 'sensors',
  STEUERGERAET: 'control unit',
  ALLGEMEIN: 'general',
  UNTERSPANNUNG: 'undervoltage',
  VARIABEL: 'variable',
  FUSS: 'footwell',
  FOND: 'rear',
  UNABHAENGIGER: 'independent',
  REGENSENSOR: 'rain sensor',
  POTI: 'potentiometer',
  RUECKSCHALTEN: 'switch back',
  ANTENNEN: 'antennas',
  ANGESCHLOSSENER: 'connected',
  VERBAUTER: 'fitted',
  UEBERWACHTER: 'monitored',
  TELEGRAMME: 'telegrams',
  EIGENRADSTATUS: 'own-wheel status',
  RADIOS: 'radio',
  UNBENUTZT: 'unused',
  WARNTON: 'warning tone',
  NIT: 'with',
  SOLANGE: 'while',
  GURT: 'belt',
  EINE: 'a',
  ATEMP: 'ambient temp',
  EINSCHALTDAUER: 'on-time',
  EINSCHALTVERZOEGERUNG: 'switch-on delay',
  EINSCHALTEN: 'switch on',
  DEAKTIVIEREN: 'deactivate',
  WAR: 'was',
  RELEVANT: 'relevant',
  ALS: 'as',
  UM: 'to',
  NEIN: 'no',
  JA: 'yes',
  MOTOR: 'engine',
  GRUPPE: 'group',
  EINGANG: 'input',
  EINGANGES: 'input',
  SIGNALES: 'signal',
  FAHRZEUGSPEZ: 'vehicle-specific',
  EINS: 'one',
  // Left as BMW wrote them: ASC, DSC, EWS, MFL, NIV, AUC, IRS, CCM, SBC, KVA,
  // ECE, CDN, the EHC channel tags and the units (MPH, MPG) are abbreviations
  // a "translation" would only replace with a long form nobody uses.
  VORN: 'front',
  VORNE: 'front',
  HINTEN: 'rear',
  LINKS: 'left',
  RECHTS: 'right',
  LI: 'left',
  RE: 'right',
  OBEN: 'upper',
  UNTEN: 'lower',
  LINKSLENKER: 'left-hand drive',
  RECHTSLENKER: 'right-hand drive',
  EIN: 'on',
  AUS: 'off',
  AKTIV: 'active',
  AKTIVIERT: 'active',
  INAKTIV: 'inactive',
  DEAKTIV: 'deactivate',
  DEAKTIVIERT: 'deactivated',
  ZU: 'closed',
  OFFEN: 'open',
  GESCHLOSSEN: 'closed',
  VERBAUT: 'fitted',
  VORHANDEN: 'present',
  OHNE: 'without',
  MIT: 'with',
  NICHT: 'not',
  KEIN: 'no',
  KEINE: 'no',
  KOMFORT: 'comfort',
  ENTRIEGELN: 'unlock',
  VERRIEGELN: 'lock',
  SCHAERFEN: 'arm',
  ENTSCHAERFEN: 'disarm',
  ABSENKEN: 'lower',
  ABSCHALTUNG: 'shutdown',
  UEBERWACHT: 'monitored',
  UEBERWACHEN: 'monitor',
  UEBERWACHUNG: 'monitoring',
  KALTUEBERWACHUNG: 'cold-check',
  FEHLERMELDUNG: 'fault reporting',
  QUITTIERUNG: 'acknowledgement',
  SPERRE: 'lockout',
  FREIGABE: 'enable',
  VERZOEGERUNG: 'delay',
  WARNUNG: 'warning',
  MELDUNG: 'message',
  ANZEIGE: 'display',
  FUNKTION: 'function',
  FUNKTIONEN: 'functions',
  TIPP: 'one-touch',
  TIPPFUNKTIONEN: 'one-touch',
  TIPPBETRIEB: 'one-touch',
  ROLLENBETRIEB: 'dyno mode',
  DAUERTON: 'continuous tone',
  OPTISCHER: 'visual',
  OPTISCHE: 'visual',
  AKUSTISCHE: 'audible',
  AKUSTISCHER: 'audible',
  CODIERT: 'coded',
  MOEGLICH: 'possible',
  WERT: 'value',
  EINH: 'unit',
  EINHEIT: 'unit',
  TYP: 'type',
  STUFE: 'level',
  PRUEFSTROM: 'test current',
  SCHWELLE: 'threshold',
  ZEIT: 'time',
  EINSCHALTZEIT: 'switch-on time',
  AUSSCHALTZEIT: 'switch-off time',
  DAUER: 'duration',
  INTERVALL: 'interval',
  ANZAHL: 'count',
  LAND: 'country',
  LAENDERVARIANTE: 'country variant',
  VARIANTE: 'variant',
  STAND: 'level',
  DIMMER: 'dimmer',
  HELLIGKEIT: 'brightness',
  GESCHWINDIGKEIT: 'speed',
  SPANNUNG: 'voltage',
  TEMPERATUR: 'temperature',
  SOLLTEMPERATUR: 'target temperature',
  DRUCK: 'pressure',
  MINDESTDRUCK: 'minimum pressure',
  STEIGUNG: 'gradient',
  EINSPRITZSTEIGUNG: 'injection gradient',
  BEREICH: 'range',
  KURVE: 'curve',
  INHALT: 'content',
  INKREMENTEN: 'increments',
  GRAD: 'degrees',
  AUSSTATTUNG: 'equipment',
  AUSGANGSPEGEL: 'output level',
  ZENTRALCODE: 'central code',
  CODIERBYTE: 'coding byte',
  CODIERBYTES: 'coding bytes',
  BAUREIHE: 'model series',
  GEBIET: 'region',
  REIFENTYP: 'tyre type',
  FREQUENZVARIANTE: 'frequency variant',
  FAHRZEUGTYP: 'vehicle type',
  WEGINSPEKTIONSINTERVALLE: 'distance service intervals',
  ZEITINSPEKTIONSINTERVALLE: 'time service intervals',
  // --- connecting words, needed for the comments ---
  FUER: 'for',
  DER: 'the',
  DIE: 'the',
  DAS: 'the',
  DES: 'of the',
  DEN: 'the',
  BEI: 'on',
  BEIM: 'on',
  NACH: 'after',
  UEBER: 'via',
  UND: 'and',
  ODER: 'or',
  WENN: 'if',
  WIE: 'as',
  BIS: 'to',
  IN: 'in',
  IST: 'is',
  WIRD: 'is',
  NUR: 'only',
  BZW: 'or',
  LIEFERT: 'returns',
  VON: 'from',
  ZUM: 'to the',
  ZUR: 'to the',
  AM: 'at the',
  IM: 'in the',
};

// Longest-first (KALTUEBERWACHUNG over KALT + UEBERWACHUNG); built after the
// context-sensitive words below, which it also has to match.
let COD_VOCAB_RE;

// AUF/ZU mean different things in a NAME than in prose: TUER_AUF is "door open",
// but "auf" as a preposition is "on". Sense picked by context.
const COD_VOCAB_NAME = { AUF: 'open', ZU: 'closed' };
const COD_VOCAB_TEXT = { AUF: 'on', ZU: 'to' };
COD_VOCAB_RE = new RegExp(
  '\\b(' +
    [...Object.keys(COD_VOCAB), ...Object.keys(COD_VOCAB_NAME)]
      .sort((a, b) => b.length - a.length)
      .join('|') +
    ')\\b',
  'gi'
);

// Place names this dictionary outputs stay capitalised mid-sentence, unlike
// the German nouns around them.
const COD_PROPER = new Set(
  Object.values(COD_VOCAB)
    .flatMap((v) => v.split(' '))
    .filter((w) => /^[A-ZÄÖÜ][a-zäöüß]+$/.test(w))
);

// Translation entry point for both SNAKE_CASE names and BMW's prose comments.
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
  if (parts.length > 1 && /^(EIN|AKTIV)$/i.test(parts[parts.length - 1]))
    parts.pop();
  // try NCS Dummy's whole-name translation before word-by-word
  return (
    datI18n(bare) ||
    datI18n(parts.join('_')) ||
    codTidy(codTranslate(parts.join(' '), true), name)
  );
}

// Sentence-case, never empty. Unknown words survive as BMW wrote them; lower-
// case the German SHOUTING but leave abbreviations (E36, IRS, K15) alone.
function codTidy(s, fallback) {
  // orig (EDIABAS) mode shows BMW's text verbatim; skip the case repair.
  if (typeof lang === 'function' && lang() === 'orig') {
    return String(s || '').trim() || fallback;
  }
  const t = String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[A-ZÄÖÜ]{4,}\b/g, (w) => (/\d/.test(w) ? w : w.toLowerCase()))
    // lower only plain Capitalised words; leave abbreviations, digit words and
    // this dictionary's own proper nouns (Switzerland) alone
    .replace(/(?!^)\b[A-ZÄÖÜ][a-zäöüß]{2,}\b/g, (w) =>
      COD_PROPER.has(w) ? w : w.toLowerCase()
    )
    // German's bare article between two nouns is an English genitive:
    // "Schwelle DER Geschwindigkeitswarnung" -> "threshold of the speed warning".
    .replace(/\b(\w+) the (\w+)/g, (m0, a, b) =>
      /^(is|not|on|in|to|for|or|and|if|of)$/i.test(a) ? m0 : `${a} of the ${b}`
    );
  if (!t) return fallback;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Some comments list what a value may hold ("E31,E32,E34,E36") rather than
// describing it. That's a hint, not a label -- detect it so codLabel uses the
// name and codHint shows the list.
function codIsEnumComment(c) {
  const t = c.trim();
  if (/,/.test(t) && !/\s/.test(t)) return true; // E31,E32,E34,E36
  if (/^'[^']*'(\s*,\s*'[^']*')*$/.test(t)) return true; // 'ECE', 'US'
  return false;
}

// The label: BMW's comment where there is one, else the name read as words.
function codLabel(f) {
  const c = (f.label || '').trim();
  if (c && !codIsEnumComment(c)) return codTidy(codTranslate(c, false), c);
  return codLabelFromName(f.name);
}

// BMW's comment when it's a permitted-values list, shown beside the field.
function codHint(f) {
  const c = (f.label || '').trim();
  return c && codIsEnumComment(c) ? c : '';
}

// Is this value on? The ECU answers 1/0, but some SGBDs answer in words. Both
// spellings of the negatives travel ("nicht aktiv" and "nicht_aktiv").
const COD_TRUE = new Set([
  '1',
  'ja',
  'ein',
  'aktiv',
  'vorhanden',
  'yes',
  'on',
  'true',
]);
const COD_FALSE = new Set([
  '0',
  'nein',
  'aus',
  'inaktiv',
  'nicht aktiv',
  'nicht_aktiv',
  'nicht vorhanden',
  'nicht_vorhanden',
  'no',
  'off',
  'false',
]);
function codIsOn(raw) {
  return COD_TRUE.has(
    String(raw ?? '')
      .trim()
      .toLowerCase()
  );
}
// Neither on nor off: a switch reading "34" means the read didn't answer this
// field; calling it "off" would be a lie.
function codKnown(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  return COD_TRUE.has(s) || COD_FALSE.has(s);
}

// Match a DATEN keyword to a value in an SGBD's coding read. The read names
// results differently (COD_*/STAT_*), so match on shared tokens and reduce the
// best hit to a number (numeric -> itself, boolean word -> 1/0). Returns null
// when nothing overlaps enough. Shared by the Expert tree and curated toggles.
function codMatchRead(kw, pairs) {
  const toks = (s) =>
    new Set(
      String(s)
        .replace(/^(COD|STAT|STATUS|CODIER)_/i, '')
        .toUpperCase()
        .split('_')
        .filter((t) => t.length > 2)
    );
  const kt = toks(kw);
  let best = null,
    bestOverlap = 0;
  for (const [name, val] of pairs) {
    const ov = [...kt].filter((t) => toks(name).has(t)).length;
    if (ov > bestOverlap && ov >= Math.min(2, kt.size)) {
      bestOverlap = ov;
      best = val;
    }
  }
  if (best == null) return null;
  const s = String(best).trim().toLowerCase();
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (codKnown(s)) return codIsOn(s) ? 1 : 0;
  return null;
}

// READ A SETTING OUT OF THE RAW CODING BLOB.
//
// codMatchRead above can only match a keyword against NAMED results. Several
// modules do not give names: on a real E46, zke5 answers COD_LESEN with one
// COD_DATEN byte array (and szm46 with CODE), so BEIKLAPPEN_GM -- and every
// other curated feature on that module -- matched nothing and read as unknown,
// which the UI then drew as off. Every one of those switches was showing the
// library default, not the car.
//
// BMW's DATEN description says exactly where each setting lives: block, word,
// mask and shift, with the on/off values named. That is enough to read the bit
// straight out of the bytes the ECU just returned.
//
// The word differs per coding index -- zke5's BEIKLAPPEN_GM is word 23 on C04
// and word 26 on C05+C06 -- so the variant must be chosen by the car's own
// index, never by taking the first one that names the keyword.
function codBytesOf(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map((b) => b & 0xff);
  if (ArrayBuffer.isView(v)) return Array.from(v, (b) => b & 0xff);
  const s = String(v).trim();
  // "System.Byte[]" and friends carry nothing; dashed/spaced hex does
  if (/^[0-9A-Fa-f]{2}([\s-][0-9A-Fa-f]{2})+$/.test(s)) {
    return s.split(/[\s-]+/).map((h) => parseInt(h, 16));
  }
  return null;
}

// The DATEN field for `kw` on the variant this car's coding index selects.
function codDatenField(daten, chassis, index, kw) {
  const byChassis = (daten && daten.chassis) || {};
  const variants =
    byChassis[String(chassis || '').toUpperCase()] ||
    byChassis[Object.keys(byChassis)[0]] ||
    {};
  const names = Object.keys(variants);
  if (!names.length) return null;
  // "C05+C06" serves both; match the index inside the name rather than equality
  const want = index == null ? null : `C${String(index).padStart(2, '0')}`;
  const pick = (want && names.find((n) => n.split('+').includes(want))) || null;
  const order = pick ? [pick] : names; // no index: fall back to any
  for (const n of order) {
    const f = (variants[n] || []).find((x) => x.name === kw);
    if (f) return { ...f, variant: n, exact: !!pick };
  }
  return null;
}

// Read one DATEN-described setting out of raw coding bytes. Returns 1/0 for a
// named aktiv/nicht_aktiv pair, the raw nibble otherwise, or null when the
// bytes or the definition are missing.
// EINHEIT: how a field's bytes become a number, as NCS Expert's own coding
// pipeline interprets it:
//
//   h  little-endian integer, LSB first          (the default)
//   a  the first byte, raw                       (ASCII code)
//   A  alphanumeric hex digit: '0'-'9' -> 0-9, 'A'-'Z' -> 10-35
//   b  bit-string: each byte is ASCII '0'/'1', byte i contributing bit i
//   d  ASCII decimal digits, concatenated and parsed
//
// Returns null for a byte a unit cannot represent, so a malformed read
// declines rather than inventing a value.
function codDecodeUnit(unit, bytes) {
  const u = unit || 'h';
  if (!bytes.length) return null;
  if (u === 'h') {
    let v = 0;
    for (let i = 0; i < bytes.length; i++) v |= (bytes[i] & 0xff) << (8 * i);
    return v >>> 0;
  }
  if (u === 'a') return bytes[0] & 0xff;
  if (u === 'A') {
    const c = bytes[0] & 0xff;
    if (c >= 0x30 && c <= 0x39) return c - 0x30; // '0'-'9'
    if (c >= 0x41 && c <= 0x5a) return c - 0x37; // 'A'-'Z' -> 10-35
    return null;
  }
  if (u === 'b') {
    let v = 0;
    for (let i = 0; i < bytes.length; i++) {
      const bit = (bytes[i] & 0xff) - 0x30;
      if (bit !== 0 && bit !== 1) return null;
      v |= bit << i;
    }
    return v >>> 0;
  }
  if (u === 'd') {
    let s = '';
    for (const b of bytes) {
      const c = b & 0xff;
      if (c < 0x30 || c > 0x39) return null;
      s += String.fromCharCode(c);
    }
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return null; // unit we do not implement: decline
}

// OPERATION: the transforms NCS Expert applies after the unit conversion,
// in order. Each is [operator, operand]; '!' takes no operand.
function codApplyOps(value, ops) {
  let v = value;
  for (const op of ops || []) {
    const k = Array.isArray(op) ? op[0] : op;
    const n = Array.isArray(op) ? op[1] >>> 0 : 0;
    switch (k) {
      case '!':
        break; // no-op marker
      case '&':
        v = (v & n) >>> 0;
        break;
      case '|':
        v = (v | n) >>> 0;
        break;
      case '^':
        v = (v ^ n) >>> 0;
        break;
      case '+':
        v = v + n;
        break;
      case '-':
        v = v - n;
        break;
      case '*':
        v = v * n;
        break;
      case '/':
        if (!n) return null;
        v = Math.floor(v / n);
        break;
      case '>':
        v = v >>> n;
        break;
      default:
        return null; // unknown operator: decline
    }
  }
  return v;
}

// Read one DATEN-described setting out of raw coding bytes, the way NCS Expert
// does: take `byte` bytes from `word`, mask them, convert per EINHEIT, then
// apply the OPERATION list. Returns 1/0 for a named aktiv/nicht_aktiv pair,
// the numeric value otherwise, or null when the bytes or definition are
// missing -- unknown is honest, a wrong toggle is not.
function codReadDaten(bytes, field) {
  if (!bytes || !field) return null;
  const i = typeof field.word === 'number' ? field.word : null;
  if (i == null || i < 0) return null;
  const nBytes =
    typeof field.byte === 'number' && field.byte > 0 ? field.byte : 1;
  if (i + nBytes > bytes.length) return null;
  // MASKE is per byte in NCS Expert; BMW ships a scalar here, which applies to
  // the byte the shift addresses (single-byte fields, 89% of the corpus). For
  // a multi-byte field a scalar mask cannot mean "one mask per byte", so it is
  // applied to the first and the rest pass whole -- matching the little-endian
  // fold the 'h' unit performs.
  const mask = typeof field.mask === 'number' ? field.mask : 0xff;
  const raw = [];
  for (let k = 0; k < nBytes; k++) {
    raw.push(k === 0 ? bytes[i] & mask : bytes[i + k] & 0xff);
  }
  let v = codDecodeUnit(field.unit, raw);
  if (v == null) return null;
  // the shift positions the masked field within its byte
  const shift = typeof field.shift === 'number' ? field.shift : 0;
  if (shift) v = v >>> shift;
  v = codApplyOps(v, field.ops);
  if (v == null) return null;
  const vals = field.values || [];
  // values are [name, hexString]; find the one this value means
  const hit = vals.find(([, hex]) => parseInt(hex, 16) === v);
  if (hit) {
    const n = String(hit[0]).toLowerCase();
    if (typeof codKnown === 'function' && codKnown(n)) {
      return typeof codIsOn === 'function' && codIsOn(n) ? 1 : 0;
    }
  }
  return v;
}

// The coding map, once. Returns the entry for an SGBD or null.
async function codingFor(sgbd) {
  if (typeof loadCodingMap !== 'function') return null;
  await loadCodingMap();
  const map = (typeof window !== 'undefined' && window.BMW_CODING_MAP) || null;
  if (!map || !sgbd) return null;
  return map[String(sgbd).toLowerCase()] || null;
}

// BMW's DATEN description of a module (bit/address -> function, settings named
// aktiv / nicht_aktiv), for ECUs whose SGBD names nothing. A module ships
// several coding variants; only the car's own coding index says which it wants,
// so the reference lists every variant rather than picking one.
async function datenFor(sgbd) {
  if (typeof loadDatenMap !== 'function') return null;
  await loadDatenMap();
  const map = (typeof window !== 'undefined' && window.BMW_DATEN_MAP) || null;
  if (!map || !sgbd) return null;
  return map[String(sgbd).toLowerCase()] || null;
}

// NCS Dummy's community translations, keyed by lowercased keyword. Returned as
// written -- already English, and codTidy would turn "(Japan)" into "(japan)".
// orig (EDIABAS) mode shows BMW's keyword untouched.
function datI18n(name) {
  if (typeof lang === 'function' && lang() === 'orig') return '';
  const t = (typeof window !== 'undefined' && window.BMW_DATEN_I18N) || null;
  return (t && name && t[String(name).toLowerCase()]) || '';
}

// Label for a DATEN keyword: community translation, else word-by-word, else raw.
function datLabel(name) {
  return datI18n(name) || codTidy(codTranslate(name, true), name);
}

// FSW stem -> legal values merged across every chassis/variant, sorted by
// value. Only real choices travel: a single wert_NN default is a number, a
// hex buffer is not a pick list.
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
          .filter(
            ([, v]) => typeof v === 'string' && /^[0-9a-f]{1,4}$/i.test(v)
          )
          .map(([n, v]) => [n, parseInt(v, 16)]);
        if (vals.length < 2) continue;
        const m =
          acc[f.name.toUpperCase()] || (acc[f.name.toUpperCase()] = new Map());
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

// Pair DATEN function names to a module's result names, which spell the same
// thing differently (COD_BL_LI_RE_KALTUEBERWACHUNG_EIN vs KALTUEBERWACHUNG_BL).
// Two rules, in order: (1) exact stem equality wins; (2) every DATEN token
// appears in the field's tokens, the DATEN name has >=2 tokens (one-token names
// like "BC" claim half a module), and the pairing is UNIQUE both ways.
// Ambiguous claims match nothing: a wrong pairing is worse than no list.
function codEnumMatch(names, enums) {
  const strip = (n) =>
    String(n)
      .replace(/^(COD|STAT|STATUS|CODIER)_/i, '')
      .toUpperCase();
  const toks = (n) =>
    new Set(
      strip(n)
        .split('_')
        .filter((t) => t && !/^(EIN|AKTIV)$/.test(t))
    );
  const out = new Map();
  const fields = names.map((n) => ({ n, stem: strip(n), t: toks(n) }));
  const claims = new Map(); // field name -> [enum, enum...]
  for (const [dn, en] of Object.entries(enums)) {
    const exact = fields.filter((x) => x.stem === dn);
    if (exact.length === 1) {
      out.set(exact[0].n, en);
      continue;
    }
    const dt = toks(dn);
    if (dt.size < 2) continue;
    const cands = fields.filter((x) => [...dt].every((t) => x.t.has(t)));
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

// BMW's DATEN coding sheet for a module, as a reference. A READING, NOT A
// READOUT: everything here is off the disk -- what the coding memory MEANS, not
// what this car holds. The address (block/word/byte/mask) is shown because it
// is what another coding tool wants and makes a value checkable against a
// known-good car.
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

    // search (lists get long -- LCM: 10,415 functions); matches BMW's keyword
    // as well as the English label
    const q = filter.trim().toLowerCase();
    const fields = q
      ? all.filter(
          (f) =>
            f.name.toLowerCase().includes(q) ||
            datLabel(f.name).toLowerCase().includes(q)
        )
      : all;

    // dropdowns, not cycling: a module may describe nine chassis and 33 indices
    const opt = (v, sel) =>
      `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v)}</option>`;

    setPanel();
    cont.innerHTML =
      `
      <div class="act-menu">
        <div class="act-menu-title">Coding map</div>
        <div class="act-menu-sub mono">${esc(ecu.sgbd)}.prg · DATEN ` +
      `${esc(daten.daten)}</div>
        <div class="dat-bar">
          ${
            chassis.length > 1
              ? `<label class="dat-pick">Chassis
            <select id="dat-ch">${chassis.map((c) => opt(c, ch)).join('')}</select>
          </label>`
              : `<span class="dat-pick-fixed mono">${esc(ch)}</span>`
          }
          ${
            variants.length > 1
              ? `<label class="dat-pick">Index
            <select id="dat-var">${variants.map((v) => opt(v, vname)).join('')}</select>
          </label>`
              : `<span class="dat-pick-fixed mono">index ${esc(vname)}</span>`
          }
          <input class="wiring-search dat-search" id="dat-q" type="search"
                 placeholder="Search functions…" value="${esc(filter)}"
                 autocomplete="off">
        </div>
        <div class="cod-note">
          <span class="cod-note-dim">${fields.length}` +
      `${q ? ` of ${all.length}` : ''} function` +
      `${fields.length === 1 ? '' : 's'} BMW's coding tool knows for this ` +
      `module. This is the map, read from disk — not this car's settings.` +
      `</span>
        </div>
        <div class="cod-list" id="dat-list"></div>
      </div>`;
    const list = cont.querySelector('#dat-list');

    fields.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'cod-row dat-row';
      // three kinds: named settings (aktiv=00/nicht_aktiv=01, a real choice);
      // one wert_NN entry (numeric field, byte is its DEFAULT); a long hex value
      // (buffer -- show the names, bytes as a tooltip)
      const vals = f.values || [];
      // numeric option names (wert_NN or the DATEN blob's bare line ids) mean
      // a numeric FIELD: show decimals, byte on hover -- same as the coding
      // tree. One value = the default, several = the fits BMW ships.
      const numName = (n) =>
        /^wert_\d+$/i.test(String(n)) || /^-?\d+$/.test(String(n));
      const allNum =
        vals.length > 0 &&
        vals.every(([n]) => numName(n)) &&
        vals.every(([, v]) => typeof v === 'string' && v.length <= 4);
      const isDefault = allNum;
      const shown = !vals.length
        ? '<span class="ink-faint">—</span>'
        : isDefault
          ? (() => {
              const uniq = [...new Set(vals.map(([, v]) => String(v)))].sort(
                (a, b) => parseInt(a, 16) - parseInt(b, 16)
              );
              return (
                `<span class="dat-val">` +
                `<span class="dat-val-n">${uniq.length === 1 ? 'default' : 'value'}</span>` +
                uniq
                  .map(
                    (v) =>
                      `<span class="dat-val-v mono" title="0x${esc(v)}">` +
                      `${parseInt(v, 16)}</span>`
                  )
                  .join('') +
                `</span>`
              );
            })()
          : (() => {
              // A buffer isn't a pick list: LWS5's KENNFELD is the same curve
              // once per chassis, so nine "16 bytes" chips say nothing.
              // Summarise those; a real choice still lists its settings.
              const long = vals.filter(
                ([, v]) => typeof v === 'string' && v.length > 4
              );
              if (long.length === vals.length && vals.length > 2) {
                const bytes = vals[0][1].length / 2;
                return (
                  `<span class="dat-val" title="${esc(
                    vals.map(([n, v]) => `${n}: ${v}`).join('\n')
                  )}">` +
                  `<span class="dat-val-n">${vals.length} variants</span>` +
                  `<span class="dat-val-v mono">${bytes} bytes each</span>` +
                  `</span>`
                );
              }
              return vals
                .map(([n, v]) => {
                  const big = typeof v === 'string' && v.length > 4;
                  return (
                    `<span class="dat-val"${big ? ` title="${esc(v)}"` : ''}>` +
                    `<span class="dat-val-n">${esc(datI18n(n) || codTranslate(n, true))}</span>` +
                    `<span class="dat-val-v mono">` +
                    `${big ? `${v.length / 2} bytes` : esc(v)}</span></span>`
                  );
                })
                .join('');
            })();
      // BMW's keyword under the English label, but only when they differ
      const label = datLabel(f.name);
      const same =
        label.toUpperCase().replace(/ /g, '_') === f.name.toUpperCase();
      row.innerHTML =
        `
        <span class="cod-name">${esc(same ? f.name : label)}
          ${same ? '' : `<span class="cod-hint mono">${esc(f.name)}</span>`}</span>
        <span class="cod-key mono">blk ${f.block} · word ${f.word}` +
        ` · byte ${f.byte} · mask 0x${f.mask.toString(16).padStart(2, '0')}</span>
        <span class="dat-vals">${shown}</span>`;
      list.appendChild(row);
    });

    const chSel = cont.querySelector('#dat-ch');
    if (chSel)
      chSel.onchange = () => {
        ch = chSel.value;
        vname = null;
        draw();
      };
    const vSel = cont.querySelector('#dat-var');
    if (vSel)
      vSel.onchange = () => {
        vname = vSel.value;
        draw();
      };

    // redraw on input, restoring the caret (the rebuild drops focus otherwise)
    const qEl = cont.querySelector('#dat-q');
    if (qEl) {
      qEl.oninput = () => {
        const at = qEl.selectionStart;
        filter = qEl.value;
        draw();
        const again = cont.querySelector('#dat-q');
        if (again) {
          again.focus();
          again.setSelectionRange(at, at);
        }
      };
    }

    const acts = [];
    if (q) {
      acts.push({
        key: '1',
        keyLabel: 'F1',
        label: 'Clear search',
        fn: () => {
          filter = '';
          draw();
        },
      });
    }
    if (back)
      acts.push({
        key: 'Escape',
        keyLabel: 'Esc',
        label: 'Back',
        kind: 'back',
        fn: back,
      });
    setActions(acts);
    sbLeft.textContent =
      `${ecu.sgbd}.prg · DATEN ${ch}/${vname} · ` +
      `${fields.length} function${fields.length === 1 ? '' : 's'}`;
    tipify(cont);
  };

  draw();
}
