#!/usr/bin/env node
// BMW-FAST framing on a real E46 MS45: which checksum, which length, and who
// owns the short->long fallback.
//
// EVERY FIXTURE IS REAL WIRE DATA, captured by tracing EDIABAS itself against
// the car (IfhTrace=3, tools/verify + BMACW_IFH_TRACE):
//
//   Send: 82 12 F1 1A 80 1F          -> echo, "*** No header received", IFH-0009
//   Send: B8 12 F1 02 1A 80 C3       -> B8 F1 12 1F 5A 80 ...   (36 bytes)
//   Send: B8 12 F1 04 18 02 FF FF 45 -> B8 F1 12 1A 58 08 29 9A 88 ...
//
// Three separate rules fall out of that, and each was got wrong at least once:
//   1. the checksum follows the FRAME FORM (82 = sum8, B8 = XOR)
//   2. a B8 frame's length is BYTE 3, not the low 6 bits
//   3. the fallback belongs to the SGBD, not the transport

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
let failures = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } };
const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');

const src = fs.readFileSync(path.join(ROOT, 'app/renderer/core/webshim.js'), 'utf8');
const grab = (name) => {
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('could not find ' + name);
  return m[0];
};
const sandbox = new Function(
  grab('withChecksum') + '\n' + grab('frameTotal') + '\n' + grab('verifyChecksum') + '\n' +
  'const conceptOf = (comm) => (comm && comm.concept) || 0x10f;\n' +
  'const isDs2 = (c) => c === 1 || c === 5 || c === 6;\n' +
  'const isIso9141 = (c) => c === 0x10c;\n' +
  'const ifhError = (c, m) => Object.assign(new Error(c + ": " + m), { ifh: c });\n' +
  'return { withChecksum, frameTotal, verifyChecksum };')();

console.log('1. the checksum follows the FRAME FORM');
{
  const sign = (b, c) => sandbox.withChecksum(b, { concept: c || 0x10f });
  ok(hex(sign([0x82, 0x12, 0xf1, 0x1a, 0x80])) === '82 12 f1 1a 80 1f',
     'short form is sum8: 82 12 f1 1a 80 1f');
  ok(hex(sign([0xb8, 0x12, 0xf1, 0x02, 0x1a, 0x80])) === 'b8 12 f1 02 1a 80 c3',
     'long form is XOR:  b8 12 f1 02 1a 80 c3');
  ok(hex(sign([0xb8, 0x12, 0xf1, 0x04, 0x18, 0x02, 0xff, 0xff]))
       === 'b8 12 f1 04 18 02 ff ff 45',
     'long FS_LESEN:     b8 12 f1 04 18 02 ff ff 45');
  ok(hex(sign([0x12, 0x04, 0x00], 0x06)) === '12 04 00 16',
     'a DS2 telegram is XOR by concept: 12 04 00 16');

  // The two ways this was got wrong, both of which the ECU answers with silence.
  const shortXor = [0x82, 0x12, 0xf1, 0x1a, 0x80].reduce((a, b) => a ^ b, 0);
  const longSum = [0xb8, 0x12, 0xf1, 0x02, 0x1a, 0x80].reduce((a, b) => (a + b) & 0xff, 0);
  ok(shortXor === 0xfb, 'signing the short form XOR would give 0xfb (wrong)');
  ok(longSum === 0x57, 'signing the long form sum8 would give 0x57 (wrong)');
}

console.log('\n2. a 0xB8 frame is sized from BYTE 3');
{
  // The car's ident reply is exactly 36 bytes and byte[3] = 0x1F = 31.
  ok(sandbox.frameTotal([0xb8, 0xf1, 0x12, 0x1f], {}) === 36,
     'ident reply: 4 + 31 + 1 = 36');
  ok(sandbox.frameTotal([0xb8, 0xf1, 0x12, 0x1a], {}) === 31,
     'fault reply: 4 + 26 + 1 = 31');
  ok((0xb8 & 0x3f) + 4 === 60,
     'the low-6-bits reading would say 60 and time out -- the bug this guards');
  ok(sandbox.frameTotal([0x82, 0xf1, 0x12, 0x1a], {}) === 6,
     'the short form is unaffected: 2 + 4 = 6');
}

console.log('\n3. checksums verify with the same rule');
{
  let threw = null;
  try { sandbox.verifyChecksum([0xb8, 0x12, 0xf1, 0x02, 0x1a, 0x80, 0xc3], { concept: 0x10f }); }
  catch (e) { threw = e; }
  ok(threw === null, 'an XOR-signed 0xB8 frame passes');
  let threw2 = null;
  try { sandbox.verifyChecksum([0xb8, 0x12, 0xf1, 0x02, 0x1a, 0x80, 0x57], { concept: 0x10f }); }
  catch (e) { threw2 = e; }
  ok(threw2 !== null, 'a sum8 checksum on a 0xB8 frame is rejected');
}

console.log('\n4. the SGBD owns the fallback, not the transport');
{
  // The VM holds BOTH telegrams as constants and branches on f.zero, which it
  // sets from the answer length. So a silent ECU must come back as an EMPTY
  // ANSWER; throwing killed the job before the second telegram was ever sent.
  ok(!/toLongForm/.test(src),
     'the transport does NOT rewrite telegrams behind the VM');
  ok(/err\.ifh === 'IFH-0009' \|\| err\.ifh === 'IFH-0003'/.test(src),
     'a silent ECU (0009) AND a failed echo (0003) both become an empty answer');
  ok(/else throw err;/.test(src),
     'and every OTHER interface error still throws');
  const guard = src.slice(src.indexOf('A SILENT ECU IS AN ANSWER OF ZERO BYTES'));
  ok(/answers\.set\(missing\.key, answer\)/.test(guard),
     'the empty answer is memoised like any other');
}

console.log(failures ? `\nFAILED (${failures})` : '\nAll BMW-FAST framing checks passed');
process.exit(failures ? 1 : 0);
