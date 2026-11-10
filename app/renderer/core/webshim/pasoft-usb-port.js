/**
 * @file The PA Soft "BMW Scanner V14x" cable over WebUSB.
 *
 * WHAT THE CABLE IS
 * ─────────────────
 * The adapter that ships with BMW Scanner 1.4.0.7 (P.A.Soft) is an FT232R
 * behind a small controller, with its own USB IDs (VID 0x0333 "PASOFT",
 * PID 0x0137 "BMW Scanner V14x"). macOS binds no serial driver to those IDs,
 * so Web Serial never sees it; WebUSB claims interface 0 and drives the FT232R
 * with FTDI vendor control requests, the same way can-ftdi-bitbang.js does.
 *
 * It is NOT a transparent K-line cable. The PC talks to the adapter's
 * controller in its own framing and the controller builds the bus telegram:
 *
 *   PC -> adapter  [len][cmd hi][cmd lo][module addr][payload...][sum8]
 *                  len = payload count + 3, sum8 = additive sum of all
 *                  bytes before it. Every byte goes out XORed with a rolling
 *                  key; the key drops by 0xB5 after each byte and carries
 *                  over from frame to frame for the whole connection.
 *   adapter -> PC  first the bus echo of the telegram it sent (or a 7-byte
 *                  adapter status frame 77 07 .. = done / 7A 07 .. = refused),
 *                  then the module's answer, both unscrambled.
 *
 * The command word picks an operation the adapter knows (46F1 = DS2 identify
 * "00", 06F3 = KWP "1A 80", ...). There is no generic "send these bytes"
 * word in PA Soft's program, so only operations whose word is known can be
 * used. The words that are known and read-only are in PASOFT_CMD.
 *
 * CONNECT (PA Soft 0x6C9DC4 -> 0x6CEBA8 -> 0x6CE388, proven live 2026-11-09)
 *   1. 19200 baud 8N1, read/write timeouts 800 ms, wait 300 ms.
 *   2. Purge, DTR on, 100 ms, DTR off: the adapter sends a 27-byte hello.
 *      hello[0] is the starting key, hello[1..26] are XORed with it and the
 *      XOR of all 27 raw bytes is 0. Decoded, hello[1..7] is "V144Bn9".
 *   3. A77A, addressed to hello[1], payload hello[2..7] plus the 25 bytes
 *      PA Soft keeps in its installation (the cable key, opts.license). The adapter answers
 *      77 07 77 07 77 07 70. Only the echo/status frame is read.
 *   4. Before the first module request: 83F0 to that module with
 *      E5 50 47 66 [Delay2 or 200] [Delay] (bmwscan.ini [Communication]
 *      Delay=20, Delay2=40), then the PC side goes to 9600 8E1.
 *
 * See ~/Desktop/BMW Stuff/PASoft-ghidra/live-dump-2026-11-09/CABLE.md for
 * the addresses behind each step.
 *
 * Usage:
 *   const port = new PasoftUsbPort();
 *   await port.open();            // requestDevice + FTDI setup + handshake
 *   const r = await port.identifyDs2(0x80);
 *   // r.reply = 80 12 a0 ...      (the IKE's DS2 identify answer)
 *   await port.close();
 */
/* exported PasoftCable, pasoftCable, pasoftBusRefusal, PasoftUsbPort, PASOFT_USB, PASOFT_CMD, pasoftParseKey, pasoftFrame, pasoftScramble, pasoftDecodeHello, pasoftNeed, pasoftChecksumOk, ftdiStripStatus, ftdiBaudValue, ftdiLineValue */

/** USB identity of the cable. */
const PASOFT_USB = { vendorId: 0x0333, productId: 0x0137 };

/**
 * Adapter command words with a known, read-only meaning.
 * The bus telegram each one produces was read back from the adapter's echo.
 */
const PASOFT_CMD = {
  /** Adapter: accept the PC (connect handshake). */
  hello: 0xa77a,
  /** Adapter: bus timing + switch the PC side to 9600 8E1. */
  busSetup: 0x83f0,
  /** DS2 identify: telegram [addr 04 00 cs]. */
  ds2Identify: 0x46f1,
  /** KWP identify: telegram [B8 addr F1 02 1A 80 cs]. */
  kwpIdentify: 0x06f3,
  /** KWP identify PA Soft uses for DME/DME2: telegram [B8 addr F1 01 A2 cs]. */
  kwpIdentifyDme: 0x41aa,
  /** DS2 fault memory, payload [block]: telegram [addr 05 04 block cs]. */
  ds2Faults: 0xc731,
  /** KWP fault list: telegram [B8 addr F1 04 18 02 FF FF cs]. */
  kwpFaults: 0xc358,
};

/** Length of the key A77A carries after the hello echo. */
const PASOFT_KEY_LEN = 25;

