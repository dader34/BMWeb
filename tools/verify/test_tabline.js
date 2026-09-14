#!/usr/bin/env node
// tabline takes ONE operand, the row index (OpTabline reads arg0, and no job
// in the corpus gives it a second). The handler read the second operand, so
// every tabline threw on an undefined operand: "op is not iterable" on the
// DSC MK60's FS_LESEN_DETAIL, reported from a tester's E46. The replay
// corpus never reaches a tabline, so this synthetic job pins it: pick row 1,
// then an index past the end, which clamps to the last row with Zero set.
const assert = require('assert');
const vm = require('vm');
const { loadBestvm } = require('./load_bestvm.js');
const ctx = { module: { exports: {} }, console };
vm.createContext(ctx);
const { Best2Vm } = loadBestvm(ctx);

let n = 0;
const ok = (msg) => {
  n++;
  console.log(`  ok    ${msg}`);
};

// operand modes as the job-code files carry them: 7 immediate, 8 pool
// string, 1 string register
const code = {
  format: 1,
  sgbd: 'tabline_test',
  jobs: { T: 0 },
  strings: ['T1', 'COL', 'ROW1', 'LAST', 'ZERO'],
  ops: [
    ['tabset', [[8, 0]]],
    ['tabline', [[7, 1]]],
    [
      'tabget',
      [
        [1, 'S1'],
        [8, 1],
      ],
    ],
    [
      'ergs',
      [
        [8, 2],
        [1, 'S1'],
      ],
    ],
    ['tabline', [[7, 9]]],
    // Zero is set by the clamp and must be read before the next table op
    ['jz', [[7, 7]]],
    [
      'ergs',
      [
        [8, 4],
        [8, 1],
      ],
    ],
    [
      'tabget',
      [
        [1, 'S1'],
        [8, 1],
      ],
    ],
    [
      'ergs',
      [
        [8, 3],
        [1, 'S1'],
      ],
    ],
    ['eoj', []],
  ],
};
const tables = { T1: [{ COL: 'a' }, { COL: 'b' }, { COL: 'c' }] };
const m = new Best2Vm(code, { tables, args: '', send: () => [] });
const sets = m.run('T');
assert.strictEqual(sets.length, 1, 'one result set');
assert.strictEqual(sets[0].ROW1, 'b', 'tabline 1 picks the second data row');
ok('tabline reads its one operand as the row index');
assert.strictEqual(
  sets[0].LAST,
  'c',
  'an index past the end clamps to the last row'
);
assert.strictEqual(sets[0].ZERO, undefined, 'and reports Zero (the jz fired)');
assert.strictEqual(
  m.flags.zero,
  false,
  'tabget on the clamped row cleared Zero again'
);
ok('an out-of-range index clamps to the last row with Zero set');
console.log(`tabline: ${n} checks passed`);
