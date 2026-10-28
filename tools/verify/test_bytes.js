// core/bytes: the shared byte helpers, against known vectors and against the
// copies they replace (ms45.js keeps its own CRC; the two must agree).
//
// Run: node tools/verify/test_bytes.js
const assert = require('assert');
const B = require('../../app/renderer/core/bytes/index.mjs');

global.Settings = { get: () => 'no' };
const { ms45Crc32 } = require('../../app/renderer/core/ms45/ms45.js');

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ok    ${name}`);
};
const enc = (s) => new TextEncoder().encode(s);

// the check value every CRC catalogue lists for "123456789"
assert.strictEqual(B.crc32Mpeg2(enc('123456789')), 0x0376e6e7);
ok('CRC-32/MPEG-2 check value');
assert.strictEqual(B.crc32Zlib(enc('123456789')), 0xcbf43926);
ok('CRC-32 (zlib) check value');
assert.strictEqual(B.crc32Zlib([enc('1234'), enc('56789')]), 0xcbf43926);
ok('zlib CRC over several spans equals one span');
assert.strictEqual(B.crc32Zlib(new Uint8Array(0)), 0);
ok('zlib CRC of nothing is 0');

// random spans: the module's MPEG-2 and ms45.js's agree, with any initial
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
for (let t = 0; t < 20; t++) {
  const len = 1 + (rnd() % 300);
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = rnd();
  const init = t % 2 ? 0xffffffff : (rnd() << 24) | (rnd() << 8) | rnd();
  assert.strictEqual(B.crc32Mpeg2(b, init), ms45Crc32(b, init), `span ${t}`);
}
ok('MPEG-2 CRC agrees with ms45Crc32 on 20 random spans');
assert.strictEqual(
  B.crc32Mpeg2(enc('123456789')),
  B.crc32Mpeg2(enc('56789'), B.crc32Mpeg2(enc('1234'))),
  'continued'
);
ok('MPEG-2 CRC continues from a running value');

const buf = new Uint8Array(8);
B.putBe32(buf, 2, 0xdeadbeef);
assert.deepStrictEqual([...buf], [0, 0, 0xde, 0xad, 0xbe, 0xef, 0, 0]);
assert.strictEqual(B.be32(buf, 2), 0xdeadbeef);
assert.strictEqual(
  B.be32(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 0),
  0xffffffff
);
ok('be32 / putBe32 round-trip, unsigned at the top bit');

assert.deepStrictEqual([...B.hexToBytes('00ff10a5')], [0, 0xff, 0x10, 0xa5]);
assert.strictEqual(
  B.bytesToHex(new Uint8Array([0, 0xff, 0x10, 0xa5])),
  '00ff10a5'
);
assert.strictEqual(B.hexToBytes('').length, 0);
ok('hex both ways');

console.log(`${passed} checks passed`);
