// Run the app with no server: static JSON for data, Web Serial for the bus.
// Replaces the two things the C# server did:
//   GET  /api/...        -> a frozen file in api/ (tools/web_export.py)
//   POST /api/.../run/X  -> the BEST2 VM (bestvm.js), talking to the cable
// The VM already runs a job against a `send(bytes)->bytes` callback, which is
// exactly a serial port; this only supplies the transport (framing, checksums,
// port settings). Loaded by every build; the C# hosts now only move bytes.

const WEB_API_BASE = 'api';

// ---------------------------------------------------------------- transport

// K+DCAN over Web Serial. Default until a job's SGBD declares its own via
// xsetpar: BMW-FAST 115200 8N1 (EdInterfaceObd's USB-cable concept).
const KDCAN = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };
// UTILITY.PRG's own numbers, read out of its BEST/2 bytecode: STATUS_UBATT and
// STATUS_ZUENDUNG both compare the adapter's sense reading against 10000 mV
// (`comp L0, 10000` / `jae`), and UTILITY/INTERFACE substitutes 12000 mV when
// the interface cannot measure at all.
const UTILITY_UBATT_MIN_MV = 10000;
const UTILITY_NOMINAL_MV = 12000;
// STATUS_ZUENDUNG's IDBSS branch (`move L0, 10000`, op132): the value UTILITY
// substitutes for an interface with no KL15 sense line, i.e. "report on".
const UTILITY_IDBSS_IGN_MV = 10000;

// ---- concept-aware framing.
//
// The SGBD's telegram EXCLUDES its trailing checksum -- appending it is the
// interface's job (learned the hard way: a request one byte short is silently
// discarded by a real ECU). Framing per concept, from each job's xsetpar
// CommParameter {concept, baud, timeout}, verified against data/sim-captures:
//
//   1/5/6   DS2 family   9600 8E1   XOR checksum   answer[1] = total length
//   0x10D   KWP2000*     9600 8E1   sum8           answer[3] + 5 = total
//   0x10F   BMW-FAST   115200 8N1   sum8           header short/long form
//   0x110   D-CAN      115200 8N1   sum8           (CAN cable, BMW-FAST serial)
//   0x10C   ISO 9141: needs a 5-baud slow init this transport cannot do yet,
//           so it refuses loudly rather than timing out mysteriously.
// The wire is described by the SGBD's set_communication_pars and nothing
// else. A telegram with no CommParameter behind it has no baud, no checksum
// rule and no length rule -- EDIABAS refuses it (IFH-0056), so do we, rather
// than assume BMW-FAST and sign a DS2 request with the wrong checksum.
const conceptOf = (comm) => {
  if (!(comm && comm.concept)) {
    throw ifhError('IFH-0056', 'no CommParameter set before the telegram');
  }
  return comm.concept;
};
const isDs2 = (c) => c === 1 || c === 5 || c === 6;
// ISO 9141-2: the module sleeps until a 5-baud address byte wakes it.
const isIso9141 = (c) => c === 0x10c;
// Concepts that ride the K line and therefore need waking before they answer.
// DS2 and KWP2000* are K-line; BMW-FAST/D-CAN (0x10F/0x110) are not.
const isKline = (c) => isDs2(c) || c === 0x10d;
// Verified on a real E46 (M54 / MS45): the DME answers the ISO 9141 generic
// tester address at 10400 baud, NOT its own KWP address at 9600. Sending a
// job to an unwoken module gets silence, which surfaced as IFH-0009 "no
// response" and looked for all the world like a wiring fault.
const ISO9141_INIT_ADDR = 0x33;
const ISO9141_BAUD = 10400;
// The rate an E46 K-line module actually answers on after the fast init.
const KLINE_BAUD = 10400;

// Interface failures carry their EDIABAS IFH identity so explainError and a
// user comparing to real INPA see the same code (IFH-0009 no answer, -0003
// line/echo, -0019 truncated). SGBD-level ERROR_ECU_* stay the jobs' business.
function ifhError(code, message) {
  const e = new Error(`${code}: ${message}`);
  e.ifh = code;
  return e;
}

// Sentinel for a readSome() that ran out of time. A distinct object rather
// than null, so "no bytes yet" can never be confused with a real empty read.
const TIMED_OUT = Symbol('timed-out');

// ---- wire tracing -----------------------------------------------------------
// Off by default (zero cost: every call site is behind `busTrace.on`). Turn it
// on from the console with `busTrace.start()`, run the failing action, then
// `busTrace.dump()` to print what actually went over the wire. This exists
// because a transport bug is invisible from the error text alone -- IFH-0003
// says "the echo was wrong" without ever showing you the echo.
const busTrace = {
  on: false,
  rows: [],
  limit: 400,
  // A small ALWAYS-ON ring buffer of the most recent wire activity, kept even
  // when verbose tracing is off (it is cheap -- a handful of {tag,hex,note}
  // objects). When an IFH error surfaces to the user, dumpRecent() prints this
  // so the failing telegrams are on the console without anyone having to have
  // run busTrace.start() first.
  recent: [],
  recentLimit: 60,
  start(limit) {
    this.on = true;
    this.rows = [];
    if (limit) this.limit = limit;
    console.log(
      '[bus] tracing ON — reproduce the failure, then busTrace.dump()'
    );
    return 'tracing';
  },
  stop() {
    this.on = false;
    return `tracing OFF (${this.rows.length} rows kept)`;
  },
  add(tag, bytes, note) {
    const row = {
      t: Date.now(),
      tag,
      hex: busTrace.hex(bytes),
      n: bytes ? bytes.length : 0,
      note,
    };
    // ring buffer: always on, bounded, drops the oldest
    this.recent.push(row);
    if (this.recent.length > this.recentLimit) this.recent.shift();
    // verbose buffer: only while explicitly tracing
    if (!this.on) return;
    if (this.rows.length >= this.limit) return;
    this.rows.push(row);
  },
  // Print the recent ring buffer -- called automatically when an IFH error
  // reaches the UI, or by hand. Labelled so it is obvious it is the auto-dump.
  dumpRecent(why) {
    if (!this.recent.length) return;
    const t0 = this.recent[0].t;
    console.groupCollapsed(
      `[bus] wire trace before ${why || 'error'} ` +
        `(${this.recent.length} rows) — expand for telegrams`
    );
    console.table(
      this.recent.map((r) => ({
        ms: r.t - t0,
        what: r.tag,
        len: r.n,
        bytes: r.hex,
        note: r.note || '',
      }))
    );
    console.groupEnd();
  },
  hex(b) {
    if (!b) return '';
    return Array.from(b, (x) =>
      (x & 0xff).toString(16).padStart(2, '0').toUpperCase()
    ).join(' ');
  },
  dump() {
    if (!this.rows.length) {
      console.log('[bus] nothing traced — busTrace.start() first');
      return;
    }
    const t0 = this.rows[0].t;
    console.table(
      this.rows.map((r) => ({
        ms: r.t - t0,
        what: r.tag,
        len: r.n,
        bytes: r.hex,
        note: r.note || '',
      }))
    );
    return `${this.rows.length} rows`;
  },
};
if (typeof window !== 'undefined') window.busTrace = busTrace;

// The API-LAYER trace: EDIABAS's api.trc equivalent. busTrace is ifh.trc (the
// raw telegrams); this is the layer above -- one row per job run, with its
// arguments, its result sets and the JOB_STATUS. Tool32's Trace window shows
// both layers; the wire tells you WHAT went over the bus, the API layer tells
// you what the JOB did with it. Recording is gated on `on` (Tool32's trace
// toggle sets it), matching how EDIABAS only writes the trace when the level
// is non-zero.
const apiTrace = {
  on: false,
  rows: [],
  limit: 500,
  start() {
    this.on = true;
    return 'api trace ON';
  },
  stop() {
    this.on = false;
    return 'api trace OFF';
  },
  clear() {
    this.rows = [];
  },
  // record one job: {sgbd, job, arg, sets, status, error, demo, t}
  add(entry) {
    if (!this.on) return;
    if (this.rows.length >= this.limit) return;
    this.rows.push({ t: Date.now(), ...entry });
  },
};
if (typeof window !== 'undefined') window.apiTrace = apiTrace;

// Which EDIABAS transmit function a concept runs, and therefore its checksum
// and its answer-length rule (EdInterfaceObd, the `switch (concept)` that
// sets ParTransmitFunc):
//   1, 5, 6            TransDs2         XOR    length from xawlen (TelLengthDs2)
//   0x10D KWP2000*     TransKwp2000S    XOR    byte[3] + 4      (TelLengthKwp2000S)
//   0x10B/0x10C/0x10F  TransKwp2000Bmw/ sum    TelLengthBmwFast
//   0x110 D-CAN        TransBmwFast
// Nothing here looks at the first byte of a frame to decide -- 0xB8 is just
// the tester address KWP2000* and BMW-FAST both use.
const XOR_CONCEPTS = new Set([1, 5, 6, 0x10d]);
const SUM_CONCEPTS = new Set([0x10b, 0x10c, 0x10f, 0x110]);
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
function withChecksum(out, comm) {
  return [...out, checksumOf(out, conceptOf(comm))];
}

// Total frame length INCLUDING the checksum byte, or null while too few
// bytes are in to know. Each rule is its EDIABAS TelLength* + 1.
function frameTotal(buf, comm) {
  const c = conceptOf(comm);
  if (XOR_CONCEPTS.has(c) && c !== 0x10d) {
    // DS2: the SGBD declared the rule with xawlen (EdInterfaceObd.TelLengthDs2)
    const al = comm && comm.answerLen;
    if (!al || !al.length) {
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
    // EdInterfaceBase.TelLengthBmwFast -- length in the low 6 bits of byte 0,
    // with byte 3 (or bytes 4-5) as the long-form fallback.
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

function verifyChecksum(frame, comm) {
  const want = checksumOf(frame.slice(0, -1), conceptOf(comm));
  if (want !== frame[frame.length - 1]) {
    throw ifhError('IFH-0019', 'answer checksum mismatch');
  }
}

function portConfig(comm) {
  const c = conceptOf(comm);
  if (isIso9141(c)) {
    // 8N1 after the handshake -- the init itself is bit-banged, not framed.
    return {
      baudRate: (comm && comm.baud) || ISO9141_BAUD,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
    };
  }
  if (isKline(c)) {
    // DS2 and KWP2000* are 8E1 at the rate the SGBD names (EdInterfaceObd.cs
    // case 0x0006: parity = Even, baudRate = CommParameter[1]). An earlier
    // 10400 8N1 override here came from an ISO 9141 experiment and does not
    // belong on these concepts.
    return {
      baudRate: (comm && comm.baud) || 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'even',
    };
  }
  return KDCAN;
}

// Read one answer off the K line. Shared by both transports, because the
// protocol does not change with the plumbing.
//
// The K line is HALF DUPLEX: one wire, so everything written is also heard
// back. Drop exactly as many bytes as were sent rather than pattern-matching
// the echo -- a request and its answer can legitimately share a prefix, and
// EdInterfaceObd drops by count for the same reason.
// `sent` is the exact request written (null when re-reading a continuation
// frame, which has no echo of its own).
async function readFrame(sent, timeoutMs, pump, comm) {
  const buf = [];
  // A WIRED K LINE ALWAYS ECHOES. HasAdapterEcho in EdiabasLib refers to a
  // REMOTE adapter (Bluetooth/WiFi) that strips the echo for you; an FTDI
  // cable on a half-duplex wire does not, so the echo is always here and is
  // always dropped by count.
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
    else await new Promise((r) => setTimeout(r, 4));
  }
  if (echoLen && at < 0) {
    throw ifhError(
      'IFH-0003',
      buf.length
        ? 'echo did not match the request (bus collision?)'
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
  let frameDeadline = deadline;
  let started = buf.length > 0;
  if (started) frameDeadline = Date.now() + Math.max(timeoutMs, 3000);
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
        frameDeadline = Date.now() + Math.max(timeoutMs, 3000);
      }
    } else await new Promise((r) => setTimeout(r, 4));
  }
  // A half-received frame is NOT an answer -- handing it to the VM decodes
  // garbage. Distinguish it from silence so the error means something.
  throw buf.length
    ? ifhError('IFH-0019', `incomplete answer from ECU (${buf.length} bytes)`)
    : ifhError('IFH-0009', 'no answer from ECU (timeout)');
}

// "Response pending": an ECU that needs longer than its declared timeout
// answers 7F <service> 78 and keeps the request alive. EDIABAS waits for
// the real answer instead of failing; a flash or a long routine depends on
// it. The payload offset follows the same framing rules as frameTotal:
// DS2 puts it at 2, KWP2000* behind its 4-byte header, BMW-FAST at 3 for
// the short form and 4 for the long form (len byte at [3]) -- a long-frame
// 7F..78 sliced at 3 was returned to the VM as the final answer.
function isResponsePending(frame, comm) {
  const c = conceptOf(comm);
  let body;
  if (isDs2(c)) body = frame.slice(2);
  else if (c === 0x10d) body = frame.slice(4);
  else if (frame[0] === 0xb8) body = frame.slice(4);
  else body = frame[0] & 0x3f ? frame.slice(3) : frame.slice(4);
  return body[0] === 0x7f && body[2] === 0x78;
}

// One request/answer exchange with per-concept retry. EDIABAS retransmits
// on a bad or missing answer (xreps); one retry covers the single-glitch
// case without hammering a dead bus.
// The quiet gap an SGBD demands between an answer and the next request.
// CommParameter dword 3 on the 0x1xx concepts (EdInterfaceObd.cs case 0x010D:
// ParRegenTime = CommParameterProtected[3]); the DS2 case reads index 6 of its
// own 16-bit layout. Clamped, because a bogus blob must not stall the bus.
function regenTimeOf(comm) {
  // decoded by Best2Vm.decodeCommParams from the concept's own index
  const raw = comm && comm.regen != null ? comm.regen : 0;
  return raw > 0 && raw <= 1000 ? raw : 0;
}

async function runExchange(bus, out, comm) {
  // The FIRST concept a session uses is the one that describes the wire. An
  // SGBD opens on it (ms450ds0: DS2) and then runs jobs that declare
  // BMW-FAST; the module is still the same K-line module, so remember what we
  // opened on and keep driving the wire that way.
  // EVERY xsetpar RECONFIGURES THE WIRE. That is what the opcode is for, and
  // EDIABAS honours each one: tracing this car showed it set concept 0x10F at
  // 115200, send the short telegram, get silence, then set concept 0x10D at
  // 9600 and send the long one -- which is answered. An earlier revision here
  // pinned the wire to the FIRST concept of a session, so the second
  // xsetpar was ignored, the B8 telegram went out at 115200 instead of 9600,
  // and the DME never heard it. The VM had reached the right branch all along.
  //
  // sessionConcept is still tracked, but only so the K-line wake knows it is
  // on a K-line module; it no longer overrides the telegram's own wire.
  bus.sessionConcept = conceptOf(comm);
  await bus.ensureConfig(portConfig(comm));
  const framed = withChecksum(out, comm);
  const timeoutMs = (comm && comm.timeout) || 2000;
  // a `wait` in the SGBD paces the bus: honor it before writing
  if (comm && comm.waitMs) {
    await new Promise((r) => setTimeout(r, Math.min(comm.waitMs, 5000)));
  }
  // ParRegenTime: a MANDATORY quiet gap between the ECU's last answer and the
  // next request, measured from the response (EdInterfaceObd.cs:4127). The
  // SGBD names it in its CommParameter -- 25 ms for this MS45 on concept
  // 0x10D. Without it a telegram sent immediately after a reply is ignored,
  // which is exactly what made a repeated FS_LESEN come back empty while the
  // identical first one was answered.
  const regenMs = regenTimeOf(comm);
  if (regenMs && bus.lastResponseAt) {
    const since = Date.now() - bus.lastResponseAt;
    if (since < regenMs) {
      await new Promise((r) => setTimeout(r, regenMs - since));
    }
  }
  // NO FRAMING FALLBACK HERE. The SGBD owns that: tracing EDIABAS showed
  // ms450ds0's INITIALISIERUNG hold BOTH telegrams as constants and try them
  // in turn -- xsend "82 12 F1 1A 80" gets IFH-0009, the bytecode carries on,
  // and xsend "B8 12 F1 02 1A 80" is answered. So a timed-out exchange must be
  // reported to the VM, not retried behind its back with a rewritten telegram.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
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
        pending < 30 && isResponsePending(frame, comm);
        pending++
      ) {
        // ParTimeoutNr78: how long the ECU may say "busy" between polls
        frame = await bus.exchangeRaw(
          null,
          (comm && comm.timeoutNr78) || Math.max(timeoutMs, 5000),
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
      // the error carries its IFH code; a garbled answer is IFH-0019
      // (checksum / incomplete) or IFH-0003 (echo), silence is IFH-0009
      if (!(e && (e.ifh === 'IFH-0019' || e.ifh === 'IFH-0003'))) throw e;
      // EdiabasLib's retry is a PURE RETRANSMISSION: ObdTrans loops the same
      // bytes with only the ParRegenTime wait, never a reinit (EdInterfaceObd
      // .cs:3652-3681). Re-arming the wake here made our retry a different,
      // more disruptive operation than the one EDIABAS performs -- and on DS2
      // there is no wake to re-arm in the first place.
    }
  }
  throw lastErr;
}

