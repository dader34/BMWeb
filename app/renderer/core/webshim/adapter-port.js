/**
 * @file A Deep OBD style WiFi adapter (the THOR and its kin), with the Web
 * Serial API's shape.
 *
 * WHY. The bus is written against a port: open/close with a PortConfig, a
 * reader, a writer, setSignals/getSignals (see gateway-port.js, the same
 * idea over a byte pipe to another machine). A WiFi adapter running the
 * EdiabasLib custom-adapter protocol is not a serial port but it is close
 * to one, and the differences fit in a port of its own, below that line:
 *
 *   - below 115200 baud every telegram goes to the adapter WRAPPED, with
 *     the baud rate and parity in its header; the adapter puts it on the K
 *     line, KEEPS THE LINE'S ECHO TO ITSELF and streams the ECU's answer
 *     back raw. The bus drops an echo by count after every write, so this
 *     port hands it the bytes it wrote as the echo, from here;
 *   - at 115200 (the DME's programming mode, BMW-FAST, D-CAN) the adapter
 *     is a transparent line: telegrams go raw and the line echoes them, as
 *     a cable's does;
 *   - the adapter answers config telegrams of its own (8x F1 F1 <cmd> ...):
 *     ignition on FE, type and version on FD, serial on FB, voltage on FC,
 *     the escape mode on 06. Ignition is what getSignals reports, on the
 *     lines a cable reports it on (DSR/DCD);
 *   - DTR as the transmit enable is the adapter's own business: setSignals
 *     is taken and nothing is sent.
 *
 * Framing, checksums, the session, the flash sequence: all above this line,
 * unchanged. The byte pipe underneath is anything with send/onData/close: a
 * WebSocket to the emulator's adapter port for the app in a browser, the
 * native TCP socket in the iOS shell for the adapter itself.
 *
 * The protocol is EdiabasLib's EdCustomAdapterCommon / EdCustomWiFiInterface
 * (github.com/uholeschak/ediabaslib), which is what the THOR's api32.dll is.
 */
/* exported AdapterPort, WsPipe, NativePipe, adapterSetting */

/** The adapter's own address on its network and the port it listens on: the Deep OBD firmware's, or ESP-Link's (192.168.4.1:23, the THOR). */
const ADAPTER_DEFAULT_HOST = '192.168.0.10';
const ADAPTER_DEFAULT_PORT = 35000;
const ADAPTER_ESPLINK_HOST = '192.168.4.1';
const ADAPTER_ESPLINK_PORT = 23;
/** How long a config telegram may take to be answered. */
const ADAPTER_CONFIG_MS = 2000;
/** The adapter type and version from which long telegrams and the KWP timeout field exist. */
const ADAPTER_MIN_TYPE = 0x0002;
const ADAPTER_MIN_VERSION = 0x0003;
const ADAPTER_LONG_TELEGRAM_VERSION = 0x0008;
/** flags1 of a wrapped telegram. */
const KLINEF1_PARITY_EVEN = 0x1;
const KLINEF1_PARITY_ODD = 0x2;
const KLINEF1_NO_ECHO = 0x20;
const KWP1281_TIMEOUT = 60;
/** Escape mode: what the adapter config telegram 06 says and the codes it uses. */
const ESCAPE_CONF_READ = 0x01;
const ESCAPE_CONF_WRITE = 0x02;
const ESCAPE_CODE = 0xff;
const ESCAPE_MASK = 0x80;
const ESCAPE_XOR = 0x55;

/**
 * The adapter's address from the settings: 'adapter://host:port' for the
 * adapter itself (the iOS shell's TCP bridge), 'adapter+ws://host:port' for
 * the same protocol on a WebSocket (the emulator). '' when the setting
 * names no adapter.
 * @param {string} value - The setting's text.
 * @returns {{scheme: 'tcp'|'ws', host: string, port: number}|null}
 */
function adapterSetting(value) {
  const m = /^adapter(\+ws)?:\/\/([^/:]+)(?::(\d+))?\/?$/i.exec(
    String(value || '').trim()
  );
  if (!m) return null;
  const host = m[2] || ADAPTER_DEFAULT_HOST;
  return {
    scheme: m[1] ? 'ws' : 'tcp',
    host,
    port: m[3]
      ? parseInt(m[3], 10)
      : host === ADAPTER_ESPLINK_HOST
        ? ADAPTER_ESPLINK_PORT
        : ADAPTER_DEFAULT_PORT,
  };
}

