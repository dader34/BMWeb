// The IR interpreter: draw an ECU's screens from data/inpa-ir/<ECU>.json
// instead of from hand-written or per-section layout code.
//
// tools/ipo_ir.py emits the whole INPA UI per ECU -- menus with INPA's own
// ITEM numbers, screens as ordered LINEs of positioned elements (text / value
// / gauge / lamp) with the row and column INPA itself draws them at, and the
// jobs each screen runs. This walks that structure.
//
// Nothing here knows anything about any particular ECU. The only per-ECU
// knowledge in the app after this is translation, which is applied at render
// time because each .IPO's strings are frozen in whatever language BMW
// compiled it with (`language` in the IR says which).
//
// Values still come from the existing live poller: an IR screen converts to
// the {job, rows, grid} shape showInpaScreens already consumes, so paging,
// gauge cells, lamp glyphs and the demo mode all work unchanged. The IR's
// contribution is WHICH rows, in WHAT order, with WHICH captions and ranges.

// screens whose elements are all static text have nothing to poll
function irReadable(scr) {
  return (scr.lines || []).some(ln =>
    (ln.elements || []).some(e => e.key && e.t !== 'text'));
}

// A screen's rows, in INPA's own drawing order.
//
// Captions: INPA prints a label as its own `text` element beside the value,
// so a row's caption is the nearest preceding text on the same line -- and
// when a LINE names several keys ("Wheel speed FL, Wheel speed FR" over
// "STAT_..._VL_WERT;STAT_..._VR_WERT"), the caption splits positionally.
function irRows(scr) {
  const rows = [];
  const cells = [];
  // a screen that reads the same job once per position (wheel, bank,
  // cylinder) repeats its result keys per LINE, distinguished only by the
  // job's argument. Rows carry that argument so the poller reads each pass
  // separately and one wheel's value cannot overwrite another's.
  const multiArg = new Set((scr.lines || []).map(l => l.jobArg)
    .filter(Boolean)).size > 1;
  for (const ln of scr.lines || []) {
    const els = ln.elements || [];
    const caps = String(ln.caption || '').split(',').map(s => s.trim());
    const valued = els.filter(e => e.key && e.t !== 'text');
    // one caption for several unrelated keys is a LOOP screen: INPA draws the
    // heading once at a computed position and reuses it (RDC prints
    // "Position FL..RR" round a wheel loop). Applying it to every key labels
    // three different readouts identically, so take no label instead.
    const capForAll = caps.length === 1 && caps[0] && valued.length === 1;
    let pending = null;
    let unitAhead = null;
    let nth = 0;
    for (const e of els) {
      if (e.t === 'text') {
        const s = String(e.s || '').trim();
        // "[rpm]" printed above a gauge is its UNIT, not its caption
        const m = /^\[(.+)\]$/.exec(s);
        if (m) { unitAhead = m[1].trim(); continue; }
        // INPA lays a labelled row out as three prints: the caption, a bare
        // ":" separator at a fixed column, then the value. The separator is
        // punctuation, not a label -- taking "nearest preceding text"
        // literally turned every coding row's caption into ":".
        if (/^[:=|-]+$/.test(s)) continue;
        if (s) pending = s;
        continue;
      }
      if (!e.key) continue;
      // positional caption from the LINE header when it lists one per key
      let label = pending;
      if (!label && caps.length > 1 && valued.length === caps.length)
        label = caps[nth];
      if (!label && capForAll) label = caps[0];
      const row = {
        key: e.key,
        label: label || null,
        unit: e.unit || unitAhead || null,
        kind: e.t,
      };
      // on a per-position screen the LINE caption ("Rad 1") is the position,
      // and the argument is what distinguishes otherwise identical keys. The
      // position is kept separately so the row's own caption can still be
      // resolved (or fall back to the SGBD description) before they are
      // joined -- prefixing here would freeze in a placeholder like "(1)".
      if (multiArg && ln.jobArg) {
        row.arg = ln.jobArg;
        const pos = (ln.caption || '').trim();
        if (pos) row.pos = pos;
      }
      if (typeof e.min === 'number' && typeof e.max === 'number'
          && e.max > e.min) { row.min = e.min; row.max = e.max; }
      if (e.on) row.on = e.on;
      if (e.off) row.off = e.off;
      rows.push(row);
      if (typeof e.row === 'number')
        cells.push({ key: e.key, row: e.row, col: e.col || 0 });
      pending = null;
      unitAhead = null;
      nth++;
    }
  }
  return { rows, cells };
}

