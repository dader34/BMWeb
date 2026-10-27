// Flashing/Tuning: the fast flash bootloader -- BL15, the boot-region
// flasher ring (ms45-emu docs/bootloader.md; the file keeps BL14's name) --
// put on a DME over the wire. BENCH ONLY (localhost).
//
// It lives in the boot region instead of the program area: a ring in the
// 96 KB boot sector's blank span (the handoff window, the park window, the
// stamp at 0x17140, a relocate stub and the v13 body) plus TWO changed stock
// words in the 8 KB sector at 0x4000: the loader's handoff at 0x4EBC (`ba
// 0x8` -> the handoff window) and the head of its park function at 0x5228
// (the factory KWP idle a DME falls into when its program or tune does not
// check out -> the park window). A held line at either lands in the
// flasher, so a push cut short by a power loss can still be resumed; a free
// line runs the stock code. A program flash cannot take it away, and the
// AIF editor runs on it. BL14 (stamp at 0x17080, the handoff word only) is
// still recognised by Identify; this file installs BL15.
//
// The park hook is only right for a loader that enters its park through the
// call BL15 was built against (the lis+addi pair at 0x3828, bl14Blob.guard):
// the install reads it first and refuses any other loader build.
//
// Installing needs a body that may rewrite the 8 KB sector at 0x4000 those
// words live in: the installer variant of the resident body (bl14Blob.
// installer, stamp flags bit 2), put on the DME first by a Fast Flash
// Program. The install then runs on that body, as tools/bl14_test.py's
// installer proved it on the emulator, with two differences on purpose:
//
//   - the boot content written back is the DME's OWN, read off it, with the
//     ring spliced in -- the car's loader build differs from the donor's,
//     and the programming log is kept rather than blanked;
//   - MPC block 0 is left alone: the resident flasher's 0x8 hook stays and
//     keeps working beside BL14 (BL14's window is first in the boot path, so
//     a held line lands in BL14). No MPC erase, no CMF exposure.
//
// The order keeps the DME bootable as long as possible: the ring goes in
// first, inert (nothing jumps to it while both words are stock), and the
// two words are written last. Committed windows: between each ERASE and
// its VERIFY (the 96 KB sector holds the loader, the 8 KB one its handoff);
// a cut there needs a BDM / boot-mode rig, as the AIF rewrite does.
/* exported bl14 */

const BL14_BOOT = 0x8000;
const BL14_BOOT_LEN = 0x18000; // [0x8000, 0x20000)
const BL14_SECT8K = 0x4000;
const BL14_SECT8K_LEN = 0x2000;
const BL14_CHUNK = 0x1000;
const BL14_MAGIC = 'MS45BL';
/** The installer body's stamp flag: its window opens at 0x4000. */
const BL14_INSTALLER_FLAG = 0x04;

const bl14Wire =
  typeof fastFlashWire !== 'undefined'
    ? fastFlashWire
    : require('./fast-flasher-wire.js').fastFlashWire;
const bl14Data =
  typeof bl14Blob !== 'undefined'
    ? bl14Blob
    : require('./bl14-blob.js').bl14Blob;

/** @param {string} hex @returns {Uint8Array} */
function _bl14Hex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** The ring's bytes, from `bl14Blob.ring.at`. @returns {Uint8Array} */
function bl14Ring() {
  return _bl14Hex(bl14Data.ring.hex.join(''));
}

/** @param {Uint8Array} b @param {number} at @returns {number} */
function _bl14Be32(b, at) {
  return (
    ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
  );
}

/** @param {Uint8Array} b @param {number} at @param {number} v */
function _bl14PutBe32(b, at, v) {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
}

/**
 * The DME's boot region with the ring in it. Refuses unless the park call
 * is the one the ring was built against, both patched words are stock (or
 * already ours) and every byte the ring covers is blank (or already the
 * ring): anything else is not a boot region this ring was built for, and
 * nothing is written.
 * @param {Uint8Array} boot - [0x8000, 0x20000) as read off the DME.
 * @param {Uint8Array} sect8k - [0x4000, 0x6000) as read off the DME.
 * @param {Uint8Array} guard - The 8 bytes at bl14Blob.guard.at, read off it.
 * @returns {{boot: Uint8Array, sect8k: Uint8Array, bootChanged: boolean,
 *   sect8kChanged: boolean}}
 */
function bl14Splice(boot, sect8k, guard) {
  if (boot.length !== BL14_BOOT_LEN || sect8k.length !== BL14_SECT8K_LEN)
    throw new Error('bl14: the boot region read is the wrong size');
  const g = bl14Data.guard;
  if (
    !guard ||
    guard.length < 8 ||
    _bl14Be32(guard, 0) !== g.words[0] ||
    _bl14Be32(guard, 4) !== g.words[1]
  )
    throw new Error(
      `bl14: the loader's park call at ext 0x${g.at.toString(16)} is not the one the bootloader was built for: this DME's loader is a different build. Nothing was written.`
    );
  const ring = bl14Ring();
  const at = bl14Data.ring.at - BL14_BOOT;
  for (let i = 0; i < ring.length; i++) {
    const v = boot[at + i];
    if (v !== 0xff && v !== ring[i])
      throw new Error(
        `bl14: ext 0x${(bl14Data.ring.at + i).toString(16)} is neither blank nor the ring (an older bootloader, or not a boot sector it was built for). Nothing was written.`
      );
  }
  for (const p of bl14Data.patches) {
    const word = _bl14Be32(sect8k, p.at - BL14_SECT8K);
    if (word !== p.stock && word !== p.word)
      throw new Error(
        `bl14: the loader's word at ext 0x${p.at.toString(16)} reads 0x${word.toString(16)}, not the stock 0x${p.stock.toString(16)}. Nothing was written.`
      );
  }
  const nb = Uint8Array.from(boot);
  nb.set(ring, at);
  const ns = Uint8Array.from(sect8k);
  for (const p of bl14Data.patches)
    _bl14PutBe32(ns, p.at - BL14_SECT8K, p.word);
  const same = (a, b) => a.every((x, i) => x === b[i]);
  return {
    boot: nb,
    sect8k: ns,
    bootChanged: !same(nb, boot),
    sect8kChanged: !same(ns, sect8k),
  };
}

