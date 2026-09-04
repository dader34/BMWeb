#!/usr/bin/env node
// What does the adapter actually say to a WebSocket handshake?
//
//   node tools/thor_ws_probe.js [host] [path]
//
// The browser hides this. A page only ever learns "the connection failed" --
// never the status line, never the headers, never whether the ESP answered
// at all. Node has raw TCP, so it can speak the handshake by hand and print
// the reply byte for byte, which is the difference between "the route is
// missing", "the handshake is malformed", and "the upgrade worked but the
// UART is silent".
//
// Three steps, each answering one question:
//
//   1. plain GET      -- is the route there at all? (426 = yes, our handler)
//   2. real handshake -- does it return 101 with a correct accept key?
//   3. ident telegram -- do bytes reach the adapter MCU and come back?
//
// Step 3 is addressed F1 -> F1 (tester to tester), so the adapter answers it
// itself: no car, no ignition, no ECU. Safe anywhere.
const net = require('net');
const crypto = require('crypto');

const HOST = process.argv[2] || '192.168.4.1';
const PATH = process.argv[3] || '/bmweb';
const PORT = 80;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sum8 = (b) => b.reduce((a, x) => (a + x) & 0xff, 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One request, raw. Returns whatever came back within `ms`.
function raw(payload, ms = 3000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let rx = Buffer.alloc(0);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      resolve(rx);
    };
    sock.setTimeout(ms);
    sock.on('data', (d) => {
      rx = Buffer.concat([rx, d]);
    });
    sock.on('timeout', finish);
    sock.on('error', (e) => {
      rx = Buffer.from(`ERR ${e.message}`);
      finish();
    });
    sock.on('close', finish);
    sock.connect(PORT, HOST, () => sock.write(payload));
    setTimeout(finish, ms);
  });
}

