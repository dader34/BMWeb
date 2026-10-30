#!/usr/bin/env node
// The interruptible push (core/flash/push-resume.js) against a mock DME:
// the tail discriminator's three branches, the prefix search, the
// torn-chunk guard, the would-not-take fallback and its bound. The
// PROTOCOL is proven on the emulator (ms45-emu tools/flash_resume_test.py,
// ALL OK on the BL image, 2026-10-27); this proves the client emits that
// sequence and converges. No hardware, no NRV2B (the mock takes plain
// bytes).
//
//   node tools/verify/test_push_resume.js
if (typeof global.window === 'undefined') global.window = {};
const {
  fastFlashWire,
} = require('../../app/renderer/core/flash/fast-flasher-wire.js');
const { pushResume } = require('../../app/renderer/core/flash/push-resume.js');

const crc32 = fastFlashWire.crc32;
const CHUNK = 0x400; // small, so the matrix runs in milliseconds
const BASE = 0x40000;
const N = 8;

let failures = 0;
const check = (what, ok) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}`);
  } else console.log(`  ok    ${what}`);
};

/** A mock DME: the 8-chunk region as a chip buffer, AND-programming with
 * the body's read-back compare, CRC QUERY/VERIFY, READ, MARKS accounting. */
function mockDme(setup) {
  const chip = new Uint8Array(N * CHUNK);
  for (let i = 0; i < chip.length; i++) chip[i] = (i * 31 + 7) & 0xff; // "old"
  if (setup) setup(chip);
  const dme = {
    chip,
    erases: 0,
    marks: [],
    nakAt: -1, // a chunk index that refuses (bit-set physics), forever
    client: {
      async sectorQuery(off, len) {
        return crc32(dme.chip.subarray(off - BASE, off - BASE + len)) >>> 0;
      },
      async erase(off) {
        dme.chip.fill(0xff, off - BASE);
        dme.erases++;
      },
      async chunk(off, plain) {
        if (off - BASE === dme.nakAt * CHUNK)
          throw new fastFlashWire.Nak(fastFlashWire.SVC.CHUNK, 4);
        const at = off - BASE;
        for (let i = 0; i < plain.length; i++) dme.chip[at + i] &= plain[i];
        for (let i = 0; i < plain.length; i++)
          if (dme.chip[at + i] !== plain[i])
            throw new fastFlashWire.Nak(fastFlashWire.SVC.CHUNK, 4);
      },
      async verify(off, len, want) {
        if (
          crc32(dme.chip.subarray(off - BASE, off - BASE + len)) >>> 0 !==
          want >>> 0
        )
          throw new fastFlashWire.Nak(fastFlashWire.SVC.VERIFY, 5);
      },
      async read(off, len) {
        return dme.chip.slice(off - BASE, off - BASE + len);
      },
      async marks(which) {
        dme.marks.push(which);
      },
    },
  };
  return dme;
}

// the target: a valid-shaped span whose tail chunk is NOT blank (the
// discriminator's complete branch needs one), plus a blank-tail variant
const target = new Uint8Array(N * CHUNK);
for (let i = 0; i < target.length; i++) target[i] = (i * 13 + 5) & 0xff;
target[target.length - 1] ^= 0x5a;
const blankTail = target.slice();
blankTail.fill(0xff, (N - 1) * CHUNK);

const cb = () => {
  const notes = [];
  return {
    notes,
    stages: [],
    lastPct: 0,
    monotonic: true,
    stage(s) {
      this.stages.push(s);
    },
    progress(p) {
      if (p < this.lastPct) this.monotonic = false;
      this.lastPct = p;
    },
    note(s) {
      notes.push(s);
    },
  };
};
const converged = (dme, want) => dme.chip.every((b, i) => b === want[i]);

(async () => {
  // ---- A. old content: erase, all chunks -------------------------------
  {
    const dme = mockDme();
    const c = cb();
    const r = await pushResume.push(
      dme.client,
      { base: BASE, data: target, marks: 0, chunk: CHUNK },
      c
    );
    check('A: converged', converged(dme, target));
    check(
      'A: erased once, 8 sent',
      r.erased && dme.erases === 1 && r.sent === 8
    );
    check('A: the cal marks burned once', JSON.stringify(dme.marks) === '[0]');
    check('A: progress monotonic to 100', c.monotonic && c.lastPct === 100);
  }

  // ---- B. the torn-chunk guard: foreign bits where the search resumes --
  {
    const dme = mockDme((chip) => {
      chip.set(target.subarray(0, 3 * CHUNK)); // pushed start...
      // ...chunk 3 left as OLD content, the rest blank (a half-erased mess)
      chip.fill(0xff, 4 * CHUNK);
    });
    const c = cb();
    const r = await pushResume.push(
      dme.client,
      { base: BASE, data: target, marks: 0, chunk: CHUNK },
      c
    );
    check('B: converged', converged(dme, target));
    check(
      'B: the guard chose a full erase',
      /foreign content -> erase/.test(r.verdict)
    );
    check('B: 8 sent after the erase', r.sent === 8 && dme.erases === 1);
  }

  // ---- C. mid-push at 3 of 8: resume, only the rest --------------------
  {
    const dme = mockDme((chip) => {
      chip.set(target.subarray(0, 3 * CHUNK));
      chip.fill(0xff, 3 * CHUNK);
    });
    const c = cb();
    const r = await pushResume.push(
      dme.client,
      { base: BASE, data: target, marks: 0, chunk: CHUNK },
      c
    );
    check('C: converged', converged(dme, target));
    check(
      'C: resumed at 3, 5 sent, no new erase',
      /resume at chunk 3/.test(r.verdict) && r.sent === 5 && !r.erased
    );
  }

  // ---- D. a torn chunk: half of chunk 3 took before the cut -------------
  {
    const dme = mockDme((chip) => {
      chip.set(target.subarray(0, 3 * CHUNK));
      chip.set(
        target.subarray(3 * CHUNK, 3 * CHUNK + CHUNK / 2).map((b) => b | 0x55),
        3 * CHUNK
      );
      chip.fill(0xff, 3 * CHUNK + CHUNK / 2);
    });
    const c = cb();
    const r = await pushResume.push(
      dme.client,
      { base: BASE, data: target, marks: 0, chunk: CHUNK },
      c
    );
    check('D: converged', converged(dme, target));
    check('D: the torn chunk re-pushed (5 sent)', r.sent === 5 && !r.erased);
  }

  // ---- E. NAK mid-push: foreign bits past the resume point --------------
  {
    const dme = mockDme((chip) => {
      chip.set(target.subarray(0, 3 * CHUNK));
      chip.fill(0xff, 3 * CHUNK);
      chip.set(target.subarray(0, CHUNK), 5 * CHUNK); // foreign-but-AND-able? no:
      // old bits at chunk 5 make the read-back refuse it
      chip.fill(0x0f, 5 * CHUNK, 6 * CHUNK);
    });
    const c = cb();
    const r = await pushResume.push(
      dme.client,
      { base: BASE, data: target, marks: 0, chunk: CHUNK },
      c
    );
    check('E: converged', converged(dme, target));
    check(
      'E: the NAK fell back to a full erase',
      dme.erases === 1 && r.sent === 8
    );
    check(
      'E: the fallback was narrated',
      c.notes.some((s) => /would not take/.test(s))
    );
  }

  // ---- F. complete: nothing sent, verify + marks only -------------------
  {
    const dme = mockDme((chip) => chip.set(target));
    const before = dme.chip.slice();
    const c = cb();
    const r = await pushResume.push(
      dme.client,
      { base: BASE, data: target, marks: 0, chunk: CHUNK },
      c
    );
    check(
      'F: nothing sent, nothing written',
      r.sent === 0 && !r.erased && dme.chip.every((b, i) => b === before[i])
    );
    check('F: still confirmed (marks)', dme.marks.length === 1);
    check('F: verdict complete', /complete/.test(r.verdict));
  }

  // ---- G. complete with a BLANK target tail (the cal's pushed tail) -----
  {
    const dme = mockDme((chip) => chip.set(blankTail));
    const c = cb();
    const r = await pushResume.push(
      dme.client,
      { base: BASE, data: blankTail, marks: 0, chunk: CHUNK },
      c
    );
    check(
      'G: blank-tail target still reads complete',
      /complete/.test(r.verdict) && r.sent === 0
    );
    // and a push missing only the blank tail is already done
    const dme2 = mockDme((chip) => {
      chip.set(blankTail.subarray(0, (N - 1) * CHUNK));
      chip.fill(0xff, (N - 1) * CHUNK);
    });
    const r2 = await pushResume.push(
      dme2.client,
      { base: BASE, data: blankTail, marks: 0, chunk: CHUNK },
      cb()
    );
    check('G: cut before the blank tail -> 0 sent', r2.sent === 0);
  }

  // ---- H. the would-not-take bound: a chip that refuses a fresh erase ---
  {
    const dme = mockDme();
    dme.nakAt = 5; // refuses chunk 5 forever
    let threw = '';
    try {
      await pushResume.push(
        dme.client,
        { base: BASE, data: target, marks: 0, chunk: CHUNK },
        cb()
      );
    } catch (e) {
      threw = e.message;
    }
    check(
      'H: the bound stands after 2 restarts',
      /again after a full erase/.test(threw) && dme.erases === 3
    );
  }

  // ---- I. shape: bad span length refused; marks optional -----------------
  {
    const dme = mockDme();
    let threw = '';
    try {
      await pushResume.push(
        dme.client,
        {
          base: BASE,
          data: target.subarray(0, 3 * CHUNK + 5),
          marks: 0,
          chunk: CHUNK,
        },
        cb()
      );
    } catch (e) {
      threw = e.message;
    }
    check('I: a non-multiple span refused', /multiple of/.test(threw));
    const dme2 = mockDme((chip) => chip.set(target));
    await pushResume.push(
      dme2.client,
      { base: BASE, data: target, chunk: CHUNK },
      cb()
    ); // no marks
    check('I: marks null by default', dme2.marks.length === 0);
  }

  console.log(
    failures
      ? `\n${failures} FAIL`
      : '\nALL OK -- pushResume client vs mock DME'
  );
  process.exit(failures ? 1 : 0);
})();
