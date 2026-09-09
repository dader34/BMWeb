/**
 * @file The .IPO token walker, in JavaScript.
 *
 * Port of tools/decompile/ipo_disasm.py's walk() plus its BUILTINS and BINOPS
 * tables. Every token is 4 bytes except the inline LINE/ITEM headers and the
 * `%STATE` label, and every field this emits (op, n, sc, ref, kind, name, to,
 * at, t, v, label, nr, dwords, keys, type, index, bytes) matches the Python
 * name for name -- the shipped exec dumps are that walker's output, and the
 * runtime that consumes them cannot tell the two producers apart.
 */

/** Builtin call numbers to names, as the disassembler names them. */
const IPOF_BUILTINS = {
  0x00: 'setmenutitle',
  0x01: 'setmenu',
  0x02: 'setitem',
  0x03: 'settitle',
  0x04: 'setscreen',
  0x0c: 'exit',
  0x05: 'setstate',
  0x06: 'setstatemachine',
  0x0f: 'scriptchange',
  0x10: 'select',
  0x11: 'deselect',
  0x13: 'start',
  0x17: 'printscreen',
  0x18: 'printfile',
  0x1c: 'getdate',
  0x1d: 'gettime',
  0x1e: 'realtostring',
  0x1f: 'stringtoreal',
  0x20: 'inttostring',
  0x24: 'strlen',
  0x25: 'midstr',
  0x27: 'formatnum',
  0x28: 'bytetoint',
  0x29: 'inttolong',
  0x2a: 'longtoreal',
  0x3e: 'getinputstate',
  0x41: 'inputhex',
  0x42: 'inputdigital',
  0x43: 'input2text',
  0x44: 'input2hexnum',
  0x45: 'input2hex',
  0x46: 'inputint',
  0x48: 'text',
  0x49: 'textout',
  0x4a: 'ftextout',
  0x4b: 'digitalout',
  0x4c: 'analogout',
  0x4d: 'multianalogout',
  0x4e: 'hexdump',
  0x52: 'messagebox',
  0x54: 'userboxopen',
  0x55: 'userboxclose',
  0x56: 'userboxftextout',
  0x5b: 'callwin',
  0x5c: 'viewopen',
  0x5d: 'viewclose',
  0x79: 'fileopen',
  0x7a: 'fileclose',
  0x7b: 'filewrite',
  0x7c: 'fileread',
  0x60: 'INPAapiInit',
  0x61: 'INPAapiEnd',
  0x62: 'INPAapiJob',
  0x63: 'INPAapiResultText',
  0x64: 'INPAapiResultInt',
  0x65: 'INPAapiResultSets',
  0x66: 'INPAapiResultDigital',
  0x67: 'INPAapiResultAnalog',
  0x68: 'INPAapiResultBinary',
  0x69: 'INPAapiCheckJobStatus',
  0x6b: 'INPAapiFsLesen',
  0x6c: 'INPAapiFsMode',
  0x6f: 'INP1apiJob',
  0x71: 'INP1apiResultText',
  0x72: 'INP1apiResultInt',
  0x73: 'INP1apiResultSets',
  0x75: 'INP1apiResultBinary',
  0x76: 'INP1apiErrorCode',
  0x77: 'INP1apiErrorText',
  0x78: 'GetBinaryDataString',
  0x8c: 'StrArrayCreate',
  0x8d: 'StrArrayDestroy',
  0x8e: 'StrArrayWrite',
  0x8f: 'StrArrayRead',
  0x91: 'StrArrayDelete',
  0x9a: 'CreateStructure',
  0x9b: 'SetStructureMode',
  0x9c: 'StructureByte',
  0x9d: 'StructureInt',
  0x9e: 'StructureLong',
  0x9f: 'StructureString',
  // BMWeb's own builtins (app/renderer/home/bmweb.h): a script of the
  // app's own can ask the host for a pick and a status line. Numbered past
  // every number the INPA corpus uses, so a BMW script never collides.
  0xe0: 'bmweb_pick',
  0xe1: 'bmweb_status',
};