// One IR screen -> the screen objects showInpaScreens polls. A screen with
// several read jobs becomes one entry per job: the poller reads them all each
// tick and keeps whichever keys each answers.
function irScreens(scr) {
  const { rows, cells } = irRows(scr);
  if (!rows.length) return [];
  // write-shaped jobs are represented in the IR but never auto-run
  const jobs = (scr.jobs || []).filter(j => !j.write);
  if (!jobs.length) return [];
  // a per-position screen becomes one poll per argument, each carrying only
  // the rows read in that pass -- otherwise all five wheels share one read
  // and show identical values
  if (rows.some(r => r.arg)) {
    return jobs.map(j => ({
      job: j.name,
      args: j.arg || '',
      group: scr.title || null,
      rows: rows.filter(r => r.arg === j.arg),
      grid: null,
    })).filter(s => s.rows.length);
  }
  return jobs.map(j => ({
    job: j.name,
    args: j.arg || '',
    group: scr.title || null,
    rows,
    grid: cells.length ? { cells } : null,
  }));
}

// Translate a caption the way the rest of the app does. German-built .IPOs
// reach us German; English-built ones pass through unchanged.
function irLabel(s) {
  if (!s) return s;
  return (typeof deGerman === 'function' && deGerman(s)) || s;
}

// INPA's own state words, so a lamp reads ON/OFF in English mode
function irState(s) {
  if (s == null) return s;
  const t = String(s).trim();
  if (/^EIN$/i.test(t)) return 'ON';
  if (/^AUS$/i.test(t)) return 'OFF';
  if (/^JA$/i.test(t)) return 'YES';
  if (/^NEIN$/i.test(t)) return 'NO';
  return irLabel(t);
}

// captions INPA recomputes each pass of a loop, so whichever one the decode
// captured belongs to no single row: a bare index "(1)", a wheel position
// heading, or its own placeholder "??"
const IR_LOOP_CAPTION = /^(\(\d+\)|\?+|Index \d+|Rad \d+|Position (FL|FR|RL|RR|VL|VR|HL|HR))$/i;

function irRowsTranslated(scr, descs) {
  return irScreens(scr).map(s => ({
    ...s,
    group: irLabel(s.group),
    rows: s.rows.map(r => ({
      ...r,
      // INPA's own caption first; for rows it draws without one -- loop
      // screens print a heading once at a computed position -- the SGBD's
      // result description, and only then the bare key.
      // A caption INPA itself computes per iteration ("Position RR", "(1)",
      // "??") is left over from the last pass of a loop and describes no
      // particular row, so the SGBD description wins over it.
      label: (r.pos ? `${irLabel(r.pos)} · ` : '') + irLabel(
        (IR_LOOP_CAPTION.test(r.label || '') ? null : r.label)
        || (descs && descs.get(r.key)) || r.label || r.key),
      unit: r.unit ? irLabel(r.unit) : r.unit,
      on: irState(r.on),
      off: irState(r.off),
    })),
  }));
}

