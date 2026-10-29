#!/usr/bin/env node
// ZCS_SCHREIBEN / ZCS_LOESCHEN: BMW's own cluster script writing the central
// coding key, against a simulated late E46 cluster.
//
// NCS Expert does not hold the ZCS write logic itself. The cluster's coding
// script (A_KMB46) routes ZCS_SCHREIBEN and ZCS_LOESCHEN to the same proc as
// SG_CODIEREN (Cod), which asks the host for the "ZCS" group's data
// (CDHGetGrpDataFromCbd) and writes it with C_S_AUFTRAG. The host -- NCS's
// C layer, here core/coding/dispatch-host.js -- is what lays the key into
// that group, from its system data GM/SA/VN_SCHLUESSEL.
//
// WHAT THIS PROVES
//   1. ZCS_SCHREIBEN with a key in system data writes that key's 20-byte
//      region (GM 4+check, SA 8+check, VN 5+check) at the cluster's ZCS group
//      (368), and nothing outside the group.
//   2. ZCS_LOESCHEN writes the blank key the script itself sets
//      (FFFFFFFFP / FFFF..E / FFFFFFFFFFF).
//   3. The check characters are BMW's: the blank key's P, E, F come out of
//      our mod-36 exactly as the script spells them.
//
//   node tools/verify/test_ncs_zcs.js
//
// Needs the generated data; skips when it is not on disk.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
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

const need = [
  'data/ecu-src/c_kmb46.job-code.json.gz',
  'app/renderer/data/coding-dispatch/a_kmb46.json',
  'app/renderer/data/datenmap.js',
];
const missing = need.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.log(`  skip  generated data not on disk (${missing.join(', ')})`);
  process.exit(0);
}

const E = require(path.join(ROOT, 'app/renderer/core/coding/encode.js'));
require(path.join(ROOT, 'app/renderer/core/coding/dispatch.js'));
const W = require(path.join(ROOT, 'app/renderer/core/coding/write.js'));
const { loadBestvm } = require('./load_bestvm.js');

// The simulated late cluster: DS2 at 0x80, coding memory read/written in
// 2-byte words (as test_coding_dispatch.js's).
function cluster(mem) {
  const log = [];
  const ds2 = (body) => {
    const f = [0x80, body.length + 3, ...body];
    let x = 0;
    for (const b of f) x ^= b;
    return [...f, x];
  };
  const word = (out) => ((out[5] << 8) | out[6]) * 2;
  const exchange = async (out) => {
    log.push(Array.from(out));
    const cmd = out[2];
    if (cmd === 0x00)
      return ds2([
        0xa0, 0x06, 0x90, 0x12, 0x34, 0x22, 8, 0x10, 0x20, 0x30, 0x03, 0x04,
        0x41, 0x31, 0x32, 0x05, 0, 0, 0, 0, 0,
      ]);
    if (cmd === 0x02)
      return ds2([0xa0, 0x4e, 0x4a, 0x87, 0x37, 0x90, 0x0c, 0, 0]);
    if (cmd === 0x06)
      return ds2([0xa0, ...mem.slice(word(out), word(out) + out[7] * 2)]);
    if (cmd === 0x07) {
      for (let i = 0; i < out[7] * 2; i++) mem[word(out) + i] = out[8 + i];
      return ds2([0xa0]);
    }
    return ds2([0xa0]);
  };
  return { exchange, log, writes: () => log.filter((t) => t[2] === 0x07) };
}

