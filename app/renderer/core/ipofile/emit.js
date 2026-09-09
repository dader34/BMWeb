/**
 * @file The AST -> the same token stream the walker reads out of an .IPO.
 *
 * The emitter's contract is that its output is indistinguishable from a
 * decoded file's: one 4-byte slot per ordinary token, an inline header's real
 * length for ITEM / LINE, and `at` / `to` as absolute byte offsets in the same
 * coordinate system walk() reports. That is what lets one runtime run a
 * compiled script and a decoded one without knowing which it has.
 *
 * Control flow compiles to the shapes the decompiler recognises, so a
 * decompile-then-compile round trip lands back on the same structure:
 *
 *     cond stmt jfalse->END                       if
 *     cond stmt jfalse->ELSE ... jump->END ELSE   if / else
 *     L: cond stmt jfalse->END ... jump->L        while
 */

/** Literal type -> the pool's type letter. */
const IPOF_LIT_TAG = {
  bool: 'b',
  byte: 'y',
  int: 'i',
  long: 'l',
  real: 'd',
  string: 's',
};

/** Slot scopes, as the walker reports them. */
const IPOF_SC_GLOBAL = 0;
const IPOF_SC_LOCAL = 2;

/**
 * Builds one proc's token list, tracking byte offsets as it goes.
 *
 * Tokens are appended without their `at`, then a single pass assigns offsets
 * and resolves the recorded jump fixups -- a jump's target is usually a token
 * that has not been emitted yet, so it cannot be resolved inline.
 */
class IpofProcEmitter {
  /**
   * @param {IpofCompiler} c The compiler, for its name tables.
   * @param {Object} proc The proc AST node.
   */
  constructor(c, proc) {
    this.c = c;
    this.proc = proc;
    this.toks = [];
    this.fixups = []; // {tok, label}
    this.labels = new Map(); // label -> token index
    this.slots = new Map(); // name -> {n, scope, ref}
    this.base = 0; // token index the current block's jumps count from
  }

  /**
   * Append a token.
   * @param {Object} t The token, without `at`.
   * @returns {Object} The same token.
   */
  push(t) {
    this.toks.push(t);
    return t;
  }

  /**
   * Reserve a label name that later resolves to the next token index.
   * @returns {string} The label.
   */
  label() {
    // A monotonic counter, NOT a name derived from the current position: a
    // while reserves its top and its exit before emitting either, so two
    // position-derived names would collide and the loop's back edge would be
    // bound to the exit -- turning every loop into straight-line code.
    this._nlabel = (this._nlabel || 0) + 1;
    return `L${this._nlabel}`;
  }

  /**
   * Bind a label to the next token to be emitted.
   * @param {string} l The label.
   * @returns {void}
   */
  mark(l) {
    this.labels.set(l, this.toks.length);
  }

  /**
   * Emit a jump whose target is filled in once the label is bound.
   * @param {string} op Either 'jump' or 'jfalse'.
   * @param {string} l The label to jump to.
   * @returns {void}
   */
  jumpTo(op, l) {
    const t = this.push({ op, to: 0 });
    this.fixups.push({ tok: t, label: l, base: this.base });
  }

  /**
   * A token's byte length: 4, except for the inline headers.
   * @param {Object} t The token.
   * @returns {number} Its length in bytes.
   */
  static size(t) {
    if (t.op === 'ITEM' || t.op === 'LINE') {
      // op + u16 + pad + u16 nr + label \n + keys \n + pad + u16 end
      return 6 + t.label.length + 1 + (t.keys || '').length + 1 + 4;
    }
    if (t.op === 'state') return t.name.length + 1 + 4 + 1;
    return 4;
  }

  /**
   * Assign every token its byte offset and resolve the jump fixups.
   *
   * A jump's target is a BYTE offset, so it is computed from the target
   * token's offset -- the same number walk() reconstructs from the file's
   * block-relative dword index.
   *
   * @param {number} start The byte offset the proc's first token sits at.
   * @returns {number} The byte offset just past the proc.
   */
  finish(start) {
    let at = start;
    const offs = [];
    for (const t of this.toks) {
      offs.push(at);
      t.at = at;
      at += IpofProcEmitter.size(t);
    }
    offs.push(at); // a jump past the last token
    for (const f of this.fixups) {
      const idx = this.labels.get(f.label);
      f.tok.to = offs[idx === undefined ? this.toks.length : idx];
    }
    return at;
  }
}

/**
 * Compiles a parsed file into an exec object.
 */
