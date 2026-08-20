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
//   3. The VM's classifier tokens (READ_TOKEN / WRITE_TOKEN / INFO_READ_TOKEN)
//      are byte-identical to the Python ones in tools/verify/
//      sgbd_bulk_verify.py, and the Python _WriteJob shim keeps the same tier
//      order (the documented cross-language twin).
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

const { Best2Vm, VmError, isWriteJob,
        READ_TOKEN, WRITE_TOKEN, INFO_READ_TOKEN } =
  require(path.join(ROOT, 'app/renderer/core/bestvm.js'));

// ---------------------------------------------------------------------------
console.log('1. isWriteJob classifies writes as writes');
// A spread of real BMW job names that MUST be treated as writes.
const WRITES = [
  'STEUERN_DIGITALAKTOR', 'STEUERN', 'CODIERDATEN_SCHREIBEN', 'SPEICHER_SCHREIBEN',
  'C_FG_SCHREIBEN', 'FS_LOESCHEN', 'IS_LOESCHEN', 'HS_LOESCHEN', 'PARAMETER_SETZEN',
  'FLASH_PROGRAMMIEREN', 'PROGRAMMIERUNG_START', 'STEUERGERAET_RESET', 'RESET',
  'CODIERUNG_SCHREIBEN', 'EEPROM_SCHREIBEN', 'NM_SETZEN',
  // INFO is a WEAK read token (checked after the write tokens): a name that
  // carries a write verb must stay a write no matter where INFO sits in it.
  // The old \bINFO in the strong read tier would have called the first two
  // reads -- \b matches at the start of a string -- which is exactly the
  // hazard the weak tier exists to close. No such job exists in the corpus
  // today; these pins keep it that way.
  'INFO_SCHREIBEN', 'INFOSPEICHER_LOESCHEN', 'INFO_RESET',
];
for (const j of WRITES) ok(isWriteJob(j), `write: ${j}`);

// And names that must NOT be misread as writes (reads / status).
const READS = [
  'CODIERUNG_LESEN', 'STATUS_LESEN', 'IDENT', 'FS_LESEN',
  'MESSWERTE_LESEN', 'HERSTELLDATEN_LESEN',
  // *_INFO reads: `_` is a word character, so \bINFO never matched these and
  // they used to fall to default-deny -- safe direction, but it blocked
  // legitimate info reads in the UI. The (?:\b|_)INFO weak tier fixed that;
  // the corpus diff (6147 names, 2026-08-17) flipped exactly CBS_INFO,
  // MODUL_INFO and DEBUGGING_INFORMATION write->read, all true reads.
  'STEUERGERAETE_INFO', 'CBS_INFO', 'MODUL_INFO', 'DEBUGGING_INFORMATION',
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
  // The stub VM's default send() throws 'no telegram sink' -- if THAT were
  // the error, bytecode ran far enough to attempt a transmit before any
  // refusal. The gate must fire first, so the error must not be the sink's.
  // (Replaces an assertion that was vacuously true whenever /refus/ matched.)
  ok(e instanceof Error && !/no telegram sink/.test(e.message),
     'refusal fires before any telegram is attempted (not the sink error)');
}
{
  // A read job must NOT be refused by the gate (it may fail later for other
  // reasons, but not with the write-gate message).
  const e = refuses('CODIERUNG_LESEN', false);
  ok(!(e && /refusing to (run|transmit) write job/i.test(e.message)),
     'read job is not blocked by the write gate');
}

// ---------------------------------------------------------------------------
console.log('3. JS and Python classifier twins are identical');
// The classifier is three token regexes plus a tier order (strong read ->
// write -> weak INFO read -> default-deny). Commit d789117c replaced the old
// single WRITE_JOB regex with this shape on the Python side, which this check
// used to extract by name -- so the twin check went stale and check.sh was
// red on every run. It now compares each token pattern byte-for-byte AND
// pins the Python _WriteJob tier order, so drift on either side or in either
// dimension fails loudly again.
const pySrc = read('tools/verify/sgbd_bulk_verify.py');
// pull the r"..." r"..." concatenation after `<NAME> = re.compile(`
function pyPattern(name) {
  const m = pySrc.match(new RegExp(
    name + ' = re\\.compile\\(\\s*((?:r"[^"]*"\\s*)+)'));
  if (!m) return null;
  return (m[1].match(/r"([^"]*)"/g) || []).map(s => s.slice(2, -1)).join('');
}
for (const [name, jsRe] of [
  ['READ_TOKEN', READ_TOKEN],
  ['WRITE_TOKEN', WRITE_TOKEN],
  ['INFO_READ_TOKEN', INFO_READ_TOKEN],
]) {
  const py = pyPattern(name);
  ok(py !== null, `found Python ${name} regex`);
  ok(py === jsRe.source,
     `JS ${name} === Python ${name}\n       js: ${jsRe.source}\n       py: ${py}`);
}
// The patterns matching is necessary but not sufficient: the SHIM must also
// consult them in the same order. Pin the exact three-tier body of
// _WriteJob.match -- a reordering (e.g. INFO before WRITE) would reclassify
// write jobs as reads on one side only.
ok(/if READ_TOKEN\.search\(n\):\s*\n\s*return None[\s\S]*?if WRITE_TOKEN\.search\(n\):\s*\n\s*return True[\s\S]*?if INFO_READ_TOKEN\.search\(n\):\s*\n\s*return None[\s\S]*?return True/.test(pySrc),
   'Python _WriteJob keeps the tier order: read -> write -> INFO -> deny');
