#!/usr/bin/env node
// The browser ECU-backup engine (app/renderer/core/flasher.js), exercised
// offline against a simulated MS45 that answers the way the real SGBD does.
//
// WHAT THIS PROVES. Three things that a real car can only prove slowly and
// expensively:
//   1. The crypto is bit-exact. The security-access message is MD5 -> RSA-sign
//      -> per-word byte swap, mirroring FlashService.GetSecurityAccessMessage.
//      MD5 is hand-rolled (WebCrypto has none), so it is pinned to the RFC 1321
//      vectors -- the length-encoding bug that only bites past 32 bits of
//      message length was caught by exactly these vectors.
//   2. The read loop reassembles a region byte-for-byte across hundreds of
//      254-byte chunks, for both the tune region and the full 1 MB flash.
//   3. The safety rails hold: a short chunk is refused rather than padded into
//      a silent hole in the backup, and demo mode is refused outright (its
//      simulated answers would yield a convincing-looking .bin of fiction).
//
// Run: node tools/verify/test_flasher.js
const assert = require('assert');
const crypto = require('crypto');

// the engine's few browser globals
global.Settings = { get: () => 'no' };

const F = require('../../app/renderer/core/flasher.js');
const P = F.FLASH_PROFILES.find((p) => p.id === 'MS45');
assert.ok(P, 'MS45 profile present');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const hex = (u) =>
  Array.from(u)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const enc = (s) => new TextEncoder().encode(s);

// ── 1. MD5 pinned to RFC 1321 (plus a multi-block case) ──────────────────────
console.log('\nMD5 (RFC 1321 vectors)');
for (const [s, want] of [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  [
    'The quick brown fox jumps over the lazy dog',
    '9e107d9d372bb6826bd81d3542a419d6',
  ],
  [
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
    '57edf4a22be3c955ac49da2e2107b67a',
  ],
]) {
  assert.strictEqual(hex(F._md5(enc(s))), want, `md5(${JSON.stringify(s)})`);
}
// and against Node's own MD5 on random binary, the real input shape
for (let n = 0; n < 40; n++) {
  const buf = crypto.randomBytes(1 + Math.floor(Math.random() * 200));
  assert.strictEqual(
    hex(F._md5(buf)),
    crypto.createHash('md5').update(buf).digest('hex'),
    `md5 of ${buf.length} random bytes`
  );
}
ok('MD5 matches the RFC vectors and Node on 40 random binary inputs');

