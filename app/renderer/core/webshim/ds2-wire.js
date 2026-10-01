/**
 * @file DS2 straight down the cable, without an SGBD.
 *
 * Every other telegram this app sends is built by an SGBD's bytecode running
 * in the VM. A few operations have no job at all -- the transmission's SGBD
 * exposes twenty-one jobs and none of them programs memory -- so those
 * telegrams have to be built by hand. This is the one place that does it.
 *
 * It is NOT a second transport. The bytes still go through the bus's own
 * exchange (runExchange): the concept-6 framing, the XOR checksum, the echo
 * drop, the length-driven read, DTR as transmit enable and the inter-telegram
 * pacing are all the same code the SGBD path uses, fed a hand-built
 * CommParams instead of an xsetpar's. The one thing added here is the baud
 * change a module can be asked for, which the SGBD path drives through
 * SET_PARAMETER and which a raw session has to do itself.
 *
 * A whole raw session runs under ONE bus lock (ds2WireSession), so the topbar
 * state poll and every job stay off the wire until the module is back in its
 * normal mode: a transmission left half way through an unlock answers nobody.
 */
/* exported Ds2Wire, ds2WireSession, DS2_ADDRESS, DS2_STATUS, ds2Frame, ds2Status, ds2SubStatus, ds2DescribeSubStatus */

/** The DS2 addresses the raw path talks to. */
const DS2_ADDRESS = { tcu: 0x32, dme: 0x12 };

/** The status byte at offset 2 of a DS2 answer. */
const DS2_STATUS = { ok: 0xa0, busy: 0xa1, refused: 0xa2, error: 0xb0 };

/** DS2 on the K line starts here, 8E1. */
const DS2_WIRE_DEFAULT_BAUD = 9600;

/**
 * A pause between telegrams. Reads survive a shorter one; writes do not: at
 * two milliseconds the baud change is not acted on and the module answers
 * the next request with its identification string instead of a real reply,
 * which reads as a module that will not unlock. One value everywhere.
 */
const DS2_WIRE_GAP_MS = 30;

/**
 * Wrap a payload in the address / length frame. The checksum is NOT
 * appended: the bus adds the concept's own (withChecksum), the same way it
 * signs an SGBD's telegram. The length counts the whole telegram including
 * that checksum, which is what caps a payload at 252 bytes.
 * @param {number} address - The module's DS2 address.
 * @param {ArrayLike<number>} payload - The command bytes.
 * @returns {number[]} `[address, total, ...payload]`, unsigned.
 * @throws {Error} When the telegram cannot carry its length in one byte.
 */
function ds2Frame(address, payload) {
  const total = payload.length + 3;
  if (total > 0xff) {
    throw new Error(
      `a DS2 telegram carries its length in one byte; this payload needs ${total}`
    );
  }
  return [address & 0xff, total, ...Array.from(payload, (b) => b & 0xff)];
}

/**
 * The status byte an answer carries, or null when it is too short.
 * @param {ArrayLike<number>} frame - A complete answer frame.
 * @returns {number|null}
 */
function ds2Status(frame) {
  return frame && frame.length > 2 ? frame[2] : null;
}

/**
 * The sub-status a flash write or commit reports at offset 8. One means the
 * operation finished; the rest are distinct flash faults.
 * @param {ArrayLike<number>} frame - A complete answer frame.
 * @returns {number|null}
 */
function ds2SubStatus(frame) {
  return frame && frame.length > 8 ? frame[8] : null;
}

/**
 * What a flash sub-status means, for the log or a dialog.
 * @param {number|null} sub - The sub-status byte.
 * @returns {string}
 */
function ds2DescribeSubStatus(sub) {
  switch (sub) {
    case 1:
      return 'complete';
    case 2:
      return 'flash fault 2 (write rejected)';
    case 3:
      return 'flash fault 3 (not programmed: flash not blank)';
    case 8:
      return 'flash fault 8 (erase refused)';
    case 14:
      return 'flash fault 14 (program written but not accepted by the boot block)';
    case null:
    case undefined:
      return 'no sub-status';
    default:
      return sub >= 9 && sub <= 15
        ? `flash fault ${sub}`
        : `unknown sub-status 0x${sub.toString(16).padStart(2, '0')}`;
  }
}

/**
 * A raw DS2 link over the bus's exchange.
 *
 * `transfer` sends one telegram and returns the module's whole answer frame
 * (address, length, status, data..., checksum), exactly the bytes that came
 * off the wire -- a refusal comes back in the status byte, a transport
 * failure throws with its IFH code.
 */
class Ds2Wire {
  /**
   * @param {(out: ArrayLike<number>, comm: CommParams) => Promise<number[]>} exchange -
   *   The bus exchange to send through. Inside a held bus lock this must be
   *   the RAW one (webBusRawExchange); the locked one would queue behind the
   *   session that holds it.
   * @param {{trace?: (text: string) => void}} [opts]
   */
  constructor(exchange, opts = {}) {
    this._exchange = exchange;
    this._trace = opts.trace || (() => {});
    /** The rate the link is running at. @type {number} */
    this.baud = DS2_WIRE_DEFAULT_BAUD;
  }

