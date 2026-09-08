/**
 * @file Concept-aware framing: which checksum, which length rule and which
 * port settings each EDIABAS concept uses.
 *
 * The SGBD's telegram EXCLUDES its trailing checksum -- appending it is the
 * interface's job (learned the hard way: a request one byte short is silently
 * discarded by a real ECU). Framing per concept, from each job's xsetpar
 * CommParameter {concept, baud, timeout}, verified against data/sim-captures:
 *
 *   1/5/6   DS2 family   9600 8E1   XOR checksum   answer[1] = total length
 *   0x10D   KWP2000*     9600 8E1   sum8           answer[3] + 5 = total
 *   0x10F   BMW-FAST   115200 8N1   sum8           header short/long form
 *   0x110   D-CAN      115200 8N1   sum8           (CAN cable, BMW-FAST serial)
 *   0x10C   ISO 9141   10400 8N1   sum8           after a 5-baud slow init
 *
 * The wire is described by the SGBD's set_communication_pars and nothing
 * else. A telegram with no CommParameter behind it has no baud, no checksum
 * rule and no length rule -- EDIABAS refuses it (IFH-0056), so do we, rather
 * than assume BMW-FAST and sign a DS2 request with the wrong checksum.
 */
/* exported KDCAN, UTILITY_NOMINAL_MV, KLINE_DEFAULT_BAUD, conceptOf, isDs2, isIso9141, isKline, isBmwFast, assertReachable, ISO9141_INIT_ADDR, ISO9141_BAUD, ifhError, withChecksum, frameTotal, verifyChecksum, portConfig */

/**
 * The wire parameters an SGBD declares with xsetpar (Best2Vm.decodeCommParams),
 * carried beside every telegram so the transport can frame, sign and pace it.
 * @typedef {object} CommParams
 * @property {number} concept - EDIABAS concept: 1/5/6 DS2, 0x10C ISO 9141,
 *   0x10D KWP2000*, 0x10F BMW-FAST, 0x110 D-CAN.
 * @property {number} [baud] - The rate the SGBD names (CommParameter[1]).
 * @property {number|null} [timeout] - ParTimeoutStd: ms the ECU may take to
 *   START answering.
 * @property {number|null} [regen] - ParRegenTime: ms of quiet the ECU needs
 *   after its answer before the next request.
 * @property {number|null} [telEnd] - ParTimeoutTelEnd (inter-byte silence).
 * @property {number|null} [timeoutNr78] - ParTimeoutNr78: ms the ECU may say
 *   "busy" (7F xx 78) between polls.
 * @property {number[]} [answerLen] - The DS2 xawlen rule: [offset|length, add].
 * @property {number} [waitMs] - A `wait` the SGBD issued before this telegram.
 * @property {number[]} [params] - The raw CommParameter words.
 */

/**
 * Web Serial / native port settings.
 * @typedef {object} PortConfig
 * @property {number} baudRate - Bits per second.
 * @property {number} dataBits - Always 8 here.
 * @property {number} stopBits - Always 1 here.
 * @property {'none'|'even'} parity - 8N1 for BMW-FAST/ISO 9141, 8E1 on the K line.
 * @property {boolean} [dtr] - The IDLE level of DTR for this concept: high on
 *   BMW-FAST/D-CAN, low on every K-line concept (see portConfig).
 */

/**
 * K+DCAN over Web Serial. Default until a job's SGBD declares its own via
 * xsetpar: BMW-FAST 115200 8N1 (the USB cable's default concept), DTR high.
 * @type {PortConfig}
 */
const KDCAN = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  dtr: true,
};
/**
 * UTILITY.PRG's own number, read out of its BEST/2 bytecode: UTILITY /
 * INTERFACE substitutes 12000 mV when the interface cannot measure at all,
 * and STATUS_UBATT / STATUS_ZUENDUNG both compare the adapter's sense reading
 * against 10000 mV (`comp L0, 10000` / `jae`), so the nominal value reads as
 * "on".
 */
