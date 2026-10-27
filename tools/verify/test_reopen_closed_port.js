#!/usr/bin/env node
// github #260: a concept switch (ensureConfig -> _reopenStreams) must survive
// a port.close() that throws "The port is already closed".
//
// On some macOS Chrome / FTDI builds the reader.cancel() in _releaseStreams
// also closes the SerialPort, so the close() in _reopenStreams threw. Uncaught,
// it aborted the first multi-concept group probe (d_0012: DS2 then KWP2000*),
// which needs the switch from the 115200 BMW-FAST default to 9600 8E1 -- so
// nothing was ever transmitted (empty wire, 1 ms "no module answered"). The fix
// ignores an already-closed close() and lets open() reopen the port.
//
//   node tools/verify/test_reopen_closed_port.js
const vm = require('vm');
const { readWebshimSource } = require('./webshim_src');

// The whole shim, in load order. It ends by touching window/navigator, so
// stub those; we only drive WebSerialBus._reopenStreams, which touches neither.
const src = readWebshimSource();
const ctx = {
  console,
  Date,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Error,
  Symbol,
  Uint8Array,
  Promise,
  Math,
  JSON,
  TextEncoder,
  TextDecoder,
  window: {
    addEventListener() {},
    dispatchEvent() {},
    removeEventListener() {},
    fetch: async () => ({ ok: false }),
    location: { href: '', search: '' },
  },
  navigator: {},
  fetch: async () => ({ ok: false }),
  exports: {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src + '\nexports.WebSerialBus = WebSerialBus;', ctx);
const { WebSerialBus } = ctx.exports;

let failures = 0;
const check = (what, ok) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}`);
  } else console.log(`  ok    ${what}`);
};

// A SerialPort whose close() ALWAYS throws "already closed" -- the macOS case
// where the reader cancel already closed it. open() records the config it was
// (re)opened with; readable/writable hand out minimal locks.
function fakeClosedOnClose() {
  const port = {
    opened: [],
    closeCalls: 0,
    _mkReadable() {
      return {
        getReader: () => ({
          read: async () => ({ value: null, done: true }),
          cancel: async () => {},
          releaseLock() {},
        }),
      };
    },
    _mkWritable() {
      return { getWriter: () => ({ write: async () => {}, releaseLock() {} }) };
    },
    async open(cfg) {
      this.opened.push(cfg);
      this.readable = this._mkReadable();
      this.writable = this._mkWritable();
    },
    async close() {
      this.closeCalls++;
      throw new DOMException(
        "Failed to execute 'close' on 'SerialPort': The port is already closed.",
        'InvalidStateError'
      );
    },
    async setSignals() {},
    getInfo() {
      return { usbVendorId: 0x403, usbProductId: 0x6001 };
    },
  };
  return port;
}

if (typeof DOMException === 'undefined') {
  global.DOMException = class DOMException extends Error {
    constructor(m, n) {
      super(m);
      this.name = n || 'Error';
    }
  };
}

(async () => {
  const bus = new WebSerialBus();
  const port = fakeClosedOnClose();
  bus.port = port;
  await port.open({
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
  });
  bus.config = {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    dtr: true,
  };
  bus.writer = port.writable.getWriter();
  bus.reader = port.readable.getReader();

  // the DS2 concept switch the d_0012 probe makes: 9600 8E1, DTR low
  const ds2 = {
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'even',
    dtr: false,
  };
  let threw = null;
  try {
    await bus.ensureConfig(ds2);
  } catch (e) {
    threw = e;
  }

  check(
    'ensureConfig does not throw on an already-closed close()',
    threw === null
  );
  check(
    'close() was attempted (and its throw swallowed)',
    port.closeCalls >= 1
  );
  check(
    'the port was reopened on the DS2 config (9600 8E1)',
    port.opened.length === 2 &&
      port.opened[1].baudRate === 9600 &&
      port.opened[1].parity === 'even'
  );
  check(
    'the bus adopted the new config',
    bus.config && bus.config.baudRate === 9600
  );

  if (failures) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log('\nALL OK');
})().catch((e) => {
  console.log('FAIL (threw):', e && e.message);
  process.exit(1);
});
