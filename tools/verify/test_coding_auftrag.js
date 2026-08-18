// AUFTRAGSAUSDRUCK predicate: lexing, precedence, evaluation.
//
// The load-bearing fact this guards is PRECEDENCE: '+' (AND) binds TIGHTER
// than ',' (OR). Getting that backwards still parses, still round-trips, and
// silently filters the wrong modules out of the car -- so the tests below
// pin it with expressions whose two readings actually disagree.
//
// The ground truth is a real BMW file, not a fixture: E46SGET.000 carries a
// 22-byte expression whose text form is "(S99,S92+S3,S287)+!S420".
//
//   node tools/verify/test_coding_auftrag.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const A = require('../../app/renderer/core/coding-auftrag.js');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => { passed++; if (process.env.V) console.log('  ok', what); };

// ---- helpers ---------------------------------------------------------------

// build predicate bytes the way BMW does, so tests read as expressions
function S(id) { return [0x53, id & 0xff, (id >> 8) & 0xff]; }
const AND = 0x2b, OR = 0x2c, NOT = 0x21, LP = 0x28, RP = 0x29;

// ---- 1. lexer --------------------------------------------------------------

{
  const toks = A.lex([...S(902), AND, ...S(903)]);
  assert.deepStrictEqual(toks.map(t => t.t), ['ref', '+', 'ref']);
  assert.strictEqual(toks[0].id, 902);
  assert.strictEqual(toks[2].id, 903);
  ok('lex: S<u16 LE> + S<u16 LE>');
}

{
  // u16 LE really is little-endian: 902 = 0x0386 -> bytes 86 03
  const toks = A.lex([0x53, 0x86, 0x03]);
  assert.strictEqual(toks[0].id, 902);
  ok('lex: u16 is little-endian');
}

{
  // NUL padding and the continuation seam are skipped, not operands
  const toks = A.lex([...S(1), 0x00, 0x5c, AND, ...S(2)]);
  assert.deepStrictEqual(toks.map(t => t.t), ['ref', '+', 'ref']);
  ok('lex: NUL padding and continuation marker dropped');
}

{
  assert.throws(() => A.lex([0x53, 0x01]), /truncated/);
  assert.throws(() => A.lex([0xff]), /unexpected byte/);
  ok('lex: truncated token and junk byte both throw');
}

// ---- 2. PRECEDENCE: '+' (AND) binds tighter than ',' (OR) -----------------
//
// "S1,S2+S3" must read as 1 OR (2 AND 3), NOT as (1 OR 2) AND 3.
// The two readings disagree on {1} alone: correct -> true, swapped -> false.

{
  const bytes = [...S(1), OR, ...S(2), AND, ...S(3)];
  const { tree } = A.compile(bytes);
  assert.strictEqual(tree.op, 'or', 'OR must be the ROOT (loosest binding)');
  assert.strictEqual(A.toText(tree), 'S1,S2+S3');

  assert.strictEqual(A.matchesAuftrag(bytes, [1]), true,
    '{1} satisfies 1 OR (2 AND 3); it would NOT satisfy (1 OR 2) AND 3');
  assert.strictEqual(A.matchesAuftrag(bytes, [2, 3]), true);
  assert.strictEqual(A.matchesAuftrag(bytes, [2]), false,
    '{2} alone must fail: the AND needs 3 too');
  ok("precedence: '+' binds tighter than ',' (the swap-detecting case)");
}

// ---- 3. NOT ---------------------------------------------------------------

{
  // '!' on a BARE ref -- the form the real E46 record ends with ("+!S420")
  const bytes = [...S(5), AND, NOT, ...S(9)];
  assert.strictEqual(A.toText(A.compile(bytes).tree), 'S5+!S9');
  assert.strictEqual(A.matchesAuftrag(bytes, [5]), true);
  assert.strictEqual(A.matchesAuftrag(bytes, [5, 9]), false, 'NOT 9 must veto');
  ok('not: prefixes a bare S token');
}

