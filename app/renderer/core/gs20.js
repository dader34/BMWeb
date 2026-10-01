// The GS20 (A5S390R) transmission's calibration: checksum, read and WRITE
// over raw DS2, in the browser.
//
// The transmission's SGBD cannot do any of this: gs20.prg exposes twenty-one
// jobs and none of them programs memory, and the dump SPEICHER_LESEN assembles
// comes back with its 16 KB blocks in the wrong places. So the telegrams are
// built by hand and go down the cable through Ds2Wire (core/webshim/
// ds2-wire.js), the bus's own exchange fed a hand-built CommParams. The
// sequence -- session, unlock, status, erase, wait, write, commit -- and its
// region, chunk and timing were taken from the macOS flasher, which verified
// a full calibration write against a real transmission: the read-back
// matched the written calibration byte for byte.
//
// Safety, in order of importance:
//   * The calibration's checksum is corrected before anything is sent, so a
//     tune file carrying a stale one cannot reach the car.
//   * The boot block and program live outside this region and are never
//     addressed, so a failed or interrupted write leaves the module still
//     answering and still flashable.
//   * A status request proves the module is open for flash commands before
//     the erase; a module that is not open refuses it there, with nothing
//     erased, instead of part way through a write.
//   * The whole session holds the bus lock, and the UI confirms before this
//     is ever called (see screens/flashing/tcu.js).
//
// The public surface:
//   gs20Checksum                       compute / stored / verify / correct / version
//   gs20ReadCalibration({fast, onStage, onProgress, abort}) -> Uint8Array (64 KB)
//   gs20WriteCalibration(bytes, {fast, onStage, onProgress, abort})
//                                      -> { checksumCorrected, volts }
//   Gs20CalReader / Gs20CalWriter      the engine over a Ds2Wire, for tests

/** Where the calibration lives in the module's address space. */
const GS20_CAL_ADDRESS = 0x090000;
/** A GS20 calibration is exactly this long. */
const GS20_CAL_LENGTH = 0x10000;
/** The quickest rate the transmission offers, thirteen times 9600. */
const GS20_FAST_BAUD = 125000;
/** DS2 on the K line, where the rest of the app expects the module. */
const GS20_DEFAULT_BAUD = 9600;

// ---- checksum ----------------------------------------------------------------
// The transmission verifies this at power-up. A calibration whose stored
// value does not match its data is rejected: the box falls back to a limp
// program (fixed gear, no adaptation) and stores a calibration fault. Nothing
// here ever reaches the car without verify() agreeing first.
//
// Algorithm (recovered from the car, 2026-09-19): CRC-16 in its reflected
// (LSB-first) form over polynomial 0xA001, initial value zero, across
// [0x2A, 0xFFC8), stored byte-swapped at 0x0D:0x0E. Validated against eight
// calibrations spanning both shipped software levels (7552700 "90" and
// 7544721 "89").
const GS20_CRC_RANGE_START = 0x2a;
const GS20_CRC_RANGE_END = 0xffc8; // exclusive
const GS20_CRC_STORED_AT = 0x0d; // high byte first
const GS20_CRC_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let bit = 0; bit < 8; bit++) v = v & 1 ? (v >>> 1) ^ 0xa001 : v >>> 1;
    table[i] = v;
  }
  return table;
})();

/**
 * The GS20 calibration checksum.
 */
