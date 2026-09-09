// The data-logging app, driven offline against a fake car.
//
// The four things that would be silently wrong in the field:
//   1. the ring buffer's cap and what counts as a number (a status word
//      logged as 0 would draw a plausible, false trace)
//   2. the scheduler's ORDER -- every job of one module before the next
//      module gets the bus, because a switch costs ENDE + INITIALISIERUNG
//   3. the CSV's shape (one row per timestamp, blanks where nothing was read)
//   4. that a write job cannot enter the rotation, however it is asked for
//
//   node tools/verify/test_logging.js
//   V=1 node tools/verify/test_logging.js     # per-check output

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const R = (p) => path.join(ROOT, 'app', 'renderer', p);
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// ---- the browser globals the screen pieces lean on -------------------------
global.window = global;
global.document = { getElementById: () => null };
global.esc = (s) => String(s == null ? '' : s);
global.normUnit = (u) => String(u == null ? '' : u).trim();
global.humanizeKey = (k) => k;
global.Settings = {
  store: {},
  get(k, d) {
    return k in this.store ? this.store[k] : d;
  },
  set(k, v) {
    this.store[k] = v;
  },
};
const isSystemSet = (s) =>
  s &&
  typeof s === 'object' &&
  ('SAETZE' in s || 'JOBNAME' in s || 'OBJECT' in s);
global.dataSets = (sets) => {
  const list = sets || [];
  return list.length && isSystemSet(list[0]) ? list.slice(1) : list;
};
// The real sleep is worker-backed. Under node it must still yield to the
// MACROTASK queue: a bare resolved promise is a microtask, so the poll loop
// would spin thousands of rounds before the test's own wait ever ran again
// (which it did -- the first draft of this test exhausted the heap).
global.bmwSleep = () => new Promise((r) => setImmediate(r));

// the write classifier exactly as shipped -- the picker's filter is only as
// good as this, so the test uses the real one rather than a stub
const bv = require(R('core/bestvm/index.js'));
global.isWriteJob = bv.isWriteJob;
assert.strictEqual(typeof global.isWriteJob, 'function', 'isWriteJob missing');

const { loadClassic } = require('./lib/load_classic.js');
const L = loadClassic('screens/logging/');
const { LogRing, LogStore, logParseNumber, logUnitFor, logCsv } = L;
const { LogScheduler } = L;
const { LogSelection, logReadableJobs, logResultKeys } = L;
const { logNiceScale } = L;

// ---- 1. numeric parsing ----------------------------------------------------
// EDIABAS answers are strings; only some of them are measurements.
assert.strictEqual(logParseNumber('13.8'), 13.8);
assert.strictEqual(logParseNumber('13.8 V'), 13.8, 'unit suffix ignored');
assert.strictEqual(logParseNumber('-40.0 °C'), -40);
assert.strictEqual(logParseNumber('1013'), 1013);
assert.strictEqual(logParseNumber('12,5'), 12.5, 'German decimal comma');
assert.strictEqual(logParseNumber(42), 42, 'already a number');
assert.strictEqual(logParseNumber('1.5e3'), 1500);
ok('parses numbers, with or without a unit');

assert.strictEqual(logParseNumber('OKAY'), null, 'a status word is not data');
assert.strictEqual(logParseNumber('aktiv'), null);
assert.strictEqual(logParseNumber(''), null);
assert.strictEqual(logParseNumber(null), null);
assert.strictEqual(logParseNumber(undefined), null);
assert.strictEqual(logParseNumber('0x1A2B'), null, 'a telegram is not data');
ok('refuses non-numeric values instead of logging them as 0');

// ---- 2. units come from the answer, not the schema -------------------------
// BMW pairs STAT_X_WERT with STAT_X_EINH; the unit is a runtime value.
assert.strictEqual(
  logUnitFor('STAT_MOTORTEMPERATUR_WERT', {
    STAT_MOTORTEMPERATUR_WERT: '87',
    STAT_MOTORTEMPERATUR_EINH: '°C',
  }),
  '°C'
);
assert.strictEqual(
  logUnitFor('STAT_X_WERT', { STAT_X_WERT: '1', STAT_X_EINH: '-' }),
  '',
  'a placeholder _EINH names no unit'
);
assert.strictEqual(
  logUnitFor('STAT_SPANNUNG', { STAT_SPANNUNG: '13.8 V' }),
  'V',
  'falls back to a unit written into the value'
);
assert.strictEqual(logUnitFor('STAT_Y', { STAT_Y: '5' }), '');
ok('reads the unit from the _EINH sibling, else from the value');