/**
 * Erase one sector, check it blank, write it back 4 KB at a time and
 * verify the whole of it.
 */
async function _bl14Rewrite(client, base, data, cb, pct0, pct1, what) {
  const crc = bl14Wire.crc32;
  cb.stage(`Erasing ${what}`);
  await client.erase(base);
  const blank = crc(new Uint8Array(data.length).fill(0xff)) >>> 0;
  if ((await client.sectorQuery(base, data.length)) >>> 0 !== blank)
    throw new Error(
      `${what} did not read blank after ERASE (hardware-protected?)`
    );
  cb.stage(`Writing ${what}`);
  const n = data.length / BL14_CHUNK;
  for (let i = 0; i < n; i++) {
    await client.chunk(
      base + i * BL14_CHUNK,
      data.subarray(i * BL14_CHUNK, (i + 1) * BL14_CHUNK)
    );
    cb.progress(pct0 + Math.floor(((i + 1) * (pct1 - pct0)) / n));
  }
  cb.stage(`Verifying ${what}`);
  await client.verify(base, data.length, crc(data) >>> 0);
}

/**
 * Put the bootloader on the DME through the installer body: read the park
 * call and both sectors off the DME, splice, then the ladder -- ARM, the
 * 96 KB sector (ring in, inert), the 8 KB sector (both words, last), DONE --
 * and the stamp read back from where the ring keeps it. A DME that already
 * carries this ring is left as it is.
 * @param {FastFlashClient} client - A session on the installer body.
 * @param {{stage: (s: string) => void, progress: (pct: number) => void,
 *   note: (s: string) => void}} cb
 * @returns {Promise<{skipped: boolean, summary: string}>}
 */
async function bl14Install(client, cb) {
  cb.stage('Reading the boot region off the DME');
  const guard = await client.read(bl14Data.guard.at, 8);
  const sect8k = await bl14Wire.readArea(client, BL14_SECT8K, BL14_SECT8K_LEN);
  const boot = await bl14Wire.readArea(client, BL14_BOOT, BL14_BOOT_LEN, (n) =>
    cb.progress(Math.floor((n * 20) / BL14_BOOT_LEN))
  );
  const s = bl14Splice(boot, sect8k, guard);
  if (!s.bootChanged && !s.sect8kChanged) {
    cb.note('the bootloader is already on the DME: nothing written');
    return {
      skipped: true,
      summary: 'the bootloader was already on the DME',
    };
  }
  cb.note(
    `splice: ring ${s.bootChanged ? 'goes in' : 'already in'}, handoff + park words ${s.sect8kChanged ? 'go in' : 'already patched'}`
  );
  await aifLadderArm(client, cb.note);
  if (s.bootChanged)
    await _bl14Rewrite(
      client,
      BL14_BOOT,
      s.boot,
      cb,
      20,
      85,
      'the boot sector (the ring, inert)'
    );
  if (s.sect8kChanged)
    await _bl14Rewrite(
      client,
      BL14_SECT8K,
      s.sect8k,
      cb,
      85,
      95,
      'the 8 KB sector (the handoff and park words)'
    );
  await aifLadderDone(client);
  const stamp = await client.read(bl14Data.ring.stampAt, 16);
  const magic = String.fromCharCode(...stamp.subarray(0, 6));
  if (magic !== BL14_MAGIC)
    throw new Error(`the stamp reads "${magic}" after the install`);
  cb.progress(100);
  return {
    skipped: false,
    summary: 'fast flasher installed, programming log kept',
  };
}

const bl14 = {
  MAGIC: BL14_MAGIC,
  STAMP_AT: bl14Data.ring.stampAt,
  INSTALLER_FLAG: BL14_INSTALLER_FLAG,
  splice: bl14Splice,
  install: bl14Install,
  /** Whether identify's detection is the installer body. */
  isInstaller(det) {
    return !!(det && det.version >= 13 && det.flags & BL14_INSTALLER_FLAG);
  },
  /**
   * The pair with the installer body spliced in, as fastFlasher.bootstrap
   * splices the shipped one (the caller signs).
   * @param {Uint8Array} flash @param {Uint8Array} mpc
   * @returns {{flash: Uint8Array, mpc: Uint8Array}}
   */
  withInstaller(flash, mpc) {
    const inst = bl14Data.installer;
    const f = Uint8Array.from(flash);
    const m = Uint8Array.from(mpc);
    // whichever body the pair carried goes, the installer takes its place
    f.fill(0xff, fastFlasher.BODY_START, fastFlasher.BODY_END);
    for (const [off, hex] of inst.runs) f.set(_bl14Hex(hex), off);
    _bl14PutBe32(m, inst.hookAt, inst.hookWord);
    return { flash: f, mpc: m };
  },
};

if (typeof window !== 'undefined') window.bl14 = bl14;
if (typeof module !== 'undefined' && module.exports) module.exports = { bl14 };
