/**
 * @file Static scans over a proc's token tape, used without executing it:
 * the byte-offset index a jump seeks through, where a proc's decoded tokens
 * end, the segment re-basing of jump targets past a %STATE label, the
 * keypress-guard flags an item body tests, and the quit-mode confirmation
 * box a state machine pops.
 */

/**
 * One decoded token of a proc, as tools/export/ipo_exec.py emits it. Only
 * the fields the VM reads are listed; which ones are present depends on `op`.
 * @typedef {object} IpoToken
 * @property {string} op - frame | const | var | procref | store | binop | jfalse |
 *   jump | ITEM | LINE | call | calluser | dllcall | state | ret | unk | ...
 * @property {number} [at] - byte offset of the token in the .IPO
 * @property {string} [t] - a const's pool tag ('s' string, 'i' int, 'd' double, 'b' bool)
 * @property {*} [v] - a const's value
 * @property {number} [sc] - a var/store's scope (absent = GLOBAL)
 * @property {number} [n] - a var/store's slot, a procref/calluser's id, a call's builtin number
 * @property {boolean} [ref] - a store through a by-reference parameter
 * @property {number} [kind] - a procref's kind (see IPO_REF_*)
 * @property {string} [name] - a binop's operator or a call's builtin name
 * @property {number} [to] - a jump's target byte offset
 * @property {number} [nr] - an ITEM's F-key number
 * @property {string} [label] - an ITEM's caption or a LINE's name
 * @property {string} [keys] - a LINE's component key string (for the picker)
 */

/**
 * The {byteOffset -> tokenIndex} index of a proc, so a resolved jump target is
 * a seek.
 * @param {IpoToken[]} toks - the proc's tokens
 * @returns {Map<number, number>}
 */
function ipoByteIndex(toks) {
  const index = new Map();
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].at != null) index.set(toks[i].at, i);
  }
  return index;
}

/**
 * Where a proc's decoded tokens end: the first undecoded byte. A proc's block
 * header sizes only its own section, so garbage past the real end (unk
 * tokens) would spin.
 * @param {IpoToken[]} toks - the proc's tokens
 * @returns {number} token index of the first `unk`, or toks.length
 */
function ipoProcEnd(toks) {
  for (let j = 0; j < toks.length; j++) {
    if (toks[j].op === 'unk') return j;
  }
  return toks.length;
}

/**
 * JUMP TARGETS PAST A STATE ARE SEGMENT-RELATIVE. The compiler emits a jump's
 * u16 as a dword index from its enclosing BLOCK -- the proc body, an
 * ITEM/LINE body, or (the part the walker does not model) a %STATE segment:
 * each state label opens a new block whose dwords count from the token after
 * the state's own exit jump (the body the driven resume enters).
 *
 * The walker resolves every target against the proc/ITEM base, so a target
 * inside a state segment lands short by the states' label bytes -- across the
 * corpus only 41% of intra-segment jumps hit a real token that way, while
 * re-basing per segment resolves 95.8% (and S_ZUHEIZ's Pruefung becomes
 * semantically exact: the measure loop's jfalse skips ONE store, the Weiter
 * guard exits to the %ENDE block). Offline execution never runs past the
 * first state (it halts there), so only the DRIVEN path needs this; the
 * offline executor stays byte-identical to ipo_vm.py.
 *
 * A corrected target may land ON a `state` token: that is a generic park
 * (the current machine segment is what setstatemachine last set), which the
 * driven loop's yield handling already provides.
 * @param {IpoToken[]} toks - the proc's tokens
 * @returns {Map<number, number>} jump token index -> re-based target byte offset
 */
function ipoSegRemap(toks) {
  const remap = new Map();
  if (!toks.length || toks[0].at == null) return remap;
  const at = (i) => toks[i].at;
  let walker = at(0) + 4; // dword 0 of the proc's own block
  let seg = walker;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.op === 'ITEM' || t.op === 'LINE') {
      const nxt = i + 1 < toks.length ? at(i + 1) : at(i) + 4;
      walker = nxt;
      seg = nxt;
    } else if (t.op === 'state') {
      let j = i + 1;
      if (j < toks.length && toks[j].op === 'jump') j += 1; // exit edge
      seg = j < toks.length ? at(j) : at(i);
    } else if (t.to != null) {
      const u16 = t.to - walker;
      if (u16 >= 0 && u16 % 4 === 0 && seg !== walker) {
        remap.set(i, seg + u16);
      }
    }
  }
  return remap;
}

