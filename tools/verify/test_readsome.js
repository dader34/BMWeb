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
// This drives the real readSome from webshim.js against a fake reader whose
// data arrives LATER than the deadline -- the exact orphan case.

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
let failures = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } };

// Pull readSome out of the class without booting the whole shim.
const src = fs.readFileSync(path.join(ROOT, 'app/renderer/core/webshim.js'), 'utf8');
const m = src.match(/const TIMED_OUT = Symbol\('timed-out'\);/);
if (!m) { console.error('TIMED_OUT sentinel missing -- was the fix reverted?'); process.exit(1); }
const body = src.match(/async readSome\(deadline\) \{[\s\S]*?\n  \}/);
if (!body) { console.error('readSome not found'); process.exit(1); }

const TIMED_OUT = Symbol('timed-out');
const readSome = new Function('TIMED_OUT',
  'return async function ' + body[0].replace(/^async /, '') + ';')(TIMED_OUT);

// A reader that answers after `delayMs`, and counts how many reads it saw.
function fakeReader(chunks, delayMs) {
  let i = 0;
  return {
    reads: 0,
    read() {
      this.reads++;
      const v = chunks[i++];
      return new Promise((res) => setTimeout(
        () => res(v === undefined ? { value: null, done: true }
                                  : { value: v, done: false }), delayMs));
    },
  };
}

console.log('a timed-out read is resumed, not discarded');
{
  // Data arrives at 30ms; first call gives up at 5ms. The bytes must still be
  // delivered to the SECOND call rather than being swallowed.
  const echo = new Uint8Array([0x12, 0x04, 0xF1, 0x1A, 0x80, 0x7D]);
  const ctx = { reader: fakeReader([echo], 30), pending: null };
  (async () => {
    const first = await readSome.call(ctx, Date.now() + 5);
    ok(first.done === false && !first.value,
       'first call reports "nothing yet" (done:false), not done:true');
    ok(ctx.pending !== null, 'the outstanding read is retained on this.pending');

    const second = await readSome.call(ctx, Date.now() + 200);
    ok(second.value && second.value.length === 6,
       `the echo survived the timeout (${second.value ? second.value.length : 0}/6 bytes)`);
    ok(ctx.reader.reads === 1,
       `only ONE underlying read was issued (${ctx.reader.reads}) -- a second would orphan the first`);
    ok(ctx.pending === null, 'pending is cleared once the read resolves');

    console.log('\na closed port still reports done');
    const ctx2 = { reader: fakeReader([], 1), pending: null };
    const r = await readSome.call(ctx2, Date.now() + 50);
    ok(r.done === true, 'done:true is reserved for the port actually closing');

    console.log(failures ? `\nFAILED (${failures})` : '\nAll readSome checks passed');
    process.exit(failures ? 1 : 0);
  })();
}
