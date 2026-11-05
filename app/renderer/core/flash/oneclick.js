// The selector-5 one-click: a login the stock loader accepts, which grants
// the programming rights the no-install trigger needs -- so a STOCK DME
// (no bootloader, no blanked boot markers) gets the v21 fast-flash body
// started in one KWP session. The whole chain is EMULATOR-PROVEN on the
// stock table (ms45-emu tools/experiments/noinstall_v5r.py, REAL factors,
// "ONE-CLICK FLASH CONTROL: PASS" 2026-11-04, v5r_real_PASS.log; the joined
// grant+stage+fire chain in noinstall_oneclick_sim.py, "ONE-CLICK DRESS
// REHEARSAL: PASS"): selector 5 answers a seed on stock, the answer key is
// the private exponent of the flash table's slot-5 modulus, and a passing
// answer walks the loader's own grant table (variant 5 -> a36 := 3), which
// is exactly the right `10 86` needs. Nothing is poked; the loader sets
// every slot itself.
//
// THE SLOT-5 KEY (see ms45-emu docs/protections.md + the FactorDB entry,
// pre-2018): the bignum engine's effective modulus is the dword-reversal of
// the flash-table bytes (K3rev below). Its two prime factors were published
// years ago; 7 divides neither p-1 nor q-1, so x -> x^7 is a bijection mod
// both and EVERY seed is solvable -- no lottery, one exponentiation:
// x = MD5-field^d5 mod K3rev.
//
// WHAT THE DME CHECKS (disasm in ms45-emu tools/experiments/noinstall_v5*.py):
//   ask  31 07 05 00 00 00 00        -> 71 07 <8-byte seed>
//   T    = MD5(EB3 ‖ EB7 ‖ seed)     (EB3 = 4 B @0x3F993D, EB7 = 4 B
//                                     @0x3F9939 -- read per unit, never
//                                     assumed, AND read AFTER the seed
//                                     ask: the ask stages them ('104M'
//                                     appeared only after it on the bench
//                                     build; the proof unit's '174M' was
//                                     already resident)
//   x    = T^d5 mod K3rev, sent as [31 08 00 00 00 00 10] + 64 B in the
//          limbs_le wire form (16 big-endian dwords, least-significant
//          limb first -- the count==4 gate at 0x8554 wants these lead
//          bytes; the plain little-endian form parses to the same x but is
//          refused)
//   proof the loader echoes `71 08` even on FAIL: only VARIANT@0x3F99C4
//   flipping to 5 (a36@0x3F9A36 leaving 1) is a grant. Both views of T
//   (little-endian, and the dword-rotated one the real run granted on) are
//   tried, smallest x first, exactly the order the emulator proof sent.
//
// The grant is RAM-only: power-off clears it and the flash is untouched.
// This module stops at the grant and the trigger's fire (core/flash/
// trigger.js, which the grant makes acceptable WITHOUT the one-time
// unlock); the screen side (screens/flashing/dme-oneclick.js) picks the
// body up and runs the operation through it.
/* exported oneClick */

const OC = {
  // K3rev: rev_limbs of the flash-table slot-5 modulus bytes (512-bit).
  N: 0xa11aaf573b4c04cf54b5ec854cd091c21db4edd825f8719e4c1cd903a89a39d37cbce04a4a2b0eb6bbe357012c71936f42be238ba9b394e135c4197f91b6ec7fn,
  // The two proven primes (product asserted at load). d5 = 7^-1 mod
  // lcm(p-1, q-1) -- with 7 dividing neither p-1 nor q-1, every seed
  // solves; no Adleman-Manders-Miller root extraction is ever needed.
  P: 74769050067128434612246568372696544010339320960641983151222512918045189742617n,
  Q: 112850351646210428555254918204904215866361426064140447195761575233770091488343n,
  D5: 0xf57dfefed4431385135e5c38d69327402d44769eb3c3b952bd1fc497dc58b9a15230d9a7b42bacf717129de3b135adacb05a824676f79beba466138c96c6557n,
  EB3: 0x3f993d, // 4 B, hashed FIRST
  EB7: 0x3f9939, // 4 B, hashed second (the lower address of the pair)
  VARIANT: 0x3f99c4, // == 5 after a grant
  A36: 0x3f9a36, // leaves 1 (stock) for 3 (bit 1: the 10 86 right)
  A37: 0x3f9a37,
  STOCK_A36: 1,
  GRANT_VARIANT: 5,
  // The login reads/writes at most: one 8-B field read, one seed ask, four
  // answer tries with a 0x74-B slot read between them, per seed round.
  SEED_ROUNDS: 4,
};

