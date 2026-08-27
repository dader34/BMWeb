// INPA .IPO virtual machine: EXECUTE .IPO screen/menu programs in the browser.
//
// The app currently ships a FROZEN IR -- a static snapshot of what each screen
// draws, patched per-screen where inference guessed wrong. Running the .IPO
// bytecode live instead lets screens branch on the real VARIANTE, the real job
// results, the real keypress. This is the JS twin of tools/decompile/
// ipo_vm.py: it runs the same decoded token tape and produces the same
// emissions (drawn lines, menu items, jobs, dialogs), so the app can execute
// screens by running them rather than freezing them.
//
// WHAT IT EXECUTES. tools/export/ipo_exec.py output: {procs, byid, pool}. This
// is a DERIVATION of the .IPO (the walked, jump-resolved token stream), exactly
// as bestvm.js runs sgbd_code.py's job-code.json rather than the raw .prg. No
// raw .IPO binary ships or is needed at runtime -- constants are already inlined
// into the tokens and jumps already resolved to byte offsets.
//
// THE MODEL, ported from ipo_vm.py (not bestvm.js -- BEST2 is a byte-register
// machine; .IPO is a STACK machine):
//   * a per-call-frame operand stack; `frame` (0x0f) clears it, a call consumes
//     it. Scope 0 = script globals, 2/3 = the frame's own slots.
//   * jumps are token seeks: t.to is a byte offset, resolved through an
//     {byteOffset -> tokenIndex} index built per proc.
//   * builtins take an OUT-PARAMETER (a procref on the stack), never return a
//     value -- INPAapiResultInt(->dest, KEY, i), inttostring(src, ->dest).
//   * host interaction (job results, dialog state) is injected, like bestvm's
//     `send`. The default OkHost answers offline: reads succeed with a
//     placeholder, JOB_STATUS is OKAY, integer reads are 1 -- enough to walk a
//     menu and draw a screen with no cable. Production swaps in a live host.
//
// VALUE IDENTITY. A drawn value must remember which result KEY filled it so the
// poller can refresh it live; a scaled/concatenated value must keep that key
// through the arithmetic. ipo_vm.py carries this on _Bound (a str subclass) and
// _Slot; JS has no str subclass, so values that carry identity are boxed as
// {__bound:true, s, slot, key, ...} / {__slot:true, sc, n}. Bare strings/ints
// stay bare, so `typeof x === 'string'` still tests "a plain literal".

const GLOBAL = 0, LOCAL = 2, LOCAL3 = 3;

class IpoError extends Error {}

// ---------------------------------------------------------------- values --

// An unset slot: reads as empty text but still names its slot, so a later draw
// can look up the Result* key bound to it. Mirrors ipo_vm.py's _Slot.
function mkSlot(sc, n) { return { __slot: true, sc: sc === 2 ? 2 : 0, n }; }
function isSlot(x) { return x != null && x.__slot === true; }

// Text that remembers where it came from: `slot` it was built from, `key` a
// Result* read bound to it, `extra` other keys folded into it, `amap` a lookup
// table. Mirrors ipo_vm.py's _Bound (which subclasses str). Here it is a box;
// str(x) is x.s.
function mkBound(slot, text, key) {
  return { __bound: true, s: text == null ? '' : String(text),
           slot: slot || null, key: key || null, extra: [], amap: null };
}
function isBound(x) { return x != null && x.__bound === true; }

// str(x): the display text of any VM value. _Slot -> '', _Bound -> its text.
function asStr(x) {
  if (x == null) return '';
  if (isBound(x)) return x.s;
  if (isSlot(x)) return '';
  if (isFloat(x)) return String(x.v);
  return String(x);
}
// is x a plain string literal (not a _Bound box, not a _Slot)?
function isPlainStr(x) { return typeof x === 'string'; }
function isPlainInt(x) {
  return typeof x === 'number' && Number.isInteger(x);
}
// a procref pushed on the stack: ['ref', kind, n]
function isRef(x) {
  return Array.isArray(x) && x.length === 3 && x[0] === 'ref';
}

// A FLOAT, boxed. JS has one number type, but INPA distinguishes int from real
// and several builtins select arguments BY TYPE: analogout takes the first two
// *ints* as (row, col) and reads its min/max/warn bounds from the *floats*
// after them (ipo_vm.py: `[x for x in stack if isinstance(x, int) and not
// isinstance(x, bool)]` vs `[x for x in stack[3:] if isinstance(x, float)]`).
// An unboxed 120.0 is Number.isInteger-true and would be misread as a col.
// Pool doubles (tag 'd') are boxed here so the int/float split survives; every
// numeric helper unwraps them. Mirrors Python's distinct float type.
function mkFloat(v) { return { __float: true, v }; }
function isFloat(x) { return x != null && x.__float === true; }

class Halt extends Error {}

// ------------------------------------------------------------- operators --

function truthy(v) {
  if (isFloat(v)) return !!v.v;
  if (isBound(v)) v = v.s;
  if (typeof v === 'string') return v !== '' && v !== '0';
  return !!v;
}

function num(v) {
  if (isFloat(v)) return v.v;
  if (isBound(v)) v = v.s;
  if (typeof v === 'number') return v;
  const f = parseFloat(String(v));
  return Number.isNaN(f) ? 0 : f;
}

// The (slot, key) an arithmetic result should keep from its operands, so a
// scaled reading (slot13 * scale) keeps STAT_..._WERT's key/slot.
function carry(a, b) {
  for (const x of [a, b]) {
    if (isBound(x) && (x.key || x.slot)) return [x.slot, x.key];
    if (isSlot(x)) return [x, null];
  }
  return [null, null];
}

// A numeric result, wrapped to keep an operand's slot/key when one had it, and
// to keep FLOAT identity when the maths is real (either operand a float, or the
// result non-integral) -- so a later type filter still sees a float.
function boundNum(value, a, b) {
  const [slot, key] = carry(a, b);
  const real = isFloat(a) || isFloat(b) || !Number.isInteger(value);
  if (slot == null && key == null) return real ? mkFloat(value) : value;
  return mkBound(slot, String(value), key);
}

function cmpEq(a, b) {
  if (isPlainStr(a) || isPlainStr(b) || isBound(a) || isBound(b)) {
    return asStr(a) === asStr(b);
  }
  if (isFloat(a) || isFloat(b)) return num(a) === num(b);
  // Python's `==` equates bool and int: True == 1, False == 0. A forced
  // keypress guard is the bool True compared against the const 1, so it must
  // read equal (LSZ's "start" gates STEUERN_IO on `g52 == 1`). JS === would
  // say true !== 1, closing the guard and skipping the job.
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const na = typeof a === 'boolean' ? (a ? 1 : 0) : a;
    const nb = typeof b === 'boolean' ? (b ? 1 : 0) : b;
    return na === nb;
  }
  return a === b;
}