  /**
   * The wire parameters a raw DS2 telegram rides on: concept 6 (DS2, XOR
   * checksum, 8E1), the link's current rate, and the answer-length rule the
   * reference interface seeds for the concept (byte 1 is the total). The
   * inter-telegram gap goes in as ParRegenTime, which the bus measures from
   * the module's last answer -- the same quiet the SGBD path owes it.
   * @param {number} timeoutMs - How long the module may take to START answering.
   * @returns {CommParams}
   */
  comm(timeoutMs) {
    return {
      concept: 6,
      baud: this.baud,
      timeout: timeoutMs,
      regen: DS2_WIRE_GAP_MS,
      // the module answers a flash command once it has done the work; it
      // never says "busy, ask again" the KWP way
      timeoutNr78: null,
      // one transmission, like the reference link: the caller's own retry
      // loop decides what to resend, because resending a write is a
      // decision, not a reflex
      repeats: 0,
      answerLen: [-1, 0],
    };
  }

  /**
   * Send one telegram and wait for the module's reply.
   * @param {number} address - The module's DS2 address.
   * @param {ArrayLike<number>} payload - The command bytes.
   * @param {number} timeoutMs - How long the module may take to start answering.
   * @returns {Promise<number[]>} The complete answer frame, checksum included.
   * @throws {Error} The bus's IFH error on silence, a bad echo or a garbled
   *   answer; or an impossible announced length.
   */
  async transfer(address, payload, timeoutMs) {
    const out = ds2Frame(address, payload);
    const reply = await this._exchange(out, this.comm(timeoutMs));
    // the bus already matched the frame to its length byte and checked the
    // checksum; what is left to refuse is an answer too short to carry a status
    if (!reply || reply.length < 3) {
      throw new Error(
        `the reply announced an impossible length of ${reply ? reply.length : 0} bytes`
      );
    }
    this._trace(
      `${busTrace.hex(out)}  ->  ${busTrace.hex(reply.slice(0, 12))}`
    );
    return reply;
  }

  /**
   * Ask the module to move to another rate, then follow it.
   *
   * The request is acknowledged at the current rate and only then does
   * either side change, so the order matters: send, read the reply, and
   * switch afterwards. The command is 0x91 followed by the rate as a 24-bit
   * big-endian number (9600 reads as 00 25 80, 125000 as 01 E8 48) and a
   * per-module flag; the transmission wants 1.
   *
   * The request may be acted on even when its acknowledgement never reaches
   * us, which would leave the module at the new rate while we stayed at the
   * old one and every later telegram came back as nonsense. So a lost
   * acknowledgement is not "nothing happened": both rates are tried and the
   * one the module actually answers on is kept.
   * @param {number} address - The module's DS2 address.
   * @param {number} baud - The rate to move to.
   * @param {number} [moduleFlag=1] - The trailing per-module byte.
   * @returns {Promise<void>}
   * @throws {Error} When the module refused the change, or answers on neither rate.
   */
  async switchBaud(address, baud, moduleFlag = 1) {
    if (baud === this.baud) return;
    const previous = this.baud;
    let acknowledged;
    try {
      const reply = await this.transfer(
        address,
        [
          0x91,
          (baud >> 16) & 0xff,
          (baud >> 8) & 0xff,
          baud & 0xff,
          moduleFlag,
        ],
        2000
      );
      acknowledged = ds2Status(reply) === DS2_STATUS.ok;
    } catch (e) {
      acknowledged = false;
    }
    await bmwSleep(DS2_WIRE_GAP_MS);

    if (await this._settle(address, baud)) {
      this._trace(`baud now ${baud}`);
      return;
    }
    if (await this._settle(address, previous)) {
      this._trace(`baud stayed at ${previous}`);
      throw new Error(`the module did not change to ${baud} baud`);
    }
    throw new Error(
      'the module stopped answering after a baud change' +
        (acknowledged ? ' it had acknowledged' : '') +
        '; cycle the ignition and reconnect'
    );
  }

  /**
   * Move the link to a rate and check the module answers there. A plain
   * ident (0x00) is harmless and answers on any healthy link.
   * @param {number} address - The module's DS2 address.
   * @param {number} baud - The rate to try.
   * @returns {Promise<boolean>} True when the module answered OK at `baud`.
   */
  async _settle(address, baud) {
    this.baud = baud;
    await bmwSleep(DS2_WIRE_GAP_MS);
    try {
      const reply = await this.transfer(address, [0x00], 1500);
      return ds2Status(reply) === DS2_STATUS.ok;
    } catch (e) {
      return false;
    }
  }
}

/**
 * Run a raw DS2 session on the cable, holding the bus lock for its whole
 * duration. The session gets a Ds2Wire over the RAW exchange (the lock is
 * already held, so the locked one would wait on itself).
 * @template T
 * @param {(wire: Ds2Wire) => Promise<T>} fn - The session.
 * @param {{trace?: (text: string) => void}} [opts]
 * @returns {Promise<T>} Whatever the session resolves to.
 * @throws {Error} 'no cable connected' before anything is sent.
 */
function ds2WireSession(fn, opts = {}) {
  if (!webBus.connected) throw new Error('no cable connected');
  return withBusLock(() =>
    fn(new Ds2Wire((out, comm) => webBusRawExchange(out, comm), opts))
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Ds2Wire,
    DS2_ADDRESS,
    DS2_STATUS,
    ds2Frame,
    ds2Status,
    ds2SubStatus,
    ds2DescribeSubStatus,
  };
}
