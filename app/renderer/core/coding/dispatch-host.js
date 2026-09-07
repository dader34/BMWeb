/**
 * @file The CDH host: the state and callbacks BMW's coding dispatcher (the
 * derived A_<cabd> program) calls into while it sequences a coding write.
 * Published as the `CodingDispatchHost` global; the interpreter that drives it
 * lives in core/coding/dispatch.js.
 *
 * NCSEXPER's C layer held this state around a dispatch: the selected SGBD,
 * the data-org (word width / byte order), the netto slot table the coding
 * data lives in, the BinBufs, the system/cabd parameter stores, the last
 * EDIABAS result sets, and the error scratchpad. The CDH_* methods are the
 * callbacks; the interpreter calls them by name and routes their arguments by
 * the signature table at the bottom of this file.
 *
 * The wire packet is built HERE, by CDHGetApiJobData, exactly as BMW's code
 * builds it: the 22-byte header rules (word-unit addresses, data at offset
 * 0x15, the dual count fields, payload round-up, the record cap) come from
 * executing the dispatcher, not from hand-guessing them.
 *
 * AUTHENTICATION is an honest no-op: the SAUTH.DAT seed/key tables are not in
 * the data set, so CDHCallAuthenticate/CDHAuthGetRandom return "no auth" and
 * let the ECU decline at the wire rather than faking an unlock. E46 body/kombi
 * coding does not gate on SecurityAccess.
 */

/**
 * One netto byte (or word) the dispatcher will transmit.
 * @typedef {Object} NettoSlot
 * @property {number} addr - byte address in the coding region.
 * @property {number} value - the value to write (byte or word).
 * @property {number} mask - bit mask (0xFF for a whole byte).
 * @property {number} flags - bit 1 (0x2) = consumed by CDHGetApiJobData.
 */

/**
 * The data organisation the CABD's SPEICHERORG declares.
 * @typedef {Object} DataOrg
 * @property {number} wortBreite - word width in bytes (1 = byte mode, 2 = word).
 * @property {number} byteFolge - byte order: 0 = low byte first.
 * @property {number} [adrMode] - address mode (0 unless the CABD says otherwise).
 */

/**
 * A CDH job runner: runs one SGBD job over the bus and returns its result sets.
 * @callback CdhRunJob
 * @param {string} sgbd - the module to run against.
 * @param {string} job - the job name.
 * @param {string} argText - the job arguments (char codes ARE the bytes when
 *   `binary` is set).
 * @param {{allowWrites: boolean, binary?: boolean}} opts - the write gate
 *   for this call, and whether the argument is a binary blob.
 * @returns {Promise<Array<Record<string, string>>>} the result sets.
 */

/**
 * One wire job the dispatcher issued, for the caller's log.
 * @typedef {Object} WireLogEntry
 * @property {string} job - the job name.
 * @property {string} sgbd - the module it ran against.
 * @property {'text'|'data'} kind - text-argument job or binary-buffer job.
 * @property {number} [bytes] - payload length for a `data` job.
 */

/**
 * The growable byte buffer behind a CDHBinBuf* handle.
 * @typedef {Object} BinBuf
 * @property {number[]} bytes - the bytes, sparse until written.
 * @property {number} size - one past the highest written position.
 */