/**
 * Global slots an item body gates its whole action on -- keypress flags.
 * INPA wraps a key's action in `if flag == 1 ...`; pressing the key means the
 * flag is true, so run_item must force it -- but ONLY a guard flag (a GLOBAL
 * compared by `eq` feeding a `jfalse`, before the body stores anything),
 * never a global read as real data. Ported from ipo_vm.py _keypress_guards.
 * @param {IpoToken[]} toks - the menu proc's tokens
 * @param {number} start - first token index of the body
 * @param {number} end - token index the body ends at (exclusive)
 * @param {{numericOnly?: boolean}} [opts] - numericOnly: a slot compared
 *   against a STRING ("ON") is state the body keeps, not a flag -- a preset
 *   of 1 can never satisfy that compare and only destroys the value (the
 *   live item VM's concern; the offline derivation keeps the Python twin's
 *   exact behaviour)
 * @returns {Set<number>} the guard flags' global slot numbers
 */
function keypressGuards(toks, start, end, opts = {}) {
  const guards = new Set(),
    stored = new Set();
  const lim = Math.min(end, toks.length);
  for (let k = start; k < lim; k++) {
    const t = toks[k],
      op = t.op;
    if (op === 'store' && (t.sc == null ? GLOBAL : t.sc) === GLOBAL) {
      stored.add(t.n);
    }
    if (
      op === 'var' &&
      (t.sc == null ? GLOBAL : t.sc) === GLOBAL &&
      !stored.has(t.n)
    ) {
      const b = k + 1 < end ? toks[k + 1] : {};
      const c = k + 2 < end ? toks[k + 2] : {};
      if (
        opts.numericOnly &&
        b.op === 'const' &&
        b.t === 's' &&
        !/^-?\d+$/.test(String(b.v).trim())
      )
        continue;
      if (b.op === 'const' && c.op === 'binop' && c.name === 'eq') {
        let gated = false;
        for (let j = k + 3; j < Math.min(k + 6, end); j++) {
          if (toks[j].op === 'jfalse') {
            gated = true;
            break;
          }
        }
        if (gated) guards.add(t.n);
      }
    }
  }
  return guards;
}

/**
 * The quit-mode confirmation a machine pops after a successful drive:
 *     if (slotN == 1) messagebox(title, prefix + <ORT>)
 * (ZKE5 sm_steuern: slot 29 = the "with Quitting" toggle, box "ACTIVATED
 * DIGITAL VALUE / Signal : <ORT>"). Scanned from the bytecode so the slot and
 * the words are INPA's own, never invented.
 * @param {IpoToken[]} toks - the state machine's tokens
 * @returns {{slot: number, title: string, prefix: string}|null} null when
 *   the machine has no such box
 */
function scanQuitBox(toks) {
  if (!Array.isArray(toks)) return null;
  for (let i = 0; i + 4 < toks.length; i++) {
    const a = toks[i],
      b = toks[i + 1],
      c = toks[i + 2];
    if (a.op !== 'var' || b.op !== 'const' || b.v !== 1) continue;
    if (c.op !== 'binop' || c.name !== 'eq') continue;
    // guarded body within reach: frame, const title, const prefix, ...,
    // call messagebox
    for (let j = i + 3; j < Math.min(i + 14, toks.length); j++) {
      const t = toks[j];
      if (t.op === 'call' && t.name === 'messagebox') {
        const strs = [];
        for (let k = i + 3; k < j; k++) {
          if (toks[k].op === 'const' && toks[k].t === 's') strs.push(toks[k].v);
        }
        if (strs.length >= 2) {
          return { slot: a.n, title: strs[0], prefix: strs[1] };
        }
        break;
      }
      if (t.op === 'state' || t.op === 'jump') break;
    }
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipoByteIndex,
    ipoProcEnd,
    ipoSegRemap,
    keypressGuards,
    scanQuitBox,
  };
}