// ---- the Transport interface -----------------------------------------------
//
// THREE transports carry the exact same protocol to the car: Web Serial (a
// K+DCAN cable in desktop Chrome), the native bridge (the macOS shell owning
// /dev/tty), and THOR (a WiFi/socket adapter). runExchange, readFrame,
// withChecksum, frameTotal and verifyChecksum above are the protocol and are
// SHARED by all three -- "the protocol does not change with the plumbing." A
// full merge of the three classes is NOT possible, because three boundaries
// are physical, not incidental, and each stays a per-transport override:
//
//   SEAM 1  connect-entry -- Web Serial needs a USER GESTURE for the first
//           requestPort(); a socket (THOR) and the native bridge do not.
//   SEAM 2  K-line line-control -- only Web Serial has setSignals (DTR/break),
//           so fast-init and the ISO 9141 slow-init live there alone; the
//           native bridge has no setSignals, and THOR asks its firmware to
//           wake the line instead (a config flag in each telegram).
//   SEAM 3  echo/config placement -- half-duplex echo stripping and the FTDI
//           read-poll latency are Web Serial / native concerns; THOR's remote
//           adapter strips the echo itself and carries the wire settings in
//           each telegram, so it has no port to reconfigure.
//
// Every transport MUST expose this surface (the rest of the renderer -- app.js,
// coding-write.js, the fetch shim -- calls only these):
//
//   get connected            -> bool           is the wire up right now
//   async connect()          -> label          open the wire (SEAM 1)
//   async reconnect()        -> label|null     silent reopen on load, no gesture
//                                              (Web Serial only: keepCable)
//   async ensureConfig(cfg)  -> void           make baud+parity match a concept
//                                              (SEAM 3: no-op on THOR)
//   async exchange(out,comm) -> frame          one request/answer -- SHARED, it
//                                              just calls runExchange(this,...)
//   async exchangeRaw(f,t,c) -> frame          write+read one frame (SEAM 2/3)
//   async disconnect()       -> void           tear the wire down
//   async readState()        -> {battery,ignition}   KL30/KL15 (absent on the
//                                              native bridge -- callers guard)
//   portLabel()              -> string         a human name for the chip
//
// runExchange also reads/writes these transport fields as shared session state:
//   sessionConcept, lastResponseAt, inited, initedAddr.
//
// The native correspondence lives in C# (a different runtime, not unified here):
// SerialProxy.cs is the byte-mover behind NativeSerialBus (open/write/
// readAvailable/close/flush), TcpProxy.cs the same for THOR's native socket.
// Bytes cross that bridge as a JSON int[] (BmacwBridge.cs AsNumberArray), NOT
// base64 -- base64 corrupted the echo/checksum. src/EdiabasMac is LEGACY (its
// InpaMac.Api server is deleted); it is reference for what JS reimplemented,
// not a transport, and is deliberately NOT part of this interface.

// Shared base for the two SERIAL transports (Web Serial + native bridge). They
// both own a real port whose baud/parity must track the job's concept, and they
// both keep the same per-session wire state -- so the reconfigure-guard and the
// state reset live here once. THOR does NOT extend this: it owns no port (SEAM
// 3) and its "wire state" is a single `inited` flag with no port to reopen.
class SerialTransportBase {
  // The full wire state, cleared when the session on the wire ENDS (connect,
  // reconnect, disconnect): a fresh cable has woken nothing and remembers no
  // concept.
  _resetWireState() {
    this.inited = null;
    this.initedAddr = null;
    this.pending = null;
    this.sessionConcept = null;
  }

  // The WAKE state only, cleared when the port is REOPENED onto different
  // settings: a reopened port drops the ECU session, so a woken module must be
  // woken again. Deliberately does NOT touch sessionConcept -- runExchange sets
  // that immediately before calling ensureConfig, and the K-line wake in
  // exchangeRaw reads it right after, so clearing it here would blind the wake.
  _resetWakeState() {
    this.inited = null;
    this.initedAddr = null;
  }

  // True when a requested config already matches the open port, so ensureConfig
  // can skip the (session-dropping) reopen. Baud and parity are the only
  // settings a concept changes; data/stop bits are constant here.
  _configUnchanged(cfg) {
    return (
      !!this.config &&
      this.config.baudRate === cfg.baudRate &&
      this.config.parity === cfg.parity
    );
  }

  // One request/answer exchange. IDENTICAL for every transport -- the retry,
  // pacing, response-pending and framing all live in runExchange, which drives
  // the transport through its exchangeRaw/ensureConfig overrides. Kept in the
  // base (and reused by THOR below) so there is exactly one copy.
  async exchange(out, comm) {
    return runExchange(this, out, comm);
  }
}

// The same bus, over the native bridge. A WKWebView has no Web Serial -- that
// is a Chrome API, and the macOS app is a Cocoa window around WebKit -- so the
// shell owns the port and moves bytes for us (SerialProxy.cs). The framing,
// checksums and echo handling stay here, identical to the Web Serial path;
// only the four primitives differ.
class NativeSerialBus extends SerialTransportBase {
  constructor() {
    super();
    this.path = null;
    this.config = null;
  }

  get connected() {
    return !!this.path;
  }

  async connect() {
    const r = await window.bmacw.serialOpen(null, KDCAN.baudRate, KDCAN.parity);
    this.path = (r && r.port) || 'serial';
    this.config = KDCAN;
    return this.portLabel();
  }

  portLabel() {
    return (this.path || '').replace('/dev/', '');
  }

  async disconnect() {
    try {
      await window.bmacw.serialClose();
    } catch {
      /* already closed */
    }
    this.path = null;
    this.config = null;
  }

  // Reopen the port when a job's concept needs different wire settings --
  // an E46 mixes 9600 8E1 body modules with a 115200 8N1 DME, and a port
  // opened once at connect time can only speak to one of them.
  async ensureConfig(cfg) {
    if (this._configUnchanged(cfg)) return;
    // Reopening the port drops the ECU session with it, so a woken module
    // must be woken again. Without this a concept switch mid-job left
    // `inited` set and every following request went to a sleeping ECU.
    this._resetWakeState();
    const r = await window.bmacw.serialOpen(
      this.path === 'serial' ? null : this.path,
      cfg.baudRate,
      cfg.parity
    );
    this.path = (r && r.port) || this.path;
    this.config = cfg;
  }

  // exchange() is inherited from SerialTransportBase (identical for every
  // transport -- it delegates to the shared runExchange).

  // ---- BMW K-line fast init ------------------------------------------------
  // THE THING THAT WAS MISSING. An E46 K-line module ignores every telegram
  // until it is woken, and the wake is NOT the 2-second 5-baud ISO 9141 init
  // -- it is a 25 ms break. EdiabasLib does exactly this in SendWakeFastInit
  // (EdInterfaceObd.cs:3506):
  //
  //     DTR on -> break 25 ms -> break off -> wait to 50 ms total -> DTR off
  //
  // Verified against a real E46 M54/MS45: with the wake the DME answers
  // 82 12 F1 1A 80 with its ident string ("754472129001060300400..."), and
  // without it every telegram at every baud and parity is met with silence.
  // That silence is what surfaced as IFH-0009 and looked like a wiring fault.
  //
  // The wake runs at 10400 8N1, which is also where the answer comes back --
  // 9600 (either parity) stays silent even after a successful wake.
  async exchangeRaw(framed, timeoutMs, comm) {
    // NOTE: the K-line wake (fast init / slow init) lives on WebSerialBus,
    // which owns the break and DTR lines. The native bridge (window.bmacw)
    // exposes no setSignals equivalent yet, so a K-line ECU reached through
    // the desktop app still relies on the host side doing the wake.
    if (framed) {
      // A stale partial frame from a timed-out job would be read as this
      // job's answer, so start clean.
      await window.bmacw.serialFlush();
      await window.bmacw.serialWrite(framed);
    }
    return readFrame(
      framed,
      timeoutMs,
      async () => window.bmacw.serialRead(),
      comm
    );
  }
}

