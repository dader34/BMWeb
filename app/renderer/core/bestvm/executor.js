/**
 * @file The executor: the opcode `step` switch and the flag arithmetic it
 * leans on. Extends Best2Vm (machine.js).
 *
 * THE SWITCH IS A 1:1 OPCODE TABLE, on purpose. One `case` per BEST2
 * opcode, in the reference's grouping, each carrying the engine fact that
 * makes it right. It is not a dispatch table and not per-opcode methods:
 * the value of reading an opcode's semantics in one place, next to its
 * neighbours, outweighs the length. Helpers and tables live AROUND it
 * (this file's top, operands.js, environment.js); the case bodies keep
 * their order and semantics.
 */

if (typeof require === 'function' && typeof module !== 'undefined') {
  Object.assign(
    globalThis,
    require('./machine.js'),
    require('./operands.js'),
    require('./environment.js')
  );
}

/**
 * Which flag combination each conditional jump tests (EdOperations' jump
 * handlers). Named exactly as the disassembler emits them. jt/jnt are
 * handled in step(): they test the TRAP REGISTER with an optional bit
 * selector, not a boolean flag.
 * @type {Object<string, (f: import('./machine.js').VmFlags) => boolean>}
 */
const JUMP_TESTS = {
  jz: (f) => f.zero,
  jnz: (f) => !f.zero,
  jc: (f) => f.carry,
  jnc: (f) => !f.carry,
  jae: (f) => !f.carry,
  jbe: (f) => f.carry || f.zero,
  ja: (f) => !f.carry && !f.zero,
  jb: (f) => f.carry,
  jmi: (f) => f.sign,
  jpl: (f) => !f.sign,
  jv: (f) => f.overflow,
  jnv: (f) => !f.overflow,
  jg: (f) => !f.zero && f.sign === f.overflow,
  jge: (f) => f.sign === f.overflow,
  jl: (f) => f.sign !== f.overflow,
  jle: (f) => f.zero || f.sign !== f.overflow,
};

/**
 * Each erg* opcode has a FIXED width and signedness, independent of the
 * operand's own type (the reference's result table). Publishing ergi
 * unsigned reported SMG2's coolant temperature as 65531 where the engine
 * says -5.
 * @type {Object<string, [number, boolean]>} opcode -> [width, signed]
 */
const ERG_SPECS = {
  ergb: [1, false],
  ergw: [2, false],
  ergd: [4, false],
  ergi: [2, true],
  ergl: [4, true],
};

/**
 * Bits of the flags WORD that `pushf` writes and `popf` reads.
 */
const FLAG_CARRY = 1;
const FLAG_ZERO = 2;
const FLAG_SIGN = 4;
const FLAG_OVERFLOW = 8;

/** `jt target, 32` aliases the unmapped trap bit 0. */
const TRAP_BIT_ALIAS_UNMAPPED = 32;

/**
 * What `xtype` reports: EdInterfaceObd's name for the K+DCAN cable this
 * app drives. SGBDs (carb) branch on it to pick their concept.
 */
const INTERFACE_TYPE = 'OBD';

/**
 * What `xvers` reports: EdInterfaceObd.InterfaceVersion, 209 (0xD1). Not
 * the engine's 7.3.0 -- the INTERFACE's version, which is what the SGBD
 * asks.
 */
const INTERFACE_VERSION = 209;

/**
 * A CommParameter blob DECLARES its own element width in byte 1
 * (EdOperations.OpXsetpar): 0x00 = 16-bit words, 0x01 = 32-bit dwords,
 * 0xFF = bytes; anything else is not a CommParameter.
 * @type {Object<number, number>}
 */
const COMM_PARAM_WIDTHS = { 0x00: 2, 0x01: 4, 0xff: 1 };

/** The largest protocol concept number a CommParameter blob can name. */
const COMM_CONCEPT_MAX = 0x1ff;

/** BEST/2 `wait` is in SECONDS; the transport pauses in milliseconds. */
const MS_PER_SECOND = 1000;

/**
 * Reduce a value to the unsigned range of a width: `value mod 2^(8*width)`,
 * non-negative even for a negative input.
 * @param {number} value - The value.
 * @param {number} width - The width in bytes.
 * @returns {number} The wrapped value.
 */
function wrapToWidth(value, width) {
  const lim = 2 ** (8 * width);
  return ((value % lim) + lim) % lim;
}

/**
 * Two's-complement negation in FULL 32 bits, `(uint)(-value)` -- what the
 * engine feeds SetOverflow for a subtraction.
 * @param {number} value - An unsigned value.
 * @returns {number} Its 32-bit negation, unsigned.
 */
function negateU32(value) {
  return (0x100000000 - value) % 0x100000000;
}

/**
 * Read an unsigned 32-bit pattern as a signed integer.
 * @param {number} value - The unsigned value.
 * @returns {number} The signed value.
 */
