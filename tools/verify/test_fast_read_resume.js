#!/usr/bin/env node
// Fast Read's resume (fastFlashWire.readImage / readArea with `resume`):
// a READ the connection drops part-way, then the same read run again with
// the same resume object -- as fbDmeFastPushWithResume does -- must carry on
// at the block that failed, not at 0x0, and the bytes must come out whole.
// On the car (2026-11-02) a full read dropped at READ 0xDF000 and started
// over, ~60 s lost. The mock stands in for the client: READ only.
//
//   node tools/verify/test_fast_read_resume.js
if (typeof global.window === 'undefined') global.window = {};
const assert = require('assert');
const {
  fastFlashWire,
} = require('../../app/renderer/core/flash/fast-flasher-wire.js');

const EXT = 0x100000;
const MPC = 0x70000;
const W = fastFlashWire.MPC_WINDOW;

/** What the DME holds at a wire offset: a pattern that differs per byte. */
function byteAt(off) {
  const o = off & 0x7fffffff;
  return ((o * 7) ^ (o >>> 8) ^ (off & W ? 0x5a : 0)) & 0xff;
}

/** A client whose READ fails once at `dropAt` (the connection dropping). */
function mockClient(dropAt) {
  const c = {
    reads: [],
    dropped: false,
    async read(off, len) {
      c.reads.push(off >>> 0);
      if (!c.dropped && off >>> 0 === dropAt >>> 0) {
        c.dropped = true;
        throw new Error('fast flasher: the DME did not answer');
      }
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = byteAt((off + i) >>> 0);
      return out;
    },
  };
  return c;
}

/** The push and its one resume, as fbDmeFastPushWithResume runs them. */
async function withResume(push) {
  try {
    return await push();
  } catch (e) {
    return await push();
  }
}

function whole(buf, base) {
  for (let i = 0; i < buf.length; i++)
    if (buf[i] !== byteAt((base + i) >>> 0)) return false;
  return true;
}

let passed = 0;
function ok(note) {
  passed++;
  console.log(`  ok    ${note}`);
}

(async () => {
  const MAX = fastFlashWire.READ_MAX;
  const blocks = (EXT + MPC) / MAX;

  // a drop in the external flash, where the car's was
  {
    const c = mockClient(0xdf000);
    const resume = { ext: {}, mpc: {} };
    const stages = [];
    const r = await withResume(() =>
      fastFlashWire.readImage(c, {
        mpc: true,
        resume,
        stage: (s) => stages.push(s),
      })
    );
    assert.ok(whole(r.flash, 0) && whole(r.mpc, W), 'the bytes come out whole');
    assert.strictEqual(
      c.reads.length,
      blocks + 1,
      'one block read twice, no more'
    );
    assert.strictEqual(
      c.reads[0xdf000 / MAX + 1],
      0xdf000,
      'the retry is the block that failed'
    );
    assert.ok(
      stages.includes('Reading the external flash, carrying on at 0xdf000'),
      `the resume says where it carries on (${stages.join(' | ')})`
    );
    ok(
      'a drop at ext 0xDF000 carries on there: one block read twice, data whole'
    );
  }

  // a drop in the MPC: the external flash is not read again
  {
    const at = (W | 0x30000) >>> 0;
    const c = mockClient(at);
    const resume = { ext: {}, mpc: {} };
    const r = await withResume(() =>
      fastFlashWire.readImage(c, { mpc: true, resume })
    );
    assert.ok(whole(r.flash, 0) && whole(r.mpc, W), 'the bytes come out whole');
    assert.strictEqual(
      c.reads.length,
      blocks + 1,
      'one block read twice, no more'
    );
    assert.ok(
      !c.reads.slice(c.reads.indexOf(at) + 1).some((o) => o < EXT),
      'no external block after the drop'
    );
    ok(
      'a drop in the MPC carries on there; the external flash is not read again'
    );
  }

  // the tune read (readArea on its own)
  {
    const base = fastFlashWire.CAL_SECTOR;
    const len = fastFlashWire.CAL_LENGTH;
    const c = mockClient(base + 3 * MAX);
    const keep = {};
    const out = await withResume(() =>
      fastFlashWire.readArea(c, base, len, () => {}, keep)
    );
    assert.ok(whole(out, base), 'the bytes come out whole');
    assert.strictEqual(
      c.reads.length,
      Math.ceil(len / MAX) + 1,
      'one block read twice'
    );
    ok('the tune read carries on at the block that failed');
  }

  // without a resume object nothing changes: a second run starts at 0
  {
    const c = mockClient(0x2000);
    await withResume(() => fastFlashWire.readArea(c, 0, 0x8000));
    assert.strictEqual(
      c.reads.length,
      3 + 8,
      'no keep: the second run starts over'
    );
    ok('no resume object: the old behaviour, a second run starts over');
  }

  console.log(`\nfast-read-resume: ${passed} checks passed`);
})().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
