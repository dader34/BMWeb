/**
 * @file One request/answer exchange: echo handling, frame assembly,
 * response-pending polling, bus pacing and the single retransmission.
 *
 * Shared by both transports, because the protocol does not change with the
 * plumbing -- each transport only supplies exchangeRaw (write + read) and
 * ensureConfig (port settings); everything else lives here.
 */
/* exported readFrame, runExchange */

/** How long readFrame idles between empty reads while waiting for bytes. */
const RX_POLL_MS = 4;
/**
 * Once an answer has STARTED, the least it gets to finish. ParTimeoutStd is
 * time-to-first-byte; a fault memory at 9600 baud needs ~250 ms of wire time
 * after that and must not be cut off by a 500 ms answer timeout it already met.
 */
const FRAME_COMPLETE_MIN_MS = 3000;
/** The answer timeout when an SGBD's CommParameter names none. */
const DEFAULT_TIMEOUT_MS = 2000;
/** The most a `wait` in the SGBD may stall the bus before a write. */
const WAIT_CAP_MS = 5000;
/** ParRegenTime above this is a bogus blob, not a pacing rule. */
const REGEN_MAX_MS = 1000;
/** The floor for ParTimeoutNr78 when the SGBD names none (a slow routine). */
const NR78_MIN_MS = 5000;
/** How many "response pending" polls a stuck ECU gets before it fails. */
const MAX_PENDING_POLLS = 30;
/** An answer slower than this is noted in the console, with the page's state. */
const SLOW_ANSWER_MS = 200;
/** What a page that is not in front adds to every telegram's budget: its own late wake-ups. */
const HIDDEN_PAGE_ALLOWANCE_MS = 500;
/** Send once, retransmit once: EDIABAS's single-glitch cover. */
const EXCHANGE_ATTEMPTS = 2;
/** KWP negative response service id. */
const NEGATIVE_RESPONSE = 0x7f;
/** The negative-response code meaning "still working, ask again". */
const RESPONSE_PENDING = 0x78;
/**
 * The negative-response code meaning "busy, re-send the request". Unlike
 * 0x78 (wait, the answer will arrive on its own) a 0x23 wants the TESTER to
 * ask again. The MS45 DME answers 0x23 to the security-access key while its
 * RSA check runs (~2 s): without this the key check saw 7F 31 23 as the
 * final answer and reported the DME "refused the key", flakily, depending
 * on whether a generic retransmit happened to re-fire in time.
 */
const BUSY_REPEAT = 0x23;
/** How many times a "busy, ask again" is re-sent before it is given up on. */
const MAX_BUSY_REPEATS = 30;
/** KWP TransferData: one block of a flash write. */
const TRANSFER_DATA = 0x36;
/**
 * The least a flash block gets to be answered: the P2max the flasher sets
 * for its programming session (ACCESS_TIMING_PARAMETER, 83 03 00 78 = 120
 * x 25 ms). The DME answers a block in ~60 ms of its own time, but now and
 * then takes ~670 ms writing one; a 500 ms ParTimeoutStd called that DME
 * silent in the middle of a program flash (block 0xBB, over the THOR) and
 * the flash stopped with the program half written.
 */
const TRANSFER_ANSWER_MS = 3000;
/**
 * The quiet gap before a flash block (TransferData) instead of the SGBD's
 * ParRegenTime. A TransferData only happens in a programming session, whose
 * access timing the flasher negotiated: the MS45 loader's P3min is exactly
 * 12 ms (its limits say so, and it refuses any other value), and a request
 * sent sooner is silently dropped and only taken on the retransmit, a whole
 * answer timeout later. 14 ms keeps a margin over the 12 for the cable's
 * and the page's own lateness; the SGBD's 25 ms is 13 ms a block of nothing,
 * a sixth of a flash. Measured on the emulated loader (ms45-emu).
 */
const TRANSFER_GAP_MS = 14;

/**
 * Pull whatever the port has right now.
 * @callback PumpFn
 * @returns {Promise<ArrayLike<number>|null|undefined>} Bytes, or nothing yet.
 */

