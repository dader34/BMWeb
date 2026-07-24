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
  // ---- flash/programming argument terms (Flash Parameter Set, AIF dialogs) ----
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
  [/\bf(ü|ue)r\b/gi, 'for'], [/\bSg\b/g, 'ECU'], [/\bAif\b/gi, 'info field'],
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
  // ---- diesel injector-adjustment (IMA) + calibration/programming terms ----
  // ---- second mining pass: ARG names + comments across the whole fleet,
  // ranked by frequency. compounds precede fragments. ----
  [/Zusatzfunktion/gi, 'additional function'], [/Funktionale?r?/gi, 'functional'],
  [/Funktionen/gi, 'functions'], [/Funktion/gi, 'function'],
  [/Abgleichmenge/gi, 'adjustment quantity'], [/Abgleichflag/gi, 'adjustment flag'],
  [/Vorgabewert/gi, 'default value'], [/Vorgabe[Bb]yte/gi, 'default byte'],
  [/Vorgabespeed/gi, 'default speed'], [/Vorgabe/gi, 'default'],
  [/Querbeschleunigung/gi, 'lateral acceleration'], [/Drehzahl/gi, 'RPM'],
  [/Sollspannung/gi, 'target voltage'], [/Sensespannung/gi, 'sense voltage'],
  [/Sensorversorgung/gi, 'sensor supply'], [/Programmierspannung/gi, 'programming voltage'],
  // compound *spannung terms must precede the generic Spannung->voltage below,
  // else that fragment fires first and strips the prefix (Versorgungsvoltage).
  [/Batteriespannung/gi, 'battery voltage'],
  [/Versorgungsspannung/gi, 'supply voltage'], [/Unterspannung/gi, 'undervoltage'],
  [/(Ü|Ue)berspannung/gi, 'overvoltage'],
  [/Geblaesesteuerspannung|Gebläsesteuerspannung/gi, 'blower control voltage'],
  [/Spannung/gi, 'voltage'],
  // compound *temperatur* terms before the generic temperatur->temperature (line ~399)
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
  // compound with -index must precede the bare Aenderung rule (else it leaves
  // "changesindex")
  [/(Ä|Ae|ä|ae)nderungsindex/gi, 'change index'],
  [/(\d+)-?stellig/gi, '$1-digit'], [/\bstellig/gi, 'digit'],
  [/\bZiffern?\b/gi, 'digits'], [/\binkl\.?/gi, 'incl.'], [/\bexkl\.?/gi, 'excl.'],
  [/\bAei\b/gi, 'AEI'], [/\bAe\b/gi, 'AE'],  // INPA arg-code fragments, keep as-is
  // BMW field-code abbreviations in ID/write args (Fg=Fahrgestell, Zb=Zusammenbau,
  // Sw=Software, Ds=Datensatz) + Datum
  [/\bDatum\b/gi, 'date'], [/\bFg\s*Nr\b/gi, 'chassis no.'], [/\bZb\s*Nr\b/gi, 'assembly no.'],
  [/\bSw\s*Nr\b/gi, 'software no.'], [/\bDs\s*Nr\b/gi, 'dataset no.'], [/\bHw\s*Nr\b/gi, 'hardware no.'],
  [/\bNr\b/gi, 'no.'],
  [/Signaturtestzeit/gi, 'signature test time'], [/\bSignatur\b/gi, 'signature'],
  [/\bBereich\b/gi, 'area'], [/\bProgramm\b/gi, 'Program'],
  [/vorgefuellter|vorgefüllter/gi, 'pre-filled'], [/Binaer\s?buffer|Binärbuffer/gi, 'binary buffer'],
  [/\bBinaer\b|\bBinär\b/gi, 'binary'], [/\bAls\b/gi, 'as'],
  // headlight beam-aim / xenon leveling (SPU): Dejustagewinkel = misalignment
  // angle; the ARG names abbreviate hor/ver + Wink(el)/Plaus(ibilitaet)
  [/Dejustagewinkels?/gi, 'misalignment angle'],
  [/Dejuhor\b/gi, 'horizontal misalignment'], [/Dejuver\b/gi, 'vertical misalignment'],
  [/Plausibilit(ä|ae)t/gi, 'plausibility'], [/\bPlaus\b/gi, 'plausibility'],
  [/\bWink\b/gi, 'angle'], [/normierter?/gi, 'normalized'],
  [/horizontaler?/gi, 'horizontal'], [/vertikaler?/gi, 'vertical'],
  [/Pruefstempel|Pr(ü|ue)fstempel|Pruefstemp\b/gi, 'inspection stamp'],
  [/Pruefcode|Pr(ü|ue)fcode/gi, 'test code'], [/Pruefflag|Pr(ü|ue)fflag/gi, 'test flag'],
  [/Auswahlbyte/gi, 'selection byte'],
  // numbered value/byte suffixes: "Wert1" -> "value 1", "Byte 3" -> "byte 3"
  [/\bWert\s*(\d+)/gi, 'value $1'], [/\bByte\s*(\d+)/gi, 'byte $1'],
  [/\bWert\b/gi, 'value'], [/\bByte\b/gi, 'byte'],
  [/Injektor-?Mengenabgleich/gi, 'injector quantity adjustment (IMA)'],
  [/\bIma\b/gi, 'IMA'],  // Injektor-Mengenabgleich (injector quantity code)
  [/Verstellwert/gi, 'adjustment value'], [/Verstellung/gi, 'adjustment'], [/Verstellen/gi, 'adjust'],
  [/\bAbgleich\b/gi, 'adjustment'], [/Programmieren/gi, 'programming'],
  [/\bZyl(?:inder)?\s*(\d+)/gi, 'cylinder $1'], [/\bZyl(?:inder)?\b/gi, 'cylinder'],
  [/Kennfeld/gi, 'map'], [/Ansteuerung/gi, 'control'],
  // ---- comprehensive job-argument vocabulary (mined from every SGBD's
  // _ARGUMENTS across the fleet; compounds precede their fragments) ----
  // compound nouns first
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
  // fuel pump (EKP) delivery rate; Soll- compound before the bare noun
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
  // verbs (infinitive + inflected forms seen in comments)
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
  [/Geschwindigkeit/gi, 'speed'], [/Beladung/gi, 'load'], [/Mengen/gi, 'quantity'],
  [/Tasten/gi, 'buttons'], [/Lampen/gi, 'lamps'], [/Antennen/gi, 'antennas'],
  [/Sekunden/gi, 'seconds'], [/Schichtung/gi, 'stratification'],
  [/Richtung/gi, 'direction'], [/Kennung/gi, 'ID'], [/Länge|Laenge/gi, 'length'],
  [/Gruen\b/gi, 'green'], [/Abblenden/gi, 'dim'], [/\bUnten\b/gi, 'down'],
  [/\bAussen\b/gi, 'outside'], [/muessen|müssen/gi, 'must'], [/sollen/gi, 'should'],
  [/\bwerden\b/gi, 'are'], [/\balten\b/gi, 'old'], [/\bfolgenden\b/gi, 'following'],
  [/\bzwischen\b/gi, 'between'], [/\büber\b|\buebe?r\b/gi, 'via'], [/ACHTUNG/gi, 'ATTENTION'],
  [/\bVvten\b/gi, 'VANOS'], [/freibrennen|freebrennen/gi, 'burn-off'],
  // multi-word glue only (safe: these can't split a single compound or a
  // result key). bare articles/prepositions are deliberately NOT rewritten —
  // they'd mangle result keys and English output for marginal readability.
  [/\bder zu\b/gi, 'to be'], [/\bder zum\b/gi, 'for'],
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
  [/Gebläse/gi, 'blower'],
  // ---- airbag / SRS (MRS module) ----
  [/Z(ü|ue)ndkreis/gi, 'squib circuit'], [/Gurtstrammer|Gurtstraffer/gi, 'belt tensioner'],
  [/Seitenairbag/gi, 'side airbag'], [/Kopfairbag/gi, 'head airbag'],
  [/Beifahrerairbag/gi, 'passenger airbag'], [/Fahrerairbag/gi, 'driver airbag'],
  [/\bStufe\b/gi, 'stage'], [/Crashsensor/gi, 'crash sensor'],
  [/Sitzbelegungserkennung/gi, 'seat occupancy detection'],
  [/Fehlerlampe/gi, 'warning lamp'], [/\bAirbag\b/gi, 'airbag'],
  // ---- supply / communication (common across modules) ----
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
// Exact full-sentence overrides for job-argument comments. A word table can't
// reorder German syntax, so the common whole sentences (the top few cover
// thousands of arg occurrences across the fleet) are translated as units,
// matched before the token pass. Keyed on the trimmed comment verbatim.
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
  if (ARG_PHRASES[trimmed]) out = ARG_PHRASES[trimmed];         // exact sentence
  // per-ECU fault-location text -> English, generated from the SGBD FORTTEXTE tables
  // (faultdb.js). keyed on the trimmed German text, so it is variant-agnostic.
  if (out === null && typeof window !== 'undefined' && window.BMW_FAULT_PHRASES)
    out = window.BMW_FAULT_PHRASES[trimmed] || null;
  if (out === null) for (const [de, en] of FAULT_PHRASES) if (trimmed === de) { out = en; break; }
  if (out === null) {
    // token-level fallback for partial/unlisted phrases (P-code text, etc.)
    out = text;
    for (const [re, en] of DE_TOKENS) out = out.replace(re, en);
  }
  // don't cache token-fallback results taken before the phrase map has loaded,
  // or they'd shadow the better BMW_FAULT_PHRASES translation once it arrives.
  if (typeof window === 'undefined' || window.BMW_FAULT_PHRASES) {
    if (_deCache.size > 5000) _deCache.clear();
    _deCache.set(text, out);
  }
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

