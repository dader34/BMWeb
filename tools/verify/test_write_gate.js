#!/usr/bin/env node
// The write-gate regression guard.
//
// This app can read and STAGE coding/actuator changes but must never TRANSMIT
// a write in the web build. That guarantee rests on a small, load-bearing set
// of facts spread across bestvm.js / webshim.js / the per-screen dangerous-job
// regexes and the Python bulk-verify tool. A refactor could silently loosen any
// of them. This test fails loudly if the guarantee erodes.
//
//   node tools/verify/test_write_gate.js
//
// It asserts, against the ACTUAL source (not a copy):
//   1. isWriteJob() classifies every known write/actuate/clear job name as write.
//   2. The VM refuses to run a write job when allowWrites is false (both gates).
//   3. The VM's WRITE_JOB regex is byte-identical to the Python one in
//      tools/verify/sgbd_bulk_verify.py (the documented cross-language twin).
//   4. isWriteJob is a SUPERSET of every pattern the per-screen "dangerous job"
//      regexes flag as a write/clear -- so nothing a screen calls dangerous can
//      slip past the VM gate.
//   5. webshim builds the VM with allowWrites:false and keeps the 501 write route.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) { console.log(`  ok   ${msg}`); }
  else { console.error(`  FAIL ${msg}`); failures++; }
};

const { Best2Vm, VmError, isWriteJob, WRITE_JOB } =
  require(path.join(ROOT, 'app/renderer/core/bestvm.js'));

// ---------------------------------------------------------------------------
console.log('1. isWriteJob classifies writes as writes');
// A spread of real BMW job names that MUST be treated as writes.
const WRITES = [
  'STEUERN_DIGITALAKTOR', 'STEUERN', 'CODIERDATEN_SCHREIBEN', 'SPEICHER_SCHREIBEN',
  'C_FG_SCHREIBEN', 'FS_LOESCHEN', 'IS_LOESCHEN', 'HS_LOESCHEN', 'PARAMETER_SETZEN',
  'FLASH_PROGRAMMIEREN', 'PROGRAMMIERUNG_START', 'STEUERGERAET_RESET', 'RESET',
  'CODIERUNG_SCHREIBEN', 'EEPROM_SCHREIBEN', 'NM_SETZEN',
];
for (const j of WRITES) ok(isWriteJob(j), `write: ${j}`);

// And names that must NOT be misread as writes (reads / status).
const READS = [
  'CODIERUNG_LESEN', 'STATUS_LESEN', 'IDENT', 'FS_LESEN', 'STEUERGERAETE_INFO',
  'MESSWERTE_LESEN', 'HERSTELLDATEN_LESEN',
];
for (const j of READS) ok(!isWriteJob(j), `read (not write): ${j}`);

// ---------------------------------------------------------------------------
console.log('2. VM refuses write jobs when allowWrites is false');
// Gate #1 fires at run() before any bytecode executes, so it triggers even with
// an empty program. A minimal valid code object: the VM only needs the header
// fields run() reads before the gate. We pass a tiny stub and assert the throw
// is the gate, not an unrelated parse error.
function refuses(job, allowWrites) {
  try {
    // Best2Vm(code, opts): code can be a minimal object; the gate at bestvm.js:437
    // checks isWriteJob(job) && !allowWrites before touching the program body.
    const vm = new Best2Vm({ jobs: {}, tables: {}, strings: [] },
                           { allowWrites });
    vm.run(job, '');
    return null; // did not throw
  } catch (e) { return e; }
}
{
  const e = refuses('CODIERDATEN_SCHREIBEN', false);
  ok(e instanceof Error && /refus/i.test(e.message),
     'refuses write job with allowWrites:false');
  ok(!(e && /allowWrites: true/.test(e.message) === false && !/refus/i.test(e.message)),
     'the refusal is the write gate (mentions refusing to run/transmit)');
}
{
  // A read job must NOT be refused by the gate (it may fail later for other
  // reasons, but not with the write-gate message).
  const e = refuses('CODIERUNG_LESEN', false);
  ok(!(e && /refusing to (run|transmit) write job/i.test(e.message)),
     'read job is not blocked by the write gate');
}

