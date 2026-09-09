/**
 * @file The Transport contract every bus implements, and the base class the
 * two serial transports share.
 *
 * TWO transports carry the exact same protocol to the car: Web Serial (a
 * K+DCAN cable in a desktop browser) and the native bridge (the macOS shell
 * owning /dev/tty). runExchange, readFrame, withChecksum, frameTotal and
 * verifyChecksum (exchange.js, framing.js) are the protocol and are SHARED by
 * both -- "the protocol does not change with the plumbing." A full merge of
 * the two classes is NOT possible, because two boundaries are physical, not
 * incidental, and each stays a per-transport override:
 *
 *   SEAM 1  connect-entry -- Web Serial needs a USER GESTURE for the first
 *           requestPort(); the native bridge does not.
 *   SEAM 2  K-line line-control -- only Web Serial has setSignals (DTR/break),
 *           so fast-init and the ISO 9141 slow-init live there alone; the
 *           native bridge has no setSignals.
 *
 * The native correspondence lives in C# (a different runtime, not unified
 * here): SerialProxy.cs is the byte-mover behind NativeSerialBus (open/write/
 * readAvailable/close/flush). Bytes cross that bridge as a JSON int[]
 * (BmacwBridge.cs AsNumberArray), NOT base64 -- base64 corrupted the
 * echo/checksum. The former C# engine (deleted with its InpaMac.Api server) was
 * reference for what JS reimplemented, not a transport, and was never part
 * of this interface.
 */
/* exported SerialTransportBase */

/**
 * KL30/KL15 as the cable reports them.
 * @typedef {object} BusState
 * @property {number|null} battery - Volts, or null when off/unknown.
 * @property {boolean|null} ignition - KL15, or null when unknown.
 * @property {boolean} [derived] - True when the port cannot report its
 *   signals and the nominal "on" was assumed.
 * @property {boolean} [sensed] - True when the value came off a modem line.
 */

/**
 * Every transport MUST expose this surface (the rest of the renderer --
 * app.js, coding-write.js, the fetch shim -- calls only these). runExchange
 * also reads/writes sessionConcept, lastResponseAt, inited and initedAddr as
 * shared session state.
 * @typedef {object} Transport
 * @property {boolean} connected - Is the wire up right now.
 * @property {() => Promise<string>} connect - Open the wire (SEAM 1); returns
 *   the port label.
 * @property {() => Promise<string|null>} [reconnect] - Silent reopen on load,
 *   no gesture (Web Serial only); null when nothing was previously granted.
 * @property {(cfg: PortConfig) => Promise<void>} ensureConfig - Make
 *   baud+parity match a concept.
 * @property {(out: ArrayLike<number>, comm: CommParams) => Promise<number[]>} exchange -
 *   One request/answer -- SHARED, it just calls runExchange(this, ...).
 * @property {(framed: number[]|null, timeoutMs: number, comm: CommParams) => Promise<number[]>} exchangeRaw -
 *   Write+read one frame (SEAM 2); framed null re-reads a continuation.
 * @property {() => Promise<void>} disconnect - Tear the wire down.
 * @property {() => Promise<BusState>} [readState] - KL30/KL15 (absent on
 *   the native bridge -- callers guard).
 * @property {() => string} portLabel - A human name for the chip.
 * @property {number|null} sessionConcept - The concept of the last telegram.
 * @property {number|null|undefined} lastResponseAt - Date.now() of the last
 *   answer, for ParRegenTime pacing.
 * @property {boolean|null} inited - Whether the K-line wake has run on this
 *   port session.
 * @property {number|null} initedAddr - The address the ISO 9141 wake was
 *   done for.
 */

/**
 * Shared base for the two SERIAL transports (Web Serial + native bridge). They
 * both own a real port whose baud/parity must track the job's concept, and
 * they both keep the same per-session wire state -- so the reconfigure-guard
 * and the state reset live here once.
 */
class SerialTransportBase {
  /**
   * Clear the full wire state, when the session on the wire ENDS (connect,
   * reconnect, disconnect): a fresh cable has woken nothing and remembers no
   * concept.
   */
  _resetWireState() {
    this.inited = null;
    this.initedAddr = null;
    this.pending = null;
    this.sessionConcept = null;
  }

  /**
   * Clear the WAKE state only, when the port is REOPENED onto different
   * settings: a reopened port drops the ECU session, so a woken module must
   * be woken again. Deliberately does NOT touch sessionConcept -- runExchange
   * sets that immediately before calling ensureConfig, and the K-line wake in
   * exchangeRaw reads it right after, so clearing it here would blind the
   * wake.
   */
  _resetWakeState() {
    this.inited = null;
    this.initedAddr = null;
  }

  /**
   * True when a requested config already matches the open port, so
   * ensureConfig can skip the (session-dropping) reopen. Baud and parity are
   * the only settings a concept changes; data/stop bits are constant here.
   * @param {PortConfig} cfg - The settings the next telegram needs.
   * @returns {boolean}
   */
  _configUnchanged(cfg) {
    return (
      !!this.config &&
      this.config.baudRate === cfg.baudRate &&
      this.config.parity === cfg.parity
    );
  }

  /**
   * One request/answer exchange. IDENTICAL for every transport -- the retry,
   * pacing, response-pending and framing all live in runExchange, which
   * drives the transport through its exchangeRaw/ensureConfig overrides. Kept
   * in the base so there is exactly one copy.
   * @param {ArrayLike<number>} out - The request without its checksum.
   * @param {CommParams} comm - Its wire parameters.
   * @returns {Promise<number[]>} The answer frame.
   */
  async exchange(out, comm) {
    return runExchange(this, out, comm);
  }
}
