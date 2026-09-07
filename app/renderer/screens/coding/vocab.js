/**
 * @file The coding vocabulary: one dictionary translating both a result NAME
 * and BMW's German comment into English, plus the label helpers every coding
 * screen shares.
 *
 * NOT the fault-phrase dictionary -- "auf" is "up" in prose, "on" here.
 * Longest match must win: German glues nouns together (KALTUEBERWACHUNG is one
 * word, not KALT + UEBERWACHUNG).
 */

/**
 * German keyword (uppercase) -> English gloss. Consulted longest-first by
 * {@link codTranslate}.
 * @type {Record<string, string>}
 */
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
/**
 * AUF/ZU mean different things in a NAME than in prose: TUER_AUF is "door
 * open", but "auf" as a preposition is "on". Sense picked by context.
 * @type {Record<string, string>}
 */
const COD_VOCAB_NAME = { AUF: 'open', ZU: 'closed' };
/**
 * The prose sense of the context-dependent words.
 * @type {Record<string, string>}
 */
const COD_VOCAB_TEXT = { AUF: 'on', ZU: 'to' };

/**
 * Every vocabulary key as one alternation, longest-first (KALTUEBERWACHUNG
 * over KALT + UEBERWACHUNG), including the context-sensitive words.
 * @type {RegExp}
 */
const COD_VOCAB_RE = new RegExp(
  '\\b(' +
    [...Object.keys(COD_VOCAB), ...Object.keys(COD_VOCAB_NAME)]
      .sort((a, b) => b.length - a.length)
      .join('|') +
    ')\\b',
  'gi'
);

/**
 * Place names this dictionary outputs stay capitalised mid-sentence, unlike
 * the German nouns around them.
 * @type {Set<string>}
 */
const COD_PROPER = new Set(
  Object.values(COD_VOCAB)
    .flatMap((v) => v.split(' '))
    .filter((w) => /^[A-ZÄÖÜ][a-zäöüß]+$/.test(w))
);

/**
 * Translate a SNAKE_CASE name or one of BMW's prose comments word by word.
 * @param {string|null|undefined} text - the German text.
 * @param {boolean} asName - pick the name sense of the context-dependent words.
 * @returns {string} the translated text ('' for empty input; the input
 *   untouched in orig/EDIABAS language mode).
 */
function codTranslate(text, asName) {
  if (!text) return '';
  if (typeof lang === 'function' && lang() === 'orig') return text;
  const ctx = asName ? COD_VOCAB_NAME : COD_VOCAB_TEXT;
  return String(text).replace(COD_VOCAB_RE, (m) => {
    const k = m.toUpperCase();
    return ctx[k] || COD_VOCAB[k] || m;
  });
}

/**
 * Sentence-case a translated string, never empty. Unknown words survive as
 * BMW wrote them; lower-case the German SHOUTING but leave abbreviations
 * (E36, IRS, K15) alone.
 * @param {string|null|undefined} s - the translated text.
 * @param {string} fallback - returned when the text is empty.
 * @returns {string} the tidied text.
 */
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

/**
 * The community translation of a DATEN keyword, keyed by lowercased keyword.
 * Returned as written -- already English, and codTidy would turn "(Japan)"
 * into "(japan)". orig (EDIABAS) mode shows BMW's keyword untouched.
 * @param {string|null|undefined} name - the DATEN keyword.
 * @returns {string} the translation, or '' when there is none.
 */
function datI18n(name) {
  if (typeof lang === 'function' && lang() === 'orig') return '';
  const t = (typeof window !== 'undefined' && window.BMW_DATEN_I18N) || null;
  return (t && name && t[String(name).toLowerCase()]) || '';
}

/**
 * Label for a DATEN keyword: community translation, else word-by-word, else
 * the raw keyword.
 * @param {string} name - the DATEN keyword.
 * @returns {string} the label.
 */
function datLabel(name) {
  return datI18n(name) || codTidy(codTranslate(name, true), name);
}

// The pieces the other coding screens call; published explicitly so the shared surface is visible.
if (typeof window !== 'undefined') {
  window.codTranslate = codTranslate;
  window.codTidy = codTidy;
  window.datI18n = datI18n;
  window.datLabel = datLabel;
}