const UTILITY_NOMINAL_MV = 12000;
/** The K-line rate EDIABAS falls back to when an SGBD names none (8E1). */
const KLINE_DEFAULT_BAUD = 9600;

/**
 * The concept a telegram rides on, or IFH-0056 when the SGBD never set one.
 * @param {CommParams|null|undefined} comm - The telegram's wire parameters.
 * @returns {number} The concept id.
 * @throws {Error} IFH-0056 when no CommParameter precedes the telegram.
 */
const conceptOf = (comm) => {
  if (!(comm && comm.concept)) {
    throw ifhError('IFH-0056', 'no CommParameter set before the telegram');
  }
  return comm.concept;
};
/**
 * Is this a DS2-family concept (1, 5, 6)?
 * @param {number} c - The concept id.
 * @returns {boolean}
 */
const isDs2 = (c) => c === 1 || c === 5 || c === 6;
/**
 * ISO 9141-2: the module sleeps until a 5-baud address byte wakes it.
 * @param {number} c - The concept id.
 * @returns {boolean}
 */
const isIso9141 = (c) => c === 0x10c;
/**
 * Concepts that ride the K line and therefore need DTR as transmit enable.
 * DS2 and KWP2000* are K-line; BMW-FAST/D-CAN (0x10F/0x110) are not.
 * @param {number} c - The concept id.
 * @returns {boolean}
 */
const isKline = (c) => isDs2(c) || c === 0x10d;
/**
 * BMW-FAST (0x10F) and D-CAN (0x110): the two concepts on which the reference
 * interface holds DTR HIGH for the whole session on a plain FTDI/COM cable
 * (`stateDtr = HasAdapterEcho`, set in exactly these two cases and nowhere
 * else). Every other concept idles with DTR low.
 * @param {number} c - The concept id.
 * @returns {boolean}
 */
const isBmwFast = (c) => c === 0x10f || c === 0x110;
/**
 * Concepts that only the old BMW ADS interface can drive: concept 1, concept
 * 2 (ISO 9141 / KWP1281 5-baud) and concept 3. They need the L line on OBD
 * pin 20 and ADS-style line control; the reference interface refuses all
 * three on any echoing adapter ("only with ADS adapter", IFH-0006), and a
 * K+DCAN cable is one. The 76 SGBDs that declare them are the early E31,
 * E34, E36, E38 and E39 modules (Motronic 1.7 to 5.2.1, DDE 2.1, ZF EGS,
 * the first ABS and IHKA). Refusing here, with the reason, beats signing a
 * request the cable can never deliver and reporting "no answer".
 */
const ADS_ONLY_CONCEPTS = new Set([1, 2, 3]);
/**
 * Refuse a concept this cable cannot physically reach, before anything is
 * configured or written.
 * @param {CommParams|null|undefined} comm - The telegram's wire parameters.
 * @throws {Error} IFH-0006 for an ADS-only concept.
 */
function assertReachable(comm) {
  const c = conceptOf(comm);
  if (ADS_ONLY_CONCEPTS.has(c)) {
    throw ifhError(
      'IFH-0006',
      `concept ${c} needs the ADS interface (L line, OBD pin 20); ` +
        'a K+DCAN cable cannot reach this module'
    );
  }
}
/**
 * Verified on a real E46 (M54 / MS45): the DME answers the ISO 9141 generic
 * tester address at 10400 baud, NOT its own KWP address at 9600. Sending a
 * job to an unwoken module gets silence, which surfaced as IFH-0009 "no
 * response" and looked for all the world like a wiring fault.
 */
const ISO9141_INIT_ADDR = 0x33;
/**
 * The rate an E46 K-line module actually answers on after the slow or fast
 * init -- 9600 (either parity) stays silent even after a successful wake.
 */
const ISO9141_BAUD = 10400;

