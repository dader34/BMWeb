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
// What is said to it once it runs is core/flash/fast-flasher-wire.js.
/* exported fastFlasher */

const ffBytes =
  typeof bytes !== 'undefined' ? bytes : require('../bytes/index.mjs');

const FAST_FLASHER_STAMP_AT = 0xfd26c; // ext offset, the body's head
const FAST_FLASHER_STAMP_LENGTH = 16;
const FAST_FLASHER_MAGIC = 'MS45QF';
const FAST_FLASHER_HOOK_AT = 0x8; // MPC, the loader's reset word
const FAST_FLASHER_STOCK_HOOK = 0x4bf717b6; // `ba 0xFFF717B4`
const FAST_FLASHER_EXT_CPU = 0xfff00000; // where the external chip is mapped
/**
 * The stamp version this app speaks. A resident body in the program area is
 * used only when it is THIS build's (the installer the bootloader rides in
 * on, or the shipped body); any other version is noted and left alone --
 * the next program flash takes it out, and the fast flash bootloader is
 * what carries the fast path. No version eras: there is one body, the
 * current one.
 */
const FAST_FLASHER_VERSION = 28;
/**
 * Stamp flags bit 1: the body carries the boot-sector (AIF) window. (Bit 0
 * said a body could write the MPC; every body since v2 can.)
 */
const FAST_FLASHER_FLAG_BOOT_WINDOW = 0x02;
/**
 * The body range on the external chip -- blank on a stock image, the
 * flasher's home after a bootstrap. The bootstrap splice refuses unless it
 * is blank (never patch over something).
 */
const FAST_FLASHER_BODY_START = FAST_FLASHER_STAMP_AT;
const FAST_FLASHER_BODY_END = 0xfff40;

/**
 * The absolute `ba` PPC assembles at MPC 0x8 for a target (AA set).
 * @param {number} target - CPU address.
 * @returns {number}
 */
function _fastFlasherBranch(target) {
  return (0x48000002 | (target & 0x03fffffc)) >>> 0;
}

/** This build's body: its runs on the external chip and the hook word. */
function _fastFlasherBody() {
  return typeof fastFlasherBlob !== 'undefined'
    ? fastFlasherBlob
    : require('../generated/fast-flasher-blob.js').fastFlasherBlob;
}

/** Whether the stamp's magic stands at `at`. @param {ArrayLike<number>} b */
function _fastFlasherMagicAt(b, at) {
  for (let i = 0; i < FAST_FLASHER_MAGIC.length; i++)
    if (b[at + i] !== FAST_FLASHER_MAGIC.charCodeAt(i)) return false;
  return true;
}

