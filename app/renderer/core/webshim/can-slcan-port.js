/**
 * @file CAN transport over a CANable (or any slcan-firmware USB-CAN adapter)
 * using the browser's WebSerial API.
 *
 * The Lawicel slcan ASCII protocol is a plain serial line:
 *   Open:   "S8\r" (500 kbit) + "O\r"
 *   Send:   "t7DD8 01 02 03 04 05 06 07 08\r"   (11-bit, 8 DLC)
 *   Recv:   "t7DC8 20 81 cd ab ff ff ff ff\r"   (auto-pushed reply)
 *   Close:  "C\r"
 *
 * GS20 protocol: request on CAN id 0x7DD, reply auto-pushed on 0x7DC.
 * One frame out → one frame in, same as a DS2 telegram.
 *
 * Usage:
 *   const port = new SlcanPort();
 *   await port.open();
 *   port.onFrame = (id, data) => console.log(id.toString(16), data);
 *   await port.send(0x7DD, [0x20, 0, 0x00, 0xD4, 0, 0, 0, 0]);
 *   await port.close();
 *
 * Hardware: CANable, candleLight or any slcan-firmware adapter; 2-node bench
 * needs one 120 Ω termination resistor on CAN-H/L plus common GND.
 * CandleLight/gs_usb adapters use libusb and are invisible to WebSerial —
 * flash them to slcan firmware for browser use.
 */
/* exported SlcanPort */

/** slcan baud-rate command for each common bus speed. */
const SLCAN_BAUD = {
  1000000: 'S8',
  800000: 'S7',
  500000: 'S6',
  250000: 'S5',
  125000: 'S4',
  100000: 'S3',
  50000: 'S2',
  20000: 'S1',
  10000: 'S0',
};

/** GS20 TCU sends on 0x7DC; this is the only id we filter for by default. */
const GS20_REPLY_ID = 0x7dc;

/**
 * A CAN port over a Lawicel slcan adapter (WebSerial).
 */
class SlcanPort {
  /**
   * @param {object} [opts]
   * @param {number} [opts.baud=500000] - CAN bus speed in bps.
   * @param {number[]} [opts.rxIds] - 11-bit IDs to surface via onFrame; [] =
   *   all.  Default [GS20_REPLY_ID].
   */
  constructor(opts = {}) {
    this._baud = opts.baud ?? 500000;
    this._rxIds = opts.rxIds ?? [GS20_REPLY_ID];
    /** @type {SerialPort|null} */
    this._port = null;
    /** @type {ReadableStreamDefaultReader|null} */
    this._reader = null;
    /** @type {WritableStreamDefaultWriter|null} */
    this._writer = null;
    /** @type {boolean} */
    this._open = false;
    /** @type {string} - partial line accumulator */
    this._buf = '';
    /** @type {((id: number, data: Uint8Array) => void)|null} */
    this.onFrame = null;
  }

  /** Is the port currently open. */
  get connected() {
    return this._open;
  }

  /**
   * Open the WebSerial port and start the slcan session.
   * Requires a user gesture the first time (browser policy).
   * @returns {Promise<string>} The port's label.
   */
  async open() {
    this._port = await navigator.serial.requestPort({
      filters: [
        { usbVendorId: 0x0483 }, // STM32 (CANable)
        { usbVendorId: 0x16d0 }, // CANable v1 (MCP2515-based)
        { usbVendorId: 0x1d50 }, // OpenMoko / candleLight hardware
        { usbVendorId: 0x0403 }, // FTDI — slcan builds exist
      ],
    });
    await this._port.open({ baudRate: 115200 });

    this._writer = this._port.writable.getWriter();
    this._reader = this._port.readable.getReader();

    // slcan init sequence: set baud, open channel
    const baudCmd = SLCAN_BAUD[this._baud] ?? 'S6';
    await this._writeLine('C'); // close if already open
    await this._writeLine(baudCmd);
    await this._writeLine('O');

    this._open = true;
    this._startReceive();

    const info = this._port.getInfo();
    return `CAN slcan ${(info.usbVendorId || 0).toString(16)}:${(info.usbProductId || 0).toString(16)}`;
  }

  /**
   * Send one 8-byte CAN frame.
   * @param {number} id - 11-bit CAN id.
   * @param {ArrayLike<number>} data - Exactly 8 bytes.
   * @returns {Promise<void>}
   */
  async send(id, data) {
    if (!this._open) throw new Error('slcan port not open');
    const hex = Array.from(data, (b) => b.toString(16).padStart(2, '0')).join(
      ' '
    );
    const dlc = data.length & 0xf;
    const line = `t${id.toString(16).padStart(3, '0')}${dlc} ${hex}`;
    await this._writeLine(line);
  }

  /**
   * Close the channel and release the port.
   * @returns {Promise<void>}
   */
  async close() {
    this._open = false;
    try {
      await this._writeLine('C');
    } catch {
      /* already gone */
    }
    try {
      this._reader?.cancel();
    } catch {
      /* ok */
    }
    try {
      this._writer?.releaseLock();
    } catch {
      /* ok */
    }
    try {
      await this._port?.close();
    } catch {
      /* ok */
    }
    this._port = this._reader = this._writer = null;
    this._buf = '';
  }

  // ---- private ---------------------------------------------------------------

  async _writeLine(cmd) {
    const enc = new TextEncoder().encode(cmd + '\r');
    await this._writer.write(enc);
  }

  _startReceive() {
    const dec = new TextDecoder();
    const pump = async () => {
      try {
        while (this._open) {
          const { value, done } = await this._reader.read();
          if (done) break;
          this._buf += dec.decode(value, { stream: true });
          this._drainLines();
        }
      } catch {
        /* port closed or cancelled */
      }
    };
    pump();
  }

  _drainLines() {
    let nl;
    while ((nl = this._buf.indexOf('\r')) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (line) this._parseLine(line);
    }
  }

  /**
   * Parse one slcan line.  Standard receive frame:
   *   t<id3><dlc> <b0> <b1> ... <b(dlc-1)>
   * @param {string} line
   */
  _parseLine(line) {
    if (!this.onFrame) return;
    if (line[0] !== 't' && line[0] !== 'T') return; // 't'=std, 'T'=ext
    const ext = line[0] === 'T';
    const idLen = ext ? 8 : 3;
    const id = parseInt(line.slice(1, 1 + idLen), 16);
    const dlc = parseInt(line[1 + idLen], 16);
    if (isNaN(id) || isNaN(dlc)) return;
    // bytes follow as hex pairs separated by spaces (or run together)
    const payload = line.slice(1 + idLen + 1).replace(/\s/g, '');
    const data = new Uint8Array(dlc);
    for (let i = 0; i < dlc; i++) {
      data[i] = parseInt(payload.slice(i * 2, i * 2 + 2), 16) || 0;
    }
    if (this._rxIds.length && !this._rxIds.includes(id)) return;
    this.onFrame(id, data);
  }
}