/**
 * Read one answer off the K line.
 *
 * The K line is HALF DUPLEX: one wire, so everything written is also heard
 * back. Drop exactly as many bytes as were sent rather than pattern-matching
 * the echo -- a request and its answer can legitimately share a prefix, and
 * the reference interface drops by count for the same reason.
 *
 * A WIRED K LINE ALWAYS ECHOES. "Adapter echo" in the reference stack refers
 * to a REMOTE adapter (Bluetooth/WiFi) that strips the echo for you; an FTDI
 * cable on a half-duplex wire does not, so the echo is always here and is
 * always dropped by count.
 *
 * @param {number[]|null} sent - The exact request written, or null when
 *   re-reading a continuation frame, which has no echo of its own.
 * @param {number} timeoutMs - ParTimeoutStd: how long the ECU may take to
 *   START answering.
 * @param {PumpFn} pump - Reads whatever the port has buffered.
 * @param {CommParams} comm - The request's wire parameters (framing rules).
 * @returns {Promise<number[]>} The complete, checksum-verified answer frame.
 * @throws {Error} IFH-0003 when the echo never matches, IFH-0019 on a
 *   truncated or mis-signed frame, IFH-0009 on silence.
 */
async function readFrame(sent, timeoutMs, pump, comm) {
  const buf = [];
  const echoLen = sent ? sent.length : 0;
  const deadline = Date.now() + timeoutMs;

  // Where does `sent` start inside buf? -1 while it is not (yet) all here.
  const findEcho = () => {
    for (let start = 0; start + echoLen <= buf.length; start++) {
      let ok = true;
      for (let i = 0; i < echoLen; i++) {
        if (buf[start + i] !== sent[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return start;
    }
    return -1;
  };

  // READ UNTIL THE ECHO IS ACTUALLY THERE, not merely until enough bytes have
  // arrived. A half-duplex K line delivers the echo split across reads and
  // often with a leftover byte in front of it -- "12 04 00 16" came back as
  // "00 12 04 00" then "16" on the next read. Stopping at buf.length >=
  // echoLen left the echo one byte short, the compare failed, and a healthy
  // exchange was reported as IFH-0003.
  let at = -1;
  while (Date.now() < deadline) {
    if (echoLen && (at = findEcho()) >= 0) break;
    if (!echoLen && buf.length) break;
    const got = await pump();
    if (got && got.length) buf.push(...got);
    else await bmwSleep(RX_POLL_MS);
  }
  if (echoLen && at < 0) {
    // what came back instead of the echo is the whole diagnosis (a clipped
    // last byte, a late answer from the previous address, line noise), so it
    // goes into the wire ring and the first bytes into the message
    if (buf.length)
      busTrace.add('rx', buf.slice(0, 48), "not the request's echo");
    const got =
      busTrace.hex(buf.slice(0, 12)) + (buf.length > 12 ? ' ...' : '');
    throw ifhError(
      'IFH-0003',
      buf.length
        ? `echo did not match the request (bus collision?): got ${got}`
        : 'no echo from the cable (is it connected to the car?)'
    );
  }
  buf.splice(0, at >= 0 ? at + echoLen : 0); // drop leading noise AND the echo
  // timeoutMs is ParTimeoutStd: how long the ECU may take to START answering.
  // EDIABAS ends the frame on inter-byte silence (ParTimeoutTelEnd), not on
  // that budget -- so once the first byte is here, a long answer at 9600 baud
  // (a fault memory: ~250 ms of wire time) must not be cut off by a 500 ms
  // answer timeout that it already met. Judge silence at timeoutMs; give a
  // started frame its own completion budget.
  const completionBudget = () =>
    Date.now() + Math.max(timeoutMs, FRAME_COMPLETE_MIN_MS);
  let frameDeadline = deadline;
  let started = buf.length > 0;
  if (started) frameDeadline = completionBudget();
  while (Date.now() < frameDeadline) {
    const total = frameTotal(buf, comm);
    if (total !== null && buf.length >= total) {
      const frame = buf.slice(0, total);
      verifyChecksum(frame, comm);
      return frame;
    }
    const got = await pump();
    if (got && got.length) {
      buf.push(...got);
      if (!started) {
        started = true;
        frameDeadline = completionBudget();
      }
    } else await bmwSleep(RX_POLL_MS);
  }
  // A half-received frame is NOT an answer -- handing it to the VM decodes
  // garbage. Distinguish it from silence so the error means something.
  throw buf.length
    ? ifhError('IFH-0019', `incomplete answer from ECU (${buf.length} bytes)`)
    : ifhError('IFH-0009', 'no answer from ECU (timeout)');
}

/**
 * "Response pending": an ECU that needs longer than its declared timeout
 * answers 7F <service> 78 and keeps the request alive. EDIABAS waits for
 * the real answer instead of failing; a flash or a long routine depends on
 * it. The payload offset follows the same framing rules as frameTotal:
 * DS2 puts it at 2, KWP2000* behind its 4-byte header, BMW-FAST at 3 for
 * the short form and 4 for the long form (len byte at [3]) -- a long-frame
 * 7F..78 sliced at 3 was returned to the VM as the final answer.
 * @param {number[]} frame - A complete answer frame.
 * @param {CommParams} comm - The request's wire parameters.
 * @returns {boolean} True when the ECU asked for more time.
 */
function negativeBody(frame, comm) {
  const c = conceptOf(comm);
  if (isDs2(c)) return frame.slice(2);
  if (c === 0x10d) return frame.slice(4);
  if (frame[0] === 0xb8) return frame.slice(4);
  return frame[0] & 0x3f ? frame.slice(3) : frame.slice(4);
}

function isResponsePending(frame, comm) {
  const body = negativeBody(frame, comm);
  return body[0] === NEGATIVE_RESPONSE && body[2] === RESPONSE_PENDING;
}

/**
 * "Busy, ask again": the ECU answers 7F <service> 23 and expects the tester
 * to RE-SEND the request (not wait, as for 0x78). Same framing rules as
 * isResponsePending.
 * @param {number[]} frame - A complete answer frame.
 * @param {CommParams} comm - The request's wire parameters.
 * @returns {boolean} True when the ECU wants the request re-sent.
 */
function isBusyRepeat(frame, comm) {
  const body = negativeBody(frame, comm);
  return body[0] === NEGATIVE_RESPONSE && body[2] === BUSY_REPEAT;
}

/**
 * The quiet gap an SGBD demands between an answer and the next request.
 * CommParameter dword 3 on the 0x1xx concepts (ParRegenTime); the DS2 case
 * reads index 6 of its own 16-bit layout -- Best2Vm.decodeCommParams picks
 * the concept's own index. Clamped, because a bogus blob must not stall the
 * bus.
 * @param {CommParams|null|undefined} comm - The telegram's wire parameters.
 * @returns {number} Milliseconds of quiet, 0 when none or out of range.
 */
function regenTimeOf(comm) {
  const raw = comm && comm.regen != null ? comm.regen : 0;
  return raw > 0 && raw <= REGEN_MAX_MS ? raw : 0;
}

/**
 * Honour the pacing an exchange owes the bus before its write: a `wait` the
 * SGBD issued, and ParRegenTime measured from the ECU's last answer.
 *
 * ParRegenTime is a MANDATORY quiet gap between the ECU's last answer and the
 * next request, measured from the response. The SGBD names it in its
 * CommParameter -- 25 ms for this MS45 on concept 0x10D. Without it a
 * telegram sent immediately after a reply is ignored, which is exactly what
 * made a repeated FS_LESEN come back empty while the identical first one was
 * answered.
 * @param {Transport} bus - The transport, for its lastResponseAt.
 * @param {CommParams} comm - The telegram's wire parameters.
 * @param {number} [capMs] - A shorter gap this request is known to be
 *   allowed (a flash block's TRANSFER_GAP_MS); never longer than the SGBD's.
 * @returns {Promise<void>}
 */
async function paceBeforeWrite(bus, comm, capMs) {
  // a `wait` in the SGBD paces the bus: honor it before writing
  if (comm && comm.waitMs) {
    await bmwSleep(Math.min(comm.waitMs, WAIT_CAP_MS));
  }
  let regenMs = regenTimeOf(comm);
  if (capMs != null && regenMs > capMs) regenMs = capMs;
  if (regenMs && bus.lastResponseAt) {
    const since = Date.now() - bus.lastResponseAt;
    if (since < regenMs) {
      await bmwSleep(regenMs - since);
    }
  }
}

/**
 * One request/answer exchange with per-concept retry. EDIABAS retransmits
 * on a bad or missing answer (xreps); one retry covers the single-glitch
 * case without hammering a dead bus.
 *
 * EVERY xsetpar RECONFIGURES THE WIRE. That is what the opcode is for, and
 * EDIABAS honours each one: tracing this car showed it set concept 0x10F at
 * 115200, send the short telegram, get silence, then set concept 0x10D at
 * 9600 and send the long one -- which is answered. So the wire follows each
 * telegram's own xsetpar; sessionConcept is tracked only so the K-line wake
 * knows it is on a K-line module.
 *
 * NO FRAMING FALLBACK HERE. The SGBD owns that: tracing EDIABAS showed
 * ms450ds0's INITIALISIERUNG hold BOTH telegrams as constants and try them
 * in turn -- xsend "82 12 F1 1A 80" gets IFH-0009, the bytecode carries on,
 * and xsend "B8 12 F1 02 1A 80" is answered. So a timed-out exchange must be
 * reported to the VM, not retried behind its back with a rewritten telegram.
 *
 * @param {Transport} bus - The transport to drive.
 * @param {ArrayLike<number>} out - The request without its checksum.
 * @param {CommParams} comm - The request's wire parameters.
 * @returns {Promise<number[]>} The answer frame.
 * @throws {Error} The last IFH error when both attempts fail, or the first
 *   error that is not a garbled answer.
 */
async function runExchange(bus, out, comm) {
  // An ADS-only concept (1, 2, 3) fails here with its reason, before the
  // port is touched -- the reference refuses them the same way (IFH-0006).
  assertReachable(comm);
  bus.sessionConcept = conceptOf(comm);
  await bus.ensureConfig(portConfig(comm));
  const framed = withChecksum(out, comm);
  // ParTimeoutStd is the ECU's budget to start answering. A page that is
  // not in front gets its wake-ups (the port's next chunk, the worker's
  // timers) delivered late: measured on a flash, +150..200 ms on every
  // exchange, which turned a 340 ms answer into a miss of a 500 ms budget
  // at random blocks. That lateness is the browser's, not the ECU's, so a
  // hidden page waits that much longer before calling the ECU silent.
  const hidden =
    typeof document !== 'undefined' && document.visibilityState === 'hidden';
  // an emulated DME (the gateway's or the adapter's emulator) runs slower
  // than the real one and says so through its port: its telegrams get
  // what it asks for on top, the car's none
  const emulated = (bus.port && bus.port.timeoutAllowanceMs) || 0;
  const transfer =
    !isDs2(conceptOf(comm)) && negativeBody(framed, comm)[0] === TRANSFER_DATA;
  const timeoutMs =
    Math.max(
      (comm && comm.timeout) || DEFAULT_TIMEOUT_MS,
      transfer ? TRANSFER_ANSWER_MS : 0
    ) +
    (hidden ? HIDDEN_PAGE_ALLOWANCE_MS : 0) +
    emulated;
  // xreps: the SGBD's own retransmit count (CommRepeats). The reference
  // sends a telegram repeats + 1 times, on silence as well as on a garbled
  // answer, and stops early only on a cable-level IFH-0003. A garbled
  // answer always gets the one retransmit it had before, even for an SGBD
  // that asked for none.
  const repeats = Math.max(0, (comm && comm.repeats) | 0);
  // A telegram may forbid retransmission entirely: the MS45 live-tune SAVE
  // op is answered by SILENCE (the DME folds the calibration and resets), so
  // a retransmit is a SECOND save fired at a DME that has already rebooted
  // with nothing open -- seen on a bench to cause repeated resets and revert
  // the saved value. Such a telegram gets exactly one attempt.
  const attempts =
    comm && comm.noRetransmit ? 1 : Math.max(EXCHANGE_ATTEMPTS, repeats + 1);
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // the retry is a pure retransmission after the regeneration wait,
    // never a reinit; a flash block gets the programming session's gap
    await paceBeforeWrite(bus, comm, transfer ? TRANSFER_GAP_MS : undefined);
    const sentAt = Date.now();
    try {
      busTrace.add(
        'tx',
        framed,
        `${attempt ? 'retransmit' : 'tx'} timeout=${timeoutMs}ms`
      );
      const askedAt = Date.now();
      let frame = await bus.exchangeRaw(framed, timeoutMs, comm);
      // the wall-clock side, for a flash that dies on one slow answer: an
      // answer that took a good part of its budget is noted in the console
      // with the page's state at the time
      if (Date.now() - askedAt > SLOW_ANSWER_MS)
        console.warn(
          `[kline] ${out[0].toString(16).padStart(2, '0')} answered after ${Date.now() - askedAt} ms (budget ${timeoutMs} ms, attempt ${attempt + 1}/${attempts}, page ${typeof document !== 'undefined' ? document.visibilityState : '?'})`
        );
      // keep reading while the ECU says "still working" -- bounded, so a
      // stuck ECU still fails instead of hanging the screen
      for (
        let pending = 0;
        pending < MAX_PENDING_POLLS && isResponsePending(frame, comm);
        pending++
      ) {
        // ParTimeoutNr78: how long the ECU may say "busy" between polls
        frame = await bus.exchangeRaw(
          null,
          (comm && comm.timeoutNr78) || Math.max(timeoutMs, NR78_MIN_MS),
          comm
        );
      }
      // "busy, ask again" (7F xx 23): re-SEND the request, not just read. The
      // MS45 security-access key check answers busy for ~2 s while its RSA
      // runs, and a key re-sent inside that window is answered with another
      // busy OR with SILENCE -- the ECU is mid-computation and says nothing.
      // Both mean "still working", so both are re-sent, bounded, as the
      // reference tester does; only a cable fault or a garble is a real error.
      // The re-send uses the ordinary timeout, not NR78: a silent one should
      // come back quickly so the next ask lands as soon as the ECU is ready.
      for (
        let busy = 0;
        busy < MAX_BUSY_REPEATS && isBusyRepeat(frame, comm);
        busy++
      ) {
        await paceBeforeWrite(bus, comm);
        busTrace.add('tx', framed, `busy, re-sending (${busy + 1})`);
        try {
          frame = await bus.exchangeRaw(framed, timeoutMs, comm);
          for (
            let pending = 0;
            pending < MAX_PENDING_POLLS && isResponsePending(frame, comm);
            pending++
          ) {
            frame = await bus.exchangeRaw(
              null,
              (comm && comm.timeoutNr78) || Math.max(timeoutMs, NR78_MIN_MS),
              comm
            );
          }
        } catch (e) {
          // silence while the ECU is busy is not a failure: keep asking.
          // `frame` still holds the last 7F..23, so the loop re-enters. A
          // cable fault or a garbled answer is a real error -- let it out.
          if (!e || e.ifh !== 'IFH-0009') throw e;
          lastErr = e;
        }
      }
      // ran out of re-sends with the ECU still saying busy: a real failure,
      // not a 7F..23 handed back to the job as though it were the answer
      if (isBusyRepeat(frame, comm))
        throw lastErr || ifhError('IFH-0009', 'ECU stayed busy (no answer)');
      busTrace.add('rx', frame, 'OK');
      bus.lastResponseAt = Date.now();
      return frame;
    } catch (e) {
      lastErr = e;
      busTrace.add('err', null, `${e.ifh || ''} ${e.message}`.trim());
      console.warn(
        `[kline] ${out[0].toString(16).padStart(2, '0')} ${e && e.ifh ? e.ifh : 'failed'} after ${Date.now() - sentAt} ms (budget ${timeoutMs} ms, attempt ${attempt + 1}/${attempts}, page ${typeof document !== 'undefined' ? document.visibilityState : '?'}): ${e && e.message}`
      );
      // The error carries its IFH code: a garbled answer is IFH-0019
      // (checksum / incomplete), a cable fault IFH-0003 (echo), silence
      // IFH-0009. A cable fault is final, as in the reference loop. A
      // garbled answer is retransmitted once regardless (a K-line glitch),
      // and beyond that, silence and garbling alike are retransmitted only
      // as many times as the SGBD asked for with xreps: an SGBD that set
      // none sends a silent telegram exactly once and its bytecode moves on
      // to the next protocol (ms450ds0's KWP2000* try before the BMW-FAST
      // one), which is what keeps variant probing quick.
      if (!e || e.ifh === 'IFH-0003') throw e;
      const garbled = e.ifh === 'IFH-0019';
      const spent = attempt + 1;
      if (garbled ? spent >= attempts : spent > repeats) throw e;
      // The reference retry is a PURE RETRANSMISSION: the same bytes with
      // only the ParRegenTime wait, never a reinit. Re-arming the wake here
      // made our retry a different, more disruptive operation than the one
      // EDIABAS performs -- and on DS2 there is no wake to re-arm in the
      // first place.
    }
  }
  // a port that is not a K+DCAN cable never echoes: name it in the error
  // instead of asking whether the cable is plugged into the car
  if (
    lastErr &&
    lastErr.ifh === 'IFH-0003' &&
    /no echo/.test(lastErr.message) &&
    bus &&
    typeof bus.portHint === 'function'
  ) {
    const hint = bus.portHint();
    if (hint && !lastErr.message.includes(hint)) lastErr.message += hint;
  }
  throw lastErr;
}
