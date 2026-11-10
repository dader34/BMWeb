// The DME-relay client: servicing the transmission with no CAN hardware
// on this side. A patched full flash plants a small PPC stub in the DME's
// external image and hooks the 10 ms frame task into it; booted, the DME
// alone drives the whole GS20 service over PT-CAN (0x7DD out, 0x7DC back)
// while its own diagnostics stay alive -- it stages the transmission's RAM
// monitor word by word, redirects its stack pointer mid-answer, then
// write, read, a DPP window, a flash read, the echo, and LAST a stock
// 0x20 readback of the payload's own first word. That word is the marker
// ladder's cell (car run 3 read it back one byte corrupted: the payload
// survived, the code didn't -- so the monitor now rewrites it with a
// block number at every structural boundary). The readback is the
// post-mortem: a live monitor answers [20 9F 00...] -- its unknown-
// command tag, which the stock program never sends -- and a dead one
// leaves the post-reset stock program answering instead, its reply
// carrying word 0: pristine staged bytes = died before or at the first
// instruction, a marker value = ran and died in that named block,
// zeros/junk = the payload never survived or the span is dirty. One
// step, four verdicts. Emu-proven ALL PASS 2026-11-07 (gs20-emu tools/
// dme_relay_p1.py) on these exact bytes: one build for chip and
// emulator, watchdog in the firmware-proven 4-byte form.
//
// This side's whole job: patch a read pair (relayPatchPair), flash it by
// the usual program path (flash-ops checksums and signs the result like
// any full flash), wait out the service (relayServiceMs), then read the
// 24-byte verdict block out of SRAM with the stock read-by-address
// (relayReadState) and judge it (relayVerdict). No CAN frame is ever sent
// from here -- the only wire is the K-line the flash itself used.
//
// Load relay-blob.js (core/generated) before this file.
/* exported relayPatchPair, relayDecodeState, relayReadState, relayVerdict,
   relayDiagnoseLast, relayServiceMs, relayAwaitVerdict */

const relayBlob_ =
  typeof relayBlob !== 'undefined'
    ? relayBlob
    : require('../generated/relay-blob.js').relayBlob;
const oneClick_ =
  typeof oneClick !== 'undefined'
    ? oneClick
    : require('./oneclick.js').oneClick;

// the same image sizes flash-ops takes (MS45_FULL_FLASH_LENGTH and
// MS45_MPC_LENGTH in core/ms45/ms45.js; hardcoded here so the node test
// needs no script shims)
const RELAY_FLASH_LENGTH = 0x100000;
const RELAY_MPC_LENGTH = 0x70000;

/**
 * Patch a read external/MPC pair into the relay pair: the blob's runs
 * spliced into the free window and the hook word (a bl to the stub) into
 * the MPC. Throws when either image is the wrong size or the target region
 * is not erased -- a tune that squatted the window must not be silently
 * overwritten. The images are copied; the inputs stay untouched.
 * @param {Uint8Array} flash - the read 1 MB external image
 * @param {Uint8Array} mpc - the read 448 KB MPC image
 * @returns {{flash: Uint8Array, mpc: Uint8Array}} the patched pair, ready
 *   for flash-ops' dme-program (which checksums and signs it)
 */
