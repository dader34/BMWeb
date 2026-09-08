/**
 * @file Builtins that convert between text and numbers: string length and
 * slicing, int/real/string conversions, hex parsing, concatenation, and the
 * date/time/API-string placeholders.
 */

/**
 * The first string-like argument parsed as a decimal, a comma accepted as
 * the decimal point; 0 when unparseable.
 * @param {IpoValue[]} stack - the call's arguments
 * @returns {number}
 */
function parseDecimalArg(stack) {
  const v = parseFloat(String(asStr(firstText(stack)) || '').replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
}

/**
 * strlen(->n, s): a bound value (Python's str subclass) counts, a slot does
 * not. instr's Text argument is a concatenation (a bound value), so
 * excluding it read length 0 and skipped the whole substring loop.
 * @type {IpoBuiltin}
 */
function bStrlen(vm, stack) {
  const x = firstText(stack);
  storeOut(vm, stack, x == null ? 0 : asStr(x).length);
}

/**
 * midstr(->dst, src, start, len): a 0-based substring of the LAST
 * string-like argument (bound values included), bound to the source's key.
 * @type {IpoBuiltin}
 */
function bMidstr(vm, stack) {
  const strs = stack.filter((x) => isPlainStr(x) || isBound(x)).map(asStr);
  const ints = allInts(stack);
  const src = strs.length ? strs[strs.length - 1] : '';
  // midstr(dest, source, start, count): start is 0-based. E46.IPO's own
  // instr() probes from 0 and takes midstr(text, 0, 2) for a mode prefix and
  // midstr(text, 2, n) for the name after it; the coding screens chunk a hex
  // string at 0, 2, 4, ... -- none of which works 1-based.
  const a = ints.length ? ints[0] : 0;
  const n = ints.length > 1 ? ints[1] : src.length;
  storeOut(
    vm,
    stack,
    src.slice(Math.max(0, a), Math.max(0, a) + Math.max(0, n)),
    keyed(stack)
  );
}

/**
 * inttostring / realtostring / formatnum(src, ->dst): the number's text,
 * truncated to an integer. A BOUND VALUE COUNTS AS A STRING: a job result
 * written through INPAapiResult* converts here, and matching plain strings
 * only zeroed every converted result (S_ZUHEIZ printed "Startzähler : 0" for
 * a counter the wire answered 7).
 * @type {IpoBuiltin}
 */
function bInttostring(vm, stack) {
  const n = firstNumberArg(stack);
  storeOut(vm, stack, String(Math.trunc(n)), keyed(stack));
}

/**
 * inttolong / bytetoint: a NUMBER out, not its text. Mapped to inttostring
 * they handed the fault printer "42" as a string, so `< 0` and longtoreal
 * saw no number and every entry read "Nr: 0".
 * @type {IpoBuiltin}
 */
function bIntwiden(vm, stack) {
  const n = firstNumberArg(stack);
  storeOut(vm, stack, Math.trunc(n), keyed(stack));
}

/**
 * stringtoreal(src, ->dst).
 * @type {IpoBuiltin}
 */
function bStringtoreal(vm, stack) {
  storeOut(vm, stack, parseDecimalArg(stack), keyed(stack));
}

/**
 * stringtoint(src, ->dst): the decimal truncated.
 * @type {IpoBuiltin}
 */
function bStringtoint(vm, stack) {
  storeOut(vm, stack, Math.trunc(parseDecimalArg(stack)), keyed(stack));
}

/**
 * hexconvert(src, ->b2, ->b1, ->b0, ->b3): a hex string split into bytes,
 * in the order the scripts expect them.
 * @type {IpoBuiltin}
 */
function bHexconvert(vm, stack) {
  let v = parseInt(String(asStr(firstText(stack)) || '').trim() || '0', 16);
  if (!Number.isFinite(v)) v = 0;
  const refs = stack.filter(isRef);
  const parts = [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff, (v >> 24) & 0xff];
  refs.forEach((r, k) => {
    if (k < 4) storeOut(vm, [r], parts[k]);
  });
}

/**
 * strcat(->dst, a, b, ...): every string-like argument joined (dest ref
 * FIRST -- not order-aligned with the other conversions).
 * @type {IpoBuiltin}
 */
function bStrcat(vm, stack) {
  const ins = stack.filter((x) => isPlainStr(x) || isBound(x)).map(asStr);
  storeOut(vm, stack, ins.join(''), keyed(stack));
}

/**
 * The inttoreal/realtoint/longtoreal family: a number out, unchanged. A job
 * result or a converted value arrives BOUND (its text plus the key it came
 * from): convert the text, as inttostring does.
 * @type {IpoBuiltin}
 */
function bNumconvert(vm, stack) {
  storeOut(vm, stack, firstNumberArg(stack), keyed(stack));
}

/**
 * getdate(->s): a fixed date offline.
 * @type {IpoBuiltin}
 */
function bGetdate(vm, stack) {
  storeOut(vm, stack, '01.01.2000');
}

/**
 * gettime(->s): a fixed time offline.
 * @type {IpoBuiltin}
 */
function bGettime(vm, stack) {
  storeOut(vm, stack, '00:00:00');
}

/**
 * getapistring(->s): empty.
 * @type {IpoBuiltin}
 */
function bGetapistring(vm, stack) {
  storeOut(vm, stack, '');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    bStrlen,
    bMidstr,
    bInttostring,
    bIntwiden,
    bStringtoreal,
    bStringtoint,
    bHexconvert,
    bStrcat,
    bNumconvert,
    bGetdate,
    bGettime,
    bGetapistring,
  };
}
