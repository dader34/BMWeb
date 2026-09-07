/**
 * @file Coding WRITE by EXECUTING BMW's own per-CABD dispatcher -- piece 3 of
 * 3 (see the coding-dispatch-derived-json plan). Published as the
 * `codingDispatch` global, with `runCodingDispatch` as the entry point.
 *
 * Instead of hand-sequencing SGBD jobs (the strategy switch in
 * core/coding/write.js, whose on-wire packet is wrong for real E46 modules),
 * we run the derived A_<cabd> dispatcher program (tools/export/ipo_exec.py
 * --coding, shape {procs, byid, coding}) on a small token interpreter,
 * implementing the CDH host callbacks it calls (core/coding/dispatch-host.js).
 * The dispatcher itself decides the job order, the arguments, and --
 * crucially -- builds the wire packet through the CDHBinBuf callbacks and
 * CDHGetApiJobData, so
 * the 22-byte header rules (word-unit addresses, data at offset 0x15, the dual
 * count fields, payload round-up, the record cap) come from executing BMW's
 * code, not from us hand-guessing them.
 *
 * SAFETY. Reads run with the SGBD VM's write gate CLOSED; only the steps the
 * dispatcher issues after we arm the write flag transmit a write job. The
 * public entry (runCodingDispatch) refuses unless opts.confirmed is set by the
 * UI, exactly like writeCoding. The caller still proves the write by re-read
 * and keeps the pre-write backup (core/coding/write.js) -- this module
 * replaces only HOW the write telegrams are produced, not those guardrails.
 *
 * app/renderer/core/*.js style: browser global, no imports; dual-exported for
 * require() so a headless test can drive it.
 */

/**
 * A derived A_<cabd> dispatcher program as data/coding-dispatch ships it.
 * @typedef {Object} DispatcherProgram
 * @property {Record<string, DispatchToken[]>} procs - token streams by proc name.
 * @property {Record<string, string>} byid - `type:id` -> name lookups.
 * @property {boolean} coding - marks a coding dispatcher (required).
 * @property {DataOrg} [dataOrg] - the CABD's SPEICHERORG.
 */

/**
 * One interpreter token (the same shapes ipovm.js runs).
 * @typedef {Object} DispatchToken
 * @property {string} op - opcode name (`frame`, `const`, `var`, `procref`,
 *   `store`, `binop`, `jfalse`, `jump`, `call`, `calluser`, `ret`, `endproc`, `unk`).
 * @property {number} [at] - byte offset, the target of jumps.
 * @property {unknown} [v] - a `const` value.
 * @property {number} [sc] - scope of a `var`/`store`: 0 global, else local.
 * @property {number} [n] - slot / proc / func index.
 * @property {number} [kind] - a `procref` kind: 2 = local scope.
 * @property {string} [name] - a `binop` operator or a `call` target.
 * @property {number} [to] - a jump target offset.
 */

/**
 * Options for runCodingDispatch.
 * @typedef {Object} DispatchOptions
 * @property {boolean} confirmed - REQUIRED true (the UI's write confirmation).
 * @property {CdhRunJob} runJob - the bus job runner.
 * @property {string} [sgbd] - the coding SGBD name.
 * @property {NettoSlot[]} [slots] - the netto slot table to write.
 * @property {string} [jobname] - which cabimain jobname to run (default SG_CODIEREN).
 * @property {DataOrg} [dataOrg] - overrides the program's own dataOrg.
 */

/**
 * What runCodingDispatch returns.
 * @typedef {Object} DispatchResult
 * @property {boolean} ok - no error recorded and return value 0.
 * @property {number} err - the host's error scratchpad.
 * @property {number} ret - the dispatcher's return value.
 * @property {WireLogEntry[]} log - the wire jobs issued, in order.
 * @property {NettoSlot[]} slots - the slot table after the run.
 */