class IpofCompiler {
  /**
   * @param {{includes: string[], globals: Object[], procs: Object[]}} ast The
   *   parsed main file.
   * @param {Object} [opts] Options.
   * @param {Object<string, number>} [opts.builtins] Builtin name -> number.
   * @param {string[]} [opts.imports] DLL import names, by index.
   */
  constructor(ast, opts) {
    const o = opts || {};
    this.ast = ast;
    this.builtins = o.builtins || {};
    this.imports = o.imports || [];
    this.protos = o.protos || {};
    this.errors = [];
    this.globals = new Map(); // name -> slot
    this.procIds = new Map(); // name -> {kind, id}
    this.procKinds = new Map(); // name -> kind
    this.paramModes = new Map(); // name -> ['in'|'out'|'inout', ...]
  }

  /**
   * Record a compile error against a source line.
   * @param {string} message What is wrong.
   * @param {number} line The source line.
   * @returns {void}
   */
  error(message, line) {
    this.errors.push({ message, line, text: `line ${line}: ${message}` });
  }

  /**
   * Assign global slots and proc ids, then compile every proc.
   * @returns {{ecu: string, procs: Object, byid: Object, errors: Object[]}} The
   *   exec object plus any errors; procs is empty when errors is not.
   */
  compile() {
    // slot 0 is the void slot the format reserves; globals start at 1
    let slot = 1;
    for (const g of this.ast.globals) {
      if (!this.globals.has(g.name)) this.globals.set(g.name, slot++);
    }
    // ids are per declaration TABLE, and the walker's procref reads them that
    // way: a screen id and a menu id may both be 3 without colliding
    const nextId = {
      func: 0,
      menu: 0,
      screen: 0,
      statemachine: 0,
      state: 0,
    };
    // A script that already carries a library function's body -- as every
    // decompiled file does, the includes having been compiled in -- must not
    // get a second copy when that library is supplied as an include too. The
    // definition from the script itself wins, and the duplicate is dropped
    // rather than reported: it is the same function, not a conflict.
    const kept = [];
    for (let k = this.ast.procs.length - 1; k >= 0; k -= 1) {
      const p = this.ast.procs[k];
      if (this.procIds.has(p.name)) continue;
      this.procIds.set(p.name, { kind: p.kind, id: 0 });
      kept.unshift(p);
    }
    this.ast.procs = kept;
    this.procIds.clear();
    for (const p of kept) {
      this.procIds.set(p.name, { kind: p.kind, id: nextId[p.kind]++ });
      this.procKinds.set(p.name, p.kind);
      this.paramModes.set(p.name, this.inferModes(p));
    }
    const procs = {};
    const byid = {};
    let at = 0;
    // the global initialisers live in the startup proc, exactly as the real
    // compiler puts them there
    const startup = this.startupProc();
    if (startup) this.ast.procs.unshift(startup);
    for (const p of this.ast.procs) {
      const e = new IpofProcEmitter(this, p);
      try {
        this.emitProc(e, p);
      } catch (err) {
        if (!(err instanceof IpofSyntaxError)) throw err;
        this.error(err.message.replace(/^line \d+: /, ''), err.line);
      }
      at = e.finish(at) + 32; // a gap for the next declaration header
      procs[p.name] = e.toks;
      const id = this.procIds.get(p.name);
      if (id) byid[`${id.kind}:${id.id}`] = p.name;
    }
    return {
      ecu: this.ecu || 'script',
      procs,
      byid,
      errors: this.errors,
    };
  }

  /**
   * A function's real parameter modes, correcting a lost `out:`.
   *
   * A parameter the body assigns to, or hands to a builtin's own out slot, is
   * written through by the callee and must therefore be passed by reference --
   * whatever the declaration says. This matters because a decompiled source
   * can lose the marker: ipo_source.py infers modes from use, and a parameter
   * only ever forwarded to another function's out slot reads as `in:` to it.
   * Compiling that literally would pass the value instead of the destination,
   * and the callee's results would go nowhere.
   *
   * @param {Object} p The proc node.
   * @returns {string[]} One mode per parameter.
   */
  inferModes(p) {
    const modes = (p.params || []).map((x) => x.mode);
    const byName = new Map();
    (p.params || []).forEach((x, k) => byName.set(x.name, k));
    if (!byName.size) return modes;
    /**
     * Mark a parameter as written through.
     * @param {string} name The argument's name.
     * @returns {void}
     */
    const markOut = (name) => {
      const k = byName.get(name);
      if (k !== undefined && modes[k] === 'in') modes[k] = 'out';
    };
    /**
     * Walk a statement list, marking every parameter the body writes to.
     * @param {Object[]} body The statements.
     * @returns {void}
     */
    const scan = (body) => {
      for (const s of body || []) {
        if (!s) continue;
        if (s.node === 'assign') markOut(s.name);
        if (s.node === 'callstmt' || s.node === 'expr') {
          const call = s.call || s.value;
          const outs = (call && this.protos[call.name]) || [];
          for (let k = 0; k < ((call && call.args) || []).length; k += 1) {
            const a = call.args[k];
            if (
              a &&
              a.node === 'name' &&
              (outs[k] === 'out' || outs[k] === 'inout')
            ) {
              markOut(a.name);
            }
          }
        }
        // a block's body is a list; a while's is one statement
        if (s.body) scan(Array.isArray(s.body) ? s.body : [s.body]);
        if (s.then) scan([s.then]);
        if (s.alt) scan([s.alt]);
      }
    };
    scan(p.body);
    for (const sec of p.sections || []) scan(sec.body);
    return modes;
  }

