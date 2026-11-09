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
  require('../../app/renderer/core/generated/fast-flasher-blob.js').fastFlasherBlob;
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
      async read(off, len) {
        events.push(['read', off]);
        return Uint8Array.from(mem.subarray(off, off + len));
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
    assert(
      !k.includes('erase'),
      'a blank chip is not erased: the DME shows every sector blank already'
    );
    assert(
      c.events.findIndex((e) => e[0] === 'chunk' && e[1] >= 0xc0000) >
        c.events.findLastIndex((e) => e[0] === 'chunk' && e[1] < 0xc0000),
      'the marks sector is still written last'
    );
    assert.deepStrictEqual(k.slice(-2), ['marks', 'reset']);
    assert.strictEqual(
      c.events[c.events.length - 2][1],
      1,
      'MARKS 1 for the program'
    );
    ok(
      'from blank: 3 sectors written without an erase (the DME shows them blank), marks sector last, MARKS 1 then RESET, chip == target'
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
    const lastChunk80 = k.findLastIndex(
      (e) => e[0] === 'chunk' && e[1] >= 0x80000 && e[1] < 0xc0000
    );
    assert(
      firstMarksChunk > lastChunk80,
      'the marks sector is written after every other unit'
    );
    assert(
      !k.some((e) => e[0] === 'verify'),
      'no VERIFY per unit: the body reads every chunk back'
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
      let pending = null; // v24: the pipelined set's result, not yet told
      const failAt = new Set(); // v24: pageset offsets the chip refuses once
      const client = {
        async sectorQuery(off, len) {
          events.push(['query', off]);
          const a = isMpc(off)
            ? mpc.subarray(off - WIN, off - WIN + len)
            : mem.subarray(off, off + len);
          return W.crc32(a);
        },
        async read(off, len) {
          events.push(['read', off]);
          return Uint8Array.from(
            isMpc(off)
              ? mpc.subarray(off - WIN, off - WIN + len)
              : mem.subarray(off, off + len)
          );
        },
        async erase(off) {
          events.push(['erase', off]);
          if (isMpc(off)) mpc.fill(0xff, off - WIN, off - WIN + BLOCK);
          else
            mem.fill(
              0xff,
              off,
              off +
                {
                  0x40000: 0x20000,
                  0x60000: 0x20000,
                  0x80000: 0x40000,
                  0xc0000: 0x40000,
                }[off]
            );
        },
        async eraseQueue(offsets) {
          events.push(['eraseQueue', offsets.slice()]);
          for (const off of offsets)
            mem.fill(
              0xff,
              off,
              off +
                {
                  0x40000: 0x20000,
                  0x60000: 0x20000,
                  0x80000: 0x40000,
                  0xc0000: 0x40000,
                }[off]
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
        // v24: the pipelined set -- answered with the PREVIOUS set's result;
        // a set whose offset is in failAt is not taken (result 4), the way
        // a page that did not pulse is dropped by the body
        async chunkSetQ(mask, offset, pagesets, plain) {
          events.push(['chunkSetQ', mask, offset, pagesets]);
          const prev = pending === null ? 0xff : pending;
          if (failAt.has(offset)) {
            failAt.delete(offset);
            pending = 4;
          } else {
            await client.chunkSet(mask, offset, pagesets, plain);
            events.pop(); // the inner chunkSet's event: it is one SETQ
            pending = 0;
          }
          return { sent: plain.length, prev };
        },
        async sync() {
          events.push(['sync']);
          const r = pending === null ? 0xff : pending;
          pending = null;
          return r;
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
          for (const [at, w] of which
            ? [
                [0xfff80, 0x42902448],
                [0xfffc0, 0x42244890],
              ]
            : [
                [0x5ff80, 0x48249042],
                [0x5ffc0, 0x90482442],
              ])
            mem.set([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255], at);
        },
        async reset() {
          events.push(['reset']);
        },
      };
      return { mem, mpc, events, client, failAt };
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
    // block0InSets: block 0 erased and written with the others, only its
    // first page (the reset word) held back and written alone, last
    c = mpcChip(ext, mpcOnChip);
    const seen0 = [];
    const inner = c.client.chunkSet;
    c.client.chunkSet = async (mask, offset, ps, plain) => {
      seen0.push(Array.from(c.mpc.subarray(0, 64))); // page 0 before this write
      return inner(mask, offset, ps, plain);
    };
    r = await W.pushProgram(
      c.client,
      target,
      {},
      { mpc: mpcTarget, pagesets: true, block0InSets: true }
    );
    assert.strictEqual(r.mpcBlocksWritten, 4);
    assert(Buffer.from(c.mpc).equals(Buffer.from(mpcTarget)), 'MPC == target');
    const all = 1 | (1 << 3) | (1 << 5) | (1 << 12);
    const eb0 = c.events.filter((e) => e[0] === 'eraseBlocks');
    assert.deepStrictEqual(
      eb0.map((e) => e[1]),
      [all],
      'one erase job, block 0 in it'
    );
    assert(
      !c.events.some((e) => e[0] === 'erase' && e[1] >= WIN),
      'no MPC block erased on its own'
    );
    const cs0 = c.events.filter((e) => e[0] === 'chunkSet');
    const held = cs0[cs0.length - 1];
    assert.deepStrictEqual(
      held.slice(1),
      [1, 0, 1],
      'the held page: block 0, offset 0, one pageset, last'
    );
    assert(
      cs0.slice(0, -1).every((e) => e[1] === all && e[3] <= 16),
      'every other set covers all four blocks, 16 pagesets at most'
    );
    assert(
      seen0[seen0.length - 1].every((b) => b === 0xff),
      'page 0 of block 0 still blank until its own write'
    );
    const kinds0 = c.events.map((e) => e[0]);
    assert(
      !kinds0.includes('verify'),
      'no VERIFY per unit: the body reads every page back'
    );
    assert.deepStrictEqual(kinds0.slice(-2), ['marks', 'reset']);
    ok(
      'block0InSets: block 0 in the one erase job and the pagesets, its reset-word page blank until written alone after every other page; chip == target'
    );

    // the sequential wire (pagesets off): the same four blocks one by one
    c = mpcChip(ext, mpcOnChip);
    await W.pushProgram(
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

    // v23: with a background erase the external sectors are queued on the
    // chip after the MPC erase and written after the pagesets; the marks
    // sector is still erased alone and first, block 0 still last of the MPC.
    // From a chip holding an older program and calibration, so every sector
    // differs and must be erased (a blank one is written without an erase)
    const oldExt = new Uint8Array(0x100000).fill(0xff);
    oldExt.set(W.programAreaImage(image(9)), 0x60000);
    for (let i = 0x40000; i < 0x5d000; i++) oldExt[i] = (i * 3) & 0xff;
    c = mpcChip(oldExt, mpcOnChip);
    await W.pushProgram(
      c.client,
      target,
      {},
      { mpc: mpcTarget, pagesets: true, backgroundErase: true }
    );
    assert(Buffer.from(c.mpc).equals(Buffer.from(mpcTarget)), 'MPC == target');
    assert(
      Buffer.from(c.mem.subarray(0x60000)).equals(
        Buffer.from(W.programAreaImage(target))
      ),
      'ext == target'
    );
    const kindsB = c.events.map((e) => e[0]);
    const firstErase = kindsB.indexOf('erase');
    assert.strictEqual(c.events[firstErase][1], 0xc0000, 'marks sector first');
    const iBlocks = kindsB.indexOf('eraseBlocks');
    const iQueue = kindsB.indexOf('eraseQueue');
    const iSet = kindsB.indexOf('chunkSet');
    const iExtChunk = c.events.findIndex(
      (e) => e[0] === 'chunk' && e[1] >= 0x60000 && e[1] < WIN
    );
    assert(
      firstErase < iBlocks && iBlocks < iQueue && iQueue < iSet,
      'marks erase, then the MPC erase, then the queue, then the pagesets'
    );
    assert(
      iExtChunk > c.events.map((e) => e[0]).lastIndexOf('chunkSet'),
      'the external chunks come after the pagesets'
    );
    assert.deepStrictEqual(
      c.events[iQueue][1],
      [0x60000, 0x80000],
      'the two other sectors queued, the marks sector not again'
    );
    assert.strictEqual(
      c.events.filter((e) => e[0] === 'erase' && e[1] < WIN).length,
      1,
      'no external sector erased one by one'
    );
    assert.deepStrictEqual(kindsB.slice(-2), ['marks', 'reset']);
    ok(
      'v23 push: external sectors queued on the chip after the MPC erase, written after the pagesets, marks sector still first and alone'
    );

    // the calibration inside the program push: with the background erase its
    // sector joins the queue and is written after the pagesets, verified and
    // marked before the program's marks; without it, first, as Flash Tune
    const calT = new Uint8Array(0x1d000);
    for (let i = 0; i < calT.length; i++) calT[i] = (i * 5 + 3) & 0xff;
    for (const behind of [true, false]) {
      c = mpcChip(oldExt, mpcOnChip);
      await W.pushProgram(
        c.client,
        target,
        {},
        { mpc: mpcTarget, pagesets: true, backgroundErase: behind, cal: calT }
      );
      assert(
        Buffer.from(c.mem.subarray(0x40000, 0x5d000)).equals(Buffer.from(calT)),
        'the calibration is on the chip'
      );
      const k = c.events.map((e) => e[0]);
      const calChunk = c.events.findIndex(
        (e) => e[0] === 'chunk' && e[1] === 0x40000
      );
      const calVerify = c.events.findIndex(
        (e) => e[0] === 'verify' && e[1] === 0x40000
      );
      const marks0 = c.events.findIndex((e) => e[0] === 'marks' && e[1] === 0);
      const marks1 = c.events.findIndex((e) => e[0] === 'marks' && e[1] === 1);
      assert(
        calChunk < calVerify && calVerify < marks0 && marks0 < marks1,
        'cal written, verified, marked, then the program marked'
      );
      if (behind) {
        const q = c.events.find((e) => e[0] === 'eraseQueue');
        assert(
          q && q[1].includes(0x40000),
          'the cal sector erases in the background queue'
        );
        assert(
          !c.events.some((e) => e[0] === 'erase' && e[1] === 0x40000),
          'not on the clock'
        );
        assert(
          calChunk > k.lastIndexOf('chunkSet'),
          'written after the pagesets'
        );
      } else {
        const marksErase = c.events.findIndex(
          (e) => e[0] === 'erase' && e[1] === 0xc0000
        );
        assert(
          calChunk < marksErase,
          'without the background: the cal first, before the marks sector goes'
        );
      }
    }
    ok(
      'cal inside the program push: background-erased and written after the pagesets, or first without it; verified and marked before the program'
    );

    // ---- a dropped connection, the push run again: it carries on where the
    // DME says it stopped -- no erase of what is already written
    const failWith = () =>
      new Error(
        'fast flasher: the DME did not answer (nothing after the echo)'
      );
    const run = (cc) =>
      W.pushProgram(
        cc.client,
        target,
        {},
        {
          mpc: mpcTarget,
          pagesets: true,
          backgroundErase: true,
          cal: calT,
        }
      );
    const sameChip = (cc) => mpcChip(cc.mem, cc.mpc);
    for (const landed of [false, true]) {
      // a drop in the MPC pagesets at set 10: its answer lost (landed) or the
      // set never reaching the chip
      c = mpcChip(oldExt, mpcOnChip);
      {
        let calls = 0;
        const inner = c.client.chunkSet.bind(c.client);
        c.client.chunkSet = async (...a) => {
          if (++calls === 10) {
            if (landed) await inner(...a);
            throw failWith();
          }
          return inner(...a);
        };
      }
      await assert.rejects(run(c), /did not answer/);
      const c2 = sameChip(c);
      await run(c2);
      const k2 = c2.events.map((e) => e[0]);
      assert(
        Buffer.from(c2.mpc).equals(Buffer.from(mpcTarget)),
        'MPC == target after the resume'
      );
      assert(
        Buffer.from(c2.mem.subarray(0x60000)).equals(
          Buffer.from(W.programAreaImage(target))
        ),
        'ext == target'
      );
      assert(!k2.includes('eraseBlocks'), 'the MPC is not erased again');
      const firstSet = c2.events.find((e) => e[0] === 'chunkSet');
      const sets = c.events.filter((e) => e[0] === 'chunkSet');
      const span = sets[1][2] - sets[0][2];
      const want = (landed ? 10 : 9) * span;
      assert.strictEqual(
        firstSet[2],
        want,
        'the sets carry on at the first one the chip lacks'
      );
      assert(
        !c2.events.some((e) => e[0] === 'erase' && e[1] === 0xc0000),
        'the marks sector is not erased again'
      );
    }
    ok(
      'a drop in the MPC pagesets: run again, no erase, the sets carry on at the first the chip lacks (answer lost or never sent); chip == target'
    );

    // a torn pageset: half its pages took before the drop
    c = mpcChip(oldExt, mpcOnChip);
    {
      let calls = 0;
      const inner = c.client.chunkSet.bind(c.client);
      c.client.chunkSet = async (mask, off, ps, plain) => {
        if (++calls === 8) {
          const half = plain.slice();
          half.fill(0xff, half.length >> 1);
          await inner(mask, off, ps, half);
          throw failWith();
        }
        return inner(mask, off, ps, plain);
      };
    }
    await assert.rejects(run(c), /did not answer/);
    const tornAt = c.events.filter((e) => e[0] === 'chunkSet')[7][2];
    let c3 = sameChip(c);
    await run(c3);
    assert(
      Buffer.from(c3.mpc).equals(Buffer.from(mpcTarget)),
      'MPC == target after a torn set'
    );
    assert(!c3.events.some((e) => e[0] === 'eraseBlocks'));
    assert.strictEqual(
      c3.events.find((e) => e[0] === 'chunkSet')[2],
      tornAt,
      'the torn set is written again'
    );
    ok(
      'a torn pageset (half its pages in): run again, written again from that set, no erase'
    );

    // a drop in an external sector at its 10th chunk
    let dropAt = -1;
    c = mpcChip(oldExt, mpcOnChip);
    {
      let calls = 0;
      const inner = c.client.chunk.bind(c.client);
      c.client.chunk = async (off, plain) => {
        if (off >= 0x80000 && off < 0xc0000 && ++calls === 10) {
          dropAt = off;
          throw failWith();
        }
        return inner(off, plain);
      };
    }
    await assert.rejects(run(c), /did not answer/);
    c3 = sameChip(c);
    await run(c3);
    assert(
      Buffer.from(c3.mem.subarray(0x60000)).equals(
        Buffer.from(W.programAreaImage(target))
      ),
      'ext == target'
    );
    assert(
      !c3.events.some(
        (e) =>
          e[0] === 'erase' ||
          e[0] === 'eraseBlocks' ||
          (e[0] === 'eraseQueue' && e[1].includes(0x80000))
      ),
      'nothing erased again'
    );
    const tenth = dropAt;
    const first80 = c3.events.find(
      (e) => e[0] === 'chunk' && e[1] >= 0x80000 && e[1] < 0xc0000
    );
    assert.strictEqual(
      first80[1],
      tenth,
      'the sector carries on at the chunk the chip lacks'
    );
    assert(
      !c3.events.some((e) => e[0] === 'chunkSet'),
      'the finished MPC is not touched'
    );
    ok(
      'a drop in an external sector: run again, no erase, it carries on at the chunk the chip lacks; the finished MPC untouched'
    );

    // everything written, the drop at the program's marks: run again, only marks
    c = mpcChip(oldExt, mpcOnChip);
    {
      const inner = c.client.marks.bind(c.client);
      c.client.marks = async (w) => {
        if (w === 1) throw failWith();
        return inner(w);
      };
    }
    await assert.rejects(run(c), /did not answer/);
    c3 = sameChip(c);
    await run(c3);
    const k3 = c3.events.map((e) => e[0]);
    assert(
      !k3.some((k) =>
        ['chunk', 'chunkSet', 'erase', 'eraseBlocks', 'eraseQueue'].includes(k)
      ),
      'nothing written or erased'
    );
    assert.deepStrictEqual(k3.slice(-2), ['marks', 'reset']);
    ok(
      'a drop before the program marks: run again, nothing written or erased, the marks burned and the DME restarted'
    );

    // ---- v24: pipelined pagesets (same chip and targets) ----
    console.log('\npipelined pagesets');
    // every pageset through SETQ, one SYNC at the end, nothing stop-and-wait
    c = mpcChip(ext, mpcOnChip);
    r = await W.pushProgram(
      c.client,
      target,
      {},
      { mpc: mpcTarget, pagesets: true, pipeline: true }
    );
    assert.strictEqual(r.mpcBlocksWritten, 4);
    assert(Buffer.from(c.mpc).equals(Buffer.from(mpcTarget)), 'MPC == target');
    let kq = c.events.map((e) => e[0]);
    assert(!kq.includes('chunkSet'), 'no plain CHUNK_SET when all sets take');
    const q = c.events.filter((e) => e[0] === 'chunkSetQ');
    assert(
      q.length > 0 &&
        q.every((e) => e[1] === ((1 << 3) | (1 << 5) | (1 << 12))),
      'SETQ masks'
    );
    assert.strictEqual(kq.filter((k) => k === 'sync').length, 1, 'one SYNC');
    assert(
      kq.indexOf('sync') > kq.lastIndexOf('chunkSetQ'),
      'SYNC after the last set'
    );
    const iBlock0 = c.events.findIndex((e) => e[0] === 'chunk' && e[1] >= WIN);
    assert(
      iBlock0 > kq.indexOf('sync'),
      'block 0 (plain chunks) after the SYNC'
    );
    ok('v24 push: every pageset pipelined, one SYNC, block 0 after it');

    // a set the chip refuses mid-run and the LAST set refused: each is told
    // one frame late (or by the SYNC) and sent again as a plain CHUNK_SET
    c = mpcChip(ext, mpcOnChip);
    c.failAt.add(0x540); // a middle offset (21 pagesets = 0x540 a set)
    // the last set SENT: 0x7E00 (the short one) is all 0xFF in this target
    c.failAt.add(0x78c0);
    await W.pushProgram(
      c.client,
      target,
      {},
      { mpc: mpcTarget, pagesets: true, pipeline: true }
    );
    assert(
      Buffer.from(c.mpc).equals(Buffer.from(mpcTarget)),
      'MPC == target after resends'
    );
    kq = c.events.map((e) => e[0]);
    const resent = c.events.filter((e) => e[0] === 'chunkSet');
    assert.deepStrictEqual(
      resent.map((e) => e[2]),
      [0x540, 0x78c0],
      'the two refused sets sent again, in order'
    );
    const iFail = c.events.findIndex(
      (e) => e[0] === 'chunkSetQ' && e[2] === 0x540
    );
    const iResend = c.events.findIndex(
      (e) => e[0] === 'chunkSet' && e[2] === 0x540
    );
    assert.strictEqual(
      c.events[iResend - 1][0],
      'chunkSetQ',
      'the middle resend right after the NEXT set (told one frame late)'
    );
    assert.strictEqual(c.events[iResend - 1][2], 0x540 + 0x540);
    assert(
      iResend === iFail + 2,
      'exactly one set between the failure and its resend'
    );
    const iSync = kq.indexOf('sync');
    assert.strictEqual(
      c.events[iSync + 1][0],
      'chunkSet',
      'the last set resent right after the SYNC'
    );
    assert.strictEqual(c.events[iSync + 1][2], 0x78c0);
    ok(
      'v24 push: a refused set is sent again on its own, a frame late or after the SYNC'
    );

    // without the body's say-so the loop stays stop-and-wait
    c = mpcChip(ext, mpcOnChip);
    await W.pushProgram(
      c.client,
      target,
      {},
      { mpc: mpcTarget, pagesets: true }
    );
    assert(
      !c.events.some((e) => e[0] === 'chunkSetQ' || e[0] === 'sync'),
      'no SETQ without opts.pipeline'
    );
    ok('v24 push: pipeline only when asked');
  }

  // ---- 4d. a garbled reply is asked for again ------------------------------------
  console.log('\ngarbled replies');
  {
    const ack = (svc) => {
      const f = [0x04, 0x12, 0xf1, svc | 0x40];
      f.push(f.slice(1).reduce((a, b) => (a + b) & 0xff, 0));
      return Uint8Array.from(f);
    };
    let n = 0;
    const link = {
      async exchange() {
        n++;
        const f = ack(0x00);
        if (n === 1 || n === 3) f[4] ^= 1; // a byte the line mangled
        return f;
      },
    };
    const client = new W.Client(link);
    let stepped = 0;
    client.stepDown = async () => {
      stepped++;
    };
    await client.hello();
    assert.strictEqual(n, 2);
    assert.strictEqual(client.lineErrors, 1);
    await client.hello();
    assert.strictEqual(n, 4);
    assert.strictEqual(stepped, 1, 'the line steps down at the second error');
    assert.strictEqual(client.lineErrors, 0, 'the count starts over');
    assert.ok(client.stepDown, 'and can step down again (2026-11-02)');
    n = 0;
    const bad = {
      async exchange() {
        n++;
        const f = ack(0x00);
        f[4] ^= 1;
        return f;
      },
    };
    await assert.rejects(() => new W.Client(bad).hello(), /checksum/);
    assert.strictEqual(n, 3, 'three tries, then the error');
    ok(
      'a garbled reply is asked for again; every two step the line down; a line that garbles every reply still fails after three tries'
    );
  }

  // ---- 4e. a chunk the line damaged on the way in is sent once more ----------
  {
    const nak = (svc, reason) => {
      const f = [0x06, 0x12, 0xf1, 0x7f, svc, reason];
      f.push(f.slice(1).reduce((a, b) => (a + b) & 0xff, 0));
      return Uint8Array.from(f);
    };
    const ack = (svc) => {
      const f = [0x04, 0x12, 0xf1, svc | 0x40];
      f.push(f.slice(1).reduce((a, b) => (a + b) & 0xff, 0));
      return Uint8Array.from(f);
    };
    let n = 0;
    const link = {
      async exchange() {
        n++;
        return n === 1 ? nak(0x03, 2) : ack(0x03);
      },
    };
    const client = new W.Client(link);
    await client.chunk(0x40000, new Uint8Array(64));
    assert.strictEqual(n, 2);
    assert.strictEqual(client.lineErrors, 1);
    n = 0;
    const perm = {
      async exchange() {
        n++;
        return nak(0x03, 1);
      },
    };
    await assert.rejects(
      () => new W.Client(perm).chunk(0x10000, new Uint8Array(64)),
      /not permitted/
    );
    assert.strictEqual(n, 1, 'a real refusal is not retried');
    // v25: the body's receive queue refuses a frame the line damaged, so
    // any telegram can come back "malformed" -- a SETQ and a QUERY go again
    for (const [svc, run] of [
      [0x0d, (c) => c.chunkSetQ(1 << 3, 0, 1, new Uint8Array(64))],
      [0x01, (c) => c.sectorQuery(0x40000, 16)],
    ]) {
      n = 0;
      const damaged = {
        async exchange() {
          n++;
          if (n === 1) return nak(svc, 6);
          const f = [0x08, 0x12, 0xf1, svc | 0x40, 0, 0, 0, 0];
          f.push(f.slice(1).reduce((a, b) => (a + b) & 0xff, 0));
          return Uint8Array.from(f);
        },
      };
      await run(new W.Client(damaged));
      assert.strictEqual(n, 2, `service ${svc}: sent again after a NAK 6`);
    }
    // a CRC refusal (2) of anything but a chunk or a set is a real answer
    n = 0;
    const crc = {
      async exchange() {
        n++;
        return nak(0x04, 2);
      },
    };
    await assert.rejects(() => new W.Client(crc).verify(0x40000, 16, 0));
    assert.strictEqual(n, 1, 'a VERIFY mismatch is not retried');
    ok(
      'a CHUNK the body refused as damaged (chunk CRC / malformed) goes once more; a permission refusal does not; v25: any telegram refused as malformed goes once more, a VERIFY mismatch does not'
    );
  }

  // ---- 4f. v26: pipelined external chunks, READX, SET_TIMING, the padding --
  console.log('\nv26: external pipeline, blank-skipping reads, reply timing');
  {
    // a client double for the external chunks: CHUNKQ answers with the
    // previous chunk's result; failAt names chunks that do not take
    const extQ = (failAt = new Set()) => {
      const mem = new Uint8Array(0x100000).fill(0xff);
      const events = [];
      let pending = null;
      const client = {
        pipelineExt: true,
        async sectorQuery(off, len) {
          events.push(['query', off]);
          return W.crc32(mem.subarray(off, off + len));
        },
        async read(off, len) {
          events.push(['read', off]);
          return Uint8Array.from(mem.subarray(off, off + len));
        },
        async erase(off) {
          events.push(['erase', off]);
          mem.fill(0xff, off, off + 0x20000);
        },
        async chunk(off, plain) {
          events.push(['chunk', off]);
          mem.set(plain, off);
          return plain.length;
        },
        async chunkQ(off, plain) {
          events.push(['chunkQ', off]);
          const prev = pending === null ? 0xff : pending;
          if (failAt.has(off)) pending = 4;
          else {
            mem.set(plain, off);
            pending = 0;
          }
          return { sent: plain.length, prev };
        },
        async sync() {
          events.push(['sync']);
          const r = pending === null ? 0xff : pending;
          pending = null;
          return r;
        },
        async verify(off, len, crc) {
          events.push(['verify', off]);
          assert.strictEqual(W.crc32(mem.subarray(off, off + len)), crc);
        },
        async marks(w) {
          events.push(['marks', w]);
        },
        async reset() {
          events.push(['reset']);
        },
      };
      return { client, events, mem };
    };
    const cal = new Uint8Array(0x1d000);
    for (let i = 0; i < cal.length; i++) cal[i] = (i * 7 + 1) & 0xff;
    let c = extQ();
    await W.pushCal(c.client, cal, {});
    let kinds = c.events.map((e) => e[0]);
    assert(!kinds.includes('chunk'), 'every cal chunk through CHUNKQ');
    assert.strictEqual(kinds.filter((k) => k === 'chunkQ').length, 29);
    assert(
      kinds.indexOf('sync') > kinds.lastIndexOf('chunkQ') &&
        kinds.indexOf('sync') < kinds.indexOf('verify'),
      'one SYNC after the last chunk, before VERIFY'
    );
    ok('v26 cal push: 29 chunks pipelined, one SYNC before the VERIFY');

    // a chunk that did not take ends the push as a refused CHUNK does,
    // whether the next ACK tells it or the SYNC
    for (const bad of [0x41000, 0x40000 + 28 * 0x1000]) {
      c = extQ(new Set([bad]));
      await assert.rejects(W.pushCal(c.client, cal, {}), (e) => {
        assert.strictEqual(e.svc, W.SVC.CHUNK);
        assert.strictEqual(e.reason, 4);
        return true;
      });
      assert(!c.events.some((e) => e[0] === 'verify'), 'no VERIFY after it');
    }
    ok(
      'v26: a pipelined chunk that did not take is a refused CHUNK (told by the next ACK or the SYNC)'
    );

    // pipelineExt off: plain CHUNKs, no SYNC
    c = extQ();
    c.client.pipelineExt = false;
    await W.pushCal(c.client, cal, {});
    kinds = c.events.map((e) => e[0]);
    assert(!kinds.includes('chunkQ') && !kinds.includes('sync'));
    ok('v26: without pipelineExt the chunks go plain');

    // READX: the reply decoded, blank pieces filled; readArea uses it for
    // whole pieces of flash and MPC only
    const ext = new Uint8Array(0x100000).fill(0xff);
    for (let i = 0x41000; i < 0x42000; i++) ext[i] = i & 0xff;
    for (let i = 0x43000; i < 0x44000; i++) ext[i] = (i >> 3) & 0xff;
    const asked = [];
    let damageX = 0;
    const link = {
      async exchange(frame) {
        const q = W.parse(frame);
        const off = be32(q.data, 0);
        const n = (q.data[4] << 8) | q.data[5];
        asked.push([q.svc, off, n]);
        const data = ext.subarray(off, off + n);
        if (q.svc === W.SVC.READ) {
          const crc = W.crc32(data);
          return W.frame(0x4a, [
            crc >>> 24,
            (crc >>> 16) & 255,
            (crc >>> 8) & 255,
            crc & 255,
            ...data,
          ]);
        }
        assert.strictEqual(q.svc, W.SVC.READX);
        let mask = 0;
        const sent = [];
        for (let i = 0; i < n / 4096; i++) {
          const p = data.subarray(i * 4096, (i + 1) * 4096);
          if (p.every((b) => b === 0xff)) mask |= 1 << i;
          else sent.push(...p);
        }
        const crc = W.crc32(Uint8Array.from(sent));
        if (damageX > 0 && sent.length) {
          damageX--;
          sent[0] ^= 1;
        }
        return W.frame(0x50, [
          crc >>> 24,
          (crc >>> 16) & 255,
          (crc >>> 8) & 255,
          crc & 255,
          mask,
          ...sent,
        ]);
      },
    };
    const client = new W.Client(link);
    client.readMax = W.READ_MAX_WIDE;
    client.readBlank = true;
    const got = await W.readArea(client, 0x40000, 0x8000);
    assert.deepStrictEqual(
      Array.from(got),
      Array.from(ext.subarray(0x40000, 0x48000))
    );
    assert.deepStrictEqual(
      asked.map((a) => a[0]),
      [W.SVC.READX, W.SVC.READX],
      'two 16 KB READX'
    );
    asked.length = 0;
    await W.readArea(client, 0x40100, 0x200);
    assert.strictEqual(asked[0][0], W.SVC.READ, 'a part piece goes as READ');
    asked.length = 0;
    damageX = 1;
    const again = await client.readX(0x40000, 0x4000);
    assert.deepStrictEqual(
      Array.from(again),
      Array.from(ext.subarray(0x40000, 0x44000))
    );
    assert.deepStrictEqual(
      asked.map((a) => a[0]),
      [W.SVC.READX, W.SVC.READ],
      'a READX that does not check out is read plainly'
    );
    ok(
      'v26 READX: blank pieces filled in, CRC over what was sent, whole pieces only; a damaged one read plainly'
    );

    // SET_TIMING: the payload, and the link told the padding after the ACK
    let padTold = -1;
    let sentFrame = null;
    const tl = {
      setPad(n) {
        padTold = n;
      },
      async exchange(frame) {
        sentFrame = W.parse(frame);
        assert.strictEqual(
          padTold,
          -1,
          'the link learns the padding only after the ACK'
        );
        return W.frame(W.SVC.SET_TIMING | 0x40, []);
      },
    };
    await new W.Client(tl).setTiming(2000, 62);
    assert.strictEqual(sentFrame.svc, W.SVC.SET_TIMING);
    assert.deepStrictEqual(Array.from(sentFrame.data), [0, 0, 7, 208, 62]);
    assert.strictEqual(padTold, 62);
    ok('v26 SET_TIMING: gap u32 + packet u8, the link told after the ACK');

    // the browser link: filler after each padded reply is waited out before
    // the next request and dropped as noise before its echo
    const written = [];
    const pending = [];
    const fake = {
      config: { baudRate: 250000 },
      port: { setSignals: async () => {}, device: 'test' },
      writer: {
        async write(f) {
          written.push([Date.now(), Array.from(f)]);
          const q = W.parse(f);
          const reply = Array.from(W.frame(q.svc | 0x40, [1, 2, 3]));
          const filler = (62 - (reply.length % 62)) % 62;
          // echo, the reply, then its filler -- the filler handed over late
          pending.push(...f, ...reply);
          setTimeout(() => pending.push(...new Array(filler).fill(0xa5)), 3);
        },
      },
      async readSome() {
        for (let i = 0; i < 50 && !pending.length; i++)
          await new Promise((r) => setTimeout(r, 1));
        return { value: Uint8Array.from(pending.splice(0)), done: false };
      },
    };
    const wl = W.webLink(fake);
    wl.setPad(62);
    const r1 = W.parse(await wl.exchange(W.frame(W.SVC.HELLO, []), 500));
    const r2 = W.parse(
      await wl.exchange(
        W.frame(W.SVC.SECTOR_QUERY, [0, 4, 0, 0, 0, 0, 0, 16]),
        500
      )
    );
    assert.strictEqual(r1.svc, 0x40);
    assert.strictEqual(
      r2.svc,
      0x41,
      'the late filler did not upset the next reply'
    );
    const gap = written[1][0] - written[0][0];
    assert(
      gap >= Math.ceil(((62 - 8) * 11 * 1000) / 250000),
      `waited ${gap} ms for the filler`
    );
    ok(
      'v26 link: the next request waits out the filler, and filler that comes late is dropped before the echo'
    );

    // a v26 body heard (its HELLO) may still be padding for an earlier
    // session: the link waits out a padded reply's filler before it is told
    written.length = 0;
    const wl2 = W.webLink(fake);
    const stamp = [
      0x4d, 0x53, 0x34, 0x35, 0x51, 0x46, 26, 0x1b, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
    const realWrite = fake.writer.write;
    let first = true;
    fake.writer.write = async (f) => {
      if (!first) return realWrite(f);
      first = false;
      written.push([Date.now(), Array.from(f)]);
      const reply = Array.from(W.frame(0x40, stamp));
      pending.push(...f, ...reply);
      setTimeout(
        () => pending.push(...new Array(62 - reply.length).fill(0xa5)),
        3
      );
    };
    fake.reopen = async (c) => {
      fake.config = { baudRate: c.baudRate };
    };
    await wl2.resume({ quick: true });
    await wl2.exchange(
      W.frame(W.SVC.SECTOR_QUERY, [0, 4, 0, 0, 0, 0, 0, 16]),
      500
    );
    const gap2 =
      written[written.length - 1][0] - written[written.length - 2][0];
    assert(
      gap2 >= Math.ceil(((62 - 21) * 11 * 1000) / 250000),
      `waited ${gap2} ms after a v26 HELLO`
    );
    fake.writer.write = realWrite;
    ok(
      'v26 link: after a v26 HELLO it already waits out filler, before the session sets the timing'
    );
  }

  // ---- 4g. a line switch the host cannot follow ----------------------------
  console.log('\nline switch');
  {
    const steps = [];
    const mk = (version) => {
      const client = {
        bodyVersion: version,
        async setBaud(scbr) {
          steps.push(['setBaud', scbr]);
        },
      };
      const link = {
        async rebaud(rate) {
          steps.push(['rebaud', rate]);
          if (rate !== 115200) throw new Error('no HELLO');
        },
        async sendBlind(rate) {
          steps.push(['sendBlind', rate]);
        },
      };
      return { client, link };
    };
    // v27: the body comes back by itself -- nothing blind, a wait, 115200
    steps.length = 0;
    let { client, link } = mk(27);
    let t0 = Date.now();
    let r = await W.fasterLine(client, link, () => {});
    assert.strictEqual(r, 115200);
    assert(
      !steps.some((x) => x[0] === 'sendBlind'),
      'nothing sent blind to a v27 body'
    );
    assert(
      Date.now() - t0 >= 3000 * 3,
      'each failed rate waits out the probation'
    );
    assert(
      steps.filter((x) => x[0] === 'rebaud' && x[1] === 115200).length === 3
    );
    // older: the pull-back copies
    steps.length = 0;
    ({ client, link } = mk(26));
    r = await W.fasterLine(client, link, () => {});
    assert.strictEqual(r, 115200);
    assert(
      steps.some((x) => x[0] === 'sendBlind'),
      'an older body is pulled back'
    );
    ok(
      'a line switch the host cannot follow: a v27 body is waited out (it comes back by itself), an older one is pulled back'
    );
  }

  // ---- 5. detection ----------------------------------------------------------
  console.log('\ndetection');
  {
    const hook = (w) =>
      Uint8Array.from([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255]);
    // this build's body: ready; any other version: left alone, not ready
    const stamp = Buffer.from('4d53343551460d03ffffd300ffffd400', 'hex');
    stamp[6] = fastFlasher.VERSION;
    const det = fastFlasher.parseDetection(
      hook(fastFlasherBlob.hookWord),
      stamp
    );
    assert(det && det.ready && det.ours && det.mpc && det.reads);
    assert.strictEqual(fastFlasher.describe(det), 'Fast flasher present');
    for (const other of [13, 9, 5, 1, fastFlasher.VERSION + 1]) {
      const st = Buffer.from(stamp);
      st[6] = other;
      const d = fastFlasher.parseDetection(hook(fastFlasherBlob.hookWord), st);
      assert(
        d && d.hooked && !d.ours && !d.ready && !d.supported,
        `v${other} is not used`
      );
      assert.throws(() => fastFlasher.assertReady(d), /left alone/);
    }
    const orphan = fastFlasher.parseDetection(
      hook(fastFlasher.STOCK_HOOK),
      stamp
    );
    assert(orphan && !orphan.hooked && !orphan.ready);
    assert.throws(() => fastFlasher.assertReady(orphan), /no longer leads/);
    // the AIF window (stamp flag bit 1) only counts on this build's body
    const aifBody = Buffer.from(stamp);
    aifBody[7] = 0x03;
    const aifDet = fastFlasher.parseDetection(
      hook(fastFlasherBlob.hookWord),
      aifBody
    );
    assert(aifDet.ready && aifDet.aifWipe);
    const oldAif = Buffer.from(aifBody);
    oldAif[6] = 12;
    assert(
      !fastFlasher.parseDetection(hook(fastFlasherBlob.hookWord), oldAif)
        .aifWipe
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

  // ---- 7. READ: the client checks each block's CRC, readImage tiles ----
  {
    const ext = new Uint8Array(0x100000);
    const mpc = new Uint8Array(0x70000);
    for (let i = 0; i < ext.length; i++) ext[i] = (i * 31 + (i >>> 12)) & 0xff;
    for (let i = 0; i < mpc.length; i++) mpc[i] = (i * 17 + 5) & 0xff;
    const asked = [];
    let damage = 0; // flip one data byte in the next `damage` replies
    const link = {
      async exchange(frame) {
        const q = W.parse(frame);
        assert.strictEqual(q.svc, W.SVC.READ);
        const off = be32(q.data, 0);
        const n = (q.data[4] << 8) | q.data[5];
        asked.push([off, n]);
        if (!n || n > W.READ_MAX_WIDE) return W.frame(0x7f, [q.svc, 6]);
        const src = off & 0x80000000 ? mpc : ext;
        const at = off & 0x7fffffff;
        if (at + n > src.length) return W.frame(0x7f, [q.svc, 1]);
        const data = Uint8Array.from(src.subarray(at, at + n));
        const crc = W.crc32(data);
        if (damage > 0) {
          damage--;
          data[n >> 1] ^= 0x01; // after the CRC: a byte the line mangled
        }
        return W.frame(0x4a, [
          crc >>> 24,
          (crc >>> 16) & 0xff,
          (crc >>> 8) & 0xff,
          crc & 0xff,
          ...data,
        ]);
      },
    };
    const client = new W.Client(link);
    client.readMax = W.READ_MAX_WIDE; // a v22+ body
    const got = await client.read(0x7f00, 512);
    assert.deepStrictEqual(
      Array.from(got),
      Array.from(ext.subarray(0x7f00, 0x8100))
    );
    damage = 1;
    const again = await client.read(0x40000, 4096);
    assert.deepStrictEqual(
      Array.from(again),
      Array.from(ext.subarray(0x40000, 0x41000))
    );
    assert.strictEqual(
      client.lineErrors,
      1,
      'a damaged block is read once more'
    );
    let stepped = 0;
    client.stepDown = async () => stepped++;
    damage = 3;
    await assert.rejects(client.read(0x40000, 4096), /damaged 3 times/);
    assert.strictEqual(
      stepped,
      1,
      'the second damaged block steps the line down'
    );
    await assert.rejects(client.read(0x40000, W.READ_MAX_WIDE + 1), W.Nak);
    // a damaged wide read is re-read in 4 KB pieces, not whole
    damage = 1;
    asked.length = 0;
    const wide = await client.read(0x44000, W.READ_MAX_WIDE);
    assert(
      Buffer.from(wide).equals(Buffer.from(ext.subarray(0x44000, 0x48000))),
      'the pieces add up to the span'
    );
    assert.deepStrictEqual(
      asked.map(([, n]) => n),
      [W.READ_MAX_WIDE, 0x1000, 0x1000, 0x1000, 0x1000],
      'one wide ask, then the four pieces'
    );
    // the step-down weighs garbles against what the rate gains: on a fast
    // line carrying wide reads one garble in six frames is kept, three in
    // a row are not
    client.baud = 312500;
    stepped = 0;
    client._recent = [];
    for (let i = 0; i < 6; i++) await client.read(0x50000 + i * 0x4000, 0x4000);
    damage = 1;
    await client.read(0x70000, 0x4000);
    assert.strictEqual(stepped, 0, 'one garble in six wide frames is carried');
    damage = 3;
    await client.read(0x74000, 0x4000);
    assert.strictEqual(stepped, 1, 'three garbles running step the line down');
    client.baud = W.BAUD;
    asked.length = 0;
    let last = -1;
    const img = await W.readImage(client, {
      mpc: true,
      progress: (p) => {
        assert(p >= last && p <= 100);
        last = p;
      },
    });
    assert(Buffer.from(img.flash).equals(Buffer.from(ext)), 'the chip, whole');
    assert(Buffer.from(img.mpc).equals(Buffer.from(mpc)), 'the MPC, whole');
    assert.strictEqual(asked.length, (0x100000 + 0x70000) / W.READ_MAX_WIDE);
    assert(asked.every(([, n]) => n === W.READ_MAX_WIDE) && last === 100);
    assert.strictEqual(
      asked[0x100000 / W.READ_MAX_WIDE][0],
      0x80000000,
      'the MPC through its window'
    );
    const tune = await W.readImage(client, {});
    assert(tune.mpc === null && tune.flash.length === 0x100000);
    ok(
      'READ: a block checked against its CRC, a damaged one asked once more, twice is an error; readImage tiles 1 MB + 448 KB in 16 KB'
    );
  }

  console.log(`\n${passed} checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