function adapterSum(bytes) {
  let s = 0;
  for (const b of bytes) s = (s + b) & 0xff;
  return s;
}

/**
 * A byte pipe over a WebSocket (binary frames both ways).
 */
class WsPipe {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.onData = null;
    this.onClose = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };
      ws.onerror = () =>
        reject(new Error(`no adapter answering at ${this.url}`));
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer && this.onData)
          this.onData(new Uint8Array(e.data));
      };
      ws.onclose = () => {
        this.ws = null;
        if (this.onClose) this.onClose();
      };
    });
  }
  send(bytes) {
    if (!this.ws) throw new Error(`the adapter connection is gone`);
    this.ws.send(Uint8Array.from(bytes));
  }
  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}

/**
 * A byte pipe over the native shell's TCP socket (the iOS app): the shell
 * exposes window.bmwebTcp = {connect(host, port, id), send(id, base64),
 * close(id)} and calls window.bmwebTcpEvent(id, 'data'|'close'|'error', payload).
 */
class NativePipe {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.id = `tcp${Date.now()}${Math.floor(Math.random() * 1000)}`;
    this.onData = null;
    this.onClose = null;
    this.open = false;
  }
  connect() {
    const shell = typeof window !== 'undefined' ? window.bmwebTcp : null;
    if (!shell)
      return Promise.reject(new Error('this build has no TCP bridge'));
    return new Promise((resolve, reject) => {
      NativePipe.pipes.set(this.id, { pipe: this, resolve, reject });
      shell.connect(this.host, this.port, this.id);
    });
  }
  send(bytes) {
    if (!this.open) throw new Error('the adapter connection is gone');
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    window.bmwebTcp.send(this.id, btoa(s));
  }
  close() {
    if (this.open) window.bmwebTcp.close(this.id);
    this.open = false;
  }
  /** The shell's events, one call per event. */
  static event(id, kind, payload) {
    const entry = NativePipe.pipes.get(id);
    if (!entry) return;
    const pipe = entry.pipe;
    if (kind === 'connected') {
      pipe.open = true;
      entry.resolve();
    } else if (kind === 'data') {
      const text = atob(payload || '');
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
      if (pipe.onData) pipe.onData(bytes);
    } else if (kind === 'error') {
      if (!pipe.open) entry.reject(new Error(payload || 'connection failed'));
      pipe.open = false;
      if (pipe.onClose) pipe.onClose();
      NativePipe.pipes.delete(id);
    } else if (kind === 'close') {
      pipe.open = false;
      if (pipe.onClose) pipe.onClose();
      NativePipe.pipes.delete(id);
    }
  }
}
NativePipe.pipes = new Map();
if (typeof window !== 'undefined')
  window.bmwebTcpEvent = (id, kind, payload) =>
    NativePipe.event(id, kind, payload);

/**
 * The adapter as a port.
 */
class AdapterPort {
  /**
   * @param {WsPipe|NativePipe} pipe - The byte pipe to the adapter.
   * @param {string} where - For the label: host:port.
   */
  constructor(pipe, where) {
    this.pipe = pipe;
    this.where = where;
    this.opened = false;
    this.cfg = null;
    this.chunks = [];
    this.waiters = [];
    this.listeners = { disconnect: [] };
    this.type = -1;
    this.version = -1;
    this.serial = null;
    this.escapeRead = false;
    this.escapeWrite = false;
    this._readEscape = false;
    this.configWait = null; // {need, got, resolve, reject, timer}: a config answer being collected
    this.gone = null;
  }

