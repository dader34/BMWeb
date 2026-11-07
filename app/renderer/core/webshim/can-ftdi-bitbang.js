/**
 * @file CAN transport via FTDI FT232 GPIO bit-bang over WebUSB.
 *
 * HOW IT WORKS
 * ─────────────
 * The K+DCAN cable's CAN side wires two of the FT232's GPIO pins directly
 * into a TJA1050 CAN transceiver.  The transceiver handles differential
 * signalling; the GPIO just needs to clock the right bit pattern at the right
 * rate.  There is no CAN controller (no MCP2515, no SJA1000) — bit stuffing,
 * CRC-15, ACK slot and EOF are ALL computed here and baked into a single
 * GPIO bit-pattern before the first byte goes to the chip.
 *
 * FTDI vendor control path (unavailable via WebSerial):
 *   SET_BITMODE  bRequest=0x0B  wValue=(mask<<8)|mode  wIndex=0
 *     mode=0x01  async bit-bang: each bulk write byte sets the 8 GPIO lines
 *     mode=0x00  reset to UART
 *   GET_BITMODE  bRequest=0x0C  read 1 byte = current pin state
 * CAN TX = GPIO bit 4 (D4 on the FT232 / pin 10 on the chip side).
 * CAN RX = GPIO bit 3 (D3).
 *
 * TIMING
 * ──────
 * FTDI FT232 async bit-bang bulk write rate ≈ 500 kHz–3 MHz depending on
 * the USB packet scheduler.  For 500 kbit CAN we need 6 GPIO samples per
 * bit-time (3 MHz clock, same value held for 6 samples).  A 100-bit CAN
 * frame + stuffing overhead + IFS = ~130 bit-times = ~780 GPIO samples
 * = 780 bytes in one bulk write.
 *
 * OPEN-LOOP RECEIVE
 * ─────────────────
 * Bit-bang read-back is slow and jittery.  For GS20 we do not need it:
 * the TCU pushes the reply on 0x7DC which the K-line side of the cable
 * reads back through the normal WebSerial UART path.  Set readbackPort to
 * an open SlcanPort (or any port whose onFrame handles incoming frames)
 * and this class will not try to decode the GPIO read-back.
 *
 * macOS DRIVER CONFLICT
 * ─────────────────────
 * Apple's FTDIUSBSerialDriver.kext claims interface 0 of any FT232 on boot.
 * WebUSB cannot claim an interface already held by a kernel driver.
 * Workaround:
 *   sudo kextunload -b com.apple.driver.AppleUSBFTDI
 *   sudo kextunload -b com.FTDI.driver.FTDIUSBSerialDriver
 * Those survive until the next USB re-plug or reboot, so do it right after
 * plugging in the cable.  A helper message is shown by open() when the
 * claim fails.
 *
 * WIRING (K+DCAN cable CAN side)
 * ────────────────────────────────
 *   FTDI D4 (TX GPIO) ── TJA1050 TXD
 *   FTDI D3 (RX GPIO) ── TJA1050 RXD
 *   OBD pin 6  = CAN-H
 *   OBD pin 14 = CAN-L
 *   120 Ω across CAN-H/L on a 2-node bench (TCU + this cable).
 *
 * Usage:
 *   const port = new FtdiBitbangCanPort();
 *   await port.open();
 *   await port.send(0x7DD, [0x20, 0, 0x00, 0xD4, 0, 0, 0, 0]);
 *   // reply arrives on the K-line UART; this class does not decode GPIO RX
 *   await port.close();
 */
/* exported FtdiBitbangCanPort, gs20CanRequest */

// ---- FTDI constants ----------------------------------------------------------
const FTDI_VID = 0x0403;
const FTDI_PID_232R = 0x6001; // FT232R (most K+DCAN cables)
const FTDI_PID_232H = 0x6014; // FT232H

