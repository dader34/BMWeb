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

  // a family sold for several chassis has a table and a history per chassis
  // (all named alike); a module's ZB is in its own chassis's only
  const e60 = '7544306,0,7544306,A,7544307DA,x\n7550125,0,7550125,A,,x';
  const e85 = '7561466,0,7561380,A,7561467DA,x\n7550125,9,7550125,B,,x';
  const merged = daten.mergeZbTables([e60, e85]);
  assert.deepStrictEqual(
    merged.map((r) => r.zb),
    ['7544306', '7550125', '7561466']
  );
  assert.strictEqual(merged[1].ix, 'A');
  assert.strictEqual(
    daten.latestZb(new Map(), '7561466', daten.parseZbTable(e60)),
    null
  );
  assert.strictEqual(
    daten.latestZb(new Map(), '7561466', merged).zb,
    '7561466'
  );
  ok("mergeZbTables: every chassis's ZBs, one listed twice taken once");
  const histories = daten.mergeHistories([
    '7550125,7544306,x\n',
    '7544306,7561466,x\n7550125,9999999,x\n',
  ]);
  assert.deepStrictEqual(
    [...histories],
    [
      ['7550125', '7544306'],
      ['7544306', '7561466'],
    ]
  );
  assert.strictEqual(
    daten.latestZb(histories, '7550125', merged).zb,
    '7561466'
  );
  ok('mergeHistories: a chain that runs through two chassis is followed');
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

  // the record's fields: what this programming knows, and what it does not
  // carried forward from the module's newest record rather than zeroed
  {
    const record = {
      AIF_FG_NR: 'WBAET37495NJ87379',
      AIF_SW_NR: '7545151',
      AIF_AENDERUNGS_INDEX: 'CA',
      AIF_BEHOERDEN_NR: '1037367',
      AIF_ZB_NR: '7545150',
      AIF_SERIEN_NR: 'NFS01',
      AIF_HAENDLER_NR: '000240',
      AIF_KM: '81234',
      AIF_PROG_NR: '0044570LO00S',
    };
    const zb = {
      vin: 'WBAET37495NJ87379',
      zb: '7561532',
      sw: '7561533',
      changeIndex: 'DA',
      approval: '0000000',
    };
    assert.deepStrictEqual(kfp.aifFields(zb, record, '0044570LO02S'), {
      AIF_FG_NR: 'WBAET37495NJ87379',
      // the ZB programmed, its software number and index: never the record's
      AIF_ZB_NR: '7561532',
      AIF_SW_NR: '7561533',
      AIF_AENDERUNGS_INDEX: 'DA',
      AIF_BEHOERDEN_NR: '0000000',
      // who programmed it
      AIF_SERIEN_NR: 'BMWEB',
      // what the programming does not know stays as the workshop wrote it
      AIF_HAENDLER_NR: '000240',
      AIF_KM: '81234',
      // the program file's own reference, not the record's older one
      AIF_PROG_NR: '0044570LO02S',
    });
    ok('aifFields: the ZB programmed, with dealer and mileage carried forward');

    // a module with no record (or one that could not be read): the defaults
    for (const none of [null, {}, { AIF_HAENDLER_NR: '', AIF_KM: '' }])
      assert.deepStrictEqual(kfp.aifFields(zb, none, ''), {
        AIF_FG_NR: 'WBAET37495NJ87379',
        AIF_ZB_NR: '7561532',
        AIF_SW_NR: '7561533',
        AIF_AENDERUNGS_INDEX: 'DA',
        AIF_BEHOERDEN_NR: '0000000',
        AIF_SERIEN_NR: 'BMWEB',
        AIF_HAENDLER_NR: '000000',
        AIF_KM: '0',
        AIF_PROG_NR: '',
      });
    ok('aifFields: a module with no record gets the defaults');

    // the last seven of the VIN: completed from the record that ends in
    // them, left alone when the record is another car's
    assert.strictEqual(
      kfp.aifFields({ ...zb, vin: 'nj87379' }, record, '').AIF_FG_NR,
      'WBAET37495NJ87379'
    );
    assert.strictEqual(
      kfp.aifFields({ ...zb, vin: 'KR12345' }, record, '').AIF_FG_NR,
      'KR12345'
    );
    ok('aifFields: a seven-character VIN is completed from its own record');

    // data alone in expert mode (no program file): the program on the
    // module is the one it had, and so is its reference
    assert.strictEqual(
      kfp.aifFields(zb, record, '').AIF_PROG_NR,
      '0044570LO00S'
    );
    // a ZB that names no data file: the data, and its number, stay
    const noData = kfp.aifFields(
      { ...zb, sw: '', changeIndex: '' },
      record,
      ''
    );
    assert.strictEqual(noData.AIF_SW_NR, '7545151');
    assert.strictEqual(noData.AIF_AENDERUNGS_INDEX, 'CA');
    // a table with no approval number: the record's
    assert.strictEqual(
      kfp.aifFields({ ...zb, approval: '' }, record, '').AIF_BEHOERDEN_NR,
      '1037367'
    );
    // what is given wins, and a malformed value in the record is not carried
    const given = kfp.aifFields(
      {
        ...zb,
        dealer: '123456',
        km: '99000',
        tester: 'ABC12',
        progRef: '0044570LN00S',
      },
      { ...record, AIF_HAENDLER_NR: '24', AIF_KM: 'n/a' },
      '0044570LO02S'
    );
    assert.strictEqual(given.AIF_HAENDLER_NR, '123456');
    assert.strictEqual(given.AIF_KM, '99000');
    assert.strictEqual(given.AIF_SERIEN_NR, 'ABC12');
    assert.strictEqual(given.AIF_PROG_NR, '0044570LN00S');
    const bad = kfp.aifFields(
      zb,
      { AIF_HAENDLER_NR: '24', AIF_KM: 'n/a', AIF_PROG_NR: 'short' },
      ''
    );
    assert.strictEqual(bad.AIF_HAENDLER_NR, '000000');
    assert.strictEqual(bad.AIF_KM, '0');
    assert.strictEqual(bad.AIF_PROG_NR, '');
    ok(
      'aifFields: what is given wins; a malformed record value is not carried'
    );
  }
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

