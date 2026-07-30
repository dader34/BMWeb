#!/usr/bin/env node
// The write guard must hold: a job that CHANGES the ECU does not transmit
// unless the caller opted in.
//
// This exists because the guard is one `if` protecting real hardware, and
// an `if` is easy to delete during a refactor without anyone noticing --
// nothing else in the suite would fail. The interesting assertion is not
// "it throws" but "it throws having sent NOTHING", including the implicit
// INITIALISIERUNG that runs before every job.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ctx = { module: { exports: {} }, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/renderer/bestvm.js'),
                                'utf8'), ctx);
const { Best2Vm, isWriteJob } = ctx.module.exports;

let failures = 0;
function check(what, ok) {
  if (!ok) { failures++; console.log(`  FAIL  ${what}`); }
  else console.log(`  ok    ${what}`);
}

// ---- classification, including the pairs that must NOT be confused
for (const [name, want] of [
  ['STATUS_UBATT', false], ['IDENT', false], ['FS_LESEN', false],
  ['CODIERUNG_LESEN', false], ['MESSWERTBLOCK_LESEN', false],
  ['FS_LOESCHEN', true], ['STEUERN_E_LUEFTER', true],
  ['ADAP_SELEKTIV_LOESCHEN', true], ['CODIERUNG_SCHREIBEN', true],
  ['ECU_CONFIG_RESET', true], ['STEUERGERAETE_RESET', true],
]) {
  check(`${want ? 'write' : 'read '} ${name}`, isWriteJob(name) === want);
}

// ---- behaviour, against a real job with real captured telegrams
const codeP = path.join(ROOT, 'data/job-code/ms450ds0.json');
const fixP = path.join(ROOT, 'data/sim-captures/vmfix.json');
if (fs.existsSync(codeP) && fs.existsSync(fixP)) {
  const code = JSON.parse(fs.readFileSync(codeP, 'utf8'));
  const tp = path.join(ROOT, 'data/sgbd-tables/ms450ds0.json');
  const tables = fs.existsSync(tp) ? JSON.parse(fs.readFileSync(tp, 'utf8')) : {};
  const fix = JSON.parse(fs.readFileSync(fixP, 'utf8'));
  const c = fix.cases.find((x) => x.sgbd === 'ms450ds0'
    && x.job === 'FS_LOESCHEN');
  if (c) {
    const byReq = new Map((c.telegrams || []).map(
      (t) => [String(t.request), t.response]));
    const lastResp = (c.telegrams || []).slice(-1)[0]?.response || [];
    let sent = 0;
    const mk = (opts) => new Best2Vm(code, Object.assign({
      tables,
      send: (r) => { sent++; return byReq.get(String(Array.from(r))) ?? lastResp; },
    }, opts));

    sent = 0;
    let threw = false;
    try { mk({}).run('FS_LOESCHEN'); } catch (e) { threw = true; }
    check('write job refused by default', threw);
    check('NOTHING transmitted before the refusal', sent === 0);

    sent = 0;
    const sets = mk({ allowWrites: true }).run('FS_LOESCHEN');
    check('write job runs when opted in', sent > 0
      && Object.assign({}, ...sets).JOB_STATUS === 'OKAY');

    sent = 0;
    mk({}).run('STATUS_MESSWERTBLOCK_0');
    check('read job unaffected without the flag', sent > 0);
  }
}

console.log(failures ? `\n${failures} FAILURES` : '\nwrite guard holds');
process.exit(failures ? 1 : 0);
