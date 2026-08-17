#!/usr/bin/env node
// Does the adapter accept a SECOND connection after a first one goes away?
//
//   node tools/thor_ws_reconnect.js [host]
//
// The firmware allows one client at a time -- two diagnostic sessions on one
// K-line would corrupt each other's telegrams. That guard is only correct if
// the slot is released when a client leaves. If it is not, the first
// connection of the day works and every one after it gets 503 until the
// adapter is power-cycled, which is exactly the shape of "it connected once,
// now it will not".
//
// So: connect, ident, disconnect, then do it all again. Twice more, because
// a leak might only strand the slot on an abrupt close.
const net = require('net');
const crypto = require('crypto');

const HOST = process.argv[2] || '192.168.4.1';
const PORT = 80;
const PATH = '/bmweb';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const sum8 = (b) => b.reduce((a, x) => (a + x) & 0xff, 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function frame(payload) {
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  return Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, body]);
}

// One full session: handshake, ident, close the way `how` says.
function session(how) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = new net.Socket();
    let phase = 'head';
    let buf = Buffer.alloc(0);
    let status = null;
    let ident = null;
    let req = null;              // the ident telegram we sent (echo detection)
    let pay = [];                // ws-frame payloads accumulated so far
    const done = (r) => {
      try { how === 'destroy' ? sock.destroy() : sock.end(); } catch { /* gone */ }
      resolve({ status, ident, ...r });
    };
    sock.setTimeout(6000);
    sock.on('timeout', () => done({ err: 'timeout' }));
    sock.on('error', (e) => done({ err: e.message }));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (phase === 'head') {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        status = buf.slice(0, buf.indexOf('\r\n')).toString('latin1');
        buf = buf.slice(end + 4);
        phase = 'frames';
        if (!/101/.test(status)) return done({});
        req = [0x82, 0xF1, 0xF1, 0xFD, 0xFD];
        req.push(sum8(req));
        sock.write(frame(req));
      }
      while (phase === 'frames' && buf.length >= 2) {
        const len = buf[1] & 0x7f;
        if (buf.length < 2 + len) break;
        pay = pay.concat([...buf.slice(2, 2 + len)]);
        buf = buf.slice(2 + len);
        // The 9-byte answer may follow an echo of the request, or arrive
        // BARE on echo-suppressing firmware -- the same two shapes
        // thor_ws_probe.js handles. And echo + answer may land in separate
        // frames, so accumulate until something checksums; a session that
        // never does ends on the 6 s socket timeout with ident NONE.
        const ans = pay.length >= req.length + 9
                  ? pay.slice(req.length, req.length + 9)
                  : pay.length >= 9 ? pay.slice(0, 9) : null;
        if (ans && sum8(ans.slice(0, 8)) === ans[8]) {
          ident = `type 0x${((ans[4] << 8) | ans[5]).toString(16)} `
                + `v${ans[6]}.${ans[7]}`;
          return done({});
        }
      }
    });
    sock.connect(PORT, HOST, () => {
      sock.write(`GET ${PATH} HTTP/1.1\r\nHost: ${HOST}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
  });
}

(async () => {
  console.log(`\nreconnect test against ws://${HOST}${PATH}\n`);
  const ways = ['end', 'destroy', 'end'];
  let firstOk = null;
  for (let i = 0; i < ways.length; i++) {
    const r = await session(ways[i]);
    const ok = r.ident !== null;
    if (i === 0) firstOk = ok;
    console.log(`  attempt ${i + 1} (closed by ${ways[i]}):`);
    console.log(`    ${r.status || r.err || 'no reply'}`);
    console.log(`    ident: ${r.ident || 'NONE'}`);
    // give the ESP a moment to notice the close before reconnecting
    await wait(1500);
  }
  console.log('\nIf attempt 1 identifies and later ones return 503 or no ident,');
  console.log('the firmware is not releasing its single-client slot on close.');
  console.log('Power-cycle the adapter to confirm: if attempt 1 then works');
  console.log('again, that is the bug.\n');
  process.exit(0);
})();
