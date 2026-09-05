#!/usr/bin/env node
// The browser ECU-backup engine (app/renderer/core/flasher.js), exercised
// offline against simulated DMEs that answer the way the real SGBDs do.
//
// WHAT THIS PROVES. Things a real car can only prove slowly and expensively:
//   1. The crypto is bit-exact. The security-access message is MD5 -> RSA-sign
//      -> per-word byte swap, mirroring the reference GetSecurityAccessMessage.
//      MD5 is hand-rolled (WebCrypto has none), so it is pinned to the RFC 1321
//      vectors -- the length-encoding bug that only bites past 32 bits of
//      message length was caught by exactly these vectors. Each profile's key
//      pair is exercised: the MSx70 message must NOT equal the MS45 one.
//   2. The read loop reassembles a region byte-for-byte across hundreds of
//      chunks, including a two-segment region (MSx70 external + internal
//      flash) and the DS2 linear read (MS43: 0x-address + count, *_WERT).
//   3. The session discipline: the unlock runs before the first read and the
//      teardown after the last, also when the read fails; BMW-FAST cars skip
//      the unlock; DS2 DMEs run no security job at all.
//   4. The safety rails: a short chunk is refused rather than padded into a
//      silent hole, demo mode is refused outright, and a hardware reference
//      must match a profile EXACTLY (a superstring is not a match).
//
// Run: node tools/verify/test_flasher.js
const assert = require('assert');
const crypto = require('crypto');

// the engine's few browser globals
global.Settings = { get: () => 'no' };

const F = require('../../app/renderer/core/flasher.js');
const byId = (id) => F.FLASH_PROFILES.find((p) => p.id === id);
const MS45 = byId('MS45');
const MSV70 = byId('MSV70');
const MSS70 = byId('MSS70');
const MS43 = byId('MS43');
const MS42 = byId('MS42');
for (const p of [MS45, MSV70, MSS70, MS43, MS42]) assert.ok(p, 'profile');

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
const tel = (u) =>
  Array.from(u)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('-')
    .toUpperCase();

// ── 1. MD5 pinned to RFC 1321 (plus random binary against Node) ─────────────
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
for (let n = 0; n < 40; n++) {
  const buf = crypto.randomBytes(1 + Math.floor(Math.random() * 200));
  assert.strictEqual(
    hex(F._md5(buf)),
    crypto.createHash('md5').update(buf).digest('hex'),
    `md5 of ${buf.length} random bytes`
  );
}
ok('MD5 matches the RFC vectors and Node on 40 random binary inputs');

