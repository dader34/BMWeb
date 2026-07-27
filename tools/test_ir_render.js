// Guard: the IR interpreter (app/renderer/ir.js) renders known screens right.
//
// Every assertion was a live defect while building it:
//   - "[rpm]" printed above a gauge is its UNIT, not its caption
//   - one caption over several unrelated keys is a LOOP heading and must not
//     be pasted onto all of them (RDC printed "Position RR" on three rows)
//   - a per-iteration caption ("(1)", "??") loses to the SGBD description
//   - write-shaped jobs never become pollable screens
//   - a write entry duplicating a read entry's screen is dropped
//
//   node tools/test_ir_render.js
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

const lang = () => 'en';
eval(fs.readFileSync(path.join(R, 'app/renderer/translate.js'), 'utf8'));
const inpaMode = () => true, esc = (s) => s, stagger = () => {}, FKEY_SLOTS = 9;
const api = async () => { throw new Error('offline'); };   // descs unavailable
// `const` declarations inside eval() are not visible to this scope, so the
// few the guard asserts on are exposed deliberately. Copying their patterns
// here instead would test a copy, not the code -- which is exactly how the
// last mislabelling survived a passing run.
let _irSrc = fs.readFileSync(path.join(R, 'app/renderer/ir.js'), 'utf8');
_irSrc = _irSrc.replace('const IR_FAULT_READ =', 'globalThis.IR_FAULT_READ =')
               .replace('const IR_FILE_ACTION =', 'globalThis.IR_FILE_ACTION =');
eval(_irSrc);

// Navigate the way the app now does: from the ECU's own root menu, by the
// label INPA prints. No section table -- these look up a key the same way a
// user would read it off the screen.
function rootKey(ir, re) {
  const root = irRootMenu(ir);
  return root ? irMenuItems(ir, root).find(i => re.test(i.label)) : null;
}
function keyMenu(ir, re) { const i = rootKey(ir, re); return i && i.menu; }
function keyScreen(ir, re) {
  const i = rootKey(ir, re);
  return i && !i.menu && i.screen ? (ir.screens || {})[i.screen] : null;
}

const load = (e) => JSON.parse(
  fs.readFileSync(path.join(R, 'data/inpa-ir', e + '.json'), 'utf8'));
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

// ---- GSDS2: eight distinct pages, right kinds, units not captions ---------
const g = load('GSDS2');
const gm = keyMenu(g, /^(Status|Read status)$/i);
ok(gm === 'm_status', `GSDS2 status menu resolved to ${gm}`);
const gItems = irMenuItems(g, gm);
ok(gItems.length >= 8, `GSDS2 expected >=8 status pages, got ${gItems.length}`);

const sigs = new Set();
for (const it of gItems) {
  const scr = g.screens[it.screen];
  if (!scr) continue;
  const { rows } = irRows(scr);
  if (rows.length) sigs.add(rows.map(r => r.key).join(','));
}
ok(sigs.size >= 7,
   `GSDS2 pages should differ; only ${sigs.size} distinct row sets`);

const ana = irRows(g.screens['s_analog_1']).rows;
ok(ana.length > 0 && ana.every(r => r.kind === 'gauge'),
   'GSDS2 s_analog_1 should be all gauges');
ok(ana.every(r => !/^\[.*\]$/.test(String(r.label || ''))),
   'a "[unit]" caption leaked into a label on s_analog_1');
ok(ana.some(r => r.unit),
   'GSDS2 s_analog_1 gauges lost their units');
ok(ana.every(r => r.min === undefined || r.max > r.min),
   'GSDS2 s_analog_1 has an inverted gauge range');

const sw = irRows(g.screens['s_schalter']).rows;
ok(sw.length && sw.every(r => r.kind === 'lamp' && r.on && r.off),
   'GSDS2 s_schalter should be lamps with on/off text');

