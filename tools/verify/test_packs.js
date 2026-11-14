#!/usr/bin/env node
// An offline build's packed ECUs, end to end: scripts/build/pack_offline.py
// packs a small site, and the app's own router (core/webshim/api-router.js
// over core/packs.js) reads it back. What it must show:
//
//   - a packed build answers every ECU read exactly as the .chassis archives
//     did, including the car-specific case (one SGBD name, two contents)
//   - an ECU fitted to two cars is in the packs once
//   - a pack that gives back different bytes is REFUSED, not used
//   - the one reader that wants a .chassis FILE (the offline exporter) gets
//     an archive made from the packs that holds what the original held
//
//   node tools/verify/test_packs.js
//
// The zstd decoder here is Node's own, the reference: this checks the
// packing and the reader. That the decoder the app ships gives the same
// bytes is test_fzstd.js's job, and scripts/build/verify_packs.mjs's for
// every real build.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const R = path.join(ROOT, 'app', 'renderer');
const fflate = require(path.join(R, 'vendor', 'fflate.min.js'));
let passed = 0;
const ok = (m) => {
  passed++;
  if (process.env.V) console.log('  ok', m);
};

const has = (name) => {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8' });
  return !(r.error && r.error.code === 'ENOENT');
};
if (
  !has('python3') ||
  !has('zstd') ||
  typeof zlib.zstdDecompressSync !== 'function'
) {
  console.log(
    'test_packs: python3, zstd or a Node with zstd not found; skipped'
  );
  process.exit(0);
}

// ---- a small site -----------------------------------------------------------
const enc = (v) => new TextEncoder().encode(JSON.stringify(v));
const ops = (seed) =>
  Array.from({ length: 4000 }, (_, i) => [
    'move',
    [
      [1, `S${(i * seed) % 7}`],
      [8, i % 251],
    ],
  ]);