function binop(name, a, b) {
  switch (name) {
    case 'add': {
      // BOTH SIDES NUMERIC -> ARITHMETIC, boxed or not. INPA's + on int
      // variables is addition; the slot/bound boxes exist so the offline
      // derivation can bind draws, and letting a box force concatenation
      // made a live accumulator compute '10'+10='1010' (llerh's setpoint on
      // the second keypress). boundNum keeps the slot and key riding on the
      // numeric result, so draw binding survives the arithmetic.
      const numish = (x) => typeof x === 'number' || isFloat(x) || isSlot(x)
        || (isBound(x) && /^-?\d+(\.\d+)?$/.test(String(x.s).trim()));
      if (numish(a) && numish(b)) return boundNum(num(a) + num(b), a, b);
      // + is BOTH concatenation and arithmetic. A row is often
      // `<bound slot> + " Werte"`; a slot concatenated must keep its identity
      // or the draw sees only text.
      let slot = null;
      for (const x of [a, b]) {
        if (isSlot(x)) slot = x;
        else if (isBound(x)) slot = x.slot;
        if (slot != null) break;
      }
      if (slot != null) {
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
      if (isPlainStr(a) || isPlainStr(b)) return asStr(a) + asStr(b);
      return boundNum(num(a) + num(b), a, b);
    }
    case 'sub': return boundNum(num(a) - num(b), a, b);
    case 'mul': return boundNum(num(a) * num(b), a, b);
    case 'div': return boundNum(num(b) ? num(a) / num(b) : 0, a, b);
    case 'eq': return cmpEq(a, b);
    case 'ne': return !cmpEq(a, b);
    case 'lt': return num(a) < num(b);
    case 'gt': return num(a) > num(b);
    case 'le': return num(a) <= num(b);
    case 'ge': return num(a) >= num(b);
    case 'and': return truthy(a) && truthy(b);
    case 'or': return truthy(a) || truthy(b);
    case 'neg': {
      // 0x6d is UNARY MINUS (ipo_disasm ground truth): llerh's "-10" is
      // `const 10; neg`, the clamp bounds are `const 128; neg`. Boolean-not
      // only ever fit guard shapes; a numeric operand negates arithmetically.
      const x = a == null ? b : a;
      const numish = typeof x === 'number' || isFloat(x)
        || (isBound(x) && /^-?\d+(\.\d+)?$/.test(String(x.s).trim()));
      if (numish) return boundNum(-num(x), x, null);
      return !truthy(x);
    }
    default: return null;
  }
}

function baseKey(key) {
  const u = String(key).toUpperCase();
  for (const suf of ['_WERT', '_EINH', '_TEXT', '_EINHEIT']) {
    if (u.endsWith(suf)) return key.slice(0, -suf.length);
  }
  return key;
}

// ---------------------------------------------------------------- host --

// Where the script's questions about the car get answered. Default is OFFLINE
// (mirrors ipo_vm.py's Host): jobs return nothing, reads read empty except the
// two invariants -- JOB_STATUS is OKAY, an integer read is 1 (one of every
// list) -- which is enough to walk the tree and draw the maximal structure. A
// live host would run the job through bestvm and hand back real results; the VM
// does not know the difference.
class OkHost {
  job(_sgbd, _job, _arg, _results) { return {}; }
  result(key, opts = {}) {
    if (key === 'JOB_STATUS') return this.status();
    if (opts.integer) return 1;
    return opts.default != null ? opts.default : '';
  }
  status() { return 'OKAY'; }
  inputstate() { return 0; }
}

// A host the guided driver FEEDS: resume(resultsMap) lands here, and the
// machine's INPAapiResult* reads serve from the most recent job's results --
// including JOB_STATUS, so INPAapiCheckJobStatus sees the wire's own verdict.
class FeedHost {
  constructor() { this.map = new Map(); }
  feed(m) {
    this.map = m instanceof Map ? m : new Map(Object.entries(m || {}));
  }
  job(_sgbd, _job, _arg, _results) { return {}; }
  result(key, opts = {}) {
    if (key === 'JOB_STATUS') return this.status();
    const v = this.map.get(key);
    if (v == null) {
      return opts.integer ? 0 : (opts.default != null ? opts.default : '');
    }
    return opts.integer ? (parseInt(v, 10) || 0) : String(v);
  }
  status() {
    const st = this.map.get('JOB_STATUS');
    return st != null ? String(st) : 'OKAY';
  }
  inputstate() { return 0; }
}

// The quit-mode confirmation a machine pops after a successful drive:
//     if (slotN == 1) messagebox(title, prefix + <ORT>)
// (ZKE5 sm_steuern: slot 29 = the "with Quitting" toggle, box "ACTIVATED
// DIGITAL VALUE / Signal : <ORT>"). Scanned from the bytecode so the slot and
// the words are INPA's own, never invented. Returns {slot, title, prefix} or
// null when the machine has no such box.
function scanQuitBox(toks) {
  if (!Array.isArray(toks)) return null;
  for (let i = 0; i + 4 < toks.length; i++) {
    const a = toks[i], b = toks[i + 1], c = toks[i + 2];
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

// ----------------------------------------------------------- emissions --

class Emissions {
  constructor() {
    this.title = null;
    this.items = [];
    this.lines = [];
    this.jobs = [];
    this.menu = null;
    this.screen = null;
    this.messages = [];
    this.calls = [];
    this.states = [];
    this.reads = [];
    this.predicateReads = new Set();
  }
}

// ----------------------------------------------------- keypress guards --

// Global slots this item body gates its whole action on -- keypress flags.
// INPA wraps a key's action in `if flag == 1 ...`; pressing the key means the
// flag is true, so run_item must force it -- but ONLY a guard flag (a GLOBAL
// compared by `eq` feeding a `jfalse`, before the body stores anything), never
// a global read as real data. Ported from ipo_vm.py _keypress_guards.
function keypressGuards(toks, start, end) {
  const guards = new Set(), stored = new Set();
  const lim = Math.min(end, toks.length);
  for (let k = start; k < lim; k++) {
    const t = toks[k], op = t.op;
    if (op === 'store' && (t.sc == null ? GLOBAL : t.sc) === GLOBAL) {
      stored.add(t.n);
    }
    if (op === 'var' && (t.sc == null ? GLOBAL : t.sc) === GLOBAL
        && !stored.has(t.n)) {
      const b = k + 1 < end ? toks[k + 1] : {};
      const c = k + 2 < end ? toks[k + 2] : {};
      if (b.op === 'const' && c.op === 'binop' && c.name === 'eq') {
        let gated = false;
        for (let j = k + 3; j < Math.min(k + 6, end); j++) {
          if (toks[j].op === 'jfalse') { gated = true; break; }
        }
        if (gated) guards.add(t.n);
      }
    }
  }
  return guards;
}

// ---------------------------------------------------------------- VM --

class IpoVm {
  // exec: {procs, byid, pool} from ipo_exec.py. byid keys are "type:id".
  constructor(exec, opts = {}) {
    this.procs = exec.procs || {};
    this.byidRaw = exec.byid || {};
    this.pool = exec.pool || [];
    this.host = opts.host || new OkHost();
    // wireJobs: the driven executor suspends on EVERY INPAapiJob (and on
    // builtin_1b waits), not only STEUERN/START -- the guided-procedure
    // driver runs each on the real wire and feeds the results back. Never
    // set by the headless diff harness, so offline parity is untouched.
    this.wireJobs = !!opts.wireJobs;
    // onText: live tap on every printed string (ftextout/messagebox), for the
    // guided driver's running log -- emissions can be repainted away by the
    // machine's own setscreen before the driver looks, the tap cannot.
    this.onText = typeof opts.onText === 'function' ? opts.onText : null;
    this.budget = opts.budget || 200000;

    this.globals = new Map();      // slot n (or ('ref',n) key) -> value
    this.refslots = new Map();     // n -> value parked under ("ref", n)
    this.out = new Emissions();
    this.steps = 0;
    this.entered = new Set();
    this.binds = new Map();        // "sc:n" -> result key
    this.files = new Map();
    this.fh = null;
    this.strArrays = new Map();
    this._arrN = 0;
    this.frame = null;
    this._itemTarget = null;

    // highest global slot touched, so run_item can preseed presence flags
    this._maxglobal = 0;
    for (const toks of Object.values(this.procs)) {
      for (const t of toks) {
        if ((t.op === 'var' || t.op === 'store')
            && (t.sc == null ? 0 : t.sc) === 0 && t.n > this._maxglobal) {
          this._maxglobal = t.n;
        }
      }
    }
  }

  byid(type, id) { return this.byidRaw[`${type}:${id}`]; }

  // Resolve a procref on the stack to a proc name.
  target(ref, kindName) {
    if (isRef(ref)) return this.byid(kindName, ref[2]);
    return null;
  }

  bindKey(sc, n) { return this.binds.get(`${sc}:${n}`); }
  setBind(sc, n, key) { this.binds.set(`${sc}:${n}`, key); }
  delBind(sc, n) { this.binds.delete(`${sc}:${n}`); }

  // ------------------------------------------------------------- run --

  run(proc, args) {
    const toks = this.procs[proc];
    if (!toks) throw new IpoError(`no proc ${proc}`);
    const frame = new Map();
    if (args) args.forEach((v, i) => frame.set(i, v));
    try { this._exec(toks, frame); } catch (e) {
      if (!(e instanceof Halt)) throw e;
    }
    return this.out;
  }

  // Execute one menu item's body as if its F-key were pressed. start/end are
  // TOKEN INDICES into the full menu token list (so the item's jumps resolve to
  // real targets). Presets keypress/enable flags true. Mirrors run_item.
  runItem(menuToks, start, end, item, presence = true) {
    if (presence) {
      const guards = keypressGuards(menuToks, start, end);
      for (let g = 0; g <= this._maxglobal; g++) {
        if (!this.globals.has(g)) {
          this.globals.set(g, true);
        } else if (guards.has(g)) {
          const cur = this.globals.get(g);
          if (cur === 0 || cur === false || cur == null) {
            this.globals.set(g, true);
          }
        }
      }
    }
    this._itemTarget = item;
    try {
      this._exec(menuToks, new Map(), start, end);
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
    } finally {
      this._itemTarget = null;
    }
    return item;
  }

  _exec(toks, frame, startAt = 0, stopAt = null) {
    const prev = this.frame;
    this.frame = frame;
    try { return this._execIn(toks, frame, startAt, stopAt); }
    finally { this.frame = prev; }
  }

  _execIn(toks, frame, startAt = 0, stopAt = null) {
    // byte offset -> token index, so a resolved jump target is a seek.
    const index = new Map();
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].at != null) index.set(toks[i].at, i);
    }
    // Stop at the first undecoded byte: a proc's block header sizes only its
    // own section, so garbage past the real end (unk tokens) would spin.
    let end = stopAt == null ? toks.length : stopAt;
    for (let j = 0; j < toks.length; j++) {
      if (toks[j].op === 'unk' && j < end) { end = j; break; }
    }

    let stack = [];
    let i = startAt;
    const curItemAtStart = this._itemTarget;
    let curItem = curItemAtStart;

    while (i < end) {
      this.steps += 1;
      if (this.steps > this.budget) throw new Halt('step budget');
      const t = toks[i];
      const op = t.op;

      if (op === 'frame') {
        stack = [];
      } else if (op === 'const') {
        // A pool double keeps its float identity so analogout's int/float
        // argument split matches Python (see mkFloat).
        stack.push(t.t === 'd' ? mkFloat(t.v) : t.v);
      } else if (op === 'var') {
        let val = this._read(t, frame);
        if (val == null) val = mkSlot(t.sc == null ? 0 : t.sc, t.n);
        stack.push(val);
      } else if (op === 'procref') {
        stack.push(['ref', t.kind, t.n]);
      } else if (op === 'store') {
        let val = stack.length ? stack.pop() : null;
        const sc = t.sc == null ? GLOBAL : t.sc;
        // A record index the item selects: `const <v>; store <global>`.
        if (curItem != null && sc === GLOBAL && !('_sel' in curItem)
            && (isPlainInt(val) || isPlainStr(val))) {
          curItem._sel = [t.n, val];
        }
        // A coding image stored for sliced display (INPAapiResultBinary path).
        const pend = this.globals.get('__pending_binary__');
        if (pend && isPlainStr(val)) {
          val = mkBound(mkSlot(sc, t.n), val, pend);
          this.setBind(sc, t.n, pend);
          this.globals.delete('__pending_binary__');
        }
        this._write(t, frame, val);
      } else if (op === 'binop') {
        const b = stack.length ? stack.pop() : null;
        const a = stack.length ? stack.pop() : null;
        if (['eq', 'ne', 'lt', 'gt', 'le', 'ge'].includes(t.name)) {
          for (const x of [a, b]) {
            if (isBound(x) && x.key) this.out.predicateReads.add(x.key);
          }
        }
        stack.push(binop(t.name, a, b));
      } else if (op === 'jfalse') {
        const cond = stack.length ? stack.pop() : false;
        if (!truthy(cond)) {
          const nxt = index.has(t.to) ? index.get(t.to) : end;
          this._harvestReads(toks, i + 1, nxt);
          if (nxt >= end) return;
          i = nxt;
          continue;
        }
      } else if (op === 'jump') {
        const nxt = index.has(t.to) ? index.get(t.to) : end;
        if (nxt >= end) return;
        i = nxt;
        continue;
      } else if (op === 'ITEM') {
        curItem = { nr: t.nr, label: t.label };
        this.out.items.push(curItem);
        stack = [];
      } else if (op === 'LINE') {
        this.out.lines.push({ label: t.label, elements: [] });
        stack = [];
      } else if (op === 'call') {
        this._builtin(t, stack, curItem);
        stack = [];
      } else if (op === 'calluser') {
        this._callUser(t, stack);
        stack = [];
      } else if (op === 'state') {
        // A yield, not a loop: park at the named state and stop.
        this.out.states.push(t.name);
        throw new Halt(`yield at ${t.name}`);
      } else if (op === 'ret') {
        return;
      }
      // block/decl/stmt/unk/dllcall/endproc: no runtime effect here
      i += 1;
    }
  }

  _callUser(t, stack) {
    // A call is not a new budget; only the frame is per-call. A conversion
    // helper turns a keyed value into a display string through an out-ref;
    // carry the input key onto an out-slot the callee left unfilled so the
    // draw is not anonymous (mirrors ipo_vm.py calluser).
    const name = this.byid('func', t.n);
    if (!name || !this.procs[name]) return;
    let inKey = null;
    for (const x of stack) if (isBound(x) && x.key) { inKey = x.key; break; }
    const outs = stack.filter(isRef);
    const frame = new Map();
    stack.forEach((v, i) => frame.set(i, v));
    this._exec(this.procs[name], frame);
    if (inKey) {
      for (const ref of outs) {
        const dsc = (ref[1] === 2 && this.frame != null) ? LOCAL : GLOBAL;
        const cur = dsc === GLOBAL ? this.globals.get(ref[2])
          : (this.frame ? this.frame.get(ref[2]) : null);
        if (isBound(cur) && cur.key) continue;
        const val = mkBound(mkSlot(dsc, ref[2]), '0', inKey);
        this.setBind(dsc, ref[2], inKey);
        if (dsc === GLOBAL) this.globals.set(ref[2], val);
        else if (this.frame) this.frame.set(ref[2], val);
      }
    }
  }

  // ------------------------------------------- resumable state driver --
  //
  // The offline _execIn HALTS at a `state` yield: enough to draw a screen or
  // recover a job, never to DRIVE a live state machine. A live actuator (INPA's
  // %STATE loop) parks at %Z_TOGGLE, shows a picker, and on the user's pick
  // RESUMES past the yield into builtin_16 + INPAapiJob. So this second executor
  // mirrors _execIn's op handling but, instead of throwing at `state`, SUSPENDS:
  // it saves (toks, i, stack, frame) and returns a pending action. The renderer
  // does the async part -- show the picker, confirm, send on the wire through
  // the ONE audited safe path -- then calls resume() to continue from i+1.
  //
  // It suspends at two points:
  //   * `state`  -- a yield; the drawn screen so far is the picker
  //   * a wire job (host.job returns a PENDING sentinel) -- the machine wants to
  //     run a job the offline host cannot answer; the renderer runs it live
  //
  // Between suspensions it is the SAME synchronous machine, so headless parity
  // with ipo_vm.py is unaffected (the diff harness never resumes).

  // Begin a resumable run of proc `name`. Returns the first pending action, or
  // {kind:'done'} if the proc finished without suspending.
  stepStart(name) {
    const toks = this.procs[name];
    if (!toks) throw new IpoError(`no proc ${name}`);
    return this._beginRange(toks, 0, this._procEnd(toks));
  }

  // INPA's KEYPRESS: run ONE item's body inside its menu proc. Starts after
  // the ITEM token, stops at the next one; the body's keypress-guard flags
  // are preset (pressing the key IS the flag); jumps resolve against the
  // whole proc, which slicing the body out would lose.
  stepStartItem(procName, nr) {
    const toks = this.procs[procName];
    if (!toks) throw new IpoError(`no proc ${procName}`);
    const idx = toks.findIndex((t) => t.op === 'ITEM' && t.nr === nr);
    if (idx < 0) throw new IpoError(`no item ${nr} in ${procName}`);
    let end = this._procEnd(toks);
    for (let j = idx + 1; j < end; j++) {
      if (toks[j].op === 'ITEM') { end = j; break; }
    }
    for (const g of keypressGuards(toks, idx + 1, end)) this.globals.set(g, 1);
    return this._beginRange(toks, idx + 1, end);
  }

  // A slice of a proc, driven (a menu's prologue: its title and defaults).
  stepStartRange(procName, i0, end) {
    const toks = this.procs[procName];
    if (!toks) throw new IpoError(`no proc ${procName}`);
    return this._beginRange(toks, i0, Math.min(end, this._procEnd(toks)));
  }

  _beginRange(toks, i0, end) {
    this._susp = { toks, frame: new Map(), i: i0, stack: [], callers: [],
                   index: this._byteIndex(toks), end,
                   remap: this._segRemap(toks) };
    return this._drive();
  }

  // Resume a suspended run. `value` is the result of the pending action: the
  // picked togglelist row (for a yield that opened a picker) or a job's result
  // sets (for a wire job). Returns the next pending action or {kind:'done'}.
  resume(value) {
    if (!this._susp) return { kind: 'done' };
    const s = this._susp;
    const wasYield = s.pending === 'yield';
    if (wasYield && value != null) {
      // the pick drives the machine: builtin_16 writes the component (ORT) into
      // the toggle out-var, getinputstate returns the on/off. Accept either a
      // bare ORT string (component only) or {ort, ein}. ein defaults to 0 (the
      // guard `getinputstate == 0` opens on a valid pick).
      if (typeof value === 'object' && !Array.isArray(value)) {
        this._pickInput = value.ort != null ? value.ort : null;
        this._driveInput = value.ein != null ? value.ein : 0;
      } else {
        this._pickInput = value;
        this._driveInput = 0;
      }
    } else if (s.pending === 'input') {
      if (s.pendingStack) {
        // the input's out-ref targets the SUSPENDED body's locals; resume
        // runs outside _drive, so switch to that frame for the store
        const prevFrame = this.frame;
        this.frame = s.frame;
        const n = Math.trunc(Number(value));
        storeOut(this, s.pendingStack,
                 Number.isFinite(n) ? n : 0, null);
        this.frame = prevFrame;
        s.pendingStack = null;
      }
    } else if (s.pending === 'job') {
      // the wire answered; fold its result keys in so a later read sees them
      this._lastJobSets = value || {};
      // ...and serve them to INPAapiResult*: the reads go through the host,
      // so a host that can be fed (FeedHost) is what closes the loop
      if (this.host && typeof this.host.feed === 'function') {
        this.host.feed(value);
      }
    }
    s.pending = null;
    s.i += 1;                       // step past the suspending token
    // A yield is followed by its WAIT-LOOP back-edge: `state %Z; jump <exit>`
    // is INPA's %WARTEN -- following that jump leaves the machine. Being DRIVEN
    // forward (the user's pick) runs the segment body AFTER the jump instead.
    // So on a yield-resume, step over the immediate unconditional jump into the
    // body; a job-resume lands mid-body and needs no skip.
    if (wasYield) {
      const jt = s.toks[s.i];
      if (jt && jt.op === 'jump') s.i += 1;
    }
    return this._drive();
  }

  // Keypress-flag globals the CURRENT wait segment tests (var N == const ->
  // jfalse before anything stores N): INPA's "Weiter"/"Start" keys set these.
  // The driver shows a Continue control when the parked segment has one.
  pendingGuards() {
    const s = this._susp;
    if (!s) return new Set();
    let end = s.end;
    for (let k = s.i + 1; k < s.end; k++) {
      if (s.toks[k].op === 'state') { end = k; break; }
    }
    return keypressGuards(s.toks, s.i + 1, end);
  }

  // Press a machine key: set its guard flag so the wait segment opens.
  pressKey(n) { this.globals.set(n, 1); }

  // JUMP TARGETS PAST A STATE ARE SEGMENT-RELATIVE. The compiler emits a
  // jump's u16 as a dword index from its enclosing BLOCK -- the proc body, an
  // ITEM/LINE body, or (the part the walker does not model) a %STATE segment:
  // each state label opens a new block whose dwords count from the token
  // after the state's own exit jump (the body the driven resume enters).
  // The walker resolves every target against the proc/ITEM base, so a target
  // inside a state segment lands short by the states' label bytes -- across
  // the corpus only 41% of intra-segment jumps hit a real token that way,
  // while re-basing per segment resolves 95.8% (and S_ZUHEIZ's Pruefung
  // becomes semantically exact: the measure loop's jfalse skips ONE store,
  // the Weiter guard exits to the %ENDE block). Offline execution never runs
  // past the first state (it halts there), so only the DRIVEN path needs
  // this; _execIn stays byte-identical to ipo_vm.py.
  //
  // A corrected target may land ON a `state` token: that is a generic park
  // (the current machine segment is what setstatemachine last set), which
  // the driven loop's yield handling already provides.
  _segRemap(toks) {
    const remap = new Map();
    if (!toks.length || toks[0].at == null) return remap;
    const at = (i) => toks[i].at;
    let walker = at(0) + 4;      // dword 0 of the proc's own block
    let seg = walker;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.op === 'ITEM' || t.op === 'LINE') {
        const nxt = i + 1 < toks.length ? at(i + 1) : at(i) + 4;
        walker = nxt;
        seg = nxt;
      } else if (t.op === 'state') {
        let j = i + 1;
        if (j < toks.length && toks[j].op === 'jump') j += 1;  // exit edge
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

  _byteIndex(toks) {
    const index = new Map();
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].at != null) index.set(toks[i].at, i);
    }
    return index;
  }

  _procEnd(toks) {
    let end = toks.length;
    for (let j = 0; j < toks.length; j++) {
      if (toks[j].op === 'unk') { end = j; break; }
    }
    return end;
  }

  // The resumable loop. Runs synchronously until it suspends or finishes.
  // Reads s.toks/s.index/s.end afresh each pass: a driven calluser SWITCHES
  // the suspension onto the callee, and stale locals would keep stepping the
  // caller's tape.
  _drive() {
    const s = this._susp;
    const prevFrame = this.frame;
    try {
      for (;;) {
        this.frame = s.frame;
        if (s.i >= s.end) {
          if (s.callers && s.callers.length) { this._popCall(s); continue; }
          break;
        }
        this.steps += 1;
        if (this.steps > this.budget) throw new Halt('step budget');
        const t = s.toks[s.i];
        const op = t.op;
        if (op === 'state') {
          // suspend: the drawn screen so far IS the picker
          this.out.states.push(t.name);
          s.pending = 'yield';
          return { kind: 'yield', name: t.name, out: this.out };
        }
        // every non-suspending op runs exactly as _execIn does, via a shared
        // single-step so the two executors cannot drift
        const sig = this._stepOne(t, op, s, s.index, s.end);
        if (sig === 'ret') {
          if (s.callers && s.callers.length) { this._popCall(s); continue; }
          break;
        }
        if (sig === 'jumped') continue;      // _stepOne already moved s.i
        if (sig === 'called') continue;      // switched into a callee
        if (sig && (sig.kind === 'job' || sig.kind === 'wait'
                    || sig.kind === 'input')) {
          // a wire job (the renderer runs it), a timed wait (it sleeps), or
          // a user prompt (it asks and hands the answer back)
          s.pending = sig.kind;
          if (sig.kind === 'input') s.pendingStack = sig.stack;
          return sig;
        }
        s.i += 1;
      }
    } finally {
      this.frame = prevFrame;
    }
    this._susp = null;
    return { kind: 'done', out: this.out };
  }

  // One token of the resumable loop. Mirrors _execIn's body exactly for every
  // op EXCEPT `state` (handled in _drive). Returns 'ret' | 'jumped' | a job
  // pending action | undefined (advance normally). s carries {stack, i, frame}.
  _stepOne(t, op, s, index, end) {
    let stack = s.stack;
    if (op === 'frame') { s.stack = []; }
    else if (op === 'const') {
      stack.push(t.t === 'd' ? mkFloat(t.v) : t.v);
    } else if (op === 'var') {
      let val = this._read(t, s.frame);
      if (val == null) val = mkSlot(t.sc == null ? 0 : t.sc, t.n);
      stack.push(val);
    } else if (op === 'procref') {
      stack.push(['ref', t.kind, t.n]);
    } else if (op === 'store') {
      let val = stack.length ? stack.pop() : null;
      const sc = t.sc == null ? GLOBAL : t.sc;
      const pend = this.globals.get('__pending_binary__');
      if (pend && isPlainStr(val)) {
        val = mkBound(mkSlot(sc, t.n), val, pend);
        this.setBind(sc, t.n, pend);
        this.globals.delete('__pending_binary__');
      }
      this._write(t, s.frame, val);
    } else if (op === 'binop') {
      const b = stack.length ? stack.pop() : null;
      const a = stack.length ? stack.pop() : null;
      stack.push(binop(t.name, a, b));
    } else if (op === 'jfalse') {
      const cond = stack.length ? stack.pop() : false;
      if (!truthy(cond)) {
        const nxt = this._jumpIndex(s, index, end);
        if (nxt >= end) return 'ret';
        s.i = nxt; return 'jumped';
      }
    } else if (op === 'jump') {
      const nxt = this._jumpIndex(s, index, end);
      if (nxt >= end) return 'ret';
      s.i = nxt; return 'jumped';
    } else if (op === 'ITEM') {
      s.stack = [];
    } else if (op === 'LINE') {
      this.out.lines.push({ label: t.label, elements: [] });
      s.stack = [];
    } else if (op === 'call') {
      const sig = this._builtinDrive(t, stack);
      s.stack = [];
      if (sig) return sig;             // a wire-job pending action
    } else if (op === 'calluser') {
      const entered = this._pushCall(s, t, stack);
      s.stack = [];
      if (entered) return 'called';
    } else if (op === 'ret') {
      return 'ret';
    }
    return undefined;
  }

  // DRIVE INTO THE CALLEE. The offline _callUser executes a user function
  // through the offline executor, so a job inside a helper never suspends --
  // and INPA puts the send inside helpers routinely (ms450's llerh(delta)
  // computes the setpoint and calls START_SYSTEMCHECK_LLERH itself). The
  // driven path keeps a call stack instead: switch the suspension onto the
  // callee's tokens; _drive pops back on ret/end. Falls back to the offline
  // call (a noop for an unknown function) exactly as before.
  _pushCall(s, t, stack) {
    const name = this.byid('func', t.n);
    if (!name || !this.procs[name]) return false;
    let inKey = null;
    for (const x of stack) if (isBound(x) && x.key) { inKey = x.key; break; }
    const outs = stack.filter(isRef);
    const frame = new Map();
    stack.forEach((v, i) => frame.set(i, v));
    if (!s.callers) s.callers = [];
    s.callers.push({ toks: s.toks, i: s.i, end: s.end, index: s.index,
                     remap: s.remap, frame: s.frame, inKey, outs });
    const toks = this.procs[name];
    s.toks = toks;
    s.i = 0;
    s.end = this._procEnd(toks);
    s.index = this._byteIndex(toks);
    s.remap = this._segRemap(toks);
    s.frame = frame;
    return true;
  }

  // Return from a driven callee: the same conversion-helper key carry the
  // offline _callUser performs, then the caller's suspension is restored.
  _popCall(s) {
    const c = s.callers.pop();
    this.frame = c.frame;
    if (c.inKey) {
      for (const ref of c.outs) {
        const dsc = (ref[1] === 2 && this.frame != null) ? LOCAL : GLOBAL;
        const cur = dsc === GLOBAL ? this.globals.get(ref[2])
          : (this.frame ? this.frame.get(ref[2]) : null);
        if (!(isBound(cur) && cur.key)) {
          const val = mkBound(mkSlot(dsc, ref[2]), '0', c.inKey);
          this.setBind(dsc, ref[2], c.inKey);
          if (dsc === GLOBAL) this.globals.set(ref[2], val);
          else if (this.frame) this.frame.set(ref[2], val);
        }
      }
    }
    s.toks = c.toks;
    s.i = c.i + 1;
    s.end = c.end;
    s.index = c.index;
    s.remap = c.remap;
    s.frame = c.frame;
  }

  // The driven executor's jump resolution: the segment-rebased target first
  // (see _segRemap), the walker's raw byte target as the fallback for the
  // few machines outside the model. A target neither resolves = exit.
  _jumpIndex(s, index, end) {
    const t = s.toks[s.i];
    const ct = s.remap ? s.remap.get(s.i) : undefined;
    if (ct !== undefined && index.has(ct)) return index.get(ct);
    return index.has(t.to) ? index.get(t.to) : end;
  }

  // builtin dispatch for the resumable path. Identical to _builtin EXCEPT a
  // drive job (STEUERN_*/START*) is not answered offline -- it returns a `job`
  // pending action so the renderer runs it through the audited safe drive path.
  _builtinDrive(t, stack) {
    const name = t.name
      || `builtin_${(t.n || 0).toString(16).padStart(2, '0')}`;
    if (name === 'INPAapiJob' || name === 'INP1apiJob'
        || name === 'INPAapiJobData') {
      const strv = (x) => (isPlainStr(x) ? x : (isBound(x) ? x.s
        : (typeof x === 'number' ? String(x)
          : (isFloat(x) ? String(x.v) : null))));
      const sgbd = stack.length > 0 ? strv(stack[0]) : null;
      const job = stack.length > 1 ? strv(stack[1]) : null;
      const arg = stack.length > 2 ? strv(stack[2]) : null;
      if (job && (this.wireJobs || /^(STEUERN|START)/i.test(job))) {
        // hand the drive to the renderer; it confirms, registers for release,
        // sends on the wire, and hands the result sets back through resume()
        return { kind: 'job', job, sgbd: sgbd || null,
                 arg: arg || null, out: this.out };
      }
    }
    // input builtins: INPA asks the user and parks until getinputstate says
    // confirmed. Offline they store '0' -- which a LIVE run must never send
    // (LLERH's Select would command idle target 0). Suspend instead; the
    // renderer shows INPA's own prompt and resume() stores the typed value.
    if (this.wireJobs && /^input(int|real|hex|string)?$/.test(name)) {
      const prompts = stack.filter((x) => isPlainStr(x) && x.trim());
      const ints = stack.filter((x) => isPlainInt(x));
      return { kind: 'input', name, prompts,
               lo: ints.length > 1 ? ints[ints.length - 2] : null,
               hi: ints.length > 1 ? ints[ints.length - 1] : null,
               stack, out: this.out };
    }
    // builtin_1b = wartezeit(ms). Offline a noop; a guided run honours it --
    // the S_ZUHEIZ Pruefung waits 2000ms after DIAGNOSE_ENDE and 10000ms for
    // the heater's run-on, and rushing those changes what the ECU answers.
    if (this.wireJobs && name === 'builtin_1b') {
      const ms = stack.find((x) => isPlainInt(x));
      return { kind: 'wait', ms: ms != null ? ms : 0, out: this.out };
    }
    // not a drive: run it exactly as the offline builtin would
    this._builtin(t, stack, null);
    return null;
  }

  // ------------------------------------------------------------ reads --

  // Record result keys an unexecuted branch reads, without running it, so the
  // union of keys across arms matches a full static decode of every branch.
  // Follows calluser into the callee (guarded against recursion). Ported from
  // _harvest_reads.
  _harvestReads(toks, lo, hi, seen) {
    if (!seen) seen = new Set();
    hi = Math.min(hi, toks.length);
    for (let k = lo; k < hi; k++) {
      const t = toks[k], op = t.op;
      if (op === 'calluser') {
        const name = this.byid('func', t.n);
        if (name && this.procs[name] && !seen.has(name)) {
          seen.add(name);
          const body = this.procs[name];
          this._harvestReads(body, 0, body.length, seen);
        }
        continue;
      }
      if (op !== 'call' || !(t.name || '').includes('Result')) continue;
      for (let b = k - 1; b >= Math.max(lo, k - 10); b--) {
        const tb = toks[b];
        const v = tb.op === 'const' ? tb.v : null;
        if (typeof v === 'string' && v) {
          if (!this.out.reads.includes(v)) this.out.reads.push(v);
          break;
        }
      }
    }
  }

  _read(t, frame) {
    const sc = t.sc == null ? GLOBAL : t.sc;
    if (sc === GLOBAL) return this.globals.has(t.n) ? this.globals.get(t.n)
      : null;
    return frame.has(t.n) ? frame.get(t.n) : null;
  }

  _write(t, frame, val) {
    // Store through an out-parameter: the slot holds a ('ref',kind,n) tuple, so
    // the write lands in the CALLER's slot. Mirrors ipo_vm.py _write.
    if (t.ref) {
      const sc = t.sc == null ? GLOBAL : t.sc;
      const src = sc !== GLOBAL ? (frame ? frame.get(t.n) : null)
        : this.globals.get(t.n);
      if (isRef(src)) {
        const dsc = (src[1] === 2 && frame != null) ? LOCAL : GLOBAL;
        const n = src[2];
        const key = (isBound(val) && val.key) ? val.key : null;
        if (key) this.setBind(dsc, n, key); else this.delBind(dsc, n);
        if (dsc === GLOBAL) this.globals.set(n, val);
        else if (frame) frame.set(n, val);
        return;
      }
    }
    const sc = t.sc == null ? GLOBAL : t.sc;
    if (sc === GLOBAL) this.globals.set(t.n, val);
    else frame.set(t.n, val);
  }

  // --------------------------------------------------------- builtins --

  _builtin(t, stack, curItem) {
    const name = t.name || `builtin_${t.n.toString(16).padStart(2, '0')}`;
    this.out.calls.push(name);
    const fn = BUILTINS[name];
    if (fn) fn(this, stack, curItem);
  }
}

