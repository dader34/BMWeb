#!/usr/bin/env node
// The ISN/EWS matcher's pairing logic (core/flash/isn-pairing.js) against
// the mock part and the mock EWS: the voting-triple finder, the match
// state over a dump, and both alignment flows end to end --
//   DME <- EWS: the used DME's triple rewritten to the car's ISN, votes
//     preserved, each write verified by readback (test_eeprom.js's mock
//     client carries that contract),
//   EWS <- DME: a blank EWS takes the DME's ISN through the factory job
//     (the test_ews.js mock's dialect), then the rolling-code sync.
// No hardware; the DME-side wire protocol itself is proven on the
// emulator (ms45-emu tools/proofs/ee_write_test.py, eeprom_dump_test.py).
//
//   node tools/verify/test_pairing.js
if (typeof global.window === 'undefined') global.window = {};
const { isnPair } = require('../../app/renderer/core/flash/isn-pairing.js');
const { eepromDump } = require('../../app/renderer/core/flash/eeprom.js');
const { ewsTalk } = require('../../app/renderer/core/flash/ews.js');

let failures = 0;
const check = (what, ok) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}`);
  } else console.log(`  ok    ${what}`);
};

/** The donor DME's ISN (what its own car's EWS held) and this car's. */
const DONOR_ISN = 0x2f7f;
const CAR_ISN = 0x1111;

/**
 * A mock part like test_eeprom.js's, shaped for the pairing story: the
 * ISN kept as a 16-bit voting triple, another voting field beside it (a
 * stored-data block holds several), an INCIDENTAL occurrence of the ISN
 * far away (another block's data -- not the ISN, must never be touched),
 * and the wire client with the v15 write contract.
 */
function mockPart() {
  const img = new Uint8Array(eepromDump.SIZE).fill(0xff);
  const put16 = (at, v) => {
    img[at] = (v >> 8) & 0xff;
    img[at + 1] = v & 0xff;
  };
  put16(0x003a, DONOR_ISN); // the ISN: straight ...
  put16(0x0040, eepromDump.inv16(DONOR_ISN)); // inverted ...
  put16(0x0046, DONOR_ISN); // straight
  put16(0x0050, 0xa55a); // another voting field (not the ISN)
  put16(0x0056, eepromDump.inv16(0xa55a));
  put16(0x005c, 0xa55a);
  put16(0x0800, DONOR_ISN); // an incidental occurrence: no vote, not the ISN
  for (let i = 0x100; i < 0x180; i++) img[i] = i & 0xff; // a dense block
  const writes = [];
  const client = {
    async read(off, len) {
      if ((off & eepromDump.WINDOW) === 0)
        throw new Error(`a plain flash read reached the EEPROM mock: ${off}`);
      const at = off & 0xffff;
      if (len > eepromDump.PAGE)
        throw new Error(`over the body's page cap: ${len}`);
      return img.slice(at, at + len);
    },
    async call(svc, data) {
      if (svc !== eepromDump.WRITE_SVC) throw new Error(`mock: service ${svc}`);
      const off =
        ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
      const at = off & 0xffff;
      const len = (data[4] << 8) | data[5];
      if (len < 1 || len > eepromDump.WRITE_MAX)
        throw new Error(`write of ${len} bytes`);
      if ((at % 32) + len > 32)
        throw new Error('write across the 32-byte page');
      writes.push(at);
      img.set(data.slice(6, 6 + len), at);
      return new Uint8Array(0);
    },
  };
  return { client, img, writes };
}

/** The mock EWS3 of test_ews.js's dialect, this car's ISN inside. */
function mockEws(isn) {
  const state = { isn, writes: 0, synced: [] };
  const xor = (f) => f.reduce((a, b) => a ^ b, 0);
  const frame = (payload) => {
    const f = [ewsTalk.ADDR, payload.length + 3, ...payload];
    f.push(xor(f));
    return f;
  };
  const sess = {
    async transfer(addr, payload) {
      if (addr !== ewsTalk.ADDR) throw new Error(`not the EWS: ${addr}`);
      const job = payload[0];
      if (job === ewsTalk.JOB.READ_ISN)
        return frame([0xa0, (state.isn >> 8) & 0xff, state.isn & 0xff]);
      if (job === ewsTalk.JOB.WRITE_ISN) {
        state.writes++;
        state.isn = ((payload[1] & 0xff) << 8) | (payload[2] & 0xff);
        return frame([0xa0]);
      }
      if (job === ewsTalk.JOB.SYNC) {
        state.synced.push('67');
        return frame([0xa0]);
      }
      throw new Error(`the mock does not know job ${job}`);
    },
  };
  return { sess, state };
}