  /** Connect the pipe and ask the adapter what it is. */
  async dial() {
    this.pipe.onData = (bytes) => this._onBytes(bytes);
    this.pipe.onClose = () => {
      this.gone = this.gone || 'the adapter connection closed';
      this.opened = false;
      this._wakeAll();
      this._fire('disconnect');
    };
    await this.pipe.connect();
    // Does the pipe carry a 00 byte? An ESP-Link bridge (the adapter at
    // 192.168.4.1:23) may not, so EdiabasLib probes before anything else: a
    // CAN-mode telegram with a non-zero byte must be answered, and if the
    // same with a zero is not, writes get escaped from here on
    await this._config([0x82, 0xf1, 0xf1, 0x82, 0x01], 6);
    let writeEscape = false;
    try {
      await this._config([0x82, 0xf1, 0xf1, 0x82, 0x00], 6);
    } catch {
      writeEscape = true;
    }
    // then the escape mode: asked for what the probe found, taken as the
    // adapter confirms it (its answer holds no 00 or FF, so it can be sent
    // either way)
    const want = writeEscape ? ESCAPE_CONF_WRITE : 0x00;
    const esc = await this._config(
      [
        0x84,
        0xf1,
        0xf1,
        0x06,
        want ^ ESCAPE_XOR,
        ESCAPE_CODE ^ ESCAPE_XOR,
        ESCAPE_MASK ^ ESCAPE_XOR,
      ],
      8
    ).catch(() => null);
    if (esc) {
      const mode = esc[4] ^ ESCAPE_XOR;
      this.escapeRead = !!(mode & ESCAPE_CONF_READ);
      this.escapeWrite = !!(mode & ESCAPE_CONF_WRITE);
    } else {
      this.escapeWrite = writeEscape;
    }
    const ver = await this._config([0x82, 0xf1, 0xf1, 0xfd, 0xfd], 9);
    this.type = (ver[4] << 8) | ver[5];
    this.version = (ver[6] << 8) | ver[7];
    if (this.type < ADAPTER_MIN_TYPE || this.version < ADAPTER_MIN_VERSION)
      throw new Error(
        `the adapter at ${this.where} is too old for K-line telegrams (type ${this.type}, version ${this.version >> 8}.${this.version & 0xff})`
      );
    const ser = await this._config([0x82, 0xf1, 0xf1, 0xfb, 0xfb], 13).catch(
      () => null
    );
    if (ser)
      this.serial = Array.from(ser.subarray(4, 12), (b) =>
        b.toString(16).padStart(2, '0')
      ).join('');
    // the emulator's adapter says so in its serial: its DME answers slower than the car's
    this.timeoutAllowanceMs =
      this.serial && this.serial.startsWith('4d533435454d55') ? 1500 : 0;
    return this.label();
  }

  /** The Web Serial surface -------------------------------------------- */
  async open(cfg) {
    if (this.gone) throw new Error(this.gone);
    this.cfg = { baudRate: cfg.baudRate, parity: cfg.parity || 'none' };
    this.chunks = [];
    this.opened = true;
  }
  async close() {
    this.opened = false;
    this._wakeAll();
    this.chunks = [];
  }
  hangUp() {
    this.opened = false;
    this._wakeAll();
    this.pipe.close();
  }
  get readable() {
    return {
      getReader: () => ({
        read: () => this._read(),
        cancel: async () => this._cancel(),
        releaseLock: () => {},
      }),
    };
  }
  get writable() {
    return {
      getWriter: () => ({
        write: (bytes) => this._write(bytes),
        releaseLock: () => {},
      }),
    };
  }
  async setSignals() {
    // DTR as the transmit enable, the break line: the adapter's own
    if (!this.opened)
      throw new Error(`the adapter at ${this.where} is not open`);
  }
  async getSignals() {
    const r = await this._config([0x82, 0xf1, 0xf1, 0xfe, 0xfe], 6);
    const ignition = (r[4] & 0x01) !== 0; // bit 7 is the firmware's "valid" mark
    return {
      dataSetReady: ignition,
      dataCarrierDetect: ignition,
      clearToSend: false,
    };
  }
  getInfo() {
    return {};
  }
  label() {
    const v =
      this.version >= 0 ? ` v${this.version >> 8}.${this.version & 0xff}` : '';
    return `adapter ${this.where}${v}${this.serial ? ` #${this.serial.replace(/(00)+$/, '')}` : ''}`;
  }
  addEventListener(type, fn) {
    if (this.listeners[type]) this.listeners[type].push(fn);
  }
  removeEventListener(type, fn) {
    if (this.listeners[type])
      this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
  }
  _fire(type) {
    for (const fn of this.listeners[type] || []) {
      try {
        fn();
      } catch {
        /* a listener's own trouble */
      }
    }
  }