// ------------------------------------------------------- builtin helpers --

// The result key of the first argument that carries one.
function keyed(stack) {
  for (const x of stack) if (isBound(x) && x.key) return x.key;
  return null;
}

// The destination a builtin writes through, or null (first procref).
function outRef(stack) {
  for (const x of stack) if (isRef(x)) return x;
  return null;
}

// Write a builtin's answer through its out-parameter. Returns slot or null.
function storeOut(vm, stack, val, key) {
  const dest = outRef(stack);
  if (dest == null) return null;
  const sc = (dest[1] === 2 && vm.frame != null) ? LOCAL : GLOBAL;
  const n = dest[2];
  if (key != null) {
    const amap = isBound(val) ? val.amap : null;
    val = mkBound(mkSlot(sc, n), val == null ? '' : asStr(val), key);
    val.amap = amap;
    vm.setBind(sc, n, key);
  }
  if (sc === GLOBAL) {
    // An offline non-answer must not overwrite a preset presence flag (true).
    const empty = val === '' || val == null || (isBound(val) && val.s === '');
    if (!empty || vm.globals.get(n) !== true) vm.globals.set(n, val);
  } else if (vm.frame) {
    vm.frame.set(n, val);
  }
  return n;
}

function firstStr(stack) {
  for (const x of stack) if (isPlainStr(x)) return x;
  return null;
}
function allStrs(stack) { return stack.filter(isPlainStr); }
function allInts(stack) {
  return stack.filter((x) => isPlainInt(x) && typeof x !== 'boolean');
}

