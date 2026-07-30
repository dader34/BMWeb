// BEST2 virtual machine: EXECUTE ECU job programs in the browser.
//
// The lifted specs (specwalk.js) summarise what a job does; this runs it.
// That difference is the whole point: summarising tops out near 71% of
// results because the tail is structural -- layouts chosen by a branch,
// multi-telegram streaming, strings assembled a byte at a time in a loop.
// INPA is flawless because EDIABAS executes; so do we.
//
// Input is tools/sgbd_code.py output: one ops array per SGBD, jump operands
// already rewritten to ops indices. Telegram I/O is a callback, so the same
// VM runs against a live cable, a captured .sim, or a synthetic fixture.
//
// Semantics are ported from the vendored EdiabasLib (EdOperations.cs,
// EdiabasNet.cs) -- the same engine tools/sgbd_bulk_verify.py diffs against,
// so every claim here is checkable and tools/test_bestvm.js checks it.
//
// THE REGISTER MODEL, which nothing else in this file makes sense without:
// B/I/L/A are VIEWS over one 32-byte array, LITTLE-endian within a view
// (Register.GetValueData: reg[off] + reg[off+1]<<8 + ...), so writing B0
// changes what L0 reads. S registers are separate byte buffers (telegrams
// and text alike -- raw bytes that may contain NULs). F are doubles.

// The register file is 32 bytes, overlaid THREE ways (EdiabasNet
// RegisterList): B0..BF = bytes 0..15 and A0..AF = bytes 16..31; I0..I7
// pair over the B range and I8..IF over the A range; L0..L3 quad over B
// and L4..L7 over A. So L1 IS bytes 4..7 IS I2+I3 IS B4..B7.
const REG_BYTES = 32;

class VmError extends Error {}

// Which flag combination each conditional jump tests (EdOperations' jump
// handlers). Named exactly as the disassembler emits them.
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
  jg: (f) => !f.zero && (f.sign === f.overflow),
  jge: (f) => f.sign === f.overflow,
  jl: (f) => f.sign !== f.overflow,
  jle: (f) => f.zero || (f.sign !== f.overflow),
  jt: (f) => f.tested,
  jnt: (f) => !f.tested,
};

class Best2Vm {
  // code    parsed sgbd JSON from tools/sgbd_code.py
  // opts.send(bytes) -> Uint8Array|number[]   the ECU exchange
  // opts.tables {NAME: [row, ...]}            SGBD tables
  // opts.args string                          job arguments, ';' separated
  constructor(code, opts = {}) {
    this.code = code;
    this.send = opts.send || (() => { throw new VmError('no telegram sink'); });
    this.tables = opts.tables || {};
    this.argText = opts.args || '';
    this.maxSteps = opts.maxSteps || 2_000_000;
  }

  reset() {
    this.regBuf = new Uint8Array(REG_BYTES);
    this.sregs = new Map();            // name -> Uint8Array
    this.fregs = new Map();            // name -> number
    this.stack = [];                   // BYTE stack (push writes N bytes)
    this.flags = { zero: false, sign: false, carry: false,
                   overflow: false, tested: false };
    this.results = [];                 // completed result sets
    this.cur = new Map();              // set being built
    this.wanted = null;                // etag filter, null = everything
    this.table = null;                 // {rows, cols, row}
    this.answer = new Uint8Array(0);
    this.steps = 0;
  }

  // ---- register access ------------------------------------------------
  static regSpan(name) {
    const kind = name[0];
    const idx = parseInt(name.slice(1), 16);
    if (!Number.isFinite(idx)) return null;
    // A registers are byte registers at index+16, NOT a wider type
    if (kind === 'B') return [idx, 1];
    if (kind === 'A') return [16 + idx, 1];
    if (kind === 'I') return [idx * 2, 2];
    if (kind === 'L') return [idx * 4, 4];
    return null;
  }

  getReg(name) {
    if (name[0] === 'F') return this.fregs.get(name) || 0;
    if (name[0] === 'S') return this.getS(name);
    const span = Best2Vm.regSpan(name);
    if (!span) throw new VmError(`unknown register ${name}`);
    // LITTLE-endian within the view: byte 0 is the LOW byte
    // (Register.GetValueData -- reg[off] + reg[off+1]<<8 + ...). Reading
    // these big-endian made `move B0,x` show up as x*256 in I0, so a
    // one-byte flag published as 256.
    let v = 0;
    for (let i = span[1] - 1; i >= 0; i--) v = v * 256 + this.regBuf[span[0] + i];
    return v;
  }

