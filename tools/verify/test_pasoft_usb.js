#!/usr/bin/env node
// PA Soft "BMW Scanner V14x" cable over WebUSB: framing, scramble, readers,
// retries, against a mock USBDevice that plays the adapter.
//
// The fixtures are REAL BYTES from this cable (live run 2026-11-09, IKE and
// MS45 on the bus) and from the BMW Scanner process dump:
//   hello (27 raw)    9b cd aa af af d9 f5 a2 9b 17 28 fe 72 d1 17 4c 5e ...
//   A77A plain        22 a7 7a 56 31 34 34 42 6e 39 9d 3e ... 03 da
//   A77A on the wire  b9 41 4b 2a f6 26 69 ea 9d 07 14 ea b0 44 1c 45 ...
//   adapter OK        77 07 77 07 77 07 70
//   83F0 plain/wire   09 83 f0 80 e5 50 47 66 28 14 1a / 2e f1 4d 88 ...
//   46F1 -> IKE       echo 80 04 00 84, answer 80 12 a0 f6 94 08 77 ...
//   06F3 -> DME       echo b8 12 f1 02 1a 80 c3, answer b8 f1 12 1f 5a 80 ...
const {
  pasoftCable,
  pasoftBusRefusal,
  PasoftUsbPort,
  PASOFT_LICENSE,
  pasoftFrame,
  pasoftScramble,
  pasoftDecodeHello,
  pasoftNeed,
  pasoftChecksumOk,
  ftdiStripStatus,
  ftdiBaudValue,
  ftdiLineValue,
} = require('../../app/renderer/core/webshim/pasoft-usb-port.js');

let failures = 0;
const ok = (c, m) => {
  if (c) console.log('  ok   ' + m);
  else {
    failures++;
    console.log('  FAIL ' + m);
  }
};
const hex = (s) =>
  Uint8Array.from(s.trim().split(/\s+/), (x) => parseInt(x, 16));
// append the XOR checksum
const xs = (s) => {
  const b = hex(s);
  return Uint8Array.from([...b, b.reduce((x, v) => x ^ v, 0)]);
};
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const HELLO = hex(
  '9b cd aa af af d9 f5 a2 9b 17 28 fe 72 d1 17 4c 5e 80 38 09 ed 2e b5 cf aa 07 2b'
);
const A77A_PLAIN = hex(
  '22 a7 7a 56 31 34 34 42 6e 39 9d 3e af 2e a9 45 78 80 b7 aa f6 a9 fc 9f ee d2 7c 59 90 79 80 59 84 88 03 da'
);
const A77A_WIRE = hex(
  'b9 41 4b 2a f6 26 69 ea 9d 07 14 ea b0 44 1c 45 33 16 56 86 81 6b f1 c7 4d 3c 45 dd 5f 63 e5 e9 7f ce 92 06'
);
const BUS_PLAIN = hex('09 83 f0 80 e5 50 47 66 28 14 1a');
const BUS_WIRE = hex('2e f1 4d 88 b6 ce ae 52 57 de 0f');
const ID_WIRE = hex('63 ed 07 c1 36');
const ADAPTER_OK = hex('77 07 77 07 77 07 70');
const IKE_ECHO = hex('80 04 00 84');
const IKE_ANSWER = hex('80 12 a0 f6 94 08 77 32 08 54 13 28 04 08 36 07 37 70');
const DME_ECHO = hex('b8 12 f1 02 1a 80 c3');
const DME_ANSWER = hex(
  'b8 f1 12 1f 5a 80 00 00 07 56 13 82 00 00 00 11 31 43 20 05 01 27 04 00 0d 91 ff ff ff 02 03 01 ff ff ff a6'
);

console.log('frame building');
{
  const f = pasoftFrame(0x46f1, 0x80, []);
  ok(eq(f, hex('03 46 f1 80 ba')), '46F1 to 0x80 = 03 46 f1 80 ba');
  const b = pasoftFrame(0x83f0, 0x80, [0xe5, 0x50, 0x47, 0x66, 40, 20]);
  ok(eq(b, BUS_PLAIN), '83F0 frame matches the dump byte for byte');
  const hello = pasoftDecodeHello(HELLO);
  const p = [...hello.decoded.subarray(2, 8), ...PASOFT_LICENSE];
  ok(eq(pasoftFrame(0xa77a, hello.decoded[1], p), A77A_PLAIN), 'A77A frame');
  ok(f[0] === 3 && b[0] === 9, 'len byte = payload count + 3');
}

