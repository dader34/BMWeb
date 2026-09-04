#!/usr/bin/env node
// WebSocket -> TCP relay for the THOR WiFi adapter.
//
//   node thor_bridge.js [adapter-host] [adapter-port]
//
// A browser can't open a TCP socket, and the THOR (a Deep-OBD-style EdiabasLib
// adapter behind an ESP-Link bridge) only listens on 192.168.4.1:23. This pipes
// every binary frame verbatim between ws://127.0.0.1:8124 and that socket -- no
// protocol knowledge here; framing/checksums live in the renderer. Retained for
// anyone who still runs it by hand (?relay=1); shipped builds use the adapter's
// own WebSocket firmware instead. Hand-rolled WS server so it needs only node.

const http = require('http');
const net = require('net');
const crypto = require('crypto');

const WS_PORT = 8124;
const ADAPTER_HOST = process.argv[2] || '192.168.4.1';
const ADAPTER_PORT = Number(process.argv[3] || 23);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ONLY PAGES THAT ARE THIS APP MAY DRIVE THE CABLE. The relay listens on
// 127.0.0.1, but "local" is not "trusted": any website open in the same
// browser can open ws://127.0.0.1:8124 too, and a browser cannot lie about
// the Origin header on a WebSocket upgrade -- so that header is the one
// thing that says who is really connecting. Accept the app's own homes:
//   - no Origin / "null"  -> a file:// offline copy, or a non-browser client
//   - localhost/127.0.0.1 -> a locally served build, any port
//   - the published site  -> must match app/renderer/CNAME
const SITE_ORIGIN = 'https://bmweb.danner.ink';
function originAllowed(origin) {
  if (!origin || origin === 'null') return true;
  if (origin === SITE_ORIGIN) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

// one server-to-client binary frame (unmasked, fin)
function wsFrame(payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x82, len]);
  else {
    head = Buffer.alloc(4);
    head[0] = 0x82;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  }
  return Buffer.concat([head, payload]);
}

// stateful parser for client frames (always masked). yields {op, payload}.
function frameParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      const masked = (buf[1] & 0x80) !== 0;
      const need = at + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.slice(at + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.slice(at, at + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
      }
      buf = buf.slice(need);
      onFrame(op, payload);
    }
  };
}

const server = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('THOR bridge: WebSocket only\n');
});

server.on('upgrade', (req, sock) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    console.log(`[ws] refused connection from origin ${origin}`);
    sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    sock.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    sock.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  console.log(
    `[ws] page connected, dialing ${ADAPTER_HOST}:${ADAPTER_PORT} ...`
  );
  const tcp = net.connect(ADAPTER_PORT, ADAPTER_HOST);
  const closeBoth = (why) => {
    console.log(`[--] closed (${why})`);
    try {
      sock.end();
    } catch {
      /* gone */
    }
    try {
      tcp.destroy();
    } catch {
      /* gone */
    }
  };

  tcp.on('connect', () => console.log('[tcp] adapter connected'));
  tcp.on('data', (d) => {
    console.log('[<-]', hex(d));
    sock.write(wsFrame(d));
  });
  tcp.on('error', (e) => closeBoth(`adapter: ${e.message}`));
  tcp.on('close', () => closeBoth('adapter closed'));

  sock.on(
    'data',
    frameParser((op, payload) => {
      if (op === 8) {
        closeBoth('page closed');
        return;
      }
      if (op === 9) {
        sock.write(
          Buffer.concat([Buffer.from([0x8a, payload.length]), payload])
        );
        return;
      }
      if (op === 1 || op === 2) {
        console.log('[->]', hex(payload));
        tcp.write(payload);
      }
    })
  );
  sock.on('error', (e) => closeBoth(`page: ${e.message}`));
  sock.on('close', () => closeBoth('page socket closed'));
});

server.listen(WS_PORT, '127.0.0.1', () => {
  console.log(
    `THOR bridge: ws://127.0.0.1:${WS_PORT} <-> tcp ${ADAPTER_HOST}:${ADAPTER_PORT}`
  );
  console.log(
    'open the web build with ?thor=1 (or Settings -> Adapter -> THOR WiFi)'
  );
});
