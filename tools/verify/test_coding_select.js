// Coding selection: which module, and which coding file, for THIS car.
//
// This is NCS Expert's mechanism -- evaluate each SGET row's AUFTRAGSAUSDRUCK
// against the car's SA codes, first match wins -- so the tests run against
// BMW's own shipped SGET rather than fixtures.
//
// The fact worth guarding is that the rows ARE NOT mutually exclusive. It is
// tempting to read the E46 KMB ladder (!S121 / S121+!S195 / S195) as picking
// exactly one row; it does not, and a change that assumed it did would look
// correct on an early car and quietly select the wrong module on a late one.
//
//   node tools/verify/test_coding_select.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => { passed++; if (process.env.V) console.log('  ok', what); };

global.window = global;
const SGET = path.join(ROOT, 'app', 'renderer', 'data', 'sget.js');
assert.ok(fs.existsSync(SGET),
  'data/sget.js missing -- run tools/decompile/ncs_sget.py --write');
// eslint-disable-next-line no-eval
eval(fs.readFileSync(SGET, 'utf8'));
assert.ok(window.BMW_SGET, 'sget.js did not set BMW_SGET');

global.CodingAuftrag = require('../../app/renderer/core/coding-auftrag.js');
const S = require('../../app/renderer/core/coding-select.js');

// ---- 1. the row is the unit of selection -----------------------------------

{
  // An absent predicate applies to every car -- the enumerator's own reading.
  assert.strictEqual(S.rowApplies({ }, []), true);
  assert.strictEqual(S.rowApplies({ exprHex: '' }, ['205']), true);
  ok('row: no predicate applies to every car');
}

{
  // An UNREADABLE predicate is NOT a match. Accepting a row we could not
  // evaluate is how a wrong module gets chosen with nothing looking wrong.
  assert.strictEqual(S.rowApplies({ exprHex: 'ZZ' }, ['205']), false);
  assert.strictEqual(S.rowApplies({ exprHex: 'FF' }, ['205']), false);
  assert.strictEqual(S.rowApplies(null, ['205']), false);
  ok('row: an unreadable predicate declines rather than matching');
}

// ---- 2. real selection off BMW's own rows ----------------------------------

{
  // Ground truth: E46 SGET, KMB slot. An early car (no build-ladder codes,
  // not an M3) takes the first row, whose predicate is !(S26,S191,S18).
  const r = S.resolveSlot('E46', 'KMB', []);
  assert.ok(r, 'the KMB slot must resolve for a plain car');
  assert.strictEqual(r.sgbd, 'c_kmb46');
  assert.strictEqual(r.file, 'KMB_E46.C02');
  assert.strictEqual(r.umrsg, 'KMB');
  ok('select: an early E46 resolves to c_kmb46 / KMB_E46.C02');
}

{
  // THE FILE IS THE POINT, not just the module. An M3 (S18) late in the run
  // takes a different CODING FILE on the same SGBD -- selecting the module
  // but keeping the wrong file would decode against the wrong map.
  const r = S.resolveSlot('E46', 'KMB', ['18', '199']);
  assert.ok(r);
  assert.strictEqual(r.sgname, 'KMBE46M3', 'an M3 must take the M3 coding file');
  assert.notStrictEqual(r.file, 'KMB_E46.C02');
  ok('select: an M3 takes the M3 coding file, not the base one');
}

{
  // A slot nothing applies to yields null. "No answer" is a real outcome and
  // must not collapse into a default.
  assert.strictEqual(S.resolveSlot('E46', 'NOSUCHSLOT', ['205']), null);
  assert.strictEqual(S.resolveSlot('NOPE', 'KMB', ['205']), null);
  ok('select: an unknown slot resolves to null, never a default');
}

// ---- 3. ambiguity is reported, not hidden ----------------------------------

