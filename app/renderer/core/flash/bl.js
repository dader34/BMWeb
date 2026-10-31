// Flashing/Tuning: the fast flash bootloader -- BL, the boot-region
// flasher ring (ms45-emu docs/bootloader.md) --
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
// AIF editor runs on it. The old ring layout (stamp at 0x17080, the handoff word only) is
// still recognised by Identify; this file installs BL.
//
// And takes it off again (Restore stock bootloader). A held line on a BL
// DME always lands in the ring -- its handoff window runs before MPC 0x8,
// so a resident installer body is out of reach -- and the ring's body may
// not touch the 8 KB sector. So the way back is two sessions on the ring:
//
//   1. on BL: the ring swapped for its INSTALLER variant (blBlob.
//      installerRing: the same windows and layout, the body's write window
//      opened to 0x4000, stamp flags 7) -- one 96 KB rewrite, the windows
//      at the same addresses, so the patched words stay right throughout;
//   2. on the installer ring: the 8 KB sector with both words stock FIRST
//      (from then on the DME boots the stock loader whatever happens to
//      the ring), then the 96 KB sector with the ring blanked, stamp and
//      all -- the boot region as it was before the install, loader build
//      and programming log kept.
//
// A cut after step 2's 8 KB rewrite and before its 96 KB one leaves a DME
// that boots stock but still carries the installer ring's stamp; nothing
// can reach that ring any more, so Identify keeps reporting a bootloader
// that a held line no longer finds. Harmless, but only a bench rig clears
// the stamp (Install refuses a ring it did not put there).
//
// The park hook is only right for a loader that enters its park through the
// call BL was built against (the lis+addi pair at 0x3828, blBlob.guard):
// the install reads it first and refuses any other loader build.
//
// Installing needs a body that may rewrite the 8 KB sector at 0x4000 those
// words live in: the installer variant of the resident body (blBlob.
// installer, stamp flags bit 2), put on the DME first by a Fast Flash
// Program. The install then runs on that body, as tools/bl_test.py's
// installer proved it on the emulator, with two differences on purpose:
//
//   - the boot content written back is the DME's OWN, read off it, with the
//     ring spliced in -- the car's loader build differs from the donor's,
//     and the programming log is kept rather than blanked;
//   - MPC block 0 is left alone: the resident flasher's 0x8 hook stays and
//     keeps working beside the ring (the ring's window is first in the boot path, so
//     a held line lands in the ring). No MPC erase, no CMF exposure.
//
// The order keeps the DME bootable as long as possible: the ring goes in
// first, inert (nothing jumps to it while both words are stock), and the
// two words are written last. Committed windows: between each ERASE and
// its VERIFY (the 96 KB sector holds the loader, the 8 KB one its handoff);
// a cut there needs a BDM / boot-mode rig, as the AIF rewrite does.
/* exported bl */

const BL_BOOT = 0x8000;
const BL_BOOT_LEN = 0x18000; // [0x8000, 0x20000)
const BL_SECT8K = 0x4000;
const BL_SECT8K_LEN = 0x2000;
const BL_CHUNK = 0x1000;
const BL_MAGIC = 'MS45BL';
/** The installer body's stamp flag: its window opens at 0x4000. */
const BL_INSTALLER_FLAG = 0x04;
/** The resident body's stamp flag for the LATE gate (~2 s of polls): it is
 * entered by a line held after the ring's window (blBlob.lateInstaller). */
const BL_LATE_FLAG = 0x20;
/** The late gate's off switch (ms45-emu flasher_gate.LATE_OFF_AT): a blank
 * word past the program's CRC and signature. Written to zero once the
 * bootloader is on, the gate goes straight to the program at every key-on;
 * a program flash erases it with its sector. Stamp flag bit 6 says the gate
 * reads it (the first late gates did not). */
const BL_LATE_OFF_AT = 0xfffe0;
const BL_LATE_OFF_LEN = 8; // CHUNK lengths go in 8s; the gate reads the first word
const BL_LATE_OFF_FLAG = 0x40;
/** Ext offsets the ring's two variants cover between them. */
const BL_RING_SPAN_END = 0x1f700;
/** The two sectors below the boot sector that the boot block's CRC also
 * covers: [0x0, 0x4000) and [0x6000, 0x8000). Read, never written. */
const BL_LOW = 0x0;
const BL_LOW_LEN = 0x4000;
const BL_MID = 0x6000;
const BL_MID_LEN = 0x2000;
/** The boot block's CRC word ("ROM test level 1"). The PROGRAM's background
 * checksum task walks ext [start, end] -- the words at 0x1F808 and 0x1F80C,
 * 0x0-0x1EFFF on both loader builds -- seeded from 0x1F9F0, and compares
 * with the word here every ~5 s; a mismatch is self-check code 11 and the
 * DME resets itself at every walk (fault 28B2 "reason 11"). The ring and
 * both patched words lie inside, so every boot sector written here carries
 * the word recomputed over the DME's own boot region (blWithBootCrc) --
 * the car's reset loop of 2026-10-28 was a ring with the stock word left. */
const BL_BOOT_CRC_AT = 0x1f800;

const blWire =
  typeof fastFlashWire !== 'undefined'
    ? fastFlashWire
    : require('./fast-flasher-wire.js').fastFlashWire;
const blData =
  typeof blBlob !== 'undefined'
    ? blBlob
    : require('../generated/bl-blob.js').blBlob;
