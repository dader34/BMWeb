#!/usr/bin/env node
// The fast-flasher client on a marginal line (FastFlashClient.call / read):
// a reply cut short is a damaged reply like a bad sum, one request gets
// FF_GARBLE_TRIES tries, every second line error steps the line down --
// again and again, not once a session -- and a step-down at the floor does
// nothing. On the car (2026-11-02) a read died on READ 0x4000 garbled twice
// at 312500, then on READ 0x21000 cut short at 250000. A mock link stands in
// for the cable: it answers READ from a pattern and damages replies on cue.
//
//   node tools/verify/test_fast_line_errors.js
if (typeof global.window === 'undefined') global.window = {};
const assert = require('assert');
const {
  fastFlashWire,
} = require('../../app/renderer/core/flash/fast-flasher-wire.js');

const READ = fastFlashWire.SVC.READ;

function dataAt(off, len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = ((off + i) * 13) & 0xff;
  return out;
}

/**
 * A link whose replies are damaged by `plan`: one entry per READ exchange,
 * 'ok' / 'cut' (the reply started, then stopped) / 'sum' (bad checksum) /
 * 'crc' (whole frame, data CRC wrong).
 */
function mockLink(plan) {
  const link = { reads: 0, frames: [] };
  link.exchange = async (frame) => {
    link.frames.push(frame[3]);
    if (frame[3] !== READ)
      return fastFlashWire.frame(frame[3] | 0x40, [], 0xf1, 0x12);
    const off =
      (frame[4] << 24) | (frame[5] << 16) | (frame[6] << 8) | frame[7];
    const len = (frame[8] << 8) | frame[9];
    const what = plan[link.reads++] || 'ok';
    const data = dataAt(off >>> 0, len);
    const crc = fastFlashWire.crc32(data);
    const payload = [
      crc >>> 24,
      (crc >>> 16) & 0xff,
      (crc >>> 8) & 0xff,
      crc & 0xff,
      ...data,
    ];
    if (what === 'crc') payload[4] ^= 0xff;
    const reply = fastFlashWire.frame(READ | 0x40, payload, 0xf1, 0x12);
    if (what === 'cut')
      throw new Error(
        `fast flasher: the DME did not answer (after the echo, 40 byte(s) of ${reply.length}: 00 10 08)`
      );
    if (what === 'sum') reply[reply.length - 1] ^= 0xff;
    if (what === 'overrun')
      throw Object.assign(new Error('Buffer overrun'), {
        name: 'BufferOverrunError',
      });
    return reply;
  };
  return link;
}

/** A client on the mock with a step-down that walks the session rates. */
function client(plan, startRate = 312500) {
  const link = mockLink(plan);
  const c = new fastFlashWire.Client(link);
  c.baud = startRate;
  c.steps = [];
  c.stepDown = async () => {
    if (c.baud <= fastFlashWire.BAUD) return;
    const lower = fastFlashWire.FAST_LINES.find(([r]) => r < c.baud);
    await c.setBaud(lower ? lower[1] : 11); // a SET_BAUD through call(), as the session does
    c.baud = lower ? lower[0] : fastFlashWire.BAUD;
    c.steps.push(c.baud);
  };
  return { c, link };
}

let passed = 0;
function ok(note) {
  passed++;
  console.log(`  ok    ${note}`);
}

(async () => {
  // a cut-short reply is retried, not the end of the job
  {
    const { c } = client(['cut']);
    const got = await c.read(0x21000, 4096);
    assert.deepStrictEqual(got, dataAt(0x21000, 4096));
    assert.strictEqual(c.lineErrors, 1);
    ok('a reply cut short is retried and counted as a line error');
  }

  // garbled twice running: the third try goes, after a step-down
  {
    const { c, link } = client(['sum', 'sum']);
    const got = await c.read(0x4000, 4096);
    assert.deepStrictEqual(got, dataAt(0x4000, 4096));
    assert.deepStrictEqual(c.steps, [250000], 'stepped down once');
    assert.strictEqual(link.reads, 3, 'three tries of the one READ');
    ok('garbled twice running: stepped down, the third try reads it');
  }

  // three in a row is still the end: the limit holds
  {
    const { c } = client(['sum', 'cut', 'sum']);
    await assert.rejects(c.read(0x4000, 4096), /checksum/);
    ok('three damaged replies in a row give up on the request');
  }

  // the step-down repeats: a line that keeps garbling keeps going down
  {
    const { c } = client([
      'crc',
      'ok',
      'cut',
      'ok',
      'sum',
      'ok',
      'crc',
      'ok',
      'cut',
      'ok',
      'sum',
      'ok',
    ]);
    for (let i = 0; i < 6; i++) await c.read(i * 0x1000, 4096);
    assert.deepStrictEqual(c.steps, [250000, 208333, 156250]);
    ok(
      'every second line error steps down again: 312500 -> 250000 -> 208333 -> 156250'
    );
  }

  // at the floor a step-down does nothing and the job goes on
  {
    const { c } = client(['cut', 'ok', 'cut', 'ok'], fastFlashWire.BAUD);
    await c.read(0, 4096);
    await c.read(0x1000, 4096);
    assert.deepStrictEqual(c.steps, []);
    assert.strictEqual(c.baud, fastFlashWire.BAUD);
    ok('at 115200 a step-down does nothing; the reads still go through');
  }

  // a fault the serial port reports (Windows, 2026-11-23: "Buffer overrun"
  // in the middle of a push stopped the flash): a damaged reply like the
  // rest -- the line is let go quiet first, then the request goes again --
  // and no more chunks go under the pulses for the rest of the session
  {
    const { c, link } = client(['overrun', 'ok']);
    const settled = [];
    link.settle = async (ms) => void settled.push(ms);
    const data = await c.read(0x2000, 4096);
    assert.deepStrictEqual(Array.from(data), Array.from(dataAt(0x2000, 4096)));
    assert.strictEqual(link.reads, 2, 'sent twice');
    assert.strictEqual(
      settled.length,
      1,
      'the line let go quiet once, before the resend'
    );
    assert.strictEqual(c.lineErrors, 1, 'counted as a line error');
    assert.ok(/BufferOverrunError/.test(c.interleaveOff), 'interleaving off');
    ok(
      'a serial buffer overrun is a damaged reply: quiet, then sent again; interleaving stops'
    );
  }
  {
    // three in a row is a line that will not carry: the push stops (and is
    // resumed by its caller), it does not spin
    const { c, link } = client(['overrun', 'overrun', 'overrun', 'ok']);
    link.settle = async () => {};
    await assert.rejects(c.read(0, 4096), /Buffer overrun/);
    assert.strictEqual(link.reads, 3);
    ok('three overruns running stop the request after its three tries');
  }
  {
    // a garble the line made is not a serial fault: interleaving goes on
    const { c, link } = client(['sum', 'ok']);
    link.settle = async () => {
      throw new Error('settle on a plain garble');
    };
    await c.read(0, 4096);
    assert.strictEqual(c.interleaveOff, '');
    ok('a bad checksum is resent at once and leaves interleaving on');
  }

  console.log(`\nfast-line-errors: ${passed} checks passed`);
})().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