// ----------------------------------------------------------- builtins --

function bSetTitle(vm, stack) { if (stack.length) vm.out.title = asStr(stack[0]); }

function bSetitem(vm, stack) {
  const nr = stack.find(isPlainInt);
  const cap = stack.find(isPlainStr);
  if (nr != null) vm.out.items.push({ nr, label: cap, fromSetitem: true });
}

function bSetmenu(vm, stack, item) {
  const ref = stack.find(isRef);
  const tgt = vm.target(ref, 'menu');
  if (tgt) { vm.out.menu = tgt; if (item) item.menu = tgt; }
}

function bSetscreen(vm, stack, item) {
  const ref = stack.find(isRef);
  const tgt = vm.target(ref, 'screen');
  if (tgt) { vm.out.screen = tgt; if (item) item.screen = tgt; }
}

function bJob(vm, stack, item) {
  // Python's _b_job tests isinstance(x, str), TRUE for _Bound (str subclass):
  // sgbd/job/arg are frequently concatenations (a bound value), so accept
  // those and read their text -- otherwise the job arg (LWS5's coding block
  // index, LAR;0x;0) and an empty-string sgbd are lost.
  const strv = (x) => (isPlainStr(x) ? x : (isBound(x) ? x.s : null));
  const sgbd = stack.length > 0 ? strv(stack[0]) : null;
  const job = stack.length > 1 ? strv(stack[1]) : null;
  const arg = stack.length > 2 ? strv(stack[2]) : null;
  if (job == null) return;
  const rec = { job, sgbd: sgbd == null ? null : sgbd };
  if (arg) rec.arg = arg;
  vm.out.jobs.push(rec);
  if (item && !('job' in item)) {
    item.job = job;
    if (rec.arg) item.jobArg = rec.arg;
  }
  // Per-line arg boundary (per-wheel loop draws one line per job arg).
  if (rec.arg) {
    let last = vm.out.lines.length ? vm.out.lines[vm.out.lines.length - 1]
      : null;
    const drawn = !!(last && last.elements && last.elements.length);
    if (drawn && last.jobArg != null && last.jobArg !== rec.arg) {
      vm.out.lines.push({ label: null, elements: [] });
      last = vm.out.lines[vm.out.lines.length - 1];
    }
    if (last && !('jobArg' in last)) last.jobArg = rec.arg;
  }
  vm.globals.set('__last_job__', vm.host.job(sgbd, job, arg, null));
}

