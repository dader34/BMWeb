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
_irSrc = _irSrc.replace('function irMenuFitsVariant', 'globalThis.irMenuFitsVariant = irMenuFitsVariant; function irMenuFitsVariant')
               .replace('const IR_FAULT_READ =', 'globalThis.IR_FAULT_READ =')
               .replace('const IR_FILE_ACTION =', 'globalThis.IR_FILE_ACTION =')
               .replace('function irSameBar', 'globalThis.irSameBar = irSameBar; function irSameBar')
               .replace('function _irHasRunnable', 'globalThis._irHasRunnable = _irHasRunnable; function _irHasRunnable')
               .replace('function irOpensMenu', 'globalThis.irOpensMenu = irOpensMenu; function irOpensMenu');
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

// ---- the bar a key keeps is not a submenu ---------------------------------
// INPA keeps the softkey bar and swaps the SCREEN: KOMBI's Info, Ident and
// Coding all install m_info_ident_code_..., which selects the SAME screen per
// key as the root. Opening it re-lists the root one level down and never shows
// the screen the key selects. Compared by TARGET, not caption -- an item takes
// the screen's softkey help when that says more, so the root can read
// "Coding" where the bar it installs still reads "Code", and comparing
// captions stopped recognising the bar the moment those captions expanded.
{
  const kbb = load('KOMBI');
  kbb._variant = 'KOMBI46';
  const rootB = irRootMenu(kbb, 'KOMBI46');
  const bar = 'm_info_ident_code_36_38_39_46_52_85';
  ok(irSameBar(kbb, bar, rootB),
     'KOMBI Coding/Ident install the root bar, not a submenu');
  for (const [re, want] of [[/^Cod(e|ing)$/i, 's_code_46'],
                            [/^Ident/i, 's_ident_36_38_39_46_52_85']]) {
    const it = irMenuItems(kbb, rootB, 'KOMBI46').find(i => re.test(i.label));
    ok(it && (!it.menu || irSameBar(kbb, it.menu, rootB)),
       `KOMBI46 ${it && it.label} should open its screen, not the bar again`);
    ok(it && it.screen === want,
       `KOMBI46 ${it && it.label} screen: ${it && it.screen}`);
  }
  // a REAL submenu still opens: Activate/Status/Memory list their own keys
  for (const re of [/^Activate\b/i, /^(Read )?Status$/i, /^Read memory$/i]) {
    const it = irMenuItems(kbb, rootB, 'KOMBI46').find(i => re.test(i.label));
    ok(it && it.menu && !irSameBar(kbb, it.menu, rootB),
       `KOMBI46 ${it && it.label} lost its real submenu`);
  }
}

// ---- the NARROWED bar a page installs is not a submenu either -------------
// While a status page is up INPA installs a shorter bar (m_status_sub_38_39:
// just Analog and Digital) whose keys select the SAME screens as the menu
// above it. Its parent keeps five keys parked on the family placeholder --
// pages this variant does not have -- and counting those made two bars with
// identical real keys look 50% alike, so Analog and Digital each re-listed
// the menu and only opened the page on a second press.
{
  const kbs = load('KOMBI');
  kbs._variant = 'KOMBI46';
  ok(irSameBar(kbs, 'm_status_sub_38_39', 'm_status_38_39'),
     'a narrowed page bar must not count as a submenu');
  ok(irSameBar(kbs, 'm_status_sub_46', 'm_status_46'),
     'KOMBI46 narrowed status bar must not count as a submenu');
  // real submenus still are ones
  const rootS = irRootMenu(kbs, 'KOMBI46');
  for (const m of ['m_status_46', 'm_steuern_46', 'm_fehler']) {
    ok(!irSameBar(kbs, m, rootS), `${m} is a real submenu of the root`);
  }
  // every status page opens a screen, not the menu again
  const st = irMenuItems(kbs, rootS, 'KOMBI46')
    .find(i => /^(Read )?Status$/i.test(i.label));
  const pages = irMenuItems(kbs, st.menu, 'KOMBI46');
  ok(pages.length >= 5, `KOMBI46 status should list its pages, got ${pages.length}`);
  ok(pages.every(p => !p.menu || irSameBar(kbs, p.menu, st.menu)),
     'a status page still opens a menu instead of its screen');
}

