#!/usr/bin/env node
// Engine protection and the spark cut rev limiter
// (app/renderer/core/ms45-protect.js), ported from ms45-emu's
// ms45emu/protect.py, whose code was run in the emulator.
//
// WHAT THIS PROVES
//   1. On the stock donor pair (when on disk) seven builds -- the defaults,
//      one part switched off, one alone, other numbers -- are, once
//      checksummed and signed, byte-identical to what the Python builder
//      writes, pinned by SHA-256.
//   2. On a synthetic stock-like pair, always: the gates (program version,
//      the scheduling routine's entry, the free area), what a build changes and
//      what it leaves alone (the limiter's own code above all), that the
//      config reads back out of a built pair, a rebuild with other numbers,
//      removal, an earlier version's three gated calls told apart and
//      undone, the config rules, and the stock limit read from a car's
//      tables.
//   3. It stacks with the map switch in either order.
//
// Run: node tools/verify/test_ms45_protect.js
//      MS45_DIR=/path/to/e46bins/MS45-DME node tools/verify/test_ms45_protect.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

global.Settings = { get: () => 'no' };
const F = require('../../app/renderer/core/flasher.js');
global._md5 = F._md5;
global._modPow = F._modPow;
// flasher.js keeps these two private; the browser build shares them as globals
global._bytesLEToBigInt = (bytes) => {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
};
global._bigIntToBytesLE = (value, outLen) => {
  const o = new Uint8Array(outLen);
  let v = value;
  for (let i = 0; i < outLen; i++) {
    o[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return o;
};
const { ms45Checksums } = require('../../app/renderer/core/ms45.js');
const { mapSwitch } = require('../../app/renderer/core/mapswitch.js');
const { ms45Protect } = require('../../app/renderer/core/ms45-protect.js');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const OFF = { sparkCut: false, oilC: null, coolantC: null, coldWarmC: null };
const LIMITS_OFF = { oilC: null, coolantC: null, coldWarmC: null };

// ── 1. the reference builds ─────────────────────────────────────────────────
console.log('\nreference builds');
const dir =
  process.env.MS45_DIR ||
  path.join(process.env.HOME || '', 'Desktop/e46bins/MS45-DME');
const stockFlash = path.join(
  dir,
  'stock',
  'NJ87379_0044570_Flash_donor_stock.bin'
);
const stockMpc = path.join(dir, 'stock', 'NJ87379_0044570_MPC_donor_stock.bin');
const STOCK = {
  flash: 'b4241f614bb2e7b9f21db8dfab1d3b738710bfea72625f5ef4d35d89ce21e8b6',
  mpc: '84dafd81fe779f08a68f458cc6b9e48d26a3e222a3f214bb69c0be8e50f5d38a',
};
const CASES = {
  defaults: {},
  noSparkCut: { sparkCut: false },
  coldOnly: { ...OFF, coldWarmC: 60, coldRpm: 3000 },
  custom: {
    oilC: 140,
    oilRpm: 4000,
    coolantC: 110,
    coolantRpm: 5000,
    coldWarmC: 45,
    coldRpm: 3200,
  },
  oilCoolant: { sparkCut: false, coldWarmC: null },
  sparkCutOnly: LIMITS_OFF,
  sparkCutAndCold: { oilC: null, coolantC: null },
};
// what ms45emu/protect.py builds from the same pair and the same numbers
const PINNED = {
  defaults: {
    flash: 'ee5a04af51c5dc44d2a0a36af2efc79be6af71b70f72a658683b1e88a994cc85',
    mpc: '1840c8a479cf90758b99a87a7043c8cc75c912dccec18ad2c023a5c56e2c8de1',
    codeBytes: 120,
  },
  noSparkCut: {
    flash: '033901a32f626df67f839fe25cb9a4308284a297207e9195dfd79f233fb060fe',
    mpc: '1840c8a479cf90758b99a87a7043c8cc75c912dccec18ad2c023a5c56e2c8de1',
    codeBytes: 104,
  },
  coldOnly: {
    flash: 'c9ff510b5b024ea7d9ba56ae020ffc31826063b555e317aa652e3ba254d16e03',
    mpc: '1840c8a479cf90758b99a87a7043c8cc75c912dccec18ad2c023a5c56e2c8de1',
    codeBytes: 48,
  },
  custom: {
    flash: 'b8457b614b14e472198ebcb71e06bc8d77fb0c437b20e364d18f0f226f29e594',
    mpc: '1840c8a479cf90758b99a87a7043c8cc75c912dccec18ad2c023a5c56e2c8de1',
    codeBytes: 120,
  },
  oilCoolant: {
    flash: '764a076eba924000866a5b327ec1a9a8744cbae30d862e1d8d83f2baf48b5c12',
    mpc: '1840c8a479cf90758b99a87a7043c8cc75c912dccec18ad2c023a5c56e2c8de1',
    codeBytes: 80,
  },
  sparkCutOnly: {
    flash: '34bfbf09d1c9f5a4c435fbb5614230c89573a0c352a48e30edb79aebbb9efbc7',
    mpc: '1840c8a479cf90758b99a87a7043c8cc75c912dccec18ad2c023a5c56e2c8de1',
    codeBytes: 40,
  },
  sparkCutAndCold: {
    flash: '2808cf59ab58a67b6fea6355fdddab19726c568e498c7a864871a788e9c14c56',
    mpc: '1840c8a479cf90758b99a87a7043c8cc75c912dccec18ad2c023a5c56e2c8de1',
    codeBytes: 64,
  },
};
if (fs.existsSync(stockFlash) && fs.existsSync(stockMpc)) {
  const flash = new Uint8Array(fs.readFileSync(stockFlash));
  const mpc = new Uint8Array(fs.readFileSync(stockMpc));
  if (sha(flash) === STOCK.flash && sha(mpc) === STOCK.mpc) {
    assert.strictEqual(ms45Protect.blockedReason(flash, mpc), null);
    for (const [name, config] of Object.entries(CASES)) {
      const r = ms45Protect.apply(flash, mpc, config);
      const signed = ms45Checksums.signProgram(
        ms45Checksums.correctProgramChecksums(r.flash, r.mpc),
        r.mpc
      );
      assert.strictEqual(sha(signed), PINNED[name].flash, `${name} flash`);
      assert.strictEqual(sha(r.mpc), PINNED[name].mpc, `${name} mpc`);
      assert.strictEqual(r.codeBytes, PINNED[name].codeBytes, `${name} size`);
    }
    ok(
      'seven builds are byte-identical to the Python builder, checksums and signature included (SHA-256 pinned)'
    );
    const r = ms45Protect.apply(flash, mpc);
    const back = ms45Protect.remove(r.flash, r.mpc);
    assert.deepStrictEqual(back.flash, flash);
    assert.deepStrictEqual(back.mpc, mpc);
    ok('removal gives the stock pair back');

    const tables = flash.subarray(
      ms45Protect.LIMIT_TABLES_START,
      ms45Protect.LIMIT_TABLES_END + 1
    );
    assert.strictEqual(ms45Protect.stockLimit(tables, 3), 6620);
    assert.strictEqual(ms45Protect.stockLimit(tables, 1), 6520);
    assert.strictEqual(ms45Protect.stockLimit(tables, null), 6520);
    ok(
      'the stock limit reads out of the tables: 6620 rpm automatic, 6520 manual'
    );

    const ms = mapSwitch.build(flash, mpc, null, null, 'shifter');
    const both = ms45Protect.apply(ms.flash, ms.mpc);
    assert.ok(mapSwitch.isCurrentVersion(both.mpc));
    assert.deepStrictEqual(
      ms45Protect.installed(both.flash, both.mpc),
      ms45Protect.DEFAULTS
    );
    const other = mapSwitch.build(r.flash, r.mpc, null, null, 'shifter');
    assert.deepStrictEqual(other.mpc, both.mpc);
    assert.deepStrictEqual(other.flash, both.flash);
    ok(
      'with the map switch: the same pair whichever goes on first, and each still recognised'
    );
  } else console.log('  skip  the stock pair on disk is not the pinned one');
} else console.log('  skip  reference builds (set MS45_DIR to run this)');

// ── 2. a synthetic stock-like pair ─────────────────────────────────────────
console.log('\nsynthetic pair');
const ENTRY = 0x377a8; // the spark scheduling routine, and its first instruction
const ENTRY_WORD = 0x7c0802a6;
const SITES = [
  // the calls an earlier version redirected
  [0x379cc, 0x377a8],
  [0x193c4, 0x1f938],
  [0x1976c, 0x1f938],
];
const LIMIT_SITE = 0x96950; // where the stock limiter stores its limit: must never change
const LIMIT_STORE = 0xb3cdb42a;
const CODE = 0xdc860;
const EXT = 0xfff00000;
function w32(a, at, v) {
  a[at] = (v >>> 24) & 0xff;
  a[at + 1] = (v >>> 16) & 0xff;
  a[at + 2] = (v >>> 8) & 0xff;
  a[at + 3] = v & 0xff;
}
const r32 = (a, at) =>
  ((a[at] << 24) | (a[at + 1] << 16) | (a[at + 2] << 8) | a[at + 3]) >>> 0;
const bl = (from, to) => ((18 << 26) | ((to - from) & 0x03fffffc) | 1) >>> 0;
function syntheticPair() {
  const mpc = new Uint8Array(0x70000);
  for (let i = 0; i < mpc.length; i++) mpc[i] = (i * 13 + 5) & 0xff;
  for (const [site, original] of SITES) w32(mpc, site, bl(site, original));
  w32(mpc, ENTRY, ENTRY_WORD);
  const flash = new Uint8Array(0x100000);
  for (let i = 0; i < flash.length; i++) flash[i] = (i * 7 + 1) & 0xff;
  flash.fill(0xff, CODE, 0xe0000);
  flash.set(Buffer.from('0044570LO02S'), 0x6031c);
  w32(flash, LIMIT_SITE, LIMIT_STORE);
  return { flash, mpc };
}
/** The word-aligned offsets where two images differ. */
function changed(a, b) {
  const at = new Set();
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) at.add(i & ~3);
  return [...at].sort((x, y) => x - y);
}

{
  const { flash, mpc } = syntheticPair();
  assert.strictEqual(ms45Protect.blockedReason(flash, mpc), null);
  assert.ok(!ms45Protect.isApplied(flash, mpc));
  assert.strictEqual(ms45Protect.installed(flash, mpc), null);

  const other = Uint8Array.from(flash);
  other.set(Buffer.from('0044570LO00S'), 0x6031c);
  assert.match(ms45Protect.blockedReason(other, mpc), /only built for program/);
  const moved = Uint8Array.from(mpc);
  w32(moved, 0x193c4, bl(0x193c4, 0x20000));
  assert.match(
    ms45Protect.blockedReason(flash, moved),
    /ignition call at 0x193C4/
  );
  const used = Uint8Array.from(flash);
  used[CODE + 0x10] = 0;
  assert.match(ms45Protect.blockedReason(used, mpc), /not empty at 0xDC860/);
  assert.match(ms45Protect.blockedReason(new Uint8Array(10), mpc), /1 MB/);
  assert.match(ms45Protect.blockedReason(flash, new Uint8Array(10)), /448 KB/);
  ok(
    'another program, a moved ignition call, a used free area and wrong sizes are refused'
  );
  const noEntry = Uint8Array.from(mpc);
  w32(noEntry, ENTRY, 0x60000000);
  assert.match(
    ms45Protect.blockedReason(flash, noEntry),
    /spark scheduling routine at 0x377A8/
  );
  assert.throws(() => ms45Protect.remove(flash, noEntry), /neither its own/);
  ok('a scheduling routine that does not begin as expected is refused');

  // the spark cut alone: one 10-word gate, only the routine's entry changed
  const jump = (from, to) => ((18 << 26) | ((to - from) & 0x03fffffc)) >>> 0;
  const cut = ms45Protect.apply(flash, mpc, LIMITS_OFF);
  assert.strictEqual(cut.codeBytes, 40);
  assert.deepStrictEqual(changed(cut.mpc, mpc), [ENTRY]);
  assert.strictEqual(r32(cut.mpc, ENTRY), jump(ENTRY, (EXT + CODE) | 0));
  // li r12,0x7fff; lbz r11,limp(r13); cmpwi r11,0; bne +8 -> past the lhz;
  // lhz r12,limit(r13); lhz r0,N(r13); cmplw r0,r12; bgelr; mflr r0; b entry+4
  assert.deepStrictEqual(
    [0, 4, 8, 12, 16, 20, 24, 28, 32].map((o) => r32(cut.flash, CODE + o)),
    [
      0x39807fff,
      0x896dbf95,
      0x2c0b0000,
      0x40820008,
      0xa18db42a,
      0xa00db414,
      0x7c006040,
      0x4c800020,
      ENTRY_WORD,
    ]
  );
  const tail = r32(cut.flash, CODE + 36);
  assert.strictEqual(tail >>> 26, 18);
  assert.strictEqual(tail & 3, 0);
  assert.strictEqual(
    (EXT + CODE + 36 + (((tail & 0x03fffffc) << 6) >> 6)) >>> 0,
    ENTRY + 4
  );
  for (const i of changed(cut.flash, flash))
    assert.ok(i >= CODE && i < CODE + 40, i.toString(16));
  assert.strictEqual(
    r32(cut.flash, LIMIT_SITE),
    LIMIT_STORE,
    "the limiter's own store is never touched"
  );
  ok(
    "the spark cut alone: one 40-byte gate at the routine's entry, reading the stored limit, with the limp-home stand-down"
  );

  // the temperature limits alone: a gate still, no limp check, start from "no cut"
  const limits = ms45Protect.apply(flash, mpc, { sparkCut: false });
  assert.strictEqual(limits.codeBytes, 104);
  assert.deepStrictEqual(changed(limits.mpc, mpc), [ENTRY]);
  // li r12,0x7fff then straight into the cold block
  assert.strictEqual(r32(limits.flash, CODE), 0x39807fff);
  assert.strictEqual(r32(limits.flash, CODE + 4), 0x896dbfc8); // lbz r11,coolant(r13)
  assert.strictEqual(r32(limits.flash, CODE + 8), 0x280b005a); // cmplwi r11,50+40
  assert.strictEqual(r32(limits.flash, CODE + 16), 0x280c0dac); // cmplwi r12,3500
  assert.strictEqual(r32(limits.flash, CODE + 24), 0x39800dac); // li r12,3500
  assert.strictEqual(r32(limits.flash, LIMIT_SITE), LIMIT_STORE);
  ok(
    'the temperature limits alone: one 104-byte gate, the limiter still untouched'
  );

  const all = ms45Protect.apply(flash, mpc);
  assert.strictEqual(all.codeBytes, 120);
  assert.ok(!ms45Protect.isOutdated(all.flash, all.mpc));
  assert.strictEqual(r32(all.flash, LIMIT_SITE), LIMIT_STORE);
  assert.deepStrictEqual(
    ms45Protect.installed(all.flash, all.mpc),
    ms45Protect.DEFAULTS
  );
  for (const config of [
    { sparkCut: false },
    LIMITS_OFF,
    { ...OFF, coldWarmC: 60, coldRpm: 3000 },
    { ...OFF, oilC: 140, oilRpm: 4000 },
    { ...OFF, coolantC: 110, coolantRpm: 5000 },
    { oilC: 140, oilRpm: 4000, coldWarmC: null },
    { oilC: null, coolantC: 120, coolantRpm: 4000 },
  ]) {
    const b = ms45Protect.apply(flash, mpc, config);
    assert.deepStrictEqual(ms45Protect.installed(b.flash, b.mpc), {
      ...ms45Protect.DEFAULTS,
      ...config,
    });
  }
  const foreign = Uint8Array.from(all.flash);
  foreign[CODE + 7] ^= 1;
  assert.strictEqual(ms45Protect.installed(foreign, all.mpc), null);
  ok(
    'the numbers read back out of a built pair; code that is not ours reads as unknown'
  );

  // a pair from an earlier build, which hooked the limiter's store: the hook
  // is undone on removal and on a rebuild, and it is not mistaken for our code
  const earlier = { flash: Uint8Array.from(flash), mpc: Uint8Array.from(mpc) };
  w32(earlier.flash, LIMIT_SITE, bl(LIMIT_SITE, CODE + 0x60));
  for (let i = 0; i < 0x80; i++) earlier.flash[CODE + i] = i;
  assert.ok(ms45Protect.isApplied(earlier.flash, earlier.mpc));
  assert.strictEqual(ms45Protect.installed(earlier.flash, earlier.mpc), null);
  assert.strictEqual(
    ms45Protect.blockedReason(earlier.flash, earlier.mpc),
    null
  );
  const stripped = ms45Protect.remove(earlier.flash, earlier.mpc);
  assert.deepStrictEqual(stripped.flash, flash);
  const rebuilt = ms45Protect.apply(earlier.flash, earlier.mpc);
  assert.deepStrictEqual(rebuilt.flash, all.flash);
  assert.strictEqual(r32(rebuilt.flash, LIMIT_SITE), LIMIT_STORE);
  const odd = Uint8Array.from(flash);
  w32(odd, LIMIT_SITE, 0x60000000);
  assert.match(
    ms45Protect.blockedReason(odd, mpc),
    /engine speed limit at 0x96950/
  );
  assert.throws(() => ms45Protect.remove(odd, mpc), /neither stock nor/);
  ok("an earlier build's limiter hook is undone on removal and rebuild");

  // a pair from the version before this one: the segment task's call and two
  // channel set-up requests go to gates, the routine's entry is stock. On a
  // car that cut nothing, so it is told apart, never read as ours, and
  // replaced whole.
  const three = { flash: Uint8Array.from(flash), mpc: Uint8Array.from(mpc) };
  SITES.forEach(([site], i) => {
    const gate = CODE + 0x74 * i;
    w32(three.mpc, site, bl(site, (EXT + gate) | 0));
    for (let o = 0; o < 0x74; o += 4) w32(three.flash, gate + o, 0x60000000);
  });
  assert.ok(ms45Protect.isApplied(three.flash, three.mpc));
  assert.ok(ms45Protect.isOutdated(three.flash, three.mpc));
  assert.ok(ms45Protect.isOutdated(earlier.flash, earlier.mpc));
  assert.strictEqual(ms45Protect.installed(three.flash, three.mpc), null);
  assert.strictEqual(ms45Protect.blockedReason(three.flash, three.mpc), null);
  const plain = ms45Protect.remove(three.flash, three.mpc);
  assert.deepStrictEqual(plain.flash, flash);
  assert.deepStrictEqual(plain.mpc, mpc);
  const renewed = ms45Protect.apply(three.flash, three.mpc);
  assert.ok(renewed.replaced);
  assert.deepStrictEqual(renewed.flash, all.flash);
  assert.deepStrictEqual(renewed.mpc, all.mpc);
  assert.ok(!ms45Protect.isOutdated(renewed.flash, renewed.mpc));
  ok(
    "the earlier version's three gated calls are told apart, undone on removal and replaced on a rebuild"
  );

  const again = ms45Protect.apply(all.flash, all.mpc, { sparkCut: false });
  assert.ok(again.replaced);
  assert.deepStrictEqual(again.flash, limits.flash);
  assert.deepStrictEqual(again.mpc, limits.mpc);
  const back = ms45Protect.remove(all.flash, all.mpc);
  assert.deepStrictEqual(back.flash, flash);
  assert.deepStrictEqual(back.mpc, mpc);
  assert.deepStrictEqual(ms45Protect.remove(flash, mpc).mpc, mpc);
  assert.throws(() => ms45Protect.remove(flash, moved), /neither stock nor/);
  ok(
    'a rebuild with other numbers replaces the gate whole; removal restores the pair'
  );

  assert.strictEqual(ms45Protect.configError({}), null);
  assert.match(ms45Protect.configError({ coldRpm: 9000 }), /cold limit/);
  assert.match(ms45Protect.configError({ oilC: 250 }), /oil temperature/);
  assert.match(ms45Protect.configError({ oilRpm: 4500.5 }), /oil limit/);
  assert.match(ms45Protect.configError(OFF), /switched off/);
  assert.match(
    ms45Protect.configError({ coldWarmC: 120, coolantC: 115 }),
    /warm-up temperature is above/
  );
  assert.strictEqual(
    ms45Protect.configError({ oilC: null, oilRpm: 99999 }),
    null,
    'a limit that is switched off is not checked'
  );
  assert.throws(
    () => ms45Protect.apply(flash, mpc, { coldRpm: 100 }),
    /cold limit/
  );
  assert.strictEqual(ms45Protect.describe({}).length, 4);
  assert.match(
    ms45Protect.describe({ ...OFF, coldWarmC: 50 })[0],
    /spark cut at 3500 rpm until the coolant is at 50/
  );
  ok(
    'config rules: ranges, whole numbers, nothing switched on, warm-up above the maximum'
  );

  // the stock limit, from three made-up tables: automated manual, automatic, ..., manual
  const tables = new Uint8Array(
    ms45Protect.LIMIT_TABLES_END - ms45Protect.LIMIT_TABLES_START + 1
  );
  const put = (calOffset, rpms) =>
    rpms.forEach((rpm, gear) => {
      const at =
        0x40000 + calOffset - ms45Protect.LIMIT_TABLES_START + 2 * gear;
      tables[at] = rpm >> 8;
      tables[at + 1] = rpm & 0xff;
    });
  put(0x60d4, [6000, 6100, 6100, 6100, 6100, 6100, 6100, 6100, 6100]);
  put(0x60e6, [6520, 6620, 6620, 6700, 6620, 6620, 6620, 6620, 6620]);
  put(0x612e, [7000, 6520, 6520, 6520, 6520, 6520, 6520, 6520, 6520]);
  assert.strictEqual(ms45Protect.stockLimit(tables, 3), 6700);
  assert.strictEqual(ms45Protect.stockLimit(tables, 2), 6100);
  assert.strictEqual(
    ms45Protect.stockLimit(tables, 1),
    6520,
    'gear 0 is not a gear'
  );
  assert.strictEqual(ms45Protect.stockLimit(tables, null), 6100);
  assert.strictEqual(ms45Protect.stockLimit(tables, 9), 6100);
  assert.strictEqual(ms45Protect.stockLimit(tables.subarray(1), 3), null);
  assert.strictEqual(ms45Protect.stockLimit(new Uint8Array(108), 3), null);
  ok(
    "the stock limit: the car's own table by transmission, the lowest when that is unknown"
  );
}

console.log(`\nms45-protect: ${passed} checks passed`);
