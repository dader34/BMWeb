// The resident fast flasher on a bootstrapped MS45.1: how the app recognises
// it, and the guard every send passes through. The DME side is built by
// ms45-emu tools/flasher_gate.py (spec: docs/fast-flasher.md there).
//
// What a bootstrap leaves on the DME, all of it readable over KWP with the
// ordinary 23 reads identify already makes:
//
//   - MPC 0x8: the reset word the loader jumps through, re-pointed from the
//     stock start (`ba 0xFFF717B4`) to the gate (`ba 0xFFFFD300`). The gate
//     listens ~600 us for a break held across reset; no break, and it hands
//     on to the stock start untouched;
//   - ext 0xFD26C: a 16-byte stamp, "MS45QF" + version + flags + the CPU
//     addresses of the gate and the flasher entry (big-endian words).
//
// Both must agree before anything is sent: the stamp alone (the hook word
// gone after a full MPC rewrite) means the body is on the chip but nothing
// ever reaches it, so the DME answers like a stock one and the app must
// treat it as one. A stock DME is safe to misfire on -- holding the line
// across its reset boots it exactly as a clean boot does (proven in
// ms45-emu tools/gate_test.py) -- but nothing here relies on that.
//
// Payloads travel NRV2B-packed (core/flash/nrv2b.js) in 4 KB stop-and-wait
// chunks; the flasher unpacks each and programs it.
/* exported fastFlasher */

const ffBytes =
  typeof bytes !== 'undefined' ? bytes : require('../bytes/index.mjs');

const FAST_FLASHER_STAMP_AT = 0xfd26c; // ext offset, the body's head
const FAST_FLASHER_STAMP_LENGTH = 16;
const FAST_FLASHER_MAGIC = 'MS45QF';
const FAST_FLASHER_HOOK_AT = 0x8; // MPC, the loader's reset word
const FAST_FLASHER_STOCK_HOOK = 0x4bf717b6; // `ba 0xFFF717B4`
const FAST_FLASHER_EXT_CPU = 0xfff00000; // where the external chip is mapped
const FAST_FLASHER_VERSION = 18; // the highest stamp version this app speaks
/**
 * The oldest body used as it stands: v13 is the first with a READ that
 * reads the right bytes, and the one proven on the car. Anything older is
 * reinstalled before it is used (v14 added the EEPROM read window and v15
 * the EEPROM write service -- the ISN screen asks for those by their
 * stamp flags, not here).
 */
const FAST_FLASHER_CURRENT_FROM = 13;
/**
 * The first body with READ: raw bytes of the chip or the MPC, 4 KB a
 * request, each block with its CRC (Fast Read). A v12 build carried a READ
 * that read from the wrong address, so it is never asked.
 */
const FAST_FLASHER_READS_FROM = 13;
/**
 * The first body that carries the AIF wipe (stamp flag bit 1): the boot
 * sector window, shut to writes until the wipe arms a marker slot. v10 and
 * v11 were bench-only bodies with it; they are older, and upgradable.
 */
const FAST_FLASHER_AIFWIPE_FROM = 12;
const FAST_FLASHER_FLAG_BOOT_WINDOW = 0x02;
/**
 * The first body whose MPC (internal flash) writes go through the boot
 * loader's own CMF driver. v2-v6 carried a hand-written sequence that read
 * the array mid-pulse; on the car (2026-10-21) its first MPC ERASE reset the
 * DME. Only a body from here on is asked to write the MPC -- and it is the
 * body already on the DME that does the writing, so an upgrade push to v7
 * itself stays external-only.
 */
const FAST_FLASHER_MPC_WRITES_FROM = 7;
/**
 * The first body with the v8 services: CHUNK_SET (pagesets -- one page in
 * each of up to fourteen MPC blocks per pulse sequence), ERASE with a block
 * mask, SET_BAUD (a faster line, with the body's own fallback to 115200)
 * and the table CRC. Older bodies get the sequential push at 115200.
 */
const FAST_FLASHER_PAGESETS_FROM = 8;
/**
 * The first body whose SET_BAUD is safe on a one-way line: it holds a new
 * rate only once the tester confirms (a SET_BAUD naming that rate) that it
 * HEARD an answer there, else falls back to 115200 by itself. v8 held any
 * rate it could read telegrams at, and a rate the cable drove into the DME
 * but whose answers came back garbled stranded the car (2026-10-21).
 */
const FAST_FLASHER_LINE_FROM = 9;
/**
 * The oldest body a Fast Flash Program may run on to replace itself: v5 is
 * the first that works on a real cable (the link pauses after each reply for
 * its echo drain); v3/v4 never got past HELLO on the car.
 */