class WebSerialBus extends SerialTransportBase {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.config = null;
  }

  get connected() {
    return !!this.port;
  }

  // Must be called from a user gesture -- the browser will not show the port
  // picker otherwise. app.js wires this to the "connect cable" control.
  async connect() {
    if (!('serial' in navigator)) {
      throw new Error(
        'This browser has no Web Serial. Use Chrome or Edge ' +
          '(desktop), or the macOS app.'
      );
    }
    this.port = await navigator.serial.requestPort();
    await this.port.open(KDCAN);
    this.config = KDCAN;
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this._resetWireState();
    return this.portLabel();
  }

  // Reconnect WITHOUT a user gesture, on page load. Web Serial remembers a
  // granted port across reloads (the permission survives; only the first
  // requestPort() needs a click), so getPorts() returns it and open()
  // succeeds silently. This is what keeps the cable "connected through a
  // reload" -- the reopen-and-it-unlocks flow depends on it. Returns the
  // label on success, or null when nothing was previously granted (first
  // run, or the user revoked it) so the caller leaves the chip as "no cable".
  async reconnect() {
    if (!('serial' in navigator) || this.connected) return null;
    let ports = [];
    try {
      ports = await navigator.serial.getPorts();
    } catch (e) {
      console.info('[serial] getPorts() threw:', e.message);
      return null;
    }
    if (!ports.length) {
      // The browser remembers a granted port PER ORIGIN, but the grant is lost
      // if the origin changes, the device re-enumerated (some FTDI adapters do
      // on replug), or the user cleared site permissions. Nothing to reopen
      // silently -- the next connect() will ask once and it sticks again.
      console.info(
        '[serial] getPorts() returned no previously-granted port ' +
          '(first run here, or the grant was lost) -- a one-time pick is needed'
      );
      return null;
    }
    // Chrome 130+ exposes SerialPort.connected = is the device physically
    // present. Prefer a present one; a remembered-but-unplugged port would just
    // fail to open. Fall back to the first if the flag is unavailable.
    this.port = ports.find((p) => p.connected !== false) || ports[0];
    try {
      await this.port.open(KDCAN);
    } catch (e) {
      // The commonest cause is the port being held by another tab/app, or the
      // device unplugged. Say which, rather than a silent "no cable".
      console.info(
        `[serial] reopen of a granted port failed: ${e.message} ` +
          `(unplugged, or another tab/app holds it?)`
      );
      this.port = null;
      return null;
    }
    this.config = KDCAN;
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this._resetWireState();
    console.info(
      '[serial] reconnected to a previously-granted port, no picker'
    );
    return this.portLabel();
  }

  // Close/reopen with a concept's wire settings. Reopening an already-
  // granted port needs no user gesture, only the first requestPort() does.
  async ensureConfig(cfg) {
    if (this._configUnchanged(cfg)) return;
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
      }
    } catch {
      /* reopening */
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch {
      /* reopening */
    }
    await this.port.close();
    await this.port.open(cfg);
    this.config = cfg;
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
  }

  portLabel() {
    const i = this.port && this.port.getInfo ? this.port.getInfo() : {};
    return i.usbVendorId
      ? `USB ${i.usbVendorId.toString(16)}:${(i.usbProductId || 0).toString(16)}`
      : 'serial';
  }

  async disconnect() {
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
      }
    } catch {
      /* closing */
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch {
      /* closing */
    }
    try {
      if (this.port) await this.port.close();
    } catch {
      /* closing */
    }
    this.port = this.reader = this.writer = null;
    this._resetWireState();
  }

  // KL30/KL15, the way INPA gets them. INPA's start screen calls UTILITY's
  // STATUS_UBATT / STATUS_ZUENDUNG, whose bytecode reads the ADAPTER's own
  // sense lines (BEST/2 xbatt op110, xignit op114) and compares against
  // 10000 mV -- it never touches the diagnostic bus. A plain K+DCAN cable has
  // neither sense line, which is exactly the case UTILITY itself handles: for
  // an interface that cannot measure, it reports the nominal 12000 mV
  // (UTILITY/INTERFACE op273) and, for one that cannot sense KL15, reports
  // ignition on (the IDBSS branch, op132). Follow that precedent rather than
  // inventing a reading -- and mark it derived so the UI can say so.
  async readState() {
    if (!this.connected) return { battery: null, ignition: null };

    // --- STATUS_UBATT: xbatt, then `comp 10000 / jae`.
    const ubattMv = await this._senseKl30();
    if (ubattMv < UTILITY_UBATT_MIN_MV) {
      // BATTERIE.SRC: on STAT_UBATT == 0 INPA sets BOTH false and never runs
      // STATUS_ZUENDUNG at all. Ignition is not "unknown" here, it is off.
      return { battery: null, ignition: false, derived: true };
    }

    // --- STATUS_ZUENDUNG: its own xignit read, only reached with battery up.
    const ignMv = await this._senseKl15();
    return {
      battery: ubattMv / 1000,
      ignition: ignMv >= UTILITY_UBATT_MIN_MV,
      derived: true, // nominal, not measured -- this adapter has no sense line
    };
  }

  // xbatt equivalent. A K+DCAN cable is bus-powered from OBD pin 16 (KL30), so
  // if a clone wires that through to a modem line, a de-asserted line is real
  // evidence of no power. Otherwise UTILITY's "cannot measure" nominal.
  async _senseKl30() {
    if (this.port && this.port.getSignals) {
      try {
        const s = await this.port.getSignals();
        if (s && s.dataSetReady === false && s.dataCarrierDetect === false)
          return 0;
      } catch {
        /* no signal support */
      }
    }
    return UTILITY_NOMINAL_MV;
  }

  // xignit equivalent. A K+DCAN cable has no KL15 sense line at all. UTILITY's
  // own precedent for exactly that interface (the IDBSS branch) is `move L0,
  // 10000` -- report ignition ON rather than falsely reporting it off, because
  // the cable cannot tell. The bus is the real arbiter: an ECU only answers
  // with KL15 live, and a failed read already surfaces as such.
  async _senseKl15() {
    return UTILITY_IDBSS_IGN_MV;
  }

  // Send one request, read one answer. The VM calls this synchronously in
  // spirit but we are async, so runJob below drives it with an await loop.
  //
  // A K-line answer ECHOES the request back first (the bus is one wire, so
  // everything sent is also heard). EdInterfaceObd drops exactly as many
  // bytes as it wrote; do the same rather than pattern-matching, because a
  // request and its answer can legitimately share a prefix.
  // exchange() is inherited from SerialTransportBase (identical for every
  // transport -- it delegates to the shared runExchange).

  async fastInit(comm) {
    if (!this.port.setSignals) {
      throw ifhError(
        'IFH-0018',
        'this browser cannot drive the K line ' +
          '(no setSignals); use the macOS app for this ECU'
      );
    }
    // DTR is this cable's transmit enable: EdiabasLib asserts it for the wake
    // and for the duration of every telegram it writes.
    //
    // THE 50 ms IS MEASURED FROM THE START OF THE BREAK, not added after it.
    // EdiabasLib's SendWakeFastInit (EdInterfaceObd.cs:3521-3530) takes one
    // timestamp, holds the break until start+25 ms, releases it, then waits
    // until start+50 ms and drops DTR -- so the telegram follows ~50 ms after
    // the break BEGAN. Sleeping 25 then another 25 makes that 50 ms of sleep
    // PLUS the four awaits' own latency, and the trace showed 61 ms from break
    // to write. A module with a strict post-wake window (W4 is 25-50 ms) has
    // stopped listening by then. Deadline-based, so the wall clock matches
    // whatever the awaits cost.
    const t0 = Date.now();
    const until = async (ms) => {
      const left = ms - (Date.now() - t0);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    };
    await this.port.setSignals({ dataTerminalReady: true, break: true });
    await until(25);
    await this.port.setSignals({ break: false });
    await until(50);
    await this.port.setSignals({ dataTerminalReady: false });
    busTrace.add('kline', null, `fastInit done in ${Date.now() - t0}ms`);
    this.inited = true;
  }

  // ---- ISO 9141-2 slow init ------------------------------------------------
  // The module sleeps. Waking it means holding the K line low/high by hand at
  // 5 BITS PER SECOND -- one start bit, eight address bits LSB first, one stop
  // bit, 200 ms each, 2 seconds in total. No UART can frame that, so it is
  // bit-banged with setSignals({break}) and the port is reopened afterwards to
  // discard the framing garbage the break generates.
  //
  // The ECU then answers 0x55 (sync) and two key bytes. The tester echoes back
  // the SECOND key byte inverted, and the ECU replies with the address
  // inverted -- at which point the session is live and normal requests work.
  //
  // Proven against a real E46 M54/MS45:
  //   addr 0x33 @ 10400 -> 55 08 08, ack f7 cc, then
  //   mode01 pid00 -> 48 6b 12 41 00 bf 9f e8 91  (0x12 = the DME)
  //
  // Init is per-session: `this.inited` holds the concept it was done for, so a
  // job run does not re-init on every exchange (each one costs 2+ seconds) but
  // switching ECU or concept does.
  async slowInit(comm) {
    const baud = (comm && comm.baud) || ISO9141_BAUD;
    const addr = ISO9141_INIT_ADDR;

    // Break signalling needs the port open; parity/data bits are irrelevant
    // while the line is driven by hand.
    await this.ensureConfig({
      baudRate: baud,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
    });
    if (!this.port.setSignals) {
      throw ifhError(
        'IFH-0018',
        'this browser cannot bit-bang the K line ' +
          '(no setSignals); use the macOS app for this ECU'
      );
    }

    // start bit (low), 8 data bits LSB first, stop bit (high) -- 200 ms each
    const bits = [0];
    for (let i = 0; i < 8; i++) bits.push((addr >> i) & 1);
    bits.push(1);
    for (const b of bits) {
      await this.port.setSignals({ break: b === 0 });
      await new Promise((r) => setTimeout(r, 200));
    }
    await this.port.setSignals({ break: false });

    // Reopen so the break's framing errors are not read as data.
    await this.reopen({
      baudRate: baud,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
    });

    // 0x55 then two key bytes, within ~300 ms of the stop bit
    const hdr = [];
    const deadline = Date.now() + 1200;
    while (hdr.length < 3 && Date.now() < deadline) {
      const { value, done } = await this.readSome(deadline);
      if (done) break;
      if (value && value.length) hdr.push(...value);
    }
    const sync = hdr.indexOf(0x55);
    if (sync < 0 || hdr.length < sync + 3) {
      throw ifhError(
        'IFH-0009',
        'the ECU did not answer the slow init ' +
          '(no 0x55 sync). Ignition on, engine off?'
      );
    }
    const kb2 = hdr[sync + 2];

    // Tester sends ~KB2; the ECU replies ~addr. W4 is 25-50 ms.
    await new Promise((r) => setTimeout(r, 30));
    await this.writer.write(new Uint8Array([~kb2 & 0xff]));
    const ackDeadline = Date.now() + 400;
    const ack = [];
    while (ack.length < 2 && Date.now() < ackDeadline) {
      const { value, done } = await this.readSome(ackDeadline);
      if (done) break;
      if (value && value.length) ack.push(...value);
    }
    // The ack carries our own echo plus ~addr; a missing one is not fatal --
    // the E46 answered f7 cc where only cc is the ECU's. Requests that follow
    // are the real proof, so do not fail the session on a fussy ack.
    this.inited = true;
    return { keyBytes: [hdr[sync + 1], kb2], ack };
  }

  // Close and reopen the port, dropping anything buffered. Used after the
  // slow init, whose break signalling leaves framing errors in the stream.
  async reopen(cfg) {
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
      }
    } catch {
      /* reopening */
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch {
      /* reopening */
    }
    this.pending = null;
    await this.port.close();
    await this.port.open(cfg);
    this.config = cfg;
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
  }

  async exchangeRaw(framed, timeoutMs, comm) {
    // WHICH concepts need waking at all -- see the DS2 note below. ISO 9141
    // sleeps until its 5-baud address arrives; DS2 does not, and BMW-FAST over
    // a D-CAN cable does not. `inited` gates the one that does, and survives
    // until the port is reopened (which is what clears it): an SGBD's session
    // init can run on one concept while its jobs declare another, so keying
    // this to the per-telegram concept would wake for the init and not for the
    // job that follows.
    const concept = conceptOf(comm);
    const kline = isKline(concept) || isKline(this.sessionConcept);
    // Which ECU this telegram addresses (DS2: the first byte). Kept for the
    // trace and for the ISO 9141 wake, which IS per module.
    const addr = framed && framed.length ? framed[0] & 0xff : null;
    busTrace.add(
      'kline',
      null,
      `addr=0x${addr == null ? '??' : addr.toString(16)}` +
        ` concept=0x${concept.toString(16)} kline=${kline}` +
        ` session=${this.sessionConcept} inited=${this.inited}` +
        ` initedAddr=${this.initedAddr}` +
        ` cfg=${this.config && this.config.baudRate}/${this.config && this.config.parity}`
    );
    // DS2 IS NOT WOKEN. EdiabasLib's SendWakeFastInit has exactly ONE call
    // site -- inside TransKwp2000Bmw (EdInterfaceObd.cs:4698) -- and TransDs2
    // (4867-4956) contains no wake, no break, no 5-baud address at all. The
    // concept-5/6 setup marks the ECU connected outright (`EcuConnected =
    // true`, line 707) so nothing can trigger one.
    //
    // We were sending a 25 ms break before the first telegram to every K-line
    // address, DS2 included. That is 240 bit-times of dominant K line at 9600
    // -- to a module that never expected a fast init it is either framing
    // garbage to resync through, or, on a module that also speaks KWP2000, a
    // genuine wake pattern that arms a different session in which a raw DS2
    // telegram is not valid and gets dropped without reply. The E46 cluster
    // (0x80) forgives it; the EGS (0x32) answered EDIABAS and never us.
    //
    // ISO 9141 genuinely does need its 5-baud address, so that stays.
    const wantsWake = isIso9141(concept) || isIso9141(this.sessionConcept);
    if (framed && !this.inited && wantsWake) {
      await this.slowInit(comm);
      if (addr != null) this.initedAddr = addr;
    }
    if (framed) {
      // Drain anything stale before a fresh write -- the same start-clean
      // the native path gets from serialFlush(). A late answer from a
      // timed-out exchange would otherwise be read as this request's echo,
      // fail the compare, and cascade IFH-0003 until the stream happens to
      // run dry.
      // Drain to a quiet line. readSome now reports {done:false, value:null}
      // when it merely ran out of time (done means the PORT closed), so stop
      // on either. Bounded so a chattering bus cannot spin here forever.
      // (K-line writes drain INSIDE the DTR window instead -- see below.)
      const wantDtr0 = isKline(concept) || isKline(this.sessionConcept);
      if (!wantDtr0) await this.drainBuffered();
      // DTR IS THE TRANSMIT ENABLE on a K+DCAN cable, and it is what was
      // missing. EdiabasLib raises it for the duration of every telegram it
      // writes (EdInterfaceObd.cs:3343-3356) and DS2 sets ParSendSetDtr
      // (case 0x0006, "DS2 uses DTR"). Without it the bytes are framed
      // correctly, leave the UART, and never reach the K line -- which is
      // exactly the silence that looked like a dead ECU.
      const wantDtr = isKline(concept) || isKline(this.sessionConcept);
      if (wantDtr && this.port.setSignals) {
        // DTR up, THEN drain, THEN write -- the order EdiabasLib uses
        // (DiscardInBuffer sits inside the DTR block, right before Write).
        // Draining earlier let bytes arrive in the gap and be read as this
        // request's echo.
        await this.port.setSignals({ dataTerminalReady: true });
        await this.drainBuffered();
      }
      await this.writer.write(new Uint8Array(framed));
      if (wantDtr && this.port.setSignals) {
        // Hold DTR for exactly the telegram's byte time plus EdiabasLib's
        // DtrTimeCorrCom (0.3 ms, EdInterfaceObd.cs:156) -- no more. DTR is
        // the transmit enable, so holding it longer than the write keeps the
        // cable talking while the ECU answers and the reply is lost. An
        // earlier +4 ms margin here produced a perfect echo and no answer.
        const bits = this.config && this.config.parity === 'none' ? 10 : 11;
        const ms =
          (framed.length * bits * 1000) / (this.config.baudRate || 9600);
        busTrace.add(
          'kline',
          null,
          `DTR held ${Math.max(1, Math.round(ms + 0.3))}ms for ${framed.length}B` +
            ` @${this.config && this.config.baudRate}/${this.config && this.config.parity}`
        );
        await new Promise((r) =>
          setTimeout(r, Math.max(1, Math.round(ms + 0.3)))
        );
        await this.port.setSignals({ dataTerminalReady: false });
      }
    }
    const deadline = Date.now() + timeoutMs;
    return readFrame(
      framed,
      timeoutMs,
      async () => {
        const { value, done } = await this.readSome(deadline);
        return done ? null : value;
      },
      comm
    );
  }

  // Read with a deadline, WITHOUT losing bytes to an abandoned read.
  //
  // THE BUG THIS FIXES: racing reader.read() against a timeout and walking
  // away leaves that read outstanding. Web Serial still delivers the next
  // chunk to it, and because nothing held the promise those bytes were gone
  // for good. The pre-write drain loop below runs with a 2 ms deadline and so
  // ALWAYS ends by timing out -- meaning every exchange armed an orphaned
  // read immediately before writing, which then swallowed the K-line echo.
  // readFrame waited the full timeout for bytes already eaten and threw
  // IFH-0003 "no echo from the cable" on a cable that echoes perfectly.
  //
  // Keeping the single outstanding read on `this.pending` and awaiting that
  // same promise next time means a timed-out read is resumed, not discarded.
  // Drain what is already buffered WITHOUT arming a new read.
  //
  // THE BUG THIS FIXES: the old drain called readSome() with a 2 ms deadline.
  // readSome keeps a timed-out read alive on this.pending (that is what stops
  // bytes being lost), so the drain's last call left a live read armed. The
  // write then went out and THAT read swallowed the first bytes of the echo --
  // every answer arrived missing its head ("12 04 00 16" came back as
  // "00 16"), which readFrame then failed to match.
  //
  // Here a read is only consumed if it has ALREADY resolved, so the drain can
  // never take bytes that belong to the telegram we are about to send.
  async drainBuffered() {
    // NEVER CREATE A READ HERE. An earlier version probed with
    // this.reader.read() when nothing was outstanding; if the line was quiet
    // that probe stayed armed, the telegram went out, and the probe swallowed
    // the first bytes of the echo. The tell was unmistakable in a wire trace:
    // the FIRST attempt of every exchange came back missing its head
    // ("82 12 f1 1a 80 1f" as "12 f1 1a 80 1f") while the retry -- which found
    // a pending read already in place and so created none -- was perfect.
    //
    // Only an ALREADY-OUTSTANDING read is consumed, and only while it keeps
    // resolving immediately. A quiet line leaves this a no-op.
    for (let i = 0; i < 64 && this.pending; i++) {
      const settled = await Promise.race([
        this.pending.then((r) => ({ hit: true, r })),
        new Promise((res) => setTimeout(() => res({ hit: false }), 2)),
      ]);
      if (!settled.hit) return; // still outstanding: leave it be
      const { value, done } = settled.r || {};
      if (done || !value || !value.length) return;
    }
  }

  async readSome(deadline) {
    const ms = Math.max(1, deadline - Date.now());
    if (!this.pending) {
      // Tag the read so a resolved value can be told from a stale handle.
      this.pending = this.reader.read().then(
        (r) => {
          this.pending = null;
          return r;
        },
        (e) => {
          this.pending = null;
          throw e;
        }
      );
    }
    let timer;
    const timeout = new Promise((res) => {
      timer = setTimeout(() => res(TIMED_OUT), ms);
    });
    try {
      const r = await Promise.race([this.pending, timeout]);
      // Timed out: the read stays on this.pending for the next call. Report
      // "nothing yet" rather than done -- done means the port closed.
      if (r === TIMED_OUT) return { value: null, done: false };
      return r;
    } finally {
      clearTimeout(timer);
    }
  }
}

