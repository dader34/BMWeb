#!/usr/bin/env node
// The EWS/ISN matcher's EWS-side client (core/flash/ews.js) against a
// mock EWS3: DS2 framing at 0x44, the two-byte ISN at reply [3..4], the
// factory write job with its refusal, and the single-telegram sync. The
// telegrams are the mined SGBD's (docs/EWS-ISN.md); this proves the
// client speaks that dialect and refuses honestly. No hardware.
//
//   node tools/verify/test_ews.js
if (typeof global.window === 'undefined') global.window = {};
const { ewsTalk } = require('../../app/renderer/core/flash/ews.js');

let failures = 0;
const check = (what, ok) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}`);
  } else console.log(`  ok    ${what}`);
};

/** A mock EWS3 on the K-line: XOR-checked DS2 frames at 0x44, an ISN
 *  held with the 3-copy redundancy semantics (the module votes, so the
 *  answer is stable), and a lock bit that makes the write job refuse. */
function mockEws({ isn = 0x2f7f, locked = false } = {}) {
  const state = { isn, locked, reads: 0, writes: 0, synced: [] };
  const xor = (f) => f.reduce((a, b) => a ^ b, 0);
  const frame = (payload) => {
    const f = [ewsTalk.ADDR, payload.length + 3, ...payload];
    f.push(xor(f));
    return f;
  };
  const sess = {
    async transfer(addr, payload) {
      // the webshim bus signs the outgoing telegram itself; only the
      // reply frame (which frame() builds) carries its checksum
      if (addr !== ewsTalk.ADDR)
        throw new Error(`the mock is the EWS; got a telegram for ${addr}`);
      const job = payload[0];
      if (job === ewsTalk.JOB.IDENT)
        return frame([
          0xa0, 0x00, 0x30, 0x36, 0x35, 0x30, 0x39, 0x34, 0x33, 0x36, 0x30,
          0x31, 0x30, 0x31, 0x30, 0x31,
        ]);
      if (job === ewsTalk.JOB.READ_ISN) {
        state.reads++;
        return frame([0xa0, (state.isn >> 8) & 0xff, state.isn & 0xff]);
      }
      if (job === ewsTalk.JOB.WRITE_ISN) {
        if (state.locked) return frame([0xa1, 0xff, 0x21]); // ERROR_NO_PASSWORD's family
        state.writes++;
        state.isn = ((payload[1] & 0xff) << 8) | (payload[2] & 0xff);
        return frame([0xa0]);
      }
      if (job === ewsTalk.JOB.SYNC) {
        // WECHSELCODE_SYNC_DME: one telegram; the EWS realigns over its own wire
        state.synced.push('67');
        return frame([0xa0]);
      }
      if (job === ewsTalk.JOB.STATUS) return frame([0xa0, 0x00]);
      throw new Error(`the mock does not know job ${job}`);
    },
  };
  return { sess, state };
}

const main = async () => {
  // framing: the client's telegrams carry the SGBD's length and checksum
  {
    const { sess } = mockEws();
    const r = await ewsTalk.ident(sess);
    check(
      'IDENT answers positive with an id block',
      r[2] === ewsTalk.POS && r.length >= 6
    );
  }

  // the ISN read: two reads, both [3..4], big-endian
  {
    const { sess, state } = mockEws({ isn: 0x2f7f });
    const { isn, reads } = await ewsTalk.readIsn(sess);
    check(
      'read ISN: 2F7F from bytes [3..4], read twice',
      isn === 0x2f7f && reads.length === 2 && state.reads === 2
    );
    check(
      'read ISN renders like INPA (four hex digits)',
      ewsTalk.isnText(isn) === '2F7F'
    );
  }

  // a line that flips a bit between reads is a refused answer, not a wrong one
  {
    const { sess, state } = mockEws();
    let flip = false;
    const real = sess.transfer.bind(sess);
    sess.transfer = async (a, p) => {
      if (p[0] === ewsTalk.JOB.READ_ISN) flip = !flip;
      const r = await real(a, p);
      if (flip && p[0] === ewsTalk.JOB.READ_ISN) r[4] ^= 1;
      return r;
    };
    let threw = false;
    try {
      await ewsTalk.readIsn(sess);
    } catch (e) {
      threw = /disagree/.test(e.message);
    }
    check(
      'two reads that disagree throw, nothing written',
      threw && state.writes === 0
    );
  }

  // the write: factory job, then read-back verify
  {
    const { sess, state } = mockEws({ isn: 0x1111 });
    const { isn, verified } = await ewsTalk.writeIsn(sess, 0x2f7f);
    check(
      'write ISN takes the job and verifies by re-read',
      verified && isn === 0x2f7f && state.writes === 1
    );
    let threw = false;
    try {
      await ewsTalk.writeIsn(sess, 0x123456);
    } catch (e) {
      threw = /two bytes/.test(e.message);
    }
    check('a value wider than 16 bits is refused before any telegram', threw);
  }

  // a locked module refuses the write; the error says so, nothing written
  {
    const { sess, state } = mockEws({ locked: true });
    let msg = '';
    try {
      await ewsTalk.writeIsn(sess, 0x2f7f);
    } catch (e) {
      msg = e.message;
    }
    check(
      'a locked module: negative status surfaces, no write happened',
      /negative status 0xa1/.test(msg) && state.writes === 0
    );
  }

  // the sync: the one 0x67 telegram the ews3.prg bytecode sends, nothing else
  {
    const { sess, state } = mockEws();
    const steps = await ewsTalk.syncDme(sess);
    check(
      'sync sends the single 67 (WECHSELCODE_SYNC_DME)',
      steps.length === 1 &&
        steps[0] === '67' &&
        state.synced.length === 1 &&
        state.synced[0] === '67'
    );
  }

  // the match state the page shows
  {
    const m1 = ewsTalk.matchState(0x2f7f, 0x2f7f);
    check('match state: agree', m1.state === 'match');
    const m2 = ewsTalk.matchState(0x1111, 0x2f7f);
    check(
      'match state: disagree says the alignment applies',
      m2.state === 'mismatch' && /alignment/.test(m2.text)
    );
    const m3 = ewsTalk.matchState(null, 0x2f7f);
    check('match state: unknown when a side is unread', m3.state === 'unknown');
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
