/**
 * @file The same bus, over the native bridge.
 *
 * A WKWebView has no Web Serial -- the desktop shell's web view does not offer
 * that API -- so the shell owns the port and moves
 * bytes for us (SerialProxy.cs). The framing, checksums and echo handling
 * stay in exchange.js, identical to the Web Serial path; only the four
 * primitives (open, write, read, flush) differ.
 */
/* exported NativeSerialBus */

/**
 * The transport behind the macOS shell's `window.bmacw` serial bridge.
 * @extends SerialTransportBase
 */
class NativeSerialBus extends SerialTransportBase {
  constructor() {
    super();
    /** @type {string|null} the device path the shell opened, or 'serial' */
    this.path = null;
    /** @type {PortConfig|null} */
    this.config = null;
  }

  /** @returns {boolean} Is the shell holding a port open for us. */
  get connected() {
    return !!this.path;
  }

  /**
   * Ask the shell to open its serial port at the K+DCAN default.
   * @returns {Promise<string>} The port label.
   */
  async connect() {
    const r = await window.bmacw.serialOpen(null, KDCAN.baudRate, KDCAN.parity);
    this.path = (r && r.port) || 'serial';
    this.config = KDCAN;
    return this.portLabel();
  }

  /** @returns {string} The device name without its /dev/ prefix. */
  portLabel() {
    return (this.path || '').replace('/dev/', '');
  }

  /** Close the shell's port and forget it. */
  async disconnect() {
    try {
      await window.bmacw.serialClose();
    } catch {
      /* already closed */
    }
    this.path = null;
    this.config = null;
  }

  /**
   * Reopen the port when a job's concept needs different wire settings --
   * an E46 mixes 9600 8E1 body modules with a 115200 8N1 DME, and a port
   * opened once at connect time can only speak to one of them.
   * @param {PortConfig} cfg - The settings the next telegram needs.
   */
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

  /**
   * Write one framed request through the shell and read its answer.
   *
   * NOTE: the K-line wake (fast init / slow init) lives on WebSerialBus,
   * which owns the break and DTR lines. The native bridge (window.bmacw)
   * exposes no setSignals equivalent yet, so a K-line ECU reached through
   * the desktop app still relies on the host side doing the wake.
   * @param {number[]|null} framed - The request with its checksum, or null
   *   to read a continuation frame without writing.
   * @param {number} timeoutMs - ParTimeoutStd for this read.
   * @param {CommParams} comm - The request's wire parameters.
   * @returns {Promise<number[]>} The answer frame.
   */
  async exchangeRaw(framed, timeoutMs, comm) {
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