/**
 * The cable key from text. A77A carries 25 bytes the reference keeps in its
 * own installation (a 28-byte stored value, of which bytes 2..26 are sent).
 * They are the owner's, from their own copy -- never in this repository;
 * BMWeb asks for them once and keeps them in this browser only.
 * @param {string} text - 25 or 28 bytes as hex, spaces optional.
 * @returns {Uint8Array|null} The 25 bytes, or null for anything else.
 */
function pasoftParseKey(text) {
  const h = String(text || '').replace(/[\s,]|0x/gi, '');
  if (!/^([0-9a-f]{2})+$/i.test(h)) return null;
  const b = Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
  if (b.length === PASOFT_KEY_LEN) return b;
  if (b.length === PASOFT_KEY_LEN + 3) return b.subarray(2, 2 + PASOFT_KEY_LEN);
  return null;
}

/** Full handshakes (DTR pulse, hello, A77A) tried before giving up. */
const PASOFT_HANDSHAKE_TRIES = 3;
/** Pause between the adapter's hello and A77A, as PA Soft leaves it. */
const PASOFT_HELLO_GAP_MS = 120;

/**
 * Bytes as spaced hex, for messages.
 * @param {ArrayLike<number>} b
 * @returns {string}
 */
const pasoftHex = (b) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

/** Length of the adapter's hello after the DTR pulse. */
const PASOFT_HELLO_LEN = 27;
/** The key drops by this much after every transmitted byte. */
const PASOFT_KEY_STEP = 0xb5;
/** FTDI bulk endpoints of interface 0. */
const PASOFT_EP_IN = 1;
const PASOFT_EP_OUT = 2;
/** FTDI full-speed packet size; each IN packet starts with 2 status bytes. */
const PASOFT_PACKET = 64;

/** FTDI vendor bRequest values (FT232R). */
const FTDI_REQ = {
  reset: 0x00,
  modemCtrl: 0x01,
  flowCtrl: 0x02,
  baud: 0x03,
  data: 0x04,
  latency: 0x09,
};
/** wValue for FTDI_REQ.reset. */
const FTDI_RESET = { sio: 0, purgeRx: 1, purgeTx: 2 };
/** Parity codes for ftdiLineValue. */
const FTDI_PARITY = { none: 0, odd: 1, even: 2 };

// ---- pure helpers --------------------------------------------------------------

/**
 * Build one adapter frame (PA Soft 0x6CD09C).
 * @param {number} cmd - 16-bit adapter command word.
 * @param {number} addr - Module address byte.
 * @param {ArrayLike<number>} [payload] - Bytes after the address (may be empty).
 * @returns {Uint8Array} [len][cmd hi][cmd lo][addr][payload...][sum8].
 */
function pasoftFrame(cmd, addr, payload = []) {
  const n = payload.length;
  const out = new Uint8Array(n + 5);
  out[0] = (n + 3) & 0xff;
  out[1] = (cmd >> 8) & 0xff;
  out[2] = cmd & 0xff;
  out[3] = addr & 0xff;
  for (let i = 0; i < n; i++) out[4 + i] = payload[i] & 0xff;
  let sum = 0;
  for (let i = 0; i < n + 4; i++) sum += out[i];
  out[n + 4] = sum & 0xff;
  return out;
}

/**
 * Scramble bytes for the wire (PA Soft 0x6CCDD4): each byte XOR key, then
 * key -= 0xB5.
 * @param {ArrayLike<number>} bytes - Plain frame bytes.
 * @param {number} key - Key before the first byte.
 * @returns {{bytes: Uint8Array, key: number}} Wire bytes and the next key.
 */
function pasoftScramble(bytes, key) {
  const out = new Uint8Array(bytes.length);
  let k = key & 0xff;
  for (let i = 0; i < bytes.length; i++) {
    out[i] = (bytes[i] ^ k) & 0xff;
    k = (k - PASOFT_KEY_STEP) & 0xff;
  }
  return { bytes: out, key: k };
}

/**
 * Check and decode the adapter's 27-byte hello (PA Soft 0x6CE388).
 * @param {ArrayLike<number>} raw - The bytes as received.
 * @returns {{key: number, decoded: Uint8Array, id: string}|null} The starting
 *   key, the decoded bytes (decoded[0] = key), the 7-character adapter id;
 *   null when the length or the XOR check is wrong.
 */
function pasoftDecodeHello(raw) {
  if (!raw || raw.length !== PASOFT_HELLO_LEN) return null;
  let x = 0;
  for (const b of raw) x ^= b;
  if (x !== 0) return null;
  const key = raw[0];
  const decoded = new Uint8Array(PASOFT_HELLO_LEN);
  decoded[0] = key;
  for (let i = 1; i < PASOFT_HELLO_LEN; i++) decoded[i] = raw[i] ^ key;
  const id = String.fromCharCode(...decoded.subarray(1, 8));
  return { key, decoded, id };
}