  /** Bytes in and out ---------------------------------------------------- */
  _onBytes(raw) {
    const bytes = this.escapeRead ? this._unescape(raw) : raw;
    if (this.configWait) {
      const w = this.configWait;
      w.got.push(...bytes);
      if (w.got.length >= w.need) {
        clearTimeout(w.timer);
        this.configWait = null;
        const got = Uint8Array.from(w.got);
        if (got.length > w.need) this._push(got.subarray(w.need));
        w.resolve(got.subarray(0, w.need));
      }
      return;
    }
    this._push(Uint8Array.from(bytes));
  }
  _unescape(raw) {
    const out = [];
    for (const b of raw) {
      if (this._readEscape) {
        out.push(b ^ ESCAPE_MASK);
        this._readEscape = false;
      } else if (b === ESCAPE_CODE) {
        this._readEscape = true;
      } else out.push(b);
    }
    return out;
  }
  _escape(bytes) {
    if (!this.escapeWrite) return Uint8Array.from(bytes);
    const out = [];
    for (const b of bytes) {
      if (b === 0 || b === ESCAPE_CODE) out.push(ESCAPE_CODE, b ^ ESCAPE_MASK);
      else out.push(b);
    }
    return Uint8Array.from(out);
  }
  _push(chunk) {
    if (!chunk.length) return;
    const w = this.waiters.shift();
    if (w) {
      w({ value: chunk, done: false });
      return;
    }
    this.chunks.push(chunk);
  }
  _wakeAll() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w({ value: undefined, done: true });
  }
  _read() {
    const next = this.chunks.shift();
    if (next) return Promise.resolve({ value: next, done: false });
    if (!this.opened) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  _cancel() {
    this.chunks = [];
    this._wakeAll();
  }
  async _write(bytes) {
    if (!this.opened)
      throw new Error(`the adapter at ${this.where} is not open`);
    const data = Uint8Array.from(bytes);
    // Wrapped at every rate, 115200 included (baud field 0 in the wrapper
    // means 115200): the firmware puts a wrapped telegram on the K line
    // whatever CAN mode its EEPROM holds, whereas raw bytes go by that
    // mode, and an adapter left in D-CAN or auto would send the DME's
    // programming session to the CAN pins.
    this.pipe.send(this._escape(this._wrap(data)));
    // the echo the bus drops by count: the adapter kept the line's, so it
    // is given here, before the ECU's answer can arrive
    this._push(Uint8Array.from(data));
  }
  /** A K-line telegram wrapped for the adapter, at the port's baud and parity. */
  _wrap(data) {
    const long = this.version >= ADAPTER_LONG_TELEGRAM_VERSION;
    const fast = this.cfg.baudRate === 115200;
    const half = fast ? 0 : this.cfg.baudRate >> 1;
    let flags1 = KLINEF1_NO_ECHO;
    if (!fast) {
      if (this.cfg.parity === 'even') flags1 |= KLINEF1_PARITY_EVEN;
      else if (this.cfg.parity === 'odd') flags1 |= KLINEF1_PARITY_ODD;
    }
    const head = long
      ? [
          0x00,
          0x02,
          half >> 8,
          half & 0xff,
          flags1,
          0x00,
          0x00,
          KWP1281_TIMEOUT,
          data.length >> 8,
          data.length & 0xff,
        ]
      : [
          0x00,
          0x00,
          half >> 8,
          half & 0xff,
          flags1,
          0x00,
          data.length >> 8,
          data.length & 0xff,
        ];
    const tel = [...head, ...data];
    tel.push(adapterSum(tel));
    return Uint8Array.from(tel);
  }
  /**
   * One config telegram to the adapter: sent, echoed, answered with
   * `answerLen` bytes. Resolves to the answer (sum checked).
   */
  _config(body, answerLen) {
    const tel = [...body, adapterSum(body)];
    if (this.configWait)
      return Promise.reject(new Error('another adapter query is in flight'));
    return new Promise((resolve, reject) => {
      const need = tel.length + answerLen;
      this.configWait = {
        need,
        got: [],
        resolve: (got) => {
          for (let i = 0; i < tel.length; i++)
            if (got[i] !== tel[i])
              return reject(
                new Error('the adapter did not echo its config telegram')
              );
          const ans = got.subarray(tel.length);
          if (
            adapterSum(ans.subarray(0, ans.length - 1)) !== ans[ans.length - 1]
          )
            return reject(new Error('the adapter answered with a bad sum'));
          resolve(ans);
        },
        reject,
        timer: setTimeout(() => {
          this.configWait = null;
          reject(
            new Error(
              `the adapter at ${this.where} did not answer (${body[3].toString(16)})`
            )
          );
        }, ADAPTER_CONFIG_MS),
      };
      try {
        this.pipe.send(this._escape(tel));
      } catch (e) {
        clearTimeout(this.configWait.timer);
        this.configWait = null;
        reject(e);
      }
    });
  }
}

if (typeof module !== 'undefined' && module.exports)
  module.exports = { AdapterPort, WsPipe, NativePipe, adapterSetting };
