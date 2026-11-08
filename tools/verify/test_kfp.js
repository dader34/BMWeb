#!/usr/bin/env node
// WebKFP's own part, headless: the flash-file reader and ZB table
// (core/kfp/daten.js), the CDH host's data pump and buffers (core/kfp/host.js),
// and the programming logic that is WinKFP's rather than the script's
// (core/kfp/run.js) -- plus, when the exported scripts are on disk, the gate
// that refuses a script calling something the host cannot serve.
//
//   node tools/verify/test_kfp.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = path.join(ROOT, 'app', 'renderer');
const daten = require(path.join(R, 'core', 'kfp', 'daten.js'));
const { KfpHost } = require(path.join(R, 'core', 'kfp', 'host.js'));
const kfp = require(path.join(R, 'core', 'kfp', 'run.js'));
let passed = 0;
const ok = (m) => {
  passed++;
  if (process.env.V) console.log('  ok', m);
};

// ---- the flash file ---------------------------------------------------------
// Intel HEX as BMW writes it: a $ header, a linear base (04), data (00), a
// segment base (02) that adds to it, a type-10 data record, the end (01)
const rec = (type, addr, bytes) => {
  const b = [bytes.length, (addr >> 8) & 0xff, addr & 0xff, type, ...bytes];
  const sum = (0x100 - (b.reduce((a, x) => a + x, 0) & 0xff)) & 0xff;
  return (
    ':' +
    [...b, sum]
      .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
      .join('')
  );
};
const hex = [
  '$REFERENZ 0044570LO02S',
  rec(0x04, 0, [0x00, 0x02]), // linear 0x20000
  rec(0x00, 0x0000, [1, 2, 3, 4]),
  rec(0x00, 0x0004, [5, 6]),
  rec(0x02, 0, [0x40, 0x00]), // segment 0x4000 << 4 = 0x40000, adds up
  rec(0x00, 0x0100, [7, 8, 9]),
  rec(0x10, 0x0103, [10]),
  rec(0x01, 0, []),
].join('\r\n');
{
  const f = daten.parseFile(hex);
  assert.strictEqual(f.reference, '0044570LO02S');
  assert.deepStrictEqual(
    f.records.map((r) => [r.address, [...r.bytes]]),
    [
      [0x20000, [1, 2, 3, 4]],
      [0x20004, [5, 6]],
      [0x60100, [7, 8, 9]],
      [0x60103, [10]],
    ]
  );
  ok('parseFile: header, linear + segment bases add up, type 10 is data');
  const runs = daten.runs(f);
  assert.deepStrictEqual(
    runs.map((r) => [r.address, r.bytes.length]),
    [
      [0x20000, 6],
      [0x60100, 4],
    ]
  );
  ok('runs: consecutive records join, a jump starts a new run');
  const blocks = daten.blocks(f, 4);
  assert.deepStrictEqual(
    blocks.map((b) => [b.address, [...b.bytes]]),
    [
      [0x20000, [1, 2, 3, 4]],
      [0x20004, [5, 6]],
      [0x60100, [7, 8, 9, 10]],
    ]
  );
  ok('blocks: each run cut at the script limit');
  assert.throws(
    () =>
      daten.parseFile(
        hex.replace(':0400000001020304F2', ':0400000001020304F3')
      ),
    /checksum/
  );
  assert.throws(
    () => daten.parseFile(hex.split('\r\n').slice(0, -1).join('\n')),
    /end record/
  );
  assert.throws(() => daten.parseFile('$X\n:00000001FF\n'), /no data/);
  ok('parseFile refuses a bad checksum, a cut file, an empty one');
}

// ---- the ZB table and history ----------------------------------------------
{
  const dat = [
    ';ZB-NR TYP-NR HW-NR IX SW-NR ...',
    '7552700,0000000,7552700,A,7504696DA,x',
    '7561382,1234567,7561382,A,7561533DA,x',
    '7561383,1234567,7561382,B,,x',
    'garbage line',
  ].join('\n');
  const rows = daten.parseZbTable(dat);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[1], {
    zb: '7561382',
    typ: '1234567',
    hw: '7561382',
    ix: 'A',
    sw: '7561533',
    swIndex: 'DA',
  });
  assert.strictEqual(rows[2].sw, '');
  ok('parseZbTable: the comma rows, number and change index apart');
  const names = ['7561382A.0PA', 'P7561533.0DA', 'A7504696.0DA', 'GD20.DAT'];
  assert.deepStrictEqual(daten.filesFor(rows[1], names), {
    program: '7561382A.0PA',
    data: 'P7561533.0DA',
  });
  assert.deepStrictEqual(daten.filesFor(rows[0], names), {
    program: null,
    data: 'A7504696.0DA',
  });
  assert.deepStrictEqual(daten.filesFor(rows[2], names), {
    program: null,
    data: null,
  });
  ok(
    'filesFor: program by hardware number + index, data by number behind any letter'
  );
  const his = daten.parseHistory(
    '7552700,7561382,x\n7561382,7561383,x\n7561383,9999999,x\n'
  );
  assert.strictEqual(daten.latestZb(his, '7552700', rows).zb, '7561383');
  assert.strictEqual(daten.latestZb(his, '7561383', rows).zb, '7561383');
  assert.strictEqual(daten.latestZb(his, '0000001', rows), null);
  ok('latestZb follows the history while the table still lists the successor');
}

