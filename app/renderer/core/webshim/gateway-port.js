/**
 * @file A cable on another machine, with the Web Serial API's shape.
 *
 * WHY. WebSerialBus is written against the four things a Web Serial port
 * offers: open/close with a PortConfig, a reader, a writer, and
 * setSignals/getSignals. Every wire fact that cost real debugging lives
 * above that line: DTR as the K-line transmit enable held for the
 * telegram's byte time, DTR idling high for BMW-FAST and D-CAN, the port
 * reopened at 9600 8E1 when a concept says so, the 5-baud slow init on the
 * break line, the echo dropped by count, a timed-out read kept on
 * `pending` so its bytes are never lost. Give the bus a port with that
 * same surface over a socket and every one of those facts still runs,
 * here, unchanged, with the cable somewhere else.
 *
 * WHAT MOVES AND WHAT DOES NOT. Bytes and modem-line states move. The
 * framing, the checksums, the session, the write confirmations and the
 * coding gates all stay in this page, because that is where the bus and
 * the app are. The machine holding the cable is a byte pipe with no gate
 * of its own, so anyone who can reach it can drive the car.
 *
 * WHERE THIS WORKS. A page served over http (localhost, the offline export
 * on a LAN, a file:// export) may open a plain ws:// socket. The hosted
 * https site may NOT: a browser blocks ws:// from an https page as mixed
 * content, with no override. From https only wss:// works, which means a
 * TLS front end in front of the gateway with a certificate the browser
 * trusts. Settings says so too, in the same words.
 *
 * The protocol is the CLI's `bmweb gateway`: JSON text frames for control
 * ({id, op, ...} answered with {id, ok, ...}) and binary frames for the
 * bytes the wire carries, so a read crosses as one frame with no base64.
 */
/* exported GatewayPort, gatewayWsUrl, gatewaySetting */

/** The port a gateway listens on when a URL names only a host. */
const GATEWAY_DEFAULT_PORT = 6801;

/** How long a control call waits for the host's answer, in ms. */
const GATEWAY_REPLY_MS = 10000;

/**
 * Turn what a user typed into a WebSocket URL.
 *
 * `192.168.1.9:6801`, `ws://192.168.1.9:6801` and a bare host all mean the
 * same thing; anything already carrying a scheme is left alone so a wss://
 * front end can be named.
 * @param {string} value - The Settings value or the ?gateway= parameter.
 * @returns {string} The ws:// or wss:// URL, or '' when nothing was set.
 */
function gatewayWsUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^wss?:\/\//i.test(text)) return text;
  // an http(s) URL means the same host: keep the scheme's security level
  if (/^https?:\/\//i.test(text)) return text.replace(/^http/i, 'ws');
  return `ws://${text.includes(':') ? text : `${text}:${GATEWAY_DEFAULT_PORT}`}`;
}

/**
 * The gateway this page should use, if any.
 *
 * `?gateway=ws://host:port` on the URL sets the stored value as well, so a
 * link handed to someone in a workshop configures their page once and
 * survives the reload. An explicit empty `?gateway=` clears it, which is
 * the way back to the local cable without opening Settings.
 * @returns {string} The URL, or '' for the local cable.
 */
function gatewaySetting() {
  let param = null;
  try {
    param = new URLSearchParams(location.search).get('gateway');
  } catch {
    /* no location to read: the stored value stands */
  }
  if (param !== null) {
    const url = gatewayWsUrl(param);
    try {
      Settings.set('gatewayUrl', url);
    } catch {
      /* nothing to persist to; the URL still applies to this page */
    }
    return url;
  }
  try {
    return gatewayWsUrl(Settings.get('gatewayUrl', ''));
  } catch {
    return '';
  }
}

/**
 * A serial port with the Web Serial API's surface, over a gateway socket.
 *
 * The reader queues what the host streams and resolves one chunk per read,
 * or `done` once the port closes or the reader is cancelled, which is what
 * readSome and the bus's drain rely on. Waiters QUEUE rather than
 * overwrite one another: the bus races a read against a timeout and takes
 * a fresh reader on every reopen, and a single waiter slot would orphan
 * the abandoned read and hand its bytes to whichever handle happened to be
 * held.
 */
