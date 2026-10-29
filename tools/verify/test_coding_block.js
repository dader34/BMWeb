#!/usr/bin/env node
// A block-addressed module (E46 light switch centre, LSZ) read and written
// through BMW's own coding script, OFFLINE and end to end:
//
//   BMW's coding script A_ALSZ (data/coding-dispatch/c_lsza)
//     -> this app's host callbacks, block mode (write.js flattenBlocked)
//       -> BMW's own coding SGBD jobs (data/ecu-src/c_lsza), in the BEST/2 VM
//         -> a simulated LSZ with 18 numbered blocks of 31 bytes, the same
//            telegrams projects/ihk-emu answers (read d0 05 08 <block>,
//            write d0 24 09 <block> <31 bytes>).
//
// WHAT THIS PROVES
//   1. The read pages every block by number and the flat image holds block N
//      at N * 256, byte for byte what the module holds.
//   2. The DATEN functions decode from it at their block (flatRule).
//   3. A write of one function sends its block whole -- the other bytes as
//      the module holds them -- and nothing to any other block.
//
//   node tools/verify/test_coding_block.js
//
// Needs the generated data (data/ecu-src, app/renderer/data); skips without.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'app/renderer/core/coding/dispatch.js'));
require(path.join(ROOT, 'app/renderer/core/coding/dispatch-host.js'));
const W = require(path.join(ROOT, 'app/renderer/core/coding/write.js'));
const E = require(path.join(ROOT, 'app/renderer/core/coding/encode.js'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ok    ${msg}`);
  } else {
    fail++;
    console.error(`  FAIL  ${msg}`);
  }
}

const BLOCKS = 18;
const LEN = 31;

/** A simulated LSZ at 0xD0: IDENT, block read 0x08, block write 0x09. */
function lsz(mem, vin = [0x4b, 0x4d, 0x12, 0x34, 0x50]) {
  const log = [];
  const ds2 = (body) => {
    const f = [0xd0, body.length + 3, ...body];
    let x = 0;
    for (const b of f) x ^= b;
    return [...f, x];
  };
  const exchange = async (out) => {
    log.push(Array.from(out));
    const cmd = out[2];
    if (cmd === 0x00)
      // IDENT: part, hw, coding index 34 (BCD: LSZ.C34), variant 0x20 (LSZ)
      return ds2([
        0xa0, 0xf6, 0x96, 0x17, 0x18, 0x11, 0x34, 0x20, 0x12, 0x34, 0x02, 0x08,
        0x14,
      ]);
    // the answer echoes the block number ahead of its 31 bytes
    if (cmd === 0x08) return ds2([0xa0, out[3], ...mem[out[3]]]);
    // the VIN's last seven: two letters, five digits BCD (C_FG_LESEN /
    // C_FG_AUFTRAG)
    if (cmd === 0x02 && out[3] === 0x02) return ds2([0xa0, 0x02, ...vin]);
    if (cmd === 0x03 && out[3] === 0x02) {
      vin.splice(0, 5, ...out.slice(4, 9));
      return ds2([0xa0]);
    }
    if (cmd === 0x09) {
      mem[out[3]] = out.slice(4, 4 + LEN);
      return ds2([0xa0]);
    }
    // end of diagnosis (DIAGNOSE_ENDE), the script's last step
    if (cmd === 0x9f) return ds2([0xa0]);
    // anything else is a telegram the real module's shape is not known for:
    // fail loudly rather than answer OK (the emulator stays silent too)
    throw new Error(
      `LSZ sim: unknown telegram ${out.map((b) => b.toString(16)).join(' ')}`
    );
  };
  return {
    exchange,
    log,
    reads: () => log.filter((t) => t[2] === 0x08),
    writes: () => log.filter((t) => t[2] === 0x09),
    vinWrites: () => log.filter((t) => t[2] === 0x03),
    vin,
  };
}

async function main() {
  console.log(
    "\nend to end: BMW's LSZ script and jobs against a simulated LSZ"
  );
  const need = [
    'data/ecu-src/c_lsza.job-code.json.gz',
    'app/renderer/data/coding-dispatch/c_lsza.json',
    'app/renderer/data/daten/E46.json',
  ];
  const missing = need.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.log(`  skip  generated data not on disk (${missing.join(', ')})`);
    return;
  }
  const { loadBestvm } = require('./load_bestvm.js');
  const ctx = { module: { exports: {} }, console };
  vm.createContext(ctx);
  const { Best2Vm } = loadBestvm(ctx);
  const gz = (f) =>
    JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data/ecu-src', f)))
    );
  const code = gz('c_lsza.job-code.json.gz');
  const tables = gz('c_lsza.tables.json.gz');
  const dispatch = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'app/renderer/data/coding-dispatch/c_lsza.json'),
      'utf8'
    )
  );
  // the coding file under NCS's own name (daten_files.py)
  const map = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'app/renderer/data/daten/E46.json'), 'utf8')
  ).modules.LSZ;
  const variant = Object.keys(map.chassis.E46).find((k) =>
    k.split('+').includes('C34')
  );
  const fields = map.chassis.E46[variant];
  const lay = map.layout.E46[variant];
  const cabd = {
    fields,
    groups: lay.groups.map(([name, start, length, block, kind]) => ({
      name,
      start,
      length,
      block,
      kind,
    })),
    codingIndex: lay.index,
    typ: lay.typ,
  };
  ok(
    lay.typ === 'BLOCK' && fields.some((f) => f.block > 0),
    `LSZ C34 is block-typed, ${fields.length} functions across blocks`
  );

  const fresh = () => {
    const mem = [];
    for (let b = 0; b < BLOCKS; b++) {
      const blk = [];
      for (let i = 0; i < LEN; i++) blk.push((b * 31 + i * 7 + 3) & 0xff);
      mem.push(blk);
    }
    return mem;
  };
  const opts = (sim) => ({
    exchange: sim.exchange,
    code,
    tables,
    jobs: code.jobs,
    Best2Vm,
    dispatch,
    dataOrg: dispatch.dataOrg,
    cabd,
    now: new Date(0),
  });

  // -- the read --------------------------------------------------------------
  const mem = fresh();
  const sim = lsz(mem);
  let r;
  try {
    r = await W.readCoding('c_lsza', opts(sim));
  } catch (e) {
    ok(false, `the read runs (${e.message})`);
    return;
  }
  const blocksRead = [...new Set(sim.reads().map((t) => t[3]))].sort(
    (a, b) => a - b
  );
  ok(
    !sim.writes().length && blocksRead.length > 1,
    `the read pages the blocks by number (${blocksRead.join(' ')}), and writes nothing`
  );
  const known = new Set(r.read);
  let same = true;
  let checked = 0;
  for (let b = 0; b < BLOCKS; b++)
    for (let i = 0; i < LEN; i++) {
      const a = b * W.BLOCK_STRIDE + i;
      if (!known.has(a)) continue;
      checked++;
      if (r.netto[a] !== mem[b][i]) same = false;
    }
  ok(
    same && checked > LEN,
    `the flat image holds block N at N * 256, byte for byte (${checked} bytes)`
  );
  let decoded = 0;
  let wrong = 0;
  for (const f of fields) {
    const flat = W.flatRule(f);
    const ws = flat.word | 0;
    const w = Math.max(1, f.byte | 0);
    let have = true;
    for (let k = 0; k < w; k++) if (!known.has(ws + k)) have = false;
    if (!have) continue;
    decoded++;
    const fromModule = E.fieldHex(
      f,
      mem[f.block | 0].concat(new Array(256).fill(0)).slice(0, 256)
    );
    if (E.fieldHex(flat, r.netto) !== fromModule) wrong++;
  }
  ok(
    decoded > 0 && !wrong,
    `${decoded} of ${fields.length} functions decode from it at their block`
  );

  // -- a write ----------------------------------------------------------------
  const target = fields.find((f) => (f.block | 0) > 0 && f.byte === 1);
  if (!target) return;
  const flat = W.flatRule(target);
  const base = Array.from(r.netto);
  const cur = E.decodeField(flat, Uint8Array.from(base));
  const want = E.spliceEdits(Uint8Array.from(base), [
    { rule: flat, value: cur ? 0 : 1 },
  ]);
  const before = mem.map((b) => b.slice());
  const wsim = lsz(mem);
  let wr;
  try {
    wr = await W.writeCoding('c_lsza', Array.from(want), {
      ...opts(wsim),
      confirmed: true,
      base,
    });
  } catch (e) {
    ok(false, `the write runs (${e.message})`);
    return;
  }
  const touched = [...new Set(wsim.writes().map((t) => t[3]))];
  ok(
    wr.ok && touched.length >= 1 && touched.includes(target.block),
    `a write of ${target.name} (block ${target.block}) reaches its block (${touched.join(' ')})`
  );
  let others = true;
  for (let b = 0; b < BLOCKS; b++)
    for (let i = 0; i < LEN; i++) {
      const a = b * W.BLOCK_STRIDE + i;
      if (mem[b][i] !== (known.has(a) ? want[a] : before[b][i])) others = false;
    }
  ok(
    others,
    'the module ends up holding the edit and nothing else changed (checksum aside)'
  );
  ok(
    !wsim.vinWrites().length &&
      wsim.vin.join() === [0x4b, 0x4d, 0x12, 0x34, 0x50].join(),
    "with no VIN known, the module's VIN is left alone (ZZ00000)"
  );

  // -- a script's read job: what NCS's Read Vin/ZCS runs ---------------------
  {
    const fsim = lsz(mem);
    const r3 = await W.runCodingReadJob('c_lsza', {
      ...opts(fsim),
      jobname: 'FGNR_LESEN',
    });
    ok(
      r3.ok && r3.pars.FAHRGESTELL_NR === 'KM12345' && !fsim.writes().length,
      `FGNR_LESEN through the script hands back the module's VIN (${r3.pars.FAHRGESTELL_NR}), nothing written`
    );
    const e4 = await W.runCodingReadJob('c_lsza', {
      ...opts(fsim),
      jobname: 'SG_CODIEREN',
    }).catch((e) => e);
    ok(
      e4 instanceof Error && /not a read/.test(e4.message),
      'a writing job is refused by the read runner'
    );
  }

  // -- the car's VIN, when known, goes to the module ---------------------------
  {
    for (let b = 0; b < BLOCKS; b++) mem[b] = before[b].slice();
    const vsim = lsz(mem);
    const r2 = await W.writeCoding('c_lsza', Array.from(want), {
      ...opts(vsim),
      confirmed: true,
      // an edit to make, so the script runs (an unchanged image sends nothing)
      base,
      vin: 'WBAEV53435KM98765',
    });
    ok(
      r2.ok &&
        vsim.vinWrites().length === 1 &&
        vsim.vin.join() === [0x4b, 0x4d, 0x98, 0x76, 0x50].join(),
      `with the VIN known, a differing one is written: KM98765 (${r2.ok} ${vsim.vinWrites().length} ${vsim.vin.map((b) => b.toString(16)).join(' ')})`
    );
  }
}