const ecu = (name, seed, extra) => ({
  'ecu.json': enc({ sgbd: name, ...extra }),
  'jobs.json': enc(['INFO', 'IDENT']),
  'job-code.json': enc({
    format: 1,
    sgbd: name,
    jobs: { INFO: 0 },
    ops: ops(seed),
  }),
  'results/INFO.json': enc([{ name: 'ECU', type: 'string' }]),
  'table/JOBRESULT.json': enc([{ SB: '0x00', STATUS_TEXT: 'OKAY' }]),
});
const ecuZip = (files) => fflate.zipSync(files, { level: 6 });
const sources = {
  A: {
    config: { id: 'A', ecus: ['aaa1', 'aaa2', 'bbb'] },
    ecus: {
      aaa1: ecu('aaa1', 3),
      aaa2: ecu('aaa2', 3, { variant: true }), // aaa1's near twin
      bbb: ecu('bbb', 5, { car: 'A' }),
    },
  },
  B: {
    config: { id: 'B', ecus: ['aaa1', 'bbb'] },
    ecus: {
      aaa1: ecu('aaa1', 3), // the same ECU as A's
      bbb: ecu('bbb', 5, { car: 'B' }), // the same NAME as A's, not the same file
    },
  },
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
const site = path.join(tmp, 'site');
const overlay = path.join(tmp, 'overlay');
fs.mkdirSync(path.join(site, 'api', 'chassis'), { recursive: true });
const aaa1 = ecuZip(sources.A.ecus.aaa1); // byte-identical in both cars
for (const [id, car] of Object.entries(sources)) {
  const files = { 'config.json': [enc(car.config), { level: 0 }] };
  for (const [name, f] of Object.entries(car.ecus))
    files[`ecu/${name}.ecu`] = [
      name === 'aaa1' ? aaa1 : ecuZip(f),
      { level: 0 },
    ];
  fs.writeFileSync(
    path.join(site, 'api', 'chassis', `${id}.chassis`),
    fflate.zipSync(files, { level: 0 })
  );
}

// two cars' ISTA bundles: gzipped members (stored and deflated in the zip),
// a plain one, a member both cars have, and one that differs by a line
const svg = (n) =>
  `<svg>${Array.from({ length: 3000 }, (_, i) => `<path d="M${i} ${(i * n) % 97}"/>`).join('')}</svg>`;
const gz = (text) =>
  fflate.gzipSync(new TextEncoder().encode(text), { level: 6 });
const bundles = {
  E1: {
    'abl/E1.json.gz': gz(JSON.stringify({ modules: ['ABL_A', 'ABL_B'] })),
    'abl/ABL_A.json.gz': gz(JSON.stringify({ id: 'ABL_A', steps: ops(3) })),
    'wiring/SP1.svgz': gz(svg(3)),
    'wiring/tree.json': new TextEncoder().encode(
      JSON.stringify({ name: 'E1' })
    ),
    'diag/x.gz': gz('diag for both cars'),
  },
  E2: {
    'abl/ABL_A.json.gz': gz(JSON.stringify({ id: 'ABL_A', steps: ops(3) })), // E1's
    'wiring/SP1.svgz': gz(svg(3) + '<!-- E2 -->'), // E1's, one edit on
    'diag/x.gz': gz('diag for both cars'),
  },
};
fs.mkdirSync(path.join(site, 'data', 'ista', 'bundles'), { recursive: true });
for (const [id, files] of Object.entries(bundles)) {
  const z = {};
  // as the real bundles are: some members stored, some deflated again
  Object.entries(files).forEach(([name, bytes], i) => {
    z[name] = [bytes, { level: i % 2 ? 6 : 0 }];
  });
  fs.writeFileSync(
    path.join(site, 'data', 'ista', 'bundles', `${id}.ista`),
    fflate.zipSync(z)
  );
}

// a car's wiring archive and its document archive, as tools/wds_import.py
// and the docs export build them: a tree, gzipped schematics, plain HTML
const wiringFiles = {
  'tree.json': new TextEncoder().encode(
    JSON.stringify({
      name: 'W1',
      children: [
        { name: 'Engine', doc: 'SP1', kind: 'schematic' },
        { name: 'About', doc: 'D1', kind: 'description' },
      ],
    })
  ),
  'svg/SP1.svgz': gz(svg(11)),
  'doc/D1.html': new TextEncoder().encode(
    '<p>Description <img src="img/p.png"></p>'
  ),
  'img/p.png': new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]),
};
const docsFiles = {
  'tree.json': new TextEncoder().encode(
    JSON.stringify({ name: 'W1', children: [] })
  ),
  'docs/42.json': new TextEncoder().encode(
    JSON.stringify({ chapters: [{ title: 'One' }] })
  ),
};
fs.mkdirSync(path.join(site, 'data', 'wiring'), { recursive: true });
fs.mkdirSync(path.join(site, 'data', 'docs'), { recursive: true });
fs.writeFileSync(
  path.join(site, 'data', 'wiring', 'W1.wiring'),
  fflate.zipSync(wiringFiles)
);
fs.writeFileSync(
  path.join(site, 'data', 'docs', 'W1.docs'),
  fflate.zipSync(docsFiles)
);

// plain data files, fetched one at a time: plain and gzipped, two the same
const dataFiles = {
  'data/kfp/families.json': enc([{ pabd: '12mds45', sgbd: '12ms45' }]),
  'data/kfp/12mds45.json': enc({ ops: ops(7) }),
  'data/kfp/12ms45.job-code.json.gz': gz(JSON.stringify({ ops: ops(9) })),
  'data/groups/d_motor.json.gz': gz(JSON.stringify({ ops: ops(9) })), // the same content
  'data/daten/E46.json': enc({ chassis: 'E46', files: ['A_E46AKMB.C01'] }),
  'data/ista/faulttests.json': enc({ 2712: ['ABL_A'] }),
};
// a file a <script> tag names is not fetched, and must stay a file
const kept = { 'data/cvt.js': new TextEncoder().encode('window.CVT={};') };
for (const [rel, bytes] of Object.entries({ ...dataFiles, ...kept })) {
  fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true });
  fs.writeFileSync(path.join(site, rel), bytes);
}

