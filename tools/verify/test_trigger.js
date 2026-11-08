#!/usr/bin/env node
// The no-install trigger's wire client (core/flash/trigger.js) against the
// EMU PROOF's exact bytes: the staged image (descriptor, entry branch, dead
// gap), the two-stage receiver, the upload frame, the staging telegrams'
// framing, and the fire sequence's request/reply contract (the refused
// 31 02 write enable included). The two-stage chain is proven on the
// emulator with the real login on loaders A, B and C (2026-11-05); this
// proves the client emits exactly that chain.  No hardware.
//
//   node tools/verify/test_trigger.js
if (typeof global.window === 'undefined') global.window = {};
const { triggerWire } = require('../../app/renderer/core/flash/trigger.js');
const {
  fastFlasherBlob,
} = require('../../app/renderer/core/generated/fast-flasher-blob.js');

const T = triggerWire.TRIGGER;
const be32 = (b, at) =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const hex = (b) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}${detail ? ' -- ' + detail : ''}`);
  } else console.log(`  ok    ${what}`);
};

// ---- the body out of the bootstrap blob ------------------------------------
const body = triggerWire.triggerBodyFromBlob(fastFlasherBlob);
check('body from blob: 7444 B (v24)', body.length === 7444, `${body.length} B`);
check('body from blob: whole words', body.length % 4 === 0);
check(
  'body from blob: starts with the flasher prologue (lis r3,0x3F9800)',
  hex(body.slice(0, 8)) === '3c20003f6021c310',
  hex(body.slice(0, 8))
);

const sha1 = (b) =>
  require('crypto').createHash('sha1').update(Buffer.from(b)).digest('hex');

// The reference values come from ms45-emu (tools/build/trigger_receiver.py
// + the descriptor the two-stage emu proof staged), which passed the real
// login chain on loaders A, B and C on 2026-11-05.
check(
  'body: byte-identical to the emu proof body',
  sha1(body) === '6019774cbf7ab23046fbde547fdf1de26dd689a1',
  sha1(body)
);

// ---- the image --------------------------------------------------------------
const image = triggerWire.triggerImage(body);
check(
  'image: 180 B (descriptor 0x70 + entry branch + 0x40 gap)',
  image.img.length === 180,
  `${image.img.length} B`
);
check(
  "image: CRC is the emu proof's 0xCDBC4652",
  image.crc === 0xcdbc4652,
  `0x${image.crc.toString(16).toUpperCase()}`
);
check('image: descriptor CRC field', be32(image.img, 0x58) === image.crc);
check(
  'image: range start 0x3FA174 (unaligned field)',
  be32(image.img, 0x5e) === T.D_ENTRY
);
check('image: range end 0x3FA1B7', be32(image.img, 0x62) === 0x3fa1b7);
check(
  'image: version 0x10, first-0xFA gate 1',
  be32(image.img, 0x00) === 0x10 && be32(image.img, 0x48) === 1
);
check(
  'image: the MTOS tag closes the descriptor',
  String.fromCharCode(...image.img.slice(0x66, 0x70)) === '004457MTOS'
);
check(
  'image: the entry branch word is b 0x3FBAA0 (0x4800192C)',
  be32(image.img, 0x70) === 0x4800192c
);
check(
  'image: the dead gap the branch skips is zero',
  image.img.slice(0x74, 0x74 + 0x40).every((x) => x === 0)
);
check(
  'image: byte-identical to the emu proof',
  sha1(image.img) === '3c6138268150bd3f475bfe403f416230a1f97bf7'
);

// ---- the receiver -----------------------------------------------------------
check('receiver: 82 words, 328 B', image.stub.length === 328);
check(
  'receiver: byte-identical to trigger_receiver.py',
  sha1(image.stub) === 'e465aff66d9b4ababe107df99e1839451666f90d'
);
check(
  'receiver: ends below the pool end 0x3FC003',
  T.STUB_AT + image.stub.length - 1 <= T.POOL_END
);
check(
  'receiver: the body fits below it',
  T.SRAM_BASE + body.length <= T.STUB_AT
);

// ---- the upload -------------------------------------------------------------
const up = triggerWire.triggerUploadFrame(body);
check(
  'upload: A5 5A, length 0x1D14, body, sum (7450 B)',
  hex(up.slice(0, 4)) === 'a55a1d14' &&
    up.length === 7450 &&
    hex(up.slice(4, 4 + body.length)) === hex(body)
);
check('upload: the sum of the emu proof body', hex(up.slice(-2)) === '0150');

// ---- the telegrams ----------------------------------------------------------
check(
  'region: the SGBD encoding of the write enable (0x3F9800, 0x80)',
  JSON.stringify(triggerWire.triggerRegion(T.ENABLE_AT, T.ENABLE_LEN)) ===
    JSON.stringify([0x3f, 0x98, 0x00, 0x00, 0x00, 0x00, 0x80])
);
const tgs = triggerWire.triggerStageTelegrams(
  [image.img, T.DESC],
  [image.stub, T.STUB_AT]
);
check(
  'staging: 3 telegrams (1 image + 2 receiver)',
  tgs.length === 3,
  `${tgs.length}`
);
check(
  'staging: every telegram <= 255 B for the length byte',
  tgs.every((t) => t.length <= 255)
);
check(
  'staging: first chunk heads 0x3FA104 with the 3D framing, 180 B',
  hex(tgs[0].slice(0, 6)) === '3d3fa1040' + '0b4'
);
check(
  'staging: the receiver heads 0x3FBAA0',
  hex(tgs[1].slice(0, 6)) === '3d3fbaa000f9' &&
    hex(tgs[2].slice(0, 4)) === '3d3fbb99'
);

// ---- the fire sequence against a mock line ----------------------------------
const sent = [];
let tg_i = 0;
const sender = async (data) => {
  sent.push(data);
  const h = hex(data);
  if (data[0] === 0x10 && data[1] === 0x86) {
    check('fire: 10 86, no login, exactly two bytes', data.length === 2);
    return [0x50, 0x86, 0x00, 0x32];
  }
  if (data[0] === 0x31 && data[1] === 0x02) {
    check(
      'fire: the write enable is 31 02 3f 98 00 00 00 00 80',
      h === '31023f980000000080',
      h
    );
    return [0x7f, 0x31, 0x22]; // refused: the write enable, nothing erased
  }
  if (data[0] === 0x3d) {
    const want = tgs[tg_i];
    check(
      `fire: staging telegram ${tg_i + 1}/${tgs.length} is the proof's bytes`,
      h === hex(new Uint8Array(want))
    );
    tg_i++;
    return [0x7d];
  }
  if (data[0] === 0x31 && data[1] === 0xfa) return [0x71, 0xfa];
  throw new Error(`mock: unexpected request ${h}`);
};

