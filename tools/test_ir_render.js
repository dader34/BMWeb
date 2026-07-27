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
eval(fs.readFileSync(path.join(R, 'app/renderer/ir.js'), 'utf8'));

const load = (e) => JSON.parse(
  fs.readFileSync(path.join(R, 'data/inpa-ir', e + '.json'), 'utf8'));
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

// ---- GSDS2: eight distinct pages, right kinds, units not captions ---------
const g = load('GSDS2');
const gm = irSectionMenu(g, 'Status');
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
const rm = irSectionMenu(r, 'Status');
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
const ract = irSectionMenu(r, 'Activations');
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