const BL_RING_LEN = BL_RING_SPAN_END - blData.ring.at;
const blBytes =
  typeof bytes !== 'undefined' ? bytes : require('../bytes/index.mjs');

/** The ring's bytes, from `blBlob.ring.at`. @returns {Uint8Array} */
function blRing() {
  return blBytes.hexToBytes(blData.ring.hex.join(''));
}

/** The installer ring's bytes, from the same address. @returns {Uint8Array} */
function blInstallerRing() {
  return blBytes.hexToBytes(blData.installerRing.hex.join(''));
}

/** The loader-swap ring's bytes (write window from ext 0x0). @returns {Uint8Array} */
function blSwapRing() {
  return blBytes.hexToBytes(blData.swapRing.hex.join(''));
}

/** The swap ring's stamp flag (bl.SWAP_FLAG). */
const BL_SWAP_FLAG = blData.swapRing ? blData.swapRing.flag : 0x80;

const _blSame = (a, b) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Where a boot region's loader places the park call -- the lis+addi pair
 * that builds the park function's address, looked for anywhere in the first
 * 16 KB (0x3828 on the 2003-on builds, 0x377C on the early 2002-03 one, and
 * wherever a build not yet seen puts it) -- or -1 when it parks some other
 * way. @param {Uint8Array} low - At least the first 16 KB, from ext 0x0. */
function _blGuardSiteIn(low) {
  const g = blData.guard;
  const end = Math.min(low.length, BL_LOW_LEN) - 8;
  for (let at = 0; at <= end; at += 4)
    if (
      blBytes.be32(low, at) === g.words[0] &&
      blBytes.be32(low, at + 4) === g.words[1]
    )
      return at;
  return -1;
}

/** Whether 8 bytes read at a site are the park call the ring is built for. */
function _blGuardOk(guard) {
  const g = blData.guard;
  return (
    !!guard &&
    guard.length >= 8 &&
    blBytes.be32(guard, 0) === g.words[0] &&
    blBytes.be32(guard, 4) === g.words[1]
  );
}

/** The park call off the DME: the 8 bytes at the site the loader's first
 * 16 KB holds it, or null when it parks some other way. */
async function _blReadGuard(client) {
  const low = await blWire.readArea(client, BL_LOW, BL_LOW_LEN);
  const at = _blGuardSiteIn(low);
  return at < 0 ? null : low.subarray(at, at + 8);
}

const _blGuardError = () =>
  new Error(
    'bl: no park call in the first 16 KB of this loader: a build the bootloader cannot hook. Nothing was written.'
  );

/**
 * The boot block's CRC over the four areas as they would stand, following
 * the table the boot sector itself carries (see BL_BOOT_CRC_AT).
 * @param {Uint8Array} low - [0x0, 0x4000) as read off the DME.
 * @param {Uint8Array} sect8k - [0x4000, 0x6000), as it will be written.
 * @param {Uint8Array} mid - [0x6000, 0x8000) as read off the DME.
 * @param {Uint8Array} boot - [0x8000, 0x20000), as it will be written.
 * @returns {number|null} Unsigned; null when the table is blank (no check).
 */
function blBootCrc(low, sect8k, mid, boot) {
  if (
    low.length !== BL_LOW_LEN ||
    sect8k.length !== BL_SECT8K_LEN ||
    mid.length !== BL_MID_LEN ||
    boot.length !== BL_BOOT_LEN
  )
    throw new Error('bl: a boot region read is the wrong size');
  const at = BL_BOOT_CRC_AT - BL_BOOT;
  const start = blBytes.be32(boot, at + 8);
  const end = blBytes.be32(boot, at + 12);
  const init = blBytes.be32(boot, at + 0x1f0);
  if (start === 0xffffffff) return null;
  const lo = start & 0xfffff;
  const hi = end & 0xfffff;
  if (start >>> 20 !== 0xfff || lo !== 0 || hi >= BL_BOOT_CRC_AT)
    throw new Error(
      `bl: the boot CRC table names ext 0x${start.toString(16)}-0x${end.toString(16)}, not a range this install can sum. Nothing was written.`
    );
  const all = new Uint8Array(BL_BOOT + BL_BOOT_LEN);
  all.set(low, BL_LOW);
  all.set(sect8k, BL_SECT8K);
  all.set(mid, BL_MID);
  all.set(boot, BL_BOOT);
  return blBytes.crc32Mpeg2(all.subarray(lo, hi + 1), init);
}

/**
 * The boot sector with its CRC word brought up to date for the region as
 * the four areas describe it. Every sector written by this file goes
 * through here; a region whose word is stale with nothing else to change
 * is still a rewrite (that is how a DME left looping by an older build is
 * mended: Install again).
 * @param {Uint8Array} low @param {Uint8Array} sect8k @param {Uint8Array} mid
 * @param {Uint8Array} boot
 * @returns {Uint8Array} A copy of `boot`.
 */
function blWithBootCrc(low, sect8k, mid, boot) {
  const crc = blBootCrc(low, sect8k, mid, boot);
  const nb = Uint8Array.from(boot);
  if (crc !== null) blBytes.putBe32(nb, BL_BOOT_CRC_AT - BL_BOOT, crc);
  return nb;
}

