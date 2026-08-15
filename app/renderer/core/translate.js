// German → English translation tables and helpers, shared across the renderer.
// Pure lookup/rewrite, no DOM. Gated on Settings language (lang()==='orig'
// keeps raw German for EDIABAS-faithful mode).
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
// INPA's softkey captions, cut to fit the F-key bar. Matched as WHOLE labels
// (anchored): a substring rule would corrupt longer text containing one.
const INPA_CAPTIONS = new Map(Object.entries({
  // fault memories: EM/IM/HM are Fehler-/Info-/Historienspeicher
  'Read EM': 'Read fault memory', 'Clear EM': 'Clear fault memory',
  'Read IM': 'Read info memory', 'Clear IM': 'Clear info memory',
  'Read HM': 'Read history memory', 'Clear HM': 'Clear history memory',
  'FS Read': 'Read fault memory', 'FS Clear': 'Clear fault memory',
  'IS Read': 'Read info memory', 'IS Clear': 'Clear info memory',
  'HS Read': 'Read history memory', 'HS Clear': 'Clear history memory',
  'Shadow': 'Info memory', 'Quick': 'Quick read',
  // climate / actuator abbreviations
  'W-valve': 'Water valve', 'Dig.out': 'Digital outputs',
  'Rep.pos': 'Repair position', 'Freshair': 'Fresh air flap',
  'Air circ.': 'Air circulation flap', 'Defrost': 'Defroster flap',
  'Rear c.': 'Rear compartment flap', 'Ventil.': 'Ventilation flap',
  'Stratif.': 'Stratification flap', 'Footwell': 'Footwell flap',
  'Comp.act': 'Cancel compressor deactivation', 'Compr.': 'Compressor',
  'Rear w.': 'Rear window defogger', 'Windsh.': 'Windshield defogger',
  'Aux. fan': 'Auxiliary fan', 'Lock v.': 'Lock valve',
  'Cali. run': 'Calibration run', 'Init': 'Initialise',
  'Displaytest': 'Display test', 'Testbild': 'Test pattern',
  // common softkeys
  'I/O state': 'I/O status', 'Seat pos.': 'Seat position',
  'km reset': 'Reset kilometres', 'Commtest': 'Communication test',
  // Only genuine abbreviations belong here: short English words (Display, Flap,
  // Sensors) are real captions on other ECUs and expanding them invents meaning.
}));

