/**
 * @file The exec form -> real .IPO container bytes, the inverse of
 * ipofDecodeExec.
 *
 * exec.js reads an .IPO the way the VM does: it scans for declaration names,
 * walks each proc's tape and inlines the constant pool into every token. That
 * view is what the runtime runs, but it is not the file. The file is a plain
 * block container, and this module writes that container back:
 *
 *     HEADER   <u8 verHi> <u8 verLo> <magic> 0a
 *     BLOCK*   <u8 type> <name> 0a <u16 id> <u16 flags>
 *              <arg1> 0a <arg2> 0a <u8 marker> <u16 size> <payload>
 *
 * The payload grammar follows the block type: a code block is `size` 4-byte
 * little-endian words (opcode | op1<<8 | op2<<16), the global block is `size`
 * type bytes, the constant block is `size` typed literals, and a logic table is
 * `size` 12-byte rows. Blocks are self-delimiting, so the file tiles with no
 * gaps and no padding -- writing them back to back reproduces the input.
 *
 * WHERE THE EXEC AND THE CONTAINER DISAGREE
 *
 * The walker reports a screen's LINE and a menu's ITEM as tokens INSIDE the
 * enclosing proc, because that is how the tape reads. In the file they are
 * their own blocks, and the bytes the walker calls an "inline header" are that
 * block's header: `nr` is its flags, `label` its arg1, `keys` its arg2 and
 * `dwords` its size. Encoding therefore splits every proc at its ITEM / LINE
 * tokens and emits one block per piece, which is what puts those bytes back
 * where they came from.
 *
 * The few header fields the walker has no token for -- the container version,
 * the magic, each block's marker and the sub-block ids -- are carried on the
 * exec as `container` when it came from a file (ipofDecodeExec records them),
 * and defaulted from the corpus when it came from the compiler, which cannot
 * know them. IPOF_ENCODE_DEFAULTS documents each default and why it is safe.
 */

/** Block type bytes, as the container numbers them. */
const IPOF_BLOCK_SCREEN = 0x01;
const IPOF_BLOCK_MENU = 0x02;
const IPOF_BLOCK_STATEMACHINE = 0x03;
// 0x04 is the logic table; no declaration ever names one, so nothing here
// writes one from tokens -- a file that has one carries it in `container`.
const IPOF_BLOCK_FUNCTION = 0x05;
const IPOF_BLOCK_GLOBALDATA = 0x11;
const IPOF_BLOCK_CONSTANTDATA = 0x12;
const IPOF_BLOCK_SCREENFUNC = 0x21;
const IPOF_BLOCK_LINEFUNC = 0x22;
const IPOF_BLOCK_MENUITEMFUNC = 0x24;
const IPOF_BLOCK_STATEFUNC = 0x25;

/**
 * The exec's declaration kind -> the container's block type byte.
 *
 * decls.js labels type 3 "state" and type 4 "statemachine"; the container calls
 * type 3 STATEMACHINE and reserves 4 for a logic table, which never carries a
 * declaration name. Both of the decoder's spellings therefore map onto 3, so a
 * file decoded under either label re-encodes to the byte it was read from.
 */
const IPOF_KIND_BLOCK = {
  screen: IPOF_BLOCK_SCREEN,
  menu: IPOF_BLOCK_MENU,
  state: IPOF_BLOCK_STATEMACHINE,
  statemachine: IPOF_BLOCK_STATEMACHINE,
  func: IPOF_BLOCK_FUNCTION,
};

/**
 * The sub-block type a section of a proc of this kind gets.
 *
 * A screen's first section is its SCREENFUNC and every later one a LINEFUNC; a
 * menu's sections are MENUITEMFUNCs and a state machine's are STATEFUNCs. The
 * whole corpus follows that rule with no exception, which is what lets a file
 * whose sub-block types were never tokenised come back byte-exact.
 *
 * @param {number} parent The enclosing block's type byte.
 * @param {number} index The section's position within the proc, from 0.
 * @returns {number} The sub-block's type byte.
 */
