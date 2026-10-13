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
 * @property {boolean} [confirmed] - REQUIRED true for a write (the UI's
 *   confirmation); a read run does not need it.
 * @property {CdhRunJob} runJob - the bus job runner.
 * @property {string} [sgbd] - the coding SGBD name.
 * @property {ArrayLike<number>} [netto] - the module's full coding image.
 * @property {CabdLayout} [cabd] - the coding description's functions, groups
 *   and coding indexes, for the script's selections.
 * @property {Record<string, string>} [systemData] - FAHRGESTELL_NR and the like.
 * @property {'write'|'read'} [mode] - `read` fills the image from the module.
 * @property {ArrayLike<number>} [changed] - write: the byte addresses the
 *   run may send -- the module's coding region.
 * @property {ArrayLike<number>} [held] - write: the image as the module
 *   holds it, for bytes that ride along in a word without being selected.
 * @property {ArrayLike<number>} [readAddrs] - read: the byte addresses wanted.
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
 * @property {string} info - the recorded error text, '' when none.
 * @property {number[]} netto - the image after the run (read mode fills it).
 * @property {number[]} written - byte addresses a write job carried.
 * @property {number[]} read - byte addresses a read filled in.
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

  /**
   * Thrown to unwind the whole run: the dispatcher's own `exit` (BMW's
   * TestCDHFehler / TestApiFehler call it after recording the error, so a
   * failed job stops the sequence instead of going on to the next write), or
   * a call this host cannot serve.
   */
  class DispatchAbort extends Error {
    /**
     * @param {string} why - what stopped the run.
     * @param {boolean} unsupported - true when a host call is not implemented.
     */
    constructor(why, unsupported) {
      super(why);
      this.dispatchAbort = true;
      this.unsupported = !!unsupported;
    }
  }

  /** The error number recorded when the run stops on an unserved host call. */
  const ERR_UNSUPPORTED_CALL = 9001;

  // The language's own library, which the dispatchers lean on: every error
  // text is built with strcat, the coding index is padded by strlen, and the
  // cluster decides whether to rewrite the VIN from midstr(FAHRGESTELL_NR).
  // Each takes its destination as the first (out) argument.
  /** @type {Record<string, {sig: Array<'in'|'out'>, fn: (...a: unknown[]) => unknown}>} */
  const BUILTINS = {
    strcat: { sig: ['out', 'in', 'in'], fn: (a, b) => asStr(a) + asStr(b) },
    strlen: { sig: ['out', 'in'], fn: (a) => asStr(a).length },
    // midstr(dest, source, start, count): start counts from 0
    midstr: {
      sig: ['out', 'in', 'in', 'in'],
      fn: (src, start, count) =>
        asStr(src).substr(Math.max(0, asInt(start)), Math.max(0, asInt(count))),
    },
    inttostring: { sig: ['in', 'out'], fn: (n) => String(asInt(n)) },
  };
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
      await this._exec(toks, this._locals(toks, new Map()));
    }

    /**
     * A proc opens with its local declarations: after `block`, one token per
     * local in slot order behind the parameters -- a bare `decl`, or a `const`
     * that is a local declared WITH its initial value -- closed by the first
     * statement terminator. BMW's handlers carry real values there (the proc
     * name for error texts, the loop flag, and MaxData: 30 for the body
     * module, 12 for the cluster's write and 16 for its read), so dropping
     * them sent 32 records where the script asks for 12.
     * @param {DispatchToken[]} toks - the proc's tokens.
     * @param {Map<number, unknown>} frame - the frame holding the parameters.
     * @returns {Map<number, unknown>} the same frame, locals initialised.
     */
    _locals(toks, frame) {
      let i = toks.length && toks[0].op === 'block' ? 1 : 0;
      const header = [];
      for (; i < toks.length; i++) {
        const op = toks[i].op;
        if (op === 'decl' || op === 'const') header.push(toks[i]);
        else break;
      }
      // only a run of declarations CLOSED by a terminator is a header; a proc
      // without locals starts straight into its first expression
      if (i >= toks.length || toks[i].op !== 'ret') return frame;
      if (!header.some((t) => t.op === 'decl' || t.op === 'const'))
        return frame;
      let slot = frame.size;
      for (const t of header) {
        if (t.op === 'const') frame.set(slot, t.v);
        slot++;
      }
      return frame;
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
          if (t.name === 'not') {
            stack.push(truthy(stack.pop()) ? 0 : 1); // the one unary operator
          } else {
            const b = stack.pop(),
              a = stack.pop();
            stack.push(binop(t.name, a, b));
          }
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
      await this._exec(this.procs[name], this._locals(this.procs[name], frame));
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
      // `exit` ends the whole run, wherever it is called from. BMW's error
      // checks record the failure and then call it, so nothing after a failed
      // job is sent.
      if (name === 'exit') throw new DispatchAbort('exit', false);
      const builtin = BUILTINS[name];
      if (builtin) {
        const bsig = builtin.sig;
        const bargs = stack.slice(-bsig.length);
        const bins = [];
        let dest = null;
        bsig.forEach((dir, k) => {
          if (dir === 'in') bins.push(bargs[k]);
          else dest = bargs[k];
        });
        if (dest != null) this._writeRef(dest, frame, builtin.fn(...bins));
        return;
      }
      const fn = host[name];
      if (typeof fn !== 'function') {
        // A call this host cannot serve must not be skipped: the script would
        // carry on with whatever it was meant to set up missing. Stop the run
        // and say which call it was.
        host.err = ERR_UNSUPPORTED_CALL;
        host.errInfo = `host call ${name} is not supported`;
        throw new DispatchAbort(host.errInfo, true);
      }
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
    // A write needs the UI's confirmation. A read run does not: its gate is
    // shut, so nothing it issues can be a write.
    if (opts.mode !== 'read' && !opts.confirmed) {
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
    // A module whose coding description numbers its blocks (SPEICHERORG TYP
    // BLOCK: the body module, the light module) is addressed by block, and its
    // jobs disagree on how: the body module's read job puts the address on
    // the wire as the block number, its write job divides the address by 20
    // first. Which address the factory tool hands them is not known, so such
    // a module is not written through here until it is.
    const cabd = opts.cabd || null;
    const blocked =
      cabd &&
      (cabd.typ === 'BLOCK' ||
        (cabd.fields || []).some((f) => (f.block | 0) > 0) ||
        (cabd.groups || []).some((g) => (g.block | 0) > 0));
    if (blocked) {
      throw new Error(
        'coding dispatch refused: this module addresses its coding by block, ' +
          'which the dispatcher path does not do yet'
      );
    }
    const mode = opts.mode === 'read' ? 'read' : 'write';
    const host = new CdhHost({
      sgbd: opts.sgbd,
      netto: opts.netto,
      cabd: cabd || undefined,
      changed: opts.changed,
      held: opts.held,
      readAddrs: opts.readAddrs,
      systemData: opts.systemData,
      mode,
      runJob: opts.runJob,
    });
    // The write handler reads (ident, coding index, a status word) and then
    // writes, so the gate is open for the whole handler; a read run keeps it
    // shut, so nothing it issues can be a write. The caller still gates the
    // WHOLE dispatch on opts.confirmed above.
    host.allowWrites = mode === 'write';
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
    // The file's own startup proc sets its globals -- the error numbers every
    // check passes on and the module name -- and then calls cabimain itself.
    // Starting at cabimain left them unset, so a failure was recorded as
    // error 0, which reads as success.
    const entry = interp.procs.__inpa_startup__
      ? '__inpa_startup__'
      : interp.procs.cabimain
        ? 'cabimain'
        : interp.procs.Cod
          ? 'Cod'
          : null;
    if (!entry) throw new Error('coding dispatch: no cabimain/Cod proc');
    let aborted = null;
    try {
      await interp.run(entry);
    } catch (e) {
      if (!e || !e.dispatchAbort) throw e;
      aborted = e;
    }
    // An `exit` after a clean handler is how some scripts end; what makes a
    // run a failure is what was recorded before it: an error number, a
    // non-zero return value, or a call this host could not serve.
    const failed =
      host.err !== 0 || host.ret !== 0 || !!(aborted && aborted.unsupported);
    return {
      ok: !failed,
      err: host.err,
      ret: host.ret,
      info: host.errInfo || '',
      log: host.log,
      slots: host.slots,
      netto: Array.from(host.netto),
      written: host.writtenAddrs(),
      read: host.readAddrs(),
    };
  }

  const api = {
    runCodingDispatch,
    CdhHost,
    Interp,
    DispatchAbort,
    ERR_UNSUPPORTED_CALL,
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