// result-name -> description, straight from the SGBD (offline, no cable).
// Cached per ECU: the same job serves several screens.
const _irDescCache = new Map();
async function irDescs(ecu, scr) {
  const jobs = (scr.jobs || []).filter(j => !j.write).map(j => j.name);
  const out = new Map();
  for (const job of jobs) {
    const ck = `${ecu.sgbd}:${job}`;
    if (!_irDescCache.has(ck)) {
      let m = new Map();
      try {
        const d = await api(`/api/ecu/${ecu.sgbd}/results/${job}`);
        for (const line of Array.isArray(d) ? d : []) {
          const i = String(line).indexOf(':');
          if (i > 0) {
            m.set(String(line).slice(0, i).trim(),
                  String(line).slice(i + 1).trim());
          }
        }
      } catch { m = new Map(); }
      _irDescCache.set(ck, m);
    }
    for (const [k, v] of _irDescCache.get(ck)) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

// A menu's entries, in INPA's order, keeping ITEM numbers as the F-keys.
// Chrome INPA implements itself (print/select/exit) is dropped: the app has
// those natively, and Back is the Esc key.
const IR_CHROME = /^(Back|Exit|Print|Zur(ü|ue)ck|Ende|End|Select|Deselect|Auswahl|Abwahl|Druck|Drucken|Gesamt)$/i;

// "Read"/"FS lesen" in a fault menu: INPA runs this through its own library
// (INPAapiFsLesen_neu, which writes na_fs.tmp), so the decoded item names no
// job. Handed to the app's fault reader instead.
// A fault-memory read. INPA runs these through its own library
// (INPAapiFsLesen_neu), so the decoded item names no job -- the memory it
// reads is in the caption. BMW ships three: Fehlerspeicher (EM/FS),
// Infospeicher (IM/IS) and Historienspeicher (HM/HS), each with its own
// read, clear, print and save.
// Word order varies by build: "Read EM", "EM Read", "FS lesen", plain "Read".
const IR_FAULT_READ =
  /^(Read|Lesen)$|^(Read|Lesen)\s+(EM|IM|HM|FS|IS|HS)\b|^(EM|IM|HM|FS|IS|HS)\s+(Read|lesen)\b|^(Shadow|Schatten)/i;

// which memory a fault-menu caption names -> the SGBD job that reads it
const IR_FAULT_JOB = [
  // "Shadow"/"Schattenspeicher" is the info memory under another name --
  // TOENS labels its F3 that way and answers IS_LESEN
  [/^(Shadow|Schatten)/i, 'IS_LESEN'],
  [/\b(IM|IS|Infospeicher)\b/i, 'IS_LESEN'],
  [/\b(HM|HS|Historienspeicher)\b/i, 'HS_LESEN'],
  [/\b(EM|FS|Fehlerspeicher)\b/i, 'FS_LESEN'],
];
const irFaultJob = (label) =>
  (IR_FAULT_JOB.find(([re]) => re.test(label)) || [null, 'FS_LESEN'])[1];

// Items INPA implements against the FILE SYSTEM rather than the car: saving
// the fault list to disk ("FS speichern", which RDC labels "store"). BMW's
// own BMW_STD.SRC defines these next to Print, and like Print they cannot be
// reproduced against an ECU.
const IR_FILE_ACTION =
  /^(store|save|speichern)\b|^(FS|IS|HS|EM|IM|HM) (speichern|drucken)$|^(Save|Print) (EM|IM|HM)$/i;

function irMenuItems(ir, menuName) {
  const menu = (ir.menus || {})[menuName];
  if (!menu) return [];
  const seen = new Set();
  return (menu.items || [])
    .filter(it => it.label && !IR_CHROME.test(it.label.trim()))
    // drives INPA rather than the car: loads another script, opens the KVP
    // editor. Flagged by the emitter from what the item does, not its name.
    .filter(it => !it.appTool)
    // writes the fault list to a file, like Print -- an INPA function, not an
    // ECU one, and it names no job because there is nothing to send
    .filter(it => !(IR_FILE_ACTION.test(it.label.trim()) && !it.job
                    && !it.screen && !it.menu))
    // a key whose only effect is to redraw the menu's own screen does
    // nothing here -- INPA needs it because the screen IS the window
    .filter(it => !(it.screen === (ir.entry || {}).screen && !it.menu))
    // an item with no navigation target is an ACTION INPA performs in place:
    // its actuator items only flip state flags and let the screen send the
    // job. Those are listed (the caption is INPA's own, joined from the
    // screen's softkey help by F-number) but never runnable here -- firing an
    // actuator is gated on car verification, and the arming semantics are
    // not decoded.
    .filter(it => it.screen || it.menu || !it.action)
    // a write entry that opens the same SCREEN as a read entry (RDC's
    // "MV write" reuses s_abgleichwert_lesen): INPA's difference is an input
    // dialog and a write job in the ITEM body, neither of which we run until
    // verified on a car, so what remains is a duplicate of the read page
    .filter(it => {
      const dup = it.screen && seen.has(it.screen)
        && /write|schreiben|reset|clear|loesch/i.test(it.label);
      if (it.screen) seen.add(it.screen);
      return !dup;
    })
    .map(it => ({
      nr: it.nr,
      label: irLabel(it.label.trim()) || it.label.trim(),
      screen: it.screen || null,
      menu: it.menu || null,
      // the job this item calls itself, if any (Clear -> FS_LOESCHEN,
      // Sleep -> SLEEP_MODE). Dropping it here made every such key inert:
      // open() tests it.job, so without this Clear could never run.
      job: it.job || null,
      // changes the ECU permanently (EEPROM write, service reset) rather
      // than driving an actuator for the duration of a test
      writeJob: !!it.writeJob,
      // INPA asks the user for a value and builds the job argument from it
      // (KLIMA_5B's flap positions: "Fresh air flap", "Position (0-100 %)")
      prompt: it.prompt || null,
      // no target and no action: INPA runs this in place (actuator toggles)
      inPlace: !it.screen && !it.menu,
      readable: it.screen ? irReadable((ir.screens || {})[it.screen] || {})
        : false,
    }));
}

// Actuator keys always run -- INPA sends on the keypress. The setting only
// decides whether we ask first; defaulting to asking, since unlike INPA this
// app can be pointed at a car by someone who did not choose the test.
const confirmActuators = () => Settings.get('confirmActuators', 'on') !== 'off';

// Live actuator state per menu, mirroring INPA's own: the menu holds the
// argument word between presses, each key toggles its own pair, and the whole
// word is sent every time. Starting from composite.baseline -- the value
// INPA's startup initialises the fields to -- means our first send is
// byte-identical to INPA's.
const _compState = new Map();

function compWord(ir, menuName) {
  const comp = (ir.menus[menuName] || {}).composite;
  if (!comp) return null;
  const ck = `${ir.ecu}:${menuName}`;
  if (!_compState.has(ck)) {
    const base = comp.baseline
      ? comp.baseline.split(';')
      : new Array(comp.fields).fill('0');
    _compState.set(ck, base);
  }
  return _compState.get(ck);
}

// Send one actuator key: set its REQ/VAL pair in the shared word, post the
// job, show what went out and what came back. No confirmation and no
// sub-screen -- INPA sends on the keypress, so this does too.
async function runComposite(ecu, ir, menuName, it, container, reopen, keysFor) {
  const comp = (ir.menus[menuName] || {}).composite;
  const pair = comp && comp.items && comp.items[String(it.nr)];
  const word = comp && compWord(ir, menuName);
  if (!comp || !word) return;

  let on = null;
  if (pair) {
    // toggle this key's request flag; the value field follows it, except
    // where INPA only ever sends 0 for that field (RDC's CAL_VAL: F3
    // requests calibration and leaves the value unused)
    const [reqI, valI] = pair;
    on = word[reqI] === '1' ? '0' : '1';
    word[reqI] = on;
    const valOnly = (comp.values || [])[valI];
    word[valI] = (valOnly && valOnly.length === 1)
      ? String(valOnly[0]) : on;
  }
  // no pair: this key is the COMMIT -- it sends the word as it stands
  // (RDC F8 "write data into ECU"), which is why it owns no field
  const arg = word.join(';');

  // INPA stays on its menu -- the keys keep their state and you toggle the
  // next one -- so the result goes to the status bar and the row's own
  // marker, never to a separate page.
  sbLeft.textContent = `${ecu.sgbd}.prg · ${comp.job} ${arg} · sending`;
  let out = null, err = null;
  try {
    out = await api(`/api/ecu/${ecu.sgbd}/run/${comp.job}`
      + `?arg=${encodeURIComponent(arg)}`, { method: 'POST' });
  } catch (e) { err = e; }

  const status = err
    ? `failed: ${err.message}`
    : (flatResults(out.sets).map(([k, v]) => `${k}=${v}`).slice(0, 3)
        .join(' ') || 'sent');
  sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} `
    + `${on === null ? 'sent' : (on === '1' ? 'ON' : 'OFF')} `
    + `· ${comp.job} ${arg} · ${status}`;
  // redraw the menu so every row shows its current on/off state
  reopen();
}

// A screen with no gauges and no lamps is a labelled READ -- coding data,
// identification, references. INPA draws those as a colon-aligned list, not
// as bars, and they do not change while the car sits there, so they get the
// ID-data card (identity.js) rather than the polling gauge grid: same
// presentation as the Info tab, in both UI modes, read once with F1 to
// re-read.
function irIsCard(scr) {
  if (irIsMemory(scr)) return false;
  const rows = irRows(scr).rows;
  if (!rows.length || !rows.every(r => r.kind === 'value')) return false;
  // a per-position screen reads the same keys once per wheel/bank, so a
  // single card keyed by result name would show the last pass five times.
  // Those go to the poller, which reads each argument separately.
  return !rows.some(r => r.arg);
}

// INPA's memory dump: SPEICHER_LESEN with a start address and a byte count,
// printed as a hex dump rather than named results. Decoding it as rows gives
// one useless JOB_STATUS field, so it routes to showMemory instead.
function irIsMemory(scr) {
  return (scr.jobs || []).some(j => /^SPEICHER_LESEN/i.test(j.name))
    && irCaptions(scr).some(c => /address|adresse/i.test(c));
}

// Only where INPA itself names regions (tools/ipo_memory.py -- GSDS2: RAM,
// ROM). An ECU like IHKA prints just "Start address" and "Number": no
// regions, no bounds. Synthesising one would invent an address range the ECU
// never declared, so those return null and are reported rather than guessed.
function irMemoryScreen(scr, mined) {
  return (mined && (mined.regions || []).length) ? mined : null;
}

// INPA's "Information" screen describes the SCRIPT, not the car: rework
// program, version, responsibility, then the SGBD's own file header. It reads
// no ECU results at all -- the captions are printed and the values come from
// script variables -- so it has no keys and would otherwise render blank.
// The SGBD answers the same facts through its INFO pseudo-job (offline, no
// cable), so the captions are paired with it positionally.
const IR_INFO_KEYS = ['TITLE', 'VERSION', 'ORIGIN', 'PACKAGE', 'ECU',
                      'REVISION', 'AUTHOR', 'SPRACHE', 'COMMENT'];

// Deliberately narrow. "No result rows plus some captions" also describes a
// screen whose values this decoder failed to extract -- ACC's s_id_aktuell
// prints BMW part number and serial number that way -- and pairing those with
// the INFO job would invent data. The information screen is identified by the
// name INPA gives it (`s_info`, the script-info page in BMW's own template,
// on 452 ECUs' Info key) plus the absence of softkey help, which is what
// distinguishes it from a screen that merely hosts a menu.
function irIsInfo(scr, name) {
  if (name !== 's_info') return false;
  if (irRows(scr).rows.length) return false;
  if (scr.softkeys && Object.keys(scr.softkeys).length) return false;
  return irCaptions(scr).length >= 3;
}

// the printed captions of a screen that has no result rows, in draw order
function irCaptions(scr) {
  const out = [];
  for (const ln of scr.lines || [])
    for (const e of ln.elements || [])
      if (e.t === 'text') {
        const s = String(e.s || '').trim();
        if (s && !/^[:=|-]+$/.test(s)) out.push(s);
      }
  return out;
}

// Info as a card: INPA's captions, paired in order with the SGBD's INFO
// results. Extra captions with no counterpart are kept and left blank rather
// than dropped -- INPA prints them.
function irInfoCard(scr) {
  const caps = irCaptions(scr);
  return {
    title: irLabel(scr.title) || 'Information',
    subtitle: 'script and SGBD information · read-only',
    jobs: ['INFO'],
    fields: caps.map((c, i) => ({
      key: IR_INFO_KEYS[i] || `_cap${i}`,
      label: irLabel(c) || c,
    })),
  };
}

// One IR screen as the shape renderIdentity consumes.
function irAsCard(scr, descs) {
  const { rows } = irRows(scr);
  return {
    title: irLabel(scr.title) || 'Read',
    subtitle: (scr.jobs || []).map(j => j.name).join(' · ') + ' · read-only',
    jobs: (scr.jobs || []).filter(j => !j.write).map(j => j.name),
    fields: rows.map(r => ({
      key: r.key,
      label: irLabel(r.label || (descs && descs.get(r.key)) || r.key),
    })),
  };
}

// Walk the IR from a menu: list its entries, open a screen, descend into a
// submenu, Esc back up one level -- INPA's own navigation, and ours.
function renderIrMenu(ecu, ir, menuName, container, back, trail = []) {
  const items = irMenuItems(ir, menuName);
  if (!items.length) return false;

  const open = async (it) => {
    // Fault memory is read through INPA's own library helper, not a job the
    // screen names: F1 calls INPAapiFsLesen_neu and writes na_fs.tmp, so the
    // decode has a caption and nothing to run. The app's fault view already
    // does this properly -- FS_LESEN plus code lookup and freeze frames --
    // so the menu is INPA's but this one entry hands off to it.
    if (it.inPlace && !it.job && IR_FAULT_READ.test(it.label)
        && typeof runJob === 'function') {
      // the caption says WHICH memory: "Read IM" -> IS_LESEN. 239 ECUs keep
      // an info memory and 20 a history memory that a hardcoded FS_LESEN
      // would never have read.
      runJob(ecu, irFaultJob(it.label), container, false);
      sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label}`;
      setActions([...keys(), {
        key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
        fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
      }]);
      return;
    }
    // A key that installs a MENU opens that menu, whatever else it does.
    // INPA's root keys set the screen AND the softkey menu together (Status
    // -> s_status + m_rdc_status), and s_status is only the window the menu
    // is drawn in -- it has no rows of its own. Checking the screen first
    // sent Status and Activate to the "no readout" message instead of their
    // submenus.
    if (it.menu) {
      renderIrMenu(ecu, ir, it.menu, container,
                   () => renderIrMenu(ecu, ir, menuName, container, back, trail),
                   [...trail, it.label]);
      return;
    }
    // an item with its own job (RDC F18 Sleep -> SLEEP_MODE) is an ordinary
    // one-key-one-job action, unrelated to any composite word
    if (it.inPlace && it.job
        && !((ir.menus[menuName] || {}).composite || {}).items?.[String(it.nr)]) {
      const reopen = () =>
        renderIrMenu(ecu, ir, menuName, container, back, trail);
      // a persistent write always asks, whatever the setting says: the
      // confirm toggle exists to match INPA on actuator TESTS, which stop
      // when you leave the screen. An EEPROM write or a service reset does
      // not undo itself.
      const permanent = it.writeJob;
      if (confirmActuators() || permanent) {
        const ok = await confirmDialog({
          title: `${permanent ? 'Write to' : 'Activate on'} `
            + `${esc(ecu.label)}?`,
          body: `Runs <span class="mono">${esc(it.job)}</span> for `
            + `<b>${esc(it.label)}</b>.<br><br>`
            + (permanent
              ? 'This changes the ECU <b>permanently</b> — it is not an '
                + 'actuator test and does not undo itself when you leave.'
              : 'This drives a real component and stays as set until you '
                + 'change it back or leave this screen.'),
          confirmLabel: permanent ? 'Write' : 'Activate', danger: true,
        });
        if (!ok) { sbLeft.textContent = 'cancelled'; return; }
      }
      // INPA asks for a value first and builds the argument from it. We know
      // the prompts but not how the script assembles them into the argument
      // -- it concatenates several variables -- so sending the job without
      // that would command a position nobody chose.
      if (it.prompt) {
        container.className = 'results-panel';
        container.innerHTML = `<div class="empty"><div>`
          + `<strong>${esc(it.label)}</strong></div>`
          + `<div>INPA prompts for ${esc(it.prompt.join(' — '))} and builds `
          + `<code>${esc(it.job)}</code>'s argument from the answer. How it `
          + `assembles that argument is not decoded, so this is listed but `
          + `not sent.</div></div>`;
        sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · needs input`;
        setActions([...keys(), {
          key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
          fn: reopen,
        }]);
        return;
      }
      sbLeft.textContent = `${ecu.sgbd}.prg · ${it.job} · sending`;
      try {
        const out = await api(`/api/ecu/${ecu.sgbd}/run/${it.job}`,
                              { method: 'POST' });
        const r = flatResults(out.sets).map(([k, v]) => `${k}=${v}`)
          .slice(0, 3).join(' ') || 'sent';
        sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · ${it.job} · ${r}`;
      } catch (e) {
        sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · failed: ${e.message}`;
      }
      reopen();
      return;
    }
    if (it.inPlace && (ir.menus[menuName] || {}).composite) {
      // INPA sends on the keypress -- no sub-screen -- so this does the same.
      // The argument is INPA's own neutral word with this key's REQ/VAL pair
      // set; every other field keeps the value it already has, exactly as
      // INPA's menu state works.
      const reopen = () =>
        renderIrMenu(ecu, ir, menuName, container, back, trail);
      if (confirmActuators()) {
        const comp = ir.menus[menuName].composite;
        const n = Object.keys(comp.items || {}).length;
        const ok = await confirmDialog({
          title: `Activate ${esc(it.label).toLowerCase()}?`,
          body: `Runs <span class="mono">${esc(comp.job)}</span> on `
            + `<b>${esc(ecu.label)}</b> — one job carrying all `
            + `${comp.fields} fields, so it re-commands all ${n} actuators `
            + `at once.<br><br>This drives real components.`,
          confirmLabel: 'Activate', danger: true,
        });
        if (!ok) { sbLeft.textContent = 'cancelled'; return; }
      }
      await runComposite(ecu, ir, menuName, it, container, reopen);
      return;
    }
    if (it.inPlace) {
      // INPA runs this from the menu: each key sets its own REQ/VAL pair in
      // ONE argument string, and a single job re-commands every actuator on
      // the ECU at once. The pairing is decoded (comp.items) -- what is not
      // established is the neutral word: whether all-REQ-zero is a true
      // no-op. Until that is confirmed on a car, pressing one key would be
      // asserting a value for six actuators nobody chose.
      // reached only when this menu has NO decoded composite: INPA runs the
      // key in place but we cannot tell what it sends, so there is nothing
      // to fire and saying so beats guessing.
      container.className = 'results-panel';
      container.innerHTML = `<div class="empty"><div>`
        + `<strong>${esc(it.label)}</strong></div>`
        + `<div>INPA runs this from the menu itself. What it sends is not `
        + `decoded for this ECU, so it cannot be reproduced here.</div></div>`;
      sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · not decoded`;
      setActions([...keys(), {
        key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
        fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
      }]);
      return;
    }
    const scr = (ir.screens || {})[it.screen];
    const backAct = {
      key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
      fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
    };
    if (scr && irIsMemory(scr)) {
      const mined = (ecu._layout || {}).special;
      const mem = irMemoryScreen(scr, mined && mined.memory);
      const reopen = () =>
        renderIrMenu(ecu, ir, menuName, container, back, trail);
      if (mem && typeof showMemory === 'function') {
        showMemory(ecu, mem, container, reopen);
      } else {
        // INPA prints "Start address" and "Number" and reads what you type.
        // We have the job but no bounds, and inventing a range would be
        // presenting a guess as the ECU's own limit.
        container.className = 'results-panel';
        container.innerHTML = `<div class="empty"><div>`
          + `<strong>${esc(irLabel(scr.title) || it.label)}</strong></div>`
          + `<div>INPA reads a start address and a byte count, then prints `
          + `the bytes. The job is <code>`
          + `${esc((scr.jobs[0] || {}).name || 'SPEICHER_LESEN')}</code>, but `
          + `this ECU declares no address range, so there is nothing to `
          + `bound the read against.</div></div>`;
        setActions([...keys(), { key: 'Escape', keyLabel: 'Esc',
          label: 'Back', kind: 'back', fn: reopen }]);
      }
      sbLeft.textContent = `${ecu.sgbd}.prg · ${[...trail, it.label].join(' · ')}`;
      return;
    }
    // INPA's Information screen: script/SGBD facts, no ECU results
    if (scr && irIsInfo(scr, it.screen)) {
      renderIdentity(ecu, irInfoCard(scr), container, backAct);
      sbLeft.textContent = `${ecu.sgbd}.prg · ${[...trail, it.label].join(' · ')}`;
      return;
    }
    // labelled reads render as the ID-data card, the way the Info tab does
    if (scr && irIsCard(scr)) {
      renderIdentity(ecu, irAsCard(scr, await irDescs(ecu, scr)),
                     container, backAct);
      sbLeft.textContent = `${ecu.sgbd}.prg · ${[...trail, it.label].join(' · ')}`;
      return;
    }
    const screens = scr
      ? irRowsTranslated(scr, await irDescs(ecu, scr)) : [];
    if (screens.length) {
      showInpaCategory(ecu, screens, container, irLabel(scr.title) || it.label);
    } else {
      container.className = 'results-panel';
      container.innerHTML = `<div class="empty"><div>`
        + (scr && !irReadable(scr)
          ? `In INPA this entry performs an action, not a readout — it is not `
            + `offered here until verified on a car.`
          : `INPA lists this entry, but it has no readouts.`)
        + `</div></div>`;
    }
    sbLeft.textContent = `${ecu.sgbd}.prg · ${[...trail, it.label].join(' · ')}`;
    setActions([...keys(), {
      key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
      fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
    }]);
  };

  const keys = () => items.slice(0, FKEY_SLOTS).map((it, n) => ({
    key: String(n + 1), keyLabel: `F${it.nr}`, label: it.label,
    fn: () => open(it),
  }));

  const count = (it) => {
    // reflects the setting, not a property of the item: with actuator tests
    // enabled these DO run, so a fixed "not runnable" would be a lie. Once
    // running, the row shows its own armed state the way INPA's menu does.
    if (it.inPlace) {
      const comp = (ir.menus[menuName] || {}).composite;
      const pair = comp && comp.items && comp.items[String(it.nr)];
      const word = pair && compWord(ir, menuName);
      // the row shows its own armed state, the way INPA's menu does
      if (word) return word[pair[0]] === '1' ? 'ON' : 'off';
      // sends the assembled word without owning a field (RDC F8 "write data
      // into ECU"), or calls its own job (F18 Sleep -> SLEEP_MODE)
      if (comp && (comp.send || []).includes(String(it.nr))) return 'send';
      if (it.job) return 'run';
      // a fault-memory read names no job -- INPA reads through its own
      // library -- but open() hands it to the app's fault view, so it does
      // work and must not be labelled undecoded
      if (IR_FAULT_READ.test(it.label)) return 'read';
      return 'not decoded';
    }
    if (!it.menu && !it.screen) return '';
    const scr = (ir.screens || {})[it.screen];
    // a menu item counts its entries. open() opens the menu whatever screen
    // it also names, so counting that screen's rows described the wrong
    // thing -- and gave 0 for the screens that only host a menu.
    if (it.menu) {
      const k = irMenuItems(ir, it.menu).length;
      return k ? `${k} function${k === 1 ? '' : 's'}` : '';
    }
    if (!scr) return '';
    // Information reads no ECU results -- its rows are printed captions
    // paired with the SGBD's INFO job, so count those
    if (irIsInfo(scr, it.screen)) {
      const n = irInfoCard(scr).fields.length;
      return n ? `${n} field${n === 1 ? '' : 's'}` : '';
    }
    const n = irRows(scr).rows.length;
    return n ? `${n} value${n === 1 ? '' : 's'}` : '';
  };

  if (inpaMode()) {
    container.className = 'results-panel';
    container.innerHTML = `<div class="act-key-list" id="ir-list"></div>`;
    const list = container.querySelector('#ir-list');
    items.forEach((it) => {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row';
      row.innerHTML = `<span class="inpa-fn-key">&lt; F${it.nr} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(it.label)}</span>`
        + `<span class="act-key-val">${esc(count(it))}</span>`
        + `<span class="ir-enter">${it.menu ? '&#8629;' : ''}</span>`;
      row.onclick = () => open(it);
      list.appendChild(row);
    });
  } else {
    container.className = 'group-grid stagger';
    container.innerHTML = '';
    items.forEach((it) => {
      const tile = document.createElement('div');
      tile.className = 'group-tile';
      tile.innerHTML = `
        <div class="group-name">${esc(it.label)}</div>
        <div class="group-count">${esc(count(it))}</div>
        <div class="group-arrow">→</div>`;
      tile.onclick = () => open(it);
      container.appendChild(tile);
    });
    stagger(container, 30);
  }

  setActions([...keys(), {
    key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: back,
  }]);
  return true;
}

// The ECU's own root menu, rendered as INPA draws it.
//
// There is deliberately NO table mapping INPA's labels to app sections. That
// approach needs a regex per label per language, silently drops every key
// nobody anticipated, and made "Information" and "Read status" collide when
// two keys happened to map to one section. The IR already holds INPA's root
// menu with its real F-key numbers and targets, so the general answer is to
// render that and let each key open whatever it opens -- exactly what
// renderIrMenu already does for every nested menu.
//
// The only judgement left is presentation, and that is decided by the decoded
// screen (irIsCard: all-value rows are a labelled read, anything with a gauge
// or lamp is a live panel), not by what the key is called.
function irRootMenu(ir) {
  const name = (ir.entry || {}).menu;
  const root = (ir.menus || {})[name];
  if (!root) return null;
  const items = irMenuItems(ir, name);
  return items.length ? name : null;
}
