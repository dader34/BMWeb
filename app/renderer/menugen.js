// raw EDIABAS job list -> English INPA-style functional menu.
// Port of the C# MenuGen.Build path (src/EdiabasMac/MenuGen.cs); the
// activations side (argument introspection, runnable gating) stays on the
// server because it needs offline engine calls. Token extensions come from
// menugen-tokens.js, generated out of tools/translations/*_tokens.tsv.

// pseudo-jobs and protocol plumbing that never belong in a menu
const MENUGEN_SYSTEM = new Set([
  '_JOBS', '_JOBCOMMENTS', '_ARGUMENTS', '_RESULTS', '_VERSIONINFO', '_TABLES', '_TABLE',
  'INITIALISIERUNG', 'ENDE', 'NORMALER_DATENVERKEHR', 'DIAGNOSE_AUFRECHT',
  'DIAGNOSE_MODE', 'DIAGNOSE_ENDE', 'SENDE_TELEGRAMM',
]);

const MENUGEN_CURATED = {
  FS_LESEN: 'Read fault codes',
  FS_LESEN_DETAIL: 'Read fault codes (detailed)',
  FS_LESEN_HEX: 'Read fault codes (hex)',
  FS_LESEN_FREEZE_FRAME: 'Read fault codes (freeze frame)',
  FS_LOESCHEN: 'Clear fault codes',
  IDENT: 'Identify ECU',
  INFO: 'ECU info',
  SERIENNUMMER_LESEN: 'Read serial number',
  STATUS_LESEN: 'Read status',
  CBS_DATEN_LESEN: 'Read CBS service data',
  CBS_RESET: 'Reset CBS service',
  STEUERGERAETE_RESET: 'Reset ECU',
  STATUS_OBD: 'OBD status',
  // immobilizer sync: NOT an actuator test — drives the DME<->EWS/CAS
  // rolling-code handshake. INPA labels it "EWS/CAS-Startwertabgleich".
  STEUERN_SYNC_MODE: 'EWS/CAS sync (immobilizer)',
  STATUS_SYNC_MODE: 'EWS/CAS sync status',
  // CO idle-mixture adjustment: live trim, then permanent store
  STEUERN_CO_ABGLEICH_VERSTELL: 'CO idle mixture: adjust',
  STEUERN_CO_ABGLEICH_PROGRAMMIEREN: 'CO idle mixture: save (program)',
  STEUERN_LLABG_PROG: 'Idle adjustment: save (program)',
  // electric radiator fan (Elektrolüfter) vs STEUERN_EBL "E-Box Fan"
  STEUERN_E_LUEFTER: 'Radiator Fan',
};

// German token -> English. Base verbs/nouns here; TSV-mined extensions from
// menugen-tokens.js win where both define a token (same precedence as C#).
const MENUGEN_BASE_TOKENS = {
  LESEN: 'Read', SCHREIBEN: 'Write', LOESCHEN: 'Clear', SETZEN: 'Set',
  STATUS: 'Status', STEUERN: 'Activate', STELLGLIED: 'Actuator', TEST: 'Test',
  FEHLER: 'Fault', FS: 'Fault', MOTOR: 'Engine', DREHZAHL: 'RPM',
  TEMPERATUR: 'Temperature', TEMP: 'Temp', DRUCK: 'Pressure', SPANNUNG: 'Voltage',
  LAMBDA: 'Lambda', GEMISCH: 'Mixture', ZUENDUNG: 'Ignition', EINSPRITZUNG: 'Injection',
  KRAFTSTOFF: 'Fuel', LUFT: 'Air', ABGAS: 'Exhaust', KAT: 'Catalyst',
  KUEHLMITTEL: 'Coolant', OEL: 'Oil', GANG: 'Gear', GETRIEBE: 'Transmission',
  SERIENNUMMER: 'Serial number', NUMMER: 'Number', NR: 'number',
  HARDWARE: 'Hardware', SOFTWARE: 'Software', VERSION: 'Version', DATEN: 'Data',
  REFERENZ: 'Reference', PHYSIKALISCHE: 'Physical',
  FLASH: 'Flash', PROGRAMMIER: 'Programming', SIGNATUR: 'Signature',
  AUTHENTISIERUNG: 'Authentication', ZUFALLSZAHL: 'Random number', START: 'Start',
  ADRESSE: 'Address', SPEICHER: 'Memory', ZEITEN: 'Times', ZEIT: 'Time',
  PARAMETER: 'Parameter', BAUDRATE: 'Baud rate', RESET: 'Reset', MODE: 'Mode',
  VARIANTE: 'Variant', PRUEFSTEMPEL: 'Inspection stamp', PRUEFCODE: 'Test code',
  BACKUP: 'Backup', READINESS: 'Readiness', SYSTEMCHECK: 'System check',
  SEK: 'Secondary', TEV: 'Purge valve', FGR: 'Cruise control', SPERREN: 'Lock',
  // body-module abbreviations: "IB" is Innenbeleuchtung, and "Ib Off" is
  // not a phrase anyone recognises
  IB: 'Interior lighting', AUS: 'off', EIN: 'on', ZV: 'Central locking',
  FH: 'Window', WIWA: 'Wipe/wash', DWA: 'Anti-theft', SHD: 'Sunroof',
  EINGRIFF: 'Intervention', EINGRIFFE: 'Interventions', ANZAHL: 'Count',
  ZAEHLER: 'Counter', MAX: 'Max', BETRIEB: 'Operation',
};

