/**
 * @file The .IPO VM's operators: truthiness and numeric coercion of boxed
 * values, and the `binop` token's arithmetic, comparison and logic -- with
 * the slot/key identity of an operand carried onto the result so a draw
 * stays bound to the reading it was computed from.
 */

/**
 * Text that reads as a number: what `+` and unary minus treat as arithmetic
 * when it arrives in a bound box (a job result is text with a key).
 * @type {RegExp}
 */
const IPO_NUMERIC_TEXT_RE = /^-?\d+(\.\d+)?$/;

/**
 * The comparison operator names: their operands are recorded as predicate
 * reads (a key a branch decides on) by the offline executor.
 * @type {string[]}
 */
const IPO_COMPARE_OPS = ['eq', 'ne', 'lt', 'gt', 'le', 'ge'];

/**
 * INPA truthiness: '' and '0' are false, a boxed float is its number, a bound
 * value is judged by its text.
 * @param {IpoValue} v - any VM value
 * @returns {boolean}
 */
function truthy(v) {
  if (isFloat(v)) return !!v.v;
  if (isBound(v)) v = v.s;
  if (typeof v === 'string') return v !== '' && v !== '0';
  return !!v;
}

/**
 * Numeric value of any VM value; unparseable text is 0.
 * @param {IpoValue} v - any VM value
 * @returns {number}
 */
function num(v) {
  if (isFloat(v)) return v.v;
  if (isBound(v)) v = v.s;
  if (typeof v === 'number') return v;
  const f = parseFloat(String(v));
  return Number.isNaN(f) ? 0 : f;
}

/**
 * Does x read as a number for arithmetic purposes: an unboxed number, a
 * boxed float, or a bound value whose text is numeric?
 * @param {IpoValue} x - any VM value
 * @returns {boolean}
 */
function looksNumeric(x) {
  return (
    typeof x === 'number' ||
    isFloat(x) ||
    (isBound(x) && IPO_NUMERIC_TEXT_RE.test(String(x.s).trim()))
  );
}

/**
 * The (slot, key) an arithmetic result should keep from its operands, so a
 * scaled reading (slot13 * scale) keeps STAT_..._WERT's key/slot.
 * @param {IpoValue} a - left operand
 * @param {IpoValue} b - right operand
 * @returns {[IpoSlot|null, string|null]}
 */
function carry(a, b) {
  for (const x of [a, b]) {
    if (isBound(x) && (x.key || x.slot)) return [x.slot, x.key];
    if (isSlot(x)) return [x, null];
  }
  return [null, null];
}

/**
 * A numeric result, wrapped to keep an operand's slot/key when one had it,
 * and to keep FLOAT identity when the maths is real (either operand a float,
 * or the result non-integral) -- so a later type filter still sees a float.
 * @param {number} value - the computed number
 * @param {IpoValue} a - left operand
 * @param {IpoValue} b - right operand (null for unary minus)
 * @returns {IpoValue}
 */
function boundNum(value, a, b) {
  const [slot, key] = carry(a, b);
  const real = isFloat(a) || isFloat(b) || !Number.isInteger(value);
  if (slot == null && key == null) return real ? mkFloat(value) : value;
  return mkBound(slot, String(value), key);
}

/**
 * INPA equality. Strings (plain or bound) compare as text; floats as numbers;
 * and, like Python's `==`, a bool equals its int (True == 1) -- a forced
 * keypress guard is the bool true compared against the const 1, so it must
 * read equal (LSZ's "start" gates STEUERN_IO on `g52 == 1`). JS === would say
 * true !== 1, closing the guard and skipping the job.
 * @param {IpoValue} a - left operand
 * @param {IpoValue} b - right operand
 * @returns {boolean}
 */
function cmpEq(a, b) {
  if (isPlainStr(a) || isPlainStr(b) || isBound(a) || isBound(b)) {
    return asStr(a) === asStr(b);
  }
  if (isFloat(a) || isFloat(b)) return num(a) === num(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const na = typeof a === 'boolean' ? (a ? 1 : 0) : a;
    const nb = typeof b === 'boolean' ? (b ? 1 : 0) : b;
    return na === nb;
  }
  return a === b;
}