/**
 * A dispatcher out-parameter reference: `['slot', scope, index]`, scope 0 =
 * global, 2 = local frame.
 * @typedef {['slot', number, number]} SlotRef
 */

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
  /**
   * Is this stack value an out-parameter slot reference?
   * @param {unknown} x - a stack value.
   * @returns {x is SlotRef} true for a slot ref.
   */
  function isRef(x) {
    return Array.isArray(x) && x[0] === 'slot';
  }
  /**
   * Build a slot reference.
   * @param {number} sc - scope: 0 global, 2 local.
   * @param {number} n - slot index.
   * @returns {SlotRef} the reference.
   */
  function mkRef(sc, n) {
    return ['slot', sc, n];
  }
  /**
   * Normalise a `procref` token to a slot reference.
   * @param {number} kind - 2 = local scope, anything else = global.
   * @param {number} n - slot index.
   * @returns {SlotRef} the reference.
   */
  function procrefToSlot(kind, n) {
    return mkRef(kind === 2 ? 2 : 0, n);
  }
  /**
   * Dispatcher truthiness: null, '', false and 0 are false.
   * @param {unknown} v - a stack value.
   * @returns {boolean} truthiness.
   */
  function truthy(v) {
    if (v == null || v === '' || v === false) return false;
    if (v === 0) return false;
    return true;
  }
  /**
   * Coerce a stack value to an integer: numbers truncate, decimal strings
   * parse base 10, bare hex strings parse base 16, anything else is 0.
   * @param {unknown} v - a stack value.
   * @returns {number} the integer.
   */
  function asInt(v) {
    if (typeof v === 'number') return v | 0;
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^-?\d+$/.test(s)) return parseInt(s, 10);
      if (/^[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
    }
    return 0;
  }
  /**
   * Coerce a stack value to a string; null and unwritten refs read as ''.
   * @param {unknown} v - a stack value.
   * @returns {string} the string.
   */
  function asStr(v) {
    if (v == null) return '';
    if (isRef(v)) return '';
    return String(v);
  }

  // ---- the binary buffer (BinBuf) -----------------------------------------
  // CDHBinBufCreate/WriteByte/WriteWord/ReadByte/ReadWord/ToStr and the packet
  // the write job consumes. Word endianness follows the data-org byteFolge.
  /**
   * A fresh, empty BinBuf.
   * @returns {BinBuf} the buffer.
   */
  function makeBinBuf() {
    return { bytes: [], size: 0 };
  }
  /**
   * Write one byte, growing the buffer's size past `pos` when needed.
   * @param {BinBuf} buf - the buffer.
   * @param {number} pos - byte position.
   * @param {number} val - the byte (masked to 8 bits).
   * @returns {void}
   */
  function binWriteByte(buf, pos, val) {
    buf.bytes[pos] = val & 0xff;
    if (pos + 1 > buf.size) buf.size = pos + 1;
  }
  /**
   * Write one 16-bit word in the data-org's byte order.
   * @param {BinBuf} buf - the buffer.
   * @param {number} pos - byte position of the first byte.
   * @param {number} val - the word (masked to 16 bits).
   * @param {boolean} lowFirst - true for low byte first.
   * @returns {void}
   */
  function binWriteWord(buf, pos, val, lowFirst) {
    const lo = val & 0xff,
      hi = (val >> 8) & 0xff;
    if (lowFirst) {
      binWriteByte(buf, pos, lo);
      binWriteByte(buf, pos + 1, hi);
    } else {
      binWriteByte(buf, pos, hi);
      binWriteByte(buf, pos + 1, lo);
    }
  }
  /**
   * Read one byte (0 when unwritten).
   * @param {BinBuf} buf - the buffer.
   * @param {number} pos - byte position.
   * @returns {number} the byte.
   */
  function binReadByte(buf, pos) {
    return buf.bytes[pos] | 0;
  }
  /**
   * Read one 16-bit word in the data-org's byte order.
   * @param {BinBuf} buf - the buffer.
   * @param {number} pos - byte position of the first byte.
   * @param {boolean} lowFirst - true for low byte first.
   * @returns {number} the word.
   */
  function binReadWord(buf, pos, lowFirst) {
    const a = buf.bytes[pos] | 0,
      b = buf.bytes[pos + 1] | 0;
    return lowFirst ? a | (b << 8) : (a << 8) | b;
  }
  /**
   * The buffer's contents as a dense byte array up to its size.
   * @param {BinBuf} buf - the buffer.
   * @returns {number[]} the bytes.
   */
  function binToBytes(buf) {
    const out = [];
    for (let i = 0; i < buf.size; i++) out.push(buf.bytes[i] | 0);
    return out;
  }

  /**
   * Binary blob -> args string whose char codes ARE the bytes (matches the
   * write module's bytesToArgString / bestvm pary).
   * @param {ArrayLike<number>} bytes - the blob.
   * @returns {string} the argument string.
   */
  function bytesToArgString(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b & 0xff);
    return s;
  }
  /**
   * Decode a result field's hex text to bytes.
   * @param {string} v - the field text (separators ignored).
   * @returns {number[]|null} the bytes, or null when not an even run of hex.
   */
  function decodeHexField(v) {
    const hex = String(v).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length < 2 || hex.length % 2) return null;
    const out = [];
    for (let i = 0; i < hex.length; i += 2)
      out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }

  // ---- the wire packet ----------------------------------------------------
  /** Length of the request header CDHGetApiJobData builds; payload follows. */
  const PACKET_HEADER_LEN = 21;
  /** Header offset of the byte count (u16 LE). */
  const HDR_BYTE_COUNT = 13;
  /** Header offset of the word count (u16 LE). */
  const HDR_WORD_COUNT = 15;
  /** Header offset of the wire address in WORD units (u16 LE). */
  const HDR_ADDR = 17;
  /** BMW's record cap: at most this many slots per request chunk. */
  const RECORD_CAP = 32;
  /** Slot flag: consumed by CDHGetApiJobData. */
  const SLOT_CONSUMED = 2;

  // ---- the CDH host -------------------------------------------------------

  /**
   * The state NCSEXPER's C layer held around a dispatch, plus the CDH_*
   * callbacks the dispatcher calls by name.
   */
  class CdhHost {
    /**
     * @param {{sgbd?: string, runJob: CdhRunJob, slots?: NettoSlot[]}} opts -
     *   the coding SGBD, the job runner, and the netto slot table.
     */
    constructor(opts) {
      /** @type {string} the coding SGBD name */
      this.sgbd = opts.sgbd || '';
      /** @type {CdhRunJob} async (sgbd, job, argText, {allowWrites}) -> sets */
      this.runJob = opts.runJob;
      /** @type {boolean} armed only for the write steps */
      this.allowWrites = false;
      /** @type {NettoSlot[]} */
      this.slots = (opts.slots || []).map((s) => ({ ...s }));
      /** @type {number} word width in bytes */
      this.wortBreite = 1;
      /** @type {number} 0 = low byte first */
      this.byteFolge = 0;
      /** @type {number} address mode */
      this.adrMode = 0;
      /** @type {Map<number, BinBuf>} handle -> BinBuf */
      this.bufs = new Map();
      this._nextBuf = 1;
      /** @type {Map<string, string>} CDHSetSystemData / GetSystemData */
      this.sys = new Map();
      /** @type {Map<string, string|number>} CDHSetCabdPar / GetCabdPar */
      this.cabdPar = new Map();
      /** @type {Array<Record<string, string>>} last runJob result sets */
      this.lastSets = [];
      /** @type {number} error scratchpad */
      this.err = 0;
      /** @type {number} CDHSetReturnVal */
      this.ret = 0;
      /** @type {WireLogEntry[]} ordered wire jobs, for the caller */
      this.log = [];
      /** @type {number} slot cursor for CDHGetApiJobData */
      this.cursor = 0;
      /** @type {{start: number, n: number}|undefined} the chunk in flight */
      this._pending = undefined;
    }

    /**
     * Is the data-org low-byte-first?
     * @returns {boolean} true for byteFolge 0.
     */
    lowFirst() {
      return this.byteFolge === 0;
    }

    // --- error scratchpad -------------------------------------------------
    /** Clear the error scratchpad. @returns {void} */
    CDHResetError() {
      this.err = 0;
    }
    /**
     * Record an error number.
     * @param {unknown} errNr - the error number.
     * @returns {void}
     */
    CDHSetError(errNr) {
      this.err = asInt(errNr);
    }
    /** @returns {number} the current error number (0 = none). */
    CDHTestError() {
      return this.err;
    }
    /**
     * Record the dispatcher's return value.
     * @param {unknown} v - the value.
     * @returns {void}
     */
    CDHSetReturnVal(v) {
      this.ret = asInt(v);
    }

    // --- param stores -----------------------------------------------------
    /**
     * @param {unknown} name - key.
     * @param {unknown} val - value.
     * @returns {number} 0.
     */
    CDHSetSystemData(name, val) {
      this.sys.set(asStr(name), asStr(val));
      return 0;
    }
    /**
     * @param {unknown} name - key.
     * @returns {string} the value, '' when unset.
     */
    CDHGetSystemData(name) {
      return this.sys.get(asStr(name)) || '';
    }
    /**
     * @param {unknown} name - key.
     * @param {unknown} val - value.
     * @returns {number} 0.
     */
    CDHSetCabdPar(name, val) {
      this.cabdPar.set(asStr(name), asStr(val));
      return 0;
    }
    /**
     * @param {unknown} name - key.
     * @returns {string|number} the value, '' when unset.
     */
    CDHGetCabdPar(name) {
      return this.cabdPar.get(asStr(name)) || '';
    }
    /**
     * @param {unknown} name - key.
     * @param {unknown} val - value, stored as an integer.
     * @returns {number} 0.
     */
    CDHSetCabdWordPar(name, val) {
      this.cabdPar.set(asStr(name), asInt(val));
      return 0;
    }
    /**
     * @param {unknown} name - key.
     * @returns {number} the integer value, 0 when unset.
     */
    CDHGetCabdWordPar(name) {
      return asInt(this.cabdPar.get(asStr(name)));
    }

    // --- SG / data org ----------------------------------------------------
    /** @returns {string} the coding SGBD name. */
    CDHGetSgbdName() {
      return this.sgbd;
    }
    /**
     * Set the data organisation.
     * @param {unknown} wb - word width (defaults to 1).
     * @param {unknown} bf - byte order.
     * @param {unknown} am - address mode.
     * @returns {number} 0.
     */
    CDHSetDataOrg(wb, bf, am) {
      this.wortBreite = asInt(wb) || 1;
      this.byteFolge = asInt(bf);
      this.adrMode = asInt(am);
      return 0;
    }

    // --- BinBuf -----------------------------------------------------------
    /** @returns {number} a new buffer handle. */
    CDHBinBufCreate() {
      const h = this._nextBuf++;
      this.bufs.set(h, makeBinBuf());
      return h;
    }
    /**
     * @param {unknown} h - handle.
     * @returns {number} 0.
     */
    CDHBinBufDelete(h) {
      this.bufs.delete(asInt(h));
      return 0;
    }
    /**
     * @param {unknown} h - handle.
     * @param {unknown} val - byte.
     * @param {unknown} pos - position.
     * @returns {number} 0.
     */
    CDHBinBufWriteByte(h, val, pos) {
      binWriteByte(this.bufs.get(asInt(h)), asInt(pos), asInt(val));
      return 0;
    }
    /**
     * @param {unknown} h - handle.
     * @param {unknown} val - word.
     * @param {unknown} pos - position.
     * @returns {number} 0.
     */
    CDHBinBufWriteWord(h, val, pos) {
      binWriteWord(
        this.bufs.get(asInt(h)),
        asInt(pos),
        asInt(val),
        this.lowFirst()
      );
      return 0;
    }
    /**
     * @param {unknown} h - handle.
     * @param {unknown} pos - position.
     * @returns {number} the byte.
     */
    CDHBinBufReadByte(h, pos) {
      return binReadByte(this.bufs.get(asInt(h)), asInt(pos));
    }
    /**
     * @param {unknown} h - handle.
     * @param {unknown} pos - position.
     * @returns {number} the word.
     */
    CDHBinBufReadWord(h, pos) {
      return binReadWord(this.bufs.get(asInt(h)), asInt(pos), this.lowFirst());
    }
    /**
     * @param {unknown} h - handle.
     * @returns {string} the buffer as uppercase hex ('' for a bad handle).
     */
    CDHBinBufToStr(h) {
      const b = this.bufs.get(asInt(h));
      return b
        ? binToBytes(b)
            .map((x) => x.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase()
        : '';
    }

    // --- the netto data pump ----------------------------------------------
    // CDHGetApiJobData builds ONE request chunk into a BinBuf: the 22-byte
    // header (data type, word width, byte order, addr mode, the byte-count at
    // 0x0D and word-count at 0x0F, the wire address in WORD units at 0x11) and
    // the payload starting at 0x15. It advances the slot cursor and returns
    // (bufSize, nrOfData) so the dispatcher's loop knows when the region is
    // exhausted. Header layout is BMW's, reproduced faithfully so the SGBD's
    // `len == 22 + N*wortBreite` check passes.
    /** Rewind the slot cursor. @returns {void} */
    CDHResetApiJobData() {
      this.cursor = 0;
    }
    /**
     * Build the next request chunk from the unconsumed slots.
     * @param {unknown} maxData - the dispatcher's chunk cap (bounded by 32).
     * @param {unknown} bufHandle - the BinBuf to build into.
     * @returns {{bufSize: number, nrOfData: number}} packet length and slot
     *   count; both 0 when the region is exhausted.
     */
    CDHGetApiJobData(maxData, bufHandle) {
      const buf = this.bufs.get(asInt(bufHandle));
      if (!buf) return { bufSize: 0, nrOfData: 0 };
      const wb = this.wortBreite;
      const cap = Math.min(asInt(maxData) || RECORD_CAP, RECORD_CAP); // BMW's record cap
      // gather up to `cap` consecutive unconsumed slots from the cursor
      const start = this.cursor;
      let n = 0;
      while (
        n < cap &&
        start + n < this.slots.length &&
        !(this.slots[start + n].flags & SLOT_CONSUMED)
      )
        n++;
      if (n === 0) return { bufSize: 0, nrOfData: 0 };
      const startAddr = this.slots[start].addr;
      const payloadLen = n * wb;
      // header
      buf.bytes = [];
      buf.size = 0;
      binWriteByte(buf, 0, 1); // data type
      binWriteByte(buf, 1, wb); // word width
      binWriteByte(buf, 2, this.byteFolge); // byte order
      binWriteByte(buf, 3, this.adrMode); // addr mode
      for (let k = 4; k < HDR_BYTE_COUNT; k++) binWriteByte(buf, k, 0);
      binWriteByte(buf, HDR_BYTE_COUNT, payloadLen & 0xff); // 0x0D byte count LE
      binWriteByte(buf, HDR_BYTE_COUNT + 1, (payloadLen >> 8) & 0xff);
      binWriteByte(buf, HDR_WORD_COUNT, n & 0xff); // 0x0F word count LE
      binWriteByte(buf, HDR_WORD_COUNT + 1, (n >> 8) & 0xff);
      const wireAddr = Math.floor(startAddr / wb); // WORD units on the wire
      binWriteByte(buf, HDR_ADDR, wireAddr & 0xff); // 0x11 addr LE
      binWriteByte(buf, HDR_ADDR + 1, (wireAddr >> 8) & 0xff);
      binWriteByte(buf, HDR_ADDR + 2, 0);
      binWriteByte(buf, HDR_ADDR + 3, 0);
      // payload at 0x15
      for (let k = 0; k < n; k++) {
        const s = this.slots[start + k];
        if (wb === 1) binWriteByte(buf, PACKET_HEADER_LEN + k, s.value & 0xff);
        else
          binWriteWord(
            buf,
            PACKET_HEADER_LEN + k * wb,
            s.value & 0xffff,
            this.lowFirst()
          );
      }
      // mark consumed and record the distribution for the response
      this._pending = { start, n };
      for (let k = 0; k < n; k++) this.slots[start + k].flags |= SLOT_CONSUMED;
      this.cursor = start + n;
      return { bufSize: PACKET_HEADER_LEN + payloadLen, nrOfData: n };
    }
    /** @returns {number} 0 when every slot has been consumed, else 1. */
    CDHCheckDataUsed() {
      return this.slots.every((s) => s.flags & SLOT_CONSUMED) ? 0 : 1;
    }
    /**
     * Response bytes (from a read job) back into the slot values, by index of
     * the chunk in flight.
     * @param {unknown} bufHandle - the BinBuf holding the response.
     * @returns {number} 0.
     */
    CDHBinBufToNettoData(bufHandle) {
      const buf = this.bufs.get(asInt(bufHandle));
      const pend = this._pending;
      if (!buf || !pend) return 0;
      const wb = this.wortBreite;
      for (let k = 0; k < pend.n; k++) {
        const s = this.slots[pend.start + k];
        s.value =
          wb === 1
            ? binReadByte(buf, PACKET_HEADER_LEN + k)
            : binReadWord(buf, PACKET_HEADER_LEN + k * wb, this.lowFirst());
      }
      return 0;
    }

    // --- EDIABAS via CDH --------------------------------------------------
    /** @returns {number} 0. */
    CDHapiInit() {
      return 0;
    }
    /** @returns {number} 0. */
    CDHapiEnd() {
      return 0;
    }
    /**
     * Run a text-argument job.
     * @param {unknown} ecu - module ('' = the coding SGBD).
     * @param {unknown} job - job name.
     * @param {unknown} para - argument text.
     * @returns {Promise<number>} 0.
     */
    async CDHapiJob(ecu, job, para) {
      const sg = asStr(ecu) || this.sgbd;
      this.lastSets = await this.runJob(sg, asStr(job), asStr(para), {
        allowWrites: this.allowWrites,
      });
      this.log.push({ job: asStr(job), sgbd: sg, kind: 'text' });
      return 0;
    }
    /**
     * Run a job whose argument is a BinBuf's bytes.
     * @param {unknown} ecu - module ('' = the coding SGBD).
     * @param {unknown} job - job name.
     * @param {unknown} bufHandle - the BinBuf to send.
     * @returns {Promise<number>} 0.
     */
    async CDHapiJobData(ecu, job, bufHandle) {
      const sg = asStr(ecu) || this.sgbd;
      const buf = this.bufs.get(asInt(bufHandle));
      const bytes = buf ? binToBytes(buf) : [];
      const argText = bytesToArgString(bytes);
      this.lastSets = await this.runJob(sg, asStr(job), argText, {
        allowWrites: this.allowWrites,
        binary: true,
      });
      this.log.push({
        job: asStr(job),
        sgbd: sg,
        kind: 'data',
        bytes: bytes.length,
      });
      return 0;
    }
    /** @returns {number} how many result sets the last job returned. */
    CDHapiResultSets() {
      return this.lastSets.length;
    }
    /**
     * @param {unknown} res - result name.
     * @param {unknown} set - 1-based set index (falls back to set 1).
     * @returns {string} the result text, '' when absent.
     */
    CDHapiResultText(res, set) {
      const s = this.lastSets[asInt(set) - 1] || this.lastSets[0] || {};
      return asStr(s[asStr(res)]);
    }
    /**
     * @param {unknown} res - result name.
     * @param {unknown} set - 1-based set index.
     * @returns {number} the result as an integer.
     */
    CDHapiResultInt(res, set) {
      return asInt(this.CDHapiResultText(res, set));
    }
    /**
     * Copy a result field's bytes into a buffer for a subsequent read/verify.
     * @param {unknown} bufHandle - the target BinBuf.
     * @param {unknown} res - result name.
     * @param {unknown} set - 1-based set index.
     * @returns {number} 0, or 1 for a bad handle.
     */
    CDHapiResultBinary(bufHandle, res, set) {
      const buf = this.bufs.get(asInt(bufHandle));
      if (!buf) return 1;
      const s = this.lastSets[asInt(set) - 1] || this.lastSets[0] || {};
      const v = s[asStr(res)];
      const bytes = decodeHexField(asStr(v)) || [];
      buf.bytes = bytes.slice();
      buf.size = bytes.length;
      return 0;
    }

    // --- CBD queries (data-driven; the caller preloads what the write needs)
    /** @returns {number} 0. */
    CDHCheckIdent() {
      return 0;
    }
    /** Slots are supplied by the caller. @returns {number} 0. */
    CDHGetNettoDataFromCbd() {
      return 0;
    }
    /** @returns {number} 0. */
    CDHGetFswDataFromCbd() {
      return 0;
    }
    /** @returns {number} 0. */
    CDHGetGrpDataFromCbd() {
      return 0;
    }

    // --- coding worklist: netto is resolved host-side, so these no-op ------
    /** @returns {number} 0. */
    CDHActivateFsw() {
      return 0;
    }
    /** @returns {number} 0. */
    CDHInactivateFsw() {
      return 0;
    }
    /** @returns {number} 0. */
    CDHActivateGrp() {
      return 0;
    }
    /** @returns {number} 0. */
    CDHInactivateGrp() {
      return 0;
    }
    /** @returns {number} 0. */
    CDHActivateAllFsw() {
      return 0;
    }
    /** @returns {number} 0. */
    CDHInactivateAllFsw() {
      return 0;
    }

    // --- authentication: honest no-op (see the header note) ---------------
    /** @returns {{responseLen: number, retVal: number}} "no auth". */
    CDHCallAuthenticate() {
      return { responseLen: 0, retVal: 0 };
    }
    /** @returns {{rndBin: string, rndAsc: string}} empty seeds. */
    CDHAuthGetRandom() {
      return { rndBin: '', rndAsc: '' };
    }
  }

  // ---- out-parameter routing ----------------------------------------------

  /**
   * Callbacks that return an object spread across their out refs in
   * signature order (multi-out callbacks).
   * @type {Record<string, string[]>}
   */
  const OUT_MULTI = {
    CDHGetApiJobData: ['bufSize', 'nrOfData'], // plus dataType/retVal ignored
    CDHCallAuthenticate: ['responseLen'],
    CDHAuthGetRandom: ['rndBin', 'rndAsc'],
  };

  // Callbacks whose scalar return is the FIRST out-ref while later out-refs are
  // a retVal/status the dispatcher ignores. Without this, a getter with two out
  // params (value + retVal) writes nothing and its value-compare always fails
  // -- which is exactly how cabimain routes JOBNAME to the handler.
  /** @type {Set<string>} */
  const OUT_FIRST = new Set([
    'CDHGetSystemData',
    'CDHGetCabdPar',
    'CDHGetCabdWordPar',
    'CDHapiResultText',
    'CDHapiResultInt',
    'CDHapiResultSets',
    'CDHGetSgbdName',
    'CDHTestError',
    'CDHBinBufReadByte',
    'CDHBinBufReadWord',
    'CDHBinBufToStr',
    'CDHCheckDataUsed',
    'CDHBinBufCreate',
  ]);

  // Per-callback arg directions, from ipo_cdh's CABI.H signatures. Only the
  // callbacks a dispatcher actually calls need entries; the rest default to
  // "all in" (harmless, since unimplemented ones no-op).
  /** @type {Record<string, Array<'in'|'out'>>} */
  const CDH_SIG = {
    CDHapiInit: [],
    CDHapiEnd: [],
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
    CDHResetError: [],
    CDHSetError: ['in', 'in', 'in', 'in', 'in'],
    CDHTestError: ['out'],
    CDHCheckIdent: ['in', 'in', 'in', 'out'],
    CDHGetNettoDataFromCbd: ['out'],
    CDHGetFswDataFromCbd: ['in', 'out'],
    CDHGetGrpDataFromCbd: ['in', 'out'],
    CDHActivateFsw: ['in', 'out'],
    CDHInactivateFsw: ['in', 'out'],
    CDHActivateGrp: ['in', 'out'],
    CDHInactivateGrp: ['in', 'out'],
    CDHActivateAllFsw: [],
    CDHInactivateAllFsw: [],
    CDHCallAuthenticate: [
      'in',
      'in',
      'in',
      'in',
      'in',
      'in',
      'in',
      'out',
      'out',
    ],
    CDHAuthGetRandom: ['out', 'out'],
  };

  const api = {
    CdhHost,
    isRef,
    mkRef,
    procrefToSlot,
    truthy,
    asInt,
    asStr,
    makeBinBuf,
    binWriteByte,
    binWriteWord,
    binReadByte,
    binReadWord,
    binToBytes,
    bytesToArgString,
    decodeHexField,
    OUT_MULTI,
    OUT_FIRST,
    CDH_SIG,
  };
  if (typeof root !== 'undefined') root.CodingDispatchHost = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