{
  // '!' on a GROUP
  const bytes = [NOT, LP, ...S(1), OR, ...S(2), RP];
  assert.strictEqual(A.matchesAuftrag(bytes, []), true);
  assert.strictEqual(A.matchesAuftrag(bytes, [1]), false);
  ok('not: prefixes a parenthesised group');
}

// ---- 4. grouping overrides precedence -------------------------------------

{
  const grouped = [LP, ...S(1), OR, ...S(2), RP, AND, ...S(3)];
  assert.strictEqual(A.matchesAuftrag(grouped, [1]), false,
    '(1 OR 2) AND 3 must reject {1}');
  assert.strictEqual(A.matchesAuftrag(grouped, [1, 3]), true);
  ok('parens: override the default precedence');
}

// ---- 5. malformed input throws (a misread container must be loud) ---------

{
  assert.throws(() => A.compile([LP, ...S(1)]), /expected \)/);
  assert.throws(() => A.compile([...S(1), AND]), /unexpected end/);
  assert.throws(() => A.compile([...S(1), ...S(2)]), /trailing tokens/);
  assert.throws(() => A.compile([AND, ...S(1)]), /unexpected token/);
  ok('malformed: unbalanced, dangling and doubled operands all throw');
}

// ---- 6. absent predicate = no restriction ---------------------------------

{
  assert.strictEqual(A.matchesAuftrag([], [1]), true);
  assert.strictEqual(A.matchesAuftrag(null, []), true);
  ok('empty expression applies to every car');
}

// ---- 7. code coercion ------------------------------------------------------

{
  const bytes = [...S(902)];
  assert.strictEqual(A.matchesAuftrag(bytes, [902]), true, 'number');
  assert.strictEqual(A.matchesAuftrag(bytes, ['902']), true, 'string');
  assert.strictEqual(A.matchesAuftrag(bytes, ['0902']), true, 'zero-padded');
  assert.strictEqual(A.matchesAuftrag(bytes, new Set([902])), true, 'Set');
  assert.strictEqual(A.matchesAuftrag(bytes, (id) => id === 902), true, 'fn');
  assert.strictEqual(A.matchesAuftrag(bytes, ['903']), false);
  ok('codes accepted as number / string / padded / Set / predicate fn');
}

// ---- 8. GROUND TRUTH: the real E46SGET.000 record -------------------------

{
  const f = path.join(ROOT, 'vendor/EC-APPS/NCSEXPER/DATEN/E39/E46SGET.000');
  if (!fs.existsSync(f)) {
    console.log('SKIP ground truth: vendor DATEN not present');
  } else {
    const d = fs.readFileSync(f);
    // length byte at 0x1dd, expression bytes follow
    const len = d[0x1dd];
    assert.strictEqual(len, 22, 'expected the known 22-byte record');
    const bytes = d.slice(0x1de, 0x1de + len);

    const { tree, refs } = A.compile(bytes);
    assert.strictEqual(A.toText(tree), '(S99,S92+S3,S287)+!S420',
      'real BMW bytes must round-trip to the known expression');
    assert.deepStrictEqual(refs, [99, 92, 3, 287, 420]);
    ok('ground truth: E46SGET.000 parses to (S99,S92+S3,S287)+!S420');

    // Exhaustive agreement with a hand-built reading of that expression,
    // written out independently of the parser.
    const ref = (s) =>
      (s.has(99) || (s.has(92) && s.has(3)) || s.has(287)) && !s.has(420);
    const ids = [99, 92, 3, 287, 420];
    for (let m = 0; m < (1 << ids.length); m++) {
      const s = new Set(ids.filter((_, i) => m & (1 << i)));
      assert.strictEqual(A.matchesAuftrag(bytes, [...s]), ref(s),
        `disagreement on {${[...s].join(',')}}`);
    }
    ok(`ground truth: all ${1 << ids.length} code combinations agree`);
  }
}

console.log(`AUFTRAGSAUSDRUCK OK (${passed} passed)`);