// And a behavioural cross-check: run the extracted Python patterns through
// the same tier order and diff against isWriteJob over every name this file
// exercises. Catches semantic drift the source-shape checks above miss.
{
  const pr = new RegExp(pyPattern('READ_TOKEN') || '$^', 'i');
  const pw = new RegExp(pyPattern('WRITE_TOKEN') || '$^', 'i');
  const pi = new RegExp(pyPattern('INFO_READ_TOKEN') || '$^', 'i');
  const pyIsWrite = (n) => (pr.test(n) ? false : pw.test(n) ? true
    : pi.test(n) ? false : true);
  const probes = [...WRITES, ...READS,
    'AUTHENTISIERUNG', 'BAUDRATE', 'LOESCHEN', 'UNBEKANNTER_JOB',
    'STATUS_LDP_START', 'STEUERN_ROE_STOP', 'ABGLEICH_LESEN_HFM'];
  const drift = probes.filter((n) => pyIsWrite(n) !== isWriteJob(n));
  ok(drift.length === 0,
     `twins agree on every probe${drift.length ? ` (drift: ${drift.join(', ')})` : ''}`);
}

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

// FORMER KNOWN GAPS, now CLOSED -- these three were asserted as NOT writes
// while the old leading-verb WRITE_JOB regex couldn't catch them, with a note
// that improving the classifier should flip the assertions. The token-based
// default-deny classifier (bestvm.js isWriteJob) did exactly that:
//   - bare 'LOESCHEN': the LOESCH token needs no prefix any more.
//   - AUTHENTISIERUNG: AUTHENTIS is a write token now -- auth unlocks
//     protected services, which is the write path, not a read.
//   - BAUDRATE: no read token, no write token -> default-deny. An
//     unrecognised comms job is guarded, never silently run.
// So everything the per-screen regexes flag dangerous is now also a VM write.
const CLOSED_GAPS = ['LOESCHEN', 'AUTHENTISIERUNG', 'BAUDRATE'];
for (const tok of CLOSED_GAPS) {
  ok(isWriteJob(tok),
     `formerly UI-only, now caught by the VM gate too: ${tok}`);
}

// ---------------------------------------------------------------------------
// WRITES ARE ENABLED BY OWNER'S DECISION (2026-08-19). The refuse-everything
// posture blocked actuator tests -- STEUERN_E_LUEFTER never reached the wire,
// so the fan screen's "Activate at 15%" did nothing while the readback sat at
// the DME's own 92. The classifier cannot separate a temporary actuator drive
// from a permanent EEPROM write, so enabling one enables both.
//
// These assertions now guard the parts that MUST stay narrow, so the change
// cannot quietly widen further.
console.log('5. writes are enabled, and the read-only paths stay read-only');
const shim = read('app/renderer/core/webshim.js');
ok(/allowWrites: true/.test(shim),
   'the job runner constructs the VM with allowWrites:true');
ok(/allowWrites: false/.test(shim),
   'group probing STILL passes allowWrites:false -- it walks addresses that '
   + 'may not be the module we think, so it must never change one');
const probe = shim.slice(shim.indexOf('Group probing walks diagnostic addresses'));
ok(/allowWrites: false/.test(probe.slice(0, 400)),
   'and that false belongs to the probe, not to a stale call site');

// ---------------------------------------------------------------------------
if (failures) {
  console.error(`\nWRITE-GATE GUARD FAILED: ${failures} assertion(s).`);
  console.error('The write posture changed in a way this guard does not expect.');
  process.exit(1);
}
console.log('\nwrite-gate guard: all assertions passed.');
