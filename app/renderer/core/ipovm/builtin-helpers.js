/**
 * @file Argument helpers every builtin shares: picking a builtin's arguments
 * off the call stack by type, and writing its answer through the
 * out-parameter (a procref) the script pushed for it.
 */

/**
 * A builtin implementation. `item` is the menu ITEM being executed (offline
 * lifts attribute jobs and dialogs to it), null when none.
 * @typedef {(vm: IpoVm, stack: IpoValue[], item: (IpoItem|null)) => void} IpoBuiltin
 */

/**
 * The name a `call` token dispatches on: its decoded name, else
 * `builtin_<hex>` from its number (the unnamed builtins the corpus proved
 * the shape of are mapped by that form).
 * @param {IpoToken} t - the call token
 * @returns {string}
 */
function ipoBuiltinName(t) {
  return t.name || `builtin_${t.n.toString(16).padStart(2, '0')}`;
}

/**
 * The result key of the first argument that carries one.
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {string|null}
 */
function keyed(stack) {
  for (const x of stack) if (isBound(x) && x.key) return x.key;
  return null;
}

/**
 * The destination a builtin writes through: the first procref, or null.
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {IpoRef|null}
 */
function outRef(stack) {
  for (const x of stack) if (isRef(x)) return x;
  return null;
}

/**
 * Write a builtin's answer through its out-parameter. With a key the value is
 * boxed as bound text and the destination slot is bound to that key. An
 * offline non-answer ('' or null) must not overwrite a preset presence flag
 * (a global holding `true`).
 * @param {IpoVm} vm - the running VM
 * @param {IpoValue[]} stack - the call's arguments (the first ref is the destination)
 * @param {IpoValue} val - the answer
 * @param {string|null} [key] - the result key the answer came from
 * @returns {number|null} the destination slot, or null when there was none
 */
function storeOut(vm, stack, val, key) {
  const dest = outRef(stack);
  if (dest == null) return null;
  const { dsc: sc, n, map } = vm._refTarget(dest, vm.frame);
  if (key != null) {
    const amap = isBound(val) ? val.amap : null;
    val = mkBound(mkSlot(sc, n), val == null ? '' : asStr(val), key);
    val.amap = amap;
    vm.setBind(sc, n, key);
  }
  if (sc === GLOBAL) {
    const empty = val === '' || val == null || (isBound(val) && val.s === '');
    if (!empty || vm.globals.get(n) !== true) vm.globals.set(n, val);
  } else {
    map.set(n, val);
  }
  return n;
}

/**
 * The first plain string argument, or null.
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {string|null}
 */
function firstStr(stack) {
  for (const x of stack) if (isPlainStr(x)) return x;
  return null;
}

/**
 * Every plain string argument, in order.
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {string[]}
 */
function allStrs(stack) {
  return stack.filter(isPlainStr);
}

/**
 * Every plain integer argument, in order (booleans excluded).
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {number[]}
 */
function allInts(stack) {
  return stack.filter((x) => isPlainInt(x) && typeof x !== 'boolean');
}

/**
 * The first string-like argument (a plain string or a bound value), or
 * undefined. Python's builtins test isinstance(x, str), which _Bound (a str
 * subclass) passes, so a job result written through INPAapiResult* counts.
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {string|IpoBound|undefined}
 */
function firstText(stack) {
  return stack.find((x) => isPlainStr(x) || isBound(x));
}

/**
 * The first number-like argument as a number: an unboxed number or a boxed
 * float, else the first string-like argument parsed (0 when unparseable).
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {number}
 */
function firstNumberArg(stack) {
  const n = stack.find((x) => typeof x === 'number' || isFloat(x));
  if (n != null) return num(n);
  const parsed = parseFloat(asStr(firstText(stack)));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * A result key without its display suffix: STAT_X_WERT, STAT_X_EINH and
 * STAT_X_TEXT all belong to STAT_X.
 * @param {string} key - result key
 * @returns {string}
 */
function baseKey(key) {
  const u = String(key).toUpperCase();
  for (const suf of ['_WERT', '_EINH', '_TEXT', '_EINHEIT']) {
    if (u.endsWith(suf)) return key.slice(0, -suf.length);
  }
  return key;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipoBuiltinName,
    keyed,
    outRef,
    storeOut,
    firstStr,
    allStrs,
    allInts,
    firstText,
    firstNumberArg,
    baseKey,
  };
}