const FAST_FLASHER_UPGRADE_FROM = 5;
/** Stamp flags bit 0: the body can write the MPC (internal flash) too -- v2. */
const FAST_FLASHER_FLAG_MPC = 0x01;
const FAST_FLASHER_CHUNK = 0x1000; // bytes per stop-and-wait chunk, unpacked

/**
 * The absolute `ba` PPC assembles at MPC 0x8 for a target (AA set).
 * @param {number} target - CPU address.
 * @returns {number}
 */
function _fastFlasherBranch(target) {
  return (0x48000002 | (target & 0x03fffffc)) >>> 0;
}

const fastFlasher = {
  STAMP_AT: FAST_FLASHER_STAMP_AT,
  STAMP_LENGTH: FAST_FLASHER_STAMP_LENGTH,
  HOOK_AT: FAST_FLASHER_HOOK_AT,
  STOCK_HOOK: FAST_FLASHER_STOCK_HOOK,
  VERSION: FAST_FLASHER_VERSION,
  MPC_WRITES_FROM: FAST_FLASHER_MPC_WRITES_FROM,
  PAGESETS_FROM: FAST_FLASHER_PAGESETS_FROM,
  LINE_FROM: FAST_FLASHER_LINE_FROM,
  READS_FROM: FAST_FLASHER_READS_FROM,
  CHUNK: FAST_FLASHER_CHUNK,

  /**
   * Interpret the two reads: the 4 bytes at MPC 0x8 and the 16-byte stamp at
   * ext 0xFD26C. Returns null when there is no stamp at all (a stock or
   * never-bootstrapped DME); otherwise what the stamp says and whether the
   * hook still leads to the gate it names.
   * @param {Uint8Array|null} hook
   * @param {Uint8Array|null} stamp
   * @returns {{version: number, flags: number, gateCpu: number,
   *   entryCpu: number, hooked: boolean, supported: boolean, mpc: boolean,
   *   ready: boolean}|null}
   */
  parseDetection(hook, stamp) {
    if (!stamp || stamp.length < FAST_FLASHER_STAMP_LENGTH) return null;
    let s = '';
    for (let i = 0; i < FAST_FLASHER_MAGIC.length; i++)
      s += String.fromCharCode(stamp[i]);
    if (s !== FAST_FLASHER_MAGIC) return null;
    const version = stamp[6];
    const flags = stamp[7];
    const gateCpu = ffBytes.be32(stamp, 8);
    const entryCpu = ffBytes.be32(stamp, 12);
    // both addresses must land inside the external chip's body range, or the
    // stamp is not one of ours whatever its first six bytes say
    const inBody = (a) =>
      a >= FAST_FLASHER_EXT_CPU + FAST_FLASHER_STAMP_AT &&
      a < FAST_FLASHER_EXT_CPU + 0xfff40 &&
      (a & 3) === 0;
    if (!version || !inBody(gateCpu) || !inBody(entryCpu)) return null;
    const hooked =
      !!hook &&
      hook.length >= 4 &&
      ffBytes.be32(hook, 0) === _fastFlasherBranch(gateCpu);
    const bootWindow = (flags & FAST_FLASHER_FLAG_BOOT_WINDOW) !== 0;
    const aifWipe = version >= FAST_FLASHER_AIFWIPE_FROM && bootWindow;
    const supported = version <= FAST_FLASHER_VERSION;
    // older bodies wedge on a real cable (a stray byte after the reopen made
    // v2 swallow every HELLO): they are reinstalled, not used
    const outdated = version < FAST_FLASHER_CURRENT_FROM;
    return {
      version,
      flags,
      gateCpu,
      entryCpu,
      hooked,
      supported,
      outdated,
      // v2 bodies write the MPC as well (the window 0x80000000 | offset)
      mpc: version >= 2 || (flags & FAST_FLASHER_FLAG_MPC) !== 0,
      // and may be trusted to: the loader's driver does the CMF writes
      mpcSafe:
        version >= FAST_FLASHER_MPC_WRITES_FROM &&
        (version >= 2 || (flags & FAST_FLASHER_FLAG_MPC) !== 0),
      // pagesets, mask erase: the v8 wire
      pagesets: version >= FAST_FLASHER_PAGESETS_FROM,
      // a line-speed change that cannot strand the DME: v9
      fastLine: version >= FAST_FLASHER_LINE_FROM,
      // READ: the whole chip and the MPC at the line's rate
      reads: version >= FAST_FLASHER_READS_FROM,
      // the bench body that can erase the boot sector (Wipe AIF)
      aifWipe,
      ready: hooked && supported && !outdated,
      // an outdated body that can still carry the program push which
      // replaces it (Fast Flash Program splices the current body in)
      upgradable:
        hooked && supported && outdated && version >= FAST_FLASHER_UPGRADE_FROM,
    };
  },

  /**
   * One line for the log and the status bar.
   * @param {ReturnType<typeof fastFlasher.parseDetection>} det
   * @returns {string}
   */
  describe(det) {
    if (!det) return 'Fast flasher: not on this DME';
    // the boot-region bootloader standing in for the resident flasher
    if (det.bootLoader)
      return `Fast flasher present${det.resident ? ' (an older copy is still in the program: the next Fast Flash Program removes it)' : ''}`;
    const v = `v${det.version}`;
    if (det.notRunning)
      return `Fast flasher ${v} found, but the DME is not running its program (${det.notRunning}), so the flasher cannot be reached. Run a full Flash Program (or Install fast flasher) to finish the DME first.`;
    if (!det.hooked)
      return `Fast flasher ${v} body found, but the reset word at MPC 0x8 no longer leads to it (the internal flash was rewritten whole). Bootstrap again to use it.`;
    if (!det.supported)
      return `Fast flasher ${v} found; this app speaks up to v${FAST_FLASHER_VERSION}. Update BMWeb to use it.`;
    if (det.outdated)
      return `Fast flasher ${v} present, older than this app's v${FAST_FLASHER_VERSION}: install the fast flash bootloader (Custom Options) to fast flash`;
    return `Fast flasher ${v} present`;
  },

  /**
   * The guard every send passes through: refuses unless the detection read
   * on this identify says the flasher is there, reachable and spoken.
   * @param {ReturnType<typeof fastFlasher.parseDetection>} det
   * @returns {void}
   */
  assertReady(det) {
    if (!det)
      throw new Error('No fast flasher on this DME (no stamp at ext 0xFD26C).');
    if (!det.ready) throw new Error(fastFlasher.describe(det));
  },

  /**
   * Cut a span of the image into the flasher's chunks and pack each with
   * NRV2B. Only once the guard has passed: packing is for a DME that can
   * unpack it.
   * @param {ReturnType<typeof fastFlasher.parseDetection>} det
   * @param {Uint8Array} bytes - The span to send.
   * @param {number} extAddr - Its ext offset on the chip.
   * @returns {Array<{addr: number, length: number, packed: Uint8Array}>}
   */
  packChunks(det, bytes, extAddr) {
    fastFlasher.assertReady(det);
    const codec =
      typeof nrv2b !== 'undefined' ? nrv2b : require('./nrv2b.js').nrv2b;
    const out = [];
    for (let at = 0; at < bytes.length; at += FAST_FLASHER_CHUNK) {
      const part = bytes.subarray(
        at,
        Math.min(bytes.length, at + FAST_FLASHER_CHUNK)
      );
      out.push({
        addr: extAddr + at,
        length: part.length,
        packed: codec.encode(part),
      });
    }
    return out;
  },

  /**
   * The body range on the external chip -- blank on a stock image, the
   * flasher's home after a bootstrap. The bootstrap splice refuses unless
   * it is blank (never patch over something).
   */
  BODY_START: 0xfd26c,
  BODY_END: 0xfff40,

  /**
   * Is a stock pair a clean target for a bootstrap? The body range must be
   * blank and MPC 0x8 must hold the stock reset word (or the hook already,
   * for an idempotent rebuild) -- the same guards flasher_gate.build uses.
   * @param {Uint8Array} flash - The 1 MB external image.
   * @param {Uint8Array} mpc - The MPC image.
   * @returns {{ok: boolean, why?: string}}
   */
  canBootstrap(flash, mpc) {
    if (!flash || flash.length < fastFlasher.BODY_END)
      return { ok: false, why: 'the external image is too small' };
    if (!mpc || mpc.length < 12)
      return { ok: false, why: 'the MPC image is too small' };
    for (let i = fastFlasher.BODY_START; i < fastFlasher.BODY_END; i++)
      if (flash[i] !== 0xff)
        return {
          ok: false,
          why: `the body range is not blank (ext ${i.toString(16)} = ${flash[i].toString(16)}); this image already carries code there`,
        };
    const hook = ffBytes.be32(mpc, FAST_FLASHER_HOOK_AT);
    const blob =
      typeof fastFlasherBlob !== 'undefined'
        ? fastFlasherBlob
        : require('../generated/fast-flasher-blob.js').fastFlasherBlob;
    if (hook !== FAST_FLASHER_STOCK_HOOK && hook !== blob.hookWord)
      return {
        ok: false,
        why: `MPC 0x8 holds ${hook.toString(16)}, not the stock reset word`,
      };
    return { ok: true };
  },

  /**
   * The bootstrap pair: the car's current images with the flasher body
   * spliced into the external chip and the hook word into MPC 0x8. The
   * CALLER then checksums and signs the pair (fbDmeChipImage / the full-
   * flash path) -- the body sits inside a signed program segment, so the
   * splice MUST be followed by a re-sign, which the full flash already does.
   * @param {Uint8Array} flash - The 1 MB external image (the shadow/current bytes).
   * @param {Uint8Array} mpc - The MPC image.
   * @returns {{flash: Uint8Array, mpc: Uint8Array}}
   * @throws {Error} When the pair is not a clean bootstrap target.
   */
  /**
   * Does this pair already carry exactly this app's flasher -- every body run
   * in the external image and the hook word at MPC 0x8? A dump read off a
   * bootstrapped DME does.
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @returns {boolean}
   */
  carriesFlasher(flash, mpc) {
    const blob =
      typeof fastFlasherBlob !== 'undefined'
        ? fastFlasherBlob
        : require('../generated/fast-flasher-blob.js').fastFlasherBlob;
    if (!flash || !mpc || flash.length < fastFlasher.BODY_END) return false;
    if (ffBytes.be32(mpc, blob.hookAt) !== blob.hookWord) return false;
    for (const [off, hex] of blob.runs) {
      const bytes = ffBytes.hexToBytes(hex);
      for (let i = 0; i < bytes.length; i++)
        if (flash[off + i] !== bytes[i]) return false;
    }
    return true;
  },

  /**
   * The pair as a bootstrapped DME must hold it: unchanged when it already
   * carries the flasher, else with it spliced in (the same splice the install
   * makes). Fast Flash Program sends its external half through this, so the
   * push rewrites the flasher's own code in the last program sector rather
   * than erasing it, and the signature is computed against the MPC the DME
   * really has -- hook included. The caller signs.
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @returns {{flash: Uint8Array, mpc: Uint8Array}}
   * @throws {Error} When the pair neither carries the flasher nor can take it.
   */
  /**
   * The pair WITHOUT the resident flasher, for a DME whose fast flasher is
   * the boot-region bootloader: the body range back to blank and MPC 0x8
   * back to the program's own reset word -- both together, since a hook
   * left pointing at a blank body would send every boot into 0xFF. A pair
   * that carries neither comes back as it was. The caller signs.
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @returns {{flash: Uint8Array, mpc: Uint8Array, removed: boolean}}
   */
  withoutFlasher(flash, mpc) {
    const f = Uint8Array.from(flash);
    const m = Uint8Array.from(mpc);
    const blob =
      typeof fastFlasherBlob !== 'undefined'
        ? fastFlasherBlob
        : require('../generated/fast-flasher-blob.js').fastFlasherBlob;
    let removed = false;
    const stamp = String.fromCharCode(
      ...f.subarray(FAST_FLASHER_STAMP_AT, FAST_FLASHER_STAMP_AT + 6)
    );
    if (stamp === FAST_FLASHER_MAGIC) {
      f.fill(0xff, fastFlasher.BODY_START, fastFlasher.BODY_END);
      removed = true;
    }
    if (ffBytes.be32(m, FAST_FLASHER_HOOK_AT) === blob.hookWord) {
      ffBytes.putBe32(m, FAST_FLASHER_HOOK_AT, FAST_FLASHER_STOCK_HOOK);
      removed = true;
    }
    return { flash: f, mpc: m, removed };
  },

  withFlasher(flash, mpc) {
    if (fastFlasher.carriesFlasher(flash, mpc)) return { flash, mpc };
    return fastFlasher.bootstrap(flash, mpc);
  },

  bootstrap(flash, mpc) {
    const can = fastFlasher.canBootstrap(flash, mpc);
    if (!can.ok) throw new Error(`Cannot install the fast flasher: ${can.why}`);
    const blob =
      typeof fastFlasherBlob !== 'undefined'
        ? fastFlasherBlob
        : require('../generated/fast-flasher-blob.js').fastFlasherBlob;
    const f = Uint8Array.from(flash);
    const m = Uint8Array.from(mpc);
    for (const [off, hex] of blob.runs) {
      const bytes = ffBytes.hexToBytes(hex);
      if (
        off < fastFlasher.BODY_START ||
        off + bytes.length > fastFlasher.BODY_END
      )
        throw new Error(
          `blob run at ${off.toString(16)} falls outside the body range`
        );
      f.set(bytes, off);
    }
    ffBytes.putBe32(m, blob.hookAt, blob.hookWord);
    return { flash: f, mpc: m };
  },
};

if (typeof window !== 'undefined') {
  window.fastFlasher = fastFlasher;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fastFlasher };
}