/**
 * The DME's boot region with the ring in it. Refuses unless the park call
 * is the one the ring was built against, both patched words are stock (or
 * already ours) and every byte the ring covers is blank (or already the
 * ring): anything else is not a boot region this ring was built for, and
 * nothing is written.
 * @param {Uint8Array} boot - [0x8000, 0x20000) as read off the DME.
 * @param {Uint8Array} sect8k - [0x4000, 0x6000) as read off the DME.
 * @param {Uint8Array} guard - The 8 bytes at blBlob.guard.at, read off it.
 * @returns {{boot: Uint8Array, sect8k: Uint8Array, bootChanged: boolean,
 *   sect8kChanged: boolean}}
 * @param {boolean} [force] - Overwrite a span that is neither blank nor a ring of ours (Repair).
 */
function blSplice(boot, sect8k, guard, force = false) {
  if (boot.length !== BL_BOOT_LEN || sect8k.length !== BL_SECT8K_LEN)
    throw new Error('bl: the boot region read is the wrong size');
  if (!_blGuardOk(guard)) throw _blGuardError();
  const ring = blRing();
  const at = blData.ring.at - BL_BOOT;
  // the span is blank (a stock loader) or holds a ring of ours of any
  // version or variant (the survey knows it by its stamp): both are
  // replaced by this build's ring. Anything else is not a boot sector the
  // ring was built for -- unless forced (Repair): the span belongs to the
  // ring and nothing else, so a torn or foreign one is overwritten too.
  if (!force && !blSurvey(boot, sect8k).ring)
    throw new Error(
      `bl: ext 0x${blData.ring.at.toString(16)} holds neither a blank span nor a ring BMWeb put there (not a boot sector the bootloader was built for). Nothing was written.`
    );
  for (const p of blData.patches) {
    const word = blBytes.be32(sect8k, p.at - BL_SECT8K);
    if (word !== p.stock && word !== p.word)
      throw new Error(
        `bl: the loader's word at ext 0x${p.at.toString(16)} reads 0x${word.toString(16)}, not the stock 0x${p.stock.toString(16)}. Nothing was written.`
      );
  }
  const nb = Uint8Array.from(boot);
  nb.fill(0xff, at, at + BL_RING_LEN);
  nb.set(ring, at);
  const ns = Uint8Array.from(sect8k);
  for (const p of blData.patches) blBytes.putBe32(ns, p.at - BL_SECT8K, p.word);
  const same = (a, b) => a.every((x, i) => x === b[i]);
  return {
    boot: nb,
    sect8k: ns,
    bootChanged: !same(nb, boot),
    sect8kChanged: !same(ns, sect8k),
  };
}

/**
 * Which ring the boot region carries, and where its two words stand.
 * @param {Uint8Array} boot - [0x8000, 0x20000) as read off the DME.
 * @param {Uint8Array} sect8k - [0x4000, 0x6000) as read off the DME.
 * @returns {{ring: 'blank'|'ring'|'installer'|'older'|null,
 *   words: 'stock'|'patched'|null,
 *   stamp: {version: number, flags: number}|null}} ring null: neither,
 *   not a region we built; 'older': a ring BMWeb put on from an earlier
 *   build (its stamp names this ring's windows, its bytes are not these),
 *   with `stamp` read from it
 */
function blSurvey(boot, sect8k) {
  if (boot.length !== BL_BOOT_LEN || sect8k.length !== BL_SECT8K_LEN)
    throw new Error('bl: the boot region read is the wrong size');
  const at = blData.ring.at - BL_BOOT;
  const span = (r) => {
    const out = new Uint8Array(BL_RING_LEN).fill(0xff);
    out.set(r, 0);
    return out;
  };
  const have = boot.subarray(at, at + BL_RING_LEN);
  const same = (r) => have.every((x, i) => x === r[i]);
  const stampAt = blData.ring.stampAt - BL_BOOT;
  const st = boot.subarray(stampAt, stampAt + 16);
  const mine = blBytes.hexToBytes(blData.ring.stamp);
  // the same magic and the same two window addresses: a ring of ours,
  // whatever its version and flags
  const stamped =
    String.fromCharCode(...st.subarray(0, 6)) === BL_MAGIC &&
    st.subarray(8, 16).every((x, i) => x === mine[8 + i]);
  const stamp = stamped ? { version: st[6], flags: st[7] } : null;
  const ring = have.every((x) => x === 0xff)
    ? 'blank'
    : same(span(blRing()))
      ? 'ring'
      : same(span(blInstallerRing()))
        ? 'installer'
        : blData.swapRing && same(span(blSwapRing()))
          ? 'swap'
          : stamped
            ? 'older'
            : null;
  const words = blData.patches.map((p) =>
    blBytes.be32(sect8k, p.at - BL_SECT8K)
  );
  const all = (k) => words.every((w, i) => w === blData.patches[i][k]);
  return {
    ring,
    words: all('stock') ? 'stock' : all('word') ? 'patched' : null,
    stamp,
  };
}

/**
 * Whether a bootloader stamp is this build's or newer: its version, and
 * every feature flag this build's ring sets (the EEPROM read window came
 * in as a flag on a version already out, so the version alone cannot tell
 * the two apart).
 * @param {{version: number, flags: number}|null|undefined} have
 * @returns {boolean}
 */
/** Whether a ring stamp is this build's plain ring, byte for byte in what
 * the stamp tells: the version and the flags. Anything else -- an older
 * ring, an installer or swap variant left on, a newer build -- is put
 * right by the same one operation (bl.put). No version arithmetic. */
