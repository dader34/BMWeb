#!/usr/bin/env node
// The GS20 calibration engine (app/renderer/core/gs20.js) and the raw DS2
// wire under it (core/webshim/ds2-wire.js), exercised offline against a
// simulated transmission that answers at the FRAME level -- address, length,
// status, data, XOR checksum -- the way the real module does on the bus.
//
// WHAT THIS PROVES. Things a real car can only prove slowly and expensively:
//   1. The checksum is bit-exact: against the values the transmission itself
//      stored in eight real calibrations (when the fixtures are on disk), and
//      the correct/verify/version helpers behave.
//   2. Every telegram is framed the way the reference link frames it: the
//      length byte counts the whole telegram, the bus signs it with the
//      concept-6 XOR, and the payload cap is honoured.
//   3. The write sequence is the reference tool's, in order: session open,
//      unlock challenge/response (the three-byte sum key), a status query
//      BEFORE the erase, erase, busy polling, data-only writes (blank pairs
//      skipped, blank tails trimmed, 118-byte chunks), and a commit that
//      insists on sub-status 1. The simulated flash ends byte-identical to the
//      checksum-corrected image.
//   4. The safety rails: a module that is not open for programming is refused
//      with NOTHING erased; a wrong-size image never reaches the wire; a
//      cancel stops the loop; the checksum is corrected before the first
//      byte goes out; an unconfirmed call is refused.
//   5. The baud change: the request is acknowledged at the old rate, the link
//      follows, a refused change is reported, and the session always leaves
//      the module back at 9600.
//
// Run: node tools/verify/test_gs20.js
//      GS20_CAL_DIR=/path/to/calibration-reads node tools/verify/test_gs20.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// the engine's few browser globals
global.bmwSleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2)));
global.busTrace = {
  hex: (b) =>
    b
      ? Array.from(b, (x) =>
          (x & 0xff).toString(16).padStart(2, '0').toUpperCase()
        ).join(' ')
      : '',
};

const W = require('../../app/renderer/core/webshim/ds2-wire.js');
Object.assign(global, W); // Ds2Wire, DS2_ADDRESS, DS2_STATUS, ds2Status, ...
const G = require('../../app/renderer/core/gs20.js');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const xor = (bytes) => bytes.reduce((a, b) => a ^ b, 0);

// ── 1. checksum ─────────────────────────────────────────────────────────────
console.log('\nchecksum');
const calDir =
  process.env.GS20_CAL_DIR ||
  path.join(
    process.env.HOME || '',
    'Desktop/e46bins/GS20-gearbox/research/calibration-reads'
  );
// what the transmission wrote back after each flash, read off the car
const PINNED = [
  ['gs20_7552700_90_partial_after.bin', 0x35a8],
  ['gs20_7552700_90_partial1bytediffafter.bin', 0x4cb6],
  ['gs20_7552700_90_partial_2.bin', 0xc54e],
  ['gs20_7552700_90_partial.bin', 0x58c3],
  ['gs20_7544721_89_partial.bin', 0xf646],
  ['gs20_7544721_89_partial_afteredits.bin', 0x35b4],
  ['gs20_7544721_89_partial_new.bin', 0xac41],
];
let pinned = 0;
for (const [name, want] of PINNED) {
  const p = path.join(calDir, name);
  if (!fs.existsSync(p)) continue;
  const cal = new Uint8Array(fs.readFileSync(p));
  assert.strictEqual(G.gs20Checksum.stored(cal), want, `${name} stored`);
  assert.strictEqual(G.gs20Checksum.compute(cal), want, `${name} computed`);
  assert.ok(G.gs20Checksum.verify(cal), `${name} verifies`);
  pinned++;
}
if (pinned)
  ok(`${pinned} real calibrations: computed == what the transmission stored`);
else console.log('  skip  real calibrations (set GS20_CAL_DIR to run this)');

// a synthetic image with a known-good checksum, and the helpers around it
const synth = new Uint8Array(G.GS20_CAL_LENGTH);
for (let i = 0; i < synth.length; i++) synth[i] = (i * 7 + 13) & 0xff;
// a version block past the checksummed range, like a real one
const VERSION = 'G2210_0090C0ER10';
for (let i = 0; i < VERSION.length; i++)
  synth[0xffc8 + i] = VERSION.charCodeAt(i);