// The handshake, held open so we can talk after it.
function handshake(ms = 4000) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const accept = crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    const sock = new net.Socket();
    let rx = Buffer.alloc(0);
    let settled = false;
    // THE BUFFER IS OWNED IN ONE PLACE. This listener stays attached for
    // the life of the socket and splits the stream itself: header bytes
    // before the blank line, frame bytes after. Resolving and letting the
    // caller attach its own 'data' handler loses whatever arrived in the
    // meantime AND re-reads the 101 response as a frame -- which decodes
    // to "TP/1.1 101 Switching Protocols" and looks exactly like a
    // firmware bug. It is not. It was this.
    const frames = []; // post-handshake bytes, in order
    let onFrames = null; // set by the caller once it is ready
    const give = (r) => {
      if (settled) return;
      settled = true;
      resolve({
        ...r,
        sock,
        key,
        accept,
        // Hand the caller a pull-based view instead of a snapshot.
        readFrames: () => Buffer.concat(frames),
        onData: (cb) => {
          onFrames = cb;
        },
      });
    };
    sock.setTimeout(ms);
    sock.on('data', (d) => {
      if (settled) {
        // already upgraded: this is frame data
        frames.push(d);
        if (onFrames) onFrames();
        return;
      }
      rx = Buffer.concat([rx, d]);
      const end = rx.indexOf('\r\n\r\n');
      if (end >= 0) {
        const rest = rx.slice(end + 4);
        if (rest.length) frames.push(rest); // frames can share the packet
        give({ head: rx.slice(0, end).toString('latin1') });
      }
    });
    sock.on('timeout', () => give({ head: null }));
    sock.on('error', (e) => give({ head: null, err: e.message }));
    sock.connect(PORT, HOST, () => {
      sock.write(
        `GET ${PATH} HTTP/1.1\r\n` +
          `Host: ${HOST}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n'
      );
    });
  });
}

// Client frames MUST be masked (RFC 6455 5.3); binary, never text.
function frame(payload) {
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  const head =
    payload.length < 126
      ? Buffer.from([0x82, 0x80 | payload.length])
      : Buffer.from([0x82, 0xfe, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, mask, body]);
}

function unframe(buf) {
  if (buf.length < 2) return null;
  const op = buf[0] & 0x0f;
  let len = buf[1] & 0x7f;
  let pos = 2;
  if (len === 126) {
    len = (buf[2] << 8) | buf[3];
    pos = 4;
  }
  if (buf.length < pos + len) return null;
  return { op, payload: buf.slice(pos, pos + len) };
}

(async () => {
  console.log(`\nprobing http://${HOST}${PATH}\n`);

  // ---- 1. is the route there?
  const get = await raw(`GET ${PATH} HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`);
  const getTxt = get.toString('latin1');
  console.log('1. plain GET (no upgrade headers)');
  console.log(`   ${getTxt.split('\r\n')[0] || '(nothing came back)'}`);
  if (/this endpoint is a websocket/i.test(getTxt)) {
    console.log('   -> our handler IS registered and running\n');
  } else if (/404/.test(getTxt)) {
    console.log(
      '   -> 404: the route is NOT in this firmware. Wrong image,\n' +
        '      or the build did not include cgiwsbridge.\n'
    );
    process.exit(1);
  } else {
    console.log(`   -> unexpected. Full reply:\n${getTxt.slice(0, 400)}\n`);
  }

  // ---- 2. does the upgrade complete?
  console.log('2. real WebSocket handshake');
  const hs = await handshake();
  if (!hs.head) {
    console.log(`   NOTHING came back${hs.err ? ` (${hs.err})` : ''}.`);
    console.log(
      '   -> the ESP accepted the socket then went silent, which is\n' +
        '      what a crash in the handler looks like.\n'
    );
    try {
      hs.sock.destroy();
    } catch {}
    process.exit(1);
  }
  const status = hs.head.split('\r\n')[0];
  console.log(`   ${status}`);
  for (const line of hs.head.split('\r\n').slice(1)) {
    if (line.trim()) console.log(`   ${line}`);
  }
  if (!/101/.test(status)) {
    console.log(
      '\n   -> no 101, so the upgrade was refused. If this is a 426,\n' +
        '      the handler did not see the Upgrade header: esp-link\n' +
        '      truncated it, or httpdGetHeader is case-sensitive in\n' +
        '      this build.\n'
    );
    try {
      hs.sock.destroy();
    } catch {}
    process.exit(1);
  }
  const gotAccept = (hs.head.match(/Sec-WebSocket-Accept:\s*(\S+)/i) || [])[1];
  const okAccept = gotAccept === hs.accept;
  console.log(
    `   accept key ${okAccept ? 'correct' : 'WRONG'}` +
      `${okAccept ? '' : ` (expected ${hs.accept}, got ${gotAccept})`}`
  );
  console.log('   -> upgraded\n');

  // ---- 3. do bytes reach the adapter MCU?
  console.log('3. firmware ident over the socket (82 F1 F1 FD FD 5E)');
  const tel = [0x82, 0xf1, 0xf1, 0xfd, 0xfd];
  tel.push(sum8(tel));
  hs.sock.write(frame(tel));
  // the handshake's own listener collects frame bytes; just poll its view
  for (let i = 0; i < 30 && hs.readFrames().length < 4; i++) await wait(100);
  await wait(300);
  const rx = hs.readFrames();

  if (!rx.length) {
    console.log('   no frames came back.');
    console.log(
      '   -> the socket is up but the UART is silent. Check the\n' +
        '      Serial baud on the esp-link Home page (should be\n' +
        '      230400), and that the adapter has power from the car.\n'
    );
    try {
      hs.sock.destroy();
    } catch {}
    process.exit(1);
  }
  const f = unframe(rx);
  if (!f) {
    console.log(
      `   ${rx.length} bytes, not a complete frame: ${hex(rx.slice(0, 24))}\n`
    );
    try {
      hs.sock.destroy();
    } catch {}
    process.exit(1);
  }
  console.log(
    `   opcode 0x${f.op.toString(16)} ` +
      `(${f.op === 2 ? 'BINARY - correct' : f.op === 1 ? 'TEXT - WRONG' : 'other'})`
  );
  console.log(`   ${f.payload.length} bytes: ${hex(f.payload)}`);

  const p = [...f.payload];
  // the adapter echoes the request, then appends its 9-byte answer
  const ans =
    p.length >= tel.length + 9
      ? p.slice(tel.length, tel.length + 9)
      : p.length >= 9
        ? p.slice(0, 9)
        : null;
  if (ans && sum8(ans.slice(0, 8)) === ans[8]) {
    const type = (ans[4] << 8) | ans[5];
    const ver = (ans[6] << 8) | ans[7];
    console.log(
      `\n   VALID IDENT: adapter type 0x${type.toString(16)}, ` +
        `firmware v${ver >> 8}.${ver & 0xff}`
    );
    console.log(
      '   -> the bridge works end to end. Point BMWeb at\n' +
        `      ws://${HOST}${PATH} and connect.\n`
    );
  } else {
    console.log('\n   bytes came back but they are not a valid ident.');
    console.log(
      '   -> something answered; if the checksum is wrong the path\n' +
        '      is corrupting data, if it is the echo alone the adapter\n' +
        '      MCU did not reply (check baud / car power).\n'
    );
  }
  try {
    hs.sock.destroy();
  } catch {}
  process.exit(0);
})();