const main = async () => {
  // the finder: the two voting fields, their strides measured, no noise
  {
    const { img } = mockPart();
    const t = isnPair.votingTriples(img);
    const byVal = Object.fromEntries(t.map((x) => [x.val, x]));
    const isn = byVal[DONOR_ISN];
    const other = byVal[0xa55a];
    check(
      'finder: both voting fields found, strides measured off the data',
      t.length === 2 &&
        isn &&
        isn.at === 0x3a &&
        isn.inverted === 0x40 &&
        isn.straight[1] === 0x46 &&
        other &&
        other.at === 0x50 &&
        other.inverted === 0x56 &&
        other.straight[1] === 0x5c
    );
    check(
      'finder: the incidental occurrence is not a field (no vote, no claim)',
      !t.some((x) => x.at === 0x800 || x.straight[1] === 0x802)
    );
  }

  // the match state: agreement, disagreement, and not-yet
  {
    const { img } = mockPart();
    const m = isnPair.matchState(img, DONOR_ISN);
    check(
      "match: the EWS ISN is the dump's voting value",
      m.state === 'match' && m.triple.at === 0x3a && m.others.length === 1
    );
    const x = isnPair.matchState(img, CAR_ISN);
    check(
      'mismatch: the other voting fields are listed for the picker',
      x.state === 'mismatch' &&
        x.triple === null &&
        x.others.length === 2 &&
        /2F7F/.test(x.text) &&
        /A55A/.test(x.text)
    );
    const u = isnPair.matchState(null, CAR_ISN);
    check('unknown: one side not read yet', u.state === 'unknown');
  }

  // the ops: three words, votes preserved, the triple's addresses only
  {
    const { img, writes } = mockPart();
    const triple = isnPair.votingTriples(img).find((t) => t.val === DONOR_ISN);
    const ops = isnPair.tripleOps(triple, CAR_ISN);
    check(
      'ops: straight/inverted/straight at the measured addresses',
      ops.length === 3 &&
        ops[0].at === 0x3a &&
        ops[0].vote === 'straight' &&
        ops[1].at === 0x40 &&
        ops[1].vote === 'inverted' &&
        ops[2].at === 0x46 &&
        ops[2].vote === 'straight'
    );
    check(
      'ops: the inverted word is the complement, the straights the value',
      ops[0].bytes[0] === 0x11 &&
        ops[0].bytes[1] === 0x11 &&
        ops[1].bytes[0] === 0xee &&
        ops[1].bytes[1] === 0xee
    );
    check(
      "ops: every write is two bytes inside one page (the module's rules)",
      ops.every((o) => o.bytes.length === 2 && (o.at % 32) + 2 <= 32)
    );
  }

  // ---- the used-DME repair: DME <- EWS, end to end -----------------------
  {
    const { client, writes } = mockPart();
    const ews = mockEws(CAR_ISN); // this car's EWS
    const dump = await eepromDump.dump(client);
    const ewsIsn = (await ewsTalk.readIsn(ews.sess)).isn;
    let m = isnPair.matchState(dump, ewsIsn);
    check(
      'flow DME<-EWS: starts a mismatch (the donor DME)',
      m.state === 'mismatch'
    );
    // the operator picks the donor's ISN triple (the one that is not
    // another car's data -- here the ISN-sized field, 0x2F7F)
    const pick = m.others.find((t) => t.val === DONOR_ISN);
    check('flow DME<-EWS: the donor ISN is among the candidates', !!pick);
    const ops = isnPair.tripleOps(pick, ewsIsn);
    await eepromDump.applyWrites(client, ops);
    check(
      "flow DME<-EWS: three verified writes, the triple's addresses only",
      writes.length === 3 && writes.join() === '58,64,70'
    );
    const after = await eepromDump.dump(client);
    m = isnPair.matchState(after, ewsIsn);
    check(
      "flow DME<-EWS: the re-dump votes the car's ISN, match",
      m.state === 'match' && m.triple.at === 0x3a
    );
    check(
      'flow DME<-EWS: the other field and the incidental copy untouched',
      isnPair
        .votingTriples(after)
        .some((t) => t.val === 0xa55a && t.at === 0x50) &&
        after[0x800] === DONOR_ISN >> 8 &&
        after[0x801] === (DONOR_ISN & 0xff)
    );
  }

  // ---- the blank-EWS repair: EWS <- DME, end to end ----------------------
  {
    const { client } = mockPart();
    const ews = mockEws(0x0000); // a blank EWS holds zeros
    const dump = await eepromDump.dump(client);
    const triple = isnPair.votingTriples(dump).find((t) => t.val === DONOR_ISN);
    const { verified } = await ewsTalk.writeIsn(ews.sess, triple.val);
    const steps = await ewsTalk.syncDme(ews.sess);
    const ewsIsn = (await ewsTalk.readIsn(ews.sess)).isn;
    check(
      "flow EWS<-DME: the factory job took the DME's ISN and verified",
      verified && ews.state.writes === 1 && ewsIsn === DONOR_ISN
    );
    check(
      'flow EWS<-DME: the rolling-code sync sent the single 67',
      steps.length === 1 && ews.state.synced.join() === '67'
    );
    check(
      'flow EWS<-DME: the DME was not written (its dump still matches)',
      isnPair.matchState(await eepromDump.dump(client), DONOR_ISN).state ===
        'match' &&
        isnPair.matchState(await eepromDump.dump(client), ewsIsn).state ===
          'match'
    );
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