class GatewayPort {
  /**
   * @param {string} url - The gateway's ws:// or wss:// URL.
   */
  constructor(url) {
    /** @type {string} */
    this.url = url;
    /** @type {WebSocket|null} */
    this.ws = null;
    /** the device the host reports serving, for the cable chip @type {string} */
    this.device = '';
    /** is a port open on the host @type {boolean} */
    this.opened = false;
    /** chunks the host sent that no read has taken @type {Uint8Array[]} */
    this.chunks = [];
    /** reads waiting for bytes, oldest first @type {Function[]} */
    this.waiters = [];
    /** control calls in flight, by the id they will be answered with */
    this.pendingCalls = new Map();
    /** the next control message's id @type {number} */
    this.nextId = 1;
    /** why the socket went, once it has @type {string|null} */
    this.gone = null;
  }

  /**
   * Open the socket to the host. Called once, before the bus takes the
   * port, so a gateway that is not there is reported as itself rather than
   * as a dead cable.
   * @returns {Promise<void>}
   * @throws {Error} When the socket cannot be opened.
   */
  async dial() {
    if (typeof WebSocket === 'undefined')
      throw new Error('this browser has no WebSocket');
    if (/^ws:\/\//i.test(this.url) && location.protocol === 'https:')
      throw new Error(
        `${this.url} cannot be opened from an https page (the browser blocks ` +
          'a plain ws:// socket as mixed content). Use a wss:// gateway, or ' +
          'open the app over http or from an offline export.'
      );
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () =>
        reject(
          new Error(
            `cannot reach the gateway at ${this.url} (is it running, and ` +
              'reachable from this machine?)'
          )
        );
    });
    this.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this._onControl(e.data);
      else this._push(new Uint8Array(e.data));
    };
    ws.onerror = null;
    ws.onclose = (e) => {
      this.gone =
        (e && e.reason) ||
        (e && e.code === 1008
          ? 'the gateway already has a client'
          : 'the gateway closed the connection');
      this.opened = false;
      // a waiting read is told done and a waiting call is failed: a silent
      // hang here would look to the app like a dead ECU rather than a
      // dropped socket
      this._wakeAll();
      for (const p of this.pendingCalls.values())
        p.reject(new Error(`the gateway connection ended: ${this.gone}`));
      this.pendingCalls.clear();
    };
  }

  /** @returns {boolean} Is a port open on the host. */
  get connected() {
    return this.opened;
  }

  /**
   * One control message from the host: a reply, or an event.
   * @param {string} text - The JSON frame.
   * @returns {void}
   */
  _onControl(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // a frame this end cannot read is not a reply it waits on
    }
    if (typeof msg.event === 'string') {
      if (msg.event === 'hello' && typeof msg.port === 'string')
        this.device = msg.port;
      return;
    }
    const p = this.pendingCalls.get(msg.id);
    if (!p) return;
    this.pendingCalls.delete(msg.id);
    if (msg.ok === false)
      p.reject(new Error(String(msg.error || 'the gateway refused the call')));
    else p.resolve(msg);
  }

  /**
   * Send one control message and wait for its reply.
   * @param {string} op - The operation.
   * @param {Object} [extra] - The operation's fields.
   * @returns {Promise<Object>} The reply.
   */
  _call(op, extra) {
    if (!this.ws || this.gone)
      return Promise.reject(
        new Error(
          `the gateway connection is gone: ${this.gone || 'not dialled'}`
        )
      );
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(
          new Error(
            `the gateway did not answer ${op} in ${GATEWAY_REPLY_MS} ms`
          )
        );
      }, GATEWAY_REPLY_MS);
      this.pendingCalls.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, op, ...(extra || {}) }));
    });
  }

  /**
   * Open the remote device with the given settings.
   * @param {PortConfig} cfg - Baud, bits, parity.
   * @returns {Promise<void>}
   */
  async open(cfg) {
    await this._call('open', { config: cfg });
    this.chunks = [];
    this.opened = true;
  }

  /**
   * Close the remote device. A waiting read is told done.
   * @returns {Promise<void>}
   */
  async close() {
    this.opened = false;
    this._wakeAll();
    this.chunks = [];
    if (!this.gone) await this._call('close');
  }

  /**
   * Drop the socket itself, once the bus has finished with the port.
   * @returns {void}
   */
  hangUp() {
    this.opened = false;
    this._wakeAll();
    if (this.ws && !this.gone) {
      try {
        this.ws.close();
      } catch {
        /* already going */
      }
    }
    this.ws = null;
  }

  /**
   * Tell every waiting read the port is done, and forget them.
   * @returns {void}
   */
  _wakeAll() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w({ value: undefined, done: true });
  }

  /**
   * Bytes the host streamed: to the waiting read, else queued.
   * @param {Uint8Array} chunk - The bytes.
   * @returns {void}
   */
  _push(chunk) {
    if (!chunk.length) return;
    const w = this.waiters.shift();
    if (w) {
      w({ value: chunk, done: false });
      return;
    }
    this.chunks.push(chunk);
  }

  /** @returns {{getReader: Function}} The readable side. */
  get readable() {
    return {
      getReader: () => ({
        read: () => this._read(),
        cancel: async () => this._cancel(),
        releaseLock: () => {},
      }),
    };
  }

  /** @returns {{getWriter: Function}} The writable side. */
  get writable() {
    return {
      getWriter: () => ({
        write: (bytes) => this._write(bytes),
        releaseLock: () => {},
      }),
    };
  }

  /**
   * One read: the next chunk, or done when the port is closed.
   * @returns {Promise<{value: Uint8Array|undefined, done: boolean}>}
   */
  _read() {
    const next = this.chunks.shift();
    if (next) return Promise.resolve({ value: next, done: false });
    if (!this.opened) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Cancel the reader: a waiting read is told done, buffered bytes go.
   * @returns {void}
   */
  _cancel() {
    this.chunks = [];
    this._wakeAll();
  }

  /**
   * Write bytes.
   *
   * As on a local port this resolves when the bytes are on their way, not
   * when they have left the car's wire: the bus then holds DTR for the
   * telegram's own byte time as the transmit enable, and waiting for more
   * here would lengthen that hold and lose the ECU's answer.
   * @param {Uint8Array} bytes - The framed request.
   * @returns {Promise<void>}
   */
  async _write(bytes) {
    if (!this.opened) throw new Error(`${this.url} is not open`);
    if (!this.ws) throw new Error('the gateway connection is gone');
    this.ws.send(bytes);
  }

  /**
   * Drive the remote modem lines. The host keeps the lines the call does
   * not name, exactly as a local port does.
   * @param {SerialOutputSignals} s - The lines to set.
   * @returns {Promise<void>}
   */
  async setSignals(s) {
    if (!this.opened) throw new Error(`${this.url} is not open`);
    await this._call('setSignals', { signals: s });
  }

  /**
   * Read the remote modem lines (KL15 arrives on DSR of a K+DCAN cable).
   * @returns {Promise<SerialInputSignals|null>} The lines, or null when the
   *   host cannot say.
   */
  async getSignals() {
    const r = await this._call('getSignals');
    return (r && r.signals) || null;
  }

  /**
   * The USB ids. A gateway does not forward them: the chip names the
   * gateway instead, which is the fact worth showing when the cable is not
   * on this machine.
   * @returns {Object} Nothing known.
   */
  getInfo() {
    return {};
  }

  /**
   * The chip's text for a remote cable: where it is, and which device.
   * @returns {string} The label.
   */
  label() {
    const where = this.url.replace(/^wss?:\/\//i, '');
    return `gateway ${where}${this.device ? ` (${this.device})` : ''}`;
  }

  /** Web Serial's disconnect event; the socket's close stands in for it. */
  addEventListener() {}
}