function bFsmode(vm, stack, item) { if (item) item.faultRead = true; }

function bCheckStatus(vm) { vm.globals.set('__status__', vm.host.status()); }

function bResult(vm, stack, item, integer) {
  const key = stack.find(isPlainStr) || null;
  let val = key ? vm.host.result(key, { integer }) : '';
  const refs = stack.filter(isRef);
  if (refs.length >= 2) storeOut(vm, [refs[0]], 1);
  const dest = refs.length ? refs[refs.length - 1] : null;
  if (dest != null) {
    const sc = dest[1] === 2 ? 2 : 0;
    if (key) {
      val = mkBound(mkSlot(sc, dest[2]), val == null ? '' : asStr(val), key);
      vm.setBind(sc, dest[2], key);
    }
    vm.globals.set(`ref:${dest[2]}`, val);
    if (sc === GLOBAL) vm.globals.set(dest[2], val);
    else if (vm.frame) vm.frame.set(dest[2], val);
  }
  if (key) {
    vm.globals.set('__lastkey__', key);
    vm.out.reads.push(key);
  }
}
function bResultInt(vm, stack, item) { bResult(vm, stack, item, true); }

function bErrorCode(vm, stack) { storeOut(vm, stack, 0); }
function bErrorText(vm, stack) { storeOut(vm, stack, ''); }