synth[0xffc8 + VERSION.length] = 0;
const fixed = G.gs20Checksum.correct(synth);
assert.ok(!G.gs20Checksum.verify(synth), 'random fill does not verify');
assert.ok(G.gs20Checksum.verify(fixed), 'corrected image verifies');
assert.deepStrictEqual(
  G.gs20Checksum.correct(fixed),
  fixed,
  'correcting a valid image changes nothing'
);
assert.notStrictEqual(synth, fixed, 'correct() returns a copy');
assert.ok(!G.gs20Checksum.verify(synth), 'the input is left alone');
// an edit inside the range changes it; one outside does not
const edited = Uint8Array.from(fixed);
edited[0x1000] ^= 0xff;
assert.notStrictEqual(
  G.gs20Checksum.compute(edited),
  G.gs20Checksum.compute(fixed)
);
const outside = Uint8Array.from(fixed);
outside[0xffd0] ^= 0xff;
outside[0x0d] ^= 0xff;
assert.strictEqual(
  G.gs20Checksum.compute(outside),
  G.gs20Checksum.compute(fixed)
);
assert.strictEqual(G.gs20Checksum.version(fixed), VERSION);
assert.strictEqual(G.gs20Checksum.release(fixed), '90');
assert.throws(
  () => G.gs20Checksum.compute(new Uint8Array(0x8000)),
  /0x10000 bytes/
);
ok(
  'correct/verify/version/release; the checksum covers [0x2A,0xFFC8) and nothing else'
);

// ── 2. framing ──────────────────────────────────────────────────────────────
console.log('\nframing');
assert.deepStrictEqual(W.ds2Frame(0x32, [0x00]), [0x32, 0x04, 0x00]);
assert.deepStrictEqual(
  W.ds2Frame(0x32, [0x07, 0x0f, 0x09, 0x00, 0x00, 0x00]),
  [0x32, 0x09, 0x07, 0x0f, 0x09, 0x00, 0x00, 0x00]
);
assert.throws(() => W.ds2Frame(0x32, new Array(253).fill(0)), /one byte/);
assert.strictEqual(W.ds2Frame(0x32, new Array(252).fill(0)).length, 254);
assert.strictEqual(
  W.ds2SubStatus([0x32, 0x0a, 0xa0, 0, 0, 0, 0, 0, 1, 0xff]),
  1
);
assert.strictEqual(W.ds2SubStatus([0x32, 0x05, 0xa0, 0, 0]), null);
assert.strictEqual(
  W.ds2DescribeSubStatus(3),
  'flash fault 3 (not programmed: flash not blank)'
);
assert.strictEqual(W.ds2DescribeSubStatus(11), 'flash fault 11');
ok(
  'ds2Frame: length counts the whole telegram incl. the checksum the bus adds; 252-byte cap'
);