// ---- a menu with nothing runnable loses to the screen ---------------------
// LWS5's Coding key installs m_code AND names s_code. m_code's only entry
// launches sm_Codier_Datei, a state machine whose whole body is "prompt for a
// path, open it 'w', write the coding data" -- INPA ships no coding readout
// for that ECU, so the key opened a one-item menu that could not run. The
// screen it also names holds the seven data blocks and the checksum.
{
  const lw2 = load('LWS5');
  const cod = lw2.menus.m_code.items.find(i => i.nr === 1);
  ok(cod && cod.fileAction,
     'LWS5 Coding key writes a .COD file and must be flagged');
  ok(!_irHasRunnable(lw2, 'm_code'),
     'm_code holds nothing runnable once the file action is flagged');
  const rootC = irRootMenu(lw2);
  const key = irMenuItems(lw2, rootC).find(i => /^Cod(e|ing)$/i.test(i.label));
  ok(key && key.screen === 's_code',
     `LWS5 Coding should name s_code, got ${key && key.screen}`);
  const rows = irRows(lw2.screens.s_code).rows;
  ok(rows.length === 8, `LWS5 coding should show 8 rows, got ${rows.length}`);
  ok(rows.filter(r => r.key === 'COD_DATEN').length === 7,
     'LWS5 coding lost its seven data blocks');
  // real submenus must still open
  ok(_irHasRunnable(lw2, 'm_status') && _irHasRunnable(lw2, 'm_fehler'),
     'a real LWS5 submenu was judged empty');
}

// ---- a file PICKER is half a real function, not a log dump ---------------
// LWS5's "Write Coding Data" is a real menu: F1 prompts for a .COD file and
// shows what you chose, F2 sends it with CODIERUNG_SCHREIBEN_DATEI. Flagging
// F1 as a file action (it does call the show-file builtin) emptied the menu,
// so the key fell through to a screen with nothing on it. A key that PROMPTS
// is a picker. And F2's job lives inside a state machine, which is the only
// evidence of what the key does -- surfaced, flagged write, and never sent,
// because how INPA assembles the argument from the picked file is not decoded.
{
  const lw3 = load('LWS5');
  const cs = lw3.menus.m_cod_schreiben.items;
  const pick = cs.find(i => i.nr === 1);
  ok(pick && !pick.fileAction && pick.prompt,
     'the .COD file picker must not be flagged a file action');
  const send = cs.find(i => i.nr === 2);
  ok(send && send.job === 'CODIERUNG_SCHREIBEN_DATEI',
     `coding write should carry its state job, got ${send && send.job}`);
  ok(send && send.writeJob && send.stateJob,
     'a state-machine EEPROM write must be flagged write AND state-sourced');
  // the ident write is the same shape
  const idw = lw3.menus.m_id_schreiben.items.find(i => i.nr === 8);
  ok(idw && idw.job === 'IDENT_SCHREIBEN' && idw.stateJob && idw.writeJob,
     `ident write not surfaced: ${idw && idw.job}`);
  // so the key opens its MENU again, rather than an empty screen
  const ex = irMenuItems(lw3, 'm_entwickler_5_0');
  const wc = ex.find(i => /^Write Coding Data$/i.test(i.label));
  ok(wc && irOpensMenu(lw3, wc, 'm_entwickler_5_0'),
     'Write Coding Data should open its menu');
  // ...while a key whose menu really is chrome-only opens its screen
  const ird = ex.find(i => /^Ident reading$/i.test(i.label));
  ok(ird && !irOpensMenu(lw3, ird, 'm_entwickler_5_0')
     && ird.screen === 's_ident_e',
     'Ident reading should open s_ident_e, not its chrome-only menu');
  ok(irRows(lw3.screens.s_ident_e).rows.length === 9,
     'LWS5 ident screen lost its fields');
}