/** FTDI vendor bRequest: SET_BITMODE */
const SET_BITMODE = 0x0b;
/** FTDI vendor bRequest: SET_BAUD_RATE (for async bit-bang rate) */
const SET_BAUD_RATE = 0x03;
/** GPIO direction mask: D4=TX out, D3=RX in; set all as output for TX. */
const GPIO_MASK = 0xff; // all 8 lines as output for async BB TX
/** async bit-bang mode */
const BB_MODE_ASYNC = 0x01;
/** reset to UART mode */
const BB_MODE_UART = 0x00;

/** Which GPIO bit is wired to TJA1050 TXD (CAN TX). */
const TX_BIT = 4; // D4
/** Idle state: CAN recessive = logic 1 on TXD. */
const TX_IDLE = 1 << TX_BIT;
/** CAN dominant = logic 0 on TXD. */
const TX_DOM = 0x00;
/** CAN recessive = all lines high (preserves other pins). */
const TX_REC = TX_IDLE;

// ---- CAN frame encoder -------------------------------------------------------

/** CAN-15 polynomial x^15 + x^14 + x^10 + x^8 + x^7 + x^4 + x^3 + x + 1 */
const CAN_CRC_POLY = 0x4599;

/**
 * Compute the 15-bit CAN CRC over the given bits (array of 0/1).
 * @param {number[]} bits
 * @returns {number} 15-bit CRC, MSB first.
 */
function canCrc15(bits) {
  let crc = 0;
  for (const bit of bits) {
    const top = (crc >>> 14) & 1;
    crc = ((crc << 1) & 0x7fff) | bit;
    if (top) crc ^= CAN_CRC_POLY;
  }
  return crc & 0x7fff;
}

/**
 * Build the raw bit stream (before EOF/IFS) for a standard CAN 2.0A data
 * frame, applying bit stuffing over SOF..CRC (not CRC delim or later).
 *
 * Returns an array of 0/1 values in transmission order.
 * @param {number} id    - 11-bit CAN ID.
 * @param {number[]} data - 0–8 bytes of payload.
 * @returns {number[]} Bit stream: SOF…IFS, ready to clock out.
 */
function encodeFrame(id, data) {
  const dlc = data.length;

  // --- build the unstuffed data region bits (SOF + arbitration + control + data) ---
  const raw = [];
  // SOF: 1 dominant bit
  raw.push(0);
  // ID[10..0] MSB first
  for (let i = 10; i >= 0; i--) raw.push((id >>> i) & 1);
  // RTR = 0 (data frame)
  raw.push(0);
  // IDE = 0 (11-bit)
  raw.push(0);
  // r0 = 0
  raw.push(0);
  // DLC[3..0]
  for (let i = 3; i >= 0; i--) raw.push((dlc >>> i) & 1);
  // data bytes
  for (const byte of data) {
    for (let i = 7; i >= 0; i--) raw.push((byte >>> i) & 1);
  }

  // CRC-15 over raw bits so far
  const crc = canCrc15(raw);

  // append CRC[14..0]
  for (let i = 14; i >= 0; i--) raw.push((crc >>> i) & 1);

  // --- bit stuffing (SOF through end of CRC) ---
  const stuffed = [];
  let run = 0,
    last = -1;
  for (const bit of raw) {
    if (bit === last) {
      run++;
      if (run === 5) {
        stuffed.push(bit ^ 1); // insert opposite
        run = 1;
        last = bit ^ 1;
      }
    } else {
      run = 1;
      last = bit;
    }
    stuffed.push(bit);
  }

  // --- fields after stuffed region (not stuffed) ---
  // CRC delimiter: 1 recessive
  stuffed.push(1);
  // ACK slot: dominant (we acknowledge our own frame on a 2-node bench)
  stuffed.push(0);
  // ACK delimiter: 1 recessive
  stuffed.push(1);
  // EOF: 7 recessive
  for (let i = 0; i < 7; i++) stuffed.push(1);
  // IFS: 3 recessive
  for (let i = 0; i < 3; i++) stuffed.push(1);

  return stuffed;
}