// The THOR WiFi adapter (EdiabasLib DEEPOBDWIFI behind an ESP-Link bridge at
// 192.168.4.1:23). NOT an ELM327 -- it carries BMW-FAST telegrams, what the VM
// sends. A browser has no TCP, so the adapter is reflashed to serve a WebSocket
// itself (vendor/esp-link-ws). Its F1->F1 "special" telegrams (ident, ignition,
// battery) are answered by the adapter MCU, so connect + topbar indicators work
// against any car; wrapping K-line/D-CAN job telegrams is still to come.
const THOR_BRIDGE = 'ws://127.0.0.1:8124';
const THOR_HOST = '192.168.4.1';
const THOR_PORT = 23;

// DIRECT MODE. An adapter running the WebSocket firmware in
// vendor/esp-link-ws serves ws://<ip>/bmweb straight off the dongle, so the
// page talks to the car with nothing else running -- no relay, no shell.
// That is what makes this work on a phone: WebSockets are the only browser
// transport with no platform gaps (Web Serial is desktop-Chrome only, Web
// Bluetooth does not exist on iOS).
//
// Everything below this line is unchanged either way. The telegram wrapping
// and the framing do not care which socket carries the bytes.
const THOR_WS_PATH = '/bmweb';
const THOR_DEFAULT_IP = '192.168.4.1';

// How long to wait on the adapter before falling back to the relay. A
// socket to an address that is not there does not fail fast -- the browser
// retransmits SYN for a long time -- so this deadline is what bounds the
// whole "try direct first" idea. Long enough for a sleepy ESP on a weak
// AP, short enough that a user who is not on the adapter's WiFi is not
// left staring.
const THOR_DIRECT_TIMEOUT_MS = 10000;

// One message that says what was tried and what to do about it. Every
// branch here is a real, distinguishable situation -- "could not connect"
// alone sends people to check the wrong thing.
function thorAdviceFor(failures, https, typedAddress) {
  const tried = failures.join('; ');
  if (https) {
    return (
      'This page is served over https, which cannot open a ws:// ' +
      'connection to the adapter (mixed content), and a bare IP cannot ' +
      'have a certificate. Open this build over http:// or as an offline ' +
      `copy. (${tried})`
    );
  }
  if (typedAddress) {
    return (
      `No adapter answered at ${typedAddress}. Check you are joined to ` +
      "the adapter's WiFi, that the address is right, and that it runs the " +
      `WebSocket firmware (vendor/esp-link-ws). (${tried})`
    );
  }
  return (
    "No THOR adapter found. Join the adapter's WiFi, and check it has " +
    'the WebSocket firmware flashed (see vendor/esp-link-ws). ' +
    `(${tried})`
  );
}