// the parts catalogue: two cars' bundles that share a picture, one with a
// name that needs escaping, and a side file fetched beside a bundle
const jpg = (n) =>
  new Uint8Array(Array.from({ length: 600 }, (_, i) => (i * n + 7) & 0xff));
const etkBundles = {
  K1: {
    'tree.json': enc({
      chassis: 'K1',
      variants: [],
      maingroups: [{ id: '11', icon: '100.jpg' }],
      groups: [],
    }),
    'img/100.jpg': jpg(3), // K2 has it too
    'img/200.png': jpg(5),
    'img/A b.jpg': jpg(9),
  },
  K2: {
    'tree.json': enc({
      chassis: 'K2',
      variants: [],
      maingroups: [{ id: '11', icon: '100.jpg' }],
      groups: [],
    }),
    'img/100.jpg': jpg(3),
  },
};
const etkSide = {
  'data/etk/K1.hs.json.gz': gz(JSON.stringify({ bt: { 100: [[1, 2, 3, 4]] } })),
};
fs.mkdirSync(path.join(site, 'data', 'etk'), { recursive: true });
fs.writeFileSync(
  path.join(site, 'data', 'etk', 'index.json'),
  JSON.stringify(['K1', 'K2'])
);
for (const [id, files] of Object.entries(etkBundles)) {
  const z = {};
  for (const [name, bytes] of Object.entries(files))
    z[name] = [bytes, { level: name === 'tree.json' ? 6 : 0 }];
  fs.writeFileSync(
    path.join(site, 'data', 'etk', `${id}.etk`),
    fflate.zipSync(z)
  );
}
for (const [rel, bytes] of Object.entries(etkSide))
  fs.writeFileSync(path.join(site, rel), bytes);

