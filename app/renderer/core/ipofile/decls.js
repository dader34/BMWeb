/**
 * @file Procedure declarations and the Constant Data metadata of an .IPO.
 *
 * Port of tools/decompile/ipo_disasm.py's find_decls / body_start and of
 * tools/decompile/ipo_source.py's _constant_data. A declaration is
 *
 *     <type u8> <name> \n <u32 id> \n [version] \n \x00 <u16 dwords>
 *
 * and it is the trailing block header that makes it one -- anchoring on that
 * is what separates real declarations from the tens of thousands of
 * name-shaped byte runs a file contains.
 */

/** Declaration type byte -> the table its id indexes. */
const IPOF_DECL_TYPES = {
  1: 'screen', 2: 'menu', 3: 'state', 4: 'statemachine', 5: 'func',
};

/**
 * Whether a byte can start a declaration name.
 *
 * @param {number} c Byte value.
 * @returns {boolean} True for A-Z, a-z or underscore.
 */
function ipofNameStart(c) {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
}

/**
 * Whether a byte can continue a declaration name.
 *
 * @param {number} c Byte value.
 * @returns {boolean} True for A-Z, a-z, 0-9 or underscore.
 */
function ipofNameChar(c) {
  return ipofNameStart(c) || (c >= 0x30 && c <= 0x39);
}

/**
 * Where a declaration's CODE begins.
 *
 * The version string between the id and the block is normally EMPTY (the two
 * newlines sit side by side). One shipped file fills it in, and those extra
 * bytes would put each of its procs three bytes into its own body, so the
 * field's real length is read rather than assumed.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} off Offset of the declaration's type byte.
 * @param {string} name The declared name.
 * @returns {number} The offset of the first code byte.
 */
function ipofBodyStart(data, off, name) {
  const i = off + 1 + name.length + 1 + 4;
  if (data[i] === 0x0a) {
    // a non-empty version string: skip its content, leave its newline
    for (let j = i + 1; j < Math.min(data.length, i + 64); j += 1) {
      if (data[j] === 0x0a) return j > i + 1 ? j : i + 1;
    }
  }
  return i + 1;
}

/**
 * Match one declaration at `at`, or null.
 *
 * The name length is bounded only by INPA's own limit: a 30-character cap
 * silently hides procs whose names are longer, and a minimum length hides the
 * one- and two-character procs some ECU families declare, whose bodies then
 * decode as garbage inside whichever proc preceded them.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} at Offset of the candidate type byte.
 * @returns {{off: number, typ: string, name: string, id: number}|null} The
 *   declaration, or null.
 */
function ipofMatchDecl(data, at) {
  const typ = IPOF_DECL_TYPES[data[at]];
  if (!typ) return null;
  let i = at + 1;
  if (!ipofNameStart(data[i])) return null;
  const nameLo = i;
  i += 1;
  while (i < data.length && i - nameLo <= 60 && ipofNameChar(data[i])) i += 1;
  if (data[i] !== 0x0a) return null;
  const name = ipofLatin1(data, nameLo, i);
  i += 1;
  if (i + 4 > data.length) return null;
  const id = ipofUint(data, i, 4);
  i += 4;
  if (data[i] !== 0x0a) return null;
  i += 1;
  // the optional version string, then the mandatory \x00 block header
  let j = i;
  const cap = Math.min(data.length, i + 33);
  while (j < cap && data[j] !== 0x0a) {
    if (data[j] < 0x20 || data[j] > 0x7e) return null;
    j += 1;
  }
  if (j >= cap || data[j] !== 0x0a) return null;
  if (data[j + 1] !== 0x00) return null;
  return { off: at, typ, name, id };
}

/**
 * Every procedure declaration in the code region.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} end End of the code region (the pool start or code end).
 * @returns {Array<{off: number, typ: string, name: string, id: number}>} The
 *   declarations, in file order.
 */
function ipofFindDecls(data, end) {
  const out = [];
  const cap = Math.min(end, data.length);
  for (let i = 0; i < cap; i += 1) {
    if (!IPOF_DECL_TYPES[data[i]]) continue;
    const d = ipofMatchDecl(data, i);
    // ids above this are not proc ids; the Python drops them the same way
    if (d && d.id <= 2000) out.push(d);
  }
  return out;
}

/**
 * The include list and the DLL import table from the Constant Data entries.
 *
 * The leading string entries are the `#include` names; any entry shaped like
 * `lib::Function:signature%...` is an import32 signature, and `dllcall #n`
 * names entry n.
 *
 * @param {Array<Array>} entries The pool entries.
 * @returns {{includes: string[], imports: Object<number, string>}} The include
 *   names in order, and imports by pool index.
 */
function ipofConstantData(entries) {
  const includes = [];
  for (const e of entries) {
    if (e[0] !== 's') break;
    includes.push(e[1]);
  }
  const imports = {};
  entries.forEach((e, i) => {
    if (e[0] === 's' && e[1].indexOf('::') >= 0 && e[1].indexOf('%') >= 0) {
      imports[i] = e[1].split('::')[1].split(':')[0];
    }
  });
  return { includes, imports };
}

/**
 * The include names as the Constant Data region lists them, read straight from
 * the bytes for the dialects whose pool did not decode.
 *
 * @param {Uint8Array} data The file bytes.
 * @returns {string[]} The include names.
 */
function ipofIncludesFromBytes(data) {
  const marker = [0x12].concat(Array.from('Constant Data').map((c) => c.charCodeAt(0)), [0x0a]);
  const hits = ipofFindAll(data, marker, 0, data.length);
  if (!hits.length) return [];
  const out = [];
  let i = hits[0] + marker.length;
  while (i < data.length && data[i] === 6) {
    const j = ipofFindNl(data, i + 1, data.length);
    if (j < 0) break;
    out.push(ipofLatin1(data, i + 1, j));
    i = j + 1;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipofFindDecls, ipofBodyStart, ipofConstantData, ipofIncludesFromBytes,
    IPOF_DECL_TYPES,
  };
}
