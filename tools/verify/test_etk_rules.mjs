#!/usr/bin/env node
// The catalogue's own line filter in JS (screens/etk/rules.js) against the
// Python port of the ETK program (tools/etk_rules.py): the fixture holds two
// E46 diagrams as the bundle and the rules sidecar carry them, and the rows
// the oracle shows for eight cars (tools/verify/make_etk_rules_fixture.py).
//
//   node tools/verify/test_etk_rules.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const R = await import(
  path.join(ROOT, 'app', 'renderer', 'screens', 'etk', 'rules.mjs')
);
const FX = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'etk-rules-E46.json'))
);
let passed = 0;
const ok = (m) => {
  passed++;
  if (process.env.V) console.log('  ok', m);
};

// ---- the building blocks ---------------------------------------------------
assert.strictEqual(R.etkUnd('T', '?'), '?');
assert.strictEqual(R.etkUnd('F', '?'), 'F');
assert.strictEqual(R.etkOder('T', '?'), 'T');
assert.strictEqual(R.etkOder('F', '?'), '?');
ok('three-valued and/or');
assert.strictEqual(R.etkShiftMonth(200401, -2), 200311);
assert.strictEqual(R.etkShiftMonth(200411, 2), 200501);
assert.strictEqual(R.etkShiftMonth(200412, 1), 200501);
assert.strictEqual(R.etkShiftMonth(200401, -1), 200312);
ok('month shift across years');
assert.strictEqual(
  R.etkEvalBool('!(A)&&(B||C)&&! D', { A: false, B: true, D: false }),
  true
);
assert.strictEqual(
  R.etkEvalBool(
    '!(S6NRA)&&(S609A||S602A)&&(((S633A||S639A||S644A)&&S6VCA&&S6NFA)||((S6NLA||S6NKA)&&S6NFA)||S6NSA)&&!(L807A||S8LHA)',
    { S609A: true, S633A: true, S6VCA: true, S6NFA: true }
  ),
  true
);
assert.throws(() => R.etkEvalBool('A &&', {}));
ok("the 'T' rule expressions");
for (const w of ['S760A', '760A', '760', '$760', 's760a'])
  assert.strictEqual(R.etkRulesCodeMatches('S760A', w), true, w);
assert.strictEqual(R.etkRulesCodeMatches('S760A', '761'), false);
assert.strictEqual(R.etkRulesCodeMatches('S760A', 'L760A'), false);
assert.strictEqual(R.etkRulesCodeMatches('P7ACA', '7AC'), true);
ok('the order words in their spellings');

// ---- the sidecar must line up with the bundle before it is trusted --------
{
  const d = FX.diagrams['51_3267'];
  const tree = {
    groups: [{ diagrams: [{ btnr: '51_3267', parts: d.parts }] }],
  };
  const side = { el: FX.el, dg: { '51_3267': d.rules } };
  assert.strictEqual(R.etkRulesMerge(tree, side), 1);
  assert.ok(tree.groups[0].diagrams[0].rules.el === FX.el);
  const shifted = {
    groups: [{ diagrams: [{ btnr: '51_3267', parts: d.parts.slice(1) }] }],
  };
  assert.strictEqual(
    R.etkRulesMerge(shifted, side),
    0,
    'a short list is refused'
  );
  const swapped = JSON.parse(JSON.stringify(tree));
  swapped.groups[0].diagrams[0].parts[3].sachnr = '0000000';
  assert.strictEqual(
    R.etkRulesMerge(swapped, side),
    0,
    'a wrong part is refused'
  );
  assert.strictEqual(R.etkRulesMerge(tree, null), 0);
  ok('alignment proven before the record is attached');
}

// ---- the oracle's cases ----------------------------------------------------
for (const c of FX.cases) {
  const fx = FX.diagrams[c.btnr];
  const d = {
    btnr: c.btnr,
    parts: fx.parts,
    rules: { ...fx.rules, el: FX.el },
  };
  const res = R.etkRulesEvaluate(d, c.car);
  assert.strictEqual(res.applies, true, `${c.name}: the sidecar applies`);
  const got = [...res.keep]
    .map((i) => `${fx.parts[i].pos}|${fx.parts[i].sachnr}`)
    .sort();
  assert.deepStrictEqual(got, c.expect, c.name);
  const verdicts = {};
  for (const r of res.rules) verdicts[r.k] = r.verdict;
  assert.deepStrictEqual(verdicts, c.rules, `${c.name}: the rules' verdicts`);
  assert.strictEqual(
    res.keep.size + res.removed.length,
    fx.parts.filter((p) => !p.fit || p.fit.includes(c.car.variant)).length,
    `${c.name}: every loaded line is kept or explained`
  );
  for (const r of res.removed) assert.ok(r.why, `${c.name}: a reason`);
  ok(`${c.name} (${got.length} rows)`);
}

// ---- without a variant nothing is filtered ---------------------------------
{
  const fx = FX.diagrams['51_3267'];
  const d = {
    btnr: '51_3267',
    parts: fx.parts,
    rules: { ...fx.rules, el: FX.el },
  };
  const res = R.etkRulesEvaluate(d, { variant: null });
  assert.strictEqual(res.applies, false);
  assert.strictEqual(res.keep.size, fx.parts.length);
  ok('no variant, no filter');
}

// ---- the conditions the panel shows ----------------------------------------
{
  const fx = FX.diagrams['51_3267'];
  const d = {
    btnr: '51_3267',
    parts: fx.parts,
    rules: { ...fx.rules, el: FX.el },
  };
  const base = FX.cases[0].car;
  const res = R.etkRulesEvaluate(d, { ...base, sa: ['S760A'] });
  const shadow = res.conds.find((c) => c.code === 'S760A');
  assert.ok(
    shadow && shadow.fromOrder && shadow.value === '1',
    'the order answers B'
  );
  const text = res.conds.find((c) => c.kind === 'T');
  assert.ok(text && text.value === '0', 'the text condition stays open');
  const car2 = R.etkRulesCar({
    variant: 3,
    prod: 200409,
    steer: 'L',
    auto: null,
    vin: 'WBAET37495NJ87379',
    typ: 'ET37',
    sa: ['760'],
    answers: { 35172: '1' },
  });
  assert.strictEqual(car2.vin, 'NJ87379');
  assert.strictEqual(car2.byVin, true);
  assert.notStrictEqual(
    R.etkRulesCarKey({ variant: 3, answers: {} }),
    R.etkRulesCarKey({ variant: 3, answers: { 35172: '1' } })
  );
  ok('conditions and car key');
}

console.log(`test_etk_rules.js: ${passed} checks passed`);