function ipofSubBlockType(parent, index) {
  if (parent === IPOF_BLOCK_MENU) return IPOF_BLOCK_MENUITEMFUNC;
  if (parent === IPOF_BLOCK_STATEMACHINE) return IPOF_BLOCK_STATEFUNC;
  return index === 0 ? IPOF_BLOCK_SCREENFUNC : IPOF_BLOCK_LINEFUNC;
}

/**
 * Defaults for the container fields a compiled-from-source exec cannot know.
 *
 * A source file says nothing about the container it will live in, so these come
 * from the corpus: v5.0 is the dialect every current INPA ships and the one the
 * walker's builtin numbering matches, "TEST-Infotext" is the magic on 1788 of
 * the 1790 shipped files, and marker 0 is what every block but four carries.
 */
const IPOF_ENCODE_DEFAULTS = {
  verHi: 5,
  verLo: 0,
  magic: 'TEST-Infotext',
  marker: 0,
};

/** Pool type letters (the walker's `t`) -> the v5.x ValueType byte. */
const IPOF_TAG_VT5 = { b: 0x01, y: 0x02, i: 0x03, l: 0x04, d: 0x05, s: 0x06 };

/**
 * Pool type letters -> the v1.x ValueType byte.
 *
 * The v1.x dialect numbers its literals differently: string is 04 where v5 uses
 * 06, int is 02 where v5 uses 03. Encoding a v1 file with the v5 table would
 * write a pool INPA cannot read, so the version picks the table.
 */
const IPOF_TAG_VT1 = { b: 0x01, i: 0x02, l: 0x03, s: 0x04, d: 0x05 };

/**
 * The literal-type table a container version uses.
 *
 * @param {number} verHi The container's major version byte.
 * @returns {Object<string, number>} Type letter -> ValueType byte.
 */
function ipofVtTable(verHi) {
  return verHi === 1 ? IPOF_TAG_VT1 : IPOF_TAG_VT5;
}

/**
 * A growable byte sink with the writes the container needs.
 */
class IpofWriter {
  /** Start empty. */
  constructor() {
    this.buf = new Uint8Array(1024);
    this.len = 0;
  }

  /**
   * Make room for `n` more bytes.
   * @param {number} n How many bytes are about to be written.
   * @returns {void}
   */
  need(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /**
   * Append one byte.
   * @param {number} v The value; only the low 8 bits are written.
   * @returns {void}
   */
  u8(v) {
    this.need(1);
    this.buf[this.len] = v & 0xff;
    this.len += 1;
  }

  /**
   * Append a little-endian unsigned 16-bit word.
   * @param {number} v The value.
   * @returns {void}
   */
  u16(v) {
    this.u8(v);
    this.u8(v >> 8);
  }

  /**
   * Append a little-endian 32-bit word.
   * @param {number} v The value.
   * @returns {void}
   */
  u32(v) {
    this.u16(v);
    this.u16(v >>> 16);
  }

  /**
   * Append a little-endian IEEE754 double, the pool's `real`.
   * @param {number} v The value.
   * @returns {void}
   */
  f64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.raw(b);
  }

  /**
   * Append raw bytes.
   * @param {Uint8Array|number[]} b The bytes.
   * @returns {void}
   */
  raw(b) {
    this.need(b.length);
    for (let i = 0; i < b.length; i += 1) this.buf[this.len + i] = b[i] & 0xff;
    this.len += b.length;
  }

  /**
   * Append text as Latin-1, the encoding the container stores names and
   * literals in.
   *
   * A character above U+00FF has no Latin-1 byte. Writing a replacement would
   * put a different string in the file than the caller asked for, so it is an
   * error naming the text instead.
   *
   * @param {string} s The text.
   * @param {string} what What this string is, for the error message.
   * @returns {void}
   */
  latin1(s, what) {
    const str = String(s === undefined || s === null ? '' : s);
    this.need(str.length);
    for (let i = 0; i < str.length; i += 1) {
      const c = str.charCodeAt(i);
      if (c > 0xff) {
        throw new Error(
          `${what}: "${str}" holds a character the container cannot store ` +
            `(U+${c.toString(16).toUpperCase()}); .IPO text is Latin-1`
        );
      }
      this.buf[this.len + i] = c;
    }
    this.len += str.length;
  }