/**
 * Build an interface failure carrying its EDIABAS IFH identity, so
 * explainError and a user comparing to real INPA see the same code (IFH-0009
 * no answer, -0003 line/echo, -0019 truncated). SGBD-level ERROR_ECU_* stay
 * the jobs' business.
 * @param {string} code - The IFH code, e.g. 'IFH-0009'.
 * @param {string} message - What went wrong, in plain words.
 * @returns {Error & {ifh: string}} The error, tagged with `ifh`.
 */
function ifhError(code, message) {
  const e = new Error(`${code}: ${message}`);
  e.ifh = code;
  return e;
}

/**
 * Which EDIABAS transmit function a concept runs, and therefore its checksum
 * and its answer-length rule (the reference interface's `switch (concept)`
 * that sets ParTransmitFunc):
 *   1, 5, 6            TransDs2         XOR    length from xawlen (TelLengthDs2)
 *   0x10D KWP2000*     TransKwp2000S    XOR    byte[3] + 4      (TelLengthKwp2000S)
 *   0x10B/0x10C/0x10F  TransKwp2000Bmw/ sum    TelLengthBmwFast
 *   0x110 D-CAN        TransBmwFast
 * Nothing here looks at the first byte of a frame to decide -- 0xB8 is just
 * the tester address KWP2000* and BMW-FAST both use.
 */
const XOR_CONCEPTS = new Set([1, 5, 6, 0x10d]);
/**
 * The reference interface's per-concept CommAnswerLen seed, used when an
 * SGBD never issues xawlen: [-o, k] = byte at offset o plus k.
 * @type {Record<number, [number, number]>}
 */
const DS_ANSWER_LEN_DEFAULT = { 1: [-2, 0], 5: [-1, 0], 6: [-1, 0] };
/** Concepts whose checksum is the 8-bit sum (see XOR_CONCEPTS). */
const SUM_CONCEPTS = new Set([0x10b, 0x10c, 0x10f, 0x110]);

/**
 * The checksum a concept puts after its telegram.
 * @param {ArrayLike<number>} bytes - The telegram without its checksum.
 * @param {number} c - The concept id.
 * @returns {number} XOR or sum8 of the bytes.
 * @throws {Error} IFH-0018 for a concept this interface cannot sign.
 */
function checksumOf(bytes, c) {
  let sum = 0;
  if (XOR_CONCEPTS.has(c)) {
    for (const b of bytes) sum ^= b;
    return sum;
  }
  if (SUM_CONCEPTS.has(c)) {
    for (const b of bytes) sum = (sum + b) & 0xff;
    return sum;
  }
  throw ifhError(
    'IFH-0018',
    `concept 0x${c.toString(16)} is not supported on this interface`
  );
}

/**
 * Append the concept's checksum to an outgoing telegram.
 * @param {ArrayLike<number>} out - The request as the SGBD built it.
 * @param {CommParams} comm - Its wire parameters.
 * @returns {number[]} The framed request, ready for the wire.
 */
function withChecksum(out, comm) {
  return [...out, checksumOf(out, conceptOf(comm))];
}

/**
 * Total frame length INCLUDING the checksum byte, or null while too few
 * bytes are in to know. Each rule is its EDIABAS TelLength* + 1.
 * @param {number[]} buf - The bytes received so far.
 * @param {CommParams} comm - The wire parameters of the request.
 * @returns {number|null} The frame length, or null while undecidable.
 * @throws {Error} IFH-0018 for an unsupported concept or a DS2 job with no
 *   answer-length rule at all.
 */
