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

// Jobs that CHANGE the ECU rather than read it. Kept deliberately identical
// to WRITE_JOB in tools/sgbd_bulk_verify.py -- two different answers to
// "is this a write?" is worse than either answer alone.
//
// The list is by NAME because that is what BEST2 gives us: the bytecode has
// no flag saying "this telegram writes", and the service byte varies per
// protocol. Naming is the SGBD authors' own convention (STEUERN_ = actuate,
// _LOESCHEN = clear, _SCHREIBEN = write) and it is what INPA's own screens
// are marked with.
const WRITE_JOB = new RegExp(
  '^(STEUERN|SCHREIBEN|.*_SCHREIBEN|.*_LOESCHEN|FS_LOESCHEN|.*_SETZEN'
  + '|FLASH.*|PROGRAMMIER.*|.*_RESET|RESET.*|CODIER.*_SCHREIB.*)', 'i');

function isWriteJob(name) {
  return WRITE_JOB.test(String(name || ''));
}

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
  // jt/jnt are handled in step(): they test the TRAP REGISTER with an
  // optional bit selector, not a boolean flag.
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
    // the job's declared array size (ArrayMaxBufSize); 1024 is EDIABAS's
    // default and every E46 job fits it
    this.arraySize = opts.arraySize || 1024;
    // process-wide shared data (shmset/shmget), persists across jobs
    this.shared = opts.shared || new Map();
    // A SESSION runs INITIALISIERUNG once when the SGBD is loaded, not once
    // per job. Callers that keep a session (webshim) pass inited:true on
    // every job after the first, so the implicit init below is skipped --
    // which is both what the engine does and one less telegram per job.
    this._inited = !!opts.inited;
    // Permission to transmit for a job that CHANGES the ECU. Off by
    // default: a caller has to say so, and saying so is the point where a
    // UI can put a confirmation in front of the user.
    this.allowWrites = !!opts.allowWrites;
    // Wire parameters from xsetpar. Seeded from the SESSION: xsetpar lives
    // in INITIALISIERUNG, which runs once per session -- a fresh VM for a
    // later job never executes it, so the caller carries comm forward the
    // same way it carries `shared`. Without this seed every ordinary job
    // transmitted with comm=null, i.e. BMW-FAST 115200 8N1, and every
    // K-line module got line noise.
    this.comm = opts.comm || null;
    // A fixed clock for date/time, when the caller needs determinism.
    // webshim re-runs a job's bytecode once per telegram fetched, and the
    // answer memo is keyed on request bytes -- a timestamp that ticks
    // between passes changes the bytes, misses the memo, and re-transmits
    // a telegram that already went out.
    this.now = opts.now || null;
  }

  reset() {
    // Per the reference: a job start clears the stack, flags, string
    // registers, results and traps. It does NOT clear byte/float registers,
    // and shared data is process-wide -- so neither is reset here.
    this.regBuf = this.regBuf || new Uint8Array(REG_BYTES);
    this.sregs = new Map();            // name -> {buf, len}
    this.fregs = new Map();            // name -> number
    this.stack = [];                   // BYTE stack (push writes N bytes)
    this.flags = { zero: false, sign: false, carry: false,
                   overflow: false, tested: false };
    this.results = [];                 // completed result sets
    this.cur = new Map();              // set being built
    this.wanted = null;                // etag filter, null = everything
    this.table = null;                 // {rows, cols, row}
    // The trap register: -1 = clean, 0 = an error with no mapped bit,
    // 2..29 = a mapped EDIABAS error (BIP_0010 -> 10 is the table error),
    // >= 0x40000000 = a user trap from `sett`. jt/jnt test THIS, not a
    // generic "tested" flag -- a tabset that SUCCEEDS must leave it clean,
    // and mine left a stale flag so `jt err,#10` fired after a good tabset
    // and 31 jobs reported ERROR_TABLE.
    this.trapBit = -1;
    this.answer = new Uint8Array(0);
    this.tokenSep = '';                // setspc separators for stoken
    this.tokenIdx = 0;                 // 1-based token number, 0 = unset
    // this.comm is deliberately NOT cleared: xsetpar runs in
    // INITIALISIERUNG, and a job start that wiped it sent every subsequent
    // telegram with default (BMW-FAST) framing. Comm lives as long as the
    // VM / session, like shared data.
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

  // A string register is a FIXED-CAPACITY buffer plus a logical length,
  // exactly like EdiabasNet's StringData -- not a JS array that shrinks.
  // The distinction is observable: `clear` zeroes the length but reads at an
  // index past it still see whatever bytes are in the buffer
  // (Operand.GetRawData uses GetArrayData(TRUE), the complete buffer), and
  // MS450's IDENT publishes ID_SG_ADR from exactly such a stale byte.
  sd(name) {
    let d = this.sregs.get(name);
    if (!d) {
      d = { buf: new Uint8Array(this.arraySize), len: 0 };
      this.sregs.set(name, d);
    }
    return d;
  }

  // logical contents
  getS(name) {
    const d = this.sd(name);
    return d.buf.subarray(0, d.len);
  }

  // the complete buffer, stale bytes included -- what indexed reads see
  getSraw(name) {
    return this.sd(name).buf;
  }

  setS(name, bytes, keepLength) {
    const d = this.sd(name);
    const src = bytes instanceof Uint8Array ? bytes
      : Uint8Array.from(bytes || []);
    if (src.length > d.buf.length) {
      // over capacity: StringData.SetData raises EDIABAS_BIP_0001 (no
      // mapped trap bit -> 0) and does NOT write. Returning silently left
      // the register holding stale bytes with a clean trap register.
      this.trapBit = 0;
      return;
    }
    d.buf.set(src, 0);
    if (!keepLength) d.len = src.length;
  }

  // `clear` on a string register zeroes the whole buffer AND the length
  clearS(name) {
    const d = this.sd(name);
    d.buf.fill(0);
    d.len = 0;
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
      const buf = this.getSraw(a);          // complete buffer, stale included
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
    if (m === 8) {
      // a pool entry is either a byte ARRAY (an exact literal, possibly
      // containing NULs) or a plain string (a result/table name)
      const lit = this.code.strings[a];
      return Array.isArray(lit) ? Uint8Array.from(lit)
        : Best2Vm.strBytes(lit ?? '');
    }
    if (m >= 1 && m <= 4) {
      if (a[0] === 'S') return this.getS(a);
      const span = Best2Vm.regSpan(a);
      return this.regBuf.slice(span[0], span[0] + span[1]);
    }
    if (m === 9 || m === 10) {
      const buf = this.getSraw(a);
      const i = m === 9 ? b : this.getReg(b);
      return i < buf.length ? buf.slice(i, i + 1) : new Uint8Array(0);
    }
    if (m >= 12 && m <= 15) {
      const buf = this.getSraw(a);
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
    if (m === 9 || m === 10 || m === 11) {
      let i = m === 9 ? b : this.getReg(b);
      if (m === 11) i += c || 0;
      const d = this.sd(a);
      if (i >= d.buf.length) return;              // over capacity: no write
      // value is serialized LITTLE-endian across `width` bytes
      const src = asBytes ? value
        : (() => {
          const w = 1;
          const o = new Uint8Array(w);
          let v = Number(value);
          for (let k = 0; k < w; k++) { o[k] = v & 0xff; v = Math.floor(v / 256); }
          return o;
        })();
      for (let k = 0; k < src.length && i + k < d.buf.length; k++) {
        d.buf[i + k] = src[k];
      }
      d.len = Math.max(d.len, i + src.length);    // grows, never shrinks
      return;
    }
    if (m >= 12 && m <= 15) {
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
  // Run a job the way a SESSION does: EDIABAS executes the SGBD's
  // INITIALISIERUNG job once before the first real job (ExecuteInitJob),
  // and SGBDs use it to populate shared data that later jobs read -- MS450's
  // AIF block size and free count arrive that way via shmset/shmget. Without
  // it those results read zeros.
  run(jobName, args) {
    // Refuse a write job BEFORE anything is transmitted -- including the
    // implicit INITIALISIERUNG, which is itself only a read but still puts
    // bytes on the wire. "Nothing was sent" is a much easier promise to
    // reason about than "only harmless things were sent".
    if (isWriteJob(jobName) && !this.allowWrites) {
      throw new VmError(
        `refusing to run write job ${jobName}: `
        + 'construct the VM with {allowWrites: true} to permit it');
    }
    const init = this.code.jobs.INITIALISIERUNG;
    if (init !== undefined && !this._inited
        && String(jobName).toUpperCase() !== 'INITIALISIERUNG') {
      this._inited = true;
      let initSets;
      try {
        initSets = this.runOne(init, '');
      } catch (e) {
        // An init that fails FAILS THE JOB. ExecuteInitJob rethrows any
        // exception and closes the SGBD to force a reload -- it does not
        // shrug and continue. Swallowing here converted every loud init
        // failure (unimplemented opcode, step limit, eerr) into a job that
        // "succeeded" with empty shared data and published zeros as OKAY.
        // The needAnswer sentinel (webshim fetching a telegram answer) also
        // rethrows, and both paths clear _inited so init runs again on the
        // next attempt.
        this._inited = false;
        throw e;
      }
      // ExecuteInitJob also demands the init PROVE itself: result set 1
      // (our set 0; the engine's set 0 is synthetic) must carry DONE=1, or
      // the engine reports EDIABAS_SYS_0010 and unloads the SGBD.
      const done = initSets && initSets.length
        && Number(initSets[0].DONE) === 1;
      if (!done) {
        this._inited = false;
        throw new VmError(
          'INITIALISIERUNG did not report DONE=1 (EDIABAS_SYS_0010)');
      }
    }
    return this.runOne(undefined, args, jobName);
  }

  runOne(entryIdx, args, jobName) {
    const entry = entryIdx !== undefined ? entryIdx
      : (this.code.jobs[jobName] ?? this.code.jobs[jobName?.toUpperCase()]);
    if (entry === undefined) throw new VmError(`no job ${jobName}`);
    this.jobName = jobName || this.jobName;
    // INITIALISIERUNG runs implicitly before a real job; it is never a
    // write, and must not inherit the target job's classification.
    this.writeJob = entryIdx !== undefined ? false : isWriteJob(jobName);
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

  // Store TEXT into a string register the way Operand.SetStringData does:
  // the bytes PLUS one appended NUL when non-empty (an empty string stores a
  // zero-length array with no NUL). This is observable, not cosmetic --
  // `scmp` is byte-exact, and the compiler's literals carry the terminator
  // ("6\0"), so a stored "6" without one never matched and MS420's VANOS
  // jobs fell through to ERROR_FUNCTION_*.
  storeText(op, txt) {
    const b = Best2Vm.strBytes(String(txt ?? ''));
    if (b.length === 0) { this.store(op, b, true); return; }
    const out = new Uint8Array(b.length + 1);
    out.set(b);
    this.store(op, out, true);
  }

  // A shared-data key. GetStringData stops at the first NUL, so a key that
  // IS a NUL byte reads as the empty string -- which is a perfectly valid
  // key, and the one MS450's AIF block uses. Uppercased, as the engine does.
  shmKey(op) {
    const raw = op[0] === 8 ? this.code.strings[op[1]] : this.bytes(op);
    const bytes = Array.isArray(raw) ? Uint8Array.from(raw) : raw;
    return Best2Vm.cstr(bytes).toUpperCase();
  }

  // A result NAME is arg0.GetStringData(): usually an inline literal, but
  // it can equally be a REGISTER -- MS420's VANOS jobs name a result from a
  // register still holding response bytes, and the engine faithfully
  // publishes the resulting garbage key. Assuming a pool index dropped the
  // name to the empty string.
  resName(op) {
    if (op[0] === 8) return this.lit(op[1]);
    return Best2Vm.cstr(this.bytes(op));
  }

  // A pool entry as TEXT: a byte-array literal is NUL-terminated text.
  lit(i) {
    const v = this.code.strings[i];
    if (Array.isArray(v)) return Best2Vm.cstr(Uint8Array.from(v));
    return v ?? '';
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

  // Publish a result. The KEY IS UPPERCASED (SetResultData keys
  // _resultDict on Name.ToUpper), so ZKE5's "STAT_IFFHMax_WERT" is
  // published as STAT_IFFHMAX_WERT -- the values were already right, only
  // the key case differed, and a caller looking up the engine's name found
  // nothing. Last write wins, as the engine's dictionary assignment does.
  emit(name, value) {
    const key = String(name).toUpperCase();
    if (this.wanted && !this.wanted.has(key) && !key.startsWith('JOB_')) {
      return;
    }
    this.cur.set(key, value);
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
        if (A[0] >= 1 && A[0] <= 4 && A[1][0] === 'S') {
          this.clearS(A[1]);
        } else {
          this.store(A, 0, false);
        }
        // OpClear sets the same flags for EVERY register type; leaving them
        // stale on the numeric path made a jz right after `clear I0` not
        // jump.
        f.carry = false; f.zero = true; f.sign = false; f.overflow = false;
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
        //
        // OpMult computes the product in 32-BIT integer arithmetic -- the
        // exact low 32 bits, wrapping -- never a 64-bit product. A plain JS
        // double multiply rounds past 2^53 and got the low word wrong for
        // large 32-bit operands; Math.imul is the exact wrap. The high half
        // is "(UInt64)result >> (len << 3)" of that 32-bit result, so it is
        // ZERO at width 4 (the engine's own comment: negative high halves
        // are not emulated).
        const w = this.widthOf(A);
        const lim = 2 ** (8 * w), half = lim / 2;
        const sx = (() => { const v = this.val(A, w); return v >= half ? v - lim : v; })();
        const sy = (() => { const v = this.val(B, w); return v >= half ? v - lim : v; })();
        const result = (w === 4 ? Math.imul(sx | 0, sy | 0) : sx * sy) >>> 0;
        this.store(A, result % lim);
        f.overflow = false;
        this.updateFlags(result, w);
        if (B && B[0] >= 1 && B[0] <= 4 && String(B[1])[0] !== 'S') {
          this.store(B, Math.floor(result / lim) % lim);
        }
        return;
      }
      case 'div': case 'divs': {
        // OpDivs does 32-BIT SIGNED division for EVERY width -- the narrow
        // native forms are commented out in the engine as "DIVS failure in
        // ediabas!" -- and it writes the REMAINDER back into arg1 when arg1
        // is register-backed. Dividing unsigned gave SMG2's hydraulic
        // pressure 42949660 where the engine says 65524: the dividend was
        // 0xFFFFFB38 = -1224, and -1224/100 = -12, which is 65524 as an
        // unsigned 16-bit result.
        const w = this.widthOf(A);
        const toI32 = (v) => (v >= 0x80000000 ? v - 0x100000000 : v);
        const x = toI32(this.val(A, w)), y = toI32(this.val(B, w));
        const lim = 2 ** (8 * w);
        if (y === 0) {
          // OpDivs on a zero divisor raises EDIABAS_BIP_0007 (which has no
          // mapped trap bit -> 0), KEEPS arg0's value, and still writes a
          // zero remainder. Yielding a silent 0 quotient turned a garbled
          // count byte into 0-valued results published as OKAY. The
          // trap-mask layer is not modeled (see generr), so trapping is
          // the conservative choice over aborting the job.
          this.trapBit = 0;
          f.overflow = false;
          this.updateFlags(0, w);
          if (B && B[0] >= 1 && B[0] <= 4 && String(B[1])[0] !== 'S') {
            this.store(B, 0);
          }
          return;
        }
        const q = Math.trunc(x / y), rem = x % y;
        const stored = ((q % lim) + lim) % lim;
        this.store(A, stored);
        f.overflow = false;
        this.updateFlags(stored, w);
        if (B && B[0] >= 1 && B[0] <= 4 && String(B[1])[0] !== 'S') {
          this.store(B, ((rem % lim) + lim) % lim);
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
        const n = this.val(B);
        const v = this.val(A, w);
        const r = v * 2 ** n;
        // carry is the LAST BIT SHIFTED OUT of the width, like the engine's
        // shift ops; untouched when the count is zero
        if (n > 0) f.carry = n <= 8 * w
          && Math.floor(v / 2 ** (8 * w - n)) % 2 === 1;
        this.store(A, r % 2 ** (8 * w));
        this.updateFlags(r, w);
        return;
      }
      case 'lsr': case 'asr': {
        // asr is ARITHMETIC: the sign bit (at the operand's width) shifts
        // back in. lsr shifts in zeros. Both report the last bit shifted
        // out in carry.
        const w = this.widthOf(A);
        const n = this.val(B);
        const lim = 2 ** (8 * w);
        const u = this.val(A, w);                       // bit pattern
        let v = u;
        if (name === 'asr' && v >= lim / 2) v -= lim;   // signed view
        // the shifted-out bit is bit n-1 of the PATTERN, sign play or not
        if (n > 0 && n <= 8 * w) {
          f.carry = Math.floor(u / 2 ** (n - 1)) % 2 === 1;
        }
        const r = Math.floor(v / 2 ** n);
        this.store(A, ((r % lim) + lim) % lim);
        this.updateFlags(r, w);
        return;
      }

      // ---- float
      case 'fix2flt': case 'ufix2flt': {
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
        this.store(A, ((v % 2 ** (8 * w)) + 2 ** (8 * w)) % 2 ** (8 * w));
        this.updateFlags(v, w);
        return;
      }
      case 'fadd': case 'fsub': case 'fmul': case 'fdiv': {
        const x = this.getReg(A[1]);
        const y = B[0] === 8 ? Best2Vm.parseNum(this.lit(B[1]))
          : (B[1] && String(B[1])[0] === 'F' ? this.getReg(B[1]) : this.val(B));
        let r = x;
        if (name === 'fadd') r = x + y;
        else if (name === 'fsub') r = x - y;
        else if (name === 'fmul') r = x * y;
        else {
          // OpFdiv divides regardless and stores what comes out; an
          // infinite or NaN quotient raises EDIABAS_BIP_0011 (trap bit 8).
          // Storing a silent 0 hid the division by zero entirely.
          r = x / y;
          if (!Number.isFinite(r)) this.trapBit = 8;
        }
        this.fregs.set(A[1], r);
        return;
      }
      case 'fcomp': {
        // comp for floats: subtract without storing. There is no width or
        // borrow arithmetic here -- zero/sign carry the ordering and
        // overflow stays clear, which is exactly what makes jl/jg/jle/jge
        // (sign vs overflow) and jc/jb (carry) all read as plain < and >.
        const fv = (op) => (op[0] === 8 ? Best2Vm.parseNum(this.lit(op[1]))
          : (op[1] && String(op[1])[0] === 'F' ? this.getReg(op[1])
            : this.val(op)));
        const x = fv(A), y = fv(B);
        f.zero = x === y;
        f.sign = x < y;
        f.carry = x < y;
        f.overflow = false;
        return;
      }
      case 'y42flt': case 'y82flt': {
        // 4/8 raw bytes -> IEEE float, LITTLE-endian: the corpus reverses
        // wire bytes with swap first (swap S1,0,4 / y42flt F5,S1[0]), so
        // the op itself reads host order.
        const n = name === 'y42flt' ? 4 : 8;
        const [m, a, b, c] = B;
        let src;
        if (m >= 9 && m <= 11) {
          const raw = this.getSraw(a);
          let i = m === 9 ? b : this.getReg(b);
          if (m === 11) i += c || 0;
          src = raw.slice(i, i + n);
        } else {
          src = Uint8Array.from(this.bytes(B)).slice(0, n);
        }
        const buf = new Uint8Array(n);
        buf.set(src.slice(0, n));
        const dv = new DataView(buf.buffer);
        this.fregs.set(A[1],
                       n === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true));
        return;
      }
      case 'flt2y4': case 'flt2y8': {
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
        const txt = B[0] === 8 ? this.lit(B[1])
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
        const txt = B[0] === 8 ? this.lit(B[1])
          : Best2Vm.cstr(this.bytes(B));
        const v = Best2Vm.strToValue(txt);
        this.store(A, ((v % 2 ** (8 * w)) + 2 ** (8 * w)) % 2 ** (8 * w));
        // a2fix forces Zero and Sign false regardless of the value
        f.zero = false; f.sign = false; f.overflow = false;
        return;
      }
      case 'flt2a': {
        this.storeText(A, Best2Vm.fltText(this.getReg(B[1])));
        return;
      }
      case 'fix2a': case 'ufix2a': {
        this.storeText(A, String(this.val(B)));
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
        this.storeText(A, String(v));
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
        this.setS(reg, n >= buf.length ? new Uint8Array(0)
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
        const ys = B[0] === 8 ? this.lit(B[1])
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
        this.tokenSep = Best2Vm.cstr(this.bytes(A));
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
        const src = Best2Vm.cstr(this.bytes(B));
        const seps = this.tokenSep || ' ';
        const parts = src.split(new RegExp(
          `[${seps.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}]+`))
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
      case 'jt': case 'jnt': {
        // `jt target[, bit]`: with a bit selector, fire when the trap
        // register equals it (bit 32 aliases the unmapped bit 0); with no
        // selector, jt fires on ANY pending trap. jnt is the inverse --
        // except with no selector, where EDIABAS has a documented bug
        // (tests >= 0x40000000, so it effectively always jumps); that is
        // emulated deliberately, since SGBDs are compiled against it.
        let hit;
        if (B && B[0] !== 0) {
          const bit = this.val(B, 1);
          hit = bit > 0
            ? (this.trapBit === bit || (this.trapBit === 0 && bit === 32))
            : this.trapBit >= 0x40000000;
        } else {
          hit = name === 'jt' ? this.trapBit >= 0
            : this.trapBit >= 0x40000000;
        }
        if (name === 'jnt') hit = !hit;
        if (!hit) return;
        if (A[1] === null) throw new VmError(`unresolved jump at ${pc}`);
        return A[1];
      }
      case 'clrt': this.trapBit = -1; return;
      case 'jz': case 'jnz': case 'jc': case 'jnc': case 'jae': case 'jbe':
      case 'ja': case 'jb': case 'jmi': case 'jpl': case 'jv': case 'jnv':
      case 'jg': case 'jge': case 'jl': case 'jle': {
        const test = JUMP_TESTS[name];
        if (!test) throw new VmError(`no test for ${name}`);
        if (!test(f)) return;
        if (A[1] === null) throw new VmError(`unresolved jump at ${pc}`);
        return A[1];
      }

      // ---- results
      // Each erg* opcode has a FIXED width and signedness, independent of
      // the operand's own type (the reference's result table):
      //   ergb  unsigned 8    ergc  SIGNED 8
      //   ergw  unsigned 16   ergi  SIGNED 16
      //   ergd  unsigned 32   ergl  SIGNED 32
      // Publishing ergi unsigned reported SMG2's coolant temperature as
      // 65531 where the engine says -5.
      case 'ergb': case 'ergw': case 'ergd':
      case 'ergi': case 'ergl': {
        const spec = { ergb: [1, false], ergw: [2, false], ergd: [4, false],
                       ergi: [2, true], ergl: [4, true] }[name];
        const [w, signed] = spec;
        let v = this.val(B, w) % 2 ** (8 * w);
        if (signed && v >= 2 ** (8 * w - 1)) v -= 2 ** (8 * w);
        this.emit(this.resName(A), v);
        return;
      }
      case 'ergr': {
        // arg1 is GetFloatData(): a pool literal parses as a number rather
        // than falling through val()'s m===8 case, which returned 0.
        this.emit(this.resName(A),
                  B[0] === 8 ? Best2Vm.parseNum(this.lit(B[1]))
                    : B[1] && String(B[1])[0] === 'F'
                      ? this.getReg(B[1]) : this.val(B));
        return;
      }
      case 'ergs': {
        const txt = B[0] === 8 ? this.lit(B[1])
          : Best2Vm.cstr(this.bytes(B));
        this.emit(this.resName(A), txt);
        return;
      }
      case 'ergy': {
        this.emit(this.resName(A), Array.from(this.bytes(B)));
        return;
      }
      case 'ergc': {
        // SIGNED 8-bit, published as a NUMBER (TypeC), not a character
        let v = this.val(B, 1) & 0xff;
        if (v >= 0x80) v -= 0x100;
        this.emit(this.resName(A), v);
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
        const nm = B && B[0] === 8 ? this.lit(B[1])
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
        const t = nameOp[0] === 8 ? this.lit(nameOp[1])
          : Best2Vm.cstr(this.bytes(nameOp));
        const rows = this.findTable(t);
        this.table = rows ? { name: t, rows, row: null } : null;
        // a missing table is EDIABAS_BIP_0010 (trap bit 10); a found one
        // must CLEAR the trap, or the SGBD's `jt err,#10` guard fires on a
        // perfectly good table
        f.zero = !rows;
        this.trapBit = rows ? -1 : 10;
        return;
      }
      case 'tabseek': case 'tabseeku': {
        if (!this.table) { f.zero = true; this.trapBit = 10; return; }
        // arg0 is always the COLUMN NAME, arg1 the value being sought.
        // `tabseek` compares text case-INsensitively; `tabseeku` parses
        // each cell as a NUMBER (StringToValue: 0x hex, 0y binary, else
        // decimal) and compares numerically -- which is what makes
        // JobResult's "0x10" style status bytes match a numeric key.
        const col = A[0] === 8 ? this.lit(A[1])
          : Best2Vm.cstr(this.bytes(A));
        const keyOp = B || A;
        const numeric = name === 'tabseeku';
        const keyNum = numeric ? this.val(keyOp) : null;
        const keyTxt = keyOp[0] === 8 ? this.lit(keyOp[1])
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
        return;
      }
      case 'tabget': {
        // Column name from a pool literal OR a register (lit() never
        // returns nullish, so `lit(B[1]) ?? ...` silently missed every
        // register-held name). Case-insensitive like tabseek.
        const col = B[0] === 8 ? this.lit(B[1])
          : Best2Vm.cstr(this.bytes(B));
        let cell;
        if (this.table && this.table.row) {
          cell = this.table.row[col];
          if (cell === undefined) {
            const k = Object.keys(this.table.row).find(
              (x) => x.toUpperCase() === String(col).toUpperCase());
            if (k !== undefined) cell = this.table.row[k];
          }
        }
        this.storeText(A, cell === undefined || cell === null
          ? '' : String(cell));
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
        this.storeText(A, txt);
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
        // THE WRITE GUARD. This is the only point where bytes leave the VM,
        // so it is the only place the check has to exist. A job whose name
        // says it CHANGES the ECU refuses to transmit unless the caller
        // opted in -- the failure happens before the bytes reach the cable
        // rather than after. Simulation and fixtures are unaffected: they
        // pass allowWrites, because writing into a .sim file harms nothing.
        if (this.writeJob && !this.allowWrites) {
          throw new VmError(
            `refusing to transmit for write job ${this.jobName}: `
            + 'construct the VM with {allowWrites: true} to permit it');
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
          throw new VmError(`answer of ${ans.length} bytes exceeds the `
            + `job's array size (${this.arraySize})`);
        }
        this.answer = Uint8Array.from(ans);
        this.store(A, this.answer, true);
        f.zero = this.answer.length === 0;
        return;
      }

      // ---- environment / no-ops for decode purposes. These affect timing,
      // tracing or interface configuration, none of which changes a decoded
      // value, so they are accepted and ignored rather than aborting a job.
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
        // the wire. Two packings exist in the corpus. Classic concepts use
        // 16-bit words: [concept, baud, ecuAddr, ...timings] (ms450ds0:
        // 06 00 80 25 b8 00 ... = DS2, 9600, addr 0xB8). The 0x1xx family
        // uses 32-bit dwords: [concept, baud, ...timings] (0d 01 00 00
        // 80 25 00 00 ... = KWP2000*, 9600). A dword-parse of a classic
        // blob yields an absurd concept, which is the disambiguator.
        //
        // The VM does not touch the port; it surfaces {concept, baud,
        // timeout} to send(), which owns framing and the wire.
        const raw = Array.from(this.bytes(A));
        let words = [];
        if (raw.length >= 4 && raw.length % 4 === 0) {
          for (let i = 0; i + 3 < raw.length; i += 4) {
            words.push(raw[i] + raw[i + 1] * 0x100
              + raw[i + 2] * 0x10000 + raw[i + 3] * 0x1000000);
          }
        }
        if (!words.length || words[0] > 0x1ff) {
          words = [];
          for (let i = 0; i + 1 < raw.length; i += 2) {
            words.push(raw[i] + raw[i + 1] * 0x100);
          }
        }
        if (words.length >= 2 && words[0] > 0 && words[0] <= 0x1ff) {
          // The exact index of the answer timeout inside the blob is not
          // decoded yet; the largest plausible timing word is a safe upper
          // bound (an answer that IS coming arrives long before it).
          const timing = words.slice(2).filter((v) => v >= 100 && v <= 30000);
          this.comm = {
            concept: words[0],
            baud: words[1],
            timeout: timing.length ? Math.max(1000, ...timing) : null,
            params: words,
          };
        }
        return;
      }
      case 'a2y': {
        // ASCII hex -> bytes: "AB0102" (separators tolerated) into a byte
        // array. Carry reports a character that is not hex -- conversion
        // stops there, keeping the bytes parsed so far.
        const txt = Best2Vm.cstr(this.bytes(B)).trim();
        const clean = txt.replace(/^0x/i, '');
        const out = [];
        let bad = false;
        for (let i = 0; i < clean.length;) {
          if (/[\s,;:]/.test(clean[i])) { i += 1; continue; }
          const pair = clean.slice(i, i + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(pair)) { bad = true; break; }
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
        this.store(A, Best2Vm.strBytes('OBD'), true);
        return;
      }
      case 'xvers': {
        // Interface version as a number. 0x0730 = the 7.3.0 engine the
        // data was lifted from; nothing in the corpus does more than
        // require it to be non-zero / recent.
        this.store(A, 0x0730);
        return;
      }
      case 'date': {
        // dd.MM.yyyy text, the German convention AIF date fields expect.
        // this.now (when the caller set one) keeps the bytes identical
        // across webshim's replay passes -- see the constructor.
        const d = this.now || new Date();
        const p = (n) => String(n).padStart(2, '0');
        this.storeText(A,
                       `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`);
        return;
      }
      case 'time': {
        const d = this.now || new Date();
        const p = (n) => String(n).padStart(2, '0');
        this.storeText(A,
                       `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
        return;
      }
      case 'wait': {
        // The VM is synchronous, so it cannot sleep -- but the TRANSPORT
        // can. Accumulate the requested pause and hand it to the next
        // exchange via comm, where runExchange honors it before writing.
        // Pacing-sensitive sequences (reset-then-reident, adaptation
        // clears) stop firing back-to-back on a real wire.
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
        this.trapBit = this.val(A) || 0x40000000;
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
      case 'freadln': case 'fread': {
        // nothing is ever open (see fopen): empty read, zero = at end
        this.store(A, new Uint8Array(0), true);
        f.zero = true;
        f.carry = true;
        return;
      }
      case 'settmr': case 'gettmr':
      case 'xconnect': case 'xhangup': case 'xstopf': case 'xawlen':
      case 'xreps': case 'xkeyb': case 'xkeybytes':
      case 'xprog': case 'xreset':
      case 'setflt': case 'clrflt':
      case 'cfgig': case 'cfgsg': case 'cfgss':
      case 'ticks': case 'trap': case 'plink': case 'pjob': case 'pexec':
      case 'fclose': case 'fseekln': case 'fwrite': case 'ergsysi':
      case 'iupdate': case 'realf':
        // ergsysi stays a no-op ON PURPOSE: it publishes into result set 0,
        // which this VM deliberately never synthesizes (the engine injects
        // set 0; see SYSTEM_RESULTS in test_bestvm.js).
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
    // StringToValue uses Convert.ToInt64, which is ALL-OR-NOTHING: it
    // throws on trailing junk and the caller catches it as 0. parseInt
    // happily takes a valid prefix, and that difference is visible --
    // y2bcd renders a non-BCD nibble as '*', so LSZ's ID_HW_NR is the text
    // "2*", which the engine reports as 0 and parseInt would call 2.
    const t = String(s ?? '').replace(/\s+$/, '');
    if (!t) return 0;
    const low = t.toLowerCase();
    if (low.startsWith('0x')) {
      const body = t.slice(2);
      if (!/^[0-9a-fA-F]+$/.test(body)) return 0;
      const v = parseInt(body, 16);
      return Number.isFinite(v) ? v : 0;
    }
    if (low.startsWith('0y')) {
      const body = t.slice(2);
      if (!/^[01]+$/.test(body)) return 0;
      const v = parseInt(body, 2);
      return Number.isFinite(v) ? v : 0;
    }
    if (low === '-' || low === '--') return 0;
    if (/^[a-z]/i.test(low)) return 0;      // a leading letter rejects it
    // decimal, truncated at the first '.' or ',' -- then it must be a
    // COMPLETE integer or the conversion fails
    const cut = t.trimStart().split(/[.,]/)[0];
    if (!/^[+-]?[0-9]+$/.test(cut)) return 0;
    const v = parseInt(cut, 10);
    return Number.isFinite(v) ? v : 0;
  }

  // EDIABAS writes float constants with either separator
  static parseNum(s) {
    if (s === undefined || s === null) return 0;
    const v = parseFloat(String(s).replace(',', '.'));
    return Number.isFinite(v) ? v : 0;
  }

  // OpFlt2A, ported faithfully: round to floatPrecision (default 4)
  // SIGNIFICANT digits (RoundToSignificantDigits, Math.Round = half-even),
  // format invariant, then CUT THE STRING after the Nth digit character --
  // including the engine's own quirk of truncating an exponent's digits.
  // JS shortest-roundtrip formatting ("0.30000000000000004") never appears:
  // the rounding and the cut both bound it.
  static fltText(value) {
    const digits = 4;                      // engine _floatPrecision default
    let v = Number(value);
    if (Number.isFinite(v) && v !== 0) {
      const scale = 10 ** (Math.floor(Math.log10(Math.abs(v))) + 1);
      const x = (v / scale) * 10 ** digits;
      let r = Math.round(x);               // JS rounds half toward +inf...
      if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) r -= 1;
      v = scale * (r / 10 ** digits);      // ...Math.Round is half to even
    }
    let s = String(v);
    const em = /^(-?[\d.]+)e([+-])(\d+)$/.exec(s);
    if (em) s = `${em[1]}E${em[2]}${em[3].padStart(2, '0')}`;
    let count = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] >= '0' && s[i] <= '9') {
        count++;
        if (count >= digits) { s = s.slice(0, i + 1); break; }
      }
    }
    return s;
  }
}

const STOP = Symbol('eoj');

// Loaded two ways: as a <script> in the app (globals) and via require() in
// tools/test_bestvm.js (module.exports). Both must work from one file.
if (typeof window !== 'undefined') {
  window.Best2Vm = Best2Vm;
  window.VmError = VmError;
  window.isWriteJob = isWriteJob;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Best2Vm, VmError, STOP, JUMP_TESTS, REG_BYTES,
                     isWriteJob, WRITE_JOB };
}
