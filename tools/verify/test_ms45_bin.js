#!/usr/bin/env node
// Offline MS45 firmware-image validation math: CRC-32/MPEG-2 + RSA firmware
// signature + region/address math.
//
// The product code is C# (src/EdiabasMac/FlashService.cs, class Ms45Bin). This
// environment has no dotnet, so this harness (a) reimplements the SAME algorithm
// in JS and pins it against known-answer vectors, and (b) parses FlashService.cs
// and asserts the load-bearing constants/offsets/opcodes there match — so the JS
// reference cannot silently drift from the C# it stands in for.
//
// The offline validation covered here is the gate that MUST pass before the
// (UNVERIFIED) write path in FlashService sends any erase/write telegram.
//
// Cross-checked against terraphantm/MS45-Flasher (Checksums_Signatures.cs).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let failures = 0;
function check(what, ok) {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}`);
  } else console.log(`  ok    ${what}`);
}
function eqBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── constants (mirror Ms45Bin) ─────────────────────────────────────────────
const TUNE_BLOB_SIZE = 0x1d000;
const EXTERNAL_FLASH_SIZE = 0x100000;
const MPC_FLASH_SIZE = 0x70000;
const PROGRAM_BLOB_HOST_OFFSET = 0x60000;
const PROGRAM_BLOB_SIZE = 0x9ff40;
const EXTERNAL_FLASH_BASE = 0xfff00000;
const PARAM_CRC_SEGMENT_BASE = 0xffe40000;
const PARAM_SIG_SEGMENT_BASE = 0xfff40000;

const PARAM_CRC_STORED = 0x100,
  PARAM_CRC_SEG_TABLE = 0x104,
  PARAM_CRC_INITIAL = 0x110;
const PARAM_SIG_SEG_COUNT = 0x130,
  PARAM_SIG_SEG_STARTS = 0x134,
  PARAM_SIG_SEG_LENGTHS = 0x144;
const PARAM_SIG_STORED = 0x174,
  SIG_LENGTH = 64;

const PROG_CRC_P_STORED = 0x60000,
  PROG_CRC_P_INIT = 0x60004;
const PROG_CRC_P_S1S = 0x60008,
  PROG_CRC_P_S2S = 0x6000c,
  PROG_CRC_P_S1E = 0x60010,
  PROG_CRC_P_S2E = 0x60014;
const PROG_CRC_S_STORED = 0x60340,
  PROG_CRC_S_S1S = 0x60348,
  PROG_CRC_S_S1E = 0x6034c;
const PROG_CRC_S_S2S = 0x60350,
  PROG_CRC_S_S2E = 0x60354,
  PROG_CRC_S_INIT = 0x60358;
const PROG_SIG_SEG_COUNT = 0x60030,
  PROG_SIG_SEG_STARTS = 0x60034,
  PROG_SIG_SEG_LENGTHS = 0x6004c;
const PROG_SIG_STORED = 0x60074;

const FIRMWARE_MODULUS = BigInt(
  '8470472580328006956677424405159809178175955696534718361218518906571634405286747173565502454089691240931470915432212928785673566143706092135925769557255439'
);
const FIRMWARE_PRIVATE_EXPONENT = BigInt(
  '7260405068852577391437792347279836438436533454172615738187301919918543775959908116508429649500721130520546364846625732843778800986047617824899475327781303'
);

// ── endian ─────────────────────────────────────────────────────────────────
function readU32BE(b, o) {
  if (o < 0 || o + 4 > b.length)
    throw new RangeError(`readU32BE oob 0x${o.toString(16)}`);
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function writeU32BE(b, v, o) {
  v >>>= 0;
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}
function writeU32LE(b, v, o) {
  v >>>= 0;
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

// ── CRC-32/MPEG-2 ───────────────────────────────────────────────────────────
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let bit = 0; bit < 8; bit++)
      c =
        (c & 0x80000000) !== 0 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf, start, length, initial) {
  let crc = initial >>> 0;
  for (let i = start; i < start + length; i++)
    crc =
      (((crc << 8) & 0xffffff00) ^
        CRC32_TABLE[((crc >>> 24) & 0xff) ^ buf[i]]) >>>
      0;
  return crc >>> 0;
}

// ── RSA signing ──────────────────────────────────────────────────────────────
function md5(buf) {
  return new Uint8Array(
    crypto.createHash('md5').update(Buffer.from(buf)).digest()
  );
}
function modPow(base, exp, mod) {
  let r = 1n,
    b = base % mod;
  if (b < 0n) b += mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return r;
}
function bytesLEToBigInt(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}
function bigIntToBytesLE(value, outLen) {
  const o = new Uint8Array(outLen);
  let v = value;
  for (let i = 0; i < outLen; i++) {
    o[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return o;
}
function encodeSignatureBytes(le) {
  const o = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    o[4 * i] = le[4 * i + 3];
    o[4 * i + 1] = le[4 * i + 2];
    o[4 * i + 2] = le[4 * i + 1];
    o[4 * i + 3] = le[4 * i];
  }
  return o;
}
function signHashedFirmware(hash) {
  const m = bytesLEToBigInt(hash);
  const c = modPow(m, FIRMWARE_PRIVATE_EXPONENT, FIRMWARE_MODULUS);
  return encodeSignatureBytes(bigIntToBytesLE(c, 64));
}

// ── parameter (tune) blob ────────────────────────────────────────────────────
function computeParameterCrc(blob) {
  let crc = readU32BE(blob, PARAM_CRC_INITIAL);
  const count = readU32BE(blob, PARAM_CRC_SEG_TABLE);
  for (let i = 0; i < count; i++) {
    const s =
      readU32BE(blob, PARAM_CRC_SEG_TABLE + 4 + i * 8) - PARAM_CRC_SEGMENT_BASE;
    const e =
      readU32BE(blob, PARAM_CRC_SEG_TABLE + 8 + i * 8) - PARAM_CRC_SEGMENT_BASE;
    if (s < 0 || e < s || e >= blob.length)
      throw new RangeError('tune CRC seg out of bounds');
    crc = crc32(blob, s, e - s + 1, crc);
  }
  return crc;
}
function computeParameterSignature(blob) {
  const count = readU32BE(blob, PARAM_SIG_SEG_COUNT);
  const buf = [];
  for (let i = 0; i < count; i++) {
    const s =
      readU32BE(blob, PARAM_SIG_SEG_STARTS + i * 8) - PARAM_SIG_SEGMENT_BASE;
    const len = readU32BE(blob, PARAM_SIG_SEG_LENGTHS + i * 4);
    if (s < 0 || s + len > blob.length)
      throw new RangeError('tune sig seg out of bounds');
    for (let j = 0; j < len; j++) buf.push(blob[s + j]);
  }
  return signHashedFirmware(md5(buf));
}
function prepareTune(blob) {
  writeU32BE(blob, computeParameterCrc(blob), PARAM_CRC_STORED);
  blob.set(computeParameterSignature(blob), PARAM_SIG_STORED);
}
function validateTune(blob) {
  const stored = readU32BE(blob, PARAM_CRC_STORED);
  const computed = computeParameterCrc(blob);
  const sig = computeParameterSignature(blob);
  const sigOk = eqBytes(
    blob.slice(PARAM_SIG_STORED, PARAM_SIG_STORED + SIG_LENGTH),
    sig
  );
  return {
    stored,
    computed,
    crcOk: stored === computed,
    sigOk,
    ok: stored === computed && sigOk,
  };
}

// ── program blob ─────────────────────────────────────────────────────────────
function appendEcuRange(dst, ecuStart, length, external, mpc) {
  if (ecuStart >= EXTERNAL_FLASH_BASE) {
    const off = ecuStart - EXTERNAL_FLASH_BASE;
    if (off < 0 || off + length > external.length)
      throw new RangeError('external seg oob');
    for (let i = 0; i < length; i++) dst.push(external[off + i]);
  } else {
    const off = ecuStart;
    if (off + length > mpc.length) throw new RangeError('mpc seg oob');
    for (let i = 0; i < length; i++) dst.push(mpc[off + i]);
  }
}
function computeProgramCrc(external, mpc, initOff, s1s, s1e, s2s, s2e) {
  let crc = readU32BE(external, initOff);
  for (const [sOff, eOff] of [
    [s1s, s1e],
    [s2s, s2e],
  ]) {
    const s = readU32BE(external, sOff),
      e = readU32BE(external, eOff);
    const len = e - s + 1;
    if (len <= 0) throw new RangeError('prog CRC seg non-positive');
    const buf = [];
    appendEcuRange(buf, s, len, external, mpc);
    crc = crc32(buf, 0, buf.length, crc);
  }
  return crc;
}
function computeProgramSignature(external, mpc) {
  const count = readU32BE(external, PROG_SIG_SEG_COUNT);
  const buf = [];
  for (let i = 0; i < count; i++) {
    const start = readU32BE(external, PROG_SIG_SEG_STARTS + i * 8);
    const len = readU32BE(external, PROG_SIG_SEG_LENGTHS + i * 4);
    appendEcuRange(buf, start, len, external, mpc);
  }
  return signHashedFirmware(md5(buf));
}
function prepareProgram(external, mpc) {
  writeU32BE(
    external,
    computeProgramCrc(
      external,
      mpc,
      PROG_CRC_P_INIT,
      PROG_CRC_P_S1S,
      PROG_CRC_P_S1E,
      PROG_CRC_P_S2S,
      PROG_CRC_P_S2E
    ),
    PROG_CRC_P_STORED
  );
  writeU32BE(
    external,
    computeProgramCrc(
      external,
      mpc,
      PROG_CRC_S_INIT,
      PROG_CRC_S_S1S,
      PROG_CRC_S_S1E,
      PROG_CRC_S_S2S,
      PROG_CRC_S_S2E
    ),
    PROG_CRC_S_STORED
  );
  external.set(computeProgramSignature(external, mpc), PROG_SIG_STORED);
}
function validateProgram(external, mpc) {
  const p = computeProgramCrc(
    external,
    mpc,
    PROG_CRC_P_INIT,
    PROG_CRC_P_S1S,
    PROG_CRC_P_S1E,
    PROG_CRC_P_S2S,
    PROG_CRC_P_S2E
  );
  const s = computeProgramCrc(
    external,
    mpc,
    PROG_CRC_S_INIT,
    PROG_CRC_S_S1S,
    PROG_CRC_S_S1E,
    PROG_CRC_S_S2S,
    PROG_CRC_S_S2E
  );
  const pOk = readU32BE(external, PROG_CRC_P_STORED) === p;
  const sOk = readU32BE(external, PROG_CRC_S_STORED) === s;
  const sig = computeProgramSignature(external, mpc);
  const sigOk = eqBytes(
    external.slice(PROG_SIG_STORED, PROG_SIG_STORED + SIG_LENGTH),
    sig
  );
  return { pOk, sOk, sigOk, ok: pOk && sOk && sigOk };
}

// ── flash-command byte-layout builders (mirror EraseEcu / FlashBlock) ────────
function buildEraseCommand(start, length) {
  const o = new Uint8Array(22);
  o[0] = 1;
  o[4] = 0xfe;
  writeU32LE(o, length, 13);
  writeU32LE(o, start, 17);
  return o;
}
function buildFlashAddressCommand(start, length) {
  const o = new Uint8Array(22);
  o[0] = 1;
  o[21] = 3;
  writeU32LE(o, length, 13);
  writeU32LE(o, start, 17);
  return o;
}
function buildFlashChunk(start, chunk) {
  const o = new Uint8Array(21 + chunk.length + 1);
  o[0] = 1;
  o[13] = chunk.length & 0xff;
  writeU32LE(o, start, 17);
  o.set(chunk, 21);
  o[21 + chunk.length] = 3;
  return o;
}

// ════════════════════════ TESTS ════════════════════════

console.log('CRC-32/MPEG-2 known-answer vectors');
check(
  'empty input returns the seed unchanged',
  crc32(new Uint8Array(0), 0, 0, 0xdeadbeef) === 0xdeadbeef
);
check(
  '"123456789" @init 0xFFFFFFFF == 0x0376E6E7 (RevEng catalogue)',
  crc32(new TextEncoder().encode('123456789'), 0, 9, 0xffffffff) === 0x0376e6e7
);
check(
  'single 0x00 @init 0 stays 0 (linear, no XOR-out)',
  crc32(new Uint8Array([0]), 0, 1, 0) === 0
);
{
  const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const whole = crc32(buf, 0, 8, 0xffffffff);
  const first = crc32(buf, 0, 3, 0xffffffff);
  const rest = crc32(buf, 3, 5, first);
  check('CRC is linear across a split buffer', whole === rest);
}

console.log('\nMD5 known-answer vectors');
check(
  'md5("") == d41d8cd9...',
  Buffer.from(md5([])).toString('hex') === 'd41d8cd98f00b204e9800998ecf8427e'
);
check(
  'md5("abc") == 90015098...',
  Buffer.from(md5(new TextEncoder().encode('abc'))).toString('hex') ===
    '900150983cd24fb0d6963f7d28e17f72'
);

console.log('\nRSA-512 firmware signing');
{
  const hash = md5(new TextEncoder().encode('MS45 firmware sig test'));
  check(
    'signing is deterministic',
    eqBytes(signHashedFirmware(hash), signHashedFirmware(hash))
  );
  check('signature block is 64 bytes', signHashedFirmware(hash).length === 64);
  check(
    'different messages -> different signatures',
    !eqBytes(signHashedFirmware(md5([1])), signHashedFirmware(md5([2])))
  );
  // manual m^d mod n on the LE-interpreted MD5, encoded — locks the whole pipeline
  const h = md5(new TextEncoder().encode('golden'));
  const c = modPow(
    bytesLEToBigInt(h),
    FIRMWARE_PRIVATE_EXPONENT,
    FIRMWARE_MODULUS
  );
  check(
    'sign == manual m^d mod n, word-swap encoded',
    eqBytes(signHashedFirmware(h), encodeSignatureBytes(bigIntToBytesLE(c, 64)))
  );
  // ciphertext recovered from storage layout is a valid RSA residue
  const sig = signHashedFirmware(md5(new TextEncoder().encode('sig < n')));
  const le = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    le[4 * i] = sig[4 * i + 3];
    le[4 * i + 1] = sig[4 * i + 2];
    le[4 * i + 2] = sig[4 * i + 1];
    le[4 * i + 3] = sig[4 * i];
  }
  const rec = bytesLEToBigInt(le);
  check('0 < ciphertext < modulus', rec > 0n && rec < FIRMWARE_MODULUS);
  check(
    'word-swap: LE [0,1,2,3] -> stored [3,2,1,0]',
    (() => {
      const inb = new Uint8Array(64);
      for (let i = 0; i < 64; i++) inb[i] = i;
      const out = encodeSignatureBytes(inb);
      return (
        out[0] === 3 &&
        out[1] === 2 &&
        out[2] === 1 &&
        out[3] === 0 &&
        out[60] === 63 &&
        out[63] === 60
      );
    })()
  );
}

console.log('\nRegion / address math');
check(
  'external base 0xFFF00000 classifies as external',
  0xfff00000 >= EXTERNAL_FLASH_BASE
);
check('MPC address 0x1000 classifies as MPC', !(0x1000 >= EXTERNAL_FLASH_BASE));
check(
  'external host offset = ecu - 0xFFF00000',
  0xfff80000 - EXTERNAL_FLASH_BASE === 0x80000
);
check(
  'program blob slice is 0x9FF40 at 0x60000',
  PROGRAM_BLOB_HOST_OFFSET + PROGRAM_BLOB_SIZE === 0xfff40
);
check(
  'tune write end 0x205CFFF spans 0x1D000 from 0x2040000',
  0x205cfff - 0x2040000 + 1 === TUNE_BLOB_SIZE
);
check(
  'program write end 0x20FFF3F spans 0x9FF40 from 0x2060000',
  0x20fff3f - 0x2060000 + 1 === PROGRAM_BLOB_SIZE
);
check(
  'mpc write end 0x6FFFF spans 0x70000 from 0',
  0x6ffff - 0 + 1 === MPC_FLASH_SIZE
);
{
  const buf = [];
  appendEcuRange(
    buf,
    0xfff80000,
    4,
    (() => {
      const e = new Uint8Array(EXTERNAL_FLASH_SIZE);
      e[0x80000] = 0xaa;
      e[0x80003] = 0xbb;
      return e;
    })(),
    new Uint8Array(MPC_FLASH_SIZE)
  );
  check(
    'appendEcuRange reads external at ecu-base offset',
    buf[0] === 0xaa && buf[3] === 0xbb
  );
  const buf2 = [];
  appendEcuRange(
    buf2,
    0x1000,
    2,
    new Uint8Array(EXTERNAL_FLASH_SIZE),
    (() => {
      const m = new Uint8Array(MPC_FLASH_SIZE);
      m[0x1000] = 0xcc;
      return m;
    })()
  );
  check('appendEcuRange reads MPC at raw offset', buf2[0] === 0xcc);
  let threw = false;
  try {
    appendEcuRange(
      [],
      0x60000,
      0x20000,
      new Uint8Array(4),
      new Uint8Array(MPC_FLASH_SIZE)
    );
  } catch (e) {
    threw = true;
  }
  check('appendEcuRange throws on out-of-bounds MPC range', threw);
}

console.log('\nflash-command byte layouts');
{
  const er = buildEraseCommand(0x2040000, 0x20000);
  check('erase: [0]=01 [4]=FE opcode', er[0] === 1 && er[4] === 0xfe);
  // len 0x20000 -> LE [00,00,02,00] at 13..16 ; start 0x2040000 -> LE [00,00,04,02] at 17..20
  check(
    'erase: len@13 LE, start@17 LE',
    er[13] === 0x00 &&
      er[15] === 0x02 &&
      er[17] === 0x00 &&
      er[19] === 0x04 &&
      er[20] === 0x02
  );
  check('erase: [21]=00 (no trailer)', er[21] === 0);
  const ad = buildFlashAddressCommand(0x2040000, 0x1d000);
  check('flash-address: [0]=01 [21]=03', ad[0] === 1 && ad[21] === 3);
  check(
    'flash-address: len 0x1D000 @13 LE',
    ad[13] === 0x00 && ad[14] === 0xd0 && ad[15] === 0x01 && ad[16] === 0x00
  );
  const ck = buildFlashChunk(0x2040000, new Uint8Array([9, 8, 7]));
  check(
    'flash-chunk: [0]=01 [13]=len [21..]=data [end]=03',
    ck[0] === 1 && ck[13] === 3 && ck[21] === 9 && ck[23] === 7 && ck[24] === 3
  );
  check('flash-chunk: chunkStart@17 LE', ck[17] === 0x00 && ck[20] === 0x02);
}

console.log('\nparameter (tune) blob: prepare -> validate round-trip');
{
  const blob = new Uint8Array(TUNE_BLOB_SIZE);
  for (let i = 0; i < blob.length; i++) blob[i] = (i * 13 + 5) & 0xff;
  // one CRC segment + one signed segment, both AFTER the header
  writeU32BE(blob, 0xffffffff, PARAM_CRC_INITIAL);
  writeU32BE(blob, 1, PARAM_CRC_SEG_TABLE);
  writeU32BE(blob, PARAM_CRC_SEGMENT_BASE + 0x200, PARAM_CRC_SEG_TABLE + 4);
  writeU32BE(blob, PARAM_CRC_SEGMENT_BASE + 0x2ff, PARAM_CRC_SEG_TABLE + 8);
  writeU32BE(blob, 1, PARAM_SIG_SEG_COUNT);
  writeU32BE(blob, PARAM_SIG_SEGMENT_BASE + 0x1000, PARAM_SIG_SEG_STARTS);
  writeU32BE(blob, 0x200, PARAM_SIG_SEG_LENGTHS);

  check('before prepare: validation fails', validateTune(blob).ok === false);
  prepareTune(blob);
  const v = validateTune(blob);
  check('after prepare: CRC ok', v.crcOk);
  check('after prepare: signature ok', v.sigOk);
  check('after prepare: overall ok (gate would pass)', v.ok);
  // manual cross-check of the CRC over the exact range
  check(
    'CRC equals manual chained CRC over 0x200..0x2FF',
    readU32BE(blob, PARAM_CRC_STORED) === crc32(blob, 0x200, 0x100, 0xffffffff)
  );

  const good = blob.slice();
  blob[0x210] ^= 0xff; // inside CRC segment
  check(
    'mutating a byte in the CRC segment fails validation',
    validateTune(blob).crcOk === false
  );
  blob.set(good);
  blob[0x1080] ^= 0xff; // inside signed segment
  check(
    'mutating a byte in the signed segment fails signature',
    validateTune(blob).sigOk === false
  );
  blob.set(good);
  blob[0x5000] ^= 0xff; // outside both segments
  check(
    'mutating a byte outside all segments keeps validation ok',
    validateTune(blob).ok === true
  );
}

console.log('\ntune bounds: out-of-range segment throws (no silent pass)');
{
  const blob = new Uint8Array(TUNE_BLOB_SIZE);
  writeU32BE(blob, 0xffffffff, PARAM_CRC_INITIAL);
  writeU32BE(blob, 1, PARAM_CRC_SEG_TABLE);
  writeU32BE(blob, PARAM_CRC_SEGMENT_BASE + 0x100, PARAM_CRC_SEG_TABLE + 4);
  writeU32BE(blob, PARAM_CRC_SEGMENT_BASE + 0x20000, PARAM_CRC_SEG_TABLE + 8); // past end
  let threw = false;
  try {
    validateTune(blob);
  } catch (e) {
    threw = true;
  }
  check('segment past end of blob throws', threw);
}

console.log(
  '\nprogram blob: prepare -> validate round-trip across MPC + external'
);
{
  const external = new Uint8Array(EXTERNAL_FLASH_SIZE);
  for (let i = 0; i < external.length; i++) external[i] = (i * 17 + 3) & 0xff;
  const mpc = new Uint8Array(MPC_FLASH_SIZE);
  for (let i = 0; i < mpc.length; i++) mpc[i] = (i * 29 + 11) & 0xff;
  // both CRCs + the signature span one MPC segment and one external segment,
  // chosen clear of the 0x60000.. header region
  const s1s = 0x00001000,
    s1e = 0x000010ff,
    s2s = 0xfff80000,
    s2e = 0xfff800ff;
  for (const [init, a, b, c, d] of [
    [
      PROG_CRC_P_INIT,
      PROG_CRC_P_S1S,
      PROG_CRC_P_S1E,
      PROG_CRC_P_S2S,
      PROG_CRC_P_S2E,
    ],
    [
      PROG_CRC_S_INIT,
      PROG_CRC_S_S1S,
      PROG_CRC_S_S1E,
      PROG_CRC_S_S2S,
      PROG_CRC_S_S2E,
    ],
  ]) {
    writeU32BE(external, 0xffffffff, init);
    writeU32BE(external, s1s, a);
    writeU32BE(external, s1e, b);
    writeU32BE(external, s2s, c);
    writeU32BE(external, s2e, d);
  }
  writeU32BE(external, 2, PROG_SIG_SEG_COUNT);
  writeU32BE(external, 0x00001000, PROG_SIG_SEG_STARTS);
  writeU32BE(external, 0x100, PROG_SIG_SEG_LENGTHS);
  writeU32BE(external, 0xfff80000, PROG_SIG_SEG_STARTS + 8);
  writeU32BE(external, 0x200, PROG_SIG_SEG_LENGTHS + 4);

  check(
    'before prepare: validation fails',
    validateProgram(external, mpc).ok === false
  );
  prepareProgram(external, mpc);
  const v = validateProgram(external, mpc);
  check('after prepare: primary CRC ok', v.pOk);
  check('after prepare: secondary CRC ok', v.sOk);
  check('after prepare: signature ok', v.sigOk);
  check('after prepare: overall ok (gate would pass)', v.ok);
  // manual cross-check: chained CRC over MPC seg then external seg
  let manual = 0xffffffff;
  manual = crc32(mpc, 0x1000, 0x100, manual);
  manual = crc32(external, 0x80000, 0x100, manual);
  check(
    'primary CRC equals manual chained CRC across both spaces',
    readU32BE(external, PROG_CRC_P_STORED) === manual
  );

  const goodExt = external.slice(),
    goodMpc = mpc.slice();
  mpc[0x1050] ^= 0xff; // inside MPC CRC+sig segment
  check(
    'mutating an MPC segment byte fails validation',
    validateProgram(external, mpc).ok === false
  );
  mpc.set(goodMpc);
  external[0x80080] ^= 0xff; // inside external CRC+sig segment
  check(
    'mutating an external segment byte fails validation',
    validateProgram(external, mpc).ok === false
  );
  external.set(goodExt);
}

// ── structural lock: the C# product code must carry the same constants ──────
console.log('\nstructural lock against src/EdiabasMac/FlashService.cs');
{
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'EdiabasMac', 'FlashService.cs'),
    'utf8'
  );
  const must = [
    // RSA firmware key (facts, reverse-engineered by hassmaschine / GPL-3.0 ref)
    [
      'firmware modulus',
      '8470472580328006956677424405159809178175955696534718361218518906571634405286747173565502454089691240931470915432212928785673566143706092135925769557255439',
    ],
    [
      'firmware private exponent',
      '7260405068852577391437792347279836438436533454172615738187301919918543775959908116508429649500721130520546364846625732843778800986047617824899475327781303',
    ],
    ['CRC-32 polynomial 0x04C11DB7', '0x04C11DB7'],
    // param header offsets
    ['ParamCrcStored 0x100', 'ParamCrcStored       = 0x100'],
    ['ParamCrcSegTable 0x104', 'ParamCrcSegTable     = 0x104'],
    ['ParamCrcInitial 0x110', 'ParamCrcInitial      = 0x110'],
    ['ParamSigStored 0x174', 'ParamSigStored       = 0x174'],
    // program header offsets
    ['ProgCrcPrimaryStored 0x60000', 'ProgCrcPrimaryStored   = 0x60000'],
    ['ProgCrcSecondaryStored 0x60340', 'ProgCrcSecondaryStored   = 0x60340'],
    ['ProgSigStored 0x60074', 'ProgSigStored     = 0x60074'],
    // bases / sizes
    ['external flash base 0xFFF00000', 'ExternalFlashBase = 0xFFF00000'],
    ['param CRC segment base 0xFFE40000', 'ParamCrcSegmentBase = 0xFFE40000'],
    ['param sig segment base 0xFFF40000', 'ParamSigSegmentBase = 0xFFF40000'],
    ['tune blob size 0x1D000', 'TuneBlobSize        = 0x1D000'],
    ['external size 0x100000', 'ExternalFlashSize   = 0x100000'],
    ['mpc size 0x70000', 'MpcFlashSize        = 0x70000'],
    ['program blob size 0x9FF40', 'ProgramBlobSize     = 0x9FF40'],
    // erase opcode + chunk size
    ['erase opcode 0xFE', 'cmd[4] = 0xFE'],
    ['flash chunk size 0xFD', 'int seg = 0xFD'],
    // the safety gate
    ['env gate BMACW_ALLOW_FLASH_WRITE', 'BMACW_ALLOW_FLASH_WRITE'],
    [
      'gate needs confirm AND env==1',
      'confirm && Environment.GetEnvironmentVariable("BMACW_ALLOW_FLASH_WRITE") == "1"',
    ],
    ['write path marked UNVERIFIED', 'UNVERIFIED'],
  ];
  for (const [label, needle] of must)
    check(`C# source contains ${label}`, src.includes(needle));
}

console.log(
  failures
    ? `\n${failures} FAILURES`
    : '\nMS45 offline BIN validation: all checks pass'
);
process.exit(failures ? 1 : 0);
