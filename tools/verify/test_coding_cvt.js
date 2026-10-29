#!/usr/bin/env node
// CodingCvt (core/coding/cvt.js): BMW's CVT evaluated for a car -- each
// coding function's value from its equipment, the personal functions left
// out -- against the shipped E46 data (data/cvt.js, tools/decompile/ncs_cvt.py).
//
// Run: node tools/verify/test_coding_cvt.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', '..', 'app', 'renderer');
for (const f of ['data/tables.js', 'data/cvt.js']) {
  if (!fs.existsSync(path.join(R, f))) {
    console.log(
      `skip: ${f} not generated (tools/decompile/ncs_cvt.py --write)`
    );
    process.exit(0);
  }
}
global.window = global;
require(path.join(R, 'data/tables.js'));
require(path.join(R, 'data/cvt.js'));
require(path.join(R, 'core/coding/auftrag.js'));
require(path.join(R, 'core/coding/select.js'));
const Cvt = require(path.join(R, 'core/coding/cvt.js'));

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const car = (keywords) =>
  Cvt.targets('E46', window.CodingSelect.aswIds('E46', [], keywords));

// the chassis keyword holds for every E46: feste_Daten_E46's fixed values
{
  const t = car([]);
  assert.strictEqual(t.values.get('GURTSTRAFFER_FAHRER_1').psw, 'aktiv');
  assert.strictEqual(
    t.values.get('GURTSTRAFFER_FAHRER_1').group,
    'feste_Daten_E46'
  );
  assert(t.values.size > 1000, `only ${t.values.size} values`);
  ok(`a bare E46 gets the fixed data (${t.values.size} functions decided)`);
}

// a group's first rule that holds decides: HandyTyp by the phone fitted
// ("S2,!S3" is NOKIA or not SIEMENS_GSM, so a car without either gets the
// Nokia's value too)
{
  assert.strictEqual(car(['NOKIA']).values.get('HANDY_TYP').psw, 'nokia_3110');
  assert.strictEqual(car([]).values.get('HANDY_TYP').psw, 'nokia_3110');
  assert.strictEqual(
    car(['SIEMENS_GSM']).values.get('HANDY_TYP').psw,
    'typ_wird_ermittelt'
  );
  ok('HANDY_TYP follows the phone, as the rules read');
}

// a group none of whose rules holds decides nothing: AMR_TYP wants an engine
{
  const bare = car([]);
  assert(bare.undecided.includes('AMR_TYP'));
  assert.strictEqual(bare.values.get('AMR_TYP'), undefined);
  assert.strictEqual(car(['M43B19']).values.get('AMR_TYP').psw, 'typ_4');
  ok('AMR_TYP is undecided without an engine, typ_4 with an M43B19');
}

// the driver's functions are reported and kept out of the MAN
{
  const t = car(['NOKIA']);
  assert(t.personal.size > 0, 'no personal functions');
  const someone = [...t.personal][0];
  const fns = [{ name: 'HANDY_TYP' }, { name: someone }, { name: 'NO_SUCH' }];
  const m = Cvt.man(fns, t);
  assert.strictEqual(m.text, 'HANDY_TYP\r\n\tnokia_3110\r\n');
  assert.deepStrictEqual(m.personal, [someone]);
  assert.deepStrictEqual(m.unknown, ['NO_SUCH']);
  ok(
    `the MAN sets HANDY_TYP, leaves ${someone} (personal) and an unknown alone`
  );
}

// a function the description marks as not coding data is never set
{
  const t = car(['NOKIA']);
  const fns = [{ name: 'HANDY_TYP' }];
  fns.codingLocked = new Set(['HANDY_TYP']);
  assert.strictEqual(Cvt.man(fns, t).count, 0);
  ok('a locked function is left out');
}

// a chassis without a CVT says so rather than deciding nothing
assert.strictEqual(Cvt.targets('E60', []), null);
ok('a chassis with no CVT returns null');

console.log(`\n${passed} passed`);
