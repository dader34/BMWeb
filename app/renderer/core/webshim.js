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
const conceptOf = (comm) => (comm && comm.concept) || 0x10f;
const isDs2 = (c) => c === 1 || c === 5 || c === 6;

// Interface failures carry their EDIABAS IFH identity so explainError and a
// user comparing to real INPA see the same code (IFH-0009 no answer, -0003
// line/echo, -0019 truncated). SGBD-level ERROR_ECU_* stay the jobs' business.
function ifhError(code, message) {
  const e = new Error(`${code}: ${message}`);
  e.ifh = code;
  return e;
}

function withChecksum(out, comm) {
  const c = conceptOf(comm);
  if (c === 0x10c) {
    throw ifhError('IFH-0018', 'this ECU speaks ISO 9141 (5-baud slow init), '
      + 'which this transport does not implement');
  }
  let sum = 0;
  if (isDs2(c)) for (const b of out) sum ^= b;
  else for (const b of out) sum = (sum + b) & 0xff;
  return [...out, sum];
}

// Total answer length (checksum included), or null while undecidable.
function frameTotal(buf, comm) {
  const c = conceptOf(comm);
  if (isDs2(c)) return buf.length >= 2 ? buf[1] : null;
  if (c === 0x10d) return buf.length >= 4 ? buf[3] + 5 : null;
  if (buf.length < 4) return null;
  const short = buf[0] & 0x3f;
  return short ? short + 4 : buf[3] + 5;
}

function verifyChecksum(frame, comm) {
  let sum = 0;
  const body = frame.slice(0, -1);
  if (isDs2(conceptOf(comm))) for (const b of body) sum ^= b;
  else for (const b of body) sum = (sum + b) & 0xff;
  if (sum !== frame[frame.length - 1]) {
    throw ifhError('IFH-0019', 'answer checksum mismatch');
  }
}

// The serial settings a concept needs. K-line concepts run 9600 8E1; the
// BMW-FAST family stays at the cable's 115200 8N1.
function portConfig(comm) {
  const c = conceptOf(comm);
  if (isDs2(c) || c === 0x10d) {
    return { baudRate: (comm && comm.baud) || 9600,
             dataBits: 8, stopBits: 1, parity: 'even' };
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
  const echoLen = sent ? sent.length : 0;
  const deadline = Date.now() + timeoutMs;
  while (buf.length < echoLen && Date.now() < deadline) {
    const got = await pump();
    if (got && got.length) buf.push(...got);
    else await new Promise((r) => setTimeout(r, 4));
  }
  if (buf.length < echoLen) {
    throw ifhError('IFH-0003', 'no echo from the cable (is it connected to the car?)');
  }
  if (sent) {
    // Compare the echo, do not just count it. A mismatch means another
    // device drove the line while we wrote (bus collision) or the cable is
    // dropping bytes -- decoding what follows would be garbage, and
    // EdiabasLib errors here for the same reason.
    for (let i = 0; i < echoLen; i++) {
      if (buf[i] !== sent[i]) {
        throw ifhError('IFH-0003',
                       'echo did not match the request (bus collision?)');
      }
    }
  }
  buf.splice(0, echoLen);
  while (Date.now() < deadline) {
    const total = frameTotal(buf, comm);
    if (total !== null && buf.length >= total) {
      const frame = buf.slice(0, total);
      verifyChecksum(frame, comm);
      return frame;
    }
    const got = await pump();
    if (got && got.length) buf.push(...got);
    else await new Promise((r) => setTimeout(r, 4));
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
  else body = (frame[0] & 0x3f) ? frame.slice(3) : frame.slice(4);
  return body[0] === 0x7f && body[2] === 0x78;
}

// One request/answer exchange with per-concept retry. EDIABAS retransmits
// on a bad or missing answer (xreps); one retry covers the single-glitch
// case without hammering a dead bus.
async function runExchange(bus, out, comm) {
  await bus.ensureConfig(portConfig(comm));
  const framed = withChecksum(out, comm);
  const timeoutMs = (comm && comm.timeout) || 2000;
  // a `wait` in the SGBD paces the bus: honor it before writing
  if (comm && comm.waitMs) {
    await new Promise((r) => setTimeout(r, Math.min(comm.waitMs, 5000)));
  }
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let frame = await bus.exchangeRaw(framed, timeoutMs, comm);
      // keep reading while the ECU says "still working" -- bounded, so a
      // stuck ECU still fails instead of hanging the screen
      for (let pending = 0; pending < 30 && isResponsePending(frame, comm); pending++) {
        frame = await bus.exchangeRaw(null, Math.max(timeoutMs, 5000), comm);
      }
      return frame;
    } catch (e) {
      lastErr = e;
      if (!/timeout|checksum|incomplete|echo/.test(String(e.message))) throw e;
    }
  }
  throw lastErr;
}

