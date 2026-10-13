#!/usr/bin/env node
// A flash session's log read as a session
// (app/renderer/screens/flashing/log-view.js): the part with no page in it.
//
// WHAT THIS PROVES
//   1. The log's header, its notes and its jobs (with their telegrams) are
//      read off the text flashLog writes, on the session's own clock.
//   2. A job's time is the time since the line before it, and a session
//      that runs past midnight keeps counting.
//   3. The summary counts jobs by kind with the time each took, and names
//      the first one that failed.
//
// Run: node tools/verify/test_flash_logview.js
const assert = require('assert');
const path = require('path');
const V = require(
  path.join(__dirname, '../../app/renderer/screens/flashing/log-view.js')
);

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

const text = [
  '# BMWeb Flashing/Backups log',
  '# operation: flash-program',
  '# started:   2026-10-13T10:06:00.000Z',
  '',
  '23:59:58.000  DME 0044570 / prog 0044570LO02S',
  '23:59:58.500  seriennummer_lesen -> OKAY',
  '    tx: B8 12 F1 02 1A 87',
  '    rx: B8 F1 12 06 5A 87 01 02 03 04',
  '23:59:59.900  flash_loeschen [5B: 01 02 03 04 05] -> OKAY',
  '00:00:02.900  flash_schreiben [253B: FF FF ...] -> OKAY',
  '00:00:03.400  flash_schreiben [253B: 00 11 ...] -> ERROR_ECU_REJECTED',
  '    tx: B8 12 F1 FF 36',
  '00:00:03.450  Flash failed',
  '',
  '# ended: 2026-10-13T10:06:06.000Z',
].join('\n');

const log = V.fbLogParse(text);
assert.strictEqual(log.operation, 'flash-program');
assert.strictEqual(log.started, '2026-10-13T10:06:00.000Z');
assert.strictEqual(log.ended, '2026-10-13T10:06:06.000Z');
assert.deepStrictEqual(
  log.events.map((e) => [e.kind, e.name || e.status]),
  [
    ['note', 'DME 0044570 / prog 0044570LO02S'],
    ['job', 'seriennummer_lesen'],
    ['job', 'flash_loeschen'],
    ['job', 'flash_schreiben'],
    ['job', 'flash_schreiben'],
    ['note', 'Flash failed'],
  ]
);
assert.strictEqual(log.events[1].tx, 'B8 12 F1 02 1A 87');
assert.strictEqual(log.events[1].rx, 'B8 F1 12 06 5A 87 01 02 03 04');
assert.strictEqual(log.events[2].arg, '5B: 01 02 03 04 05');
assert.strictEqual(log.events[4].status, 'ERROR_ECU_REJECTED');
assert.ok(log.events[4].failed && !log.events[3].failed);
assert.strictEqual(log.events[4].tx, 'B8 12 F1 FF 36');
ok('header, notes, jobs and their telegrams are read off the text');

assert.deepStrictEqual(
  log.events.map((e) => e.at),
  [0, 500, 1900, 4900, 5400, 5450]
);
assert.deepStrictEqual(
  log.events.map((e) => e.took),
  [0, 500, 1400, 3000, 500, 50]
);
assert.strictEqual(log.total, 5450);
ok('a job took the time since the line before it, across midnight too');

const sum = V.fbLogSummary(log);
assert.strictEqual(sum.jobs, 4);
assert.strictEqual(sum.failed, 1);
assert.strictEqual(sum.notes, 2);
assert.deepStrictEqual(sum.kinds, [
  { name: 'flash_schreiben', n: 2, failed: 1, ms: 3500 },
  { name: 'flash_loeschen', n: 1, failed: 0, ms: 1400 },
  { name: 'seriennummer_lesen', n: 1, failed: 0, ms: 500 },
]);
assert.strictEqual(sum.firstFailure, log.events[4]);
assert.strictEqual(sum.slowest, log.events[3]);
ok('jobs are counted by kind with their time, and the first failure named');

const empty = V.fbLogParse('');
assert.deepStrictEqual(empty.events, []);
assert.strictEqual(V.fbLogSummary(empty).firstFailure, null);
assert.strictEqual(V.fbLogSpan(450), '450 ms');
assert.strictEqual(V.fbLogSpan(179100), '2 min 59 s');
assert.strictEqual(V.fbLogClock(61250), '01:01.3');
ok('an empty log is an empty session, and spans read plainly');

console.log(`\nflash-logview: ${passed} checks passed`);