/**
 * Expand a bit stream into a GPIO byte pattern.
 * Each bit is held for `samples` GPIO write cycles (oversampling).
 * bit=0 → TX_DOM, bit=1 → TX_REC.
 * @param {number[]} bits
 * @param {number} samples - Oversampling ratio (≥1).
 * @returns {Uint8Array}
 */
function bitsToGpioPattern(bits, samples) {
  const out = new Uint8Array(bits.length * samples);
  let pos = 0;
  for (const bit of bits) {
    const gpio = bit ? TX_REC : TX_DOM;
    for (let s = 0; s < samples; s++) out[pos++] = gpio;
  }
  return out;
}

// ---- FTDI baud-rate divider ---------------------------------------------------
// In async bit-bang mode the FTDI clocks out one byte per baud clock.
// Divisor = 3_000_000 / rate (for FT232R).  We target 3 MHz = divisor 1.
// Actual GPIO rate will be 3 MHz nominal; at 500k CAN we oversample by 6.

const FTDI_BASE_CLK = 3_000_000; // Hz — FT232R async BB max
const CAN_BIT_RATE = 500_000; // Hz — GS20 bus
const OVERSAMPLE = Math.round(FTDI_BASE_CLK / CAN_BIT_RATE); // = 6

/**
 * Build the 16-bit FTDI baud-rate divisor word for SET_BAUD_RATE.
 * FT232R: divisor = 3_000_000 / baud (integer part only for BB mode).
 * @param {number} targetHz
 * @returns {number} 16-bit divisor.
 */
function ftdiBaudDiv(targetHz) {
  return Math.max(1, Math.round(FTDI_BASE_CLK / targetHz)) & 0xffff;
}

// ---- FtdiBitbangCanPort class -------------------------------------------------

/**
 * CAN sender over FTDI FT232 GPIO bit-bang via WebUSB.
 *
 * This is a TX-only path; for RX use a SlcanPort or the K-line UART to read
 * the reply the GS20 pushes back on 0x7DC.
 */
class FtdiBitbangCanPort {
  /**
   * @param {object} [opts]
   * @param {number} [opts.canBitRate=500000] - CAN bus speed.
   * @param {number} [opts.oversample] - GPIO samples per CAN bit (auto).
   */
  constructor(opts = {}) {
    this._canBitRate = opts.canBitRate ?? CAN_BIT_RATE;
    this._oversample = opts.oversample ?? OVERSAMPLE;
    /** @type {USBDevice|null} */
    this._device = null;
    this._open = false;
  }

  /** Is the device open. */
  get connected() {
    return this._open;
  }

  /**
   * Request and open the FTDI device, configure bit-bang mode.
   * @returns {Promise<string>} Device description string.
   * @throws {Error} With a human-readable message if the kernel driver
   *   is blocking the WebUSB claim (macOS FTDIUSBSerialDriver.kext).
   */
  async open() {
    this._device = await navigator.usb.requestDevice({
      filters: [
        { vendorId: FTDI_VID, productId: FTDI_PID_232R },
        { vendorId: FTDI_VID, productId: FTDI_PID_232H },
      ],
    });

    await this._device.open();

    // macOS: the FTDI kext may hold interface 0 — selectConfiguration +
    // claimInterface will throw if it does.
    await this._device.selectConfiguration(1);
    try {
      await this._device.claimInterface(0);
      // WebUSB requires an explicit alt-setting selection before any bulk
      // transfer; FT232 interface 0 has one alt (0) carrying ep IN 0x81 and
      // ep OUT 0x02.  Skipping this is a NotFoundError on the first transferOut.
      await this._device.selectAlternateInterface(0, 0);
    } catch (e) {
      await this._device.close();
      this._device = null;
      throw new Error(
        'WebUSB cannot claim the FTDI interface — the macOS kernel driver ' +
          'is holding it.  Run these two commands in Terminal, then replug:\n' +
          '  sudo kextunload -b com.apple.driver.AppleUSBFTDI\n' +
          '  sudo kextunload -b com.FTDI.driver.FTDIUSBSerialDriver\n' +
          `(Original error: ${e.message})`,
        { cause: e }
      );
    }

    // set the baud-rate divisor for the target BB clock rate
    const div = ftdiBaudDiv(FTDI_BASE_CLK);
    await this._ctrlOut(SET_BAUD_RATE, div, 0);

    // enter async bit-bang mode: all 8 lines as output
    await this._ctrlOut(SET_BITMODE, (GPIO_MASK << 8) | BB_MODE_ASYNC, 0);

    // bus-idle: hold TX recessive
    await this._device.transferOut(
      2,
      new Uint8Array([TX_REC, TX_REC, TX_REC, TX_REC])
    );

    this._open = true;
    return `FTDI bit-bang CAN ${this._device.productName ?? ''}`.trim();
  }

