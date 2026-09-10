/**
 * @file An .IPO's bytes -> the runnable `exec` object the ipovm consumes.
 *
 * The browser twin of tools/export/ipo_exec.py's export() over
 * tools/decompile/ipo_vm.py's VM: same decode, same proc bounds, same
 * {ecu, procs, byid} shape. The runtime cannot tell a dropped file's exec
 * from a shipped data/inpa-ir dump, which is the whole point -- a script the
 * user supplies runs through the identical path, wire policy included.
 *
 * The token walk is a SCAN, not a parse: it hunts for declaration names and
 * infers proc bounds from where the next one starts. That is what the VM does
 * and what the shipped dumps were made with, so it stays. Alongside it,
 * ipofReadContainer reads the file the way its own header says to -- a plain
 * list of blocks -- and the result rides on the exec as `container` so
 * ipofEncode can put every byte back exactly where it was, including the
 * header fields no token has room for.
 */

/**
 * The block types whose payload is `size` 4-byte instruction words.
 * @type {Object<number, boolean>}
 */
const IPOF_CODE_BLOCKS = {
  0x01: true,
  0x02: true,
  0x03: true,
  0x05: true,
  0x21: true,
  0x22: true,
  0x23: true,
  0x24: true,
  0x25: true,
};

/**
 * How many bytes the constant pool's `size` entries occupy.
 *
 * The two dialects number their literals differently -- v1.x calls a string 04
 * and an int 02, v5.x calls them 06 and 03 -- so the version picks the widths.
 * Getting this wrong walks off the end of the pool and mis-frames every block
 * after it, which is why the version is threaded in rather than guessed.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} at The first pool byte.
 * @param {number} count How many entries the header declares.
 * @param {number} verHi The container's major version.
 * @returns {number} The pool's byte length.
 */
function ipofPoolLen(data, at, count, verHi) {
  const width =
    verHi === 1
      ? { 0x01: 1, 0x02: 2, 0x03: 4, 0x05: 8 }
      : {
          0x01: 1,
          0x02: 1,
          0x03: 2,
          0x04: 4,
          0x05: 8,
          0x07: 4,
          0x08: 4,
          0x09: 4,
        };
  const strTag = verHi === 1 ? 0x04 : 0x06;
  let i = at;
  for (let k = 0; k < count; k += 1) {
    if (i >= data.length) throw new Error('constant pool truncated');
    const t = data[i];
    i += 1;
    if (t === strTag) {
      const j = ipofFindNl(data, i, data.length);
      if (j < 0) throw new Error('unterminated pool string');
      i = j + 1;
      continue;
    }
    const n = width[t];
    if (n === undefined)
      throw new Error(`unknown constant type 0x${t.toString(16)}`);
    i += n;
  }
  return i - at;
}

/**
 * Read the .IPO as the block container it is.
 *
 * Every block is self-delimiting -- its header names the payload length -- so
 * the file tiles exactly, with no gaps and no padding. Reading it this way
 * keeps the fields the token walk has nowhere to put: each block's marker, its
 * id, and the type byte that says whether a screen's section is its SCREENFUNC
 * or one of its LINEFUNCs.
 *
 * @param {Uint8Array} data The file bytes.
 * @returns {{verHi: number, verLo: number, magic: string,
 *   blocks: Object[], globals: Uint8Array}|null} The container, or null when
 *   the bytes are not one.
 */
function ipofReadContainer(data) {
  try {
    if (data.length < 4) return null;
    const verHi = data[0];
    const verLo = data[1];
    const m = ipofFindNl(data, 2, data.length);
    if (m < 0) return null;
    const magic = ipofLatin1(data, 2, m);
    let i = m + 1;
    const blocks = [];
    let globals = new Uint8Array(0);
    while (i < data.length) {
      const type = data[i];
      i += 1;
      const n1 = ipofFindNl(data, i, data.length);
      if (n1 < 0) return null;
      const name = ipofLatin1(data, i, n1);
      i = n1 + 1;
      if (i + 4 > data.length) return null;
      const id = ipofUint(data, i, 2);
      const flags = ipofUint(data, i + 2, 2);
      i += 4;
      const n2 = ipofFindNl(data, i, data.length);
      if (n2 < 0) return null;
      const arg1 = ipofLatin1(data, i, n2);
      i = n2 + 1;
      const n3 = ipofFindNl(data, i, data.length);
      if (n3 < 0) return null;
      const arg2 = ipofLatin1(data, i, n3);
      i = n3 + 1;
      if (i + 3 > data.length) return null;
      const marker = data[i];
      const size = ipofUint(data, i + 1, 2);
      i += 3;
      let plen;
      if (IPOF_CODE_BLOCKS[type]) plen = size * 4;
      else if (type === 0x11) plen = size;
      else if (type === 0x04) plen = size * 12;
      else if (type === 0x12) plen = ipofPoolLen(data, i, size, verHi);
      else plen = size;
      if (i + plen > data.length) return null;
      const payload = data.subarray(i, i + plen);
      if (type === 0x11) globals = payload;
      blocks.push({
        type,
        name,
        id,
        flags,
        arg1,
        arg2,
        marker,
        size,
        payload,
      });
      i += plen;
    }
    return { verHi, verLo, magic, blocks, globals };
  } catch (err) {
    // a file that does not tile is not a container; the token scan still runs
    void err;
    return null;
  }
}

