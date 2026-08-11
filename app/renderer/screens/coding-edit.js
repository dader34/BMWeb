// Coding: read what a module is coded to, and stage changes to it.
//
// BMW's own coding tool needs the DATEN files to make sense of a module: the
// ECU hands back a binary blob and DATEN says which bit at which address is
// "fold the mirrors on lock". For 32 of the ECUs we ship, none of that is
// needed -- the SGBD names its own coding values. LSZ's CODIERUNG_LESEN does
// not return a blob, it returns 42 named results:
//
//     COD_BL_LI_RE_KALTUEBERWACHUNG_EIN  int  "Kaltueberwachung fuer Bremslicht"
//
// which is the whole map, shipped in the .prg. tools/decompile/coding_map.py
// mines it into data/codingmap.js; this draws it.
//
// WRITES ARE BLOCKED. Eight of those ECUs expose a coding write whose argument
// list can be assembled from the values we can read, so the editor stages a
// change and shows exactly what would be sent -- and stops there. A coding
// write is an EEPROM write: get it wrong on a module that gates the immobiliser
// or the airbags and the car does not start, or worse. Arming this needs a
// verified round-trip on a car that can be recovered, which has not happened,
// so the send path deliberately does not exist rather than sitting behind a
// confirm dialog that a wrong keypress could clear.