// A wrong constant here fails every login on every DME with the loader's
// own refusal, so check the arithmetic once at load instead: the primes
// must multiply to the modulus (the FactorDB receipt) and d5 must invert 7.
if (OC.P * OC.Q !== OC.N)
  throw new Error('oneClick: the slot-5 constants are inconsistent (p*q != n)');

// Same-scope globals when the app loads this as a plain script; the require
// path is for tools/verify, which runs these files under node.
const ocMd5 = typeof _md5 !== 'undefined' ? _md5 : require('./flasher.js')._md5;
const ocModPow =
  typeof _modPow !== 'undefined' ? _modPow : require('./flasher.js')._modPow;
const ocTrigger =
  typeof triggerWire !== 'undefined'
    ? triggerWire
    : require('./trigger.js').triggerWire;

/**
 * The limbs_le wire form: 16 big-endian dwords, least-significant limb
 * first -- the form the count==4 gate accepts (the plain LE bytes parse to
 * the same x and are still refused).
 * @param {bigint} v - The answer x (< 2^512).
 * @returns {Uint8Array} 64 bytes.
 */
function oneClickLimbsLe(v) {
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const limb = Number((v >> BigInt(32 * i)) & 0xffffffffn);
    out[i * 4] = (limb >>> 24) & 0xff;
    out[i * 4 + 1] = (limb >>> 16) & 0xff;
    out[i * 4 + 2] = (limb >>> 8) & 0xff;
    out[i * 4 + 3] = limb & 0xff;
  }
  return out;
}

/** @returns {bigint} The limbs_le bytes parsed back to x (the DME's parse). */
function oneClickLimbsLeToBigInt(bytes) {
  let v = 0n;
  for (let i = 15; i >= 0; i--)
    v =
      (v << 32n) |
      BigInt(
        ((bytes[i * 4] << 24) |
          (bytes[i * 4 + 1] << 16) |
          (bytes[i * 4 + 2] << 8) |
          bytes[i * 4 + 3]) >>>
          0
      );
  return v;
}

/**
 * Read RAM with the stock read-by-address (23), the same dialect the
 * live-tune client uses (core/ms45/livetune.js): 24-bit address, one length
 * byte, answer 63 + bytes. Works in the plain diagnostic session, no login.
 * @param {(data: number[]) => Promise<number[]|Uint8Array|null>} sender -
 *   ms45LiveTuneSender-shaped send path.
 * @param {number} address
 * @param {number} length
 * @returns {Promise<Uint8Array>}
 * @throws {Error} When the DME stays silent or refuses the read.
 */
async function oneClickRead(sender, address, length) {
  const out = new Uint8Array(length);
  for (let done = 0; done < length;) {
    const n = Math.min(250, length - done);
    const at = address + done;
    const r = await sender([
      0x23,
      (at >> 16) & 0xff,
      (at >> 8) & 0xff,
      at & 0xff,
      n,
    ]);
    if (!r)
      throw new Error(
        `one-click: the DME did not answer a read at 0x${at.toString(16)}`
      );
    if (r[0] !== 0x63 || r.length < n + 1)
      throw new Error(
        `one-click: the DME refused a read at 0x${at.toString(16)}`
      );
    out.set(Array.from(r.slice(1, 1 + n)), done);
    done += n;
  }
  return out;
}

