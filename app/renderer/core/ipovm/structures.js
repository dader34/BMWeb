/**
 * @file INPA's binary-structure helpers (CreateStructure / SetStructureMode /
 * Structure{Byte,Int,Long,String}) and the import32 sprintf the scripts'
 * own hex formatters (chr, bytetohexstring, longtohexstring) build on.
 * Offline these stay noops (the Python twin's behaviour, parity-diffed); a
 * LIVE run needs them or every helper pops its own "Error: Handle" box and
 * prints nothing.
 */

/** The builtin names a live run answers here. */
const IPO_STRUCT_FNS = new Set([
  'CreateStructure',
  'SetStructureMode',
  'StructureByte',
  'StructureInt',
  'StructureLong',
  'StructureString',
]);

/** Byte width of each fixed-width structure accessor. */
const IPO_STRUCT_WIDTH = {
  StructureByte: 1,
  StructureInt: 2,
  StructureLong: 4,
};

/** SetStructureMode: 0 writes into the buffer, 1 reads out of it. */
const IPO_STRUCT_WRITE = 0;

/** CreateStructure's buffer size when the script names none. */
const IPO_STRUCT_DEFAULT_SIZE = 1024;

/**
 * A structure the VM owns, behind a numeric handle.
 * @typedef {object} IpoStructure
 * @property {Uint8Array} buf - the bytes
 * @property {number} mode - the mode it was created in (the effective mode is VM-wide)
 */

/**
 * The low bytes of a string, one per character (the structure buffers hold
 * single-byte text).
 * @param {string} s - the text
 * @returns {number[]}
 */
function ipoStringBytes(s) {
  const out = [];
  for (const ch of String(s || '')) out.push(ch.charCodeAt(0) & 0xff);
  return out;
}

/**
 * The number a structure argument holds: a bound value's text, a boxed
 * float's value, else Number(); 0 when not finite.
 * @param {IpoValue} v - the argument
 * @returns {number}
 */