(function (root) {
  'use strict';

  const Host =
    typeof root !== 'undefined' && root.CodingDispatchHost
      ? root.CodingDispatchHost
      : require('./dispatch-host.js');
  const {
    CdhHost,
    isRef,
    mkRef,
    procrefToSlot,
    truthy,
    asInt,
    asStr,
    OUT_MULTI,
    OUT_FIRST,
    CDH_SIG,
  } = Host;

  /** Interpreter step budget: a runaway dispatcher stops here. */
  const STEP_BUDGET = 200000;
  /** The cabimain jobname that means "code the module". */
  const DEFAULT_JOBNAME = 'SG_CODIEREN';

  // ---- the interpreter ----------------------------------------------------
  //
  // Executes the dispatcher's token stream (same token shapes ipovm.js runs),
  // routing `call` to the CDH host. Only the opcodes a dispatcher uses are
  // handled; anything else is a no-op (the write engine is arithmetic + calls +
  // branches, no screen/menu machinery).
  /** The dispatcher token interpreter. */
  class Interp {
    /**
     * @param {DispatcherProgram} exec - the program.
     * @param {CdhHost} host - the CDH host the calls route to.
     */
    constructor(exec, host) {
      /** @type {Record<string, DispatchToken[]>} */
      this.procs = exec.procs || {};
      this.byidRaw = exec.byid || {};
      this.host = host;
      /** @type {Map<number, unknown>} */
      this.globals = new Map();
      this.budget = STEP_BUDGET;
      this.steps = 0;
    }
    /**
     * Look up a name by type and id.
     * @param {string} type - e.g. `func`.
     * @param {number} id - the id.
     * @returns {string|undefined} the name.
     */
    byid(type, id) {
      return this.byidRaw[`${type}:${id}`];
    }

    /**
     * Run one proc by name in a fresh local frame.
     * @param {string} proc - proc name.
     * @returns {Promise<void>} resolves when the proc ends.
     * @throws {Error} when the proc does not exist or the step budget is hit.
     */
    async run(proc) {
      const toks = this.procs[proc];
      if (!toks) throw new Error(`coding-dispatch: no proc ${proc}`);
      await this._exec(toks, new Map());
    }

    /**
     * Read a variable; an unset one yields a slot ref for out-param writes.
     * @param {DispatchToken} t - the `var` token.
     * @param {Map<number, unknown>} frame - the local frame.
     * @returns {unknown} the value or a slot ref.
     */
    _read(t, frame) {
      const sc = t.sc == null ? 0 : t.sc;
      const v = sc === 0 ? this.globals.get(t.n) : frame.get(t.n);
      return v == null ? mkRef(sc, t.n) : v;
    }
    /**
     * Write a variable.
     * @param {number} sc - scope: 0 global, else local.
     * @param {number} n - slot index.
     * @param {Map<number, unknown>} frame - the local frame.
     * @param {unknown} val - the value.
     * @returns {void}
     */
    _write(sc, n, frame, val) {
      if (sc === 0) this.globals.set(n, val);
      else frame.set(n, val);
    }
    /**
     * Write through a slot ref (no-op for a non-ref).
     * @param {unknown} ref - the ref.
     * @param {Map<number, unknown>} frame - the local frame.
     * @param {unknown} val - the value.
     * @returns {void}
     */
    _writeRef(ref, frame, val) {
      if (!isRef(ref)) return;
      this._write(ref[1] === 0 ? 0 : ref[1], ref[2], frame, val);
    }

    /**
     * Execute a token stream.
     * @param {DispatchToken[]} toks - the tokens.
     * @param {Map<number, unknown>} frame - the local frame.
     * @param {number} [startAt] - first token index.
     * @param {number|null} [stopAt] - one past the last token index.
     * @returns {Promise<void>} resolves when the stream ends or returns.
     * @throws {Error} when the step budget is exhausted.
     */
    async _exec(toks, frame, startAt = 0, stopAt = null) {
      const index = new Map();
      for (let i = 0; i < toks.length; i++)
        if (toks[i].at != null) index.set(toks[i].at, i);
      let end = stopAt == null ? toks.length : stopAt;
      for (let j = 0; j < toks.length && j < end; j++) {
        if (toks[j].op === 'unk') {
          end = j;
          break;
        }
      }
      let stack = [];
      let i = startAt;
      while (i < end) {
        if (++this.steps > this.budget)
          throw new Error('coding-dispatch: step budget');
        const t = toks[i];
        const op = t.op;
        if (op === 'frame') {
          stack = [];
        } else if (op === 'const') {
          stack.push(t.v);
        } else if (op === 'var') {
          stack.push(this._read(t, frame));
        } else if (op === 'procref') {
          // A procref feeding a CALL is that call's out-param slot (kind 2 =
          // local). A procref feeding calluser is a real proc reference; but
          // the coding dispatchers only pass procrefs as call out-params, so
          // normalising to a slot ref is safe here.
          stack.push(procrefToSlot(t.kind, t.n));
        } else if (op === 'store') {
          const val = stack.length ? stack.pop() : '';
          this._write(t.sc == null ? 0 : t.sc, t.n, frame, val);
        } else if (op === 'binop') {
          const b = stack.pop(),
            a = stack.pop();
          stack.push(binop(t.name, a, b));
        } else if (op === 'jfalse') {
          const cond = stack.length ? stack.pop() : false;
          if (!truthy(cond)) {
            const nxt = index.has(t.to) ? index.get(t.to) : end;
            if (nxt >= end) return;
            i = nxt;
            continue;
          }
        } else if (op === 'jump') {
          const nxt = index.has(t.to) ? index.get(t.to) : end;
          if (nxt >= end) return;
          i = nxt;
          continue;
        } else if (op === 'call') {
          await this._call(t, stack, frame);
          stack = [];
        } else if (op === 'calluser') {
          await this._callUser(t, stack);
          stack = [];
        } else if (op === 'ret') {
          // In the A_ (coding dispatcher) dialect, 0e is a per-statement
          // terminator, not a function return -- cabimain has 14 of them but
          // returns once. It clears the operand stack and falls through; the
          // real end of a proc is `endproc` (0d) or the token end. Treating it
          // as a return here stopped cabimain at its first statement, so no
          // handler ever ran.
          stack = [];
        } else if (op === 'endproc') {
          return;
        }
        i += 1;
      }
    }

    /**
     * Call a user proc with the operand stack as its positional locals.
     * @param {DispatchToken} t - the `calluser` token.
     * @param {unknown[]} stack - the operand stack.
     * @returns {Promise<void>} resolves when the proc ends.
     */
    async _callUser(t, stack) {
      const name = this.byid('func', t.n);
      if (!name || !this.procs[name]) return;
      const frame = new Map();
      stack.forEach((v, i) => frame.set(i, v));
      await this._exec(this.procs[name], frame);
    }

    /**
     * Call a CDH host callback, splitting the stack into value-ins and
     * out-refs by the signature table and distributing the result.
     * @param {DispatchToken} t - the `call` token.
     * @param {unknown[]} stack - the operand stack.
     * @param {Map<number, unknown>} frame - the local frame.
     * @returns {Promise<void>} resolves when the callback has run.
     */
    async _call(t, stack, frame) {
      const name = t.name;
      const host = this.host;
      const fn = host[name];
      if (typeof fn !== 'function') return; // unimplemented CDH slot: no-op
      // Split args into value-ins and out-refs by the CDH signature order.
      const sig = CDH_SIG[name] || [];
      // Args are the top `sig.length` stack entries in order.
      const args = sig.length ? stack.slice(-sig.length) : [];
      const ins = [];
      const outRefs = [];
      sig.forEach((dir, k) => {
        const a = args[k];
        if (dir === 'in') ins.push(a);
        else outRefs.push(a);
      });
      let result = fn.apply(host, ins);
      if (result && typeof result.then === 'function') result = await result;
      // distribute results to out-refs
      const multi = OUT_MULTI[name];
      if (multi && result && typeof result === 'object') {
        multi.forEach((key, k) => {
          if (outRefs[k] != null)
            this._writeRef(outRefs[k], frame, result[key]);
        });
      } else if (outRefs.length === 1 || OUT_FIRST.has(name)) {
        // scalar result -> the first out-ref.
        if (outRefs[0] != null) this._writeRef(outRefs[0], frame, result);
      }
      // The trailing out-ref of a CDH callback is its retVal (0 = success).
      // The dispatcher checks it (e.g. TestCDHFehler compares it to 0 and
      // exit()s on non-zero), so an unwritten retVal reads as a ref/non-zero
      // and aborts the whole dispatch. Set every not-yet-written out-ref to 0.
      const written = multi
        ? multi.length
        : outRefs.length === 1 || OUT_FIRST.has(name)
          ? 1
          : 0;
      for (let k = written; k < outRefs.length; k++) {
        if (outRefs[k] != null) this._writeRef(outRefs[k], frame, 0);
      }
      // callbacks with no out-ref (CDHapiJob etc.) push nothing.
    }
  }

  // ---- binop (subset the dispatcher uses) ---------------------------------
  /**
   * Evaluate a binary operator on two stack values.
   * @param {string} name - operator name.
   * @param {unknown} a - left operand.
   * @param {unknown} b - right operand.
   * @returns {number} the result (0 for an unknown operator).
   */
  function binop(name, a, b) {
    switch (name) {
      case 'add':
        return asInt(a) + asInt(b);
      case 'sub':
        return asInt(a) - asInt(b);
      case 'mul':
        return asInt(a) * asInt(b);
      case 'div':
        return asInt(b) ? (asInt(a) / asInt(b)) | 0 : 0;
      case 'eq':
        return eqv(a, b) ? 1 : 0;
      case 'ne':
        return eqv(a, b) ? 0 : 1;
      case 'lt':
        return asInt(a) < asInt(b) ? 1 : 0;
      case 'gt':
        return asInt(a) > asInt(b) ? 1 : 0;
      case 'le':
        return asInt(a) <= asInt(b) ? 1 : 0;
      case 'ge':
        return asInt(a) >= asInt(b) ? 1 : 0;
      case 'and':
        return truthy(a) && truthy(b) ? 1 : 0;
      case 'or':
        return truthy(a) || truthy(b) ? 1 : 0;
      case 'not':
        return truthy(a) ? 0 : 1;
      case 'bitand':
        return asInt(a) & asInt(b);
      case 'bitor':
        return asInt(a) | asInt(b);
      case 'bitxor':
        return asInt(a) ^ asInt(b);
      default:
        return 0;
    }
  }
  /**
   * Dispatcher equality: string compare when either side is a string, else
   * integer compare.
   * @param {unknown} a - left.
   * @param {unknown} b - right.
   * @returns {boolean} equal?
   */
  function eqv(a, b) {
    if (typeof a === 'string' || typeof b === 'string')
      return asStr(a) === asStr(b);
    return asInt(a) === asInt(b);
  }

  // ---- entry point --------------------------------------------------------
  /**
   * Run a derived coding dispatcher against the bus.
   * @param {DispatcherProgram} exec - the derived program {procs, byid, coding:true}.
   * @param {DispatchOptions} opts - see {@link DispatchOptions}.
   * @returns {Promise<DispatchResult>} the outcome, wire log and slot table.
   * @throws {Error} when not confirmed, no runJob is given, the program is not
   *   a coding dispatcher, or it has no cabimain/Cod entry proc.
   */
  async function runCodingDispatch(exec, opts = /** @type {any} */ ({})) {
    if (!opts.confirmed) {
      throw new Error('coding dispatch refused: opts.confirmed must be set');
    }
    if (typeof opts.runJob !== 'function') {
      throw new Error('coding dispatch refused: no runJob provided');
    }
    if (!exec || !exec.coding) {
      throw new Error(
        'coding dispatch refused: not a coding-dispatcher program'
      );
    }
    const host = new CdhHost({
      sgbd: opts.sgbd,
      slots: opts.slots || [],
      runJob: opts.runJob,
    });
    // The dispatcher's Cod handler reads (ident, coding index, current netto)
    // then writes. We arm the write gate for the whole handler: the read jobs
    // it issues are not write jobs, so they transmit fine with the gate open,
    // and only a write job (C_S_AUFTRAG / C_CHECKSUM / *_SCHREIBEN) is gated by
    // bestvm's classifier anyway. The caller still gates the WHOLE dispatch on
    // opts.confirmed above.
    host.allowWrites = true;
    // Seed the data-org from the CABD SPEICHERORG (exec.dataOrg / opts.dataOrg):
    // NCSEXPER's C layer sets it at CABD load, before the IPO runs, and the
    // dispatcher only re-sets it if it wants to override. Without this, a
    // word-mode module (E46 KMB, wortBreite 2) frames its packet as byte mode
    // and the SGBD rejects it (len != 22 + N*wortBreite).
    const org = opts.dataOrg || exec.dataOrg;
    if (org)
      host.CDHSetDataOrg(org.wortBreite, org.byteFolge, org.adrMode || 0);
    const interp = new Interp(exec, host);
    // cabimain routes by JOBNAME; seed it and run the router.
    const jobname = opts.jobname || DEFAULT_JOBNAME;
    host.CDHSetCabdPar('JOBNAME', jobname);
    host.sys.set('JOBNAME', jobname);
    const entry = interp.procs.cabimain
      ? 'cabimain'
      : interp.procs.Cod
        ? 'Cod'
        : null;
    if (!entry) throw new Error('coding dispatch: no cabimain/Cod proc');
    await interp.run(entry);
    return {
      ok: host.err === 0 && host.ret === 0,
      err: host.err,
      ret: host.ret,
      log: host.log,
      slots: host.slots,
    };
  }

  const api = {
    runCodingDispatch,
    CdhHost,
    Interp,
    _makeBinBuf: Host.makeBinBuf,
    _bytesToArgString: Host.bytesToArgString,
    _binWriteWord: Host.binWriteWord,
    _binReadWord: Host.binReadWord,
  };
  if (typeof root !== 'undefined') {
    root.runCodingDispatch = runCodingDispatch;
    root.codingDispatch = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
