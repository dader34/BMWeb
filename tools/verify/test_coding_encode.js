// Guard: coding-encode.js is the EXACT inverse of the coding read decode, so a
// write that stages a value produces bytes an equal read recovers unchanged.
// A coding write is an EEPROM write against a real ECU -- a decode/encode that
// disagree by one bit corrupt the car. Every assertion here was a real hazard:
//
//   - Mod-36 / VIN check chars gate identity writes (SGBD strlen==18, then a
//     re-computed check-char compare). One wrong char = ERROR_NUMBER_ARGUMENT
//     or a bricked VIN slot. Locked to the doc's known vectors.
//   - encode(decode(x)) must equal x for the raw netto image (idempotent
//     re-write), and decode(encode(v)) must equal v for every field shape --
//     hex, ASCII ('a'), decimal ('d'), the '!' XOR-invert and the '-48'
//     ASCII-digit op. A lossy inverse silently writes the wrong byte.
//   - splice must be NON-DESTRUCTIVE: two FSWs sharing one netto byte (a
//     sub-byte mask each) -- editing one must leave the other's bits intact.
//
//   node tools/verify/test_coding_encode.js
'use strict';
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', '..');

// Load the module under test the way the app would -- as a browser global.
// eval into a window shim so we test the shipped file, not a copy.
const window = {};
eval(
  fs.readFileSync(path.join(R, 'app/renderer/core/coding-encode.js'), 'utf8')
);
const CE = window.CodingEncode;

// Load the real datenmap into the same shim to pull live field fixtures.
eval(fs.readFileSync(path.join(R, 'app/renderer/data/datenmap.js'), 'utf8'));
const MAP = window.BMW_DATEN_MAP;

const fails = [];
const ok = (cond, msg) => {
  if (!cond) fails.push(msg);
};

// ============================================================================
// (a) Mod-36 + VIN vectors -- EXACT (docs/zcs-write.md §2, fahrgestell §TL;DR)
// ============================================================================
for (const [prefix, body, want] of [
  ['C1', 'FFFFFFFF', 'P'], // GM
  ['C1', '61630000', '5'], // GM
  ['C2', '0000284803AC1400', 'G'], // SA
  ['C2', 'FFFFFFFFFFFFFFFF', 'E'], // SA
  ['C3', '0000640620', '1'],
]) {
  // VN
  const got = CE.mod36(prefix, body);
  ok(got === want, `mod36(${prefix},${body}) = ${got}, want ${want}`);
}
ok(
  CE.vinCheckChar('WBAAA00000PM10277') === 'L',
  `vinCheckChar(WBAAA00000PM10277) = ${CE.vinCheckChar('WBAAA00000PM10277')}, want L`
);
// the format* helpers append the check char
ok(
  CE.formatGm('FFFFFFFF') === 'FFFFFFFFP',
  `formatGm = ${CE.formatGm('FFFFFFFF')}`
);
ok(
  CE.formatSa('0000284803AC1400') === '0000284803AC1400G',
  `formatSa = ${CE.formatSa('0000284803AC1400')}`
);
ok(
  CE.formatVn('0000640620') === '00006406201',
  `formatVn = ${CE.formatVn('0000640620')}`
);
ok(
  CE.formatFahrgestellNr('WBAAA00000PM10277') === 'WBAAA00000PM10277L',
  `formatFahrgestellNr = ${CE.formatFahrgestellNr('WBAAA00000PM10277')}`
);

// ============================================================================
// (b) Round-trip decode/encode over REAL datenmap fields
// ============================================================================
// Walk the map, collecting one fixture of every shape we can prove: hex
// (omitted unit), 'a' ASCII, 'd' decimal, the '!' op, and the '-48' op.
function* walkFields() {
  for (const mod of Object.keys(MAP)) {
    const ch = MAP[mod].chassis || {};
    for (const chas of Object.keys(ch))
      for (const ci of Object.keys(ch[chas]))
        for (const f of ch[chas][ci]) yield [{ mod, chas, ci }, f];
  }
}

