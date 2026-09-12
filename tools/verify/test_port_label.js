#!/usr/bin/env node
// The cable chip and the no-echo error must say what a port IS when it is
// not a K+DCAN cable. A tester spent four days on "no echo from the cable
// (is it connected to the car?)" with a port the chip called "serial": the
// browser reported no USB ids for it, which means a Bluetooth adapter or a
// virtual port, neither of which has a K line to echo on.
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const R = path.join(
  __dirname,
  '..',
  '..',
  'app',
  'renderer',
  'core',
  'webshim'
);
// only the transport base and the Web Serial bus: the class bodies are what
// is under test, and loading the whole shim would want a browser's fetch
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
const busWith = (info) => {
  const b = Object.create(WebSerialBus.prototype);
  b.port = { getInfo: () => info };
  return b;
};
assert.strictEqual(
  busWith({ usbVendorId: 0x403, usbProductId: 0x6001 }).portLabel(),
  'USB 403:6001'
);
assert.strictEqual(
  busWith({ usbVendorId: 0x403, usbProductId: 0x6001 }).portHint(),
  '',
  'a USB cable gets no hint: the car is the question, not the port'
);
ok('an FTDI cable reads as its USB ids');
assert.strictEqual(
  busWith({ bluetoothServiceClassId: '1101' }).portLabel(),
  'Bluetooth serial, not a K+DCAN cable'
);
assert.match(
  busWith({ bluetoothServiceClassId: '1101' }).portHint(),
  /Bluetooth serial/
);
ok('a Bluetooth port is named as one');
assert.strictEqual(busWith({}).portLabel(), 'serial port, no USB id reported');
assert.doesNotMatch(
  busWith({}).portLabel(),
  /not a K\+DCAN/,
  'no ids is not a verdict: a Linux container strips them from a real cable'
);
assert.match(
  busWith({}).portHint(),
  /USB 403:6001/,
  'the hint says what a real cable looks like'
);
assert.match(
  busWith({}).portHint(),
  /can still be the cable/,
  'and that this port may be one'
);
ok('a port without USB ids is named as one, without a verdict');
// a gateway port carries its own label and gets no hint (the remote side knows)
const g = Object.create(WebSerialBus.prototype);
g.port = { label: () => 'gateway 192.168.1.9:6801', getInfo: () => ({}) };
assert.strictEqual(g.portLabel(), 'gateway 192.168.1.9:6801');
assert.strictEqual(g.portHint(), '');
ok('a gateway port keeps its own label');
console.log(`port-label: ${n} checks passed`);
