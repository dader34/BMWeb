// coding-auftrag: BMW's AUFTRAGSAUSDRUCK byte-coded predicate -- the test that
// decides whether a row applies to THIS car.
//
// An SGET row carries a boolean expression over the car's equipment codes. The
// enumerator evaluates it against the ASW (Auswahl-Steuerwort) bit-vector
// derived from the car's FA/ZCS, and keeps only rows that pass. Without it we
// show every module and every variant the chassis could ever have, instead of
// the ones this car actually has.
//
// BYTE FORMAT (verified against vendor/EC-APPS/NCSEXPER/DATEN/E39/E46SGET.000
// at 0x1df, whose 22-byte expression reads "(S99,S92+S3,S287)+!S420"):
//
//   0x53 'S' + u16 LE   an equipment-code reference; true iff that bit is set
//   0x2b '+'            AND
//   0x2c ','            OR
//   0x21 '!'            NOT (prefix)
//   0x28 '(' 0x29 ')'   grouping
//   0x5c '\'            continuation: the expression resumes in the next chunk
//
// GRAMMAR. Precedence, tightest first: NOT, then AND ('+'), then OR (','). So
// "(S99,S92+S3,S287)+!S420" is ((99 OR 92) AND (3 OR 287)) AND NOT 420 -- note
// '+' binds TIGHTER than ',', which is the reverse of the C-like reading and
// the easiest thing to get backwards here.
//
//   expr    ::= and ( ',' and )*        -- OR, loosest
//   and     ::= unary ( '+' unary )*    -- AND
//   unary   ::= '!' unary | atom
//   atom    ::= S<id> | '(' expr ')'
//
// NOT applies to a bare S token as well as to a group: the same record ends
// "+!S420", so a '!'-before-atom form is real and not an edge case.
//
// UNKNOWN CODES ARE FALSE, NOT AN ERROR. A car's ASW simply lacks bits it does
// not have; that is the normal case, not a parse failure. A MALFORMED
// expression is different -- that means we misread the container, and the
// caller must be able to tell those apart, so parse errors throw.