// Round-trip both directions on a rule. The two invariants a codec must hold:
//
//   encode(decode(image)) == image   over the bytes the field OWNS -- an
//     idempotent re-write of what the ECU already holds must not flip a bit.
//   decode(encode(v)) == v           for every v the field can actually
//     DECODE TO -- probes are derived by decoding real byte patterns, because
//     ops like '!' (XOR 0xFFFFFFFF) map a byte into a 32-bit value that plain
//     integers 0/1 never hit; feeding those would test an impossible input.
function roundTrip(rule) {
  const width = rule.byte || 1;
  const at = rule.word || 0;
  const bufLen = at + width + 2; // + a neighbour byte to prove non-destruction
  const m0 = rule.mask === undefined ? 0xff : rule.mask & 0xff;

  // (1) encode(decode(image)) == image over the owned footprint, for a spread
  // of arbitrary starting bytes, AND collect the decoded values as legal probes.
  const probes = new Set();
  for (const seed of [0x00, 0xff, 0x5a, 0xa5, 0x01, 0x80]) {
    const img = new Uint8Array(bufLen).fill(seed);
    // also vary the field's own bytes so the probe set spans its range
    for (let i = 0; i < width; i++) img[at + i] = (seed ^ (i * 0x33)) & 0xff;
    const val = CE.decodeField(rule, img);
    probes.add(val);
    const out = new Uint8Array(img);
    CE.encodeField(rule, val, out);
    for (let i = 0; i < width; i++) {
      const mask = i === 0 ? m0 : 0xff;
      if ((out[at + i] & mask) !== (img[at + i] & mask))
        return `encode(decode) changed owned byte ${i} of ${rule.name} seed=0x${seed.toString(16)} (${JSON.stringify(rule.ops)}/${rule.unit})`;
    }
    // neighbour bytes outside the field must never move
    for (const j of [at + width, at + width + 1]) {
      if (out[j] !== img[j])
        return `encode(decode) touched neighbour byte ${j} of ${rule.name}`;
    }
  }

  // (2) decode(encode(v)) == v for every legal (decodable) v. Buffer fields
  // decode to a hex string; integer fields to a number.
  for (const v of probes) {
    const buf = new Uint8Array(bufLen).fill(0);
    CE.encodeField(rule, v, buf);
    const back = CE.decodeField(rule, buf);
    const want = typeof v === 'string' ? v : v >>> 0;
    if (back !== want)
      return `decode(encode(${v})) = ${back} for ${rule.name} (${JSON.stringify(rule.ops)}/${rule.unit})`;
  }
  return null;
}

// pick one live fixture per shape
const shapes = {
  hex: null,
  a: null,
  d: null,
  opInvert: null,
  opMinus: null,
  multi: null,
};
for (const [, f] of walkFields()) {
  const u = f.unit || 'h';
  const opc = (f.ops || []).map((o) => o[0]).join('');
  if (!shapes.hex && u === 'h' && !opc && (f.byte || 1) === 1) shapes.hex = f;
  if (!shapes.a && u === 'a' && !opc) shapes.a = f;
  if (!shapes.d && u === 'd' && !opc) shapes.d = f;
  if (!shapes.opInvert && opc === '!') shapes.opInvert = f;
  if (!shapes.opMinus && (f.ops || []).some((o) => o[0] === '-' && o[1] === 48))
    shapes.opMinus = f;
  if (!shapes.multi && (f.byte || 1) > 1) shapes.multi = f;
}

let covered = 0;
for (const [name, f] of Object.entries(shapes)) {
  ok(f, `no datenmap fixture found for shape "${name}"`);
  if (f) {
    const err = roundTrip(f);
    ok(!err, `round-trip [${name}] ${f.name}: ${err}`);
    if (!err) covered++;
  }
}
// the two op shapes and the ASCII/decimal units are the load-bearing ones
ok(
  shapes.opInvert && shapes.opInvert.ops[0][0] === '!',
  'no "!" XOR-invert op field found in datenmap'
);
ok(
  shapes.opMinus && shapes.opMinus.ops.some((o) => o[0] === '-' && o[1] === 48),
  'no "-48" ASCII-digit op field found in datenmap'
);

// bulk sweep: EVERY field with an op or a non-hex unit must round-trip, and a
// broad sample of plain hex fields too (39k total is too slow to fully sweep).
let swept = 0,
  sweepFail = 0;
let idx = 0;
for (const [, f] of walkFields()) {
  const special = (f.ops && f.ops.length) || (f.unit && f.unit !== 'h');
  if (special || idx++ % 400 === 0) {
    const err = roundTrip(f);
    if (err) {
      sweepFail++;
      if (sweepFail <= 5) fails.push(`sweep: ${err}`);
    }
    swept++;
  }
}
ok(sweepFail === 0, `${sweepFail} of ${swept} swept fields failed round-trip`);