/** Binary operator opcodes to names. */
const IPOF_BINOPS = {
  0x60: 'add',
  0x61: 'sub',
  0x62: 'mul',
  0x63: 'div',
  0x64: 'lt',
  0x65: 'gt',
  0x66: 'le',
  0x67: 'ge',
  0x68: 'eq',
  0x69: 'ne',
  0x6a: 'and',
  0x6b: 'or',
  0x6c: 'xor',
  0x6d: 'neg',
  0x6e: 'not',
  0x6f: 'band',
  0x70: 'bor',
  0x71: 'bxor',
};

/** Local declaration type bytes (opcode 08). */
const IPOF_DECL_LOCALS = {
  0x50: 'bool',
  0x51: 'int',
  0x52: 'byte',
  0x53: 'long',
  0x54: 'real',
  0x55: 'string',
};

/**
 * Call names of the coding-dispatcher dialect (the `A_<cabd>` files).
 *
 * Same bytecode, a different host table: these files' calls index the coding
 * host, so decoding one with the screen table would name every call wrongly.
 * Carried so the reader reports a dropped coding file honestly rather than as
 * a screen script full of unknown builtins.
 * @type {Object<number, string>}
 */
const IPOF_CDH_NAMES = {
  0: 'settimer',
  1: 'testtimer',
  2: 'exit',
  3: 'realtostring',
  4: 'inttostring',
  5: 'hexconvert',
  6: 'strcat',
  7: 'strlen',
  8: 'midstr',
  11: 'CDHapiInit',
  12: 'CDHapiEnd',
  13: 'CDHapiJob',
  14: 'CDHapiJobData',
  15: 'CDHapiResultText',
  16: 'CDHapiResultInt',
  17: 'CDHapiResultSets',
  18: 'CDHapiResultDigital',
  19: 'CDHapiResultAnalog',
  20: 'CDHapiResultBinary',
  21: 'CDHapiCheckJobStatus',
  22: 'apiInit',
  23: 'apiEnd',
  24: 'apiJob',
  25: 'apiState',
  26: 'apiResultText',
  27: 'apiResultInt',
  28: 'apiResultSets',
  29: 'apiResultReal',
  30: 'apiErrorCode',
  31: 'apiErrorText',
  32: 'GetBinaryDataString',
  42: 'CDHGetFswPswFromZcs',
  43: 'CDHSetReturnVal',
  44: 'CDHSetSystemData',
  45: 'CDHGetSystemData',
  46: 'CDHSetCabdPar',
  47: 'CDHGetCabdPar',
  48: 'CDHGetFswPswFromCvt',
  49: 'CDHReadSget',
  50: 'CDHSetSgName',
  51: 'CDHGetSgbdName',
  52: 'CDHGetBaureiheFromZcs',
  53: 'CDHActivateFsw',
  54: 'CDHInactivateFsw',
  55: 'CDHActivateGrp',
  56: 'CDHInactivateGrp',
  57: 'CDHActivateAllFsw',
  58: 'CDHInactivateAllFsw',
  59: 'CDHChangePsw',
  60: 'CDHSaveFswPswList',
  61: 'CDHRestoreFswPswList',
  62: 'CDHSetCbdName',
  63: 'CDHGetInfo',
  64: 'CDHCheckIdent',
  65: 'CDHGetFswDataFromCbd',
  66: 'CDHGetFswPswDataFromCbd',
  67: 'CDHGetGrpDataFromCbd',
  68: 'CDHGetNettoDataFromCbd',
  69: 'CDHGetNettoMaskFromCbd',
  70: 'CDHGetFswPswFromNettoData',
  71: 'CDHResetApiJobData',
  72: 'CDHGetApiJobData',
  73: 'CDHCheckDataUsed',
  74: 'CDHBinBufToNettoData',
  75: 'CDHBinBufCreate',
  76: 'CDHBinBufDelete',
  77: 'CDHBinBufWriteByte',
  78: 'CDHBinBufWriteWord',
  79: 'CDHBinBufReadByte',
  80: 'CDHBinBufReadWord',
  81: 'CDHBinBufToStr',
  82: 'CDHResetError',
  83: 'CDHSetError',
  84: 'CDHTestError',
  85: 'CDHGetApiJobByteData',
  86: 'CDHSetCabdWordPar',
  87: 'CDHGetCabdWordPar',
  88: 'CDHGetReferenzProgramm',
  89: 'CDHGetReferenzDaten',
  91: 'CDHSetDataOrg',
  92: 'CDHIdReady',
  93: 'CDHCallAuthenticate',
  94: 'CDHGetFaVersion',
  95: 'CDHGetAnzahlFaElemente',
  96: 'CDHGetFaElement',
  97: 'CDHCheckIdent2',
  98: 'CDHAuthGetRandom',
};

