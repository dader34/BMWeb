/**
 * @file CAN transport to the gs20-emu emulator over a plain WebSocket.
 *
 * The emulator exposes a CAN bus via tools/kline.py --can-ws PORT.
 * Protocol: 10-byte binary WebSocket frames, both directions.
 *   [id_hi, id_lo, d0, d1, d2, d3, d4, d5, d6, d7]
 *
 * Usage:
 *   const port = new CanEmuPort('ws://localhost:8771');
 *   await port.open();
 *   port.onFrame = (id, data) => console.log(id.toString(16), data);
 *   await port.send(0x7DD, [0x20, 0, 0x00, 0xD4, 0, 0, 0, 0]);
 *   await port.close();
 *
 * Start the emulator with:
 *   .pypy/bin/pypy3 tools/kline.py --image stock --ws 8770 --can-ws 8771
 * Point BMWeb K-line at ?gateway=ws://localhost:8770 as usual, and
 * create a CanEmuPort pointed at ws://localhost:8771 for CAN commands.
 *
 * Same surface as SlcanPort and FtdiBitbangCanPort so callers are hardware-agnostic.
 */
/* exported CanEmuPort */

/** GS20 reply id — the only id surfaced by default. */
const CAN_EMU_REPLY_ID = 0x7dc;

/**
 * CAN port that speaks to the gs20-emu WebSocket CAN bridge.
 */
class CanEmuPort {
  /**
   * @param {string} [wsUrl='ws://localhost:8771'] - WebSocket URL of the emu CAN bridge.
   * @param {object} [opts]
   * @param {number[]} [opts.rxIds] - 11-bit IDs to surface via onFrame; [] = all.
   */
  constructor(wsUrl = 'ws://localhost:8771', opts = {}) {
    this._url = wsUrl;
    this._rxIds = opts.rxIds ?? [CAN_EMU_REPLY_ID];
    /** @type {WebSocket|null} */
    this._ws = null;
    this._open = false;
    /** @type {((id: number, data: Uint8Array) => void)|null} */
    this.onFrame = null;
  }

  /** Is the port currently open. */
  get connected() {
    return this._open;
  }

  /**
   * Connect to the emulator's CAN WebSocket.
   * @returns {Promise<string>} The URL it connected to.
   */
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this._ws = ws;
        this._open = true;
        resolve(this._url);
      };
      ws.onerror = () =>
        reject(new Error(`CanEmuPort: cannot connect to ${this._url}`));
      ws.onclose = () => {
        this._open = false;
        this._ws = null;
      };
      ws.onmessage = ({ data }) => {
        if (!(data instanceof ArrayBuffer)) return;
        const f = new Uint8Array(data);
        if (f.length !== 10) return;
        const id = (f[0] << 8) | f[1];
        const payload = f.slice(2);
        if (this._rxIds.length && !this._rxIds.includes(id)) return;
        if (this.onFrame) this.onFrame(id, payload);
      };
    });
  }

  /**
   * Send one 8-byte CAN frame.
   * @param {number} id - 11-bit CAN id.
   * @param {ArrayLike<number>} data - Exactly 8 bytes.
   * @returns {Promise<void>}
   */
  send(id, data) {
    if (!this._open || !this._ws)
      return Promise.reject(new Error('CanEmuPort not open'));
    const frame = new Uint8Array(10);
    frame[0] = (id >> 8) & 0xff;
    frame[1] = id & 0xff;
    for (let i = 0; i < 8; i++) frame[2 + i] = (data[i] ?? 0) & 0xff;
    this._ws.send(frame.buffer);
    return Promise.resolve();
  }

  /**
   * Close the WebSocket.
   * @returns {Promise<void>}
   */
  close() {
    this._open = false;
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        /* ok */
      }
      this._ws = null;
    }
    return Promise.resolve();
  }
}
