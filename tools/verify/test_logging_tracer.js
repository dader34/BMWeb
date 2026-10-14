// The replay viewer's Map view: binning a run over a table, and matching
// a table's axes to the run's readings (screens/logging/tracer.js).
//
// Run: node tools/verify/test_logging_tracer.js
const assert = require('assert');
const path = require('path');

const C = require(
  path.join(__dirname, '../../app/renderer/core/livetune-cursor.js')
);
const R = require(
  path.join(__dirname, '../../app/renderer/screens/logging/replay.js')
);
global.ltAxisPosition = C.ltAxisPosition;
global.ltCursorInputs = C.ltCursorInputs;
global.logReplayValueAt = R.logReplayValueAt;
const T = require(
  path.join(__dirname, '../../app/renderer/screens/logging/tracer.js')
);

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

// a 3 by 2 table: rpm across (1000, 2000, 3000), load down (20, 60)
const d = {
  rows: 2,
  cols: 3,
  cells: [
    [1, 2, 3],
    [4, 5, 6],
  ],
  offset: 0x1000,
  x: { points: [1000, 2000, 3000], first: 0x900, units: 'rpm', title: 'N' },
  y: { points: [20, 60], first: 0x910, units: '%', title: 'Load' },
};
// a run: a second at 1000 rpm / 20 %, then half a second at 3000 / 60,
// then a long gap, then one sample back at idle
const log = {
  series: [
    {
      label: 'Engine speed',
      key: 'MW410C_WERT',
      unit: 'rpm',
      t: [0, 500, 1000, 1500, 9000],
      v: [1000, 1000, 3000, 3000, 1000],
    },
    {
      label: 'Engine load',
      key: 'MW4113_WERT',
      unit: '%',
      t: [0, 1000, 9000],
      v: [20, 60, 20],
    },
    {
      label: 'Lambda, bank 1',
      key: 'MW4140_WERT',
      unit: '',
      t: [0, 1000, 9000],
      v: [1.0, 0.9, 1.1],
    },
  ],
};

const bins = T.logTracerBins(log, d, 0, 1, -1, 0, 10000);
assert.strictEqual(bins.dwell.length, 6);
assert.strictEqual(bins.dwell[0], 1); // top-left: 1000 rpm, 20 %
assert.strictEqual(bins.dwell[5], 0.5 + 2); // bottom-right: the half second, then the capped gap
assert.strictEqual(bins.total, 3.5);
assert.strictEqual(bins.path.length, 5);
assert.deepStrictEqual(bins.path[2], { col: 2, row: 1, t: 1000 });
assert.strictEqual(bins.mean, null);
ok('dwell is the time between samples in each cell, a long gap capped');

const windowed = T.logTracerBins(log, d, 0, 1, -1, 900, 1600);
assert.strictEqual(windowed.dwell[0], 0);
assert.strictEqual(windowed.dwell[5], 0.5 + 2);
ok('only the samples in the window are binned');

const avg = T.logTracerBins(log, d, 0, 1, 2, 0, 10000);
assert.strictEqual(avg.mean[0], 1.0);
assert.strictEqual(avg.mean[5], 0.9);
assert.ok(Number.isNaN(avg.mean[1]));
ok('a reading is averaged over each cell the run was in, NaN elsewhere');

const oneRow = T.logTracerBins(
  log,
  { ...d, rows: 1, y: null },
  0,
  -1,
  -1,
  0,
  10000
);
assert.strictEqual(oneRow.dwell.length, 3);
assert.strictEqual(oneRow.dwell[0], 1);
assert.strictEqual(oneRow.dwell[2], 0.5 + 2);
assert.strictEqual(T.logTracerBins(log, d, -1, -1, -1, 0, 10000), null);
ok('a one-row table bins across only; no reading on either axis is nothing');

// matching: the cursor map says which variable feeds each axis, the value
// table which logged value that is; the untraced axis is guessed by name
global.MS45_CURSOR_MAP = {
  vars: [
    [0x3fd7c4, 2, 0, 'N'],
    [0x3fd900, 1, 0, 'rl'],
  ],
  tables: { [0x1000]: [[0x900, 0]] },
  axes: {},
};
global.MS45_VALUE_MAP = {
  values: { 0x410c: [0x3fd7c4, 2, 0, 1, 0], 0x4113: [0x3fd900, 1, 0, 1, 0] },
};
const m = T.logTracerMatch(d, log);
assert.deepStrictEqual(m, { x: 0, y: 1 });
const unknown = T.logTracerMatch(
  { ...d, offset: 0x2000, x: { ...d.x, units: 'ms', title: 'ti' } },
  log
);
assert.deepStrictEqual(unknown, { x: -1, y: 1 });
ok('axes are matched through the maps, else by units and name, else not');

const tables = T.logTracerTables({
  items: [
    {
      kind: 'table',
      title: 'KFZW',
      axes: [{ id: 'x', embed: { address: 1 } }],
    },
    { kind: 'table', title: 'ONE', axes: [{ id: 'z', embed: { address: 1 } }] },
    { kind: 'constant', title: 'K' },
  ],
  comfortList: [
    {
      name: 'Ignition',
      subjects: [{ name: 'Timing', rows: [{ item: null, label: 'x' }] }],
    },
  ],
});
assert.deepStrictEqual(
  tables.map((t) => t.label),
  ['KFZW']
);
ok('only tables with an axis in the image are listed, by their Comfort name');

console.log(`\nlogging-tracer: ${passed} checks passed`);