// ---- RDC: loop captions suppressed, writes handled ------------------------
const r = load('RDC');
const rm = keyMenu(r, /^(Status|Read status)$/i);
ok(rm === 'm_rdc_status', `RDC status menu resolved to ${rm}`);
const rItems = irMenuItems(r, rm);
ok(!rItems.some(i => /write/i.test(i.label)),
   'RDC "MV write" duplicates the read screen and should be dropped');

const wheel = irRows(r.screens['s_rad_io']).rows;
const dupLabels = wheel.filter(x => x.label)
  .filter((x, _i, a) => a.filter(y => y.label === x.label).length > 1);
ok(dupLabels.length === 0,
   `RDC loop caption pasted onto ${dupLabels.length} rows`);

// no screen may poll a write job
for (const [name, scr] of Object.entries(r.screens)) {
  for (const s of irScreens(scr)) {
    const j = (scr.jobs || []).find(x => x.name === s.job);
    ok(j && !j.write, `RDC ${name} would poll write job ${s.job}`);
  }
}

// ---- actuator menus: captions joined from the screen's softkey help -------
// INPA's actuator ITEMs carry only fragments ("DWA", "button") and flip state
// flags; the real caption is printed on the screen as "< F2 >  DWA output"
// and joins back by F-number. Without that join the section showed one
// unlabeled row.
const ract = keyMenu(r, /^(Activate|Ansteuern)$/i);
ok(ract === 'm_steuern', `RDC activations menu resolved to ${ract}`);
const rActs = irMenuItems(r, ract);
ok(rActs.length >= 8,
   `RDC should list >=8 actuator functions, got ${rActs.length}`);
ok(rActs.some(i => /DWA output/i.test(i.label)),
   'RDC actuator captions did not join from the screen softkeys');
ok(rActs.every(i => !/^(DWA|button|plant)$/i.test(i.label)),
   'an actuator item kept its fragment label instead of the softkey caption');
// nothing in-place may ever be runnable
ok(rActs.filter(i => i.inPlace).every(i => !i.screen && !i.menu),
   'an in-place actuator item claims a target');

// ---- labelled rows: caption, not the ":" separator ------------------------
// INPA lays a labelled row out as three prints -- caption at col 0, a bare
// ":" at a fixed column, then the value. "Nearest preceding text" took the
// separator, so every RDC coding row was labelled ":".
const cod = keyScreen(r, /^Cod(e|ing)$/i);
ok(cod && cod.title === 'RDC coding',
   `RDC Coding screen not found: ${cod && cod.title}`);
const codRows = cod ? irRows(cod).rows : [];
ok(codRows.length === 5, `RDC coding should have 5 rows, got ${codRows.length}`);
ok(codRows.some(x => x.label === 'Number antennas'),
   'RDC coding lost its real captions');
ok(codRows.every(x => x.kind === 'value'),
   'RDC coding rows must stay text values, not gauges');
// a screen of labelled reads renders as the ID-data card, like the Info tab
ok(cod && irIsCard(cod), 'RDC coding should render as a card, not a gauge grid');
const codCard = cod && irAsCard(cod, new Map());
ok(codCard && codCard.jobs.length === 1
   && codCard.jobs[0] === 'CODIERUNG_LESEN',
   `RDC coding card job wrong: ${codCard && codCard.jobs}`);
ok(codCard && codCard.fields.every(f => f.label && f.label !== f.key),
   'RDC coding card has unlabelled fields');
// a gauge screen must NOT be treated as a card
ok(!irIsCard(g.screens['s_analog_1']),
   'GSDS2 s_analog_1 is gauges and must not render as a card');

// ---- root menu lists ECU functions, not INPA's own tools -----------------
// RDC F11 "Change" runs kvp_edit and F15 "Extra" loads another .IPO; neither
// touches the car. Detected from what the item does (a scriptchange call or a
// script path), never from its label.
const rRoot = irMenuItems(r, irRootMenu(r));
ok(!rRoot.some(i => /^(Change|Extra)$/i.test(i.label)),
   'RDC root menu still lists INPA app tools');
