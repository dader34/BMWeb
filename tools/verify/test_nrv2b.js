#!/usr/bin/env node
// The NRV2B codec the fast flasher's payloads travel in
// (app/renderer/core/flash/nrv2b.js). The DME's decoder is proven against
// these streams on the emulator (ms45-emu tools/proofs/nrv2b_emu_test.py);
// what this pins is the app's end:
//   1. The format: a stream the reference (UCL-ported) encoder made still
//      decodes, so the decoder here reads what the DME's does.
//   2. Round trips over the shapes that have their own code paths: empty and
//      tiny inputs, runs, matches around the 0xD00 offset step, a two-byte
//      match past it at the very end (it has no code), random bytes.
//   3. The parse earns its keep: never more than the all-literal stream, and
//      no larger than the greedy-with-lazy parse it replaced on fixed inputs.
//   4. A damaged stream is refused, not decoded into something else.
//
// Run: node tools/verify/test_nrv2b.js
const assert = require('assert');
const { nrv2b } = require('../../app/renderer/core/flash/nrv2b.js');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const hex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
let seed = 45;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 16;
const trip = (plain, what) => {
  const packed = nrv2b.encode(plain);
  assert.deepStrictEqual(
    Buffer.from(nrv2b.decode(packed, plain.length)),
    Buffer.from(plain),
    what
  );
  return packed;
};

// ---- 1. the format ----------------------------------------------------------
const text = Uint8Array.from(
  Buffer.from(
    'the wire is what a flash waits on; the wire is what a flash waits on. '.repeat(
      2
    ) + 'MS45 MS45 MS45'
  )
);
{
  const reference = hex(
    'ff7468652077697265ff2069732077686174ff206120666c617368ff207761697473206f' +
      'ec6e3b2022a9922ead80454f4d5334b23504c0000000000120ff'
  );
  assert.deepStrictEqual(
    Buffer.from(nrv2b.decode(reference, text.length)),
    Buffer.from(text)
  );
  ok('a stream from the reference encoder decodes');
}

// ---- 2. round trips ---------------------------------------------------------
{
  for (let n = 0; n <= 40; n++) {
    trip(new Uint8Array(n), `${n} zeros`);
    trip(
      Uint8Array.from({ length: n }, () => rnd() & 0xff),
      `${n} random`
    );
    trip(
      Uint8Array.from({ length: n }, (_, i) => i & 1),
      `${n} alternating`
    );
  }
  ok('empty and tiny inputs');

  for (const d of [1, 2, 255, 256, 257, 0xcff, 0xd00, 0xd01, 0xd02]) {
    const p = new Uint8Array(4096);
    for (let i = 0; i < p.length; i++)
      p[i] = i >= d && rnd() % 8 ? p[i - d] : rnd() & 0xff;
    trip(p, `repeats ${d} back`);
  }
  ok('matches at every offset class, either side of 0xD00');

  // the last two bytes repeat only what stands 0xD01 back: the format has no
  // code for that match, so they go as literals (a parse that took it for
  // the end of the chunk never finished)
  const p = Uint8Array.from({ length: 0xd01 + 2 }, (_, i) =>
    i < 2 ? 0xa0 + i : (i * 7 + (i >> 8)) & 0x7f
  );
  p.set(p.subarray(0, 2), 0xd01);
  trip(p, 'a two-byte match past 0xD00 at the end');
  ok('a two-byte match past 0xD00 at the very end is not taken');

  trip(new Uint8Array(4096).fill(0xff), 'blank');
  trip(new Uint8Array(140000).fill(0xaa), 'a run longer than any offset');
  ok('runs, to the longest match and past the furthest offset');
}

// ---- 3. the parse ----------------------------------------------------------
{
  // code-like, tables, noise and blank stretches, as a program chunk has
  const firmware = new Uint8Array(4096);
  for (let at = 0; at < firmware.length;) {
    const kind = rnd() % 5;
    const n = Math.min(firmware.length - at, 48 + (rnd() % 400));
    for (let i = 0; i < n; i++)
      firmware[at + i] =
        kind === 0
          ? 0xff
          : kind === 1
            ? [0x7c, 0x08, 0x02, 0xa6, 0x94, 0x21, 0xff, 0xf0][i & 7] ^
              ((i >> 5) & 3)
            : kind === 2
              ? (i * 3) & 0xff
              : kind === 3
                ? rnd() & 0xff
                : (at + i) & 0x3f;
    at += n;
  }
  const noise = Uint8Array.from({ length: 4096 }, () => rnd() & 0xff);
  // EOF is the match flag, ss11(0x1000000) and a byte: 59 bits
  const literal = (n) => Math.ceil((n * 9 + 51) / 8) + 1;
  for (const p of [text, firmware, noise])
    assert(trip(p).length <= literal(p.length), 'no worse than literals');
  ok('never more than the all-literal stream');

  // what the greedy-with-lazy parse (UCL n2b_99, level 9 shape) made of them
  assert(trip(text).length <= 62, `text: ${trip(text).length} bytes`);
  assert(
    trip(firmware).length <= 945,
    `firmware: ${trip(firmware).length} bytes`
  );
  ok('no larger than the parse it replaced');
}

// ---- 4. damage --------------------------------------------------------------
{
  const packed = trip(text);
  assert.throws(() => nrv2b.decode(packed.subarray(0, 20), text.length));
  assert.throws(() => nrv2b.decode(packed, text.length + 400));
  ok('a cut-short stream and a wrong length are refused');
}

console.log(`\n${passed} checks passed`);