// ---- 3. the ring buffer's cap ----------------------------------------------
// The cap is by TIME: the charts share one axis, so a count-based cap would
// hold different spans per series.
const ring = new LogRing(1000); // a 1 s window, so the test can see the edge
const t0 = 100000;
for (let i = 0; i <= 10; i++) ring.push(t0 + i * 200, i); // 0..2000ms
// only samples within 1000ms of the newest (t0+2000) survive
assert.ok(ring.length < 11, 'old samples were dropped');
assert.ok(
  ring.t[0] >= t0 + 2000 - 1000,
  `oldest kept sample is inside the window (${ring.t[0]})`
);
assert.strictEqual(ring.last(), 10, 'the newest sample is kept');
ok('ring buffer drops samples older than its window');

const big = new LogRing(60000);
for (let i = 0; i < 5000; i++) big.push(t0 + i, i);
assert.strictEqual(big.length, 5000, 'nothing inside the window is dropped');
ok('ring buffer keeps everything inside the window');

// stats and the cursor lookup
const st = big.stats(t0, t0 + 4999);
assert.strictEqual(st.min, 0);
assert.strictEqual(st.max, 4999);
assert.strictEqual(st.last, 4999);
assert.strictEqual(big.at(t0 + 100), 100, 'cursor reads the sample at t');
assert.strictEqual(
  big.at(t0 - 50000, 10),
  null,
  'cursor reads nothing where there is no sample'
);
ok('stats and the cursor lookup agree with the samples');

// a flat series must still get a drawable range
const flat = logNiceScale(5, 5);
assert.ok(flat.hi > flat.lo, 'a flat line gets a band, not a zero-height box');
ok('axis scaling never produces a zero-height range');

// ---- 4. the store ingests only what parses ---------------------------------
const store = new LogStore(60000);
const row = {
  STAT_TEMP_WERT: '87.5',
  STAT_TEMP_EINH: '°C',
  JOB_STATUS: 'OKAY',
  STAT_MODE: 'aktiv',
};
const taken = store.ingest(
  'ms450ds0',
  'STATUS_TEMP',
  row,
  ['STAT_TEMP_WERT', 'STAT_MODE'],
  t0
);
assert.strictEqual(taken, 1, 'only the numeric key was logged');
const sid = L.logSeriesKey('ms450ds0', 'STATUS_TEMP', 'STAT_TEMP_WERT');
assert.strictEqual(store.series.get(sid).last(), 87.5);
assert.strictEqual(store.series.get(sid).unit, '°C', 'unit came from _EINH');
assert.ok(
  !store.series.has(L.logSeriesKey('ms450ds0', 'STATUS_TEMP', 'STAT_MODE'))
);
ok('the store logs numeric keys and drops the rest');

// ---- 5. the scheduler's ordering -------------------------------------------
// THE POINT OF THE WHOLE DESIGN: the shim holds one session at a time, so a
// module switch costs ENDE + INITIALISIERUNG. Every job of one module must
// run back to back before another module gets the bus.
/**
 * A fake api() that records every POST and answers with a rising number.
 * @param {object} [opts] - {fail: Set of "sgbd/JOB" that should throw}
 * @returns {Array<{sgbd: string, job: string}>} the calls, in order
 */
function fakeApi(opts = {}) {
  const sent = [];
  let n = 0;
  global.api = async (url) => {
    const m = String(url).match(/^\/api\/ecu\/([^/]+)\/run\/([^?]+)/);
    if (!m) throw new Error(`unexpected api ${url}`);
    const sgbd = m[1];
    const job = decodeURIComponent(m[2]);
    sent.push({ sgbd, job });
    if (opts.fail && opts.fail.has(`${sgbd}/${job}`))
      throw new Error('IFH-0009: no answer');
    n++;
    return {
      sets: [
        { SAETZE: '1', JOBNAME: job }, // the system set dataSets() drops
        { VAL: String(n), VAL_EINH: 'V' },
      ],
    };
  };
  return sent;
}

