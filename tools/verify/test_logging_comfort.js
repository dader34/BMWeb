#!/usr/bin/env node
// Data logging's Comfort lists (app/renderer/screens/logging/comfort.js) and
// the MS45's one-exchange value reader (packet.js).
//
// WHAT THIS PROVES
//   1. Every row of the MS42 and MS43 lists names a job the SGBD ships, that
//      takes no argument, that the write guard lets through, and a result
//      register that job declares.
//   2. Every MS45 row is a value of the SGBD's own table (FUMWELTTEXTE) and
//      carries that table's scaling, sign and identifier; no value is listed
//      twice.
//   3. The reader defines the packet the way the DME's own jobs do (clear,
//      then identifiers in order, two bytes each), reads it in one exchange,
//      scales the words, defines it again when the DME has lost it, and
//      refuses more values than one definition holds.
//   4. The figures it gives for an answer captured from the emulated DME are
//      the ones the SGBD's scaling gives.
//
// Run: node tools/verify/test_logging_comfort.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const R = path.join(ROOT, 'app', 'renderer');
const P = require(path.join(R, 'screens/logging/packet.js'));
Object.assign(global, P);
const C = require(path.join(R, 'screens/logging/comfort.js'));
Object.assign(global, C);
const { isWriteJob } = require(path.join(R, 'core/bestvm/write-guard.js'));

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const gz = (name) => {
  const f = path.join(ROOT, 'data', 'ecu-src', name);
  return fs.existsSync(f)
    ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f)))
    : null;
};

