/**
 * @file The .IPO executor. Two ways to run a proc: the OFFLINE executor
 * (run / runItem) halts at a `state` yield -- enough to draw a screen or
 * recover a job, byte-identical to ipo_vm.py; and the RESUMABLE driver
 * (stepStart / stepStartItem / stepStartRange + resume) SUSPENDS instead,
 * saving (toks, i, stack, frame) and returning a pending action, so the
 * renderer can show the picker, confirm, send on the wire through the ONE
 * audited safe path, and continue from the next token. Between suspensions
 * it is the same synchronous machine, so headless parity is unaffected (the
 * diff harness never resumes).
 *
 * The public API the app and the harnesses load is exported at the end of
 * this file; it is the last piece of core/ipovm/ in load order.
 */

/** The offline executor's default step budget: a runaway guard per VM. */
const IPO_DEFAULT_BUDGET = 200000;

/** How many reference hops _refTarget follows before giving up. */
/** the comparisons a never-written local takes its default in */
const IPO_CMP_OPS = new Set(['eq', 'ne', 'lt', 'gt', 'le', 'ge']);

/**
 * What an unwritten local is worth beside `other` at run time: '' beside a
 * string, 0 otherwise.
 * @param {IpoValue} other - the operand on the other side
 * @returns {IpoValue}
 */
function ipoSlotDefault(other) {
  return isPlainStr(other) || isBound(other) ? '' : 0;
}

const IPO_REF_MAX_HOPS = 8;

/** How far back of a Result* call _harvestReads looks for its key. */
const IPO_HARVEST_LOOKBACK = 10;

/**
 * The saved state of a suspended run.
 * @typedef {object} IpoSuspension
 * @property {IpoToken[]} toks - the tape being run
 * @property {Map<number, IpoValue>} frame - the current frame's slots
 * @property {number} i - token index to continue at
 * @property {IpoValue[]} stack - the operand stack
 * @property {IpoCallRecord[]} callers - the driven call stack
 * @property {Map<number, number>} index - byte offset -> token index
 * @property {number} end - token index the run ends at
 * @property {Map<number, number>} remap - segment-rebased jump targets
 * @property {string|null} [pending] - the kind of action it is parked on
 * @property {IpoValue[]|null} [pendingStack] - the parked call's arguments
 */

/**
 * A driven caller, saved while its callee runs.
 * @typedef {object} IpoCallRecord
 * @property {IpoToken[]} toks - the caller's tape
 * @property {number} i - the calluser token's index
 * @property {number} end - the caller's end
 * @property {Map<number, number>} index - the caller's byte index
 * @property {Map<number, number>} remap - the caller's segment remap
 * @property {Map<number, IpoValue>} frame - the caller's frame
 * @property {string|null} inKey - the key carried in through the arguments
 * @property {IpoRef[]} outs - the out-refs the callee may leave unfilled
 */

/**
 * The picker's answer to a toggle/yield resume: a bare ORT string (component
 * only) or {ort, ein}.
 * @typedef {string|{ort?: string, ein?: number}} IpoPick
 */

