// Coding WRITE by EXECUTING BMW's own per-CABD dispatcher -- piece 3 of 3
// (see the coding-dispatch-derived-json plan). Instead of hand-sequencing
// SGBD jobs (the coding-write.js strategy switch, whose on-wire packet is
// wrong for real E46 modules), we run the derived A_<cabd> dispatcher program
// (tools/export/ipo_exec.py --coding, shape {procs, byid, coding}) on a small
// token interpreter, implementing the CDH host callbacks it calls. The
// dispatcher itself decides the job order, the arguments, and -- crucially --
// builds the wire packet through CDHBinBuf*/CDHGetApiJobData, so the 22-byte
// header rules (word-unit addresses, data at offset 0x15, the dual count
// fields, payload round-up, the record cap) come from executing BMW's code,
// not from us hand-guessing them.
//
// SAFETY. Reads run with the SGBD VM's write gate CLOSED; only the steps the
// dispatcher issues after we arm the write flag transmit a write job. The
// public entry (runCodingDispatch) refuses unless opts.confirmed is set by the
// UI, exactly like writeCoding. The caller still proves the write by re-read
// and keeps the pre-write backup (coding-write.js) -- this module replaces
// only HOW the write telegrams are produced, not those guardrails.
//
// AUTHENTICATION is an honest no-op: the SAUTH.DAT seed/key tables are not in
// the data set, so CDHCallAuthenticate/CDHAuthGetRandom return "no auth" and
// let the ECU decline at the wire rather than faking an unlock. E46 body/kombi
// coding does not gate on SecurityAccess.
//
// app/renderer/core/*.js style: browser global, no imports; dual-exported for
// require() so a headless test can drive it.