  /**
   * Send one CAN data frame (up to 8 bytes) by writing the pre-computed
   * GPIO bit-pattern as a single bulk transfer.
   * @param {number} id - 11-bit CAN ID.
   * @param {ArrayLike<number>} data - 1–8 bytes.
   * @returns {Promise<void>}
   */
  async send(id, data) {
    if (!this._open) throw new Error('FTDI port not open');
    const bits = encodeFrame(id, Array.from(data));
    const pattern = bitsToGpioPattern(bits, this._oversample);
    // guarantee the line returns to idle
    const idle = new Uint8Array(this._oversample * 10).fill(TX_REC);
    const frame = new Uint8Array(pattern.length + idle.length);
    frame.set(pattern);
    frame.set(idle, pattern.length);
    await this._device.transferOut(2, frame);
  }

  /**
   * Reset to UART mode and release the USB interface.
   * @returns {Promise<void>}
   */
  async close() {
    if (!this._open) return;
    this._open = false;
    try {
      // recessive idle then back to UART
      await this._device.transferOut(2, new Uint8Array(8).fill(TX_REC));
      await this._ctrlOut(SET_BITMODE, BB_MODE_UART, 0);
    } catch {
      /* ok */
    }
    try {
      await this._device.releaseInterface(0);
    } catch {
      /* ok */
    }
    try {
      await this._device.close();
    } catch {
      /* ok */
    }
    this._device = null;
  }

  // ---- private ---------------------------------------------------------------

  /**
   * FTDI vendor control transfer OUT.
   * @param {number} request - bRequest byte (e.g. SET_BITMODE).
   * @param {number} value   - wValue.
   * @param {number} index   - wIndex (0 for single-interface FT232).
   */
  _ctrlOut(request, value, index) {
    return this._device.controlTransferOut(
      {
        requestType: 'vendor',
        recipient: 'device',
        request,
        value,
        index,
      },
      new Uint8Array(0)
    );
  }
}

// ---- GS20 CAN helper ---------------------------------------------------------

/**
 * Send one GS20 tester command over CAN and wait for the reply.
 *
 * @param {SlcanPort|FtdiBitbangCanPort} txPort - Open CAN sender.
 * @param {SlcanPort} rxPort - Open SlcanPort whose onFrame receives 0x7DC.
 * @param {number[]} payload - 8-byte command [cmd, sub, w1lo, w1hi, ...].
 * @param {number} [timeoutMs=500]
 * @returns {Promise<Uint8Array>} The 8-byte reply frame data.
 */
function gs20CanRequest(txPort, rxPort, payload, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rxPort.onFrame = null;
      reject(new Error('GS20 CAN reply timeout'));
    }, timeoutMs);

    rxPort.onFrame = (id, data) => {
      if (id !== GS20_REPLY_ID) return;
      clearTimeout(timer);
      rxPort.onFrame = null;
      resolve(data);
    };

    txPort.send(0x7dd, payload).catch((e) => {
      clearTimeout(timer);
      rxPort.onFrame = null;
      reject(e);
    });
  });
}