/** LINE (21/22) and ITEM (24) headers carry their label inline. */
const IPOF_INLINE_OPS = { 0x21: 1, 0x22: 1, 0x24: 1 };

/**
 * Format a builtin's fallback name the way the Python's f-string does.
 *
 * @param {number} n The builtin number.
 * @returns {string} `builtin_xx`, two lowercase hex digits.
 */
function ipofBuiltinName(n) {
  const hex = n.toString(16);
  return `builtin_${hex.length < 2 ? `0${hex}` : hex}`;
}

/**
 * Try to read a `%STATE` label token at `i`.
 *
 * The token is `%NAME \n <u32 index> 0a`, and it sits where a 4-byte token
 * would. The '%' is part of the token: keying on the shape alone matches
 * pool markers inside ordinary format strings and swallows the instructions
 * after each.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} i Offset to read at.
 * @param {number} hi End of the proc body.
 * @returns {{tok: Object, next: number}|null} The token and the offset after
 *   it, or null when these bytes are not a label.
 */
function ipofReadState(data, i, hi) {
  if (data[i] !== 0x25) return null;
  const j = ipofFindNl(data, i + 1, Math.min(hi, i + 72));
  if (j < 0 || j === i) return null;
  for (let k = i; k < j; k += 1) {
    if (data[k] < 0x20 || data[k] >= 0x7f) return null;
  }
  if (!(j + 5 < hi && data[j + 5] === 0x0a)) return null;
  return {
    tok: {
      op: 'state',
      name: ipofLatin1(data, i, j),
      index: ipofUint(data, j + 1, 4),
      at: i,
    },
    next: j + 6,
  };
}

/**
 * Try to read an inline LINE / ITEM header at `i`.
 *
 * Layout: op + u16 0x000a + pad + u16 nr + caption \n + key list \n + pad +
 * u16 end-dword. LINE's second string is its result-key list, usually empty;
 * when empty the tail bytes look like an ordinary token, which is what makes
 * reading the second newline mandatory rather than optional.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} i Offset to read at.
 * @param {number} hi End of the proc body.
 * @returns {{tok: Object, next: number}|null} The token and the offset after
 *   it, or null.
 */
function ipofReadInline(data, i, hi) {
  const op = data[i];
  if (!IPOF_INLINE_OPS[op] || i + 6 > hi) return null;
  const nr = ipofUint(data, i + 4, 2);
  const j = ipofFindNl(data, i + 6, Math.min(hi, i + 220));
  if (j < 0) return null;
  const label = ipofLatin1(data, i + 6, j);
  const j2 = ipofFindNl(data, j + 1, Math.min(hi, j + 260));
  const second = j2 >= 0 ? ipofLatin1(data, j + 1, j2) : '';
  // +4, not +3: the end-dword u16 occupies data[j2+2:j2+4]
  if (!(j2 >= 0 && j2 + 4 <= hi)) return null;
  const tok = {
    op: op === 0x24 ? 'ITEM' : 'LINE',
    nr,
    label,
    dwords: ipofUint(data, j2 + 2, 2),
    at: i,
  };
  if (second) tok.keys = second;
  return { tok, next: j2 + 4 };
}

/**
 * The token stream of one proc body.
 *
 * Jump tokens carry `to`, the target resolved to a byte offset: targets are
 * dword indices relative to the ENCLOSING BLOCK (the proc body after its
 * header, or the bytes after the nearest ITEM/LINE header), which `base`
 * tracks.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} lo First byte of the body.
 * @param {number} hi End of the body, exclusive.
 * @param {Array<Array>} pool The constant pool entries.
 * @param {Object<number, string>} [names] Call-name table override, for the
 *   dialects that index a different host table.
 * @returns {{toks: Object[], unknown: number, len: number}} The tokens, the
 *   count of undecoded bytes, and the body length.
 */
