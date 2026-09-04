#!/usr/bin/env node
// The guided-procedure engine, driven offline against real bytecode.
//
// S_ZUHEIZ's Pruefung is the canonical activate-then-observe machine. The
// driver must: suspend on EVERY job (wireJobs), honour the builtin_1b waits
// (2000ms settle, 10000ms run-on), serve wire results back through FeedHost,
// resolve the segment-relative jumps past the state labels (the teardown was
// unreachable before _segRemap), and surface the Weiter key's guard flag.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const {
  IpoVm,
  FeedHost,
  scanQuitBox,
} = require('../../app/renderer/core/ipovm.js');

const ROOT = path.join(__dirname, '..', '..');
const load = (p) =>
  JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, p))));

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

// ---- 1. the full Pruefung lifecycle, scripted -------------------------------
{
  const exec = load('data/chassis/other/s_zuheiz/ipoexec.json.gz');
  const texts = [];
  const vm = new IpoVm(exec, {
    budget: 800000,
    wireJobs: true,
    host: new FeedHost(),
    onText: (t) => texts.push(t),
  });
  const jobs = [];
  const waits = [];
  const states = [];
  let guardSeen = null,
    pressed = false;
  let step = vm.stepStart('Pruefung');
  for (let n = 0; n < 200 && step && step.kind !== 'done'; n++) {
    if (step.kind === 'job') {
      jobs.push([step.job, step.arg || '']);
      const fed = new Map([['JOB_STATUS', 'OKAY']]);
      if (step.job === 'STARTZAEHLER_LESEN') fed.set('STARTZAEHLER', '7');
      step = vm.resume(fed);
    } else if (step.kind === 'wait') {
      waits.push(step.ms);
      step = vm.resume();
    } else {
      states.push(step.name);
      const guards = vm.pendingGuards();
      if (guards.size && !pressed) {
        guardSeen = [step.name, [...guards]];
        guards.forEach((g) => vm.pressKey(g));
        pressed = true;
      }
      step = vm.resume();
    }
  }
  assert.strictEqual(step && step.kind, 'done', 'the machine never finished');
  const names = jobs.map(([j]) => j);
  // preparation, in order
  assert.ok(
    names.includes('DIAGNOSE_TESTBIT'),
    'DIAGNOSE_TESTBIT never reached the wire (non-STEUERN jobs must suspend)'
  );
  assert.deepStrictEqual(
    jobs.find(([j]) => j === 'STEUERN_WASSERVENTIL'),
    ['STEUERN_WASSERVENTIL', '100;100'],
    'the water-valve drive lost its 100;100 argument'
  );
  // the heater goes ON after the first counter read...
  const onIdx = jobs.findIndex(
    ([j, a]) => j === 'STEUERN_STANDHEIZUNG' && a === 'EIN'
  );
  assert.ok(
    onIdx > names.indexOf('STARTZAEHLER_LESEN'),
    'heater ON before the counter read'
  );
  // ...and the TEARDOWN runs (unreachable before the segment-relative jump fix)
  assert.ok(
    jobs.some(
      ([j, a]) =>
        j === 'STEUERN_STANDHEIZUNG' &&
        a === 'AUS' &&
        jobs.indexOf(jobs.find(([jj, aa]) => jj === j && aa === a)) >= 0
    ),
    'no heater AUS at all'
  );
  assert.ok(
    jobs.filter(([j]) => j === 'STARTZAEHLER_LESEN').length >= 2,
    'the second (teardown) counter read never ran'
  );
  assert.ok(
    jobs.some(([j, a]) => j === 'DIAGNOSE_TESTBIT' && a === 'AUS'),
    'DIAGNOSE_TESTBIT AUS (teardown) never ran'
  );
  assert.ok(
    waits.includes(2000) && waits.includes(10000),
    `the 2000/10000ms waits were skipped (${waits})`
  );
  assert.ok(
    states.includes('%STOP_PHASE') && states.includes('%NACHBEREITUNG'),
    `teardown states unreachable (${states})`
  );
  assert.ok(
    pressed &&
      guardSeen &&
      guardSeen[0] === '%NACHBEREITUNG' &&
      guardSeen[1].includes(33),
    `the Weiter guard (slot 33 at %NACHBEREITUNG) was not offered: ${JSON.stringify(guardSeen)}`
  );
  ok(
    `Pruefung: ${jobs.length} jobs, waits ${JSON.stringify([...new Set(waits)])}, ` +
      `states ${[...new Set(states)].join(' ')}, Weiter pressed`
  );

  // the counter fed through FeedHost surfaced in the machine's own print
  assert.ok(
    texts.some((t) => /Startz\u00e4hler : 7|Startzähler : 7/.test(t)),
    `the fed STARTZAEHLER=7 never surfaced in the prints:\n${texts.join('\n')}`
  );
  ok('FeedHost + onText: "Zuheizer : Startzähler : 7" printed by the machine');
}

// ---- 2. offline parity: wireJobs off keeps the old shape --------------------
{
  const exec = load('data/chassis/other/s_zuheiz/ipoexec.json.gz');
  const vm = new IpoVm(exec, { budget: 800000 });
  const step = vm.stepStart('Pruefung');
  assert.strictEqual(
    step.kind,
    'yield',
    'without wireJobs the machine must park at its first %STATE as before'
  );
  ok('parity: wireJobs off still parks at the first yield');
}

// ---- 3. the quit-box scan on ZKE5 -------------------------------------------
{
  const exec = load('data/chassis/E46/zke5/ipoexec.json.gz');
  const qb = scanQuitBox(exec.procs['sm_steuern']);
  assert.ok(qb, 'sm_steuern has a quit box and the scan missed it');
  assert.strictEqual(
    qb.slot,
    29,
    `quit flag should be slot 29, got ${qb.slot}`
  );
  assert.strictEqual(qb.title, 'ACTIVATED DIGITAL VALUE');
  assert.strictEqual(qb.prefix, 'Signal : ');
  ok('quit box: slot 29, "ACTIVATED DIGITAL VALUE / Signal : <ORT>"');
  assert.strictEqual(scanQuitBox(exec.procs['inpainit'] || []), null);
  ok('quit box: a machine without the idiom returns null');
}

console.log(`\nguided: ${passed} checks passed`);
