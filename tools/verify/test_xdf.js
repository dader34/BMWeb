// Guard: app/renderer/core/xdf.js is the parser + raw<->engineering codec the
// Tuning screen (screens/tuning.js) uses to read and WRITE firmware bytes. A
// wrong scale, endianness or inverse silently corrupts an ECU image the user
// then flashes -- so every load-bearing property is pinned here:
//
//   - the .xdf parser recovers the header defaults, base offset, and each
//     item's kind / address / size / mask / MATH exactly;
//   - decode(raw) applies the MATH scaling (X*0.25, 0.75*X-48, X-100, ...);
//   - a full value round-trip decode(bytes) -> edit -> encode -> bytes holds,
//     and decode(encode(v)) == v, across signed / unsigned / LE / BE widths;
//   - table geometry + per-cell address strides land on the right bytes;
//   - flags read and toggle the correct bit without disturbing neighbours.
//
//   node tools/verify/test_xdf.js
'use strict';
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', '..');

// Load the module under test the way the app would -- as a browser global.
// eval into a window shim so we test the SHIPPED file, not a copy.
const window = {};
eval(fs.readFileSync(path.join(R, 'app/renderer/core/xdf.js'), 'utf8'));
const XDF = window.XDF;

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ============================================================================
// A hand-built .xdf covering every item kind, plus signed / LE / BE / scaled
// forms. Addresses are hex (as TunerPro emits); BASEOFFSET is 0.
// ============================================================================
const XDF_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- a synthetic MS4x-style definition for the codec tests -->
<XDFFORMAT version="1.60">
  <XDFHEADER>
    <flags>0x1</flags>
    <fileversion>1.0</fileversion>
    <deftitle>Test Definition</deftitle>
    <description>synthetic fixture</description>
    <author>verify</author>
    <BASEOFFSET offset="0" subtract="0" />
    <DEFAULTS datasizeinbits="8" sigdigits="2" outputtype="1" signed="0" lsbfirst="1" float="0" />
    <REGION type="0xFFFFFFFF" startaddress="0x0" size="0x80" name="BIN" />
    <CATEGORY index="0x0" name="Limits" />
    <CATEGORY index="0x1" name="Tables" />
  </XDFHEADER>

  <!-- signed 8-bit, scaled: eng = 0.75*X - 48 -->
  <XDFCONSTANT uniqueid="0x1">
    <title>Coolant Trim</title>
    <description>signed byte, linear</description>
    <CATEGORYMEM index="0" category="1" />
    <EMBEDDEDDATA mmedtypeflags="0x01" mmedaddress="0x00" mmedelementsizebits="8" />
    <units>C</units>
    <MATH equation="0.75*X-48"><VAR id="X" /></MATH>
  </XDFCONSTANT>

  <!-- unsigned 16-bit little-endian, scaled: eng = X*0.25 -->
  <XDFCONSTANT uniqueid="0x2">
    <title>Rev Limit</title>
    <description>u16 LE quarter-rpm</description>
    <CATEGORYMEM index="0" category="1" />
    <EMBEDDEDDATA mmedtypeflags="0x02" mmedaddress="0x10" mmedelementsizebits="16" />
    <units>rpm</units>
    <MATH equation="X*0.25"><VAR id="X" /></MATH>
  </XDFCONSTANT>

  <!-- signed 16-bit BIG-endian (typeflags has signed bit, NO lsbfirst bit) -->
  <XDFCONSTANT uniqueid="0x3">
    <title>Timing Offset</title>
    <EMBEDDEDDATA mmedtypeflags="0x01" mmedaddress="0x14" mmedelementsizebits="16" />
    <MATH equation="X"><VAR id="X" /></MATH>
  </XDFCONSTANT>

  <!-- a single-bit flag at byte 0x20, mask 0x04 -->
  <XDFFLAG uniqueid="0x4">
    <title>Enable Feature</title>
    <EMBEDDEDDATA mmedaddress="0x20" mmedelementsizebits="8" />
    <mask>0x04</mask>
  </XDFFLAG>

  <!-- 1D table: 4 unsigned bytes, eng = X*2 -->
  <XDFTABLE uniqueid="0x5">
    <title>Boost Row</title>
    <CATEGORYMEM index="0" category="2" />
    <XDFAXIS id="x">
      <indexcount>4</indexcount>
      <LABEL index="0" value="1000" /><LABEL index="1" value="2000" />
      <LABEL index="2" value="3000" /><LABEL index="3" value="4000" />
      <EMBEDDEDDATA mmedaddress="0x0" mmedelementsizebits="16" />
      <MATH equation="X"><VAR id="X" /></MATH>
    </XDFAXIS>
    <XDFAXIS id="y"><indexcount>1</indexcount><EMBEDDEDDATA mmedaddress="0x0" /><MATH equation="X"/></XDFAXIS>
    <XDFAXIS id="z">
      <EMBEDDEDDATA mmedtypeflags="0x00" mmedaddress="0x30" mmedelementsizebits="8" mmedrowcount="1" mmedcolcount="4" />
      <MATH equation="X*2"><VAR id="X" /></MATH>
    </XDFAXIS>
  </XDFTABLE>

  <!-- 2D table: 2 rows x 3 cols, u16 LE, eng = X-100 -->
  <XDFTABLE uniqueid="0x6">
    <title>Fuel Map</title>
    <CATEGORYMEM index="0" category="2" />
    <XDFAXIS id="x"><indexcount>3</indexcount><EMBEDDEDDATA mmedaddress="0x0" /><MATH equation="X"/></XDFAXIS>
    <XDFAXIS id="y"><indexcount>2</indexcount><EMBEDDEDDATA mmedaddress="0x0" /><MATH equation="X"/></XDFAXIS>
    <XDFAXIS id="z">
      <EMBEDDEDDATA mmedtypeflags="0x02" mmedaddress="0x40" mmedelementsizebits="16" mmedrowcount="2" mmedcolcount="3" />
      <MATH equation="X-100"><VAR id="X" /></MATH>
    </XDFAXIS>
  </XDFTABLE>