// token-level German -> English, applied IN ORDER: longer compounds and
// multi-word phrases first so they win before their fragments rewrite a piece.
const DE_TOKENS = [
  // captions INPA leaves in German
  [/^Zurück\/control beenden$/i, 'Back / end control'],
  [/^Sitzhzg\.?$/i, 'Seat heating'],
  [/^Eingänge$/i, 'Inputs'],
  [/^Ausgänge$/i, 'Outputs'],
  [/^Speichern$/i, 'Save'],
  [/^Speicher$/i, 'Memory'],
  [/^Abbruch$/i, 'Cancel'],
  [/^Beenden$/i, 'End'],
  [/^Weiter$/i, 'Continue'],
  [/^weiter$/i, 'continue'],
  [/^Alle$/i, 'All'],
  [/^Ausw\.?$/i, 'Select'],
  [/^Variante$/i, 'Variant'],
  // RDC (tire pressure) result descriptions. compounds first.
  [/Anzahl '([^']+)'-Ereignisse/gi, "'$1' event count"],
  [/Anzahl '([^']+)'-Meldungen/gi, "'$1' messages"],
  [/\bReifenpannen?\b/gi, 'flat tire'],
  [/\bReifendruck-?pruefen\b/gi, 'check tire pressure'],
  [/\bReifendruck\b/gi, 'tire pressure'],
  [/\bSensor-?defekt\b/gi, 'sensor defective'],
  [/\bRE-?sendet-?nicht\b/gi, 'wheel unit not transmitting'],
  [/\bRE-?ueberhitzt\b/gi, 'wheel unit overheated'],
  [/\bDruck-?pruefen\b/gi, 'check pressure'],
  [/\bzugeordnet\+bestaetigt\b/gi, 'assigned + confirmed'],
  [/\btemporaerer Inaktiv-?Zustaende\b/gi, 'temporary inactive states'],
  [/\bEigenraderkennung\b/gi, 'own-wheel detection'],
  [/\bRadbatterie Restleben\b/gi, 'wheel battery remaining life'],
  [/\bRadsolldruck\b/gi, 'wheel target pressure'],
  [/\banaloger RSSI Summenpegel\b/gi, 'analogue RSSI total level'],
  [/\bempfangener RE-Telegramme\b/gi, 'received wheel-unit telegrams'],
  [/\bGuete der Empfaenge in Prozent\b/gi, 'reception quality in percent'],
  [/\bRad (\d+)\b/g, 'Wheel $1'],
  [/\bRadtemperatur\b/gi, 'wheel temperature'],
  [/\bRaddruck\b/gi, 'wheel pressure'],
  [/\bRadposition\b/gi, 'wheel position'],
  [/\bin Monaten\b/gi, 'in months'],
  [/\bGrad Celsius\b/gi, '°C'],
  [/\baktueller?\b/gi, 'current'],
  // wheel positions. Case-sensitive on purpose: VL/HL match inside words under /i.
  [/\bVL\b/g, 'FL'], [/\bVR\b/g, 'FR'],
  [/\bHL\b/g, 'RL'], [/\bHR\b/g, 'RR'],
  [/\bKalibrierung\b/gi, 'calibration'],
  [/\babgebrochen\b/gi, 'aborted'],
  [/\bbestaetigt\b/gi, 'confirmed'],
  // climate actuator names (IHKA STEUERN_*). compounds first, else "Heizspannung"
  // -> the hybrid "Heizvoltage".
  [/\bHeizspannung\b/gi, 'Heater voltage'],
  [/\bStandheizung\b/gi, 'Auxiliary heater'],
  [/\bZusatzheizung\b/gi, 'Supplementary heater'],
  [/\bKlimakompressor\b/gi, 'A/C compressor'],
  [/\bSperrventil\b/gi, 'Shut-off valve'],
  [/\bWasserventil\b/gi, 'Water valve'],
  [/\bZusatzwasserpumpe\b/gi, 'Auxiliary water pump'],
  [/\bZusatzluefter\b|\bZusatzlüfter\b/gi, 'Auxiliary fan'],
  [/\bUmluftklappe\b/gi, 'Recirculation flap'],
  [/\bFrischluftklappe\b/gi, 'Fresh air flap'],
  [/\bKlappenposition\b/gi, 'Flap position'],
  [/\bHeckscheibe\b/gi, 'Rear window'],
  [/\bFrontscheibe\b/gi, 'Windscreen'],
  // KO = Kompressor, the A/C compressor request to the DME
  [/\bDME[\s_]KO\b/gi, 'A/C compressor request (DME)'],
  [/\bDME[\s_]AC\b/gi, 'A/C enable (DME)'],

  // climate/body jargon INPA prints in its own English (not German, so nothing
  // above touches it). Stratification = airflow layering; AUC = air-quality sensor.
  [/Stratification potentiometer/gi, 'Air layering flap position'],
  [/Stratification flap/gi, 'Air layering flap'],
  [/\bStratification\b/gi, 'Air layering'],
  // compounds first; and the replacements must not contain "AUC" or the bare
  // rule below nests the parenthetical.
  [/\bAUC\s+sensor\b/gi, 'Air-quality sensor'],
  [/\bAUC\s+heating\b/gi, 'Air-quality sensor heating'],
  [/\bAUC\s+supply\b/gi, 'Air-quality sensor supply'],
  [/\bAUC\b(?!\w)/g, 'Air quality'],
  [/\bClamp\s*30\b/gi, 'Terminal 30 (battery feed)'],
  [/\bClamp\s*15\b/gi, 'Terminal 15 (ignition)'],
  [/\bClamp\s*R\b/gi, 'Terminal R (accessory)'],
  [/\bVia K-?Bus\b/gi, 'via K-bus'],
  [/\bPhototransistor\b/gi, 'Sun sensor (phototransistor)'],
  [/degrees C\b/gi, '°C'],

  // INPA root-menu captions. Whole captions ahead of every word rule, else
  // "Fehlerspeicher" -> "faultspeicher"; and a word table can't reorder
  // verb-last German ("Fehlerspeicher lesen"), so translate as units.
  [/^Fehlerspeicher$/i, 'Error memory'],
  [/^Fehlerspeicher lesen$/i, 'Read error memory'],
  [/^Fehlerspeicher lesen Detail$/i, 'Read error memory (detail)'],
  [/^Fehlerspeicher l(ö|oe)schen$/i, 'Clear error memory'],
  [/^Fehlerspeicher mit [Ff]reeze [Ff]rame Daten$/i,
   'Read error memory with freeze frame'],
  [/^Fehlerspeicher HEX-Dump \(Detail\)$/i, 'Error memory hex dump (detail)'],
  [/^Infospeicher lesen$/i, 'Read info memory'],
  [/^Infospeicher l(ö|oe)schen$/i, 'Clear info memory'],
  [/^Historienspeicher l(ö|oe)schen$/i, 'Clear history memory'],
  [/^Digitalwerte?$/i, 'Digital values'],
  [/^analoge Messwertbl(ö|oe)cke$/i, 'Analogue measurement blocks'],
  [/\bMesswertbl(ö|oe)cke?\b/gi, 'measurement blocks'],
  [/\bMesswerte?\b/gi, 'measured value'],
  [/\bGebersignale?\b/gi, 'sensor signals'],
  [/\bStartwertabgleich\b/gi, 'start value matching'],
  [/\bAbgasregelung\b/gi, 'emission control'],
  [/\bLambda[- ]?Sonden?\b/gi, 'lambda sensor'],
  [/\bAdaption\b/gi, 'adaptation'],
  [/^Bildschirm drucken$/i, 'Print screen'],
  [/^INPA beenden$/i, 'Exit INPA'],
  // these verbs must come after the phrases above, else "Bildschirm print"
  [/\bdrucken\b/gi, 'print'], [/\bspeichern\b/gi, 'save'],
  [/^Historienspeicher lesen$/i, 'Read history memory'],
  [/^Anpassungswerte selektiv l(ö|oe)schen$/i,
   'Clear selected adaptation values'],
  [/^Speicher lesen erweitert$/i, 'Read memory (extended)'],
  // compounds before the bare /Fehler/ rule, else "faultspeicher lesen"
  [/\bFehlerspeicher(s|n)?\b/gi, 'error memory'],
  [/\bInfospeicher(s|n)?\b/gi, 'info memory'],
  [/\bHistorienspeicher(s|n)?\b/gi, 'history memory'],
  [/\bAnpassungswerte?\b/gi, 'adaptation values'],
  [/\bStellgliedansteuerung(en)?\b/gi, 'actuator activation'],
  [/\bStellglied(er)?\b/gi, 'actuator'],
  [/\bSystemdiagnose(n)?\b/gi, 'system diagnostics'],
  [/\bSG-Identifikation\b/gi, 'ECU identification'],
  [/\bAnwenderInfoFeld\b/gi, 'user info field'],
  [/\bKommentar einf(ü|ue)gen\b/gi, 'insert comment'],
  [/\bAbspeicherung\b/gi, 'saving'],
  [/\bselektiv\b/gi, 'selective'],

  [/^Status lesen$/i, 'Read status'],
  [/^Speicher lesen$/i, 'Read memory'],
  [/^Identifikation$/i, 'Identification'],
  [/^Codierung$/i, 'Coding'],
  [/^Ansteuern$/i, 'Activate'],
  [/^Informationen?$/i, 'Information'],

  // job-name verbs/nouns (humanized SGBD job names)
  [/\bPruefen\b|\bPrüfen\b/gi, 'Check'], [/\bLesen\b/gi, 'Read'],
  [/\bSchreiben\b/gi, 'Write'], [/\bSetzen\b/gi, 'Set'], [/\bLoeschen\b|\bLöschen\b/gi, 'Clear'],
  [/\bSteuern\b/gi, 'Activate'], [/\bSignatur\b/gi, 'Signature'],
  [/\bBlocklaenge\b|\bBlocklänge\b/gi, 'Block length'], [/\bZeiten\b/gi, 'Times'],
  // job-argument dialog terms (SGBD _ARGUMENTS schema)
  [/Datum der SG-Programmierung/gi, 'date of ECU programming'],
  // SGBD result descriptions (Service/Special/Other cards). Full ARGCOMMENT
  // sentences first, else the single-word rules make half-German hybrids.
  [/Gibt das aktuelle gew(ä|ae)hlte Protokoll aus/gi, 'currently selected protocol'],
  [/Anzahl der Diagnoseprotokolle/gi, 'number of diagnostic protocols'],
  [/f(ü|ue)r Pr(ü|ue)fablauf Bandende/gi, 'for end-of-line test'],
  [/Pr(ü|ue)fablauf Bandende/gi, 'end-of-line test'],
  [/die letzten vier Stellen der/gi, 'last four digits of the'],
  [/die letzten (\w+) Stellen/gi, 'last $1 digits'],
  [/Index f(ü|ue)r Fehler(ort|art)/gi, 'fault location index'],
  [/im Klartext/gi, 'in plain text'],
  [/Alle m(ö|oe)glichen Diagnose-?Protokolle/gi, 'all available diagnostic protocols'],
  [/(Ä|Ae)nderungsindex max\.? 2-?stellig ASCII inkl\.? Ziffern/gi,
   'change index (max 2 chars, ASCII incl. digits)'],
  [/aus dem Steuerger(ä|ae)t ausgelesene Daten im Format/gi, 'data read from the ECU, formatted'],
  [/Fehlerdaten pro Fehler als Hexcode/gi, 'fault data per fault (hex)'],
  [/Infodaten pro Fehler als Hexcode/gi, 'info data per entry (hex)'],
  [/Index f(ü|ue)r Fehlerort/gi, 'fault location index'],
  [/Index f(ü|ue)r Infoort/gi, 'info location index'],
  [/Fehlerort als Text/gi, 'fault location'],
  [/Infoort als Text/gi, 'info location'],
  [/Fehlersymptom \(Standard-?Fehlerart\) als (Zahl|Text)/gi, 'fault symptom'],
  [/Readyness Flag \(Standard-?Fehlerart\) als (Zahl|Text)/gi, 'readiness flag'],
  [/Fehler vorhanden \(Standard-?Fehlerart\) als (Zahl|Text)/gi, 'fault present'],
  [/Typ des Fehlerspeichers/gi, 'fault memory type'],
  [/Anzahl der (Fehler|Infoarten|Umweltbedingungen)/gi, 'count'],
  [/CBS-?Kennung als (Zahl|Hex-?String|Text)/gi, 'CBS identifier'],
  [/Steuerger(ä|ae)teadresse als Hex-?String/gi, 'ECU address (hex)'],
  [/Steuerger(ä|ae)teadresse im Klartext/gi, 'ECU address'],
  [/Anzahl der CBS ?-? ?Umfaenge im Steuerger(ä|ae)t/gi, 'number of CBS items in the ECU'],
  [/ISN als\s+WERT/gi, 'ISN value'],
  [/ausgelesene Daten als ASCII Format/gi, 'data read (ASCII)'],
  [/ausgelesene Daten/gi, 'data read'],
  [/OKAY,? wenn fehlerfrei/gi, 'OKAY when no error'],

  // flash/programming argument terms (Flash Parameter Set, AIF dialogs)
  [/Steuerger(ä|ae)te?-?adresse/gi, 'ECU address'],
  [/Steuerger(ä|ae)te?/gi, 'ECU'],
  [/Anzahl der Anwender-?Infofelder/gi, 'number of user info fields'],
  [/Gr(ö|oe)(ß|ss)e des Anwender-?Infofeldes/gi, 'size of the user info field'],
  [/Offset f(ü|ue)r letztes Anwender-?Infofeld/gi, 'offset of the last user info field'],
  [/Anwender-?Infofelder/gi, 'user info fields'],
  [/Anwender-?Infofeld/gi, 'user info field'],
  [/Endekennung/gi, 'end marker'], [/Maxanzahl/gi, 'max count'],
  [/\bAnzahl\b/gi, 'count'], [/\bAdresse\b/gi, 'address'],
  [/Gr(ö|oe)(ß|ss)e/gi, 'size'], [/\bletztes?\b/gi, 'last'],
  // lowercase "Aif" mid-prose expands; the uppercase acronym is INPA's screen name
  [/\bf(ü|ue)r\b/gi, 'for'], [/\bSg\b/g, 'ECU'], [/\bAif\b/g, 'info field'],
  // identity-card labels from SGBD result descriptions. compound nouns first,
  // else "Lieferanten-Nummer" -> hybrid "Lieferanten-number".
  [/Herstelldatum\s*KW/gi, 'manufacture date (week)'],
  [/Herstelldatum\s*Jahr/gi, 'manufacture date (year)'],
  [/Herstelldatum\s*Monat/gi, 'manufacture date (month)'],
  [/Herstelldatum\s*Tag/gi, 'manufacture date (day)'],
  [/Herstelldatum/gi, 'manufacture date'],
  [/Lieferanten-?\s*Nummer/gi, 'supplier number'],
  [/Lieferanten-?\s*Text/gi, 'supplier'],
  [/Identifikation\s+EWS-?Schnittstelle/gi, 'EWS interface identification'],
  [/Schnittstelle/gi, 'interface'],
  [/Diagnose-?index/gi, 'diagnostic index'],
  [/Codier-?index/gi, 'coding index'],
  [/Bus-?index/gi, 'bus index'],
  // body-module component names (BITS tables). compound/multi-word first, else
  // "Schalter FH Fahrer auf" -> "switch FH driver auf".
  [/Schalter\s+FH\s+Fahrer\s+auf/gi, 'window switch, driver — up'],
  [/Schalter\s+FH\s+Fahrer\s+zu/gi, 'window switch, driver — down'],
  [/Schalter\s+FH\s+Beifahrer\s+auf/gi, 'window switch, passenger — up'],
  [/Schalter\s+FH\s+Beifahrer\s+zu/gi, 'window switch, passenger — down'],
  [/Motor-?\s*Hauben-?\s*Kontakt/gi, 'bonnet contact'],
  [/Wischerrelais/gi, 'wiper relay'],
  [/Wischerschalter/gi, 'wiper switch'],
  [/Waschpumpe/gi, 'washer pump'],
  [/Rueckstellkontakt|Rückstellkontakt/gi, 'park contact'],
  [/Innenbeleuchtung/gi, 'interior lighting'],
  [/Innenraumschutz/gi, 'interior motion sensor'],
  [/Heckklappe/gi, 'boot lid'], [/Heckscheibe/gi, 'rear window'],
  [/Tuerkontakt|Türkontakt/gi, 'door contact'],
  [/Kindersicherung/gi, 'child lock'],
  [/Verbraucherabschaltung/gi, 'load shedding'],
  [/Neigungsgeber/gi, 'tilt sensor'],
  [/Fernbedienung/gi, 'remote control'],
  [/Zentral-?Verriegelung/gi, 'central locking'],
  [/Entriegeln/gi, 'unlock'], [/Verriegeln/gi, 'lock'],
  [/\bTaster\b/gi, 'button'], [/\bSchalter\b/gi, 'switch'],
  [/\bKontakt\b/gi, 'contact'], [/\bRelais\b/gi, 'relay'],
  [/\bVersorgung\b/gi, 'supply'], [/\bStufe\b/gi, 'stage'],
  [/\bSender\b/gi, 'transmitter'], [/\bSchluessel\b|\bSchlüssel\b/gi, 'key'],
  [/\bReserve\b/gi, 'spare'], [/\bEingang\b/gi, 'input'],
  // direction words: standalone tokens only (case-sensitive), never inside a word
  [/\bauf\b/g, 'up'], [/\bzu\b/g, 'down'],
  [/\bAnsteuern\b/gi, 'Activate'],
  [/BMW-?Hardwarenummer/gi, 'BMW hardware number'],
  [/BMW-?Teilenummer/gi, 'BMW part number'],
  [/BMW-?Einkaufsnummer/gi, 'BMW purchasing number'],
  [/Urspr(ü|ue)nglich/gi, 'originally'],
  [/Pruefplannummer|Pr(ü|ue)fplannummer/gi, 'test plan number'],
  [/Programmstandsnummer/gi, 'program version number'],
  [/Kilometerstand|km-?Stand/gi, 'mileage'],
  [/Varianten-?Index/gi, 'variant index'],
  [/Variante des Grundmoduls/gi, 'base module variant'],
  [/Datensatz/gi, 'dataset'],
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
  // fleet-wide ARG names + comments, by frequency. compounds precede fragments.
  [/Zusatzfunktion/gi, 'additional function'], [/Funktionale?r?/gi, 'functional'],
  [/Funktionen/gi, 'functions'], [/Funktion/gi, 'function'],
  [/Abgleichmenge/gi, 'adjustment quantity'], [/Abgleichflag/gi, 'adjustment flag'],
  [/Vorgabewert/gi, 'default value'], [/Vorgabe[Bb]yte/gi, 'default byte'],
  [/Vorgabespeed/gi, 'default speed'], [/Vorgabe/gi, 'default'],
  [/Querbeschleunigung/gi, 'lateral acceleration'], [/Drehzahl/gi, 'RPM'],
  [/Sollspannung/gi, 'target voltage'], [/Sensespannung/gi, 'sense voltage'],
  [/Sensorversorgung/gi, 'sensor supply'], [/Programmierspannung/gi, 'programming voltage'],
  // compound *spannung before the generic Spannung->voltage, else "...voltage"
  [/Batteriespannung/gi, 'battery voltage'],
  [/Versorgungsspannung/gi, 'supply voltage'], [/Unterspannung/gi, 'undervoltage'],
  [/(Ü|Ue)berspannung/gi, 'overvoltage'],
  [/Geblaesesteuerspannung|Gebläsesteuerspannung/gi, 'blower control voltage'],
  [/Spannung/gi, 'voltage'],
  // compound *temperatur* before the generic temperatur->temperature
  [/Umgebungstemperatursensor/gi, 'ambient temperature sensor'],
  [/Verstellwinkel/gi, 'adjustment angle'], [/Zuendwinkel|Zündwinkel/gi, 'ignition angle'],
  [/Drosselklappenwinkel/gi, 'throttle angle'], [/Motorlagewinkel/gi, 'engine position angle'],
  [/\bWinkel\b/gi, 'angle'], [/WortAdresse/gi, 'word address'],
  [/Speicheradresse/gi, 'memory address'], [/Diagnoseadresse/gi, 'diagnostic address'],
  [/Deviceadresse/gi, 'device address'], [/Codierblock/gi, 'coding block'],
  [/Steuerwert/gi, 'control value'], [/Steuerart\s*(\d+)/gi, 'control type $1'],
  [/Steuerparameter/gi, 'control parameter'], [/Ventilstellung/gi, 'valve position'],
  [/Fahrzeugh(ö|oe)he/gi, 'vehicle height'], [/Restlaufleistung/gi, 'remaining mileage'],
  [/Tankentl(ü|ue)ftung/gi, 'tank ventilation'], [/Abschaltung/gi, 'shutoff'],
  [/Aktivierung/gi, 'activation'], [/Betaetigung|Betätigung/gi, 'actuation'],
  [/bet(ä|ae)tigt/gi, 'actuated'], [/Kalibrieranforderung/gi, 'calibration request'],
  [/(ü|ue)berwachenden?/gi, 'monitored'], [/Verd(ä|ae)chtigung/gi, 'suspicion'],
  [/Pruefdatum|Pr(ü|ue)fdatum/gi, 'test date'], [/Inspektion/gi, 'inspection'],
  [/Produktion/gi, 'production'], [/Berechnung/gi, 'calculation'],
  [/Taktverh(ä|ae)ltnis/gi, 'duty cycle'], [/Schaltmodus/gi, 'switch mode'],
  [/Schalter/gi, 'switch'], [/\bAktion\b/gi, 'action'], [/Reaktion/gi, 'reaction'],
  [/Zaehler|Zähler/gi, 'counter'], [/Einheit/gi, 'unit'], [/Stellung/gi, 'position'],
  [/Helligkeit/gi, 'brightness'], [/Lautst(ä|ae)rke/gi, 'volume'],
  [/Leitung/gi, 'circuit'], [/Versorgung/gi, 'supply'], [/K(ü|ue)hler/gi, 'cooler'],
  [/Messung/gi, 'measurement'], [/Ergebnis/gi, 'result'], [/Beschreibung/gi, 'description'],
  [/einschl(ä|ae)ft/gi, 'sleeps'], [/m(ö|oe)gliche/gi, 'possible'],
  [/optional/gi, 'optional'], [/Zahl\b/gi, 'number'],
  // -index compound before the bare Aenderung rule, else "changesindex"
  [/(Ä|Ae|ä|ae)nderungsindex/gi, 'change index'],
  [/(\d+)-?stellig/gi, '$1-digit'], [/\bstellig/gi, 'digit'],
  [/\bZiffern?\b/gi, 'digits'], [/\binkl\.?/gi, 'incl.'], [/\bexkl\.?/gi, 'excl.'],
  [/\bAei\b/gi, 'AEI'], [/\bAe\b/gi, 'AE'],  // INPA arg-code fragments, keep as-is
  // BMW field-code abbreviations (Fg=Fahrgestell, Zb=Zusammenbau, Sw=Software, Ds=Datensatz)
  [/\bDatum\b/gi, 'date'], [/\bFg\s*Nr\b/gi, 'chassis no.'], [/\bZb\s*Nr\b/gi, 'assembly no.'],
  [/\bSw\s*Nr\b/gi, 'software no.'], [/\bDs\s*Nr\b/gi, 'dataset no.'], [/\bHw\s*Nr\b/gi, 'hardware no.'],
  [/\bNr\b/gi, 'no.'],
  [/Signaturtestzeit/gi, 'signature test time'], [/\bSignatur\b/gi, 'signature'],
  [/\bBereich\b/gi, 'area'], [/\bProgramm\b/gi, 'Program'],
  [/vorgefuellter|vorgefüllter/gi, 'pre-filled'], [/Binaer\s?buffer|Binärbuffer/gi, 'binary buffer'],
  [/\bBinaer\b|\bBinär\b/gi, 'binary'], [/\bAls\b/gi, 'as'],
  // xenon leveling (SPU): ARG names abbreviate hor/ver + Wink(el)/Plaus(ibilitaet)
  [/Dejustagewinkels?/gi, 'misalignment angle'],
  [/Dejuhor\b/gi, 'horizontal misalignment'], [/Dejuver\b/gi, 'vertical misalignment'],
  [/Plausibilit(ä|ae)t/gi, 'plausibility'], [/\bPlaus\b/gi, 'plausibility'],
  [/\bWink\b/gi, 'angle'], [/normierter?/gi, 'normalized'],
  [/horizontaler?/gi, 'horizontal'], [/vertikaler?/gi, 'vertical'],
  [/Pruefstempel|Pr(ü|ue)fstempel|Pruefstemp\b/gi, 'inspection stamp'],
  [/Pruefcode|Pr(ü|ue)fcode/gi, 'test code'], [/Pruefflag|Pr(ü|ue)fflag/gi, 'test flag'],
  [/Auswahlbyte/gi, 'selection byte'],
  // numbered value/byte suffixes before the bare forms
  [/\bWert\s*(\d+)/gi, 'value $1'], [/\bByte\s*(\d+)/gi, 'byte $1'],
  [/\bWert\b/gi, 'value'], [/\bByte\b/gi, 'byte'],
  [/Injektor-?Mengenabgleich/gi, 'injector quantity adjustment (IMA)'],
  [/\bIma\b/gi, 'IMA'],
  [/Verstellwert/gi, 'adjustment value'], [/Verstellung/gi, 'adjustment'], [/Verstellen/gi, 'adjust'],
  [/\bAbgleich\b/gi, 'adjustment'], [/Programmieren/gi, 'programming'],
  [/\bZyl(?:inder)?\s*(\d+)/gi, 'cylinder $1'], [/\bZyl(?:inder)?\b/gi, 'cylinder'],
  [/Kennfeld/gi, 'map'], [/Ansteuerung/gi, 'control'],
  // fleet-wide job-argument vocabulary. compounds precede fragments.
  [/Codierdaten/gi, 'coding data'], [/Codierwert/gi, 'coding value'],
  [/Programmdaten/gi, 'program data'], [/Herstellerdaten/gi, 'manufacturer data'],
  [/Abgleichdaten/gi, 'adjustment data'], [/Ident[_ ]?Daten/gi, 'ident data'],
  [/Startadresse/gi, 'start address'], [/Startwert/gi, 'start value'],
  [/Offsetwert/gi, 'offset value'], [/Grenzwert/gi, 'limit value'],
  [/Adaptionswert/gi, 'adaptation value'], [/Analogwert/gi, 'analog value'],
  [/Digitalwert/gi, 'digital value'], [/Dezimalwert/gi, 'decimal value'],
  [/Hexwert/gi, 'hex value'], [/Dimmwert/gi, 'dim value'], [/Dummy[Ww]ert/gi, 'dummy value'],
  [/Abgleichspannung/gi, 'adjustment voltage'],
  [/Lambdasondenheizung/gi, 'lambda sensor heater'],
  [/Drehzahlanhebung/gi, 'idle speed increase'], [/Solldrehzahl/gi, 'target RPM'],
  // Soll- compound before the bare noun
  [/Soll-?F(ö|oe)rdermenge/gi, 'target delivery quantity'],
  [/F(ö|oe)rdermenge/gi, 'delivery quantity'], [/F(ö|oe)rderbeginn/gi, 'delivery start'],
  [/Enddrehzahl/gi, 'end RPM'], [/Drehrichtung/gi, 'rotation direction'],
  [/Bewegungsrichtung/gi, 'movement direction'],
  [/Prozentschritten/gi, 'percent steps'], [/Schrittanzahl/gi, 'number of steps'],
  [/Schrittmotoren/gi, 'stepper motors'], [/Kompressorkupplung/gi, 'compressor clutch'],
  [/Eigenraderkennung/gi, 'own-wheel detection'], [/Bitkombinationen/gi, 'bit combinations'],
  [/Innenbeleuchtung/gi, 'interior lighting'], [/Spiegelheizung/gi, 'mirror heater'],
  [/Luftverteilung/gi, 'air distribution'], [/Luftfuehrung/gi, 'air guidance'],
  [/Motorlagersteuerung/gi, 'engine mount control'], [/Sendeleistung/gi, 'transmit power'],
  [/Behoerden(daten)?/gi, 'authority data'], [/Vindaten/gi, 'VIN data'],
  [/Klangzeichen/gi, 'chime'], [/Heimleuchten/gi, 'welcome light'],
  // verbs (infinitive + inflected)
  [/einschalten/gi, 'switch on'], [/ausschalten/gi, 'switch off'],
  [/aktivieren/gi, 'activate'], [/deaktivieren/gi, 'deactivate'],
  [/eingeben/gi, 'enter'], [/vorgeben/gi, 'specify'], [/vorzugebenden?/gi, 'to be specified'],
  [/uebergeben|übergeben/gi, 'pass'],
  [/uebernehmen|übernehmen/gi, 'apply'], [/auszulesenden?/gi, 'to be read'],
  [/lesenden?/gi, 'read'], [/gelesen/gi, 'read'], [/ausgelesen/gi, 'read out'],
  [/geschrieben/gi, 'written'], [/codiert/gi, 'coded'], [/angesteuert/gi, 'activated'],
  [/gewünschte|gewuenschte/gi, 'desired'], [/ausgewählten|ausgewaehlten/gi, 'selected'],
  [/unveraendert|unverändert/gi, 'unchanged'], [/dokumentierung/gi, 'documentation'],
  [/behält|behaelt/gi, 'keeps'], [/löscht|loescht/gi, 'clears'],
  [/steuert/gi, 'controls'], [/schalten/gi, 'switch'], [/starten/gi, 'start'],
  [/sperren/gi, 'lock'], [/vorgeben/gi, 'set'],
  // remaining single nouns / adjectives
  [/\bDaten\b/gi, 'data'], [/Bezeichnung/gi, 'designation'],
  [/Quantisierung/gi, 'quantization'], [/Umrechnung/gi, 'conversion'],
  [/Belegung/gi, 'assignment'], [/Belueftung|Belüftung/gi, 'ventilation'],
  [/Entfrostung/gi, 'defrost'], [/Beleuchtung/gi, 'lighting'], [/Heizung/gi, 'heater'],
  [/Kalibrierung/gi, 'calibration'], [/Codierung/gi, 'coding'],
  [/Steuerung/gi, 'control'], [/Regelung/gi, 'regulation'],
  [/Deaktivierung/gi, 'deactivation'], [/Initialisierung/gi, 'initialization'],
  [/Verfuegbarkeit|Verfügbarkeit/gi, 'availability'], [/Wiederholung/gi, 'repetition'],
  [/Einstellung/gi, 'setting'], [/Gewichtung/gi, 'weighting'], [/Verbindung/gi, 'connection'],
  [/Einspritzung/gi, 'injection'], [/Beladung/gi, 'load'], [/Dichtung/gi, 'seal'],
  [/Kennlinien?/gi, 'characteristic curve'], [/Serien\b/gi, 'series'],
  [/Grenz\b/gi, 'limit'], [/Steigung/gi, 'slope'], [/Spreizung/gi, 'spread'],
  [/Abweichung/gi, 'deviation'], [/Aenderung|Änderung/gi, 'change'],
  // DWS/RDC wheel-speed vocabulary, AHEAD of the generic /Geschwindigkeit/ and
  // /Signal/ rules, else they shred these compounds ("Radgeschwindigkeit" -> "Radspeed").
  [/Standardisierungsfortschritt/gi, 'standardisation progress'],
  [/\bStandardisierung\b/gi, 'standardisation'],
  [/\bRohsignal\s+vom\b/gi, 'raw signal from'],
  [/\bRohsignale\b/gi, 'raw signals'], [/\bRohsignal\b/gi, 'raw signal'],
  [/geschwindigkeitsabh(ä|ae)ngige?r?/gi, 'speed-dependent'],
  [/Speeds?abh\./gi, 'speed-dep.'],
  [/\bRadgeschwindigkeit(en)?\b/gi, 'wheel speed'],
  // unit form only: bare "Impulse" already reads right in English, don't mangle it
  [/\bImpulse\s*\/\s*sec\b/g, 'pulses/sec'],
  [/Pannenmeldung/gi, 'deflation warning'],
  [/Bandmode/gi, 'plant mode'],
  [/Geschwindigkeit/gi, 'speed'], [/Beladung/gi, 'load'], [/Mengen/gi, 'quantity'],
  [/Tasten/gi, 'buttons'], [/Lampen/gi, 'lamps'], [/Antennen/gi, 'antennas'],
  [/Sekunden/gi, 'seconds'], [/Schichtung/gi, 'stratification'],
  [/Richtung/gi, 'direction'], [/Kennung/gi, 'ID'], [/Länge|Laenge/gi, 'length'],
  [/Gruen\b/gi, 'green'], [/Abblenden/gi, 'dim'], [/\bUnten\b/gi, 'down'],
  [/\bAussen\b/gi, 'outside'], [/muessen|müssen/gi, 'must'], [/sollen/gi, 'should'],
  [/\bwerden\b/gi, 'are'], [/\balten\b/gi, 'old'], [/\bfolgenden\b/gi, 'following'],
  [/\bzwischen\b/gi, 'between'], [/\büber\b|\buebe?r\b/gi, 'via'], [/ACHTUNG/gi, 'ATTENTION'],
  [/\bVvten\b/gi, 'VANOS'], [/freibrennen|freebrennen/gi, 'burn-off'],
  // multi-word glue only. bare articles/prepositions are deliberately NOT
  // rewritten — they'd mangle result keys for marginal readability.
  [/\bder zu\b/gi, 'to be'], [/\bder zum\b/gi, 'for'],
  [/Sollwert/gi, 'target value'],
  [/ohne Argument/gi, 'without argument'], [/Wechsel/gi, 'toggle'],
  [/Klima und Fahrbedingung/gi, 'A/C and driving condition'],
  [/mit Klimaanlage/gi, 'with A/C'], [/mit Fahrstufe/gi, 'with gear engaged'],
  [/niedriger UBatt/gi, 'low battery voltage'],
  [/Ein=1 Aus=0|1=Ein 0=Aus|1=Ein, 0=Aus/gi, '1=on 0=off'],
  // ECU state words (arrive as VALUES too): negated forms must win over plain ones
  [/\bnicht aktiv\b/gi, 'not active'], [/\bnicht bereit\b/gi, 'not ready'],
  [/\bnicht vorhanden\b/gi, 'not present'], [/\bnicht erkannt\b/gi, 'not detected'],
  [/\baktiv\b/gi, 'active'], [/\bbereit\b/gi, 'ready'], [/\bgesperrt\b/gi, 'locked'],
  [/\bja\b/gi, 'yes'], [/\bnein\b/gi, 'no'], [/\bfehlerfrei\b/gi, 'no fault'],
  [/\bEin\b/gi, 'on'], [/\bAus\b/gi, 'off'], [/\bZeit\b/gi, 'time'],
  [/\bDauer\b/gi, 'duration'], [/\bFaktor\b/gi, 'factor'], [/\bbis\b/gi, 'to'],
  // multi-word phrases, before their component words
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
  // component nouns
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
  [/Gebläse/gi, 'blower'],
  // airbag / SRS (MRS module)
  [/Z(ü|ue)ndkreis/gi, 'squib circuit'], [/Gurtstrammer|Gurtstraffer/gi, 'belt tensioner'],
  [/Seitenairbag/gi, 'side airbag'], [/Kopfairbag/gi, 'head airbag'],
  [/Beifahrerairbag/gi, 'passenger airbag'], [/Fahrerairbag/gi, 'driver airbag'],
  [/\bStufe\b/gi, 'stage'], [/Crashsensor/gi, 'crash sensor'],
  [/Sitzbelegungserkennung/gi, 'seat occupancy detection'],
  [/Fehlerlampe/gi, 'warning lamp'], [/\bAirbag\b/gi, 'airbag'],
  // supply / communication
  [/Kommunikation/gi, 'communication'], [/Masse-?Schluss/gi, 'short to ground'],
  [/Widerstand zu gro(ß|ss)/gi, 'resistance too high'],
  [/Widerstand zu klein/gi, 'resistance too low'],
  [/Fensterheber/gi, 'window lift'], [/Zentralverriegelung/gi, 'central locking'],
  [/Beifahrerspiegel/gi, 'passenger mirror'], [/Fahrerspiegel/gi, 'driver mirror'],
  [/Beifahrerseite/gi, 'passenger side'], [/Fahrerseite/gi, 'driver side'],
  [/\bBeifahrer\b/gi, 'passenger'], [/\bFahrer\b/gi, 'driver'],
  [/Potentiometer/gi, 'potentiometer'], [/Achse/gi, 'axis'],
  [/Sicherung/gi, 'fuse'], [/Relais/gi, 'relay'], [/Motor/gi, 'motor'],
  [/Schlüssel|Schluessel/gi, 'key'], [/Toleranz/gi, 'tolerance'], [/erhöht|erhoeht/gi, 'increased'],
  [/Impulsrad/gi, 'reluctor ring'], [/Überwachung|Ueberwachung/gi, 'monitoring'],
  [/\bNummer\b/gi, 'number'], [/\bbei\b/gi, 'at'], [/\boder\b/gi, 'or'],
  [/Luftsystem/gi, 'air system'], [/Luftmasse/gi, 'air mass'],
  [/Kraftstoffsystem/gi, 'fuel system'], [/Zündsystem/gi, 'ignition system'],
  [/Generator/gi, 'alternator'], [/Lichtmaschine/gi, 'alternator'],
  [/Botschaft/gi, 'message'], [/Antwort/gi, 'response'],
  // generic tokens
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
// Exact full-sentence overrides for job-argument comments, matched before the
// token pass (a word table can't reorder German syntax). Keyed on trimmed text.
const ARG_PHRASES = {
  'Als Argument wird ein vorgefuellter Binaerbuffer uebergeben':
    'Pass a pre-built binary buffer as the argument',
  '"ja"   -> Funktionale Adresse 0xEF wird benutzt':
    '"yes" -> use functional address 0xEF',
  '0x????: Angabe eines einzelnen Fehlers': '0x????: a single fault',
  'Zu übertragende Blocknummer (Zähler) bei langen Datenstreams':
    'block number (counter) to transfer for long data streams',
  "Wenn 'JA' wird der Messwertblock im SG gelöscht":
    "'YES' clears the measurement block in the ECU",
  'Abgleichdaten in folgendem Format': 'adjustment data in the following format',
  'Auswahl eines Stellers (Pflicht)': 'select an actuator (required)',
  'Auswahl eines Tests (Pflicht)': 'select a test (required)',
  'Auswahl eines Tests': 'select a test',
  'Nummer der auszulesenden Stützstellenkombination':
    'number of the reference-point combination to read',
  'Länge der folgenden Information wie die Antwort erhalten wird.':
    'length of the following info on how the response is received.',
  'ASCII-codiert Information wie die Antwort erhalten wird:':
    'ASCII-coded info on how the response is received:',
  'wird die Nummer des zu lesenden Fehlers im Fehlerspeicher uebergeben':
    'pass the number of the fault to read from the fault memory',
  'wird die Nummer des zu lesenden Fehlers uebergeben':
    'pass the number of the fault to read',
  'kleines x muss Charakter sein 0-9 oder A-Z':
    'lowercase x must be a character 0-9 or A-Z',
  'Dieser Job ist mit Passwort geschützt': 'This job is password protected',
  'Wird nur bei Motoren mit 2 Bänken benötigt (M67TÜ)':
    'only needed on engines with 2 banks (M67TU)',
  'gibt einen absoluten Verstellwinkel an (0..180 Grd)':
    'specifies an absolute adjustment angle (0..180 deg)',
  'Dient nur zur Sicherheit, wird nicht': 'for safety only, is not',
  'Länge des Individualisierungs Datenstream oder -streamstücks':
    'length of the individualization data stream or stream piece',
  'Individualdaten können via CAN oder MOST oder XY erreicht werden':
    'individual data can be reached via CAN or MOST or XY',
  'Individualdaten können via CAN oder MOST oder XY geschrieben werden':
    'individual data can be written via CAN or MOST or XY',
  'Übergabe im Format Messagenummern zB.: 00C0000D für N und V':
    'pass as message numbers, e.g. 00C0000D for N and V',
  'Einzelkerze rücksetzen: GLU1 ... GLU6 (... GLU8)':
    'reset single glow plug: GLU1 ... GLU6 (... GLU8)',
  'Wert der vorzugebenden Soll-Foerdermenge':
    'value of the target delivery quantity to set',
};

