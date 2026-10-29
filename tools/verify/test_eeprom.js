#!/usr/bin/env node
// The DME-side of the ISN/EWS matcher (core/flash/eeprom.js) against a
// mock fast-flash wire: the 4 KB dump rides offset bit 30 through the
// client's read() untouched, a page at a time, and the scan helpers see
// the 3-copy redundancy the stored-data blocks use (docs/EWS-ISN.md).
// No hardware.
//
//   node tools/verify/test_eeprom.js
if (typeof global.window === 'undefined') global.window = {};
const { eepromDump } = require('../../app/renderer/core/flash/eeprom.js');

let failures = 0;
const check = (what, ok) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}`);
  } else console.log(`  ok    ${what}`);
};

/** The mock car's ISN: what its EWS holds, and what the dump keeps three
 *  times (straight / inverted / straight). */
const OLD_ISN = [0x2f, 0x7f, 0xa3, 0x5c];

/** A mock part plus the wire client the v15 body serves: read(off, len)
 *  and call(0x0B, payload) both carry the bit-30 window and the 16-bit
 *  address exactly as given; write refusals mirror the module's. */
function mockPart() {
  // blank, then a block that keeps the ISN three times the way task10
  // restores it: straight, inverted (a 16-bit word at a time), straight
  const img = new Uint8Array(eepromDump.SIZE).fill(0xff);
  const put = (at, bytes) => bytes.forEach((b, i) => (img[at + i] = b));
  put(0x003a, OLD_ISN);
  put(0x0040, eepromDump.invBytes(OLD_ISN));
  put(0x0046, OLD_ISN);
  for (let i = 0x100; i < 0x180; i++) img[i] = i & 0xff; // a dense block
  const reads = [];
  const writes = [];
  const client = {
    async read(off, len) {
      const window = off >>> 31 !== 1 && (off & 0x40000000) !== 0;
      if (!window)
        throw new Error(`a plain flash read reached the EEPROM mock: ${off}`);
      const at = off & 0xffff;
      if (len > eepromDump.PAGE)
        throw new Error(`over the body's page cap: ${len}`);
      reads.push({ at, len });
      return img.slice(at, at + len);
    },
    async call(svc, data) {
      if (svc !== eepromDump.WRITE_SVC) throw new Error(`mock: service ${svc}`);
      const off =
        ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
      if ((off & eepromDump.WINDOW) === 0)
        throw new Error(`write without the window bit: ${off}`);
      const at = off & 0xffff;
      const len = (data[4] << 8) | data[5];
      if (len < 1 || len > eepromDump.WRITE_MAX)
        throw new Error(`write of ${len} bytes: the module refuses`);
      if (at + len > eepromDump.SIZE)
        throw new Error(`write past the part's end`);
      if ((at % 32) + len > 32)
        throw new Error(`write across the 32-byte page`);
      writes.push({ at, len });
      img.set(data.slice(6, 6 + len), at);
      return new Uint8Array(0); // the ACK's payload
    },
  };
  return { client, img, reads, writes };
}