</XDFFORMAT>`;

// The firmware image the definition points into.
const BIN = new Uint8Array(128);
BIN[0x00] = 0x80;                                    // Coolant Trim raw = -128 (signed)
BIN[0x10] = 0x00; BIN[0x11] = 0x10;                 // Rev Limit u16 LE = 0x1000 = 4096
BIN[0x14] = 0x80; BIN[0x15] = 0x00;                 // Timing Offset s16 BE = -32768
BIN[0x20] = 0x04;                                    // Enable Feature flag bit set
BIN[0x30] = 1; BIN[0x31] = 2; BIN[0x32] = 3; BIN[0x33] = 4;  // Boost Row
// Fuel Map: u16 LE raw 100..105 (row-major, contiguous)
[100, 101, 102, 103, 104, 105].forEach((v, i) => { BIN[0x40 + i * 2] = v & 0xff; BIN[0x41 + i * 2] = (v >> 8) & 0xff; });

// ============================================================================
// (a) parse structure
// ============================================================================
const def = XDF.parseXdf(XDF_XML);
ok(def.header.deftitle === 'Test Definition', `deftitle = ${def.header.deftitle}`);
ok(def.header.author === 'verify', `author = ${def.header.author}`);
ok(def.header.baseOffset.offset === 0 && def.header.baseOffset.subtract === false, 'baseOffset');
ok(def.header.defaults.datasizeinbits === 8, `defaults.datasizeinbits = ${def.header.defaults.datasizeinbits}`);
ok(def.header.defaults.lsbfirst === true, 'defaults.lsbfirst should be true');
ok(def.header.defaults.signed === false, 'defaults.signed should be false');
ok(def.header.categories.length === 2 && def.header.categories[1].name === 'Tables', 'categories');
ok(def.header.regions.length === 1 && def.header.regions[0].size === 0x80, 'region size');

const byTitle = {};
for (const it of def.items) byTitle[it.title] = it;
ok(def.items.length === 6, `item count = ${def.items.length}, want 6`);
ok(byTitle['Coolant Trim'].kind === 'constant', 'Coolant Trim kind');
ok(byTitle['Enable Feature'].kind === 'flag', 'Enable Feature kind');
ok(byTitle['Boost Row'].kind === 'table', 'Boost Row kind');

// constant fields parsed correctly
const trim = byTitle['Coolant Trim'];
ok(trim.embed.address === 0x00 && trim.embed.elementsizebits === 8, 'trim embed');
ok(trim.embed.typeflags === 0x01, `trim typeflags = ${trim.embed.typeflags}`);
ok(trim.mathEquation === '0.75*X-48', `trim math = ${trim.mathEquation}`);
ok(trim.units === 'C', `trim units = ${trim.units}`);
ok(trim.categoryIndices.length === 1 && trim.categoryIndices[0] === 0, 'trim category (1-based -> 0)');

const rev = byTitle['Rev Limit'];
ok(rev.embed.address === 0x10 && rev.embed.elementsizebits === 16, 'rev embed');
ok(rev.embed.typeflags === 0x02, 'rev typeflags lsbfirst');
ok(rev.mathEquation === 'X*0.25', `rev math = ${rev.mathEquation}`);

const flag = byTitle['Enable Feature'];
ok(flag.mask === 0x04, `flag mask = ${flag.mask}`);
ok(flag.embed.address === 0x20, 'flag address');

// ============================================================================
// (b) resolveEmbedded flag decoding (signed / LE / float / defaults fallback)
// ============================================================================
const B = def.header.baseOffset, D = def.header.defaults;
const trimSpec = XDF.resolveEmbedded(trim.embed, B, D);
ok(trimSpec.signed === true && trimSpec.lsbfirst === false && trimSpec.float === false, 'trim spec signed BE');
const revSpec = XDF.resolveEmbedded(rev.embed, B, D);
ok(revSpec.signed === false && revSpec.lsbfirst === true, 'rev spec unsigned LE');
// typeflags==0 -> DEFAULTS win (lsbfirst true, unsigned)
const flagSpec = XDF.resolveEmbedded(flag.embed, B, D);
ok(flagSpec.lsbfirst === true && flagSpec.signed === false, 'flag spec falls back to DEFAULTS');

// ============================================================================
// (c) decode applies MATH scaling (exact hand-computed values)
// ============================================================================
// Coolant Trim: raw 0x80 signed = -128 -> 0.75*-128 - 48 = -144
ok(near(XDF.decodeConstant(trim, BIN, def.header), -144), `Coolant Trim = ${XDF.decodeConstant(trim, BIN, def.header)}, want -144`);
// Rev Limit: raw 4096 LE -> *0.25 = 1024
ok(near(XDF.decodeConstant(rev, BIN, def.header), 1024), `Rev Limit = ${XDF.decodeConstant(rev, BIN, def.header)}, want 1024`);
// Timing Offset: s16 BE bytes 0x80 0x00 -> -32768
ok(near(XDF.decodeConstant(byTitle['Timing Offset'], BIN, def.header), -32768), 'Timing Offset BE signed');

// endianness cross-check: the SAME bytes read as LE would be 0x0080 = 128, not -32768
const beSpec = XDF.resolveEmbedded(byTitle['Timing Offset'].embed, B, D);
ok(XDF.readScalar(BIN, beSpec) === -32768, 'readScalar BE = -32768');
const leSpec = Object.assign({}, beSpec, { lsbfirst: true });
ok(XDF.readScalar(BIN, leSpec) === 128, `same bytes LE = ${XDF.readScalar(BIN, leSpec)}, want 128`);

// ============================================================================
// (d) value round-trip: decode -> edit -> encode -> bytes -> decode
// ============================================================================
function roundTripConstant(item, newEng) {
  const enc = XDF.encodeConstant(item, newEng, def.header);
  ok(enc !== null, `encodeConstant returned null for ${item.title} = ${newEng}`);
  if (!enc) return;
  const buf = new Uint8Array(BIN);              // copy; splice the new bytes in
  buf.set(enc.bytes, enc.address);
  const back = XDF.decodeConstant(item, buf, def.header);
  ok(near(back, newEng, 1e-6), `round-trip ${item.title}: set ${newEng}, read ${back}`);
}
// Rev Limit: set 2000 rpm -> raw 8000 = 0x1F40 -> LE [0x40,0x1F]
{
  const enc = XDF.encodeConstant(rev, 2000, def.header);
  ok(enc && enc.bytes[0] === 0x40 && enc.bytes[1] === 0x1f, `Rev Limit 2000 -> bytes ${enc && [...enc.bytes]}`);
  roundTripConstant(rev, 2000);
}
roundTripConstant(trim, -90);          // 0.75*X-48 = -90 -> X = -56 (exact, in range)
roundTripConstant(trim, -144);         // the stock value re-writes identically
roundTripConstant(rev, 0);
roundTripConstant(rev, 16383.75);      // near u16 top: raw 65535

// idempotent re-write: encode(decode(image)) must not move the owned bytes
for (const item of [trim, rev, byTitle['Timing Offset']]) {
  const cur = XDF.decodeConstant(item, BIN, def.header);
  const enc = XDF.encodeConstant(item, cur, def.header);
  ok(enc !== null, `idempotent encode null for ${item.title}`);
  if (enc) {
    for (let i = 0; i < enc.bytes.length; i++) {
      ok(enc.bytes[i] === BIN[enc.address + i],
        `idempotent re-write changed byte ${i} of ${item.title}: ${enc.bytes[i]} vs ${BIN[enc.address + i]}`);
    }
  }
}

// out-of-range and non-invertible are refused (not silently truncated)
ok(XDF.encodeConstant(rev, 1e9, def.header) === null, 'over-range value should refuse to encode');
ok(XDF.invertLinear('X*X') === null, 'non-linear MATH is not invertible');
ok(XDF.invertLinear('48') === null, 'constant MATH (no X) is not invertible');

// ============================================================================
// (e) low-level encodeScalar/readScalar round-trip over widths & signedness
// ============================================================================
function scalarRT(sizeBits, signed, lsbfirst, value) {
  const spec = { sizeBits, signed, lsbfirst, float: false, address: 0 };
  const bytes = XDF.encodeScalar(value, spec);
  ok(bytes !== null, `encodeScalar null for ${value} (${sizeBits}b signed=${signed})`);
  if (!bytes) return;
  const buf = new Uint8Array(bytes.length + 3);
  buf.set(bytes, 0);
  const back = XDF.readScalar(buf, spec);
  ok(back === value, `scalar RT ${sizeBits}b signed=${signed} le=${lsbfirst}: ${value} -> ${back}`);
}
for (const le of [true, false]) {
  scalarRT(8, false, le, 0); scalarRT(8, false, le, 255); scalarRT(8, true, le, -128); scalarRT(8, true, le, 127);
  scalarRT(16, false, le, 0); scalarRT(16, false, le, 65535); scalarRT(16, true, le, -32768); scalarRT(16, true, le, 32767);
  scalarRT(32, false, le, 0); scalarRT(32, false, le, 4294967295); scalarRT(32, true, le, -2147483648); scalarRT(32, true, le, 2147483647);
}
// float32 round-trip (exact for a representable value)
{
  const spec = { sizeBits: 32, signed: true, lsbfirst: true, float: true, address: 0 };
  const bytes = XDF.encodeScalar(1.5, spec);
  const buf = new Uint8Array(4); buf.set(bytes, 0);
  ok(XDF.readScalar(buf, spec) === 1.5, 'float32 round-trip 1.5');
}

// ============================================================================
// (f) flag read / toggle (bit-precise, non-destructive)
// ============================================================================
ok(XDF.readFlag(BIN, 0x20, 0x04) === true, 'flag 0x04 set');
ok(XDF.readFlag(BIN, 0x20, 0x08) === false, 'flag 0x08 clear');
ok(XDF.applyFlag(0x04, 0x08, true) === 0x0c, 'set bit 0x08 alongside 0x04');
ok(XDF.applyFlag(0x0c, 0x04, false) === 0x08, 'clear bit 0x04 leaves 0x08');
ok(XDF.applyFlag(0xff, 0x04, false) === 0xfb, 'clear one bit leaves the rest');

// ============================================================================
// (g) table geometry, cell addresses, decode + per-cell round-trip
// ============================================================================
const boost = XDF.decodeTable(byTitle['Boost Row'], BIN, def.header);
ok(boost.rows === 1 && boost.cols === 4, `Boost Row geometry ${boost.rows}x${boost.cols}, want 1x4`);
ok(JSON.stringify(boost.cells[0]) === JSON.stringify([2, 4, 6, 8]), `Boost Row cells = ${JSON.stringify(boost.cells[0])}, want [2,4,6,8]`);

const fuel = byTitle['Fuel Map'];
const fmap = XDF.decodeTable(fuel, BIN, def.header);
ok(fmap.rows === 2 && fmap.cols === 3, `Fuel Map geometry ${fmap.rows}x${fmap.cols}, want 2x3`);
// raw 100..105, eng = X-100 -> 0..5 row-major
ok(JSON.stringify(fmap.cells) === JSON.stringify([[0, 1, 2], [3, 4, 5]]), `Fuel Map cells = ${JSON.stringify(fmap.cells)}`);
// cell (1,2) address: 16-bit, 3 cols, contiguous -> 0x40 + 10 = 0x4A
ok(XDF.tableCellAddress(fmap.embed, 1, 2) === 0x4a, `cell(1,2) addr = 0x${XDF.tableCellAddress(fmap.embed, 1, 2).toString(16)}, want 0x4a`);
ok(XDF.tableCellAddress(fmap.embed, 0, 0) === 0x40, 'cell(0,0) addr');
// per-cell round-trip: set (1,2) to eng 50 -> raw 150
{
  const enc = XDF.encodeTableCell(fuel, def.header, 1, 2, 50);
  ok(enc && enc.address === 0x4a && enc.raw === 150, `Fuel cell (1,2)=50 -> raw ${enc && enc.raw} @0x${enc && enc.address.toString(16)}`);
  const buf = new Uint8Array(BIN);
  buf.set(enc.bytes, enc.address);
  const re = XDF.decodeTable(fuel, buf, def.header);
  ok(re.cells[1][2] === 50, `Fuel cell (1,2) read back ${re.cells[1][2]}, want 50`);
  // neighbours unchanged
  ok(re.cells[1][1] === 4 && re.cells[0][2] === 2, 'editing one cell disturbed a neighbour');
}

// ============================================================================
// (h) parser robustness: bad root, encrypted file, entity decode
// ============================================================================
let threw = false;
try { XDF.parseXdf('<NOTXDF></NOTXDF>'); } catch (e) { threw = e instanceof XDF.XdfParseError; }
ok(threw, 'non-XDFFORMAT root should throw XdfParseError');
threw = false;
try {
  XDF.parseXdf('<XDFFORMAT><XDFHEADER><openpassword>x</openpassword></XDFHEADER></XDFFORMAT>');
} catch (e) { threw = /encrypted/i.test(e.message); }
ok(threw, 'encrypted .xdf should be refused');
// entity + attribute decode
{
  const d = XDF.parseXdf('<XDFFORMAT><XDFHEADER><deftitle>A &amp; B &lt;x&gt;</deftitle></XDFHEADER></XDFFORMAT>');
  ok(d.header.deftitle === 'A & B <x>', `entity decode = ${d.header.deftitle}`);
}

// ============================================================================
// report -- FAIL LOUDLY
// ============================================================================
if (fails.length) {
  console.error(`xdf: ${fails.length} FAILED`);
  for (const f of fails) console.error('  x ' + f);
  process.exit(1);
}
console.log('xdf OK: parsed 6 items, header/defaults/categories, scaling decode, '
  + 'value round-trips (signed/unsigned/LE/BE/float), flags, 1D+2D tables & cell strides, '
  + 'encrypted/entity guards');