  /**
   * Append text then the 0x0a separator that terminates every container
   * string.
   * @param {string} s The text.
   * @param {string} what What this string is, for the error message.
   * @returns {void}
   */
  strz(s, what) {
    this.latin1(s, what);
    this.u8(0x0a);
  }

  /**
   * The bytes written so far.
   * @returns {Uint8Array} A copy sized to the content.
   */
  bytes() {
    return this.buf.slice(0, this.len);
  }
}

/**
 * Encode one instruction token back to its 4-byte word.
 *
 * This is the exact inverse of the walker's decode ladder: each branch there
 * recognised a (b0, b1) pair and read a u16, so each case here writes that pair
 * and that u16 back. `jump` and `jfalse` are the one place the token is not
 * self-contained -- the walker resolved the target to an absolute byte offset,
 * so the dword index has to be recomputed against the block the jump lives in.
 *
 * @param {IpofWriter} w The sink.
 * @param {Object} t The token.
 * @param {number} base The byte offset dword 0 of the enclosing block sits at.
 * @param {string} where The proc name, for error messages.
 * @returns {void}
 */
function ipofEncodeToken(w, t, base, where) {
  /**
   * Write one instruction word.
   * @param {number} b0 The opcode byte.
   * @param {number} b1 The first operand byte.
   * @param {number} u16 The second operand word.
   * @returns {void}
   */
  const word = (b0, b1, u16) => {
    w.u8(b0);
    w.u8(b1);
    w.u16(u16);
  };
  switch (t.op) {
    case 'const':
      word(0x01, 0x01, t.n);
      return;
    case 'var':
      word(t.ref ? 0x03 : 0x01, t.sc, t.n);
      return;
    case 'store':
      word(t.ref ? 0x07 : 0x06, t.sc, t.n);
      return;
    case 'decl': {
      const code = IPOF_DECL_LOCAL_CODE[t.type];
      if (code === undefined)
        throw new Error(`${where}: no local type byte for "${t.type}"`);
      word(0x08, code, 0);
      return;
    }
    case 'procref':
      word(0x02, t.kind, t.n);
      return;
    case 'binop':
      // the operator byte is the token's `n`, which the walker read from the
      // middle two bytes: b1 is its low half and the u16's low byte its high
      w.u8(0x09);
      w.u16(t.n);
      w.u8(0x00);
      return;
    case 'block':
      word(0x0a, 0x00, t.dwords);
      return;
    case 'jump':
    case 'jfalse': {
      const rel = (t.to - base) / 4;
      if (!Number.isInteger(rel) || rel < 0 || rel > 0xffff) {
        throw new Error(
          `${where}: a ${t.op} to byte ${t.to} is not a dword offset from ` +
            `block base ${base}; the exec's offsets are inconsistent`
        );
      }
      word(t.op === 'jump' ? 0x0a : 0x0b, 0x00, rel);
      return;
    }
    case 'ret':
      word(0x0e, 0x00, 0);
      return;
    case 'endproc':
      word(0x0d, 0x00, 0);
      return;
    case 'dllcall':
      word(0x0d, 0x01, t.n);
      return;
    case 'stmt':
      word(0x05, 0x00, t.n);
      return;
    case 'calluser':
      word(0x0c, 0x80, t.n);
      return;
    case 'call':
      word(0x0c, 0x81, t.n);
      return;
    case 'frame':
      // The walker matches b0 == 0x0f alone and never reads the operands, so
      // the token cannot say what they were. Zero is not a guess: every one of
      // the 582,688 frame instructions in the shipped corpus carries 0f 00
      // 00 00, so writing that back is what the format actually holds.
      word(0x0f, 0x00, 0);
      return;
    case 'unk': {
      // bytes the walker could not name, kept verbatim as hex
      const hex = String(t.bytes || '');
      if (!/^[0-9a-f]{8}$/i.test(hex))
        throw new Error(`${where}: an unk token carries no 4 bytes ("${hex}")`);
      for (let i = 0; i < 4; i += 1) w.u8(parseInt(hex.substr(i * 2, 2), 16));
      return;
    }
    case 'state':
      // `%NAME \n <u32 index> 0a`, sitting where a token would
      w.strz(t.name, `${where}: state label`);
      w.u32(t.index);
      w.u8(0x0a);
      return;
    default:
      throw new Error(`${where}: cannot encode a "${t.op}" token`);
  }
}