/**
 * How many bytes the frame being received needs in total, after the byte at
 * buf.length - 1 arrived (PA Soft 0x6CCF80 / 0x6CCE8A). Start with need = 4.
 *   mode 1: byte 2 is the total
 *   mode 2 (DS2): byte 1 is the total
 *   mode 3 (KWP, length byte): byte 3 + 5
 *   mode 4 (KWP, length in format byte): (byte 0 & 0x3F) + 4, or byte 3 + 5
 *     when the format byte carries no length
 * On the echo read (statusFrames) 77 07 / 7A 07 frames are 7 bytes long.
 * @param {number} mode - 1..4.
 * @param {ArrayLike<number>} buf - Bytes received so far (at least one).
 * @param {number} need - The current total.
 * @param {boolean} [statusFrames] - Apply the adapter status-frame rule.
 * @returns {number} The new total.
 */
function pasoftNeed(mode, buf, need, statusFrames = false) {
  const i = buf.length - 1;
  const b = buf[i];
  let n = need;
  if (mode === 1 && i === 2) n = b;
  else if (mode === 2 && i === 1) n = b;
  else if (mode === 3 && i === 3) n = b + 5;
  else if (mode === 4) {
    if (i === 0 && buf[0] & 0x3f) n = (b & 0x3f) + 4;
    if (i === 3 && !(buf[0] & 0x3f)) n = b + 5;
  }
  if (statusFrames && i >= 1 && (buf[0] === 0x7a || buf[0] === 0x77)) {
    if (buf[1] === 7) n = 7;
  }
  return n;
}

/**
 * The receive check on a module answer (PA Soft 0x6CD05D): modes 1-3 XOR of
 * every byte is 0, mode 4 the 8-bit sum of every byte is 0.
 * @param {number} mode - 1..4.
 * @param {ArrayLike<number>} frame - The whole answer, checksum included.
 * @returns {boolean} True when the check passes.
 */
function pasoftChecksumOk(mode, frame) {
  let c = 0;
  for (const b of frame) c = mode === 4 ? (c + b) & 0xff : c ^ b;
  return c === 0;
}

/**
 * Drop the two FTDI modem-status bytes at the start of every IN packet.
 * @param {ArrayLike<number>} data - What transferIn returned (one or more
 *   packets back to back).
 * @param {number} [packetSize=64] - wMaxPacketSize of the IN endpoint.
 * @returns {Uint8Array} The UART payload bytes only.
 */
function ftdiStripStatus(data, packetSize = PASOFT_PACKET) {
  const out = [];
  for (let p = 0; p < data.length; p += packetSize) {
    const end = Math.min(p + packetSize, data.length);
    for (let i = p + 2; i < end; i++) out.push(data[i]);
  }
  return Uint8Array.from(out);
}

/**
 * The FT232R SET_BAUD_RATE wValue/wIndex for a baud rate (3 MHz base clock,
 * eighths encoded in bits 14-16).
 * @param {number} baud - Wanted rate.
 * @returns {{value: number, index: number}} Control transfer fields.
 */
function ftdiBaudValue(baud) {
  const FRAC = [0, 3, 2, 4, 1, 5, 6, 7]; // eighths -> FTDI sub-integer code
  let eighths = Math.round((3000000 * 8) / baud);
  let enc;
  if (eighths <= 8)
    enc = 0; // 3 Mbaud
  else if (eighths < 16)
    enc = 1; // 2 Mbaud
  else {
    eighths = Math.min(eighths, 0x3fff * 8 + 7);
    enc = (eighths >> 3) | (FRAC[eighths & 7] << 14);
  }
  return { value: enc & 0xffff, index: (enc >> 16) & 0xffff };
}

/**
 * The SET_DATA wValue: data bits | parity << 8 | stop code << 11.
 * @param {number} bits - Data bits (7 or 8).
 * @param {'none'|'odd'|'even'} parity - Parity.
 * @param {number} [stop=1] - Stop bits (1 or 2).
 * @returns {number} wValue.
 */
function ftdiLineValue(bits, parity, stop = 1) {
  return bits | (FTDI_PARITY[parity] << 8) | ((stop === 2 ? 2 : 0) << 11);
}

/**
 * Promise that resolves after ms milliseconds.
 * @param {number} ms - Delay.
 * @returns {Promise<void>} Resolves after the delay.
 */
function pasoftDelay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- the port ------------------------------------------------------------------

/**
 * The PA Soft cable as a request/answer port.
 */
