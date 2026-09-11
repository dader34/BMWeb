#!/usr/bin/env node
// A read that resolves while nobody is awaiting it must keep its bytes.
//
// THE RACE THIS PINS. readSome leaves a timed-out read outstanding on
// this.pending. After the next K-line write the bus sleeps for the DTR
// hold; if the outstanding read resolves in that window with the echo's
// first chunk, the next readSome must hand those bytes back, not arm a
// fresh read that only sees the rest. On Windows every DS2 echo came back
// missing its first byte until this held.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const R = path.join(
  __dirname,
  '..',
  '..',
  'app',
  'renderer',
  'core',
  'webshim'
);
const src = ['transport-base.js', 'web-serial-bus.js']
  .map((f) => fs.readFileSync(path.join(R, f), 'utf8'))
  .join('\n');
const ctx = {
  exports: {},
  console,
  Date,
  setTimeout,
  clearTimeout,
  Error,
  Promise,
  Map,
  Set,
  Uint8Array,
  navigator: {},
  location: { hostname: 'localhost' },
  bmwSleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(`${src}\nexports.WebSerialBus = WebSerialBus;`, ctx);
const { WebSerialBus } = ctx.exports;
let n = 0;
const ok = (m) => {
  n++;
  console.log(`  ok    ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** a reader whose chunks arrive when the test says so */
function fakeReader() {
  const queue = [];
  let waiter = null;
  return {
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    deliver(bytes) {
      const r = { value: Uint8Array.from(bytes), done: false };
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(r);
      } else queue.push(r);
    },
  };
}

(async () => {
  const bus = Object.create(WebSerialBus.prototype);
  bus.pending = null;
  bus.reader = fakeReader();

  // 1. the previous exchange timed out: a read is left outstanding
  const t = await bus.readSome(Date.now() + 5);
  assert.strictEqual(t.value, null);
  assert.strictEqual(t.done, false);
  assert.ok(bus.pending, 'the timed-out read stays outstanding');
  ok('a timed-out read is kept, not abandoned');

  // 2. the drain before the next write finds the line quiet and leaves it
  await bus.drainBuffered();
  assert.ok(bus.pending, 'a quiet line leaves the outstanding read alone');
  ok('the pre-write drain does not touch a quiet read');

  // 3. the echo's first byte arrives while the bus is asleep in the DTR hold
  bus.reader.deliver([0xf0]);
  await sleep(8);
  // 4. the frame read begins: it must get that byte, then the rest
  const first = await bus.readSome(Date.now() + 50);
  assert.deepStrictEqual(
    Array.from(first.value),
    [0xf0],
    'the first chunk survives'
  );
  bus.reader.deliver([0x04, 0x00, 0xf4]);
  const rest = await bus.readSome(Date.now() + 50);
  assert.deepStrictEqual(Array.from(rest.value), [0x04, 0x00, 0xf4]);
  assert.strictEqual(bus.pending, null, 'a delivered read clears the handle');
  ok('bytes that arrived while nobody awaited them are delivered next');

  // 5. the drain still eats what is actually stale: bytes already there
  bus.reader.deliver([0x55, 0x55]);
  await bus.readSome(Date.now() + 1); // arms a read that resolves at once
  await bus.drainBuffered();
  assert.strictEqual(
    bus.pending,
    null,
    'a stale chunk is consumed and cleared'
  );
  ok('a stale chunk before a write is still drained');

  console.log(`read-pending: ${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