const fastFlasher = {
  STAMP_AT: FAST_FLASHER_STAMP_AT,
  STAMP_LENGTH: FAST_FLASHER_STAMP_LENGTH,
  HOOK_AT: FAST_FLASHER_HOOK_AT,
  STOCK_HOOK: FAST_FLASHER_STOCK_HOOK,
  VERSION: FAST_FLASHER_VERSION,
  BODY_START: FAST_FLASHER_BODY_START,
  BODY_END: FAST_FLASHER_BODY_END,

  /**
   * Interpret the two reads: the 4 bytes at MPC 0x8 and the 16-byte stamp at
   * ext 0xFD26C. Returns null when there is no stamp at all (a stock or
   * never-bootstrapped DME); otherwise what the stamp says and whether the
   * hook still leads to the gate it names.
   * @param {Uint8Array|null} hook
   * @param {Uint8Array|null} stamp
   * @returns {{version: number, flags: number, gateCpu: number,
   *   entryCpu: number, hooked: boolean, supported: boolean, mpc: boolean,
   *   ready: boolean, lateOff?: boolean}|null}
   */
  parseDetection(hook, stamp) {
    if (!stamp || stamp.length < FAST_FLASHER_STAMP_LENGTH) return null;
    if (!_fastFlasherMagicAt(stamp, 0)) return null;
    const version = stamp[6];
    const flags = stamp[7];
    const gateCpu = ffBytes.be32(stamp, 8);
    const entryCpu = ffBytes.be32(stamp, 12);
    // both addresses must land inside the external chip's body range, or the
    // stamp is not one of ours whatever its first six bytes say
    const inBody = (a) =>
      a >= FAST_FLASHER_EXT_CPU + FAST_FLASHER_BODY_START &&
      a < FAST_FLASHER_EXT_CPU + FAST_FLASHER_BODY_END &&
      (a & 3) === 0;
    if (!version || !inBody(gateCpu) || !inBody(entryCpu)) return null;
    const hooked =
      !!hook &&
      hook.length >= 4 &&
      ffBytes.be32(hook, 0) === _fastFlasherBranch(gateCpu);
    const bootWindow = (flags & FAST_FLASHER_FLAG_BOOT_WINDOW) !== 0;
    // this build's body, or not: nothing in between
    const ours = version === FAST_FLASHER_VERSION;
    return {
      version,
      flags,
      gateCpu,
      entryCpu,
      hooked,
      ours,
      supported: ours,
      mpc: ours,
      reads: ours,
      aifWipe: ours && bootWindow,
      ready: hooked && ours,
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
    if (det.bootLoader) return 'Fast flasher present';
    if (det.notRunning)
      return `Fast flasher found, but the DME is not running its program (${det.notRunning}), so the flasher cannot be reached. Run a full Flash Program (or Install fast flasher) to finish the DME first.`;
    // the bootloader installer, switched off once the bootloader went on
    if (det.lateOff)
      return 'Bootloader installer in the program, switched off: the DME starts normally (the next program flash removes it)';
    if (!det.hooked)
      return 'Fast flasher body found, but the reset word at MPC 0x8 no longer leads to it (the internal flash was rewritten whole). Bootstrap again to use it.';
    // Older "!det.ours" branch (announcing a non-matching installed body)
    // removed per user request; the one-click/AIF tools no longer gate on
    // installed version matching, so the line was only noise.
    return 'Fast flasher present';
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
    // describe() no longer names an old body (dropped from the identify
    // line), so the refusal says it here instead of "Fast flasher present"
    if (det.hooked && !det.ours)
      throw new Error(
        "The fast flasher in this DME's program is an older version this build cannot use; it is left alone (the next Fast Flash Program removes it)."
      );
    if (!det.ready) throw new Error(fastFlasher.describe(det));
  },

  /**
   * Is a stock pair a clean target for a bootstrap? The body range must be
   * blank and MPC 0x8 must hold the stock reset word (or the hook already,
   * for an idempotent rebuild) -- the same guards flasher_gate.build uses.
   * @param {Uint8Array} flash - The 1 MB external image.
   * @param {Uint8Array} mpc - The MPC image.
   * @returns {{ok: boolean, why?: string}}
   */
  canBootstrap(flash, mpc) {
    if (!flash || flash.length < FAST_FLASHER_BODY_END)
      return { ok: false, why: 'the external image is too small' };
    if (!mpc || mpc.length < 12)
      return { ok: false, why: 'the MPC image is too small' };
    for (let i = FAST_FLASHER_BODY_START; i < FAST_FLASHER_BODY_END; i++)
      if (flash[i] !== 0xff)
        return {
          ok: false,
          why: `the body range is not blank (ext ${i.toString(16)} = ${flash[i].toString(16)}); this image already carries code there`,
        };
    const hook = ffBytes.be32(mpc, FAST_FLASHER_HOOK_AT);
    if (
      hook !== FAST_FLASHER_STOCK_HOOK &&
      hook !== _fastFlasherBody().hookWord
    )
      return {
        ok: false,
        why: `MPC 0x8 holds ${hook.toString(16)}, not the stock reset word`,
      };
    return { ok: true };
  },

  /**
   * Does this pair already carry exactly this app's flasher -- every body run
   * in the external image and the hook word at MPC 0x8? A dump read off a
   * bootstrapped DME does.
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @returns {boolean}
   */
  carriesFlasher(flash, mpc) {
    const blob = _fastFlasherBody();
    if (!flash || !mpc || flash.length < FAST_FLASHER_BODY_END) return false;
    if (ffBytes.be32(mpc, blob.hookAt) !== blob.hookWord) return false;
    return blob.runs.every(([off, hex]) =>
      ffBytes.hexToBytes(hex).every((b, i) => flash[off + i] === b)
    );
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
  withFlasher(flash, mpc) {
    if (fastFlasher.carriesFlasher(flash, mpc)) return { flash, mpc };
    return fastFlasher.bootstrap(flash, mpc);
  },

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
    const stamped = _fastFlasherMagicAt(f, FAST_FLASHER_STAMP_AT);
    // this build's hook word, or any absolute branch into the body range
    // (another build's gate): with the body blanked, either one sends
    // every boot into 0xFF
    const word = ffBytes.be32(m, FAST_FLASHER_HOOK_AT);
    const li = word & 0x03fffffc;
    const target = (li & 0x02000000 ? li | 0xfc000000 : li) >>> 0;
    const intoBody =
      (word & 0xfc000003) >>> 0 === 0x48000002 &&
      target >= FAST_FLASHER_EXT_CPU + FAST_FLASHER_BODY_START &&
      target < FAST_FLASHER_EXT_CPU + FAST_FLASHER_BODY_END;
    const hooked = word === _fastFlasherBody().hookWord || intoBody;
    if (stamped) f.fill(0xff, FAST_FLASHER_BODY_START, FAST_FLASHER_BODY_END);
    if (hooked)
      ffBytes.putBe32(m, FAST_FLASHER_HOOK_AT, FAST_FLASHER_STOCK_HOOK);
    return { flash: f, mpc: m, removed: stamped || hooked };
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
  bootstrap(flash, mpc) {
    const can = fastFlasher.canBootstrap(flash, mpc);
    if (!can.ok) throw new Error(`Cannot install the fast flasher: ${can.why}`);
    const blob = _fastFlasherBody();
    const f = Uint8Array.from(flash);
    const m = Uint8Array.from(mpc);
    for (const [off, hex] of blob.runs) {
      const bytes = ffBytes.hexToBytes(hex);
      if (
        off < FAST_FLASHER_BODY_START ||
        off + bytes.length > FAST_FLASHER_BODY_END
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