  setReg(name, value) {
    if (name[0] === 'F') { this.fregs.set(name, value); return; }
    if (name[0] === 'S') { this.setS(name, value); return; }
    const span = Best2Vm.regSpan(name);
    if (!span) throw new VmError(`unknown register ${name}`);
    let v = Math.trunc(Number(value));
    if (v < 0) v += 2 ** (8 * span[1]);          // two's complement in-width
    for (let i = 0; i < span[1]; i++) {          // low byte first
      this.regBuf[span[0] + i] = v & 0xff;
      v = Math.floor(v / 256);
    }
  }

  getS(name) {
    if (!this.sregs.has(name)) this.sregs.set(name, new Uint8Array(0));
    return this.sregs.get(name);
  }

  setS(name, bytes) {
    this.sregs.set(name, bytes instanceof Uint8Array
      ? bytes : Uint8Array.from(bytes || []));
  }

  // ---- operands -------------------------------------------------------
  // [mode, ...payload] as emitted by sgbd_code.py
  resolveIdx(mode, a) {
    // ranged/indexed modes name either an immediate index or a register
    if (mode === 9 || mode === 12 || mode === 13) return a;         // imm
    return this.getReg(a);                                           // reg
  }

  resolveLen(mode, a) {
    if (mode === 12 || mode === 14) return a;                        // imm
    return this.getReg(a);
  }

  // Numeric read. `width` is the DESTINATION's width, and for byte-array
  // sources it decides how many bytes are folded -- Operand.GetValueData
  // takes dataLen from the caller and assembles that many bytes
  // LITTLE-endian, zero-padding when the slice is short.
  //
  // This matters far beyond arithmetic: `move I2, S2[B2]` reads TWO bytes
  // of the response into I2. Reading one byte made every response-length
  // guard of the form `move I2,S2[B2] / and / comp I5,I4` compare the wrong
  // number, so jobs reported ERROR_ECU_INCORRECT_LEN and emitted nothing.
  val(op, width) {
    const [m, a, b, c] = op;
    if (m >= 5 && m <= 7) return a;
    if (m === 8) return 0;                     // a string literal as number
    if (m >= 1 && m <= 4) {
      if (a[0] === 'S') {
        const buf = this.getS(a);
        const n = width || buf.length;
        let v = 0;
        for (let i = n - 1; i >= 0; i--) v = v * 256 + (buf[i] || 0);
        return v;
      }
      return this.getReg(a);
    }
    if (m === 9 || m === 10 || m === 11) {
      const buf = this.getS(a);
      let i = m === 9 ? b : this.getReg(b);
      if (m === 11) i += c || 0;
      const n = width || 1;
      let v = 0;
      for (let k = n - 1; k >= 0; k--) v = v * 256 + (buf[i + k] || 0);
      return v;
    }
    if (m >= 12 && m <= 15) {
      const buf = this.bytes(op);
      const n = width || buf.length;
      let v = 0;
      for (let i = n - 1; i >= 0; i--) v = v * 256 + (buf[i] || 0);
      return v;
    }
    throw new VmError(`operand mode ${m} as value`);
  }

  // byte-array read (string registers, ranges, literals)
  bytes(op) {
    const [m, a, b, c] = op;
    if (m === 8) return Best2Vm.strBytes(this.code.strings[a] ?? '');
    if (m >= 1 && m <= 4) {
      if (a[0] === 'S') return this.getS(a);
      const span = Best2Vm.regSpan(a);
      return this.regBuf.slice(span[0], span[0] + span[1]);
    }
    if (m === 9 || m === 10) {
      const buf = this.getS(a);
      const i = m === 9 ? b : this.getReg(b);
      return i < buf.length ? buf.slice(i, i + 1) : new Uint8Array(0);
    }
    if (m >= 12 && m <= 15) {
      const buf = this.getS(a);
      const i = this.resolveIdx(m, b);
      const n = this.resolveLen(m, c);
      // reads past the current length yield what exists, not an error --
      // the engine's Operand does the same, and jobs rely on it
      return buf.slice(i, i + Math.max(0, n));
    }
    if (m >= 5 && m <= 7) {
      return Uint8Array.from([a & 0xff]);
    }
    throw new VmError(`operand mode ${m} as bytes`);
  }

  // write back
  store(op, value, asBytes) {
    const [m, a, b, c] = op;
    if (m >= 1 && m <= 4) {
      if (asBytes) {
        if (a[0] === 'S') { this.setS(a, value); return; }
        const span = Best2Vm.regSpan(a);
        for (let i = 0; i < span[1]; i++) {
          this.regBuf[span[0] + i] = i < value.length ? value[i] : 0;
        }
        return;
      }
      this.setReg(a, value);
      return;
    }
    if (m === 9 || m === 10) {
      const i = m === 9 ? b : this.getReg(b);
      const buf = this.getS(a);
      const need = i + 1;
      const grown = buf.length >= need ? buf : (() => {
        const g = new Uint8Array(need);
        g.set(buf);
        return g;
      })();
      grown[i] = asBytes ? (value[0] || 0) : (Number(value) & 0xff);
      this.setS(a, grown);
      return;
    }
    if (m >= 12 && m <= 15) {
      const i = this.resolveIdx(m, b);
      const n = this.resolveLen(m, c);
      const src = asBytes ? value : Uint8Array.from([Number(value) & 0xff]);
      const buf = this.getS(a);
      const end = i + Math.max(0, n);
      const grown = new Uint8Array(Math.max(buf.length, end));
      grown.set(buf);
      for (let k = 0; k < n; k++) grown[i + k] = k < src.length ? src[k] : 0;
      this.setS(a, grown);
      return;
    }
    throw new VmError(`operand mode ${m} as destination`);
  }