/** Local declaration type name -> its opcode-08 operand byte. */
const IPOF_DECL_LOCAL_CODE = (() => {
  const out = {};
  for (const k of Object.keys(IPOF_DECL_LOCALS))
    out[IPOF_DECL_LOCALS[k]] = Number(k);
  return out;
})();

/**
 * Split one proc's tokens into the blocks the container stores them as.
 *
 * Everything up to the first ITEM / LINE token is the proc's own block; each
 * ITEM / LINE token opens a new block whose header those token fields fill and
 * whose payload is the tokens that follow it.
 *
 * @param {Object[]} toks The proc's tokens.
 * @returns {Array<{head: Object|null, toks: Object[]}>} The pieces, the first
 *   of which is the proc's own body (`head` null).
 */
function ipofSplitSections(toks) {
  const out = [{ head: null, toks: [] }];
  for (const t of toks || []) {
    if (t.op === 'ITEM' || t.op === 'LINE') out.push({ head: t, toks: [] });
    else out[out.length - 1].toks.push(t);
  }
  return out;
}

/**
 * Write one block header and its code payload.
 *
 * @param {IpofWriter} w The sink.
 * @param {Object} b The block: type, name, id, flags, arg1, arg2, marker.
 * @param {Object[]} toks The tokens of its payload.
 * @param {string} where The proc name, for error messages.
 * @returns {void}
 */
function ipofWriteCodeBlock(w, b, toks, where) {
  w.u8(b.type);
  w.strz(b.name || '', `${where}: block name`);
  w.u16(b.id || 0);
  w.u16(b.flags || 0);
  w.strz(b.arg1 || '', `${where}: block arg1`);
  w.strz(b.arg2 || '', `${where}: block arg2`);
  w.u8(b.marker === undefined ? IPOF_ENCODE_DEFAULTS.marker : b.marker);
  // `size` counts dwords, and a state label is not one: it occupies the space
  // of a token but the container sizes the payload in 4-byte units, so the
  // count is the payload's byte length over 4 rather than the token count.
  const body = new IpofWriter();
  const base = 0;
  for (const t of toks) ipofEncodeToken(body, t, base, where);
  if (body.len % 4 !== 0) {
    throw new Error(
      `${where}: a block payload of ${body.len} bytes is not a whole number ` +
        'of instruction words'
    );
  }
  w.u16(body.len / 4);
  w.raw(body.bytes());
}

/**
 * Re-base a proc's jump targets onto its own block.
 *
 * The walker resolved every jump to an absolute file offset using the base it
 * was tracking; the encoder writes each block from zero, so the targets are
 * shifted by the block's own start. Doing it here keeps ipofEncodeToken a pure
 * per-token inverse.
 *
 * @param {Object[]} toks The tokens of one block's payload.
 * @param {number} origin The absolute offset the block's dword 0 sat at, or
 *   null when the exec carries no offsets.
 * @returns {Object[]} Tokens whose jump targets count from the block start.
 */
function ipofRebaseJumps(toks, origin) {
  if (origin === null || origin === undefined) return toks;
  return toks.map((t) => {
    if (t.op !== 'jump' && t.op !== 'jfalse') return t;
    return Object.assign({}, t, { to: t.to - origin });
  });
}

/**
 * The byte offset the first token of a token list sat at, or null.
 *
 * @param {Object[]} toks The tokens.
 * @returns {number|null} The offset, or null when none carries one.
 */
function ipofFirstAt(toks) {
  for (const t of toks) if (typeof t.at === 'number') return t.at;
  return null;
}

/**
 * Encode a constant pool entry.
 *
 * @param {IpofWriter} w The sink.
 * @param {Array} e The entry, `[typeLetter, value]`.
 * @param {Object<string, number>} vt Type letter -> ValueType byte.
 * @param {number} i The entry's index, for error messages.
 * @returns {void}
 */