/** Executes {procs, byid, pool} from ipo_exec.py. byid keys are "type:id". */
class IpoVm {
  /**
   * @param {{procs?: Record<string, IpoToken[]>, byid?: Record<string, string>, pool?: *[]}} exec -
   *   the decoded script
   * @param {object} [opts] - options
   * @param {IpoHost} [opts.host] - where the car's answers come from (default OkHost)
   * @param {boolean} [opts.wireJobs] - the driven executor suspends on EVERY
   *   INPAapiJob (and on wartezeit), not only writes -- the driver runs each
   *   on the real wire and feeds the results back. Never set by the headless
   *   diff harness, so offline parity is untouched.
   * @param {(text: string) => void} [opts.onText] - live tap on every printed
   *   string (ftextout/messagebox) for the driver's running log -- emissions
   *   can be repainted away by the machine's own setscreen before the driver
   *   looks, the tap cannot.
   * @param {number} [opts.budget] - step budget per run
   */
  constructor(exec, opts = {}) {
    this.procs = exec.procs || {};
    this.byidRaw = exec.byid || {};
    this.pool = exec.pool || [];
    /** @type {IpoHost} */
    this.host = opts.host || new OkHost();
    this.wireJobs = !!opts.wireJobs;
    this.onText = typeof opts.onText === 'function' ? opts.onText : null;
    this.budget = opts.budget || IPO_DEFAULT_BUDGET;

    /** @type {Map<number|string, IpoValue>} slot n (or a bookkeeping key) -> value */
    this.globals = new Map();
    /** @type {Emissions} */
    this.out = new Emissions();
    this.steps = 0;
    /** @type {Set<string>} state machines the offline setstate already ran */
    this.entered = new Set();
    /** @type {Map<string, string>} "sc:n" -> the result key bound to that slot */
    this.binds = new Map();
    /** @type {Map<string, string[]>} in-memory files by path */
    this.files = new Map();
    /** @type {{path: string, mode: string, line: number}|null} the open file */
    this.fh = null;
    /** @type {Map<number, Map<number, string>>} StrArray handle -> entries */
    this.strArrays = new Map();
    this._arrN = 0;
    /** @type {Map<number, IpoValue>|null} the frame of the proc being executed */
    this.frame = null;
    /** @type {IpoItem|null} the item runItem is executing */
    this._itemTarget = null;
    /** @type {boolean} an input dialog ran: the next job's arg is not static */
    this.inputFed = false;
    /** @type {IpoSuspension|null} the parked driven run */
    this._susp = null;
    /** @type {string|null} the component the picker handed back, for togglelist */
    this._pickInput = null;
    /** @type {number|null} the on/off the picker handed back, for getinputstate */
    this._driveInput = null;
    /** @type {Map<number, IpoStructure>|null} live binary structures by handle */
    this.structs = null;
    /** @type {number|null} SetStructureMode's last setting */
    this._structMode = null;
    /** @type {Map<number, number>|null} settimer deadlines by timer number */
    this.timers = null;
    /** @type {object|null} the last wire job's fed results */
    this._lastJobSets = null;

    // highest global slot touched, so run_item can preseed presence flags
    this._maxglobal = 0;
    for (const toks of Object.values(this.procs)) {
      for (const t of toks) {
        if (
          (t.op === 'var' || t.op === 'store') &&
          (t.sc == null ? GLOBAL : t.sc) === GLOBAL &&
          t.n > this._maxglobal
        ) {
          this._maxglobal = t.n;
        }
      }
    }
  }

  /**
   * The name of a proc by type and id.
   * @param {string} type - func | menu | screen | state
   * @param {number} id - the id the procref carries
   * @returns {string|undefined}
   */
  byid(type, id) {
    return this.byidRaw[`${type}:${id}`];
  }

  /**
   * Resolve a procref on the stack to a proc name.
   * @param {IpoValue} ref - the stack value
   * @param {string} kindName - the proc type to look up
   * @returns {string|null}
   */
  target(ref, kindName) {
    if (isRef(ref)) return this.byid(kindName, ref[2]);
    return null;
  }

  /**
   * The result key bound to a slot.
   * @param {number} sc - scope
   * @param {number} n - slot
   * @returns {string|undefined}
   */
  bindKey(sc, n) {
    return this.binds.get(`${sc}:${n}`);
  }

  /**
   * Bind a slot to a result key.
   * @param {number} sc - scope
   * @param {number} n - slot
   * @param {string} key - result key
   * @returns {void}
   */
  setBind(sc, n, key) {
    this.binds.set(`${sc}:${n}`, key);
  }

  /**
   * Forget a slot's binding.
   * @param {number} sc - scope
   * @param {number} n - slot
   * @returns {void}
   */
  delBind(sc, n) {
    this.binds.delete(`${sc}:${n}`);
  }

  // ------------------------------------------------------------- run --

  /**
   * Run a proc offline to its end or first yield.
   * @param {string} proc - proc name
   * @param {IpoValue[]} [args] - the frame's initial slots
   * @returns {Emissions}
   * @throws {IpoError} when the proc does not exist
   */
  run(proc, args) {
    const toks = this.procs[proc];
    if (!toks) throw new IpoError(`no proc ${proc}`);
    const frame = new Map();
    if (args) args.forEach((v, i) => frame.set(i, v));
    try {
      this._exec(toks, frame);
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
    }
    return this.out;
  }

  /**
   * Execute one menu item's body offline as if its F-key were pressed.
   * start/end are TOKEN INDICES into the full menu token list (so the item's
   * jumps resolve to real targets). Presets keypress/enable flags true.
   * Mirrors run_item.
   * @param {IpoToken[]} menuToks - the menu proc's tokens
   * @param {number} start - first token of the body
   * @param {number} end - token index the body ends at
   * @param {IpoItem} item - the item to attribute emissions to
   * @param {boolean} [presence] - preset every untouched global to true
   * @returns {IpoItem}
   */
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