{
  // MEASURED ON THE SHIPPED DATA: 4 of 44 realistic E46 cars satisfy rows
  // naming BOTH c_kmb46 and kombi46r. NCS Expert breaks the tie by row order.
  // We do the same -- and say so, because a caller about to write should be
  // able to see that nothing but the order decided it.
  const r = S.resolveSlot('E46', 'KMB', ['121']);
  assert.ok(r, 'S121 must still resolve');
  assert.strictEqual(r.ambiguous, true, 'S121 is a known ambiguous car');
  assert.ok(r.matched > 1, 'more than one row applied');
  assert.ok(r.alternatives.includes('kombi46r'),
    `expected kombi46r among alternatives, got ${r.alternatives}`);
  // first match wins, deterministically
  assert.strictEqual(r.sgbd, 'c_kmb46');
  ok('select: an ambiguous car resolves by row order AND reports it');
}

{
  // An unambiguous car must NOT be flagged -- a warning that fires always is
  // a warning nobody reads.
  const r = S.resolveSlot('E46', 'KMB', []);
  assert.strictEqual(r.ambiguous, false);
  assert.deepStrictEqual(r.alternatives, []);
  ok('select: an unambiguous car is not flagged');
}

{
  // Rows differing only by CODING INDEX are not a conflict: the index picks
  // between them later. Ambiguity means the rows disagree about WHICH MODULE.
  let sameSgbdMulti = 0;
  for (const codes of [[], ['191'], ['192'], ['18'], ['18', '196']]) {
    const r = S.resolveSlot('E46', 'KMB', codes);
    if (r && r.matched > 1 && !r.ambiguous) sameSgbdMulti++;
  }
  assert.ok(sameSgbdMulti > 0,
    'expected at least one car matching several rows on ONE module');
  ok('select: several rows on one module is not reported as ambiguity');
}

// ---- 4. finding a module by its configured name ----------------------------

{
  const slots = S.slotsForSgbd('E46', 'c_kmb46');
  assert.ok(slots.length, 'c_kmb46 must belong to at least one slot');
  assert.ok(slots.includes('KMB') || slots.includes('AKMB'));
  ok(`select: a configured SGBD finds its slot(s) (${slots})`);
}

{
  // A module SGET does not mention has nothing to choose between, and must
  // come back null so the caller keeps what the config said.
  assert.strictEqual(S.resolveModule('E46', 'not_a_module', ['205']), null);
  // These are the real ones: modules sharing a diagnostic address whose names
  // never appear in SGET. Selection cannot help them -- telling them apart
  // needs the group's identification job, which this module deliberately
  // does not use. Guarded so a later change cannot quietly claim otherwise.
  for (const sg of ['bc_v', 'uhr_bc', 'msd80', 'msv80', 'amph70']) {
    assert.strictEqual(S.slotsForSgbd('E36', sg).length, 0,
      `${sg} unexpectedly appeared in E36 SGET`);
    assert.strictEqual(S.slotsForSgbd('E90', sg).length, 0,
      `${sg} unexpectedly appeared in E90 SGET`);
  }
  ok('select: modules absent from SGET resolve to null (the documented gap)');
}

// ---- 5. re-pointing a module list ------------------------------------------

{
  const mods = [{ sgbd: 'c_kmb46', label: 'Instrument cluster' },
                { sgbd: 'lsz', label: 'Light switch' }];
  // No codes: nothing is known about the car, so nothing is re-pointed.
  assert.deepStrictEqual(S.applySelection('E46', mods, []), mods);
  assert.deepStrictEqual(S.applySelection('E46', mods, null), mods);
  ok('apply: with no equipment codes the list is untouched');
}

{
  // THE DIAGNOSTIC NAME SURVIVES. Selection speaks the CODING namespace
  // (C_LSZA, LSZ.C31); jobs are run against the diagnostic name the config
  // carries (lsz). Overwriting one with the other sends every read to a name
  // the engine has never heard of, so `sgbd` must come through untouched and
  // the coding file must arrive beside it.
  const mods = [{ sgbd: 'lsz', label: 'Light switch' }];
  const out = S.applySelection('E46', mods, ['26', '195']);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].sgbd, 'lsz', 'the diagnostic name must not be rewritten');
  assert.ok(out[0].select, 'the selection must be attached');
  assert.strictEqual(out[0].select.sgbd, 'c_lsza', 'coding name goes in select');
  assert.strictEqual(out[0].select.file, 'LSZ.C31');
  ok('apply: keeps the diagnostic sgbd, attaches the coding variant');
}