class PasoftUsbPort {
  /**
   * @param {object} [opts]
   * @param {USB} [opts.usb] - navigator.usb or a stand-in.
   * @param {(ms: number) => Promise<void>} [opts.sleep] - Delay function
   *   (tests pass a fast one).
   * @param {number} [opts.byteTimeoutMs=800] - Per-byte read timeout
   *   (PA Soft FT_SetTimeouts 800).
   * @param {number} [opts.latencyMs=2] - FTDI latency timer.
   * @param {number} [opts.retries=1] - Resends per transfer after a failed
   *   echo/answer, a DS2 busy (A1) or a KWP 7F 21/23 (PA Soft does one).
   * @param {number} [opts.maxPending=40] - Cap on KWP 7F xx 78 re-reads.
   * @param {number} [opts.delay=20] - bmwscan.ini Delay (83F0 last byte).
   * @param {number} [opts.delay2=40] - bmwscan.ini Delay2 (83F0 byte 5).
   * @param {Uint8Array} opts.license - The 25-byte cable key (pasoftParseKey).
   * @param {(dir: string, bytes: Uint8Array) => void} [opts.trace] - Called
   *   with 'tx' (plain frame), 'wire' (scrambled), 'echo' and 'reply'.
   */
  constructor(opts = {}) {
    this._usb =
      opts.usb ?? (typeof navigator !== 'undefined' ? navigator.usb : null);
    this._sleep = opts.sleep ?? pasoftDelay;
    this._byteTimeoutMs = opts.byteTimeoutMs ?? 800;
    this._latencyMs = opts.latencyMs ?? 2;
    this._retries = opts.retries ?? 1;
    this._maxPending = opts.maxPending ?? 40;
    this._delay = opts.delay ?? 20;
    this._delay2 = opts.delay2 ?? 40;
    this._trace = opts.trace ?? null;
    this._license = opts.license ?? null;
    /** @type {USBDevice|null} */
    this._device = null;
    this._key = 0;
    this._rx = [];
    this._waiter = null;
    this._reading = false;
    this._busReady = false;
    /** @type {Promise<void>|null} the reader loop, until it ends */
    this._readerDone = null;
    /** The decoded hello after open(), or null. */
    this.hello = null;
  }

  /** True while the device is open and the handshake has passed. */
  get connected() {
    return !!this._device && !!this.hello;
  }

  /** The current scramble key (for tests and traces). */
  get key() {
    return this._key;
  }

  /**
   * Ask the user for the cable (WebUSB chooser).
   * @param {USB} [usb] - navigator.usb or a stand-in.
   * @returns {Promise<USBDevice>} The chosen device.
   */
  static requestDevice(usb) {
    const u = usb ?? navigator.usb;
    return u.requestDevice({ filters: [{ ...PASOFT_USB }] });
  }

  /**
   * Open the cable, set the FT232R up and run the adapter handshake.
   * @param {USBDevice} [device] - An already chosen device; when left out the
   *   WebUSB chooser opens.
   * @returns {Promise<{id: string, key: number}>} Adapter id and start key.
   */
  async open(device) {
    if (!this._license || this._license.length !== PASOFT_KEY_LEN)
      throw new Error('PA Soft cable: no cable key set');
    this._device = device ?? (await PasoftUsbPort.requestDevice(this._usb));
    const dev = this._device;
    // a session left open (a reconnect, a page that dropped its port) is
    // closed first, so no transfer of it is still waiting for our bytes
    if (dev.opened) {
      try {
        await dev.close();
      } catch {
        /* closed already */
      }
    }
    await dev.open();
    if (dev.configuration === null) await dev.selectConfiguration(1);
    await dev.claimInterface(0);
    await dev.selectAlternateInterface(0, 0);

    await this._ctrl(FTDI_REQ.reset, FTDI_RESET.sio);
    await this._ctrl(FTDI_REQ.latency, this._latencyMs);
    await this._ctrl(FTDI_REQ.flowCtrl, 0);
    await this._setLine(19200, 'none');
    await this._ctrl(FTDI_REQ.modemCtrl, 0x0100); // DTR off
    this._startReader();
    await this._sleep(300);

    try {
      await this._handshake();
    } catch (e) {
      await this.close();
      throw e;
    }
    return { id: this.hello.id, key: this.hello.key };
  }

  /**
   * Release the cable.
   * @returns {Promise<void>}
   */
  async close() {
    const dev = this._device;
    this._reading = false;
    this._device = null;
    this.hello = null;
    this._busReady = false;
    if (!dev) return;
    try {
      await dev.releaseInterface(0);
    } catch {
      /* already gone */
    }
    try {
      await dev.close();
    } catch {
      /* already gone */
    }
    // the reader's last transfer ends with the close; wait for it, so it
    // cannot take the first bytes of the next session
    if (this._readerDone)
      await Promise.race([this._readerDone, this._sleep(500)]);
    this._readerDone = null;
  }

  /**
   * Send 83F0 (bus timing) to a module and move the PC side to 9600 8E1.
   * transfer() does this by itself before its first request.
   * @param {number} addr - The module the first request goes to.
   * @param {boolean} [slow] - Use 200 for the second timing byte, as PA Soft
   *   does for DME, DME2, SRS, TEL, SBE and URS.
   * @returns {Promise<Uint8Array>} The adapter's status frame.
   */
  async setupBus(addr, slow = false) {
    const p = [0xe5, 0x50, 0x47, 0x66, slow ? 0xc8 : this._delay2, this._delay];
    const echo = await this._once(PASOFT_CMD.busSetup, addr, p, 2, false);
    if (echo.status !== 'ok') throw new Error('PA Soft cable: 83F0 refused');
    this._busReady = true;
    return echo.echo;
  }