/**
 * `+` on a slot or bound operand: concatenation that keeps the slot's
 * identity and folds every other key into `extra`, so a row built as
 * `<bound slot> + " Werte"` still draws bound to its reading.
 * @param {IpoValue} a - left operand
 * @param {IpoValue} b - right operand
 * @param {IpoSlot} slot - the identity to keep
 * @returns {IpoBound}
 */
function concatBound(a, b, slot) {
  const [, key] = carry(a, b);
  const out = mkBound(slot, asStr(a) + asStr(b), key);
  const folded = [];
  for (const x of [a, b]) {
    if (isBound(x)) {
      if (x.key && x.key !== key) folded.push(x.key);
      for (const k of x.extra) if (k !== key) folded.push(k);
    }
  }
  if (folded.length) out.extra = [...new Set(folded)];
  return out;
}

/**
 * The `add` operator. BOTH SIDES NUMERIC -> ARITHMETIC, boxed or not: INPA's
 * + on int variables is addition; the slot/bound boxes exist so the offline
 * derivation can bind draws, and letting a box force concatenation made a
 * live accumulator compute '10'+10='1010' (llerh's setpoint on the second
 * keypress). Otherwise + is concatenation, and a slot concatenated must keep
 * its identity or the draw sees only text.
 * @param {IpoValue} a - left operand
 * @param {IpoValue} b - right operand
 * @returns {IpoValue}
 */
function addOp(a, b) {
  const numish = (x) => looksNumeric(x) || isSlot(x);
  if (numish(a) && numish(b)) return boundNum(num(a) + num(b), a, b);
  let slot = null;
  for (const x of [a, b]) {
    if (isSlot(x)) slot = x;
    else if (isBound(x)) slot = x.slot;
    if (slot != null) break;
  }
  if (slot != null) return concatBound(a, b, slot);
  if (isPlainStr(a) || isPlainStr(b)) return asStr(a) + asStr(b);
  return boundNum(num(a) + num(b), a, b);
}

/**
 * The `neg` operator (0x6d) is UNARY MINUS (ipo_disasm ground truth): llerh's
 * "-10" is `const 10; neg`, the clamp bounds are `const 128; neg`. Boolean-not
 * only ever fit guard shapes; a numeric operand negates arithmetically.
 * @param {IpoValue} a - the operand when passed first (null from the executor)
 * @param {IpoValue} b - the operand as the executor passes it
 * @returns {IpoValue}
 */
function negOp(a, b) {
  const x = a == null ? b : a;
  if (looksNumeric(x)) return boundNum(-num(x), x, null);
  return !truthy(x);
}

/**
 * Apply a `binop` token. Unknown names yield null.
 * @param {string} name - operator name (add, sub, mul, div, eq, ne, lt, gt,
 *   le, ge, and, or, neg)
 * @param {IpoValue} a - left operand (null for neg)
 * @param {IpoValue} b - right operand
 * @returns {IpoValue}
 */
function binop(name, a, b) {
  switch (name) {
    case 'add':
      return addOp(a, b);
    case 'sub':
      return boundNum(num(a) - num(b), a, b);
    case 'mul':
      return boundNum(num(a) * num(b), a, b);
    case 'div':
      return boundNum(num(b) ? num(a) / num(b) : 0, a, b);
    case 'eq':
      return cmpEq(a, b);
    case 'ne':
      return !cmpEq(a, b);
    case 'lt':
      return num(a) < num(b);
    case 'gt':
      return num(a) > num(b);
    case 'le':
      return num(a) <= num(b);
    case 'ge':
      return num(a) >= num(b);
    case 'and':
      return truthy(a) && truthy(b);
    case 'or':
      return truthy(a) || truthy(b);
    case 'neg':
      return negOp(a, b);
    default:
      return null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IPO_COMPARE_OPS,
    truthy,
    num,
    carry,
    boundNum,
    cmpEq,
    binop,
  };
}