(function (root) {
  'use strict';

  // ---- values -------------------------------------------------------------
  // A CABD out-parameter is a reference: the callback writes its result back
  // through it. On the operand stack an out-ref is ['slot', sc, n]; a computed
  // value is itself; an unset slot reads as '' (INPA initialises globals to "").
  // A slot reference an out-param writes back through. It appears two ways in
  // the bytecode: an unset `var` read yields one, and -- for a CALL's out
  // params -- a `procref` (02 <kind> <n>) where kind 2 = local scope, 0/other
  // = global. Both normalise to ['slot', sc, n].
  function isRef(x) { return Array.isArray(x) && x[0] === 'slot'; }
  function mkRef(sc, n) { return ['slot', sc, n]; }
  function procrefToSlot(kind, n) { return mkRef(kind === 2 ? 2 : 0, n); }
  function truthy(v) {
    if (v == null || v === '' || v === false) return false;
    if (v === 0) return false;
    return true;
  }
  function asInt(v) {
    if (typeof v === 'number') return v | 0;
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^-?\d+$/.test(s)) return parseInt(s, 10);
      if (/^[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
    }
    return 0;
  }
  function asStr(v) {
    if (v == null) return '';
    if (isRef(v)) return '';
    return String(v);
  }

  // ---- the binary buffer (BinBuf) -----------------------------------------
  // CDHBinBufCreate/WriteByte/WriteWord/ReadByte/ReadWord/ToStr and the packet
  // the write job consumes. Word endianness follows the data-org byteFolge.
  function makeBinBuf() {
    return { bytes: [], size: 0 };
  }
  function binWriteByte(buf, pos, val) {
    buf.bytes[pos] = val & 0xff;
    if (pos + 1 > buf.size) buf.size = pos + 1;
  }
  function binWriteWord(buf, pos, val, lowFirst) {
    const lo = val & 0xff, hi = (val >> 8) & 0xff;
    if (lowFirst) { binWriteByte(buf, pos, lo); binWriteByte(buf, pos + 1, hi); }
    else { binWriteByte(buf, pos, hi); binWriteByte(buf, pos + 1, lo); }
  }
  function binReadByte(buf, pos) { return buf.bytes[pos] | 0; }
  function binReadWord(buf, pos, lowFirst) {
    const a = buf.bytes[pos] | 0, b = buf.bytes[pos + 1] | 0;
    return lowFirst ? (a | (b << 8)) : ((a << 8) | b);
  }
  function binToBytes(buf) {
    const out = [];
    for (let i = 0; i < buf.size; i++) out.push(buf.bytes[i] | 0);
    return out;
  }

  // ---- the CDH host -------------------------------------------------------
  //
  // Holds the state NCSEXPER's C layer held around a dispatch: the selected
  // SGBD, the data-org (word width / byte order), the netto slot table the
  // coding data lives in, the BinBufs, the system/cabd parameter stores, the
  // last EDIABAS result sets, and the error scratchpad. Its methods are the
  // CDH_* callbacks; the interpreter calls them by name.
  class CdhHost {
    constructor(opts) {
      this.sgbd = opts.sgbd || '';
      this.runJob = opts.runJob;         // async (sgbd, job, argText, {allowWrites}) -> sets
      this.allowWrites = false;          // armed only for the write steps
      this.slots = (opts.slots || []).map((s) => ({ ...s }));  // {addr,value,mask,flags}
      this.wortBreite = 1;
      this.byteFolge = 0;                // 0 = low byte first
      this.adrMode = 0;
      this.bufs = new Map();             // handle -> BinBuf
      this._nextBuf = 1;
      this.sys = new Map();              // CDHSetSystemData / GetSystemData
      this.cabdPar = new Map();          // CDHSetCabdPar / GetCabdPar
      this.lastSets = [];                // last runJob result sets
      this.err = 0;                      // error scratchpad
      this.ret = 0;                      // CDHSetReturnVal
      this.log = [];                     // ordered wire jobs, for the caller
      this.cursor = 0;                   // slot cursor for CDHGetApiJobData
    }

    lowFirst() { return this.byteFolge === 0; }

    // --- error scratchpad -------------------------------------------------
    CDHResetError() { this.err = 0; }
    CDHSetError(errNr) { this.err = asInt(errNr); }
    CDHTestError() { return this.err; }
    CDHSetReturnVal(v) { this.ret = asInt(v); }

    // --- param stores -----------------------------------------------------
    CDHSetSystemData(name, val) { this.sys.set(asStr(name), asStr(val)); return 0; }
    CDHGetSystemData(name) { return this.sys.get(asStr(name)) || ''; }
    CDHSetCabdPar(name, val) { this.cabdPar.set(asStr(name), asStr(val)); return 0; }
    CDHGetCabdPar(name) { return this.cabdPar.get(asStr(name)) || ''; }
    CDHSetCabdWordPar(name, val) { this.cabdPar.set(asStr(name), asInt(val)); return 0; }
    CDHGetCabdWordPar(name) { return asInt(this.cabdPar.get(asStr(name))); }

    // --- SG / data org ----------------------------------------------------
    CDHGetSgbdName() { return this.sgbd; }
    CDHSetDataOrg(wb, bf, am) {
      this.wortBreite = asInt(wb) || 1;
      this.byteFolge = asInt(bf);
      this.adrMode = asInt(am);
      return 0;
    }

    // --- BinBuf -----------------------------------------------------------
    CDHBinBufCreate() { const h = this._nextBuf++; this.bufs.set(h, makeBinBuf()); return h; }
    CDHBinBufDelete(h) { this.bufs.delete(asInt(h)); return 0; }
    CDHBinBufWriteByte(h, val, pos) { binWriteByte(this.bufs.get(asInt(h)), asInt(pos), asInt(val)); return 0; }
    CDHBinBufWriteWord(h, val, pos) { binWriteWord(this.bufs.get(asInt(h)), asInt(pos), asInt(val), this.lowFirst()); return 0; }
    CDHBinBufReadByte(h, pos) { return binReadByte(this.bufs.get(asInt(h)), asInt(pos)); }
    CDHBinBufReadWord(h, pos) { return binReadWord(this.bufs.get(asInt(h)), asInt(pos), this.lowFirst()); }
    CDHBinBufToStr(h) {
      const b = this.bufs.get(asInt(h));
      return b ? binToBytes(b).map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase() : '';
    }

    // --- the netto data pump ----------------------------------------------
    // CDHGetApiJobData builds ONE request chunk into a BinBuf: the 22-byte
    // header (data type, word width, byte order, addr mode, the byte-count at
    // 0x0D and word-count at 0x0F, the wire address in WORD units at 0x11) and
    // the payload starting at 0x15. It advances the slot cursor and returns
    // (bufSize, nrOfData) so the dispatcher's loop knows when the region is
    // exhausted. Header layout is BMW's, reproduced faithfully so the SGBD's
    // `len == 22 + N*wortBreite` check passes.
    CDHResetApiJobData() { this.cursor = 0; }
    CDHGetApiJobData(maxData, bufHandle) {
      const buf = this.bufs.get(asInt(bufHandle));
      if (!buf) return { bufSize: 0, nrOfData: 0 };
      const wb = this.wortBreite;
      const cap = Math.min(asInt(maxData) || 32, 32);   // BMW's record cap
      // gather up to `cap` consecutive unconsumed slots from the cursor
      const start = this.cursor;
      let n = 0;
      while (n < cap && start + n < this.slots.length
             && !(this.slots[start + n].flags & 2)) n++;
      if (n === 0) return { bufSize: 0, nrOfData: 0 };
      const startAddr = this.slots[start].addr;
      const payloadLen = n * wb;
      // header
      buf.bytes = []; buf.size = 0;
      binWriteByte(buf, 0, 1);                     // data type
      binWriteByte(buf, 1, wb);                    // word width
      binWriteByte(buf, 2, this.byteFolge);        // byte order
      binWriteByte(buf, 3, this.adrMode);          // addr mode
      for (let k = 4; k < 13; k++) binWriteByte(buf, k, 0);
      binWriteByte(buf, 13, payloadLen & 0xff);    // 0x0D byte count LE
      binWriteByte(buf, 14, (payloadLen >> 8) & 0xff);
      binWriteByte(buf, 15, n & 0xff);             // 0x0F word count LE
      binWriteByte(buf, 16, (n >> 8) & 0xff);
      const wireAddr = Math.floor(startAddr / wb); // WORD units on the wire
      binWriteByte(buf, 17, wireAddr & 0xff);      // 0x11 addr LE
      binWriteByte(buf, 18, (wireAddr >> 8) & 0xff);
      binWriteByte(buf, 19, 0); binWriteByte(buf, 20, 0);
      // payload at 0x15
      for (let k = 0; k < n; k++) {
        const s = this.slots[start + k];
        if (wb === 1) binWriteByte(buf, 21 + k, s.value & 0xff);
        else binWriteWord(buf, 21 + k * wb, s.value & 0xffff, this.lowFirst());
      }
      // mark consumed and record the distribution for the response
      this._pending = { start, n };
      for (let k = 0; k < n; k++) this.slots[start + k].flags |= 2;
      this.cursor = start + n;
      return { bufSize: 21 + payloadLen, nrOfData: n };
    }
    CDHCheckDataUsed() {
      return this.slots.every((s) => (s.flags & 2)) ? 0 : 1;
    }
    // response bytes (from a read job) back into the slot values, by index
    CDHBinBufToNettoData(bufHandle) {
      const buf = this.bufs.get(asInt(bufHandle));
      const pend = this._pending;
      if (!buf || !pend) return 0;
      const wb = this.wortBreite;
      for (let k = 0; k < pend.n; k++) {
        const s = this.slots[pend.start + k];
        s.value = wb === 1 ? binReadByte(buf, 21 + k)
          : binReadWord(buf, 21 + k * wb, this.lowFirst());
      }
      return 0;
    }

    // --- EDIABAS via CDH --------------------------------------------------
    CDHapiInit() { return 0; }
    CDHapiEnd() { return 0; }
    async CDHapiJob(ecu, job, para) {
      const sg = asStr(ecu) || this.sgbd;
      this.lastSets = await this.runJob(sg, asStr(job), asStr(para),
        { allowWrites: this.allowWrites });
      this.log.push({ job: asStr(job), sgbd: sg, kind: 'text' });
      return 0;
    }
    async CDHapiJobData(ecu, job, bufHandle) {
      const sg = asStr(ecu) || this.sgbd;
      const buf = this.bufs.get(asInt(bufHandle));
      const bytes = buf ? binToBytes(buf) : [];
      const argText = bytesToArgString(bytes);
      this.lastSets = await this.runJob(sg, asStr(job), argText,
        { allowWrites: this.allowWrites, binary: true });
      this.log.push({ job: asStr(job), sgbd: sg, kind: 'data', bytes: bytes.length });
      return 0;
    }
    CDHapiResultSets() { return this.lastSets.length; }
    CDHapiResultText(res, set) {
      const s = this.lastSets[asInt(set) - 1] || this.lastSets[0] || {};
      return asStr(s[asStr(res)]);
    }
    CDHapiResultInt(res, set) { return asInt(this.CDHapiResultText(res, set)); }
    CDHapiResultBinary(bufHandle, res, set) {
      // copy a result field's bytes into the buffer for a subsequent read/verify
      const buf = this.bufs.get(asInt(bufHandle));
      if (!buf) return 1;
      const s = this.lastSets[asInt(set) - 1] || this.lastSets[0] || {};
      const v = s[asStr(res)];
      const bytes = decodeHexField(asStr(v)) || [];
      buf.bytes = bytes.slice(); buf.size = bytes.length;
      return 0;
    }

    // --- CBD queries (data-driven; the caller preloads what the write needs)
    CDHCheckIdent() { return 0; }
    CDHGetNettoDataFromCbd() { return 0; }   // slots are supplied by the caller
    CDHGetFswDataFromCbd() { return 0; }
    CDHGetGrpDataFromCbd() { return 0; }

    // --- coding worklist: netto is resolved host-side, so these no-op ------
    CDHActivateFsw() { return 0; }
    CDHInactivateFsw() { return 0; }
    CDHActivateGrp() { return 0; }
    CDHInactivateGrp() { return 0; }
    CDHActivateAllFsw() { return 0; }
    CDHInactivateAllFsw() { return 0; }

    // --- authentication: honest no-op (see the header note) ---------------
    CDHCallAuthenticate() { return { responseLen: 0, retVal: 0 }; }
    CDHAuthGetRandom() { return { rndBin: '', rndAsc: '' }; }
  }

  // binary blob -> args string whose char codes ARE the bytes (matches
  // coding-write.js bytesToArgString / bestvm pary).
  function bytesToArgString(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b & 0xff);
    return s;
  }
  function decodeHexField(v) {
    const hex = String(v).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length < 2 || hex.length % 2) return null;
    const out = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }

  // Which callbacks return through an OUT-ref (result written back through the
  // last ref arg) vs return a value on the stack. Multi-out callbacks
  // (CDHGetApiJobData, CDHCallAuthenticate, CDHAuthGetRandom) return an object
  // spread across their out refs in signature order.
  const OUT_MULTI = {
    CDHGetApiJobData: ['bufSize', 'nrOfData'],   // plus dataType/retVal ignored
    CDHCallAuthenticate: ['responseLen'],
    CDHAuthGetRandom: ['rndBin', 'rndAsc'],
  };

  // Callbacks whose scalar return is the FIRST out-ref while later out-refs are
  // a retVal/status the dispatcher ignores. Without this, a getter with two out
  // params (value + retVal) writes nothing and its value-compare always fails
  // -- which is exactly how cabimain routes JOBNAME to the handler.
  const OUT_FIRST = new Set([
    'CDHGetSystemData', 'CDHGetCabdPar', 'CDHGetCabdWordPar',
    'CDHapiResultText', 'CDHapiResultInt', 'CDHapiResultSets',
    'CDHGetSgbdName', 'CDHTestError', 'CDHBinBufReadByte', 'CDHBinBufReadWord',
    'CDHBinBufToStr', 'CDHCheckDataUsed', 'CDHBinBufCreate',
  ]);

  // ---- the interpreter ----------------------------------------------------
  //
  // Executes the dispatcher's token stream (same token shapes ipovm.js runs),
  // routing `call` to the CDH host. Only the opcodes a dispatcher uses are
  // handled; anything else is a no-op (the write engine is arithmetic + calls +
  // branches, no screen/menu machinery).
  class Interp {
    constructor(exec, host) {
      this.procs = exec.procs || {};
      this.byidRaw = exec.byid || {};
      this.host = host;
      this.globals = new Map();
      this.budget = 200000;
      this.steps = 0;
    }
    byid(type, id) { return this.byidRaw[`${type}:${id}`]; }

    async run(proc) {
      const toks = this.procs[proc];
      if (!toks) throw new Error(`coding-dispatch: no proc ${proc}`);
      await this._exec(toks, new Map());
    }

    _read(t, frame) {
      const sc = t.sc == null ? 0 : t.sc;
      const v = sc === 0 ? this.globals.get(t.n) : frame.get(t.n);
      return v == null ? mkRef(sc, t.n) : v;
    }
    _write(sc, n, frame, val) {
      if (sc === 0) this.globals.set(n, val); else frame.set(n, val);
    }
    _writeRef(ref, frame, val) {
      if (!isRef(ref)) return;
      this._write(ref[1] === 0 ? 0 : ref[1], ref[2], frame, val);
    }

    async _exec(toks, frame, startAt = 0, stopAt = null) {
      const index = new Map();
      for (let i = 0; i < toks.length; i++) if (toks[i].at != null) index.set(toks[i].at, i);
      let end = stopAt == null ? toks.length : stopAt;
      for (let j = 0; j < toks.length && j < end; j++) {
        if (toks[j].op === 'unk') { end = j; break; }
      }
      let stack = [];
      let i = startAt;
      while (i < end) {
        if (++this.steps > this.budget) throw new Error('coding-dispatch: step budget');
        const t = toks[i];
        const op = t.op;
        if (op === 'frame') { stack = []; }
        else if (op === 'const') { stack.push(t.v); }
        else if (op === 'var') { stack.push(this._read(t, frame)); }
        else if (op === 'procref') {
          // A procref feeding a CALL is that call's out-param slot (kind 2 =
          // local). A procref feeding calluser is a real proc reference; but
          // the coding dispatchers only pass procrefs as call out-params, so
          // normalising to a slot ref is safe here.
          stack.push(procrefToSlot(t.kind, t.n));
        }
        else if (op === 'store') {
          const val = stack.length ? stack.pop() : '';
          this._write(t.sc == null ? 0 : t.sc, t.n, frame, val);
        } else if (op === 'binop') {
          const b = stack.pop(), a = stack.pop();
          stack.push(binop(t.name, a, b));
        } else if (op === 'jfalse') {
          const cond = stack.length ? stack.pop() : false;
          if (!truthy(cond)) { const nxt = index.has(t.to) ? index.get(t.to) : end; if (nxt >= end) return; i = nxt; continue; }
        } else if (op === 'jump') {
          const nxt = index.has(t.to) ? index.get(t.to) : end; if (nxt >= end) return; i = nxt; continue;
        } else if (op === 'call') {
          await this._call(t, stack, frame); stack = [];
        } else if (op === 'calluser') {
          await this._callUser(t, stack); stack = [];
        } else if (op === 'ret') {
          // In the A_ (coding dispatcher) dialect, 0e is a per-statement
          // terminator, not a function return -- cabimain has 14 of them but
          // returns once. It clears the operand stack and falls through; the
          // real end of a proc is `endproc` (0d) or the token end. Treating it
          // as a return here stopped cabimain at its first statement, so no
          // handler ever ran.
          stack = [];
        } else if (op === 'endproc') { return; }
        i += 1;
      }
    }

    async _callUser(t, stack) {
      const name = this.byid('func', t.n);
      if (!name || !this.procs[name]) return;
      const frame = new Map();
      stack.forEach((v, i) => frame.set(i, v));
      await this._exec(this.procs[name], frame);
    }

    async _call(t, stack, frame) {
      const name = t.name;
      const host = this.host;
      const fn = host[name];
      if (typeof fn !== 'function') return;      // unimplemented CDH slot: no-op
      // Split args into value-ins and out-refs by the CDH signature order.
      const sig = CDH_SIG[name] || [];
      // Args are the top `sig.length` stack entries in order.
      const args = sig.length ? stack.slice(-sig.length) : [];
      const ins = [];
      const outRefs = [];
      sig.forEach((dir, k) => {
        const a = args[k];
        if (dir === 'in') ins.push(a);
        else outRefs.push(a);
      });
      let result = fn.apply(host, ins);
      if (result && typeof result.then === 'function') result = await result;
      // distribute results to out-refs
      const multi = OUT_MULTI[name];
      if (multi && result && typeof result === 'object') {
        multi.forEach((key, k) => { if (outRefs[k] != null) this._writeRef(outRefs[k], frame, result[key]); });
      } else if (outRefs.length === 1 || OUT_FIRST.has(name)) {
        // scalar result -> the first out-ref.
        if (outRefs[0] != null) this._writeRef(outRefs[0], frame, result);
      }
      // The trailing out-ref of a CDH callback is its retVal (0 = success).
      // The dispatcher checks it (e.g. TestCDHFehler compares it to 0 and
      // exit()s on non-zero), so an unwritten retVal reads as a ref/non-zero
      // and aborts the whole dispatch. Set every not-yet-written out-ref to 0.
      const written = multi ? multi.length : ((outRefs.length === 1 || OUT_FIRST.has(name)) ? 1 : 0);
      for (let k = written; k < outRefs.length; k++) {
        if (outRefs[k] != null) this._writeRef(outRefs[k], frame, 0);
      }
      // callbacks with no out-ref (CDHapiJob etc.) push nothing.
    }
  }

  // ---- binop (subset the dispatcher uses) ---------------------------------
  function binop(name, a, b) {
    switch (name) {
      case 'add': return asInt(a) + asInt(b);
      case 'sub': return asInt(a) - asInt(b);
      case 'mul': return asInt(a) * asInt(b);
      case 'div': return asInt(b) ? (asInt(a) / asInt(b)) | 0 : 0;
      case 'eq': return eqv(a, b) ? 1 : 0;
      case 'ne': return eqv(a, b) ? 0 : 1;
      case 'lt': return asInt(a) < asInt(b) ? 1 : 0;
      case 'gt': return asInt(a) > asInt(b) ? 1 : 0;
      case 'le': return asInt(a) <= asInt(b) ? 1 : 0;
      case 'ge': return asInt(a) >= asInt(b) ? 1 : 0;
      case 'and': return truthy(a) && truthy(b) ? 1 : 0;
      case 'or': return truthy(a) || truthy(b) ? 1 : 0;
      case 'not': return truthy(a) ? 0 : 1;
      case 'bitand': return asInt(a) & asInt(b);
      case 'bitor': return asInt(a) | asInt(b);
      case 'bitxor': return asInt(a) ^ asInt(b);
      default: return 0;
    }
  }
  function eqv(a, b) {
    if (typeof a === 'string' || typeof b === 'string') return asStr(a) === asStr(b);
    return asInt(a) === asInt(b);
  }

  // Per-callback arg directions, from ipo_cdh's CABI.H signatures. Only the
  // callbacks a dispatcher actually calls need entries; the rest default to
  // "all in" (harmless, since unimplemented ones no-op).
  const CDH_SIG = {
    CDHapiInit: [], CDHapiEnd: [],
    CDHapiJob: ['in', 'in', 'in', 'in'],
    CDHapiJobData: ['in', 'in', 'in', 'in', 'in'],
    CDHapiResultText: ['out', 'in', 'in', 'in'],
    CDHapiResultInt: ['out', 'in', 'in'],
    CDHapiResultSets: ['out'],
    CDHapiResultBinary: ['in', 'in', 'in', 'out'],
    CDHSetReturnVal: ['in'],
    CDHSetSystemData: ['in', 'in', 'out'],
    CDHGetSystemData: ['in', 'out', 'out'],
    CDHSetCabdPar: ['in', 'in', 'out'],
    CDHGetCabdPar: ['in', 'out', 'out'],
    CDHSetCabdWordPar: ['in', 'in', 'out'],
    CDHGetCabdWordPar: ['in', 'out', 'out'],
    CDHGetSgbdName: ['out', 'out'],
    CDHSetDataOrg: ['in', 'in', 'in', 'out'],
    CDHResetApiJobData: [],
    CDHGetApiJobData: ['in', 'in', 'out', 'out', 'out', 'out'],
    CDHCheckDataUsed: ['out'],
    CDHBinBufToNettoData: ['in', 'out'],
    CDHBinBufCreate: ['out', 'out'],
    CDHBinBufDelete: ['in', 'out'],
    CDHBinBufWriteByte: ['in', 'in', 'in', 'out'],
    CDHBinBufWriteWord: ['in', 'in', 'in', 'out'],
    CDHBinBufReadByte: ['in', 'out', 'in', 'out'],
    CDHBinBufReadWord: ['in', 'out', 'in', 'out'],
    CDHBinBufToStr: ['in', 'out', 'out'],
    CDHResetError: [], CDHSetError: ['in', 'in', 'in', 'in', 'in'],
    CDHTestError: ['out'], CDHCheckIdent: ['in', 'in', 'in', 'out'],
    CDHGetNettoDataFromCbd: ['out'], CDHGetFswDataFromCbd: ['in', 'out'],
    CDHGetGrpDataFromCbd: ['in', 'out'],
    CDHActivateFsw: ['in', 'out'], CDHInactivateFsw: ['in', 'out'],
    CDHActivateGrp: ['in', 'out'], CDHInactivateGrp: ['in', 'out'],
    CDHActivateAllFsw: [], CDHInactivateAllFsw: [],
    CDHCallAuthenticate: ['in', 'in', 'in', 'in', 'in', 'in', 'in', 'out', 'out'],
    CDHAuthGetRandom: ['out', 'out'],
  };

  // ---- entry point --------------------------------------------------------
  //
  // runCodingDispatch(exec, opts) -> {ok, log, slots}
  //   exec        the derived dispatcher program {procs, byid, coding:true}
  //   opts.sgbd   the coding SGBD name
  //   opts.slots  the netto slot table [{addr, value, mask, flags}] to write
  //   opts.jobname   which cabimain jobname to run (default SG_CODIEREN)
  //   opts.runJob(sgbd, job, argText, {allowWrites, binary}) -> result sets
  //   opts.confirmed  REQUIRED true (the UI's write confirmation)
  //   opts.armWrite   called just before the write steps, returns/enables the
  //                   host's allowWrites (default: arm for the whole dispatch
  //                   after the initial ident/read; see note)
  async function runCodingDispatch(exec, opts = {}) {
    if (!opts.confirmed) {
      throw new Error('coding dispatch refused: opts.confirmed must be set');
    }
    if (typeof opts.runJob !== 'function') {
      throw new Error('coding dispatch refused: no runJob provided');
    }
    if (!exec || !exec.coding) {
      throw new Error('coding dispatch refused: not a coding-dispatcher program');
    }
    const host = new CdhHost({
      sgbd: opts.sgbd,
      slots: opts.slots || [],
      runJob: opts.runJob,
    });
    // The dispatcher's Cod handler reads (ident, coding index, current netto)
    // then writes. We arm the write gate for the whole handler: the read jobs
    // it issues are not write jobs, so they transmit fine with the gate open,
    // and only a write job (C_S_AUFTRAG / C_CHECKSUM / *_SCHREIBEN) is gated by
    // bestvm's classifier anyway. The caller still gates the WHOLE dispatch on
    // opts.confirmed above.
    host.allowWrites = true;
    // Seed the data-org from the CABD SPEICHERORG (exec.dataOrg / opts.dataOrg):
    // NCSEXPER's C layer sets it at CABD load, before the IPO runs, and the
    // dispatcher only re-sets it if it wants to override. Without this, a
    // word-mode module (E46 KMB, wortBreite 2) frames its packet as byte mode
    // and the SGBD rejects it (len != 22 + N*wortBreite).
    const org = opts.dataOrg || exec.dataOrg;
    if (org) host.CDHSetDataOrg(org.wortBreite, org.byteFolge, org.adrMode || 0);
    const interp = new Interp(exec, host);
    // cabimain routes by JOBNAME; seed it and run the router.
    host.CDHSetCabdPar('JOBNAME', opts.jobname || 'SG_CODIEREN');
    host.sys.set('JOBNAME', opts.jobname || 'SG_CODIEREN');
    const entry = interp.procs.cabimain ? 'cabimain'
      : (interp.procs.Cod ? 'Cod' : null);
    if (!entry) throw new Error('coding dispatch: no cabimain/Cod proc');
    await interp.run(entry);
    return { ok: host.err === 0 && host.ret === 0, err: host.err,
             ret: host.ret, log: host.log, slots: host.slots };
  }

  const api = {
    runCodingDispatch, CdhHost, Interp,
    _makeBinBuf: makeBinBuf, _bytesToArgString: bytesToArgString,
    _binWriteWord: binWriteWord, _binReadWord: binReadWord,
  };
  if (typeof root !== 'undefined') {
    root.runCodingDispatch = runCodingDispatch;
    root.codingDispatch = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
