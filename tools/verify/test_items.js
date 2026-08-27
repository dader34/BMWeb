#!/usr/bin/env node
// Live item bodies: INPA's keypress executed from the bytecode.
//
// ms450's adjust keys are the canonical LOSSY static decode: the menu items
// flatten to job+arg "0" (m_llco) or to the STOP job (m_system_llerh), and
// the real send -- clamp(setpoint+delta) -> START_SYSTEMCHECK_LLERH <n> --
// happens inside a helper the item calls. Driving the item body must produce
// INPA's exact wire traffic, and a second press must accumulate (one VM per
// module, globals persist).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { IpoVm, FeedHost } = require('../../app/renderer/core/ipovm.js');

const ROOT = path.join(__dirname, '..', '..');
const exec = JSON.parse(zlib.gunzipSync(fs.readFileSync(
  path.join(ROOT, 'data/chassis/E46/ms450ds0/ipoexec.json.gz'))));

let passed = 0;
const ok = (m) => { passed++; console.log(`  ok    ${m}`); };

const vm = new IpoVm(exec, { budget: 800000, wireJobs: true,
                             host: new FeedHost() });
const drive = (step) => {
  const sent = [];
  for (let n = 0; n < 200 && step && step.kind !== 'done'; n++) {
    if (step.kind === 'job') {
      sent.push([step.job, step.arg || '']);
      step = vm.resume(new Map([['JOB_STATUS', 'OKAY']]));
    } else if (step.kind === 'wait') {
      step = vm.resume();
    } else break;
  }
  assert.ok(step && step.kind === 'done', `body did not finish (${step && step.kind})`);
  return sent;
};
const item = (menu, nr) => drive(vm.stepStartItem(menu, nr));

// ---- LLERH: +10 twice, then +100, then -10 ---------------------------------
{
  const first = exec.procs.m_system_llerh.findIndex((t) => t.op === 'ITEM');
  drive(vm.stepStartRange('m_system_llerh', 0, first));   // prologue
  assert.deepStrictEqual(item('m_system_llerh', 1),
    [['STOP_SYSTEMCHECK_LLERH', ''], ['START_SYSTEMCHECK_LLERH', '10']],
    '+10 must stop, then start with the computed setpoint');
  assert.deepStrictEqual(item('m_system_llerh', 1).pop(),
    ['START_SYSTEMCHECK_LLERH', '20'], 'a second +10 must accumulate to 20');
  assert.deepStrictEqual(item('m_system_llerh', 3).pop(),
    ['START_SYSTEMCHECK_LLERH', '120'], '+100 on top must send 120');
  assert.deepStrictEqual(item('m_system_llerh', 2).pop(),
    ['START_SYSTEMCHECK_LLERH', '110'], '-10 must send 110');
  ok('LLERH: +10, +10, +100, -10 -> 10, 20, 120, 110 (clamped setpoint, one VM)');
}

// ---- CO trim: the "+" that used to decode as CO_PERC=0 ---------------------
{
  const sent1 = item('m_llco', 1);
  assert.strictEqual(sent1.length, 1);
  assert.strictEqual(sent1[0][0], 'STEUERN_CO_ABGLEICH_VERSTELL');
  assert.notStrictEqual(sent1[0][1], '0',
    'the "+" key must not send the flattened arg 0');
  const v1 = parseInt(sent1[0][1], 10);
  const sent2 = item('m_llco', 3);                       // "+ +", bigger step
  const v2 = parseInt(sent2[0][1], 10);
  assert.ok(v2 > v1, `"++" (${v2}) must step further than "+" (${v1})`);
  const sent3 = item('m_llco', 2);                       // "--"
  const v3 = parseInt(sent3[0][1], 10);
  assert.ok(v3 < v2, `"--" (${v3}) must step back down from ${v2}`);
  ok(`CO trim: + -> ${v1}, ++ -> ${v2}, -- -> ${v3} (computed, accumulating)`);
}

// ---- Select ("Ausw"): the inputint prompt feeds the absolute target --------
{
  const vm2 = new IpoVm(exec, { budget: 800000, wireJobs: true,
                                host: new FeedHost() });
  const sent = [];
  let prompt = null;
  let step = vm2.stepStartItem('m_system_llerh', 6);
  for (let n = 0; n < 100 && step && step.kind !== 'done'; n++) {
    if (step.kind === 'input') {
      prompt = { texts: step.prompts, lo: step.lo, hi: step.hi };
      step = vm2.resume(850);
    } else if (step.kind === 'job') {
      sent.push([step.job, step.arg || '']);
      step = vm2.resume(new Map([['JOB_STATUS', 'OKAY']]));
    } else if (step.kind === 'wait') step = vm2.resume();
    else break;
  }
  assert.ok(prompt, 'Select never asked for a value');
  assert.ok(/Request set value idle speed/.test(prompt.texts[0]),
    `wrong prompt: ${JSON.stringify(prompt)}`);
  assert.deepStrictEqual(prompt.lo, 0);
  assert.deepStrictEqual(prompt.hi, 1999);
  assert.deepStrictEqual(sent,
    [['STOP_SYSTEMCHECK_LLERH', ''], ['START_SYSTEMCHECK_LLERH', '850']],
    'the typed 850 must become the START argument');
  ok('Select: prompts INPA\'s inputint (0..1999), 850 -> START_SYSTEMCHECK_LLERH 850');
}

console.log(`\nitems: ${passed} checks passed`);