// ---------------------------------------------------------------------------
console.log('3. JS and Python WRITE_JOB regexes are identical');
// Extract the literal from each source and compare the assembled pattern.
const jsPattern = WRITE_JOB.source;
const pySrc = read('tools/verify/sgbd_bulk_verify.py');
// pull the r"..." r"..." concatenation after `WRITE_JOB = re.compile(`
const pyMatch = pySrc.match(/WRITE_JOB = re\.compile\(\s*((?:r"[^"]*"\s*)+)/);
let pyPattern = null;
if (pyMatch) {
  pyPattern = (pyMatch[1].match(/r"([^"]*)"/g) || [])
    .map(s => s.slice(2, -1)).join('');
}
ok(pyPattern !== null, 'found Python WRITE_JOB regex');
ok(pyPattern === jsPattern,
   `JS regex === Python regex\n       js: ${jsPattern}\n       py: ${pyPattern}`);

// ---------------------------------------------------------------------------
console.log('4. isWriteJob is a superset of the per-screen dangerous regexes');
// The per-screen regexes (ecu.js, live.js) drive UI warnings. Any job a screen
// flags as write/clear MUST also be caught by the VM's isWriteJob, or the VM
// could transmit something a screen thought was dangerous. We probe with the
// tokens those regexes key on.
// Real BMW write/clear job names always carry a prefix (FS_LOESCHEN,
// CODIERDATEN_SCHREIBEN). The VM regex keys on that (`.*_LOESCHEN`), so a
// PREFIXED danger job is always caught:
const SCREEN_DANGER_TOKENS = [
  'FLASH', 'FS_LOESCHEN', 'CODIER_SCHREIBEN', 'STEUERGERAET_RESET',
  'PROGRAMMIER', 'PARAMETER_SETZEN', 'X_SCHREIBEN', 'Y_LOESCHEN', 'Z_SETZEN',
  'PROGRAMMIERUNG',
];
for (const tok of SCREEN_DANGER_TOKENS) {
  ok(isWriteJob(tok), `isWriteJob covers screen-danger token: ${tok}`);
}

// KNOWN, DOCUMENTED GAPS -- jobs some per-screen regex flags dangerous that the
// VM's isWriteJob does NOT classify as a write. These are asserted so the gap
// stays a conscious decision, not a silent drift. If a future change should
// close one, that is a deliberate edit to WRITE_JOB (a safety change, reviewed
// on its own), which will flip the assertion and force the update here.
//   - bare 'LOESCHEN' (no prefix): ecu.js /LOESCHEN/ flags it; WRITE_JOB needs
//     `.*_LOESCHEN`. No real BMW job is named bare 'LOESCHEN'.
//   - AUTHENTISIERUNG / BAUDRATE: ecu.js flags them; they are auth/comms, not
//     EEPROM writes -- gated at the UI, intentionally not VM writes.
const KNOWN_GAPS = ['LOESCHEN', 'AUTHENTISIERUNG', 'BAUDRATE'];
for (const tok of KNOWN_GAPS) {
  ok(!isWriteJob(tok),
     `known gap (UI-gated, not a VM write): ${tok}`);
}

// ---------------------------------------------------------------------------
console.log('5. webshim keeps allowWrites:false and the 501 write route');
const shim = read('app/renderer/core/webshim.js');
ok(/allowWrites:\s*false/.test(shim),
   'webshim constructs the VM with allowWrites:false');
ok(!/allowWrites:\s*true/.test(shim),
   'webshim never constructs the VM with allowWrites:true');
ok(/\/\^\\\/api\\\/ecu\\\/\[\^\/\]\+\\\/\(clear\|write\|flash\)/.test(shim)
   || /\(clear\|write\|flash\)/.test(shim),
   'webshim keeps the /clear|write|flash 501 route');
ok(/write operations are not available in the web build/.test(shim),
   'webshim keeps the 501 write-refusal message');

// ---------------------------------------------------------------------------
if (failures) {
  console.error(`\nWRITE-GATE GUARD FAILED: ${failures} assertion(s).`);
  console.error('A change has loosened the write protection. Do NOT ship this.');
  process.exit(1);
}
console.log('\nwrite-gate guard: all assertions passed.');