try {
  const run = spawnSync(
    'python3',
    [
      path.join(ROOT, 'scripts', 'build', 'pack_offline.py'),
      site,
      overlay,
      '--jobs',
      '2',
    ],
    { encoding: 'utf8' }
  );
  assert.strictEqual(
    run.status,
    0,
    `the packer failed: ${run.stderr || run.stdout}`
  );
  const index = JSON.parse(
    fs.readFileSync(
      path.join(overlay, 'api', 'ecu-packs', 'index.json'),
      'utf8'
    )
  );
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(overlay, 'replaced.json'), 'utf8')),
    [
      'api/chassis/A.chassis',
      'api/chassis/B.chassis',
      'data/daten/E46.json',
      'data/docs/W1.docs',
      'data/etk/K1.etk',
      'data/etk/K1.hs.json.gz',
      'data/etk/K2.etk',
      'data/groups/d_motor.json.gz',
      'data/ista/bundles/E1.ista',
      'data/ista/bundles/E2.ista',
      'data/ista/faulttests.json',
      'data/kfp/12mds45.json',
      'data/kfp/12ms45.job-code.json.gz',
      'data/kfp/families.json',
      'data/wiring/W1.wiring',
    ]
  );
  assert.strictEqual(index.ecus.length, 4, 'aaa1, aaa2 and the two bbb');
  assert.strictEqual(index.chassis.A.ecus.aaa1, index.chassis.B.ecus.aaa1);
  assert.notStrictEqual(index.chassis.A.ecus.bbb, index.chassis.B.ecus.bbb);
  ok('an ECU two cars share is packed once; a name with two contents, twice');
  const packedBytes = index.packs.reduce(
    (n, name) =>
      n + fs.statSync(path.join(overlay, 'api', 'ecu-packs', name)).size,
    0
  );
  const before = ['A', 'B'].reduce(
    (n, id) =>
      n + fs.statSync(path.join(site, 'api', 'chassis', `${id}.chassis`)).size,
    0
  );
  assert.ok(
    packedBytes < before / 2,
    `${packedBytes} packed against ${before}`
  );
  ok('the packs are well under half the archives they replace');

  // ---- the app's router over a folder --------------------------------------
  // A page in miniature: the same scripts, in the page's order, sharing one
  // global scope, with a fetch that reads a folder.
  const page = (dir, flags, decompress) => {
    const sandbox = {
      console,
      TextDecoder,
      TextEncoder,
      Response,
      Promise,
      location: { pathname: '/index.html', protocol: 'http:' },
      fflate,
      fzstd: { decompress },
      ...flags,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    for (const f of [
      'core/packs.js',
      'core/webshim/data-fetch.js',
      'core/webshim/api-router.js',
    ])
      vm.runInContext(fs.readFileSync(path.join(R, f), 'utf8'), ctx, {
        filename: f,
      });
    const asked = [];
    const realFetch = async (url) => {
      // as a server would: no query, no leading slash
      const rel = String(url).split(/[?#]/)[0].replace(/^\/+/, '');
      asked.push(rel);
      const file = path.join(dir, rel);
      return fs.existsSync(file)
        ? new Response(fs.readFileSync(file))
        : new Response(null, { status: 404 });
    };
    sandbox.webRealFetch = realFetch;
    return {
      asked,
      // the page with the shim installed: its file fetch, as readers see it
      shim: () => {
        sandbox.fetch = realFetch;
        vm.runInContext('installWebShim()', ctx);
        return sandbox.webRealFetch;
      },
      istaFile: (id, rel) => vm.runInContext('istaBundleFile', ctx)(id, rel),
      loadChassis: (id) => vm.runInContext('loadChassis', ctx)(id, realFetch),
      loadEcu: (sgbd) => vm.runInContext('loadEcu', ctx)(sgbd, realFetch),
      archive: (id) => vm.runInContext('webChassisArchive', ctx)(id),
      packed: (id) => vm.runInContext('webChassisPacked', ctx)(id),
    };
  };
  const unzstd = (z) => new Uint8Array(zlib.zstdDecompressSync(z));
  const plain = (map) =>
    Object.fromEntries(
      [...map].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])
    );
  const want = (files) =>
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [
        k,
        JSON.parse(new TextDecoder().decode(v)),
      ])
    );

  // the build as the packer leaves it: the overlay, and no .chassis files
  const built = path.join(tmp, 'built');
  fs.cpSync(overlay, built, { recursive: true });
  (async () => {
    for (const id of ['A', 'B']) {
      // each car in a fresh page, so "the car that is open" is that car
      const packedPage = page(built, { BMWEB_OFFLINE: true }, unzstd);
      const classicPage = page(site, {}, unzstd);
      const c1 = await packedPage.loadChassis(id);
      const c2 = await classicPage.loadChassis(id);
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(c1.config)),
        JSON.parse(JSON.stringify(c2.config))
      );
      assert.deepStrictEqual(
        [...c1.ecuZips.keys()].sort(),
        [...c2.ecuZips.keys()].sort()
      );
      for (const sgbd of Object.keys(sources[id].ecus)) {
        const fromPacks = plain(await packedPage.loadEcu(sgbd));
        const fromArchive = plain(await classicPage.loadEcu(sgbd));
        assert.deepStrictEqual(fromPacks, fromArchive, `${id}/${sgbd}`);
        assert.deepStrictEqual(
          fromPacks,
          want(sources[id].ecus[sgbd]),
          `${id}/${sgbd}`
        );
      }
      assert.ok(
        !packedPage.asked.some((a) => a.endsWith('.chassis')),
        'a packed build asked for a .chassis archive'
      );
    }
    ok('a packed build answers every ECU read as the archives do, car by car');

    // the hosted site: no flag, so the packs are never asked for
    const hosted = page(site, {}, unzstd);
    await hosted.loadChassis('A');
    await hosted.loadEcu('aaa2');
    assert.ok(
      !hosted.asked.some((a) => a.includes('ecu-packs')),
      'a build that is not offline asked for packs'
    );
    ok('a build that is not offline never asks for packs');

    // a pack that unpacks to other bytes: refused, whatever the cause
    // one changed byte in every 50,000, past the configs at the pack's start
    const flip = (z) => {
      const raw = unzstd(z);
      for (let at = 25000; at < raw.length; at += 50000) raw[at] ^= 1;
      return raw;
    };
    const damaged = page(built, { BMWEB_OFFLINE: true }, flip);
    await damaged.loadChassis('A');
    let refused = 0;
    for (const sgbd of ['aaa1', 'aaa2', 'bbb']) {
      try {
        await damaged.loadEcu(sgbd);
      } catch (e) {
        assert.match(e.message, /is not what was packed/);
        refused++;
      }
    }
    assert.strictEqual(refused, 3, 'a damaged ECU was read as if whole');
    const short = page(built, { BMWEB_OFFLINE: true }, (z) =>
      unzstd(z).subarray(1)
    );
    await assert.rejects(
      short.loadChassis('A'),
      /unpacked to \d+ bytes, not its/
    );
    ok('a pack that unpacks wrong is refused, not used');

    // the exporter's .chassis, made from the packs
    const exporter = page(built, { BMWEB_OFFLINE: true }, unzstd);
    assert.strictEqual(await exporter.packed('a'), true);
    assert.strictEqual(await exporter.packed('ZZZ'), false);
    const made = fflate.unzipSync(await exporter.archive('A'));
    assert.deepStrictEqual(
      JSON.parse(new TextDecoder().decode(made['config.json'])),
      sources.A.config
    );
    for (const [sgbd, files] of Object.entries(sources.A.ecus)) {
      const inner = fflate.unzipSync(made[`ecu/${sgbd}.ecu`]);
      assert.deepStrictEqual(
        Object.keys(inner).sort(),
        Object.keys(files).sort()
      );
      for (const [name, bytes] of Object.entries(files))
        assert.ok(
          Buffer.from(inner[name]).equals(Buffer.from(bytes)),
          `${sgbd}/${name}`
        );
    }
    assert.strictEqual(await page(site, {}, unzstd).archive('A'), null);
    ok('a .chassis made from the packs holds what the original held');

    // ---- the ISTA bundles ----------------------------------------------------
    {
      const istaIndex = JSON.parse(
        fs.readFileSync(
          path.join(overlay, 'data', 'ista', 'packs', 'index.json'),
          'utf8'
        )
      );
      assert.deepStrictEqual(Object.keys(istaIndex.archives).sort(), [
        'E1.ista',
        'E2.ista',
      ]);
      const bytesOf = async (r) =>
        r ? new Uint8Array(await r.arrayBuffer()) : r;
      const quiet = console.error;
      const packedPage = page(built, { BMWEB_OFFLINE: true }, unzstd);
      const classicPage = page(site, {}, unzstd);
      for (const [id, files] of Object.entries(bundles)) {
        for (const [rel, original] of Object.entries(files)) {
          const a = await bytesOf(await packedPage.istaFile(id, rel));
          const b = await bytesOf(await classicPage.istaFile(id, rel));
          assert.ok(
            Buffer.from(b).equals(Buffer.from(original)),
            `${id}/${rel} (archive)`
          );
          if (/\.(gz|svgz)$/.test(rel))
            // what a reader gunzips is what it always got
            assert.ok(
              Buffer.from(fflate.gunzipSync(a)).equals(
                Buffer.from(fflate.gunzipSync(original))
              ),
              `${id}/${rel} (packed)`
            );
          else
            assert.ok(
              Buffer.from(a).equals(Buffer.from(original)),
              `${id}/${rel} (packed)`
            );
        }
        assert.strictEqual(
          await packedPage.istaFile(id, 'abl/NOT_THERE.json.gz'),
          null
        );
      }
      assert.strictEqual(
        await packedPage.istaFile('E99', 'abl/X.json.gz'),
        null
      );
      assert.ok(
        !packedPage.asked.some((a) => a.endsWith('.ista') && !a.includes('E99'))
      );
      assert.ok(!classicPage.asked.some((a) => a.includes('ista/packs')));
      ok(
        'a packed ISTA bundle gives every file the archive gave, and no other'
      );

      // E1 and E2 share two files and differ by a line in a third: stored once
      const listOf = (id) =>
        JSON.parse(
          Buffer.from(
            zlib.zstdDecompressSync(
              fs.readFileSync(
                path.join(
                  overlay,
                  'data',
                  'ista',
                  'packs',
                  istaIndex.archives[`${id}.ista`][0]
                )
              )
            )
          ).toString()
        );
      const l1 = listOf('E1');
      const l2 = listOf('E2');
      assert.deepStrictEqual(l1['abl/ABL_A.json.gz'], l2['abl/ABL_A.json.gz']);
      assert.deepStrictEqual(l1['diag/x.gz'], l2['diag/x.gz']);
      assert.notDeepStrictEqual(l1['wiring/SP1.svgz'], l2['wiring/SP1.svgz']);
      ok('a file two cars share is in the packs once');

      // other bytes than were packed: the file is "not there", loudly
      const said = [];
      console.error = (m) => said.push(String(m));
      try {
        const flipAll = (z) => {
          const raw = unzstd(z);
          for (let at = 40; at < raw.length; at += 400) raw[at] ^= 1;
          return raw;
        };
        const damagedIsta = page(built, { BMWEB_OFFLINE: true }, flipAll);
        assert.strictEqual(
          await damagedIsta.istaFile('E1', 'wiring/SP1.svgz'),
          null
        );
      } finally {
        console.error = quiet;
      }
      assert.ok(
        said.length >= 1,
        'a damaged ISTA file was dropped without a word'
      );
      ok('an ISTA file that is not what was packed is refused, and said');
    }

    // ---- plain data files ---------------------------------------------------
    {
      // the build as offline-build.mjs stages it: the site, less what the
      // packs replace, with the packs laid over
      const staged = path.join(tmp, 'staged');
      fs.cpSync(site, staged, { recursive: true });
      for (const rel of JSON.parse(
        fs.readFileSync(path.join(overlay, 'replaced.json'), 'utf8')
      ))
        fs.rmSync(path.join(staged, rel));
      fs.cpSync(overlay, staged, { recursive: true });
      const packedPage = page(staged, { BMWEB_OFFLINE: true }, unzstd);
      const fetchPacked = packedPage.shim();
      const fetchClassic = page(site, {}, unzstd).shim();
      const body = async (r) => new Uint8Array(await r.arrayBuffer());
      for (const [rel, original] of Object.entries({
        ...dataFiles,
        ...kept,
        ...etkSide,
      })) {
        // as readers ask: a bare relative path, and one with a query
        for (const url of [rel, `/${rel}?v=3`]) {
          const a = await fetchPacked(url);
          const b = await fetchClassic(url);
          assert.ok(a.ok && b.ok, `${url}: ${a.status} / ${b.status}`);
          const [x, y] = [await body(a), await body(b)];
          assert.ok(
            Buffer.from(y).equals(Buffer.from(original)),
            `${rel} (file)`
          );
          if (rel.endsWith('.gz'))
            assert.ok(
              Buffer.from(fflate.gunzipSync(x)).equals(
                Buffer.from(fflate.gunzipSync(original))
              ),
              `${rel} (packed)`
            );
          else
            assert.ok(
              Buffer.from(x).equals(Buffer.from(original)),
              `${rel} (packed)`
            );
        }
      }
      assert.strictEqual(
        (await fetchPacked('data/kfp/families.json', { method: 'HEAD' })).ok,
        true
      );
      assert.strictEqual((await fetchPacked('data/kfp/NOPE.json')).ok, false);
      assert.ok(
        !packedPage.asked.some((a) => a in dataFiles),
        'a packed file was asked of the folder'
      );
      assert.ok(
        packedPage.asked.includes('data/cvt.js'),
        'a kept file was not read as a file'
      );
      // the catalogue's side file comes out of the catalogue's own packs
      assert.ok(packedPage.asked.includes('data/etk/packs/index.json'));
      // another host's URL of the same path is not this site's file
      const remote = await fetchPacked(
        'https://example.invalid/data/kfp/families.json'
      );
      assert.strictEqual(remote.ok, false);
      ok(
        'a packed build answers each data file as the file did, and leaves the rest alone'
      );

      const said = [];
      const quiet = console.error;
      console.error = (m) => said.push(String(m));
      try {
        const flipAll = (z) => {
          const raw = unzstd(z);
          for (let at = 40; at < raw.length; at += 400) raw[at] ^= 1;
          return raw;
        };
        const bad = await page(staged, { BMWEB_OFFLINE: true }, flipAll).shim()(
          'data/kfp/12mds45.json'
        );
        assert.strictEqual(bad.ok, false);
      } finally {
        console.error = quiet;
      }
      assert.ok(said.length >= 1);
      ok(
        'a data file that is not what was packed fails the fetch, and says so'
      );
    }

    // ---- the wiring and document archives -----------------------------------
    // The wiring screen is ES modules: its own archive module, with the
    // globals it reads from the classic shell stood in for.
    {
      const folder = (dir) => async (url) => {
        const file = path.join(dir, String(url).replace(/^\/+/, ''));
        return fs.existsSync(file)
          ? new Response(fs.readFileSync(file))
          : new Response(null, { status: 404 });
      };
      Object.assign(globalThis, {
        window: globalThis,
        fflate,
        fzstd: { decompress: unzstd },
        WEB_BASE: '',
        dispChassis: (id) => id,
      });
      for (const f of ['core/packs.js', 'core/webshim/data-fetch.js'])
        vm.runInThisContext(fs.readFileSync(path.join(R, f), 'utf8'), {
          filename: f,
        });
      const { pathToFileURL } = require('url');
      const wiring = await import(
        pathToFileURL(path.join(R, 'screens', 'wiring', 'archive.mjs')).href
      );
      const docsMod = await import(
        pathToFileURL(path.join(R, 'screens', 'wiring', 'docs.mjs')).href
      );
      const read = async (packedBuild) => {
        globalThis.BMWEB_OFFLINE = packedBuild;
        globalThis.webRealFetch = folder(packedBuild ? built : site);
        wiring.WIRING_CACHE.clear();
        const data = await wiring.loadWiring('w1');
        assert.strictEqual(!!data.packed, packedBuild);
        await wiring.wiringNeed(data, ['svg/SP1.svgz', 'doc/SP1.html']);
        await wiring.wiringNeed(data, [
          'svg/D1.svgz',
          'doc/D1.html',
          'img/p.png',
        ]);
        const docs = await wiring.wiringFetchArchive(
          'docs/W1.docs',
          null,
          'no docs'
        );
        await wiring.wiringNeed(docs, ['docs/42.json', 'docs/43.json']);
        return {
          has: await wiring.hasWiring('W1'),
          hasNot: await wiring.wiringDataExists('wiring/NOPE.wiring'),
          tree: data.tree,
          schematic: wiring.wiringDoc(data, 'SP1'),
          description: wiring.wiringDoc(data, 'D1'),
          missing: wiring.wiringDoc(data, 'ZZ'),
          picture: Array.from(data.files.get('img/p.png') || []),
          doc: docsMod.docsDoc(docs, 42),
          noDoc: docsMod.docsDoc(docs, 43),
        };
      };
      const fromPacks = await read(true);
      const fromArchive = await read(false);
      assert.deepStrictEqual(fromPacks, fromArchive);
      assert.strictEqual(fromPacks.schematic.text, svg(11));
      assert.strictEqual(fromPacks.has, true);
      assert.strictEqual(fromPacks.hasNot, false);
      assert.deepStrictEqual(fromPacks.doc, { chapters: [{ title: 'One' }] });
      ok(
        'a packed wiring or document archive gives each document the archive gave'
      );

      // the exporter's archive, made whole again from the packs
      globalThis.BMWEB_OFFLINE = true;
      globalThis.webRealFetch = folder(built);
      const whole = fflate.unzipSync(
        await globalThis.dataPackedFolder('wiring').zip('W1.wiring', fflate)
      );
      assert.deepStrictEqual(
        Object.keys(whole).sort(),
        Object.keys(wiringFiles).sort()
      );
      for (const [name, bytes] of Object.entries(wiringFiles)) {
        const a = name.endsWith('.svgz')
          ? fflate.gunzipSync(whole[name])
          : whole[name];
        const b = name.endsWith('.svgz') ? fflate.gunzipSync(bytes) : bytes;
        assert.ok(Buffer.from(a).equals(Buffer.from(b)), name);
      }
      assert.strictEqual(
        await globalThis.dataPackedFolder('wiring').zip('NOPE.wiring', fflate),
        undefined
      );
      ok('a wiring archive made from the packs holds what the original held');
    }

    // ---- the parts catalogue -------------------------------------------------
    {
      const folderFetch = (dir) => async (url) => {
        const file = path.join(
          dir,
          String(url).split(/[?#]/)[0].replace(/^\/+/, '')
        );
        return fs.existsSync(file) && fs.statSync(file).isFile()
          ? new Response(fs.readFileSync(file))
          : new Response(null, { status: 404 });
      };
      const staged = path.join(tmp, 'staged');
      globalThis.location = {
        href: 'http://bmweb.test/index.html',
        origin: 'http://bmweb.test',
      };
      const { pathToFileURL } = require('url');
      const etkUrl = pathToFileURL(
        path.join(R, 'screens', 'etk', 'data.mjs')
      ).href;
      // one copy of the module per kind of build: each keeps what it loaded
      globalThis.BMWEB_OFFLINE = true;
      globalThis.webRealFetch = folderFetch(staged);
      const packedEtk = await import(`${etkUrl}?packed`);
      const p1 = await packedEtk.loadEtk('k1');
      const p2 = await packedEtk.loadEtk('K2');
      globalThis.BMWEB_OFFLINE = false;
      globalThis.webRealFetch = folderFetch(site);
      const classicEtk = await import(`${etkUrl}?classic`);
      const c1 = await classicEtk.loadEtk('K1');

      assert.deepStrictEqual(p1.tree, c1.tree);
      assert.deepStrictEqual([...p1.images].sort(), [
        '100.jpg',
        '200.png',
        'A b.jpg',
      ]);
      assert.deepStrictEqual([...p2.images], ['100.jpg']);
      // every picture the bundle held is one file, at the address the app
      // gives an <img>, with the bundle's bytes
      for (const [member, bytes] of Object.entries(etkBundles.K1)) {
        if (!member.startsWith('img/')) continue;
        const ref = member.slice(4);
        const url = packedEtk.etkImageUrl(p1, ref);
        assert.ok(
          url && url.startsWith('http://bmweb.test/data/etk/img/'),
          `${ref}: ${url}`
        );
        const onDisk = path.join(
          staged,
          decodeURIComponent(new URL(url).pathname)
        );
        assert.ok(
          Buffer.from(fs.readFileSync(onDisk)).equals(Buffer.from(bytes)),
          ref
        );
        assert.match(classicEtk.etkImageUrl(c1, ref), /^blob:/);
      }
      assert.strictEqual(
        packedEtk.etkImageUrl(p1, '100.jpg'),
        packedEtk.etkImageUrl(p2, '100.jpg'),
        'two cars with the same picture point at two files'
      );
      assert.strictEqual(
        packedEtk.etkImageUrl(p1, 'A b.jpg'),
        'http://bmweb.test/data/etk/img/_/A%20b.jpg'
      );
      // a picture this car's bundle never held is no picture, as before,
      // even though another car's file of that name is on disk
      assert.strictEqual(packedEtk.etkImageUrl(p2, '200.png'), null);
      assert.strictEqual(classicEtk.etkImageUrl(c1, 'nope.jpg'), null);
      assert.strictEqual(packedEtk.etkImageUrl(p1, 'nope.jpg'), null);
      assert.ok(!fs.existsSync(path.join(staged, 'data', 'etk', 'K1.etk')));
      await assert.rejects(packedEtk.loadEtk('ZZ9'), /no parts data/);
      ok(
        'a packed parts catalogue gives each car its tree and each picture once'
      );
    }

    console.log(`test_packs: ${passed} checks passed`);
  })()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
} catch (e) {
  fs.rmSync(tmp, { recursive: true, force: true });
  throw e;
}
