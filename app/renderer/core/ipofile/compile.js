/**
 * @file Compiling an INPA source script (.IPS / .SRC) to a runnable exec.
 *
 * The front door over lex / parse / emit: it resolves `#include`s from the
 * files the user dropped alongside the script, builds the builtin-number table
 * the emitter needs, and reports what it could not do with the line to look at.
 *
 * INCLUDES ARE THE USER'S TO SUPPLY. A header declares the builtins
 * (`extern name(in: type a, out: type b)`) and the .SRC libraries carry
 * function bodies the compiled file must contain, but those are BMW's files:
 * they are not in this repo and never ship with it. A script that needs one it
 * did not get is a clear error naming the missing include, not a silent
 * half-compile.
 */

/** Builtin name -> number, inverted from the walker's table. */
const IPOF_BUILTIN_NUMS = (() => {
  const out = {};
  for (const k of Object.keys(IPOF_BUILTINS)) out[IPOF_BUILTINS[k]] = Number(k);
  return out;
})();

/**
 * The aliases the decompiler prints for builtins the walker leaves numbered.
 *
 * A round trip has to accept its own output, so every name the decompiler can
 * emit must compile back to the number it came from.
 * @type {Object<string, number>}
 */
const IPOF_ALIAS_NUMS = {
  settimer: 0x09,
  testtimer: 0x0a,
  control: 0x12,
  stop: 0x14,
  getapistring: 0x15,
  togglelist: 0x16,
  setcolor: 0x1a,
  stringtoint: 0x21,
  hexconvert: 0x22,
  strcat: 0x23,
  input2int: 0x47,
  blankscreen: 0x51,
  userboxclear: 0x57,
  userboxsetcolor: 0x58,
  INP1apiResultReal: 0x74,
  callstatemachine: 0x07,
  returnstatemachine: 0x08,
  setjobstatus: 0x0b,
  delay: 0x1b,
  inputnum: 0x39,
  inputtext: 0x3a,
  ftextclear: 0x4f,
  clearrect: 0x50,
  SPSInit: 0x92,
  SPSLeseVonSPS: 0x94,
  SPSSendeAnSPS: 0x95,
  ApiJobFsLesenFAB: 0x97,
  ApiResultFsLesenFAB: 0x98,
  ELDIOpenStartDialog: 0x99,
  setitemrepeat: 0xa1,
};

/**
 * Every builtin name the compiler can place, name -> number.
 * @returns {Object<string, number>} The table.
 */
function ipofBuiltinTable() {
  const out = Object.assign({}, IPOF_BUILTIN_NUMS, IPOF_ALIAS_NUMS);
  // a `builtin_2a` spelling is what the decompiler prints for anything with no
  // name at all, and it has to compile back to its own number
  for (let n = 0; n < 256; n += 1) out[ipofBuiltinName(n)] = n;
  return out;
}

/**
 * The parameter modes of every prototype an include declares.
 *
 * A builtin's `out:` / `inout:` parameters are passed BY REFERENCE, and the
 * bytecode says so with a different opcode: an out argument compiles to a
 * procref carrying the slot, not to an ordinary push. Without the prototypes
 * there is no way to know which argument that is, so a script whose headers
 * were not supplied cannot be compiled faithfully -- which is the other reason
 * the includes are required rather than optional.
 *
 * @param {Object<string, string>} files The dropped files, name -> text.
 * @returns {Object<string, string[]>} Function name -> parameter modes.
 */
function ipofScanPrototypes(files) {
  const out = {};
  for (const name of Object.keys(files || {})) {
    const text = String(files[name])
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const re = /(?:extern|import32|import)\b[^(;]*?(\w+)\s*\(([^)]*)\)\s*;/g;
    let m = re.exec(text);
    while (m) {
      const modes = [];
      const pre = /\b(in|out|inout)\s*:/g;
      let p = pre.exec(m[2]);
      while (p) {
        modes.push(p[1]);
        p = pre.exec(m[2]);
      }
      if (modes.length && !out[m[1]]) out[m[1]] = modes;
      m = re.exec(text);
    }
  }
  return out;
}

