/**
 * @file Parser for INPA's script language: tokens -> an AST.
 *
 * The grammar is the one tools/decompile/ipo_source.py emits, which is the one
 * BMW's own shipped .SRC files are written in -- globals with initialisers,
 * `#include`, functions with in:/out:/inout: parameters, MENU with INIT and
 * ITEM(nr,"label") blocks, SCREEN with LINE("label","keys") blocks,
 * STATEMACHINE with %labels, if/else/while, and C-precedence expressions.
 *
 * The AST is deliberately thin: the emitter walks it once and never revisits a
 * node, so nodes carry only what the emitter needs plus the line number an
 * error has to report.
 */

/** Binary operator precedence, the decompiler's table read backwards. */
const IPOF_PREC = {
  '||': 1,
  '^^': 1,
  '&&': 2,
  '&': 3,
  '|': 3,
  '^': 3,
  '==': 4,
  '!=': 4,
  '<': 5,
  '>': 5,
  '<=': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
};

/** Source operator text -> the binop opcode the walker names. */
const IPOF_OP_CODE = {
  '+': 0x60,
  '-': 0x61,
  '*': 0x62,
  '/': 0x63,
  '<': 0x64,
  '>': 0x65,
  '<=': 0x66,
  '>=': 0x67,
  '==': 0x68,
  '!=': 0x69,
  '&&': 0x6a,
  '||': 0x6b,
  '^^': 0x6c,
  '&': 0x6f,
  '|': 0x70,
  '^': 0x71,
};

/** Unary operator text -> opcode. */
const IPOF_UNOP_CODE = { '-': 0x6d, '!': 0x6e };

/** The declared value types. */
const IPOF_TYPES = new Set(['bool', 'byte', 'int', 'long', 'real', 'string']);

/**
 * A recursive-descent parser over one file's tokens.
 */
class IpofParser {
  /**
   * @param {Array<Object>} toks Tokens from ipofLex.
   */
  constructor(toks) {
    this.toks = toks;
    this.i = 0;
  }

  /**
   * The current token.
   * @returns {Object} The token.
   */
  peek() {
    return this.toks[this.i];
  }

  /**
   * Consume and return the current token.
   * @returns {Object} The token.
   */
  next() {
    const t = this.toks[this.i];
    this.i += 1;
    return t;
  }

  /**
   * Whether the current token matches a kind and (optionally) a value.
   * @param {string} kind The token kind.
   * @param {*} [value] The required value.
   * @returns {boolean} True on a match.
   */
  at(kind, value) {
    const t = this.peek();
    return t.kind === kind && (value === undefined || t.value === value);
  }

  /**
   * Consume the current token if it matches, else return null.
   * @param {string} kind The token kind.
   * @param {*} [value] The required value.
   * @returns {Object|null} The token, or null.
   */
  accept(kind, value) {
    return this.at(kind, value) ? this.next() : null;
  }

  /**
   * Consume the current token, requiring a match.
   * @param {string} kind The token kind.
   * @param {*} [value] The required value.
   * @returns {Object} The token.
   * @throws {IpofSyntaxError} When it does not match.
   */
  expect(kind, value) {
    const t = this.peek();
    if (!this.at(kind, value)) {
      const want = value === undefined ? kind : JSON.stringify(value);
      const got =
        t.kind === 'eof' ? 'end of file' : JSON.stringify(String(t.value));
      throw new IpofSyntaxError(`expected ${want}, found ${got}`, t.line);
    }
    return this.next();
  }

  /**
   * Parse a whole file.
   * @returns {{includes: string[], globals: Object[], procs: Object[]}} The AST.
   */
  parseFile() {
    const includes = [];
    const globals = [];
    const procs = [];
    while (!this.at('eof')) {
      if (this.at('include')) {
        includes.push(this.next().value);
        continue;
      }
      if (this.at('kw') && IPOF_TYPES.has(this.peek().value)) {
        globals.push(...this.parseVarDecl());
        continue;
      }
      procs.push(this.parseProc());
    }
    return { includes, globals, procs };
  }

  /**
   * Parse one `type name [= literal] [, name ...];` declaration.
   * @returns {Object[]} One node per declared name.
   */
  parseVarDecl() {
    const typeTok = this.next();
    const type = typeTok.value;
    const out = [];
    do {
      const nameTok = this.expect('id');
      let init = null;
      if (this.accept('op', '=')) init = this.parseExpr();
      out.push({
        node: 'var',
        type,
        name: nameTok.value,
        init,
        line: nameTok.line,
      });
    } while (this.accept('op', ','));
    this.expect('op', ';');
    return out;
  }