ok(rRoot.length === 7,
   `RDC root should list INPA's 7 ECU keys, got ${rRoot.length}`);
const dRoot = irMenuItems(load('DWS'), irRootMenu(load('DWS')));
ok(!dRoot.some(i => /^Extra$/i.test(i.label)),
   'DWS "Extra" (bare-name scriptchange) still listed');

// ---- fault menu: real entries, jobs preserved, file actions dropped -------
// "store" is BMW_STD.SRC's "FS speichern" -- it writes the fault list to a
// file, like Print, and names no job. "Clear" DOES name FS_LOESCHEN, and
// irMenuItems was dropping `job`, which made every self-running key inert.
const errIt = rootKey(r, /^(Error|Fehler)/i);
ok(errIt && errIt.menu, 'RDC Error key lost its menu');
const errItems = irMenuItems(r, errIt.menu);
ok(!errItems.some(i => /^store$/i.test(i.label)),
   'fault menu still lists the file-save action');
const clear = errItems.find(i => /^Clear$/i.test(i.label));
ok(clear && clear.job === 'FS_LOESCHEN',
   `Clear must carry FS_LOESCHEN, got ${clear && clear.job}`);
// reading faults is INPA library code (INPAapiFsLesen_neu), so the item names
// no job and the app's own fault view handles it
const read = errItems.find(i => /^(Read|FS lesen|Lesen)$/i.test(i.label));
ok(read && !read.job, 'fault Read should have no job of its own');

// ---- setitem captions: INPA names its keys at runtime --------------------
// SZL's fault menu declares all twelve entries with setitem() in the INIT
// block ("Read EM", "Clear IM", "Read HM" ...) while every ITEM's inline
// label is empty. Without decoding setitem the menu showed blank rows, and
// the info and history memories were invisible.
const szl = load('SZL');
const szlErr = rootKey(szl, /^(Error|Fehler)/i);
ok(szlErr && szlErr.menu, 'SZL Error key lost its menu');
const szlItems = irMenuItems(szl, szlErr.menu);
ok(szlItems.every(i => i.label && i.label.trim()),
   'SZL fault menu still has blank captions');
// captions are expanded for display (INPA_CAPTIONS), so assert on what the
// user sees, not on the abbreviation
for (const [cap, job] of [['Read fault memory', null],
                          ['Clear fault memory', 'FS_LOESCHEN'],
                          ['Read info memory', null],
                          ['Clear info memory', 'IS_LOESCHEN'],
                          ['Read history memory', null],
                          ['Clear history memory', 'HS_LOESCHEN']]) {
  const e = szlItems.find(i => i.label === cap);
  ok(e, `SZL fault menu missing "${cap}"`);
  if (e && job) ok(e.job === job, `SZL "${cap}" job: ${e.job}`);
}
// Word order varies by build and so does the wording: "Read EM", "EM Read",
// "FS lesen", "Shadow" (the info memory under another name -- TOENS labels
// F3 that way and answers IS_LESEN). All are fault reads and none may be
// labelled "not decoded", since open() hands them to the fault view.
for (const cap of ['Read', 'Read EM', 'EM Read', 'FS Read', 'IS Read',
                   'HS Read', 'FS lesen', 'Lesen', 'Shadow']) {
  ok(IR_FAULT_READ.test(cap), `"${cap}" not recognised as a fault read`);
}
for (const cap of ['Clear', 'Print', 'on', 'off', 'Stop', 'EV 1', 'Activate']) {
  ok(!IR_FAULT_READ.test(cap), `"${cap}" wrongly treated as a fault read`);
}

// the caption picks the memory: "Read IM" must read IS_LESEN, not FS_LESEN
const FJ = [[/\b(IM|IS)\b/i, 'IS_LESEN'], [/\b(HM|HS)\b/i, 'HS_LESEN'],
            [/\b(EM|FS)\b/i, 'FS_LESEN']];