// ---- a labelled per-pass read is still a card ----------------------------
// LWS5's coding page calls CODIERUNG_LESEN once per block and labels each
// "Data Block 0..6". Those rows carry a job ARGUMENT, which the per-position
// guard (written for RDC's wheels, where the same key repeats with no
// distinguishing caption) rejected -- so a list of eight labelled reads
// rendered as a gauge grid instead of the ident-style card. Distinct captions
// make it a card again, and each field must then be read in its own pass or
// all seven blocks show whatever the last one returned.
{
  const lw4 = load('LWS5');
  const cod2 = lw4.screens.s_code;
  ok(irIsCard(cod2), 'LWS5 coding should render as a card');
  const card = irAsCard(cod2, new Map());
  ok(card.fields.length === 8, `coding card should have 8 fields, got ${card.fields.length}`);
  const blocks = card.fields.filter(f => f.arg != null);
  ok(blocks.length === 7, `expected 7 per-pass blocks, got ${blocks.length}`);
  ok(blocks.every(f => f.job === 'CODIERUNG_LESEN'),
     'a per-pass field must name the job that reads it');
  ok(new Set(blocks.map(f => f.arg)).size === 7,
     'the seven blocks must read seven distinct arguments');
  // the argument-carrying job must NOT also be read argument-less, or each
  // block would be read twice and only the last kept
  ok(!card.jobs.includes('CODIERUNG_LESEN'),
     'a per-pass job must not also be in the card-level job list');
  ok(card.jobs.includes('CODIERUNG_CHECK'),
     'the checksum job reads normally and must stay');
  // RDC reads the same 8 keys once per wheel -- 40 rows, 8 distinct keys, the
  // caption repeating each pass. Those must stay on the poller, which reads
  // each argument separately, or a card would show the last wheel five times.
  const rdcW = load('RDC').screens.s_abgleichwert_lesen;
  ok(!irIsCard(rdcW), 'a per-wheel screen must stay on the poller');
  ok(irRows(rdcW).rows.length === 40,
     `RDC per-wheel screen changed shape: ${irRows(rdcW).rows.length} rows`);
}

// ---- a PC file operation is not an ECU function --------------------------
// LWS5's fault menu offers "Read protocol file" and "Delete Protocol file":
// the first displays na_fs_pr.tmp, the second reopens it "w" to truncate it.
// Neither touches the car, and no caption pattern would catch them -- the
// emitter flags them from the bytecode (builtins 5c/79) instead. It must not
// swallow a key that ALSO reads the ECU: LWS5's own "Read"/"Clear" write that
// same log after their job, and a fault read is INPA's library doing exactly
// this (it writes na_fs.tmp and shows it) while being a real function.
{
  const lw = load('LWS5');
  const fm = lw.menus.m_fehler.items;
  const byNr = (n) => fm.find(i => i.nr === n) || {};
  ok(byNr(1).job === 'ABGLEICH_LESEN' && !byNr(1).fileAction,
     'LWS5 F1 reads the ECU and must not be flagged a file action');
  ok(byNr(2).job === 'FS_LOESCHEN' && !byNr(2).fileAction,
     'LWS5 F2 clears the ECU and must not be flagged a file action');
  for (const n of [3, 4]) {
    ok(byNr(n).fileAction, `LWS5 F${n} is a protocol-file action`);
  }
  const shown = irMenuItems(lw, 'm_fehler').map(i => i.label);
  ok(!shown.some(l => /protocol file/i.test(l)),
     `a protocol-file action is still listed: ${shown}`);
  ok(shown.some(l => /^Read error memory$/i.test(l))
     && shown.some(l => /^Clear error memory$/i.test(l)),
     `LWS5 lost a real fault key: ${shown}`);
  // fault reads route through INPA's own library and look like file I/O; RDC
  // and SZL must keep theirs
  for (const e of ['RDC', 'SZL']) {
    const ir2 = load(e);
    const err = rootKey(ir2, /^(Error|Fehler)/i);
    const items = irMenuItems(ir2, err.menu).map(i => i.label);
    ok(items.some(l => IR_FAULT_READ.test(l)),
       `${e} lost its fault read to the file-action filter: ${items}`);
  }
}

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
// A menu item takes the screen's own softkey help when that says more, so
// match on meaning rather than INPA's shortest wording.
const clear = errItems.find(i => /^(Clear|Delete)\b/i.test(i.label));
ok(clear && clear.job === 'FS_LOESCHEN',
   `Clear must carry FS_LOESCHEN, got ${clear && clear.job}`);