// A script that writes the car's VIN unconditionally (the E46 climate
// module's A_IHK46 does on every SG_CODIEREN) is refused before anything is
// sent when no VIN is known -- not left to fail on the VIN job mid-run, after
// the coding went out.
async function vinRequired() {
  console.log('\na script that writes the VIN, with none known');
  const need = [
    'data/ecu-src/c_ihk.job-code.json.gz',
    'app/renderer/data/coding-dispatch/a_ihk46.json',
  ];
  if (need.some((f) => !fs.existsSync(path.join(ROOT, f)))) {
    console.log('  skip  generated data not on disk');
    return;
  }
  const { loadBestvm } = require('./load_bestvm.js');
  const ctx = { module: { exports: {} }, console };
  vm.createContext(ctx);
  const { Best2Vm } = loadBestvm(ctx);
  const gz = (f) =>
    JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data/ecu-src', f)))
    );
  const code = gz('c_ihk.job-code.json.gz');
  const dispatch = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'app/renderer/data/coding-dispatch/a_ihk46.json'),
      'utf8'
    )
  );
  // the climate module's coding file under NCS's own name (daten_files.py)
  const map = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'app/renderer/data/daten/E46.json'), 'utf8')
  ).modules.IHK_E46;
  const lay = map.layout.E46.C17;
  const cabd = {
    fields: map.chassis.E46.C17,
    groups: lay.groups.map(([name, start, length, block, kind]) => ({
      name,
      start,
      length,
      block,
      kind,
    })),
    codingIndex: lay.index,
    typ: lay.typ,
  };
  const sent = [];
  const base = new Array(3232).fill(0);
  const want = base.slice();
  want[0] ^= 1;
  let e = null;
  try {
    await W.writeCoding('c_ihk', want, {
      confirmed: true,
      exchange: async (out) => {
        sent.push(out);
        throw new Error('nothing should be sent');
      },
      code,
      tables: {},
      jobs: code.jobs,
      Best2Vm,
      dispatch,
      dataOrg: dispatch.dataOrg,
      cabd,
      base,
      now: new Date(0),
    });
  } catch (err) {
    e = err;
  }
  ok(
    e && /writes the car's VIN/.test(e.message) && !sent.length,
    'refused before anything is sent, saying the VIN is needed'
  );
}