  /**
   * Parse one procedure: a function, MENU, SCREEN or STATEMACHINE.
   * @returns {Object} The proc node.
   */
  parseProc() {
    const t = this.peek();
    if (
      this.at('kw', 'MENU') ||
      this.at('kw', 'SCREEN') ||
      this.at('kw', 'STATEMACHINE')
    ) {
      const kw = this.next().value;
      const kind = {
        MENU: 'menu',
        SCREEN: 'screen',
        STATEMACHINE: 'statemachine',
      }[kw];
      const name = this.expect('id').value;
      this.expect('op', '(');
      this.expect('op', ')');
      this.expect('op', '{');
      return this.parseProcBody(kind, name, t.line);
    }
    // a function: `name(params) { ... }`
    const name = this.expect('id').value;
    this.expect('op', '(');
    const params = this.parseParams();
    this.expect('op', ')');
    this.expect('op', '{');
    const locals = this.parseLocals();
    const body = this.parseStmts();
    this.expect('op', '}');
    return {
      node: 'proc',
      kind: 'func',
      name,
      params,
      locals,
      body,
      line: t.line,
    };
  }

  /**
   * Parse a parameter list: `in: type name, out: type name, ...`.
   * @returns {Array<{mode: string, type: string, name: string}>} The params.
   */
  parseParams() {
    const out = [];
    if (this.at('op', ')')) return out;
    do {
      const modeTok = this.peek();
      let mode = 'in';
      if (
        this.at('kw', 'in') ||
        this.at('kw', 'out') ||
        this.at('kw', 'inout')
      ) {
        mode = this.next().value;
        this.expect('op', ':');
      }
      const type = this.peek().value;
      if (!IPOF_TYPES.has(type)) {
        throw new IpofSyntaxError(
          `parameter needs a type, found "${type}"`,
          modeTok.line
        );
      }
      this.next();
      out.push({ mode, type, name: this.expect('id').value });
    } while (this.accept('op', ','));
    return out;
  }

  /**
   * Parse the local declarations at a body's top.
   * @returns {Object[]} The local nodes.
   */
  parseLocals() {
    const out = [];
    while (this.at('kw') && IPOF_TYPES.has(this.peek().value))
      out.push(...this.parseVarDecl());
    return out;
  }

  /**
   * Parse a MENU / SCREEN / STATEMACHINE body, whose sections are its blocks.
   * @param {string} kind The proc kind.
   * @param {string} name The proc name.
   * @param {number} line The declaration's line.
   * @returns {Object} The proc node.
   */
  parseProcBody(kind, name, line) {
    const locals = this.parseLocals();
    const pre = [];
    const sections = [];
    while (!this.at('op', '}')) {
      if (this.at('kw', 'INIT')) {
        this.next();
        this.expect('op', '{');
        // INIT is the menu's prologue: it runs before any item, so its
        // statements belong with the ones written bare above it
        pre.push(...this.parseStmts());
        this.expect('op', '}');
        continue;
      }
      if (this.at('kw', 'ITEM') || this.at('kw', 'LINE')) {
        const head = this.next().value;
        this.expect('op', '(');
        let nr = 0;
        let label;
        let keys = '';
        if (head === 'ITEM') {
          nr = this.expect('num').value;
          this.expect('op', ',');
          label = this.expect('str').value;
        } else {
          label = this.expect('str').value;
          if (this.accept('op', ',')) keys = this.expect('str').value;
        }
        this.expect('op', ')');
        this.expect('op', '{');
        const body = this.parseStmts();
        this.expect('op', '}');
        sections.push({
          node: head,
          nr,
          label,
          keys,
          body,
          line,
        });
        continue;
      }
      if (this.at('state')) {
        const st = this.next();
        const body = [];
        // a state runs to the next label or the proc's end
        while (!this.at('op', '}') && !this.at('state'))
          body.push(this.parseStmt());
        sections.push({
          node: 'STATE',
          name: st.value,
          body,
          line: st.line,
        });
        continue;
      }
      pre.push(this.parseStmt());
    }
    this.expect('op', '}');
    return {
      node: 'proc',
      kind,
      name,
      params: [],
      locals,
      body: pre,
      sections,
      line,
    };
  }

  /**
   * Parse statements up to a closing brace.
   * @returns {Object[]} The statement nodes.
   */
  parseStmts() {
    const out = [];
    while (!this.at('op', '}') && !this.at('eof')) out.push(this.parseStmt());
    return out;
  }