// ── 2. security-access message is byte-identical to the C# reference ─────────
console.log('\nsecurity-access message');
function reference(userId, serial, seed) {
  // an independent transcription of FlashService.GetSecurityAccessMessage
  const toHash = new Uint8Array([...userId, ...serial, ...seed]);
  const hash = F._md5(toHash);
  let m = 0n;
  for (let i = hash.length - 1; i >= 0; i--) m = (m << 8n) | BigInt(hash[i]);
  let c = F._modPow(m, P.security.d, P.security.n);
  const enc64 = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    enc64[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const payload = new Uint8Array(65);
  payload[64] = 3;
  for (let i = 0; i < 16; i++) {
    payload[0 + 4 * i] = enc64[3 + 4 * i];
    payload[1 + 4 * i] = enc64[2 + 4 * i];
    payload[2 + 4 * i] = enc64[1 + 4 * i];
    payload[3 + 4 * i] = enc64[0 + 4 * i];
  }
  const header = [
    1, 0, 0, 0, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0x10,
  ];
  return new Uint8Array([...header, ...payload]);
}
for (let n = 0; n < 8; n++) {
  const userId = crypto.randomBytes(4);
  const serial = crypto.randomBytes(4);
  const seed = crypto.randomBytes(4);
  const got = F._rsaSecurityMessage(P.security, userId, serial, seed);
  const want = reference(userId, serial, seed);
  assert.strictEqual(
    got.length,
    90,
    'message is 25-byte header + 65-byte payload'
  );
  assert.deepStrictEqual(Array.from(got), Array.from(want), `message #${n}`);
}
ok(
  '8 random seed/serial/userId messages match the reference layout, 90 bytes each'
);

// ── 3. the read engine against a simulated MS45 ──────────────────────────────
console.log('\nread engine (simulated MS45)');
const FLASH = new Uint8Array(0x100000);
for (let i = 0; i < FLASH.length; i++) FLASH[i] = (i * 7 + 3) & 0xff;
const tel = (u) =>
  Array.from(u)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('-')
    .toUpperCase();

let log = [];
let shortAt = null; // when set, chunks at/after this address come back truncated
global.webRunJob = async (sgbd, job, arg) => {
  log.push(job);
  const set = {};
  if (job === 'hardware_referenz_lesen') set.HARDWARE_REFERENZ = '0044570';
  else if (job === 'daten_referenz_lesen') set.DATEN_REFERENZ = '1234';
  else if (job === 'aif_lesen') set.AIF_FG_NR = 'WBATEST';
  else if (job === 'seriennummer_lesen')
    set._TEL_ANTWORT = 'B8-F1-12-01-02-03-04-99';
  else if (job === 'authentisierung_zufallszahl_lesen')
    set.ZUFALLSZAHL = 'AA-BB-CC-DD';
  else if (job === 'authentisierung_start') {
    // the key arrives as a BINARY arg: a Latin-1 string, one char per byte
    assert.strictEqual(
      arg.length,
      90,
      'authentisierung_start gets the 90-byte message'
    );
    assert.strictEqual(
      arg.charCodeAt(0),
      1,
      'binary arg: first header byte intact'
    );
    assert.strictEqual(arg.charCodeAt(89), 3, 'binary arg: level byte intact');
  } else if (job === 'speicher_lesen_ascii') {
    const [seg, start, len] = arg.split(';');
    assert.strictEqual(seg, 'ROMX');
    const s = +start;
    let n = +len;
    if (shortAt !== null && s >= shortAt) n = Math.min(n, 10);
    set.DATEN = tel(FLASH.subarray(s, s + n));
  }
  return { sets: [set] };
};

(async () => {
  // data region
  const stages = [];
  let last = 0;
  const r = await F.flashBackup('ms450ds0', {
    region: 'data',
    onStage: (t) => stages.push(t),
    onProgress: (p) => (last = p),
  });
  const want = FLASH.subarray(0x40000, 0x5d000);
  assert.strictEqual(r.bytes.length, want.length);
  assert.deepStrictEqual(Array.from(r.bytes), Array.from(want));
  assert.strictEqual(r.info.type, 'MS45.1');
  assert.strictEqual(r.name, 'MS45.1_data_WBATEST.bin');
  assert.strictEqual(last, 100);
  assert.strictEqual(
    log.filter((j) => j === 'speicher_lesen_ascii').length,
    Math.ceil(want.length / 254)
  );
  ok(`data region: ${want.length} bytes byte-identical, named ${r.name}`);

  // the unlock ran, in order, before any read
  const order = [
    'seriennummer_lesen',
    'authentisierung_zufallszahl_lesen',
    'authentisierung_start',
  ];
  const idx = order.map((j) => log.indexOf(j));
  assert.ok(
    idx.every((i) => i >= 0) && idx[0] < idx[1] && idx[1] < idx[2],
    'auth order'
  );
  assert.ok(
    idx[2] < log.indexOf('speicher_lesen_ascii'),
    'unlock before first read'
  );
  assert.strictEqual(
    log.filter((j) => /diagnose_mode|SET_PARAMETER|ACCESS_TIMING/.test(j))
      .length,
    4,
    'programming-mode switch'
  );
  ok(
    'security access ran serial -> seed -> key -> programming mode, before the first read'
  );

  // full flash
  log = [];
  const rf = await F.flashBackup('ms450ds0', { region: 'full' });
  assert.strictEqual(rf.bytes.length, FLASH.length);
  assert.deepStrictEqual(Array.from(rf.bytes), Array.from(FLASH));
  ok(
    `full flash: ${FLASH.length} bytes byte-identical over ${log.filter((j) => j === 'speicher_lesen_ascii').length} chunks`
  );

  // ── safety rails ────────────────────────────────────────────────────────────
  console.log('\nsafety rails');
  shortAt = 0x40000 + 254 * 5;
  await assert.rejects(
    () => F.flashBackup('ms450ds0', { region: 'data' }),
    /short read at 0x404f6: got 10, wanted 254/
  );
  ok('a short chunk is refused, not padded into a silent hole');
  shortAt = null;

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => F.flashBackup('ms450ds0', { region: 'data', abort: ac.signal }),
    /backup cancelled/
  );
  ok('cancel is honoured');

  global.Settings = { get: () => 'yes' };
  await assert.rejects(() => F.flashBackup('ms450ds0', {}), /demo mode/);
  ok('demo mode is refused: simulated answers must never become a backup');
  global.Settings = { get: () => 'no' };

  // an unknown DME is refused, with the hardware ref named
  global.webRunJob = async (sgbd, job) =>
    job === 'hardware_referenz_lesen'
      ? { sets: [{ HARDWARE_REFERENZ: '0099999' }] }
      : { sets: [{}] };
  await assert.rejects(
    () => F.flashBackup('ms450ds0', {}),
    /no flash profile.*0099999/
  );
  ok('an unrecognised hardware reference is refused, not guessed at');

  console.log(`\nflasher: ${passed} checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
