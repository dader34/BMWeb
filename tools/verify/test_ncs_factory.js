#!/usr/bin/env node
// The factory coding tool's own rules, as read out of NCSEXPER.exe
// (2026-10-26), against the shipped E46 tables:
//
//   the vehicle order -> AT rows (type key, options, E words, dates, conditions)
//   the coding key    -> ZST rows (GM by value, SA/VN by bits, all-zero = any)
//   the coding file   -> its SGVT row (must hold; adds version keywords)
//   the CVT           -> exactly one rule per group, later entries overwrite
//   undecided functions -> their only value, or refused
//   the netto build   -> unused bits (UNBELEGT) get the description's fill
//
// Run: node tools/verify/test_ncs_factory.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const R = path.join(ROOT, 'app', 'renderer');
for (const f of ['data/tables.js', 'data/cvt.js', 'data/daten/E46.json']) {
  if (!fs.existsSync(path.join(R, f))) {
    console.log(`skip: ${f} not generated`);
    process.exit(0);
  }
}
global.window = global;
require(path.join(R, 'data/tables.js'));
require(path.join(R, 'data/cvt.js'));
require(path.join(R, 'core/coding/auftrag.js'));
require(path.join(R, 'core/vehicle-identity/fa.js'));
const S = require(path.join(R, 'core/coding/select.js'));
const Cvt = require(path.join(R, 'core/coding/cvt.js'));
const W = require(path.join(R, 'core/coding/write.js'));

let passed = 0;
const ok = (cond, m) => {
  assert.ok(cond, m);
  passed++;
  console.log(`  ok    ${m}`);
};
const kw = (order) => (S.atKeywords('E46', order) || { keywords: [] }).keywords;

console.log('\nthe vehicle order through the AT table');
ok(
  S.dateHolds('V0302', '0102') &&
    !S.dateHolds('V0302', '0302') &&
    S.dateHolds('N0302', '0302') &&
    S.dateHolds('N0302', '0703'),
  'V0302 holds before 03/02, N0302 from 03/02 on'
);
ok(
  S.dateHolds('N0302', '0399') && !S.dateHolds('V0302', '0399'),
  'the year compares as two characters, as in the factory: 1999 ("99") is after 2002'
);
ok(
  kw({ codes: ['112', '185'], time: '0102' }).includes('NOTARZT') &&
    !kw({ codes: ['112', '185'], time: '0402' }).includes('NOTARZT') &&
    !kw({ codes: ['112'], time: '0102' }).includes('NOTARZT'),
  'W 112 V0302 =185 NOTARZT: only before 03/02 and only with option 185'
);
ok(
  kw({ codes: ['BL93'], time: '0305' }).includes('S54B32') &&
    kw({ codes: ['BL93'], time: '0305' }).includes('COUP'),
  'a type key row (W BL93) holds for the type key: E46 COUP S54B32 ...'
);
ok(
  kw({ codes: ['ZHZN'], time: '0305' }).includes('EL_ZUHEIZER'),
  'an E word row (E ZHZN) holds: EL_ZUHEIZER'
);
ok(
  kw({ codes: ['5AB'], time: '0305' }).length > 0,
  'a non-numeric option (W 5AB) holds'
);
ok(
  kw({ codes: [], time: '0904' }).includes('PU01') &&
    kw({ codes: [], time: '0904' }).includes('KMBI_CI_08'),
  "the time criterion's Z row gives the revision stamps"
);
{
  const fa = window.VehicleIdentity.parseFa(
    'E46_#0904*BL93%475&LCSW$205$2AA+633L-ZHZN|7531125'
  );
  const codes = S.orderCodes(fa);
  ok(
    codes.join() === 'BL93,205,2AA,633L,ZHZN',
    'the order codes are the type key, options, HO and E words -- not paint, upholstery or build numbers'
  );
  const eq = S.carEquipment('E46', { fa });
  ok(
    eq.source === 'FA' &&
      eq.time === '0904' &&
      eq.keywords.includes('AUTOMATIK') &&
      eq.keywords.includes('EL_ZUHEIZER') &&
      eq.keywords.includes('KMBI_CI_08'),
    'carEquipment reads an order whole: options, E words and the time criterion'
  );
}

console.log('\nthe coding key through the ZST table');
ok(
  S.gmHolds('6C210000', '6C210000') && !S.gmHolds('6C230000', '6C210000'),
  'GM characters 1-4 are a value: a row 6C21 does not hold for a 6C23 car'
);
ok(
  S.gmHolds('6C231100', '00000000') &&
    S.gmHolds('6C231100', '00001100') &&
    !S.gmHolds('6C231200', '00001100'),
  'characters 5-6 are a value too, 0 meaning any'
);
ok(
  S.gmHolds('00000070', '00000070') &&
    S.gmHolds('000000F0', '00000070') &&
    !S.gmHolds('00000030', '00000070'),
  'character 7 is a mask'
);
{
  const t = window.BMW_TABLES.E46;
  const zeros = {
    gm: '00000000',
    sa: '0000000000000000',
    vn: '0000000000',
  };
  const got = S.zstKeywords('E46', zeros);
  ok(
    got.includes('E46'),
    'an all-zero ZST row holds for every car (H E46 ... E46)'
  );
  const ci = t.zst.find((r) => r.names.some((n) => /_CI_/.test(n)));
  const keys = { gm: ci.gm, sa: ci.sa, vn: ci.vn };
  ok(
    S.zstKeywords('E46', keys).some((n) => /_CI_/.test(n)),
    "a row's module revision stamps are the car's keywords"
  );
}