function blIsCurrent(have) {
  return !!(
    have &&
    have.version === BL_BODY_VERSION &&
    have.flags === BL_RING_FLAGS
  );
}
/** Whether a ring stamp is this build's, in any variant (the installer or
 * swap ring too): what the restore and the bench tools need. */
function blIsOurs(have) {
  return !!(have && have.version === BL_BODY_VERSION);
}

/**
 * Restore, session 1's boot sector: BL's ring swapped for the installer
 * ring. Refuses a region that is not BL as BMWeb installs it.
 * @param {Uint8Array} boot @param {Uint8Array} sect8k - As read off the DME.
 * @returns {Uint8Array|null} The new boot sector; null when it already
 *   carries the installer ring.
 */
function blInstallerImage(boot, sect8k) {
  const v = blSurvey(boot, sect8k);
  if (
    v.words !== 'patched' ||
    (v.ring !== 'ring' && v.ring !== 'installer' && v.ring !== 'swap')
  )
    throw new Error(
      `bl: the boot region is not BL as BMWeb installs it (ring ${v.ring || 'unknown'}, words ${v.words || 'unknown'}). Nothing was written.`
    );
  // the swap ring's window covers the installer's: it serves the restore too
  if (v.ring === 'installer' || v.ring === 'swap') return null;
  const nb = Uint8Array.from(boot);
  const at = blData.ring.at - BL_BOOT;
  nb.fill(0xff, at, at + BL_RING_LEN);
  nb.set(blInstallerRing(), at);
  return nb;
}

/**
 * Restore, session 2's sectors: both words stock, the ring blanked.
 * Refuses a region that is not the installer ring's (or a restore of it
 * cut between the two sectors).
 * @param {Uint8Array} boot @param {Uint8Array} sect8k - As read off the DME.
 * @returns {{boot: Uint8Array, sect8k: Uint8Array, bootChanged: boolean,
 *   sect8kChanged: boolean}}
 */
function blRestoreImages(boot, sect8k) {
  const v = blSurvey(boot, sect8k);
  if (!v.words || !v.ring || v.ring === 'ring')
    throw new Error(
      `bl: the boot region is not the installer ring as BMWeb puts it on (ring ${v.ring || 'unknown'}, words ${v.words || 'unknown'}). Nothing was written.`
    );
  const ns = Uint8Array.from(sect8k);
  for (const p of blData.patches)
    blBytes.putBe32(ns, p.at - BL_SECT8K, p.stock);
  const nb = Uint8Array.from(boot);
  const at = blData.ring.at - BL_BOOT;
  nb.fill(0xff, at, at + BL_RING_LEN);
  return {
    boot: nb,
    sect8k: ns,
    bootChanged: v.ring !== 'blank',
    sect8kChanged: v.words !== 'stock',
  };
}

/**
 * Erase one sector, check it blank, write it back 4 KB at a time and
 * verify the whole of it.
 */