// ---- packed SP-Daten ---------------------------------------------------------
// The packer is Python (tools/export/kfp_spdaten_pack.py) and the reader is
// the app's (daten.openPack): pack real-shaped files with the one, read them
// back with the other, and they must be the same bytes. Then the property
// that matters more than the round trip: a pack that would give back a
// DIFFERENT file is refused, never returned.
//
// The zstd decoder here is Node's own, the reference: this checks the FORMAT.
// That the decoder the app ships (vendor/fzstd.js) gives the same bytes is
// test_fzstd.js's job.
{
  const os = require('os');
  const zlib = require('zlib');
  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-'));
  try {
    const src = path.join(tmp, 'src');
    const out = path.join(tmp, 'out');
    const head =
      ';==========\r\n;;K_File-Name:      X.0PA\r\n$REFERENZ G1 A\r\n';
    const body = (seed, from = 0) => {
      let t = '';
      for (let i = from; i < 400; i++)
        t +=
          rec(
            0,
            (i * 16) & 0xffff,
            Array.from({ length: 16 }, (_, k) => (i * 7 + k * seed) & 0xff)
          ) + '\r\n';
      return t;
    };
    const files = {
      // two versions that share most of their bytes, CRLF, BMW's header; the
      // second has a record put in near the top, which moves every line
      // after it against the first
      'E46/MOD/1111111A.0PA': head + body(3) + ':00000001FF\r\n',
      'E46/MOD/2222222A.0PA':
        head +
        ':1000000000112233445566778899AABBCCDDEEFF00\r\n' +
        body(3, 1) +
        ':00000001FF\r\n',
      // LF only and no newline at the end; a lower-case record, a record
      // with a wrong checksum and an odd-length one, none of which may be
      // rewritten; a base-address record between data records
      'E46/MOD/A3333333.0DA':
        ';x\n:0a0b0c\n:ABC\n:0400000001020304F3\n' +
        rec(4, 0, [0, 1]) +
        '\n' +
        rec(0, 0xfff8, [1, 2, 3, 4, 5, 6, 7, 8]) +
        '\n' +
        rec(0, 0, [9, 10, 11, 12, 13, 14, 15, 16]) +
        '\n:00000001FF',
      // not text at all
      'E46/MOD/MOD.DAT': Buffer.from([0, 255, 10, 13, 10, 10, 58, 48, 13]),
      'E46/MOD/EMPTY.ATS': '',
      // the same module under a second chassis: one copy in the pack
      'E39/MOD/1111111A.0PA': head + body(3) + ':00000001FF\r\n',
    };
    const index = { version: 1, modules: { MOD: {} } };
    for (const [rel, text] of Object.entries(files)) {
      const [chassis, , name] = rel.split('/');
      fs.mkdirSync(path.join(src, chassis, 'MOD'), { recursive: true });
      const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'latin1');
      fs.writeFileSync(path.join(src, rel), bytes);
      index.modules.MOD[chassis] = index.modules.MOD[chassis] || {
        path: `${chassis}/MOD/`,
        table: 'MOD.DAT',
        files: {},
      };
      index.modules.MOD[chassis].files[name] = bytes.length;
    }
    fs.writeFileSync(path.join(src, 'index.json'), JSON.stringify(index));
    const tool = (name) => {
      const r = spawnSync(name, ['--version'], { encoding: 'utf8' });
      return !(r.error && r.error.code === 'ENOENT');
    };
    if (
      !tool('python3') ||
      !tool('zstd') ||
      typeof zlib.zstdDecompressSync !== 'function'
    ) {
      console.log(
        '  (python3, zstd or a Node with zstd not found: packed SP-Daten checks skipped)'
      );
    } else {
      const run = spawnSync(
        'python3',
        [
          path.join(ROOT, 'tools', 'export', 'kfp_spdaten_pack.py'),
          src,
          out,
          '--verify',
          '--jobs',
          '1',
        ],
        { encoding: 'utf8' }
      );
      assert.strictEqual(
        run.status,
        0,
        `the packer failed: ${run.stderr || run.stdout}`
      );
      const packed = JSON.parse(
        fs.readFileSync(path.join(out, 'index.json'), 'utf8')
      );
      assert.strictEqual(packed.version, 2);
      assert.strictEqual(packed.packs.length, packed.sizes.length);
      const unzstd = (z) => new Uint8Array(zlib.zstdDecompressSync(z));
      const packBytes = (n) =>
        new Uint8Array(
          fs.readFileSync(path.join(out, 'packs', packed.packs[n]))
        );
      const opened = new Map();
      const open = (n) => {
        if (!opened.has(n)) opened.set(n, daten.openPack(packBytes(n), unzstd));
        return opened.get(n);
      };
      for (const rel of Object.keys(files)) {
        const [chassis, , name] = rel.split('/');
        const [p, place] = packed.modules.MOD[chassis].at[name];
        const got = open(p).read(place);
        assert.ok(
          Buffer.from(got.bytes).equals(fs.readFileSync(path.join(src, rel))),
          `${rel} unpacked to something else`
        );
      }
      ok('every packed file unpacks to its original, byte for byte');
      assert.deepStrictEqual(
        packed.modules.MOD.E39.at['1111111A.0PA'],
        packed.modules.MOD.E46.at['1111111A.0PA']
      );
      ok('the same file under two chassis is one file in the pack');

      // the two versions' records are data in one payload stream, not lines:
      // the pack is far smaller than either file
      const [p0, place0] = packed.modules.MOD.E46.at['1111111A.0PA'];
      assert.ok(
        packed.sizes[p0] < files['E46/MOD/1111111A.0PA'].length / 2,
        'two versions of a file did not pack smaller than half of one'
      );
      ok('versions of a file share their bytes in the pack');

      // damage one payload byte: the reader must refuse the file
      const good = packBytes(p0);
      const hlen = new DataView(good.buffer).getUint32(6, true);
      const header = JSON.parse(
        Buffer.from(good.subarray(10, 10 + hlen)).toString()
      );
      const skel = good.subarray(10 + hlen, 10 + hlen + header.skel[0]);
      const pay = Buffer.from(
        zlib.zstdDecompressSync(good.subarray(10 + hlen + header.skel[0]))
      );
      const hit = header.files[place0];
      pay[hit.pay[0] + 5] ^= 0x01;
      const zp = zlib.zstdCompressSync(pay);
      const h2 = Buffer.from(
        JSON.stringify({ ...header, pay: [zp.length, pay.length] })
      );
      const len = Buffer.alloc(4);
      len.writeUInt32LE(h2.length);
      const bad = new Uint8Array(
        Buffer.concat([Buffer.from('BSPK2\n'), len, h2, Buffer.from(skel), zp])
      );
      const damaged = daten.openPack(bad, unzstd);
      assert.throws(
        () => damaged.read(place0),
        /did not unpack to the file that was packed/
      );
      ok('a file whose bytes changed in the pack is refused, not returned');
      assert.throws(
        () => daten.openPack(new Uint8Array(16), unzstd),
        /not an SP-Daten pack/
      );
      // a decompressor that returns the wrong amount is caught at once
      assert.throws(
        () => daten.openPack(good, (z) => unzstd(z).subarray(1)),
        /did not unpack to its own length/
      );
      ok('a pack that is not one, or unpacks short, is refused');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`test_kfp: ${passed} checks passed`);
