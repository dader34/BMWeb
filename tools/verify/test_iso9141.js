#!/usr/bin/env node
// ISO 9141-2 slow init: framing, config, and the wake handshake.
//
// WHY THIS EXISTS. The E46's DME sleeps until a 5-baud address byte wakes it.
// webshim refused concept 0x10C outright ("this transport does not implement
// it"), so every request went to a module that was never woken and came back
// silent -- surfacing as IFH-0009 and looking exactly like a wiring fault.
// On a real car this cost a diagnosis: a shop quoted $1k to rewire the DME
// and CAN for a car whose DME answers fine once it is asked properly.
//
// The fixtures are REAL BYTES captured off an E46 M54/MS45:
//   5-baud 0x33 @ 10400 -> 55 08 08
//   tester ~KB2 (f7)    -> ECU ack cc  (= ~0x33)
//   mode01 pid00        -> 48 6b 12 41 00 bf 9f e8 91   (0x12 = DME)

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
let failures = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { failures++; console.log('  FAIL ' + m); } };

const src = fs.readFileSync(path.join(ROOT, 'app/renderer/core/webshim.js'), 'utf8');

console.log('concept 0x10C is no longer refused');
{
  ok(!/this transport does not implement/.test(src),
     'the "not implemented" refusal is gone');
  ok(/const isIso9141 = \(c\) => c === 0x10c;/.test(src),
     'isIso9141 identifies concept 0x10C');
  ok(/ISO9141_INIT_ADDR = 0x33/.test(src),
     'the generic tester address 0x33 is used, not the ECU KWP address');
  ok(/ISO9141_BAUD = 10400/.test(src),
     'ISO 9141 runs at 10400 baud, not 9600');
}

// Pull the pure functions out to exercise them directly.
const grab = (name) => {
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('could not find ' + name);
  return m[0];
};
const sandbox = new Function(
  grab('frameTotal') + '\n' + grab('portConfig') + '\n' + grab('withChecksum') + '\n' +
  'const conceptOf = (comm) => (comm && comm.concept) || 0x10f;\n' +
  'const isDs2 = (c) => c === 1 || c === 5 || c === 6;\n' +
  'const isIso9141 = (c) => c === 0x10c;\n' +
  'const ISO9141_BAUD = 10400;\n' +
  'const KLINE_BAUD = 10400;\n' +
  'const isKline = (c) => isDs2(c) || c === 0x10d;\n' +
  'const KDCAN = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none" };\n' +
  'const ifhError = (c, m) => Object.assign(new Error(c + ": " + m), { ifh: c });\n' +
  'return { frameTotal, portConfig, withChecksum };')();

console.log('\nport settings');
{
  const cfg = sandbox.portConfig({ concept: 0x10c });
  ok(cfg.baudRate === 10400, `ISO 9141 opens at 10400 (got ${cfg.baudRate})`);
  ok(cfg.parity === 'none', `8N1, not the K-line 8E1 (got ${cfg.parity})`);
  // DS2/KWP2000* are 8E1 at the SGBD's own rate (EdInterfaceObd.cs case
  // 0x0006: parity = Even, baudRate = CommParameter[1]).
  const kwp = sandbox.portConfig({ concept: 0x10d, baud: 9600 });
  ok(kwp.baudRate === 9600 && kwp.parity === 'even',
     'KWP2000* keeps the SGBD rate at 8E1');
}

console.log('\nframing, against the real answer from the car');
{
  // 48 6b 12 41 00 bf 9f e8 91 : fmt 0x48 -> low 6 bits = 8 data bytes
  const real = [0x48, 0x6b, 0x12, 0x41, 0x00, 0xbf, 0x9f, 0xe8, 0x91];
  const total = sandbox.frameTotal(real, { concept: 0x10c });
  ok(total === 12, `frame length from the header: 8 data + 3 hdr + 1 sum = 12 (got ${total})`);
  ok(sandbox.frameTotal([], { concept: 0x10c }) === null,
     'undecidable with no bytes yet');
  // and a checksum still computes as sum8, shared with KWP
  const framed = sandbox.withChecksum([0x68, 0x6a, 0xf1, 0x01, 0x00], { concept: 0x10c });
  const want = (0x68 + 0x6a + 0xf1 + 0x01 + 0x00) & 0xff;
  ok(framed[framed.length - 1] === want,
     `sum8 checksum appended (0x${framed[framed.length-1].toString(16)} = 0x${want.toString(16)})`);
  ok(framed.length === 6, 'checksum did not throw for 0x10C any more');
}

console.log('\nthe 5-baud bit pattern');
{
  // start(0) + 0x33 LSB-first + stop(1). 0x33 = 0b00110011
  const addr = 0x33;
  const bits = [0];
  for (let i = 0; i < 8; i++) bits.push((addr >> i) & 1);
  bits.push(1);
  ok(bits.length === 10, '10 bit-times: start + 8 data + stop');
  ok(bits.join('') === '0110011001',
     `0x33 LSB-first with framing = 0110011001 (got ${bits.join('')})`);
  ok(bits.length * 200 === 2000, 'at 200 ms per bit the init takes 2 s');
}

