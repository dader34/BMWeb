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
 * @property {number} addr - byte address of the word in the coding region.
 * @property {number} value - unused (the data comes from the host's image).
 * @property {number} mask - the mask of the word's first byte.
 * @property {number[]} masks - one mask per byte of the word: which bits are
 *   the selection's own (0xFF throughout for a whole word).
 * @property {boolean[]} own - per byte of the word: selected itself, or only
 *   riding along in a word a neighbour is selected in.
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
 * @property {number} [bytes] - buffer length for a `data` job.
 * @property {number} [addr] - byte address of the request's first word.
 * @property {number} [words] - how many words the request carries.
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
  // the write job consumes.
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
  //
  // The request a coding job takes is BMW's "binary buffer": 21 header bytes,
  // the data, and a closing 0x03 -- 22 + N*wortBreite bytes in all. Checked by
  // running the coding SGBDs' own jobs offline: C_S_LESEN and C_C_LESEN answer
  // ERROR_BIN_BUFFER to a buffer one byte short, and the jobs read the byte
  // count at 0x0D (body module) or the word count at 0x0F (cluster), the
  // address at 0x11 and the data from 0x15.
  /** Offset of the data in a request or answer buffer. */
  const PACKET_DATA = 21;
  /** Bytes around the data: the 21-byte header and the closing 0x03. */
  const PACKET_OVERHEAD = 22;
  /** The byte that closes a buffer. */
  const PACKET_END = 0x03;
  /** Header offset of the mask, one byte per byte of a word: which bits of
   *  each word the request is about. */
  const HDR_MASK = 9;
  /** Header offset of the byte count (u16 LE). */
  const HDR_BYTE_COUNT = 13;
  /** Header offset of the word count (u16 LE). */
  const HDR_WORD_COUNT = 15;
  /** Header offset of the wire address in WORD units (u16 LE). */
  const HDR_ADDR = 17;
  /** The most records one request carries when the script names no limit. */
  const RECORD_CAP = 32;
  /** Slot flag: consumed by CDHGetApiJobData. */
  const SLOT_CONSUMED = 2;
  /** CDH return value: fine. */
  const CDH_OK = 0;
  /** CDH return value: the coding description does not know that name. */
  const CDH_UNKNOWN_NAME = 1;
  /** CDH return value: the module's coding index is not this description's. */
  const CDH_WRONG_INDEX = 2;
  /** Jobs whose buffer is a request to READ, or to check: nothing is written. */
  const NOT_A_WRITE = /LESEN|CHECKSUM|IDENT|STATUS/i;

  /**
   * The parts of a coding description (.Cxx) the script selects by name.
   * @typedef {Object} CabdLayout
   * @property {Array<{name: string, word: number, byte: number, block?: number}>} fields -
   *   every function: its byte address and length.
   * @property {Array<{name: string, start: number, length: number, block?: number}>} [groups] -
   *   the named blocks (CODIERDATENBLOCK and its siblings).
   * @property {number[]} [codingIndex] - the coding indexes this description serves.
   * @property {'FREI'|'BLOCK'} [typ] - SPEICHERORG's TYP: one address space, or
   *   numbered blocks each with their own.
   */

  // ---- the CDH host -------------------------------------------------------

  /**
   * The state NCSEXPER's C layer held around a dispatch, plus the CDH_*
   * callbacks the dispatcher calls by name.
   *
   * WHAT GETS SENT. The script never names an address. It switches functions
   * and groups on and off (CDHActivate*, CDHInactivate*) and then asks for
   * "the data" -- all that is switched on (CDHGetNettoDataFromCbd), one
   * function (CDHGetFswDataFromCbd) or one group (CDHGetGrpDataFromCbd) --
   * which CDHGetApiJobData then deals out a request at a time. So the host
   * holds the module's whole image and a per-byte "switched on" map:
   *
   *   - the image is what the module should hold afterwards: its coding
   *     region as just read, with the user's edits laid on;
   *   - "everything" (CDHActivateAllFsw) is the set of addresses the caller
   *     hands in. For a write that is the whole coding region -- every
   *     coding block of the description, as the factory tool sends it -- and
   *     never the manufacturer or reserved blocks; for a read, what is to be
   *     read. What the script then switches off is left out of it;
   *   - a function asked for by name is sent as it stands, changed or not:
   *     the cluster's script reads CODIERUNG_ERFOLGT and addresses its
   *     checksum job that way.
   */
  class CdhHost {
    /**
     * @param {{sgbd?: string, runJob: CdhRunJob, netto?: ArrayLike<number>,
     *   cabd?: CabdLayout, changed?: ArrayLike<number>, readAddrs?: ArrayLike<number>,
     *   systemData?: Record<string, string>, mode?: 'write'|'read'}} opts -
     *   the coding SGBD, the job runner, the image, the coding description,
     *   the byte addresses a write may send (`changed`: the coding region)
     *   or a read wants, and the system data the script asks for.
     */
    constructor(opts) {
      /** @type {string} the coding SGBD name */
      this.sgbd = opts.sgbd || '';
      /** @type {CdhRunJob} async (sgbd, job, argText, {allowWrites}) -> sets */
      this.runJob = opts.runJob;
      /** @type {boolean} armed only for the write steps */
      this.allowWrites = false;
      /** @type {'write'|'read'} */
      this.mode = opts.mode === 'read' ? 'read' : 'write';
      /** @type {Uint8Array} the module's image, one byte per address */
      this.netto = Uint8Array.from(opts.netto || []);
      /** @type {Uint8Array|null} what the module holds now, where known: a
       *  byte that rides along in a word without being part of the
       *  selection goes back as this, not as the edited image has it */
      this.held = opts.held ? Uint8Array.from(opts.held) : null;
      const size = this.netto.length;
      /** @type {CabdLayout} */
      this.cabd = opts.cabd || { fields: [] };
      /** @type {Map<string, Array<[number, number]>>} function -> [start, end) ranges */
      this.fieldRanges = new Map();
      /** @type {Map<string, Array<{start: number, masks: number[]}>>} function -> its bits, byte by byte */
      this.fieldMasks = new Map();
      for (const f of this.cabd.fields || []) {
        const key = String(f.name).toUpperCase();
        if (!this.fieldRanges.has(key)) {
          this.fieldRanges.set(key, []);
          this.fieldMasks.set(key, []);
        }
        const width = Math.max(1, f.byte | 0);
        this.fieldRanges.get(key).push([f.word | 0, (f.word | 0) + width]);
        const masks = [];
        for (let i = 0; i < width; i++) {
          masks.push(
            Array.isArray(f.masks) && i < f.masks.length
              ? f.masks[i] & 0xff
              : i === 0 && f.mask != null
                ? f.mask & 0xff
                : 0xff
          );
        }
        this.fieldMasks.get(key).push({ start: f.word | 0, masks });
      }
      /** @type {Map<string, Array<[number, number]>>} group -> [start, end) ranges */
      this.groupRanges = new Map();
      for (const g of this.cabd.groups || []) {
        const key = String(g.name).toUpperCase();
        if (!this.groupRanges.has(key)) this.groupRanges.set(key, []);
        this.groupRanges
          .get(key)
          .push([g.start | 0, (g.start | 0) + Math.max(0, g.length | 0)]);
      }
      /** @type {Uint8Array} what "everything" means: see the class note */
      this.everything = new Uint8Array(size);
      const all = this.mode === 'read' ? opts.readAddrs : opts.changed;
      for (const a of all || []) if (a >= 0 && a < size) this.everything[a] = 1;
      /** @type {Uint8Array} per byte: switched on? */
      this.on = Uint8Array.from(this.everything);
      /** @type {NettoSlot[]} the current selection, one slot per word */
      this.slots = [];
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
      for (const [k, v] of Object.entries(opts.systemData || {}))
        this.sys.set(k, String(v));
      /** @type {Set<string>} what the caller supplied about this car */
      this._given = new Set(this.sys.keys());
      /** @type {Map<string, string|number>} CDHSetCabdPar / GetCabdPar */
      this.cabdPar = new Map();
      /** @type {Array<Record<string, unknown>>} last runJob result sets */
      this.lastSets = [];
      /** @type {number} error scratchpad */
      this.err = 0;
      /** @type {string} the text recorded with the error */
      this.errInfo = '';
      /** @type {number} CDHSetReturnVal */
      this.ret = 0;
      /** @type {WireLogEntry[]} ordered wire jobs, for the caller */
      this.log = [];
      /** @type {number} slot cursor for CDHGetApiJobData */
      this.cursor = 0;
      /** @type {{start: number, n: number}|undefined} the chunk in flight */
      this._pending = undefined;
      /** @type {Set<number>} byte addresses a write job carried */
      this._written = new Set();
      /** @type {Set<number>} byte addresses a read filled in */
      this._read = new Set();
    }

    /**
     * Is the data-org low-byte-first?
     * @returns {boolean} true for byteFolge 0.
     */
    lowFirst() {
      return this.byteFolge === 0;
    }
    /** @returns {number[]} the byte addresses a write job carried, ascending. */
    writtenAddrs() {
      return Array.from(this._written).sort((x, y) => x - y);
    }
    /** @returns {number[]} the byte addresses a read filled in, ascending. */
    readAddrs() {
      return Array.from(this._read).sort((x, y) => x - y);
    }

    // --- error scratchpad -------------------------------------------------
    /** Clear the error scratchpad. @returns {void} */
    CDHResetError() {
      this.err = 0;
      this.errInfo = '';
    }
    /**
     * Record an error: number, the script file, the proc, the line and a text.
     * @param {unknown} errNr - the error number.
     * @param {unknown} [file] - the script's name.
     * @param {unknown} [proc] - the procedure.
     * @param {unknown} [line] - the line.
     * @param {unknown} [info] - what failed ("C_KMB46, C_S_AUFTRAG: ERROR_VERIFY").
     * @returns {void}
     */
    CDHSetError(errNr, file, proc, line, info) {
      // a script that records "an error" with an unset number still failed
      this.err = asInt(errNr) || -1;
      this.errInfo = [asStr(proc), asStr(info)].filter(Boolean).join(': ');
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
      // an unset variable arrives as a reference: that is not a 0
      this.ret = isRef(v) ? -1 : asInt(v);
    }

    // --- param stores -----------------------------------------------------
    /**
     * @param {unknown} name - key.
     * @param {unknown} val - value.
     * @returns {number} 0.
     */
    CDHSetSystemData(name, val) {
      const key = asStr(name);
      // What the caller supplied about THIS car outranks the script's
      // placeholders (the cluster's script seeds the central coding keys with
      // FFs before it asks for them).
      if (!this._given.has(key)) this.sys.set(key, asStr(val));
      return CDH_OK;
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
      return CDH_OK;
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
      return CDH_OK;
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
      return CDH_OK;
    }

    // --- BinBuf -----------------------------------------------------------
    // A BinBuf is plain memory of the PC the tool ran on: its words are
    // little-endian whatever the module's own byte order is. The cluster's
    // script patches its checksum request with CDHBinBufWriteWord(buf, 56, 5)
    // and (182, 7), and the job reads the low byte at 5 and 7 -- written
    // high-byte-first, the job asked the cluster to sum from address 0.
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
      return CDH_OK;
    }
    /**
     * @param {unknown} h - handle.
     * @param {unknown} val - byte.
     * @param {unknown} pos - position.
     * @returns {number} 0, or 1 for a bad handle.
     */
    CDHBinBufWriteByte(h, val, pos) {
      const buf = this.bufs.get(asInt(h));
      if (!buf) return CDH_UNKNOWN_NAME;
      binWriteByte(buf, asInt(pos), asInt(val));
      return CDH_OK;
    }
    /**
     * @param {unknown} h - handle.
     * @param {unknown} val - word.
     * @param {unknown} pos - position.
     * @returns {number} 0, or 1 for a bad handle.
     */
    CDHBinBufWriteWord(h, val, pos) {
      const buf = this.bufs.get(asInt(h));
      if (!buf) return CDH_UNKNOWN_NAME;
      binWriteWord(buf, asInt(pos), asInt(val), true);
      return CDH_OK;
    }
    /**
     * @param {unknown} h - handle.
     * @param {unknown} pos - position.
     * @returns {number} the byte.
     */
    CDHBinBufReadByte(h, pos) {
      const buf = this.bufs.get(asInt(h));
      return buf ? binReadByte(buf, asInt(pos)) : 0;
    }
    /**
     * @param {unknown} h - handle.
     * @param {unknown} pos - position.
     * @returns {number} the word.
     */
    CDHBinBufReadWord(h, pos) {
      const buf = this.bufs.get(asInt(h));
      return buf ? binReadWord(buf, asInt(pos), true) : 0;
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

    // --- what is switched on ------------------------------------------------
    /**
     * Switch a set of byte ranges on or off.
     * @param {Array<[number, number]>|undefined} ranges - [start, end) ranges.
     * @param {boolean} on - on or off.
     * @param {boolean} [whole] - on means "send as it stands" (a function
     *   asked for by name), not "send where it differs".
     * @returns {void}
     */
    _switch(ranges, on, whole) {
      for (const [start, end] of ranges || []) {
        for (let a = Math.max(0, start); a < end && a < this.on.length; a++)
          this.on[a] = on ? (whole ? 1 : this.everything[a]) : 0;
      }
    }
    /** Everything on (see the class note for what that is). @returns {number} 0. */
    CDHActivateAllFsw() {
      this.on = Uint8Array.from(this.everything);
      return CDH_OK;
    }
    /** Everything off. @returns {number} 0. */
    CDHInactivateAllFsw() {
      this.on = new Uint8Array(this.on.length);
      return CDH_OK;
    }
    // A name this coding index does not have is not an error here: one script
    // serves every index of a module and names functions only some of them
    // carry. The script asks CDHTestError afterwards, as BMW's does.
    /**
     * @param {unknown} name - the function.
     * @returns {number} 0.
     */
    CDHActivateFsw(name) {
      this._switch(this.fieldRanges.get(asStr(name).toUpperCase()), true);
      return CDH_OK;
    }
    /**
     * @param {unknown} name - the function.
     * @returns {number} 0.
     */
    CDHInactivateFsw(name) {
      this._switch(this.fieldRanges.get(asStr(name).toUpperCase()), false);
      return CDH_OK;
    }
    /**
     * @param {unknown} name - the group.
     * @returns {number} 0.
     */
    CDHActivateGrp(name) {
      this._switch(this.groupRanges.get(asStr(name).toUpperCase()), true);
      return CDH_OK;
    }
    /**
     * @param {unknown} name - the group.
     * @returns {number} 0.
     */
    CDHInactivateGrp(name) {
      this._switch(this.groupRanges.get(asStr(name).toUpperCase()), false);
      return CDH_OK;
    }

    // --- loading a selection ----------------------------------------------
    /**
     * Make the slot table from a per-byte map: one slot per word that has a
     * byte in it, in address order. In word mode the word goes as a whole --
     * its other byte from the image, which holds what the module holds.
     * @param {Uint8Array} map - per byte: wanted?
     * @param {Uint8Array} [bits] - per byte: which bits are the selection's
     *   own. Without it every word is whole (mask FF).
     * @returns {void}
     */
    _select(map, bits) {
      const wb = this.wortBreite;
      const words = new Set();
      for (let a = 0; a < map.length; a++) if (map[a]) words.add((a / wb) | 0);
      this.slots = Array.from(words)
        .sort((x, y) => x - y)
        .filter((w) => (w + 1) * wb <= this.netto.length)
        .map((w) => {
          const masks = [];
          const own = [];
          for (let k = 0; k < wb; k++) {
            masks.push(bits ? bits[w * wb + k] : 0xff);
            own.push(!!map[w * wb + k]);
          }
          return {
            addr: w * wb,
            value: 0,
            mask: masks[0],
            masks,
            own,
            flags: 0,
          };
        });
      this.cursor = 0;
      this._pending = undefined;
    }
    /**
     * Load everything that is switched on.
     * @returns {number} 0.
     */
    CDHGetNettoDataFromCbd() {
      this._select(this.on);
      return CDH_OK;
    }
    /**
     * Load what is switched on, to be READ (the script's CODIERDATEN_LESEN).
     * @returns {number} 0.
     */
    CDHGetNettoMaskFromCbd() {
      this._select(this.on);
      return CDH_OK;
    }
    /**
     * Load one function by name, as it stands.
     * @param {unknown} name - the function.
     * @returns {number} 0, or 1 when this coding index has no such function.
     */
    CDHGetFswDataFromCbd(name) {
      if (!this.fieldMasks.has(asStr(name).toUpperCase())) {
        this.errInfo = `no function ${asStr(name)} in this coding description`;
        return CDH_UNKNOWN_NAME;
      }
      // The request then says which bits of each word are this function's
      // (header 0x09). The cluster's checksum job stores its result through
      // that mask: with the whole word claimed it overwrote the "coding done"
      // flag that shares the checksum's word.
      const map = new Uint8Array(this.netto.length);
      const bits = new Uint8Array(this.netto.length);
      for (const { start, masks } of this.fieldMasks.get(
        asStr(name).toUpperCase()
      )) {
        for (let i = 0; i < masks.length && start + i < map.length; i++) {
          map[start + i] = 1;
          bits[start + i] |= masks[i];
        }
      }
      this._select(map, bits);
      return CDH_OK;
    }
    /**
     * Load one group by name: as much of it as is in "everything" (see the
     * class note).
     * @param {unknown} name - the group.
     * @returns {number} 0, or 1 when this coding index has no such group.
     */
    CDHGetGrpDataFromCbd(name) {
      const ranges = this.groupRanges.get(asStr(name).toUpperCase());
      if (!ranges) {
        this.errInfo = `no group ${asStr(name)} in this coding description`;
        return CDH_UNKNOWN_NAME;
      }
      const map = new Uint8Array(this.netto.length);
      for (const [start, end] of ranges)
        for (let a = start; a < end && a < map.length; a++)
          map[a] = this.everything[a];
      this._select(map);
      return CDH_OK;
    }
    /**
     * The module's coding index against the description's own list.
     * @param {unknown} what - 'CODIERINDEX' (other checks pass).
     * @param {unknown} value - what the module answered.
     * @returns {number} 0, or 2 when the description is for another index.
     */
    CDHCheckIdent(what, value) {
      const list = this.cabd.codingIndex;
      if (asStr(what).toUpperCase() !== 'CODIERINDEX' || !list || !list.length)
        return CDH_OK;
      const text = asStr(value).trim();
      const index = /^\d+$/.test(text) ? parseInt(text, 10) : NaN;
      if (list.includes(index)) return CDH_OK;
      this.errInfo = `the module's coding index is ${text || '(none)'}, this description is for ${list.join(', ')}`;
      return CDH_WRONG_INDEX;
    }

    // --- the netto data pump ----------------------------------------------
    /** Rewind the slot cursor. @returns {void} */
    CDHResetApiJobData() {
      this.cursor = 0;
      for (const s of this.slots) s.flags &= ~SLOT_CONSUMED;
    }
    /**
     * Build the next request from the selection: a run of words at
     * consecutive addresses, at most `maxData` of them.
     * @param {unknown} maxData - the script's limit, in words.
     * @param {unknown} bufHandle - the BinBuf to build into.
     * @returns {{bufSize: number, nrOfData: number}} buffer length and word
     *   count; both 0 when the selection is used up.
     */
    CDHGetApiJobData(maxData, bufHandle) {
      const buf = this.bufs.get(asInt(bufHandle));
      this._pending = undefined;
      if (!buf) return { bufSize: 0, nrOfData: 0 };
      const wb = this.wortBreite;
      const cap = Math.max(1, asInt(maxData) || RECORD_CAP);
      const start = this.cursor;
      let n = 0;
      while (
        n < cap &&
        start + n < this.slots.length &&
        !(this.slots[start + n].flags & SLOT_CONSUMED) &&
        this.slots[start + n].addr === this.slots[start].addr + n * wb &&
        // one mask per request: a run ends where the mask changes
        String(this.slots[start + n].masks) === String(this.slots[start].masks)
      )
        n++;
      if (n === 0) return { bufSize: 0, nrOfData: 0 };
      const startAddr = this.slots[start].addr;
      const payloadLen = n * wb;
      buf.bytes = [];
      buf.size = 0;
      for (let k = 0; k < PACKET_DATA; k++) binWriteByte(buf, k, 0);
      binWriteByte(buf, 0, 1); // data type
      binWriteByte(buf, 1, wb); // word width
      binWriteByte(buf, 2, this.byteFolge); // byte order
      binWriteByte(buf, 3, this.adrMode); // addr mode
      for (let k = 0; k < wb; k++)
        binWriteByte(buf, HDR_MASK + k, this.slots[start].masks[k]);
      binWriteWord(buf, HDR_BYTE_COUNT, payloadLen, true);
      binWriteWord(buf, HDR_WORD_COUNT, n, true);
      binWriteWord(buf, HDR_ADDR, (startAddr / wb) | 0, true); // WORD units
      // The data: the image's bytes in address order. A word-organised module
      // stores a word's bytes at consecutive addresses in its own order, so
      // address order IS its byte order; the job sends them as they come.
      // A byte that is in a selected word without being selected itself (the
      // script switched its function off, its neighbour's not) goes as the
      // module holds it.
      for (let k = 0; k < payloadLen; k++) {
        const slot = this.slots[start + ((k / wb) | 0)];
        const a = startAddr + k;
        binWriteByte(
          buf,
          PACKET_DATA + k,
          slot.own[k % wb] || !this.held ? this.netto[a] : this.held[a]
        );
      }
      binWriteByte(buf, PACKET_DATA + payloadLen, PACKET_END);
      this._pending = { start, n };
      for (let k = 0; k < n; k++) this.slots[start + k].flags |= SLOT_CONSUMED;
      this.cursor = start + n;
      return { bufSize: PACKET_OVERHEAD + payloadLen, nrOfData: n };
    }
    /** @returns {number} 0 when the whole selection has been dealt out, else 1. */
    CDHCheckDataUsed() {
      return this.slots.every((s) => s.flags & SLOT_CONSUMED) ? CDH_OK : 1;
    }
    /**
     * An answer buffer (from a read job) into the image, for the request in
     * flight.
     * @param {unknown} bufHandle - the BinBuf holding the answer.
     * @returns {number} 0, or 1 when the answer is not the request's size.
     */
    CDHBinBufToNettoData(bufHandle) {
      const buf = this.bufs.get(asInt(bufHandle));
      const pend = this._pending;
      if (!buf || !pend) return 1;
      const wb = this.wortBreite;
      const want = pend.n * wb;
      if (buf.size < PACKET_DATA + want) {
        this.errInfo = `the answer holds ${Math.max(0, buf.size - PACKET_DATA)} data bytes, the request asked for ${want}`;
        return 1;
      }
      const startAddr = this.slots[pend.start].addr;
      for (let k = 0; k < want; k++) {
        this.netto[startAddr + k] = binReadByte(buf, PACKET_DATA + k);
        this._read.add(startAddr + k);
      }
      return CDH_OK;
    }

    // --- EDIABAS via CDH --------------------------------------------------
    /** @returns {number} 0. */
    CDHapiInit() {
      return CDH_OK;
    }
    /** @returns {number} 0. */
    CDHapiEnd() {
      return CDH_OK;
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
      return CDH_OK;
    }
    /**
     * Run a job whose argument is a BinBuf: its first `bufSize` bytes.
     * @param {unknown} ecu - module ('' = the coding SGBD).
     * @param {unknown} job - job name.
     * @param {unknown} bufHandle - the BinBuf to send.
     * @param {unknown} bufSize - how much of it is the argument.
     * @returns {Promise<number>} 0.
     */
    async CDHapiJobData(ecu, job, bufHandle, bufSize) {
      const sg = asStr(ecu) || this.sgbd;
      const name = asStr(job);
      const buf = this.bufs.get(asInt(bufHandle));
      let bytes = buf ? binToBytes(buf) : [];
      const size = isRef(bufSize) ? 0 : asInt(bufSize);
      if (size > 0) {
        bytes = bytes.slice(0, size);
        while (bytes.length < size) bytes.push(0);
      }
      const pend = this._pending;
      const carries = pend && !NOT_A_WRITE.test(name);
      this.lastSets = await this.runJob(sg, name, bytesToArgString(bytes), {
        allowWrites: this.allowWrites,
        binary: true,
      });
      if (carries) {
        // only the selection's own bytes count as written: one that rode
        // along went back as the module held it
        const wb = this.wortBreite;
        for (let i = 0; i < pend.n; i++) {
          const slot = this.slots[pend.start + i];
          for (let k = 0; k < wb; k++)
            if (slot.own[k]) this._written.add(slot.addr + k);
        }
      }
      this.log.push({
        job: name,
        sgbd: sg,
        kind: 'data',
        bytes: bytes.length,
        addr: pend ? this.slots[pend.start].addr : undefined,
        words: pend ? pend.n : undefined,
      });
      return CDH_OK;
    }
    /** @returns {number} how many result sets the last job returned. */
    CDHapiResultSets() {
      return this.lastSets.length;
    }
    /**
     * A result of the last job, from the set that carries it.
     * @param {unknown} res - result name.
     * @param {unknown} set - 1-based set index (falls back to any set).
     * @returns {unknown} the value, undefined when absent.
     */
    _result(res, set) {
      const key = asStr(res);
      const at = this.lastSets[asInt(set) - 1];
      if (at && at[key] != null) return at[key];
      for (const s of this.lastSets) if (s && s[key] != null) return s[key];
      return undefined;
    }
    /**
     * @param {unknown} res - result name.
     * @param {unknown} set - 1-based set index.
     * @returns {string} the result text, '' when absent.
     */
    CDHapiResultText(res, set) {
      return asStr(this._result(res, set));
    }
    /**
     * @param {unknown} res - result name.
     * @param {unknown} set - 1-based set index.
     * @returns {number} the result as an integer.
     */
    CDHapiResultInt(res, set) {
      const v = this._result(res, set);
      return typeof v === 'number' ? v | 0 : asInt(asStr(v));
    }
    /**
     * Copy a binary result into a buffer.
     * @param {unknown} bufHandle - the target BinBuf.
     * @param {unknown} res - result name.
     * @param {unknown} set - 1-based set index.
     * @returns {number} 0, or 1 for a bad handle or a missing result.
     */
    CDHapiResultBinary(bufHandle, res, set) {
      const buf = this.bufs.get(asInt(bufHandle));
      if (!buf) return 1;
      const v = this._result(res, set);
      // the VM hands a binary result over as its bytes; a text one is hex
      const bytes =
        v && typeof v === 'object' && typeof v.length === 'number'
          ? Array.from(/** @type {ArrayLike<number>} */ (v), (b) => b & 0xff)
          : decodeHexField(asStr(v));
      if (!bytes) {
        this.errInfo = `the job returned no ${asStr(res)}`;
        return 1;
      }
      buf.bytes = bytes.slice();
      buf.size = bytes.length;
      return CDH_OK;
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
  // CDHapiResultInt(value, result, set) has ONE out, the value: it is covered
  // by the single-out rule. CDHBinBufReadByte/ReadWord(buf, value, pos, ret)
  // are in the list above so the value lands in the first out, ret reads 0.

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
    CDHGetNettoMaskFromCbd: ['out'],
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
    PACKET_DATA,
    PACKET_OVERHEAD,
    PACKET_END,
  };
  if (typeof root !== 'undefined') root.CodingDispatchHost = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