/**
 * Decode one .IPO into its runnable exec object.
 *
 * Proc bounds follow the VM, not the decompiler: `lo` is the fixed
 * declaration length (the VM does not read the optional version field) and
 * the last proc runs to the POOL start rather than to the code end, because
 * the shipped dumps were produced that way and the tokens have to match them.
 *
 * @param {Uint8Array} data The .IPO file bytes.
 * @param {string} stem The name to report as the exec's ecu.
 * @returns {{ecu: string, procs: Object<string, Object[]>, byid: Object<string,
 *   string>, includes: string[], imports: Object<number, string>,
 *   unknown: number, bytes: number}} The exec plus the metadata the report
 *   panel shows.
 */
function ipofDecodeExec(data, stem) {
  let { start: ps, entries: pool } = ipofFindPool(data);
  let coding = false;
  if (ps === null) {
    // The NCS coding dispatchers share this bytecode but encode their pool
    // differently and index the coding host table, not the screen builtins.
    // Decoding them keeps the reader complete and lets the app say what a
    // dropped file actually is instead of reporting an unreadable script.
    const apool = ipofAPool(data);
    if (!apool)
      throw new Error(`${stem}: no constant pool -- not an INPA .IPO?`);
    pool = apool;
    ps = ipofCodeEnd(data, null);
    coding = true;
  }
  const codeEnd = ipofCodeEnd(data, ps);
  const decls = ipofFindDecls(data, codeEnd);
  if (decls.length < 3)
    throw new Error(`${stem}: no procedure declarations found`);
  const procs = {};
  const byid = {};
  let unknown = 0;
  let bytes = 0;
  decls.forEach((d, k) => {
    // the VM's bounds, verbatim: no version-field probe, last proc ends at ps
    const lo = d.off + 1 + d.name.length + 1 + 4 + 1;
    const hi = k + 1 < decls.length ? decls[k + 1].off : ps;
    const r = ipofWalk(data, lo, hi, pool, coding ? IPOF_CDH_NAMES : null);
    procs[d.name] = r.toks;
    byid[`${d.typ}:${d.id}`] = d.name;
    unknown += r.unknown;
    bytes += r.len;
  });
  let meta = ipofConstantData(pool);
  if (!meta.includes.length)
    meta = { includes: ipofIncludesFromBytes(data), imports: meta.imports };
  return {
    ecu: stem,
    procs,
    byid,
    coding,
    includes: meta.includes,
    imports: meta.imports,
    unknown,
    bytes,
    // the file as its own header describes it, so it can be written back
    // unchanged; null when the bytes do not tile as a block container
    container: ipofReadContainer(data),
  };
}

/**
 * The exec's proc inventory, grouped for the parse report.
 *
 * @param {Object} exec An exec object from ipofDecodeExec or the compiler.
 * @returns {{menus: string[], screens: string[], funcs: string[],
 *   machines: string[]}} Proc names by kind, sorted.
 */
function ipofInventory(exec) {
  const out = {
    menus: [],
    screens: [],
    funcs: [],
    machines: [],
  };
  const bucket = {
    menu: 'menus',
    screen: 'screens',
    func: 'funcs',
    statemachine: 'machines',
    state: 'machines',
  };
  for (const key of Object.keys(exec.byid || {})) {
    const kind = key.split(':')[0];
    const b = bucket[kind];
    if (b) out[b].push(exec.byid[key]);
  }
  for (const k of Object.keys(out)) out[k] = out[k].slice().sort();
  return out;
}

/**
 * Read a file the user dropped or picked, as raw bytes.
 *
 * @param {File} file The browser File object.
 * @returns {Promise<Uint8Array>} Its bytes.
 */
function ipofReadBytes(file) {
  return file.arrayBuffer().then((buf) => new Uint8Array(buf));
}

/**
 * Whether a filename names a compiled script.
 *
 * @param {string} name The file name.
 * @returns {boolean} True for .ipo, either case.
 */
function ipofIsCompiled(name) {
  return /\.ipo$/i.test(name || '');
}

/**
 * Whether a filename names a script source the compiler accepts.
 *
 * @param {string} name The file name.
 * @returns {boolean} True for .ips or .src.
 */
function ipofIsSource(name) {
  return /\.(ips|src)$/i.test(name || '');
}

/**
 * Whether a filename names an include the compiler may need.
 *
 * @param {string} name The file name.
 * @returns {boolean} True for .h and for the .src files that carry bodies.
 */
function ipofIsInclude(name) {
  return /\.(h|src)$/i.test(name || '');
}

/**
 * A file name without its extension.
 *
 * @param {string} name The file name.
 * @returns {string} The stem.
 */
function ipofStem(name) {
  return String(name || 'script').replace(/\.[^.]*$/, '');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipofDecodeExec,
    ipofReadContainer,
    ipofPoolLen,
    ipofInventory,
    ipofReadBytes,
    ipofIsCompiled,
    ipofIsSource,
    ipofIsInclude,
    ipofStem,
  };
}
