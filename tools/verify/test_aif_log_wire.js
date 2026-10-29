#!/usr/bin/env node
// The AIF editor's wire client (core/flash/aif.js) against a mock DME:
// the marker ladder's rules, the AND-physics backstop on direct writes,
// the rewrite's trusted-sector check and read fallback. The PROTOCOL is
// proven on the emulator (ms45-emu tools/aif_editor_test.py, ALL OK
// 2026-10-27, on the BL14 image); this proves the client emits that
// sequence and converges. No hardware, no NRV2B (the mock client takes
// plain bytes).
//
//   node tools/verify/test_aif_log_wire.js
if (typeof global.window === 'undefined') global.window = {};
const {
  fastFlashWire,
} = require('../../app/renderer/core/flash/fast-flasher-wire.js');
const { aifLog } = require('../../app/renderer/core/flash/aif.js');

const crc32 = fastFlashWire.crc32;
const MARK = fastFlashWire.MARK;
const BOOT = 0x8000;
const BOOT_END = 0x20000;
const AIF = 0x1fb34;
const LOG_LEN = BOOT_END - AIF;
const SLOTS = Math.floor(LOG_LEN / 64);

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
        for (let i = 0; i < plain.length; i++) dme.chip[off + i] &= plain[i];
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

  console.log(
    failures ? `\n${failures} FAIL` : '\nALL OK -- aifLog client vs mock DME'
  );
  process.exit(failures ? 1 : 0);
})();