console.log('\nthe coding file through the SGVT');
{
  const row = window.BMW_TABLES.E46.sgvt.find(
    (r) => r.fam === 'KMB' && r.cbd === 'C04'
  );
  ok(!!row && row.asw.length === 2, 'SGVT KMB C04 adds two version keywords');
  const none = S.sgvtRow('E46', 'KMB', 'C99', []);
  ok(
    none.found === false && none.holds,
    'a coding file the SGVT does not list passes'
  );
  const r = S.sgvtRow('E46', 'KMB', 'C04', [0x1a]);
  ok(
    r.found && r.holds === false && r.add.length === 0,
    'a row whose predicate fails refuses the coding file (0x11A0) and adds nothing'
  );
}

console.log('\nthe CVT, strict');
{
  const data = {
    X: {
      groups: [
        {
          kind: 'GRUPPE',
          name: 'g1',
          rules: [
            { expr: 'a', exprHex: '530100', fsw: [], set: [['F1', 'v1']] },
            { expr: 'b', exprHex: '530200', fsw: [], set: [['F1', 'v2']] },
          ],
        },
        {
          kind: 'GRUPPE',
          name: 'g2',
          rules: [
            {
              expr: 'a',
              exprHex: '530100',
              fsw: ['F3'],
              set: [
                ['F2', 'x'],
                ['F2', 'y'],
              ],
            },
          ],
        },
        {
          kind: 'GRUPPE',
          name: 'g3',
          rules: [{ expr: 'c', exprHex: '530300', fsw: [], set: [] }],
        },
      ],
    },
  };
  const tables = { X: { asw: {} } };
  const t = Cvt.targets('X', [1, 2], data, tables);
  ok(
    t.ambiguous.includes('g1') &&
      t.errors.some((e) => /2 rules of group g1/.test(e)),
    'two rules of a group holding is an error (0x119A)'
  );
  ok(
    t.undecided.includes('g3') &&
      t.errors.some((e) => /no rule of group g3/.test(e)),
    'no rule of a group holding is an error (0x116B)'
  );
  ok(t.values.get('F2').psw === 'y', 'a later entry overwrites an earlier one');
  ok(
    t.values.get('F1').psw === 'v2',
    'and a later holding rule an earlier one'
  );
  const fns = [
    {
      name: 'F2',
      values: [
        ['x', '00'],
        ['y', '01'],
      ],
    },
    {
      name: 'F3',
      values: [
        ['a', '00'],
        ['b', '01'],
      ],
    },
    { name: 'F4', values: [['only', '01']] },
    {
      name: 'F5',
      values: [
        ['p', '00'],
        ['q', '01'],
      ],
    },
  ];
  const m = Cvt.man(fns, t);
  ok(
    m.single.includes('F4') && /F4\r\n\tonly/.test(m.text),
    'a function the order does not decide gets its only value'
  );
  ok(
    m.refused.some((r) => r.startsWith('F5')) &&
      m.refused.some((r) => r.startsWith('F3')),
    'one with several values, or named without a value, is refused'
  );
}

console.log('\nthe netto build: unused bits');
{
  const E46 = JSON.parse(
    fs.readFileSync(path.join(R, 'data/daten/E46.json'), 'utf8')
  );
  const cabdOf = (mod, variant) => {
    const m = E46.modules[mod];
    const lay = m.layout.E46[variant];
    return W.flattenBlocked({
      fields: m.chassis.E46[variant],
      groups: lay.groups.map(([name, start, length, block, kind]) => ({
        name,
        start,
        length,
        block,
        kind,
      })),
      own: lay.own.map(([block, start, length, masks]) => ({
        block,
        start,
        length,
        masks,
      })),
      fill: lay.fill.map(([block, start, length, masks, values]) => ({
        block,
        start,
        length,
        masks,
        values,
      })),
      typ: lay.typ,
    });
  };
  const gm5 = W.factoryCoverage(cabdOf('GM5', 'C05+C06'), 512);
  ok(
    gm5.fillMask[2] === 0xe0 && gm5.fillBits[2] === 0x60,
    'GM5 C05 byte 2: unused bits E0 get the fill value 3 (0x60)'
  );
  let full = 0;
  for (let a = 0; a < 30; a++) if (gm5.mask[a] === 0xff) full++;
  ok(
    full === 30,
    'every byte of GM5 block 0 is owned whole (functions + unused bits)'
  );
  const variant = Object.keys(E46.modules.KMB_E46.layout.E46).find((v) =>
    v.includes('C08')
  );
  const kmb = W.factoryCoverage(cabdOf('KMB_E46', variant), 1024);
  ok(
    [368, 377, 387, 86, 87, 122].every((a) => kmb.mask[a] === 0),
    "the cluster C08: the ZCS key, coding date and VIN bytes are not the coding run's"
  );
}

console.log(`\n${passed} passed`);
