/**
 * @file The Web Serial transport: a K+DCAN cable in a desktop browser, with
 * the K-line line control (DTR transmit enable, fast init, ISO 9141 slow
 * init) that only this bus can drive.
 */
/* exported WebSerialBus */

/**
 * Sentinel for a readSome() that ran out of time. A distinct object rather
 * than null, so "no bytes yet" can never be confused with a real empty read.
 */
const TIMED_OUT = Symbol('timed-out');

/**
 * The reference interface's DtrTimeCorrCom: how much longer than the
 * telegram's byte time DTR stays up, in ms. No more -- DTR is the transmit
 * enable, so holding it longer keeps the cable talking while the ECU answers
 * and the reply is lost. An earlier +4 ms margin here produced a perfect echo
 * and no answer.
 */
const DTR_TIME_CORR_MS = 0.3;
/** Fast init: the break is held until this long after it BEGAN. */
const FAST_INIT_BREAK_MS = 25;
/** Fast init: DTR drops this long after the break began (W4 is 25-50 ms). */
const FAST_INIT_DTR_MS = 50;
/** ISO 9141 slow init: one bit time at 5 baud. */
const SLOW_INIT_BIT_MS = 200;
/** ISO 9141 slow init: how long the 0x55 sync and two key bytes may take. */
const SLOW_INIT_SYNC_MS = 1200;
/** ISO 9141 slow init: the W4 pause before the tester's inverted key byte. */
const SLOW_INIT_W4_MS = 30;
/** ISO 9141 slow init: how long the ECU's address acknowledgement may take. */
const SLOW_INIT_ACK_MS = 400;
/** ISO 9141 sync pattern the ECU answers the 5-baud address with. */
const ISO9141_SYNC = 0x55;
/** drainBuffered: the most already-resolved reads it consumes in one go. */
const DRAIN_MAX_READS = 64;
/** drainBuffered: how long a pending read gets to prove it has settled. */
const DRAIN_PROBE_MS = 2;

/**
 * The transport for a K+DCAN cable through the browser's Web Serial API.
 * @extends SerialTransportBase
 */
class WebSerialBus extends SerialTransportBase {
  constructor() {
    super();
    /** @type {SerialPort|null} */
    this.port = null;
    /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */
    this.reader = null;
    /** @type {WritableStreamDefaultWriter<Uint8Array>|null} */
    this.writer = null;
    /** @type {PortConfig|null} */
    this.config = null;
    /**
     * The one outstanding reader.read(), kept across a timed-out readSome so
     * its bytes are never orphaned.
     * @type {Promise<ReadableStreamReadResult<Uint8Array>>|null}
     */
    this.pending = null;
  }

  /** @returns {boolean} Is a port open. */
  get connected() {
    return !!this.port;
  }

  /**
   * WHICH PORT this session drives: the one seam a gateway adds.
   *
   * With a gateway configured (Settings `gatewayUrl`, or `?gateway=` on the
   * URL) the cable is on another machine, and the port is a socket to it
   * with this same Web Serial surface. Everything below this line -- the
   * framing, the line control, the reopens, the timeouts -- runs here
   * either way and cannot tell the two apart, which is the whole point of
   * putting the seam at the port rather than inside the transport.
   * @returns {Promise<SerialPort>} The port to open.
   * @throws {Error} When neither a gateway nor Web Serial can supply one.
   */
  async _acquirePort() {
    const url = typeof gatewaySetting === 'function' ? gatewaySetting() : '';
    if (url) {
      const remote = new GatewayPort(url);
      await remote.dial();
      return remote;
    }
    if (!('serial' in navigator)) {
      throw new Error(
        'This browser has no Web Serial. Use Chrome or Edge ' +
          '(desktop), or the macOS app.'
      );
    }
    return navigator.serial.requestPort();
  }

  /**
   * Open a port the user picks. Must be called from a user gesture -- the
   * browser will not show the port picker otherwise. app.js wires this to the
   * "connect cable" control. A gateway needs no gesture (there is no picker
   * to show), but it costs nothing to arrive through the same click.
   * @returns {Promise<string>} The port label.
   * @throws {Error} When no port can be acquired.
   */
  async connect() {
    this.port = await this._acquirePort();
    await this.port.open(KDCAN);
    this.config = KDCAN;
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    await this._applyIdleSignals(KDCAN);
    this._resetWireState();
    this._watchPort();
    return this.portLabel();
  }