{
  // A module SGET does not cover passes through untouched, with no `select`.
  const mods = [{ sgbd: 'totally_unknown', label: 'X' }];
  const out = S.applySelection('E46', mods, ['205']);
  assert.deepStrictEqual(out, mods);
  ok('apply: an uncovered module passes through unchanged');
}

{
  // Selection must never add or drop modules -- it annotates a list, and a
  // list that changes length would silently hide or duplicate a module.
  const mods = [{ sgbd: 'lsz' }, { sgbd: 'ews' }, { sgbd: 'zke5' },
                { sgbd: 'unknown_thing' }];
  const out = S.applySelection('E46', mods, ['26', '195']);
  assert.strictEqual(out.length, mods.length);
  assert.deepStrictEqual(out.map((m) => m.sgbd), mods.map((m) => m.sgbd));
  ok('apply: annotates the list without adding or dropping modules');
}

// ---- 6. the corpus holds together ------------------------------------------

{
  // EVERY ROW MUST BE REACHABLE. A row no car can satisfy is either a
  // misparsed predicate or a module that can never be selected, and both are
  // silent failures -- the module simply never appears.
  //
  // "Feed the row its own refs" does NOT test this: refs lists every code the
  // predicate mentions, including negated ones, so a row like
  // `S138+S87+!S180` fails when handed S180. Each row is searched instead for
  // a car that satisfies it, over its own referenced codes.
  const satisfiable = (row) => {
    const refs = [...new Set(row.refs || [])].map(String);
    if (!refs.length) return S.rowApplies(row, []);
    // Small enough to enumerate exhaustively; larger rows get a bounded
    // random search, which is sufficient to show reachability.
    if (refs.length <= 14) {
      for (let m = 0; m < (1 << refs.length); m++) {
        const car = refs.filter((_, i) => m & (1 << i));
        if (S.rowApplies(row, car)) return true;
      }
      return false;
    }
    for (let t = 0; t < 20000; t++) {
      const car = refs.filter(() => Math.random() < 0.5);
      if (S.rowApplies(row, car)) return true;
    }
    return false;
  };

  let chassis = 0, rows = 0;
  const dead = [];
  for (const ch of Object.keys(window.BMW_SGET)) {
    const rs = S.rowsFor(ch);
    if (!rs.length) continue;
    chassis++;
    for (const r of rs) {
      rows++;
      if (!satisfiable(r)) dead.push(`${ch} ${r.UMRSG} ${r.SGBD} ${r.expr}`);
    }
  }
  assert.strictEqual(chassis, 8,
    `expected 8 chassis with rows (E32 and E34 ship none), got ${chassis}`);
  assert.deepStrictEqual(dead, [],
    `rows no car can satisfy:\n  ${dead.join('\n  ')}`);
  ok(`select: every SGET row is reachable by some car (${rows} rows, ${chassis} chassis)`);
}

{
  // A resolved row must always name a module to talk to. A selection with no
  // sgbd would send a job to undefined.
  let checked = 0;
  for (const ch of Object.keys(window.BMW_SGET)) {
    for (const r of S.rowsFor(ch)) {
      const got = S.resolveSlot(ch, r.UMRSG, r.refs || []);
      if (!got) continue;
      assert.ok(got.sgbd, `${ch} ${r.UMRSG}: resolved with no sgbd`);
      checked++;
    }
  }
  assert.ok(checked > 100, `only ${checked} resolutions exercised`);
  ok(`select: every resolution names a module (${checked} checked)`);
}

console.log(`coding-select: ${passed} tests passed`);