function frameTotal(buf, comm) {
  const c = conceptOf(comm);
  if (XOR_CONCEPTS.has(c) && c !== 0x10d) {
    // DS2: the rule the SGBD declared with xawlen (TelLengthDs2), or, when it
    // never did, EDIABAS's own default for the concept -- every xsetpar seeds
    // CommAnswerLen per concept (DS1/DS2 = [-1, 0] "byte 1 is the total
    // length", concept 1 = [-2, 0]) and xawlen only overrides it. The E46
    // steering-angle group d_0057 is 99 ops and never calls xawlen; refusing
    // its exchange here made the resolver log "bus-silent" for a sensor that
    // answers every time, and the scan printed "not installed".
    let al = comm && comm.answerLen;
    if (!al || !al.length) al = DS_ANSWER_LEN_DEFAULT[c];
    if (!al) {
      throw ifhError(
        'IFH-0018',
        'DS2 answer length not set by the SGBD (xawlen)'
      );
    }
    if (al[0] > 0) return al[0];
    const off = -al[0];
    return buf.length > off ? buf[off] + (al[1] || 0) : null;
  }
  // KWP2000* (0x10d): these answers always carry the B8 F1 12 address header,
  // so byte 0 (0xB8) is NOT a BMW-FAST length byte -- the length is byte 3,
  // and the frame is byte3 + 4 header + 1 checksum. Verified against a real
  // MS45 EDIABAS trace: byte3 0x1F -> 36 bytes, 0x41 -> 70, 0xFF -> 260. (Do
  // NOT apply TelLengthBmwFast's byte0-&-0x3F rule here: 0xB8 & 0x3F = 56
  // would force every answer to 60 bytes.)
  if (c === 0x10d) return buf.length >= 4 ? buf[3] + 4 + 1 : null;
  if (SUM_CONCEPTS.has(c)) {
    // TelLengthBmwFast -- length in the low 6 bits of byte 0, with byte 3 (or
    // bytes 4-5) as the long-form fallback.
    if (!buf.length) return null;
    const short = buf[0] & 0x3f;
    if (short) return short + 3 + 1;
    if (buf.length < 4) return null;
    if (buf[3] === 0)
      return buf.length >= 6 ? (buf[4] << 8) + buf[5] + 6 + 1 : null;
    return buf[3] + 4 + 1;
  }
  throw ifhError(
    'IFH-0018',
    `concept 0x${c.toString(16)} is not supported on this interface`
  );
}

/**
 * Check a complete frame's trailing checksum against its concept's rule.
 * @param {number[]} frame - The whole answer including its checksum byte.
 * @param {CommParams} comm - The wire parameters of the request.
 * @throws {Error} IFH-0019 on a mismatch.
 */
function verifyChecksum(frame, comm) {
  const want = checksumOf(frame.slice(0, -1), conceptOf(comm));
  if (want !== frame[frame.length - 1]) {
    throw ifhError('IFH-0019', 'answer checksum mismatch');
  }
}

/**
 * The port settings a concept's telegrams travel on.
 * @param {CommParams} comm - The telegram's wire parameters.
 * @returns {PortConfig} Baud, bits and parity for the port.
 */
function portConfig(comm) {
  const c = conceptOf(comm);
  if (isIso9141(c)) {
    // 8N1 after the handshake -- the init itself is bit-banged, not framed.
    // DTR idles low: the reference raises the idle level for BMW-FAST and
    // D-CAN only, never for 0x10C.
    return {
      baudRate: (comm && comm.baud) || ISO9141_BAUD,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      dtr: false,
    };
  }
  if (isKline(c)) {
    // DS2 and KWP2000* are 8E1 at the rate the SGBD names (concept 6 in the
    // reference interface: parity = Even, baudRate = CommParameter[1]). An
    // earlier 10400 8N1 override here came from an ISO 9141 experiment and
    // does not belong on these concepts. DTR idles LOW: held high it keeps
    // the cable transmitting and the answer is lost (real E46, MS45).
    return {
      baudRate: (comm && comm.baud) || KLINE_DEFAULT_BAUD,
      dataBits: 8,
      stopBits: 1,
      parity: 'even',
      dtr: false,
    };
  }
  // BMW-FAST / D-CAN: 115200 8N1 with DTR held HIGH for the session, the way
  // the reference drives a plain cable (stateDtr = HasAdapterEcho). Dropping
  // it after a K-line probe and leaving it there is the one thing this
  // transport did differently from the reference on an E60/E65/E90 bus.
  return { ...KDCAN, dtr: isBmwFast(c) };
}