(function (root) {
  'use strict';

  const T_REF = 0x53; // 'S'
  const T_AND = 0x2b; // '+'
  const T_OR = 0x2c; // ','
  const T_NOT = 0x21; // '!'
  const T_LP = 0x28; // '('
  const T_RP = 0x29; // ')'
  const T_CONT = 0x5c; // '\'

  // ---- lexer ---------------------------------------------------------------

  // bytes -> token list. Each token is {t:'ref',id} or {t:'+'|','|'!'|'('|')'}.
  // A continuation marker is dropped: chunk joining is the caller's job (it
  // holds the rows), and by the time we lex, the bytes are already one buffer.
  function lex(bytes) {
    const b = Array.from(bytes, (x) => x & 0xff);
    const out = [];
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c === T_REF) {
        if (i + 2 >= b.length) {
          throw new Error('AUFTRAGSAUSDRUCK: truncated S token at ' + i);
        }
        out.push({ t: 'ref', id: b[i + 1] | (b[i + 2] << 8) }); // u16 LE
        i += 2;
        continue;
      }
      if (c === T_AND) {
        out.push({ t: '+' });
        continue;
      }
      if (c === T_OR) {
        out.push({ t: ',' });
        continue;
      }
      if (c === T_NOT) {
        out.push({ t: '!' });
        continue;
      }
      if (c === T_LP) {
        out.push({ t: '(' });
        continue;
      }
      if (c === T_RP) {
        out.push({ t: ')' });
        continue;
      }
      if (c === T_CONT) continue; // chunk seam, not an operand
      if (c === 0x00) continue; // trailing NUL padding
      throw new Error(
        'AUFTRAGSAUSDRUCK: unexpected byte 0x' + c.toString(16) + ' at ' + i
      );
    }
    return out;
  }

  // ---- parser (recursive descent, precedence as documented above) ----------

  function parse(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const eat = (t) => {
      if (!tokens[pos] || tokens[pos].t !== t) {
        throw new Error(`AUFTRAGSAUSDRUCK: expected ${t} at token ${pos}`);
      }
      return tokens[pos++];
    };

    function atom() {
      const tk = peek();
      if (!tk)
        throw new Error('AUFTRAGSAUSDRUCK: unexpected end of expression');
      if (tk.t === 'ref') {
        pos++;
        return { op: 'ref', id: tk.id };
      }
      if (tk.t === '(') {
        eat('(');
        const e = expr();
        eat(')');
        return e;
      }
      throw new Error(`AUFTRAGSAUSDRUCK: unexpected token ${tk.t} at ${pos}`);
    }

    function unary() {
      if (peek() && peek().t === '!') {
        pos++;
        return { op: 'not', a: unary() };
      }
      return atom();
    }

    function and() {
      let l = unary();
      while (peek() && peek().t === '+') {
        pos++;
        l = { op: 'and', a: l, b: unary() };
      }
      return l;
    }

    function expr() {
      let l = and();
      while (peek() && peek().t === ',') {
        pos++;
        l = { op: 'or', a: l, b: and() };
      }
      return l;
    }

    const tree = expr();
    if (pos !== tokens.length) {
      throw new Error(`AUFTRAGSAUSDRUCK: trailing tokens at ${pos}`);
    }
    return tree;
  }

  // ---- evaluation ----------------------------------------------------------

  // has(id) -> boolean: does the car carry this equipment code?
  function evalTree(node, has) {
    switch (node.op) {
      case 'ref':
        return !!has(node.id);
      case 'not':
        return !evalTree(node.a, has);
      case 'and':
        return evalTree(node.a, has) && evalTree(node.b, has);
      case 'or':
        return evalTree(node.a, has) || evalTree(node.b, has);
      default:
        throw new Error('AUFTRAGSAUSDRUCK: bad node ' + node.op);
    }
  }

  // Build the has() predicate from whatever the caller holds. Accepts a Set,
  // an array, or a function. Codes are compared as NUMBERS (the S token's u16),
  // and string entries like "902" or "0902" are coerced -- callers get SA codes
  // from several places and should not have to normalise first.
  function hasFrom(codes) {
    if (typeof codes === 'function') return codes;
    const set = new Set();
    for (const c of codes || []) {
      const n = typeof c === 'number' ? c : parseInt(String(c).trim(), 10);
      if (Number.isFinite(n)) set.add(n);
    }
    return (id) => set.has(id);
  }

  // ---- public API ----------------------------------------------------------

  // compile(bytes) -> {tree, refs} -- refs is every code the expression tests,
  // which is what a UI needs to explain WHY a row was filtered out.
  function compile(bytes) {
    const tree = parse(lex(bytes));
    const refs = [];
    (function walk(n) {
      if (!n) return;
      if (n.op === 'ref') {
        if (!refs.includes(n.id)) refs.push(n.id);
        return;
      }
      walk(n.a);
      walk(n.b);
    })(tree);
    return { tree, refs };
  }

  // The headline call: does this car satisfy this row's predicate?
  //   matchesAuftrag(bytes, saCodes) -> boolean
  // An EMPTY/absent expression means "no restriction" -> true, matching the
  // enumerator: a row with no predicate applies to every car.
  function matchesAuftrag(bytes, codes) {
    if (!bytes || !bytes.length) return true;
    const { tree } = compile(bytes);
    return evalTree(tree, hasFrom(codes));
  }

  // Render back to the readable form ("(S99,S92+S3,S287)+!S420") for tooling,
  // diffs and error messages. Parenthesised only where precedence needs it.
  function toText(node) {
    switch (node.op) {
      case 'ref':
        return 'S' + node.id;
      case 'not': {
        const inner = toText(node.a);
        return '!' + (node.a.op === 'ref' ? inner : `(${inner})`);
      }
      case 'and': {
        const w = (n) => (n.op === 'or' ? `(${toText(n)})` : toText(n));
        return `${w(node.a)}+${w(node.b)}`;
      }
      case 'or':
        return `${toText(node.a)},${toText(node.b)}`;
      default:
        return '?';
    }
  }

  const api = {
    lex,
    parse,
    compile,
    evalTree,
    matchesAuftrag,
    toText,
    hasFrom,
  };
  root.CodingAuftrag = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