function bResultSets(vm, stack) {
  const refs = stack.filter(isRef);
  if (refs.length >= 2) storeOut(vm, [refs[0]], 1);
  storeOut(vm, refs.length ? [refs[refs.length - 1]] : [], 1);
}

function bStrArrayCreate(vm, stack) {
  const refs = stack.filter(isRef);
  vm._arrN += 1;
  vm.strArrays.set(vm._arrN, new Map());
  if (refs.length >= 2) storeOut(vm, [refs[0]], 1);
  storeOut(vm, refs.length ? [refs[refs.length - 1]] : [], vm._arrN);
}

function bStrArrayWrite(vm, stack) {
  const ints = stack.filter((x) => (typeof x === 'number' || isBound(x))
    && typeof x !== 'boolean').map((x) => Math.trunc(num(x)));
  const txt = stack.find((x) => isPlainStr(x));
  if (ints.length >= 2 && txt != null && vm.strArrays.has(ints[0])) {
    vm.strArrays.get(ints[0]).set(ints[1], txt);
  }
}

function bStrArrayRead(vm, stack) {
  const vals = stack.filter((x) => !isRef(x));
  const arr = vals.length ? (vm.strArrays.get(Math.trunc(num(vals[0])))
    || new Map()) : new Map();
  const text = vals.length > 1 ? (arr.get(Math.trunc(num(vals[1]))) || '') : '';
  const out = mkBound(null, text, keyed(stack));
  const amap = {};
  for (const [k, v] of arr) amap[String(k)] = v;
  out.amap = Object.keys(amap).length ? amap : null;
  storeOut(vm, stack, out, out.key);
}