  /**
   * The synthetic proc that carries the global initialisers.
   * @returns {Object|null} The proc node, or null when nothing is initialised.
   */
  startupProc() {
    const body = this.ast.globals
      .filter((g) => g.init)
      .map((g) => ({
        node: 'assign',
        name: g.name,
        value: g.init,
        line: g.line,
      }));
    if (!body.length) return null;
    const name = '__inpa_startup__';
    if (this.procIds.has(name)) return null;
    this.procIds.set(name, { kind: 'func', id: 900 });
    this.procKinds.set(name, 'func');
    return {
      node: 'proc',
      kind: 'func',
      name,
      params: [],
      locals: [],
      body,
      line: 0,
    };
  }

  /**
   * Compile one proc's body into its emitter.
   * @param {IpofProcEmitter} e The emitter.
   * @param {Object} p The proc node.
   * @returns {void}
   */
  emitProc(e, p) {
    // params first, then locals: the slot order the format fixes
    let n = 0;
    for (const par of p.params) {
      e.slots.set(par.name, {
        n: n++,
        scope: IPOF_SC_LOCAL,
        ref: par.mode === 'out' || par.mode === 'inout',
      });
    }
    for (const l of p.locals) {
      e.slots.set(l.name, { n: n++, scope: IPOF_SC_LOCAL, ref: false });
    }
    // the block header, whose dword count the runtime reads as the prologue's
    // end; it is patched once the prologue's real length is known
    const header = e.push({ op: 'block', dwords: 0 });
    for (const l of p.locals) {
      // an initialised local declares as a bare literal push, an
      // uninitialised one as a typed decl -- the two forms the prologue has
      if (l.init) this.emitExpr(e, l.init, p);
      else e.push({ op: 'decl', type: l.type });
    }
    e.base = 0;
    const end = e.label();
    e.endLabel = end;
    this.emitBlock(e, p.body, p);
    for (const s of p.sections || []) this.emitSection(e, s, p);
    e.mark(end);
    e.push({ op: 'ret' });
    e.push({ op: 'endproc' });
    // the header's dword count is the block's own extent, which is only ever
    // read as documentation -- the runtime walks the tape, not this number
    header.dwords = e.toks.length - 1;
  }

  /**
   * Compile one ITEM / LINE / STATE section.
   * @param {IpofProcEmitter} e The emitter.
   * @param {Object} s The section node.
   * @param {Object} p The enclosing proc.
   * @returns {void}
   */
  emitSection(e, s, p) {
    if (s.node === 'STATE') {
      e.push({
        op: 'state',
        name: `%${s.name}`,
        index: this.stateIndex(s.name),
      });
    } else {
      const t = {
        op: s.node,
        nr: s.nr,
        label: s.label,
        dwords: 0,
      };
      if (s.keys) t.keys = s.keys;
      e.push(t);
    }
    // an inline header re-bases the jumps inside its own body
    e.base = e.toks.length;
    const mark = e.toks.length;
    const end = e.label();
    const outer = e.endLabel;
    e.endLabel = end;
    this.emitBlock(e, s.body, p);
    e.mark(end);
    e.endLabel = outer;
    if (s.node !== 'STATE') e.toks[mark - 1].dwords = e.toks.length - mark;
  }

  /**
   * The state index a `%LABEL` carries.
   * @param {string} name The label name.
   * @returns {number} Its index.
   */
  stateIndex(name) {
    if (!this._states) this._states = new Map();
    if (!this._states.has(name)) this._states.set(name, this._states.size);
    return this._states.get(name);
  }

  /**
   * Compile a list of statements.
   * @param {IpofProcEmitter} e The emitter.
   * @param {Object[]} body The statements.
   * @param {Object} p The enclosing proc.
   * @returns {void}
   */
  emitBlock(e, body, p) {
    for (const s of body) this.emitStmt(e, s, p);
  }