function ipofWritePoolEntry(w, e, vt, i) {
  const tag = e[0];
  const v = e[1];
  const t = vt[tag];
  if (t === undefined)
    throw new Error(`constant ${i}: no ValueType for a "${tag}" literal`);
  w.u8(t);
  if (tag === 's') {
    w.strz(v, `constant ${i}`);
    return;
  }
  if (tag === 'd') {
    w.f64(Number(v));
    return;
  }
  if (tag === 'b' || tag === 'y') {
    w.u8(Number(v));
    return;
  }
  if (tag === 'i') {
    // An `int` slot is 16 bits. The compiler tags every whole-number literal
    // `int` without checking the range, so a source saying 65536 would be
    // written as 0 -- a different program, silently. Refusing it instead is
    // the only honest option: the caller must widen the literal.
    const n = Number(v);
    if (!Number.isInteger(n) || n < -0x8000 || n > 0xffff) {
      throw new Error(
        `constant ${i}: ${n} does not fit the container's 16-bit int; ` +
          'declare the literal as a long'
      );
    }
    w.u16(n);
    return;
  }
  if (tag === 'l') {
    w.u32(Number(v));
    return;
  }
  throw new Error(`constant ${i}: cannot encode a "${tag}" literal`);
}

/**
 * Rebuild the constant pool from the values the walker inlined into tokens.
 *
 * The exec has no pool array of its own: every `const` token carries its index
 * `n`, its type letter `t` and its value `v`. Collecting them by index
 * reconstructs the pool, and the entry count the header declares is the highest
 * index used plus one.
 *
 * @param {Object} exec The exec object.
 * @returns {Array<Array>} The pool entries by index.
 */
function ipofPoolFromTokens(exec) {
  const byIndex = [];
  for (const name of Object.keys(exec.procs || {})) {
    for (const t of exec.procs[name] || []) {
      if (t.op !== 'const') continue;
      if (byIndex[t.n] !== undefined) continue;
      let tag = t.t;
      // The compiler tags every whole-number literal `int` without checking
      // that it fits 16 bits, because the exec form holds a JS number and
      // never had to. The pool does have to, so a literal too big for an int
      // slot is stored in the 32-bit one; the value is what the script meant,
      // and the wider type is the only one that can hold it.
      if (tag === 'i') {
        const n = Number(t.v);
        if (Number.isInteger(n) && (n < -0x8000 || n > 0xffff)) tag = 'l';
      }
      byIndex[t.n] = [tag, t.v];
    }
  }
  for (let i = 0; i < byIndex.length; i += 1) {
    // an index no token referenced still needs a slot, or every later index
    // shifts; a zero int is the smallest filler that keeps the stream legal
    if (byIndex[i] === undefined) byIndex[i] = ['i', 0];
  }
  return byIndex;
}

/**
 * Encode an exec object as .IPO container bytes.
 *
 * When `exec.container` is present -- ipofDecodeExec records it for a file it
 * read -- its blocks are written back exactly as they were read, which makes
 * the round trip byte-exact. Without it the container is rebuilt from the
 * tokens alone and the missing header fields take IPOF_ENCODE_DEFAULTS, which
 * is the path a script compiled from source takes.
 *
 * @param {Object} exec The exec object from ipofDecodeExec or the compiler.
 * @param {Object} [opts] Options.
 * @param {number} [opts.verHi] Container major version.
 * @param {number} [opts.verLo] Container minor version.
 * @param {string} [opts.magic] Container magic string.
 * @returns {Uint8Array} The .IPO bytes.
 */
function ipofEncode(exec, opts) {
  const o = opts || {};
  const c = exec && exec.container ? exec.container : null;
  if (c && c.blocks) return ipofEncodeContainer(c, o);
  return ipofEncodeFromTokens(exec, o);
}

/**
 * Write a container the decoder recorded, block for block.
 *
 * @param {Object} c The recorded container.
 * @param {Object} o Options overriding the version and magic.
 * @returns {Uint8Array} The .IPO bytes.
 */
function ipofEncodeContainer(c, o) {
  const w = new IpofWriter();
  w.u8(o.verHi === undefined ? c.verHi : o.verHi);
  w.u8(o.verLo === undefined ? c.verLo : o.verLo);
  w.strz(o.magic === undefined ? c.magic : o.magic, 'the file magic');
  for (const b of c.blocks) {
    w.u8(b.type);
    w.strz(b.name || '', 'a block name');
    w.u16(b.id || 0);
    w.u16(b.flags || 0);
    w.strz(b.arg1 || '', 'a block arg1');
    w.strz(b.arg2 || '', 'a block arg2');
    w.u8(b.marker || 0);
    w.u16(b.size || 0);
    w.raw(b.payload);
  }
  return w.bytes();
}

