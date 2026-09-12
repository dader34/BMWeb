#!/usr/bin/env node
// setflt and the config reads were no-ops. setflt sets the significant
// digits flt2a keeps (ms450ds0's measurement block sets 9 right before it
// formats every value; the default is 4, so 12.3456 read as 12.35), and
// cfgig / cfgsg answer the SGBD's questions about the engine: SIMULATION is
// "0" and BipEcuFile is the SGBD file's stem. A synthetic job pins each.
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
// string, 1 string register, 4 long register, 12 float register
const code = {
  format: 1,
  sgbd: 'ms450ds0',
  jobs: { T: 0, U: 12 },
  strings: [
    '12.3456789',
    'DEFAULT',
    'SIX',
    'NINE',
    'SIMULATION',
    'SIM',
    'BipEcuFile',
    'FILE',
    'NoSuchKey',
    'UNSET',
    'x',
  ],
  ops: [
    [
      'a2flt',
      [
        [12, 'F0'],
        [8, 0],
      ],
    ],
    [
      'flt2a',
      [
        [1, 'S1'],
        [12, 'F0'],
      ],
    ],
    [
      'ergs',
      [
        [8, 1],
        [1, 'S1'],
      ],
    ],
    ['setflt', [[7, 6]]],
    [
      'flt2a',
      [
        [1, 'S1'],
        [12, 'F0'],
      ],
    ],
    [
      'ergs',
      [
        [8, 2],
        [1, 'S1'],
      ],
    ],
    ['setflt', [[7, 9]]],
    [
      'flt2a',
      [
        [1, 'S1'],
        [12, 'F0'],
      ],
    ],
    [
      'ergs',
      [
        [8, 3],
        [1, 'S1'],
      ],
    ],
    [
      'move',
      [
        [4, 'L0'],
        [7, 7],
      ],
    ],
    [
      'cfgig',
      [
        [4, 'L0'],
        [8, 4],
      ],
    ],
    [
      'ergi',
      [
        [8, 5],
        [4, 'L0'],
      ],
    ],
    // job U: the string reads (and a job after a setflt keeps the digits)
    ['clear', [[1, 'S2']]],
    [
      'cfgsg',
      [
        [1, 'S2'],
        [8, 6],
      ],
    ],
    [
      'ergs',
      [
        [8, 7],
        [1, 'S2'],
      ],
    ],
    [
      'move',
      [
        [1, 'S2'],
        [8, 10],
      ],
    ],
    [
      'cfgsg',
      [
        [1, 'S2'],
        [8, 8],
      ],
    ],
    [
      'ergs',
      [
        [8, 9],
        [1, 'S2'],
      ],
    ],
    [
      'a2flt',
      [
        [12, 'F0'],
        [8, 0],
      ],
    ],
    [
      'flt2a',
      [
        [1, 'S1'],
        [12, 'F0'],
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
// the T job runs into U (no eoj between them) on purpose: one pass through
// every case, then U on its own shows the precision persisting
const m = new Best2Vm(code, { tables: {}, args: '', send: () => [] });
const [t] = m.run('T');
assert.strictEqual(t.DEFAULT, '12.35', 'four significant digits by default');
assert.strictEqual(t.SIX, '12.3457', 'setflt 6 keeps six');
assert.strictEqual(t.NINE, '12.3456789', 'setflt 9 keeps nine');
ok('setflt sets the significant digits flt2a keeps');
assert.strictEqual(t.SIM, 0, 'SIMULATION reads 0');
ok('cfgig answers SIMULATION with 0');
assert.strictEqual(t.FILE, 'ms450ds0', 'BipEcuFile is the SGBD stem');
assert.strictEqual(t.UNSET, 'x', 'an unknown key leaves the register alone');
ok('cfgsg answers BipEcuFile and leaves unknown keys untouched');
const [u] = m.run('U');
assert.strictEqual(
  u.NINE,
  '12.3456789',
  'the precision persists across jobs, as the engine holds it'
);
ok('the precision holds until the next setflt');
console.log(`vm-config: ${n} checks passed`);