// ── 3. a simulated transmission ─────────────────────────────────────────────
// Answers at the frame level. The fake bus exchange checks what the real
// one would: concept 6, the baud the module is listening on, and that the
// request is unsigned (the bus signs it).
function makeTcu() {
  const t = {
    baud: 9600,
    session: false,
    unlocked: false,
    flash: new Uint8Array(G.GS20_CAL_LENGTH).fill(0x55),
    erased: false,
    busyLeft: 0,
    volts: 122, // 12.44 V
    refuseFast: false,
    silentOnce: null, // a command byte to answer with silence once
    log: [],
    writes: 0,
  };
  const reply = (status, data = []) => {
    const body = [0x32, data.length + 4, status, ...data];
    return [...body, xor(body)];
  };
  const ifh = (code, msg) => {
    const e = new Error(`${code}: ${msg}`);
    e.ifh = code;
    return e;
  };
  t.exchange = async (out, comm) => {
    assert.strictEqual(comm.concept, 6, 'DS2 concept');
    assert.strictEqual(comm.answerLen[0], -1, 'DS2 length rule');
    assert.strictEqual(comm.regen, 30, 'inter-telegram gap');
    assert.strictEqual(out[0], 0x32, 'addressed to the transmission');
    assert.strictEqual(
      out[1],
      out.length + 1,
      'length counts the checksum the bus adds'
    );
    if (comm.baud !== t.baud)
      throw ifh('IFH-0009', 'no answer from ECU (timeout)');
    const p = out.slice(2);
    t.log.push(p);
    if (t.silentOnce === p[0]) {
      t.silentOnce = null;
      throw ifh('IFH-0009', 'no answer from ECU (timeout)');
    }
    switch (p[0]) {
      case 0x00:
        return reply(0xa0, [0x00, 0x1b, 0x00, 0x05, 0x00]);
      case 0x91: {
        const want = (p[1] << 16) | (p[2] << 8) | p[3];
        if (p[4] !== 1 || t.refuseFast) return reply(0xa2);
        const r = reply(0xa0);
        t.baud = want; // acted on after the acknowledgement goes out
        return r;
      }
      case 0x05:
        if (t.session) return reply(0xa2);
        t.session = true;
        return reply(0xa0);
      case 0x0b: {
        if (!t.session) return reply(0xa2);
        const block = new Array(45).fill(0);
        block[GS20VOLT - 3] = t.volts;
        return reply(0xa0, block);
      }
      case 0x90: {
        if (!t.session) return reply(0xa2);
        if (p[1] === 0x42 && p[2] === 0x4d && p[3] === 0x57) {
          if (t.unlocked) return reply(0xa0, [0x01]);
          // a 46-byte challenge of ASCII-ish bytes
          const data = [];
          for (let i = 0; i < 42; i++)
            data.push(0x30 + ((i * 11 + p[4]) % 0x40));
          const r = reply(0xa0, data);
          assert.strictEqual(r.length, 46);
          t.challenge = r;
          t.seed = p[4];
          return r;
        }
        const c = t.challenge;
        const want = [];
        for (let i = 0; i < 4; i++) {
          want[i] = (c[(t.seed + i) % 46] + c[18 + i] + c[41 + i]) & 0xff;
        }
        assert.deepStrictEqual(p.slice(1), want, 'unlock key');
        t.unlocked = true;
        return reply(0xa0, [0x07]);
      }
      case 0x06: {
        const addr = (p[1] << 24) | (p[2] << 16) | (p[3] << 8) | p[4];
        const n = p[5];
        const off = addr - G.GS20_CAL_ADDRESS;
        assert.ok(
          off >= 0 && off + n <= t.flash.length,
          'read inside the calibration'
        );
        // the module wraps a read that crosses a 16 KB page: never ask for one
        assert.ok(
          Math.floor(off / 0x4000) === Math.floor((off + n - 1) / 0x4000),
          'no page straddle'
        );
        return reply(0xa0, Array.from(t.flash.subarray(off, off + n)));
      }
      case 0x07: {
        if (!t.unlocked) return reply(0xa2);
        const addr = (p[2] << 16) | (p[3] << 8) | p[4];
        if (p[1] === 0x0f) {
          if (t.busyLeft > 0) {
            t.busyLeft--;
            return reply(0xa1);
          }
          return reply(0xa0, [0, 0, 0, 0, 0, 1, 0]);
        }
        if (p[1] === 0x06) {
          assert.strictEqual(
            addr,
            G.GS20_CAL_ADDRESS,
            'erase the calibration sector only'
          );
          t.flash.fill(0xff);
          t.erased = true;
          t.busyLeft = 3;
          return reply(0xa0, [0, 0, 0, 0, 0, 1, 0]);
        }
        if (p[1] === 0x02) {
          assert.ok(t.erased, 'written after the erase');
          const n = p[5];
          const data = p.slice(6);
          assert.strictEqual(
            data.length,
            n,
            'write length byte matches the data'
          );
          assert.ok(n <= 118, 'write chunk cap');
          const off = addr - G.GS20_CAL_ADDRESS;
          for (let i = 0; i < n; i++) {
            if (t.flash[off + i] !== 0xff)
              return reply(0xa0, [0, 0, 0, 0, 0, 3, 0]);
            t.flash[off + i] = data[i];
          }
          t.writes++;
          return reply(0xa0, [0, 0, 0, 0, 0, 1, 0]);
        }
        return reply(0xb0);
      }
      default:
        return reply(0xb0);
    }
  };
  return t;
}
const GS20VOLT = 10;