function bResultBinary(vm, stack) {
  const key = stack.find(isPlainStr) || null;
  if (key) { vm.globals.set('__pending_binary__', key); vm.out.reads.push(key); }
}

function bGetBinaryDataString(vm, stack) {
  const refs = stack.filter(isRef);
  if (refs.length < 2) return;
  const dst = refs[0], src = refs[1];
  const dsc = (dst[1] === 2 && vm.frame != null) ? LOCAL : GLOBAL;
  const ssc = (src[1] === 2 && vm.frame != null) ? LOCAL : GLOBAL;
  let key = vm.bindKey(ssc, src[2]);
  if (!key) {
    key = vm.globals.get('__pending_binary__');
    vm.globals.delete('__pending_binary__');
  }
  if (!key) return;
  const val = mkBound(mkSlot(dsc, dst[2]), '0', key);
  vm.setBind(dsc, dst[2], key);
  if (dsc === GLOBAL) vm.globals.set(dst[2], val);
  else if (vm.frame) vm.frame.set(dst[2], val);
}

function bTextout(vm, stack) {
  if (vm.onText) {
    const t = stack.find((x) => isPlainStr(x) || isBound(x));
    if (t != null && String(t).trim()) vm.onText(asStr(t));
  }
  // ftextout(text/slot, row, col, ...): a printed literal, or a printed VALUE
  // whose key comes from the binding. A bound value wins over a literal.
  let key = null, also = [];
  for (const x of stack) {
    if (isBound(x) && x.key) {
      key = x.key;
      also = (x.extra || []).filter((k) => k !== key);
      break;
    }
    const sl = isBound(x) ? x.slot : (isSlot(x) ? x : null);
    if (sl != null) {
      key = vm.bindKey(sl.sc, sl.n);
      if (key) break;
    }
  }
  const lit = firstStr(stack);
  if (key == null && lit == null) return;
  const ints = allInts(stack);
  if (!vm.out.lines.length) vm.out.lines.push({ label: null, elements: [] });
  const line = vm.out.lines[vm.out.lines.length - 1];
  // A drawn unit folds onto the value element sharing its base.
  if (key && /(_EINH|_EINHEIT)$/.test(key.toUpperCase())) {
    for (let e = line.elements.length - 1; e >= 0; e--) {
      const el = line.elements[e];
      if (el.key && baseKey(el.key) === baseKey(key)
          && !/(_EINH|_EINHEIT)$/.test(el.key.toUpperCase())) {
        el.unit = key;
        return;
      }
    }
  }
  let el;
  if (key) {
    el = { t: 'value', key };
    if (also.length) el.also = also;
    const amap = stack.map((x) => (isBound(x) ? x.amap : null))
      .find((m) => m);
    if (amap) el.map = amap;
  } else {
    el = { t: 'text', s: lit };
  }
  if (ints.length >= 2) { el.row = ints[0]; el.col = ints[1]; }
  line.elements.push(el);
}

function field(vm, stack, kind) {
  const ints = allInts(stack);
  const strs = allStrs(stack);
  const el = { t: kind === 'analog' ? 'gauge' : 'lamp' };
  if (ints.length >= 2) { el.row = ints[0]; el.col = ints[1]; }
  let key = keyed(stack);
  if (key == null) {
    let sl = null;
    for (const x of stack) if (isBound(x) && x.slot) { sl = x.slot; break; }
    if (sl == null) sl = stack.find(isSlot) || null;
    if (sl != null) key = vm.bindKey(sl.sc, sl.n);
  }
  if (key) el.key = key;
  if (kind === 'digital' && strs.length >= 2) {
    el.on = strs[strs.length - 2].trim();
    el.off = strs[strs.length - 1].trim();
  }
  if (!vm.out.lines.length) vm.out.lines.push({ label: null, elements: [] });
  vm.out.lines[vm.out.lines.length - 1].elements.push(el);
  return el;
}

function bAnalogout(vm, stack) {
  const el = field(vm, stack, 'analog');
  // Python: [x for x in stack[3:] if isinstance(x,(int,float)) and not bool].
  // Both ints and floats count; a boxed float unwraps via num().
  const nums = stack.slice(3)
    .filter((x) => (isFloat(x) || (typeof x === 'number' && typeof x
      !== 'boolean')))
    .map(num);
  if (nums.length >= 2) { el.min = nums[0]; el.max = nums[1]; }
  if (nums.length >= 4) { el.warnLo = nums[2]; el.warnHi = nums[3]; }
  // Python: next(x for x in stack if isinstance(x,str) and x.strip()) --
  // includes _Bound. A fmt built by concatenation is a _Bound.
  const fmt = stack.find((x) => (isPlainStr(x) || isBound(x)) && asStr(x).trim());
  if (fmt) el.fmt = asStr(fmt).trim();
}

function bMultiAnalogout(vm, stack) {
  let group = [], drawn = 0;
  for (const x of stack) {
    group.push(x);
    if (isPlainStr(x) && x.trim()) { bAnalogout(vm, group); drawn += 1; group = []; }
  }
  if (!drawn) bAnalogout(vm, stack);
}

function bDigitalout(vm, stack) { field(vm, stack, 'digital'); }

function bStrlen(vm, stack) {
  // Python's _b_strlen: next(x for x in stack if isinstance(x, str)) -- a
  // _Bound (str subclass) counts, a _Slot does not. instr's Text argument is a
  // concatenation (a _Bound), so excluding it read length 0 and skipped the
  // whole substring loop.
  const x = stack.find((v) => isPlainStr(v) || isBound(v));
  storeOut(vm, stack, x == null ? 0 : asStr(x).length);
}

function bMidstr(vm, stack) {
  // Python: strs = [x for x in stack if isinstance(x, str)] -- includes _Bound.
  const strs = stack.filter((x) => isPlainStr(x) || isBound(x)).map(asStr);
  const ints = allInts(stack);
  const src = strs.length ? strs[strs.length - 1] : '';
  const a = ints.length ? ints[0] - 1 : 0;
  const n = ints.length > 1 ? ints[1] : src.length;
  storeOut(vm, stack, src.slice(Math.max(0, a), Math.max(0, a) + Math.max(0, n)),
    keyed(stack));
}

function bInttostring(vm, stack) {
  let n = stack.find((x) => typeof x === 'number' || isFloat(x));
  if (n == null) {
    // A BOUND VALUE COUNTS AS A STRING. Python's _b_inttostring tests
    // isinstance(x, str), which _Bound (a str subclass) passes -- so a job
    // result written through INPAapiResult* converts there. The JS box is
    // not a string subclass, and matching plain strings only zeroed every
    // converted result: S_ZUHEIZ printed "Startzähler : 0" for a counter
    // the wire answered 7.
    const s = stack.find((x) => isPlainStr(x) || isBound(x));
    n = parseFloat(asStr(s));
    if (Number.isNaN(n)) n = 0;
  } else {
    n = num(n);
  }
  storeOut(vm, stack, String(Math.trunc(n)), keyed(stack));
}

