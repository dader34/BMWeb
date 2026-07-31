#!/usr/bin/env node
// First contact with a WiFi ELM327 adapter (THOR etc.): connect, identify,
// and read the standard OBD-II surface of whatever car it is plugged into.
//
//   node tools/elm_probe.js [host] [port]     defaults: 192.168.0.10 35000
//
// This is a familiarization tool, not the app transport. It exists to learn
// how the adapter behaves -- init sequence, prompt discipline, protocol
// detection, multi-frame answers -- before a real transport is written
// against it. Everything here is generic SAE J1979: it reads any OBD-II car,
// which is the point (the BMW is in the shop; the Acura is not).
//
// The ELM327 conversation model: send an ASCII line, read until the '>'
// prompt. AT* lines configure the chip; bare hex lines are OBD requests the
// chip frames, sends, and answers with hex text.

const net = require('net');

const HOST = process.argv[2] || '192.168.0.10';
const PORT = Number(process.argv[3] || 35000);

// ---------------------------------------------------------------- transport

const sock = new net.Socket();
let buf = '';
let pending = null;

sock.on('data', (d) => {
  buf += d.toString('latin1');
  // '>' is the ELM's "ready for the next command"
  if (buf.includes('>') && pending) {
    const answer = buf.slice(0, buf.indexOf('>'));
    buf = '';
    const done = pending; pending = null;
    done.resolve(answer.replace(/\r/g, '\n').replace(/\n+/g, '\n').trim());
  }
});

function send(cmd, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending = null;
      reject(new Error(`no prompt after "${cmd}" in ${timeoutMs} ms`));
    }, timeoutMs);
    pending = { resolve: (a) => { clearTimeout(t); resolve(a); } };
    sock.write(cmd + '\r');
  });
}

// hex pairs out of an answer, dropping ELM chatter and multi-frame dressing
// ("0:" line counters, "SEARCHING...", the echoed length line on CAN)
function hexBytes(answer) {
  return answer.split('\n')
    .map((l) => l.replace(/^[0-9A-F]+:/i, ''))       // ISO-TP line counter
    .filter((l) => !/SEARCHING|BUS INIT|^[0-9A-F]{3}$/i.test(l.trim()))
    .join(' ')
    .match(/\b[0-9A-F]{2}\b/gi) || [];
}

// everything after a mode/pid echo (e.g. "49 02 01 ..." -> the ...)
function payload(answer, echo) {
  const b = hexBytes(answer).join(' ');
  const at = b.indexOf(echo);
  return at < 0 ? [] : b.slice(at + echo.length).trim().split(/\s+/).filter(Boolean);
}

const toCodes = (bytes) => {
  // DTC pairs: 2 bytes each, top 2 bits pick the letter
  const letter = ['P', 'C', 'B', 'U'];
  const out = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const a = parseInt(bytes[i], 16), b = parseInt(bytes[i + 1], 16);
    if (!a && !b) continue;
    out.push(letter[a >> 6] + ((a >> 4) & 3) + (a & 15).toString(16).toUpperCase()
      + b.toString(16).padStart(2, '0').toUpperCase());
  }
  return out;
};

// ---------------------------------------------------------------- the probe

(async () => {
  console.log(`connecting to ${HOST}:${PORT} ...`);
  await new Promise((res, rej) => {
    sock.once('error', rej);
    sock.connect(PORT, HOST, res);
  });
  sock.on('error', (e) => { console.error('socket:', e.message); process.exit(1); });
  console.log('connected\n');

  // who is this chip
  console.log('== adapter ==');
  console.log('reset:   ', (await send('ATZ')).replace(/\n/g, ' '));
  await send('ATE0');                       // echo off: answers only
  await send('ATL0');                       // no linefeed dressing
  console.log('version: ', await send('ATI'));
  console.log('voltage: ', await send('ATRV'));   // battery, from the OBD pin

  // let the chip find the car's protocol (the 0100 both triggers the search
  // and asks "which PIDs do you support" -- every OBD-II car answers it)
  console.log('\n== car ==');
  await send('ATSP0');
  const first = await send('0100', 15000);
  console.log('first answer:', first.replace(/\n/g, ' | '));
  console.log('protocol:    ', await send('ATDP'));

  if (/UNABLE|NO DATA|ERROR/i.test(first)) {
    console.log('\nno car answered. ignition on? adapter seated?');
    sock.destroy();
    return;
  }

  // identity
  const vin = payload(await send('0902', 15000), '49 02')
    .map((h) => parseInt(h, 16))
    .filter((c) => c >= 0x20 && c < 0x7f)
    .map((c) => String.fromCharCode(c)).join('').replace(/^\x01|[0-9]?$/, (m) => m);
  console.log('VIN:         ', vin || '(not reported)');

  // a few live values, decoded per J1979
  const rpmB = payload(await send('010C'), '41 0C');
  if (rpmB.length >= 2)
    console.log('RPM:         ', (parseInt(rpmB[0], 16) * 256 + parseInt(rpmB[1], 16)) / 4);
  const spd = payload(await send('010D'), '41 0D');
  if (spd.length)
    console.log('speed:       ', parseInt(spd[0], 16), 'km/h');
  const clt = payload(await send('0105'), '41 05');
  if (clt.length)
    console.log('coolant:     ', parseInt(clt[0], 16) - 40, '°C');

  // stored + pending fault codes
  const stored = toCodes(payload(await send('03', 15000), '43'));
  console.log('stored DTCs: ', stored.length ? stored.join(', ') : 'none');
  const pend = toCodes(payload(await send('07', 15000), '47'));
  console.log('pending DTCs:', pend.length ? pend.join(', ') : 'none');

  sock.destroy();
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