(async () => {
  // ── 4. the write sequence ──────────────────────────────────────────────
  console.log('\nwrite sequence');
  let tcu = makeTcu();
  let wire = new W.Ds2Wire(tcu.exchange);
  const stages = [];
  let last = 0;
  const writer = new G.Gs20CalWriter(wire, { note: (t) => stages.push(t) });
  // an image with blank pairs inside and a blank tail, so the skip/trim
  // paths run; its checksum is stale on purpose
  const image = Uint8Array.from(synth);
  image.fill(0xff, 0x100, 0x180); // a blank run in the middle
  image.fill(0xff, 0xfff0); // a blank tail (past the version block)
  image[0x0d] = 0xde;
  image[0x0e] = 0xad;
  const r = await writer.write(image, {
    onStage: (t) => stages.push(t),
    onProgress: (p) => (last = p),
  });
  assert.strictEqual(r.checksumCorrected, true);
  assert.ok(stages.some((s) => /checksum corrected 0xDEAD -> 0x/.test(s)));
  const want = G.gs20Checksum.correct(image);
  assert.deepStrictEqual(
    Array.from(tcu.flash),
    Array.from(want),
    'flash == corrected image'
  );
  assert.strictEqual(last, 100);
  // order: 05, 90 seed, 90 key, 07 0F (status before erase), 07 06, 07 0F ...
  const cmds = tcu.log.map((p) =>
    p[0] === 0x07
      ? `07 ${p[1].toString(16).padStart(2, '0')}`
      : p[0].toString(16).padStart(2, '0')
  );
  assert.strictEqual(cmds[0], '05');
  assert.strictEqual(cmds[1], '90');
  assert.strictEqual(cmds[2], '90');
  assert.strictEqual(
    cmds[3],
    '07 0f',
    'status query proves the unlock before the erase'
  );
  assert.strictEqual(cmds[4], '07 06');
  assert.deepStrictEqual(
    cmds.slice(5, 9),
    ['07 0f', '07 0f', '07 0f', '07 0f'],
    '3 busy polls + the ready one'
  );
  assert.ok(
    cmds.slice(9, -1).every((c) => c === '07 02'),
    'then only writes'
  );
  assert.strictEqual(cmds[cmds.length - 1], '07 0f', 'commit last');
  // blank pairs were never written, chunks are 118 or trimmed
  const writes = tcu.log.filter((p) => p[0] === 0x07 && p[1] === 0x02);
  assert.ok(writes.every((p) => p[5] <= 118));
  assert.ok(
    writes.every(
      (p) => !(p[6 + p[5] - 2] === 0xff && p[6 + p[5] - 1] === 0xff)
    ),
    'no chunk ends in a blank pair'
  );
  const touched = writes.reduce((n, p) => n + p[5], 0);
  assert.ok(
    touched < want.length,
    `only data cells programmed (${touched} of ${want.length})`
  );
  assert.ok(
    !writes.some(
      (p) => ((p[2] << 16) | (p[3] << 8) | p[4]) - G.GS20_CAL_ADDRESS === 0x100
    ),
    'the blank run was stepped over'
  );
  ok(
    `session, unlock, status, erase, ${writes.length} writes (${touched} bytes), commit: flash byte-identical`
  );

  // ── 5. the read ────────────────────────────────────────────────────────
  console.log('\nread');
  tcu.log = [];
  const got = await new G.Gs20CalReader(wire).read({
    onProgress: (p) => (last = p),
  });
  assert.deepStrictEqual(Array.from(got), Array.from(tcu.flash));
  const reads = tcu.log.filter((p) => p[0] === 0x06);
  assert.ok(reads.every((p) => p[5] <= 123));
  // the first chunk of every page starts exactly on the page
  for (const pg of [0, 1, 2, 3]) {
    assert.ok(
      reads.some(
        (p) =>
          ((p[2] << 16) | (p[3] << 8) | p[4]) ===
          G.GS20_CAL_ADDRESS + pg * 0x4000
      )
    );
  }
  ok(
    `64 KB read back identical over ${reads.length} chunks, none straddling a 16 KB page`
  );

  // ── 6. safety rails ────────────────────────────────────────────────────
  console.log('\nsafety rails');
  // a module that is open but refuses flash commands: nothing erased
  tcu = makeTcu();
  wire = new W.Ds2Wire(tcu.exchange);
  const refuser = tcu.exchange;
  tcu.exchange = async (out, comm) => {
    if (out[2] === 0x07 && out[3] === 0x0f && !tcu.erased) {
      // pretend the unlock did not really take
      return [0x32, 0x04, 0xa2, 0x32 ^ 0x04 ^ 0xa2];
    }
    return refuser(out, comm);
  };
  wire = new W.Ds2Wire(tcu.exchange);
  let w2 = new G.Gs20CalWriter(wire);
  await assert.rejects(
    () => w2.write(fixed),
    /not open for programming\. Nothing was erased/
  );
  assert.strictEqual(w2.eraseStarted, false);
  assert.ok(!tcu.erased, 'flash untouched');
  assert.ok(tcu.flash.every((b) => b === 0x55));
  ok(
    'a module not open for flash commands is refused before the erase, flash untouched'
  );

  // wrong size never reaches the wire
  tcu = makeTcu();
  wire = new W.Ds2Wire(tcu.exchange);
  w2 = new G.Gs20CalWriter(wire);
  await assert.rejects(
    () => w2.write(new Uint8Array(0x8000)),
    /0x10000 bytes; this one is 0x8000/
  );
  assert.strictEqual(tcu.log.length, 0);
  ok('a wrong-size image is refused with nothing sent');

  // the checksum goes out corrected: the module never sees the stale one
  tcu = makeTcu();
  wire = new W.Ds2Wire(tcu.exchange);
  await new G.Gs20CalWriter(wire).write(image);
  assert.strictEqual(tcu.flash[0x0d], want[0x0d]);
  assert.strictEqual(tcu.flash[0x0e], want[0x0e]);
  assert.ok(G.gs20Checksum.verify(tcu.flash));
  ok('the module receives a verified checksum, never the stale one');

  // cancel: stops the write loop; the error says the erase had started
  tcu = makeTcu();
  wire = new W.Ds2Wire(tcu.exchange);
  const ac = new AbortController();
  w2 = new G.Gs20CalWriter(wire);
  let n = 0;
  await assert.rejects(
    () =>
      w2.write(fixed, {
        abort: ac.signal,
        onProgress: () => {
          if (++n === 5) ac.abort();
        },
      }),
    /cancelled/
  );
  assert.strictEqual(w2.eraseStarted, true);
  assert.ok(
    tcu.writes >= 5 && tcu.writes < 100,
    `stopped after ${tcu.writes} writes`
  );
  ok(
    'cancel stops after the current chunk and the writer says the erase had started'
  );

  // a silent telegram is retried (three attempts), then succeeds
  tcu = makeTcu();
  wire = new W.Ds2Wire(tcu.exchange);
  tcu.silentOnce = 0x05;
  await new G.Gs20CalWriter(wire).write(fixed);
  assert.strictEqual(
    tcu.log.filter((p) => p[0] === 0x05).length,
    2,
    'sent once, resent once'
  );
  assert.deepStrictEqual(Array.from(tcu.flash), Array.from(fixed));
  ok('one silent answer is retried and the write completes');

  // a write the flash rejects stops with the address and the fault
  tcu = makeTcu();
  wire = new W.Ds2Wire(tcu.exchange);
  const pure = tcu.exchange;
  tcu.exchange = async (out, comm) => {
    const r = await pure(out, comm);
    if (out[2] === 0x07 && out[3] === 0x02 && tcu.writes === 10) {
      const bad = [0x32, 0x0b, 0xa0, 0, 0, 0, 0, 0, 2, 0];
      return [...bad, xor(bad)];
    }
    return r;
  };
  wire = new W.Ds2Wire(tcu.exchange);
  await assert.rejects(
    () => new G.Gs20CalWriter(wire).write(fixed),
    /write rejected at 0x09[0-9A-F]{4}: flash fault 2 \(write rejected\)/
  );
  ok('a rejected write names its address and the flash fault');

  // the unlock answers "already open" with a short reply: no key is sent
  tcu = makeTcu();
  tcu.unlocked = true;
  wire = new W.Ds2Wire(tcu.exchange);
  await new G.Gs20CalWriter(wire).write(fixed);
  assert.strictEqual(
    tcu.log.filter((p) => p[0] === 0x90).length,
    1,
    'seed only, no key'
  );
  ok('a module already open skips the key');

  // ── 7. baud change ─────────────────────────────────────────────────────
  console.log('\nbaud change');
  tcu = makeTcu();
  wire = new W.Ds2Wire(tcu.exchange);
  await wire.switchBaud(0x32, 125000);
  assert.strictEqual(wire.baud, 125000);
  assert.strictEqual(tcu.baud, 125000);
  const sw = tcu.log.find((p) => p[0] === 0x91);
  assert.deepStrictEqual(
    sw,
    [0x91, 0x01, 0xe8, 0x48, 0x01],
    '125000 = 01 E8 48, flag 1'
  );
  // the ident that settles it went out at the new rate (the module answered)
  assert.strictEqual(tcu.log[tcu.log.length - 1][0], 0x00);
  await wire.switchBaud(0x32, 9600);
  assert.strictEqual(tcu.baud, 9600);
  assert.deepStrictEqual(
    tcu.log.filter((p) => p[0] === 0x91)[1],
    [0x91, 0x00, 0x25, 0x80, 0x01],
    '9600 = 00 25 80'
  );
  ok(
    'switchBaud: 0x91 + 24-bit rate + flag, acknowledged at the old rate, followed'
  );

  tcu = makeTcu();
  tcu.refuseFast = true;
  wire = new W.Ds2Wire(tcu.exchange);
  await assert.rejects(
    () => wire.switchBaud(0x32, 125000),
    /did not change to 125000 baud/
  );
  assert.strictEqual(wire.baud, 9600, 'link stays where the module is');
  ok('a refused change leaves the link at the old rate and says so');

  // ── 8. the orchestration on the car ────────────────────────────────────
  console.log('\non the car');
  tcu = makeTcu();
  let locked = 0;
  global.webBus = { connected: true };
  global.withBusLock = async (fn) => {
    locked++;
    try {
      return await fn();
    } finally {
      locked--;
    }
  };
  global.webBusRawExchange = (out, comm) => {
    assert.strictEqual(locked, 1, 'every telegram goes out under the bus lock');
    return tcu.exchange(out, comm);
  };
  Object.assign(global, { ds2WireSession: undefined });
  // ds2WireSession is a top-level function in ds2-wire.js; in Node it is not
  // a global, so bind what the engine reaches for
  global.ds2WireSession = (fn, opts) => {
    if (!global.webBus.connected) throw new Error('no cable connected');
    return global.withBusLock(() =>
      fn(new W.Ds2Wire(global.webBusRawExchange, opts))
    );
  };

  assert.throws(
    () => G.gs20WriteCalibration(fixed, {}),
    /explicit confirmation/
  );
  ok('an unconfirmed write is refused before the bus is touched');

  const st = [];
  const res = await G.gs20WriteCalibration(fixed, {
    confirmed: true,
    onStage: (t) => st.push(t),
  });
  assert.strictEqual(res.volts, 12.44);
  assert.strictEqual(res.eraseStarted, true);
  assert.ok(st.includes('battery 12.4 V'));
  assert.ok(st.includes('baud 125000'));
  assert.strictEqual(tcu.baud, 9600, 'left at 9600');
  assert.strictEqual(
    tcu.log[tcu.log.length - 1][0],
    0x00,
    'session closed with an ident'
  );
  assert.deepStrictEqual(Array.from(tcu.flash), Array.from(fixed));
  // order on the car: session open, battery, baud switch, then the write
  const first = tcu.log.slice(0, 4).map((p) => p[0]);
  assert.deepStrictEqual(first, [0x05, 0x0b, 0x91, 0x00]);
  assert.strictEqual(locked, 0, 'lock released');
  ok(
    'write on the car: session, battery, fast baud, write, back to 9600, session closed'
  );

  // low battery refuses before anything is erased
  tcu = makeTcu();
  tcu.volts = 110; // 11.2 V
  await assert.rejects(
    () => G.gs20WriteCalibration(fixed, { confirmed: true }),
    (e) => /battery is 11\.2 V/.test(e.message) && e.eraseStarted === false
  );
  assert.ok(!tcu.erased);
  assert.strictEqual(tcu.baud, 9600);
  ok(
    'a low battery refuses the write with nothing erased, and the module is left at 9600'
  );

  // the read on the car: no session, fast baud, back to 9600
  tcu = makeTcu();
  const rd = await G.gs20ReadCalibration({ onStage: (t) => st.push(t) });
  assert.deepStrictEqual(Array.from(rd), Array.from(tcu.flash));
  assert.ok(!tcu.log.some((p) => p[0] === 0x05), 'a read opens no session');
  assert.strictEqual(tcu.baud, 9600);
  ok('read on the car: fast baud, 64 KB read, back to 9600, no session');

  // no cable
  global.webBus.connected = false;
  assert.throws(() => G.gs20ReadCalibration({}), /no cable connected/);
  ok('no cable: refused before the lock is taken');

  console.log(`\ngs20: ${passed} checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
});
