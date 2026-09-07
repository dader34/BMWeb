/**
 * @file The .IPO virtual machine's value model: the boxes a VM value travels
 * in, the predicates that tell them apart, and the two errors the executor
 * throws.
 *
 * The VM (core/ipovm/vm.js) EXECUTES .IPO screen/menu programs in the
 * browser. It is the JS twin of tools/decompile/ipo_vm.py: it runs the same
 * decoded token tape (tools/export/ipo_exec.py output: {procs, byid, pool},
 * a derivation of the .IPO with constants inlined and jumps resolved to byte
 * offsets) and produces the same emissions (drawn lines, menu items, jobs,
 * dialogs), so screens can be executed rather than frozen.
 *
 * THE MODEL, ported from ipo_vm.py (not bestvm.js -- BEST2 is a byte-register
 * machine; .IPO is a STACK machine):
 *   - a per-call-frame operand stack; `frame` (0x0f) clears it, a call
 *     consumes it. Scope 0 = script globals, 2/3 = the frame's own slots.
 *   - jumps are token seeks: t.to is a byte offset, resolved through a
 *     {byteOffset -> tokenIndex} index built per proc.
 *   - builtins take an OUT-PARAMETER (a procref on the stack), never return a
 *     value -- INPAapiResultInt(->dest, KEY, i), inttostring(src, ->dest).
 *   - host interaction (job results, dialog state) is injected, like
 *     bestvm's `send`. The default OkHost answers offline; production swaps
 *     in a live host.
 *
 * VALUE IDENTITY. A drawn value must remember which result KEY filled it so
 * the poller can refresh it live; a scaled/concatenated value must keep that
 * key through the arithmetic. ipo_vm.py carries this on _Bound (a str
 * subclass) and _Slot; JS has no str subclass, so values that carry identity
 * are boxed as {__bound:true, ...} / {__slot:true, ...}. Bare strings/ints
 * stay bare, so `typeof x === 'string'` still tests "a plain literal".
 */

/**
 * Variable scope of a `var`/`store` token: 0 = script globals. (The other
 * scopes, 2 and 3, are the current frame's own slots -- see LOCAL.)
 * @type {number}
 */
const GLOBAL = 0;
/**
 * Variable scope of a frame-local slot (scope 3 is treated the same by
 * mkSlot: only "global or not" matters to a slot's identity).
 * @type {number}
 */
const LOCAL = 2;

/**
 * Procref kinds pushed by a `procref` token: what the reference names.
 * A local ref (IPO_REF_LOCAL) remembers the frame it was taken in; the
 * others are indices into the exec's `byid` table by type.
 */
const IPO_REF_LOCAL = 2;
const IPO_REF_SCREEN = 64;
const IPO_REF_MENU = 65;
const IPO_REF_STATE = 66;
const IPO_REF_STATE_ALT = 67;

/**
 * An unset slot: reads as empty text but still names its slot, so a later
 * draw can look up the Result* key bound to it. Mirrors ipo_vm.py's _Slot.
 * @typedef {object} IpoSlot
 * @property {true} __slot - box tag
 * @property {number} sc - scope, GLOBAL or LOCAL
 * @property {number} n - slot number
 */

/**
 * Text that remembers where it came from. Mirrors ipo_vm.py's _Bound (a str
 * subclass); here it is a box and the display text is `s`.
 * @typedef {object} IpoBound
 * @property {true} __bound - box tag
 * @property {string} s - the text
 * @property {IpoSlot|null} slot - the slot it was built from
 * @property {string|null} key - the Result* key bound to it
 * @property {string[]} extra - other keys folded into it by concatenation
 * @property {Record<string, string>|null} amap - a lookup table it came from
 *   (StrArrayRead), so a painter can map the value to a caption
 */

/**
 * A FLOAT, boxed. JS has one number type, but INPA distinguishes int from
 * real and several builtins select arguments BY TYPE: analogout takes the
 * first two *ints* as (row, col) and reads its min/max/warn bounds from the
 * *floats* after them. An unboxed 120.0 is Number.isInteger-true and would
 * be misread as a col. Pool doubles (tag 'd') are boxed so the int/float
 * split survives; every numeric helper unwraps them.
 * @typedef {object} IpoFloat
 * @property {true} __float - box tag
 * @property {number} v - the value
 */

