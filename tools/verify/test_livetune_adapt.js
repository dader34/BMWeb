// The adaptations window (screens/tuning/live-adapt.js): the rows out of
// the DME's answers, and the CSV.
//
// Run: node tools/verify/test_livetune_adapt.js
const assert = require('assert');
const path = require('path');

const A = require(
  path.join(__dirname, '../../app/renderer/screens/tuning/live-adapt.js')
);

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

const rows = A.tnAdaptRows({
  STATUS_ADAPTION_GEMISCH: {
    STAT_ADD_WERT1: '0.106',
    STAT_ADD_WERT2: '-0.021',
    STAT_FAC_WERT1: '2.45',
    STAT_FAC_WERT2: '',
    STAT_PWM_UP_WERT1: '38.3',
  },
  STATUS_NOCKENWELLE_ADAPTION: { STAT_CAM_REF_IN_1: '60.12' },
});
assert.strictEqual(rows.length, 8 + 8);
assert.deepStrictEqual(rows[0], {
  label: 'Mixture adaptation, additive, bank 1',
  value: 0.106,
  unit: 'mg/stk',
  dp: 3,
  job: 'STATUS_ADAPTION_GEMISCH',
});
assert.strictEqual(rows[3].value, null); // blank: not answered
assert.strictEqual(rows[8].label, 'Intake cam reference');
assert.strictEqual(rows[8].value, 60.12);
assert.ok(!rows.some((r) => r.job === 'STATUS_ADAPTION_DK_LLSTELLER'));
ok('rows follow the job list, a job the DME did not answer is left out');

A.tnAdapt.rows = rows.slice(0, 2);
A.tnAdapt.readAt = new Date('2026-10-13T12:00:00Z');
const csv = A.tnAdaptCsv().split('\n');
assert.strictEqual(csv[0], 'adaptation,value,unit,job,read_at');
assert.strictEqual(
  csv[1],
  '"Mixture adaptation, additive, bank 1",0.106,mg/stk,STATUS_ADAPTION_GEMISCH,2026-10-13T12:00:00.000Z'
);
ok('the CSV quotes labels with commas and carries the read time');

assert.strictEqual(A.tnAdaptSelector([]), '255;239;255');
assert.strictEqual(A.tnAdaptSelector([0, 2]), '5;0;0');
assert.strictEqual(A.tnAdaptSelector([9, 10, 7]), '0;32;3');
assert.strictEqual(A.TN_ADAPT_GROUPS.length, 11);
ok(
  'the selector is the groups OR-ed, all but the battery registration when none'
);

console.log(`\nlivetune-adapt: ${passed} checks passed`);
