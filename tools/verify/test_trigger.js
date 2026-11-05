#!/usr/bin/env node
// The no-install trigger's wire client (core/flash/trigger.js) against the
// EMU PROOF's exact bytes: the staged image (descriptor, entry branch, dead
// gap, body, relocate stub), the CRC the stock gate validates, the staging
// telegrams' framing, and the fire sequence's request/reply contract.  The
// CHAIN is proven on the emulator (ms45-emu tools/experiments/
// trigger_flasher.py, ALL PASS 2026-11-03 -- fire -> gate -> stub -> the
// body relocated verbatim to 0x3F9800, snapshot-verified); this proves the
// client emits exactly that chain.  No hardware.
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
check('body from blob: 6368 B', body.length === 6368, `${body.length} B`);
check('body from blob: whole words', body.length % 4 === 0);
check(
  'body from blob: starts with the flasher prologue (lis r3,0x3F9800)',
  hex(body.slice(0, 8)) === '3c20003f6021c160',
  hex(body.slice(0, 8))
);

// ---- the image --------------------------------------------------------------
const image = triggerWire.triggerImage(body);
check(
  'image: 6548 B (descriptor 0x70 + entry/gap 68 + body)',
  image.img.length === 6548,
  `${image.img.length} B`
);
check(
  "image: CRC is the emu proof's 0xDED7A639",
  image.crc === 0xded7a639,
  `0x${image.crc.toString(16).toUpperCase()}`
);
check('image: descriptor CRC field', be32(image.img, 0x58) === 0xded7a639);
check(
  'image: range start 0x3FA174 (unaligned field)',
  be32(image.img, 0x5e) === T.D_ENTRY
);
check('image: range end 0x3FBA97', be32(image.img, 0x62) === 0x3fba97);
check(
  'image: version 0x10, first-0xFA gate 1',
  be32(image.img, 0x00) === 0x10 && be32(image.img, 0x48) === 1
);
check(
  'image: the MTOS tag closes the descriptor',
  String.fromCharCode(...image.img.slice(0x66, 0x70)) === '004457MTOS'
);
const entry = be32(image.img, 0x70);
check(
  "image: the entry branch word is the proof's 0x4800192C",
  entry === 0x4800192c,
  `0x${entry.toString(16)}`
);
const gap = image.img.slice(0x74, 0x74 + 0x40);
check(
  'image: the dead gap the branch skips is zero',
  gap.every((x) => x === 0)
);
check(
  "image: the body lands at 0x3FA1B8, the stub's copy source",
  image.img.slice(0x74 + 0x40).length === body.length
);

// ---- the stub ---------------------------------------------------------------
const REF_STUB = [
  0x7cc000a6,
  0x54c6045e,
  0x7cc00124,
  0x4c00012c, // mfmsr/rlwinm/mtmsr/isync: EE off
  0x3c60003f,
  0x6063a1b8, // li32 r3, 0x3FA1B8 (the body)
  0x3c80003f,
  0x60849800, // li32 r4, 0x3F9800  (SRAM)
  0x3ca00000,
  0x60a50638, // li32 r5, 1592      (words)
  0x80c30000,
  0x90c40000,
  0x38630004,
  0x38840004,
  0x34a5ffff, // lwz/stw/addi/addi/addic.
  0x4082ffec, // bne cp
  0x483f9802, // ba 0x3F9800
];
const stub = triggerWire.triggerStub(body.length / 4);
check('stub: the entry branch word', stub.entry === 0x4800192c);
check(
  'stub: 17 words, byte-identical to the proof',
  stub.words.length === 17 && stub.words.every((w, i) => w === REF_STUB[i]),
  stub.words.map((w) => w.toString(16)).join(',')
);
check(
  'stub: the count word tracks the body (r5 = words)',
  (stub.words[9] & 0xffff) === body.length / 4
);
check('image: stub piece is the packed 68 B', image.stub.length === 68);

