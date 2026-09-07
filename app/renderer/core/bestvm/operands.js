/**
 * @file Operand addressing modes: how an instruction's `[mode, ...payload]`
 * operand is read as a number, as bytes, as text or as a float, how it is
 * written back, and how wide it is. Extends Best2Vm (machine.js).
 */

if (typeof require === 'function' && typeof module !== 'undefined') {
  Object.assign(globalThis, require('./machine.js'));
}

/**
 * Operand addressing modes, numbered as sgbd_code.py emits them (the
 * engine's OpAddrMode order), with the payload each carries after the mode:
 *   REG_*          [name]                 a register by name (S/B/A/I/L/F)
 *   IMM8/16/32     [value]                an immediate; IMM32 also holds
 *                                         jump targets (an ops index)
 *   IMM_STR        [poolIndex]            a constant-pool entry
 *   IDX_IMM        [reg, idx]             reg[#idx], one byte
 *   IDX_REG        [reg, idxReg]          reg[idxReg]
 *   IDX_REG_IMM    [reg, idxReg, off]     reg[idxReg + #off]
 *   IDX_*_LEN_*    [reg, idx, len]        a byte range; idx and len are
 *                                         each an immediate or a register
 *                                         name as the mode says
 */
const OpMode = Object.freeze({
  NONE: 0,
  REG_S: 1,
  REG_AB: 2,
  REG_I: 3,
  REG_L: 4,
  IMM8: 5,
  IMM16: 6,
  IMM32: 7,
  IMM_STR: 8,
  IDX_IMM: 9,
  IDX_REG: 10,
  IDX_REG_IMM: 11,
  IDX_IMM_LEN_IMM: 12,
  IDX_IMM_LEN_REG: 13,
  IDX_REG_LEN_IMM: 14,
  IDX_REG_LEN_REG: 15,
});

/**
 * Is the mode a plain register (REG_S..REG_L)?
 * @param {number} m - The operand mode.
 * @returns {boolean}
 */
function opIsReg(m) {
  return m >= OpMode.REG_S && m <= OpMode.REG_L;
}

/**
 * Is the mode a numeric immediate (IMM8..IMM32)?
 * @param {number} m - The operand mode.
 * @returns {boolean}
 */
function opIsImm(m) {
  return m >= OpMode.IMM8 && m <= OpMode.IMM32;
}

/**
 * Is the mode a single indexed byte (IDX_IMM..IDX_REG_IMM)?
 * @param {number} m - The operand mode.
 * @returns {boolean}
 */
function opIsIndexed(m) {
  return m >= OpMode.IDX_IMM && m <= OpMode.IDX_REG_IMM;
}

/**
 * Is the mode a byte range (the four IDX_*_LEN_* forms)?
 * @param {number} m - The operand mode.
 * @returns {boolean}
 */
function opIsRange(m) {
  return m >= OpMode.IDX_IMM_LEN_IMM && m <= OpMode.IDX_REG_LEN_REG;
}

/**
 * Is the operand a whole string register (`S0`, not `S0[i]`)?
 * @param {import('./machine.js').Operand} op - The operand.
 * @returns {boolean}
 */
function opIsStringReg(op) {
  return opIsReg(op[0]) && !!op[1] && op[1][0] === 'S';
}

/**
 * Is the operand a numeric register (B/A/I/L/F by name)? These are the
 * operands `mult` and `div` write their second result (high half,
 * remainder) back into.
 * @param {import('./machine.js').Operand|undefined} op - The operand.
 * @returns {boolean}
 */
function opIsNumReg(op) {
  return !!op && opIsReg(op[0]) && String(op[1])[0] !== 'S';
}

