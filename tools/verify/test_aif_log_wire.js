#!/usr/bin/env node
// The AIF editor's wire client (core/flash/aif.js) against a mock DME:
// the marker ladder's rules, the AND-physics backstop on direct writes,
// the rewrite's trusted-sector check and read fallback. The PROTOCOL is
// proven on the emulator (ms45-emu tools/aif_editor_test.py, ALL OK
// 2026-10-27, on the bootloader image); this proves the client emits that
// sequence and converges. No hardware, no NRV2B (the mock client takes
// plain bytes).
//
//   node tools/verify/test_aif_log_wire.js
if (typeof global.window === 'undefined') global.window = {};
const {
  fastFlashWire,
} = require('../../app/renderer/core/flash/fast-flasher-wire.js');
const { aifLog } = require('../../app/renderer/core/flash/aif.js');
const { bl } = require('../../app/renderer/core/flash/bl.js');
const { blBlob } = require('../../app/renderer/core/generated/bl-blob.js');

const crc32 = fastFlashWire.crc32;
const MARK = fastFlashWire.MARK;
const BOOT = 0x8000;
const BOOT_END = 0x20000;
const AIF = 0x1fb34;
const LOG_LEN = BOOT_END - AIF;

let failures = 0;
const check = (what, ok) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}`);
  } else console.log(`  ok    ${what}`);
};

// A mock DME: the boot sector as a chip buffer, a 64-slot marker ladder
// (v11 rules: read the current slot, arm FRESH, done ARMED, DONE only when
// every slot is spent), AND-programming with the body's read-back compare,
// and the READ the read-fallback needs.
function mockDme() {
  const chip = new Uint8Array(BOOT_END);
  // loader-ish content below the log, a four-slot log above it
  for (let i = 0; i < AIF - BOOT; i++) chip[BOOT + i] = (i * 31 + 7) & 0xff;
  for (let s = 0; s < 4; s++) {
    const at = AIF + s * 64;
    chip[at] = 0x40; // '@'
    chip.set(
      Array.from('NJ87379', (c) => c.charCodeAt(0)),
      at + 1
    );
    chip[at + 9] = s ? 0x26 : 0x03;
    chip[at + 0x20] = 0x21; // '!'
    chip.set(
      Array.from(s < 2 ? '42324' : 'BMWEB', (c) => c.charCodeAt(0)),
      at + 0x21
    );
  }
  const dme = {
    chip,
    slots: new Array(64).fill(MARK.FRESH), // the marker ladder
    cur: 0,
    erases: 0,
    reads: 0,
    chunks: 0,
    /** The nth CHUNK from now goes unanswered (0: none). `landed`: whether it was programmed first. */
    loseChunk: 0,
    loseLanded: false,
    resets: 0,
    client: {
      async aifRead() {
        return dme.cur >= dme.slots.length ? MARK.DONE : dme.slots[dme.cur];
      },
      async aifArm() {
        if (dme.slots[dme.cur] !== MARK.FRESH)
          throw new Error('mock: arm over a non-fresh slot');
        dme.slots[dme.cur] = MARK.ARMED;
      },
      async aifDone() {
        if (dme.slots[dme.cur] !== MARK.ARMED)
          throw new Error('mock: done over a non-armed slot');
        dme.slots[dme.cur] = MARK.DONE;
        dme.cur++;
      },
      async erase(off) {
        if (off === BOOT && dme.slots[dme.cur] !== MARK.ARMED)
          throw new Error('mock: boot-sector ERASE refused, marker not armed');
        if (off === BOOT) {
          dme.chip.fill(0xff, BOOT, BOOT_END);
          dme.erases++;
        }
      },
      async sectorQuery(off, len) {
        return crc32(dme.chip.subarray(off, off + len)) >>> 0;
      },
      async chunk(off, plain) {
        if (off >= BOOT && dme.slots[dme.cur] !== MARK.ARMED)
          throw new Error('mock: boot-sector CHUNK refused, marker not armed');
        dme.chunks++;
        const lost = dme.loseChunk && --dme.loseChunk === 0;
        // a frame the line lost: nothing programmed, nothing answered
        if (lost && !dme.loseLanded)
          throw new Error('fast flasher: no reply to CHUNK');
        for (let i = 0; i < plain.length; i++) dme.chip[off + i] &= plain[i];
        if (lost) throw new Error('fast flasher: no reply to CHUNK');
        // the body's read-back compare: a chunk that would set bits NAKs
        for (let i = 0; i < plain.length; i++)
          if (dme.chip[off + i] !== plain[i])
            throw new fastFlashWire.Nak(fastFlashWire.SVC.CHUNK, 4);
      },
      async verify(off, len, want) {
        if (crc32(dme.chip.subarray(off, off + len)) >>> 0 !== want >>> 0)
          throw new fastFlashWire.Nak(fastFlashWire.SVC.VERIFY, 5);
      },
      async read(off, len) {
        dme.reads += len;
        return dme.chip.slice(off, off + len);
      },
    },
  };
  return dme;
}

const cb = () => {
  const notes = [];
  return {
    notes,
    stage: () => {},
    progress: () => {},
    note: (s) => notes.push(s),
  };
};

(async () => {
  const stock = () => mockDme();

  // ---- writeDirect: two bit-clear edits, no erase -------------------------
  {
    const dme = stock();
    const e1 = dme.chip.slice(AIF, AIF + 64);
    e1[0x21 + 4] = 0x30; // '4' -> '0' (a clear)
    const e2 = dme.chip.slice(AIF + 64, AIF + 128);
    e2[0x22] = 0x20; // '3' -> ' ' (a clear)
    await aifLog.writeDirect(
      dme.client,
      [
        { at: AIF, bytes: e1 },
        { at: AIF + 64, bytes: e2 },
      ],
      cb()
    );
    check('direct: slot 0 edited', dme.chip[AIF + 0x25] === 0x30);
    check('direct: slot 1 edited', dme.chip[AIF + 64 + 0x22] === 0x20);
    check(
      'direct: nothing below the log changed',
      crc32(dme.chip.subarray(BOOT, AIF)) ===
        crc32(stock().chip.subarray(BOOT, AIF))
    );
    check('direct: no erase', dme.erases === 0);
    check(
      'direct: two ladder slots spent, third fresh',
      (async () => true)() &&
        dme.slots[0] === MARK.DONE &&
        dme.slots[1] === MARK.DONE &&
        dme.slots[2] === MARK.FRESH
    );
  }

  // ---- writeDirect: a bit-set edit NAKs and says why ----------------------
  {
    const dme = stock();
    const bad = dme.chip.slice(AIF, AIF + 64);
    bad[0x21] = (0x42 & 0x02) | 0x41; // 'B' over '4'... whatever: force a set
    bad[0x21] = bad[0x21] | 0x08; // a bit the chip does not have
    let threw = '';
    try {
      await aifLog.writeDirect(dme.client, [{ at: AIF, bytes: bad }], cb());
    } catch (e) {
      threw = e.message;
    }
    check(
      'bit-set: refused with the rewrite guidance',
      /would not take/.test(threw) && /rewrite/.test(threw)
    );
    check('bit-set: nothing below the log changed', dme.erases === 0);
    check(
      'bit-set: the ladder stays ARMED (resumable)',
      dme.slots[0] === MARK.ARMED && dme.cur === 0
    );
    // ...and the next good edit resumes through the armed slot
    const good = dme.chip.slice(AIF, AIF + 64);
    good[0x25] = 0x30;
    await aifLog.writeDirect(dme.client, [{ at: AIF, bytes: good }], cb());
    check(
      'bit-set: a later edit resumes the armed slot',
      dme.slots[0] === MARK.DONE && dme.cur === 1
    );
  }

  // ---- writeDirect: bounds and shape --------------------------------------
  {
    const dme = stock();
    let threw = '';
    try {
      await aifLog.writeDirect(
        dme.client,
        [{ at: AIF - 2, bytes: new Uint8Array(64) }],
        cb()
      );
    } catch (e) {
      threw = e.message;
    }
    check(
      'bounds: an edit outside the log refused',
      /outside the log/.test(threw)
    );
    threw = '';
    try {
      await aifLog.writeDirect(
        dme.client,
        [{ at: AIF, bytes: new Uint8Array(63) }],
        cb()
      );
    } catch (e) {
      threw = e.message;
    }
    check(
      'bounds: an odd-length edit refused',
      /even, at most 4096/.test(threw)
    );
  }

  // ---- rewrite: a trusted sector that matches, splice and restore ---------
  {
    const dme = stock();
    const sector = dme.chip.slice(BOOT, BOOT_END); // what the app holds
    const aif = new Uint8Array(LOG_LEN).fill(0xff); // clear-all
    await aifLog.rewrite(dme.client, aif, cb(), { sector });
    check(
      'rewrite: the log is blank',
      dme.chip.subarray(AIF, BOOT_END).every((b) => b === 0xff)
    );
    check(
      'rewrite: the loader came back byte-identical',
      dme.chip.subarray(BOOT, AIF).every((b, i) => b === sector[i])
    );
    check(
      'rewrite: one erase, one ladder slot',
      dme.erases === 1 && dme.slots[0] === MARK.DONE
    );
    check('rewrite: nothing read off the DME', dme.reads === 0);
  }

  // ---- rewrite: a stale sector falls back to reading the DME --------------
  {
    const dme = stock();
    const sector = dme.chip.slice(BOOT, BOOT_END);
    sector[0x100] ^= 0xff; // not what the chip holds
    const aif = new Uint8Array(LOG_LEN).fill(0xff);
    const c = cb();
    await aifLog.rewrite(dme.client, aif, c, { sector });
    check(
      'fallback: the stale sector was not trusted',
      c.notes.some((n) => /does not match the chip/.test(n))
    );
    check('fallback: the sector was read back', dme.reads === AIF - BOOT);
    check(
      'fallback: the loader still byte-identical',
      dme.chip.subarray(BOOT, AIF).every((b, i) => b === stock().chip[BOOT + i])
    );
    check(
      'fallback: the log blank',
      dme.chip.subarray(AIF, BOOT_END).every((b) => b === 0xff)
    );
  }

  // ---- rewrite: no sector given, wrong log length, spent ladder -----------
  {
    const dme = stock();
    const aif = new Uint8Array(LOG_LEN).fill(0xff);
    aif[0] = 0x40;
    await aifLog.rewrite(dme.client, aif, cb()); // no opts.sector
    check(
      'no-sector: read the boot content off the DME',
      dme.reads === AIF - BOOT
    );
    check('no-sector: the log rewritten', dme.chip[AIF] === 0x40);

    let threw = '';
    try {
      await aifLog.rewrite(dme.client, new Uint8Array(64), cb());
    } catch (e) {
      threw = e.message;
    }
    check(
      'shape: a wrong-length log refused',
      /must be 1228 bytes/.test(threw)
    );

    const spent = mockDme();
    spent.slots.fill(MARK.DONE);
    spent.cur = 64;
    threw = '';
    try {
      await aifLog.rewrite(
        spent.client,
        new Uint8Array(LOG_LEN).fill(0xff),
        cb()
      );
    } catch (e) {
      threw = e.message;
    }
    check(
      'ladder: every slot spent -> nothing erased',
      /is spent/.test(threw) && spent.erases === 0
    );

    const foreign = mockDme();
    foreign.slots[0] = 0x1234;
    threw = '';
    try {
      await aifLog.rewrite(
        foreign.client,
        new Uint8Array(LOG_LEN).fill(0xff),
        cb()
      );
    } catch (e) {
      threw = e.message;
    }
    check(
      'ladder: a foreign tail refused',
      /foreign tail/.test(threw) && foreign.erases === 0
    );
  }

  // ---- a rewrite cut after its erase ---------------------------------------
  // One CHUNK of the restore goes unanswered. The boot sector is erased
  // past that point; the image to finish it from is on this side only.
  const wire = fastFlashWire;
  const cutRewrite = async (landed) => {
    wire.rewriteEnd();
    const dme = stock();
    const before = dme.chip.slice(BOOT, AIF);
    const aif = new Uint8Array(LOG_LEN).fill(0xff);
    aif[0] = 0x40;
    dme.loseChunk = 10;
    dme.loseLanded = landed;
    let threw = '';
    try {
      await aifLog.rewrite(dme.client, aif, cb());
    } catch (e) {
      threw = e.message;
    }
    return { dme, before, aif, threw };
  };
  {
    const { dme, before, aif, threw } = await cutRewrite(false);
    check('cut: the rewrite stopped at the lost frame', /no reply/.test(threw));
    check(
      'cut: the loader is part erased',
      dme.chip.subarray(BOOT + 10 * 0x1000, AIF).every((b) => b === 0xff)
    );
    check(
      'cut: the image is kept open',
      !!wire.rewriteOpen() &&
        wire.rewriteOpen().base === BOOT &&
        wire.rewriteOpen().data.length === BOOT_END - BOOT
    );
    check(
      "cut: the DME reads 'open'",
      (await wire.rewriteState(dme.client)) === 'open'
    );

    // the retry that used to brick: the same rewrite again WITHOUT the
    // finish. It must refuse the part-erased sector as a source.
    const kept = wire.rewriteOpen();
    wire.rewriteEnd(); // as after a page that lost the image
    let refused = '';
    const erasesBefore = dme.erases;
    try {
      await aifLog.rewrite(dme.client, aif, cb());
    } catch (e) {
      refused = e.message;
    }
    check(
      'cut, image lost: a second rewrite refuses the erased sector as its source',
      /reads erased/.test(refused) &&
        /Do NOT switch the ignition off/.test(refused)
    );
    check('cut, image lost: nothing more erased', dme.erases === erasesBefore);

    // with the image: finished from it, loader byte-identical, log as asked
    wire.rewriteBegin(kept.base, kept.data, kept.what);
    const c = cb();
    const finished = await aifLog.finishInterrupted(dme.client, c);
    check('finish: reported', finished === true);
    check(
      'finish: the loader is back byte for byte',
      dme.chip.subarray(BOOT, AIF).every((b, i) => b === before[i])
    );
    check(
      'finish: the log is the one that rewrite was writing',
      dme.chip.subarray(AIF, BOOT_END).every((b, i) => b === aif[i])
    );
    check(
      'finish: the marker moved on',
      dme.slots[0] === MARK.DONE && dme.cur === 1
    );
    check('finish: nothing is open any more', wire.rewriteOpen() === null);
    check(
      'finish: a second call does nothing',
      (await aifLog.finishInterrupted(dme.client, cb())) === false
    );
  }
  {
    // the lost frame had been programmed, and it was the last one: the
    // sector is whole, only VERIFY and DONE never ran
    wire.rewriteEnd();
    const dme = stock();
    const aif = new Uint8Array(LOG_LEN).fill(0xff);
    dme.loseChunk = 24;
    dme.loseLanded = true;
    try {
      await aifLog.rewrite(dme.client, aif, cb());
    } catch (e) {
      /* the lost answer */
    }
    check(
      "whole: the DME reads 'whole'",
      (await wire.rewriteState(dme.client)) === 'whole'
    );
    const erases = dme.erases;
    check(
      'whole: finished',
      (await aifLog.finishInterrupted(dme.client, cb())) === true
    );
    check(
      'whole: no second erase, the marker closed',
      dme.erases === erases &&
        dme.slots[0] === MARK.DONE &&
        wire.rewriteOpen() === null
    );
  }
  {
    // a record that is not about this DME: its ladder has moved on
    wire.rewriteEnd();
    const dme = stock();
    wire.rewriteBegin(
      BOOT,
      new Uint8Array(BOOT_END - BOOT).fill(0x11),
      'the boot sector'
    );
    check(
      "stale: marker not armed -> 'none'",
      (await wire.rewriteState(dme.client)) === 'none'
    );
    check('stale: the record is dropped', wire.rewriteOpen() === null);
    // ... or armed, but the sector has bits clear that the image wants set
    // (an erase that never ran, another DME): not written over
    wire.rewriteBegin(
      BOOT,
      new Uint8Array(BOOT_END - BOOT).fill(0xff),
      'the boot sector'
    );
    await dme.client.aifArm();
    const erases = dme.erases;
    check(
      'stale: a sector the image does not fit is left alone',
      (await aifLog.finishInterrupted(dme.client, cb())) === false &&
        dme.erases === erases &&
        wire.rewriteOpen() === null
    );
  }
  {
    // an erase the body refuses outright leaves nothing open
    wire.rewriteEnd();
    const dme = stock();
    dme.client.erase = async () => {
      throw new wire.Nak(wire.SVC.ERASE, 3);
    };
    try {
      await aifLog.rewrite(
        dme.client,
        new Uint8Array(LOG_LEN).fill(0xff),
        cb()
      );
    } catch (e) {
      /* refused */
    }
    check('refused erase: nothing is open', wire.rewriteOpen() === null);
  }

  // ---- RESET is not sent while a boot sector is part-written -----------------
  {
    const { dme } = await cutRewrite(false);
    // the real client's reset(), over the mock's services
    const client = Object.create(wire.Client.prototype);
    Object.assign(client, dme.client, {
      readMax: 0x1000,
      call: async (svc) => {
        if (svc === wire.SVC.RESET) dme.resets++;
        return new Uint8Array(0);
      },
    });
    let threw = null;
    try {
      await client.reset();
    } catch (e) {
      threw = e;
    }
    check(
      'reset: refused while the sector is open, and says why',
      !!threw &&
        threw.rewriteOpen === true &&
        /without its loader/.test(threw.message)
    );
    check('reset: nothing was sent', dme.resets === 0);
    await aifLog.finishInterrupted(dme.client, cb());
    await client.reset();
    check('reset: sent once the sector is whole again', dme.resets === 1);
  }

  // ---- the bootloader client over the same window ----------------------------
  // bl.restore's 96 KB rewrite cut after its erase: run again, it used to
  // read the erased sector, find "the ring blanked" and report the boot
  // region already stock -- with no loader in it.
  {
    wire.rewriteEnd();
    const dme = stock();
    // a boot region as bl.restore expects: the installer ring in its span,
    // both words patched, and an 8 KB sector / low sectors to read
    const ringAt = blBlob.ring.at;
    const ring = Uint8Array.from(
      blBlob.installerRing.hex
        .join('')
        .match(/../g)
        .map((h) => parseInt(h, 16))
    );
    dme.chip.fill(0xff, ringAt, 0x1f700);
    dme.chip.set(ring, ringAt);
    // no boot CRC table (the loader does not check): keeps the mock simple
    dme.chip.fill(0xff, 0x1f808, 0x1f810);
    for (const p of blBlob.patches) {
      dme.chip[p.at] = p.word >>> 24;
      dme.chip[p.at + 1] = (p.word >>> 16) & 255;
      dme.chip[p.at + 2] = (p.word >>> 8) & 255;
      dme.chip[p.at + 3] = p.word & 255;
    }
    // the mock erases/refuses by BOOT only: give it the 8 KB sector too
    const erase0 = dme.client.erase;
    dme.client.erase = async (off) => {
      if (off === 0x4000) {
        dme.chip.fill(0xff, 0x4000, 0x6000);
        return;
      }
      return erase0(off);
    };
    const want = dme.chip.slice(0, BOOT_END);
    for (const p of blBlob.patches) {
      want[p.at] = p.stock >>> 24;
      want[p.at + 1] = (p.stock >>> 16) & 255;
      want[p.at + 2] = (p.stock >>> 8) & 255;
      want[p.at + 3] = p.stock & 255;
    }
    want.fill(0xff, ringAt, 0x1f700);
    // the 8 KB sector is 2 chunks, then the 96 KB one: lose its 6th
    dme.loseChunk = 2 + 6;
    let threw = '';
    try {
      await bl.restore(dme.client, cb());
    } catch (e) {
      threw = e.message;
    }
    check('bl.restore: cut inside the 96 KB sector', /no reply/.test(threw));
    check(
      'bl.restore: that sector is kept open',
      !!wire.rewriteOpen() && wire.rewriteOpen().base === BOOT
    );
    const r = await bl.restore(dme.client, cb());
    check(
      'bl.restore, run again: the boot region is the stock one, whole',
      dme.chip.subarray(0, BOOT_END).every((b, i) => b === want[i])
    );
    check(
      'bl.restore, run again: finished from the kept image, nothing left open',
      !!r && wire.rewriteOpen() === null
    );
  }

  console.log(
    failures ? `\n${failures} FAIL` : '\nALL OK -- aifLog client vs mock DME'
  );
  process.exit(failures ? 1 : 0);
})();