// ---- WinKFP's own logic in run.js ------------------------------------------
{
  assert.deepStrictEqual(kfp.progOrder(1, 0), ['data']);
  assert.deepStrictEqual(kfp.progOrder(2, 0), ['program']);
  assert.deepStrictEqual(kfp.progOrder(3, 2), ['program', 'data']);
  assert.deepStrictEqual(kfp.progOrder(3, 1), ['data', 'program']);
  assert.strictEqual(kfp.progOrder(3, 0), null);
  assert.strictEqual(kfp.progOrder(4, 1), null);
  ok('progOrder: coapiKfGetProgOrderBsuD2');
  assert.strictEqual(kfp.aifDate(new Date(2026, 10, 7)), '071126');
  ok('aifDate: ddmmyy');
  const exec = (calls) => ({
    procs: {
      cabimain: [{ op: 'const', t: 's', v: 'JOBNAME' }],
      X: calls.map((name) => ({ op: 'call', n: 0, name })),
    },
  });
  assert.deepStrictEqual(
    kfp.unservedCalls(
      exec([
        'CDHapiJob',
        'strlen',
        'exit',
        'builtin_63',
        'builtin_64',
        'CDHBinBufAppend',
      ])
    ),
    []
  );
  assert.deepStrictEqual(
    kfp.unservedCalls(exec(['CDHapiJob', 'builtin_99', 'CDHNoSuchCall'])),
    ['builtin_99', 'CDHNoSuchCall']
  );
  ok(
    'unservedCalls: the library, the aliases and the host are served, the rest refused'
  );
}

// ---- the host: data pump and buffers ----------------------------------------
{
  const runs = [
    { address: 0x20000, bytes: Uint8Array.from([1, 2, 3, 4, 5, 6]) },
    { address: 0x60100, bytes: Uint8Array.from([7, 8, 9, 10]) },
  ];
  const host = new KfpHost({ sgbd: 'x', runJob: async () => [], runs });
  const h = host.CDHBinBufCreate();
  const dealt = [];
  for (;;) {
    const r = host.CDHGetApiJobByteData(4, h);
    if (!r.nrOfData) {
      assert.strictEqual(r.bufSize, 0);
      break;
    }
    const b = host.bufs.get(h);
    assert.strictEqual(b.bytes[0], 1, 'byte 0 is 1');
    const count =
      b.bytes[13] |
      (b.bytes[14] << 8) |
      (b.bytes[15] << 16) |
      (b.bytes[16] << 24);
    const addr =
      b.bytes[17] |
      (b.bytes[18] << 8) |
      (b.bytes[19] << 16) |
      (b.bytes[20] << 24);
    assert.strictEqual(count, r.nrOfData);
    assert.strictEqual(b.bytes[21 + r.nrOfData], 3, 'the block ends with 03');
    assert.strictEqual(r.bufSize, 21 + r.nrOfData + 1);
    dealt.push([addr, b.bytes.slice(21, 21 + r.nrOfData)]);
  }
  assert.deepStrictEqual(dealt, [
    [0x20000, [1, 2, 3, 4]],
    [0x20004, [5, 6]],
    [0x60100, [7, 8, 9, 10]],
  ]);
  ok(
    'CDHGetApiJobByteData deals the runs in blocks: count at 13, address at 17, data from 21'
  );
  host.CDHResetApiJobData();
  const again = host.CDHGetApiJobByteData(100, h);
  assert.strictEqual(
    again.nrOfData,
    6,
    'a reset starts the file over, a run at a time'
  );
  ok('CDHResetApiJobData');

  // the download scripts' telegram: a header byte, then the block's data
  const t = host.CDHBinBufCreate();
  host.CDHBinBufWriteByte(t, 0x36, 0);
  assert.strictEqual(host.CDHBinBufAppend(h, t, 21, 6), 0);
  host.CDHBinBufWriteByte(t, 0x37, 7);
  assert.strictEqual(host.CDHBinBufAppend(h, t, 21, 2), 0);
  assert.deepStrictEqual(
    host.bufs.get(t).bytes,
    [0x36, 1, 2, 3, 4, 5, 6, 0x37, 1, 2]
  );
  assert.strictEqual(host.CDHBinBufAppend(999, t, 0, 1), 1);
  ok('CDHBinBufAppend (builtin_63) appends at the end, a bad handle is 1');
}

// ---- every exported script passes the gate (when the export is on disk) ----
{
  const dirs = [
    path.join(R, 'data', 'kfp'),
    path.join(ROOT, 'dist-web', 'data', 'kfp'),
  ];
  const K = dirs.find((d) => fs.existsSync(path.join(d, 'families.json')));
  if (!K) {
    console.log(
      '  SKIP  no data/kfp export on disk (tools/export/kfp_pabd_all.py)'
    );
  } else {
    const fam = JSON.parse(fs.readFileSync(path.join(K, 'families.json')));
    const seen = new Map();
    for (const f of fam) {
      if (seen.has(f.pabd)) continue;
      const exec = JSON.parse(fs.readFileSync(path.join(K, f.pabd + '.json')));
      seen.set(f.pabd, kfp.unservedCalls(exec));
    }
    const refused = [...seen].filter(([, u]) => u.length);
    assert.deepStrictEqual(
      refused,
      [],
      `scripts the host cannot serve: ${refused.map(([p, u]) => `${p} (${u.join(', ')})`).join('; ')}`
    );
    ok(
      `every one of the ${seen.size} exported scripts (${fam.length} families) is served`
    );
  }
}

console.log(`test_kfp: ${passed} checks passed`);