/**
 * The answer candidates for one seed's T, in the order the real run sent
 * them: the little-endian parse of T FIRST -- the view whose answer granted
 * on the stock emulator (v5r_real_PASS.log, seed 7c510fe3.., slots
 * (5,3,0)) -- and the dword-rotated parse second, the spare (the loader's
 * 4-dword LSB-first compare is the disasm's "LE32 views" plural; only the
 * first was ever needed).
 * @param {Uint8Array} t - The 16-byte MD5.
 * @returns {bigint[]} Two x values.
 */
function oneClickCandidates(t) {
  let le = 0n; // int.from_bytes(T, 'little')
  for (let i = 15; i >= 0; i--) le = (le << 8n) | BigInt(t[i]);
  const rot = new Uint8Array(16); // T[12:16]+T[8:12]+T[4:8]+T[0:4]
  rot.set(t.subarray(12, 16), 0);
  rot.set(t.subarray(8, 12), 4);
  rot.set(t.subarray(4, 8), 8);
  rot.set(t.subarray(0, 4), 12);
  let be = 0n; // int.from_bytes(rot, 'big')
  for (let i = 0; i < 16; i++) be = (be << 8n) | BigInt(rot[i]);
  return [ocModPow(le, OC.D5, OC.N), ocModPow(be, OC.D5, OC.N)];
}

/**
 * The selector-5 login, from nothing to the grant: read the unit's own
 * login fields, draw a seed, answer it, and read the slots back -- the
 * reply's `71 08 01` is NOT trusted (the loader lies on fail too); only
 * VARIANT having become 5 is a grant.
 * @param {(data: number[]) => Promise<number[]|Uint8Array|null>} sender -
 *   ms45LiveTuneSender-shaped send path.
 * @param {{stage?: (s: string) => void, note?: (s: string) => void}} [cb]
 * @returns {Promise<{variant: number, a36: number, a37: number,
 *   seed: Uint8Array, x: bigint}>}
 * @throws {Error} When the DME never grants (its refusals quoted).
 */
async function oneClickLogin(sender, cb = {}) {
  const stage = cb.stage || (() => {});
  const note = cb.note || (() => {});
  const hex8 = (b) =>
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join(' ');

  let lastWords = 'no answer';
  let shownFields = '';
  for (let round = 0; round < OC.SEED_ROUNDS; round++) {
    stage(`Answering the selector-5 login (seed ${round + 1})`);
    const ask = await sender([0x31, 0x07, 0x05, 0x00, 0x00, 0x00, 0x00]);
    if (!ask || ask[0] !== 0x71 || ask.length < 10)
      throw new Error(
        `one-click: selector 5 did not answer a seed${
          ask ? ` (answered ${hex8(ask)})` : ''
        }`
      );
    const seed = Uint8Array.from(ask.slice(2, 10));
    // The login fields are read AFTER the ask: the ask itself stages them
    // (proven on the bench build 2026-11-04: EB7 read 00 00 00 00 before
    // it, '104M' after -- hashing the before value answers wrong; the
    // proof unit's '174M' was already resident, which is why read-first
    // passed there). One read covers both: EB7 at 0x3F9939, EB3 at
    // 0x3F993D.
    const pair = await oneClickRead(sender, OC.EB7, 8);
    const eb7 = pair.slice(0, 4);
    const eb3 = pair.slice(4, 8);
    const fields = `${hex8(eb3)} / ${hex8(eb7)}`;
    if (fields !== shownFields) {
      note(
        `login fields (seed ${round + 1}): EB3 ${hex8(eb3)} / EB7 ${hex8(eb7)}`
      );
      shownFields = fields;
    }
    // T = MD5(EB3 ‖ EB7 ‖ seed) -- EB3 FIRST even though it sits at the
    // higher address; this order is the disasm's (fn_98FC / fn_7FE0)
    const t = ocMd5(new Uint8Array([...eb3, ...eb7, ...seed]));
    for (const x of oneClickCandidates(t)) {
      // Six header bytes before the 64-byte key: [31 08 00 00 00 10].
      // An earlier form carried a seventh 0x00 before the 0x10 (total len
      // 0x47 instead of 0x46), which the loader's 31 08 handler parses as
      // a malformed body and refuses pre-verify with 7f 31 12. The proven
      // chain (tools/experiments/noinstall_v5r.py:176, PASS on stock) uses
      // the six-byte form; keep it in lockstep.
      const r = await sender([
        0x31,
        0x08,
        0x00,
        0x00,
        0x00,
        0x10,
        ...oneClickLimbsLe(x),
      ]);
      // the loader echoes 71 08 whatever happened -- read the slots, the
      // only honest witness. One read spans VARIANT..a37 (0x74 B).
      const slots = await oneClickRead(sender, OC.VARIANT, 0x74);
      const variant = slots[0];
      const a36 = slots[OC.A36 - OC.VARIANT];
      const a37 = slots[OC.A37 - OC.VARIANT];
      const ok = variant === OC.GRANT_VARIANT || a36 !== OC.STOCK_A36;
      note(
        `31 08 -> ${
          r
            ? Array.from(r)
                .slice(0, 3)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' ')
            : 'silence'
        } · slots ${variant}/${a36}/${a37}` + (ok ? ' — granted' : '')
      );
      if (ok) return { variant, a36, a37, seed, x };
      lastWords = r
        ? Array.from(r)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ')
        : 'silence';
    }
  }
  throw new Error(
    `one-click: the DME refused every answer (${lastWords}); it stays on ` +
      'its stock loader and nothing was written'
  );
}

