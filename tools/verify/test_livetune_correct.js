// The live cell correction (screens/tuning/live-correct.js): crediting a
// sample's trim to the cells around a position, and planning the change.
//
// Run: node tools/verify/test_livetune_correct.js
const assert = require('assert');
const path = require('path');

const C = require(
  path.join(__dirname, '../../app/renderer/screens/tuning/live-correct.js')
);

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

const acc = C.tnCorrectNew(2, 3);
C.tnCorrectCredit(acc, 0, 0, 0.04);
assert.strictEqual(acc.weight[0], 1);
assert.strictEqual(acc.sum[0], 0.04);
assert.strictEqual(acc.samples, 1);
// half way between the first two columns, a quarter of the way down
C.tnCorrectCredit(acc, 0.25, 0.5, 0.02);
assert.ok(Math.abs(acc.weight[0] - 1.375) < 1e-9); // 1 + 0.75 * 0.5
assert.ok(Math.abs(acc.weight[1] - 0.375) < 1e-9);
assert.ok(Math.abs(acc.weight[3] - 0.125) < 1e-9);
assert.ok(Math.abs(acc.weight[4] - 0.125) < 1e-9);
assert.ok(Math.abs(acc.sum[1] - 0.02 * 0.375) < 1e-9);
ok('a sample is shared between the four cells around it by their shares');

const edge = C.tnCorrectNew(1, 3);
C.tnCorrectCredit(edge, 0, 2, 0.1);
C.tnCorrectCredit(edge, 5, -1, 0.1); // off the table: pinned to its edge
assert.strictEqual(edge.weight[2], 1);
assert.strictEqual(edge.weight[0], 1);
ok('a one-row table and positions off the edge still land on a cell');

const cells = [
  [100, 100, 100],
  [100, 100, 100],
];
const full = C.tnCorrectNew(2, 3);
for (let i = 0; i < C.TN_CORRECT_MIN_WEIGHT; i++)
  C.tnCorrectCredit(full, 0, 0, 0.04);
for (let i = 0; i < C.TN_CORRECT_MIN_WEIGHT; i++)
  C.tnCorrectCredit(full, 1, 2, -0.5);
C.tnCorrectCredit(full, 0, 1, 0.04); // one sample: not enough
const plan = C.tnCorrectPlan(full, cells, 0.5);
assert.strictEqual(plan.ready, 2);
assert.strictEqual(plan.capped, 1);
assert.deepStrictEqual(
  plan.values.map(([r, c, v]) => [r, c, Math.round(v * 1000) / 1000]),
  [
    [0, 0, 102],
    [1, 2, 100 * (1 - C.TN_CORRECT_MAX_STEP)],
  ]
);
ok('only cells with enough samples change, by the mean trim, capped');

console.log(`\nlivetune-correct: ${passed} checks passed`);
