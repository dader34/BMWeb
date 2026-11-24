#!/usr/bin/env node
// readSome must not lose bytes to an abandoned read.
//
// THE BUG: racing reader.read() against a timeout and walking away left that
// read outstanding. Web Serial delivered the next chunk to it and, because
// nothing held the promise, those bytes vanished. The pre-write drain loop
// runs with a 2 ms deadline and so ALWAYS times out -- every exchange armed an
// orphan right before writing, which then ate the K-line echo. The app threw
// IFH-0003 "no echo from the cable" on a cable that echoes perfectly (verified
// against a real FT232R on an E46: all 6 bytes came straight back).
//
// This drives the real readSome from the transport shim against a fake reader whose
// data arrives LATER than the deadline -- the exact orphan case.

let failures = 0;
const ok = (c, m) => {
  if (c) console.log('  ok   ' + m);
  else {
    failures++;
    console.log('  FAIL ' + m);
  }
};

// Pull readSome out of the class without booting the whole shim (the pieces
// of core/webshim/, joined in load order).
const src = require('./webshim_src').readWebshimSource();
const m = src.match(/const TIMED_OUT = Symbol\('timed-out'\);/);
if (!m) {
  console.error('TIMED_OUT sentinel missing -- was the fix reverted?');
  process.exit(1);
}
const body = src.match(/async readSome\(deadline\) \{[\s\S]*?\n {2}\}/);
if (!body) {
  console.error('readSome not found');
  process.exit(1);
}

const TIMED_OUT = Symbol('timed-out');
// the shim's waits run on a worker-backed clock in the browser; here the
// plain timer stands in for it
const bmwSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the set as the shim declares it, so the test runs what ships
const lineSet = src.match(
  /const SERIAL_LINE_ERRORS = new Set\((\[[^\]]*\])\);/
);
if (!lineSet) {
  console.error('SERIAL_LINE_ERRORS missing -- was the fix reverted?');
  process.exit(1);
}
const SERIAL_LINE_ERRORS = new Set(
  JSON.parse(lineSet[1].replace(/'/g, '"').replace(/,\s*\]/, ']'))
);
const readSome = new Function(
  'TIMED_OUT',
  'bmwSleep',
  'SERIAL_LINE_ERRORS',
  'return async function ' + body[0].replace(/^async /, '') + ';'
)(TIMED_OUT, bmwSleep, SERIAL_LINE_ERRORS);
const renew = src.match(/_renewReader\(\) \{[\s\S]*?\n {2}\}/);
if (!renew || !SERIAL_LINE_ERRORS.has('BufferOverrunError')) {
  console.error(
    'the line-fault reader renewal is missing -- was the fix reverted?'
  );
  process.exit(1);
}
const renewReader = new Function('return function ' + renew[0] + ';')();

// A reader that answers after `delayMs`, and counts how many reads it saw.
function fakeReader(chunks, delayMs) {
  let i = 0;
  return {
    reads: 0,
    read() {
      this.reads++;
      const v = chunks[i++];
      return new Promise((res) =>
        setTimeout(
          () =>
            res(
              v === undefined
                ? { value: null, done: true }
                : { value: v, done: false }
            ),
          delayMs
        )
      );
    },
  };
}

console.log('a timed-out read is resumed, not discarded');
{
  // Data arrives at 30ms; first call gives up at 5ms. The bytes must still be
  // delivered to the SECOND call rather than being swallowed.
  const echo = new Uint8Array([0x12, 0x04, 0xf1, 0x1a, 0x80, 0x7d]);
  const ctx = { reader: fakeReader([echo], 30), pending: null };
  (async () => {
    const first = await readSome.call(ctx, Date.now() + 5);
    ok(
      first.done === false && !first.value,
      'first call reports "nothing yet" (done:false), not done:true'
    );
    ok(
      ctx.pending !== null,
      'the outstanding read is retained on this.pending'
    );

    const second = await readSome.call(ctx, Date.now() + 200);
    ok(
      second.value && second.value.length === 6,
      `the echo survived the timeout (${second.value ? second.value.length : 0}/6 bytes)`
    );
    ok(
      ctx.reader.reads === 1,
      `only ONE underlying read was issued (${ctx.reader.reads}) -- a second would orphan the first`
    );
    ok(ctx.pending === null, 'pending is cleared once the read resolves');

    console.log('\na closed port still reports done');
    const ctx2 = { reader: fakeReader([], 1), pending: null };
    const r = await readSome.call(ctx2, Date.now() + 50);
    ok(r.done === true, 'done:true is reserved for the port actually closing');

    // A LINE FAULT IS NOT THE END OF THE PORT (a Windows laptop,
    // 2026-11-23: "Buffer overrun" mid-flash, then every read failed at
    // once). Web Serial errors the stream and hands out a fresh one; the
    // fault reaches the caller, and the next read uses the new stream.
    console.log('\na line fault: the error is reported, the next read works');
    for (const name of ['BufferOverrunError']) {
      const fault = Object.assign(new Error('Buffer overrun'), { name });
      const dead = {
        released: false,
        read: () => Promise.reject(fault),
        releaseLock() {
          this.released = true;
        },
      };
      const fresh = fakeReader([new Uint8Array([0x40, 0x41])], 1);
      const port = { readable: { getReader: () => fresh } };
      const ctx3 = {
        reader: dead,
        pending: null,
        port,
        _renewReader: renewReader,
      };
      let threw = null;
      try {
        await readSome.call(ctx3, Date.now() + 50);
      } catch (e) {
        threw = e;
      }
      const next = await readSome.call(ctx3, Date.now() + 50);
      ok(
        threw === fault &&
          dead.released &&
          ctx3.reader === fresh &&
          next.value &&
          next.value.length === 2,
        `${name}: reported, the errored reader let go, the next read on the fresh stream`
      );
    }
    // a break, a framing or a parity error is the bus's own doing while it
    // wakes a module: the reader is left as it was (renewing it there took
    // the Chrome tab down on Windows during Identify, 2026-11-23)
    for (const name of ['BreakError', 'FramingError', 'ParityError']) {
      const fault = Object.assign(new Error(name), { name });
      const held = { read: () => Promise.reject(fault), releaseLock() {} };
      const ctx5 = {
        reader: held,
        pending: null,
        port: { readable: { getReader: () => fakeReader([], 1) } },
        _renewReader: renewReader,
      };
      try {
        await readSome.call(ctx5, Date.now() + 50);
      } catch {
        /* expected */
      }
      ok(ctx5.reader === held, `${name}: the reader is left as it was`);
    }
    // a fault that is not the line's (the port went away) is left alone
    const gone = Object.assign(new Error('The device has been lost.'), {
      name: 'NetworkError',
    });
    const lost = { read: () => Promise.reject(gone), releaseLock() {} };
    const ctx4 = {
      reader: lost,
      pending: null,
      port: { readable: { getReader: () => fakeReader([], 1) } },
      _renewReader: renewReader,
    };
    try {
      await readSome.call(ctx4, Date.now() + 50);
    } catch {
      /* expected */
    }
    ok(
      ctx4.reader === lost,
      'a lost device is not papered over with a new reader'
    );

    console.log(
      failures ? `\nFAILED (${failures})` : '\nAll readSome checks passed'
    );
    process.exit(failures ? 1 : 0);
  })();
}