const MENUGEN_TOKENS = Object.assign({}, MENUGEN_BASE_TOKENS,
  typeof MENUGEN_TSV_TOKENS !== 'undefined' ? MENUGEN_TSV_TOKENS : {});

const MENUGEN_ORDER = ['Faults', 'Status', 'Activations', 'System Check', 'Coding',
                       'Identity', 'AIF', 'Adaption', 'Service', 'Special', 'Other'];
const MENUGEN_DANGER =
  /FLASH|LOESCHEN|SCHREIBEN|RESET|AUTHENTISIERUNG|PROGRAMMIER|BAUDRATE|_SETZEN|STEUERN(?!\w*LESEN)|STELLGLIED/i;
// suffix verbs moved to front of label
const MENUGEN_FRONT_VERB = { LESEN: 'Read', SCHREIBEN: 'Write', LOESCHEN: 'Clear', SETZEN: 'Set' };

function menugenSection(job) {
  const j = job.toUpperCase();
  if (j.startsWith('FS_') || j.includes('FEHLER')) return 'Faults';
  if (j === 'IDENT' || j === 'INFO' || j === 'SERIENNUMMER_LESEN' || j.startsWith('IDENT')) return 'Identity';
  if (j.includes('VERSION') || j.includes('HARDWARE') || j.includes('REFERENZ') || j.includes('_HW_')) return 'Identity';
  if (j.startsWith('STATUS') || j.startsWith('MW_') || j.includes('MESSWERT')) return 'Status';
  // STEUERN_WERT_LESEN and friends read the current activation value:
  // read jobs, not actuator tests
  if (j.startsWith('STEUERN') && j.includes('LESEN')) return 'Status';
  if (j.startsWith('STEUERN') || j.includes('STELLGLIED') || j.includes('AUSGAENGE_SCHALTEN')) return 'Activations';
  // Flash/authentication jobs are deliberately NOT a menu section: these are
  // raw primitives only safe inside the seed/key sequence the Flashing tool
  // drives. Listing them as buttons would offer erase/write out of order.
  if (j.includes('FLASH') || j.includes('PROGRAMMIER') || j.includes('AUTHENTISIERUNG') || j.includes('SIGNATUR')) return null;
  if (j.includes('SYSTEMCHECK')) return 'System Check';
  if (j.includes('CODIER') || j.includes('ECU_CONFIG') || j.includes('SET_PARAMETER')
      || j.includes('BAUDRATE') || j.includes('INTERFACETYPE') || j.includes('ACCESS_TIMING')) return 'Coding';
  // INPA gives the user-information field its own root key (F3 "AIF"),
  // separate from Ident (F2): it is a programming LOG, not ECU identity.
  if (j.includes('AIF')) return 'AIF';
  if (j.includes('ZIF') || j.includes('PRUEFCODE')
      || j.includes('C_CI') || j.includes('C_FG') || j.includes('C_C_')) return 'Identity';
  if (j.includes('EWS') || j.includes('DISTANCE_MIL') || j.startsWith('SPEICHER')) return 'Special';
  // INPA gives adaptation clearing its own root key (F8 "Adaption"):
  // it erases what the DME has learned, which is not a service read.
  if (j.includes('ADAP')) return 'Adaption';
  if (j.includes('CBS') || j.includes('PRUEFSTEMPEL') || j.includes('PRUEFFLAG')
      || j.includes('DIAGNOSEPROTOKOLL')
      || j.includes('RESET') || j.includes('STARTWERT') || j.includes('SLEEP')
      || j.includes('INNENTEMP')) return 'Service';

  // E36/early-E46 engine and body ECUs expose many DS1/DS2-era jobs the rules
  // above miss. route them into INPA's named submenus (verified against the
  // a_smot/a_dmot frontends and the .prg job sets) so nothing lands in "Other".

  // self-tests, actuator/sensor diagnostics, ABS/DSC bleeding + pressure
  // build/hold cycles, hydraulic/pump tests, simulations -> System-Check.
  if (j.includes('SELBSTTEST') || j.includes('PRUEFLAUF') || j.includes('IO_STATUS')
      || j.includes('I_O_DIAGNOSE') || j.startsWith('TEST_') || j.includes('TESTPRG')
      || j.includes('TEST_PRG') || j.includes('SIMULATION') || j.includes('_SIM_')
      || j.includes('SIM_HA') || j.includes('EINSPURMODELL') || j.includes('MCS_AKTIVIEREN')
      || j.includes('DISPLAYTEST') || j.includes('DISPLAY_TEST') || j.startsWith('DOWNLOAD_')
      || j.includes('DRUCKABBAU') || j.includes('DRUCKAUFBAU') || j.includes('DRUCKHALTEN')
      || j.includes('PUMPEN') || j.includes('ENTLUEFTUNG') || j.includes('BLEEDMASTER')
      || j.includes('VAKUUM') || j.includes('FUEHLER') || j.includes('ANFAHREN_POSITION')
      || j.includes('MOTOR_FAHREN') || j.includes('TIPP_FUNKTION') || j.includes('TANK_LECK')
      || j.includes('CRASH_AUSLOESEN') || j.includes('EICHLAUF')) return 'System Check';

  // variant/equipment/vehicle-data coding -> Coding.
  if (j.startsWith('COD_') || (j.startsWith('COD') && j.includes('LESEN')) || j.includes('KODIER')
      || j.includes('VAR_COD') || j.includes('EMK_COD') || j.includes('AGR_COD')
      || j.includes('AUSSTATTUNG') || j.includes('KFZ_DATEN') || j.includes('PARAMETERSATZ')
      || j.includes('ZCS') || j.includes('DATENSATZNUMMER') || j.includes('FAKTOR_SCHREIBEN')
      || j.includes('TRIG_SCHREIBEN')) return 'Coding';

  // production/identification data, counters, system-address + KD reads -> Identity.
  if (j.includes('PROD_NR') || j.includes('BMW_NR') || j.includes('FG_NR') || j.includes('FGNR')
      || j.includes('HERSTELLDAT') || j.includes('HERSTELLDATEN') || j.includes('HERSTELLERDATEN')
      || j.includes('HERSTELLER_DATEN') || j.includes('TYP_LESEN') || j.includes('ZAEHLERSTAENDE')
      || j.includes('SYS_ADR') || j.includes('SYSTEM_ADRESSEN') || j.includes('MAX_BLOCK')
      || j.includes('KD_DATEN') || j.includes('KD_INIT') || j.includes('ZUSTAND_LESEN')
      || j.includes('ZCS_LESEN')) return 'Identity';

  // memory dumps, immobilizer ISN, security access (login/seed/password),
  // rolling code + key data, function/lock state -> Special.
  if (j.startsWith('RAM_') || j.startsWith('ROM_') || j.includes('EEPROM') || j.includes('ISN')
      || j.includes('SEED') || j.includes('LOGIN') || j.includes('PASSWORT')
      || j.includes('WECHSELCODE') || j.includes('SCHLUESSEL') || j.startsWith('SCHL_')
      || j.includes('INFOSPEICHER') || j === 'IS_LESEN' || j.includes('FUNKTIONSSPERRE')
      || j.includes('VERRIEGELUNG') || j.includes('INIT_SPERRE')) return 'Special';

  // adaptation clears, CO/idle/consumption adjustment, programming-voltage,
  // battery messages, diagnostic-session control, end-of-line -> Service.
  if (j.includes('ADAPT') || j.includes('ABGLEICH') || j.includes('ABGAS_VARIANTE')
      || j.includes('UPROG') || j.includes('MESSE_VERSTELLZEIT') || j.includes('BATTERIE_MELDUNG')
      || j.includes('DIAGNOSE_') || j.includes('DIAGNOSTICEND') || j.includes('START_BUS')
      || j.startsWith('BET_') || j.includes('RPA_EOL') || j.endsWith('_LOESCHEN')) return 'Service';

  // raw OBD-II mode readouts + transparent/raw access, ADC + parameter reads -> Status.
  if (j.includes('_MODE') || j.includes('_REQ') || j.includes('RAWMODE')
      || j.includes('TRANSPARENT') || j.includes('ADC_LESEN') || j === 'PARAMETER_LESEN')
    return 'Status';

  return 'Other';
}

