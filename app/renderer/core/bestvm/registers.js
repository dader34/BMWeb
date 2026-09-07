/**
 * @file The register file: the 32-byte B/I/L/A overlay, the F doubles and
 * the fixed-capacity S string registers. Extends Best2Vm (machine.js).
 */

if (typeof require === 'function' && typeof module !== 'undefined') {
  Object.assign(globalThis, require('./machine.js'));
}

/** Byte index where the A registers start in the register file. */
const A_REG_OFFSET = 16;

/**
 * Where a numeric register lives in the 32-byte file.
 * @param {string} name - A register name: B0..BF, A0..AF, I0..IF, L0..L7.
 * @returns {?[number, number]} `[byteOffset, width]`, or null for a name
 *   that is not a numeric register.
 */
Best2Vm.regSpan = function regSpan(name) {
  const kind = name[0];
  const idx = parseInt(name.slice(1), 16);
  if (!Number.isFinite(idx)) return null;
  // A registers are byte registers at index+16, NOT a wider type
  if (kind === 'B') return [idx, 1];
  if (kind === 'A') return [A_REG_OFFSET + idx, 1];
  if (kind === 'I') return [idx * 2, 2];
  if (kind === 'L') return [idx * 4, 4];
  return null;
};

Object.assign(Best2Vm.prototype, {
  /**
   * Read a register by name: a float, the logical bytes of a string
   * register, or a numeric register's unsigned value.
   * @param {string} name - The register name.
   * @returns {number|Uint8Array} The value (bytes for an S register).
   * @throws {VmError} An unknown register name.
   */
  getReg(name) {
    if (name[0] === 'F') return this.fregs.get(name) || 0;
    if (name[0] === 'S') return this.getS(name);
    const span = Best2Vm.regSpan(name);
    if (!span) throw new VmError(`unknown register ${name}`);
    // LITTLE-endian within the view: byte 0 is the LOW byte
    // (Register.GetValueData -- reg[off] + reg[off+1]<<8 + ...). Reading
    // these big-endian made `move B0,x` show up as x*256 in I0, so a
    // one-byte flag published as 256.
    return Best2Codec.leValue(this.regBuf, span[0], span[1]);
  },

  /**
   * Write a register by name. A numeric register takes the value truncated
   * to an integer, two's complement in its own width, low byte first.
   * @param {string} name - The register name.
   * @param {number|Uint8Array|number[]} value - The value (bytes for an S
   *   register).
   * @returns {void}
   * @throws {VmError} An unknown register name.
   */
  setReg(name, value) {
    if (name[0] === 'F') {
      this.fregs.set(name, value);
      return;
    }
    if (name[0] === 'S') {
      this.setS(name, value);
      return;
    }
    const span = Best2Vm.regSpan(name);
    if (!span) throw new VmError(`unknown register ${name}`);
    let v = Math.trunc(Number(value));
    if (v < 0) v += 2 ** (8 * span[1]); // two's complement in-width
    this.regBuf.set(Best2Codec.leBytes(v, span[1]), span[0]);
  },

  /**
   * The string register record, created on first use. A string register is
   * a FIXED-CAPACITY buffer plus a logical length, exactly like EdiabasNet's
   * StringData -- not a JS array that shrinks. The distinction is
   * observable: `clear` zeroes the length but reads at an index past it
   * still see whatever bytes are in the buffer (Operand.GetRawData uses
   * GetArrayData(TRUE), the complete buffer), and MS450's IDENT publishes
   * ID_SG_ADR from exactly such a stale byte.
   * @param {string} name - The S register name.
   * @returns {import('./machine.js').StringRegister} The register record.
   */
  sd(name) {
    let d = this.sregs.get(name);
    if (!d) {
      d = { buf: new Uint8Array(this.arraySize), len: 0 };
      this.sregs.set(name, d);
    }
    return d;
  },

  /**
   * A string register's logical contents.
   * @param {string} name - The S register name.
   * @returns {Uint8Array} A view of the first `len` bytes.
   */
  getS(name) {
    const d = this.sd(name);
    return d.buf.subarray(0, d.len);
  },

  /**
   * A string register's complete buffer, stale bytes included -- what
   * indexed reads see.
   * @param {string} name - The S register name.
   * @returns {Uint8Array} The whole buffer.
   */
  getSraw(name) {
    return this.sd(name).buf;
  },

  /**
   * Replace a string register's contents.
   * @param {string} name - The S register name.
   * @param {Uint8Array|number[]} bytes - The new contents.
   * @param {boolean} [keepLength] - Leave the logical length untouched.
   * @returns {void}
   */
  setS(name, bytes, keepLength) {
    const d = this.sd(name);
    const src =
      bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    if (src.length > d.buf.length) {
      // over capacity: StringData.SetData raises EDIABAS_BIP_0001 (no
      // mapped trap bit -> 0) and does NOT write. Returning silently left
      // the register holding stale bytes with a clean trap register.
      this.trapBit = TRAP_UNMAPPED;
      return;
    }
    d.buf.set(src, 0);
    if (!keepLength) d.len = src.length;
  },

  /**
   * `clear` on a string register zeroes the whole buffer AND the length.
   * @param {string} name - The S register name.
   * @returns {void}
   */
  clearS(name) {
    const d = this.sd(name);
    d.buf.fill(0);
    d.len = 0;
  },
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { A_REG_OFFSET };
}