// ============================================================================
// (c) splice is non-destructive across a SHARED byte
// ============================================================================
// Two FSWs on the same netto byte, disjoint sub-byte masks -- the classic
// coding-flow.md §5 case (KEYCARDREADER / SWA share netto[4]).
{
  const kcr = {
    name: 'KCR',
    word: 4,
    byte: 1,
    mask: 0x40,
    shift: 6,
    values: [],
  }; // bit 6
  const swa = {
    name: 'SWA',
    word: 4,
    byte: 1,
    mask: 0x20,
    shift: 5,
    values: [],
  }; // bit 5
  const low = {
    name: 'LOW',
    word: 4,
    byte: 1,
    mask: 0x0f,
    shift: 0,
    values: [],
  }; // nibble

  const img = new Uint8Array(8).fill(0);
  img[4] = 0x0a; // 0000 1010 -- low nibble holds 0x0A

  // stage KCR=1 via spliceEdits; SWA and the low nibble must be untouched
  const out = CE.spliceEdits(img, [{ rule: kcr, value: 1 }]);
  ok(
    out !== img && out[4] !== undefined,
    'spliceEdits should return a new buffer'
  );
  ok(img[4] === 0x0a, 'spliceEdits mutated the source image (must copy)');
  ok(
    out[4] === 0x4a,
    `KCR splice: netto[4] = 0x${out[4].toString(16)}, want 0x4a`
  );
  ok(
    CE.decodeField(low, out) === 0x0a,
    'the shared low nibble changed under a KCR edit'
  );
  ok(
    CE.decodeField(swa, out) === 0,
    'the neighbouring SWA bit changed under a KCR edit'
  );

  // now stage SWA=1 too; KCR must survive
  const out2 = CE.spliceEdits(img, [
    { rule: kcr, value: 1 },
    { rule: swa, value: 1 },
  ]);
  ok(
    out2[4] === 0x6a,
    `KCR+SWA splice: netto[4] = 0x${out2[4].toString(16)}, want 0x6a`
  );
  ok(
    CE.decodeField(kcr, out2) === 1 && CE.decodeField(swa, out2) === 1,
    'both KCR and SWA should read back set after a combined splice'
  );
  ok(
    CE.decodeField(low, out2) === 0x0a,
    'the low nibble changed under the combined edit'
  );
  // a neighbouring byte is never touched
  ok(
    out2[5] === 0x00 && out2[3] === 0x00,
    'splice touched a byte outside the field'
  );
}

// ============================================================================
// (d) synthetic coverage for the unit chars datenmap does not carry ('A','b')
// ============================================================================
// No 'A' or 'b' field ships today, but the encoder implements them per
// daten-format.md §1.8 -- prove the inverse holds so the read side can add
// them without a silent codec bug.
{
  const aRule = {
    name: 'A2',
    word: 0,
    byte: 2,
    mask: 0xff,
    shift: 0,
    unit: 'A',
    values: [],
  };
  for (const v of [0, 1, 35, 36, 100, 1295]) {
    // 1295 = max for 2 base-36 digits
    const buf = new Uint8Array(4);
    CE.encodeField(aRule, v, buf);
    ok(CE.decodeField(aRule, buf) === v, `unit 'A' round-trip failed for ${v}`);
  }
  // a 'b' bitstring stores one BIT per byte, so a width-4 field holds 4 bits.
  const bRule = {
    name: 'B4',
    word: 0,
    byte: 4,
    mask: 0xff,
    shift: 0,
    unit: 'b',
    values: [],
  };
  for (const v of [0, 1, 0xa, 0xf]) {
    // 0..15 = the 4-bit range
    const buf = new Uint8Array(6);
    CE.encodeField(bRule, v, buf);
    ok(CE.decodeField(bRule, buf) === v, `unit 'b' round-trip failed for ${v}`);
  }
  // buildZcsRegion lays out the fixed 20 bytes with correct check chars
  const netto = new Uint8Array(40);
  CE.buildZcsRegion('61630000', '0000284803AC1400', '0000640620', 10, netto);
  ok(
    netto[10] === 0x61 &&
      netto[11] === 0x63 &&
      netto[12] === 0x00 &&
      netto[13] === 0x00,
    'ZCS GM body nibble-pack wrong'
  );
  ok(
    netto[14] === '5'.charCodeAt(0),
    `ZCS GM check char = ${String.fromCharCode(netto[14])}, want 5`
  );
  ok(
    netto[23] === 'G'.charCodeAt(0),
    `ZCS SA check char = ${String.fromCharCode(netto[23])}, want G`
  );
  ok(
    netto[29] === '1'.charCodeAt(0),
    `ZCS VN check char = ${String.fromCharCode(netto[29])}, want 1`
  );
  ok(
    netto[9] === 0 && netto[30] === 0,
    'buildZcsRegion wrote outside its 20-byte window'
  );
}

// ============================================================================
// report -- FAIL LOUDLY, no silent skips
// ============================================================================
if (fails.length) {
  console.error(`coding-encode: ${fails.length} FAILED`);
  for (const f of fails) console.error('  x ' + f);
  process.exit(1);
}
console.log(
  `coding-encode OK: 6 mod36/vin vectors, ${covered}/6 field shapes, ${swept} fields swept, splice non-destructive, ZCS layout`
);