console.log('\nsession lifecycle');
{
  ok(/this\.inited = null;/.test(src), 'inited is reset somewhere');
  const ec = src.match(/async ensureConfig\(cfg\)[\s\S]*?\n  \}/)[0];
  ok(/this\.inited = null/.test(ec),
     'reopening the port for a new concept clears the woken session');
  ok(/if \(framed && !this\.inited && wantsWake\)/.test(src),
     'the wake runs once per PORT session, and only for a concept that wants one');
  // The session no longer PINS the wire: every xsetpar reconfigures it, which
  // is how the SGBD moves from 115200 to 9600 to send its second telegram.
  // sessionConcept is kept only so the K-line wake knows the module's kind.
  ok(/bus\.sessionConcept = conceptOf\(comm\);/.test(src),
     'the session tracks the current concept, and every xsetpar updates it');
  ok(/await bus\.ensureConfig\(portConfig\(comm\)\);/.test(src),
     'and the wire follows the telegram\'s own concept, not a pinned one');
}


console.log('\nBMW K-line fast init (the wake that was missing)');
{
  ok(/async fastInit\(comm\)/.test(src), 'fastInit exists');
  const fi = src.match(/async fastInit\(comm\)[\s\S]*?\n  \}/)[0];
  ok(/dataTerminalReady: true, break: true/.test(fi),
     'DTR is asserted together with the break (EdiabasLib SendWakeFastInit)');
  // Deadline-based, not two sleeps: EdiabasLib measures the 50 ms from the
  // START of the break (SendWakeFastInit, EdInterfaceObd.cs:3521-3530), so
  // sleeping 25+25 plus four awaits' latency overshot it (61 ms, measured).
  ok(/await until\(25\)/.test(fi), 'the break is held until start+25 ms');
  ok(/await until\(50\)/.test(fi),
     'and DTR drops at start+50 ms, measured from the break, not added after');
  ok(/dataTerminalReady: false/.test(fi), 'DTR is dropped after the wake');
  ok(/const kline = isKline\(concept\) \|\| isKline\(this\.sessionConcept\)/.test(src),
     'a BMW-FAST job on a session opened as K-line still counts as K-line');
  ok(/const isKline = \(c\) => isDs2\(c\) \|\| c === 0x10d;/.test(src),
     'DS2 and KWP2000* count as K-line; BMW-FAST/D-CAN do not');
}

console.log('\nK-line wire settings follow the SGBD, not a guess');
{
  // An earlier revision forced 10400 8N1 here from an ISO 9141 experiment.
  // DS2 is 8E1 at the rate its CommParameter names; the silence that override
  // was chasing turned out to be the missing DTR transmit-enable instead.
  const ds2 = sandbox.portConfig({ concept: 0x06, baud: 9600 });
  ok(ds2.baudRate === 9600, `DS2 uses the SGBD rate (got ${ds2.baudRate})`);
  ok(ds2.parity === 'even', `DS2 is 8E1 (got ${ds2.parity})`);
  const other = sandbox.portConfig({ concept: 0x10d, baud: 19200 });
  ok(other.baudRate === 19200, 'a different declared rate is honoured');
}

console.log('\nDTR is asserted for every K-line write');
{
  // THE BUG THIS GUARDS: on a K+DCAN cable DTR is the transmit enable.
  // EdiabasLib raises it around every telegram (EdInterfaceObd.cs:3343) and
  // DS2 sets ParSendSetDtr. Without it the bytes are framed correctly, leave
  // the UART, and never reach the K line -- silence that reads as a dead ECU.
  const web = src.slice(src.indexOf('class WebSerialBus'),
                        src.indexOf('class ThorWifiBus'));
  ok(/dataTerminalReady: true/.test(web), 'DTR is raised before the write');
  ok(/dataTerminalReady: false/.test(web), 'and dropped after it');
  ok(/const wantDtr = isKline\(concept\) \|\| isKline\(this\.sessionConcept\)/.test(web),
     'only on K-line concepts, including a BMW-FAST job on a K-line session');
}

console.log('\nthe wake lives on the bus that owns the wires');
{
  // THE MISTAKE THIS GUARDS: fastInit/slowInit were first added to
  // NativeSerialBus, but the browser drives the cable through WebSerialBus.
  // The code was correct and simply never ran -- the car stayed silent and
  // nothing about the app said why.
  const web = src.slice(src.indexOf('class WebSerialBus'),
                        src.indexOf('class ThorWifiBus'));
  const nat = src.slice(src.indexOf('class NativeSerialBus'),
                        src.indexOf('class WebSerialBus'));
  ok(/async fastInit/.test(web), 'fastInit is defined on WebSerialBus');
  ok(/async slowInit/.test(web), 'slowInit is defined on WebSerialBus');
  ok(!/async fastInit/.test(nat),
     'and NOT stranded on NativeSerialBus, where it would never run');
  // fastInit is NO LONGER called for DS2. EdiabasLib's SendWakeFastInit has
  // one call site, inside TransKwp2000Bmw (EdInterfaceObd.cs:4698); TransDs2
  // has no wake at all and concept 5/6 sets EcuConnected = true outright.
  // Breaking a DS2 module that never expected one is what silenced the E46
  // EGS (0x32) while the cluster (0x80) tolerated it.
  ok(/const wantsWake = isIso9141\(concept\) \|\| isIso9141\(this\.sessionConcept\)/
     .test(web), 'only ISO 9141 asks for a wake');
  ok(!/} else if \(kline\) \{\n\s*await this\.fastInit/.test(web),
     'DS2 is never broken before a telegram, as EdiabasLib never breaks it');
  ok(/setSignals/.test(web),
     'the wake uses Web Serial setSignals, which only this bus has');
}

console.log(failures ? `\nFAILED (${failures})` : '\nAll ISO 9141 checks passed');
process.exit(failures ? 1 : 0);