  /**
   * Compile one statement.
   * @param {IpofProcEmitter} e The emitter.
   * @param {Object} s The statement node.
   * @param {Object} p The enclosing proc.
   * @returns {void}
   */
  emitStmt(e, s, p) {
    if (s.node === 'empty') return;
    if (s.node === 'block') {
      this.emitBlock(e, s.body, p);
      return;
    }
    if (s.node === 'label') {
      e.push({
        op: 'state',
        name: `%${s.name}`,
        index: this.stateIndex(s.name),
      });
      return;
    }
    if (s.node === 'return') {
      // an early exit is a jump to the body's end, the shape the decompiler
      // reads back as `return;`
      e.jumpTo('jump', e.endLabel);
      return;
    }
    if (s.node === 'assign') {
      this.emitExpr(e, s.value, p);
      const slot = this.resolveSlot(e, s.name, s.line);
      const t = { op: 'store', n: slot.n, sc: slot.scope };
      if (slot.ref) t.ref = true;
      e.push(t);
      // a store is followed by the statement separator, as the compiled files
      // show: the tape's evaluation stack is cleared between statements
      e.push({ op: 'stmt', n: 1 });
      return;
    }
    if (s.node === 'callstmt') {
      this.emitCall(e, s.call, p);
      return;
    }
    if (s.node === 'expr') {
      this.emitExpr(e, s.value, p);
      e.push({ op: 'stmt', n: 1 });
      return;
    }
    if (s.node === 'if') {
      this.emitExpr(e, s.cond, p);
      e.push({ op: 'stmt', n: 1 });
      const alt = e.label();
      e.jumpTo('jfalse', alt);
      this.emitStmt(e, s.then, p);
      if (s.alt) {
        const done = e.label();
        e.jumpTo('jump', done);
        e.mark(alt);
        this.emitStmt(e, s.alt, p);
        e.mark(done);
      } else {
        e.mark(alt);
      }
      return;
    }
    if (s.node === 'while') {
      const top = e.label();
      const done = e.label();
      e.mark(top);
      this.emitExpr(e, s.cond, p);
      e.push({ op: 'stmt', n: 1 });
      e.jumpTo('jfalse', done);
      this.emitStmt(e, s.body, p);
      e.jumpTo('jump', top);
      e.mark(done);
      return;
    }
    this.error(`cannot compile a ${s.node} statement`, s.line);
  }

  /**
   * Compile one call, opening its argument frame first.
   * @param {IpofProcEmitter} e The emitter.
   * @param {Object} c The call node.
   * @param {Object} p The enclosing proc.
   * @returns {void}
   */
  emitCall(e, c, p) {
    e.push({ op: 'frame' });
    const proc = this.procIds.get(c.name);
    // an out/inout parameter is passed by reference: the argument compiles to
    // a procref carrying the slot, not to an ordinary push
    const modes =
      proc && proc.kind === 'func'
        ? this.paramModes.get(c.name) || []
        : this.protos[c.name] || [];
    c.args.forEach((a, k) => {
      const byRef = modes[k] === 'out' || modes[k] === 'inout';
      this.emitArg(e, a, p, byRef);
    });
    if (proc && proc.kind === 'func') {
      e.push({ op: 'calluser', n: proc.id });
      return;
    }
    const alias = (this.imports.alias || {})[c.name];
    const imp = this.imports.indexOf(alias || c.name);
    if (imp >= 0) {
      e.push({ op: 'dllcall', n: imp });
      return;
    }
    const n = this.builtins[c.name];
    if (n === undefined) {
      // a builtin the tables do not number cannot be compiled: there is no
      // opcode to emit, and inventing one would send an unknown call to the car
      this.error(
        `unknown function "${c.name}" -- no builtin number for it`,
        c.line
      );
      e.push({ op: 'stmt', n: 1 });
      return;
    }
    e.push({ op: 'call', n, name: ipofBuiltinNameFor(n, this.builtinNames) });
  }