function menugenTranslate(job) {
  const curated = MENUGEN_CURATED[job.toUpperCase()];
  if (curated) return curated;
  const parts = job.split('_').filter(p => p.length > 0);
  // trailing Read/Write/Clear/Set verb moves to front
  let front = null;
  if (parts.length > 1) {
    const fv = MENUGEN_FRONT_VERB[parts[parts.length - 1].toUpperCase()];
    if (fv) { front = fv; parts.pop(); }
  }
  const words = parts.map(p => {
    const t = MENUGEN_TOKENS[p.toUpperCase()];
    if (t) return t;
    return /^\p{L}+$/u.test(p) ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p;
  });
  const body = words.join(' ');
  return front !== null ? `${front} ${body.toLowerCase()}` : body;
}

// job list -> [{section, items: [{job, label, danger}]}], INPA section order
function menugenBuild(jobs) {
  const buckets = new Map(MENUGEN_ORDER.map(s => [s, []]));
  for (const job of jobs) {
    if (MENUGEN_SYSTEM.has(job.toUpperCase())) continue;
    const section = menugenSection(job);
    if (section === null) continue; // no INPA menu holds this job
    buckets.get(section).push({ job, label: menugenTranslate(job), danger: MENUGEN_DANGER.test(job) });
  }
  return MENUGEN_ORDER.filter(s => buckets.get(s).length > 0)
                      .map(s => ({ section: s, items: buckets.get(s) }));
}