const main = async () => {
  // the dump: one page read (the part is 4 KB), its offset masked with the window
  {
    const { client, img, reads } = mockPart();
    const progress = [];
    const got = await eepromDump.dump(client, {
      progress: (d) => progress.push(d),
    });
    check(
      'dump: byte-exact over the whole 4 KB',
      Buffer.from(got).equals(Buffer.from(img.subarray(0, eepromDump.SIZE)))
    );
    check(
      'dump: one read of a page, in the bit-30 window',
      reads.length === eepromDump.SIZE / eepromDump.PAGE &&
        reads.every(
          (r) => r.len === eepromDump.PAGE && r.at % eepromDump.PAGE === 0
        )
    );
    check(
      'dump: progress ticks once a page',
      progress.length === 1 && progress[0] === eepromDump.SIZE
    );
  }

  // the window constant the page offsets are built from
  check('the window is offset bit 30', eepromDump.WINDOW === 0x40000000);

  // the scan: the ISN shows where the vault keeps it, thrice
  {
    const { client } = mockPart();
    const img = await eepromDump.dump(client);
    const hits = eepromDump.scan16(img, 0x2f7f);
    check(
      'scan: both straight copies of the ISN found',
      hits.length === 2 && hits[0] === 0x3a && hits[1] === 0x46
    );
    const inverted = eepromDump.scan16(img, eepromDump.inv16(0x2f7f));
    check(
      'scan: the inverted middle copy is the complement',
      inverted.length === 1 && inverted[0] === 0x40
    );
  }

  // the block map: blank spans separate the blocks, heads come along
  {
    const { client } = mockPart();
    const img = await eepromDump.dump(client);
    const blocks = eepromDump.blockMap(img);
    const small = blocks.find((b) => b.at === 0x3a);
    const dense = blocks.find((b) => b.at === 0x100);
    check(
      'blocks: the stored-data block and the dense block, nothing else',
      blocks.length === 2 && !!small && !!dense
    );
    check(
      'blocks: ends trimmed at the last non-blank byte',
      small.end === 0x4a && dense.end === 0x180
    );
    check(
      'blocks: the head bytes travel with the map',
      dense.head[0] === 0x00 && dense.head[1] === 0x01
    );
  }

  // the write: one verified op, the module's rules enforced client-side
  {
    const { client, writes } = mockPart();
    await eepromDump.write(client, 0x003a, OLD_ISN);
    check(
      'write: one op reached the part',
      writes.length === 1 && writes[0].at === 0x3a && writes[0].len === 4
    );
    check('write: the readback verified (promise resolved)', true);
    const rejects = [
      ['zero bytes', 0x50, []],
      ['over the one-queue cap', 0x50, new Array(26).fill(1)],
      ['past the part', 0xfffe, [1, 2, 3, 4]],
      ['across the 32-byte page', 0x1e, [1, 2, 3, 4]],
    ];
    let thrown = 0;
    for (const [what, at, bytes] of rejects) {
      try {
        await eepromDump.write(client, at, bytes);
      } catch (e) {
        thrown++;
        continue;
      }
      console.log(`  FAIL  write: ${what} did not throw`);
      failures++;
    }
    check(
      'write: every rule refusal throws client-side',
      thrown === rejects.length
    );
    check('write: refusals never reached the part', writes.length === 1);
  }

  // the readback is a check, not a formality: a part that lies fails the promise
  {
    const { client } = mockPart();
    const honestRead = client.read.bind(client);
    client.read = async (off, len) => {
      const back = await honestRead(off, len);
      back[0] ^= 0xff; // the write "took", the read says otherwise
      return back;
    };
    try {
      await eepromDump.write(client, 0x003a, OLD_ISN);
      console.log('  FAIL  write: a mismatched readback resolved');
      failures++;
    } catch (e) {
      check(
        'write: a mismatched readback fails the write',
        /read back/.test(e.message)
      );
    }
  }

  // the ISN rewrite: dump, find the three copies, retarget them, re-dump
  {
    const { client } = mockPart();
    const img = await eepromDump.dump(client);
    const ops = eepromDump.isnWrites(img, OLD_ISN, [0x11, 0x22, 0x33, 0x44]);
    check(
      'isn: three ops, votes in place (straight 0x3a/0x46, inverted 0x40)',
      ops.length === 3 &&
        ops[0].at === 0x3a &&
        ops[0].vote === 'straight' &&
        ops[1].at === 0x40 &&
        ops[1].vote === 'inverted' &&
        ops[2].at === 0x46 &&
        ops[2].vote === 'straight'
    );
    const ticks = [];
    await eepromDump.applyWrites(client, ops, {
      progress: (d, t) => ticks.push([d, t]),
    });
    const after = await eepromDump.dump(client);
    check(
      'isn: the new ISN sits where the old did, thrice',
      eepromDump.findRuns(after, [0x11, 0x22, 0x33, 0x44]).join() === '58,70' &&
        eepromDump.findRuns(after, [0xee, 0xdd, 0xcc, 0xbb]).join() === '64'
    );
    check(
      'isn: no byte of the old ISN survives',
      eepromDump.findRuns(after, OLD_ISN).length === 0
    );
    check(
      'isn: progress ticks once an op',
      ticks.length === 3 && ticks[2][0] === 3 && ticks[2][1] === 3
    );
  }

  // an ISN the dump does not hold: no ops, never a write blind
  {
    const { client, writes } = mockPart();
    const img = await eepromDump.dump(client);
    const ops = eepromDump.isnWrites(
      img,
      [0xde, 0xad, 0xbe, 0xef],
      [1, 2, 3, 4]
    );
    check('isn: a dump without the old ISN yields no ops', ops.length === 0);
    check('isn: nothing was written', writes.length === 0);
  }

  if (failures) {
    console.log(`${failures} FAILURES`);
    process.exit(1);
  }
  console.log('ALL OK');
};

main().catch((e) => {
  console.log(`FAILED: ${e.message}`);
  process.exit(1);
});
