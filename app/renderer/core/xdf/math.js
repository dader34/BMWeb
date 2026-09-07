/**
 * @file XDF engine, piece 2 of 6: the MATH expression parser, evaluator and
 * linear inverse, plus the tally of equations that could not be compiled.
 *
 * TunerPro MATH is strictly arithmetic: term (('+'|'-') term)*, term is
 * factor (('*'|'/') factor)*, factor is -factor | (expr) | NUMBER | IDENT.
 * Real samples: "X", "0.75*X-48.0", "X*0.01", "X-100".
 *
 * Adds to the shared `window.XDF` namespace; see xml.js for the load order.
 */

(function (root) {
  'use strict';

  const XDF = root.XDF || (root.XDF = {});

  /**
   * @typedef {{ kind: 'num', value: number }} MathNum
   * @typedef {{ kind: 'var', name: string }} MathVar
   * @typedef {{ kind: 'neg', arg: MathNode }} MathNeg
   * @typedef {{ kind: 'binop', op: '+'|'-'|'*'|'/', left: MathNode, right: MathNode }} MathBinop
   * @typedef {MathNum|MathVar|MathNeg|MathBinop} MathNode
   */

  /**
   * Error raised when a MATH string does not fit the arithmetic grammar.
   * Carries the source and the offset so the message can point at the spot.
   */
  class MathParseError extends Error {
    /**
     * @param {string} message - What was expected or found.
     * @param {string} source - The MATH string being parsed.
     * @param {number} position - Character offset of the problem.
     */
    constructor(message, source, position) {
      super(`${message} at position ${position} of "${source}"`);
      this.name = 'MathParseError';
      this.source = source;
      this.position = position;
    }
  }

  /**
   * Parse a MATH string into an expression tree.
   * @param {string} src - The equation, e.g. "0.75*X-48".
   * @returns {MathNode}
   * @throws {MathParseError} On any token outside the grammar.
   */
  function parseMath(src) {
    let pos = 0;
    const skipWs = () => {
      while (pos < src.length && /\s/.test(src[pos])) pos++;
    };

    function parseNumber() {
      const start = pos;
      while (pos < src.length && /[0-9.]/.test(src[pos])) pos++;
      if (pos < src.length && (src[pos] === 'e' || src[pos] === 'E')) {
        pos++;
        if (src[pos] === '+' || src[pos] === '-') pos++;
        while (pos < src.length && /[0-9]/.test(src[pos])) pos++;
      }
      const text = src.slice(start, pos);
      const value = Number(text);
      if (!Number.isFinite(value))
        throw new MathParseError(`Invalid number "${text}"`, src, start);
      return { kind: 'num', value };
    }
    function parseIdent() {
      const start = pos;
      while (pos < src.length && /[A-Za-z0-9_]/.test(src[pos])) pos++;
      return { kind: 'var', name: src.slice(start, pos).toUpperCase() };
    }
    function parseFactor() {
      skipWs();
      const ch = src[pos];
      if (ch === undefined)
        throw new MathParseError('Unexpected end of expression', src, pos);
      if (ch === '-') {
        pos++;
        return { kind: 'neg', arg: parseFactor() };
      }
      if (ch === '+') {
        pos++;
        return parseFactor();
      }
      if (ch === '(') {
        pos++;
        const inner = parseExpr();
        skipWs();
        if (src[pos] !== ')')
          throw new MathParseError("Expected ')'", src, pos);
        pos++;
        return inner;
      }
      if (/[0-9.]/.test(ch)) return parseNumber();
      if (/[A-Za-z_]/.test(ch)) return parseIdent();
      throw new MathParseError(`Unexpected "${ch}"`, src, pos);
    }
    function parseTerm() {
      let left = parseFactor();
      for (;;) {
        skipWs();
        const ch = src[pos];
        if (ch !== '*' && ch !== '/') return left;
        pos++;
        left = { kind: 'binop', op: ch, left, right: parseFactor() };
      }
    }
    function parseExpr() {
      let left = parseTerm();
      for (;;) {
        skipWs();
        const ch = src[pos];
        if (ch !== '+' && ch !== '-') return left;
        pos++;
        left = { kind: 'binop', op: ch, left, right: parseTerm() };
      }
    }
    const expr = parseExpr();
    skipWs();
    if (pos < src.length)
      throw new MathParseError(`Unexpected "${src[pos]}"`, src, pos);
    return expr;
  }

  /**
   * Evaluate an expression tree against a variable binding.
   * @param {MathNode} expr - Tree from parseMath.
   * @param {Object<string, number>} vars - Upper-cased variable name -> value.
   * @returns {number}
   * @throws {Error} On an unbound variable or a malformed node.
   */
  function evalMath(expr, vars) {
    switch (expr.kind) {
      case 'num':
        return expr.value;
      case 'var': {
        const v = vars[expr.name];
        if (typeof v !== 'number')
          throw new Error(`Unbound variable "${expr.name}"`);
        return v;
      }
      case 'neg':
        return -evalMath(expr.arg, vars);
      case 'binop': {
        const l = evalMath(expr.left, vars),
          r = evalMath(expr.right, vars);
        switch (expr.op) {
          case '+':
            return l + r;
          case '-':
            return l - r;
          case '*':
            return l * r;
          case '/':
            return l / r;
        }
      }
    }
    throw new Error('bad expr node');
  }

  // UNPARSEABLE MATH MUST NOT BE SILENT.
  //
  // Every decode path falls back to the raw byte when compileMath throws --
  // which is the right behaviour (better a raw number than nothing), but done
  // quietly it presents raw bytes AS engineering units, and nothing on screen
  // says the conversion did not happen. TunerPro's V5 MATH supports
  // multi-variable <MATH><VAR> forms we do not implement; a definition using
  // one would render plausible-looking, wrong values.
  //
  // So every fallback records itself here. parseXdf attaches the tally to the
  // returned file as `mathFailures`, and the UI can say so.

  /**
   * Equation -> fallback count for the current parse. Cleared by parseXdf and
   * shared with the codec, which records decode-time misses into it.
   * @type {Map<string, number>}
   */
  const mathMisses = new Map();

  /**
   * Record one failed compile of `eq` in the tally.
   * @param {string|null|undefined} eq - The MATH string that would not compile.
   * @returns {void}
   */
  function noteMathMiss(eq) {
    const k = String(eq == null ? '(none)' : eq).slice(0, 120);
    mathMisses.set(k, (mathMisses.get(k) || 0) + 1);
  }

  /**
   * The tally as a sorted list, most frequent first.
   * @returns {{ equation: string, count: number }[]}
   */
  function mathMissReport() {
    return [...mathMisses.entries()]
      .map(([equation, count]) => ({ equation, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Compile a MATH string into a raw -> engineering function.
   * @param {string} src - The equation.
   * @param {string} [varName] - The variable name the equation uses (default "X").
   * @returns {(x: number) => number}
   * @throws {MathParseError} When the equation does not parse.
   */
  function compileMath(src, varName) {
    varName = (varName || 'X').toUpperCase();
    const ast = parseMath(src);
    return (x) => evalMath(ast, { [varName]: x });
  }

  /**
   * Detect the linear form aX + b of an expression tree.
   * @param {MathNode} expr - Tree from parseMath.
   * @param {string} [varName] - The variable (default "X").
   * @returns {{ a: number, b: number }|null} The coefficients, or null when non-linear.
   */
  function linearize(expr, varName) {
    const v = (varName || 'X').toUpperCase();
    switch (expr.kind) {
      case 'num':
        return { a: 0, b: expr.value };
      case 'var':
        return expr.name === v ? { a: 1, b: 0 } : null;
      case 'neg': {
        const inner = linearize(expr.arg, v);
        if (!inner) return null;
        return {
          a: inner.a === 0 ? 0 : -inner.a,
          b: inner.b === 0 ? 0 : -inner.b,
        };
      }
      case 'binop': {
        const l = linearize(expr.left, v),
          r = linearize(expr.right, v);
        if (!l || !r) return null;
        switch (expr.op) {
          case '+':
            return { a: l.a + r.a, b: l.b + r.b };
          case '-':
            return { a: l.a - r.a, b: l.b - r.b };
          case '*':
            if (l.a === 0) return { a: l.b * r.a, b: l.b * r.b };
            if (r.a === 0) return { a: r.b * l.a, b: r.b * l.b };
            return null;
          case '/':
            if (r.a !== 0) return null;
            if (r.b === 0) return null;
            return { a: l.a / r.b, b: l.b / r.b };
        }
      }
    }
    return null;
  }

  /**
   * Build the inverse (engineering -> raw) of a linear MATH string.
   * @param {string} src - The equation.
   * @param {string} [varName] - The variable (default "X").
   * @returns {((y: number) => number)|null} null when not invertible
   *   (non-linear, or a constant with no X dependence).
   * @throws {MathParseError} When the equation does not parse.
   */
  function invertLinear(src, varName) {
    const lin = linearize(parseMath(src), varName);
    if (!lin || lin.a === 0) return null;
    const { a, b } = lin;
    return (y) => (y - b) / a;
  }

  Object.assign(XDF, {
    parseMath,
    evalMath,
    compileMath,
    linearize,
    invertLinear,
    MathParseError,
    // the live tally of MATH the engine could not compile
    mathMisses,
    noteMathMiss,
    mathMissReport,
  });
})(typeof window !== 'undefined' ? window : this);