  /**
   * Put the modem lines where the concept wants them for the whole session:
   * DTR at the config's idle level, RTS always low.
   *
   * The reference interface does this in the same switch that picks baud and
   * parity: on a plain FTDI/COM cable (an "echoing adapter" to it) DTR is
   * held HIGH for BMW-FAST and D-CAN and LOW for every K-line concept, and
   * RTS is never raised. What the browser leaves on the lines after open()
   * is platform-dependent (Windows asserts both, WICG/serial#177), and a
   * K-line exchange here ends with DTR dropped -- so without this step a
   * BMW-FAST/D-CAN module was driven with DTR low after the first K-line
   * probe of the session, which is the one way this transport differed
   * from the reference on an E60/E65/E90 bus. Ports without setSignals
   * (nothing to drive) are left alone.
   * @param {PortConfig} cfg - The settings the session runs on.
   * @returns {Promise<void>}
   */
  async _applyIdleSignals(cfg) {
    if (!this.port || !this.port.setSignals) return;
    const dtr = !!(cfg && cfg.dtr);
    await this.port.setSignals({
      dataTerminalReady: dtr,
      requestToSend: false,
    });
    busTrace.add('kline', null, `idle DTR=${dtr ? 'high' : 'low'} RTS=low`);
  }

  /**
   * Hear the cable being pulled. Web Serial fires `disconnect` on the port
   * when its device goes away; until then a pulled cable looked connected
   * (`this.port` was still set) and the chip said so until a reload. Drop
   * the wire state and tell the app (a `bmweb-cable` event on window), then
   * watch for the device coming back and reopen it silently.
   * @returns {void}
   */
  _watchPort() {
    const port = this.port;
    if (!port || typeof port.addEventListener !== 'function') return;
    port.addEventListener('disconnect', () => this._portGone(port), {
      once: true,
    });
    if (!this._replugWatched && typeof navigator !== 'undefined') {
      const serial = navigator.serial;
      if (serial && typeof serial.addEventListener === 'function') {
        this._replugWatched = true;
        serial.addEventListener('connect', () => {
          if (this.connected) return;
          this.reconnect()
            .then((label) => {
              if (label) this._announce(true);
            })
            .catch(() => {});
        });
      }
    }
  }

  /**
   * The port's device is gone: forget it without trying to close it (there
   * is nothing to close), then announce.
   * @param {SerialPort} port - the port that fired
   * @returns {void}
   */
  _portGone(port) {
    if (this.port !== port) return; // already replaced
    console.info('[serial] the cable was unplugged');
    this._releaseStreams().catch(() => {});
    this.port = this.reader = this.writer = null;
    this._resetWireState();
    this._announce(false);
  }

  /**
   * Tell the app the cable state changed.
   * @param {boolean} connected - whether a port is open now
   * @returns {void}
   */
  _announce(connected) {
    if (typeof window === 'undefined' || !window.dispatchEvent) return;
    try {
      window.dispatchEvent(
        new CustomEvent('bmweb-cable', { detail: { connected } })
      );
    } catch {
      /* no CustomEvent: nothing to announce to */
    }
  }

  /**
   * Reconnect WITHOUT a user gesture, on page load. Web Serial remembers a
   * granted port across reloads (the permission survives; only the first
   * requestPort() needs a click), so getPorts() returns it and open()
   * succeeds silently. This is what keeps the cable "connected through a
   * reload" -- the reopen-and-it-unlocks flow depends on it.
   * @returns {Promise<string|null>} The label on success, or null when
   *   nothing was previously granted (first run, or the user revoked it) so
   *   the caller leaves the chip as "no cable".
   */
  async reconnect() {
    if (this.connected) return null;
    // A gateway has no permission to remember and no picker to skip: the
    // socket either opens or it does not, so the silent path is simply the
    // ordinary connect. A gateway that is not running stays "no cable",
    // exactly as an unplugged cable does.
    const gateway =
      typeof gatewaySetting === 'function' ? gatewaySetting() : '';
    if (gateway) {
      try {
        return await this.connect();
      } catch (e) {
        console.info(`[serial] the gateway did not answer: ${e.message}`);
        this.port = null;
        return null;
      }
    }
    if (!('serial' in navigator)) return null;
    let ports;
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
    // Newer browsers expose SerialPort.connected = is the device physically
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
    await this._applyIdleSignals(KDCAN);
    this._resetWireState();
    this._watchPort();
    console.info(
      '[serial] reconnected to a previously-granted port, no picker'
    );
    return this.portLabel();
  }