(async () => {
  // two modules, two jobs each
  const targets = [
    {
      sgbd: 'ms450ds0',
      label: 'MS45',
      group: null,
      job: 'STATUS_A',
      keys: ['VAL'],
    },
    {
      sgbd: 'ihka46',
      label: 'IHKA',
      group: null,
      job: 'STATUS_C',
      keys: ['VAL'],
    },
    {
      sgbd: 'ms450ds0',
      label: 'MS45',
      group: null,
      job: 'STATUS_B',
      keys: ['VAL'],
    },
    {
      sgbd: 'ihka46',
      label: 'IHKA',
      group: null,
      job: 'STATUS_D',
      keys: ['VAL'],
    },
  ];
  const sent = fakeApi();
  const st2 = new LogStore(60000);
  const sched = new LogScheduler({ targets, store: st2, gapMs: 0 });

  // the plan groups by module, keeping pick order
  const plan = sched.plan();
  assert.strictEqual(plan.length, 2, 'two modules');
  assert.strictEqual(plan[0].sgbd, 'ms450ds0');
  assert.deepStrictEqual(
    plan[0].jobs.map((j) => j.job),
    ['STATUS_A', 'STATUS_B'],
    "a module's jobs are gathered together"
  );
  assert.deepStrictEqual(
    plan[1].jobs.map((j) => j.job),
    ['STATUS_C', 'STATUS_D']
  );
  ok('the plan groups the selection by module');

  sched.start();
  // let a few rounds run, then stop and inspect the wire order
  while (sent.length < 8) await new Promise((r) => setImmediate(r));
  await sched.stop();

  const first8 = sent.slice(0, 8).map((c) => `${c.sgbd}/${c.job}`);
  assert.deepStrictEqual(
    first8,
    [
      'ms450ds0/STATUS_A',
      'ms450ds0/STATUS_B',
      'ihka46/STATUS_C',
      'ihka46/STATUS_D',
      'ms450ds0/STATUS_A',
      'ms450ds0/STATUS_B',
      'ihka46/STATUS_C',
      'ihka46/STATUS_D',
    ],
    'all jobs of one module run before the next module gets the bus'
  );
  ok('scheduler never alternates modules mid-round');

  // the switch count is what the grouping buys: 2 per round, not 4
  let switches = 0;
  for (let i = 1; i < first8.length; i++) {
    if (sent[i].sgbd !== sent[i - 1].sgbd) switches++;
  }
  assert.strictEqual(
    switches,
    3,
    'one switch per module boundary, not per job'
  );
  ok('one session switch per module per round');

  // samples landed, and the per-module rate is reported once there are two rounds
  assert.ok(st2.active().length === 4, 'a series per (module, job)');
  assert.ok(st2.rounds.get('ms450ds0').n >= 2, 'rounds were counted');
  ok('the store recorded a series per selected job');

  // a job that fails on the wire leaves the rotation instead of burning the
  // sample budget every round
  const sent2 = fakeApi({ fail: new Set(['ihka46/STATUS_C']) });
  const st3 = new LogStore(60000);
  const s3 = new LogScheduler({ targets, store: st3, gapMs: 0 });
  s3.start();
  while (sent2.length < 10) await new Promise((r) => setImmediate(r));
  await s3.stop();
  const badCalls = sent2.filter((c) => c.job === 'STATUS_C').length;
  assert.strictEqual(
    badCalls,
    1,
    'the failing job was tried once, then dropped'
  );
  ok('a failing job leaves the rotation');

  // stop() is final: no call may land after it
  const before = sent2.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent2.length, before, 'nothing ran after stop()');
  ok('stop() ends the loop for good');

  // ---- 6. the CSV shape ----------------------------------------------------
  // One row per timestamp; a cell is filled only where a sample exists at
  // that instant. A round-robin log HAS gaps and must show them as gaps.
  const cs = new LogStore(60000);
  cs.ingest('a', 'J1', { X: '1' }, ['X'], 1000);
  cs.ingest('b', 'J2', { Y: '10' }, ['Y'], 1500);
  cs.ingest('a', 'J1', { X: '2' }, ['X'], 2000);
  const csv = logCsv(cs);
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines.length, 4, 'a header plus one row per timestamp');
  assert.ok(/^time,seconds,/.test(lines[0]), 'time columns lead the header');
  assert.strictEqual(
    lines[0].split(',').length,
    4,
    'two time columns plus one per series'
  );
  const cells = lines.map((l) => l.split(','));
  assert.strictEqual(cells[1][2], '1', 'the first series has its value');
  assert.strictEqual(cells[1][3], '', 'the other series was not read then');
  assert.strictEqual(cells[2][2], '', 'blank, not carried forward');
  assert.strictEqual(cells[2][3], '10');
  assert.strictEqual(cells[3][2], '2');
  assert.strictEqual(
    cells[1][1],
    '0.000',
    'seconds count from the first sample'
  );
  assert.strictEqual(cells[3][1], '1.000');
  ok('CSV is one row per timestamp with real gaps');

  assert.strictEqual(
    logCsv(new LogStore()),
    '',
    'an empty store exports nothing'
  );
  ok('an empty buffer exports nothing rather than a bare header');

  // ---- 7. writes are refused ----------------------------------------------
  // The picker's filter is the VM's own classifier, and it is default-deny.
  const jobs = [
    'STATUS_MOTORTEMPERATUR', // read
    'MESSWERTBLOCK_LESEN', // read
    'FS_LESEN', // read
    'STEUERN_MOTOR', // WRITE
    'FS_LOESCHEN', // WRITE
    'CODIERDATEN_SCHREIBEN', // WRITE
    'INITIALISIERUNG', // WRITE token: the session machinery owns it
    'WOBBLE', // unknown -> default-deny
  ];
  global.jobNamesFor = async () => jobs;
  const readable = await logReadableJobs('ms450ds0');
  assert.ok(readable.includes('STATUS_MOTORTEMPERATUR'));
  assert.ok(readable.includes('MESSWERTBLOCK_LESEN'));
  assert.ok(readable.includes('FS_LESEN'));
  for (const w of [
    'STEUERN_MOTOR',
    'FS_LOESCHEN',
    'CODIERDATEN_SCHREIBEN',
    'INITIALISIERUNG',
    'WOBBLE',
  ]) {
    assert.ok(!readable.includes(w), `${w} must not be offered for logging`);
  }
  ok('the picker offers no write job, and default-denies an unknown one');

  // ...and the selection refuses one even if asked directly (a stale preset)
  const sel = new LogSelection();
  const mod = { sgbd: 'ms450ds0', label: 'MS45', group: null };
  sel.set(mod, 'STEUERN_MOTOR', 'X', true);
  assert.strictEqual(sel.size, 0, 'a write cannot be selected directly');
  sel.set(mod, 'STATUS_MOTORTEMPERATUR', 'STAT_TEMP_WERT', true);
  assert.strictEqual(sel.size, 1);
  ok('the selection itself refuses a write job');

  // a preset saved before the classifier tightened must not smuggle one back
  const restored = new LogSelection().fromJSON([
    {
      sgbd: 'ms450ds0',
      label: 'MS45',
      group: null,
      job: 'STEUERN_X',
      key: 'A',
    },
    { sgbd: 'ms450ds0', label: 'MS45', group: null, job: 'STATUS_X', key: 'B' },
  ]);
  assert.strictEqual(restored.size, 1, 'the write row was dropped on load');
  assert.strictEqual(restored.targets()[0].job, 'STATUS_X');
  ok('loading a preset re-applies the write filter');

  // ---- 8. result keys: both shipped shapes, internals hidden ---------------
  global.api = async () => [
    'JOB_STATUS : "OKAY", wenn fehlerfrei',
    '_TEL_AUFTRAG : Hex-Auftrag an SG',
    'STAT_MOTORTEMPERATUR_WERT : Wert von TCO',
    'STAT_MOTORTEMPERATUR_EINH : Einheit von TCO',
  ];
  const keys = await logResultKeys('ms450ds0', 'STATUS_MOTORTEMPERATUR');
  assert.deepStrictEqual(
    keys.map((k) => k.name),
    ['STAT_MOTORTEMPERATUR_WERT', 'STAT_MOTORTEMPERATUR_EINH'],
    'JOB_STATUS and _-prefixed internals are not offered'
  );
  assert.strictEqual(keys[0].comment, 'Wert von TCO', 'the comment survives');
  ok('result keys parse the "NAME : comment" shape and hide internals');

  global.api = async () => [
    { name: 'STAT_SPANNUNG_WERT', comment: 'Batterie', unit: 'V' },
  ];
  const specKeys = await logResultKeys('x', 'Y');
  assert.strictEqual(
    specKeys[0].unit,
    'V',
    'a declared unit is carried through'
  );
  ok('result keys also parse the {name, unit} spec shape');

  global.api = async () => {
    throw new Error('404');
  };
  assert.deepStrictEqual(
    await logResultKeys('x', 'Y'),
    [],
    'a job with no shipped schema is empty, not an error'
  );
  ok('a missing result schema is empty rather than fatal');

  // ---- a chart card's remove drops just that series -------------------------
  {
    const sel = new LogSelection();
    const m = { sgbd: 'MS450DS0', label: 'MS45', group: 'D_MOTOR' };
    sel.set(m, 'STATUS_MESSWERTBLOCK_0', 'STAT_MESSWERT0_WERT', true);
    sel.set(m, 'STATUS_MESSWERTBLOCK_0', 'STAT_MESSWERT1_WERT', true);
    const id = L.logSeriesKey(
      'MS450DS0',
      'STATUS_MESSWERTBLOCK_0',
      'STAT_MESSWERT0_WERT'
    );
    assert.strictEqual(sel.remove(id), true);
    assert.strictEqual(sel.size, 1);
    assert.ok(
      !sel.has('MS450DS0', 'STATUS_MESSWERTBLOCK_0', 'STAT_MESSWERT0_WERT')
    );
    assert.ok(
      sel.has('MS450DS0', 'STATUS_MESSWERTBLOCK_0', 'STAT_MESSWERT1_WERT')
    );
    assert.strictEqual(sel.remove(id), false);
    ok('remove(id) drops one series and reports whether it was there');
  }

  console.log(`\nlogging: ${passed} checks passed`);
})().catch((e) => {
  console.error('\nlogging check FAILED');
  console.error(e);
  process.exit(1);
});