console.log('scramble stream');
{
  const s = pasoftScramble(A77A_PLAIN, 0x9b);
  ok(
    eq(s.bytes, A77A_WIRE),
    'A77A with key 0x9b gives the captured wire bytes'
  );
  const s2 = pasoftScramble(BUS_PLAIN, s.key);
  ok(eq(s2.bytes, BUS_WIRE), 'the key carries over into 83F0');
  const s3 = pasoftScramble(hex('03 46 f1 80 ba'), s2.key);
  ok(eq(s3.bytes, ID_WIRE), 'and into 46F1');
  ok(
    pasoftScramble([0], 0x00).key === 0x4b,
    'key -= 0xB5 per byte (0 -> 0x4b)'
  );
  // dump: start key 0x9b, 26 bytes later (mod 256) the key read 0x39
  ok(pasoftScramble(new Uint8Array(26), 0x9b).key === 0x39, 'dump key drift');
}

console.log('hello decode');
{
  const h = pasoftDecodeHello(HELLO);
  ok(h && h.key === 0x9b, 'start key = first raw byte');
  ok(h && h.id === 'V144Bn9', 'adapter id V144Bn9');
  const bad = HELLO.slice();
  bad[5] ^= 1;
  ok(pasoftDecodeHello(bad) === null, 'XOR check rejects a corrupted hello');
  ok(pasoftDecodeHello(HELLO.subarray(0, 26)) === null, 'short hello rejected');
}

console.log('reply framing per mode');
{
  const run = (mode, bytes, status) => {
    const buf = [];
    let need = 4;
    for (const b of bytes) {
      if (buf.length >= need) break;
      buf.push(b);
      need = pasoftNeed(mode, buf, need, status);
    }
    return need;
  };
  ok(run(2, IKE_ANSWER) === 18, 'mode 2: DS2 byte 1 is the total');
  ok(run(3, DME_ANSWER) === 36, 'mode 3: byte 3 + 5');
  ok(run(1, hex('00 00 06 01 02 03')) === 6, 'mode 1: byte 2 is the total');
  ok(
    run(4, hex('83 f1 12 5a 80 00 00')) === 7,
    'mode 4: format low 6 bits + 4'
  );
  ok(
    run(4, hex('80 f1 12 03 5a 80 00 00')) === 8,
    'mode 4: no length in format -> byte 3 + 5'
  );
  ok(
    run(2, ADAPTER_OK, true) === 7,
    'echo read: 77 07 is a 7-byte status frame'
  );
  ok(run(3, ADAPTER_OK, true) === 7, 'in any mode');
  ok(pasoftChecksumOk(2, IKE_ANSWER), 'DS2 answer XOR check');
  ok(
    pasoftChecksumOk(3, DME_ANSWER),
    'KWP answer XOR check (adapter uses XOR)'
  );
  ok(pasoftChecksumOk(4, hex('01 02 fd')), 'mode 4 additive check');
  ok(!pasoftChecksumOk(2, hex('80 04 00 85')), 'bad XOR rejected');
}

console.log('FTDI status bytes and line setup');
{
  const pkt = (payload) => Uint8Array.from([0x01, 0x60, ...payload]);
  const big = new Uint8Array(64 + 4);
  big.set(pkt(new Array(62).fill(0xaa)));
  big.set(pkt([0x11, 0x22]), 64);
  const s = ftdiStripStatus(big);
  ok(
    s.length === 64 && s[61] === 0xaa && s[62] === 0x11 && s[63] === 0x22,
    'two packets: 2 status bytes dropped from each'
  );
  ok(ftdiStripStatus(hex('01 60')).length === 0, 'status-only packet is empty');
  ok(ftdiBaudValue(19200).value === 0x809c, '19200 -> 0x809C');
  ok(ftdiBaudValue(9600).value === 0x4138, '9600 -> 0x4138');
  ok(ftdiLineValue(8, 'none') === 0x0008, '8N1 = 0x0008');
  ok(ftdiLineValue(8, 'even') === 0x0208, '8E1 = 0x0208');
}

// ---- mock adapter --------------------------------------------------------------

/**
 * A USBDevice that plays the PA Soft adapter: descrambles what it gets,
 * answers from a script, wraps everything in 64-byte FTDI packets.
 */