function relayPatchPair(flash, mpc) {
  if (!(flash instanceof Uint8Array) || flash.length !== RELAY_FLASH_LENGTH)
    throw new Error('relay: the external image is not 1 MB');
  if (!(mpc instanceof Uint8Array) || mpc.length !== RELAY_MPC_LENGTH)
    throw new Error('relay: the MPC image is not 448 KB');
  const b = relayBlob_;
  const out = { flash: new Uint8Array(flash), mpc: new Uint8Array(mpc) };

  let first = Infinity;
  let end = 0;
  for (const [at, hex] of b.runs) {
    const bytes = hex.length / 2;
    if (at < b.stubAt || at + bytes > b.stubEnd)
      throw new Error(
        `relay: blob run at 0x${at.toString(16)} is outside the free window`
      );
    first = Math.min(first, at);
    end = Math.max(end, at + bytes);
  }
  // the hook site tells whose payload this program carries: the stock word
  // the blob was built and proven against, or our own hook word (a previous
  // relay run -- the payload is then already in the window and gets written
  // over in place). Anything else is a different program build, and a hook
  // planted into it could land mid-instruction. Refuse, name both.
  const w0 = b.stockHookWord;
  const w1 = b.hookWord >>> 0;
  const found =
    ((mpc[b.hookAt] << 24) |
      (mpc[b.hookAt + 1] << 16) |
      (mpc[b.hookAt + 2] << 8) |
      mpc[b.hookAt + 3]) >>>
    0;
  const alreadyOurs = found === w1;
  if (found !== w0 && !alreadyOurs)
    throw new Error(
      `relay: MPC 0x${b.hookAt.toString(16)} carries 0x` +
        `${found.toString(16)}, not this program's 0x${w0.toString(16)} -- ` +
        `the relay payload is not built for that program`
    );

  // erased check, guard bytes before the window included -- the same span
  // the builder asserted against the stock image. Skipped when the hook is
  // already ours: the window then holds a relay payload (ours), and this
  // run replaces it -- the diff push writes only the bytes that differ.
  if (!alreadyOurs)
    for (let i = first - b.guardBefore; i < end; i++)
      if (out.flash[i] !== 0xff)
        throw new Error(
          `relay: external flash not erased at 0x${i.toString(16)}`
        );

  for (const [at, hex] of b.runs)
    for (let i = 0; i < hex.length; i += 2)
      out.flash[at + i / 2] = parseInt(hex.slice(i, i + 2), 16);

  const w = b.hookWord;
  out.mpc.set(
    [(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff],
    b.hookAt
  );
  return out;
}

/**
 * Decode the 24-byte verdict block (big-endian halfwords, the PPC's own
 * stores): step, phase (0 tx / 1 wait / 2 done), magic, replies, good,
 * digest, and the last 8-byte answer.
 * @param {Uint8Array} bytes
 */
function relayDecodeState(bytes) {
  const u16 = (i) => (bytes[i] << 8) | bytes[i + 1];
  return {
    step: u16(0),
    phase: u16(2),
    magic: u16(4),
    replies: u16(6),
    good: u16(8),
    digest: u16(10),
    last: Array.from(bytes.slice(16, 24)),
  };
}

/**
 * Read the verdict block out of the booted relay DME. Works in the plain
 * diagnostic session, no login -- the stock read-by-address the one-click
 * client already speaks.
 * @param {(data: number[]) => Promise<number[]|Uint8Array|null>} sender -
 *   ms45LiveTuneSender-shaped send path
 * @returns {Promise<ReturnType<typeof relayDecodeState>>}
 */
async function relayReadState(sender) {
  return relayDecodeState(
    await oneClick_.read(sender, relayBlob_.state, relayBlob_.stateSize)
  );
}

/**
 * Poll the verdict block until the question is settled: the block says done
 * (or the DME turns out not to run the relay program at all), or the
 * deadline passes. The DME may still be booting or mid-service right after
 * the flash, so a failed read is retried, not fatal -- but the last error is
 * kept and named, so silence, a refusal and a busy cable are told apart.
 *
 * Patient by default: the service itself is seconds, but the real
 * transmission can sit minutes on a single answer (the 2026-11-07 car run
 * stalled at step 127/240 and self-healed -- the stub's bounded resend
 * carried it; a 25 s poll window would have called it dead).
 *
 * NO BUS CLAIM here, deliberately: the sender's telegrams already queue
 * through the bus lock, which refuses EVERYONE while a claim stands -- a
 * claim here would refuse our own reads before a byte left the machine
 * (exactly the car's first two runs, 2026-11-06: 18 attempts, all "the
 * cable is busy: GS20 relay ...", not one telegram on the wire).
 * @param {(data: number[]) => Promise<number[]|Uint8Array|null>} sender -
 *   ms45LiveTuneSender-shaped send path
 * @param {{deadlineMs?: number, sleepMs?: number}} [opts]
 * @returns {Promise<{state: ReturnType<typeof relayDecodeState>|null,
 *   attempts: number, lastWhy: string}>} state null when nothing was read
 */
async function relayAwaitVerdict(sender, opts = {}) {
  const deadlineMs = opts.deadlineMs ?? 300000;
  const sleepMs = opts.sleepMs ?? 1500;
  const deadline = Date.now() + deadlineMs;
  let state;
  let attempts = 0;
  let lastWhy;
  for (;;) {
    attempts++;
    try {
      state = await relayReadState(sender);
      lastWhy = '';
    } catch (e) {
      state = null; // still booting: the K-line init gets no answer yet --
      // but a refusal (7F) is a different disease than silence, and the
      // error names it; keep the last one for the no-verdict message
      lastWhy = (e && e.message) || String(e);
    }
    // done, or a settled blank block (no relay program), or out of time
    if (
      state &&
      (state.magic !== relayBlob_.magic ||
        state.phase === 2 ||
        state.step >= relayBlob_.steps)
    )
      break;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  return { state, attempts, lastWhy };
}

/**
 * Name what the last answer says when the blob is the SAFE PROBE (no
 * redirect, no monitor: the box's own firmware ran the whole time and
 * the stock program answered every frame). The last answer is stock's
 * read of word 0, the pad, so it is a two-way verdict the v10 runs never
 * lived to give: the pad intact (cc 00) = the payload SURVIVED staging
 * at monitorBase on the real transmission -- the killer of the three
 * service builds is the redirect itself, not the span; any other word =
 * the span did not hold on real silicon (the clean-span bitmap was
 * measured on the emulator's GS20 model, not this box).
 * @param {number[]} last
 * @returns {string}
 */
function relayDiagnoseProbe(last) {
  const b = relayBlob_;
  if (last.length >= 8 && last.every((v, i) => v === b.expectLast[i]))
    return (
      'the payload SURVIVED staging: word 0 reads back cc 00 on the real ' +
      'transmission -- the span holds, so the killer of the service ' +
      'builds is the redirect/landing, not staging'
    );
  if (
    last[0] === 0x20 &&
    last[1] === 0x81 &&
    last[2] === b.probeWord[0] &&
    last[3] === b.probeWord[1]
  )
    return (
      'word 0 survived (cc 00) but the reply tail differs from the ' +
      'emulated one -- the span held; save the full answer'
    );
  if (last[0] === 0x20 && last[1] === 0x81)
    return (
      'the span did NOT hold: word 0 came back ' +
      `${last[2].toString(16)} ${last[3].toString(16)}, not the staged ` +
      'cc 00 -- the emulated clean-span bitmap does not describe ' +
      'this transmission (next: probe other spans)'
    );
  if (last.every((v) => v === 0))
    return (
      "no answer was ever recorded -- the staging itself stalled on the " +
      'real box (the step counter says where)'
    );
  if (last[1] === 0x81)
    return (
      'a stock answer of an unexpected class (' +
      `${last[0].toString(16)}) -- save the full answer`
    );
  return 'an answer the stock read format does not shape -- save it';
}

/**
 * Name what the last answer says about the run, whatever it is. The final
 * step is the post-mortem readback (a stock 0x20 read of the payload's
 * own first word -- the marker ladder's cell), so the answer is a
 * four-way verdict: the monitor's [20 9F] unknown-command tag (stock
 * never sends it -- liveness), the staged word pristine (the code was
 * fine; the monitor died before or at its first instruction), a small
 * marker value 0x000k (the monitor RAN and died in block k -- the
 * ladder names it), or zeros/junk (the payload never survived, or the
 * span is written by something on the real unit). Older and odder
 * flavors are named too.
 * @param {number[]} last
 * @returns {string}
 */
function relayDiagnoseLast(last) {
  const b = relayBlob_;
  if (b.mode === 'probe') return relayDiagnoseProbe(last);
  if (last.length >= 8 && last.every((v, i) => v === b.expectLast[i]))
    return (
      'the monitor itself answered the readback probe -- alive at ' +
      'the final step'
    );
  if (
    last[0] === 0x20 &&
    last[1] === 0x81 &&
    last[2] === b.probeWord[0] &&
    last[3] === b.probeWord[1]
  )
    return (
      'the staged code is intact and survived the reset -- the monitor ' +
      'died before or at its first instruction (the first instruction ' +
      'itself is the killer, not staging)'
    );
  if (
    last[0] === 0x20 &&
    last[1] === 0x81 &&
    last[3] === 0 &&
    last[2] === b.markers.length
  )
    return (
      'the monitor RAN, went DEAF (no command ever reached it) and ' +
      'self-rescued: it reset the transmission cleanly when its silence ' +
      'deadline fired, so the box came back by itself -- the monitor ' +
      'lives; its CAN receive never armed on this box'
    );
  // 01 00 doubles as the boot's own reset counter: on real silicon every
  // reset flavor (the deaf monitor's deadline SRST, or a dead monitor's
  // watchdog) funnels through the boot, which rewrites the span -- so a
  // readback of 1 means "the box reset", and the two tell apart only by
  // how the run FELT (below), not by this word
  if (last[0] === 0x20 && last[1] === 0x81 && last[2] === 1 && last[3] === 0)
    return (
      'word 0 came back 01 00 -- a boot value, not the staged pad: the ' +
      'transmission had reset by the time of the readback and no monitor ' +
      'answered the tail. Died at entry (a fast reset) or ran deaf and ' +
      'self-rescued (the clicking stopped by itself after about a minute)'
    );
  if (
    last[0] === 0x20 &&
    last[1] === 0x81 &&
    last[3] === 0 &&
    last[2] >= 2 &&
    last[2] < b.markers.length
  )
    return (
      `the monitor RAN and died in the "${b.markers[last[2] - 1]}"` +
      ` block (marker ${last[2]} of ${b.markers.length})`
    );
  if (last[0] === 0x20 && last[1] === 0x81 && last[2] === 0 && last[3] === 0)
    return (
      'word 0 read back zeros: the boot rewrote the span after a reset ' +
      '-- no monitor answered the tail (stock did). Either it died at ' +
      'entry (the box reset fast) or it ran deaf and its silence ' +
      'deadline rescued it (about a minute of clicking, then it stopped ' +
      'by itself)'
    );
  if (last[0] === 0x2a && last[1] === 0x81)
    return (
      'an echo answer: this verdict block is from the previous ' +
      "build's run (its table ended at the echo; re-run to refresh it)"
    );
  if (last[0] === 0x20 && last[1] === 0x81)
    return (
      `word 0 came back ${last[2].toString(16)} ${last[3].toString(16)} ` +
      '-- a boot value, not the staged pad: the transmission had reset ' +
      'by the time of the readback and no monitor answered the tail'
    );
  if (last[1] === 0x81)
    return (
      'the stock program is answering (class ' +
      `${last[0].toString(16)} reply), not the monitor`
    );
  if (last.every((v) => v === 0)) return 'no answer was ever recorded';
  return 'an answer neither the monitor nor the stock program formats';
}

/**
 * Judge a read state block against the blob's expectations: the service
 * ran to its last step and finished, every answering step was answered,
 * and all but two were acked -- the SP-redirect step answers nothing by
 * design, and the final readback is answered with the monitor's 0x9F
 * tag rather than an 0x81 ack, hence good = steps - 2. The last answer
 * must be the monitor's own readback reply: byte-exact liveness.
 * @param {ReturnType<typeof relayDecodeState>} s
 * @returns {{ok: boolean, checks: {what: string, ok: boolean}[],
 *   note: string}} note describes the last answer's meaning
 */
function relayVerdict(s) {
  const b = relayBlob_;
  const checks = [
    { what: 'magic', ok: s.magic === b.magic },
    { what: 'steps', ok: s.step === b.steps },
    { what: 'done', ok: s.phase === 2 },
    { what: 'replies', ok: s.replies === b.expectReplies },
    { what: 'ok answers', ok: s.good === b.expectGood },
    {
      what: 'last answer',
      ok:
        s.last.length === b.expectLast.length &&
        s.last.every((v, i) => v === b.expectLast[i]),
    },
  ];
  return {
    ok: checks.every((c) => c.ok),
    checks,
    note: relayDiagnoseLast(s.last),
  };
}

/** The service's own duration once the patched DME boots (ms).
 * Add reconnect slack before reading the verdict block. */
function relayServiceMs() {
  return relayBlob_.steps * relayBlob_.stepMs;
}

if (typeof module !== 'undefined' && module.exports)
  module.exports = {
    relayPatchPair,
    relayDecodeState,
    relayReadState,
    relayVerdict,
    relayDiagnoseLast,
    relayServiceMs,
    relayAwaitVerdict,
  };