function ipofWalk(data, lo, hi, pool, names) {
  const callNames = names || IPOF_BUILTINS;
  const toks = [];
  let unknown = 0;
  let i = lo;
  let base = lo + 4; // dword 0 of the proc's own block
  while (i < hi) {
    const start = i;
    const mark = toks.length;
    const st = ipofReadState(data, i, hi);
    if (st) {
      toks.push(st.tok);
      i = st.next;
      continue;
    }
    const inl = ipofReadInline(data, i, hi);
    if (inl) {
      toks.push(inl.tok);
      i = inl.next;
      base = i; // jumps inside this body count from here
      continue;
    }
    if (i + 4 > hi) {
      unknown += hi - i;
      break;
    }
    const b0 = data[i];
    const b1 = data[i + 1];
    const u16 = ipofUint(data, i + 2, 2);
    const mid = ipofUint(data, i + 1, 2);
    if (b0 === 0x01 && b1 === 0x01) {
      const v = u16 < pool.length ? pool[u16] : ['?', u16];
      toks.push({ op: 'const', n: u16, t: v[0], v: v[1] });
    } else if (b0 === 0x01 && (b1 === 0x00 || b1 === 0x02 || b1 === 0x03)) {
      toks.push({ op: 'var', n: u16, sc: b1 });
    } else if (b0 === 0x03 && (b1 === 0x00 || b1 === 0x02 || b1 === 0x03)) {
      // push THROUGH a reference param: reading an out/inout param's value
      toks.push({ op: 'var', n: u16, sc: b1, ref: true });
    } else if (b0 === 0x06 && b1 >= 0x00 && b1 <= 0x03) {
      toks.push({ op: 'store', n: u16, sc: b1 });
    } else if (b0 === 0x07 && (b1 === 0x00 || b1 === 0x02 || b1 === 0x03)) {
      toks.push({ op: 'store', n: u16, sc: b1, ref: true });
    } else if (b0 === 0x08 && IPOF_DECL_LOCALS[b1] && u16 === 0) {
      toks.push({ op: 'decl', type: IPOF_DECL_LOCALS[b1] });
    } else if (b0 === 0x02) {
      toks.push({ op: 'procref', kind: b1, n: u16 });
    } else if (b0 === 0x09) {
      // an unnamed operator keeps an explicit null: the Python's dict lookup
      // yields None and the field is present in every shipped dump, so a
      // JS `undefined` would drop the key and diverge
      toks.push({ op: 'binop', n: mid, name: IPOF_BINOPS[mid] || null });
    } else if (b0 === 0x0a && b1 === 0x00) {
      if (!toks.length) toks.push({ op: 'block', dwords: u16 });
      else toks.push({ op: 'jump', to: base + 4 * u16 });
    } else if (b0 === 0x0b && b1 === 0x00) {
      toks.push({ op: 'jfalse', to: base + 4 * u16 });
    } else if (b0 === 0x0e && b1 === 0x00 && u16 === 0) {
      toks.push({ op: 'ret' });
    } else if (b0 === 0x0d && b1 === 0x00 && u16 === 0) {
      toks.push({ op: 'endproc' });
    } else if (b0 === 0x0d && b1 === 0x01) {
      toks.push({ op: 'dllcall', n: u16 });
    } else if (b0 === 0x05 && b1 === 0x00) {
      toks.push({ op: 'stmt', n: u16 });
    } else if (b0 === 0x0c && b1 === 0x80) {
      toks.push({ op: 'calluser', n: u16 });
    } else if (b0 === 0x0c && b1 === 0x81) {
      toks.push({
        op: 'call',
        n: u16,
        name: callNames[u16] || ipofBuiltinName(u16),
      });
    } else if (b0 === 0x0f) {
      toks.push({ op: 'frame' });
    } else {
      let hex = '';
      for (let k = 0; k < 4; k += 1)
        hex += data[i + k].toString(16).padStart(2, '0');
      toks.push({ op: 'unk', bytes: hex });
      unknown += 4;
    }
    for (let k = mark; k < toks.length; k += 1) {
      if (toks[k].at === undefined) toks[k].at = start;
    }
    i += 4;
  }
  return { toks, unknown, len: hi - lo };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipofWalk,
    IPOF_BUILTINS,
    IPOF_BINOPS,
    IPOF_DECL_LOCALS,
    ipofBuiltinName,
    IPOF_CDH_NAMES,
  };
}