const _deCache = new Map();
function deGerman(text) {
  if (!text) return text;
  if (lang() === 'orig') return text; // keep German in EDIABAS mode
  if (_deCache.has(text)) return _deCache.get(text);
  let out = null;
  const trimmed = text.trim();
  if (INPA_CAPTIONS.has(trimmed)) out = INPA_CAPTIONS.get(trimmed);
  if (out === null && ARG_PHRASES[trimmed]) out = ARG_PHRASES[trimmed];
  // per-ECU fault-location text (SGBD FORTTEXTE tables, faultdb.js), variant-agnostic
  if (out === null && typeof window !== 'undefined' && window.BMW_FAULT_PHRASES)
    out = window.BMW_FAULT_PHRASES[trimmed] || null;
  if (out === null) for (const [de, en] of FAULT_PHRASES) if (trimmed === de) { out = en; break; }
  if (out === null) {
    // token-level fallback for partial/unlisted phrases (P-code text, etc.)
    out = text;
    for (const [re, en] of DE_TOKENS) out = out.replace(re, en);
    // token rules are lowercase (German capitalises nouns), so restore the
    // source's leading case where it had one, else "actuator activation" under
    // "Read error memory".
    if (/^[A-ZÄÖÜ]/.test(text) && /^[a-z]/.test(out))
      out = out.charAt(0).toUpperCase() + out.slice(1);
  }
  // don't cache a token-fallback taken before the phrase map loads, or it
  // shadows the better BMW_FAULT_PHRASES translation once it arrives.
  if (typeof window === 'undefined' || window.BMW_FAULT_PHRASES) {
    if (_deCache.size > 5000) _deCache.clear();
    _deCache.set(text, out);
  }
  return out;
}