class MockAdapter {
  constructor(script) {
    this.script = script; // (plainFrame, adapter) => [Uint8Array chunks]
    this.key = 0;
    this.ctrl = [];
    this.wire = [];
    this.plain = [];
    this.pending = [];
    this.waiters = [];
    this.configuration = null;
    this.helloRaw = HELLO;
    this.helloCount = 0;
    this.dtr = 0;
  }
  async open() {}
  async close() {
    this.closed = true;
    for (const w of this.waiters) w(null);
  }
  async selectConfiguration() {
    this.configuration = {};
  }
  async claimInterface() {}
  async releaseInterface() {}
  async selectAlternateInterface() {}
  async controlTransferOut(setup) {
    this.ctrl.push([setup.request, setup.value, setup.index]);
    if (setup.request === 1) {
      const on = setup.value & 1;
      if (this.dtr && !on) {
        this.helloCount++;
        const h =
          typeof this.helloRaw === 'function'
            ? this.helloRaw(this.helloCount)
            : this.helloRaw;
        this.key = h[0];
        this.push(h);
      }
      this.dtr = on;
    }
    return { status: 'ok' };
  }
  async transferOut(ep, data) {
    this.wire.push(Uint8Array.from(data));
    const plain = data.map((b) => {
      const p = b ^ this.key;
      this.key = (this.key - 0xb5) & 0xff;
      return p;
    });
    this.plain.push(plain);
    for (const c of this.script(plain, this) || []) this.push(c);
    return { status: 'ok', bytesWritten: data.length };
  }
  push(bytes) {
    for (let i = 0; i < bytes.length; i += 62) {
      this.pending.push(
        Uint8Array.from([0x01, 0x60, ...bytes.slice(i, i + 62)])
      );
    }
    const w = this.waiters.shift();
    if (w) w(this.pending.shift());
  }
  transferIn() {
    if (this.closed) return Promise.reject(new Error('closed'));
    if (this.pending.length)
      return Promise.resolve(this.mk(this.pending.shift()));
    return new Promise((resolve) => {
      this.waiters.push((p) => resolve(p ? this.mk(p) : this.mk(hex('01 60'))));
    });
  }
  mk(p) {
    return { status: 'ok', data: new DataView(p.buffer) };
  }
}

const cmdOf = (f) => (f[1] << 8) | f[2];

/** Standard adapter: OK to A77A/83F0, IKE + DME identify. */
function carScript(extra) {
  return (f, a) => {
    const c = cmdOf(f);
    if (extra) {
      const r = extra(c, f, a);
      if (r) return r;
    }
    if (c === 0xa77a || c === 0x83f0) return [ADAPTER_OK];
    if (c === 0x46f1) return [IKE_ECHO, IKE_ANSWER];
    if (c === 0x06f3) return [DME_ECHO, DME_ANSWER];
    return [];
  };
}