// reading faults is INPA library code (INPAapiFsLesen_neu), so the item names
// no job and the app's own fault view handles it
const read = errItems.find(i => /^(Read|FS lesen|Lesen)\b/i.test(i.label));
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
// Wording depends on whether the screen printed longer softkey help ("Read
// error memory") or only the setitem abbreviation ("Read EM"), so match the
// memory and the verb, and assert the JOB -- which is what actually runs.
for (const [what, verb, mem, job] of [
    ['fault read', /^(Read|Lesen)/i, /\b(EM|FS|error|fault)\b/i, null],
    ['fault clear', /^(Clear|Delete)/i, /\b(EM|FS|error|fault)\b/i, 'FS_LOESCHEN'],
    ['info read', /^(Read|Lesen)/i, /\b(IM|IS|info)/i, null],
    ['info clear', /^(Clear|Delete)/i, /\b(IM|IS|info)/i, 'IS_LOESCHEN'],
    ['history read', /^(Read|Lesen)/i, /\b(HM|HS|history)/i, null],
    ['history clear', /^(Clear|Delete)/i, /\b(HM|HS|history)/i, 'HS_LOESCHEN']]) {
  const e = szlItems.find(i => verb.test(i.label) && mem.test(i.label));
  ok(e, `SZL fault menu missing ${what}`);
  if (e && job) ok(e.job === job, `SZL ${what} job: ${e.job}`);
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

// A screen with several jobs becomes one poll PER JOB, each carrying the whole
// row list (every job answers its own subset). The value count is therefore
// the DISTINCT rows -- summing per poll reported KOMBI's 7-job, 18-row CAN
// page as "126 values" and its 3-job Analog page as 30.
{
  const kbc = load('KOMBI');
  for (const [name, jobs, rows] of [['s_status_can_36C_38_39C_46', 7, 18],
                                    ['s_status_analog_46', 3, 10],
                                    ['s_status_toens_io_46', 2, 5]]) {
    const polls = irScreens(kbc.screens[name]);
    ok(polls.length === jobs,
       `${name} should poll ${jobs} jobs, got ${polls.length}`);
    const distinct = new Set(polls.flatMap(
      p => p.rows.map(r => `${r.key}:${r.arg || ''}`))).size;
    ok(distinct === rows,
       `${name} should show ${rows} values, got ${distinct}`);
  }
}

// ---- a key with BOTH a menu and a screen opens the menu -------------------
// INPA's root keys set the screen and the softkey menu together (Status ->
// s_status + m_rdc_status). s_status is only the window the menu is drawn in
// and has no rows, so checking the screen first sent Status and Activate to
// the "performs an action, not a readout" message instead of their submenus.
for (const label of [/^(Read )?Status$/i, /^Activate\b/i]) {
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

// ---- variant roots: INPA asks the ECU, and so do we ----------------------
// KOMBI ships two root menus and inpainit picks between them by running
// INITIALISIERUNG and matching its VARIANTE result. Taking the first declared
// gave an E46 the E31/E32/E34 root, which has no Status or Memory key.
const kb = load('KOMBI');
ok(kb.variantJob === 'INITIALISIERUNG' && kb.variantKey === 'VARIANTE',
   `KOMBI variant probe wrong: ${kb.variantJob}/${kb.variantKey}`);
ok(Object.keys(kb.rootVariants || {}).length === 2,
   'KOMBI should declare two root menus');
ok((kb.rootVariants['m_main_36_38_39_46_52_85'] || []).includes('KOMBI46'),
   'KOMBI46 not listed against the E36..E85 root');
ok(irRootMenu(kb, 'KOMBI46') === 'm_main_36_38_39_46_52_85',
   'an E46 cluster must get the root that has Status and Memory');
ok(irRootMenu(kb, 'KOMBI31') === 'm_main_31_32_34',
   'an E31 cluster must get its own root');
// with no answer, prefer the widest root rather than the first declared
ok(irMenuItems(kb, irRootMenu(kb)).some(i => /^(Read )?Status$/i.test(i.label)),
   'the default root must not be the one missing Status');
// variant names are names, not result keys picked up from a nearby compare
for (const list of Object.values(kb.rootVariants || {})) {
  ok(!list.some(v => /^STAT_|_EIN$/.test(v)),
     `a result key leaked into KOMBI's variant list: ${list}`);
}

// ---- variant SCREENS, not just variant roots -----------------------------
// An item can name several screens, one per chassis: KOMBI's Code key lists
// s_code_36_38_39_52 first but also s_code_46, which has 37 rows against the
// first's 13. Its Status key installs m_status_38_39, an E38/E39 menu whose
// pages are all _38 screens -- an E46 got an empty Analog page and a Digital
// page with nothing behind it.
{
  const kbv = load('KOMBI');
  kbv._variant = 'KOMBI46';
  const root = irRootMenu(kbv, 'KOMBI46');
  const items = irMenuItems(kbv, root, 'KOMBI46');
  const code = items.find(i => /^Cod(e|ing)$/i.test(i.label));
  ok(code && code.screen === 's_code_46',
     `KOMBI46 Code should open s_code_46, got ${code && code.screen}`);
  ok(irRows(kbv.screens[code.screen]).rows.length > 30,
     'KOMBI46 coding screen lost its rows');
  // INPA ships one Status menu per variant and lists the rest as alternatives.
  // Taking item.menu blind gave an E46 the E38/E39 pages; it must get its own
  // m_status_46, whose keys (TOENS I/O, TOENS ECU, CAN) exist on no other.
  const stat = items.find(i => /^(Read )?Status$/i.test(i.label));
  ok(stat && stat.menu === 'm_status_46',
     `KOMBI46 Status should open m_status_46, got ${stat && stat.menu}`);
  const pages = irMenuItems(kbv, stat.menu, 'KOMBI46');
  const ana = pages.find(i => /\bAnalog\b/i.test(i.label));
  ok(ana && ana.screen === 's_status_analog_46',
     `KOMBI46 Analog should be s_status_analog_46, got ${ana && ana.screen}`);
  ok(pages.some(i => /CAN/i.test(i.label)),
     'KOMBI46 Status lost the CAN page its own menu declares');

  // A lettered variant falls back to its numeric sibling's menu where INPA
  // ships no lettered one: there is no m_steuern_46r, so the E46 roadster
  // takes m_steuern_46. Requiring an exact tag match left its Activate key
  // with no menu, which dropped the whole section to the legacy renderer.
  {
    const ir46r = load('KOMBI');
    ir46r._variant = 'KOMBI46R';
    const act = irMenuItems(ir46r, irRootMenu(ir46r, 'KOMBI46R'), 'KOMBI46R')
      .find(i => /^Activate\b/i.test(i.label));
    ok(act && act.menu === 'm_steuern_46',
       `KOMBI46R Activate should open m_steuern_46, got ${act && act.menu}`);
    // ...but a key whose only screen is the family placeholder (which lists
    // the variant names and holds nothing) is one this variant does not have
    const st = irMenuItems(ir46r, irRootMenu(ir46r, 'KOMBI46R'), 'KOMBI46R')
      .find(i => /^(Read )?Status$/i.test(i.label));
    const p46r = irMenuItems(ir46r, st.menu, 'KOMBI46R');
    ok(!p46r.some(i => /TOENS|Thermal oil/i.test(i.label)),
       'KOMBI46R has no TOENS page and must not be offered one');
    ok(p46r.every(i => !i.screen
                    || irRows(ir46r.screens[i.screen] || {}).rows.length),
       'a Status page resolved to the empty family placeholder');
  }

  // A screen suffixed with variants serves THOSE variants only. s_status_36
  // reads STATUS_LESEN, a job only KOMBI36/361 have, so handing it to any
  // other variant asked the ECU for results it never returns ("0 of 16").
  // What the key actually opens: a menu wins over the screen it also names.
  const st36 = (v) => {
    const ir2 = load('KOMBI');
    ir2._variant = v;
    const it = irMenuItems(ir2, irRootMenu(ir2, v), v)
      .find(i => /^(Read )?Status$/i.test(i.label));
    if (!it) return null;
    return it.menu ? `menu:${it.menu}` : it.screen;
  };
  for (const v of ['KOMBI36', 'KOMBI361']) {
    ok(st36(v) === 's_status_36', `${v} Status should be s_status_36`);
  }
  for (const v of ['KOMBI46', 'KOMBI52', 'KOMBI85', 'IKE']) {
    ok(st36(v) !== 's_status_36',
       `${v} must not land on s_status_36 -- its SGBD has no STATUS_LESEN`);
  }
  ok(stat && irRows(kbv.screens[stat.screen]).rows.length > 10,
     `KOMBI46 Status screen has too few rows: ${stat && stat.screen}`);
  // a different variant gets its own screens
  const i36 = irMenuItems(kbv, root, 'KOMBI36');
  ok(i36.find(i => /^Cod(e|ing)$/i.test(i.label)).screen !== 's_code_46',
     'KOMBI36 wrongly given the E46 coding screen');
  // a menu with no digits serves every variant
  ok(irMenuFitsVariant('m_steuern', 'KOMBI46')
     && !irMenuFitsVariant('m_status_38_39', 'KOMBI46')
     && irMenuFitsVariant('m_status_38_39', 'KOMBI38'),
     'menu-name chassis matching is wrong');
}

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