  /**
   * Compile one call argument.
   *
   * A bare name that names a proc is a procref (the form `setscreen(s_main,
   * TRUE)` uses); a name that names an out parameter passes by reference.
   *
   * @param {IpofProcEmitter} e The emitter.
   * @param {Object} a The argument expression.
   * @param {Object} p The enclosing proc.
   * @returns {void}
   */
  emitArg(e, a, p, byRef) {
    if (
      a.node === 'name' &&
      this.procIds.has(a.name) &&
      !e.slots.has(a.name) &&
      !this.globals.has(a.name)
    ) {
      const r = this.procIds.get(a.name);
      const kind = {
        screen: 0x40,
        menu: 0x41,
        state: 0x42,
        statemachine: 0x43,
        func: 0x00,
      }[r.kind];
      e.push({ op: 'procref', kind, n: r.id });
      return;
    }
    if (byRef && a.node === 'name') {
      // the destination slot itself, in the scope it lives in -- the same
      // encoding the walker reads back as a procref over a variable
      const slot = this.resolveSlot(e, a.name, a.line);
      e.push({ op: 'procref', kind: slot.scope, n: slot.n });
      return;
    }
    this.emitExpr(e, a, p);
  }

  /**
   * Resolve a name to its slot.
   * @param {IpofProcEmitter} e The emitter.
   * @param {string} name The name.
   * @param {number} line The source line, for errors.
   * @returns {{n: number, scope: number, ref: boolean}} The slot.
   */
  resolveSlot(e, name, line) {
    if (e.slots.has(name)) return e.slots.get(name);
    if (this.globals.has(name)) {
      return { n: this.globals.get(name), scope: IPOF_SC_GLOBAL, ref: false };
    }
    // A name shaped like the decompiler's own placeholder for a slot it could
    // not name (`v2`, `s17`, `gb44`) is a slot the source never declared
    // because the .IPO never named it. Give it one rather than refusing the
    // file: the alternative is that no decompiled script round-trips.
    if (/^(?:g?[bylirsv])\d+$/.test(name)) {
      const slot = { n: e.slots.size, scope: IPOF_SC_LOCAL, ref: false };
      e.slots.set(name, slot);
      return slot;
    }
    this.error(`"${name}" is not declared`, line);
    return { n: 0, scope: IPOF_SC_GLOBAL, ref: false };
  }

  /**
   * Compile an expression, leaving its value on the stack.
   * @param {IpofProcEmitter} e The emitter.
   * @param {Object} x The expression node.
   * @param {Object} p The enclosing proc.
   * @returns {void}
   */
  emitExpr(e, x, p) {
    if (x.node === 'lit') {
      // a bool is a byte in the pool, so it reads back as 1 / 0 -- never as a
      // JS boolean, which would not compare equal to a decoded file's value
      const v = x.type === 'bool' ? (x.value ? 1 : 0) : x.value;
      e.push({
        op: 'const',
        n: this.constSlot(x),
        t: IPOF_LIT_TAG[x.type],
        v,
      });
      return;
    }
    if (x.node === 'name') {
      if (
        !e.slots.has(x.name) &&
        !this.globals.has(x.name) &&
        this.procIds.has(x.name)
      ) {
        this.emitArg(e, x, p);
        return;
      }
      const slot = this.resolveSlot(e, x.name, x.line);
      const t = { op: 'var', n: slot.n, sc: slot.scope };
      if (slot.ref) t.ref = true;
      e.push(t);
      return;
    }
    if (x.node === 'call') {
      this.emitCall(e, x, p);
      return;
    }
    if (x.node === 'binop') {
      this.emitExpr(e, x.left, p);
      this.emitExpr(e, x.right, p);
      const code = IPOF_OP_CODE[x.op];
      e.push({ op: 'binop', n: code, name: IPOF_BINOPS[code] || null });
      return;
    }
    if (x.node === 'unop') {
      this.emitExpr(e, x.operand, p);
      const code = IPOF_UNOP_CODE[x.op];
      e.push({ op: 'binop', n: code, name: IPOF_BINOPS[code] || null });
      return;
    }
    this.error(`cannot compile a ${x.node} expression`, x.line);
  }

  /**
   * The pool index a literal would occupy.
   *
   * The exec form inlines every constant's value, so the index is only an
   * identity -- but it has to be stable and unique per distinct literal, the
   * way a real pool's is.
   *
   * @param {Object} x The literal node.
   * @returns {number} Its slot.
   */
  constSlot(x) {
    if (!this._consts) this._consts = new Map();
    const key = `${x.type} ${String(x.value)}`;
    if (!this._consts.has(key)) this._consts.set(key, this._consts.size);
    return this._consts.get(key);
  }
}

/**
 * A builtin's canonical name for a number, matching what the walker emits.
 *
 * @param {number} n The builtin number.
 * @param {Object<number, string>} [names] An override table.
 * @returns {string} The name.
 */
function ipofBuiltinNameFor(n, names) {
  const table = names || IPOF_BUILTINS;
  return table[n] || ipofBuiltinName(n);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IpofCompiler,
    IpofProcEmitter,
    ipofBuiltinNameFor,
    IPOF_LIT_TAG,
  };
}