  /**
   * Give the port's streams back (cancel the reader, release both locks) so
   * the port can be closed. Every failure is swallowed: the port is being
   * closed or reopened either way.
   */
  async _releaseStreams() {
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
      }
    } catch {
      /* closing or reopening */
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch {
      /* closing or reopening */
    }
  }

  /**
   * Close the port and open it again on `cfg`, taking fresh stream locks.
   * @param {PortConfig} cfg - The settings to reopen with.
   */
  async _reopenStreams(cfg) {
    // a reopen can be asked for before any port was granted: the first
    // group probe on a page load raced the silent reconnect and died on
    // "reading 'close' of null", which the app could not tell from a bug.
    // Name it as what it is, in the words the error screen recognises.
    if (!this.port) throw new Error('no cable is open');
    await this.port.close();
    await this.port.open(cfg);
    this.config = cfg;
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    // a reopened port comes back with whatever lines the platform asserts
    await this._applyIdleSignals(cfg);
  }

  /**
   * Close/reopen with a concept's wire settings. Reopening an already-
   * granted port needs no user gesture, only the first requestPort() does.
   * A change in the idle DTR level alone (BMW-FAST after a K-line probe, or
   * back) does not drop the port: only the lines move.
   * @param {PortConfig} cfg - The settings the next telegram needs.
   */
  async ensureConfig(cfg) {
    if (this._configUnchanged(cfg)) {
      const want = !!(cfg && cfg.dtr);
      if (!!(this.config && this.config.dtr) !== want) {
        this.config = { ...this.config, dtr: want };
        await this._applyIdleSignals(this.config);
      }
      return;
    }
    await this._releaseStreams();
    await this._reopenStreams(cfg);
  }

  /**
   * @returns {string} 'gateway host:port (device)' when the cable is on
   *   another machine, else 'USB vid:pid' when the port says, else
   *   'serial'. The chip shows this, so a remote car reads as remote.
   */
  portLabel() {
    if (this.port && typeof this.port.label === 'function')
      return this.port.label();
    const i = this.port && this.port.getInfo ? this.port.getInfo() : {};
    if (i.usbVendorId)
      return `USB ${i.usbVendorId.toString(16)}:${(i.usbProductId || 0).toString(16)}`;
    // A K+DCAN cable is a USB device and the browser reports its ids. A port
    // without them is a Bluetooth adapter (the browser names those by their
    // service class) or a virtual port, and neither has a K line to echo on:
    // a tester spent four days on "no echo from the cable" with a port the
    // chip merely called "serial". Say what it is.
    if (i.bluetoothServiceClassId)
      return 'Bluetooth serial, not a K+DCAN cable';
    return 'serial port without a USB id, not a K+DCAN cable';
  }

  /**
   * Why this port cannot be a K+DCAN cable, for the no-echo error, or ''
   * when it reports USB ids (then the cable is real and the car is the
   * question).
   * @returns {string}
   */
  portHint() {
    if (this.port && typeof this.port.label === 'function') return '';
    const i = this.port && this.port.getInfo ? this.port.getInfo() : {};
    if (i.usbVendorId) return '';
    return ` -- this port is a ${this.portLabel()}; a K+DCAN cable shows as USB 403:6001`;
  }

  /** Release the streams, close the port and forget the wire state. */
  async disconnect() {
    await this._releaseStreams();
    const port = this.port;
    try {
      if (port) await port.close();
    } catch {
      /* closing */
    }
    // a gateway's socket is dropped AFTER the remote cable is closed: the
    // close travels over that very socket
    if (port && typeof port.hangUp === 'function') port.hangUp();
    this.port = this.reader = this.writer = null;
    this._resetWireState();
  }

  /**
   * KL30/KL15, exactly the way INPA gets them on this same K+DCAN cable.
   *
   * The reference serial interface (plain serial, which is what an FTDI
   * K+DCAN cable is) derives BOTH battery and ignition from ONE modem line,
   * DSR: BatteryVoltage = IgnitionVoltage = DSR asserted ? nominal : 0. A
   * genuine K+DCAN cable wires KL15 through to the DSR pin, so DSR asserted
   * means the ignition is on (report the nominal voltage), DSR low means off.
   * UTILITY's STATUS_UBATT / STATUS_ZUENDUNG then just compare that against
   * 10000 mV. So the honest reading is the DSR line, not a fixed nominal --
   * and Web Serial exposes it as getSignals().dataSetReady.
   *
   * The separate ignition-status read (the 82 F1 F1 FA FA command) exists
   * ONLY for the BT/WiFi/ELM adapters; for a serial FTDI cable EDIABAS falls
   * to the DSR path and both lamps track that one line together. So do we:
   * no cable can tell battery-on-ignition-off apart on this hardware, and
   * pretending it can would be the invention, not the fidelity.
   *
   * Only when the port cannot report signals at all do we fall back to the
   * old nominal-on (a cable we cannot query is not evidence of ignition off).
   * @returns {Promise<BusState>}
   */
  async readState() {
    if (!this.connected) return { battery: null, ignition: null };
    const on = await this._ignitionAsserted();
    if (on === null) {
      // the port cannot report its signals: fall back to the nominal "on",
      // the same thing EDIABAS shows for an interface it cannot sample.
      return {
        battery: UTILITY_NOMINAL_MV / 1000,
        ignition: true,
        derived: true,
      };
    }
    return {
      battery: on ? UTILITY_NOMINAL_MV / 1000 : null,
      ignition: on,
      sensed: true,
    };
  }

  /**
   * KL15 arrives on a modem line of the K+DCAN cable. The reference interface
   * reads DSR; on real FTDI clones the ignition drives DSR AND DCD together
   * (both seen going true with the key on and false with it out on this
   * hardware), while RI sits high regardless (stuck, even unplugged) and CTS
   * stays low. So take ignition as asserted when EITHER DSR or DCD is high --
   * covering both wirings -- and ignore RI/CTS, which carry no ignition here.
   * @returns {Promise<boolean|null>} true = ignition on, false = off, null =
   *   the port reports no signals (caller falls back to "on").
   */
  async _ignitionAsserted() {
    if (!this.port || !this.port.getSignals) return null;
    try {
      const s = await this.port.getSignals();
      if (!s) return null;
      const dsr = typeof s.dataSetReady === 'boolean' ? s.dataSetReady : null;
      const dcd =
        typeof s.dataCarrierDetect === 'boolean' ? s.dataCarrierDetect : null;
      if (dsr === null && dcd === null) return null;
      return !!dsr || !!dcd;
    } catch {
      return null;
    }
  }

  // exchange() is inherited from SerialTransportBase (identical for every
  // transport -- it delegates to the shared runExchange).

  /**
   * BMW K-line fast init: a 25 ms break with DTR held, the wake a KWP2000
   * module needs before it listens.
   *
   * THE THING THAT WAS MISSING. An E46 K-line module ignores every telegram
   * until it is woken, and the wake is NOT the 2-second 5-baud ISO 9141 init
   * -- it is a 25 ms break. The reference interface does exactly this:
   *
   *     DTR on -> break 25 ms -> break off -> wait to 50 ms total -> DTR off
   *
   * Verified against a real E46 M54/MS45: with the wake the DME answers
   * 82 12 F1 1A 80 with its ident string ("754472129001060300400..."), and
   * without it every telegram at every baud and parity is met with silence.
   * That silence is what surfaced as IFH-0009 and looked like a wiring fault.
   * The wake runs at 10400 8N1, which is also where the answer comes back.
   *
   * DTR is this cable's transmit enable: the reference interface asserts it
   * for the wake and for the duration of every telegram it writes.
   *
   * THE 50 ms IS MEASURED FROM THE START OF THE BREAK, not added after it.
   * The reference takes one timestamp, holds the break until start+25 ms,
   * releases it, then waits until start+50 ms and drops DTR -- so the
   * telegram follows ~50 ms after the break BEGAN. Sleeping 25 then another
   * 25 makes that 50 ms of sleep PLUS the four awaits' own latency, and the
   * trace showed 61 ms from break to write. A module with a strict post-wake
   * window (W4 is 25-50 ms) has stopped listening by then. Deadline-based, so
   * the wall clock matches whatever the awaits cost.
   *
   * Currently no concept calls this (see exchangeRaw: DS2 is never broken,
   * ISO 9141 slow-inits); it stays for the KWP2000 modules that need it.
   * @param {CommParams} comm - The telegram's wire parameters (unused; kept
   *   for symmetry with slowInit).
   * @throws {Error} IFH-0018 when the port cannot drive its signals.
   */
  async fastInit(comm) {
    if (!this.port.setSignals) {
      throw ifhError(
        'IFH-0018',
        'this browser cannot drive the K line ' +
          '(no setSignals); use the macOS app for this ECU'
      );
    }
    const t0 = Date.now();
    const until = async (ms) => {
      const left = ms - (Date.now() - t0);
      if (left > 0) await bmwSleep(left);
    };
    await this.port.setSignals({ dataTerminalReady: true, break: true });
    await until(FAST_INIT_BREAK_MS);
    await this.port.setSignals({ break: false });
    await until(FAST_INIT_DTR_MS);
    await this.port.setSignals({ dataTerminalReady: false });
    busTrace.add('kline', null, `fastInit done in ${Date.now() - t0}ms`);
    this.inited = true;
  }

  /**
   * ISO 9141-2 slow init. The module sleeps. Waking it means holding the K
   * line low/high by hand at 5 BITS PER SECOND -- one start bit, eight
   * address bits LSB first, one stop bit, 200 ms each, 2 seconds in total. No
   * UART can frame that, so it is bit-banged with setSignals({break}) and the
   * port is reopened afterwards to discard the framing garbage the break
   * generates.
   *
   * The ECU then answers 0x55 (sync) and two key bytes. The tester echoes
   * back the SECOND key byte inverted, and the ECU replies with the address
   * inverted -- at which point the session is live and normal requests work.
   *
   * Proven against a real E46 M54/MS45:
   *   addr 0x33 @ 10400 -> 55 08 08, ack f7 cc, then
   *   mode01 pid00 -> 48 6b 12 41 00 bf 9f e8 91  (0x12 = the DME)
   *
   * Init is per-session: `this.inited` holds the concept it was done for, so
   * a job run does not re-init on every exchange (each one costs 2+ seconds)
   * but switching ECU or concept does.
   * @param {CommParams} comm - The telegram's wire parameters (its baud).
   * @returns {Promise<{keyBytes: number[], ack: number[]}>} The ECU's key
   *   bytes and whatever came back after the tester's inverted key.
   * @throws {Error} IFH-0018 without setSignals; IFH-0009 when no sync came.
   */
  async slowInit(comm) {
    const baud = (comm && comm.baud) || ISO9141_BAUD;
    const addr = ISO9141_INIT_ADDR;
    /** @type {PortConfig} */
    const cfg = { baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none' };

    // Break signalling needs the port open; parity/data bits are irrelevant
    // while the line is driven by hand.
    await this.ensureConfig(cfg);
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
      await bmwSleep(SLOW_INIT_BIT_MS);
    }
    await this.port.setSignals({ break: false });

    // Reopen so the break's framing errors are not read as data.
    await this.reopen(cfg);

    // 0x55 then two key bytes, within ~300 ms of the stop bit
    const hdr = await this._readUpTo(3, Date.now() + SLOW_INIT_SYNC_MS);
    const sync = hdr.indexOf(ISO9141_SYNC);
    if (sync < 0 || hdr.length < sync + 3) {
      throw ifhError(
        'IFH-0009',
        'the ECU did not answer the slow init ' +
          '(no 0x55 sync). Ignition on, engine off?'
      );
    }
    const kb2 = hdr[sync + 2];

    // Tester sends ~KB2; the ECU replies ~addr. W4 is 25-50 ms.
    await bmwSleep(SLOW_INIT_W4_MS);
    await this.writer.write(new Uint8Array([~kb2 & 0xff]));
    const ack = await this._readUpTo(2, Date.now() + SLOW_INIT_ACK_MS);
    // The ack carries our own echo plus ~addr; a missing one is not fatal --
    // the E46 answered f7 cc where only cc is the ECU's. Requests that follow
    // are the real proof, so do not fail the session on a fussy ack.
    this.inited = true;
    return { keyBytes: [hdr[sync + 1], kb2], ack };
  }

  /**
   * Collect up to `n` bytes before `deadline`, stopping early if the port
   * closes. Used by the slow init's sync and ack reads.
   * @param {number} n - How many bytes to wait for.
   * @param {number} deadline - Absolute Date.now() cut-off.
   * @returns {Promise<number[]>} Whatever arrived (possibly fewer than n).
   */
  async _readUpTo(n, deadline) {
    const got = [];
    while (got.length < n && Date.now() < deadline) {
      const { value, done } = await this.readSome(deadline);
      if (done) break;
      if (value && value.length) got.push(...value);
    }
    return got;
  }

  /**
   * Close and reopen the port, dropping anything buffered. Used after the
   * slow init, whose break signalling leaves framing errors in the stream.
   * @param {PortConfig} cfg - The settings to reopen with.
   */
  async reopen(cfg) {
    await this._releaseStreams();
    this.pending = null;
    await this._reopenStreams(cfg);
  }

  /**
   * How long DTR stays up for a K-line write: exactly the telegram's byte
   * time plus DtrTimeCorrCom, never less than 1 ms.
   * @param {number[]} framed - The bytes about to be written.
   * @returns {number} Whole milliseconds.
   */
  _dtrHoldMs(framed) {
    const bits = this.config && this.config.parity === 'none' ? 10 : 11;
    const ms =
      (framed.length * bits * 1000) /
      ((this.config && this.config.baudRate) || KLINE_DEFAULT_BAUD);
    return Math.max(1, Math.round(ms + DTR_TIME_CORR_MS));
  }

  /**
   * Write one framed request (waking the module first when its concept needs
   * it, with DTR as transmit enable on the K line) and read its answer.
   *
   * WHICH concepts need waking at all: ISO 9141 sleeps until its 5-baud
   * address arrives; DS2 does not, and BMW-FAST over a D-CAN cable does not.
   * `inited` gates the one that does, and survives until the port is
   * reopened (which is what clears it): an SGBD's session init can run on
   * one concept while its jobs declare another, so keying this to the
   * per-telegram concept would wake for the init and not for the job that
   * follows.
   *
   * DS2 IS NOT WOKEN. The reference interface's fast-init wake has exactly
   * ONE call site -- inside its KWP2000 transmit -- and its DS2 transmit
   * contains no wake, no break, no 5-baud address at all; the concept-5/6
   * setup marks the ECU connected outright so nothing can trigger one.
   * We were sending a 25 ms break before the first telegram to every K-line
   * address, DS2 included. That is 240 bit-times of dominant K line at 9600
   * -- to a module that never expected a fast init it is either framing
   * garbage to resync through, or, on a module that also speaks KWP2000, a
   * genuine wake pattern that arms a different session in which a raw DS2
   * telegram is not valid and gets dropped without reply. The E46 cluster
   * (0x80) forgives it; the EGS (0x32) answered EDIABAS and never us.
   * ISO 9141 genuinely does need its 5-baud address, so that stays.
   *
   * DTR IS THE TRANSMIT ENABLE on a K+DCAN cable, and it is what was
   * missing. The reference interface raises it for the duration of every
   * telegram it writes, and DS2 sets its "send with DTR" flag. Without it the
   * bytes are framed correctly, leave the UART, and never reach the K line --
   * which is exactly the silence that looked like a dead ECU.
   * @param {number[]|null} framed - The request with its checksum, or null
   *   to read a continuation frame without writing.
   * @param {number} timeoutMs - ParTimeoutStd for this read.
   * @param {CommParams} comm - The request's wire parameters.
   * @returns {Promise<number[]>} The answer frame.
   */
  async exchangeRaw(framed, timeoutMs, comm) {
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
      // run dry. readSome reports {done:false, value:null} when it merely ran
      // out of time (done means the PORT closed), so the drain stops on
      // either, bounded so a chattering bus cannot spin forever.
      // (K-line writes drain INSIDE the DTR window instead -- see below.)
      if (!kline) await this.drainBuffered();
      if (kline && this.port.setSignals) {
        // DTR up, THEN drain, THEN write -- the order the reference uses
        // (its input discard sits inside the DTR block, right before the
        // write). Draining earlier let bytes arrive in the gap and be read
        // as this request's echo.
        await this.port.setSignals({ dataTerminalReady: true });
        await this.drainBuffered();
      }
      await this.writer.write(new Uint8Array(framed));
      if (kline && this.port.setSignals) {
        const holdMs = this._dtrHoldMs(framed);
        busTrace.add(
          'kline',
          null,
          `DTR held ${holdMs}ms for ${framed.length}B` +
            ` @${this.config && this.config.baudRate}/${this.config && this.config.parity}`
        );
        await bmwSleep(holdMs);
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

  /**
   * Drain what is already buffered WITHOUT arming a new read.
   *
   * THE BUG THIS FIXES: the old drain called readSome() with a 2 ms deadline.
   * readSome keeps a timed-out read alive on this.pending (that is what stops
   * bytes being lost), so the drain's last call left a live read armed. The
   * write then went out and THAT read swallowed the first bytes of the echo --
   * every answer arrived missing its head ("12 04 00 16" came back as
   * "00 16"), which readFrame then failed to match.
   *
   * NEVER CREATE A READ HERE. An earlier version probed with
   * this.reader.read() when nothing was outstanding; if the line was quiet
   * that probe stayed armed, the telegram went out, and the probe swallowed
   * the first bytes of the echo. The tell was unmistakable in a wire trace:
   * the FIRST attempt of every exchange came back missing its head
   * ("82 12 f1 1a 80 1f" as "12 f1 1a 80 1f") while the retry -- which found
   * a pending read already in place and so created none -- was perfect.
   *
   * Only an ALREADY-OUTSTANDING read is consumed, and only while it keeps
   * resolving immediately. A quiet line leaves this a no-op.
   */
  async drainBuffered() {
    for (let i = 0; i < DRAIN_MAX_READS && this.pending; i++) {
      const settled = await Promise.race([
        this.pending.then((r) => ({ hit: true, r })),
        bmwSleep(DRAIN_PROBE_MS).then(() => ({ hit: false })),
      ]);
      if (!settled.hit) return; // still outstanding: leave it be
      this.pending = null; // consumed here, as stale
      const { value, done } = settled.r || {};
      if (done || !value || !value.length) return;
    }
  }

  /**
   * Read with a deadline, WITHOUT losing bytes to an abandoned read.
   *
   * THE BUG THIS FIXES: racing reader.read() against a timeout and walking
   * away leaves that read outstanding. Web Serial still delivers the next
   * chunk to it, and because nothing held the promise those bytes were gone
   * for good. The pre-write drain loop used to run with a 2 ms deadline and
   * so ALWAYS ended by timing out -- meaning every exchange armed an orphaned
   * read immediately before writing, which then swallowed the K-line echo.
   * readFrame waited the full timeout for bytes already eaten and threw
   * IFH-0003 "no echo from the cable" on a cable that echoes perfectly.
   *
   * Keeping the single outstanding read on `this.pending` and awaiting that
   * same promise next time means a timed-out read is resumed, not discarded.
   * @param {number} deadline - Absolute Date.now() cut-off for this call.
   * @returns {Promise<{value: Uint8Array|null|undefined, done: boolean}>}
   *   The read result; {value:null, done:false} when it merely timed out
   *   (done:true is reserved for the port closing).
   */
  async readSome(deadline) {
    const ms = Math.max(1, deadline - Date.now());
    // THE CONSUMER CLEARS THE HANDLE, NEVER THE READ ITSELF. An earlier
    // version had the read null this.pending as it resolved. A read left
    // outstanding by the previous exchange's timeout then resolved while
    // nobody was awaiting it -- during the 5 to 11 ms the transmit line is
    // held after a K-line write -- and its value, the first chunk of the
    // echo, was dropped: the next readSome found no handle and armed a
    // fresh read that only saw the rest. On Windows, where the cable hands
    // over one byte per chunk, every DS2 echo came back missing its first
    // byte ("F0 04 00 F4" as "04 00 F4"); on macOS one to four bytes went,
    // sometimes. A resolved read now stays on this.pending until a caller
    // takes its value.
    if (!this.pending) this.pending = this.reader.read();
    // a worker-timed race: a late wake resolves an orphaned promise, nothing
    // else, so there is no timer to clear
    const timeout = bmwSleep(ms).then(() => TIMED_OUT);
    let r;
    try {
      r = await Promise.race([this.pending, timeout]);
    } catch (e) {
      this.pending = null;
      throw e;
    }
    // Timed out: the read stays on this.pending for the next call. Report
    // "nothing yet" rather than done -- done means the port closed.
    if (r === TIMED_OUT) return { value: null, done: false };
    this.pending = null;
    return r;
  }
}