async function _blRewrite(client, base, data, cb, pct0, pct1, what) {
  const crc = blWire.crc32;
  cb.stage(`Erasing ${what}`);
  await client.erase(base);
  const blank = crc(new Uint8Array(data.length).fill(0xff)) >>> 0;
  if ((await client.sectorQuery(base, data.length)) >>> 0 !== blank)
    throw new Error(
      `${what} did not read blank after ERASE (hardware-protected?)`
    );
  cb.stage(`Writing ${what}`);
  const n = data.length / BL_CHUNK;
  for (let i = 0; i < n; i++) {
    await client.chunk(
      base + i * BL_CHUNK,
      data.subarray(i * BL_CHUNK, (i + 1) * BL_CHUNK)
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
/**
 * The one write that puts this build's bootloader on a DME, whatever is
 * there: a stock boot region (through the installer body), a ring of ours
 * of any version or variant (through that ring itself), or this build's
 * ring with a stale boot CRC word. The DME's own boot region is read, the
 * ring laid over the span, the two words patched if still stock, the CRC
 * word recomputed; then the 96 KB sector is rewritten if it changed, and
 * the 8 KB sector if the words did (only a body with that window -- the
 * installer -- is ever asked, since a ring implies the words are patched).
 * @param {object} client - The fast flasher wire client.
 * @param {{stage: (s: string) => void, progress: (pct: number) => void,
 *   note: (s: string) => void}} cb
 * @returns {Promise<{skipped: boolean, summary: string}>}
 * @param {boolean} [force] - Overwrite whatever the ring span holds (Repair).
 */
async function blPut(client, cb, force = false) {
  cb.stage('Reading the boot region off the DME');
  const guard = await _blReadGuard(client);
  if (!_blGuardOk(guard)) throw _blGuardError();
  const { low, sect8k, mid, boot } = await _blReadRegion(client, cb);
  const was = blSurvey(boot, sect8k);
  const s = blSplice(boot, sect8k, guard, force);
  const nb = blWithBootCrc(low, s.sect8k, mid, s.boot);
  const bootChanged = s.bootChanged || !_blSame(nb, boot);
  if (!bootChanged && !s.sect8kChanged) {
    cb.note('this build of the bootloader is on the DME: nothing written');
    return { skipped: true, summary: 'the bootloader was already current' };
  }
  cb.note(
    `put: ${
      was.stamp
        ? 'the old ring goes, the current one comes in'
        : was.ring
          ? 'ring goes in'
          : 'the span held unknown bytes: the ring goes over them'
    }, handoff + park words ${s.sect8kChanged ? 'go in' : 'already patched'}${bootChanged && !s.bootChanged ? ', boot CRC word brought up to date' : ''}`
  );
  await aifLadderArm(client, cb.note);
  if (bootChanged)
    await _blRewrite(
      client,
      BL_BOOT,
      nb,
      cb,
      20,
      85,
      'the boot sector (the ring)'
    );
  if (s.sect8kChanged)
    await _blRewrite(
      client,
      BL_SECT8K,
      s.sect8k,
      cb,
      85,
      95,
      'the 8 KB sector (the handoff and park words)'
    );
  await aifLadderDone(client);
  const st = await _blStamp(client);
  if (st.magic !== BL_MAGIC || !blIsCurrent(st))
    throw new Error(
      `the stamp reads "${st.magic}" (not the current ring) after the write`
    );
  cb.progress(100);
  return {
    skipped: false,
    summary: 'the current bootloader is on the DME, programming log kept',
  };
}

/**
 * Switch the late installer off once the bootloader is on: zeros over its
 * blank off-switch word (no erase -- the CHUNK programs and reads back), so
 * the DME starts its program at every key-on instead of listening ~2 s.
 * Only on a session in a late installer whose gate reads the switch; any
 * other session is left alone.
 * @param {FastFlashClient} client
 * @param {{note: (s: string) => void}} cb
 * @returns {Promise<boolean>} Whether the switch was written.
 */
async function blLateOff(client, cb) {
  const st = await client.hello();
  const flags = st[7];
  if (!(flags & BL_INSTALLER_FLAG && flags & BL_LATE_FLAG)) return false;
  if (!(flags & BL_LATE_OFF_FLAG)) {
    cb.note(
      'this installer has no off switch: it stays in the program until the next program flash'
    );
    return false;
  }
  await client.chunk(BL_LATE_OFF_AT, new Uint8Array(BL_LATE_OFF_LEN));
  cb.note(
    'installer switched off: the DME starts its program straight away at every key-on'
  );
  return true;
}

/**
 * Burn a new DME ISN into the flash triple at ext 0x1FB00, through the
 * boot-sector ladder this file already uses (ARM -> ERASE -> CHUNK ->
 * VERIFY -> DONE). BENCH ONLY. The read-back is the boot sector re-read and
 * the ISN voted from it, so a wrong write shows as a mismatch, not a
 * silent pass. A DME already on that ISN is left as it is.
 *
 * This writes ONLY the six ISN bytes (plus the boot CRC word, which is
 * recomputed for hygiene though 0x1FB00 lies outside its range); the ring,
 * the handoff words, the program and the log are untouched.
 * @param {FastFlashClient} client - A session on the fast flash bootloader.
 * @param {number} isn - 0x0000..0xFFFF, the ISN to write.
 * @param {{stage: (s: string) => void, progress: (pct: number) => void,
 *   note: (s: string) => void}} cb
 * @returns {Promise<{skipped: boolean, was: number|null, summary: string}>}
 */
async function blBurnIsn(client, isn, cb) {
  const isnFlashMod =
    typeof isnFlash !== 'undefined'
      ? isnFlash
      : require('./isn-flash.js').isnFlash;
  const { low, sect8k, mid, boot } = await _blReadRegion(client, cb);
  const s = isnFlashMod.spliceBoot(low, sect8k, mid, boot, isn);
  const text = (v) => (v === null ? '??' : isnFlashMod.text(v));
  if (!s.changed) {
    cb.note(`the DME already holds ISN ${text(isn)}: nothing written`);
    return {
      skipped: true,
      was: s.was,
      summary: `the DME already held ISN ${text(isn)}`,
    };
  }
  cb.note(`ISN ${text(s.was)} -> ${text(isn)} (flash 0x1FB00)`);
  await aifLadderArm(client, cb.note);
  await _blRewrite(
    client,
    BL_BOOT,
    s.boot,
    cb,
    20,
    95,
    `the boot sector (ISN ${text(isn)})`
  );
  await aifLadderDone(client);
  // read the six bytes back and vote them: the write is only good if the
  // DME would now read the ISN we wrote
  const back = await client.read(isnFlashMod.AT, isnFlashMod.LEN);
  const got = isnFlashMod.fromTriple(back);
  if (got !== isn)
    throw new Error(
      `ISN read-back is ${text(got)} (${Array.from(back)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')}), not ${text(isn)}`
    );
  cb.progress(100);
  return {
    skipped: false,
    was: s.was,
    summary: `ISN written: ${text(s.was)} -> ${text(isn)}`,
  };
}

/**
 * Virginize the DME: blank the ISN triple at ext 0x1FB00 to 0xFF, through
 * the same boot-sector ladder. The DME then reads a blank ISN (0xFFFF).
 * NB the EWS does NOT write the flash triple back during a sync (car, 2026-
 * 10-28): pairing is burnIsn with the car's ISN + the sync; this is a bench
 * tool. BENCH ONLY. A DME already blank is left as it is.
 * @param {FastFlashClient} client - A session on the fast flash bootloader.
 * @param {{stage: (s: string) => void, progress: (pct: number) => void,
 *   note: (s: string) => void}} cb
 * @returns {Promise<{skipped: boolean, was: number|null, summary: string}>}
 */
async function blVirginize(client, cb) {
  const isnFlashMod =
    typeof isnFlash !== 'undefined'
      ? isnFlash
      : require('./isn-flash.js').isnFlash;
  const text = (v) => (v === null ? 'blank' : isnFlashMod.text(v));
  const { low, sect8k, mid, boot } = await _blReadRegion(client, cb);
  const s = isnFlashMod.blankBoot(low, sect8k, mid, boot);
  if (!s.changed) {
    cb.note('the DME ISN is already blank: nothing written');
    return {
      skipped: true,
      was: s.was,
      summary: 'the DME ISN was already blank',
    };
  }
  cb.note(`ISN ${text(s.was)} -> blank (flash 0x1FB00 wiped to FF)`);
  await aifLadderArm(client, cb.note);
  await _blRewrite(
    client,
    BL_BOOT,
    s.boot,
    cb,
    20,
    95,
    'the boot sector (ISN blanked)'
  );
  await aifLadderDone(client);
  const back = await client.read(isnFlashMod.AT, isnFlashMod.LEN);
  if (!Array.from(back).every((b) => b === 0xff))
    throw new Error(
      `the ISN did not read blank after the wipe (${Array.from(back)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')})`
    );
  cb.progress(100);
  return {
    skipped: false,
    was: s.was,
    summary: `ISN virginized (was ${text(s.was)})`,
  };
}

/** Read the boot region off the DME (20% of the bar): the 8 KB and 96 KB
 * sectors that get written, and the two below them that the boot block's
 * CRC covers as well. */
async function _blReadRegion(client, cb) {
  cb.stage('Reading the boot region off the DME');
  const low = await blWire.readArea(client, BL_LOW, BL_LOW_LEN);
  const sect8k = await blWire.readArea(client, BL_SECT8K, BL_SECT8K_LEN);
  const mid = await blWire.readArea(client, BL_MID, BL_MID_LEN);
  const boot = await blWire.readArea(client, BL_BOOT, BL_BOOT_LEN, (n) =>
    cb.progress(Math.floor((n * 20) / BL_BOOT_LEN))
  );
  return { low, sect8k, mid, boot };
}

/** The stamp's first 8 bytes where the ring keeps it. */
async function _blStamp(client) {
  const st = await client.read(blData.ring.stampAt, 16);
  return {
    magic: String.fromCharCode(...st.subarray(0, 6)),
    version: st[6],
    flags: st[7],
  };
}

/**
 * Restore, session 1, on BL: swap the ring for its installer variant
 * (one 96 KB rewrite; the windows stay where the patched words point). A
 * DME already carrying the installer ring is left as it is.
 * @param {FastFlashClient} client - A session on BL's ring.
 * @param {{stage: (s: string) => void, progress: (pct: number) => void,
 *   note: (s: string) => void}} cb
 * @returns {Promise<{skipped: boolean, summary: string}>}
 */
async function blToInstaller(client, cb) {
  const { low, sect8k, mid, boot } = await _blReadRegion(client, cb);
  const img = blInstallerImage(boot, sect8k);
  const nb = blWithBootCrc(low, sect8k, mid, img || boot);
  if (!img && _blSame(nb, boot)) {
    cb.note('the installer ring is already on the DME: nothing written');
    return { skipped: true, summary: 'the installer ring was already on' };
  }
  if (!img)
    cb.note('the installer ring is on already; its boot CRC word was stale');
  await aifLadderArm(client, cb.note);
  await _blRewrite(
    client,
    BL_BOOT,
    nb,
    cb,
    20,
    95,
    'the boot sector (the installer ring)'
  );
  await aifLadderDone(client);
  const st = await _blStamp(client);
  if (st.magic !== BL_MAGIC || !(st.flags & BL_INSTALLER_FLAG))
    throw new Error(
      `the stamp reads "${st.magic}" flags 0x${st.flags.toString(16)} after the swap`
    );
  cb.progress(100);
  return { skipped: false, summary: 'installer ring in, programming log kept' };
}

/**
 * Restore, session 2, on the installer ring: both words back to stock
 * (the 8 KB sector, first: the DME boots stock from here on), then the
 * ring blanked out of the 96 KB sector. Picks up a run cut between the two.
 * @param {FastFlashClient} client - A session on the installer ring.
 * @param {{stage: (s: string) => void, progress: (pct: number) => void,
 *   note: (s: string) => void}} cb
 * @returns {Promise<{skipped: boolean, summary: string}>}
 */
async function blRestore(client, cb) {
  const { low, sect8k, mid, boot } = await _blReadRegion(client, cb);
  const r = blRestoreImages(boot, sect8k);
  r.boot = blWithBootCrc(low, r.sect8k, mid, r.boot);
  r.bootChanged = r.bootChanged || !_blSame(r.boot, boot);
  if (!r.sect8kChanged && !r.bootChanged) {
    cb.note('the boot region is already stock: nothing written');
    return { skipped: true, summary: 'the boot region was already stock' };
  }
  await aifLadderArm(client, cb.note);
  if (r.sect8kChanged)
    await _blRewrite(
      client,
      BL_SECT8K,
      r.sect8k,
      cb,
      20,
      30,
      'the 8 KB sector (the stock handoff and park words)'
    );
  if (r.bootChanged)
    await _blRewrite(
      client,
      BL_BOOT,
      r.boot,
      cb,
      30,
      95,
      'the boot sector (the ring blanked)'
    );
  await aifLadderDone(client);
  const st = await _blStamp(client);
  if (st.magic === BL_MAGIC)
    throw new Error('the stamp still reads MS45BL after the restore');
  cb.progress(100);
  return {
    skipped: false,
    summary: 'stock bootloader restored, programming log kept',
  };
}

/**
 * Update, one session on an older BL: the park call checked against this
 * ring's build, both sectors read, this build's ring in place of the old one
 * (one 96 KB rewrite; the windows stay where the patched words point), the
 * stamp read back current. A DME already carrying this build's ring is left
 * as it is.
 * @param {FastFlashClient} client - A session on the old ring.
 * @param {{stage: (s: string) => void, progress: (pct: number) => void,
 *   note: (s: string) => void}} cb
 * @returns {Promise<{skipped: boolean, summary: string}>}
 */

/** This build's body version, from the blob's installer stamp. */
const BL_BODY_VERSION = parseInt(blData.installer.stamp.slice(12, 14), 16);
/** This build's ring stamp flags, and the feature bits among them (the
 * installer bit is a variant, not a feature). */
const BL_RING_FLAGS = parseInt(blData.ring.stamp.slice(14, 16), 16);

/** The loader's CMF driver as the body finds it: the data start S of the
 * three known builds (A, B, C), the signature at S+4, code at S+0x7C, the
 * wrappers (erase_job +0x148, program_job +0x21C) and the window the body
 * copies (+0x400 for 0x1800). ms45-emu tools/build/flasher_body.py. */
const BL_DRV_SITES = [0x14b04, 0x14b28, 0x14cdc];
const BL_DRV_SIG = [0x002fc800, 0x002fc840, 0x284f0000];
const BL_DRV_CODE = 0x7c;
const BL_DRV_ERASE = 0x148;
const BL_DRV_PROGRAM = 0x21c;
const BL_DRV_FLOOR = 0x400;
const BL_DRV_WINDOW = 0x1800;

/**
 * The targets of the first `count` FORWARD `bl`s of a routine, as the body's
 * drv_fwd takes them (a backward call is the watchdog stub): offsets into
 * `code`, which starts at the driver's code start.
 * @param {Uint8Array} code @param {number} from - The routine's offset.
 * @returns {number[]} Fewer than `count` when the routine is not shaped so.
 */
function blForwardCalls(code, from, count = 5) {
  const out = [];
  for (let at = from; at < from + 0x300 && at + 4 <= code.length; at += 4) {
    const w = blBytes.be32(code, at);
    if ((w & 0xfc000003) >>> 0 !== 0x48000001) continue;
    if (w & 0x02000000) continue;
    out.push(at + (w & 0x03fffffc));
    if (out.length === count) break;
  }
  return out;
}

/**
 * Whether the body could drive this loader's CMF driver: the five entries
 * its wrappers name (init, finish, start, step from program_job; the erase
 * start from erase_job) all lie in the copied window and begin with the
 * driver's `stwu r1` prologue -- exactly the body's own check.
 * @param {Uint8Array} code - The driver's code, from its code start, at
 *   least 0x1C00 bytes (or as far as the read went).
 * @returns {{ok: boolean, entries: Object<string, number>, why: string|null}}
 */
function blDriverEntries(code) {
  const prog = blForwardCalls(code, BL_DRV_PROGRAM);
  const erase = blForwardCalls(code, BL_DRV_ERASE);
  if (prog.length < 5 || erase.length < 5)
    return {
      ok: false,
      entries: {},
      why: 'the driver wrappers are not shaped as the body expects',
    };
  const entries = {
    init: prog[0],
    finish: prog[1],
    start: prog[2],
    step: prog[4],
    startmask: erase[2],
  };
  for (const [name, off] of Object.entries(entries)) {
    if (off < BL_DRV_FLOOR || off >= BL_DRV_FLOOR + BL_DRV_WINDOW)
      return {
        ok: false,
        entries,
        why: `${name} at +0x${off.toString(16)} lies outside the body's driver window`,
      };
    if (off + 2 > code.length || ((code[off] << 8) | code[off + 1]) !== 0x9421)
      return {
        ok: false,
        entries,
        why: `${name} at +0x${off.toString(16)} does not begin with the driver's prologue`,
      };
  }
  return { ok: true, entries, why: null };
}

/**
 * What Identify learned about the boot region, judged: whether the
 * bootloader as it stands will boot the car, take a flash and write the
 * MPC, and what to do if not. Pure; the reads are the screen's.
 * @param {{stamp: {version: number, flags: number}|null,
 *   words: {handoff: number, park: number}|null, parkCallAt: number|null,
 *   crcWord: number|null, driver: {found: boolean, ok: boolean, why: string|null}|null,
 *   resetRecord: {count: number, code: number}|null, status: string}} h
 * @returns {{broken: boolean, problems: string[], notes: string[]}}
 */
function blHealth(h) {
  const problems = [];
  const notes = [];
  if (h.stamp) {
    if (blIsCurrent(h.stamp)) notes.push('bootloader current');
    // this build's installer or swap ring: a step of Restore or Update boot
    // sector, not an old bootloader
    else if (blIsOurs(h.stamp))
      notes.push(
        h.stamp.flags & BL_INSTALLER_FLAG ? 'installer ring' : 'swap ring'
      );
    else problems.push('an old bootloader is on the DME');
  }
  if (h.words) {
    const [ho, pk] = blData.patches;
    const hOk = h.words.handoff === ho.word;
    const pOk = h.words.park === pk.word;
    if (hOk && pOk) notes.push('handoff and park words patched');
    else if (h.words.handoff === ho.stock && h.words.park === pk.stock)
      problems.push(
        h.stamp
          ? 'the ring is in but both loader words are still stock: a held line never reaches it'
          : 'loader words stock'
      );
    else if (!hOk || !pOk)
      problems.push(
        `the loader's ${!hOk ? 'handoff' : 'park'} word reads 0x${(!hOk ? h.words.handoff : h.words.park).toString(16)}, neither stock nor the ring's`
      );
  }
  if (h.parkCallAt != null)
    notes.push(`park call at 0x${h.parkCallAt.toString(16)}`);
  else
    problems.push(
      'the park call is at none of the known sites: a loader build the ring was not proven on'
    );
  if (h.crcWord != null) {
    if (h.crcWord === 0xffffffff) problems.push('the boot CRC word is blank');
    else notes.push('boot CRC word present');
  }
  if (h.driver) {
    if (!h.driver.found)
      problems.push(
        'the CMF driver is at none of the known places: MPC writes would be refused'
      );
    else if (!h.driver.ok)
      problems.push(`MPC writes would be refused: ${h.driver.why}`);
    else notes.push('driver entries resolve');
  }
  if (h.resetRecord && h.resetRecord.count && h.resetRecord.code === 11)
    problems.push(
      `the DME has reset itself ${h.resetRecord.count} time(s) on its ROM test (code 11): the boot CRC word is stale, or the program/tune checksum`
    );
  if (h.status && h.status !== 'Normalbetrieb')
    notes.push(`programming status: ${h.status}`);
  return { broken: problems.length > 0, problems, notes };
}

/** One line for the log. */
function blHealthText(r) {
  return r.broken
    ? `Bootloader check: PROBLEM -- ${r.problems.join('; ')}. Install / update the fast flash bootloader puts the boot region right.`
    : 'Bootloader check: OK';
}

const bl = {
  MAGIC: BL_MAGIC,
  /** The swap ring's stamp flag (ms45-emu bl.SWAP_FLAG): its body may
   * rewrite every boot sector. Bench only. */
  SWAP_FLAG: BL_SWAP_FLAG,
  STAMP_AT: blData.ring.stampAt,
  INSTALLER_FLAG: BL_INSTALLER_FLAG,
  /** This build's ring version: what "current" means (bl.isCurrent). */
  BODY_VERSION: BL_BODY_VERSION,
  isCurrent: blIsCurrent,
  isOurs: blIsOurs,
  /** The ring stamp's flag for "installed with the boot CRC word kept"
   * (ms45-emu tools/build/bl.py CRC_FLAG); a ring without it is older. */
  CRC_FLAG: 0x40,
  splice: blSplice,
  survey: blSurvey,
  bootCrc: blBootCrc,
  withBootCrc: blWithBootCrc,
  put: blPut,
  lateOff: blLateOff,
  LATE_OFF_AT: BL_LATE_OFF_AT,
  LATE_OFF_LEN: BL_LATE_OFF_LEN,
  health: blHealth,
  healthText: blHealthText,
  driverEntries: blDriverEntries,
  forwardCalls: blForwardCalls,
  DRV_SITES: BL_DRV_SITES,
  DRV_SIG: BL_DRV_SIG,
  DRV_CODE: BL_DRV_CODE,
  installerImage: blInstallerImage,
  restoreImages: blRestoreImages,
  toInstaller: blToInstaller,
  restore: blRestore,
  burnIsn: blBurnIsn,
  virginize: blVirginize,
  /** Whether identify's detection is the installer body. */
  isInstaller(det) {
    return !!(det && det.version >= 13 && det.flags & BL_INSTALLER_FLAG);
  },
  /** Whether it is the installer behind the late gate (entered by a line held after the reset, not across it). */
  isLateInstaller(det) {
    return !!(bl.isInstaller(det) && det.flags & BL_LATE_FLAG);
  },
  /** Whether that late installer's gate reads its off switch. */
  hasLateOff(det) {
    return !!(bl.isLateInstaller(det) && det.flags & BL_LATE_OFF_FLAG);
  },
  /**
   * The pair with the installer behind the LATE gate spliced in: the way
   * past a ring that takes a held line and cannot serve. Written by the
   * DME's own loader; every boot listens ~2 s at MPC 0x8 until the
   * bootloader write switches it off (bl.lateOff) or the next program flash
   * takes it out (the caller signs). The off switch is blanked: a read of a
   * DME whose installer was switched off carries the zeros.
   * @param {Uint8Array} flash @param {Uint8Array} mpc
   * @returns {{flash: Uint8Array, mpc: Uint8Array}}
   */
  withLateInstaller(flash, mpc) {
    const r = _blCarry(blData.lateInstaller, flash, mpc);
    r.flash.fill(0xff, BL_LATE_OFF_AT, BL_LATE_OFF_AT + BL_LATE_OFF_LEN);
    return r;
  },
};

/** One installer variant spliced into a pair, whichever body it carried. */
function _blCarry(inst, flash, mpc) {
  const f = Uint8Array.from(flash);
  const m = Uint8Array.from(mpc);
  // whichever body the pair carried goes, the installer takes its place
  f.fill(0xff, fastFlasher.BODY_START, fastFlasher.BODY_END);
  for (const [off, hex] of inst.runs) f.set(blBytes.hexToBytes(hex), off);
  blBytes.putBe32(m, inst.hookAt, inst.hookWord);
  return { flash: f, mpc: m };
}

if (typeof window !== 'undefined') window.bl = bl;
if (typeof module !== 'undefined' && module.exports) module.exports = { bl };
