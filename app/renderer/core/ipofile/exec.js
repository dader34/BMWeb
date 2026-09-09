/**
 * @file An .IPO's bytes -> the runnable `exec` object the ipovm consumes.
 *
 * The browser twin of tools/export/ipo_exec.py's export() over
 * tools/decompile/ipo_vm.py's VM: same decode, same proc bounds, same
 * {ecu, procs, byid} shape. The runtime cannot tell a dropped file's exec
 * from a shipped data/inpa-ir dump, which is the whole point -- a script the
 * user supplies runs through the identical path, wire policy included.
 */

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
    if (!apool) throw new Error(`${stem}: no constant pool -- not an INPA .IPO?`);
    pool = apool;
    ps = ipofCodeEnd(data, null);
    coding = true;
  }
  const codeEnd = ipofCodeEnd(data, ps);
  const decls = ipofFindDecls(data, codeEnd);
  if (decls.length < 3) throw new Error(`${stem}: no procedure declarations found`);
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
  if (!meta.includes.length) meta = { includes: ipofIncludesFromBytes(data), imports: meta.imports };
  return {
    ecu: stem,
    procs,
    byid,
    coding,
    includes: meta.includes,
    imports: meta.imports,
    unknown,
    bytes,
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
    menus: [], screens: [], funcs: [], machines: [],
  };
  const bucket = {
    menu: 'menus', screen: 'screens', func: 'funcs', statemachine: 'machines', state: 'machines',
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
    ipofDecodeExec, ipofInventory, ipofReadBytes, ipofIsCompiled, ipofIsSource,
    ipofIsInclude, ipofStem,
  };
}
