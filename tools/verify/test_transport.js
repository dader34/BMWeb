#!/usr/bin/env node
// The wire contract: framing, checksums, port settings and session
// semantics -- the layer between the VM and the cable.
//
// This exists because none of it is covered elsewhere. test_bestvm replays
// captured answers, so it never frames a request; the write guard watches
// what leaves the VM, not what reaches the wire. Everything below is
// checked against data/sim-captures, which came off real cars: a DS2 answer
// XOR-verifies, a KWP2000* answer sum8-verifies, and their length bytes say
// where each frame ends. Get any of it wrong and every request is silently
// discarded by the ECU -- which is exactly the bug this file was written
// after.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

// webshim.js is a browser file: it ends by touching `window`. Take the pure
// helpers, which is everything above the first class.
const src = fs.readFileSync(path.join(ROOT, 'app/renderer/core/webshim.js'),
                            'utf8');
const helpers = src.slice(0, src.indexOf('class NativeSerialBus'));
const ctx = { exports: {}, console, Date, setTimeout, Error };
vm.createContext(ctx);
vm.runInContext(`${helpers}
  exports.withChecksum = withChecksum;
  exports.frameTotal = frameTotal;
  exports.verifyChecksum = verifyChecksum;
  exports.portConfig = portConfig;
  exports.isResponsePending = isResponsePending;
  exports.ifhError = ifhError;`, ctx);
const { withChecksum, frameTotal, verifyChecksum, portConfig,
        isResponsePending } = ctx.exports;

// the VM, for the xsetpar -> comm contract
const vmCtx = { module: { exports: {} }, console };
vm.createContext(vmCtx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/renderer/core/bestvm.js'),
                                'utf8'), vmCtx);
const { Best2Vm } = vmCtx.module.exports;

let failures = 0;
function check(what, ok) {
  if (!ok) { failures++; console.log(`  FAIL  ${what}`); }
  else console.log(`  ok    ${what}`);
}

const DS2 = { concept: 6, baud: 9600 };
const KWP = { concept: 0x10d, baud: 9600 };
const FAST = { concept: 0x10f, baud: 115200 };

// ---- checksums, against the shipped captures --------------------------

// DS2: XOR of everything before it. This request appears verbatim in
// data/sim-captures/aic.sim, where the length byte (04) counts the
// checksum -- so a correctly framed request is exactly `len` bytes long.
{
  const framed = withChecksum([0xE8, 0x04, 0x00], DS2);
  check('DS2 request gains its XOR checksum',
        framed.length === 4 && framed[3] === (0xE8 ^ 0x04 ^ 0x00));
  check('DS2 framed length matches its own length byte',
        framed.length === framed[1]);
}

// The DS2 answer from aic.sim, which must verify and self-describe.
{
  const ans = [0xE8, 0x11, 0xA0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
               0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0x48];
  check('DS2 answer total comes from byte 1', frameTotal(ans, DS2) === 17);
  let threw = false;
  try { verifyChecksum(ans, DS2); } catch { threw = true; }
  check('DS2 captured answer passes its checksum', !threw);
  const bad = ans.slice(); bad[bad.length - 1] ^= 0xff;
  let caught = null;
  try { verifyChecksum(bad, DS2); } catch (e) { caught = e; }
  check('a corrupt DS2 answer is rejected, as IFH-0019',
        caught && caught.ifh === 'IFH-0019');
}

// KWP2000* / BMW-FAST: additive sum8 -- EXCEPT a 0xB8 frame, which is XOR.
// Both rules are real bytes from EDIABAS's trace against an E46 MS45:
//   82 12 F1 1A 80 1F        (short form, sum8)
//   B8 12 F1 02 1A 80 C3     (long form,  XOR -- sum8 would be 0x57)
// This block used a 0xB8 frame as its sum8 example, which the car disproves.
{
  const req = [0x82, 0x12, 0xF1, 0x1A, 0x80];
  const framed = withChecksum(req, KWP);
  const want = req.reduce((a, b) => (a + b) & 0xff, 0);
  check('KWP2000* short-form request gains its sum8 checksum',
        framed.length === 6 && framed[5] === want && framed[5] === 0x1F);
  const long = withChecksum([0xB8, 0x12, 0xF1, 0x02, 0x1A, 0x80], KWP);
  check('a 0xB8 request is signed XOR instead (the car answers only this)',
        long[long.length - 1] === 0xC3);
  const ans = [0x9B, 0xF1, 0x12, 0x42, 0x1A, 0x80];
  check('KWP2000* answer length is byte 3 + 5',
        frameTotal(ans.concat(new Array(0x42)), KWP) === 0x42 + 5);
}

// BMW-FAST short form: 0x80|len, and the length lives in the low 6 bits.
{
  const fast = [0x82, 0x12, 0xF1, 0x1A, 0x80];
  const framed = withChecksum(fast, FAST);
  const want = fast.reduce((a, b) => (a + b) & 0xff, 0);
  check('BMW-FAST request gains its sum8 checksum', framed[5] === want);
  check('BMW-FAST short-form total is len + 4 + 1',
        frameTotal(framed, FAST) === 6);
}

// An undecidable prefix must say "keep reading", never guess a length.
check('a 2-byte prefix does not yet decide a BMW-FAST frame',
      frameTotal([0x82, 0x12], FAST) === null);