let error = null;
const progressed = [];

(async () => {
  try {
    await triggerWire.triggerFire(sender, body, {
      markers: { unlocked: true },
      stage: () => {},
      note: () => {},
      progress: (n, total) => progressed.push([n, total]),
    });
  } catch (e) {
    error = e;
  }
  check('fire: the sequence completes', !error, error && error.message);
  check(
    "fire: 10 86, 31 02, 3 x 3D, arm, fire in the proof's order",
    sent.length === 7 &&
      sent[0][0] === 0x10 &&
      sent[1][1] === 0x02 &&
      sent[2][0] === 0x3d &&
      sent[4][0] === 0x3d &&
      sent[5][1] === 0xfa &&
      sent[6][1] === 0xfa,
    `${sent.length}`
  );
  check(
    'fire: progress walked every chunk',
    progressed.length === 3 && progressed[2][0] === 3 && progressed[2][1] === 3
  );

  // the refused-marker gate: nothing at all goes out
  let refused = null;
  try {
    await triggerWire.triggerFire(async () => null, body, {
      markers: { unlocked: false },
    });
  } catch (e) {
    refused = e;
  }
  check(
    'gate: a locked DME refuses before the session opens',
    !!refused && /stock boot markers/.test(refused.message),
    refused && refused.message
  );

  // anything but 7F 31 22 to the write enable stops the chain before staging
  for (const [what, reply] of [
    ['an accepted erase (71 02 01)', [0x71, 0x02, 0x01]],
    ['a different NRC (7F 31 12)', [0x7f, 0x31, 0x12]],
    ['silence', null],
  ]) {
    let err = null;
    const staged = [];
    const odd = async (data) => {
      if (data[0] === 0x10) return [0x50, 0x86, 0x00, 0x32];
      if (data[0] === 0x31 && data[1] === 0x02) return reply;
      staged.push(data);
      return [0x7d];
    };
    try {
      await triggerWire.triggerFire(odd, body, {});
    } catch (e) {
      err = e;
    }
    check(
      `write enable: ${what} stops the chain, nothing staged`,
      !!err &&
        /write enable was not answered/.test(err.message) &&
        !staged.length,
      err && err.message
    );
  }

  console.log(failures ? `\nFAILED: ${failures}` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