const fj = (l) => (FJ.find(([re]) => re.test(l)) || [null, 'FS_LESEN'])[1];
ok(fj('Read IM') === 'IS_LESEN' && fj('Read HM') === 'HS_LESEN'
   && fj('Read EM') === 'FS_LESEN' && fj('Read') === 'FS_LESEN',
   'fault-memory caption -> job mapping wrong');
// print/save are file actions, like store
ok(!szlItems.some(i => /^(Print|Save) (EM|IM|HM)$/i.test(i.label)),
   'SZL fault menu still lists print/save file actions');

// ---- per-position screens read once per argument --------------------------
// RDC's "matching values" calls ABGLEICHWERT_LESEN with "1".."5", once per
// wheel, so the SAME eight result keys appear five times. Without the job
// argument the screen showed 40 rows all sharing one read -- five identical
// blocks. Each pass must poll separately and carry its position.
const mv = r.screens['s_abgleichwert_lesen'];
const mvJobs = (mv.jobs || []).filter(j => !j.write);
ok(mvJobs.length === 5 && mvJobs.every(j => j.arg),
   `RDC matching values should read 5 arguments, got ${mvJobs.length}`);
const mvScreens = irScreens(mv);
ok(mvScreens.length === 5,
   `per-wheel screen should poll 5 times, got ${mvScreens.length}`);
ok(mvScreens.every(s => s.rows.length === 8),
   `each wheel should carry its own 8 rows: ${mvScreens.map(s => s.rows.length)}`);
ok(new Set(mvScreens.map(s => s.args)).size === 5,
   'per-wheel polls must use distinct job arguments');
ok(!irIsCard(mv),
   'a per-position screen must not collapse onto one card keyed by result name');

// ---- a key with BOTH a menu and a screen opens the menu -------------------
// INPA's root keys set the screen and the softkey menu together (Status ->
// s_status + m_rdc_status). s_status is only the window the menu is drawn in
// and has no rows, so checking the screen first sent Status and Activate to
// the "performs an action, not a readout" message instead of their submenus.
for (const label of [/^Status$/i, /^Activate$/i]) {
  const it = rootKey(r, label);
  ok(it && it.menu, `RDC ${label} lost its menu`);
  ok(it && irMenuItems(r, it.menu).length > 0,
     `RDC ${label} menu is empty`);
  // the screen it also names must be a menu holder, not a readout
  const holder = it && it.screen ? r.screens[it.screen] : null;
  ok(!holder || irRows(holder).rows.length === 0,
     `RDC ${label} screen unexpectedly has rows`);
}

// ---- Information: script facts, not an empty screen ----------------------
// s_info reads no ECU results -- INPA prints captions and fills them from
// script variables -- so it rendered blank. Paired with the SGBD's INFO job.
const info = r.screens['s_info'];
ok(irIsInfo(info, 's_info'), 'RDC s_info should be recognised as the Information screen');
ok(!irIsInfo(r.screens['s_status'], 's_status'),
   'a screen that only hosts a menu must not be read as Information');
ok(!irIsCard(info), 's_info has no result rows and must not be a value card');
const infoCard = irInfoCard(info);
ok(infoCard.fields.length >= 5 && infoCard.jobs[0] === 'INFO',
   `RDC info card wrong: ${infoCard.fields.length} fields, ${infoCard.jobs}`);
ok(infoCard.fields[0].label === 'Rework program',
   `info card first caption: ${infoCard.fields[0].label}`);

// no row anywhere may be labelled with punctuation
let punct = 0;
for (const f of fs.readdirSync(path.join(R, 'data/inpa-ir'))) {
  const ir2 = JSON.parse(fs.readFileSync(path.join(R, 'data/inpa-ir', f), 'utf8'));
  for (const s of Object.values(ir2.screens || {}))
    for (const x of irRows(s).rows)
      if (/^[:=|-]+$/.test(String(x.label || '').trim())) punct++;
}
ok(punct === 0, `${punct} rows labelled with a separator instead of a caption`);