Object.assign(Best2Vm.prototype, {
  /**
   * The index of an indexed or ranged operand: an immediate for the
   * `IDX_IMM*` modes, else the named register's value.
   * @param {number} mode - The operand mode.
   * @param {number|string} a - The index payload (number or register name).
   * @returns {number} The index.
   */
  resolveIdx(mode, a) {
    // ranged/indexed modes name either an immediate index or a register
    if (
      mode === OpMode.IDX_IMM ||
      mode === OpMode.IDX_IMM_LEN_IMM ||
      mode === OpMode.IDX_IMM_LEN_REG
    ) {
      return a; // imm
    }
    return this.getReg(a); // reg
  },

  /**
   * The length of a ranged operand: an immediate for the `*_LEN_IMM`
   * modes, else the named register's value.
   * @param {number} mode - The operand mode.
   * @param {number|string} a - The length payload (number or register name).
   * @returns {number} The length.
   */
  resolveLen(mode, a) {
    if (mode === OpMode.IDX_IMM_LEN_IMM || mode === OpMode.IDX_REG_LEN_IMM) {
      return a; // imm
    }
    return this.getReg(a);
  },

  /**
   * Numeric read. `width` is the DESTINATION's width, and for byte-array
   * sources it decides how many bytes are folded -- Operand.GetValueData
   * takes dataLen from the caller and assembles that many bytes
   * LITTLE-endian, zero-padding when the slice is short.
   *
   * This matters far beyond arithmetic: `move I2, S2[B2]` reads TWO bytes
   * of the response into I2. Reading one byte made every response-length
   * guard of the form `move I2,S2[B2] / and / comp I5,I4` compare the wrong
   * number, so jobs reported ERROR_ECU_INCORRECT_LEN and emitted nothing.
   * @param {import('./machine.js').Operand} op - The operand.
   * @param {number} [width] - Bytes to fold for byte-array sources; the
   *   whole source when omitted (one byte for an indexed operand).
   * @returns {number} The unsigned value.
   * @throws {VmError} A mode that has no value.
   */
  val(op, width) {
    const [m, a, b, c] = op;
    if (opIsImm(m)) return a;
    if (m === OpMode.IMM_STR) return 0; // a string literal as number
    if (opIsReg(m)) {
      if (a[0] === 'S') {
        const buf = this.getS(a);
        return Best2Codec.leValue(buf, 0, width || buf.length);
      }
      return this.getReg(a);
    }
    if (opIsIndexed(m)) {
      const buf = this.getSraw(a); // complete buffer, stale included
      let i = m === OpMode.IDX_IMM ? b : this.getReg(b);
      if (m === OpMode.IDX_REG_IMM) i += c || 0;
      return Best2Codec.leValue(buf, i, width || 1);
    }
    if (opIsRange(m)) {
      const buf = this.bytes(op);
      return Best2Codec.leValue(buf, 0, width || buf.length);
    }
    throw new VmError(`operand mode ${m} as value`);
  },

  /**
   * Byte-array read: string registers, indexed bytes, ranges, pool
   * literals, or an immediate's low byte.
   * @param {import('./machine.js').Operand} op - The operand.
   * @returns {Uint8Array} The bytes (a view or a copy; callers treat it as
   *   read-only).
   * @throws {VmError} A mode that has no bytes.
   */
  bytes(op) {
    const [m, a, b, c] = op;
    if (m === OpMode.IMM_STR) {
      // a pool entry is either a byte ARRAY (an exact literal, possibly
      // containing NULs) or a plain string (a result/table name)
      const lit = this.code.strings[a];
      return Array.isArray(lit)
        ? Uint8Array.from(lit)
        : Best2Codec.strBytes(lit ?? '');
    }
    if (opIsReg(m)) {
      if (a[0] === 'S') return this.getS(a);
      const span = Best2Vm.regSpan(a);
      return this.regBuf.slice(span[0], span[0] + span[1]);
    }
    if (m === OpMode.IDX_IMM || m === OpMode.IDX_REG) {
      const buf = this.getSraw(a);
      const i = m === OpMode.IDX_IMM ? b : this.getReg(b);
      return i < buf.length ? buf.slice(i, i + 1) : new Uint8Array(0);
    }
    if (opIsRange(m)) {
      const buf = this.getSraw(a);
      const i = this.resolveIdx(m, b);
      const n = this.resolveLen(m, c);
      // reads past the current length yield what exists, not an error --
      // the engine's Operand does the same, and jobs rely on it
      return buf.slice(i, i + Math.max(0, n));
    }
    if (opIsImm(m)) {
      return Uint8Array.from([a & 0xff]);
    }
    throw new VmError(`operand mode ${m} as bytes`);
  },

  /**
   * Write back to an operand: a register, an indexed byte, or a range.
   * @param {import('./machine.js').Operand} op - The destination operand.
   * @param {number|Uint8Array|number[]} value - The value: bytes when
   *   `asBytes`, else a number.
   * @param {boolean} [asBytes] - Store `value` as bytes rather than as a
   *   number.
   * @returns {void}
   * @throws {VmError} A mode that cannot be written.
   */
  store(op, value, asBytes) {
    const [m, a, b, c] = op;
    if (opIsReg(m)) {
      if (asBytes) {
        if (a[0] === 'S') {
          this.setS(a, value);
          return;
        }
        const span = Best2Vm.regSpan(a);
        for (let i = 0; i < span[1]; i++) {
          this.regBuf[span[0] + i] = i < value.length ? value[i] : 0;
        }
        return;
      }
      this.setReg(a, value);
      return;
    }
    if (opIsIndexed(m)) {
      let i = m === OpMode.IDX_IMM ? b : this.getReg(b);
      if (m === OpMode.IDX_REG_IMM) i += c || 0;
      const d = this.sd(a);
      if (i >= d.buf.length) return; // over capacity: no write
      // a number lands as ONE byte: an indexed destination is a byte wide
      const src = asBytes ? value : Uint8Array.from([Number(value) & 0xff]);
      for (let k = 0; k < src.length && i + k < d.buf.length; k++) {
        d.buf[i + k] = src[k];
      }
      d.len = Math.max(d.len, i + src.length); // grows, never shrinks
      return;
    }
    if (opIsRange(m)) {
      const i = this.resolveIdx(m, b);
      const n = this.resolveLen(m, c);
      const src = asBytes ? value : Uint8Array.from([Number(value) & 0xff]);
      const d = this.sd(a);
      for (let k = 0; k < n && i + k < d.buf.length; k++) {
        d.buf[i + k] = k < src.length ? src[k] : 0;
      }
      d.len = Math.max(d.len, Math.min(i + Math.max(0, n), d.buf.length));
      return;
    }
    throw new VmError(`operand mode ${m} as destination`);
  },

  /**
   * Store TEXT into a string register the way Operand.SetStringData does:
   * the bytes PLUS one appended NUL when non-empty (an empty string stores a
   * zero-length array with no NUL). This is observable, not cosmetic --
   * `scmp` is byte-exact, and the compiler's literals carry the terminator
   * ("6\0"), so a stored "6" without one never matched and MS420's VANOS
   * jobs fell through to ERROR_FUNCTION_*.
   * @param {import('./machine.js').Operand} op - The destination operand.
   * @param {*} txt - The text to store.
   * @returns {void}
   */
  storeText(op, txt) {
    const b = Best2Codec.strBytes(String(txt ?? ''));
    if (b.length === 0) {
      this.store(op, b, true);
      return;
    }
    const out = new Uint8Array(b.length + 1);
    out.set(b);
    this.store(op, out, true);
  },

  /**
   * THE width rule: GetArgsValueLength returns arg0.GetDataLen(TRUE) and
   * ignores arg1 entirely, so every arithmetic/move width comes from the
   * DESTINATION in write mode. write=true is what makes a plain indexed
   * destination (S0[i]) exactly one byte wide.
   * @param {import('./machine.js').Operand} op - The operand.
   * @returns {number} Its width in bytes (0 for a mode without one).
   */
  widthOf(op) {
    const m = op[0];
    if (opIsReg(m)) {
      const r = op[1];
      if (r[0] === 'S') return this.getS(r).length;
      const span = Best2Vm.regSpan(r);
      return span ? span[1] : 4;
    }
    if (m === OpMode.IMM8) return 1;
    if (m === OpMode.IMM16) return 2;
    if (m === OpMode.IMM32) return 4;
    if (m === OpMode.IMM_STR) return this.bytes(op).length;
    if (opIsIndexed(m)) return 1; // write mode
    if (opIsRange(m)) return this.bytes(op).length;
    return 0;
  },

  /**
   * An operand as TEXT (arg.GetStringData()): a pool literal as its
   * NUL-terminated text, anything else as the NUL-terminated text of its
   * bytes. This is how result names, table names, column names and string
   * comparands are read -- and a name can equally be a REGISTER: MS420's
   * VANOS jobs name a result from a register still holding response bytes,
   * and the engine faithfully publishes the resulting garbage key.
   * @param {import('./machine.js').Operand} op - The operand.
   * @returns {string} The text.
   */
  textOf(op) {
    if (op[0] === OpMode.IMM_STR) return this.lit(op[1]);
    return Best2Codec.cstr(this.bytes(op));
  },

  /**
   * An operand as a FLOAT (arg.GetFloatData()): a pool literal parses as a
   * number, an F register reads its double, anything else its numeric
   * value.
   * @param {import('./machine.js').Operand} op - The operand.
   * @returns {number} The value.
   */
  floatOf(op) {
    if (op[0] === OpMode.IMM_STR) return Best2Codec.parseNum(this.lit(op[1]));
    if (op[1] && String(op[1])[0] === 'F') return this.getReg(op[1]);
    return this.val(op);
  },
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    OpMode,
    opIsReg,
    opIsImm,
    opIsIndexed,
    opIsRange,
    opIsStringReg,
    opIsNumReg,
  };
}
