#!/usr/bin/env node
// A logging run kept in the History and read back
// (app/renderer/screens/logging/replay.js): the part with no page in it.
//
// WHAT THIS PROVES
//   1. A snapshot takes each reading's samples between two times, with its
//      name and unit, and nothing from a reading that was not sampled then.
//   2. Saving writes one History entry that carries the run and says what is
//      in it.
//   3. The value at a time is the latest sample at or before it.
//   4. Readings in the same unit are drawn to one shared scale, others to
//      their own, and a flat reading still gets a band.
//   5. The CSV has a row a sample time and a column a reading.
//
// Run: node tools/verify/test_logging_replay.js
const assert = require('assert');
const path = require('path');

const R = require(
  path.join(__dirname, '../../app/renderer/screens/logging/replay.js')
);

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

(async () => {
  const ring = (t, v, unit) => ({ t, v, unit });
  const store = {
    series: new Map([
      ['a', ring([1000, 1100, 1200, 1300], [1, 2, 3, 4], 'V')],
      ['b', ring([1050, 1250], [0.4, 0.9], 'V')],
      ['c', ring([1100, 1300], [800, 800], 'rpm')],
      ['d', ring([10, 20], [5, 6], '')], // sampled before this run
      ['e', ring([1100], [7], '')], // declared in the store, not in its names
    ]),
    meta: new Map(
      ['a', 'b', 'c', 'd'].map((k) => [
        k,
        { sgbd: 'ms450ds0', job: '@VALUES', key: k, label: `Reading ${k}` },
      ])
    ),
  };
  const log = R.logSnapshot(store, 1050, 1300);
  assert.deepStrictEqual(
    log.series.map((s) => s.label),
    ['Reading a', 'Reading b', 'Reading c']
  );
  assert.deepStrictEqual(log.series[0].t, [1100, 1200, 1300]);
  assert.deepStrictEqual(log.series[0].v, [2, 3, 4]);
  assert.strictEqual(log.series[0].unit, 'V');
  assert.strictEqual(log.from, 1050);
  assert.strictEqual(log.to, 1300);
  assert.strictEqual(R.logSnapshot(store, 5000, 6000), null);
  ok('a snapshot is the samples of that stretch, by reading, or nothing');

  const kept = [];
  global.flashHistory = { _append: async (e) => kept.push(e) };
  const entry = await R.logSaveToHistory(log, {
    chassis: 'E46',
    module: 'MS450DS0',
  });
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(entry.operation, R.LOG_HISTORY_OPERATION);
  assert.strictEqual(entry.started, 1050);
  assert.strictEqual(entry.seconds, 0.3);
  assert.strictEqual(entry.dataLog, log);
  assert.match(
    entry.details,
    /^3 readings at 6\.7\/s: Reading a, Reading b, Reading c$/
  );
  assert.strictEqual(await R.logSaveToHistory(null), null);
  ok('saving writes one History entry carrying the run and what is in it');

  const a = log.series[0];
  assert.strictEqual(R.logReplayValueAt(a, 1100), 2);
  assert.strictEqual(R.logReplayValueAt(a, 1199), 2);
  assert.strictEqual(R.logReplayValueAt(a, 1200), 3);
  assert.strictEqual(R.logReplayValueAt(a, 9999), 4);
  assert.strictEqual(R.logReplayValueAt(a, 0), 2);
  assert.strictEqual(R.logReplayValueAt({ t: [], v: [] }, 5), null);
  ok('the value at a time is the latest sample at or before it');

  const sc = R.logReplayScales(log.series);
  assert.deepStrictEqual(sc[0], sc[1], 'the two voltages share a scale');
  assert.ok(sc[0].lo < 0.4 && sc[0].hi > 4);
  assert.ok(sc[2].lo < 800 && sc[2].hi > 800, 'a flat reading has a band');
  assert.notDeepStrictEqual(sc[2], sc[0]);
  ok('one scale a unit, and a band even for a reading that never moved');

  assert.strictEqual(R.logReplayClock(0), '00:00.0');
  assert.strictEqual(R.logReplayClock(61250), '01:01.3');
  const csv = R.logReplayCsv(log).trim().split('\r\n');
  assert.strictEqual(
    csv[0],
    'time,seconds,"Reading a [V]","Reading b [V]","Reading c [rpm]"'
  );
  assert.strictEqual(csv.length, 1 + 5); // 1050, 1100, 1200, 1250, 1300
  assert.ok(csv[1].endsWith(',0.000,,0.4,'));
  assert.ok(csv[2].endsWith(',0.050,2,,800'));
  ok('the CSV is a row a sample time and a column a reading');

  assert.deepStrictEqual(R.logReplayStats(a, 1100, 1250), {
    min: 2,
    max: 3,
    avg: 2.5,
    n: 2,
  });
  assert.strictEqual(R.logReplayStats(a, 5000, 6000), null);
  assert.deepStrictEqual(R.logReplayTicks(0, 6520, 6), [0, 2000, 4000, 6000]);
  assert.deepStrictEqual(R.logReplayTicks(5, 5, 4), [5]);
  ok(
    'the figures of a stretch are its own, and an axis is marked in round steps'
  );

  const chans = [
    { unit: 'rpm' },
    { unit: 'V' },
    { unit: '' },
    { unit: 'V' },
    { unit: '' },
    { unit: 'rpm' },
  ];
  assert.deepStrictEqual(
    R.logReplayPanes(
      chans,
      chans.map(() => true)
    ),
    [[0, 5], [1, 3], [2], [4]]
  );
  assert.deepStrictEqual(
    R.logReplayPanes(chans, [false, true, false, true, true, true]),
    [[1, 3], [4], [5]]
  );
  ok('Split gives a pane to each unit, and one each to channels without one');

  console.log(`\nlogging-replay: ${passed} checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