// The E46 body module (GM5) on coding file C05/C06 is coded through ZKE5_S12,
// whose jobs take the block from the address's high byte -- the same flat
// image as the LSZ. A strict simulation seeded with a real car's two blocks
// (read off a 2005 325i with zke5 COD_LESEN): read, one edit, write, verify.
async function gm5() {
  console.log('\nthe body module (GM5 C05) through ZKE5_S12 and A_GM5');
  const need = [
    'data/ecu-src/zke5_s12.job-code.json.gz',
    'app/renderer/data/coding-dispatch/c_gm5.json',
  ];
  if (need.some((f) => !fs.existsSync(path.join(ROOT, f)))) {
    console.log('  skip  generated data not on disk');
    return;
  }
  const { loadBestvm } = require('./load_bestvm.js');
  const ctx = { module: { exports: {} }, console };
  vm.createContext(ctx);
  const { Best2Vm } = loadBestvm(ctx);
  const gz = (f) =>
    JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data/ecu-src', f)))
    );
  const code = gz('zke5_s12.job-code.json.gz');
  const tables = gz('zke5_s12.tables.json.gz');
  const dispatch = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'app/renderer/data/coding-dispatch/c_gm5.json'),
      'utf8'
    )
  );
  const map = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'app/renderer/data/daten/E46.json'), 'utf8')
  ).modules.GM5;
  const lay = map.layout.E46['C05+C06'];
  const fields = map.chassis.E46['C05+C06'];
  const cabd = {
    fields,
    groups: lay.groups.map(([name, start, length, block, kind]) => ({
      name,
      start,
      length,
      block,
      kind,
    })),
    codingIndex: lay.index,
    typ: lay.typ,
  };
  const hex = (t) => t.split(' ').map((h) => parseInt(h, 16));
  // the car's own blocks, as its GM5 answered 08 00 / 08 01
  const mem = [
    hex(
      '4C 12 71 01 55 12 1F 00 A0 02 FF 01 0F 28 41 84 80 09 00 00 60 07 90 20 00 02 73 00 00 AA'
    ),
    hex(
      '9A 0F 02 55 00 20 00 FE C7 02 FE 86 02 3E 80 02 69 D7 7C 7C D7 00 E1 79 44 05 00 00 00 AA'
    ),
  ];
  let vin = [0x00, 0x00, 0x00];
  const log = [];
  const exchange = async (out) => {
    log.push(Array.from(out));
    const f = (body) => {
      const t = [0x00, body.length + 3, ...body];
      let x = 0;
      for (const b of t) x ^= b;
      return [...t, x];
    };
    const cmd = out[2];
    if (cmd === 0x00)
      // IDENT: coding index 05 (BCD) at data byte 5
      return f([
        0xa0, 0x08, 0x37, 0x63, 0x05, 0x11, 0x05, 0x10, 0x12, 0x34, 0x02, 0x08,
        0x14,
      ]);
    if (cmd === 0x08) return f([0xa0, ...mem[out[3]]]);
    if (cmd === 0x09) {
      mem[out[3]] = out.slice(4, 4 + 30);
      return f([0xa0]);
    }
    if (cmd === 0x0e) return f([0xa0, ...vin]);
    if (cmd === 0x0f) {
      vin = out.slice(3);
      return f([0xa0]);
    }
    if (cmd === 0x9f) return f([0xa0]);
    throw new Error(
      `GM5 sim: unknown telegram ${out.map((b) => b.toString(16)).join(' ')}`
    );
  };
  const opts = {
    exchange,
    code,
    tables,
    jobs: code.jobs,
    Best2Vm,
    dispatch,
    dataOrg: dispatch.dataOrg,
    cabd,
    now: new Date(0),
  };
  let r;
  try {
    r = await W.readCoding('zke5_s12', opts);
  } catch (e) {
    ok(false, `the GM5 read runs (${e.message})`);
    return;
  }
  const reads = [...new Set(log.filter((t) => t[2] === 0x08).map((t) => t[3]))];
  let same = true;
  for (let b = 0; b < 2; b++)
    for (let i = 0; i < 30; i++)
      if (r.netto[b * W.BLOCK_STRIDE + i] !== mem[b][i]) same = false;
  ok(
    same && reads.join() === '0,1',
    `both blocks read (08 ${reads.join(' / 08 ')}), byte for byte the car's`
  );
  // comfort closing by remote: a block-1 function
  const target = fields.find((x) => x.name === 'KOMFORTSCHLIESSUNG_FB');
  const flat = W.flatRule(target);
  const base = Array.from(r.netto);
  const was = E.fieldHex(flat, base);
  const other = target.values.find(([, v]) => v !== was);
  const want = E.spliceEdits(Uint8Array.from(base), [
    { rule: flat, hex: other[1] },
  ]);
  const before = mem.map((b) => b.slice());
  log.length = 0;
  let wr;
  try {
    wr = await W.writeCoding('zke5_s12', Array.from(want), {
      ...opts,
      confirmed: true,
      base,
      vin: 'WBAET37495NJ87379',
    });
  } catch (e) {
    ok(false, `the GM5 write runs (${e.message})`);
    return;
  }
  const writes = log.filter((t) => t[2] === 0x09).map((t) => t[3]);
  let only = true;
  for (let b = 0; b < 2; b++)
    for (let i = 0; i < 30; i++)
      if (mem[b][i] !== want[b * W.BLOCK_STRIDE + i]) only = false;
  ok(
    wr.ok && writes.includes(1) && only,
    `KOMFORTSCHLIESSUNG_FB ${was} -> ${other[1]} lands in block 1 (09 ${writes.join(' / 09 ')}), the module holds exactly the edit`
  );
  ok(mem[0].join() === before[0].join(), 'block 0 is unchanged');
}

main()
  .then(vinRequired)
  .then(gm5)
  .catch((e) => {
    fail++;
    console.error(e);
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