// environment-measurement labels (F_UW*_TEXT). skipped in Original mode.
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
// token fallback for compound env labels not in the exact map
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

// BMW hex fault number (e.g. 27DA) -> OBD-II P-code. only real mappings; no
// fabricated codes.
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

// F_ORT_NR (BMW "Fehlerort") -> the LOCATION BYTE the SGBD FORTTEXTE table keys
// on (IHKA 0x1F, LWS 0x0B). For a 16-bit value (LWS 0x0B3F) the location is the
// HIGH byte; the low byte is symptom detail. EDIABAS gives it decimal ("2879");
// hex ("0x0B3F"/"1F") is accepted too. Returns two hex digits.
function ortNrCode(nr) {
  if (nr == null) return null;
  const s = String(nr).trim();
  if (!s) return null;
  let val = null;
  let m = s.match(/^0x([0-9A-Fa-f]+)$/) || s.match(/^([0-9A-Fa-f]*[A-Fa-f][0-9A-Fa-f]*)$/);
  if (m) val = parseInt(m[1], 16);
  else if (/^\d+$/.test(s)) val = parseInt(s, 10);
  if (val == null || Number.isNaN(val)) return s; // unknown format: show as-is
  const loc = val > 0xFF ? (val >> 8) & 0xFF : val;  // high byte if 16-bit
  return loc.toString(16).toUpperCase().padStart(2, '0');
}
function pCode(loc, hex) {
  const code = bmwCode(loc, hex);
  return code && PCODE_MAP[code] ? PCODE_MAP[code] : null;
}