// ---------------------------------------------------------------------------
// Coding vocabulary: ONE dictionary, both directions in.
//
// A coding value arrives labelled two ways and both are German: the result
// NAME (COD_FH_DEAKTIV_NACH_TUER_AUF_EIN) and, 65% of the time, BMW's own
// comment ("Kaltueberwachung fuer Bremslicht"). 35% carry no comment at all --
// ZKE4 and LCM name 89 flags and describe none -- so the name has to be
// readable on its own.
//
// This path does NOT use deGerman(). That table is tuned for fault text and
// prose captions, and on this vocabulary it half-translates: "Kaltueberwachung
// fuer Bremslicht" came out "Kaltmonitoring for Bremslicht", and "Offset auf
// Mindestdruck" became "Offset up Mindestdruck" because `auf` is "up" in
// prose and "on/at" here. A dictionary that knows THIS vocabulary translates
// names and comments alike, so a word learned once reads correctly in both.
//
// Compounds come first: German glues nouns together (KALTUEBERWACHUNG is one
// word, not KALT + UEBERWACHUNG), so the longest match has to win or the parts
// translate separately into nonsense.
const COD_VOCAB = {
  // --- systems, as BMW abbreviates them in result names ---
  FH: 'windows', FENSTERHEBER: 'windows', SHD: 'sunroof', ZV: 'central locking',
  ZAV: 'central locking', DWA: 'alarm', BC: 'on-board computer',
  KOMBI: 'instrument cluster', DME: 'engine ECU', EGS: 'transmission ECU',
  EKS: 'seat module', IHKA: 'climate control', KLR: 'climate control',
  RLS: 'rain sensor', LWR: 'headlight aim', ASP: 'mirror', FB: 'remote',
  FERNBEDIENUNG: 'remote', SITZHEIZUNG: 'seat heating', GURTWARNUNG: 'belt warning',
  NEIGUNGSGEBER: 'tilt sensor', BLS: 'brake light switch', IB: 'interior light',
  // --- lights ---
  STANDLICHT: 'side light', SL: 'side light', ABBLENDLICHT: 'low beam',
  AL: 'low beam', FERNLICHT: 'high beam', FL: 'high beam',
  BREMSLICHT: 'brake light', BL: 'brake light', BREMSLICHTSCHALTER: 'brake light switch',
  NEBELSCHLUSSLICHT: 'rear fog light', NSL: 'rear fog light',
  NEBELSCHEINWERFER: 'front fog light', NSW: 'front fog light',
  KENNZEICHENLICHT: 'plate light', KZL: 'plate light',
  RUECKLICHT: 'tail light', RUECKFAHRSCHEINWERFER: 'reversing light',
  RFS: 'reversing light', BLINKER: 'indicator', WARNBLINKER: 'hazards',
  INNENLICHT: 'interior light', LICHT: 'light',
  // --- parts of the car ---
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
  // the tail: everything a corpus pass over all 567 labels still left German
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
  // --- the long tail, from a pass over every word in all 567 labels ---
  // instrument cluster / on-board computer
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
  // body / locking / alarm
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
  // lighting
  ANHAENGER: 'trailer', ANHAENGERLICHT: 'trailer light',
  PARKLICHT: 'parking light', STANDLICHTAUSFALL: 'side-light failure',
  ERSATZFUNKTION: 'substitute function', BEDIMMTE: 'dimmed',
  BETRIEBSSTUNDENZAEHLERLOESCHUNG: 'hour-counter reset',
  LAMPENWECHSEL: 'bulb change', WARNBLINKEN: 'hazard flashing',
  MITTE: 'centre', BLK: 'indicator', ZYKLUSZEIT: 'cycle time',
  ABSCHALTET: 'switches off', VOLT: 'volt',
  // seats / mirrors / roof
  ABKLAPP: 'fold', ABKLAPPEN: 'fold', SPIEGELHEIZEN: 'mirror heating',
  PERMANENTES: 'permanent', INVERTIERT: 'inverted', INVERTIERTER: 'inverted',
  LENKSAEULENVERSTELLSCHALTER: 'steering-column adjust switch',
  TIPPTASTENBETRIEB: 'momentary-switch mode', FREI: 'free',
  AKTIVSITZ: 'active seat', SONNENROLLO: 'sun blind',
  UMKEHRZEIT: 'reversal time', VERDECKMOTOR: 'roof motor',
  KLAPPE: 'flap', MOTORHAUBENKONTAKTE: 'bonnet contacts',
  // chassis / engine
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
  // wipers / misc
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
  // ABREGEL, ...) are BMW's own abbreviations, and a "translation" would
  // only invent a long form nobody uses. Same for the units (MPH, MPG).
  // --- position ---
  VORN: 'front', VORNE: 'front', HINTEN: 'rear', LINKS: 'left',
  RECHTS: 'right', LI: 'left', RE: 'right', OBEN: 'upper', UNTEN: 'lower',
  LINKSLENKER: 'left-hand drive', RECHTSLENKER: 'right-hand drive',
  // --- states and verbs ---
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
  // --- measurement ---
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

// Longest-first, so KALTUEBERWACHUNG wins over KALT and UEBERWACHUNG.
// Built after the context-sensitive words below, which it also has to match.
let COD_VOCAB_RE;

// A few words mean different things in a NAME than in a SENTENCE, and getting
// this wrong is exactly the failure that made the general translator unusable
// here ("Offset auf Mindestdruck" -> "Offset up Mindestdruck"). AUF after a
// part of the car is that part standing open (TUER_AUF, "door open"); in prose
// it is the preposition. So the sense is chosen by context rather than by one
// global entry that has to be wrong half the time.
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
  const parts = String(name).replace(/^(COD|STAT|STATUS|CODIER)_/i, '')
    .split('_').filter(Boolean);
  // a trailing _EIN/_AKTIV on a switch is the boolean marker, not the word
  if (parts.length > 1 && /^(EIN|AKTIV)$/i.test(parts[parts.length - 1])) parts.pop();
  return codTidy(codTranslate(parts.join(' '), true), name);
}

