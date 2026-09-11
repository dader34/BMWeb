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
/** Send once, retransmit once: EDIABAS's single-glitch cover. */
const EXCHANGE_ATTEMPTS = 2;
/** KWP negative response service id. */
const NEGATIVE_RESPONSE = 0x7f;
/** The negative-response code meaning "still working, ask again". */
const RESPONSE_PENDING = 0x78;

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
function isResponsePending(frame, comm) {
  const c = conceptOf(comm);
  let body;
  if (isDs2(c)) body = frame.slice(2);
  else if (c === 0x10d) body = frame.slice(4);
  else if (frame[0] === 0xb8) body = frame.slice(4);
  else body = frame[0] & 0x3f ? frame.slice(3) : frame.slice(4);
  return body[0] === NEGATIVE_RESPONSE && body[2] === RESPONSE_PENDING;
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
 * @returns {Promise<void>}
 */
async function paceBeforeWrite(bus, comm) {
  // a `wait` in the SGBD paces the bus: honor it before writing
  if (comm && comm.waitMs) {
    await bmwSleep(Math.min(comm.waitMs, WAIT_CAP_MS));
  }
  const regenMs = regenTimeOf(comm);
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
 * 9600 and send the long one -- which is answered. An earlier revision here
 * pinned the wire to the FIRST concept of a session, so the second xsetpar
 * was ignored, the B8 telegram went out at 115200 instead of 9600, and the
 * DME never heard it. The VM had reached the right branch all along.
 * sessionConcept is still tracked, but only so the K-line wake knows it is
 * on a K-line module; it no longer overrides the telegram's own wire.
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
  const timeoutMs = (comm && comm.timeout) || DEFAULT_TIMEOUT_MS;
  await paceBeforeWrite(bus, comm);
  let lastErr;
  for (let attempt = 0; attempt < EXCHANGE_ATTEMPTS; attempt++) {
    try {
      busTrace.add(
        'tx',
        framed,
        `${attempt ? 'retransmit' : 'tx'} timeout=${timeoutMs}ms`
      );
      let frame = await bus.exchangeRaw(framed, timeoutMs, comm);
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
      busTrace.add('rx', frame, 'OK');
      bus.lastResponseAt = Date.now();
      return frame;
    } catch (e) {
      lastErr = e;
      busTrace.add('err', null, `${e.ifh || ''} ${e.message}`.trim());
      // Retransmit a GARBLED answer once (a K-line glitch), never a SILENT
      // one: EDIABAS ships CommRepeats = 0, so a telegram nobody answers is
      // sent exactly once and the bytecode moves on to its next protocol.
      // Sending it twice doubled every probe step (ms450ds0's KWP2000* try
      // before the BMW-FAST one that an MS45 actually answers).
      // The error carries its IFH code; a garbled answer is IFH-0019
      // (checksum / incomplete) or IFH-0003 (echo), silence is IFH-0009.
      if (!(e && (e.ifh === 'IFH-0019' || e.ifh === 'IFH-0003'))) throw e;
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