// The same bus, over the native bridge. A WKWebView has no Web Serial -- that
// is a Chrome API, and the macOS app is a Cocoa window around WebKit -- so the
// shell owns the port and moves bytes for us (SerialProxy.cs). The framing,
// checksums and echo handling stay here, identical to the Web Serial path;
// only the four primitives differ.
class NativeSerialBus {
  constructor() { this.path = null; this.config = null; }

  get connected() { return !!this.path; }

  async connect() {
    const r = await window.bmacw.serialOpen(null, KDCAN.baudRate, KDCAN.parity);
    this.path = (r && r.port) || 'serial';
    this.config = KDCAN;
    return this.portLabel();
  }

  portLabel() { return (this.path || '').replace('/dev/', ''); }

  async disconnect() {
    try { await window.bmacw.serialClose(); } catch { /* already closed */ }
    this.path = null;
    this.config = null;
  }

  // Reopen the port when a job's concept needs different wire settings --
  // an E46 mixes 9600 8E1 body modules with a 115200 8N1 DME, and a port
  // opened once at connect time can only speak to one of them.
  async ensureConfig(cfg) {
    if (this.config && this.config.baudRate === cfg.baudRate
        && this.config.parity === cfg.parity) return;
    const r = await window.bmacw.serialOpen(this.path === 'serial'
      ? null : this.path, cfg.baudRate, cfg.parity);
    this.path = (r && r.port) || this.path;
    this.config = cfg;
  }

  async exchange(out, comm) { return runExchange(this, out, comm); }

  async exchangeRaw(framed, timeoutMs, comm) {
    if (framed) {
      // A stale partial frame from a timed-out job would be read as this
      // job's answer, so start clean.
      await window.bmacw.serialFlush();
      await window.bmacw.serialWrite(framed);
    }
    return readFrame(framed, timeoutMs,
      async () => window.bmacw.serialRead(), comm);
  }
}

class WebSerialBus {
  constructor() {
    this.port = null; this.reader = null; this.writer = null;
    this.config = null;
  }

  get connected() { return !!this.port; }

  // Must be called from a user gesture -- the browser will not show the port
  // picker otherwise. app.js wires this to the "connect cable" control.
  async connect() {
    if (!('serial' in navigator)) {
      throw new Error('This browser has no Web Serial. Use Chrome or Edge '
        + '(desktop), or the macOS app.');
    }
    this.port = await navigator.serial.requestPort();
    await this.port.open(KDCAN);
    this.config = KDCAN;
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    return this.portLabel();
  }

  // Close/reopen with a concept's wire settings. Reopening an already-
  // granted port needs no user gesture, only the first requestPort() does.
  async ensureConfig(cfg) {
    if (this.config && this.config.baudRate === cfg.baudRate
        && this.config.parity === cfg.parity) return;
    try { if (this.reader) { await this.reader.cancel(); this.reader.releaseLock(); } } catch { /* reopening */ }
    try { if (this.writer) this.writer.releaseLock(); } catch { /* reopening */ }
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
    try { if (this.reader) { await this.reader.cancel(); this.reader.releaseLock(); } } catch { /* closing */ }
    try { if (this.writer) this.writer.releaseLock(); } catch { /* closing */ }
    try { if (this.port) await this.port.close(); } catch { /* closing */ }
    this.port = this.reader = this.writer = null;
  }