function bMessage(vm, stack, item) {
  // Python's _b_message uses isinstance(x, str), which is TRUE for _Bound (a
  // str subclass) -- the body is often a concatenation, so a bound value.
  const strs = stack.filter((x) => isPlainStr(x) || isBound(x)).map(asStr);
  if (vm.onText && strs.length) vm.onText(strs.join(' — '));
  if (strs.length) {
    vm.out.messages.push({ title: strs[0], body: strs.length > 1 ? strs[1]
      : null });
    if (item) (item.messages = item.messages || []).push(strs[0]);
  }
}

function bGetInputState(vm, stack) {
  // When the state machine is being DRIVEN (a resume fed us the user's on/off),
  // that answer is the input state; the guard tests `== 0`, so a valid pick is
  // 0. Offline (no drive) it falls to the host's placeholder, unchanged.
  const iv = vm._driveInput;
  storeOut(vm, stack, iv != null ? iv : vm.host.inputstate());
}

// builtin_16 = togglelist. Offline it is a noop (the picked row is runtime-only,
// so the diff harness sees nothing). When DRIVEN, it writes the user's picked
// component (an ORT key from the BITS table) into its out-var, exactly as the
// widget does at runtime -- so the INPAapiJob that reads that slot sends the
// pick as its argument (STEUERN_DIGITAL <ORT>).
function bToggleList(vm, stack) {
  if (vm._pickInput == null) return;          // offline: noop, as before
  storeOut(vm, stack, vm._pickInput);
}

function bInput(vm, stack, item) {
  const prompts = stack.filter((x) => isPlainStr(x) && x.trim());
  if (item && prompts.length) {
    const have = item.prompt || (item.prompt = []);
    for (const p of prompts) if (!have.includes(p)) have.push(p);
  }
  for (const ref of stack.filter(isRef)) storeOut(vm, [ref], '0');
}

function bFileopen(vm, stack) {
  const path = stack.filter((x) => (isPlainStr(x) || isSlot(x))
    && !['r', 'w', 'a'].includes(x)).map(asStr).join('');
  let mode = 'r';
  for (let k = stack.length - 1; k >= 0; k--) {
    if (isPlainStr(stack[k]) && ['r', 'w', 'a'].includes(stack[k])) {
      mode = stack[k]; break;
    }
  }
  if (mode === 'w') vm.files.set(path, []);
  else if (mode === 'a' && !vm.files.has(path)) vm.files.set(path, []);
  vm.fh = { path, mode, line: 0 };
}
function bFileclose(vm) { vm.fh = null; }
function bFilewrite(vm, stack) {
  if (!vm.fh || vm.fh.mode === 'r') return;
  const txt = stack.find(isPlainStr) || '';
  if (!vm.files.has(vm.fh.path)) vm.files.set(vm.fh.path, []);
  vm.files.get(vm.fh.path).push(txt);
}
function bFileread(vm, stack) {
  let line = '';
  if (vm.fh && vm.fh.mode === 'r') {
    const lines = vm.files.get(vm.fh.path) || [];
    if (vm.fh.line < lines.length) { line = lines[vm.fh.line]; vm.fh.line += 1; }
  }
  storeOut(vm, stack, line);
}

function bSelect(vm, stack, item) {
  if (item && !item.action) item.action = 'select';
}
function bDeselect(vm, stack, item) {
  if (item && !item.action) item.action = 'deselect';
}
function bExit(vm, stack, item) { if (item) item.action = 'exit'; }
function bPrint(vm, stack, item) { if (item) item.action = 'printscreen'; }
function bScriptchange(vm, stack, item) { if (item) item.appTool = true; }
function bCallwin(vm, stack, item) { if (item) item.appTool = true; }
function bNoop() {}

// setstate/start: enter a state machine, run to its first yield, attribute the
// job it fired to this key. (Prototype: the simple case -- run and record the
// first job; the togglelist/fixed-job recovery of ipo_vm.py's _b_setstate is a
// production refinement, not needed for the three test cases.)
function bSetstate(vm, stack, item) {
  const ref = stack.find((x) => isRef(x) && (x[1] === 66 || x[1] === 67));
  if (ref == null) return;
  const name = vm.byid('state', ref[2]);
  if (!name || !vm.procs[name]) return;
  if (item) item.stateEnter = name;
  if (vm.entered.has(name)) return;
  vm.entered.add(name);
  const before = vm.out.jobs.length;
  try { vm._exec(vm.procs[name], new Map()); } catch (e) {
    if (!(e instanceof Halt)) throw e;
  }
  if (item && !('job' in item) && vm.out.jobs.length > before) {
    const j = vm.out.jobs[before];
    item.job = j.job;
    item.stateJob = true;
    if (j.arg && !item.jobArg) item.jobArg = j.arg;
  }
}

const BUILTINS = {
  setmenutitle: bSetTitle,
  settitle: bSetTitle,
  setitem: bSetitem,
  setmenu: bSetmenu,
  setscreen: bSetscreen,
  INPAapiJob: bJob,
  INP1apiJob: bJob,
  INPAapiFsMode: bFsmode,
  INPAapiCheckJobStatus: bCheckStatus,
  INPAapiResultText: bResult,
  INPAapiResultAnalog: bResult,
  INPAapiResultDigital: bResult,
  INPAapiResultInt: bResultInt,
  INP1apiResultText: bResult,
  INP1apiResultInt: bResultInt,
  ftextout: bTextout,
  textout: bTextout,
  text: bTextout,
  userboxftextout: bTextout,
  messagebox: bMessage,
  builtin_53: bMessage,
  exit: bExit,
  printscreen: bPrint,
  scriptchange: bScriptchange,
  callwin: bCallwin,
  analogout: bAnalogout,
  digitalout: bDigitalout,
  multianalogout: bMultiAnalogout,
  strlen: bStrlen,
  midstr: bMidstr,
  inttostring: bInttostring,
  inttolong: bInttostring,
  bytetoint: bInttostring,
  realtostring: bInttostring,
  SetStructureMode: bNoop,
  CreateStructure: bNoop,
  StructureByte: bNoop,
  StructureString: bNoop,
  StructureInt: bNoop,
  StructureLong: bNoop,
  userboxopen: bNoop,
  userboxclose: bNoop,
  viewopen: bNoop,
  viewclose: bNoop,
  setstate: bSetstate,
  start: bSetstate,
  select: bSelect,
  deselect: bDeselect,
  INPAapiInit: bNoop,
  INPAapiEnd: bNoop,
  INPAapiFsLesen: bNoop,
  INP1apiErrorText: bErrorText,
  INP1apiErrorCode: bErrorCode,
  INP1apiResultSets: bResultSets,
  getinputstate: bGetInputState,
  inputhex: bNoop,
  builtin_3f: bInput,
  input2text: bInput,
  input2hexnum: bInput,
  inputint: bInput,
  fileopen: bFileopen,
  fileclose: bFileclose,
  filewrite: bFilewrite,
  fileread: bFileread,
  hexdump: bNoop,
  printfile: bNoop,
  setstatemachine: bNoop,
  StrArrayCreate: bStrArrayCreate,
  StrArrayDestroy: bNoop,
  StrArrayWrite: bStrArrayWrite,
  StrArrayRead: bStrArrayRead,
  StrArrayDelete: bNoop,
  INPAapiResultBinary: bResultBinary,
  GetBinaryDataString: bGetBinaryDataString,
  // builtin_16 = togglelist: writes the picked row into an out variable. Offline
  // a noop (the pick is runtime-only); when driven it stores the user's pick.
  builtin_16: bToggleList,
  builtin_12: bNoop,   // start (0x12): begins the selected sequence
};

// Loaded two ways: as a <script> in the app (globals) and via require() in the
// headless harness (module.exports).
if (typeof window !== 'undefined') {
  window.IpoVm = IpoVm;
  window.IpoError = IpoError;
  window.OkHost = OkHost;
  window.FeedHost = FeedHost;
  window.scanQuitBox = scanQuitBox;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IpoVm, IpoError, OkHost, FeedHost, scanQuitBox,
                     Emissions, mkBound, mkSlot, isBound, isSlot, binop };
}