function structNum(v) {
  if (isBound(v)) v = v.s;
  if (isFloat(v)) return v.v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Answer one structure builtin on a live run. A structure is a byte buffer
 * behind a handle (never 0: 0 is the failure code). Mode 0 writes, 1 reads.
 * Structure{Byte,Int,Long,String}(handle, offset[, len], value | out ref):
 * the handle is the first non-out argument (a slot read or a ref); a write
 * takes the last non-ref argument as its value, a read stores through the
 * last ref.
 * @param {IpoVm} vm - the running VM (owns `structs` and `_structMode`)
 * @param {string} name - the builtin's name (one of IPO_STRUCT_FNS)
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {void}
 */
/**
 * The current value behind a reference (through chained refs).
 * @param {IpoVm} vm - the running VM
 * @param {IpoRef} r - the reference
 * @returns {*}
 */
function ipoRefValue(vm, r) {
  const { n, map } = vm._refTarget(r, vm.frame);
  return map.get(n);
}

function ipoStructureCall(vm, name, stack) {
  if (!vm.structs) vm.structs = new Map();
  const refs = stack.filter(isRef);
  const nums = stack
    .map((x) => (isPlainInt(x) ? x : isFloat(x) ? x.v : null))
    .filter((x) => x != null);
  if (name === 'CreateStructure') {
    const size = nums.length ? Math.max(1, nums[0]) : IPO_STRUCT_DEFAULT_SIZE;
    const h = vm.structs.size + 1;
    vm.structs.set(h, { buf: new Uint8Array(size), mode: IPO_STRUCT_WRITE });
    storeOut(vm, stack, h);
    return;
  }
  if (name === 'SetStructureMode') {
    vm._structMode = nums.length ? nums[0] : IPO_STRUCT_WRITE;
    return;
  }
  const handle = structNum(
    stack.find((x) => !isRef(x) && (isPlainInt(x) || isBound(x)))
  );
  const st = vm.structs.get(handle);
  if (!st) return;
  const off = nums.length > 1 ? nums[1] : nums.length ? nums[0] : 0;
  const width = IPO_STRUCT_WIDTH[name] || 0;
  const mode = vm._structMode || IPO_STRUCT_WRITE;
  if (width) {
    if (mode === IPO_STRUCT_WRITE) {
      // the value comes by value or, as longtohexstring packs its number,
      // by reference (StructureLong(handle, 0, &value))
      const vals = stack.filter((x) => !isRef(x));
      const v = structNum(
        refs.length
          ? ipoRefValue(vm, refs[refs.length - 1])
          : vals[vals.length - 1]
      );
      for (let i = 0; i < width; i++) {
        if (off + i < st.buf.length) st.buf[off + i] = (v >>> (8 * i)) & 0xff;
      }
    } else {
      let v = 0;
      for (let i = width - 1; i >= 0; i--) v = v * 256 + (st.buf[off + i] || 0);
      storeOut(vm, refs.slice(-1), v);
    }
    return;
  }
  // StructureString(handle, offset, len, out string | string)
  const len = nums.length > 2 ? nums[2] : st.buf.length - off;
  if (mode === IPO_STRUCT_WRITE) {
    let sv = stack.find((x) => isPlainStr(x) || (isBound(x) && !isRef(x)));
    if (sv == null && refs.length) sv = ipoRefValue(vm, refs[refs.length - 1]);
    const bytes = ipoStringBytes(asStr(sv == null ? '' : sv));
    for (let i = 0; i < Math.min(len, bytes.length); i++) {
      if (off + i < st.buf.length) st.buf[off + i] = bytes[i];
    }
  } else {
    let out = '';
    for (let i = 0; i < len && off + i < st.buf.length; i++) {
      const b = st.buf[off + i];
      if (b === 0) break;
      out += String.fromCharCode(b);
    }
    storeOut(vm, refs.slice(-1), out);
  }
}

/**
 * sprintf through import32: (out string ref, format, handle ref, out count
 * ref). The import table is per-file and carries no names, but the scripts
 * use it for ONE thing the formatters must honour: a sprintf of a
 * structure's bytes ("%08lX") into an out string. The format is the only
 * string carrying '%'; the value is the structure's long at offset 0 (what
 * the formatters just wrote), or the argument itself when it is not a
 * handle.
 * @param {IpoVm} vm - the running VM
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {void}
 */
function ipoDllCall(vm, stack) {
  const refs = stack.filter(isRef);
  // the format is usually computed ('%0' + width + 'lX'), so a bound string
  const fmtArg = stack.find(
    (x) => (isPlainStr(x) || isBound(x)) && asStr(x).includes('%')
  );
  if (!fmtArg || !refs.length) return;
  const fmt = asStr(fmtArg);
  let value = 0;
  if (refs.length > 1) {
    const raw = ipoRefValue(vm, refs[1]);
    const n = Number(isBound(raw) ? raw.s : isFloat(raw) ? raw.v : raw);
    const st = vm.structs && vm.structs.get(n);
    if (st) {
      for (let i = 3; i >= 0; i--) value = value * 256 + (st.buf[i] || 0);
    } else if (Number.isFinite(n)) value = n;
  }
  const m = fmt.match(/%(0?)(\d*)(l?)([xXdus])/);
  let text = fmt;
  if (m) {
    const width = m[2] ? Number(m[2]) : 0;
    let body;
    if (m[4] === 'x') body = (value >>> 0).toString(16);
    else if (m[4] === 'X') body = (value >>> 0).toString(16).toUpperCase();
    else if (m[4] === 'u') body = String(value >>> 0);
    else body = String(value);
    const pad = m[1] === '0' ? '0' : ' ';
    while (body.length < width) body = pad + body;
    text = fmt.replace(m[0], body);
  }
  storeOut(vm, [refs[0]], text);
  if (refs.length > 2) storeOut(vm, [refs[refs.length - 1]], text.length);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IPO_STRUCT_FNS,
    ipoStringBytes,
    ipoStructureCall,
    ipoDllCall,
  };
}