/**
 * Build a container from the exec's tokens alone.
 *
 * @param {Object} exec The exec object.
 * @param {Object} o Options overriding the version and magic.
 * @returns {Uint8Array} The .IPO bytes.
 */
function ipofEncodeFromTokens(exec, o) {
  if (!exec || !exec.procs) throw new Error('ipofEncode: not an exec object');
  const verHi = o.verHi === undefined ? IPOF_ENCODE_DEFAULTS.verHi : o.verHi;
  const verLo = o.verLo === undefined ? IPOF_ENCODE_DEFAULTS.verLo : o.verLo;
  const magic = o.magic === undefined ? IPOF_ENCODE_DEFAULTS.magic : o.magic;
  const w = new IpofWriter();
  w.u8(verHi);
  w.u8(verLo);
  w.strz(magic, 'the file magic');
  // proc name -> its declared kind and id, from the byid table the exec carries
  const kindOf = {};
  const idOf = {};
  for (const key of Object.keys(exec.byid || {})) {
    const cut = key.indexOf(':');
    kindOf[exec.byid[key]] = key.slice(0, cut);
    idOf[exec.byid[key]] = Number(key.slice(cut + 1));
  }
  for (const name of Object.keys(exec.procs)) {
    const kind = kindOf[name] || 'func';
    const type = IPOF_KIND_BLOCK[kind];
    if (type === undefined)
      throw new Error(`${name}: no block type for a "${kind}" declaration`);
    const parts = ipofSplitSections(exec.procs[name]);
    parts.forEach((part, k) => {
      const head = part.head;
      const origin = ipofFirstAt(part.toks);
      const toks = ipofRebaseJumps(part.toks, origin);
      if (k === 0) {
        ipofWriteCodeBlock(
          w,
          {
            type,
            name,
            id: idOf[name] || 0,
            flags: 0,
            arg1: '',
            arg2: '',
            marker: IPOF_ENCODE_DEFAULTS.marker,
          },
          toks,
          name
        );
        return;
      }
      ipofWriteCodeBlock(
        w,
        {
          type: ipofSubBlockType(type, k - 1),
          name: '',
          id: 0,
          flags: head.nr || 0,
          arg1: head.label || '',
          arg2: head.keys || '',
          marker: IPOF_ENCODE_DEFAULTS.marker,
        },
        toks,
        name
      );
    });
  }
  // the global-slot type table, then the pool -- the order every file uses
  const globals = (exec.container && exec.container.globals) || [];
  w.u8(IPOF_BLOCK_GLOBALDATA);
  w.strz('Global Data', 'the global block name');
  w.u16(0);
  w.u16(0);
  w.strz('', 'the global block arg1');
  w.strz('', 'the global block arg2');
  w.u8(IPOF_ENCODE_DEFAULTS.marker);
  w.u16(globals.length);
  w.raw(globals);
  const pool = ipofPoolFromTokens(exec);
  const vt = ipofVtTable(verHi);
  const body = new IpofWriter();
  pool.forEach((e, i) => ipofWritePoolEntry(body, e, vt, i));
  w.u8(IPOF_BLOCK_CONSTANTDATA);
  w.strz('Constant Data', 'the constant block name');
  w.u16(0);
  w.u16(0);
  w.strz('', 'the constant block arg1');
  w.strz('', 'the constant block arg2');
  w.u8(IPOF_ENCODE_DEFAULTS.marker);
  w.u16(pool.length);
  w.raw(body.bytes());
  return w.bytes();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipofEncode,
    IpofWriter,
    ipofEncodeToken,
    ipofWritePoolEntry,
    ipofPoolFromTokens,
    ipofSplitSections,
    ipofSubBlockType,
    ipofVtTable,
    IPOF_ENCODE_DEFAULTS,
    IPOF_TAG_VT5,
    IPOF_TAG_VT1,
    IPOF_KIND_BLOCK,
  };
}