// full 16-bit F_ORT_NR as 4-hex ("24002" -> "5DC2"), or null for single bytes.
// Lets the caller tell a real 2-byte DTC (DSC 5DC2, in the DB) from a text-scheme
// location+detail word (LWS 0B3F, not in the DB -> show the location byte).
function ortNrFull(nr) {
  if (nr == null) return null;
  const s = String(nr).trim();
  if (!s) return null;
  let val = null;
  let m = s.match(/^0x([0-9A-Fa-f]+)$/) || s.match(/^([0-9A-Fa-f]*[A-Fa-f][0-9A-Fa-f]*)$/);
  if (m) val = parseInt(m[1], 16);
  else if (/^\d+$/.test(s)) val = parseInt(s, 10);
  if (val == null || Number.isNaN(val) || val <= 0xFF) return null;
  return val.toString(16).toUpperCase().padStart(4, '0');
}

// P-code lookup backed by window.BMW_PCODES (BMW hex -> [SAE P-codes], primary
// first); PCODE_MAP is the fallback. Lazy-injected; fault screens warm it.
let _pcodesPromise = null;
function loadPcodes() {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.BMW_PCODES) return Promise.resolve();
  if (_pcodesPromise) return _pcodesPromise;
  _pcodesPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'data/pcodes.js';
    s.onload = () => resolve();
    s.onerror = () => { _pcodesPromise = null; resolve(); };
    document.head.appendChild(s);
  });
  return _pcodesPromise;
}