  /**
   * DS2 identify (46F1, mode 2).
   * @param {number} addr - DS2 module address.
   * @param {boolean} [slow] - 83F0 slow timing if this is the first request.
   * @returns {Promise<PasoftResult>} Echo and answer.
   */
  identifyDs2(addr, slow = false) {
    return this.transfer(PASOFT_CMD.ds2Identify, addr, [], 2, { slow });
  }

  /**
   * DS2 fault count: C731 [00] = telegram 04 00; answer byte 3 is the count.
   * @param {number} addr - DS2 module address.
   * @returns {Promise<number|null>} The count, or null without an A0 answer.
   */
  async faultCountDs2(addr) {
    const r = await this.transfer(PASOFT_CMD.ds2Faults, addr, [0x00], 2);
    return r.status === 'ok' && r.reply.length > 4 ? r.reply[3] : null;
  }

  /**
   * KWP fault count: C358 = telegram 18 02 FF FF; answer 58 n ... (n at
   * byte 5).
   * @param {number} addr - Module address.
   * @returns {Promise<number|null>} The count, or null without a 58 answer.
   */
  async faultCountKwp(addr) {
    const r = await this.transfer(PASOFT_CMD.kwpFaults, addr, [], 3);
    return r.status === 'ok' && r.reply[4] === 0x58 ? r.reply[5] : null;
  }

  /**
   * KWP identify (mode 3). 06F3 sends 1A 80; 41AA (PA Soft's DME choice)
   * sends A2, which an MS45 refuses with 7F A2 11.
   * @param {number} addr - Module address (0x12 = DME).
   * @param {boolean} [dme] - Use 41AA instead of 06F3.
   * @returns {Promise<PasoftResult>} Echo and answer.
   */
  identifyKwp(addr, dme = false) {
    const cmd = dme ? PASOFT_CMD.kwpIdentifyDme : PASOFT_CMD.kwpIdentify;
    return this.transfer(cmd, addr, [], 3, { slow: dme });
  }

  /**
   * @typedef {object} PasoftResult
   * @property {'ok'|'busy'|'negative'|'refused'|'error'} status
   * @property {Uint8Array} echo - The bus telegram the adapter sent.
   * @property {Uint8Array|null} reply - The module's answer.
   * @property {number|null} nrc - KWP negative response code.
   */

  /**
   * One request with PA Soft's retry rules (0x6CD1E4): a missing echo or
   * answer is resent once; DS2 A1 waits 1.2 s and resends once; KWP 7F xx 78
   * reads again without resending; KWP 7F xx 21/23 waits 1.2 s and resends.
   * @param {number} cmd - Adapter command word.
   * @param {number} addr - Module address.
   * @param {ArrayLike<number>} payload - Bytes after the address.
   * @param {number} mode - 1, 2 (DS2), 3 (KWP length byte), 4 (KWP format).
   * @param {object} [opts]
   * @param {boolean} [opts.noReply] - Read only the echo/status frame.
   * @param {boolean} [opts.slow] - 83F0 slow timing if this is the first
   *   request of the connection.
   * @returns {Promise<PasoftResult>} Echo and answer.
   */
  async transfer(cmd, addr, payload, mode, opts = {}) {
    if (!this.connected) throw new Error('PA Soft cable: not open');
    if (!this._busReady) await this.setupBus(addr, !!opts.slow);
    let budget = opts.retries ?? this._retries;
    for (;;) {
      const r = await this._once(cmd, addr, payload, mode, !opts.noReply);
      let again = false;
      if (r.status === 'error' || r.status === 'refused') {
        again = true;
      } else if (r.status === 'busy' || r.retryable) {
        if (budget > 0) await this._sleep(1200);
        again = true;
      }
      if (!again || budget <= 0) {
        delete r.retryable;
        return r;
      }
      budget--;
    }
  }

  // ---- private -------------------------------------------------------------------