// "192.168.4.1" | "192.168.4.1:81" | "ws://host/path" -> a URL. Bare hosts
// are the common case (it is what the adapter's own page shows), so accept
// them and supply the rest.
function thorDirectUrl(addr) {
  const a = String(addr || THOR_DEFAULT_IP).trim();
  if (/^wss?:\/\//i.test(a)) return a;
  return `ws://${a.replace(/\/+$/, '')}${THOR_WS_PATH}`;
}

class ThorWifiBus {
  // directUrl: talk to the adapter's own WebSocket instead of the relay.
  constructor(directUrl) {
    this.ws = null;
    this.native = false; // shell-owned TCP socket
    this.direct = directUrl || null; // address the user chose
    this.usingDirect = null; // address that answered
    this.textFrames = false;
    this._connecting = null; // in-flight connect()
    this.fw = null; // { type, version }
    this.state = { battery: null, ignition: null }; // last ident readings
    this.rx = [];
    // whether the adapter has been asked to wake the K line this session
    this.inited = false;
    this.sessionConcept = null;
  }

  get connected() {
    return this.native || (!!this.ws && this.ws.readyState === 1);
  }

  // Open a WebSocket, or give up after `ms`. A socket to an address that
  // simply is not there does NOT fail fast -- the browser sits in SYN
  // retransmit, which on a phone can run past a minute. Hence the deadline:
  // it is what makes "try direct, then fall back" finish in a knowable
  // time rather than looking hung.
  openWs(url, ms, onText) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      let settled = false;
      // THE DEADLINE COVERS OPENING, AND NOTHING AFTER IT. It exists
      // because a socket to an address that is not there does not fail
      // fast -- the browser sits in SYN retransmit. Once the socket is
      // OPEN that reason is gone, so this must never touch it: closing a
      // live connection here killed a working adapter ten seconds in,
      // mid-conversation, with voltage already on screen.
      const timer = setTimeout(() => {
        if (settled || ws.readyState === 1) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* never opened */
        }
        rej(
          new Error(`no answer from ${url} within ${Math.round(ms / 1000)}s`)
        );
      }, ms);
      ws.onopen = () => {
        clearTimeout(timer);
        if (settled) {
          // A late open after we gave up: do not hand back a socket the
          // caller has stopped waiting for, and do not leak it either.
          try {
            ws.close();
          } catch {
            /* already closing */
          }
          return;
        }
        settled = true;
        // KEEPALIVE. A diagnostic session is idle most of the time -- the
        // user reads a screen and thinks -- and an idle TCP connection is
        // exactly what times out. The firmware disarms espconn's own
        // 10-second timer, but an AP or router in between can have its own
        // idea, so keep the socket warm.
        //
        // A browser cannot send a ping opcode, so this is a ZERO-LENGTH
        // BINARY frame: the firmware's `if (plen) uart0_tx_buffer(...)`
        // means an empty payload writes nothing to the K-line. Traffic on
        // the socket, silence on the wire.
        clearInterval(this.keepAlive);
        this.keepAlive = setInterval(() => {
          if (ws.readyState !== 1) {
            clearInterval(this.keepAlive);
            return;
          }
          try {
            ws.send(new Uint8Array(0));
          } catch {
            /* closing */
          }
        }, 5000);
        res(ws);
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already dead */
        }
        rej(new Error(`could not open ${url}`));
      };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          busTrace.add(
            'ws.text',
            null,
            JSON.stringify(String(e.data).slice(0, 60))
          );
          if (onText) onText();
          return;
        }
        const chunk = new Uint8Array(e.data);
        busTrace.add(
          'ws.recv',
          chunk,
          `rx ${this.rx.length} -> ${this.rx.length + chunk.length}`
        );
        this.rx.push(...chunk);
      };
      ws.onclose = (e) => {
        // WHO CLOSED IT, AND WHY. A connection that dies mid-session is
        // the hardest thing to diagnose blind: the app just says "not
        // running" and every layer looks innocent. The close code names
        // the culprit -- 1006 is an abnormal close (no close frame: the
        // peer vanished or the network dropped), 1001 is going-away,
        // 1000 is a clean close somebody asked for.
        console.warn(
          `[thor] socket closed: code=${e && e.code} ` +
            `reason="${(e && e.reason) || ''}" ` +
            `clean=${e && e.wasClean} url=${url}`
        );
        this.ws = null;
      };
    });
  }

  async connect() {
    // ONE CONNECT AT A TIME. app.js auto-connects on load AND offers the
    // chip as a manual retry, so two chains can overlap -- and a second
    // chain's failed attempt would tear down the transport the first one
    // had already established. Hand the caller the in-flight attempt
    // instead of starting a rival one.
    if (this._connecting) return this._connecting;
    if (this.connected) return this.portLabel();
    this._connecting = this.connectOnce().finally(() => {
      this._connecting = null;
    });
    return this._connecting;
  }

  async connectOnce() {
    // WHAT TO TRY, IN ORDER. Direct first whenever it is possible: an
    // adapter running the WebSocket firmware needs nothing else, which is
    // the only arrangement that works on a phone. The relay and the
    // shell's socket are the fallbacks, and each one is only offered where
    // it can actually work.
    const https =
      typeof location !== 'undefined' && location.protocol === 'https:';
    const attempts = [];
    if (!https) {
      attempts.push({
        kind: 'direct',
        url: this.direct || thorDirectUrl(THOR_DEFAULT_IP),
        open: async (url) => {
          this.ws = await this.openWs(url, THOR_DIRECT_TIMEOUT_MS, () => {
            this.textFrames = true;
          });
          this.usingDirect = url;
        },
      });
    }
    if (window.bmacw && window.bmacw.tcpOpen) {
      attempts.push({
        kind: 'native',
        open: async () => {
          await window.bmacw.tcpOpen(THOR_HOST, THOR_PORT);
          this.native = true;
        },
      });
    }
    // THE RELAY IS GONE FROM THE SHIPPED BUILDS. A browser cannot open a
    // raw TCP socket, so reaching a stock esp-link adapter used to need a
    // node process beside the page -- which is exactly the "install
    // something first" this app exists to avoid, and impossible on a phone.
    // The answer is the WebSocket firmware (vendor/esp-link-ws): flash it
    // once and the adapter serves the socket itself.
    //
    // Kept alive only for someone who still runs thor_bridge.js by hand:
    // ?relay=1. Not offered, not documented in the UI, and never tried on
    // its own -- a silent fallback to a relay would hide a wrong address or
    // unflashed firmware behind a connection that happens to work.
    if (!this.direct && bootQuery.has('relay')) {
      attempts.push({
        kind: 'relay',
        open: async () => {
          this.ws = await this.openWs(THOR_BRIDGE, 4000);
        },
      });
    }

    // A SOCKET IS NOT AN ADAPTER, so each attempt has to prove itself
    // before the next one is skipped. The ident is that proof: addressed
    // F1 -> F1, the adapter MCU answers it itself, and a correct reply can
    // only come back over a real, binary-clean UART bridge. No car, no
    // ignition. An endpoint that opens and then says nothing -- a console
    // socket, a relay with no adapter behind it -- fails here and the next
    // transport gets its turn, which is the whole point of trying in order.
    const failures = [];
    for (const a of attempts) {
      try {
        await a.open(a.url);
        const fw = await this.special(0xfd, 9);
        this.fw = { type: (fw[4] << 8) | fw[5], version: (fw[6] << 8) | fw[7] };
        // the raw method, not the bus-locked wrapper installed below --
        // connect() already holds the lock, and the wrapper would deadlock
        await ThorWifiBus.prototype.readState.call(this);
        return this.portLabel();
      } catch (e) {
        failures.push(
          `${a.kind}: ${
            this.textFrames
              ? 'text frames, not a binary UART bridge'
              : e.message
          }`
        );
        await this.dropTransport();
      }
    }
    throw new Error(thorAdviceFor(failures, https, this.direct));
  }

  // Undo a failed attempt so the next one starts clean.
  async dropTransport() {
    clearInterval(this.keepAlive);
    this.keepAlive = null;
    try {
      if (this.ws) this.ws.close();
    } catch {
      /* already gone */
    }
    if (this.native) {
      try {
        await window.bmacw.tcpClose();
      } catch {
        /* already gone */
      }
    }
    this.ws = null;
    this.native = false;
    this.usingDirect = null;
    this.textFrames = false;
    this.rx.length = 0;
    // the wake belongs to the CONNECTION: a new transport must re-wake
    this.inited = false;
    this.sessionConcept = null;
  }

  portLabel() {
    const v = this.fw
      ? ` v${this.fw.version >> 8}.${this.fw.version & 0xff}`
      : '';
    // Name the mode that actually WON, not the one that was configured:
    // with the fallback in place those differ, and "direct" has to mean
    // "nothing else is running" or it is worse than no label at all.
    const how = this.usingDirect ? ' direct' : this.native ? '' : ' via relay';
    return `THOR${v}${how}`;
  }

  async disconnect() {
    clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (this.native) {
      try {
        await window.bmacw.tcpClose();
      } catch {
        /* already gone */
      }
      this.native = false;
    }
    try {
      if (this.ws) this.ws.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
    this.usingDirect = null;
    this.inited = false;
    this.sessionConcept = null;
  }

  // One special telegram: 82 F1 F1 <cmd> <cmd> <sum8>. The adapter echoes
  // the request, then appends its answer (respLen bytes, sum8 last). Over
  // the WebSocket, bytes arrive via onmessage; over the native socket, poll
  // the shell (same shape as NativeSerialBus, and the timeout policy stays
  // here either way).
  async special(cmd, respLen, timeoutMs = 2000) {
    const req = [0x82, 0xf1, 0xf1, cmd, cmd];
    req.push(req.reduce((a, b) => (a + b) & 0xff, 0));
    if (this.native) await window.bmacw.tcpRead(); // drop anything stale
    this.rx.length = 0;
    if (this.native) await window.bmacw.tcpWrite(req);
    else this.ws.send(new Uint8Array(req));
    const want = req.length + respLen;
    const deadline = Date.now() + timeoutMs;
    while (this.rx.length < want && Date.now() < deadline) {
      if (this.native) {
        const got = await window.bmacw.tcpRead();
        if (got && got.length) {
          this.rx.push(...got);
          continue;
        }
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    if (this.rx.length < want) {
      busTrace.add(
        'thor.special',
        this.rx,
        `cmd=0x${cmd.toString(16)} SHORT: wanted ${want}, got ${this.rx.length}`
      );
      throw new Error('THOR adapter did not answer');
    }
    const resp = this.rx.slice(req.length, want);
    busTrace.add('thor.special', resp, `cmd=0x${cmd.toString(16)} ok`);
    const sum = resp.slice(0, -1).reduce((a, b) => (a + b) & 0xff, 0);
    if (sum !== resp[resp.length - 1]) {
      busTrace.add(
        'thor.special',
        this.rx,
        `cmd=0x${cmd.toString(16)} CHECKSUM bad`
      );
      throw new Error('THOR answer checksum bad');
    }
    return resp;
  }

  // ignition sense + battery voltage, read from the adapter (no car protocol
  // involved). Feeds /api/state, so the topbar KL30/KL15 indicators are real.
  async readState() {
    const ign = await this.special(0xfe, 6);
    this.state.ignition = (ign[4] & 0x01) !== 0;
    if (this.fw && this.fw.type >= 2) {
      const v = await this.special(0xfc, 6);
      this.state.battery = v[4] / 10;
    }
    return this.state;
  }

  // ---- job telegrams.
  //
  // The adapter does not take a bare BMW telegram: it takes a CONFIG header
  // saying how to drive the K line, with the telegram as payload. That is
  // what makes THOR the only transport here that can reach a 9600-baud DS2
  // module without touching the serial port's own settings -- the baud
  // rides in each telegram.
  //
  // Layout (EdiabasLib EdCustomAdapterCommon.CreateAdapterTelegram), the
  // two firmware generations:
  //
  //   fw < 0x0008:  00 00 baudH baudL flags1 interByte lenH lenL <payload> sum8
  //   fw >= 0x0008: 00 02 baudH baudL flags1 flags2 interByte kwp1281To
  //                                                  lenH lenL <payload> sum8
  //
  // baud is transmitted HALVED, big-endian; 115200 is special-cased to 0,
  // which means "raw passthrough" (the adapter stops reframing and the wire
  // is BMW-FAST as-is). flags1 bits 0-2 are parity (0 none, 1 even),
  // 0x80 selects the K line. The adapter echoes the whole wrapped telegram
  // back, then appends the ECU's answer with its own sum8 -- so the answer
  // is checked on its own bytes, not across the echo.
  // flags1 bits, from EdiabasLib EdCustomAdapterCommon (KLINEF1_*). These are
  // the adapter's instructions for how to drive the wire.
  static get KLINEF1() {
    return {
      PARITY_EVEN: 0x01,
      USE_LLINE: 0x08,
      SEND_PULSE: 0x10,
      NO_ECHO: 0x20,
      FAST_INIT: 0x40,
      USE_KLINE: 0x80,
    };
  }

  // Build flags1 the way EdiabasLib does (EdCustomAdapterCommon
  // .CreateAdapterTelegram, lines 245-262), because the adapter acts on these
  // bits and a missing one is silent.
  //
  // THE L LINE IS THE ONE THAT WAS MISSING. EdiabasLib sets KLINEF1_USE_LLINE
  // whenever setDtr is false, and DS2 is exactly that case: EdInterfaceObd's
  // concept-1 setup (case 0x0001) sets `ParSendSetDtr = false`. On the serial
  // path DTR is the transmit enable; on a custom adapter the equivalent is
  // telling the firmware to drive the L line as well as K. Without it the
  // telegram is framed perfectly, the adapter echoes it, and the module never
  // hears a thing -- which is precisely the silence seen here.
  //
  // NOTE DS2 needs NO WAKE: the same setup sets `EcuConnected = true` outright,
  // so there is no fast-init for this concept. (KWP2000 does wake, via
  // SendWakeFastInit -> KLINEF1_FAST_INIT; that path is kept for 0x10D.)
  // NO_ECHO IS THE STARTING VALUE, NOT AN OPTION. EdiabasLib opens with
  // `byte flags1 = KLINEF1_NO_ECHO` and never clears it, so a real adapter is
  // always told to swallow the echo -- and in the wrapped branch EdiabasLib
  // reads no echo back either (the echo-removal loop lives only in the raw /
  // 115200 branch). Asking for the echo left this the only client on the wire
  // driving the line differently from every other one.
  static thorConfig(comm, fastInit) {
    const F = ThorWifiBus.KLINEF1;
    const c = conceptOf(comm);
    const kline = isDs2(c) || c === 0x10d;
    const baud = kline ? (comm && comm.baud) || 9600 : 115200;
    let flags1 = F.NO_ECHO | F.USE_KLINE;
    if (kline) {
      flags1 |= F.PARITY_EVEN; // DS2/KWP2000* are 8E1
      // setDtr is false for these concepts, so the L line carries the send
      flags1 |= F.USE_LLINE;
      // only the concepts that actually do a fast init ask for one
      if (fastInit && c === 0x10d) flags1 |= F.FAST_INIT;
    }
    return {
      baudHalf: baud === 115200 ? 0 : Math.floor(baud / 2),
      flags1,
      interByte: 0,
    };
  }

  thorWrap(payload, comm, fastInit) {
    const cfg = ThorWifiBus.thorConfig(comm, fastInit);
    const v2 = this.fw && this.fw.version >= 0x0008;
    const head = v2
      ? [
          0x00,
          0x02,
          (cfg.baudHalf >> 8) & 0xff,
          cfg.baudHalf & 0xff,
          cfg.flags1,
          0x00,
          cfg.interByte,
          0x3c,
          (payload.length >> 8) & 0xff,
          payload.length & 0xff,
        ]
      : [
          0x00,
          0x00,
          (cfg.baudHalf >> 8) & 0xff,
          cfg.baudHalf & 0xff,
          cfg.flags1,
          cfg.interByte,
          (payload.length >> 8) & 0xff,
          payload.length & 0xff,
        ];
    const tel = [...head, ...payload];
    tel.push(tel.reduce((a, b) => (a + b) & 0xff, 0));
    return tel;
  }

  // The wire settings ride in each telegram's config header (thorWrap), so the
  // adapter needs no port reconfiguration -- but runExchange calls this on
  // every exchange, so it has to exist and be cheap. Tracking the concept
  // keeps parity with the serial buses for anything that reads it back.
  async ensureConfig(cfg) {
    this.config = cfg;
  }

  // Same contract as the serial buses' exchangeRaw: write `framed` (null means
  // "keep reading the answer to what was already sent" -- the response-pending
  // path), then return one verified frame. Everything ABOVE this -- concept
  // reconfiguration, ParRegenTime, response-pending polling, the retry policy
  // -- now comes from runExchange, shared with the serial path, instead of the
  // partial copy this class used to carry.
  async exchangeRaw(framed, timeoutMs, comm) {
    let echoLen = 0;
    if (framed) {
      // `framed` already carries the concept checksum (runExchange applied it);
      // the adapter wraps that telegram, it does not compute the checksum.
      // Wake the module on the first K-line telegram of a session, exactly
      // like the serial path's `inited` gate -- the wake belongs to the
      // CONNECTION, not to one telegram, so it is cleared on connect/drop.
      const concept = conceptOf(comm);
      const wantWake =
        (isKline(concept) || isKline(this.sessionConcept)) && !this.inited;
      busTrace.add(
        'thor.wake?',
        null,
        `concept=0x${concept.toString(16)} isKline=${isKline(concept)}` +
          ` sessionConcept=${this.sessionConcept} inited=${this.inited}` +
          ` -> wantWake=${wantWake}`
      );
      const tel = this.thorWrap(Array.from(framed), comm, wantWake);
      if (wantWake) this.inited = true;
      // No echo to skip: thorConfig sets KLINEF1_NO_ECHO, so the adapter
      // swallows it and the next bytes on the stream are the ECU's answer.
      // (When the flag was absent the adapter echoed the PAYLOAD -- the bare
      // BMW telegram, not the wrapper -- which is why echoLen was framed.length
      // and not tel.length. Kept as a note: the echo is a mode, not a given.)
      echoLen = 0;
      busTrace.add(
        'thor.telegram',
        framed,
        `concept 0x${conceptOf(comm).toString(16)}`
      );
      busTrace.add(
        'thor.wrapped',
        tel,
        `echoLen=${echoLen} baud=${(comm && comm.baud) || ''}` +
          ` flags1=0x${tel[4].toString(16)}${wantWake ? ' FAST_INIT' : ''}`
      );
      if (this.native) await window.bmacw.tcpRead(); // drop anything stale
      this.rx.length = 0;
      if (this.native) await window.bmacw.tcpWrite(tel);
      else this.ws.send(new Uint8Array(tel));
    } else {
      busTrace.add('thor.reread', null, 'response-pending follow-up');
    }
    const deadline = Date.now() + timeoutMs;
    // echoLen is 0 while NO_ECHO is set; the loop and the throw below cost
    // nothing then, and still cover an adapter that echoes anyway.
    while (this.rx.length < echoLen && Date.now() < deadline) {
      if (this.native) {
        const got = await window.bmacw.tcpRead();
        if (got && got.length) {
          this.rx.push(...got);
          continue;
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    if (this.rx.length < echoLen) {
      busTrace.add('thor.rx', this.rx, `SHORT: wanted echo of ${echoLen}`);
      throw new Error('no echo from the THOR adapter (timeout)');
    }
    if (echoLen)
      busTrace.add('thor.echo', this.rx.slice(0, echoLen), 'echo (skipped)');
    while (Date.now() < deadline) {
      const buf = this.rx.slice(echoLen);
      const total = frameTotal(buf, comm);
      if (total !== null && buf.length >= total) {
        const frame = buf.slice(0, total);
        busTrace.add('thor.answer', frame, `frameTotal=${total}`);
        verifyChecksum(frame, comm);
        // consume it, so a follow-up read (response-pending) starts clean
        this.rx = this.rx.slice(echoLen + total);
        return frame;
      }
      if (this.native) {
        const got = await window.bmacw.tcpRead();
        if (got && got.length) {
          this.rx.push(...got);
          continue;
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const partial = this.rx.length - echoLen;
    busTrace.add(
      'thor.rx',
      this.rx,
      `TIMEOUT after echo: ${partial} byte(s) of answer, frameTotal=${frameTotal(this.rx.slice(echoLen), comm)}`
    );
    throw new Error(
      partial > 0
        ? `incomplete answer from ECU via THOR (${partial} bytes)`
        : 'no answer from ECU (timeout)'
    );
  }

  // The Transport interface's shared exchange: identical to the serial buses'
  // (all three delegate to runExchange). THOR does NOT extend
  // SerialTransportBase -- it owns no port, so the reconfigure-guard and
  // wake-state reset there do not apply (SEAM 3) -- so it keeps its own copy of
  // this one-liner rather than inheriting the port-shaped base.
  async exchange(out, comm) {
    return runExchange(this, out, comm);
  }
}

// Which transport this host can do. THOR is an explicit choice (?thor=1 or the
// Adapter setting): shell TCP in the macOS app, a direct WebSocket to the
// adapter's esp-link-ws firmware in a browser (relay is ?relay=1 only). Else the
// native serial bridge when present. Settings read from localStorage over the
// shell's injected copy, which is a reload behind right after a change.
const bootSettings = (() => {
  try {
    return {
      ...(window.__bmacwSettings || {}),
      ...JSON.parse(localStorage.getItem('bmacw.settings') || '{}'),
    };
  } catch {
    return {};
  }
})();
const bootQuery = (() => {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
})();

const wantThor = (() => {
  // an https page cannot open ws://192.168.4.1, so the hosted site is
  // K+DCAN only whatever a carried-over setting says
  if (typeof location !== 'undefined' && location.protocol === 'https:')
    return false;
  if (bootQuery.has('thor') || bootQuery.has('ws')) return true;
  return bootSettings.adapter === 'thor';
})();

// The adapter's own WebSocket address; setting one turns the relay off
// (?ws=<host> for a one-off, Settings > THOR address for durable). Empty keeps
// the relay default -- stock esp-link has no WebSocket, so direct mode needs a
// reflashed adapter. No setting for the address itself: 192.168.4.1 is the
// ESP's fixed soft-AP address (a field for something that never varies only
// gets typed wrong); change it in esp-link's Soft-AP page if you must.
const thorDirect = (() => {
  const q = bootQuery.get('ws');
  if (q) return thorDirectUrl(q === '1' ? THOR_DEFAULT_IP : q);
  const s = bootSettings.thorAddress; // honoured if an old copy set it
  return s ? thorDirectUrl(s) : null;
})();

const webBus = wantThor
  ? new ThorWifiBus(thorDirect)
  : typeof window !== 'undefined' && window.bmacw && window.bmacw.serialOpen
    ? new NativeSerialBus()
    : new WebSerialBus();

// ONE EXCHANGE AT A TIME, BUS-WIDE. The K-line is half duplex and the THOR
// socket has a single rx buffer: two concurrent callers interleave writes
// and steal each other's answers -- the 3-second topbar state poll was
// clobbering any job that took longer than a second. The old C# engine
// held a bus lock server-side; the VM migration lost it. Every entry point
// that can touch the wire queues here.
let busChain = Promise.resolve();
function withBusLock(fn) {
  const run = busChain.then(fn, fn);
  busChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

// A session must not outlive the cable: dropping the bus without clearing
// it would leave the next connection thinking INITIALISIERUNG had already
// run, and reuse shared data from a car that may not even be the same one.
// ENDE is skipped deliberately -- the wire is already going away.
{
  const raw = {
    disconnect: webBus.disconnect.bind(webBus),
    exchange: webBus.exchange.bind(webBus),
    connect: webBus.connect.bind(webBus),
    readState: webBus.readState ? webBus.readState.bind(webBus) : null,
  };
  webBus.disconnect = async (...a) => {
    sessions.clear();
    loadedSgbd = null;
    // resolved variants are facts about the CAR on the other end of this
    // cable; the next connection may be a different one
    groupVariantCache.clear();
    return withBusLock(() => raw.disconnect(...a));
  };
  webBus.exchange = (...a) => withBusLock(() => raw.exchange(...a));
  // The unlocked exchange, for a caller that ALREADY holds the bus lock and
  // must not queue behind itself (webWriteCoding runs a whole sequence inside
  // one lock). Assigned here so coding-write reaches the same raw wire reads do.
  webBusRawExchange._raw = (...a) => raw.exchange(...a);
  webBus.connect = (...a) => withBusLock(() => raw.connect(...a));
  if (raw.readState) {
    webBus.readState = (...a) => withBusLock(() => raw.readState(...a));
  }
}

// ---------------------------------------------------------------- job runner

// EDIABAS's session model, which a fresh-VM-per-job does not have:
// INITIALISIERUNG runs ONCE when an SGBD is loaded, shared data (shmset)
// persists across that SGBD's jobs, and ENDE runs when it is unloaded.
// MS450 hands its AIF block from init to later jobs exactly this way.
// The session also carries COMM: xsetpar lives in INITIALISIERUNG, so a
// later job's fresh VM never executes it -- without the carry, every
// ordinary job transmitted with default BMW-FAST framing and every K-line
// module got 115200 8N1 line noise.
// Keyed by SGBD; switching ECUs ends the previous session.
const sessions = new Map(); // sgbd -> { shared, inited, comm }

function sessionFor(sgbd) {
  const key = String(sgbd).toLowerCase();
  let s = sessions.get(key);
  if (!s) {
    s = { shared: new Map(), inited: false, comm: null };
    sessions.set(key, s);
  }
  return s;
}

// Run ENDE for a session being dropped. Fire-and-forget: the answer does
// not matter, but the ECU is entitled to the notification.
async function endSession(sgbd) {
  const key = String(sgbd).toLowerCase();
  const s = sessions.get(key);
  if (!s || !s.inited) {
    sessions.delete(key);
    return;
  }
  sessions.delete(key);
  try {
    const code = await webFetchJson(`data/job-code/${key}.json`);
    if (code && code.jobs && code.jobs.ENDE !== undefined) {
      await webRunJob(sgbd, 'ENDE', null, {
        noInit: true,
        shared: s.shared,
        comm: s.comm,
      });
    }
  } catch {
    /* the session is over either way */
  }
}

// The currently-loaded SGBD. EDIABAS holds one at a time; switching ends
// the old session so its ENDE runs while the bus is still up.
let loadedSgbd = null;

async function switchSession(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (loadedSgbd === key) return;
  const prev = loadedSgbd;
  loadedSgbd = key;
  // Only a REAL switch clears the wire state. `if (loadedSgbd === key) return`
  // above already skipped the no-op case, so reaching here means a different
  // ECU -- which may live on a different wire, so the remembered concept and
  // the wake that went with it do not carry over.
  //
  // NOTE this must NOT run between an SGBD's session init and its jobs: those
  // are the same session. Clearing there let the job's BMW-FAST concept
  // become the session concept, the port reopened at 115200, and the wake
  // performed at 10400 was undone before the telegram went out.
  if (prev) {
    await endSession(prev);
    webBus.sessionConcept = null;
    webBus.inited = null;
  }
}

// Run a job the way the server's /run endpoint did, but in the VM.
async function webRunJob(sgbd, job, arg, opts = {}) {
  const code = await webFetchJson(`data/job-code/${sgbd.toLowerCase()}.json`);
  if (!code) throw new Error(`no job code shipped for ${sgbd}`);
  const sharedTables = await loadSharedTables();
  const tables =
    (await webFetchJson(`data/sgbd-tables/${sgbd.toLowerCase()}.json`)) || {};
  const session = opts.shared
    ? { shared: opts.shared, inited: true, comm: opts.comm || null }
    : sessionFor(sgbd);

  // send() is synchronous but the wire is async, so drive the VM in passes:
  // each pass runs until a send whose answer we lack, which we fetch, memoise,
  // then retry from the top (the VM is deterministic, so replay is safe).
  // Memo keyed by request bytes AND occurrence index: a job that sends the same
  // telegram twice (clear-then-verify) must get the second answer, not a replay.
  const answers = new Map();
  // one clock for all passes -- a time that ticked between passes would change
  // the request bytes, miss the memo, and re-transmit an already-sent telegram
  const jobNow = new Date();
  let sendSeq = 0;
  let emptyAnswers = 0; // telegrams the wire could not answer
  let realAnswers = 0; // telegrams that came back with bytes
  for (let attempt = 0; attempt < 64; attempt++) {
    let missing = null;
    sendSeq = 0;
    const vm = new Best2Vm(code, {
      tables,
      extTables: sharedTables,
      args: arg == null ? '' : String(arg),
      // Writes permitted -- see the note on Best2Vm.allowWrites. This is the
      // main job runner, so it is what lets an actuator test reach the wire.
      allowWrites: true,
      shared: session.shared,
      inited: session.inited,
      comm: session.comm,
      now: jobNow,
      send: (out, comm) => {
        const key = `${sendSeq++}:${Array.from(out)}`;
        if (answers.has(key)) return answers.get(key);
        // Carry the wire parameters along with the request: the exchange
        // below needs the concept to frame, checksum and pace it.
        missing = { key, out: Array.from(out), comm };
        // Unwind this pass: nothing sensible to return, and continuing
        // would decode garbage. The throw is caught below; the marker
        // makes bestvm's INITIALISIERUNG handling rethrow it instead of
        // swallowing it -- an init whose telegrams were never fetched used
        // to "succeed" having sent nothing.
        const need = new Error('__need_answer__');
        need.needAnswer = true;
        throw need;
      },
    });
    try {
      const sets = vm.run(job, arg == null ? '' : String(arg));
      session.inited = true;
      session.comm = vm.comm || session.comm;
      // A job that transmitted and was answered by NOTHING did not read the
      // car. Saying so is the only honest outcome: the alternative is a
      // "clean fault memory" that is really a dead wire.
      if (emptyAnswers && !realAnswers) {
        throw ifhError(
          'IFH-0009',
          'the ECU did not answer any telegram in this job'
        );
      }
      return { sets };
    } catch (e) {
      // Only the needAnswer sentinel may turn into a wire exchange. A real
      // VM error thrown in the same pass must surface as itself, not be
      // recycled into "did not settle".
      if (!missing || !e.needAnswer) throw e;
      // A SILENT ECU IS AN ANSWER OF ZERO BYTES, NOT A DEAD JOB.
      //
      // The VM sets f.zero from the answer's length and the bytecode branches
      // on it. Tracing EDIABAS proved the SGBD relies on exactly that:
      // ms450ds0's INITIALISIERUNG holds two telegrams as constants, sends
      // "82 12 F1 1A 80", gets IFH-0009 -- and carries on to send
      // "B8 12 F1 02 1A 80", which the ECU answers. Throwing here killed the
      // job on the first telegram, so the second was never tried and a
      // perfectly reachable DME looked silent.
      //
      // Only a NO-ANSWER is swallowed this way. A damaged frame, a checksum
      // failure or a bus-level fault still throws: those mean the wire is
      // lying, and continuing would decode garbage.
      let answer;
      try {
        answer = await webBus.exchange(missing.out, missing.comm);
      } catch (err) {
        // IFH-0009 (silence) and IFH-0003 (the echo did not come back cleanly)
        // both mean THIS TELEGRAM GOT NOTHING USABLE. The SGBD's fallback
        // branches on the answer's length via `slen`, so both must arrive as
        // an empty answer or the bytecode never reaches its second telegram.
        //
        // A half-duplex K line genuinely produces both: an ECU that ignores a
        // framing answers with silence, and the stray leftover byte that
        // follows makes the NEXT echo compare fail. Treating only the timeout
        // as "no answer" left the app dying on whichever of the two happened
        // to occur first.
        if (err && (err.ifh === 'IFH-0009' || err.ifh === 'IFH-0003')) {
          answer = [];
          // REMEMBER THAT THE WIRE FAILED. The empty answer is what the SGBD's
          // fallback needs, but a job whose telegrams ALL came back empty has
          // not read the car -- it has read nothing. Without this the fault
          // screen rendered "No stored faults / clean fault memory" for a DME
          // holding nine real faults, which is the worst thing a diagnostic
          // tool can say.
          emptyAnswers++;
        } else throw err;
      }
      if (answer && answer.length) realAnswers++;
      answers.set(missing.key, answer);
    }
  }
  throw new Error('job did not settle after 64 telegram exchanges');
}

// ---------------------------------------------------------------- groups
//
// Which SGBD is this ECU? EDIABAS answers with GROUP files: d_00a4 probes
// diagnostic address 0xA4, decodes the ident answer, and reports VARIANTE
// ("MRS4"), which IS the SGBD name to load. The groups in data/groups/ are
// the same VM bytecode as any job (tools/export/sgbd_export.py); the newer
// dialect additionally resolves through the t_grtb assignment table
// (variants.json), reached by tabset/tabsetex "ZuordnungsTabelle".
// ResolveSgbdFile in the reference engine does exactly this: run the
// group's IDENTIFIKATION, read result VARIANTE from the first data set.

// name -> Promise<code|null>; the PROMISE is cached so two concurrent
// resolves of the same group fetch once.
const groupCodeCache = new Map();
let groupVariantsPromise = null;
// group -> variant. Successful resolutions only, per session: an ECU that
// did not answer may be a module that was busy, so a re-sweep asks again.
const groupVariantCache = new Map();

// data/groups files are gzipped JSON served as-is. A host that transparently
// content-decodes hands us plain JSON; take either.
async function webFetchGz(path) {
  try {
    const r = await fetch(path);
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    const isGz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    if (isGz && typeof fflate === 'undefined') {
      throw new Error('fflate decompression library not loaded');
    }
    const text = new TextDecoder('utf-8').decode(
      isGz ? fflate.gunzipSync(buf) : buf
    );
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function loadGroupCode(name) {
  const key = String(name).toLowerCase();
  if (!groupCodeCache.has(key)) {
    groupCodeCache.set(key, webFetchGz(`data/groups/${key}.json.gz`));
  }
  return groupCodeCache.get(key);
}

// The shared table files (t_pcod, t_scod, t_ausb, t_grtb): an SGBD reads
// them with `tabsetex <table>, <file>` -- ms450ds0's FS_LESEN_DETAIL looks
// its P-code up in t_pcod's PCodeTexte. Loaded once, given to every VM.
let sharedTablesPromise = null;
function loadSharedTables() {
  if (!sharedTablesPromise) {
    sharedTablesPromise = webFetchGz('data/groups/shared-tables.json.gz')
      .then((t) => (t && typeof t === 'object' ? t : {}))
      .catch(() => ({}));
  }
  return sharedTablesPromise;
}

function loadGroupVariants() {
  if (!groupVariantsPromise) {
    groupVariantsPromise = webFetchJson('data/groups/variants.json');
  }
  return groupVariantsPromise;
}

// Resolve one group to a concrete variant over the live bus: run the
// group's IDENTIFIKATION exactly the way webRunJob drives a job (passes
// with memoised answers over webBus.exchange), and return the VARIANTE it
// reports, LOWERCASED -- that is the SGBD name every loader here expects.
// Returns null when nothing answered, the answer matched no variant, or
// the group could not be loaded; never a made-up name. IDENTIFIKATION is a
// read (IDENT is a strong read token), so no allowWrites is involved.
// Why the last webResolveVariant call answered null -- the gate screens
// read this so a failed probe reports WHICH way it failed instead of a
// generic "no answer". Five exits share that null, and on a live car they
// mean completely different things (silent bus vs. answered-but-unmatched).
let _lastResolve = null;
function webResolveVariantLast() {
  return _lastResolve;
}

async function webResolveVariant(groupName) {
  const key = String(groupName).toLowerCase();
  if (groupVariantCache.has(key)) return groupVariantCache.get(key);
  const diag = (path, extra) => {
    _lastResolve = { group: key, path, ...extra };
    console.info(`[variant] ${key}: ${path}`, extra || '');
    // into the session journal too: a beta Report must say WHY a module
    // was not identified, not just that inpainit stopped afterwards
    if (typeof Journal !== 'undefined' && Journal.log) {
      Journal.log(
        'variant',
        `${key}: ${path}` + (extra ? ' ' + JSON.stringify(extra) : '')
      );
    }
  };
  const code = await loadGroupCode(key);
  if (!code || !code.jobs || code.jobs.IDENTIFIKATION === undefined) {
    diag('no-probe-shipped');
    return null;
  }
  const variants = await loadGroupVariants();

  // The group's OWN tables (tabset dialect: d_0032 reaches its embedded
  // ZuordnungsTabelle copy with a plain `tabset`), plus t_grtb for the
  // `tabsetex "ZuordnungsTabelle", "t_grtb"` dialect. Each side also
  // stands in for the other defensively: exports that predate local
  // tables get the t_grtb master under the local name (its keys embed the
  // address, so the same rows match), and a missing variants.json falls
  // back to the group's local copies as t_grtb -- but where both exist,
  // the real source wins (local copy for tabset, the t_grtb dump for
  // tabsetex), which is what the engine reads in each case.
  const tables = Object.assign({}, code.tables || {});
  const extTables = { t_grtb: Object.assign({}, code.tables || {}) };
  if (variants && Array.isArray(variants.rows)) {
    const tname = variants.table || 'ZuordnungsTabelle';
    extTables.t_grtb[tname] = variants.rows;
    const hasLocal = Object.keys(tables).some(
      (k) => k.toUpperCase() === tname.toUpperCase()
    );
    if (!hasLocal) tables[tname] = variants.rows;
  }

  const answers = new Map();
  const jobNow = new Date();
  let sets = null;
  let emptyAnswers = 0; // telegrams the wire could not answer
  let realAnswers = 0; // telegrams that came back with bytes
  try {
    for (let attempt = 0; attempt < 64; attempt++) {
      let missing = null;
      let sendSeq = 0;
      const vm = new Best2Vm(code, {
        tables,
        extTables,
        args: '',
        // Group probing walks diagnostic addresses to find out WHICH module
        // answers, so it must never transmit anything that changes one. It
        // only ever needs idents, and this stays refused on purpose.
        allowWrites: false,
        now: jobNow,
        send: (out, comm) => {
          const k = `${sendSeq++}:${Array.from(out)}`;
          if (answers.has(k)) return answers.get(k);
          missing = { key: k, out: Array.from(out), comm };
          const need = new Error('__need_answer__');
          need.needAnswer = true;
          throw need;
        },
      });
      try {
        sets = vm.run('IDENTIFIKATION', '');
        break;
      } catch (e) {
        if (!missing || !e.needAnswer) throw e;
        let answer;
        try {
          answer = await webBus.exchange(missing.out, missing.comm);
        } catch (err) {
          // A GROUP PROBES SEVERAL PROTOCOLS AT ONE ADDRESS, AND SILENCE ON
          // ONE OF THEM IS A NORMAL STEP, NOT THE END OF THE JOB. d_0012
          // opens with a DS2 frame (12 04 00), then falls back to KWP2000*
          // (B8 12 F1 02 1A 80). An MS45 ignores the first and answers the
          // second -- verified against EDIABAS's own ifh.trc on a real E46,
          // which logs SetError EDIABAS_IFH_0009 on the DS2 probe and keeps
          // going. The bytecode branches on the answer's LENGTH (slen), so
          // an empty answer is what carries it to the next telegram.
          //
          // Letting that rejection escape to the outer catch returned "no
          // variant" for a DME that was answering perfectly, and the sweep
          // drew it as "not installed" -- hiding ten real stored faults.
          // This is the same rule webRunJob already applies (see its
          // IFH-0009/IFH-0003 branch); the resolver never got it.
          if (err && (err.ifh === 'IFH-0009' || err.ifh === 'IFH-0003')) {
            answer = [];
            emptyAnswers++;
          } else throw err;
        }
        if (answer && answer.length) realAnswers++;
        answers.set(missing.key, answer);
      }
    }
  } catch (e) {
    // A job-level failure (bad bytecode, unusable answer) means the address
    // did not identify. Absence of an ANSWER is handled above.
    diag('probe-error', {
      error: String((e && e.message) || e),
      empty: emptyAnswers,
      real: realAnswers,
    });
    return null;
  }
  // Nothing on this address answered anything: the module is genuinely not
  // there. Distinguished from a resolution that ran but matched no variant,
  // which is a shipped-tables problem rather than a silent bus.
  if (emptyAnswers && !realAnswers) {
    diag('bus-silent', { empty: emptyAnswers });
    return null;
  }
  for (const s of sets || []) {
    if (typeof s.VARIANTE === 'string' && s.VARIANTE) {
      const v = s.VARIANTE.toLowerCase();
      diag('resolved', { variant: v, empty: emptyAnswers, real: realAnswers });
      groupVariantCache.set(key, v);
      return v;
    }
  }
  diag('answered-but-unmatched', {
    empty: emptyAnswers,
    real: realAnswers,
    sets: (sets || []).length,
  });
  return null;
}

// ---------------------------------------------------------------- coding write
//
// The ONE explicitly-coding write path. Everything else in this shim runs the
// VM with allowWrites:false (webRunJob) and the /clear|write|flash route 501s.
// A coding write is different: it is the app's most safety-critical action, so
// it gets its own gate, its own confirmation, and prove-by-re-read.
//
// The write permission itself lives in coding-write.js, NOT here: that module
// is the only place that constructs the VM writeable, and it does so only
// after this function has checked opts.confirmed. Keeping the write-enabling
// VM construction out of this file is deliberate -- webRunJob and every
// ordinary job run stay provably read-only (test_write_gate.js reads THIS file
// and asserts it never builds the VM writeable).
//
// It runs over the SAME bus lock as reads (withBusLock), so a coding sequence
// cannot interleave with the topbar state poll or any job on the wire.
async function webWriteCoding(sgbd, nettoHex, opts = {}) {
  if (typeof window.writeCoding !== 'function') {
    throw new Error('coding-write.js is not loaded');
  }
  if (!opts.confirmed) {
    throw new Error(
      'coding write requires an explicit confirmation ' +
        '(opts.confirmed) from the UI before it can transmit'
    );
  }
  if (!webBus.connected) throw new Error('no cable connected');

  const key = String(sgbd).toLowerCase();
  // The SGBD program, its tables, and its job list -- the same sources the
  // read path uses, so the strategy sees exactly the jobs this module exposes.
  const code = await webFetchJson(`data/job-code/${key}.json`);
  if (!code) throw new Error(`no job code shipped for ${sgbd}`);
  const tables = (await webFetchJson(`data/sgbd-tables/${key}.json`)) || {};

  // DISPATCHER PROGRAM (optional). When a derived A_<cabd> coding dispatcher
  // is shipped for this module, writeCoding runs BMW's own dispatcher instead
  // of the hand-sequenced strategy (see coding-write.js writeViaDispatch). The
  // exec ships next to the module's job-code as <sgbd>.ipoexec.json with a
  // "coding":true marker; opts.dataOrg carries the CABD word width. Absent, the
  // strategy path runs unchanged, so this is additive and safe.
  const dispatch = await webFetchJson(`data/coding-dispatch/${key}.json`);
  const dispatchOk = dispatch && dispatch.coding && dispatch.procs;

  // One SGBD is loaded at a time, exactly like a read: end the previous
  // session (its ENDE) before this one initialises, then run the whole write
  // sequence under the bus lock so nothing else touches the wire mid-coding.
  await switchSession(sgbd);
  const session = sessionFor(sgbd);
  return withBusLock(() =>
    window.writeCoding(sgbd, nettoHex, {
      confirmed: true,
      code,
      tables,
      jobs: code.jobs,
      // the bus-locked wire, called from inside the lock we already hold --
      // webBus.exchange re-enters withBusLock, which the promise chain
      // serialises, so pass the RAW exchange to avoid queuing behind ourselves
      exchange: (out, comm) => webBusRawExchange(out, comm),
      session,
      // the dispatcher program + its word width, only when shipped for this CABD
      dispatch: dispatchOk ? dispatch : null,
      dataOrg: dispatchOk ? dispatch.dataOrg || null : null,
      jobname: dispatchOk ? opts.jobname || 'SG_CODIEREN' : undefined,
    })
  );
}

// The raw exchange, unwrapped from the bus lock. webWriteCoding already holds
// the lock for the whole sequence; going through the locked webBus.exchange
// again would deadlock (the sequence's next exchange waits on a chain the
// sequence itself is blocking). Same pattern connect() uses for readState.
// `_raw` is wired in the bus-lock installation block above (hoisted); it is
// the SAME raw.exchange the locked webBus.exchange wraps.
function webBusRawExchange(out, comm) {
  if (!webBusRawExchange._raw) throw new Error('bus not initialised');
  return webBusRawExchange._raw(out, comm);
}

// ---------------------------------------------------------------- fetch shim

async function webFetchJson(path) {
  const r = await fetch(path);
  return r.ok ? r.json().catch(() => null) : null;
}

// WHERE THIS PAGE LIVES. GitHub Pages serves a project site from a subpath
// (/BMacW/), not the domain root, so "/api/chassis" would resolve to
// dader34.github.io/api/chassis -- off the site entirely. Derive the base
// from the document's own URL and hang every static path off it. Empty at a
// domain root and inside the macOS app, so both behave exactly as before.
const WEB_BASE = (
  typeof location !== 'undefined'
    ? location.pathname.replace(/\/[^/]*$/, '')
    : ''
).replace(/\/$/, '');

// Cache of chassis configs and their ECU zip buffers.
// Format: chassisId -> { config: Object, ecuZips: Map(sgbd -> ArrayBuffer) }
const CHASSIS_CACHE = new Map();

// Cache of parsed ECU files.
// Format: sgbd -> Map(filename -> content)
const ECU_CACHE = new Map();

async function loadChassis(chassisId, realFetch) {
  const upperId = chassisId.toUpperCase();
  if (CHASSIS_CACHE.has(upperId)) return CHASSIS_CACHE.get(upperId);

  // AN OFFLINE COPY HAS NO SERVER. A file:// page gets an opaque origin
  // where fetch() is blocked, so the offline export inlines each archive as
  // base64 in a <script> instead -- which file:// loads happily. Use that
  // when it is there, and only reach for the network otherwise.
  if (
    typeof BMACW_INLINE === 'object' &&
    BMACW_INLINE &&
    BMACW_INLINE[upperId]
  ) {
    const bin = atob(BMACW_INLINE[upperId]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return cacheChassis(upperId, bytes);
  }

  const fileUrl = `${WEB_BASE}/api/chassis/${upperId}.chassis`;
  const res = await realFetch(fileUrl);
  if (!res.ok)
    throw new Error(`Failed to load chassis ${upperId}: ${res.statusText}`);

  const buffer = await res.arrayBuffer();
  return cacheChassis(upperId, new Uint8Array(buffer));
}

// Unpack one .chassis and remember it. Shared by the inline and network
// paths, which differ only in where the bytes came from.
function cacheChassis(upperId, bytes) {
  if (typeof fflate === 'undefined') {
    throw new Error('fflate decompression library not loaded');
  }
  const unzipped = fflate.unzipSync(bytes);

  const configBytes = unzipped['config.json'];
  if (!configBytes)
    throw new Error(`Missing config.json in chassis ${upperId}`);
  const config = JSON.parse(new TextDecoder('utf-8').decode(configBytes));

  const ecuZips = new Map();
  for (const [name, b] of Object.entries(unzipped)) {
    if (name.startsWith('ecu/') && name.endsWith('.ecu')) {
      ecuZips.set(name.slice(4, -4).toLowerCase(), b);
    }
  }

  const data = { config, ecuZips };
  CHASSIS_CACHE.set(upperId, data);
  return data;
}

async function loadEcu(sgbd, realFetch) {
  const lowerSgbd = sgbd.toLowerCase();
  if (ECU_CACHE.has(lowerSgbd)) return ECU_CACHE.get(lowerSgbd);

  // Search cached chassis first
  let ecuZipBytes = null;
  for (const chassisData of CHASSIS_CACHE.values()) {
    if (chassisData.ecuZips.has(lowerSgbd)) {
      ecuZipBytes = chassisData.ecuZips.get(lowerSgbd);
      break;
    }
  }

  // Not in a chassis we have open yet. ECUs ship only inside their chassis
  // archive -- loose copies duplicated all 310 for 47 MB and nothing read
  // them -- so find the car that owns this SGBD and load that. Costs one
  // chassis download, after which every ECU in the same car is already here.
  if (!ecuZipBytes) {
    const idx =
      typeof BMACW_INLINE === 'object' && BMACW_INLINE && BMACW_INLINE._index
        ? BMACW_INLINE._index
        : await (
            await realFetch(`${WEB_BASE}/${WEB_API_BASE}/ecu-index.json`)
          )
            .json()
            .catch(() => null);
    const cid = idx && idx[lowerSgbd];
    if (cid) {
      const data = await loadChassis(cid, realFetch);
      ecuZipBytes = data.ecuZips.get(lowerSgbd) || null;
    }
  }

  if (!ecuZipBytes) {
    throw new Error(`ECU archive not found for ${lowerSgbd}`);
  }

  if (typeof fflate === 'undefined') {
    throw new Error('fflate decompression library not loaded');
  }
  const unzipped = fflate.unzipSync(ecuZipBytes);
  const ecuFiles = new Map();
  const decoder = new TextDecoder('utf-8');

  for (const [name, bytes] of Object.entries(unzipped)) {
    try {
      const text = decoder.decode(bytes);
      const parsed = JSON.parse(text);
      ecuFiles.set(name, parsed);
    } catch (e) {
      ecuFiles.set(name, decoder.decode(bytes));
    }
  }

  ECU_CACHE.set(lowerSgbd, ecuFiles);
  return ecuFiles;
}

// Install over window.fetch so core.js's api() needs no change at all.
function installWebShim() {
  const nativeFetch = window.fetch.bind(window);
  // OFFLINE FOLDER (file:// double-click). Every genuine file read funnels
  // through `real`: the shim passes non-/api/ paths straight here (line "if
  // (!rel.startsWith('/api/')) return real(...)"), and chassis.json,
  // ecu-index.json and the .chassis/.ecu archives load through it too. So
  // routing THIS one function through the picked directory handle covers all
  // data -- chassis, ECU, groups, coding-dispatch, sgbd-tables, job-code,
  // ISTA -- with no other change. offlineFsActive() is false on http(s) and
  // in the native app, where this is exactly nativeFetch.
  const real = async (input, init) => {
    if (
      typeof offlineFsActive === 'function' &&
      offlineFsActive() &&
      typeof offlineFsReady === 'function' &&
      offlineFsReady()
    ) {
      const url =
        typeof input === 'string' ? input : (input && input.url) || '';
      // ONLY same-origin paths belong to the folder. A genuine remote URL (the
      // ETK/faults HF fallback) must still go to the network -- rerouting it to
      // a folder read would 404 a file that was meant to come from the internet.
      // An http(s):// URL to another host is remote; a file:// URL or a bare
      // relative path is ours.
      const isRemote = /^https?:\/\//i.test(url);
      if (!isRemote) {
        let rel = url.replace(/^file:\/\/[^/]*/, '');
        if (WEB_BASE && rel.startsWith(WEB_BASE))
          rel = rel.slice(WEB_BASE.length);
        rel = rel.replace(/^\/+/, '');
        if (rel) return offlineReadFile(rel);
      }
    }
    return nativeFetch(input, init);
  };
  // Anything that needs the FILE rather than the shim's answer (the offline
  // exporter zips the archives themselves) asks for this.
  window.webRealFetch = real;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    let rel = url.replace(/^https?:\/\/[^/]+/, '');

    // Normalize path relative to WEB_BASE
    if (WEB_BASE && rel.startsWith(WEB_BASE)) {
      rel = rel.slice(WEB_BASE.length);
    }
    if (!rel.startsWith('/')) rel = '/' + rel;

    const ok = (body) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const err = (msg, status = 503) =>
      new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    // --- VM bytecode / sgbd-tables files interception (from cached ECUs)
    if (
      rel.startsWith('/data/job-code/') &&
      rel !== '/data/job-code/index.json'
    ) {
      const sgbd = rel
        .split('?')[0]
        .split('/')
        .pop()
        .replace(/\.json$/, '')
        .toLowerCase();
      try {
        const ecu = await loadEcu(sgbd, real);
        const code = ecu.get('job-code.json');
        if (!code) return err(`Job code not found for ${sgbd}`, 404);
        return ok(code);
      } catch (e) {
        return err(e.message, 404);
      }
    }

    if (rel.startsWith('/data/sgbd-tables/')) {
      const sgbd = rel
        .split('?')[0]
        .split('/')
        .pop()
        .replace(/\.json$/, '')
        .toLowerCase();
      try {
        const ecu = await loadEcu(sgbd, real);
        const tables = ecu.get('sgbd-tables.json');
        if (!tables) return err(`SGBD tables not found for ${sgbd}`, 404);
        return ok(tables);
      } catch (e) {
        return err(e.message, 404);
      }
    }

    // Only route to API if prefix matches /api/
    if (!rel.startsWith('/api/')) return real(input, init);

    // --- endpoints the server computed, answered locally
    if (/^\/api\/health/.test(rel)) return ok({ ok: true, web: true });
    if (/^\/api\/port/.test(rel)) {
      return ok({ port: webBus.connected ? webBus.portLabel() : null });
    }
    if (/^\/api\/state/.test(rel)) {
      // the THOR adapter senses ignition and battery itself; ask it
      if (webBus.connected && webBus.readState) {
        try {
          const st = await webBus.readState();
          return ok({
            battery: st.battery,
            ignition: st.ignition,
            connected: true,
            derived: !!st.derived,
            detail: st.derived
              ? 'nominal: this adapter has no voltage sense'
              : null,
          });
        } catch {
          /* adapter went away; report disconnected below */
        }
      }
      return ok({
        battery: null,
        ignition: null,
        connected: webBus.connected,
        detail: webBus.connected ? null : 'no cable connected',
      });
    }

    // --- job execution
    const run = /^\/api\/ecu\/([^/]+)\/run\/([^/?]+)/.exec(rel);
    if (run) {
      const q = new URLSearchParams(rel.split('?')[1] || '');
      const arg = q.get('arg');
      // EDIABAS answers every job with a SYNTHETIC result set 0 the runtime
      // itself fills: OBJECT (the loaded SGBD), VARIANTE (its variant name),
      // JOBNAME and SAETZE. It never comes from the wire and no job declares
      // it -- inpainit's variant check reads VARIANTE from set 0 to ask "which
      // ECU file is loaded?", and without it the check compared against ''
      // and stopped every module whose .ipo gates on it. bestvm returns data
      // sets only (its set 0 is the engine's set 1), so carry the system
      // record beside them rather than renumbering every consumer.
      const systemSet = (sets) => ({
        OBJECT: run[1].toLowerCase(),
        VARIANTE: run[1].toUpperCase(),
        JOBNAME: decodeURIComponent(run[2]).toUpperCase(),
        SAETZE: (sets || []).length,
      });
      if (q.get('demo') === '1' && typeof webDemoSets === 'function') {
        const sgbd = run[1].toLowerCase();
        try {
          const ecu = await loadEcu(sgbd, real);
          const meta = ecu.get('meta.json');
          if (!meta) return err(`Metadata not found for ${sgbd}`, 404);
          const sets = webDemoSets(meta, decodeURIComponent(run[2]), arg);
          // coding reads answer with the module's own legal values (DATEN)
          if (typeof webDemoCoding === 'function') {
            await webDemoCoding(sgbd, decodeURIComponent(run[2]), sets);
          }
          // fault reads answer with faults this module can really report
          if (typeof webDemoFaults === 'function') {
            await webDemoFaults(sgbd, decodeURIComponent(run[2]), sets);
          }
          apiTrace.add({
            sgbd: run[1],
            job: decodeURIComponent(run[2]),
            arg,
            sets,
            status: (sets[0] && sets[0].JOB_STATUS) || '',
            demo: true,
          });
          return ok({ job: run[2], demo: true, sets, system: systemSet(sets) });
        } catch (e) {
          apiTrace.add({
            sgbd: run[1],
            job: decodeURIComponent(run[2]),
            arg,
            error: e.message,
            demo: true,
          });
          return err(e.message, 404);
        }
      }
      if (!webBus.connected) return err('no cable connected', 503);
      try {
        // One SGBD is "loaded" at a time, like the engine: moving to a
        // different ECU ends the previous session (ENDE) before the new
        // one initialises.
        await switchSession(run[1]);
        const r = await webRunJob(run[1], decodeURIComponent(run[2]), arg);
        apiTrace.add({
          sgbd: run[1],
          job: decodeURIComponent(run[2]),
          arg,
          sets: r.sets,
          status: (r.sets[0] && r.sets[0].JOB_STATUS) || '',
        });
        return ok({ job: run[2], sets: r.sets, system: systemSet(r.sets) });
      } catch (e) {
        apiTrace.add({
          sgbd: run[1],
          job: decodeURIComponent(run[2]),
          arg,
          error: e.message,
        });
        // A WIRE error (IFH-*) that reaches the user is where the telegram
        // trace is worth seeing -- auto-dump the recent ring buffer so the
        // failing exchange is on the console with no busTrace.start() needed.
        if (e && e.ifh) busTrace.dumpRecent(`${e.ifh} on ${run[1]}/${run[2]}`);
        return err(e.message);
      }
    }
    // The web build used to refuse these outright. Lifted at the owner's
    // request so actuator tests work; see the note on Best2Vm.allowWrites.
    // The routes below still run through the VM's own gate, which is now
    // permissive by default rather than absent.

    // --- everything else is a static file route (served from the zip archives)
    //
    // SPLIT THE PATH, NOT THE QUERY. ecu.js asks for "/api/ecu/msv80/ir?code=
    // MSV80" so the server can match a layout by INPA code, and splitting the
    // whole string leaves the last segment as "ir?code=MSV80", which matches
    // no kind. Every ECU then fell through to "no screen definition" while its
    // archive sat there holding 161 screens.
    const m = rel
      .split('?')[0]
      .replace(/^\/api\//, '')
      .split('/')
      .filter(Boolean);
    if (!m.length) return err('not found', 404);

    if (m[0] === 'chassis') {
      if (m.length === 1) {
        // The LIST, not the directory. Passing the bare /api/chassis through
        // asks the host for a path that is now a directory of .chassis
        // archives, and a static server answers with an index page -- 200,
        // text/html, and the renderer parses it as the chassis list. Name the
        // file explicitly.
        if (typeof BMACW_INLINE === 'object' && BMACW_INLINE) {
          return ok(Object.keys(BMACW_INLINE).filter((k) => k !== '_index'));
        }
        return real(`${WEB_BASE}/${WEB_API_BASE}/chassis.json`, init);
      } else {
        const cid = m[1];
        try {
          const data = await loadChassis(cid, real);
          return ok(data.config);
        } catch (e) {
          return err(e.message, 404);
        }
      }
    }

    // THE OWNER INDEX IS A STATIC FILE, NOT A ROUTE. Every /api/* path that
    // matches nothing below falls to the catch-all err() at the end, which
    // answers a 404 whose BODY is {"error": ...} -- one key. loadEcu reads
    // that as the index, finds no owner for the SGBD, and every job on a
    // variant the page has not already cached fails with "archive not found".
    //
    // On a real E46 that meant the climate unit identified as ihka46_3 and
    // then reported a CLEAN FAULT MEMORY, on a module holding two present
    // faults. Serve the file.
    if (m[0] === 'ecu-index.json') {
      if (
        typeof BMACW_INLINE === 'object' &&
        BMACW_INLINE &&
        BMACW_INLINE._index
      ) {
        return ok(BMACW_INLINE._index);
      }
      return real(`${WEB_BASE}/${WEB_API_BASE}/ecu-index.json`, init);
    }

    if (m[0] === 'ecu' && m.length >= 3) {
      const sgbd = m[1].toLowerCase();
      const kind = m[2];
      try {
        const ecu = await loadEcu(sgbd, real);
        // 'ipoexec' is the runnable execution-derived twin ({procs,byid}) the
        // live .IPO interpreter (ipovm.js) executes, shipped beside ir.json.
        // An ECU without one (an orphan, or a pre-phase-1 archive) 404s and the
        // renderer falls back to the frozen IR -- so it is optional, not fatal.
        // the variant's own config record (label, section, group): the sweep
        // names an identified variant by it when the menu lists no such row
        if (kind === 'ecu') {
          const info = ecu.get('ecu.json');
          return info ? ok(info) : err(`No record for ${sgbd}`, 404);
        }
        if (
          kind === 'jobs' ||
          kind === 'ir' ||
          kind === 'tables' ||
          kind === 'ipoexec'
        ) {
          const res = ecu.get(`${kind}.json`);
          if (!res) {
            if (kind === 'jobs') return ok([]);
            return err(`${kind} not found for ${sgbd}`, 404);
          }
          return ok(res);
        }
        if (
          (kind === 'results' || kind === 'arguments' || kind === 'table') &&
          m[3]
        ) {
          const subName = decodeURIComponent(m[3]).toUpperCase();
          const res = ecu.get(`${kind}/${subName}.json`);
          if (!res) return err(`${kind}/${subName} not found for ${sgbd}`, 404);
          return ok(res);
        }
      } catch (e) {
        // loadEcu THREW -- the archive is missing or failed to load, which
        // is not the same as a healthy archive with no jobs.json. Answering
        // ok([]) here made a broken export indistinguishable from an ECU
        // that genuinely has no jobs.
        return err(e.message, 404);
      }
    }

    return err(`no static route for ${rel}`, 404);
  };
}

if (typeof window !== 'undefined') {
  window.webBus = webBus;
  window.installWebShim = installWebShim;
  // group -> variant resolution, for the sweep screen: which SGBD answers
  // at this diagnostic address? (lowercased SGBD name, or null)
  window.webResolveVariant = webResolveVariant;
  window.webResolveVariantLast = webResolveVariantLast;
  // The explicitly-confirmed coding write path (the UI's "code this module"
  // action). Gated on opts.confirmed and its own re-read proof; see above.
  window.webWriteCoding = webWriteCoding;
  installWebShim();
}
