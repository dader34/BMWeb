#!/usr/bin/env node
// The zstd decoder the app ships (app/renderer/vendor/fzstd.js) against the
// reference one built into Node, on the kind of frames BMWeb's packs are:
// level 19, long-distance matching, a 32 MB window.
//
//   node tools/verify/test_fzstd.js
//   SPDATEN_PACKED=~/.../sp-daten-packed node tools/verify/test_fzstd.js
//
// WHY THIS EXISTS. fzstd reads a match offset through 32 bits and decodes an
// offset of 64 MB or more WRONG, with no error (seen on real data packed
// with --long=27). The packs keep every offset under that with a 2^25
// window. This test is what says the decoder is right INSIDE that limit:
// it builds data whose matches reach back almost the whole window and
// compares fzstd's output with the original, byte for byte.
//
// With SPDATEN_PACKED set it also reads every file of every pack in that
// folder through the app's own reader and fzstd, which checks each file's
// length and CRC-32.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..');
const R = path.join(ROOT, 'app', 'renderer');
let passed = 0;
const ok = (m) => {
  passed++;
  if (process.env.V) console.log('  ok', m);
};

if (typeof zlib.zstdCompressSync !== 'function') {
  console.log('test_fzstd: this Node has no zstd; skipped');
  process.exit(0);
}
const fzstd = require(path.join(R, 'vendor', 'fzstd.js'));
const daten = require(path.join(R, 'core', 'kfp', 'daten.js'));
const C = zlib.constants;

// a small deterministic generator, so a failure can be reproduced
let seed = 0x2545f491;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
const noise = (n) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = rnd() & 0xff;
  return b;
};
const text = (n) => {
  const words = [
    '{"op":"const","n":',
    ',"t":"i","v":',
    ',"at":',
    '},',
    '["move",[[1,"S1"],[8,0]]],',
  ];
  const parts = [];
  let len = 0;
  while (len < n) {
    const w = words[rnd() % words.length] + (rnd() % 5000);
    parts.push(w);
    len += w.length;
  }
  return Buffer.from(parts.join('')).subarray(0, n);
};

const WINDOW_LOG = 25;
const pack = (data, level = 19) =>
  new Uint8Array(
    zlib.zstdCompressSync(data, {
      params: {
        [C.ZSTD_c_compressionLevel]: level,
        [C.ZSTD_c_enableLongDistanceMatching]: 1,
        [C.ZSTD_c_windowLog]: WINDOW_LOG,
      },
    })
  );
const same = (a, b) =>
  a.length === b.length &&
  Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), b) === 0;

const cases = {
  'text that repeats': text(6 << 20),
  'incompressible bytes': noise(3 << 20),
  'one byte, many times': Buffer.alloc(5 << 20, 0x5a),
  empty: Buffer.alloc(0),
};
// matches that reach back nearly the whole 32 MB window: a block, then
// filler up to just under 2^25, then the block again (twice, so that the
// second copy is also found at the limit, and once shifted by one byte)
{
  const block = noise(1 << 20);
  const gap = (1 << WINDOW_LOG) - block.length - 4096;
  cases['a match almost a window back'] = Buffer.concat([
    block,
    text(gap),
    block,
    Buffer.from([7]),
    text(gap - 1),
    block,
  ]);
}
// two "versions" of an image, the second with bytes inserted near its start
{
  const image = noise(8 << 20);
  cases['a version shifted against the last'] = Buffer.concat([
    image,
    image.subarray(0, 1000),
    noise(37),
    image.subarray(1000),
  ]);
}
for (const [what, data] of Object.entries(cases)) {
  for (const level of [3, 19]) {
    const z = pack(data, level);
    const ref = zlib.zstdDecompressSync(z, { maxOutputLength: 2 ** 31 - 1 });
    assert.ok(ref.equals(data), `${what}: the reference decoder disagrees?`);
    const got = fzstd.decompress(z);
    assert.ok(
      same(got, data),
      `fzstd got "${what}" wrong at level ${level} ` +
        `(${data.length} bytes in, ${got.length} out)`
    );
  }
  ok(`fzstd unpacks ${what}`);
}

const dir = process.env.SPDATEN_PACKED;
if (dir) {
  const index = JSON.parse(
    fs.readFileSync(path.join(dir, 'index.json'), 'utf8')
  );
  let files = 0;
  let bytes = 0;
  index.packs.forEach((name, n) => {
    const opened = daten.openPack(
      new Uint8Array(fs.readFileSync(path.join(dir, 'packs', name))),
      fzstd.decompress
    );
    // read() throws on a file whose length or CRC-32 is not the packed one
    opened.files.forEach((f, place) => {
      bytes += opened.read(place).bytes.length;
      files++;
    });
    if (process.env.V && n % 50 === 0)
      console.log(`  ${n}/${index.packs.length} packs`);
  });
  ok(`every file of every pack in ${dir} reads back whole`);
  console.log(
    `  ${index.packs.length} packs, ${files} files, ${(bytes / 1e9).toFixed(2)} GB checked`
  );
}

console.log(`test_fzstd: ${passed} checks passed`);