const gs20Checksum = {
  /**
   * The value that belongs at 0x0D:0x0E for this calibration, in the order
   * it is stored (high byte first).
   * @param {Uint8Array} cal - The calibration image.
   * @returns {number} The 16-bit stored form.
   * @throws {Error} When the image is shorter than the checksummed range.
   */
  compute(cal) {
    if (!cal || cal.length < GS20_CRC_RANGE_END) {
      throw new Error(
        `a GS20 calibration is 0x${GS20_CAL_LENGTH.toString(16)} bytes; ` +
          `this one is 0x${(cal ? cal.length : 0).toString(16)}`
      );
    }
    let crc = 0;
    for (let i = GS20_CRC_RANGE_START; i < GS20_CRC_RANGE_END; i++) {
      crc = (crc >>> 8) ^ GS20_CRC_TABLE[(crc ^ cal[i]) & 0xff];
    }
    // stored byte-swapped relative to the running value
    return ((crc & 0xff) << 8) | (crc >>> 8);
  },
  /**
   * The checksum currently stored in the image.
   * @param {Uint8Array} cal - The calibration image.
   * @returns {number}
   */
  stored(cal) {
    if (!cal || cal.length <= GS20_CRC_STORED_AT + 1) {
      throw new Error('calibration is too short to hold a checksum');
    }
    return (cal[GS20_CRC_STORED_AT] << 8) | cal[GS20_CRC_STORED_AT + 1];
  },
  /**
   * True when the stored checksum matches the data.
   * @param {Uint8Array} cal - The calibration image.
   * @returns {boolean}
   */
  verify(cal) {
    return gs20Checksum.stored(cal) === gs20Checksum.compute(cal);
  },
  /**
   * A copy with the checksum corrected. The input is left alone so a caller
   * can still show what changed.
   * @param {Uint8Array} cal - The calibration image.
   * @returns {Uint8Array}
   */
  correct(cal) {
    const out = Uint8Array.from(cal);
    const v = gs20Checksum.compute(out);
    out[GS20_CRC_STORED_AT] = (v >> 8) & 0xff;
    out[GS20_CRC_STORED_AT + 1] = v & 0xff;
    return out;
  },
  /**
   * The calibration's own version string, which it repeats in the block past
   * the checksummed range, e.g. "G2210_0090C0ER10"; null when the image
   * carries nothing recognisable.
   * @param {Uint8Array} cal - The calibration image.
   * @returns {string|null}
   */
  version(cal) {
    if (!cal || cal.length < GS20_CAL_LENGTH) return null;
    let text = '';
    for (let i = GS20_CRC_RANGE_END; i < GS20_CAL_LENGTH; i++) {
      const b = cal[i];
      if (b >= 0x20 && b < 0x7f) text += String.fromCharCode(b);
      else if (text.length) break;
    }
    text = text.trim();
    return text.length >= 8 ? text.slice(0, 16) : null;
  },
  /**
   * The release digits a calibration names for itself: the four digits after
   * the underscore of "G2210_0090C0ER10", the same number the transmission
   * reports as its software reference. Null when nothing can be read.
   * @param {Uint8Array} cal - The calibration image.
   * @returns {string|null}
   */
  release(cal) {
    const version = gs20Checksum.version(cal);
    if (!version) return null;
    const m = /_(\d{4})/.exec(version);
    if (!m) return null;
    return m[1].replace(/^0+(?=\d)/, '');
  },
};

// ---- the engine over a wire --------------------------------------------------
const GS20_NORMAL_TIMEOUT_MS = 1000;
const GS20_READ_TIMEOUT_MS = 3000;
const GS20_ERASE_TIMEOUT_MS = 60000;
const GS20_RETRIES = 3;
const GS20_RETRY_DELAY_MS = 100;
const GS20_BUSY_POLL_MS = 100;
const GS20_MAX_BUSY_POLLS = 600; // 60 s at 100 ms
/** A plain reply (already open / now open) is five bytes; a challenge 46. */
const GS20_SHORT_REPLY = 5;
const GS20_CHALLENGE_REPLY = 46;
/** Supply voltage: command 0B 03 answers a 48-byte block; the volts sit here. */
const GS20_VOLTAGE_OFFSET = 10;
const GS20_VOLTAGE_SCALE = 0.10196078;

/**
 * The 07 <sub> <addr24> 00 command the flash commands share.
 * @param {number} sub - 0x06 erase, 0x0F status.
 * @param {number} address - The 24-bit address.
 * @returns {number[]}
 */
function _gs20AddressCommand(sub, address) {
  return [
    0x07,
    sub,
    (address >> 16) & 0xff,
    (address >> 8) & 0xff,
    address & 0xff,
    0x00,
  ];
}

/**
 * `0x090000` style, for messages.
 * @param {number} n - An address.
 * @returns {string}
 */
function _gs20Hex(n) {
  return '0x' + n.toString(16).toUpperCase().padStart(6, '0');
}

/**
 * Throw when the caller has cancelled.
 * @param {AbortSignal|undefined} abort - The cancel signal.
 * @throws {Error} 'cancelled'.
 */
function _gs20Check(abort) {
  if (abort && abort.aborted) throw new Error('cancelled');
}