  /**
   * DTR pulse, read and check the hello, then A77A.
   * @returns {Promise<void>}
   */
  async _handshake() {
    // PA Soft (0x6CE388) pulses DTR, reads the hello and sends A77A; when
    // that fails it starts over. The adapter is given the pause PA Soft
    // leaves between the hello and A77A (about 120 ms in the capture):
    // sent within a few milliseconds of the hello, A77A could go
    // unanswered.
    let lastError = 'no hello after DTR pulse';
    for (let attempt = 0; attempt < PASOFT_HANDSHAKE_TRIES; attempt++) {
      await this._purge();
      await this._ctrl(FTDI_REQ.modemCtrl, 0x0101); // DTR on
      await this._sleep(100);
      await this._ctrl(FTDI_REQ.modemCtrl, 0x0100); // DTR off
      const raw = await this._readBytes(PASOFT_HELLO_LEN);
      const hello = raw && pasoftDecodeHello(raw);
      if (!hello) {
        lastError =
          'no hello after DTR pulse' +
          (raw ? '' : ' (heard ' + this._rx.length + ' byte(s))');
        continue;
      }
      await this._sleep(PASOFT_HELLO_GAP_MS);
      this._key = hello.key;
      const d = hello.decoded;
      const payload = new Uint8Array(6 + PASOFT_KEY_LEN);
      payload.set(d.subarray(2, 8), 0);
      payload.set(this._license, 6);
      const r = await this._once(PASOFT_CMD.hello, d[1], payload, 2, false);
      if (r.status === 'ok') {
        this.hello = hello;
        return;
      }
      const heard = r.echo && r.echo.length ? pasoftHex(r.echo) : 'nothing';
      lastError = `handshake refused (${r.status}; A77A answer: ${heard})`;
      await this._sleep(300);
    }
    this.hello = null;
    throw new Error('PA Soft cable: ' + lastError);
  }

  /**
   * One send + echo read (+ answer read), no retries.
   * @param {number} cmd - Adapter command word.
   * @param {number} addr - Module address.
   * @param {ArrayLike<number>} payload - Bytes after the address.
   * @param {number} mode - Reply length rule.
   * @param {boolean} wantReply - Read the module answer after the echo.
   * @returns {Promise<PasoftResult & {retryable?: boolean}>} The result.
   */
  async _once(cmd, addr, payload, mode, wantReply) {
    await this._purge();
    const plain = pasoftFrame(cmd, addr, payload);
    const s = pasoftScramble(plain, this._key);
    this._key = s.key;
    this._emit('tx', plain);
    this._emit('wire', s.bytes);
    await this._device.transferOut(PASOFT_EP_OUT, s.bytes);
    if (cmd === PASOFT_CMD.busSetup) {
      await this._sleep(20);
      await this._setLine(9600, 'even');
    }
    const res = { status: 'ok', echo: null, reply: null, nrc: null };
    const echo = await this._readFrame(mode, true);
    res.echo = echo.bytes;
    this._emit('echo', echo.bytes);
    if (!echo.ok) {
      res.status = echo.refused ? 'refused' : 'error';
      return res;
    }
    if (!wantReply) return res;
    for (let pending = 0; ; pending++) {
      const ans = await this._readFrame(mode, false);
      res.reply = ans.bytes;
      this._emit('reply', ans.bytes);
      if (!ans.ok || !pasoftChecksumOk(mode, ans.bytes)) {
        res.status = 'error';
        return res;
      }
      const a = ans.bytes;
      if (mode === 1) {
        res.status = a[3] === echo.bytes[3] ? 'ok' : 'error';
      } else if (mode === 2) {
        if (a[2] === 0xa1) res.status = 'busy';
        else res.status = a[2] === 0xa0 ? 'ok' : 'error';
      } else {
        const sid = mode === 3 ? 4 : 3;
        if (a[sid] === 0x7f) {
          res.nrc = a[sid + 2];
          if (res.nrc === 0x78 && pending < this._maxPending) continue;
          res.status = 'negative';
          if (res.nrc === 0x21 || res.nrc === 0x23) res.retryable = true;
        }
      }
      return res;
    }
  }

  /**
   * Read one frame with the mode's length rule.
   * @param {number} mode - 1..4.
   * @param {boolean} isEcho - Echo read: status frames count, 7A 07 = refused.
   * @returns {Promise<{ok: boolean, refused?: boolean, bytes: Uint8Array}>}
   *   ok is false on a timeout.
   */
  async _readFrame(mode, isEcho) {
    const buf = [];
    let need = 4;
    while (buf.length < need) {
      const b = await this._readByte();
      if (b < 0) return { ok: false, bytes: Uint8Array.from(buf) };
      buf.push(b);
      need = pasoftNeed(mode, buf, need, isEcho);
    }
    const bytes = Uint8Array.from(buf);
    if (isEcho && bytes[0] === 0x7a && bytes[1] === 7) {
      return { ok: false, refused: true, bytes };
    }
    return { ok: true, bytes };
  }