// rich ISTA fault metadata + service-info documents (decrypted DiagDocDb).
// Lazy-loaded: meta (14MB) warms with the fault screens; info (60MB) only on a
// fault detail panel.
//
// The large BMW-derived fault data (faultinfo/faultmeta/faultdb/faultindex) is
// NOT shipped in the repo -- it is BMW's copyrighted ISTA/EDIABAS text. It is
// hosted on the same Hugging Face dataset as the ETK data and loaded from there
// at runtime, with a local `data/` copy taking precedence when a build ships
// one (offline/desktop). Loading is a plain <script src> that sets a window
// global; cross-origin classic scripts load fine from HF.
const FAULT_HF_BASE =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/faults/';

function _lazyScript(src, ready, holder) {
  return function () {
    if (typeof window === 'undefined') return Promise.resolve();
    if (window[ready]) return Promise.resolve();
    if (holder.p) return holder.p;
    // basename for the HF fallback (src is like 'data/faultinfo.js')
    const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
    const file = src.split('/').pop();
    const urls = [`${base}/${src}`, `${FAULT_HF_BASE}${file}`];
    holder.p = new Promise((resolve) => {
      let i = 0;
      const tryNext = () => {
        if (i >= urls.length) { holder.p = null; resolve(); return; }
        const s = document.createElement('script');
        s.src = urls[i++];
        s.onload = () => resolve();
        s.onerror = () => { s.remove(); tryNext(); };  // local missing -> HF
        document.head.appendChild(s);
      };
      tryNext();
    });
    return holder.p;
  };
}
const _metaHolder = {}, _infoHolder = {}, _codingHolder = {}, _datenHolder = {};
const loadFaultMeta = _lazyScript('data/faultmeta.js', 'BMW_FAULT_META', _metaHolder);
const loadFaultInfo = _lazyScript('data/faultinfo.js', 'BMW_FAULT_INFO', _infoHolder);
// what an ECU's coding values MEAN, for the SGBDs that name their own
const loadCodingMap = _lazyScript('data/codingmap.js', 'BMW_CODING_MAP', _codingHolder);
// ...and from BMW's DATEN, for ECUs whose SGBD says nothing
const loadDatenMap = _lazyScript('data/datenmap.js', 'BMW_DATEN_MAP', _datenHolder);