function toInt32(value) {
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

/**
 * Zero-pad a number to two digits, for the `date`/`time` texts.
 * @param {number} n - The number.
 * @returns {string} Two or more digits.
 */
function twoDigits(n) {
  return String(n).padStart(2, '0');
}

Object.assign(Best2Vm.prototype, {
  /**
   * Flags.SetOverflow: only when the operands SHARE a sign that differs
   * from the result's. Operands are compared at the operation width.
   * @param {number} v1 - The first operand, unsigned at `width`.
   * @param {number} v2 - The second operand, unsigned at `width`.
   * @param {number} result - The raw (unwrapped) result.
   * @param {number} width - The operation width in bytes.
   * @returns {void}
   */
  setOverflow(v1, v2, result, width) {
    const sm = 2 ** (8 * width - 1);
    const s1 = (v1 & sm) !== 0,
      s2 = (v2 & sm) !== 0;
    const sr = (wrapToWidth(result, width) & sm) !== 0;
    this.flags.overflow = s1 === s2 && s1 !== sr;
  },

  /**
   * Set Zero and Sign from a result at a width.
   * @param {number} value - The raw (unwrapped) result.
   * @param {number} width - The width in bytes.
   * @returns {void}
   */
  updateFlags(value, width) {
    const masked = wrapToWidth(value, width);
    this.flags.zero = masked === 0;
    this.flags.sign = masked >= 2 ** (8 * width - 1);
  },

  /**
   * Push a value as `n` bytes, LSB first, so the top of the stack is the
   * most significant byte.
   * @param {number} value - The value.
   * @param {number} n - How many bytes.
   * @returns {void}
   */
  pushBytes(value, n) {
    let v = value;
    for (let i = 0; i < n; i++) {
      this.stack.push(v & 0xff);
      v = Math.floor(v / 256);
    }
  },

  /**
   * Pop `n` bytes and rebuild the value: push wrote LSB first, so the MSB
   * is on top, and popping MSB-first while shifting left reassembles
   * exactly what was pushed. The caller checks the stack is deep enough.
   * @param {number} n - How many bytes.
   * @returns {number} The value.
   */
  popValue(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + this.stack.pop();
    return v;
  },

  /**
   * Execute one instruction.
   * @param {string} name - The opcode name as sgbd_code.py emits it.
   * @param {import('./machine.js').Operand[]} a - Its operands.
   * @param {number} pc - Its index in `ops`, for error messages.
   * @returns {number|symbol|undefined} The next `pc` for a taken jump,
   *   STOP at `eoj`, or undefined to fall through to `pc + 1`.
   * @throws {VmError} An unimplemented opcode, an unresolved jump, a
   *   refused write, an oversized answer, or an `eerr`.
   */
  step(name, a, pc) {
    const A = a[0],
      B = a[1];
    const f = this.flags;

    switch (name) {
      case 'nop':
        return;
      case 'eoj':
        return STOP;

      // ---- stack: BYTES, not values. push writes the operand's width,
      // MSB last so the top of the stack is the most significant byte;
      // pop/atsp read a width and rebuild big-endian. atsp reads POS bytes
      // DOWN from the top rather than peeking (OpAtsp: index = pos - len).
      case 'push': {
        const w = this.widthOf(A);
        let v = this.val(A);
        if (opIsImm(A[0])) {
          // an immediate pushes 4 bytes (EdValueType width)
          this.pushBytes(v, 4);
          return;
        }
        this.pushBytes(v, w);
        return;
      }
      case 'pop': {
        // push wrote LSB first, so the MSB is on top: popping MSB-first and
        // shifting left reassembles exactly what was pushed.
        const w = this.widthOf(A);
        if (this.stack.length < w) {
          this.store(A, 0);
          this.updateFlags(0, w);
          return;
        }
        const v = this.popValue(w);
        this.store(A, v);
        this.flags.overflow = false;
        this.updateFlags(v, w);
        return;
      }
      case 'atsp': {
        // `atsp reg,#pos` reads WITHOUT popping, pos bytes down from the top
        // (OpAtsp: index = pos - length into a pop-order array, then
        // big-endian assembly). In our array the top is the LAST element,
        // so pop-order index k is stack[len-1-k].
        const w = this.widthOf(A);
        const pos = this.val(B);
        if (this.stack.length < w || pos < w) {
          this.store(A, 0);
          return;
        }
        let v = 0;
        for (let k = pos - w; k < pos; k++) {
          v = v * 256 + (this.stack[this.stack.length - 1 - k] ?? 0);
        }
        this.store(A, v);
        this.updateFlags(v, w);
        return;
      }
      case 'pushf': {
        // the flags WORD (bit0 carry, bit1 zero, bit2 sign, bit3 overflow),
        // 4 bytes LSB-first like any other push -- not four zeros
        const v =
          (f.carry ? FLAG_CARRY : 0) |
          (f.zero ? FLAG_ZERO : 0) |
          (f.sign ? FLAG_SIGN : 0) |
          (f.overflow ? FLAG_OVERFLOW : 0);
        this.pushBytes(v, 4);
        return;
      }
      case 'popf': {
        const v = this.stack.length >= 4 ? this.popValue(4) : 0;
        f.carry = !!(v & FLAG_CARRY);
        f.zero = !!(v & FLAG_ZERO);
        f.sign = !!(v & FLAG_SIGN);
        f.overflow = !!(v & FLAG_OVERFLOW);
        return;
      }

      case 'clear': {
        if (opIsStringReg(A)) {
          this.clearS(A[1]);
        } else {
          this.store(A, 0, false);
        }
        // OpClear sets the same flags for EVERY register type; leaving them
        // stale on the numeric path made a jz right after `clear I0` not
        // jump.
        f.carry = false;
        f.zero = true;
        f.sign = false;
        f.overflow = false;
        return;
      }

      case 'move': {
        // width coercion: a byte destination takes the low byte, a string
        // destination takes bytes. Reading a string source into a numeric
        // destination folds big-endian (Operand.GetValueData).
        const dstIsBytes =
          opIsStringReg(A) ||
          opIsRange(A[0]) ||
          B[0] === OpMode.IMM_STR ||
          opIsStringReg(B);
        if (dstIsBytes) {
          this.store(A, this.bytes(B), true);
          return;
        }
        const w = this.widthOf(A);
        const v = this.val(B, w);
        this.store(A, v);
        f.carry = false;
        f.overflow = false;
        this.updateFlags(v, w);
        return;
      }

      // ---- integer arithmetic. Carry is the unsigned overflow out of the
      // destination's width; Overflow is the signed one.
      case 'adds':
      case 'addc': {
        const w = this.widthOf(A);
        const x = this.val(A, w),
          y = this.val(B, w) + (name === 'addc' && f.carry ? 1 : 0);
        const sum = x + y;
        const lim = 2 ** (8 * w);
        f.carry = sum >= lim;
        this.setOverflow(x, y, sum, w);
        this.store(A, sum % lim);
        this.updateFlags(sum, w);
        return;
      }
      case 'subb':
      case 'subc': {
        const w = this.widthOf(A);
        const x = this.val(A, w),
          y = this.val(B, w) + (name === 'subc' && f.carry ? 1 : 0);
        const diff = x - y;
        f.carry = diff < 0;
        this.setOverflow(x, negateU32(y), diff, w);
        this.store(A, wrapToWidth(diff, w));
        this.updateFlags(diff, w);
        return;
      }
      case 'comp': {
        // Subtract without storing. Carry is the unsigned BORROW, and
        // Overflow follows SetOverflow(val0, (uint)(-val1), diff) -- the
        // subtrahend is negated in FULL 32-BIT two's complement and only
        // then masked to the width, which for w < 4 is NOT the same as
        // negating within the width. This decides `jc`/`jl`/`jg`, i.e.
        // every loop bound in the corpus, so it is copied literally.
        const w = this.widthOf(A);
        const x = this.val(A, w),
          y = this.val(B, w);
        const diff = x - y;
        f.carry = diff < 0;
        this.setOverflow(x, negateU32(y), diff, w);
        this.updateFlags(diff, w);
        return;
      }
      case 'mult': {
        // SIGNED narrow multiply, and it CLOBBERS arg1 with the high half
        // when arg1 is register-backed (OpMult). Missing the clobber left a
        // stride register holding a stale value, so FS_LESEN's fault-record
        // cursor advanced from the wrong base and every record read one
        // byte early.
        //
        // OpMult computes the product in 32-BIT integer arithmetic -- the
        // exact low 32 bits, wrapping -- never a 64-bit product. A plain JS
        // double multiply rounds past 2^53 and got the low word wrong for
        // large 32-bit operands; Math.imul is the exact wrap. The high half
        // is "(UInt64)result >> (len << 3)" of that 32-bit result, so it is
        // ZERO at width 4 (the engine's own comment: negative high halves
        // are not emulated).
        const w = this.widthOf(A);
        const lim = 2 ** (8 * w),
          half = lim / 2;
        const sx = (() => {
          const v = this.val(A, w);
          return v >= half ? v - lim : v;
        })();
        const sy = (() => {
          const v = this.val(B, w);
          return v >= half ? v - lim : v;
        })();
        const result = (w === 4 ? Math.imul(sx | 0, sy | 0) : sx * sy) >>> 0;
        this.store(A, result % lim);
        f.overflow = false;
        this.updateFlags(result, w);
        if (opIsNumReg(B)) {
          this.store(B, Math.floor(result / lim) % lim);
        }
        return;
      }
      case 'div':
      case 'divs': {
        // OpDivs does 32-BIT SIGNED division for EVERY width -- the narrow
        // native forms are commented out in the engine as "DIVS failure in
        // ediabas!" -- and it writes the REMAINDER back into arg1 when arg1
        // is register-backed. Dividing unsigned gave SMG2's hydraulic
        // pressure 42949660 where the engine says 65524: the dividend was
        // 0xFFFFFB38 = -1224, and -1224/100 = -12, which is 65524 as an
        // unsigned 16-bit result.
        const w = this.widthOf(A);
        const x = toInt32(this.val(A, w)),
          y = toInt32(this.val(B, w));
        if (y === 0) {
          // OpDivs on a zero divisor raises EDIABAS_BIP_0007 (which has no
          // mapped trap bit -> 0), KEEPS arg0's value, and still writes a
          // zero remainder. Yielding a silent 0 quotient turned a garbled
          // count byte into 0-valued results published as OKAY. The
          // trap-mask layer is not modeled (see generr), so trapping is
          // the conservative choice over aborting the job.
          this.trapBit = TRAP_UNMAPPED;
          f.overflow = false;
          this.updateFlags(0, w);
          if (opIsNumReg(B)) {
            this.store(B, 0);
          }
          return;
        }
        const q = Math.trunc(x / y),
          rem = x % y;
        const stored = wrapToWidth(q, w);
        this.store(A, stored);
        f.overflow = false;
        this.updateFlags(stored, w);
        if (opIsNumReg(B)) {
          this.store(B, wrapToWidth(rem, w));
        }
        return;
      }
      case 'mod': {
        const w = this.widthOf(A);
        const d = this.val(B);
        const r = d === 0 ? 0 : this.val(A) % d;
        this.store(A, r);
        this.updateFlags(r, w);
        return;
      }
      case 'and':
      case 'or':
      case 'xor': {
        const w = this.widthOf(A);
        const x = BigInt(this.val(A, w)),
          y = BigInt(this.val(B, w));
        const r = Number(
          name === 'and' ? x & y : name === 'or' ? x | y : x ^ y
        );
        this.store(A, r);
        this.updateFlags(r, w);
        return;
      }
      case 'not': {
        const w = this.widthOf(A);
        const lim = 2 ** (8 * w);
        const r = lim - 1 - this.val(A);
        this.store(A, r);
        this.updateFlags(r, w);
        return;
      }
      case 'asl':
      case 'lsl': {
        const w = this.widthOf(A);
        const n = this.val(B);
        const v = this.val(A, w);
        const r = v * 2 ** n;
        // carry is the LAST BIT SHIFTED OUT of the width, like the engine's
        // shift ops; untouched when the count is zero
        if (n > 0)
          f.carry = n <= 8 * w && Math.floor(v / 2 ** (8 * w - n)) % 2 === 1;
        this.store(A, r % 2 ** (8 * w));
        this.updateFlags(r, w);
        return;
      }
      case 'lsr':
      case 'asr': {
        // asr is ARITHMETIC: the sign bit (at the operand's width) shifts
        // back in. lsr shifts in zeros. Both report the last bit shifted
        // out in carry.
        const w = this.widthOf(A);
        const n = this.val(B);
        const lim = 2 ** (8 * w);
        const u = this.val(A, w); // bit pattern
        let v = u;
        if (name === 'asr' && v >= lim / 2) v -= lim; // signed view
        // the shifted-out bit is bit n-1 of the PATTERN, sign play or not
        if (n > 0 && n <= 8 * w) {
          f.carry = Math.floor(u / 2 ** (n - 1)) % 2 === 1;
        }
        const r = Math.floor(v / 2 ** n);
        this.store(A, wrapToWidth(r, w));
        this.updateFlags(r, w);
        return;
      }

      // ---- float
      case 'fix2flt':
      case 'ufix2flt': {
        // fix2flt SIGN-EXTENDS by the SOURCE operand's width (1/2/4 ->
        // SByte/Int16/Int32); ufix2flt does not. Skipping the sign made a
        // negative reading come out as its unsigned complement scaled --
        // SMG2's lateral acceleration read 4294942.72 where the engine
        // says -24.576, i.e. exactly (value - 2^32) * scale.
        const w = this.widthOf(B) || 4;
        let v = this.val(B, w);
        if (name === 'fix2flt') {
          const lim = 2 ** (8 * w);
          if (v >= lim / 2) v -= lim;
        }
        this.fregs.set(A[1], v);
        return;
      }
      case 'flt2fix': {
        const w = this.widthOf(A);
        const v = Math.trunc(this.getReg(B[1]));
        this.store(A, wrapToWidth(v, w));
        this.updateFlags(v, w);
        return;
      }
      case 'fadd':
      case 'fsub':
      case 'fmul':
      case 'fdiv': {
        const x = this.getReg(A[1]);
        const y = this.floatOf(B);
        let r = x;
        if (name === 'fadd') r = x + y;
        else if (name === 'fsub') r = x - y;
        else if (name === 'fmul') r = x * y;
        else {
          // OpFdiv divides regardless and stores what comes out; an
          // infinite or NaN quotient raises EDIABAS_BIP_0011 (trap bit 8).
          // Storing a silent 0 hid the division by zero entirely.
          r = x / y;
          if (!Number.isFinite(r)) this.trapBit = TRAP_FLOAT;
        }
        this.fregs.set(A[1], r);
        return;
      }
      case 'fcomp': {
        // comp for floats: subtract without storing. There is no width or
        // borrow arithmetic here -- zero/sign carry the ordering and
        // overflow stays clear, which is exactly what makes jl/jg/jle/jge
        // (sign vs overflow) and jc/jb (carry) all read as plain < and >.
        const x = this.floatOf(A),
          y = this.floatOf(B);
        f.zero = x === y;
        f.sign = x < y;
        f.carry = x < y;
        f.overflow = false;
        return;
      }
      case 'y42flt':
      case 'y82flt': {
        // 4/8 raw bytes -> IEEE float, LITTLE-endian: the corpus reverses
        // wire bytes with swap first (swap S1,0,4 / y42flt F5,S1[0]), so
        // the op itself reads host order.
        const n = name === 'y42flt' ? 4 : 8;
        const [m, a, b, c] = B;
        let src;
        if (opIsIndexed(m)) {
          const raw = this.getSraw(a);
          let i = m === OpMode.IDX_IMM ? b : this.getReg(b);
          if (m === OpMode.IDX_REG_IMM) i += c || 0;
          src = raw.slice(i, i + n);
        } else {
          src = Uint8Array.from(this.bytes(B)).slice(0, n);
        }
        const buf = new Uint8Array(n);
        buf.set(src.slice(0, n));
        const dv = new DataView(buf.buffer);
        this.fregs.set(
          A[1],
          n === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true)
        );
        return;
      }
      case 'flt2y4':
      case 'flt2y8': {
        const n = name === 'flt2y4' ? 4 : 8;
        const buf = new Uint8Array(n);
        const dv = new DataView(buf.buffer);
        const v = this.getReg(B[1]);
        if (n === 4) dv.setFloat32(0, v, true);
        else dv.setFloat64(0, v, true);
        this.store(A, buf, true);
        return;
      }
      case 'a2flt': {
        const txt = this.textOf(B);
        this.fregs.set(A[1], Best2Codec.parseNum(txt));
        return;
      }
      case 'a2fix': {
        // StringToValue, NOT a float parse: it understands 0x hex and 0y
        // binary. The `bits` tables hold masks as "0x01", and parseFloat
        // stops at the 'x' and yields 0 -- so every table-driven bit test
        // masked with 0 and reported the bit set.
        const w = this.widthOf(A);
        const txt = this.textOf(B);
        const v = Best2Codec.strToValue(txt);
        this.store(A, wrapToWidth(v, w));
        // a2fix forces Zero and Sign false regardless of the value
        f.zero = false;
        f.sign = false;
        f.overflow = false;
        return;
      }
      case 'flt2a': {
        this.storeText(
          A,
          Best2Codec.fltText(this.getReg(B[1]), this.floatPrecision)
        );
        return;
      }
      case 'setflt': {
        // set_float_precision (OpSetflt): significant digits for every
        // flt2a from here on. 1,333 uses in 102 modules: ms450ds0's
        // MESSWERTBLOCK_LESEN sets 9 right before formatting its values,
        // 947 uses set 6. A no-op here left every one at the default 4, so
        // 12.3456 read as 12.35 on the measurement blocks.
        this.floatPrecision = Math.max(1, this.val(A) >>> 0);
        return;
      }
      case 'cfgig':
      case 'cfgsg': {
        // get config integer / string (OpCfgig / OpCfgsg): the engine's
        // configuration, read by the SGBD. Only the keys the corpus asks
        // for are answered, the way the engine answers them, and any other
        // key leaves the register untouched (GetConfigProperty null):
        //   SIMULATION  "0"  (434 uses: "are we replaying a trace?")
        //   BipEcuFile  the SGBD file's stem (247 FS_LESEN templates)
        //   RetryComm   "1"
        // UserErrorHandling has no default in the engine and stays unset.
        const key = String(this.textOf(B) || '').toUpperCase();
        if (name === 'cfgig') {
          if (key === 'SIMULATION') this.store(A, 0);
          else if (key === 'RETRYCOMM') this.store(A, 1);
          return;
        }
        if (key === 'BIPECUFILE') {
          this.storeText(A, String((this.code && this.code.sgbd) || ''));
        } else if (key === 'SIMULATION') this.storeText(A, '0');
        else if (key === 'RETRYCOMM') this.storeText(A, '1');
        return;
      }
      case 'fix2a':
      case 'ufix2a': {
        this.storeText(A, String(this.val(B)));
        return;
      }
      case 'fix2dez':
      case 'ufix2dez': {
        // signed for fix2dez, unsigned for ufix2dez, width from the SOURCE
        const w = this.widthOf(B) || 1;
        let v = this.val(B);
        if (name === 'fix2dez') {
          const lim = 2 ** (8 * w);
          if (v >= lim / 2) v -= lim;
        }
        this.storeText(A, String(v));
        return;
      }

      // ---- byte/text conversions
      case 'fix2hex':
      case 'ufix2hex': {
        // EXACT format: "0x{0:X02}" / "0x{0:X04}" / "0x{0:X08}" by the
        // SOURCE operand's width -- prefix included, zero-padded, uppercase.
        // This is load-bearing, not cosmetic: JobResult's SB column holds
        // "0xA0", and the status lookup is `fix2hex S1,B0` / `tabseek "SB"`,
        // so dropping the prefix made every job's status miss and clamp to
        // the table's last row (ERROR_ECU_UNKNOWN_STATUSBYTE instead of OKAY).
        const w = this.widthOf(B) || 1;
        const digits = w >= 4 ? 8 : w === 2 ? 4 : 2;
        const v = this.val(B);
        const txt =
          '0x' + (v >>> 0).toString(16).toUpperCase().padStart(digits, '0');
        this.storeText(A, txt);
        return;
      }
      case 'y2hex': {
        let s = '';
        for (const x of this.bytes(B)) {
          s += x.toString(16).toUpperCase().padStart(2, '0');
        }
        this.storeText(A, s);
        return;
      }
      case 'y2bcd': {
        // a nibble above 9 is not a BCD digit: ValueToBcd prints '*'
        let s = '';
        for (const x of this.bytes(B)) {
          for (const n of [(x >> 4) & 0xf, x & 0xf]) {
            s += n <= 9 ? String(n) : '*';
          }
        }
        this.storeText(A, s);
        return;
      }
      case 'hex2y': {
        const txt = Best2Codec.cstr(this.bytes(B)).replace(/[^0-9A-Fa-f]/g, '');
        const out = new Uint8Array(Math.floor(txt.length / 2));
        for (let i = 0; i < out.length; i++) {
          out[i] = parseInt(txt.substr(i * 2, 2), 16);
        }
        this.store(A, out, true);
        return;
      }

      // ---- strings (byte buffers)
      case 'slen':
      case 'strlen': {
        const b = this.bytes(B);
        const n = name === 'strlen' ? Best2Codec.cstr(b).length : b.length;
        this.store(A, n);
        this.updateFlags(n, this.widthOf(A));
        return;
      }
      case 'scat':
      case 'strcat': {
        const x = this.bytes(A),
          y = this.bytes(B);
        const base =
          name === 'strcat' ? Best2Codec.strBytes(Best2Codec.cstr(x)) : x;
        const add =
          name === 'strcat' ? Best2Codec.strBytes(Best2Codec.cstr(y)) : y;
        const out = new Uint8Array(base.length + add.length);
        out.set(base);
        out.set(add, base.length);
        this.store(A, out, true);
        return;
      }
      case 'scut': {
        // KNOWN OPEN QUESTION (do not "fix" without engine evidence): this
        // counts on string registers carrying no trailing NUL, but
        // storeText (the store path for pars/tabget/flt2a/...) DOES count
        // its NUL in the logical length -- so scut directly after a
        // storeText keeps a NUL the engine would drop. No fixture in the
        // 3,730-result suite exercises that sequence; changing either side
        // blind risks the 100% agreement. Revisit with a captured trace of
        // a job doing scut-after-storeText.
        //
        // strcut removes the last `len` bytes -- and `len` COUNTS THE
        // TERMINATING NUL, which the register's logical length does not
        // include once SetStringData has stored it. So `scut S1,#1` on the
        // 2-byte "FP" removes only the (absent) terminator and leaves "FP"
        // intact; treating it as "drop the last byte" cut the P and broke
        // EWS's VIN check digit 200 instructions later.
        //
        // Concretely: the effective byte count removed is len-1, floored at
        // zero, because our string registers carry no trailing NUL of their
        // own (storeText appends one only for text results).
        const reg = A[1];
        const buf = this.getS(reg);
        const n = Math.max(0, this.val(B) - 1);
        this.setS(
          reg,
          n >= buf.length ? new Uint8Array(0) : buf.slice(0, buf.length - n)
        );
        return;
      }
      case 'spaste': {
        // INSERT (datainsert), shifting the tail right -- not an overwrite.
        // Inserting at or past the current logical end is a silent no-op.
        const reg = A[1];
        const idx = A[0] === OpMode.IDX_IMM ? A[2] : this.getReg(A[2]);
        const src = this.bytes(B);
        const buf = this.getS(reg);
        if (idx >= buf.length) return;
        const out = new Uint8Array(buf.length + src.length);
        out.set(buf.slice(0, idx), 0);
        out.set(src, idx);
        out.set(buf.slice(idx), idx + src.length);
        this.setS(reg, out);
        return;
      }
      case 'scmp': {
        // datacmp: byte-exact, and Zero means EQUAL (the normal sense)
        const x = this.bytes(A),
          y = this.bytes(B);
        f.zero = x.length === y.length && x.every((v, i) => v === y[i]);
        return;
      }
      case 'strcmp': {
        // INVERTED relative to scmp: OpStrcmp sets
        //   Zero = (String.Compare(a, b, Ordinal) != 0)
        // so ZERO MEANS THE STRINGS DIFFER. Getting this backwards made
        // every `strcmp S2,"BUSY" / jz done` status check read as "still
        // busy" on an OKAY response, so all 28 BMS46 jobs retried the
        // telegram until the step limit.
        const xs = Best2Codec.cstr(this.bytes(A));
        const ys = this.textOf(B);
        f.zero = xs !== ys;
        return;
      }
      case 'serase': {
        // delete `len` bytes at arg0's index, closing the gap (dataerase).
        // arg0 must be an indexed operand; the index names the position.
        const reg = A[1];
        const idx = A[0] === OpMode.IDX_IMM ? A[2] : this.getReg(A[2]);
        const n = this.val(B);
        const buf = this.getS(reg);
        // The gap is CLIPPED to the string: an erase at or past the end
        // removes nothing, and one that runs past the end removes only what
        // is there. Sizing the result as length-minus-count instead dropped
        // the surviving bytes whenever the range overhung -- FA.PRG's
        // `serase S4[1], 1` on a one-byte S4 emptied it, and the vehicle
        // order decode stopped at its third option with
        // ERROR_UNKNOWN_IDENTIFIER.
        const from = Math.max(0, Math.min(buf.length, idx));
        const to = Math.max(from, Math.min(buf.length, idx + Math.max(0, n)));
        const out = new Uint8Array(buf.length - (to - from));
        out.set(buf.subarray(0, from), 0);
        out.set(buf.subarray(to), from);
        this.setS(reg, out);
        return;
      }
      case 'srevrs': {
        const b = Uint8Array.from(this.bytes(A)).reverse();
        this.store(A, b, true);
        return;
      }
      case 'strim': {
        this.store(
          A,
          Best2Codec.strBytes(Best2Codec.cstr(this.bytes(A)).trim()),
          true
        );
        return;
      }
      case 'swap': {
        // ranged modes can hold a REGISTER NAME for index or length --
        // resolve them the way every other indexed op does, or a register-
        // backed range coerces to 0 and nothing is reversed
        const [m, reg, bIdx, cLen] = A;
        const idx = this.resolveIdx(m, bIdx ?? 0);
        const n = this.resolveLen(m, cLen ?? 0);
        const buf = Uint8Array.from(this.getS(reg));
        const part = buf.slice(idx, idx + n).reverse();
        buf.set(part, idx);
        this.setS(reg, buf);
        return;
      }
      case 'setspc': {
        // Sets the split parameters the NEXT stoken uses: arg0 is the
        // separator characters (a pool string like " " or ", "), arg1 the
        // 1-based token number.
        this.tokenSep = Best2Codec.cstr(this.bytes(A));
        this.tokenIdx = this.val(B);
        return;
      }
      case 'stoken': {
        // Token extraction: split arg1 by the setspc separators and store
        // the setspc-selected token into arg0. Zero flag reports "no such
        // token" -- the corpus idiom is `setspc " ",n / stoken S5,S7 / jz
        // fail`. Runs of separators collapse: the seps here are " " and
        // ", ", where keeping empty tokens would make every second token
        // blank.
        const src = Best2Codec.cstr(this.bytes(B));
        const seps = this.tokenSep || ' ';
        const parts = src
          .split(
            new RegExp(`[${seps.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}]+`)
          )
          .filter((t) => t !== '');
        const tok = this.tokenIdx >= 1 ? parts[this.tokenIdx - 1] : undefined;
        this.storeText(A, tok ?? '');
        f.zero = tok === undefined;
        return;
      }
      case 'test': {
        // non-destructive AND: flags only, arg0 is NOT written
        const w = this.widthOf(A);
        const r = Number(BigInt(this.val(A)) & BigInt(this.val(B)));
        f.overflow = false;
        this.updateFlags(r, w);
        return;
      }
      case 'setc':
        f.carry = true;
        return;
      case 'clrc':
        f.carry = false;
        return;
      case 'clrv':
        f.overflow = false;
        return;
      case 'sett':
        this.trapBit = this.val(A) || TRAP_USER;
        return;
      case 'ssize': {
        const n = this.bytes(A).length;
        this.store(B, n);
        return;
      }

      // ---- control flow
      case 'jump':
        if (A[1] === null) throw new VmError(`unresolved jump at ${pc}`);
        return A[1];
      case 'jt':
      case 'jnt': {
        // `jt target[, bit]`: with a bit selector, fire when the trap
        // register equals it (bit 32 aliases the unmapped bit 0); with no
        // selector, jt fires on ANY pending trap. jnt is the inverse --
        // except with no selector, where EDIABAS has a documented bug
        // (tests >= 0x40000000, so it effectively always jumps); that is
        // emulated deliberately, since SGBDs are compiled against it.
        let hit;
        if (B && B[0] !== OpMode.NONE) {
          const bit = this.val(B, 1);
          hit =
            bit > 0
              ? this.trapBit === bit ||
                (this.trapBit === TRAP_UNMAPPED &&
                  bit === TRAP_BIT_ALIAS_UNMAPPED)
              : this.trapBit >= TRAP_USER;
        } else {
          hit = name === 'jt' ? this.trapBit >= 0 : this.trapBit >= TRAP_USER;
        }
        if (name === 'jnt') hit = !hit;
        if (!hit) return;
        if (A[1] === null) throw new VmError(`unresolved jump at ${pc}`);
        return A[1];
      }
      case 'clrt':
        this.trapBit = TRAP_CLEAN;
        return;
      case 'jz':
      case 'jnz':
      case 'jc':
      case 'jnc':
      case 'jae':
      case 'jbe':
      case 'ja':
      case 'jb':
      case 'jmi':
      case 'jpl':
      case 'jv':
      case 'jnv':
      case 'jg':
      case 'jge':
      case 'jl':
      case 'jle': {
        const test = JUMP_TESTS[name];
        if (!test) throw new VmError(`no test for ${name}`);
        if (!test(f)) return;
        if (A[1] === null) throw new VmError(`unresolved jump at ${pc}`);
        return A[1];
      }

      // ---- results
      // Each erg* opcode has a FIXED width and signedness, independent of
      // the operand's own type (the reference's result table, ERG_SPECS):
      //   ergb  unsigned 8    ergc  SIGNED 8
      //   ergw  unsigned 16   ergi  SIGNED 16
      //   ergd  unsigned 32   ergl  SIGNED 32
      // Publishing ergi unsigned reported SMG2's coolant temperature as
      // 65531 where the engine says -5.
      //
      // The result NAME is arg0.GetStringData() (textOf): usually an
      // inline literal, but it can equally be a REGISTER -- MS420's VANOS
      // jobs name a result from a register still holding response bytes,
      // and the engine faithfully publishes the resulting garbage key.
      // Assuming a pool index dropped the name to the empty string.
      case 'ergb':
      case 'ergw':
      case 'ergd':
      case 'ergi':
      case 'ergl': {
        const [w, signed] = ERG_SPECS[name];
        let v = this.val(B, w) % 2 ** (8 * w);
        if (signed && v >= 2 ** (8 * w - 1)) v -= 2 ** (8 * w);
        this.emit(this.textOf(A), v);
        return;
      }
      case 'ergr': {
        // arg1 is GetFloatData(): a pool literal parses as a number rather
        // than falling through val()'s m===8 case, which returned 0.
        this.emit(this.textOf(A), this.floatOf(B));
        return;
      }
      case 'ergs': {
        const txt = this.textOf(B);
        this.emit(this.textOf(A), txt);
        return;
      }
      case 'ergy': {
        this.emit(this.textOf(A), Array.from(this.bytes(B)));
        return;
      }
      case 'ergc': {
        // SIGNED 8-bit, published as a NUMBER (TypeC), not a character
        let v = this.val(B, 1) & 0xff;
        if (v >= 0x80) v -= 0x100;
        this.emit(this.textOf(A), v);
        return;
      }
      case 'enewset':
        this.flush();
        return;
      case 'etag': {
        // `etag target, "NAME"` is a JUMP, not a flag test: if the caller
        // asked for a specific subset of results and NAME is not in it,
        // skip the block that computes it. An empty request set means
        // "everything is wanted", so the jump is never taken -- which is
        // why treating this as a flag left every result uncomputed.
        if (!this.wanted || this.wanted.size === 0) return;
        const nm = B ? this.textOf(B) : '';
        if (this.wanted.has(String(nm || '').toUpperCase())) return;
        if (A[1] === null) throw new VmError(`unresolved etag at ${pc}`);
        return A[1];
      }

      // ---- tables
      case 'tabset':
      case 'tabsetex': {
        // Table lookup is CASE-INSENSITIVE (TableNameDict is keyed on
        // ToUpper), and `tabsetex` names the table in arg0 with the SGBD
        // file in arg1 -- an empty file name keeps the current stream.
        //
        // The external file matters: every group SGBD in data/groups
        // reaches the variant assignment table with `tabsetex
        // "ZuordnungsTabelle", "t_grtb"` (or the Motorrad/UDS spelling),
        // and OpTabsetex (EdOperations.cs) opens THAT file's table stream
        // for a non-empty name -- a missing file is EDIABAS_SYS_0002 and a
        // missing table EDIABAS_BIP_0010, and neither falls back to the
        // current SGBD's tables. Both land in the trap register here
        // (SYS_0002 folded onto bit 10: this VM's trap model has no
        // system-error tier, and the observable effect -- the jz/jt guard
        // after the tabset fires -- is the same).
        const t = this.textOf(A);
        let rows;
        if (name === 'tabsetex') {
          const file = B ? this.textOf(B) : '';
          rows = file ? this.findExtTable(file, t) : this.findTable(t);
        } else {
          rows = this.findTable(t);
        }
        this.table = rows ? { name: t, rows, row: null } : null;
        // a missing table is EDIABAS_BIP_0010 (trap bit 10); a found one
        // must CLEAR the trap, or the SGBD's `jt err,#10` guard fires on a
        // perfectly good table
        f.zero = !rows;
        this.trapBit = rows ? TRAP_CLEAN : TRAP_TABLE;
        return;
      }
      case 'tabseek':
      case 'tabseeku': {
        if (!this.table) {
          f.zero = true;
          this.trapBit = TRAP_TABLE;
          return;
        }
        // arg0 is always the COLUMN NAME, arg1 the value being sought.
        // `tabseek` compares text case-INsensitively; `tabseeku` parses
        // each cell as a NUMBER (StringToValue: 0x hex, 0y binary, else
        // decimal) and compares numerically -- which is what makes
        // JobResult's "0x10" style status bytes match a numeric key.
        //
        // DELIBERATELY NO WILDCARD MATCHING, group tables included. The
        // ZuordnungsTabelle cells look like patterns ("32 .2M. 0550",
        // "00 ---- 0100"), but the engine's SeekTable (EdiabasNet.cs) is a
        // plain ToUpper dictionary -- first matching row, exact text -- and
        // the wildcard walk lives IN the group bytecode: d_0032's
        // IDENTIFIKATION writes the '.' characters into its seek key
        // itself (`move L0,#$2e / move S5[L1],B0` at 0x9d6/0xabb) when the
        // ident chars are in [0-9A-Z], so the key it seeks is byte-equal
        // to the cell it must hit. A wildcard-aware seek here would match
        // rows the engine never selects.
        const col = this.textOf(A);
        const keyOp = B || A;
        const numeric = name === 'tabseeku';
        const keyNum = numeric ? this.val(keyOp) : null;
        const keyTxt = numeric ? null : this.textOf(keyOp).toLowerCase();
        const hit = this.table.rows.find((r) => {
          const c = sgbdTableCell(r, col);
          if (c === undefined) return false;
          if (numeric) return Best2Codec.strToValue(String(c)) === keyNum;
          return String(c).toLowerCase() === keyTxt;
        });
        // A VALUE MISS IS NOT AN ERROR: SeekTable returns the LAST data row
        // and reports not-found, because SGBD tables conventionally put a
        // catch-all in the last row. Zero==true means "not found" (inverted
        // from the usual sense), which is the `tabseek / jz` idiom.
        this.table.row =
          hit || this.table.rows[this.table.rows.length - 1] || null;
        f.zero = !hit;
        return;
      }
      case 'tabget': {
        // Column name from a pool literal OR a register (lit() never
        // returns nullish, so `lit(B[1]) ?? ...` silently missed every
        // register-held name). Case-insensitive like tabseek.
        const col = this.textOf(B);
        const cell =
          this.table && this.table.row
            ? sgbdTableCell(this.table.row, col)
            : undefined;
        this.storeText(
          A,
          cell === undefined || cell === null ? '' : String(cell)
        );
        f.zero = cell === undefined || cell === null;
        return;
      }
      case 'tabrows': {
        // Rows + 1: the header row counts (GetTableRows + 1), while every
        // row INDEX is 0-based over data rows -- so this is not a loop bound
        this.store(A, this.table ? this.table.rows.length + 1 : 0);
        return;
      }
      case 'tabcols': {
        this.store(
          A,
          this.table && this.table.rows[0]
            ? Object.keys(this.table.rows[0]).length
            : 0
        );
        return;
      }
      case 'tabline': {
        // ONE operand, the row index (OpTabline reads arg0; the opcode has
        // no second operand anywhere in the corpus). Reading B here made
        // every tabline throw on an undefined operand, which surfaced as
        // "op is not iterable" on the DSC MK60's FS_LESEN_DETAIL and would
        // have on the 501 other modules whose jobs use it.
        // 0-based over DATA rows; an out-of-range index clamps to the last
        // row and reports Zero=true (GetTableLine), it does not fail
        const i = this.val(A);
        if (!this.table) {
          f.zero = true;
          return;
        }
        const inRange = i >= 0 && i < this.table.rows.length;
        this.table.row = inRange
          ? this.table.rows[i]
          : this.table.rows[this.table.rows.length - 1] || null;
        f.zero = !inRange;
        return;
      }

      // ---- job arguments. ZERO IS THE PRESENCE FLAG, not "value == 0":
      // par* set Zero=true and only clear it when the requested parameter
      // exists and is non-empty. Indices are 1-BASED and the decrement is
      // unsigned, so index 0 underflows and always misses. Without these
      // flags a job that guards on `pars / jz` ran its with-arguments path
      // on no arguments and exited before emitting anything.
      case 'pars': {
        const parts = this.args();
        const i = this.val(B) - 1;
        f.zero = true;
        let txt = '';
        if (i >= 0 && i < parts.length && parts[i] !== '') {
          txt = parts[i];
          f.zero = false;
        }
        this.storeText(A, txt);
        return;
      }
      case 'parb':
      case 'parw':
      case 'parl':
      case 'pard':
      case 'pari': {
        const parts = this.args();
        const i = this.val(B) - 1;
        f.zero = true;
        f.carry = false;
        f.sign = false;
        f.overflow = false;
        let v = 0;
        if (i >= 0 && i < parts.length && parts[i] !== '') {
          v = Best2Codec.strToValue(parts[i]);
          f.zero = false;
        }
        this.store(A, v);
        return;
      }
      case 'parr': {
        const parts = this.args();
        const i = this.val(B) - 1;
        f.zero = true;
        f.carry = false;
        f.sign = false;
        f.overflow = false;
        let v = 0;
        if (i >= 0 && i < parts.length && parts[i] !== '') {
          v = Best2Codec.parseNum(parts[i]);
          f.zero = false;
        }
        this.fregs.set(A[1], v);
        return;
      }
      case 'parn': {
        const n = this.args().length;
        this.store(A, n);
        f.overflow = false;
        this.updateFlags(this.val(A), this.widthOf(A));
        return;
      }
      case 'pary': {
        // the WHOLE binary argument blob -- no index, no splitting
        f.zero = this.argBytes.length === 0;
        this.store(A, this.argBytes, true);
        return;
      }

      // ---- telegrams
      case 'xsend':
      case 'xsendf':
      case 'xsendr':
      case 'xsendex':
      case 'xrequf':
      case 'xraw': {
        // arg0 names the register that RECEIVES the answer; the request is
        // the second operand where present, else arg0's current contents.
        const req = B ? this.bytes(B) : this.bytes(A);
        // THE WRITE GUARD. This is the only point where bytes leave the VM,
        // so it is the only place the check has to exist. A job whose name
        // says it CHANGES the ECU refuses to transmit unless the caller
        // opted in -- the failure happens before the bytes reach the cable
        // rather than after. Simulation and fixtures are unaffected: they
        // pass allowWrites, because writing into a .sim file harms nothing.
        if (this.writeJob && !this.allowWrites) {
          throw new VmError(
            `refusing to transmit for write job ${this.jobName}: ` +
              'construct the VM with {allowWrites: true} to permit it'
          );
        }
        // The wire parameters ride along: the transport needs the concept
        // to frame, checksum and pace this exchange. Callers that replay
        // captured answers just ignore the second argument. A `wait` since
        // the last exchange becomes waitMs, honored before the write.
        let comm = this.comm;
        if (this.pendingWaitMs) {
          comm = { ...(comm || {}), waitMs: this.pendingWaitMs };
          this.pendingWaitMs = 0;
        }
        const ans = this.send(Array.from(req), comm) || [];
        if (ans.length > this.arraySize) {
          // An answer that exceeds the register capacity must not be
          // half-stored: setS would refuse the write and the job would
          // decode its own request bytes -- still sitting in the register --
          // as the ECU's response. Fail loudly instead.
          throw new VmError(
            `answer of ${ans.length} bytes exceeds the ` +
              `job's array size (${this.arraySize})`
          );
        }
        this.answer = Uint8Array.from(ans);
        this.store(A, this.answer, true);
        f.zero = this.answer.length === 0;
        return;
      }

      // ---- environment / no-ops for decode purposes. These affect timing,
      // tracing or interface configuration, none of which changes a decoded
      // value, so they are accepted and ignored rather than aborting a job.
      //
      // Process-wide shared data. `shmset key, value` (arg0 is the KEY,
      // arg1 the value); `shmget dest, key` (arg0 is the DEST). Keys are
      // uppercased, values persist across jobs in a session -- which is how
      // MS450 hands its AIF block from one job to the next, using a key
      // that is literally a single NUL byte.
      case 'shmset': {
        this.shared.set(this.shmKey(A), Uint8Array.from(this.bytes(B)));
        return;
      }
      case 'shmget': {
        // CARRY IS THE MISS INDICATOR (true = key absent); the destination
        // gets an empty array.
        const hit = this.shared.get(this.shmKey(B));
        f.carry = !hit;
        this.store(A, hit || new Uint8Array(0), true);
        return;
      }
      case 'xsetpar': {
        // CommParameter: the SGBD tells the interface handler how to drive
        // the wire. The blob DECLARES its own element width in byte 1
        // (EdOperations.OpXsetpar): 0x00 = 16-bit words, 0x01 = 32-bit
        // dwords, 0xFF = bytes; anything else is not a CommParameter. That
        // replaces the old "a dword parse gives an absurd concept" guess.
        //
        // The VM does not touch the port; it surfaces {concept, baud,
        // timeout, ...} to send(), which owns framing and the wire.
        const raw = Array.from(this.bytes(A));
        const width = raw.length >= 2 ? COMM_PARAM_WIDTHS[raw[1]] || 0 : 0;
        let words = [];
        if (width && raw.length % width === 0) {
          for (let i = 0; i + width - 1 < raw.length; i += width) {
            words.push(Best2Codec.leValue(raw, i, width));
          }
        }
        if (words.length >= 2 && words[0] > 0 && words[0] <= COMM_CONCEPT_MAX) {
          this.comm = Best2Codec.decodeCommParams(words);
          if (this.answerLen) this.comm.answerLen = this.answerLen;
          if (this.repeats !== undefined) this.comm.repeats = this.repeats;
        }
        return;
      }
      case 'a2y': {
        // ASCII hex -> bytes: "AB0102" (separators tolerated) into a byte
        // array. Carry reports a character that is not hex -- conversion
        // stops there, keeping the bytes parsed so far.
        const txt = Best2Codec.cstr(this.bytes(B)).trim();
        const clean = txt.replace(/^0x/i, '');
        const out = [];
        let bad = false;
        for (let i = 0; i < clean.length;) {
          if (/[\s,;:]/.test(clean[i])) {
            i += 1;
            continue;
          }
          const pair = clean.slice(i, i + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
            bad = true;
            break;
          }
          out.push(parseInt(pair, 16));
          i += 2;
        }
        this.store(A, Uint8Array.from(out), true);
        f.carry = bad;
        f.zero = out.length === 0;
        return;
      }
      case 'eerr': {
        // The corpus idiom is `sett n / eerr` inside flash and
        // authentication jobs. The engine's exact behavior is not
        // recoverable from this repo, so raise the trapped error loudly --
        // a clean failure beats a silently-continued flash guard. If a
        // replay ever shows eerr on a passing path, the differential test
        // will flag this and it gets refined.
        throw new VmError(`SGBD raised error via eerr (trap ${this.trapBit})`);
      }
      case 'xtype': {
        // Interface type name. EdInterfaceObd reports "OBD" for the K+DCAN
        // cable this app drives; SGBDs (carb) branch on it to pick their
        // concept.
        this.store(A, Best2Codec.strBytes(INTERFACE_TYPE), true);
        return;
      }
      case 'xvers': {
        // EdInterfaceObd.InterfaceVersion: 209 (0xD1). Not the engine's
        // 7.3.0 -- the INTERFACE's version, which is what the SGBD asks.
        this.store(A, INTERFACE_VERSION);
        return;
      }
      case 'settmr': {
        // set_trap_mask: bits of errors the SGBD chooses to handle itself
        // (EdOperations.OpSettmr / EdiabasNet.SetError: an error whose bit
        // is masked does not abort the job; the SGBD reads it back with
        // `trap`/`gettmr`). This is NOT a timer.
        this.trapMask = this.val(A) >>> 0;
        return;
      }
      case 'gettmr': {
        this.store(A, this.trapMask >>> 0);
        return;
      }
      case 'ticks': {
        // milliseconds of wall clock (EdOperations.OpTicks: Ticks / 10000)
        this.store(A, (this.now ? this.now.getTime() : Date.now()) >>> 0);
        return;
      }
      case 'date': {
        // dd.MM.yyyy text, the German convention AIF date fields expect.
        // this.now (when the caller set one) keeps the bytes identical
        // across webshim's replay passes -- see the constructor.
        const d = this.now || new Date();
        this.storeText(
          A,
          `${twoDigits(d.getDate())}.${twoDigits(d.getMonth() + 1)}.${d.getFullYear()}`
        );
        return;
      }
      case 'time': {
        const d = this.now || new Date();
        this.storeText(
          A,
          `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}:${twoDigits(d.getSeconds())}`
        );
        return;
      }
      case 'wait': {
        // The VM is synchronous, so it cannot sleep -- but the TRANSPORT
        // can. Accumulate the requested pause and hand it to the next
        // exchange via comm, where runExchange honors it before writing.
        // Pacing-sensitive sequences (reset-then-reident, adaptation
        // clears) stop firing back-to-back on a real wire.
        //
        // BEST/2 `wait` is in SECONDS: EdOperations.OpWait sleeps
        // arg * 1000 ms. Treating it as milliseconds retried the MS45
        // authentisierung_start key ~1 s too early -- the DME was still
        // busy, answered nothing, and the retransmit collided with the
        // late answer into an IFH-0003 cascade. `waitex` is the ms variant.
        this.pendingWaitMs =
          (this.pendingWaitMs || 0) + this.val(A) * MS_PER_SECOND;
        return;
      }
      case 'waitex': {
        // BEST/2 `waitex`: the same pause in MILLISECONDS (OpWaitex).
        this.pendingWaitMs = (this.pendingWaitMs || 0) + this.val(A);
        return;
      }
      case 'generr': {
        // Deliberately raise an EDIABAS error. Modeled like sett: the
        // error lands in the trap register where jt/jnt can test it, which
        // is the trappable half of the engine's behavior. (The engine also
        // terminates when the error is unmasked; the trap-mask layer is
        // not decoded, so trapping is the conservative choice -- a job
        // that meant to die still takes its error path via jt.)
        this.trapBit = this.val(A) || TRAP_USER;
        return;
      }
      case 'fopen': {
        // SGBDs open runtime scratch files (ALC_60: c:/ediabas/ecu/
        // cod_lm.dat -- a coding session's leftovers, absent even on a
        // fresh real install). No virtual filesystem is provided, so every
        // open MISSES with honest flags rather than leaving stale
        // registers: handle 0, zero = failure -- the state a real engine
        // reports on a clean machine, and what the jobs' own jz guards
        // expect to handle.
        this.store(A, 0);
        f.zero = true;
        f.carry = true;
        return;
      }
      case 'freadln':
      case 'fread': {
        // nothing is ever open (see fopen): empty read, zero = at end
        this.store(A, new Uint8Array(0), true);
        f.zero = true;
        f.carry = true;
        return;
      }
      case 'xawlen': {
        // set_answer_length (EdOperations.OpXawlen): int16 pairs. For DS2 the
        // interface derives the answer's total length from it
        // (EdInterfaceObd.TelLengthDs2): [n>0] fixed n bytes; [-o, k] = the
        // byte at offset o plus k. zke5/lws5 say [-1, 0]; ms450ds0 [-3, 5].
        // Carried on comm so the transport reads the SGBD's rule, not a
        // guessed "length is byte 1".
        const raw = Array.from(this.bytes(A));
        const al = [];
        for (let i = 0; i + 1 < raw.length; i += 2) {
          const v = raw[i] | (raw[i + 1] << 8);
          al.push(v & 0x8000 ? v - 0x10000 : v);
        }
        this.answerLen = al;
        this.comm = Object.assign({}, this.comm || {}, { answerLen: al });
        return;
      }
      case 'xreps': {
        // set_repeat_counter (EdOperations.OpXreps): how many times the
        // interface RESENDS a telegram that got no usable answer before it
        // reports the error -- CommRepeats, read by the reference's send
        // loop (EdInterfaceObd.ObdTrans: repeats + 1 attempts, stopping
        // early only on a cable-level IFH-0003). Every init job sets it
        // (775 of 1,006 modules say 2, the EWS says 4); the default of 0
        // holds only until INITIALISIERUNG runs. Ignoring it sent every
        // telegram once, so a K-line module that sleeps through its first
        // wake-up (the EWS, on three testers' cars) failed with IFH-0009
        // where the tool's second attempt is answered. Carried on comm so
        // runExchange reads the SGBD's own count.
        const n = this.val(A) >>> 0;
        this.repeats = n;
        this.comm = Object.assign({}, this.comm || {}, { repeats: n });
        return;
      }
      case 'xconnect':
      case 'xhangup':
      case 'xstopf':
      case 'xkeyb':
      case 'xkeybytes':
      case 'xprog':
      case 'xreset':
      case 'clrflt':
      case 'cfgss':
      case 'trap':
      case 'plink':
      case 'pjob':
      case 'pexec':
      case 'fclose':
      case 'fseekln':
      case 'fwrite':
      case 'ergsysi':
      case 'iupdate':
      case 'realf':
        // ergsysi stays a no-op ON PURPOSE: it publishes into result set 0,
        // which this VM deliberately never synthesizes (the engine injects
        // set 0; see SYSTEM_RESULTS in test_bestvm.js).
        return;

      default:
        // Silence is how a VM produces wrong answers. An unknown opcode
        // throws, the differential test catches it, and the gap gets
        // implemented instead of guessed.
        throw new VmError(`unimplemented opcode ${name} at ${pc}`);
    }
  },
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    JUMP_TESTS,
    ERG_SPECS,
    FLAG_CARRY,
    FLAG_ZERO,
    FLAG_SIGN,
    FLAG_OVERFLOW,
    TRAP_BIT_ALIAS_UNMAPPED,
    INTERFACE_TYPE,
    INTERFACE_VERSION,
    COMM_PARAM_WIDTHS,
    COMM_CONCEPT_MAX,
    MS_PER_SECOND,
    wrapToWidth,
    negateU32,
    toInt32,
    twoDigits,
  };
}