// ── 2. security-access message is byte-identical to the reference layout ─────
console.log('\nsecurity-access message');
// an independent transcription of the reference GetSecurityAccessMessage
function reference(key, userId, serial, seed) {
  const toHash = new Uint8Array([...userId, ...serial, ...seed]);
  const hash = F._md5(toHash);
  let m = 0n;
  for (let i = hash.length - 1; i >= 0; i--) m = (m << 8n) | BigInt(hash[i]);
  let c = F._modPow(m, key.d, key.n);
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
const keyOf = (p, type) =>
  p.security.keys ? p.security.keys[type] : p.security;
for (let n = 0; n < 4; n++) {
  const userId = crypto.randomBytes(4);
  const serial = crypto.randomBytes(4);
  const seed = crypto.randomBytes(4);
  const msgs = {};
  for (const [p, type] of [
    [MS45, 'MS45.1'],
    [MSV70, 'MSV70'],
    [MSS70, 'MSS70'],
  ]) {
    const got = F._rsaSecurityMessage(p.security, userId, serial, seed, type);
    const want = reference(keyOf(p, type), userId, serial, seed);
    assert.strictEqual(got.length, 90, '25-byte header + 65-byte payload');
    assert.deepStrictEqual(Array.from(got), Array.from(want), `${type} #${n}`);
    msgs[type] = hex(got);
  }
  // three different key pairs must sign the same challenge differently
  assert.notStrictEqual(msgs['MS45.1'], msgs.MSV70);
  assert.notStrictEqual(msgs.MSV70, msgs.MSS70);
  assert.notStrictEqual(msgs['MS45.1'], msgs.MSS70);
}
assert.throws(
  () =>
    F._rsaSecurityMessage(
      MSV70.security,
      new Uint8Array(4),
      new Uint8Array(4),
      new Uint8Array(4),
      'MSS70'
    ),
  /no security key for MSS70/
);
ok(
  'MS45, MSV70 and MSS70 messages each match the reference layout with their own key'
);

// ── 3. simulated DMEs ────────────────────────────────────────────────────────
// one flash image per family, distinct fill so a cross-wired read would show
const img = (size, k) => {
  const u = new Uint8Array(size);
  for (let i = 0; i < size; i++) u[i] = (i * k + 3) & 0xff;
  return u;
};
const MS45_FLASH = img(0x100000, 7);
const X70_LAR = img(0x180000, 11);
const X70_FLASH = img(0x80000, 13);
const MS43_FLASH = img(0x80000, 17);

let log = [];
let shortAt = null; // when set, KWP chunks at/after this address come back short
let protocol = 'KWP2000*'; // what DIAGNOSEPROTOKOLL_LESEN answers on MSx70
let failIdent = false;
let refuseSeed = false; // the ECU answers the seed request with an error status

let connected = null; // when set, every other SGBD fails like a dead bus
global.webRunJob = async (sgbd, job, arg) => {
  log.push([sgbd, job, arg]);
  if (connected && sgbd !== connected) throw new Error('no answer from ECU');
  const set = {};
  const kwpCommon = () => {
    if (job === 'daten_referenz_lesen') set.DATEN_REFERENZ = '1234';
    else if (job === 'aif_lesen') set.AIF_FG_NR = 'WBATEST';
    else if (job === 'seriennummer_lesen')
      set._TEL_ANTWORT = 'B8-F1-12-01-02-03-04-99';
    else if (job === 'authentisierung_zufallszahl_lesen') {
      if (refuseSeed) {
        set.JOB_STATUS = 'ERROR_ECU_CONDITIONS_NOT_CORRECT';
      } else {
        set.JOB_STATUS = 'OKAY';
        set.ZUFALLSZAHL = 'AA-BB-CC-DD';
      }
    } else if (job === 'authentisierung_start') {
      // the key arrives as a BINARY arg: a Latin-1 string, one char per byte
      assert.strictEqual(arg.length, 90, '90-byte message');
      assert.strictEqual(arg.charCodeAt(0), 1, 'header byte intact');
      assert.strictEqual(arg.charCodeAt(89), 3, 'level byte intact');
    }
  };
  const kwpRead = (segments) => {
    const [seg, start, len] = arg.split(';');
    const src = segments[seg];
    assert.ok(src, `segment ${seg} exists`);
    const s = +start;
    let n = +len;
    if (shortAt !== null && s >= shortAt) n = Math.min(n, 10);
    set.DATEN = tel(src.subarray(s, s + n));
  };
  if (sgbd === 'ms450ds0') {
    if (job === 'hardware_referenz_lesen')
      set.HARDWARE_REFERENZ = failIdent ? '00445700' : '0044570';
    else if (job === 'speicher_lesen_ascii') kwpRead({ ROMX: MS45_FLASH });
    else kwpCommon();
  } else if (sgbd === 'msv70' || sgbd === 'mss70') {
    if (job === 'hardware_referenz_lesen')
      set.HARDWARE_REFERENZ = sgbd === 'msv70' ? '0049PP0' : '0049R20';
    else if (job === 'DIAGNOSEPROTOKOLL_LESEN') set.DIAG_PROT_IST = protocol;
    else if (job === 'speicher_lesen_ascii')
      kwpRead({ LAR: X70_LAR, FLASH: X70_FLASH });
    else kwpCommon();
  } else if (sgbd === 'ms430ds0') {
    if (job === 'IDENT') {
      if (failIdent) return { sets: [{ JOB_STATUS: 'ERROR_ECU_...' }] };
      set.ID_HW_NR = 4;
      set.ID_SW_NR = 69;
      set.ID_BMW_NR = '7 519 308';
    } else if (job === 'AIF_LESEN') set.AIF_FG_NR = 'WBAMS43';
    else if (job === 'SPEICHER_LIN_LESEN') {
      // "0xHHHHHH;count": a 0x literal the VM's StringToValue understands
      const m = /^0x([0-9a-f]{6});(\d+)$/.exec(arg);
      assert.ok(m, `DS2 read arg shape: ${arg}`);
      const s = parseInt(m[1], 16);
      const n = +m[2];
      assert.ok(n >= 1 && n <= 255, 'count fits one telegram byte');
      set.SPEICHER_LIN_LESEN_WERT = tel(MS43_FLASH.subarray(s, s + n));
    } else assert.fail(`unexpected job on MS43: ${job}`);
  }
  return { sets: [set] };
};

const jobs = (sgbd) => log.filter((l) => l[0] === sgbd).map((l) => l[1]);

(async () => {
  // ── MS45 ────────────────────────────────────────────────────────────────
  console.log('\nread engine: MS45');
  let last = 0;
  const r = await F.flashBackup('ms450ds0', {
    region: 'data',
    onProgress: (p) => (last = p),
  });
  const want = MS45_FLASH.subarray(0x40000, 0x5d000);
  assert.deepStrictEqual(Array.from(r.bytes), Array.from(want));
  assert.strictEqual(r.info.type, 'MS45.1');
  assert.strictEqual(r.name, 'MS45.1_data_WBATEST.bin');
  assert.strictEqual(last, 100);
  let j = jobs('ms450ds0');
  const order = [
    'seriennummer_lesen',
    'authentisierung_zufallszahl_lesen',
    'authentisierung_start',
  ];
  const idx = order.map((x) => j.indexOf(x));
  assert.ok(idx.every((i) => i >= 0) && idx[0] < idx[1] && idx[1] < idx[2]);
  assert.ok(idx[2] < j.indexOf('speicher_lesen_ascii'), 'unlock before read');
  assert.strictEqual(
    j.filter((x) => /diagnose_mode|SET_PARAMETER|ACCESS_TIMING/.test(x)).length,
    6,
    '4 ramp jobs + 2 teardown jobs'
  );
  assert.deepStrictEqual(j.slice(-2), ['diagnose_mode', 'SET_PARAMETER']);
  assert.strictEqual(log[log.length - 2][2], 'DEFAULT;PC9600');
  ok(`data region ${want.length} bytes identical; unlock first, teardown last`);

  log = [];
  const rf = await F.flashBackup('ms450ds0', { region: 'full' });
  assert.deepStrictEqual(Array.from(rf.bytes), Array.from(MS45_FLASH));
  ok(`full flash ${MS45_FLASH.length} bytes identical`);

  // ── MSV70 / MSS70 ────────────────────────────────────────────────────────
  console.log('\nread engine: MSV70 / MSS70');
  log = [];
  const rv = await F.flashBackup('msv70', { region: 'full' });
  assert.strictEqual(rv.bytes.length, X70_LAR.length + X70_FLASH.length);
  assert.deepStrictEqual(
    Array.from(rv.bytes.subarray(0, X70_LAR.length)),
    Array.from(X70_LAR)
  );
  assert.deepStrictEqual(
    Array.from(rv.bytes.subarray(X70_LAR.length)),
    Array.from(X70_FLASH)
  );
  assert.strictEqual(rv.name, 'MSV70_full_WBATEST.bin');
  j = jobs('msv70');
  assert.ok(j.includes('authentisierung_start'), 'KWP2000* car unlocked');
  const timing = log.find((l) => l[1] === 'ACCESS_TIMING_PARAMETER');
  assert.strictEqual(timing[2], '00;120;0;240;00', 'MSx70 timing, not MS45');
  // LAR is read to its end before FLASH starts
  const reads = log.filter((l) => l[1] === 'speicher_lesen_ascii');
  const firstFlash = reads.findIndex((l) => l[2].startsWith('FLASH;'));
  assert.ok(firstFlash > 0);
  assert.ok(reads.slice(0, firstFlash).every((l) => l[2].startsWith('LAR;')));
  assert.ok(reads.slice(firstFlash).every((l) => l[2].startsWith('FLASH;')));
  assert.deepStrictEqual(j.slice(-2), ['diagnose_mode', 'SET_PARAMETER']);
  ok(
    `full flash = LAR ${X70_LAR.length} + FLASH ${X70_FLASH.length} bytes, concatenated in order`
  );

  log = [];
  const rs = await F.flashBackup('mss70', { region: 'data' });
  assert.deepStrictEqual(
    Array.from(rs.bytes),
    Array.from(X70_LAR.subarray(0x40000, 0x60000))
  );
  assert.strictEqual(rs.info.type, 'MSS70');
  ok('MSS70 data region 0x40000–0x5FFFF read with the MSS70 key');

  // BMW-FAST: no unlock, no ramp, no teardown
  log = [];
  protocol = 'BMW-FAST';
  const rfast = await F.flashBackup('msv70', { region: 'data' });
  assert.strictEqual(rfast.bytes.length, 0x20000);
  j = jobs('msv70');
  for (const x of [
    'seriennummer_lesen',
    'authentisierung_start',
    'diagnose_mode',
    'SET_PARAMETER',
    'ACCESS_TIMING_PARAMETER',
  ]) {
    assert.ok(!j.includes(x), `${x} must not run on BMW-FAST`);
  }
  protocol = 'KWP2000*';
  ok('BMW-FAST car: read straight away, no unlock and no teardown');

  // teardown still runs when the read fails mid-way
  log = [];
  shortAt = 0x40000 + 254 * 3;
  await assert.rejects(
    () => F.flashBackup('msv70', { region: 'data' }),
    /short read at 0x402fa: got 10, wanted 254/
  );
  shortAt = null;
  j = jobs('msv70');
  assert.deepStrictEqual(j.slice(-2), ['diagnose_mode', 'SET_PARAMETER']);
  ok('a failed read still leaves programming mode');

  // ── MS43 (DS2) ───────────────────────────────────────────────────────────
  console.log('\nread engine: MS43 (DS2)');
  log = [];
  const r43 = await F.flashBackup('ms430ds0', { region: 'full' });
  assert.deepStrictEqual(Array.from(r43.bytes), Array.from(MS43_FLASH));
  assert.strictEqual(r43.name, 'MS43_full_WBAMS43.bin');
  assert.strictEqual(r43.info.hwRef, '4');
  assert.strictEqual(r43.info.swRef, '69');
  j = jobs('ms430ds0');
  assert.deepStrictEqual(
    [...new Set(j)],
    ['IDENT', 'AIF_LESEN', 'SPEICHER_LIN_LESEN']
  );
  assert.strictEqual(
    j.filter((x) => x === 'SPEICHER_LIN_LESEN').length,
    Math.ceil(MS43_FLASH.length / 128)
  );
  ok(
    `full 512 KB identical over ${Math.ceil(MS43_FLASH.length / 128)} DS2 chunks; only IDENT/AIF/read jobs ran`
  );

  log = [];
  const r43d = await F.flashBackup('ms430ds0', { region: 'data' });
  assert.deepStrictEqual(
    Array.from(r43d.bytes),
    Array.from(MS43_FLASH.subarray(0x70000, 0x80000))
  );
  assert.strictEqual(
    log.find((l) => l[1] === 'SPEICHER_LIN_LESEN')[2],
    '0x070000;128'
  );
  ok('calibration block 0x70000–0x7FFFF, first arg "0x070000;128"');

  // MS42's calibration block sits mid-flash
  assert.deepStrictEqual(MS42.regions[0].parts, [
    { segment: 'LIN', start: 0x48000, end: 0x4ffff },
  ]);
  assert.strictEqual(F.flashRegionSize(MS42.regions[1]), 0x80000);
  ok('MS42 profile: calibration 0x48000–0x4FFFF, full 512 KB');

  // ── safety rails ──────────────────────────────────────────────────────────
  console.log('\nsafety rails');
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

  // a superstring of a known reference is NOT a match, and the refusal
  // names what the car said
  failIdent = true;
  await assert.rejects(
    () => F.flashBackup('ms450ds0', {}),
    /no flash profile.*00445700/
  );
  assert.strictEqual(F.flashTypeForHwRef(MS45, '0044570'), 'MS45.1');
  assert.strictEqual(F.flashTypeForHwRef(MS45, ' 0044570 '), 'MS45.1');
  assert.strictEqual(F.flashTypeForHwRef(MS45, '00445700'), null);
  assert.strictEqual(F.flashTypeForHwRef(MS45, '44570'), null);
  ok('hardware reference must match exactly; the refusal names the reference');

  // a DS2 DME whose IDENT does not answer is refused, not assumed
  await assert.rejects(() => F.flashBackup('ms430ds0', {}), /no flash profile/);
  failIdent = false;
  ok('DS2 profile needs IDENT to answer before it reads anything');

  // a ramp that fails after the key was accepted still tears the session down
  let failRamp = true;
  const saveRun = global.webRunJob;
  global.webRunJob = async (sgbd, job, arg) => {
    if (failRamp && job === 'SET_PARAMETER' && arg === ';115200') {
      log.push([sgbd, job, arg]);
      throw new TypeError('simulated VM fault in SET_PARAMETER');
    }
    return saveRun(sgbd, job, arg);
  };
  log = [];
  await assert.rejects(
    () => F.flashBackup('ms450ds0', { region: 'data' }),
    /simulated VM fault/
  );
  j = jobs('ms450ds0');
  assert.ok(j.includes('authentisierung_start'), 'key was sent');
  assert.deepStrictEqual(j.slice(-2), ['diagnose_mode', 'SET_PARAMETER']);
  assert.strictEqual(log[log.length - 2][2], 'DEFAULT;PC9600');
  assert.ok(!j.includes('speicher_lesen_ascii'));
  failRamp = false;
  global.webRunJob = saveRun;
  ok('a ramp that fails after the key still leaves programming mode');

  // an ECU that refuses a step is reported by its JOB_STATUS, and the
  // teardown is not attempted (no programming session was opened)
  refuseSeed = true;
  log = [];
  await assert.rejects(
    () => F.flashBackup('ms450ds0', { region: 'data' }),
    /authentisierung_zufallszahl_lesen: ERROR_ECU_CONDITIONS_NOT_CORRECT/
  );
  assert.ok(!jobs('ms450ds0').includes('authentisierung_start'));
  assert.ok(!jobs('ms450ds0').includes('speicher_lesen_ascii'));
  refuseSeed = false;
  ok('a non-OKAY JOB_STATUS stops the unlock and names the job and status');

  // ── detect ────────────────────────────────────────────────────────────────
  console.log('\ndetect');
  for (const [sgbd, type] of [
    ['ms430ds0', 'MS43'],
    ['mss70', 'MSS70'],
    ['ms450ds0', 'MS45.1'],
  ]) {
    connected = sgbd;
    log = [];
    const stages = [];
    const d = await F.flashDetect({ onStage: (t) => stages.push(t) });
    assert.ok(d.profile, `detected something on ${sgbd}`);
    assert.strictEqual(d.profile.sgbd, sgbd);
    assert.strictEqual(d.info.type, type);
    assert.ok(stages.length >= 1 && stages[0].startsWith('trying '));
    // nothing but ident jobs went out: detection must never read or unlock
    assert.ok(
      log.every((l) =>
        /^(hardware_referenz_lesen|daten_referenz_lesen|aif_lesen|IDENT|AIF_LESEN)$/.test(
          l[1]
        )
      ),
      'detect runs only ident jobs'
    );
  }
  ok(
    'detect finds MS43, MSS70 and MS45.1 by trying each SGBD, ident jobs only'
  );

  connected = 'nothing';
  const none = await F.flashDetect({});
  assert.strictEqual(none.profile, null);
  ok('detect with no supported DME on the bus returns null, does not guess');
  connected = null;

  // ── background-tab hold ─────────────────────────────────────────────────
  // the read must run inside a held Web Lock so a backgrounded tab is not
  // throttled; when the Web Locks API exists, flashBackup must take it
  console.log('\nbackground-tab hold');
  // Node has a real navigator.locks (a LockManager), so spy on it by
  // wrapping request rather than replacing navigator (which is read-only).
  let heldDuringRead = false;
  let lockName = null;
  let heldNow = false;
  const realRequest = navigator.locks.request.bind(navigator.locks);
  navigator.locks.request = async (name, cb) => {
    lockName = name;
    heldNow = true;
    return realRequest(name, async (lock) => {
      try {
        return await cb(lock);
      } finally {
        heldNow = false;
      }
    });
  };
  const saved = global.webRunJob;
  global.webRunJob = async (sgbd, job, arg) => {
    if (job === 'speicher_lesen_ascii') heldDuringRead = heldNow;
    return saved(sgbd, job, arg);
  };
  connected = 'ms450ds0';
  await F.flashBackup('ms450ds0', { region: 'data' });
  global.webRunJob = saved;
  navigator.locks.request = realRequest;
  assert.strictEqual(
    lockName,
    'bmweb-ecu-backup',
    'the read takes a named Web Lock'
  );
  assert.ok(heldDuringRead, 'the lock is held while chunks are being read');
  assert.ok(!heldNow, 'the lock is released when the backup ends');
  ok('the read holds a Web Lock so a background tab is not throttled');

  console.log(`\nflasher: ${passed} checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
});