(async () => {
  const ctx = { module: { exports: {} }, console };
  vm.createContext(ctx);
  const { Best2Vm } = loadBestvm(ctx);
  const gz = (f) =>
    JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data/ecu-src', f)))
    );
  const code = gz('c_kmb46.job-code.json.gz');
  let tables = {};
  try {
    tables = gz('c_kmb46.tables.json.gz');
  } catch {
    /* an SGBD without tables */
  }
  const dispatch = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'app/renderer/data/coding-dispatch/a_kmb46.json'),
      'utf8'
    )
  );
  // the cluster's coding file under NCS's own name (daten_files.py)
  const kombi = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'app/renderer/data/daten/E46.json'), 'utf8')
  ).modules.KMB_E46;
  const variant = Object.keys(kombi.chassis.E46).find((k) =>
    k.split('+').includes('C08')
  );
  const lay = kombi.layout.E46[variant];
  const cabd = {
    fields: kombi.chassis.E46[variant],
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
  const zcsGroup = cabd.groups.find((g) => g.name === 'ZCS');
  ok(
    zcsGroup && zcsGroup.start === 368 && zcsGroup.length === 20,
    "the cluster's ZCS group is 20 bytes at 368 (C08)"
  );

  // -- 3. the check characters are BMW's ----------------------------------------
  ok(
    E.mod36('C1', 'FFFFFFFF') === 'P' &&
      E.mod36('C2', 'FFFFFFFFFFFFFFFF') === 'E' &&
      E.mod36('C3', 'FFFFFFFFFF') === 'F',
    "mod-36 gives the blank key's P, E, F exactly as A_KMB46 spells them"
  );

  const fresh = () => {
    const mem = new Uint8Array(1024);
    for (let i = 0; i < mem.length; i++) mem[i] = (i * 37 + 11) & 0xff;
    return mem;
  };
  // As the NCS screen asks for it: the image the module should hold, i.e.
  // what it holds with the key laid into the ZCS group.
  const withKey = (mem, gm, sa, vn) =>
    Array.from(
      E.buildZcsRegion(gm, sa, vn, zcsGroup.start, Uint8Array.from(mem))
    );
  const run = (jobname, mem, systemData, want) => {
    const sim = cluster(mem);
    return W.writeCoding('c_kmb46', want, {
      confirmed: true,
      exchange: sim.exchange,
      code,
      tables,
      jobs: code.jobs,
      Best2Vm,
      dispatch,
      dataOrg: dispatch.dataOrg,
      cabd,
      base: Array.from(mem),
      jobname,
      systemData,
      now: new Date(0),
    }).then(
      (r) => ({ r, sim }),
      (e) => ({ e, sim })
    );
  };
  const region = (gm, sa, vn) =>
    Array.from(
      E.buildZcsRegion(gm, sa, vn, 0, new Uint8Array(20)).slice(0, 20)
    );
  const outside = (before, after) => {
    const out = [];
    for (let i = 0; i < before.length; i++)
      if (
        before[i] !== after[i] &&
        !(i >= zcsGroup.start && i < zcsGroup.start + 20)
      )
        out.push(i);
    return out;
  };

  // -- 1. ZCS_SCHREIBEN writes the key the user gave --------------------------
  {
    const GM = '0A100106';
    const SA = '00004A2005009080';
    const VN = '00013FE916';
    const mem = fresh();
    const before = Uint8Array.from(mem);
    const { r, e } = await run(
      'ZCS_SCHREIBEN',
      mem,
      {
        GM_SCHLUESSEL: GM + E.mod36('C1', GM),
        SA_SCHLUESSEL: SA + E.mod36('C2', SA),
        VN_SCHLUESSEL: VN + E.mod36('C3', VN),
      },
      withKey(mem, GM, SA, VN)
    );
    ok(!e, `ZCS_SCHREIBEN ran${e ? ` (threw: ${e.message})` : ''}`);
    const got = Array.from(mem.slice(368, 388));
    const want = region(GM, SA, VN);
    ok(
      String(got) === String(want),
      'the cluster now holds the given key at 368..387'
    );
    // After the key, BMW's script writes the cluster's CHECKSUM function (the
    // byte just before the group, 366); nothing else may move.
    const checksum = cabd.fields.find((f) => f.name === 'CHECKSUM');
    const stray = outside(before, mem).filter(
      (a) => !(checksum && a === checksum.word)
    );
    ok(
      stray.length === 0,
      `nothing outside the ZCS group but the script's CHECKSUM byte changed${stray.length ? ` (changed: ${stray.slice(0, 8).join(',')})` : ''}`
    );
    if (r) ok(r.ok, 'the write reports done (read back and verified)');
  }

  // -- 2. ZCS_LOESCHEN writes the blank key -----------------------------------
  {
    const mem = fresh();
    const { e } = await run(
      'ZCS_LOESCHEN',
      mem,
      {},
      withKey(mem, 'FFFFFFFF', 'FFFFFFFFFFFFFFFF', 'FFFFFFFFFF')
    );
    ok(!e, `ZCS_LOESCHEN ran${e ? ` (threw: ${e.message})` : ''}`);
    const got = Array.from(mem.slice(368, 388));
    const want = region('FFFFFFFF', 'FFFFFFFFFFFFFFFF', 'FFFFFFFFFF');
    ok(
      String(got) === String(want),
      'the cluster now holds the blank key (FFFFFFFFP / FFFF..E / FFFFFFFFFFF)'
    );
  }

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