(async () => {
  // ── 1. the job-read lists ──────────────────────────────────────────────────
  for (const sgbd of ['ms430ds0', 'ms420ds0']) {
    const meta = gz(`${sgbd}.meta.json.gz`);
    if (!meta) {
      console.log(`  skip  ${sgbd}: no SGBD data on disk`);
      continue;
    }
    const seen = new Set();
    let n = 0;
    for (const g of C.LOG_COMFORT[sgbd].groups)
      for (const r of g.rows) {
        n++;
        const job = meta.jobs[r.job];
        assert.ok(job, `${sgbd}: ${r.label}: no job ${r.job}`);
        assert.ok(
          !(job.arguments || []).length,
          `${sgbd}: ${r.job} takes an argument`
        );
        assert.ok(!isWriteJob(r.job), `${sgbd}: ${r.job} is held as a write`);
        assert.ok(
          job.results.some((x) => x.name === r.key),
          `${sgbd}: ${r.job} has no result ${r.key}`
        );
        assert.ok(!seen.has(`${r.job}/${r.key}`), `${sgbd}: ${r.label} twice`);
        seen.add(`${r.job}/${r.key}`);
      }
    ok(`${sgbd}: ${n} rows, each a declared result of a readable job`);
  }

  // ── 2. the MS45's measurement values ───────────────────────────────────────
  const tables = gz('ms450ds0.tables.json.gz');
  const rows = C.LOG_COMFORT.ms450ds0.groups.flatMap((g) => g.rows);
  assert.ok(rows.every((r) => r.job === P.LOG_PACKET_JOB && r.value));
  assert.strictEqual(new Set(rows.map((r) => r.value.id)).size, rows.length);
  if (tables) {
    const table = new Map(
      (tables.tables || tables).FUMWELTTEXTE.map((t) => [
        parseInt(t.UWNR, 16),
        t,
      ])
    );
    for (const r of rows) {
      const t = table.get(r.value.id);
      assert.ok(t, `${r.label}: no value ${r.value.id.toString(16)}`);
      assert.ok(!/unbenutzt/.test(t.UWTEXT), `${r.label}: an unused value`);
      assert.strictEqual(
        r.value.mul,
        parseFloat(t.MUL_WORD),
        `${r.label}: scale`
      );
      assert.strictEqual(r.value.add, parseFloat(t.ADD), `${r.label}: offset`);
      assert.strictEqual(
        r.value.signed,
        /^signed/.test(t.UWTYP_DDLI),
        `${r.label}: sign`
      );
    }
    ok(`ms450ds0: ${rows.length} values, each with the SGBD table's scaling`);
  } else console.log('  skip  ms450ds0: no SGBD tables on disk');
  assert.strictEqual(
    C.logComfortLabel('MS450DS0', P.LOG_PACKET_JOB, P.logPacketKey(0x4111)),
    'Engine speed'
  );
  assert.strictEqual(C.logComfortLabel('ms450ds0', 'STATUS_X', 'Y'), '');
  ok('a reading is named by control unit, job and key; an unknown one is not');
  const lists = C.logComfortLists([
    { sgbd: 'zke3_gm5' },
    { sgbd: 'MS430DS0', group: 'D_0012' },
    { sgbd: 'ms450ds0', group: 'D_0012' },
    { sgbd: 'ms450ds0', group: 'D_0012' },
  ]);
  assert.deepStrictEqual(
    lists.map((l) => l.sgbd),
    ['ms430ds0', 'ms450ds0']
  );
  ok('a chassis offers one list per control unit that has one, none assumed');

  // ── 3. the reader ──────────────────────────────────────────────────────────
  // a DME that keeps the packet it was last given, as the emulated one does
  const ids = [0x4111, 0x4119, 0x411f, 0x413c, 0x4114, 0x4122, 0x411c, 0x4116];
  // the words the emulated DME answered for these (key on, engine stopped),
  // with the last two made up to cover a negative scale and a signed word
  const words = [0, 910, 31488, 36352, 27904, 21504, 0x4000, 0xff00];
  const sent = [];
  let held = null;
  global.ms45LiveTuneSender = () => async (data) => {
    sent.push(Array.from(data));
    if (data[0] === 0x2c && data[2] === 0x04) {
      held = null;
      return [0x6c, 0xf0];
    }
    if (data[0] === 0x2c) {
      held = [];
      for (let i = 2; i < data.length; i += 6) {
        assert.strictEqual(data[i], 0x02, 'by identifier');
        assert.strictEqual(data[i + 1], 1 + (i - 2) / 3, 'position');
        assert.strictEqual(data[i + 2], 2, 'two bytes');
        assert.strictEqual(data[i + 5], 0x01);
        held.push((data[i + 3] << 8) | data[i + 4]);
      }
      return [0x6c, 0xf0];
    }
    if (data[0] === 0x21) {
      if (!held) return [0x7f, 0x21, 0x31];
      const out = [0x61, 0xf0];
      for (const id of held) {
        const w = words[ids.indexOf(id)];
        out.push(w >> 8, w & 0xff);
      }
      return out;
    }
    return null;
  };
  const keys = ids.map(P.logPacketKey);
  let row = await P.logPacketRead('ms450ds0', keys);
  assert.deepStrictEqual(
    sent.map((t) => t.slice(0, 3)),
    [
      [0x2c, 0xf0, 0x04],
      [0x2c, 0xf0, 0x02],
      [0x21, 0xf0],
    ]
  );
  ok('the first round clears, names the values in order, and reads once');
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  assert.ok(near(row[keys[1]], 910), 'idle target');
  assert.ok(near(row[keys[2]], 44.25), 'coolant');
  assert.ok(near(row[keys[3]], 14.422), 'battery');
  assert.ok(near(row[keys[4]], 42.578), 'pedal');
  assert.ok(near(row[keys[5]], 44), 'oil');
  assert.ok(near(row[keys[6]], -64), 'exhaust cam: a negative scale');
  assert.ok(near(row[keys[7]], -0.390625), 'lambda control: a signed word');
  assert.strictEqual(row.MW411F_EINH, '°C');
  ok('the words are scaled as the SGBD scales them, units beside them');

  sent.length = 0;
  row = await P.logPacketRead('ms450ds0', keys);
  assert.deepStrictEqual(sent, [[0x21, 0xf0]]);
  ok('every later round is one exchange');

  sent.length = 0;
  held = null; // the DME restarted
  row = await P.logPacketRead('ms450ds0', keys);
  assert.ok(near(row[keys[2]], 44.25));
  assert.strictEqual(sent.filter((t) => t[0] === 0x21).length, 2);
  ok('a DME that lost the packet is given it again, and read');

  sent.length = 0;
  await P.logPacketRead('ms450ds0', keys.slice(0, 3));
  assert.strictEqual(sent[1].length, 2 + 6 * 3);
  ok('a changed selection is a new definition');

  await assert.rejects(
    P.logPacketRead('ms450ds0', new Array(P.LOG_PACKET_MAX + 1).fill(keys[0])),
    /at most/
  );
  await assert.rejects(
    P.logPacketRead('ms450ds0', ['NOPE_WERT']),
    /not a known/
  );
  ok('too many values, or an unknown one, is refused before the wire');

  sent.length = 0;
  await P.logPacketRelease();
  assert.deepStrictEqual(sent, [[0x2c, 0xf0, 0x04]]);
  sent.length = 0;
  await P.logPacketRelease();
  assert.strictEqual(sent.length, 0);
  ok('stopping drops the packet on the DME, once');

  console.log(`\nlogging-comfort: ${passed} checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