// per-ECU-variant records for a hex code: [{sgbd, name, info?}], or []. `info`
// indexes into BMW_FAULT_INFO[hex].
function variantsForHex(code) {
  if (!code) return [];
  const c = String(code).replace(/^0x/i, '').toUpperCase();
  const m = (typeof window !== 'undefined' && window.BMW_FAULT_META) || null;
  return (m && m[c] && m[c].variants) || [];
}

// the service-info document for a hex code + variant info-index, or null.
function faultInfoFor(code, infoIdx) {
  if (code == null || infoIdx == null) return null;
  const c = String(code).replace(/^0x/i, '').toUpperCase();
  const db = (typeof window !== 'undefined' && window.BMW_FAULT_INFO) || null;
  const bucket = db && db[c];
  return (bucket && bucket[String(infoIdx)]) || null;
}

// all SAE P-codes for a BMW hex code ("27C3" -> ["P0456"], primary first), or [].
// Prefers ISTA meta, then the pcodes map, then the fallback.
function pcodesForHex(code) {
  if (!code) return [];
  const c = String(code).replace(/^0x/i, '').toUpperCase();
  const m = (typeof window !== 'undefined' && window.BMW_FAULT_META) || null;
  if (m && m[c] && m[c].pcodes) return m[c].pcodes;
  const db = (typeof window !== 'undefined' && window.BMW_PCODES) || null;
  if (db && db[c]) return db[c];
  if (PCODE_MAP[c]) return [PCODE_MAP[c]];
  return [];
}