  /**
   * Read n bytes, each within the byte timeout.
   * @param {number} n - Count.
   * @returns {Promise<Uint8Array|null>} The bytes, or null on a timeout.
   */
  async _readBytes(n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const b = await this._readByte();
      if (b < 0) return null;
      out[i] = b;
    }
    return out;
  }

  /**
   * Next received byte, or -1 after the byte timeout.
   * @returns {Promise<number>} The byte or -1.
   */
  _readByte() {
    if (this._rx.length) return Promise.resolve(this._rx.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._waiter = null;
        resolve(-1);
      }, this._byteTimeoutMs);
      this._waiter = () => {
        clearTimeout(timer);
        this._waiter = null;
        resolve(this._rx.shift());
      };
    });
  }

  /**
   * Keep one bulk IN transfer outstanding; queue the UART bytes.
   */
  _startReader() {
    if (this._reading) return;
    this._reading = true;
    const dev = this._device;
    const loop = async () => {
      while (this._reading && this._device === dev) {
        let r;
        try {
          r = await dev.transferIn(PASOFT_EP_IN, PASOFT_PACKET * 8);
        } catch {
          break;
        }
        if (!r || !r.data) continue;
        const raw = new Uint8Array(
          r.data.buffer,
          r.data.byteOffset,
          r.data.byteLength
        );
        const bytes = ftdiStripStatus(raw);
        for (const b of bytes) this._rx.push(b);
        if (bytes.length && this._waiter) this._waiter();
      }
      this._reading = false;
    };
    this._readerDone = loop();
  }

  /**
   * Purge the chip's buffers and the local queue (PA Soft FT_Purge(3)).
   * @returns {Promise<void>}
   */
  async _purge() {
    await this._ctrl(FTDI_REQ.reset, FTDI_RESET.purgeRx);
    await this._ctrl(FTDI_REQ.reset, FTDI_RESET.purgeTx);
    this._rx.length = 0;
  }

  /**
   * Set baud rate and line properties.
   * @param {number} baud - Rate.
   * @param {'none'|'odd'|'even'} parity - Parity (8 data bits, 1 stop).
   * @returns {Promise<void>}
   */
  async _setLine(baud, parity) {
    const b = ftdiBaudValue(baud);
    await this._ctrl(FTDI_REQ.baud, b.value, b.index);
    await this._ctrl(FTDI_REQ.data, ftdiLineValue(8, parity));
  }

  /**
   * FTDI vendor control transfer OUT.
   * @param {number} request - bRequest.
   * @param {number} value - wValue.
   * @param {number} [index=0] - wIndex.
   * @returns {Promise<USBOutTransferResult>} The transfer result.
   */
  _ctrl(request, value, index = 0) {
    return this._device.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request, value, index },
      new Uint8Array(0)
    );
  }

  /**
   * Pass bytes to the trace hook.
   * @param {string} dir - 'tx', 'wire', 'echo' or 'reply'.
   * @param {Uint8Array} bytes - The bytes.
   */
  _emit(dir, bytes) {
    if (this._trace) this._trace(dir, bytes);
  }
}

// ---- the app's one PA Soft cable ---------------------------------------------

/** localStorage key that remembers the user picked this cable. */
const PASOFT_REMEMBER_KEY = 'bmweb.cable.pasoft';
/** Where this browser keeps the owner's cable key (hex). */
const PASOFT_KEY_STORE = 'bmweb.cable.pasoft.key';

/**
 * The PA Soft cable as the app sees it: connect from the top-bar chip,
 * reconnect silently after a reload, one request at a time. It is NOT the
 * webBus: SGBD jobs, coding and flashing cannot go through this cable (its
 * adapter only performs operations it has a command word for), so only
 * BMWeb Scanner talks to it.
 */
class PasoftCable {
  /**
   * @param {object} [opts] - Passed to every PasoftUsbPort it opens.
   */
  constructor(opts = {}) {
    this._opts = opts;
    /** @type {PasoftUsbPort|null} */
    this._port = null;
    this._chain = Promise.resolve();
    this._device = null;
    this._watching = false;
  }

  /** True once the handshake has passed and until the cable goes away. */
  get connected() {
    return !!this._port && this._port.connected;
  }

  /** What the top bar shows. */
  get label() {
    const id = this._port && this._port.hello ? ' ' + this._port.hello.id : '';
    return 'BMW Scanner' + id + ' (PA Soft, Scanner only)';
  }

  /** True when this browser can drive the cable at all (WebUSB). */
  static available() {
    return typeof navigator !== 'undefined' && !!navigator.usb;
  }

  /**
   * Pick the cable (WebUSB chooser; needs a user gesture) and connect.
   * @returns {Promise<string>} The label.
   */
  async connect() {
    // the chooser first: it needs the click that brought us here
    const dev = await PasoftUsbPort.requestDevice(this._opts.usb);
    if (!this.key()) {
      const text =
        typeof window !== 'undefined' && window.prompt
          ? window.prompt(
              'BMW Scanner cable key: paste the 25 bytes (hex) from your own BMW Scanner installation. Kept in this browser only.'
            )
          : null;
      if (text == null) throw new Error('the cable key is needed to connect');
      if (!this.setKey(text))
        throw new Error('that is not a cable key (25 bytes as hex)');
    }
    return this._openOn(dev);
  }

  /**
   * The owner's cable key kept in this browser, or null.
   * @returns {Uint8Array|null}
   */
  key() {
    if (this._opts.license) return this._opts.license;
    try {
      return typeof localStorage === 'undefined'
        ? null
        : pasoftParseKey(localStorage.getItem(PASOFT_KEY_STORE));
    } catch {
      return null;
    }
  }

