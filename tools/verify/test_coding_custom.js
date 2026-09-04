// Custom coding parameters: validation, overlay, and -- the point of the
// whole thing -- that a user-defined row encodes through the REAL codec
// exactly like a BMW-described one.
//
// The dangerous property here is address correctness. A custom row carries a
// mask the user typed; if shift is computed wrong, or the overlay hands the
// codec a shape it does not expect, the write lands on the wrong bits. So the
// last section runs custom fields through coding-encode itself rather than
// asserting on the object.
//
//   node tools/verify/test_coding_custom.js

const assert = require('assert');

// localStorage stand-in -- the module degrades to no-op without one, and we
// want the real persistence path under test.
const _mem = {};
global.localStorage = {
  getItem: (k) => (k in _mem ? _mem[k] : null),
  setItem: (k, v) => {
    _mem[k] = String(v);
  },
  removeItem: (k) => {
    delete _mem[k];
  },
};

const C = require('../../app/renderer/core/coding-custom.js');
const E = require('../../app/renderer/core/coding-encode.js');

let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

const reset = () => {
  for (const k of Object.keys(_mem)) delete _mem[k];
};

// BMW-described rows to collide/overlap against
const BMW = [
  {
    name: 'CAN_11H',
    block: 12288,
    word: 0,
    byte: 1,
    mask: 0x01,
    shift: 0,
    values: [
      ['nicht_aktiv', '00'],
      ['aktiv', '01'],
    ],
  },
  {
    name: 'ALC_KLS_DISABLE',
    block: 12288,
    word: 0,
    byte: 1,
    mask: 0x02,
    shift: 1,
    values: [
      ['nicht_aktiv', '00'],
      ['aktiv', '01'],
    ],
  },
];

// ---- 1. validation ---------------------------------------------------------

{
  reset();
  const bad = [
    [{ name: '', word: 0 }, /name is required/],
    [{ name: '9LIVES', word: 0 }, /must start with a letter/],
    [{ name: 'OK', word: -1 }, /byte offset/],
    [{ name: 'OK', word: 0, byte: 0 }, /width/],
    [{ name: 'OK', word: 0, mask: 0 }, /selects no bits/],
    [{ name: 'OK', word: 0, mask: 0x1ff }, /mask must be a byte/],
    [{ name: 'OK', word: 0, byte: 2, mask: 0x0f }, /wider than one byte/],
    [{ name: 'OK', word: 0, values: [['a', 'zz']] }, /must be hex/],
    [
      {
        name: 'OK',
        word: 0,
        values: [
          ['a', '01'],
          ['A', '02'],
        ],
      },
      /share a label/,
    ],
    [{ name: 'CAN_11H', word: 0 }, /already exists/],
  ];
  for (const [row, re] of bad) {
    const err = C.validate(row, BMW);
    assert.ok(
      err && re.test(err),
      `expected ${re} for ${JSON.stringify(row)}, got ${err}`
    );
  }
  assert.strictEqual(
    C.validate(
      {
        name: 'MY_PARAM',
        word: 5,
        byte: 1,
        mask: 0x04,
        values: [
          ['off', '00'],
          ['on', '01'],
        ],
      },
      BMW
    ),
    null
  );
  ok('validate: 10 bad shapes rejected, a good one accepted');
}

// ---- 2. overlap detection --------------------------------------------------

{
  // same byte, overlapping bits -> reported
  assert.deepStrictEqual(C.overlaps({ word: 0, mask: 0x03 }, BMW), [
    'CAN_11H',
    'ALC_KLS_DISABLE',
  ]);
  // same byte, disjoint bits -> clean
  assert.deepStrictEqual(C.overlaps({ word: 0, mask: 0x04 }, BMW), []);
  // different byte -> clean even with the same mask
  assert.deepStrictEqual(C.overlaps({ word: 1, mask: 0x01 }, BMW), []);
  ok('overlaps: reports bit collisions, ignores other bytes');
}

// ---- 3. add / list / remove, scoped per variant ---------------------------

{
  reset();
  const r = C.addCustom(
    'alc_ds2',
    'E46',
    'C04',
    {
      name: 'WELCOME_DELAY',
      block: 12288,
      word: 5,
      byte: 1,
      mask: 0x0c,
      values: [
        ['short', '01'],
        ['long', '02'],
      ],
    },
    BMW
  );
  assert.strictEqual(r.ok, true, r.err);
  assert.strictEqual(r.field.custom, true);
  assert.strictEqual(r.field.id, 0xf000, 'first synthetic id is 0xF000');
  assert.strictEqual(r.field.shift, 2, 'mask 0x0C has 2 trailing zeros');

  assert.strictEqual(C.list('alc_ds2', 'E46', 'C04').length, 1);
  // a DIFFERENT variant must not see it -- same byte, different meaning
  assert.strictEqual(C.list('alc_ds2', 'E46', 'C05').length, 0);
  assert.strictEqual(C.list('alc_ds2', 'E39', 'C04').length, 0);
  assert.strictEqual(C.list('gm5', 'E46', 'C04').length, 0);
  ok('add/list: stored, and scoped to (sgbd, chassis, variant)');

  const second = C.addCustom(
    'alc_ds2',
    'E46',
    'C04',
    { name: 'OTHER', word: 6, mask: 0xff, values: [] },
    BMW
  );
  assert.strictEqual(second.field.id, 0xf001, 'ids increment');

  assert.strictEqual(C.removeCustom('alc_ds2', 'E46', 'C04', 0xf000), true);
  assert.strictEqual(C.list('alc_ds2', 'E46', 'C04').length, 1);
  assert.strictEqual(
    C.removeCustom('alc_ds2', 'E46', 'C04', 0x1234),
    false,
    'removing an unknown id reports false'
  );
  ok('remove: deletes by id, reports unknown ids');
}