  /**
   * Parse one statement.
   * @returns {Object} The statement node.
   */
  parseStmt() {
    const t = this.peek();
    if (this.at('op', ';')) {
      this.next();
      return { node: 'empty', line: t.line };
    }
    if (this.at('op', '{')) {
      this.next();
      const body = this.parseStmts();
      this.expect('op', '}');
      return { node: 'block', body, line: t.line };
    }
    if (this.at('kw', 'if')) {
      this.next();
      this.expect('op', '(');
      const cond = this.parseExpr();
      this.expect('op', ')');
      const then = this.parseStmt();
      let alt = null;
      if (this.accept('kw', 'else')) alt = this.parseStmt();
      return {
        node: 'if',
        cond,
        then,
        alt,
        line: t.line,
      };
    }
    if (this.at('kw', 'while')) {
      this.next();
      this.expect('op', '(');
      const cond = this.parseExpr();
      this.expect('op', ')');
      const body = this.parseStmt();
      return {
        node: 'while',
        cond,
        body,
        line: t.line,
      };
    }
    if (this.at('kw', 'return')) {
      this.next();
      this.expect('op', ';');
      return { node: 'return', line: t.line };
    }
    if (this.at('state')) {
      const st = this.next();
      return { node: 'label', name: st.value, line: st.line };
    }
    // an assignment or a call: both start with an expression
    const e = this.parseExpr();
    if (this.accept('op', '=')) {
      const value = this.parseExpr();
      this.expect('op', ';');
      if (e.node !== 'name') {
        throw new IpofSyntaxError(
          'assignment needs a variable on the left',
          t.line
        );
      }
      return {
        node: 'assign',
        name: e.name,
        value,
        line: t.line,
      };
    }
    this.expect('op', ';');
    if (e.node !== 'call') return { node: 'expr', value: e, line: t.line };
    return { node: 'callstmt', call: e, line: t.line };
  }

  /**
   * Parse an expression with C precedence.
   * @param {number} [minPrec] The lowest precedence to bind at.
   * @returns {Object} The expression node.
   */
  parseExpr(minPrec) {
    const min = minPrec || 0;
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op') break;
      const prec = IPOF_PREC[t.value];
      if (prec === undefined || prec < min) break;
      this.next();
      const right = this.parseExpr(prec + 1);
      left = {
        node: 'binop',
        op: t.value,
        left,
        right,
        line: t.line,
      };
    }
    return left;
  }

  /**
   * Parse a unary expression.
   * @returns {Object} The expression node.
   */
  parseUnary() {
    const t = this.peek();
    if (this.at('op', '-') || this.at('op', '!')) {
      this.next();
      return {
        node: 'unop',
        op: t.value,
        operand: this.parseUnary(),
        line: t.line,
      };
    }
    return this.parseAtom();
  }

  /**
   * Parse an atom: a literal, a name, a call, or a parenthesised expression.
   * @returns {Object} The expression node.
   */
  parseAtom() {
    const t = this.next();
    if (t.kind === 'num') {
      return {
        node: 'lit',
        type: t.real ? 'real' : 'int',
        value: t.value,
        line: t.line,
      };
    }
    if (t.kind === 'str') {
      return {
        node: 'lit',
        type: 'string',
        value: t.value,
        line: t.line,
      };
    }
    if (t.kind === 'kw' && (t.value === 'TRUE' || t.value === 'FALSE')) {
      return {
        node: 'lit',
        type: 'bool',
        value: t.value === 'TRUE',
        line: t.line,
      };
    }
    if (t.kind === 'op' && t.value === '(') {
      const e = this.parseExpr();
      this.expect('op', ')');
      return e;
    }
    if (t.kind === 'id') {
      if (this.at('op', '(')) {
        this.next();
        const args = [];
        if (!this.at('op', ')')) {
          do {
            args.push(this.parseExpr());
          } while (this.accept('op', ','));
        }
        this.expect('op', ')');
        return {
          node: 'call',
          name: t.value,
          args,
          line: t.line,
        };
      }
      return { node: 'name', name: t.value, line: t.line };
    }
    const got =
      t.kind === 'eof' ? 'end of file' : JSON.stringify(String(t.value));
    throw new IpofSyntaxError(`expected a value, found ${got}`, t.line);
  }
}

/**
 * Parse one INPA source file.
 *
 * @param {string} src The source text.
 * @returns {{includes: string[], globals: Object[], procs: Object[]}} The AST.
 * @throws {IpofSyntaxError} On a syntax error, naming the line.
 */
function ipofParse(src) {
  return new IpofParser(ipofLex(src)).parseFile();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipofParse,
    IpofParser,
    IPOF_PREC,
    IPOF_OP_CODE,
    IPOF_UNOP_CODE,
    IPOF_TYPES,
  };
}