/**
 * One exchange with the transmission, with the reference tool's retry:
 * three attempts a hundred milliseconds apart, over a transport failure
 * and over a refused status alike. A module-level refusal is reported by
 * its status byte, a transport failure by the bus's own error.
 * @param {Ds2Wire} wire - The link.
 * @param {number} address - The module's DS2 address.
 * @param {number[]} payload - The command bytes.
 * @param {number} timeoutMs - How long the module may take to answer.
 * @param {string} what - The step, for the error.
 * @param {{abort?: AbortSignal, allowBusy?: boolean, allowRefused?: boolean}} [opts]
 * @returns {Promise<number[]>} The answer frame.
 * @throws {Error} After the last attempt, naming the step and the last cause.
 */
async function _gs20Exchange(
  wire,
  address,
  payload,
  timeoutMs,
  what,
  opts = {}
) {
  let last = null;
  for (let attempt = 0; attempt < GS20_RETRIES; attempt++) {
    _gs20Check(opts.abort);
    try {
      const reply = await wire.transfer(address, payload, timeoutMs);
      const status = ds2Status(reply);
      if (status === DS2_STATUS.ok) return reply;
      if (opts.allowBusy && status === DS2_STATUS.busy) return reply;
      if (opts.allowRefused && status === DS2_STATUS.refused) return reply;
      throw new Error(
        `the transmission refused the ${what} request (status ` +
          `${status == null ? 'missing' : '0x' + status.toString(16).toUpperCase()}): ` +
          busTrace.hex(reply.slice(0, 12))
      );
    } catch (e) {
      if (e && e.message === 'cancelled') throw e;
      last = e;
      if (attempt + 1 < GS20_RETRIES) await bmwSleep(GS20_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `the ${what} request failed after ${GS20_RETRIES} attempts: ${last && last.message}`
  );
}

/**
 * Reads a GS20 calibration over raw DS2.
 *
 * The module reads within 16 KB pages and wraps to the start of the region
 * when a request crosses one, so the bytes past the boundary come back as
 * the calibration header instead of the data that lives there (measured on
 * the car at 0x094000). Every request is trimmed to end at a page boundary,
 * and every chunk is placed at the offset it was asked for rather than
 * appended, so a short or repeated reply cannot quietly shift the image.
 */
class Gs20CalReader {
  /** Bytes per read telegram: keeps the reply inside DS2's one length byte. */
  static get CHUNK() {
    return 123;
  }
  /** The module's read page. */
  static get PAGE() {
    return 0x4000;
  }
  /**
   * @param {Ds2Wire} wire - The link.
   * @param {{note?: (text: string) => void, address?: number}} [opts]
   */
  constructor(wire, opts = {}) {
    this._wire = wire;
    this._note = opts.note || (() => {});
    this._address = opts.address == null ? DS2_ADDRESS.tcu : opts.address;
  }

  /**
   * Read the whole calibration.
   * @param {{onProgress?: (pct: number) => void, abort?: AbortSignal}} [opts]
   * @returns {Promise<Uint8Array>} The 64 KB image.
   * @throws {Error} On cancel, a refused read, or a short reply.
   */
  async read(opts = {}) {
    const image = new Uint8Array(GS20_CAL_LENGTH);
    let offset = 0;
    while (offset < image.length) {
      _gs20Check(opts.abort);
      let length = Math.min(Gs20CalReader.CHUNK, image.length - offset);
      length = Math.min(
        length,
        Gs20CalReader.PAGE - (offset % Gs20CalReader.PAGE)
      );
      const chunk = await this.readBytes(
        GS20_CAL_ADDRESS + offset,
        length,
        opts.abort
      );
      if (chunk.length !== length) {
        throw new Error(
          `the transmission returned ${chunk.length} bytes at ` +
            `${_gs20Hex(GS20_CAL_ADDRESS + offset)} where ${length} were asked for`
        );
      }
      image.set(chunk, offset);
      offset += length;
      opts.onProgress &&
        opts.onProgress(Math.round((offset * 100) / image.length));
    }
    this._note(
      `read ${image.length} bytes, checksum 0x${gs20Checksum.stored(image).toString(16).toUpperCase().padStart(4, '0')}` +
        (gs20Checksum.verify(image) ? ' (valid)' : ' (does NOT match the data)')
    );
    return image;
  }

  /**
   * One chunk, as the diagnostic SGBD reads it: 06, a 32-bit address and a
   * count. The answer is [address][length][status][data ...][checksum].
   * @param {number} address - Where to read.
   * @param {number} length - How many bytes (at most 123).
   * @param {AbortSignal} [abort] - Cancel signal.
   * @returns {Promise<Uint8Array>} Exactly `length` bytes.
   * @throws {Error} When the module refused or answered short, after the retries.
   */
  async readBytes(address, length, abort) {
    const payload = [
      0x06,
      (address >>> 24) & 0xff,
      (address >> 16) & 0xff,
      (address >> 8) & 0xff,
      address & 0xff,
      length & 0xff,
    ];
    let last = null;
    for (let attempt = 0; attempt < GS20_RETRIES; attempt++) {
      _gs20Check(abort);
      try {
        const reply = await this._wire.transfer(
          this._address,
          payload,
          GS20_READ_TIMEOUT_MS
        );
        if (ds2Status(reply) !== DS2_STATUS.ok) {
          throw new Error(
            `the transmission refused a read at ${_gs20Hex(address)}: ` +
              busTrace.hex(reply.slice(0, 12))
          );
        }
        const available = reply.length - 4;
        if (available < length) {
          throw new Error(
            `a read at ${_gs20Hex(address)} returned only ${Math.max(available, 0)} of ${length} bytes`
          );
        }
        return Uint8Array.from(reply.slice(3, 3 + length));
      } catch (e) {
        if (e && e.message === 'cancelled') throw e;
        last = e;
        if (attempt + 1 < GS20_RETRIES) await bmwSleep(GS20_RETRY_DELAY_MS);
      }
    }
    throw new Error(
      `a read at ${_gs20Hex(address)} failed after ${GS20_RETRIES} attempts: ${last && last.message}`
    );
  }
}

/**
 * Writes a GS20 calibration over raw DS2: unlock, erase, wait, write, commit.
 */
class Gs20CalWriter {
  /**
   * Data bytes per write telegram. A write telegram is 1 address + 1 length
   * + 6 header + data + 1 checksum; the length byte caps the total at 255,
   * so 118 is what the reference tool uses and the most that fits with
   * headroom.
   */
  static get CHUNK() {
    return 118;
  }
  /**
   * @param {Ds2Wire} wire - The link.
   * @param {{note?: (text: string) => void, address?: number}} [opts]
   */
  constructor(wire, opts = {}) {
    this._wire = wire;
    this._note = opts.note || (() => {});
    this._address = opts.address == null ? DS2_ADDRESS.tcu : opts.address;
    /**
     * Whether an erase was sent. Until it is, a failure has left the
     * calibration exactly as it was, and saying otherwise would send someone
     * hunting a problem they do not have.
     * @type {boolean}
     */
    this.eraseStarted = false;
  }

  /**
   * @param {number[]} payload - The command bytes.
   * @param {number} timeoutMs - How long the module may take to answer.
   * @param {string} what - The step, for the error.
   * @param {{abort?: AbortSignal, allowBusy?: boolean, allowRefused?: boolean}} [opts]
   * @returns {Promise<number[]>}
   */
  _exchange(payload, timeoutMs, what, opts) {
    return _gs20Exchange(
      this._wire,
      this._address,
      payload,
      timeoutMs,
      what,
      opts
    );
  }

  /**
   * Start a session. Without this the module refuses the unlock that
   * follows, the same way whether the cable is wrong or the session was
   * simply never opened. A module whose program is erased answers from its
   * boot block, which refuses the open (0xA2) because it is already in
   * programming mode -- and then takes unlock, erase and write as usual, so
   * that refusal is noted rather than fatal.
   * @param {AbortSignal} [abort] - Cancel signal.
   * @returns {Promise<void>}
   */
  async openSession(abort) {
    const reply = await this._exchange(
      [0x05],
      GS20_NORMAL_TIMEOUT_MS,
      'session open',
      {
        abort,
        allowRefused: true,
      }
    );
    if (ds2Status(reply) === DS2_STATUS.refused) {
      this._note(
        'session open refused (0xA2): the module is already in programming mode, continuing'
      );
    }
  }

  /**
   * Take the module back out of programming mode. A transmission left in it
   * keeps answering its own requests while holding the line against
   * everything else, so the engine control unit stops identifying and the
   * cable looks broken. An identification request is what settles it.
   * Failing to close is not worth raising over: the calibration is written.
   * @returns {Promise<void>}
   */
  async closeSession() {
    try {
      await this._exchange([0x00], GS20_NORMAL_TIMEOUT_MS, 'session close');
    } catch (e) {
      /* nothing useful to do; the write itself has finished */
    }
  }

  /**
   * Supply voltage, worth knowing before an erase: the module browning out
   * midway is one of the few ways to be left holding half a calibration.
   * Command 0B 03 answers a 48-byte block; the voltage sits at offset 10,
   * scaled by 0.10196078 (12.44 V against a parked car).
   * @returns {Promise<number>} Volts, 0 when the block is too short.
   */
  async readBatteryVolts() {
    const reply = await this._exchange(
      [0x0b, 0x03],
      GS20_NORMAL_TIMEOUT_MS,
      'battery'
    );
    if (reply.length <= GS20_VOLTAGE_OFFSET) return 0;
    return (
      Math.round(reply[GS20_VOLTAGE_OFFSET] * GS20_VOLTAGE_SCALE * 100) / 100
    );
  }

  /**
   * Open the module for programming. It either reports itself already open,
   * with a five-byte reply, or returns a 46-byte challenge to answer. The
   * answer is four bytes, each the sum of three taken from the challenge:
   * one the seed points at, one from offset 18 and one from offset 41. The
   * bytes involved happen to be ASCII, so a valid key looks oddly uniform;
   * that is not a sign of it being wrong.
   * @param {AbortSignal} [abort] - Cancel signal.
   * @returns {Promise<void>}
   * @throws {Error} On an unexpected challenge or a rejected key.
   */
  async unlock(abort) {
    const seed = 1 + Math.floor(Math.random() * 23); // 1..23, like the reference
    const reply = await this._exchange(
      [0x90, 0x42, 0x4d, 0x57, seed],
      GS20_NORMAL_TIMEOUT_MS,
      'unlock seed',
      { abort }
    );
    const replyLength = reply.length > 1 ? reply[1] : 0;
    if (replyLength === GS20_SHORT_REPLY) return; // already open
    if (replyLength !== GS20_CHALLENGE_REPLY) {
      throw new Error(
        `unexpected reply to the unlock request: ${busTrace.hex(reply.slice(0, 16))}`
      );
    }
    const key = [];
    for (let i = 0; i < 4; i++) {
      key[i] =
        (reply[(seed + i) % replyLength] + reply[18 + i] + reply[41 + i]) &
        0xff;
    }
    const accepted = await this._exchange(
      [0x90, ...key],
      GS20_NORMAL_TIMEOUT_MS,
      'unlock key',
      {
        abort,
      }
    );
    // a short reply means the module is now open; its trailing byte varies
    // and is not a result code
    if ((accepted.length > 1 ? accepted[1] : 0) !== GS20_SHORT_REPLY) {
      throw new Error(
        `the transmission did not accept the unlock key: ${busTrace.hex(accepted.slice(0, 16))}`
      );
    }
  }

  /**
   * Ask the flash for its status, which only an open module answers. Nothing
   * is modified, so this is the last chance to stop cheaply.
   * @param {AbortSignal} [abort] - Cancel signal.
   * @returns {Promise<void>}
   * @throws {Error} Saying nothing was erased, when the module is not open.
   */
  async confirmFlashAccepted(abort) {
    let reply;
    try {
      reply = await this._exchange(
        _gs20AddressCommand(0x0f, GS20_CAL_ADDRESS),
        GS20_NORMAL_TIMEOUT_MS,
        'flash status',
        { abort, allowBusy: true }
      );
    } catch (e) {
      if (e && e.message === 'cancelled') throw e;
      throw new Error(
        'the transmission did not answer a flash status request, so it is not open ' +
          `for programming. Nothing was erased. (${e && e.message})`,
        { cause: e }
      );
    }
    const status = ds2Status(reply);
    if (status !== DS2_STATUS.ok && status !== DS2_STATUS.busy) {
      throw new Error(
        'the transmission refused a flash status request, so it is not open for ' +
          `programming. Nothing was erased. Reply: ${busTrace.hex(reply.slice(0, 12))}`
      );
    }
  }

  /**
   * Erase the calibration sector, then poll until the module stops
   * reporting busy.
   * @param {AbortSignal} [abort] - Cancel signal.
   * @returns {Promise<void>}
   * @throws {Error} When the erase is refused or the module stays busy.
   */
  async erase(abort) {
    this.eraseStarted = true;
    await this._exchange(
      _gs20AddressCommand(0x06, GS20_CAL_ADDRESS),
      GS20_ERASE_TIMEOUT_MS,
      'erase',
      {
        abort,
      }
    );
    for (let poll = 0; poll < GS20_MAX_BUSY_POLLS; poll++) {
      _gs20Check(abort);
      const reply = await this._exchange(
        _gs20AddressCommand(0x0f, GS20_CAL_ADDRESS),
        GS20_ERASE_TIMEOUT_MS,
        'status',
        { abort, allowBusy: true }
      );
      if (ds2Status(reply) !== DS2_STATUS.busy) return;
      await bmwSleep(GS20_BUSY_POLL_MS);
    }
    throw new Error('the transmission stayed busy after the erase');
  }

  /**
   * Program the image. Pairs of blank bytes are stepped over rather than
   * written, and a chunk is trimmed back past any blank tail, so only cells
   * that carry data are programmed.
   * @param {Uint8Array} image - The checksum-corrected 64 KB image.
   * @param {{onProgress?: (pct: number) => void, abort?: AbortSignal}} [opts]
   * @returns {Promise<void>}
   * @throws {Error} When a write is rejected, naming the address and fault.
   */
  async writeRegion(image, opts = {}) {
    let offset = 0;
    while (offset < image.length) {
      _gs20Check(opts.abort);
      while (
        offset + 1 < image.length &&
        image[offset] === 0xff &&
        image[offset + 1] === 0xff
      ) {
        offset += 2;
      }
      if (offset >= image.length) break;
      let length = Math.min(Gs20CalWriter.CHUNK, image.length - offset);
      while (
        length > 2 &&
        image[offset + length - 2] === 0xff &&
        image[offset + length - 1] === 0xff
      ) {
        length -= 2;
      }
      const address = GS20_CAL_ADDRESS + offset;
      const payload = [
        0x07,
        0x02,
        (address >> 16) & 0xff,
        (address >> 8) & 0xff,
        address & 0xff,
        length,
        ...image.subarray(offset, offset + length),
      ];
      const reply = await this._exchange(
        payload,
        GS20_NORMAL_TIMEOUT_MS,
        'write',
        {
          abort: opts.abort,
        }
      );
      const sub = ds2SubStatus(reply);
      if (sub != null && sub !== 1) {
        throw new Error(
          `write rejected at ${_gs20Hex(address)}: ${ds2DescribeSubStatus(sub)}`
        );
      }
      offset += length;
      opts.onProgress &&
        opts.onProgress(Math.round((offset * 100) / image.length));
    }
  }

  /**
   * The closing status request, which unlike the others insists the
   * sub-status reports the operation actually completed.
   * @param {AbortSignal} [abort] - Cancel signal.
   * @returns {Promise<void>}
   * @throws {Error} When the module never confirms, or reports a flash fault.
   */
  async commit(abort) {
    for (let poll = 0; poll < GS20_MAX_BUSY_POLLS; poll++) {
      _gs20Check(abort);
      const reply = await this._exchange(
        _gs20AddressCommand(0x0f, GS20_CAL_ADDRESS),
        GS20_ERASE_TIMEOUT_MS,
        'commit',
        { abort, allowBusy: true }
      );
      if (ds2Status(reply) === DS2_STATUS.busy) {
        await bmwSleep(GS20_BUSY_POLL_MS);
        continue;
      }
      const sub = ds2SubStatus(reply);
      if (sub === 1) return;
      throw new Error(
        `the transmission did not confirm the write: ${ds2DescribeSubStatus(sub)} ` +
          `(${busTrace.hex(reply.slice(0, 12))})`
      );
    }
    throw new Error('the transmission never confirmed the write');
  }

  /**
   * Write a calibration. The image must be exactly 64 KB; its checksum is
   * corrected first, so the caller may pass a freshly edited tune.
   * @param {Uint8Array} calibration - The image to write.
   * @param {{onProgress?: (pct: number) => void, onStage?: (text: string) => void, abort?: AbortSignal}} [opts]
   * @returns {Promise<{checksumCorrected: boolean}>}
   * @throws {Error} On a wrong size, a refused step, or cancel.
   */
  async write(calibration, opts = {}) {
    if (!calibration || calibration.length !== GS20_CAL_LENGTH) {
      throw new Error(
        `a GS20 calibration is 0x${GS20_CAL_LENGTH.toString(16).toUpperCase()} bytes; ` +
          `this one is 0x${(calibration ? calibration.length : 0).toString(16).toUpperCase()}`
      );
    }
    const stage = opts.onStage || (() => {});
    // correct the checksum before a single byte goes out: a calibration the
    // module rejects at power-up is the one failure this can prevent outright
    const image = gs20Checksum.correct(calibration);
    const checksumCorrected =
      gs20Checksum.stored(calibration) !== gs20Checksum.stored(image);
    if (checksumCorrected) {
      this._note(
        `checksum corrected 0x${gs20Checksum.stored(calibration).toString(16).toUpperCase().padStart(4, '0')}` +
          ` -> 0x${gs20Checksum.stored(image).toString(16).toUpperCase().padStart(4, '0')}`
      );
    }
    _gs20Check(opts.abort);

    stage('opening session');
    await this.openSession(opts.abort);
    stage('unlocking');
    await this.unlock(opts.abort);
    // prove the module really will take flash commands before erasing
    await this.confirmFlashAccepted(opts.abort);

    stage(`erasing ${_gs20Hex(GS20_CAL_ADDRESS)}`);
    await this.erase(opts.abort);

    stage(`writing ${image.length} bytes to ${_gs20Hex(GS20_CAL_ADDRESS)}`);
    await this.writeRegion(image, {
      onProgress: opts.onProgress,
      abort: opts.abort,
    });

    stage('committing');
    await this.commit(opts.abort);
    stage('done');
    return { checksumCorrected };
  }
}

// ---- orchestration on the car ---------------------------------------------------
/**
 * Try the fast rate for a bulk transfer. A module that will not take it
 * costs only speed, so the refusal is logged and the session carries on.
 * @param {Ds2Wire} wire - The link.
 * @param {(text: string) => void} stage - Progress callback.
 * @returns {Promise<void>}
 */
async function _gs20TryFast(wire, stage) {
  try {
    await wire.switchBaud(DS2_ADDRESS.tcu, GS20_FAST_BAUD);
    stage(`baud ${wire.baud}`);
  } catch (e) {
    stage(`staying at ${wire.baud} baud: ${(e && e.message) || e}`);
  }
}

/**
 * Leave the module on the rate the rest of the app expects. Best effort.
 * @param {Ds2Wire} wire - The link.
 * @returns {Promise<void>}
 */
async function _gs20BackToDefault(wire) {
  try {
    await wire.switchBaud(DS2_ADDRESS.tcu, GS20_DEFAULT_BAUD);
  } catch (e) {
    /* the module may already be back, or gone; nothing more to do here */
  }
}

/**
 * Read the transmission's calibration off the car.
 * @param {Object} [opts]
 * @param {boolean} [opts.fast=true] - Move to 125000 baud for the transfer.
 * @param {(text: string) => void} [opts.onStage] - Progress callback.
 * @param {(pct: number) => void} [opts.onProgress] - Progress 0..100.
 * @param {AbortSignal} [opts.abort] - Cancels the read.
 * @returns {Promise<Uint8Array>} The 64 KB calibration.
 */
function gs20ReadCalibration(opts = {}) {
  const stage = opts.onStage || (() => {});
  return ds2WireSession(
    async (wire) => {
      // a plain read needs no session: the 06 read answers in the module's
      // normal mode, which is how the reference tool reads it
      if (opts.fast !== false) await _gs20TryFast(wire, stage);
      try {
        stage('reading calibration');
        return await new Gs20CalReader(wire, { note: stage }).read({
          onProgress: opts.onProgress,
          abort: opts.abort,
        });
      } finally {
        await _gs20BackToDefault(wire);
      }
    },
    { trace: opts.onTrace }
  );
}

/**
 * Write a calibration to the transmission. The UI MUST have confirmed this
 * with the operator first; the engine refuses an unconfirmed call.
 * @param {Uint8Array} calibration - The 64 KB image (checksum corrected here).
 * @param {Object} [opts]
 * @param {boolean} opts.confirmed - The operator's explicit confirmation.
 * @param {boolean} [opts.fast=true] - Move to 125000 baud for the transfer.
 * @param {(text: string) => void} [opts.onStage] - Progress callback.
 * @param {(pct: number) => void} [opts.onProgress] - Progress 0..100.
 * @param {AbortSignal} [opts.abort] - Cancels (never mid-erase: see below).
 * @returns {Promise<{checksumCorrected: boolean, volts: number|null, eraseStarted: boolean}>}
 * @throws {Error} Unconfirmed, low battery, or whatever step refused. The
 *   error carries `eraseStarted` so the UI can say whether the calibration
 *   on the car was touched.
 */
function gs20WriteCalibration(calibration, opts = {}) {
  if (!opts.confirmed) {
    throw new Error(
      'a calibration write requires an explicit confirmation from the UI'
    );
  }
  const stage = opts.onStage || (() => {});
  return ds2WireSession(
    async (wire) => {
      const writer = new Gs20CalWriter(wire, { note: stage });
      let volts = null;
      try {
        // the session has to be open before anything else is asked of the
        // module: without it even a supply reading comes back refused
        stage('opening session');
        await writer.openSession(opts.abort);

        // worth knowing, not worth failing over: a module left mid-session by
        // an earlier run refuses this while still flashing perfectly well
        try {
          volts = await writer.readBatteryVolts();
          stage(`battery ${volts.toFixed(1)} V`);
        } catch (e) {
          stage(`battery reading unavailable: ${(e && e.message) || e}`);
        }
        if (volts != null && volts > 0 && volts < 11.5) {
          throw new Error(
            `battery is ${volts.toFixed(1)} V, which is too low to flash safely; ` +
              'put a charger on it and try again'
          );
        }

        // five hundred odd telegrams at 9600 leave the calibration erased for
        // minutes rather than tens of seconds; the change is made after the
        // session is open and before anything is erased
        if (opts.fast !== false) await _gs20TryFast(wire, stage);

        const result = await writer.write(calibration, {
          onStage: stage,
          onProgress: opts.onProgress,
          abort: opts.abort,
        });
        // the programming-log entry, written while the session is still
        // unlocked (core/gs20-program.js adds writeAifRecord); never fatal
        let aif = null;
        let aifError = null;
        if (opts.aifRecord && typeof writer.writeAifRecord === 'function') {
          try {
            stage('writing the programming record (AIF)');
            aif = await writer.writeAifRecord(opts.aifRecord);
            stage(
              `AIF entry ${aif.slot + 1} written at ${_gs20Hex(aif.address)} (${aif.left} left)`
            );
          } catch (e) {
            aifError = (e && e.message) || String(e);
            stage(`AIF not written: ${aifError}`);
          }
        }
        return { ...result, volts, eraseStarted: writer.eraseStarted, aif, aifError };
      } catch (e) {
        if (e && typeof e === 'object') e.eraseStarted = writer.eraseStarted;
        throw e;
      } finally {
        await _gs20BackToDefault(wire);
        await writer.closeSession();
      }
    },
    { trace: opts.onTrace }
  );
}

if (typeof window !== 'undefined') {
  window.gs20Checksum = gs20Checksum;
  window.gs20ReadCalibration = gs20ReadCalibration;
  window.gs20WriteCalibration = gs20WriteCalibration;
  window.GS20_CAL_LENGTH = GS20_CAL_LENGTH;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    gs20Checksum,
    Gs20CalReader,
    Gs20CalWriter,
    _gs20Exchange,
    _gs20AddressCommand,
    _gs20Hex,
    _gs20Check,
    _gs20TryFast,
    _gs20BackToDefault,
    GS20_NORMAL_TIMEOUT_MS,
    GS20_READ_TIMEOUT_MS,
    GS20_ERASE_TIMEOUT_MS,
    GS20_RETRIES,
    GS20_RETRY_DELAY_MS,
    GS20_BUSY_POLL_MS,
    GS20_MAX_BUSY_POLLS,
    GS20_DEFAULT_BAUD,
    gs20ReadCalibration,
    gs20WriteCalibration,
    GS20_CAL_ADDRESS,
    GS20_CAL_LENGTH,
    GS20_FAST_BAUD,
  };
}