const sleeps = [];
const fastSleep = (ms) => {
  sleeps.push(ms);
  return Promise.resolve();
};
(async () => {
  console.log('connect sequence');
  {
    const dev = new MockAdapter(carScript());
    const port = new PasoftUsbPort({ sleep: fastSleep, byteTimeoutMs: 30 });
    const info = await port.open(dev);
    ok(
      info.id === 'V144Bn9' && info.key === 0x9b,
      'open() returns the adapter id and start key'
    );
    ok(eq(dev.wire[0], A77A_WIRE), 'A77A goes out exactly as captured');
    const req = dev.ctrl.map((c) => c[0] + ':' + c[1].toString(16));
    ok(
      req.includes('3:809c') && req.includes('4:8'),
      'FT232R set to 19200 8N1'
    );
    ok(
      req.indexOf('1:101') < req.indexOf('1:100', req.indexOf('1:101')),
      'DTR on then off'
    );
    ok(
      req.includes('9:2') && req.includes('2:0'),
      'latency and flow control set'
    );
    const r = await port.identifyDs2(0x80);
    ok(eq(dev.wire[1], BUS_WIRE), '83F0 sent first, key carried over');
    ok(eq(dev.wire[2], ID_WIRE), '46F1 wire bytes match the capture');
    const after = dev.ctrl.map((c) => c[0] + ':' + c[1].toString(16));
    ok(
      after.includes('3:4138') && after.includes('4:208'),
      'PC side moved to 9600 8E1 after 83F0'
    );
    ok(
      r.status === 'ok' && eq(r.echo, IKE_ECHO) && eq(r.reply, IKE_ANSWER),
      'IKE identify: echo + answer'
    );
    const k = await port.identifyKwp(0x12);
    ok(
      k.status === 'ok' && eq(k.reply, DME_ANSWER),
      'DME KWP identify (06F3) answer'
    );
    ok(
      dev.plain.filter((f) => cmdOf(f) === 0x83f0).length === 1,
      '83F0 only once per connection'
    );
    await port.close();
  }

  console.log('handshake failures');
  {
    const bad = HELLO.slice();
    bad[3] ^= 0x40;
    const dev = new MockAdapter(carScript());
    dev.helloRaw = (n) => (n === 1 ? bad : HELLO);
    const port = new PasoftUsbPort({ sleep: fastSleep, byteTimeoutMs: 30 });
    await port.open(dev);
    ok(
      dev.helloCount === 2 && port.connected,
      'a bad hello is retried once (second DTR pulse)'
    );
    await port.close();

    const dev2 = new MockAdapter(
      carScript((c) => (c === 0xa77a ? [hex('7a 07 7a 07 7a 07 7a')] : null))
    );
    let err = null;
    try {
      await new PasoftUsbPort({ sleep: fastSleep, byteTimeoutMs: 30 }).open(
        dev2
      );
    } catch (e) {
      err = e;
    }
    ok(err && /refused/.test(err.message), '7A 07 to A77A = handshake refused');
  }

  console.log('retry rules');
  {
    // DS2 busy once, then OK
    let n = 0;
    const busy = hex('80 04 a1 25');
    const dev = new MockAdapter(
      carScript((c) => (c === 0x46f1 && n++ === 0 ? [IKE_ECHO, busy] : null))
    );
    const port = new PasoftUsbPort({ sleep: fastSleep, byteTimeoutMs: 30 });
    await port.open(dev);
    sleeps.length = 0;
    const r = await port.identifyDs2(0x80);
    ok(
      r.status === 'ok' && n === 2,
      'DS2 A1: resent once and the second answer used'
    );
    ok(sleeps.includes(1200), 'waited 1.2 s before the resend');

    // DS2 busy forever -> busy after one resend
    n = 0;
    const dev2 = new MockAdapter(
      carScript((c) => (c === 0x46f1 ? (n++, [IKE_ECHO, busy]) : null))
    );
    const p2 = new PasoftUsbPort({ sleep: fastSleep, byteTimeoutMs: 30 });
    await p2.open(dev2);
    const r2 = await p2.identifyDs2(0x80);
    ok(
      r2.status === 'busy' && n === 2,
      'DS2 A1 twice: gives up as busy after one resend'
    );

    // KWP 7F 78 pending then answer, no resend
    n = 0;
    const pend = xs('b8 f1 12 03 7f 1a 78');
    const dev3 = new MockAdapter(
      carScript((c) =>
        c === 0x06f3 ? (n++, [DME_ECHO, pend, pend, DME_ANSWER]) : null
      )
    );
    const p3 = new PasoftUsbPort({ sleep: fastSleep, byteTimeoutMs: 30 });
    await p3.open(dev3);
    const r3 = await p3.identifyKwp(0x12);
    ok(pasoftChecksumOk(3, pend), '(fixture 7F 78 frame has a valid XOR)');
    ok(
      r3.status === 'ok' && n === 1 && eq(r3.reply, DME_ANSWER),
      'KWP 7F 78: read again, not resent'
    );

    // KWP 7F 21 -> wait and resend
    n = 0;
    const busyK = xs('b8 f1 12 03 7f 1a 21');
    const dev4 = new MockAdapter(
      carScript((c) => (c === 0x06f3 && n++ === 0 ? [DME_ECHO, busyK] : null))
    );
    const p4 = new PasoftUsbPort({ sleep: fastSleep, byteTimeoutMs: 30 });
    await p4.open(dev4);
    sleeps.length = 0;
    const r4 = await p4.identifyKwp(0x12);
    ok(
      r4.status === 'ok' && n === 2 && sleeps.includes(1200),
      'KWP 7F 21: 1.2 s, resent once'
    );

    // KWP 7F 11 -> negative, no resend
    const dev5 = new MockAdapter(
      carScript((c) =>
        c === 0x41aa
          ? [hex('b8 12 f1 01 a2 f8'), hex('b8 f1 12 03 7f a2 11 94')]
          : null
      )
    );
    const p5 = new PasoftUsbPort({ sleep: fastSleep, byteTimeoutMs: 30 });
    await p5.open(dev5);
    const r5 = await p5.identifyKwp(0x12, true);
    ok(
      r5.status === 'negative' && r5.nrc === 0x11,
      '41AA on MS45: 7F A2 11 (live) = negative, nrc 0x11'
    );

    // no answer -> resent once, then error
    n = 0;
    const dev6 = new MockAdapter(
      carScript((c) => (c === 0x46f1 ? (n++, [IKE_ECHO]) : null))
    );
    const p6 = new PasoftUsbPort({ sleep: fastSleep, byteTimeoutMs: 20 });
    await p6.open(dev6);
    const r6 = await p6.identifyDs2(0x80);
    ok(
      r6.status === 'error' && n === 2,
      'missing answer: one resend, then error'
    );

    // bad checksum -> error
    const dev7 = new MockAdapter(
      carScript((c) => (c === 0x46f1 ? [IKE_ECHO, hex('80 04 a0 25')] : null))
    );
    const p7 = new PasoftUsbPort({
      sleep: fastSleep,
      byteTimeoutMs: 20,
      retries: 0,
    });
    await p7.open(dev7);
    const r7 = await p7.identifyDs2(0x80);
    ok(r7.status === 'error', 'answer with a bad XOR = error');
    for (const p of [port, p2, p3, p4, p5, p6, p7]) await p.close();
  }

  console.log('BMWeb Scanner over the PA Soft cable');
  {
    const ALLOWED = new Set([0xa77a, 0x83f0, 0x46f1, 0x06f3, 0xc731, 0xc358]);
    const IKE_FAULTS = hex('80 05 a0 05 20'); // capture: C731 [00] -> 5 faults
    const DME_FAULTS = hex('b8 f1 12 08 58 02 29 9a e8 27 c3 41 f7'); // C358
    const dev = new MockAdapter(
      carScript((c, f) => {
        const addr = f[3];
        if (c === 0x46f1 && addr === 0x12) return [hex('12 04 00 16')]; // silent
        if (c === 0xc731) return [hex('80 05 04 00 81'), IKE_FAULTS];
        if (c === 0xc358)
          return [hex('b8 12 f1 04 18 02 ff ff 45'), DME_FAULTS];
        if (c === 0x06f3) return [DME_ECHO, DME_ANSWER];
        return null;
      })
    );
    // the app's singleton, with fast timings for the mock
    const cable = pasoftCable;
    cable._opts = { sleep: fastSleep, byteTimeoutMs: 20 };
    await cable._openOn(dev);
    ok(
      cable.connected && /V144Bn9/.test(cable.label),
      'cable connects, label names the adapter'
    );
    ok(
      /only works with BMWeb Scanner/.test(pasoftBusRefusal().message),
      'bus entry points get the Scanner-only refusal'
    );

    const data = require('../../app/renderer/screens/scanner/scanner-data.js');
    Object.assign(
      global,
      data,
      require('../../app/renderer/screens/scanner/scanner-proc.js'),
      { inpaMode: () => false, pasoftCable: cable }
    );
    const w = require('../../app/renderer/screens/scanner/scanner.js');
    const at = (n) => data.SCANNER_MODULES.find((m) => m.name === n);
    ok(
      w.scannerPasoft() === cable,
      'the scanner picks the PA cable when no K+DCAN is in'
    );
    const ike = await w.scannerIdentify(at('IKE'));
    ok(
      ike && ike.id.part === '6.940.877' && eq(ike.raw, IKE_ANSWER),
      'IKE identify: the module answer (not the echo) is parsed'
    );
    const dme = await w.scannerIdentify(at('DME'));
    ok(
      dme &&
        dme.id.kwp &&
        dme.id.part === '7.561.382' &&
        eq(dme.raw, DME_ANSWER),
      'DME: silent in DS2, identified with 06F3 (KWP 1A 80)'
    );
    ok(
      (await w.scannerCounts(at('IKE'), { kwp: false, raw: null })).errors ===
        5,
      'DS2 fault count from C731 [00]: 5'
    );
    ok(
      (await w.scannerCounts(at('DME'), { kwp: true, raw: null })).errors === 2,
      'KWP fault count from C358: 2'
    );
    const cl = await w.scannerClearFaults(at('IKE'), {
      kwp: false,
      raw: null,
    });
    ok(
      !cl.ok && /not available/.test(cl.error),
      'clear is refused on this cable'
    );
    const sent = dev.plain.map(cmdOf);
    ok(
      sent.every((c) => ALLOWED.has(c)),
      'only read words went out: ' +
        [...new Set(sent)].map((c) => c.toString(16)).join(' ')
    );
    const dme12 = dev.plain.find((f) => cmdOf(f) === 0x83f0);
    ok(dme12 && dme12[3] === 0x80, '83F0 once, to the first module asked');
    await cable.disconnect();
    ok(
      !cable.connected && pasoftBusRefusal() === null,
      'disconnect: no refusal any more'
    );
    ok(w.scannerPasoft() === null, 'and the scanner no longer picks it');
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