/**
 * The DLL functions the includes import, in declaration order.
 *
 * `import32 "C" lib "kernel32::GetPrivateProfileStringA" GetPrivateProfileString`
 * binds a Windows entry point to a name the script may call. The compiled file
 * numbers these per file and calls them by index, so the order they are
 * declared in IS the numbering -- a name the script calls but no include
 * imports has no number, and cannot be compiled.
 *
 * @param {Object<string, string>} files The dropped files, name -> text.
 * @returns {string[]} The imported names by index, carrying an `alias` map of
 *   DLL entry-point names to the script-side name that holds each slot.
 */
function ipofScanImports(files) {
  const out = [];
  // entry-point name -> the script-side name that holds the slot
  out.alias = {};
  for (const name of Object.keys(files || {})) {
    const text = String(files[name])
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // `import32 "C" lib "kernel32::Entry" Name (...)`: the name is what follows
    // the LIB string, so the calling convention's own quoted "C" has to be
    // stepped over rather than matched non-greedily past.
    const re = /import32\b[^\n]*?\blib\s+"([^"]*)"\s+(\w+)/g;
    let m = re.exec(text);
    while (m) {
      // Each import takes ONE slot -- the index is the number the call carries.
      // The DLL's own entry point is recorded as an alias of that slot, not as
      // a second one: a source the user wrote calls the script-side name, while
      // a source recovered from a compiled file names the entry point, because
      // that is all the import table holds. Both must reach the same number.
      const entry = m[1].indexOf('::') >= 0 ? m[1].split('::')[1] : '';
      if (out.indexOf(m[2]) < 0) {
        if (entry && entry !== m[2]) out.alias[entry] = m[2];
        out.push(m[2]);
      }
      m = re.exec(text);
    }
  }
  return out;
}

/**
 * The include names a source text asks for, in order.
 *
 * @param {string} src The source text.
 * @returns {string[]} The include names.
 */
function ipofScanIncludes(src) {
  const out = [];
  const re = /^[ \t]*#\s*include\s*"([^"]+)"/gm;
  let m = re.exec(src);
  while (m) {
    if (out.indexOf(m[1]) < 0) out.push(m[1]);
    m = re.exec(src);
  }
  return out;
}

/**
 * Whether an include only declares things (no bodies to compile in).
 *
 * A `.h` is prototypes and globals; a `.SRC` library carries function bodies
 * the compiled file must contain, so it is concatenated instead.
 *
 * @param {string} name The include name.
 * @returns {boolean} True for a declarations-only header.
 */
function ipofIsDeclOnly(name) {
  return /\.h$/i.test(name);
}

/**
 * Resolve a script and its includes into one source text.
 *
 * `.h` headers contribute their globals (so slot numbering matches) and their
 * prototypes; `.SRC` libraries contribute everything, bodies included, ahead of
 * the main file -- which is the order the compiled artifacts show.
 *
 * @param {string} src The main script's text.
 * @param {Object<string, string>} files The dropped files, name -> text; names
 *   are matched case-insensitively, as INPA's own tooling matches them.
 * @returns {{text: string, used: string[], missing: string[]}} The combined
 *   source, the includes that resolved, and the ones that did not.
 */