// sentence case, and never return an empty label.
//
// A word this dictionary does not know survives as BMW wrote it, which in a
// result name means SHOUTING ("Type SCHLOSS SIGNALE"). Lower-casing those puts
// them back in the sentence, but only when they are ordinary words: E36, IRS,
// K15 and the like are genuine abbreviations and stay as they are.
function codTidy(s, fallback) {
  // EDIABAS-faithful mode shows BMW's text exactly as BMW wrote it, so the
  // case repair -- which exists only to undo German noun capitalisation after
  // translation -- must not run.
  if (typeof lang === 'function' && lang() === 'orig') {
    return String(s || '').trim() || fallback;
  }
  const t = String(s || '').replace(/\s+/g, ' ').trim()
    .replace(/\b[A-ZÄÖÜ]{4,}\b/g, w => (/\d/.test(w) ? w : w.toLowerCase()))
    // German capitalises every noun and the translation inherits it, leaving
    // "Unit for Offset of the minimum pressure" mid-sentence. Only plain
    // Capitalised words are lowered -- an all-caps abbreviation (AC, KO, IRS)
    // and anything with a digit (E36, K15) are left exactly as BMW wrote them,
    // as are the proper nouns this dictionary itself produces (Switzerland).
    .replace(/(?!^)\b[A-ZÄÖÜ][a-zäöüß]{2,}\b/g,
             w => (COD_PROPER.has(w) ? w : w.toLowerCase()))
    // German puts a bare article where English needs a genitive: "Schwelle
    // DER Geschwindigkeitswarnung" translates word-for-word to "threshold the
    // speed warning". Between two nouns, that article is "of the".
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

// Is this value on? The ECU answers 1/0, but demo mode and some SGBDs answer
// in words, and a coding flag reads "ja"/"aktiv"/"ein" just as readily.
const COD_TRUE = new Set(['1', 'ja', 'ein', 'aktiv', 'vorhanden', 'yes', 'on', 'true']);
const COD_FALSE = new Set(['0', 'nein', 'aus', 'inaktiv', 'nicht vorhanden', 'no', 'off', 'false']);
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

// BMW's DATEN description of the same module, for the ECUs whose SGBD
// names nothing. Where the SGBD hands back one opaque CODIER_DATA buffer,
// this says which bit at which address is which function -- and, unlike the
// SGBD, what the settings are actually CALLED (aktiv / nicht_aktiv).
//
// One module ships several coding variants and nothing on the bench says
// which a given car wants: that comes from the module's own coding index,
// which is only knowable with the car connected. So the reference lists
// every variant rather than picking one.
async function datenFor(sgbd) {
  if (typeof loadDatenMap !== 'function') return null;
  await loadDatenMap();
  const map = (typeof window !== 'undefined' && window.BMW_DATEN_MAP) || null;
  if (!map || !sgbd) return null;
  return map[String(sgbd).toLowerCase()] || null;
}

// NCS Dummy's community translations (Translations.csv, revtor et al.),
// generated into datenmap.js beside the map itself and keyed by lowercased
// keyword. Returned as written: it is already plain English, and codTidy's
// case repair exists to undo German noun capitalisation -- run on real
// English it turns "(Japan)" into "(japan)". EDIABAS-faithful mode shows
// BMW's keyword untouched, the same rule every translation here follows.
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

// TURNED OFF. Flip to true to put the Coding map back on the ECU menu.
//
// The screen and its data are intact -- this is the one gate every entry
// point runs through (the tile, the INPA row, the C key, and the hook that
// survives a submenu redraw), so switching it here removes all of them
// without disturbing the code that draws them.
const CODING_MAP_ENABLED = false;

// Does this ECU have a coding page worth offering? Used by the ECU menu to
// decide whether to show the key at all. Either source will do: the SGBD's
// own named values, or BMW's DATEN description of its blob.
async function hasCoding(sgbd) {
  if (!CODING_MAP_ENABLED) return false;
  return !!(await codingFor(sgbd)) || !!(await datenFor(sgbd));
}

// BMW's DATEN coding sheet for a module, as a reference.
//
// A READING, NOT A READOUT. Everything here comes off the disk: this is
// what the module's coding memory MEANS, not what this car currently holds.
// Turning it into live values needs the coding blob off the car and the
// module's own coding index to pick the variant, neither of which the app
// reads yet -- so the screen says so rather than implying otherwise.
//
// The address is shown because it is the useful part: block, word, byte and
// mask are exactly what another coding tool wants, and what makes a value
// checkable against a known-good car.
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

    // SEARCH, because these lists got long. LCM carries 10,415 functions
    // across its variants and scrolling that to find one is not reading, it
    // is hunting. Matches BMW's own keyword as well as the English label,
    // since the keyword is what another coding tool will show you.
    const q = filter.trim().toLowerCase();
    const fields = q
      ? all.filter(f => f.name.toLowerCase().includes(q)
          || datLabel(f.name).toLowerCase().includes(q))
      : all;

    // DROPDOWNS, not one-at-a-time cycling. This module may describe nine
    // chassis and thirty-three coding indices; a softkey that steps through
    // them one press at a time is unusable at that size, and the earlier
    // version had exactly that because the data was two chassis deep.
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
      // WHAT BMW ACTUALLY LISTS, which is three different things:
      //
      //   several named settings   aktiv=00 / nicht_aktiv=01, a real choice
      //   one wert_NN entry        not a choice at all: a numeric field, and
      //                            the byte is its DEFAULT. 5,562 rows are
      //                            this, and printing "value" threw the
      //                            number away.
      //   a long hex value         a buffer, usually a characteristic curve
      //                            or a country parameter block. Showing it
      //                            whole is unreadable and dropping it lost
      //                            PROGRAMMPARAMETER_LCM's seven country
      //                            variants entirely, so the NAMES show and
      //                            the bytes are a tooltip.
      const vals = f.values || [];
      const isDefault = vals.length === 1 && /^wert_\d+$/i.test(vals[0][0]);
      const shown = !vals.length
        ? '<span class="ink-faint">—</span>'
        : isDefault
          ? `<span class="dat-val"><span class="dat-val-n">default</span>`
            + `<span class="dat-val-v mono">0x${esc(vals[0][1])}</span></span>`
          : (() => {
              // A BUFFER PARAMETER IS NOT A PICK LIST. LWS5's KENNFELD rows
              // carry the same 16-byte characteristic curve once per chassis
              // (e38, e39, e46 ...), and rendering nine "16 bytes" chips wraps
              // over four lines and says nothing. Summarise those and let the
              // row stay one line; a real choice still lists its settings.
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
      // BMW's keyword under the English label, but only when translating
      // actually said something. Two thirds of these now come from NCS
      // Dummy's community translations; the rest fall back to the coding
      // dictionary, which mostly returns the keyword with underscores
      // swapped for spaces -- and a second line repeating the first is
      // noise, not context.
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

    // redraw on input, keeping the caret where it was: the whole panel is
    // rebuilt, so the field would otherwise lose focus on every keystroke
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

// The coding screen. `back` returns to whatever opened it.
async function showCoding(ecu, container, back, chassisId) {
  const cont = container || view;
  // .view owns the page's padding AND its scrolling (inset + overflow-y).
  // Overwriting its class with .results-panel takes both away: the rows run to
  // the window edge and the list cannot be scrolled past the fold. Screens
  // normally render into a CHILD of .view, so restyle only when this is one.
  const setPanel = () => { if (cont !== view) cont.className = 'results-panel'; };
  const entry = await codingFor(ecu.sgbd);
  if (!entry) {
    // No named values in the SGBD. BMW's DATEN files may still describe
    // this module's blob, which is the whole point of them.
    const daten = await datenFor(ecu.sgbd);
    if (daten) return showDatenReference(ecu, daten, cont, setPanel, back,
                                         chassisId);
    setPanel();
    cont.innerHTML = errorBlock(
      `${ecu.sgbd}.prg does not name its coding values, and BMW's DATEN files `
      + `carry no description of this module either. There is nothing to label.`);
    if (back) setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: back }]);
    return;
  }

  // staged edits: field name -> the value the user set it to
  const staged = new Map();
  let current = new Map();     // what the ECU last answered
  let readOk = false;

  const write = entry.write && entry.write.supported ? entry.write : null;
  // which staged values the write could actually carry: an argument is only
  // sendable if the mine paired it to a value we can read
  const writable = new Set(
    (write ? write.args : []).filter(a => a.from).map(a => a.from));

  const draw = () => {
    const inpa = inpaMode();
    setPanel();
    const changed = [...staged.keys()].filter(k => {
      const cur = current.get(k);
      return codKnown(cur) || cur != null
        ? String(staged.get(k)) !== String(codIsOn(cur) ? 1 : 0)
          && String(staged.get(k)) !== String(cur).trim()
        : true;
    });

    cont.innerHTML = `
      <div class="act-menu">
        <div class="act-menu-title">Coding</div>
        <div class="act-menu-sub mono">${esc(ecu.sgbd)}.prg · ${esc(entry.read)}</div>
        <div class="cod-note" id="cod-note"></div>
        <div class="cod-list ${inpa ? 'cod-inpa' : ''}" id="cod-list"></div>
      </div>`;
    const list = cont.querySelector('#cod-list');
    const note = cont.querySelector('#cod-note');

    if (!readOk) {
      note.innerHTML = `<span class="cod-note-dim">Not read yet — `
        + `press Read to ask the module what it is coded to.</span>`;
    } else if (!changed.length) {
      note.innerHTML = `<span class="cod-note-dim">`
        + `${entry.fields.length} value${entry.fields.length === 1 ? '' : 's'} read`
        + `${write ? '' : ' · this module exposes no coding write'}</span>`;
    } else {
      note.innerHTML = `<span class="cod-note-staged">${changed.length} change`
        + `${changed.length === 1 ? '' : 's'} staged</span>`
        + `<span class="cod-note-dim"> · nothing has been sent to the car</span>`;
    }

    entry.fields.forEach(f => {
      const cur = current.get(f.name);
      const has = current.has(f.name);
      const isStaged = staged.has(f.name);
      const row = document.createElement('div');
      row.className = 'cod-row'
        + (isStaged ? ' staged' : '')
        + (write && !writable.has(f.name) ? ' cod-nowrite' : '');

      // the value cell: a toggle for a switch, the value for anything else
      let valueHtml;
      if (!has) {
        valueHtml = `<span class="cod-val ink-faint">—</span>`;
      } else if (f.switch || codKnown(cur)) {
        const on = isStaged ? staged.get(f.name) === 1 : codIsOn(cur);
        valueHtml = `<button class="cod-toggle${on ? ' on' : ''}" data-f="${esc(f.name)}">`
          + `<span class="cod-lamp">${on ? '●' : '○'}</span>`
          + `<span class="cod-state">${on ? 'on' : 'off'}</span></button>`;
      } else {
        const shown = isStaged ? staged.get(f.name) : cur;
        valueHtml = `<button class="cod-num" data-f="${esc(f.name)}">`
          + `${esc(shown)}</button>`;
      }

      const hint = codHint(f);
      row.innerHTML = `
        <span class="cod-name">${esc(codLabel(f))}${hint
          ? `<span class="cod-hint">${esc(hint)}</span>` : ''}</span>
        <span class="cod-key mono">${esc(f.name)}</span>
        ${valueHtml}
        ${isStaged ? `<span class="cod-was mono">was ${esc(
            codKnown(cur) ? (codIsOn(cur) ? 'on' : 'off') : cur)}</span>` : '<span></span>'}`;
      list.appendChild(row);
    });

    // A switch flips; a number is typed. Neither sends anything.
    list.querySelectorAll('.cod-toggle').forEach(b => b.onclick = () => {
      const name = b.dataset.f;
      const cur = codIsOn(current.get(name)) ? 1 : 0;
      const now = staged.has(name) ? staged.get(name) : cur;
      const next = now ? 0 : 1;
      if (next === cur) staged.delete(name); else staged.set(name, next);
      draw();
    });
    list.querySelectorAll('.cod-num').forEach(b => b.onclick = async () => {
      const name = b.dataset.f;
      const field = entry.fields.find(f => f.name === name);
      const val = await inputDialog({
        title: codLabel(field),
        body: `<span class="mono">${esc(name)}</span>`
          // BMW's own comment, but only when it says something the title does
          // not already say -- the title IS the translated comment
          + (codHint(field) ? `<br>Valid values: ${esc(codHint(field))}` : '')
          + `<br><br>The module currently reports `
          + `<b>${esc(current.get(name))}</b>. Changing this stages the value; `
          + `nothing is sent to the car.`,
        kind: field.type === 'int' ? 'number' : 'text',
        example: String(current.get(name) ?? ''),
        confirmLabel: 'Stage',
      });
      if (val == null || val === '') return;
      if (String(val).trim() === String(current.get(name)).trim()) staged.delete(name);
      else staged.set(name, String(val).trim());
      draw();
    });

    tipify(cont);
    setKeys();
  };

  const doRead = async () => {
    sbLeft.textContent = `${entry.read}…`;
    const list = cont.querySelector('#cod-list');
    if (list) list.innerHTML = `<div class="empty"><span class="loader"></span>`
      + `<span>Reading coding…</span></div>`;
    try {
      const d = await api(`/api/ecu/${ecu.sgbd}/run/${entry.read}`, { method: 'POST' });
      current = new Map(flatResults(d.sets));
      readOk = true;
      const got = entry.fields.filter(f => current.has(f.name)).length;
      sbLeft.textContent = `${entry.read} · ${got}/${entry.fields.length} values`;
    } catch (e) {
      readOk = false;
      setPanel();
      cont.innerHTML = errorBlock(e.message);
      sbLeft.textContent = 'read failed';
      setKeys();
      return;
    }
    draw();
  };

  // What WOULD be sent, spelled out. This is the whole point of staging: you
  // can see the exact job and arguments, and check them against a known-good
  // coding, without the app being able to send them.
  const showPending = () => {
    const rows = [...staged.entries()].map(([name, val]) => {
      const f = entry.fields.find(x => x.name === name);
      const arg = write ? (write.args.find(a => a.from === name) || {}).name : null;
      return `<div class="ident-line">`
        + `<span class="ident-lk">${esc(codLabel(f))}</span>`
        + `<span class="ident-lc">:</span>`
        + `<span class="ident-lv">${esc(val)}`
        + (arg ? ` <span class="ink-faint">→ ${esc(arg)}</span>`
               : ` <span class="cod-note-warn">no write argument</span>`)
        + `</span></div>`;
    }).join('');

    const canSend = write && [...staged.keys()].every(k => writable.has(k));
    confirmDialog({
      title: 'Staged changes',
      body: `<div class="ident-card">${rows || '<div class="empty">Nothing staged.</div>'}</div>`
        + `<br><div class="cod-blocked">`
        + (write
            ? `<b>Not sent.</b> ${esc(ecu.sgbd)}.prg exposes `
              + `<span class="mono">${esc(write.job)}</span>`
              + (canSend
                  ? `, and these values map onto its arguments.`
                  : `, but some of these values do not map onto its arguments.`)
              + ` Sending is disabled: a coding write is an EEPROM write, and `
              + `this app has not verified a round-trip on a car that can be `
              + `recovered. Use this list to check the change, not to apply it.`
            : `<b>Not sent.</b> ${esc(ecu.sgbd)}.prg exposes no coding write `
              + `that can be assembled from named values, so there is nothing `
              + `to send even if sending were enabled.`)
        + `</div>`,
      confirmLabel: 'OK', cancelLabel: 'Close',
    });
  };

  const setKeys = () => {
    const acts = [
      { key: '1', keyLabel: 'F1', label: readOk ? 'Re-read' : 'Read',
        kind: 'primary', fn: doRead },
    ];
    if (staged.size) {
      acts.push({ key: '2', keyLabel: 'F2', label: `Review (${staged.size})`,
                  fn: showPending });
      acts.push({ key: '3', keyLabel: 'F3', label: 'Discard',
                  fn: () => { staged.clear(); draw(); } });
    }
    if (back) acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                          kind: 'back', fn: back });
    setActions(acts);
  };

  draw();
  doRead();
}