  /**
   * Keep (or with an empty text forget) the cable key in this browser.
   * @param {string} text - Hex, as pasoftParseKey takes it.
   * @returns {boolean} False when the text is not a key.
   */
  setKey(text) {
    const k = text ? pasoftParseKey(text) : null;
    if (text && !k) return false;
    try {
      if (k)
        localStorage.setItem(
          PASOFT_KEY_STORE,
          Array.from(k, (b) => b.toString(16).padStart(2, '0')).join(' ')
        );
      else localStorage.removeItem(PASOFT_KEY_STORE);
    } catch {
      /* storage blocked */
    }
    return true;
  }

  /**
   * Reopen a cable granted before, without a chooser, when the user picked
   * it last time.
   * @returns {Promise<string|null>} The label, or null when there is none.
   */
  async reconnect() {
    if (!PasoftCable.available()) return null;
    let remembered = false;
    try {
      if (typeof window === 'undefined') return null;
      remembered = localStorage.getItem(PASOFT_REMEMBER_KEY) === '1';
    } catch {
      /* storage blocked */
    }
    if (!remembered) return null;
    const devs = await navigator.usb.getDevices();
    const dev = devs.find(
      (d) =>
        d.vendorId === PASOFT_USB.vendorId &&
        d.productId === PASOFT_USB.productId
    );
    return dev && this.key() ? this._openOn(dev) : null;
  }

  /**
   * Drop the cable.
   * @param {boolean} [forget=true] - Stop reconnecting it after a reload.
   * @returns {Promise<void>}
   */
  async disconnect(forget = true) {
    const port = this._port;
    this._port = null;
    this._device = null;
    if (forget) this._remember(false);
    if (port) await port.close();
    this._announce();
  }

  /**
   * Run one cable operation after the ones before it.
   * @template T
   * @param {(port: PasoftUsbPort) => Promise<T>} fn - The operation.
   * @returns {Promise<T>} Its result.
   */
  run(fn) {
    const go = () => {
      if (!this.connected)
        throw new Error('the BMW Scanner cable is not connected');
      return fn(this._port);
    };
    const r = this._chain.then(go, go);
    this._chain = r.then(
      () => {},
      () => {}
    );
    return r;
  }

  /**
   * @param {USBDevice} dev - The device to open.
   * @returns {Promise<string>} The label.
   */
  async _openOn(dev) {
    // one open at a time: a menu pick during the reload's reconnect waits
    // for it instead of running a second handshake on the same adapter
    while (this._opening) {
      try {
        await this._opening;
      } catch {
        /* the other open's failure is its caller's to report */
      }
    }
    const opening = this._openNow(dev);
    this._opening = opening;
    try {
      return await opening;
    } finally {
      if (this._opening === opening) this._opening = null;
    }
  }

  /**
   * @param {USBDevice} dev - The device to open.
   * @returns {Promise<string>} The label.
   */
  async _openNow(dev) {
    if (this._port) await this.disconnect(false);
    const port = new PasoftUsbPort({ ...this._opts, license: this.key() });
    await port.open(dev);
    this._port = port;
    this._device = dev;
    this._remember(true);
    this._watch();
    this._announce();
    return this.label;
  }

  /** Close when the cable is unplugged. */
  _watch() {
    if (this._watching || !PasoftCable.available()) return;
    this._watching = true;
    navigator.usb.addEventListener('disconnect', (ev) => {
      if (ev.device && ev.device === this._device) this.disconnect(false);
    });
  }

  /** @param {boolean} on - Remember the choice for the next load. */
  _remember(on) {
    if (typeof window === 'undefined') return;
    try {
      if (on) localStorage.setItem(PASOFT_REMEMBER_KEY, '1');
      else localStorage.removeItem(PASOFT_REMEMBER_KEY);
    } catch {
      /* storage blocked */
    }
  }

  /** Tell the top bar the cable state changed. */
  _announce() {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new Event('bmweb-cable'));
    }
  }
}

/** The app's one PA Soft cable. */
const pasoftCable = new PasoftCable();

/**
 * The error every bus entry point gives while only the PA Soft cable is
 * connected, or null when that is not the case.
 * @returns {Error|null} The refusal.
 */
function pasoftBusRefusal() {
  if (!pasoftCable.connected) return null;
  return new Error(
    'the BMW Scanner (PA Soft) cable only works with BMWeb Scanner; connect a K+DCAN cable for this'
  );
}

if (typeof window !== 'undefined') window.pasoftCable = pasoftCable;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PasoftCable,
    pasoftCable,
    pasoftBusRefusal,
    PasoftUsbPort,
    PASOFT_USB,
    PASOFT_CMD,
    pasoftParseKey,
    pasoftFrame,
    pasoftScramble,
    pasoftDecodeHello,
    pasoftNeed,
    pasoftChecksumOk,
    ftdiStripStatus,
    ftdiBaudValue,
    ftdiLineValue,
  };
}