// ---- the telegrams ----------------------------------------------------------
check(
  'region: the SGBD erase encoding of (0x02040000, 0x8000)',
  JSON.stringify(triggerWire.triggerRegion(T.ERASE_AT, T.ERASE_LEN)) ===
    JSON.stringify([0x04, 0x00, 0x00, 0x02, 0x00, 0x80, 0x00])
);
const tgs = triggerWire.triggerStageTelegrams(
  [image.img, T.DESC],
  [image.stub, T.STUB_AT]
);
check(
  'staging: 28 telegrams (27 image + 1 stub)',
  tgs.length === 28,
  `${tgs.length}`
);
check(
  'staging: every telegram <= 255 B for the length byte',
  tgs.every((t) => t.length <= 255)
);
const first = tgs[0];
check(
  'staging: first chunk heads 0x3FA104 with the 3D framing',
  first[0] === 0x3d &&
    first[1] === 0x3f &&
    first[2] === 0xa1 &&
    first[3] === 0x04 &&
    first[4] === 0x00 &&
    first[5] === 249
);
const last = tgs[27];
check(
  'staging: the stub piece heads 0x3FBAA0, 68 B',
  last[0] === 0x3d &&
    last[1] === 0x3f &&
    last[2] === 0xba &&
    last[3] === 0xa0 &&
    last[4] === 0x00 &&
    last[5] === 68
);
check(
  'staging: the stub piece bytes are the stub',
  hex(last.slice(6)) === hex(image.stub)
);
// the chunks reassemble the pieces: addresses run contiguous within each
let okContig = true;
let ti = 0;
for (const [data, at] of [
  [image.img, T.DESC],
  [image.stub, T.STUB_AT],
]) {
  let expect = at;
  let covered = 0;
  while (covered < data.length) {
    const tg = tgs[ti++];
    const a = (tg[1] << 16) | (tg[2] << 8) | tg[3];
    if (a !== expect) {
      okContig = false;
      break;
    }
    expect += tg[5];
    covered += tg[5];
  }
}
check('staging: chunk addresses walk each piece contiguously', okContig);

// ---- the fire sequence against a mock line ----------------------------------
// The mock validates every request byte-for-byte against what the emu proof
// sends and answers what the stock loader answered there.
const sent = [];
const stages = [];
let tg_i = 0;
const sender = async (data) => {
  sent.push(data);
  const h = hex(data);
  if (data[0] === 0x10 && data[1] === 0x86) {
    check('fire: 10 86, no login, exactly two bytes', data.length === 2);
    return [0x50, 0x86, 0x00, 0x32]; // the emu's positive answer
  }
  if (data[0] === 0x31 && data[1] === 0x02) {
    check(
      'fire: the erase telegram is 31 02 04 00 00 02 00 80 00',
      h === '310204000002008000',
      h
    );
    return [0x71, 0x02, 0x01]; // accepted, job done
  }
  if (data[0] === 0x3d) {
    const want = tgs[tg_i];
    check(
      `fire: staging telegram ${tg_i + 1}/${tgs.length} is the proof's bytes`,
      h === hex(new Uint8Array(want)),
      `${h.slice(0, 20)}..`
    );
    tg_i++;
    return [0x7d];
  }
  if (data[0] === 0x31 && data[1] === 0xfa) {
    check('fire: the fire telegram is 31 FA, exactly', h === '31fa', h);
    return [0x71, 0xfa]; // the arm pass's reply; the fire follows inside the DME
  }
  throw new Error(`mock: unexpected request ${h}`);
};

let error = null;
let progressed = [];

(async () => {
  try {
    const r = await triggerWire.triggerFire(sender, body, {
      markers: { unlocked: true },
      stage: (s) => stages.push(s),
      note: () => {},
      progress: (n, total) => progressed.push([n, total]),
    });
    check('fire: returns the arm reply', hex(r.replied) === '71fa');
  } catch (e) {
    error = e;
  }
  check('fire: the sequence completes', !error, error && error.message);
  check(
    "fire: 1 + 1 + 28 + 1 wire requests in the proof's order",
    sent.length === 31 &&
      sent[0][0] === 0x10 &&
      sent[1][0] === 0x31 &&
      sent[2][0] === 0x3d &&
      sent[30][1] === 0xfa,
    `${sent.length}`
  );
  check(
    'fire: progress walked every chunk',
    progressed.length === 28 &&
      progressed[27][0] === 28 &&
      progressed[27][1] === 28
  );

  // the refused-marker gate: nothing at all goes out
  let refused = null;
  const silent = async () => null;
  try {
    await triggerWire.triggerFire(silent, body, {
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

  // a refused erase stops the chain with the DME's own words
  let nrc = null;
  const refusing = async (data) => {
    if (data[0] === 0x10) return [0x50, 0x86, 0x00, 0x32];
    if (data[0] === 0x31 && data[1] === 0x02) return [0x7f, 0x31, 0x02, 0x22];
    return null;
  };
  try {
    await triggerWire.triggerFire(refusing, body, {});
  } catch (e) {
    nrc = e;
  }
  check(
    'refusal: an erase NRC stops the chain, decoded',
    !!nrc && /erase was not accepted.*conditions not met/.test(nrc.message),
    nrc && nrc.message
  );

  console.log(failures ? `\nFAILED: ${failures}` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