/**
 * A procref on the stack: ['ref', kind, n, ownerFrame]. A local ref (kind
 * IPO_REF_LOCAL) remembers the frame it was taken in, so a callee writing
 * through its by-reference parameter lands in the CALLER's slot, not its own.
 * @typedef {['ref', number, number, (Map<number, IpoValue>|null)]} IpoRef
 */

/**
 * Anything a VM slot or stack cell can hold.
 * @typedef {string|number|boolean|null|IpoSlot|IpoBound|IpoFloat|IpoRef} IpoValue
 */

/** A malformed program or a missing proc: the caller's mistake, not a halt. */
class IpoError extends Error {}

/**
 * Control-flow stop thrown by the offline executor: a `state` yield, or the
 * step budget. Never an error -- run() swallows it and returns the emissions.
 */
class Halt extends Error {}

// ---------------------------------------------------------------- boxes --

/**
 * Box an unset slot so its identity survives until a draw looks it up.
 * @param {number} sc - scope of the slot
 * @param {number} n - slot number
 * @returns {IpoSlot}
 */
function mkSlot(sc, n) {
  return { __slot: true, sc: sc === LOCAL ? LOCAL : GLOBAL, n };
}

/**
 * Is x an unset-slot box?
 * @param {IpoValue} x - any VM value
 * @returns {x is IpoSlot}
 */
function isSlot(x) {
  return x != null && x.__slot === true;
}

/**
 * Box text that carries its origin.
 * @param {IpoSlot|null|undefined} slot - the slot it was built from
 * @param {*} text - display text (stringified; null reads as '')
 * @param {string|null|undefined} key - the Result* key bound to it
 * @returns {IpoBound}
 */
function mkBound(slot, text, key) {
  return {
    __bound: true,
    s: text == null ? '' : String(text),
    slot: slot || null,
    key: key || null,
    extra: [],
    amap: null,
  };
}

/**
 * Is x a bound-text box?
 * @param {IpoValue} x - any VM value
 * @returns {x is IpoBound}
 */
function isBound(x) {
  return x != null && x.__bound === true;
}

/**
 * str(x): the display text of any VM value. A slot reads '', a bound value
 * its text, a boxed float its number.
 * @param {IpoValue} x - any VM value
 * @returns {string}
 */
function asStr(x) {
  if (x == null) return '';
  if (isBound(x)) return x.s;
  if (isSlot(x)) return '';
  if (isFloat(x)) return String(x.v);
  return String(x);
}

/**
 * Is x a plain string literal (not a bound box, not a slot)?
 * @param {IpoValue} x - any VM value
 * @returns {x is string}
 */
function isPlainStr(x) {
  return typeof x === 'string';
}

/**
 * Is x a plain integer (an unboxed whole number)?
 * @param {IpoValue} x - any VM value
 * @returns {x is number}
 */
function isPlainInt(x) {
  return typeof x === 'number' && Number.isInteger(x);
}

/**
 * Is x a procref pushed on the stack?
 * @param {IpoValue} x - any VM value
 * @returns {x is IpoRef}
 */
function isRef(x) {
  return Array.isArray(x) && x.length >= 3 && x[0] === 'ref';
}

/**
 * Box a real so it keeps its float identity (see IpoFloat).
 * @param {number} v - the value
 * @returns {IpoFloat}
 */
function mkFloat(v) {
  return { __float: true, v };
}

/**
 * Is x a boxed float?
 * @param {IpoValue} x - any VM value
 * @returns {x is IpoFloat}
 */
function isFloat(x) {
  return x != null && x.__float === true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GLOBAL,
    LOCAL,
    IPO_REF_LOCAL,
    IPO_REF_SCREEN,
    IPO_REF_MENU,
    IPO_REF_STATE,
    IPO_REF_STATE_ALT,
    IpoError,
    Halt,
    mkSlot,
    isSlot,
    mkBound,
    isBound,
    asStr,
    isPlainStr,
    isPlainInt,
    isRef,
    mkFloat,
    isFloat,
  };
}