// F_ORT_NR is the ECU-local fault-location number (BMW "Fehlerort"). We show the
// LOCATION BYTE - the value a plain code reader displays and the key the SGBD
// FORTTEXTE table uses (IHKA 0x1F -> Drucksensor, LWS 0x0B -> LWS-ID). For a 16-bit
// F_ORT_NR (e.g. LWS 0x0B3F) the location is the HIGH byte (0x0B); the low byte is a
// symptom/status detail we don't surface here. Single-byte values pass through as-is.
// Returned as two hex digits ("1F", "0B"). EDIABAS gives F_ORT_NR as a decimal string
// ("2879" for 0x0B3F); an already-hex value ("0x0B3F"/"1F") is accepted too.
function ortNrCode(nr) {
  if (nr == null) return null;
  const s = String(nr).trim();
  if (!s) return null;
  let val = null;
  let m = s.match(/^0x([0-9A-Fa-f]+)$/) || s.match(/^([0-9A-Fa-f]*[A-Fa-f][0-9A-Fa-f]*)$/);
  if (m) val = parseInt(m[1], 16);
  else if (/^\d+$/.test(s)) val = parseInt(s, 10);
  if (val == null || Number.isNaN(val)) return s; // unknown format: show as-is
  // location byte: high byte for a 16-bit value, the value itself for a single byte
  const loc = val > 0xFF ? (val >> 8) & 0xFF : val;
  return loc.toString(16).toUpperCase().padStart(2, '0');
}
function pCode(loc, hex) {
  const code = bmwCode(loc, hex);
  return code && PCODE_MAP[code] ? PCODE_MAP[code] : null;
}