// UNAMBIGUOUS offline P-code for a hex code, or null. Many BMW codes map to
// SEVERAL SAE P-codes gated by ECU variant; guessing the first misleads, so
// offline we return one ONLY when the code has exactly one. A live read's own
// F_PCODE_STRING is exact and always preferred.
function pcodeForHexSgbd(code, sgbd) {
  if (!code) return null;
  const list = pcodesForHex(code);
  return list.length === 1 ? list[0] : null;
}

// primary P-code for a bare BMW hex code ("27C3" -> "P0456"), or null.
function pcodeForHex(code) {
  const list = pcodesForHex(code);
  return list.length ? list[0] : null;
}

// reverse lookup for search: "P0456" -> "27C3", null if unknown. Built once from
// the richest source available (BMW_FAULT_META, then BMW_PCODES, then fallback).
let _PCODE_REV = null, _PCODE_REV_SRC = null;
function hexForPcode(p) {
  const meta = (typeof window !== 'undefined' && window.BMW_FAULT_META) || null;
  const db = (typeof window !== 'undefined' && window.BMW_PCODES) || null;
  const src = meta || db || PCODE_MAP;
  if (_PCODE_REV_SRC !== src) {
    _PCODE_REV = {}; _PCODE_REV_SRC = src;
    for (const [h, v] of Object.entries(src)) {
      const list = meta ? (v.pcodes || []) : (Array.isArray(v) ? v : [v]);
      for (const pc of list) { const k = String(pc).toUpperCase(); if (!(k in _PCODE_REV)) _PCODE_REV[k] = h; }
    }
  }
  return _PCODE_REV[String(p).toUpperCase()] || null;
}
