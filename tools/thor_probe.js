#!/usr/bin/env node
// First contact with the THOR WiFi dongle -- a Deep-OBD-style custom adapter
// (ESP-Link WiFi bridge + adapter MCU), NOT an ELM327. Its api32.dll shim is
// EdiabasLib with ObdComPort=DEEPOBDWIFI, and this speaks the same protocol:
// BMW-FAST-framed adapter telegrams on 192.168.4.1:23.
//
//   node tools/thor_probe.js [host] [port]
//
// The ident conversation never touches the car, so it works parked next to
// any vehicle: the special telegrams are addressed F1 -> F1 (tester to
// tester) and the adapter MCU answers them itself. Sequence and offsets
// mirror EdCustomAdapterCommon.UpdateAdapterInfo in EdiabasLib:
//
//   82 F1 F1 FE FE <chk>   ignition status  (answer 6 bytes, status at +4)
//   82 F1 F1 FD FD <chk>   firmware         (answer 9, type at +4/5, ver +6/7)
//   82 F1 F1 FB FB <chk>   serial           (answer 13, 8 bytes at +4)
//   82 F1 F1 FC FC <chk>   battery voltage  (answer 6, value at +4)
//
// The adapter ECHOES each request, then appends its answer; the checksum is
// an 8-bit sum over the preceding bytes.

const net = require('net');

const HOST = process.argv[2] || '192.168.4.1';
const PORT = Number(process.argv[3] || 23);

const sum8 = (bytes) => bytes.reduce((a, b) => (a + b) & 0xff, 0);
const tel = (cmd) => {
  const t = [0x82, 0xf1, 0xf1, cmd, cmd];
  t.push(sum8(t));
  return Buffer.from(t);
};
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

const sock = new net.Socket();
let rx = Buffer.alloc(0);
sock.on('data', (d) => {
  rx = Buffer.concat([rx, d]);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// send one ident telegram, collect echo + answer, validate both
async function ident(cmd, respLen, timeoutMs = 3000) {
  const req = tel(cmd);
  rx = Buffer.alloc(0); // discard, like EdiabasLib does
  sock.write(req);
  const deadline = Date.now() + timeoutMs;
  const want = req.length + respLen;
  while (rx.length < want && Date.now() < deadline) await wait(20);
  if (rx.length < want)
    throw new Error(
      `0x${cmd.toString(16)}: ${rx.length}/${want} bytes (${hex(rx) || 'nothing'})`
    );
  // the echo may be preceded by bridge chatter; find it rather than assume
  const at = rx.indexOf(req);
  if (at < 0) throw new Error(`0x${cmd.toString(16)}: no echo in ${hex(rx)}`);
  const resp = rx.slice(at + req.length, at + req.length + respLen);
  if (sum8([...resp.slice(0, respLen - 1)]) !== resp[respLen - 1])
    throw new Error(`0x${cmd.toString(16)}: bad checksum in ${hex(resp)}`);
  return resp;
}

(async () => {
  console.log(`connecting to ${HOST}:${PORT} ...`);
  await new Promise((res, rej) => {
    sock.setTimeout(10000, () =>
      rej(new Error(`connect to ${HOST}:${PORT} timed out`))
    );
    sock.once('error', rej);
    sock.connect(PORT, HOST, res);
  });
  sock.setTimeout(0); // connected; ident() owns per-telegram timeouts
  sock.on('error', (e) => {
    console.error('socket:', e.message);
    process.exit(1);
  });
  await wait(300); // let the bridge say anything it wants
  if (rx.length) console.log('bridge banner:', hex(rx));
  console.log('connected\n');

  const ign = await ident(0xfe, 6);
  console.log(
    `ignition:  raw ${hex(ign)}  -> status ${ign[4]}` +
      ` (${ign[4] & 0x01 ? 'ON' : 'off'})`
  );

  const fw = await ident(0xfd, 9);
  const type = (fw[4] << 8) | fw[5];
  const ver = (fw[6] << 8) | fw[7];
  console.log(
    `firmware:  raw ${hex(fw)}  -> adapter type ${type}, version ${ver}`
  );

  if (type >= 2) {
    const ser = await ident(0xfb, 13);
    console.log(`serial:    ${hex(ser.slice(4, 12))}`);
    const volt = await ident(0xfc, 6);
    console.log(
      `battery:   raw value ${volt[4]}  (~${(volt[4] / 10).toFixed(1)} V if /10)`
    );
  } else {
    console.log('(adapter type < 2: no serial/voltage telegrams)');
  }

  console.log(
    '\nadapter identified. This is the EdiabasLib custom protocol, ' +
      'so raw BMW-FAST transport will work when the BMW is back.'
  );
  sock.destroy();
})().catch((e) => {
  console.error('probe failed:', e.message);
  sock.destroy();
  process.exit(1);
});