// ---- 4. the overlay never mutates vendor data ------------------------------

{
  reset();
  C.addCustom(
    'alc_ds2',
    'E46',
    'C04',
    { name: 'EXTRA', block: 12288, word: 9, mask: 0xff, values: [] },
    BMW
  );

  const before = JSON.stringify(BMW);
  const merged = C.mergeCustom(BMW, 'alc_ds2', 'E46', 'C04');

  assert.strictEqual(
    JSON.stringify(BMW),
    before,
    "BMW_DATEN_MAP's array must be untouched"
  );
  assert.notStrictEqual(merged, BMW, 'merge returns a NEW array');
  assert.strictEqual(merged.length, BMW.length + 1);
  assert.ok(merged.some((f) => f.name === 'EXTRA' && f.custom));
  // custom row lands inside its block, not appended blindly at the end
  const idx = merged.findIndex((f) => f.name === 'EXTRA');
  assert.strictEqual(
    Number(merged[idx - 1].block),
    12288,
    'sorted into its block so it renders under the right group header'
  );
  ok('mergeCustom: pure -- new array, vendor data unchanged');

  // no overlay -> the SAME array back (no needless copying on every redraw)
  assert.strictEqual(C.mergeCustom(BMW, 'nothing', 'E46', 'C04'), BMW);
  ok('mergeCustom: returns the input untouched when there is no overlay');
}

// ---- 5. THE POINT: a custom field encodes like a real one -----------------

{
  reset();
  // a 2-bit field in the high nibble of byte 5
  const add = C.addCustom(
    'alc_ds2',
    'E46',
    'C04',
    {
      name: 'DELAY',
      block: 12288,
      word: 5,
      byte: 1,
      mask: 0x30,
      values: [
        ['a', '01'],
        ['b', '02'],
      ],
    },
    BMW
  );
  const f = add.field;
  assert.strictEqual(f.shift, 4);

  // splice onto a netto that already has neighbours in the same byte
  const netto = new Uint8Array(8);
  netto[5] = 0x8f; // bits outside 0x30 must survive
  const out = E.spliceEdits(netto, [{ rule: f, value: 2 }]);

  assert.strictEqual(out[5] & 0x30, 0x20, 'value 2 lands in the masked bits');
  assert.strictEqual(
    out[5] & ~0x30 & 0xff,
    0x8f & ~0x30 & 0xff,
    'neighbouring bits in the same byte are preserved'
  );
  assert.strictEqual(E.decodeField(f, out), 2, 'decode is the inverse');
  ok('custom field splices and round-trips through the real codec');

  // and a full-byte custom field
  const wide = C.addCustom(
    'alc_ds2',
    'E46',
    'C04',
    { name: 'WHOLE', block: 12288, word: 6, byte: 1, mask: 0xff, values: [] },
    BMW
  ).field;
  const out2 = E.spliceEdits(new Uint8Array(8), [{ rule: wide, value: 0xab }]);
  assert.strictEqual(out2[6], 0xab);
  assert.strictEqual(E.decodeField(wide, out2), 0xab);
  ok('full-byte custom field round-trips');
}

// ---- 6. export / import ----------------------------------------------------

{
  reset();
  C.addCustom(
    'gm5',
    'E46',
    'C06',
    { name: 'SHARED', word: 3, mask: 0x08, values: [] },
    []
  );
  const dump = C.exportAll();
  assert.ok(Object.keys(dump).some((k) => k.startsWith('gm5|E46|C06')));

  reset();
  assert.strictEqual(C.list('gm5', 'E46', 'C06').length, 0);
  C.importAll(dump);
  assert.strictEqual(
    C.list('gm5', 'E46', 'C06').length,
    1,
    'imported rows come back'
  );
  ok('export/import round-trips the overlay');
}

// ---- 7. degrades without storage ------------------------------------------

{
  const saved = global.localStorage;
  delete global.localStorage;
  assert.deepStrictEqual(
    C.list('x', 'E46', 'C01'),
    [],
    'no storage -> empty list, not a throw'
  );
  const r = C.addCustom(
    'x',
    'E46',
    'C01',
    { name: 'N', word: 0, mask: 1, values: [] },
    []
  );
  assert.strictEqual(r.ok, false);
  assert.ok(/storage/.test(r.err), 'says why it could not save');
  global.localStorage = saved;
  ok('no localStorage: reports failure instead of throwing');
}

console.log(`coding-custom OK (${passed} passed)`);
