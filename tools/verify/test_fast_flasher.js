#!/usr/bin/env node
// The resident fast flasher's app side (app/renderer/core/flash/fast-flasher*.js),
// exercised offline. The DME side and the wire bytes are proven in ms45-emu
// (tools/flasher_session_test.py, mpc_session_test.py); what this pins is
// everything the app decides on its own:
//   1. Framing: the frame layout, the u16 length escape a 4 KB CHUNK needs,
//      the checksum, a stream that is still incomplete, a corrupt reply.
//   2. CRC-32/MPEG-2 against a known vector -- the same CRC the DME's own
//      program checksums use, and what SECTOR_QUERY/VERIFY compare.
//   3. The chip models the pushes compare against: the cal sector and the
//      program area as the loader leaves them (marks included), and what is
//      WRITTEN (marks blank -- only MARKS burns them, last).
//   4. The push sequencing against an in-memory chip: everything differs,
//      nothing differs, one sector differs; the marks' sector erased first
//      and written last; verify after each unit; MARKS then RESET at the end.
//   5. Detection: the stamp + hook, a hook that no longer leads to the gate,
//      a newer version than the app speaks, a malformed stamp.
//   6. The bootstrap splice: guards (blank body range, stock reset word),
//      idempotence, that it touches nothing outside the body range, and that
//      the result is detected as ready.
//
// Run: node tools/verify/test_fast_flasher.js
const assert = require('assert');

global.nrv2b = require('../../app/renderer/core/flash/nrv2b.js').nrv2b;
global.fastFlasherBlob =
  require('../../app/renderer/core/flash/fast-flasher-blob.js').fastFlasherBlob;
const {
  fastFlasher,
} = require('../../app/renderer/core/flash/fast-flasher.js');
const {
  fastFlashWire: W,
} = require('../../app/renderer/core/flash/fast-flasher-wire.js');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const be32 = (b, at) =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