  static strBytes(s) {
    return Best2Vm.strBytesCp1252(String(s ?? ''));
  }

  // CP1252, the engine's ambient Encoding -- NOT latin-1. Bytes 0x80..0x9F
  // are printable there (0x96 is an en dash), and decoding them as latin-1
  // control characters turned "LLR - Solldrehzahl" into a C1 escape.
  static CP1252_HIGH = [
    0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
    0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];

  static bytesStr(b) {
    let s = '';
    for (const x of b) {
      s += String.fromCharCode(x >= 0x80 && x <= 0x9F
        ? Best2Vm.CP1252_HIGH[x - 0x80] : x);
    }
    return s;
  }

  // ...and the inverse, for text written back into a byte buffer
  static strBytesCp1252(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c <= 0xff) { out[i] = c; continue; }
      const k = Best2Vm.CP1252_HIGH.indexOf(c);
      out[i] = k >= 0 ? 0x80 + k : 0x3f;
    }
    return out;
  }

  // NUL-terminated text, the way result strings are published
  static cstr(b) {
    const z = b.indexOf(0);
    return Best2Vm.bytesStr(z < 0 ? b : b.slice(0, z));
  }

  // Flags.SetOverflow: only when the operands SHARE a sign that differs
  // from the result's. Operands are compared at the operation width.
  setOverflow(v1, v2, result, width) {
    const sm = 2 ** (8 * width - 1);
    const s1 = (v1 & sm) !== 0, s2 = (v2 & sm) !== 0;
    const sr = (((result % 2 ** (8 * width)) + 2 ** (8 * width))
      % 2 ** (8 * width) & sm) !== 0;
    this.flags.overflow = s1 === s2 && s1 !== sr;
  }

  // ---- flags ----------------------------------------------------------
  updateFlags(value, width) {
    const bits = 8 * width;
    const masked = ((value % 2 ** bits) + 2 ** bits) % 2 ** bits;
    this.flags.zero = masked === 0;
    this.flags.sign = masked >= 2 ** (bits - 1);
  }

  // ---- the loop -------------------------------------------------------
  run(jobName, args) {
    const entry = this.code.jobs[jobName] ?? this.code.jobs[jobName?.toUpperCase()];
    if (entry === undefined) throw new VmError(`no job ${jobName}`);
    this.reset();
    if (args !== undefined) this.argText = args;
    this.argBytes = Best2Vm.strBytes(this.argText);
    this._args = undefined;
    let pc = entry;
    const ops = this.code.ops;
    while (pc >= 0 && pc < ops.length) {
      if (++this.steps > this.maxSteps) {
        throw new VmError(`step limit at op ${pc}`);
      }
      const [name, a] = ops[pc];
      const next = this.step(name, a, pc);
      if (next === STOP) break;
      pc = next === undefined ? pc + 1 : next;
    }
    this.flush();
    return this.results;
  }

  flush() {
    if (this.cur.size) {
      this.results.push(Object.fromEntries(this.cur));
      this.cur = new Map();
    }
  }

  // Job arguments split on ';'. An EMPTY argument string is ZERO
  // parameters (GetActiveArgStrings only splits when length > 0), not one
  // empty string -- otherwise `parn` reports 1 and every arg guard inverts.
  args() {
    if (this._args === undefined) {
      this._args = this.argText.length > 0 ? this.argText.split(';') : [];
    }
    return this._args;
  }

  // Case-insensitive table lookup, with the exact name preferred.
  findTable(name) {
    if (!name) return null;
    if (this.tables[name]) return this.tables[name];
    const want = String(name).toUpperCase();
    if (!this._tabIndex) {
      this._tabIndex = new Map();
      for (const k of Object.keys(this.tables)) {
        this._tabIndex.set(k.toUpperCase(), this.tables[k]);
      }
    }
    return this._tabIndex.get(want) || null;
  }

  // Publish a result unless an `etag` said the caller does not want it.
  emit(name, value) {
    if (this.wanted && !this.wanted.has(name.toUpperCase())
        && !name.startsWith('JOB_')) {
      return;
    }
    this.cur.set(name, value);
  }

  // THE width rule: GetArgsValueLength returns arg0.GetDataLen(TRUE) and
  // ignores arg1 entirely, so every arithmetic/move width comes from the
  // DESTINATION in write mode. write=true is what makes a plain indexed
  // destination (S0[i]) exactly one byte wide.
  widthOf(op) {
    const m = op[0];
    if (m >= 1 && m <= 4) {
      const r = op[1];
      if (r[0] === 'S') return this.getS(r).length;
      const span = Best2Vm.regSpan(r);
      return span ? span[1] : 4;
    }
    if (m === 5) return 1;
    if (m === 6) return 2;
    if (m === 7) return 4;
    if (m === 8) return this.bytes(op).length;
    if (m === 9 || m === 10 || m === 11) return 1;   // write mode
    if (m >= 12 && m <= 15) return this.bytes(op).length;
    return 0;
  }

  step(name, a, pc) {
    const A = a[0], B = a[1];
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
        if (A[0] >= 5 && A[0] <= 7) {
          // an immediate pushes 4 bytes (EdValueType width)
          for (let i = 0; i < 4; i++) { this.stack.push(v & 0xff); v = Math.floor(v / 256); }
          return;
        }
        for (let i = 0; i < w; i++) { this.stack.push(v & 0xff); v = Math.floor(v / 256); }
        return;
      }
      case 'pop': {
        // push wrote LSB first, so the MSB is on top: popping MSB-first and
        // shifting left reassembles exactly what was pushed.
        const w = this.widthOf(A);
        if (this.stack.length < w) { this.store(A, 0); this.updateFlags(0, w); return; }
        let v = 0;
        for (let i = 0; i < w; i++) v = v * 256 + this.stack.pop();
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
        if (this.stack.length < w || pos < w) { this.store(A, 0); return; }
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
        let v = (f.carry ? 1 : 0) | (f.zero ? 2 : 0)
          | (f.sign ? 4 : 0) | (f.overflow ? 8 : 0);
        for (let i = 0; i < 4; i++) { this.stack.push(v & 0xff); v >>= 8; }
        return;
      }
      case 'popf': {
        let v = 0;
        if (this.stack.length >= 4) {
          for (let i = 0; i < 4; i++) v = v * 256 + this.stack.pop();
        }
        f.carry = !!(v & 1); f.zero = !!(v & 2);
        f.sign = !!(v & 4); f.overflow = !!(v & 8);
        return;
      }

      case 'clear': {
        if (A[0] >= 1 && A[0] <= 4 && A[1][0] === 'S') { this.setS(A[1], new Uint8Array(0)); return; }
        this.store(A, 0, false);
        return;
      }

      case 'move': {
        // width coercion: a byte destination takes the low byte, a string
        // destination takes bytes. Reading a string source into a numeric
        // destination folds big-endian (Operand.GetValueData).
        const dstIsBytes = (A[0] >= 1 && A[0] <= 4 && A[1][0] === 'S')
          || A[0] >= 12 || B[0] === 8
          || (B[0] >= 1 && B[0] <= 4 && B[1] && B[1][0] === 'S');
        if (dstIsBytes) { this.store(A, this.bytes(B), true); return; }
        const w = this.widthOf(A);
        const v = this.val(B, w);
        this.store(A, v);
        f.carry = false; f.overflow = false;
        this.updateFlags(v, w);
        return;
      }

      // ---- integer arithmetic. Carry is the unsigned overflow out of the
      // destination's width; Overflow is the signed one.
      case 'adds': case 'addc': {
        const w = this.widthOf(A);
        const x = this.val(A, w), y = this.val(B, w)
          + (name === 'addc' && f.carry ? 1 : 0);
        const sum = x + y;
        const lim = 2 ** (8 * w);
        f.carry = sum >= lim;
        this.setOverflow(x, y, sum, w);
        this.store(A, sum % lim);
        this.updateFlags(sum, w);
        return;
      }
      case 'subb': case 'subc': {
        const w = this.widthOf(A);
        const x = this.val(A, w), y = this.val(B, w)
          + (name === 'subc' && f.carry ? 1 : 0);
        const lim = 2 ** (8 * w);
        const diff = x - y;
        f.carry = diff < 0;
        this.setOverflow(x, (0x100000000 - y) % 0x100000000, diff, w);
        this.store(A, ((diff % lim) + lim) % lim);
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
        const x = this.val(A, w), y = this.val(B, w);
        const diff = x - y;
        f.carry = diff < 0;
        this.setOverflow(x, (0x100000000 - y) % 0x100000000, diff, w);
        this.updateFlags(diff, w);
        return;
      }
      case 'mult': {
        // SIGNED narrow multiply, and it CLOBBERS arg1 with the high half
        // when arg1 is register-backed (OpMult). Missing the clobber left a
        // stride register holding a stale value, so FS_LESEN's fault-record
        // cursor advanced from the wrong base and every record read one
        // byte early.
        const w = this.widthOf(A);
        const lim = 2 ** (8 * w), half = lim / 2;
        const sx = (() => { const v = this.val(A, w); return v >= half ? v - lim : v; })();
        const sy = (() => { const v = this.val(B, w); return v >= half ? v - lim : v; })();
        const p = sx * sy;
        const lo = ((p % lim) + lim) % lim;
        this.store(A, lo);
        f.overflow = false;
        this.updateFlags(lo, w);
        if (B && B[0] >= 1 && B[0] <= 4 && String(B[1])[0] !== 'S') {
          const hi = Math.trunc((p < 0 ? p + 2 ** 32 : p) / lim);
          this.store(B, ((hi % lim) + lim) % lim);
        }
        return;
      }
      case 'div': case 'divs': {
        const w = this.widthOf(A);
        const d = this.val(B);
        const q = d === 0 ? 0 : Math.trunc(this.val(A) / d);
        this.store(A, ((q % 2 ** (8 * w)) + 2 ** (8 * w)) % 2 ** (8 * w));
        this.updateFlags(q, w);
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
      case 'and': case 'or': case 'xor': {
        const w = this.widthOf(A);
        const x = BigInt(this.val(A, w)), y = BigInt(this.val(B, w));
        const r = Number(name === 'and' ? (x & y)
          : name === 'or' ? (x | y) : (x ^ y));
        this.store(A, r);
        this.updateFlags(r, w);
        return;
      }
      case 'not': {
        const w = this.widthOf(A);
        const lim = 2 ** (8 * w);
        const r = (lim - 1) - this.val(A);
        this.store(A, r);
        this.updateFlags(r, w);
        return;
      }
      case 'asl': case 'lsl': {
        const w = this.widthOf(A);
        const r = this.val(A) * 2 ** this.val(B);
        this.store(A, r % 2 ** (8 * w));
        this.updateFlags(r, w);
        return;
      }
      case 'lsr': case 'asr': {
        const w = this.widthOf(A);
        const r = Math.floor(this.val(A) / 2 ** this.val(B));
        this.store(A, r);
        this.updateFlags(r, w);
        return;
      }

      // ---- float
      case 'fix2flt': case 'ufix2flt':
        this.fregs.set(A[1], this.val(B));
        return;
      case 'flt2fix': {
        const w = this.widthOf(A);
        const v = Math.trunc(this.getReg(B[1]));
        this.store(A, ((v % 2 ** (8 * w)) + 2 ** (8 * w)) % 2 ** (8 * w));
        this.updateFlags(v, w);
        return;
      }
      case 'fadd': case 'fsub': case 'fmul': case 'fdiv': {
        const x = this.getReg(A[1]);
        const y = B[0] === 8 ? Best2Vm.parseNum(this.code.strings[B[1]])
          : (B[1] && String(B[1])[0] === 'F' ? this.getReg(B[1]) : this.val(B));
        let r = x;
        if (name === 'fadd') r = x + y;
        else if (name === 'fsub') r = x - y;
        else if (name === 'fmul') r = x * y;
        else r = y === 0 ? 0 : x / y;
        this.fregs.set(A[1], r);
        return;
      }
      case 'a2flt': {
        const txt = B[0] === 8 ? this.code.strings[B[1]]
          : Best2Vm.cstr(this.bytes(B));
        this.fregs.set(A[1], Best2Vm.parseNum(txt));
        return;
      }
      case 'a2fix': {
        // StringToValue, NOT a float parse: it understands 0x hex and 0y
        // binary. The `bits` tables hold masks as "0x01", and parseFloat
        // stops at the 'x' and yields 0 -- so every table-driven bit test
        // masked with 0 and reported the bit set.
        const w = this.widthOf(A);
        const txt = B[0] === 8 ? this.code.strings[B[1]]
          : Best2Vm.cstr(this.bytes(B));
        const v = Best2Vm.strToValue(txt);
        this.store(A, ((v % 2 ** (8 * w)) + 2 ** (8 * w)) % 2 ** (8 * w));
        // a2fix forces Zero and Sign false regardless of the value
        f.zero = false; f.sign = false; f.overflow = false;
        return;
      }
      case 'flt2a': {
        const v = this.getReg(B[1]);
        this.store(A, Best2Vm.strBytes(String(v)), true);
        return;
      }
      case 'fix2a': case 'ufix2a': {
        this.store(A, Best2Vm.strBytes(String(this.val(B))), true);
        return;
      }
      case 'fix2dez': case 'ufix2dez': {
        // signed for fix2dez, unsigned for ufix2dez, width from the SOURCE
        const w = this.widthOf(B) || 1;
        let v = this.val(B);
        if (name === 'fix2dez') {
          const lim = 2 ** (8 * w);
          if (v >= lim / 2) v -= lim;
        }
        this.store(A, Best2Vm.strBytes(String(v)), true);
        return;
      }

      // ---- byte/text conversions
      case 'fix2hex': case 'ufix2hex': {
        // EXACT format: "0x{0:X02}" / "0x{0:X04}" / "0x{0:X08}" by the
        // SOURCE operand's width -- prefix included, zero-padded, uppercase.
        // This is load-bearing, not cosmetic: JobResult's SB column holds
        // "0xA0", and the status lookup is `fix2hex S1,B0` / `tabseek "SB"`,
        // so dropping the prefix made every job's status miss and clamp to
        // the table's last row (ERROR_ECU_UNKNOWN_STATUSBYTE instead of OKAY).
        const w = this.widthOf(B) || 1;
        const digits = w >= 4 ? 8 : (w === 2 ? 4 : 2);
        const v = this.val(B);
        const txt = '0x' + (v >>> 0).toString(16).toUpperCase()
          .padStart(digits, '0');
        this.store(A, Best2Vm.strBytes(txt), true);
        return;
      }
      case 'y2hex': {
        let s = '';
        for (const x of this.bytes(B)) {
          s += x.toString(16).toUpperCase().padStart(2, '0');
        }
        this.store(A, Best2Vm.strBytes(s), true);
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
        this.store(A, Best2Vm.strBytes(s), true);
        return;
      }
      case 'hex2y': {
        const txt = Best2Vm.cstr(this.bytes(B)).replace(/[^0-9A-Fa-f]/g, '');
        const out = new Uint8Array(Math.floor(txt.length / 2));
        for (let i = 0; i < out.length; i++) {
          out[i] = parseInt(txt.substr(i * 2, 2), 16);
        }
        this.store(A, out, true);
        return;
      }

      // ---- strings (byte buffers)
      case 'slen': case 'strlen': {
        const b = this.bytes(B);
        const n = name === 'strlen' ? Best2Vm.cstr(b).length : b.length;
        this.store(A, n);
        this.updateFlags(n, this.widthOf(A));
        return;
      }
      case 'scat': case 'strcat': {
        const x = this.bytes(A), y = this.bytes(B);
        const base = name === 'strcat' ? Best2Vm.strBytes(Best2Vm.cstr(x)) : x;
        const add = name === 'strcat' ? Best2Vm.strBytes(Best2Vm.cstr(y)) : y;
        const out = new Uint8Array(base.length + add.length);
        out.set(base); out.set(add, base.length);
        this.store(A, out, true);
        return;
      }
      case 'scut': {
        // strcut removes the LAST `len` bytes (len counts the terminator)
        const reg = A[1];
        const buf = this.getS(reg);
        const n = this.val(B);
        this.setS(reg, n > buf.length ? new Uint8Array(0)
          : buf.slice(0, buf.length - n));
        return;
      }
      case 'spaste': {
        // INSERT (datainsert), shifting the tail right -- not an overwrite.
        // Inserting at or past the current logical end is a silent no-op.
        const reg = A[1];
        const idx = A[0] === 9 ? A[2] : this.getReg(A[2]);
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
        const x = this.bytes(A), y = this.bytes(B);
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
        const xs = Best2Vm.cstr(this.bytes(A));
        const ys = B[0] === 8 ? this.code.strings[B[1]]
          : Best2Vm.cstr(this.bytes(B));
        f.zero = xs !== String(ys ?? '');
        return;
      }
      case 'serase': {
        // delete `len` bytes at arg0's index, closing the gap (dataerase).
        // arg0 must be an indexed operand; the index names the position.
        const reg = A[1];
        const idx = A[0] === 9 ? A[2] : this.getReg(A[2]);
        const n = this.val(B);
        const buf = this.getS(reg);
        const out = new Uint8Array(Math.max(0, buf.length - Math.max(0, n)));
        let w = 0;
        for (let i = 0; i < buf.length; i++) {
          if (i < idx || i >= idx + n) out[w++] = buf[i];
        }
        this.setS(reg, out.slice(0, w));
        return;
      }
      case 'srevrs': {
        const b = Uint8Array.from(this.bytes(A)).reverse();
        this.store(A, b, true);
        return;
      }
      case 'strim': {
        this.store(A, Best2Vm.strBytes(Best2Vm.cstr(this.bytes(A)).trim()),
                   true);
        return;
      }
      case 'swap': {
        const reg = A[1];
        const idx = A[2] ?? 0, n = A[3] ?? 0;
        const buf = Uint8Array.from(this.getS(reg));
        const part = buf.slice(idx, idx + n).reverse();
        buf.set(part, idx);
        this.setS(reg, buf);
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
      case 'setc': f.carry = true; return;
      case 'clrc': f.carry = false; return;
      case 'clrv': f.overflow = false; return;
      case 'sett': this.trapBit = this.val(A) || 0x40000000; return;
      case 'ssize': {
        const n = this.bytes(A).length;
        this.store(B, n);
        return;
      }

      // ---- control flow
      case 'jump':
        if (A[1] === null) throw new VmError(`unresolved jump at ${pc}`);
        return A[1];
      case 'jz': case 'jnz': case 'jc': case 'jnc': case 'jae': case 'jbe':
      case 'ja': case 'jb': case 'jmi': case 'jpl': case 'jv': case 'jnv':
      case 'jg': case 'jge': case 'jl': case 'jle': case 'jt': case 'jnt': {
        const test = JUMP_TESTS[name];
        if (!test) throw new VmError(`no test for ${name}`);
        if (!test(f)) return;
        if (A[1] === null) throw new VmError(`unresolved jump at ${pc}`);
        return A[1];
      }

      // ---- results
      case 'ergb': case 'ergw': case 'ergd': case 'ergi': case 'ergl': {
        this.emit(this.code.strings[A[1]], this.val(B));
        return;
      }
      case 'ergr': {
        this.emit(this.code.strings[A[1]],
                  B[1] && String(B[1])[0] === 'F'
                    ? this.getReg(B[1]) : this.val(B));
        return;
      }
      case 'ergs': {
        const txt = B[0] === 8 ? this.code.strings[B[1]]
          : Best2Vm.cstr(this.bytes(B));
        this.emit(this.code.strings[A[1]], txt);
        return;
      }
      case 'ergy': {
        this.emit(this.code.strings[A[1]], Array.from(this.bytes(B)));
        return;
      }
      case 'ergc': {
        this.emit(this.code.strings[A[1]],
                  String.fromCharCode(this.val(B) & 0xff));
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
        const nm = B && B[0] === 8 ? this.code.strings[B[1]]
          : (B ? Best2Vm.cstr(this.bytes(B)) : '');
        if (this.wanted.has(String(nm || '').toUpperCase())) return;
        if (A[1] === null) throw new VmError(`unresolved etag at ${pc}`);
        return A[1];
      }

      // ---- tables
      case 'tabset': case 'tabsetex': {
        // Table lookup is CASE-INSENSITIVE (TableNameDict is keyed on
        // ToUpper), and `tabsetex` names the table in arg0 with the SGBD
        // file in arg1 -- an empty file name keeps the current stream.
        const nameOp = A;
        const t = nameOp[0] === 8 ? this.code.strings[nameOp[1]]
          : Best2Vm.cstr(this.bytes(nameOp));
        const rows = this.findTable(t);
        this.table = rows ? { name: t, rows, row: null } : null;
        // a missing table is EDIABAS_BIP_0010; the SGBD sees it via the
        // flags and its own guard emits ERROR_TABLE
        f.zero = !rows;
        return;
      }
      case 'tabseek': case 'tabseeku': {
        if (!this.table) { f.zero = true; f.tested = false; return; }
        // arg0 is always the COLUMN NAME, arg1 the value being sought.
        // `tabseek` compares text case-INsensitively; `tabseeku` parses
        // each cell as a NUMBER (StringToValue: 0x hex, 0y binary, else
        // decimal) and compares numerically -- which is what makes
        // JobResult's "0x10" style status bytes match a numeric key.
        const col = A[0] === 8 ? this.code.strings[A[1]]
          : Best2Vm.cstr(this.bytes(A));
        const keyOp = B || A;
        const numeric = name === 'tabseeku';
        const keyNum = numeric ? this.val(keyOp) : null;
        const keyTxt = keyOp[0] === 8 ? this.code.strings[keyOp[1]]
          : Best2Vm.cstr(this.bytes(keyOp));
        const want = numeric ? [] : [keyTxt];
        const ci = true;
        const cellOf = (r) => {
          if (r[col] !== undefined) return r[col];
          const k = Object.keys(r).find(
            (x) => x.toUpperCase() === String(col).toUpperCase());
          return k === undefined ? undefined : r[k];
        };
        const hit = this.table.rows.find((r) => {
          const c = cellOf(r);
          if (c === undefined) return false;
          if (numeric) return Best2Vm.strToValue(String(c)) === keyNum;
          return want.some((w) => String(c).toLowerCase()
            === String(w).toLowerCase());
        });
        // A VALUE MISS IS NOT AN ERROR: SeekTable returns the LAST data row
        // and reports not-found, because SGBD tables conventionally put a
        // catch-all in the last row. Zero==true means "not found" (inverted
        // from the usual sense), which is the `tabseek / jz` idiom.
        this.table.row = hit || this.table.rows[this.table.rows.length - 1]
          || null;
        f.zero = !hit;
        f.tested = !!hit;
        return;
      }
      case 'tabget': {
        const col = this.code.strings[B[1]] ?? Best2Vm.cstr(this.bytes(B));
        const cell = this.table && this.table.row
          ? this.table.row[col] : undefined;
        this.store(A, Best2Vm.strBytes(cell === undefined || cell === null
          ? '' : String(cell)), true);
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
        this.store(A, this.table && this.table.rows[0]
          ? Object.keys(this.table.rows[0]).length : 0);
        return;
      }
      case 'tabline': {
        // 0-based over DATA rows; an out-of-range index clamps to the last
        // row and reports Zero=true (GetTableLine), it does not fail
        const i = this.val(B);
        if (!this.table) { f.zero = true; return; }
        const inRange = i >= 0 && i < this.table.rows.length;
        this.table.row = inRange ? this.table.rows[i]
          : this.table.rows[this.table.rows.length - 1] || null;
        f.zero = !inRange;
        return;
      }

      // ---- job arguments
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
        this.store(A, Best2Vm.strBytes(txt), true);
        return;
      }
      case 'parb': case 'parw': case 'parl': case 'pard': case 'pari': {
        const parts = this.args();
        const i = this.val(B) - 1;
        f.zero = true; f.carry = false; f.sign = false; f.overflow = false;
        let v = 0;
        if (i >= 0 && i < parts.length && parts[i] !== '') {
          v = Best2Vm.strToValue(parts[i]);
          f.zero = false;
        }
        this.store(A, v);
        return;
      }
      case 'parr': {
        const parts = this.args();
        const i = this.val(B) - 1;
        f.zero = true; f.carry = false; f.sign = false; f.overflow = false;
        let v = 0;
        if (i >= 0 && i < parts.length && parts[i] !== '') {
          v = Best2Vm.parseNum(parts[i]);
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
      case 'xsend': case 'xsendf': case 'xsendr': case 'xsendex':
      case 'xrequf': case 'xraw': {
        // arg0 names the register that RECEIVES the answer; the request is
        // the second operand where present, else arg0's current contents.
        const req = B ? this.bytes(B) : this.bytes(A);
        const ans = this.send(Array.from(req)) || [];
        this.answer = Uint8Array.from(ans);
        this.store(A, this.answer, true);
        f.zero = this.answer.length === 0;
        return;
      }

      // ---- environment / no-ops for decode purposes. These affect timing,
      // tracing or interface configuration, none of which changes a decoded
      // value, so they are accepted and ignored rather than aborting a job.
      case 'settmr': case 'gettmr': case 'clrt': case 'wait': case 'setspc':
      case 'xconnect': case 'xhangup': case 'xstopf': case 'xawlen':
      case 'xreps': case 'xsetpar': case 'xkeyb': case 'xkeybytes':
      case 'setflt': case 'clrflt': case 'shmset': case 'shmget':
      case 'cfgig': case 'cfgsg': case 'cfgss': case 'date': case 'time':
      case 'ticks': case 'trap': case 'plink': case 'pjob': case 'pexec':
      case 'fopen': case 'fclose': case 'fseekln': case 'freadln':
      case 'fread': case 'fwrite': case 'stoken': case 'ergsysi':
      case 'generr': case 'iupdate': case 'realf':
        if (name === 'gettmr' || name === 'ticks') this.store(A, 0);
        return;

      default:
        // Silence is how a VM produces wrong answers. An unknown opcode
        // throws, the differential test catches it, and the gap gets
        // implemented instead of guessed.
        throw new VmError(`unimplemented opcode ${name} at ${pc}`);
    }
  }

  // EDIABAS's StringToValue: 0x hex, 0y binary, else decimal truncated at
  // the first '.' or ','. Unparseable yields 0. This is what table cells
  // are run through by tabseeku, so "0x10" seeks as 16.
  static strToValue(s) {
    const t = String(s ?? '').trim();
    if (!t) return 0;
    const low = t.toLowerCase();
    if (low.startsWith('0x')) {
      const v = parseInt(t.slice(2), 16);
      return Number.isFinite(v) ? v : 0;
    }
    if (low.startsWith('0y')) {
      const v = parseInt(t.slice(2), 2);
      return Number.isFinite(v) ? v : 0;
    }
    const cut = t.split(/[.,]/)[0];
    const v = parseInt(cut, 10);
    return Number.isFinite(v) ? v : 0;
  }

  // EDIABAS writes float constants with either separator
  static parseNum(s) {
    if (s === undefined || s === null) return 0;
    const v = parseFloat(String(s).replace(',', '.'));
    return Number.isFinite(v) ? v : 0;
  }
}

const STOP = Symbol('eoj');

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Best2Vm, VmError, STOP, JUMP_TESTS, REG_BYTES };
}
