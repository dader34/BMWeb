#!/usr/bin/env node
// The GS20 beyond its calibration (app/renderer/core/gs20-program.js): the
// program checksum, the AIF record, the no-upshift patch, BMW's .0DA / .0PA
// decoder, the program writer's erase/write/commit sequence and the subcode-8
// full reader, exercised offline against a simulated module at the frame
// level.
//
// WHAT THIS PROVES
//   1. The AIF record is bit-exact: it reproduces the factory entry a real
//      7544721 transmission holds at 0x08F000, and what BMW's own
//      AIF_SCHREIBEN emitted for a known argument set.
//   2. The program checksum is CRC-16/ARC over the two descriptor-table
//      ranges: the shipped read-patch image verifies, a flip inside a range is
//      caught, a flip in the gap is not.
//   3. The no-upshift patch recognises the layout, applies it, and refuses
//      anything else.
//   4. The .0DA decoder handles the type-04/02 bases and BMW's type-0x10
//      records, and refuses a bad checksum, an unknown type or a hole.
//   5. The program writer erases exactly the four sectors (each must answer
//      sub-status 1), writes blank-skipping chunks that never straddle a
//      sector, commits on sub-status 1, and a refused erase leaves nothing
//      erased. The full reader probes before it reads and names stock
//      firmware's B0.
//   6. writeAifRecord finds the first free slot after the base the info block
//      names, checks the slot's flash status, and writes 46 bytes there.
//
// Run: node tools/verify/test_gs20_program.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.bmwSleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1)));
global.busTrace = {
  hex: (b) => (b ? Array.from(b, (x) => (x & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(' ') : ''),
};
global.webBus = { connected: true };
global.withBusLock = (fn) => fn();
global.webBusRawExchange = () => {
  throw new Error('not wired');
};
const W = require('../../app/renderer/core/webshim/ds2-wire.js');
Object.assign(global, W);
const G = require('../../app/renderer/core/gs20.js');
Object.assign(global, G);
const P = require('../../app/renderer/core/gs20-program.js');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const xor = (bytes) => bytes.reduce((a, b) => a ^ b, 0);

(async () => {
// ── 1. the AIF record ────────────────────────────────────────────────────────
console.log('\nAIF record');
const FACTORY = [
  0x20, 0x2c, 0xa3, 0x9f, 0x0c, 0x31, 0x01, 0x15, 0x48, 0x02, 0x00, 0x10, 0xc1, 0x00, 0x95, 0x04, 0x00, 0x73, 0x19, 0x0b, 0x03, 0x4a, 0x00,
  0x0f, 0x42, 0x40, 0x00, 0x73, 0x19, 0x0a, 0x00, 0x34, 0x32, 0x33, 0x32, 0x34, 0x00, 0x30, 0x21, 0x00, 0x00, 0x00, 0x00, 0x89, 0xc0, 0x00,
];
assert.deepStrictEqual(
  Array.from(P.gs20Aif.build('WBAEV33415KW20131', new Date(2004, 9, 18), 7543051, 'DA', 1000000, 7543050, '42324', 12321, 0, [0, 0x89, 0xc0])),
  FACTORY
);
ok('reproduces the factory entry a real transmission holds');
const CAPTURED = [
  0x20, 0x2c, 0xa3, 0x9f, 0x0c, 0x31, 0x00, 0x15, 0x48, 0x01, 0x08, 0x31, 0x05, 0x00, 0xf4, 0x9a, 0x00, 0x73, 0x3e, 0xbc, 0x03, 0x30, 0x00,
  0x5b, 0xcd, 0x15, 0x00, 0x73, 0x3e, 0xbc, 0x00, 0x31, 0x32, 0x33, 0x34, 0x35, 0x00, 0x30, 0x39, 0x00, 0xcd, 0x00, 0x00, 0x00, 0x01, 0x00,
];
assert.deepStrictEqual(
  Array.from(P.gs20Aif.build('WBAEV33405KW12345', new Date(2026, 8, 30), 7552700, 'C0', 123456789, 7552700, '12345', 12345, 123456, [0, 0, 1])),
  CAPTURED
);
ok("matches what BMW's AIF_SCHREIBEN sent for the same arguments");
assert.throws(() => P.gs20Aif.build('NJ87379', new Date(), 1, 'DA', 1, 1, '12345', 1, 0, [0, 0, 0]), /17 letters/);
assert.ok(P.gs20Aif.isFree([0xff]) && !P.gs20Aif.isFree([0x20]));
assert.deepStrictEqual(P.gs20Aif.partNumbers('G2210_0090C0ER10'), { dataNr: 7558009, assemblyNr: 7558008 });
assert.strictEqual(P.gs20Aif.partNumbers('G2210_0090C0XX10'), null);
assert.strictEqual(P.gs20Aif.number(' 12321 '), 12321);
assert.strictEqual(P.gs20Aif.number('abc'), 0);
ok('a 7-char VIN is refused; free slots, part numbers and number parsing');

// ── 2. the program checksum ─────────────────────────────────────────────────
console.log('\nprogram checksum');
const patchPath = path.join(__dirname, '..', '..', 'app', 'renderer', 'data', 'gs20_7552700_readpatch_program.bin');
const patch = new Uint8Array(fs.readFileSync(patchPath));
assert.strictEqual(patch.length, P.GS20_PROGRAM_LENGTH);
assert.ok(P.gs20ProgramChecksum.verify(patch), 'the shipped read-patch program verifies');
assert.strictEqual(P.gs20ProgramChecksum.stored(patch), 0x4cb5);
assert.strictEqual(P.gs20ProgramRelease(patch), '90');
assert.strictEqual(P.gs20IdentTail(patch), '90C0');
assert.ok(P.gs20ProgramHasReadPatch(patch));
const inRange = Uint8Array.from(patch);
inRange[0x1000] ^= 1;
assert.ok(!P.gs20ProgramChecksum.verify(inRange));
const inGap = Uint8Array.from(patch);
inGap[0x210] ^= 1;
assert.ok(P.gs20ProgramChecksum.verify(inGap), 'the gap at 0x200-0x27F is outside the ranges');
const { image: corrected, checksum } = P.gs20ProgramChecksum.corrected(inRange);
assert.ok(P.gs20ProgramChecksum.verify(corrected));
assert.strictEqual(P.gs20ProgramChecksum.stored(corrected), checksum);
assert.ok(!P.gs20ProgramChecksum.verify(inRange), 'corrected() returns a copy');
assert.throws(() => P.gs20ProgramChecksum.compute(new Uint8Array(100)), /0x40000/);
ok('shipped image verifies (0x4CB5); release 90, tail 90C0, patch present; ranges and gap; corrected copy');

// ── 3. no auto upshift ──────────────────────────────────────────────────────
console.log('\nno auto upshift');
const cal = new Uint8Array(G.GS20_CAL_LENGTH);
for (let i = 0; i < cal.length; i++) cal[i] = (i * 3) & 0xff;
for (const group of [0x0d44, 0x0e64, 0x11c4, 0x12e4]) {
  for (let t = 0; t < 4; t++) {
    cal[group + t * 36] = 17;
    cal[group + t * 36 + 1] = 0;
  }
}
cal[0x3098] = 1;
cal[0x309a] = 1;
assert.ok(P.gs20NoUpshift.isApplicable(cal) && !P.gs20NoUpshift.isApplied(cal));
const patched = P.gs20NoUpshift.apply(cal);
assert.ok(P.gs20NoUpshift.isApplied(patched));
assert.ok(!P.gs20NoUpshift.isApplied(cal), 'apply() returns a copy');
assert.strictEqual(patched[0x0d44], 17, 'the counts are kept');
assert.strictEqual(patched[0x0d46] | (patched[0x0d47] << 8), 0x1fe0);
assert.strictEqual(patched[0x3098], 0);
const other = Uint8Array.from(cal);
other[0x0d44] = 16;
assert.ok(!P.gs20NoUpshift.isApplicable(other));
assert.throws(() => P.gs20NoUpshift.apply(other), /upshift tables/);
assert.ok(!P.gs20NoUpshift.isApplicable(new Uint8Array(100)));
ok('layout recognised, patch applied to a copy, other layouts refused');

// ── 4. BMW .0DA / .0PA ─────────────────────────────────────────────────────
console.log('\nDaten file');
function hexRecord(address, type, data) {
  const bytes = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
  const sum = (-bytes.reduce((a, b) => a + b, 0)) & 0xff;
  return ':' + [...bytes, sum].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}
function datenText(image, base) {
  const lines = ['$REFERENZ G2210_0090C0ER10 E', ';; ZL_Referenz: G2210_0090C0ER10', ';;K_F1: Daten fuer E46 M54B25 USA MY05'];
  for (let page = 0; page < image.length; page += 0x10000) {
    const abs = base + page;
    lines.push(hexRecord(0, 0x02, [0, 0]));
    lines.push(hexRecord(0, 0x04, [(abs >> 24) & 0xff, (abs >> 16) & 0xff]));
    for (let o = 0; o < 0x10000 && page + o < image.length; o += 32) {
      const last = o + 32 >= 0x10000 || page + o + 32 >= image.length;
      lines.push(hexRecord(o, last ? 0x10 : 0x00, Array.from(image.subarray(page + o, page + o + 32))));
    }
  }
  lines.push(':00000001FF');
  return lines.join('\r\n');
}
const calImage = new Uint8Array(G.GS20_CAL_LENGTH);
for (let i = 0; i < calImage.length; i++) calImage[i] = (i * 5 + 1) & 0xff;
const text = datenText(calImage, G.GS20_CAL_ADDRESS);
assert.deepStrictEqual(P.gs20DatenFile.decode(text), calImage);
assert.strictEqual(P.gs20DatenFile.readReference(text), 'G2210_0090C0ER10');
assert.strictEqual(P.gs20DatenFile.readVehicle(text), 'E46 M54B25 USA MY05');
ok('a 64 KB .0DA with type-04/02 bases and type-0x10 page tails decodes byte for byte');
const progImage = new Uint8Array(P.GS20_PROGRAM_LENGTH);
for (let i = 0; i < progImage.length; i++) progImage[i] = (i * 11 + 7) & 0xff;
assert.deepStrictEqual(P.gs20DatenFile.decodeProgram(datenText(progImage, P.GS20_PROGRAM_ADDRESS)), progImage);
ok('a 256 KB .0PA decodes byte for byte');
const bad = text.replace(/:20000010/, ':20000010').split('\r\n');
const i0 = bad.findIndex((l) => l.startsWith(':20'));
bad[i0] = bad[i0].slice(0, -2) + '00';
assert.throws(() => P.gs20DatenFile.decode(bad.join('\n')), /record checksum/);
assert.throws(() => P.gs20DatenFile.decode(text.replace(':00000001FF', hexRecord(0, 0x05, [1, 2]) + '\n:00000001FF')), /record type 0x05/);
const short = text.split('\r\n').filter((l, i) => i !== 10).join('\n');
assert.throws(() => P.gs20DatenFile.decode(short), /does not cover/);
assert.ok(P.gs20DatenFile.isDatenFile('A7558009.0DA') && P.gs20DatenFile.isProgramFile('7552700A.0pa'));
assert.ok(P.gs20DatenFile.hasTrailer(Uint8Array.from([1, 2, 0xc7, 0xa3, 0x8c, 0x44])));
assert.ok(!P.gs20DatenFile.hasTrailer(new Uint8Array(8)));
ok('a bad record checksum, an unknown type and a hole are refused; names and the trailer');

// ── 5. a simulated transmission at the frame level ─────────────────────────
console.log('\nprogram writer');
function makeModule(opts = {}) {
  const flash = new Uint8Array(0x80000).fill(0xff); // 0x080000..0x0FFFFF
  const m = {
    flash,
    erased: [],
    writes: [],
    statusCalls: 0,
    open: opts.open !== false,
    refuseErase: !!opts.refuseErase,
    info: opts.info || null,
    busyOnce: new Set(),
  };
  const frame = (status, body) => {
    const f = [0x32, body.length + 4, status, ...body];
    f.push(xor(f));
    return f;
  };
  m.wire = new W.Ds2Wire(async (out) => {
    const payload = out.slice(2);
    const cmd = payload[0];
    if (cmd === 0x00) return frame(0xa0, [0x37, 0x35, 0x35, 0x32, 0x37, 0x30, 0x30]);
    if (cmd === 0x05) return frame(0xa0, [0]);
    if (cmd === 0x0b) return frame(0xa0, new Array(45).fill(0).map((_, i) => (i === 7 ? 122 : 0)));
    if (cmd === 0x0d) return m.info ? m.info : frame(0xa0, new Array(0x49).fill(0));
    if (cmd === 0x90) {
      if (payload.length === 5 && payload[1] === 0x42) return frame(0xa0, [0]); // already open
      return frame(0xa0, [0]);
    }
    if (cmd === 0x06) {
      const addr = ((payload[1] << 24) | (payload[2] << 16) | (payload[3] << 8) | payload[4]) >>> 0;
      const n = payload[5];
      const off = addr - 0x80000;
      return frame(0xa0, Array.from(flash.subarray(off, off + n)));
    }
    if (cmd !== 0x07) return frame(0xb0, []);
    const sub = payload[1];
    const addr = (payload[2] << 16) | (payload[3] << 8) | payload[4];
    const withSub = (s) => frame(0xa0, [sub, payload[2], payload[3], payload[4], 0, s, 0]);
    if (!m.open) return frame(0xa2, []);
    if (sub === 0x0f) {
      m.statusCalls++;
      if (m.busyOnce.has(addr)) {
        m.busyOnce.delete(addr);
        return frame(0xa1, [sub, payload[2], payload[3], payload[4], 0, 0, 0]);
      }
      return withSub(1);
    }
    if (sub === 0x06) {
      if (m.refuseErase) return withSub(8);
      m.erased.push(addr);
      flash.fill(0xff, addr - 0x80000, addr - 0x80000 + 0x10000);
      m.busyOnce.add(addr);
      return withSub(1);
    }
    if (sub === 0x02) {
      const n = payload[5];
      m.writes.push([addr, n]);
      for (let i = 0; i < n; i++) flash[addr - 0x80000 + i] &= payload[6 + i];
      const next = addr + n;
      return frame(0xa0, [sub, (next >> 16) & 0xff, (next >> 8) & 0xff, next & 0xff, 0, 1, 0]);
    }
    return frame(0xb0, []);
  });
  return m;
}

{
  const m = makeModule();
  const program = Uint8Array.from(patch);
  program[0x3fecc] = 0; // a stale checksum, to be corrected on the way
  program[0x3fecd] = 0;
  const stages = [];
  const w = new P.Gs20ProgramWriter(m.wire, { note: (t) => stages.push(t) });
  const r = await w.write(program, { onStage: (t) => stages.push(t) });
  assert.deepStrictEqual(m.erased, [0xa0000, 0xb0000, 0xc0000, 0xd0000], 'exactly the four program sectors, in order');
  assert.ok(m.writes.every(([a, n]) => n <= 118 && n > 0 && Math.floor(a / 0x10000) === Math.floor((a + n - 1) / 0x10000)), 'no chunk straddles a sector');
  assert.ok(m.writes.every(([a, n]) => !(program[a - 0xa0000] === 0xff && program[a - 0xa0000 + 1] === 0xff) || n < 118), 'blank runs are stepped over');
  const expect = P.gs20ProgramChecksum.corrected(program).image;
  assert.deepStrictEqual(m.flash.subarray(0x20000, 0x60000), expect, 'the simulated flash ends byte-identical to the corrected image');
  assert.ok(r.checksumCorrected && r.checksum === 0x4cb5);
  assert.ok(stages.some((s) => /^erasing, 4$/.test(s)) && stages.some((s) => /^writing program 100%$/.test(s)));
  assert.strictEqual(w.erasedSectors.length, 4);
  ok('erase x4 (busy polled), write (blank-skipping, sector-bounded), commit; checksum corrected first');
}
{
  // program + calibration as one operation: the calibration lands in the
  // same session after the program, the session is opened once (the second
  // open the calibration writer asks for is answered by the fake as taken)
  const m = makeModule();
  const calImage = new Uint8Array(G.GS20_CAL_LENGTH);
  for (let i = 0; i < calImage.length; i++) calImage[i] = (i * 7 + 3) & 0xff;
  const stages = [];
  global.ds2WireSession = async (fn) => fn(m.wire);
  const r = await P.gs20WriteProgram(patch, { confirmed: true, fast: false, calibration: calImage, onStage: (s) => stages.push(s) });
  assert.deepStrictEqual(m.erased, [0xa0000, 0xb0000, 0xc0000, 0xd0000, 0x90000], 'the program sectors first, then the calibration');
  assert.deepStrictEqual(m.flash.subarray(0x20000, 0x60000), P.gs20ProgramChecksum.corrected(patch).image);
  assert.deepStrictEqual(m.flash.subarray(0x10000, 0x20000), G.gs20Checksum.correct(calImage), 'the calibration lands checksum-corrected');
  assert.ok(r.calibration && r.calibration.checksumCorrected);
  const order = stages.map((s) => s.toLowerCase());
  assert.ok(order.indexOf('program written and committed; writing the calibration') > order.indexOf('writing program 100%'));
  assert.ok(order.indexOf('program written and committed; writing the calibration') < order.indexOf('erasing 0x090000'));
  ok('a program with its calibration: both written in one session, program first, no second confirmation needed');
  delete global.ds2WireSession;
}
{
  const m = makeModule({ refuseErase: true });
  const w = new P.Gs20ProgramWriter(m.wire);
  await assert.rejects(() => w.write(patch), /did not erase 0x0A0000.*erase refused/);
  assert.strictEqual(w.erasedSectors.length, 0, 'a refused erase (sub-status 8) leaves nothing erased');
  ok('an erase answered with sub-status 8 is refused, not treated as done');
}
{
  const m = makeModule({ open: false });
  const w = new P.Gs20ProgramWriter(m.wire);
  await assert.rejects(() => w.write(patch), /not open for programming. Nothing was erased/);
  assert.deepStrictEqual(m.erased, []);
  ok('a module that refuses the status query is refused before any erase');
}
{
  const m = makeModule();
  await assert.rejects(() => new P.Gs20ProgramWriter(m.wire).write(new Uint8Array(0x1000)), /0x40000/);
  ok('a wrong-size image never reaches the wire');
}

console.log('\nfull reader');
{
  const m = makeModule();
  m.flash.set([0xfa, 0x0a, 0x00, 0x1e, 0xfa, 0, 0, 0], 0);
  // subcode 8 is served from the same flash for the simulation
  const base = m.wire._exchange;
  m.wire._exchange = async (out, comm) => {
    const p = out.slice(2);
    if (p[0] === 0x06 && p[1] === 0x08) {
      const addr = (p[2] << 16) | (p[3] << 8) | p[4];
      const n = p[5];
      const body = [0xa0, ...Array.from(m.flash.subarray(addr - 0x80000, addr - 0x80000 + n))];
      const f = [0x32, body.length + 3, ...body];
      f.push(xor(f));
      return f;
    }
    return base(out, comm);
  };
  const rd = new P.Gs20FullReader(m.wire);
  assert.strictEqual(await rd.probe(), null);
  const img = await rd.read(0x80000, 0x8000);
  assert.deepStrictEqual(img, m.flash.subarray(0, 0x8000));
  ok('probe sees the JMPS vectors; a region reads back identical, page-bounded');
}
{
  const m = makeModule();
  m.wire._exchange = async () => {
    const f = [0x32, 0x04, 0xb0];
    f.push(xor(f));
    return f;
  };
  const why = await new P.Gs20FullReader(m.wire).probe();
  assert.match(why, /not have the patched program/);
  ok('stock firmware (B0) is named as such');
}

console.log('\nAIF slot write');
{
  const info = [0x32, 0x4c, 0xa0, ...new Array(0x3c).fill(0), 0x08, 0xf0, 0x00, 0, 0, 0, 0, 0, 0, 0, 0];
  info[info.length - 1] = xor(info.slice(0, -1));
  const m = makeModule({ info });
  m.flash.set(FACTORY, 0x0f000); // slot 0 taken, slot 1 free
  const s = new G.Gs20CalWriter(m.wire);
  assert.strictEqual(await s.readAifAddress(), 0x08f000);
  const record = P.gs20Aif.build('WBAET37495NJ87379', new Date(2026, 8, 30), 7558009, 'DA', 1000000, 7558008, 'BMWEB', 12321, 0, [0, 0x90, 0xc0]);
  const r = await s.writeAifRecord(record);
  assert.deepStrictEqual(r, { address: 0x08f02e, slot: 1, left: 12 });
  assert.deepStrictEqual(m.flash.subarray(0x0f02e, 0x0f02e + 46), record);
  assert.deepStrictEqual(m.writes, [[0x08f02e, 46]]);
  ok('the first free slot after the base is found, status-checked and written');
  for (let i = 0; i < 14; i++) m.flash.set(FACTORY, 0x0f000 + i * 46);
  await assert.rejects(() => s.writeAifRecord(record), /log is full/);
  ok('a full log is refused');
}

console.log(`\ngs20-program: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