  // Send one request, read one answer. The VM calls this synchronously in
  // spirit but we are async, so runJob below drives it with an await loop.
  //
  // A K-line answer ECHOES the request back first (the bus is one wire, so
  // everything sent is also heard). EdInterfaceObd drops exactly as many
  // bytes as it wrote; do the same rather than pattern-matching, because a
  // request and its answer can legitimately share a prefix.
  async exchange(out, comm) { return runExchange(this, out, comm); }

  async exchangeRaw(framed, timeoutMs, comm) {
    if (framed) {
      // Drain anything stale before a fresh write -- the same start-clean
      // the native path gets from serialFlush(). A late answer from a
      // timed-out exchange would otherwise be read as this request's echo,
      // fail the compare, and cascade IFH-0003 until the stream happens to
      // run dry.
      for (;;) {
        const { value, done } = await this.readSome(Date.now() + 2);
        if (done || !value || !value.length) break;
      }
      await this.writer.write(new Uint8Array(framed));
    }
    const deadline = Date.now() + timeoutMs;
    return readFrame(framed, timeoutMs, async () => {
      const { value, done } = await this.readSome(deadline);
      return done ? null : value;
    }, comm);
  }

  async readSome(deadline) {
    const ms = Math.max(1, deadline - Date.now());
    let timer;
    const timeout = new Promise((res) => {
      timer = setTimeout(() => res({ value: null, done: true }), ms);
    });
    try {
      return await Promise.race([this.reader.read(), timeout]);
    } finally { clearTimeout(timer); }
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
    return 'This page is served over https, which cannot open a ws:// '
      + 'connection to the adapter (mixed content), and a bare IP cannot '
      + 'have a certificate. Open this build over http:// or as an offline '
      + `copy. (${tried})`;
  }
  if (typedAddress) {
    return `No adapter answered at ${typedAddress}. Check you are joined to `
      + "the adapter's WiFi, that the address is right, and that it runs the "
      + `WebSocket firmware (vendor/esp-link-ws). (${tried})`;
  }
  return "No THOR adapter found. Join the adapter's WiFi, and check it has "
    + 'the WebSocket firmware flashed (see vendor/esp-link-ws). '
    + `(${tried})`;
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
    this.native = false;                             // shell-owned TCP socket
    this.direct = directUrl || null;                 // address the user chose
    this.usingDirect = null;                         // address that answered
    this.textFrames = false;
    this._connecting = null;                         // in-flight connect()
    this.fw = null;                                  // { type, version }
    this.state = { battery: null, ignition: null };  // last ident readings
    this.rx = [];
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
        try { ws.close(); } catch { /* never opened */ }
        rej(new Error(`no answer from ${url} within ${Math.round(ms / 1000)}s`));
      }, ms);
      ws.onopen = () => {
        clearTimeout(timer);
        if (settled) {
          // A late open after we gave up: do not hand back a socket the
          // caller has stopped waiting for, and do not leak it either.
          try { ws.close(); } catch { /* already closing */ }
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
          if (ws.readyState !== 1) { clearInterval(this.keepAlive); return; }
          try { ws.send(new Uint8Array(0)); } catch { /* closing */ }
        }, 5000);
        res(ws);
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already dead */ }
        rej(new Error(`could not open ${url}`));
      };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') { if (onText) onText(); return; }
        this.rx.push(...new Uint8Array(e.data));
      };
      ws.onclose = (e) => {
        // WHO CLOSED IT, AND WHY. A connection that dies mid-session is
        // the hardest thing to diagnose blind: the app just says "not
        // running" and every layer looks innocent. The close code names
        // the culprit -- 1006 is an abnormal close (no close frame: the
        // peer vanished or the network dropped), 1001 is going-away,
        // 1000 is a clean close somebody asked for.
        console.warn(`[thor] socket closed: code=${e && e.code} `
          + `reason="${(e && e.reason) || ''}" `
          + `clean=${e && e.wasClean} url=${url}`);
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
    this._connecting = this.connectOnce()
      .finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async connectOnce() {
    // WHAT TO TRY, IN ORDER. Direct first whenever it is possible: an
    // adapter running the WebSocket firmware needs nothing else, which is
    // the only arrangement that works on a phone. The relay and the
    // shell's socket are the fallbacks, and each one is only offered where
    // it can actually work.
    const https = typeof location !== 'undefined'
      && location.protocol === 'https:';
    const attempts = [];
    if (!https) {
      attempts.push({
        kind: 'direct',
        url: this.direct || thorDirectUrl(THOR_DEFAULT_IP),
        open: async (url) => {
          this.ws = await this.openWs(url, THOR_DIRECT_TIMEOUT_MS,
                                      () => { this.textFrames = true; });
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
        open: async () => { this.ws = await this.openWs(THOR_BRIDGE, 4000); },
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
        const fw = await this.special(0xFD, 9);
        this.fw = { type: (fw[4] << 8) | fw[5], version: (fw[6] << 8) | fw[7] };
        // the raw method, not the bus-locked wrapper installed below --
        // connect() already holds the lock, and the wrapper would deadlock
        await ThorWifiBus.prototype.readState.call(this);
        return this.portLabel();
      } catch (e) {
        failures.push(`${a.kind}: ${this.textFrames
          ? 'text frames, not a binary UART bridge' : e.message}`);
        await this.dropTransport();
      }
    }
    throw new Error(thorAdviceFor(failures, https, this.direct));
  }

  // Undo a failed attempt so the next one starts clean.
  async dropTransport() {
    clearInterval(this.keepAlive);
    this.keepAlive = null;
    try { if (this.ws) this.ws.close(); } catch { /* already gone */ }
    if (this.native) {
      try { await window.bmacw.tcpClose(); } catch { /* already gone */ }
    }
    this.ws = null;
    this.native = false;
    this.usingDirect = null;
    this.textFrames = false;
    this.rx.length = 0;
  }

  portLabel() {
    const v = this.fw ? ` v${this.fw.version >> 8}.${this.fw.version & 0xff}` : '';
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
      try { await window.bmacw.tcpClose(); } catch { /* already gone */ }
      this.native = false;
    }
    try { if (this.ws) this.ws.close(); } catch { /* already gone */ }
    this.ws = null;
    this.usingDirect = null;
  }

  // One special telegram: 82 F1 F1 <cmd> <cmd> <sum8>. The adapter echoes
  // the request, then appends its answer (respLen bytes, sum8 last). Over
  // the WebSocket, bytes arrive via onmessage; over the native socket, poll
  // the shell (same shape as NativeSerialBus, and the timeout policy stays
  // here either way).
  async special(cmd, respLen, timeoutMs = 2000) {
    const req = [0x82, 0xF1, 0xF1, cmd, cmd];
    req.push(req.reduce((a, b) => (a + b) & 0xff, 0));
    if (this.native) await window.bmacw.tcpRead();  // drop anything stale
    this.rx.length = 0;
    if (this.native) await window.bmacw.tcpWrite(req);
    else this.ws.send(new Uint8Array(req));
    const want = req.length + respLen;
    const deadline = Date.now() + timeoutMs;
    while (this.rx.length < want && Date.now() < deadline) {
      if (this.native) {
        const got = await window.bmacw.tcpRead();
        if (got && got.length) { this.rx.push(...got); continue; }
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    if (this.rx.length < want) throw new Error('THOR adapter did not answer');
    const resp = this.rx.slice(req.length, want);
    const sum = resp.slice(0, -1).reduce((a, b) => (a + b) & 0xff, 0);
    if (sum !== resp[resp.length - 1]) throw new Error('THOR answer checksum bad');
    return resp;
  }

  // ignition sense + battery voltage, read from the adapter (no car protocol
  // involved). Feeds /api/state, so the topbar KL30/KL15 indicators are real.
  async readState() {
    const ign = await this.special(0xFE, 6);
    this.state.ignition = (ign[4] & 0x01) !== 0;
    if (this.fw && this.fw.type >= 2) {
      const v = await this.special(0xFC, 6);
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
  static thorConfig(comm) {
    const c = conceptOf(comm);
    const kline = isDs2(c) || c === 0x10d;
    const baud = kline ? ((comm && comm.baud) || 9600) : 115200;
    // even parity on the K-line concepts, none on BMW-FAST
    const parity = kline ? 0x01 : 0x00;
    return {
      baudHalf: baud === 115200 ? 0 : Math.floor(baud / 2),
      flags1: parity | 0x80,
      interByte: 0,
    };
  }

  thorWrap(payload, comm) {
    const cfg = ThorWifiBus.thorConfig(comm);
    const v2 = this.fw && this.fw.version >= 0x0008;
    const head = v2
      ? [0x00, 0x02, (cfg.baudHalf >> 8) & 0xff, cfg.baudHalf & 0xff,
         cfg.flags1, 0x00, cfg.interByte, 0x3c,
         (payload.length >> 8) & 0xff, payload.length & 0xff]
      : [0x00, 0x00, (cfg.baudHalf >> 8) & 0xff, cfg.baudHalf & 0xff,
         cfg.flags1, cfg.interByte,
         (payload.length >> 8) & 0xff, payload.length & 0xff];
    const tel = [...head, ...payload];
    tel.push(tel.reduce((a, b) => (a + b) & 0xff, 0));
    return tel;
  }

  async exchange(out, comm) {
    // the BMW telegram still needs its own concept checksum -- the adapter
    // wraps it, it does not compute it
    const payload = withChecksum(out, comm);
    const tel = this.thorWrap(payload, comm);
    const timeoutMs = (comm && comm.timeout) || 2000;
    if (comm && comm.waitMs) {
      await new Promise((r) => setTimeout(r, Math.min(comm.waitMs, 5000)));
    }
    if (this.native) await window.bmacw.tcpRead();      // drop anything stale
    this.rx.length = 0;
    if (this.native) await window.bmacw.tcpWrite(tel);
    else this.ws.send(new Uint8Array(tel));
    const deadline = Date.now() + timeoutMs;
    // wait for the echo first, then let the concept decide how long the
    // answer is -- same framing rules as the serial path
    while (this.rx.length < tel.length && Date.now() < deadline) {
      if (this.native) {
        const got = await window.bmacw.tcpRead();
        if (got && got.length) { this.rx.push(...got); continue; }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    if (this.rx.length < tel.length) {
      throw new Error('no echo from the THOR adapter (timeout)');
    }
    while (Date.now() < deadline) {
      const buf = this.rx.slice(tel.length);
      const total = frameTotal(buf, comm);
      if (total !== null && buf.length >= total) {
        const frame = buf.slice(0, total);
        verifyChecksum(frame, comm);
        return frame;
      }
      if (this.native) {
        const got = await window.bmacw.tcpRead();
        if (got && got.length) { this.rx.push(...got); continue; }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const partial = this.rx.length - tel.length;
    throw new Error(partial > 0
      ? `incomplete answer from ECU via THOR (${partial} bytes)`
      : 'no answer from ECU (timeout)');
  }
}

// Which transport this host can do. THOR is an explicit choice (?thor=1 or the
// Adapter setting): shell TCP in the macOS app, a direct WebSocket to the
// adapter's esp-link-ws firmware in a browser (relay is ?relay=1 only). Else the
// native serial bridge when present. Settings read from localStorage over the
// shell's injected copy, which is a reload behind right after a change.
const bootSettings = (() => {
  try {
    return { ...(window.__bmacwSettings || {}),
             ...JSON.parse(localStorage.getItem('bmacw.settings') || '{}') };
  } catch { return {}; }
})();
const bootQuery = (() => {
  try { return new URLSearchParams(location.search); }
  catch { return new URLSearchParams(); }
})();

const wantThor = (() => {
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
  const s = bootSettings.thorAddress;      // honoured if an old copy set it
  return s ? thorDirectUrl(s) : null;
})();

const webBus = wantThor ? new ThorWifiBus(thorDirect)
  : (typeof window !== 'undefined' && window.bmacw && window.bmacw.serialOpen)
    ? new NativeSerialBus() : new WebSerialBus();

// ONE EXCHANGE AT A TIME, BUS-WIDE. The K-line is half duplex and the THOR
// socket has a single rx buffer: two concurrent callers interleave writes
// and steal each other's answers -- the 3-second topbar state poll was
// clobbering any job that took longer than a second. The old C# engine
// held a bus lock server-side; the VM migration lost it. Every entry point
// that can touch the wire queues here.
let busChain = Promise.resolve();
function withBusLock(fn) {
  const run = busChain.then(fn, fn);
  busChain = run.then(() => {}, () => {});
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
const sessions = new Map();          // sgbd -> { shared, inited, comm }

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
  if (!s || !s.inited) { sessions.delete(key); return; }
  sessions.delete(key);
  try {
    const code = await webFetchJson(`data/job-code/${key}.json`);
    if (code && code.jobs && code.jobs.ENDE !== undefined) {
      await webRunJob(sgbd, 'ENDE', null,
                      { noInit: true, shared: s.shared, comm: s.comm });
    }
  } catch { /* the session is over either way */ }
}

// The currently-loaded SGBD. EDIABAS holds one at a time; switching ends
// the old session so its ENDE runs while the bus is still up.
let loadedSgbd = null;

async function switchSession(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (loadedSgbd === key) return;
  const prev = loadedSgbd;
  loadedSgbd = key;
  if (prev) await endSession(prev);
}

// Run a job the way the server's /run endpoint did, but in the VM.
async function webRunJob(sgbd, job, arg, opts = {}) {
  const code = await webFetchJson(`data/job-code/${sgbd.toLowerCase()}.json`);
  if (!code) throw new Error(`no job code shipped for ${sgbd}`);
  const tables = await webFetchJson(
    `data/sgbd-tables/${sgbd.toLowerCase()}.json`) || {};
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
  for (let attempt = 0; attempt < 64; attempt++) {
    let missing = null;
    sendSeq = 0;
    const vm = new Best2Vm(code, {
      tables,
      args: arg == null ? '' : String(arg),
      allowWrites: false,
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
      return { sets };
    } catch (e) {
      // Only the needAnswer sentinel may turn into a wire exchange. A real
      // VM error thrown in the same pass must surface as itself, not be
      // recycled into "did not settle".
      if (!missing || !e.needAnswer) throw e;
      answers.set(missing.key,
                  await webBus.exchange(missing.out, missing.comm));
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
    const text = new TextDecoder('utf-8')
      .decode(isGz ? fflate.gunzipSync(buf) : buf);
    return JSON.parse(text);
  } catch { return null; }
}

function loadGroupCode(name) {
  const key = String(name).toLowerCase();
  if (!groupCodeCache.has(key)) {
    groupCodeCache.set(key, webFetchGz(`data/groups/${key}.json.gz`));
  }
  return groupCodeCache.get(key);
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
async function webResolveVariant(groupName) {
  const key = String(groupName).toLowerCase();
  if (groupVariantCache.has(key)) return groupVariantCache.get(key);
  const code = await loadGroupCode(key);
  if (!code || !code.jobs || code.jobs.IDENTIFIKATION === undefined) {
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
    const hasLocal = Object.keys(tables)
      .some((k) => k.toUpperCase() === tname.toUpperCase());
    if (!hasLocal) tables[tname] = variants.rows;
  }

  const answers = new Map();
  const jobNow = new Date();
  let sets = null;
  try {
    for (let attempt = 0; attempt < 64; attempt++) {
      let missing = null;
      let sendSeq = 0;
      const vm = new Best2Vm(code, {
        tables,
        extTables,
        args: '',
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
        answers.set(missing.key,
                    await webBus.exchange(missing.out, missing.comm));
      }
    }
  } catch {
    // A silent address raises IFH-0009 out of the exchange; the engine's
    // ExecuteIdentJob turns any job exception into "no variant". Same here.
    return null;
  }
  for (const s of sets || []) {
    if (typeof s.VARIANTE === 'string' && s.VARIANTE) {
      const v = s.VARIANTE.toLowerCase();
      groupVariantCache.set(key, v);
      return v;
    }
  }
  return null;
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
const WEB_BASE = (typeof location !== 'undefined'
  ? location.pathname.replace(/\/[^/]*$/, '') : '').replace(/\/$/, '');

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
  if (typeof BMACW_INLINE === 'object' && BMACW_INLINE
      && BMACW_INLINE[upperId]) {
    const bin = atob(BMACW_INLINE[upperId]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return cacheChassis(upperId, bytes);
  }

  const fileUrl = `${WEB_BASE}/api/chassis/${upperId}.chassis`;
  const res = await realFetch(fileUrl);
  if (!res.ok) throw new Error(`Failed to load chassis ${upperId}: ${res.statusText}`);

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
  if (!configBytes) throw new Error(`Missing config.json in chassis ${upperId}`);
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
    const idx = (typeof BMACW_INLINE === 'object' && BMACW_INLINE
                 && BMACW_INLINE._index)
      ? BMACW_INLINE._index
      : await (await realFetch(
          `${WEB_BASE}/${WEB_API_BASE}/ecu-index.json`)).json().catch(() => null);
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
  const real = window.fetch.bind(window);
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

    const ok = (body) => new Response(JSON.stringify(body),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    const err = (msg, status = 503) => new Response(
      JSON.stringify({ error: msg }),
      { status, headers: { 'Content-Type': 'application/json' } });

    // --- VM bytecode / sgbd-tables files interception (from cached ECUs)
    if (rel.startsWith('/data/job-code/') && rel !== '/data/job-code/index.json') {
      const sgbd = rel.split('?')[0].split('/').pop()
        .replace(/\.json$/, '').toLowerCase();
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
      const sgbd = rel.split('?')[0].split('/').pop()
        .replace(/\.json$/, '').toLowerCase();
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
          return ok({ battery: st.battery, ignition: st.ignition,
                      connected: true, detail: null });
        } catch { /* adapter went away; report disconnected below */ }
      }
      return ok({ battery: null, ignition: null, connected: webBus.connected,
                  detail: webBus.connected ? null : 'no cable connected' });
    }

    // --- job execution
    const run = /^\/api\/ecu\/([^/]+)\/run\/([^/?]+)/.exec(rel);
    if (run) {
      const q = new URLSearchParams(rel.split('?')[1] || '');
      const arg = q.get('arg');
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
          return ok({ job: run[2], demo: true, sets });
        } catch (e) {
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
        return ok({ job: run[2], sets: r.sets });
      } catch (e) { return err(e.message); }
    }
    if (/^\/api\/ecu\/[^/]+\/(clear|write|flash)/.test(rel)) {
      return err('write operations are not available in the web build', 501);
    }

    // --- everything else is a static file route (served from the zip archives)
    //
    // SPLIT THE PATH, NOT THE QUERY. ecu.js asks for "/api/ecu/msv80/ir?code=
    // MSV80" so the server can match a layout by INPA code, and splitting the
    // whole string leaves the last segment as "ir?code=MSV80", which matches
    // no kind. Every ECU then fell through to "no screen definition" while its
    // archive sat there holding 161 screens.
    const m = rel.split('?')[0].replace(/^\/api\//, '').split('/').filter(Boolean);
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

    if (m[0] === 'ecu' && m.length >= 3) {
      const sgbd = m[1].toLowerCase();
      const kind = m[2];
      try {
        const ecu = await loadEcu(sgbd, real);
        if (kind === 'jobs' || kind === 'ir' || kind === 'tables') {
          const res = ecu.get(`${kind}.json`);
          if (!res) {
            if (kind === 'jobs') return ok([]);
            return err(`${kind} not found for ${sgbd}`, 404);
          }
          return ok(res);
        }
        if ((kind === 'results' || kind === 'arguments' || kind === 'table') && m[3]) {
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
  installWebShim();
}