(async () => {
  // ---- 1. framing -----------------------------------------------------------
  console.log('\nframing');
  {
    const f = W.frame(W.SVC.ERASE, [0x00, 0x04, 0x00, 0x00]);
    assert.strictEqual(
      f[0],
      8,
      'n counts tgt..cksum: 12 F1 02 + 4 data + cksum'
    );
    const p = W.parse(f);
    assert(p && p.svc === W.SVC.ERASE && p.used === f.length);
    assert.deepStrictEqual([...p.data], [0, 4, 0, 0]);
    const big = new Uint8Array(4200).map((_, i) => i & 0xff);
    const long = W.frame(W.SVC.CHUNK, big);
    assert.strictEqual(
      long[0],
      0,
      'a frame past 255 bytes escapes to a u16 length'
    );
    assert.strictEqual((long[1] << 8) | long[2], 3 + big.length + 1);
    const pl = W.parse(long);
    assert(pl && pl.data.length === big.length && pl.used === long.length);
    assert.deepStrictEqual([...pl.data], [...big]);
    assert.strictEqual(
      W.parse(long.subarray(0, 10)),
      null,
      'incomplete: not yet'
    );
    assert.strictEqual(W.parse([]), null);
    const bad = Uint8Array.from(f);
    bad[bad.length - 1] ^= 0xff;
    assert.throws(() => W.parse(bad), /checksum/);
    ok(
      'short and long (u16-escaped) frames round-trip; incomplete streams wait; a bad checksum is refused'
    );
  }

  // ---- 2. the CRC ------------------------------------------------------------
  console.log('\ncrc');
  assert.strictEqual(W.crc32(Buffer.from('123456789')), 0x0376e6e7);
  ok('CRC-32/MPEG-2 of "123456789" is 0376E6E7');

  // ---- 3. the chip models ----------------------------------------------------
  console.log('\nchip models');
  {
    const cal = new Uint8Array(W.CAL_LENGTH).fill(0xab);
    const sec = W.calSectorImage(cal);
    assert.strictEqual(sec.length, 0x20000);
    assert(sec.subarray(0, W.CAL_LENGTH).every((b) => b === 0xab));
    assert.strictEqual(be32(sec, 0x1ff80), 0x48249042);
    assert.strictEqual(be32(sec, 0x1ffc0), 0x90482442);
    assert(sec.subarray(W.CAL_LENGTH, 0x1ff80).every((b) => b === 0xff));
    ok('the cal sector: the signed cal, blank, the two cal marks');

    const full = new Uint8Array(0x100000).fill(0x11);
    const area = W.programAreaImage(full);
    assert.strictEqual(area.length, 0xa0000);
    assert.strictEqual(be32(area, 0xfff80 - 0x60000), 0x42902448);
    assert.strictEqual(be32(area, 0xfffc0 - 0x60000), 0x42244890);
    assert(
      area
        .subarray(0xfff40 - 0x60000, 0xfff80 - 0x60000)
        .every((b) => b === 0xff)
    );
    const units = W.programUnits(full, new Uint8Array(0x70000));
    assert.strictEqual(units.length, 17);
    assert.deepStrictEqual(
      units.slice(0, 3).map((u) => u.addr),
      [0x60000, 0x80000, 0xc0000]
    );
    assert.strictEqual(
      units[3].addr >>> 0,
      (W.MPC_WINDOW | 0x68000) >>> 0,
      'MPC block 13 first'
    );
    assert.strictEqual(
      units[16].addr >>> 0,
      W.MPC_WINDOW >>> 0,
      'MPC block 0 last'
    );
    const marks = units.find((u) => u.holdsMarks);
    assert.strictEqual(marks.addr, 0xc0000);
    assert.strictEqual(
      be32(marks.bytes, 0xfff80 - 0xc0000),
      0x42902448,
      'compared WITH the marks'
    );
    assert.strictEqual(
      be32(marks.write, 0xfff80 - 0xc0000),
      0xffffffff,
      'written WITHOUT them'
    );
    assert.strictEqual(
      W.programUnits(full, null).length,
      3,
      'no MPC: external only'
    );
    ok(
      'the program area and its 17 units: ext sectors, MPC 13..0, marks compared but never written'
    );
  }

  // ---- 4. push sequencing ----------------------------------------------------
  console.log('\npush sequencing');
  const chip = (initial) => {
    const mem = Uint8Array.from(initial);
    const events = [];
    const sizes = {
      0x40000: 0x20000,
      0x60000: 0x20000,
      0x80000: 0x40000,
      0xc0000: 0x40000,
    };
    const client = {
      async sectorQuery(off, len) {
        events.push(['query', off]);
        return W.crc32(mem.subarray(off, off + len));
      },
      async erase(off) {
        events.push(['erase', off]);
        mem.fill(0xff, off, off + sizes[off]);
      },
      async chunk(off, plain) {
        events.push(['chunk', off]);
        assert(
          plain.length % 2 === 0 && plain.length <= 4096,
          'declen even, <= 4 KB'
        );
        mem.set(plain, off);
        return global.nrv2b.encode(plain).length;
      },
      async verify(off, len, crc) {
        events.push(['verify', off]);
        assert.strictEqual(
          W.crc32(mem.subarray(off, off + len)),
          crc,
          'verify CRC'
        );
      },
      async marks(which) {
        events.push(['marks', which]);
        const m = which
          ? [
              [0xfff80, 0x42902448],
              [0xfffc0, 0x42244890],
            ]
          : [
              [0x5ff80, 0x48249042],
              [0x5ffc0, 0x90482442],
            ];
        for (const [at, w] of m)
          mem.set([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255], at);
      },
      async reset() {
        events.push(['reset']);
      },
    };
    return { mem, events, client };
  };
  const image = (seed) => {
    const f = new Uint8Array(0x100000).fill(0xff);
    let x = seed >>> 0;
    const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 0xff;
    for (let i = 0x60000; i < 0xfff40; i++)
      f[i] = i % 4096 < 3500 ? rnd() : 0xff;
    return f;
  };
  {
    const target = image(1);
    const onChip = new Uint8Array(0x100000).fill(0xff);
    onChip.set(W.programAreaImage(target), 0x60000);

    let c = chip(new Uint8Array(0x100000).fill(0xff));
    const seen = [];
    let r = await W.pushProgram(c.client, target, {
      progress: (p) => seen.push(p),
    });
    assert.strictEqual(r.sectorsWritten, 3);
    assert(
      seen[seen.length - 1] === 100 &&
        seen.every((p, i) => !i || p >= seen[i - 1])
    );
    assert(
      Buffer.from(c.mem.subarray(0x60000)).equals(
        Buffer.from(W.programAreaImage(target))
      )
    );
    let k = c.events.map((e) => e[0]);
    assert.strictEqual(c.events[0][0], 'query');
    assert.strictEqual(
      c.events.filter((e) => e[0] === 'erase')[0][1],
      0xc0000,
      'the marks sector is erased first'
    );
    assert.deepStrictEqual(k.slice(-2), ['marks', 'reset']);
    assert.strictEqual(
      c.events[c.events.length - 2][1],
      1,
      'MARKS 1 for the program'
    );
    ok(
      'from blank: 3 sectors written, marks sector erased first, MARKS 1 then RESET, chip == target'
    );

    c = chip(onChip);
    r = await W.pushProgram(c.client, target, {});
    assert(
      r.skipped && !c.events.some((e) => e[0] !== 'query' && e[0] !== 'reset')
    );
    ok('nothing differs: queries and a RESET, nothing erased, nothing written');

    const t2 = Uint8Array.from(target);
    for (let i = 0x80000; i < 0x80100; i++) t2[i] ^= 0x5a;
    c = chip(onChip);
    r = await W.pushProgram(c.client, t2, {});
    assert.strictEqual(
      r.sectorsWritten,
      2,
      'the changed sector and the marks sector'
    );
    assert.deepStrictEqual(
      c.events.filter((e) => e[0] === 'erase').map((e) => e[1]),
      [0xc0000, 0x80000]
    );
    k = c.events;
    const firstMarksChunk = k.findIndex(
      (e) => e[0] === 'chunk' && e[1] >= 0xc0000
    );
    const verify80 = k.findIndex((e) => e[0] === 'verify' && e[1] === 0x80000);
    assert(
      firstMarksChunk > verify80,
      'the marks sector is written after every other unit is verified'
    );
    assert(
      Buffer.from(c.mem.subarray(0x60000)).equals(
        Buffer.from(W.programAreaImage(t2))
      )
    );
    ok(
      'one sector differs: only it and the marks sector move; the marks sector goes last'
    );

    const cal = new Uint8Array(W.CAL_LENGTH).map((_, i) => (i * 7) & 0xff);
    c = chip(new Uint8Array(0x100000).fill(0xff));
    r = await W.pushCal(c.client, cal, {});
    assert(!r.skipped && r.chunks > 0);
    assert(
      Buffer.from(c.mem.subarray(0x40000, 0x60000)).equals(
        Buffer.from(W.calSectorImage(cal))
      )
    );
    assert.deepStrictEqual(c.events.map((e) => e[0]).slice(-3), [
      'verify',
      'marks',
      'reset',
    ]);
    c = chip(c.mem);
    r = await W.pushCal(c.client, cal, {});
    assert(r.skipped);
    ok(
      'the cal push: erase, chunks, verify, MARKS 0, RESET; a matching cal is not rewritten'
    );

    await assert.rejects(
      () => W.pushProgram(c.client, new Uint8Array(16), {}),
      /not 1 MB/
    );
    await assert.rejects(
      () => W.pushCal(c.client, new Uint8Array(16), {}),
      /0x1D000/
    );
    ok('wrong image sizes are refused before anything is sent');
  }

  // ---- 4b. the v8 MPC push: pagesets over the blocks that differ -------------
  console.log('\nMPC pagesets');
  {
    const BLOCK = 0x8000;
    const WIN = 0x80000000;
    const mpcChip = (ext, mpc0) => {
      const mem = Uint8Array.from(ext);
      const mpc = Uint8Array.from(mpc0);
      const events = [];
      const isMpc = (off) => off >= WIN;
      const client = {
        async sectorQuery(off, len) {
          events.push(['query', off]);
          const a = isMpc(off)
            ? mpc.subarray(off - WIN, off - WIN + len)
            : mem.subarray(off, off + len);
          return W.crc32(a);
        },
        async erase(off) {
          events.push(['erase', off]);
          if (isMpc(off)) mpc.fill(0xff, off - WIN, off - WIN + BLOCK);
          else
            mem.fill(
              0xff,
              off,
              off +
                { 0x60000: 0x20000, 0x80000: 0x40000, 0xc0000: 0x40000 }[off]
            );
        },
        async eraseBlocks(mask) {
          events.push(['eraseBlocks', mask]);
          for (let b = 0; b < 14; b++)
            if ((mask >> b) & 1) mpc.fill(0xff, b * BLOCK, (b + 1) * BLOCK);
        },
        async chunk(off, plain) {
          events.push(['chunk', off]);
          if (isMpc(off)) {
            for (let i = 0; i < plain.length; i++)
              mpc[off - WIN + i] &= plain[i];
          } else mem.set(plain, off);
          return plain.length;
        },
        async chunkSet(mask, offset, pagesets, plain) {
          events.push(['chunkSet', mask, offset, pagesets]);
          const blocks = [];
          for (let b = 0; b < 14; b++) if ((mask >> b) & 1) blocks.push(b);
          assert.strictEqual(
            plain.length,
            pagesets * blocks.length * 64,
            'declen'
          );
          assert(
            offset % 64 === 0 && offset + pagesets * 64 <= BLOCK,
            'offset'
          );
          let at = 0;
          for (let p = 0; p < pagesets; p++)
            for (const b of blocks) {
              const a = b * BLOCK + offset + p * 64;
              for (let i = 0; i < 64; i++) mpc[a + i] &= plain[at + i];
              at += 64;
            }
          return plain.length;
        },
        async verify(off, len, crc) {
          events.push(['verify', off]);
          const a = isMpc(off)
            ? mpc.subarray(off - WIN, off - WIN + len)
            : mem.subarray(off, off + len);
          assert.strictEqual(
            W.crc32(a),
            crc,
            `verify CRC at ${off.toString(16)}`
          );
        },
        async marks(which) {
          events.push(['marks', which]);
          for (const [at, w] of [
            [0xfff80, 0x42902448],
            [0xfffc0, 0x42244890],
          ])
            mem.set([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255], at);
        },
        async reset() {
          events.push(['reset']);
        },
      };
      return { mem, mpc, events, client };
    };
    const target = image(7);
    const ext = new Uint8Array(0x100000).fill(0xff);
    ext.set(W.programAreaImage(target), 0x60000);
    let x = 99;
    const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 0xff;
    const mpcTarget = new Uint8Array(0x70000);
    for (let i = 0; i < mpcTarget.length; i++)
      mpcTarget[i] = i % 4096 < 3000 ? rnd() : 0xff;
    const mpcOnChip = Uint8Array.from(mpcTarget);
    for (const b of [0, 3, 5, 12]) mpcOnChip[b * BLOCK + 17] ^= 0x80; // four blocks differ
    // v8: blocks 3, 5, 12 as pagesets in one erase; block 0 alone, last
    let c = mpcChip(ext, mpcOnChip);
    let r = await W.pushProgram(
      c.client,
      target,
      {},
      { mpc: mpcTarget, pagesets: true }
    );
    assert.strictEqual(r.mpcBlocksWritten, 4);
    assert(Buffer.from(c.mpc).equals(Buffer.from(mpcTarget)), 'MPC == target');
    const eb = c.events.filter((e) => e[0] === 'eraseBlocks');
    assert.strictEqual(eb.length, 1);
    assert.strictEqual(eb[0][1], (1 << 3) | (1 << 5) | (1 << 12));
    const cs = c.events.filter((e) => e[0] === 'chunkSet');
    assert(
      cs.length > 0 &&
        cs.every(
          (e, i) =>
            e[1] === eb[0][1] &&
            (e[3] === 21 ||
              (i === cs.length - 1 && e[3] === (0x8000 / 64) % 21))
        ),
      '21 pagesets of 3 blocks per CHUNK_SET'
    );
    assert(
      cs.every((e, i) => !i || e[2] > cs[i - 1][2]),
      'offsets ascend'
    );
    const kinds = c.events.map((e) => e[0]);
    const lastErase = kinds.lastIndexOf('erase');
    assert.strictEqual(
      c.events[lastErase][1],
      WIN >>> 0,
      'block 0 erased on its own, after the pagesets'
    );
    assert(
      lastErase > kinds.lastIndexOf('chunkSet'),
      'block 0 after the pagesets'
    );
    assert.deepStrictEqual(kinds.slice(-2), ['marks', 'reset']);
    // the sequential wire (pagesets off): the same four blocks one by one
    c = mpcChip(ext, mpcOnChip);
    r = await W.pushProgram(
      c.client,
      target,
      {},
      { mpc: mpcTarget, pagesets: false }
    );
    assert(Buffer.from(c.mpc).equals(Buffer.from(mpcTarget)));
    assert(
      !c.events.some((e) => e[0] === 'eraseBlocks' || e[0] === 'chunkSet')
    );
    assert.strictEqual(
      c.events.filter((e) => e[0] === 'erase' && e[1] >= WIN).length,
      4
    );
    ok(
      'v8 push: the differing MPC blocks bar 0 erased in one job and written as pagesets, block 0 alone and last; the v7 wire still sequential; chip == target both ways'
    );
  }

  // ---- 5. detection ----------------------------------------------------------
  console.log('\ndetection');
  {
    const hook = (w) =>
      Uint8Array.from([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255]);
    const stamp = Buffer.from('4d53343551460801ffffd300ffffd400', 'hex');
    const det = fastFlasher.parseDetection(
      hook(fastFlasherBlob.hookWord),
      stamp
    );
    assert(det && det.ready && det.version === 8 && det.mpc && !det.outdated);
    assert(det.mpcSafe, "v8 writes the MPC through the loader's driver");
    assert.strictEqual(fastFlasher.describe(det), 'Fast flasher v8 present');
    assert(det.pagesets, 'v8 has the pageset / mask-erase / SET_BAUD wire');
    const v7 = Buffer.from(stamp);
    v7[6] = 7;
    const seven = fastFlasher.parseDetection(
      hook(fastFlasherBlob.hookWord),
      v7
    );
    assert(
      seven &&
        seven.mpcSafe &&
        !seven.pagesets &&
        seven.outdated &&
        seven.upgradable
    );
    // v6 is MPC-capable on paper but its own CMF sequence reset the car:
    // it is upgraded, never asked to write the MPC
    const v6 = Buffer.from(stamp);
    v6[6] = 6;
    const six = fastFlasher.parseDetection(hook(fastFlasherBlob.hookWord), v6);
    assert(six && six.mpc && !six.mpcSafe && six.outdated && six.upgradable);
    const v2 = Buffer.from(stamp);
    v2[6] = 5; // v5: the echo drain ate the next request
    const old = fastFlasher.parseDetection(hook(fastFlasherBlob.hookWord), v2);
    assert(old && old.hooked && old.outdated && !old.ready);
    assert.throws(() => fastFlasher.assertReady(old));
    assert(/reinstall/.test(fastFlasher.describe(old)));
    // v5 works on the car (with the link's pauses): a Fast Flash Program may
    // run on it to replace it; v4 and older may not
    assert(
      old.upgradable && /Fast Flash Program/.test(fastFlasher.describe(old))
    );
    const v4 = Buffer.from(stamp);
    v4[6] = 4;
    const v4det = fastFlasher.parseDetection(
      hook(fastFlasherBlob.hookWord),
      v4
    );
    assert(v4det.outdated && !v4det.upgradable && !v4det.ready);
    const v1 = Buffer.from(stamp);
    v1[6] = 1;
    v1[7] = 0;
    assert.strictEqual(
      fastFlasher.parseDetection(hook(fastFlasherBlob.hookWord), v1).mpc,
      false
    );
    const orphan = fastFlasher.parseDetection(
      hook(fastFlasher.STOCK_HOOK),
      stamp
    );
    assert(orphan && !orphan.hooked && !orphan.ready);
    assert.throws(() => fastFlasher.assertReady(orphan), /no longer leads/);
    const newer = Buffer.from(stamp);
    newer[6] = 9;
    assert(
      !fastFlasher.parseDetection(hook(fastFlasherBlob.hookWord), newer)
        .supported
    );
    const malformed = Buffer.from(stamp);
    malformed[8] = 0;
    assert.strictEqual(
      fastFlasher.parseDetection(hook(fastFlasherBlob.hookWord), malformed),
      null
    );
    assert.strictEqual(
      fastFlasher.parseDetection(hook(0), new Uint8Array(16).fill(0xff)),
      null
    );
    assert.throws(() => fastFlasher.assertReady(null), /No fast flasher/);
    ok(
      'stamp + hook = ready; an older body must be reinstalled; v1 has no MPC; a stock hook, a newer version and a malformed stamp are not ready'
    );
  }

  // ---- 6. the bootstrap splice -----------------------------------------------
  console.log('\nbootstrap');
  {
    const flash = new Uint8Array(0x100000).map((_, i) =>
      i < fastFlasher.BODY_START ? i & 0xff : 0xff
    );
    const mpc = new Uint8Array(0x70000).fill(0x22);
    mpc.set([0x4b, 0xf7, 0x17, 0xb6], 8); // the stock reset word
    assert(fastFlasher.canBootstrap(flash, mpc).ok);
    assert(!fastFlasher.carriesFlasher(flash, mpc));
    const { flash: f2, mpc: m2 } = fastFlasher.bootstrap(flash, mpc);
    assert.strictEqual(
      be32(m2, 8),
      fastFlasherBlob.hookWord,
      'the hook word at MPC 0x8'
    );
    for (let i = 0; i < flash.length; i++)
      if (
        f2[i] !== flash[i] &&
        (i < fastFlasher.BODY_START || i >= fastFlasher.BODY_END)
      )
        assert.fail(`changed ${i.toString(16)} outside the body range`);
    for (let i = 0; i < mpc.length; i++)
      if (i < 8 || i >= 12) assert.strictEqual(m2[i], mpc[i]);
    assert(
      fastFlasher.carriesFlasher(f2, m2),
      'the spliced pair carries the flasher'
    );
    const det = fastFlasher.parseDetection(
      m2.subarray(8, 12),
      f2.subarray(0xfd26c, 0xfd27c)
    );
    assert(det && det.ready, 'and reads back as a ready flasher');
    const again = fastFlasher.withFlasher(f2, m2);
    assert(
      again.flash === f2 && again.mpc === m2,
      'withFlasher leaves a carrying pair alone'
    );
    const dirty = Uint8Array.from(flash);
    dirty[0xfd500] = 0x12;
    assert.throws(
      () => fastFlasher.bootstrap(dirty, mpc),
      /body range is not blank/
    );
    const oddHook = Uint8Array.from(mpc);
    oddHook.set([0x12, 0x34, 0x56, 0x78], 8);
    assert.throws(
      () => fastFlasher.bootstrap(flash, oddHook),
      /not the stock reset word/
    );
    assert.doesNotThrow(
      () => fastFlasher.bootstrap(flash, m2),
      'an already-hooked MPC may be bootstrapped again'
    );
    ok(
      'splice touches only the body range and MPC 0x8; guards refuse a used range or a strange hook; re-install is allowed'
    );
  }

  console.log(`\n${passed} checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