function ipofResolveIncludes(src, files) {
  const lower = {};
  for (const k of Object.keys(files || {})) lower[k.toLowerCase()] = files[k];
  /**
   * An include's text, matching on its base name.
   *
   * Scripts include their headers by relative path (`..\sgdat\inpa.h`), and a
   * dropped file has no path at all -- only its name. Matching the base name
   * is what lets the user drop the header next to the script, which is the
   * only way they can supply it.
   *
   * @param {string} name The include name as written.
   * @returns {string|undefined} The text, or undefined.
   */
  const find = (name) => {
    const key = name.toLowerCase();
    if (lower[key] !== undefined) return lower[key];
    const base = key.split(/[\\/]/).pop();
    return lower[base];
  };
  const used = [];
  const missing = [];
  const seen = {};
  const parts = [];
  /**
   * Pull one include in, depth first, so a nested include's globals land first.
   * @param {string} name The include name.
   * @returns {void}
   */
  const pull = (name) => {
    const key = name.toLowerCase().split(/[\\/]/).pop();
    if (seen[key]) return;
    seen[key] = true;
    const text = find(name);
    if (text === undefined) {
      missing.push(name);
      return;
    }
    used.push(name);
    for (const nested of ipofScanIncludes(text)) pull(nested);
    parts.push(ipofStripPrototypes(text, ipofIsDeclOnly(name)));
  };
  for (const name of ipofScanIncludes(src)) pull(name);
  parts.push(src.replace(/^[ \t]*#\s*include\s*"[^"]+"[ \t]*$/gm, ''));
  return { text: parts.join('\n'), used, missing };
}

/**
 * Drop the `extern` prototype lines from an include.
 *
 * A prototype declares a builtin's signature for the real compiler; this one
 * numbers builtins from its own tables, so the lines are noise the parser
 * would reject. A declarations-only header keeps its globals, which do matter:
 * they occupy the leading slots.
 *
 * @param {string} text The include's text.
 * @param {boolean} declOnly Whether the include is a `.h`.
 * @returns {string} The text the parser can take.
 */
function ipofStripPrototypes(text, declOnly) {
  // Newlines are preserved so a later error still names the line the user has
  // in front of them. A prototype runs to its semicolon and may span lines --
  // the import32 declarations put one parameter per line.
  let out = text.replace(
    /^[ \t]*(?:extern|import32|import)\b[\s\S]*?;/gm,
    (m) => m.replace(/[^\n]/g, ' ')
  );
  out = out.replace(/^[ \t]*#\s*include\s*"[^"]+"[ \t]*$/gm, '');
  void declOnly;
  return out;
}

/**
 * Compile an INPA source script into a runnable exec.
 *
 * @param {string} src The script's text.
 * @param {Object} [opts] Options.
 * @param {string} [opts.name] The stem to report as the exec's ecu.
 * @param {Object<string, string>} [opts.files] Includes the user supplied,
 *   name -> text.
 * @param {string[]} [opts.imports] DLL import names by index, when known.
 * @returns {{ok: boolean, exec: Object|null, errors: Object[], includes:
 *   string[], missing: string[]}} The result; `errors` carries a `line` and a
 *   ready-to-show `text` for each problem.
 */
function ipofCompileSource(src, opts) {
  const o = opts || {};
  const r = ipofResolveIncludes(src, o.files || {});
  const errors = [];
  for (const m of r.missing) {
    errors.push({
      line: 0,
      message: `missing include "${m}" -- drop it alongside the script`,
      text: `missing include "${m}" -- drop it alongside the script`,
    });
  }
  if (errors.length) {
    return {
      ok: false,
      exec: null,
      errors,
      includes: r.used,
      missing: r.missing,
    };
  }
  let ast;
  try {
    ast = ipofParse(r.text);
  } catch (err) {
    if (!(err instanceof IpofSyntaxError)) throw err;
    errors.push({ line: err.line, message: err.message, text: err.message });
    return {
      ok: false,
      exec: null,
      errors,
      includes: r.used,
      missing: r.missing,
    };
  }
  const c = new IpofCompiler(ast, {
    builtins: ipofBuiltinTable(),
    // the caller's table (a compiled file's own) wins; failing that, what the
    // includes declare, which is the only source a bare .IPS has
    imports:
      o.imports && o.imports.length
        ? o.imports
        : ipofScanImports(o.files || {}),
    protos: ipofScanPrototypes(o.files || {}),
  });
  c.ecu = o.name || 'script';
  const exec = c.compile();
  if (exec.errors.length) {
    return {
      ok: false,
      exec: null,
      errors: exec.errors,
      includes: r.used,
      missing: r.missing,
    };
  }
  return {
    ok: true,
    exec: {
      ecu: exec.ecu,
      procs: exec.procs,
      byid: exec.byid,
      coding: false,
      includes: ast.includes,
      imports: {},
    },
    errors: [],
    includes: r.used,
    missing: [],
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipofCompileSource,
    ipofResolveIncludes,
    ipofScanIncludes,
    ipofBuiltinTable,
    ipofScanPrototypes,
    ipofScanImports,
    IPOF_BUILTIN_NUMS,
    IPOF_ALIAS_NUMS,
  };
}