  /**
   * Execute a tape offline in the given frame, restoring the previous frame
   * after.
   * @param {IpoToken[]} toks - the tape
   * @param {Map<number, IpoValue>} frame - the frame's slots
   * @param {number} [startAt] - first token index
   * @param {number|null} [stopAt] - token index to stop at (exclusive)
   * @returns {void}
   */
  _exec(toks, frame, startAt = 0, stopAt = null) {
    const prev = this.frame;
    this.frame = frame;
    try {
      return this._execIn(toks, frame, startAt, stopAt);
    } finally {
      this.frame = prev;
    }
  }

  /**
   * The offline executor's loop, byte-identical in behaviour to ipo_vm.py:
   * it records predicate reads and harvests the reads of skipped branches
   * (for the static lift), attributes a record index to the item, and HALTS
   * at a `state` yield.
   * @param {IpoToken[]} toks - the tape
   * @param {Map<number, IpoValue>} frame - the frame's slots
   * @param {number} [startAt] - first token index
   * @param {number|null} [stopAt] - token index to stop at (exclusive)
   * @returns {void}
   * @throws {Halt} at a yield or when the step budget runs out
   */
  _execIn(toks, frame, startAt = 0, stopAt = null) {
    const index = ipoByteIndex(toks);
    const end = Math.min(
      stopAt == null ? toks.length : stopAt,
      ipoProcEnd(toks)
    );

    let stack = [];
    let i = startAt;
    let curItem = this._itemTarget;

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
        if (val == null) val = mkSlot(t.sc == null ? GLOBAL : t.sc, t.n);
        stack.push(val);
      } else if (op === 'procref') {
        stack.push([
          'ref',
          t.kind,
          t.n,
          t.kind === IPO_REF_LOCAL ? frame : null,
        ]);
      } else if (op === 'store') {
        let val = stack.length ? stack.pop() : null;
        const sc = t.sc == null ? GLOBAL : t.sc;
        // A record index the item selects: `const <v>; store <global>`.
        if (
          curItem != null &&
          sc === GLOBAL &&
          !('_sel' in curItem) &&
          (isPlainInt(val) || isPlainStr(val))
        ) {
          curItem._sel = [t.n, val];
        }
        val = this._bindPendingBinary(sc, t.n, val);
        this._write(t, frame, val);
      } else if (op === 'binop') {
        // neg (0x6d) is UNARY: it takes the top value only. Popping two ate
        // the operand underneath (`3, 43, 10.0 neg` negated the 43 and lost
        // the 10.0), shifting every later argument of the call.
        const b = stack.length ? stack.pop() : null;
        const a = t.name === 'neg' ? null : stack.length ? stack.pop() : null;
        if (IPO_COMPARE_OPS.includes(t.name)) {
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
        this.inputFed = false;
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

  /**
   * A coding image stored for sliced display (the INPAapiResultBinary path):
   * the first string stored after the read is bound to the pending key.
   * @param {number} sc - scope of the store
   * @param {number} n - slot of the store
   * @param {IpoValue} val - the value being stored
   * @returns {IpoValue} the value, boxed when it took the pending key
   */
  _bindPendingBinary(sc, n, val) {
    const pend = this.globals.get('__pending_binary__');
    if (pend && isPlainStr(val)) {
      val = mkBound(mkSlot(sc, n), val, pend);
      this.setBind(sc, n, pend);
      this.globals.delete('__pending_binary__');
    }
    return val;
  }

  /**
   * The key carried in through a call's arguments, and the out-refs the
   * callee may leave unfilled: a conversion helper turns a keyed value into
   * a display string through an out-ref, so the input key is carried onto an
   * out-slot the callee left anonymous (mirrors ipo_vm.py calluser).
   * @param {IpoValue[]} stack - the call's arguments
   * @returns {{inKey: string|null, outs: IpoRef[], frame: Map<number, IpoValue>}}
   */
  _callArgs(stack) {
    const inKey = keyed(stack);
    const outs = stack.filter(isRef);
    const frame = new Map();
    stack.forEach((v, i) => frame.set(i, v));
    return { inKey, outs, frame };
  }

  /**
   * Bind the callee's unfilled out-refs to the key its arguments carried.
   * @param {string|null} inKey - the carried key
   * @param {IpoRef[]} outs - the call's out-refs
   * @returns {void}
   */
  _carryKeyToOuts(inKey, outs) {
    if (!inKey) return;
    for (const ref of outs) {
      const { dsc, n, map } = this._refTarget(ref, this.frame);
      const cur = map.get(n);
      if (isBound(cur) && cur.key) continue;
      // Offline the callee's arithmetic is opaque and the lift only needs
      // the key on the slot. A live run computed the value (E46.IPO's
      // inttohexstring formats F_ORT_NR through a DLL printf), so the key
      // rides along with it instead of replacing it.
      const keep = this.wireJobs && cur != null && cur !== '';
      const val = mkBound(mkSlot(dsc, n), keep ? asStr(cur) : '0', inKey);
      this.setBind(dsc, n, inKey);
      map.set(n, val);
    }
  }

  /**
   * Call a user function offline. A call is not a new budget; only the frame
   * is per-call. An unknown function is a noop.
   * @param {IpoToken} t - the calluser token
   * @param {IpoValue[]} stack - the call's arguments
   * @returns {void}
   */
  _callUser(t, stack) {
    const name = this.byid('func', t.n);
    if (!name || !this.procs[name]) return;
    const { inKey, outs, frame } = this._callArgs(stack);
    this._exec(this.procs[name], frame);
    this._carryKeyToOuts(inKey, outs);
  }

  // ------------------------------------------- resumable state driver --

  /**
   * Reset the per-run step budget and fetch a proc's tape. The budget is a
   * runaway guard PER RUN: a persistent VM (the live runtime cycles a
   * frequent screen for as long as the module is open) must not hit it by
   * accumulation.
   * @param {string} name - proc name
   * @returns {IpoToken[]}
   * @throws {IpoError} when the proc does not exist
   */
  _beginRun(name) {
    this.steps = 0;
    const toks = this.procs[name];
    if (!toks) throw new IpoError(`no proc ${name}`);
    return toks;
  }

  /**
   * Begin a resumable run of proc `name`.
   * @param {string} name - proc name
   * @returns {IpoStep} the first pending action, or {kind:'done'}
   * @throws {IpoError} when the proc does not exist
   */
  stepStart(name) {
    const toks = this._beginRun(name);
    return this._beginRange(toks, 0, ipoProcEnd(toks));
  }

  /**
   * INPA's KEYPRESS: run ONE item's body inside its menu proc. Starts after
   * the ITEM token, stops at the next one; the body's keypress-guard flags
   * are preset (pressing the key IS the flag); jumps resolve against the
   * whole proc, which slicing the body out would lose.
   *
   * Only the FLAGS (`if (flag == 1)`) are preset, never a slot the body
   * compares against a string: IHKA46's digital keys toggle
   * `if (v37 == "ON") v37 = "OFF" else v37 = "ON"` and send v37, and a
   * preset of 1 on every press sent ON forever. This VM persists across
   * presses; that state is the point.
   * @param {string} procName - the menu proc
   * @param {number} nr - the item's F-key number
   * @returns {IpoStep}
   * @throws {IpoError} when the proc or the item does not exist
   */
  stepStartItem(procName, nr) {
    const toks = this._beginRun(procName);
    const idx = toks.findIndex((t) => t.op === 'ITEM' && t.nr === nr);
    if (idx < 0) throw new IpoError(`no item ${nr} in ${procName}`);
    let end = ipoProcEnd(toks);
    for (let j = idx + 1; j < end; j++) {
      if (toks[j].op === 'ITEM') {
        end = j;
        break;
      }
    }
    for (const g of keypressGuards(toks, idx + 1, end, { numericOnly: true }))
      this.globals.set(g, 1);
    return this._beginRange(toks, idx + 1, end);
  }

  /**
   * A slice of a proc, driven (a menu's prologue: its title and defaults).
   * @param {string} procName - proc name
   * @param {number} i0 - first token index
   * @param {number} end - token index to stop at (exclusive)
   * @returns {IpoStep}
   * @throws {IpoError} when the proc does not exist
   */
  stepStartRange(procName, i0, end) {
    const toks = this._beginRun(procName);
    return this._beginRange(toks, i0, Math.min(end, ipoProcEnd(toks)));
  }

  /**
   * Park a fresh suspension on a tape range and drive it.
   * @param {IpoToken[]} toks - the tape
   * @param {number} i0 - first token index
   * @param {number} end - token index to stop at (exclusive)
   * @returns {IpoStep}
   */
  _beginRange(toks, i0, end) {
    this._susp = {
      toks,
      frame: new Map(),
      i: i0,
      stack: [],
      callers: [],
      index: ipoByteIndex(toks),
      end,
      remap: ipoSegRemap(toks),
    };
    return this._drive();
  }

  /**
   * Take the picker's answer: builtin_16 writes the component (ORT) into the
   * toggle out-var, getinputstate returns the on/off. `ein` defaults to the
   * confirming 0 (the guard `getinputstate == 0` opens on a valid pick).
   * @param {IpoPick} value - the pick
   * @returns {void}
   */
  _takePick(value) {
    if (typeof value === 'object' && !Array.isArray(value)) {
      this._pickInput = value.ort != null ? value.ort : null;
      this._driveInput = value.ein != null ? value.ein : IPO_INPUT_CONFIRMED;
    } else {
      this._pickInput = value;
      this._driveInput = IPO_INPUT_CONFIRMED;
    }
  }

  /**
   * Store an input dialog's answer through the parked call's out-refs. A hex
   * ask answers with a STRING (stored verbatim); a two-field ask answers
   * with an ARRAY, one element per out-ref -- storing a single number
   * through the first ref only left every second field (input2hexnum's
   * number, input2int's Jahr) unset. The out-refs target the SUSPENDED
   * body's locals; resume runs outside _drive, so the store switches to that
   * frame.
   * @param {IpoSuspension} s - the suspension
   * @param {string|number|Array<string|number>} value - the answer
   * @returns {void}
   */
  _storeInputAnswer(s, value) {
    const prevFrame = this.frame;
    this.frame = s.frame;
    const store1 = (ref, v) => {
      if (typeof v === 'string') {
        storeOut(this, [ref], v, null);
        return;
      }
      const n = Math.trunc(Number(v));
      storeOut(this, [ref], Number.isFinite(n) ? n : 0, null);
    };
    const refs = s.pendingStack.filter(isRef);
    if (Array.isArray(value)) {
      refs.forEach((r, k) => {
        if (k < value.length) store1(r, value[k]);
      });
    } else if (refs.length) {
      refs.forEach((r) => store1(r, value));
    }
    this.frame = prevFrame;
  }

  /**
   * Resume a suspended run with the result of its pending action: the picked
   * togglelist row (for a yield that opened a picker, or a toggle), the typed
   * answer (for an input), or a job's result sets (for a wire job).
   * @param {*} [value] - the pending action's result
   * @returns {IpoStep} the next pending action or {kind:'done'}
   */
  resume(value) {
    if (!this._susp) return { kind: 'done' };
    const s = this._susp;
    const wasYield = s.pending === 'yield';
    if (wasYield && value != null) {
      // the pick drives the machine
      this._takePick(value);
    } else if (s.pending === 'input') {
      if (s.pendingStack) {
        this._storeInputAnswer(s, value);
        s.pendingStack = null;
      }
    } else if (s.pending === 'file') {
      // the picker's answer: the chosen name, '' when cancelled
      if (s.pendingStack) {
        const prevFrame = this.frame;
        this.frame = s.frame;
        try {
          ipoDllFileAnswer(this, s.pendingStack, value);
        } finally {
          this.frame = prevFrame;
        }
        s.pendingStack = null;
      }
    } else if (s.pending === 'toggle') {
      // the pick: run the parked togglelist with it, then step past it
      if (value != null) {
        this._takePick(value);
        const prevFrame = this.frame;
        this.frame = s.frame;
        try {
          this._builtin(s.toks[s.i], s.pendingStack || [], null);
        } finally {
          this.frame = prevFrame;
          this._pickInput = null; // one pick per togglelist call
        }
      }
      s.pendingStack = null;
    } else if (s.pending === 'exit') {
      this._susp = null;
      return { kind: 'done', out: this.out };
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
    s.i += 1; // step past the suspending token
    // A yield is followed by its WAIT-LOOP back-edge: `state %Z; jump <exit>`
    // is INPA's %WARTEN -- following that jump leaves the machine. Being
    // DRIVEN forward (the user's pick) runs the segment body AFTER the jump
    // instead. So on a yield-resume, step over the immediate unconditional
    // jump into the body; a job-resume lands mid-body and needs no skip.
    if (wasYield) {
      const jt = s.toks[s.i];
      if (jt && jt.op === 'jump') s.i += 1;
    }
    return this._drive();
  }

  /**
   * Keypress-flag globals the CURRENT wait segment tests (var N == const ->
   * jfalse before anything stores N): INPA's "Weiter"/"Start" keys set
   * these. The driver shows a Continue control when the parked segment has
   * one.
   * @returns {Set<number>}
   */
  pendingGuards() {
    const s = this._susp;
    if (!s) return new Set();
    let end = s.end;
    for (let k = s.i + 1; k < s.end; k++) {
      if (s.toks[k].op === 'state') {
        end = k;
        break;
      }
    }
    return keypressGuards(s.toks, s.i + 1, end);
  }

  /**
   * Press a machine key: set its guard flag so the wait segment opens.
   * @param {number} n - the flag's global slot
   * @returns {void}
   */
  pressKey(n) {
    this.globals.set(n, 1);
  }

  /**
   * The resumable loop. Runs synchronously until it suspends or finishes.
   * Reads s.toks/s.index/s.end afresh each pass: a driven calluser SWITCHES
   * the suspension onto the callee, and stale locals would keep stepping the
   * caller's tape.
   * @returns {IpoStep}
   * @throws {Halt} when the step budget runs out
   */
  _drive() {
    const s = this._susp;
    const prevFrame = this.frame;
    try {
      for (;;) {
        this.frame = s.frame;
        if (s.i >= s.end) {
          if (s.callers && s.callers.length) {
            this._popCall(s);
            continue;
          }
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
        const sig = this._stepOne(t, op, s, s.index, s.end);
        if (sig === 'ret') {
          if (s.callers && s.callers.length) {
            this._popCall(s);
            continue;
          }
          break;
        }
        if (sig === 'jumped') continue; // _stepOne already moved s.i
        if (sig === 'called') continue; // switched into a callee
        if (sig === 'stop') {
          // INPA's `stop`: leave the body being run. In a helper that is
          // its return; at the top it skips to the next ITEM/LINE of the
          // proc (a screen's other lines still draw), or to the end.
          if (s.callers && s.callers.length) {
            this._popCall(s);
            continue;
          }
          const nxt = this._segmentEnd(s);
          if (nxt >= s.end) break;
          s.i = nxt;
          continue;
        }
        if (sig && IPO_SUSPEND_KINDS.has(sig.kind)) {
          // a wire job (the renderer runs it), a timed wait (it sleeps), a
          // user prompt / message / picker (it asks and hands the answer
          // back), or the script's own exit
          s.pending = sig.kind;
          if (
            sig.kind === 'input' ||
            sig.kind === 'toggle' ||
            sig.kind === 'file'
          )
            s.pendingStack = sig.stack;
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

  /**
   * One token of the resumable loop. Mirrors _execIn's handling of every op
   * EXCEPT `state` (handled in _drive), minus the offline-only bookkeeping
   * (predicate reads, harvested reads, item record indices), plus the live
   * dllcall and the driven calluser.
   * @param {IpoToken} t - the token
   * @param {string} op - its op
   * @param {IpoSuspension} s - the suspension ({stack, i, frame} are advanced in place)
   * @param {Map<number, number>} index - the tape's byte index
   * @param {number} end - the run's end
   * @returns {'ret'|'jumped'|'called'|'stop'|IpoStep|undefined} how the loop
   *   should continue: undefined = advance normally
   */
  _stepOne(t, op, s, index, end) {
    const stack = s.stack;
    if (op === 'frame') {
      s.stack = [];
    } else if (op === 'const') {
      stack.push(t.t === 'd' ? mkFloat(t.v) : t.v);
    } else if (op === 'var') {
      let val = this._read(t, s.frame);
      if (val == null) val = mkSlot(t.sc == null ? GLOBAL : t.sc, t.n);
      stack.push(val);
    } else if (op === 'procref') {
      stack.push([
        'ref',
        t.kind,
        t.n,
        t.kind === IPO_REF_LOCAL ? s.frame : null,
      ]);
    } else if (op === 'store') {
      let val = stack.length ? stack.pop() : null;
      const sc = t.sc == null ? GLOBAL : t.sc;
      val = this._bindPendingBinary(sc, t.n, val);
      this._write(t, s.frame, val);
    } else if (op === 'binop') {
      let b = stack.length ? stack.pop() : null;
      let a = t.name === 'neg' ? null : stack.length ? stack.pop() : null; // unary
      // a local the script never wrote is 0 (or '' beside a string) when it
      // runs, as INPA zero-fills its declarations; the offline lift keeps
      // the slot so a compare on it stays undecided there
      if (this.wireJobs && IPO_CMP_OPS.has(t.name)) {
        if (isSlot(a)) a = ipoSlotDefault(b);
        if (isSlot(b)) b = ipoSlotDefault(a);
      }
      stack.push(binop(t.name, a, b));
    } else if (op === 'jfalse') {
      const cond = stack.length ? stack.pop() : false;
      if (!truthy(cond)) {
        const nxt = this._jumpIndex(s, index, end);
        if (nxt >= end) return 'ret';
        s.i = nxt;
        return 'jumped';
      }
    } else if (op === 'jump') {
      const nxt = this._jumpIndex(s, index, end);
      if (nxt >= end) return 'ret';
      s.i = nxt;
      return 'jumped';
    } else if (op === 'ITEM') {
      s.stack = [];
    } else if (op === 'LINE') {
      this.out.lines.push({ label: t.label, elements: [] });
      s.stack = [];
    } else if (op === 'call') {
      const sig = ipoDriveBuiltin(this, t, stack);
      s.stack = [];
      if (sig) return sig; // a pending action
    } else if (op === 'dllcall') {
      // an import32 call: only a live run answers it (see ipoDllCall); the
      // save-as dialog among them is a pending action like an input
      const sig = this.wireJobs ? ipoDllCall(this, stack) : null;
      s.stack = [];
      if (sig) return sig;
    } else if (op === 'calluser') {
      const entered = this._pushCall(s, t, stack);
      s.stack = [];
      if (entered) return 'called';
    } else if (op === 'ret') {
      return 'ret';
    }
    return undefined;
  }

  /**
   * Where the body being run ends: the next ITEM or LINE token after the
   * current one, or the run's end when this is the last body.
   * @param {IpoSuspension} s - the suspension
   * @returns {number} token index
   */
  _segmentEnd(s) {
    for (let j = s.i + 1; j < s.end; j++) {
      const op = s.toks[j].op;
      if (op === 'ITEM' || op === 'LINE') return j;
    }
    return s.end;
  }

  /**
   * DRIVE INTO THE CALLEE. The offline _callUser executes a user function
   * through the offline executor, so a job inside a helper never suspends --
   * and INPA puts the send inside helpers routinely (ms450's llerh(delta)
   * computes the setpoint and calls START_SYSTEMCHECK_LLERH itself). The
   * driven path keeps a call stack instead: switch the suspension onto the
   * callee's tokens; _drive pops back on ret/end. An unknown function is a
   * noop, exactly as offline.
   * @param {IpoSuspension} s - the suspension
   * @param {IpoToken} t - the calluser token
   * @param {IpoValue[]} stack - the call's arguments
   * @returns {boolean} whether the suspension switched into a callee
   */
  _pushCall(s, t, stack) {
    const name = this.byid('func', t.n);
    if (!name || !this.procs[name]) return false;
    const { inKey, outs, frame } = this._callArgs(stack);
    if (!s.callers) s.callers = [];
    s.callers.push({
      toks: s.toks,
      i: s.i,
      end: s.end,
      index: s.index,
      remap: s.remap,
      frame: s.frame,
      inKey,
      outs,
    });
    const toks = this.procs[name];
    s.toks = toks;
    s.i = 0;
    s.end = ipoProcEnd(toks);
    s.index = ipoByteIndex(toks);
    s.remap = ipoSegRemap(toks);
    s.frame = frame;
    return true;
  }

  /**
   * Return from a driven callee: the same conversion-helper key carry the
   * offline _callUser performs, then the caller's suspension is restored.
   * @param {IpoSuspension} s - the suspension
   * @returns {void}
   */
  _popCall(s) {
    const c = s.callers.pop();
    this.frame = c.frame;
    this._carryKeyToOuts(c.inKey, c.outs);
    s.toks = c.toks;
    s.i = c.i + 1;
    s.end = c.end;
    s.index = c.index;
    s.remap = c.remap;
    s.frame = c.frame;
  }

  /**
   * The driven executor's jump resolution: the segment-rebased target first
   * (see ipoSegRemap), the walker's raw byte target as the fallback for the
   * few machines outside the model. A target neither resolves = exit.
   * @param {IpoSuspension} s - the suspension (its current token is the jump)
   * @param {Map<number, number>} index - the tape's byte index
   * @param {number} end - the run's end
   * @returns {number} the token index to continue at, or `end`
   */
  _jumpIndex(s, index, end) {
    const t = s.toks[s.i];
    const ct = s.remap ? s.remap.get(s.i) : undefined;
    if (ct !== undefined && index.has(ct)) return index.get(ct);
    return index.has(t.to) ? index.get(t.to) : end;
  }

  // ------------------------------------------------------------ reads --

  /**
   * Record result keys an unexecuted branch reads, without running it, so
   * the union of keys across arms matches a full static decode of every
   * branch. Follows calluser into the callee (guarded against recursion).
   * Ported from _harvest_reads.
   * @param {IpoToken[]} toks - the tape
   * @param {number} lo - first token index of the skipped branch
   * @param {number} hi - token index it ends at (exclusive)
   * @param {Set<string>} [seen] - callees already harvested
   * @returns {void}
   */
  _harvestReads(toks, lo, hi, seen) {
    if (!seen) seen = new Set();
    hi = Math.min(hi, toks.length);
    for (let k = lo; k < hi; k++) {
      const t = toks[k],
        op = t.op;
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
      for (let b = k - 1; b >= Math.max(lo, k - IPO_HARVEST_LOOKBACK); b--) {
        const tb = toks[b];
        const v = tb.op === 'const' ? tb.v : null;
        if (typeof v === 'string' && v) {
          if (!this.out.reads.includes(v)) this.out.reads.push(v);
          break;
        }
      }
    }
  }

  /**
   * Read a `var` token's slot. A by-reference parameter READS the caller's
   * value: `strlen(->n, s)` inside `stringappend(string &s, ...)` measures
   * the string, not the reference. Without this the pad loop never ended
   * (length 0 forever).
   * @param {IpoToken} t - the var token
   * @param {Map<number, IpoValue>} frame - the current frame
   * @returns {IpoValue|null}
   */
  _read(t, frame) {
    const sc = t.sc == null ? GLOBAL : t.sc;
    let v;
    if (sc === GLOBAL) v = this.globals.has(t.n) ? this.globals.get(t.n) : null;
    else v = frame.has(t.n) ? frame.get(t.n) : null;
    if (isRef(v)) {
      const tg = this._refTarget(v, frame);
      v = tg.map.has(tg.n) ? tg.map.get(tg.n) : null;
    }
    return v;
  }

  /**
   * Where a reference points: the owning frame (or the globals) and the
   * slot, following a reference stored in a referenced slot (a by-ref
   * parameter handed on by reference).
   * @param {IpoRef} ref - the reference
   * @param {Map<number, IpoValue>|null} frame - the current frame
   * @returns {{dsc: number, n: number, map: Map<number, IpoValue>}}
   */
  _refTarget(ref, frame) {
    let cur = ref;
    let map = null,
      dsc = GLOBAL,
      n = 0;
    for (let hops = 0; hops < IPO_REF_MAX_HOPS && isRef(cur); hops++) {
      const owner = cur[1] === IPO_REF_LOCAL ? cur[3] || frame : null;
      if (owner) {
        dsc = LOCAL;
        map = owner;
      } else {
        dsc = GLOBAL;
        map = this.globals;
      }
      n = cur[2];
      const next = map.has(n) ? map.get(n) : null;
      if (!isRef(next)) break;
      cur = next;
    }
    return { dsc, n, map: map || this.globals };
  }

  /**
   * Store through a `store` token. A store through an out-parameter (the
   * slot holds a ref) lands in the CALLER's slot and moves the binding with
   * it. Mirrors ipo_vm.py _write.
   * @param {IpoToken} t - the store token
   * @param {Map<number, IpoValue>|null} frame - the current frame
   * @param {IpoValue} val - the value
   * @returns {void}
   */
  _write(t, frame, val) {
    const sc = t.sc == null ? GLOBAL : t.sc;
    if (t.ref) {
      const src =
        sc !== GLOBAL ? (frame ? frame.get(t.n) : null) : this.globals.get(t.n);
      if (isRef(src)) {
        const { dsc, n, map } = this._refTarget(src, frame);
        const key = isBound(val) && val.key ? val.key : null;
        if (key) this.setBind(dsc, n, key);
        else this.delBind(dsc, n);
        map.set(n, val);
        return;
      }
    }
    if (sc === GLOBAL) this.globals.set(t.n, val);
    else frame.set(t.n, val);
  }

  // --------------------------------------------------------- builtins --

  /**
   * Run a `call` token's builtin offline (a name the table lacks is recorded
   * and skipped).
   * @param {IpoToken} t - the call token
   * @param {IpoValue[]} stack - the call's arguments
   * @param {IpoItem|null} curItem - the item being executed
   * @returns {void}
   */
  _builtin(t, stack, curItem) {
    const name = ipoBuiltinName(t);
    this.out.calls.push(name);
    const fn = BUILTINS[name];
    if (fn) fn(this, stack, curItem);
  }
}

// Loaded two ways: as <script>s in the app (globals) and through the verify
// harnesses' classic-script loader (module.exports, unioned across pieces).
if (typeof window !== 'undefined') {
  window.IpoVm = IpoVm;
  window.IpoError = IpoError;
  window.OkHost = OkHost;
  window.FeedHost = FeedHost;
  window.scanQuitBox = scanQuitBox;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IpoVm,
    IpoError,
    OkHost,
    FeedHost,
    scanQuitBox,
    Emissions,
    mkBound,
    mkSlot,
    isBound,
    isSlot,
    binop,
  };
}