// ---- port settings ----------------------------------------------------

// K-line concepts run 8E1 at the rate their CommParameter names, exactly as
// EdInterfaceObd does (case 0x0006: parity = Even, baudRate = param[1]).
check('DS2 runs 9600 8E1',
      portConfig(DS2).baudRate === 9600 && portConfig(DS2).parity === 'even');
check('KWP2000* runs 9600 8E1',
      portConfig(KWP).baudRate === 9600 && portConfig(KWP).parity === 'even');
check('BMW-FAST stays 115200 8N1',
      portConfig(FAST).baudRate === 115200
      && portConfig(FAST).parity === 'none');
check('an unknown concept falls back to BMW-FAST, not to nothing',
      portConfig(null).baudRate === 115200);

// ISO 9141 IS implemented now (5-baud slow init, see test_iso9141.js). It used
// to refuse with IFH-0018 here; that refusal is what made an E46 DME look
// unreachable when it answers fine once woken. Framing it must now succeed and
// share KWP's sum8.
{
  let caught = null;
  let framed = null;
  try { framed = withChecksum([0x68, 0x6A, 0xF1], { concept: 0x10c }); }
  catch (e) { caught = e; }
  check('ISO 9141 no longer refuses to frame a request', !caught);
  check('ISO 9141 frames with a sum8 checksum like KWP',
        framed && framed[framed.length - 1] === ((0x68 + 0x6A + 0xF1) & 0xff));
  check('ISO 9141 opens at 10400 8N1, not the K-line 9600 8E1',
        portConfig({ concept: 0x10c }).baudRate === 10400
        && portConfig({ concept: 0x10c }).parity === 'none');
}

// ---- response pending -------------------------------------------------
// 7F <service> 78 means "still working". Failing the job here is what made
// long routines look dead.
{
  const pend = [0x83, 0xF1, 0x12, 0x7F, 0x31, 0x78, 0x00];
  const done = [0x83, 0xF1, 0x12, 0x71, 0x31, 0x00, 0x00];
  check('7F..78 is recognised as response-pending',
        isResponsePending(pend, FAST) === true);
  check('a real answer is not mistaken for response-pending',
        isResponsePending(done, FAST) === false);
}

// ---- the VM -> transport contract -------------------------------------
// xsetpar is how an SGBD declares its wire. If the VM drops it, the
// transport has nothing to go on and every K-line ECU is unreachable.
{
  // ms450ds0's own INITIALISIERUNG blob: concept 6 (DS2), 9600 baud
  const blob = [0x06, 0x00, 0x80, 0x25, 0xb8, 0x00, 0x00, 0x00,
                0x00, 0x00, 0xf4, 0x01, 0x19, 0x00, 0x14, 0x00, 0x00, 0x00];
  const code = {
    format: 1, sgbd: 't', jobs: { T: 0 },
    ops: [['xsetpar', [[8, 0]]], ['xsend', [[1, 'S1'], [8, 1]]], ['eoj', []]],
    strings: [blob, [0x12, 0x34]],
  };
  let seen = null;
  const v = new Best2Vm(code, { send: (out, comm) => { seen = comm; return []; },
                              allowWrites: true });  // testing the wire, not the write gate
  try { v.run('T', ''); } catch { /* eoj/decode is not the point */ }
  check('xsetpar reaches send() as the concept',
        seen && seen.concept === 6);
  check('xsetpar reaches send() as the baud rate',
        seen && seen.baud === 9600);
}

// A dword-packed blob (the 0x1xx family) must not be read as 16-bit words,
// which would yield an absurd concept.
{
  const blob = [0x0d, 0x01, 0x00, 0x00, 0x80, 0x25, 0x00, 0x00,
                0xf4, 0x01, 0x00, 0x00, 0x19, 0x00, 0x00, 0x00];
  const code = {
    format: 1, sgbd: 't', jobs: { T: 0 },
    ops: [['xsetpar', [[8, 0]]], ['xsend', [[1, 'S1'], [8, 1]]], ['eoj', []]],
    strings: [blob, [0x12, 0x34]],
  };
  let seen = null;
  const v = new Best2Vm(code, { send: (out, comm) => { seen = comm; return []; },
                              allowWrites: true });  // testing the wire, not the write gate
  try { v.run('T', ''); } catch { /* not the point */ }
  check('a dword CommParameter decodes as KWP2000* at 9600',
        seen && seen.concept === 0x10d && seen.baud === 9600);
}

// `wait` paces the bus. It cannot sleep inside a synchronous VM, so it has
// to arrive at the transport instead of vanishing.
{
  const code = {
    format: 1, sgbd: 't', jobs: { T: 0 },
    ops: [['wait', [[7, 50]]], ['xsend', [[1, 'S1'], [8, 0]]], ['eoj', []]],
    strings: [[0x12, 0x34]],
  };
  let seen = null;
  const v = new Best2Vm(code, { send: (out, comm) => { seen = comm; return []; },
                              allowWrites: true });  // testing the wire, not the write gate
  try { v.run('T', ''); } catch { /* not the point */ }
  check('wait is carried to the transport as waitMs',
        seen && seen.waitMs === 50);
}

console.log(failures ? `\n${failures} FAILED` : '\ntransport holds');
process.exit(failures ? 1 : 0);