/**
 * The grant plus the no-install trigger: login, then the stock loader's own
 * staging and fire (trigger.js, with NO marker check -- the grant is what
 * makes the session acceptable, not blanked boot markers). On return the
 * v21 fast-flash body owns the line from SRAM; the caller's next step is
 * the resident protocol's HELLO at 115200 (fastFlashWire webLink resume),
 * never another KWP telegram.
 * @param {(data: number[]) => Promise<number[]|Uint8Array|null>} sender -
 *   ms45LiveTuneSender-shaped send path. Its session switch is a no-op once
 *   the MS45 SGBD is loaded, so it is safe ACROSS the 10 86 (verified
 *   against core/webshim/job-runner.js switchSession's early return).
 * @param {Uint8Array} body - The fast-flash body (triggerBodyFromBlob).
 * @param {{stage?: (s: string) => void, note?: (s: string) => void,
 *   progress?: (n: number, total: number) => void}} [cb]
 * @returns {Promise<{grant: object, replied: number[]|Uint8Array|null}>}
 */
async function oneClickGrantAndFire(sender, body, cb = {}) {
  const grant = await oneClickLogin(sender, cb);
  // no cb.markers: the one-time unlock is NOT wanted and NOT checked -- a
  // stock DME's intact markers are fine, the grant carries the session
  const fired = await ocTrigger.triggerFire(sender, body, cb);
  return { grant, replied: fired.replied };
}

// The exported name IS the full wire object (constants + functions). A
// separate `window.oneClick = ...` assignment would be shadowed in the
// browser by any top-level const of the same name -- the classic-script
// global lexical binding wins over the window property -- so consumers
// everywhere reference THIS object bare.
const oneClick = {
  ...OC,
  limbsLe: oneClickLimbsLe,
  limbsLeToBigInt: oneClickLimbsLeToBigInt,
  read: oneClickRead,
  candidates: oneClickCandidates,
  login: oneClickLogin,
  grantAndFire: oneClickGrantAndFire,
};

if (typeof window !== 'undefined') window.oneClick = oneClick;
if (typeof module !== 'undefined' && module.exports)
  module.exports = { oneClick };
