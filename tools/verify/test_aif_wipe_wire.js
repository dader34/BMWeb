#!/usr/bin/env node
// The BMWeb side of the AIF wipe: fastFlashWire.wipeAif drives the v10
// boot-window body's sequence (arm -> erase -> blank-check -> restore ->
// verify -> done). The BODY itself is proven in ms45-emu (aif_wipe_flasher.py);
// this proves the CLIENT emits that sequence and converges, against a mock DME
// that models the marker, the arm-gated boot erase, blank reads and AND
// programming. No hardware, no NRV2B (the mock client takes plain bytes).
//
//   node tools/verify/test_aif_wipe_wire.js
if (typeof global.window === 'undefined') global.window = {};
const {
  fastFlashWire,
} = require('../../app/renderer/core/flash/fast-flasher-wire.js');
const crc32 = fastFlashWire.crc32;

const BOOT = 0x8000;
const BOOT_END = 0x20000;
const AIF = 0x1fb34;
const MARK = { FRESH: 0xffff, ARMED: 0xa55a, DONE: 0xa558 };

let failures = 0;
const check = (what, ok) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}`);
  } else console.log(`  ok    ${what}`);
};

// A mock DME: the boot sector as a chip buffer + the resume marker. Erase
// blanks the sector (arm-gated), chunk AND-programs, sectorQuery/verify CRC it.
function mockDme({ marker = MARK.FRESH, blank = false } = {}) {
  // reference stock boot content below the log, then a populated log
  const bootContent = new Uint8Array(AIF - BOOT);
  for (let i = 0; i < bootContent.length; i++)
    bootContent[i] = (i * 31 + 7) & 0xff;
  const chip = new Uint8Array(BOOT_END); // indices >= 0x8000 are the boot sector
  chip.fill(0xff);
  chip.set(bootContent, BOOT);
  for (let a = AIF; a < BOOT_END; a++) chip[a] = (a * 13 + 1) & 0xff; // a "used" log
  if (blank) chip.fill(0xff, BOOT, BOOT_END); // model an already-erased sector
  const dme = {
    marker,
    chip,
    bootContent,
    erases: 0,
    client: {
      async hello() {
        const s = new Uint8Array(16);
        s.set([0x4d, 0x53, 0x34, 0x35, 0x51, 0x46], 0); // "MS45QF"
        s[6] = 12; // v12
        s[7] = 0x03; // flags: MPC window + boot window
        return s;
      },
      async aifRead() {
        return dme.marker;
      },
      async aifArm() {
        dme.marker &= MARK.ARMED; // program clears bits: 0xFFFF -> 0xA55A
      },
      async aifDone() {
        dme.marker &= MARK.DONE; // 0xA55A -> 0xA558
      },
      async erase(off) {
        if (off >= BOOT && off < BOOT_END && dme.marker !== MARK.ARMED)
          throw new Error('mock: boot-sector ERASE refused, marker not armed');
        if (off >= BOOT && off < BOOT_END) {
          dme.chip.fill(0xff, BOOT, BOOT_END);
          dme.erases++;
        }
      },
      async sectorQuery(off, len) {
        return crc32(dme.chip.subarray(off, off + len)) >>> 0;
      },
      async chunk(off, plain) {
        for (let i = 0; i < plain.length; i++) dme.chip[off + i] &= plain[i]; // AND-program
      },
      async verify(off, len, crc) {
        if (crc32(dme.chip.subarray(off, off + len)) >>> 0 !== crc >>> 0)
          throw new Error(`mock: VERIFY mismatch at 0x${off.toString(16)}`);
      },
    },
  };
  return dme;
}

function assertWiped(dme, label) {
  const bootOk = dme.chip
    .subarray(BOOT, AIF)
    .every((b, i) => b === dme.bootContent[i]);
  const logBlank = dme.chip.subarray(AIF, BOOT_END).every((b) => b === 0xff);
  check(`${label}: boot content below the log == stock`, bootOk);
  check(`${label}: the log 0x1fb34-0x1ffff is blank`, logBlank);
  check(`${label}: marker DONE`, dme.marker === MARK.DONE);
}

(async () => {
  // 1. fresh wipe
  let dme = mockDme();
  let r = await fastFlashWire.wipeAif(dme.client, dme.bootContent);
  check('fresh: wipeAif reports wiped', r.wiped === true);
  check('fresh: exactly one boot-sector erase', dme.erases === 1);
  assertWiped(dme, 'fresh');

  // 2. resume from ARMED with the boot sector already blank (interrupted after
  //    erase): the marker-driven path re-erases (idempotent) and restores
  dme = mockDme({ marker: MARK.ARMED, blank: true });
  r = await fastFlashWire.wipeAif(dme.client, dme.bootContent);
  check('resume(armed,blank): wiped', r.wiped === true);
  assertWiped(dme, 'resume');

  // 3. v11 reads DONE only when every marker slot is spent: refused, unerased
  dme = mockDme({ marker: MARK.DONE });
  let spentThrew = false;
  try {
    await fastFlashWire.wipeAif(dme.client, dme.bootContent);
  } catch (e) {
    spentThrew = /slot on this DME is spent/.test(e.message);
  }
  check(
    'all slots spent: refused, nothing erased',
    spentThrew && dme.erases === 0
  );

  // 4. a non-v10 body is refused
  dme = mockDme();
  dme.client.hello = async () => {
    const s = new Uint8Array(16);
    s.set([0x4d, 0x53, 0x34, 0x35, 0x51, 0x46], 0);
    s[6] = 9;
    s[7] = 0x01; // v9, no boot window
    return s;
  };
  let threw = false;
  try {
    await fastFlashWire.wipeAif(dme.client, dme.bootContent);
  } catch {
    threw = true;
  }
  check('a v9 body is refused (not the boot-window body)', threw);

  // 5. a sector that will not blank (hardware-protected) is caught, not written
  dme = mockDme();
  dme.client.erase = async () => {}; // "erase" that does nothing (protected)
  threw = false;
  try {
    await fastFlashWire.wipeAif(dme.client, dme.bootContent);
  } catch (e) {
    threw = /did not read blank/.test(e.message);
  }
  check('a sector that will not blank is caught before any restore', threw);

  // 6. a restore source that is not this DME's boot content (another loader
  //    build) is refused before the marker is armed or anything is erased
  dme = mockDme();
  const foreign = dme.bootContent.slice();
  foreign[0x14b00 - BOOT] ^= 0xff; // in the CMF driver the builds place differently
  threw = false;
  try {
    await fastFlashWire.wipeAif(dme.client, foreign);
  } catch (e) {
    threw = /does not match/.test(e.message);
  }
  check(
    'a foreign boot content is refused: nothing armed, nothing erased',
    threw && dme.erases === 0 && dme.marker === MARK.FRESH
  );

  // 7. the old line test's damage (its 4 KB pattern ANDed into 0x10000 by a
  //    v10 body) differs from the clean source in that block alone: the wipe
  //    goes ahead and the restore repairs it
  dme = mockDme();
  for (let i = 0; i < 0x1000; i++)
    dme.chip[0x10000 + i] &= (i * 7919 + 13) & 0xff;
  r = await fastFlashWire.wipeAif(dme.client, dme.bootContent);
  check('line-test damage: wiped', r.wiped === true);
  assertWiped(dme, 'line-test damage repaired');

  // 8. the same damage plus a difference anywhere else is refused
  dme = mockDme();
  for (let i = 0; i < 0x1000; i++)
    dme.chip[0x10000 + i] &= (i * 7919 + 13) & 0xff;
  dme.chip[0x14b00] ^= 0xff;
  threw = false;
  try {
    await fastFlashWire.wipeAif(dme.client, dme.bootContent);
  } catch (e) {
    threw = /0x10000, 0x14000/.test(e.message);
  }
  check(
    'damage at 0x10000 AND elsewhere is refused, naming both blocks',
    threw && dme.erases === 0 && dme.marker === MARK.FRESH
  );

  if (failures) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log('\nALL OK');
})().catch((e) => {
  console.log('FAIL (threw):', e && e.message);
  process.exit(1);
});