// ---- KLIMA_5B: the second digitalout opcode, writes, and prompts ---------
// 0x4b is digitalout(var,row,col,on,off) -- 990 sites, the COMMON form --
// but only 0x4d was mapped, so IHKA's I/O status decoded twelve captions and
// zero values. This is the assertion that would have caught it.
const kl = load('KLIMA_5B');
const io = kl.screens['s_eingaenge_ihka38_ihka38_2_ihka38_3'];
const ioRows = irRows(io).rows;
ok(ioRows.length === 12, `IHKA I/O status should have 12 rows, got ${ioRows.length}`);
ok(ioRows.every(x => x.kind === 'lamp' && x.on && x.off),
   'IHKA I/O status rows should all be lamps with on/off text');

// a job that changes the ECU permanently must be flagged, but STEUERN_* --
// the actuator mechanism itself -- must NOT be, or every activation dies
let permanent = 0, actuators = 0;
for (const m of Object.values(kl.menus || {})) {
  for (const i of m.items || []) {
    if (!i.job) continue;
    if (i.writeJob) permanent++;
    if (/^STEUERN_/.test(i.job) && !/EEPROM|SCHREIBEN/i.test(i.job)) {
      actuators++;
      ok(!i.writeJob, `actuator ${i.job} wrongly flagged as a write`);
    }
  }
}
ok(permanent > 0, 'IHKA EEPROM_SCHREIBEN not flagged as a persistent write');
ok(actuators > 10, `IHKA should keep its actuators runnable, got ${actuators}`);

// nine flap positions call ONE job but each prompts for its own value
const flaps = Object.values(kl.menus || {})
  .flatMap(m => (m.items || []))
  .filter(i => i.job === 'STEUERN_MOTOR_KLAPPENPOSITION' && i.prompt);
ok(flaps.length >= 5,
   `IHKA flap positions should carry their prompts, got ${flaps.length}`);
ok(flaps.every(i => i.prompt.some(p => /%/.test(p))),
   'a flap prompt lost its range');

// ---- corpus: the interpreter must not throw on any ECU --------------------
let files = fs.readdirSync(path.join(R, 'data/inpa-ir')).filter(f => f.endsWith('.json'));
let screens = 0, rows = 0, broke = 0;
for (const f of files) {
  try {
    const ir = JSON.parse(fs.readFileSync(path.join(R, 'data/inpa-ir', f), 'utf8'));
    for (const scr of Object.values(ir.screens || {})) {
      screens++;
      rows += irRows(scr).rows.length;
    }
    for (const m of Object.keys(ir.menus || {})) irMenuItems(ir, m);
  } catch (e) { broke++; }
}
ok(broke === 0, `interpreter threw on ${broke} ECUs`);
ok(rows > 20000, `corpus rows regressed: ${rows}`);

// Coverage: how many ECUs the app can drive straight from their own root
// menu. This is the number the label->section table used to cap -- it served
// 161 ECUs because only three labels were mapped, and every unmapped key
// ("Info", "Ident", "Memory", "KVP", anything German) was invisible.
let rooted = 0;
for (const f of files) {
  const ir = JSON.parse(fs.readFileSync(path.join(R, 'data/inpa-ir', f), 'utf8'));
  if (irRootMenu(ir)) rooted++;
}
ok(rooted > 450, `ECUs drivable from their own root menu regressed: ${rooted}`);
console.log(`  ir-render  ${rooted}/${files.length} ECUs drive from their own `
  + `root menu (no label mapping)`);

console.log(`  ir-render  GSDS2 ${gItems.length} pages / ${sigs.size} distinct, `
  + `RDC ${rItems.length} pages`);
console.log(`  ir-render  corpus ${files.length} ECUs, ${screens} screens, `
  + `${rows} rows, ${broke} errors`);
if (fails.length) {
  console.log('\nFAIL');
  for (const f of fails) console.log('   -', f);
  process.exit(1);
}
console.log('\nOK');
