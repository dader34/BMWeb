/**
 * @file A minimal WebSocket (RFC 6455) server and client over `node:net`.
 *
 * WHY THIS EXISTS. The package promises zero runtime dependencies, and the
 * gateway needs a socket both ends can speak: the CLI on one machine and a
 * browser page on the other. The browser already has WebSocket; Node has a
 * WebSocket CLIENT global only from version 22, and no server at all. So
 * the wire format is written here once, for both ends, rather than pulling
 * a package in and breaking the promise.
 *
 * What is implemented is the subset the gateway uses and nothing more: the
 * HTTP upgrade handshake, text and binary data frames (fragmented ones
 * reassembled), ping/pong, and close. No compression, no extensions, no
 * subprotocol negotiation. A client's frames are masked and a server's are
 * not, as the RFC requires, and a server rejects an unmasked client frame
 * rather than trying to read it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';

/** The GUID RFC 6455 appends to the client key before the SHA-1. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Frame opcodes; the gateway needs these five. */
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * The largest message either end will assemble, in bytes. A telegram is
 * tens of bytes, so a megabyte is generous; the cap exists so a confused
 * or hostile peer cannot make this process allocate without bound.
 */
const MAX_MESSAGE = 1 << 20;

/** The close code for a normal, deliberate close. */
export const CLOSE_NORMAL = 1000;

/** The close code for a policy refusal (a second client on the gateway). */
export const CLOSE_POLICY = 1008;

/** What a peer hands its owner: a message, a close, or an error. */
export interface WsHandlers {
  /** a text frame's payload */
  onText?(text: string): void;
  /** a binary frame's payload */
  onBinary?(bytes: Uint8Array): void;
  /** the connection ended, with the peer's code and reason when it sent one */
  onClose?(code: number, reason: string): void;
  /** the connection failed; onClose follows */
  onError?(err: Error): void;
}

/**
 * One WebSocket connection, either end of it.
 *
 * `masked` says how THIS end frames what it sends: a client masks, a
 * server does not. Incoming frames are checked against the opposite rule.
 */
export class WsConnection {
  private readonly socket: Socket;
  private readonly masked: boolean;
  private handlers: WsHandlers = {};
  /** bytes received and not yet parsed into a frame */
  private buf: Buffer = Buffer.alloc(0);
  /** the opcode of the message being assembled across continuation frames */
  private fragOp = 0;
  /** the fragments of that message */
  private frags: Buffer[] = [];
  /** how many bytes those fragments hold */
  private fragLen = 0;
  /** has a close frame been sent, so the next one is not sent twice */
  private closing = false;
  /** has onClose already fired */
  private closed = false;

  /**
   * @param socket - the open TCP socket, past the handshake
   * @param masked - true on the client end, which must mask what it sends
   */
  constructor(socket: Socket, masked: boolean) {
    this.socket = socket;
    this.masked = masked;
    // Nagle would hold a short telegram back waiting for more to send, and
    // the app's timeouts are time-to-first-byte: every millisecond of delay
    // here is a millisecond stolen from the ECU's answer window.
    socket.setNoDelay(true);
    socket.on('data', (d) => this.feed(d));
    socket.on('error', (e) => {
      this.handlers.onError?.(e);
      this.finish(1006, e.message);
    });
    socket.on('close', () => this.finish(1006, 'socket closed'));
  }

  /**
   * Take the handlers. Set once, right after construction, so no frame is
   * parsed before someone is listening.
   * @param h - the handlers
   */
  on(h: WsHandlers): void {
    this.handlers = h;
  }

  /**
   * Send a text frame.
   * @param text - the payload
   */
  sendText(text: string): void {
    this.send(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  /**
   * Send a binary frame.
   * @param bytes - the payload
   */
  sendBinary(bytes: Uint8Array): void {
    this.send(OP_BINARY, Buffer.from(bytes));
  }

  /**
   * Send a close frame and end the socket.
   * @param code - the close code
   * @param reason - the human reason, at most 123 bytes on the wire
   */
  close(code = CLOSE_NORMAL, reason = ''): void {
    if (this.closing) return;
    this.closing = true;
    const r = Buffer.from(reason, 'utf8').subarray(0, 123);
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    try {
      this.send(OP_CLOSE, body);
    } catch {
      /* the socket is already gone; the close is moot */
    }
    // give the frame a moment to leave before the FIN, then stop waiting
    this.socket.end();
  }

  /** Drop the socket without a close frame (a handshake refusal). */
  destroy(): void {
    this.closing = true;
    this.socket.destroy();
  }

  /**
   * Frame a payload and write it.
   * @param op - the opcode
   * @param payload - the bytes
   */
  private send(op: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeFrame(op, payload, this.masked));
  }

  /**
   * Take bytes off the socket and parse every whole frame in them.
   * @param chunk - what arrived
   */
  private feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const frame = decodeFrame(this.buf, !this.masked);
      if (frame === null) return; // not a whole frame yet
      if (frame instanceof Error) {
        this.handlers.onError?.(frame);
        this.close(1002, frame.message);
        return;
      }
      this.buf = this.buf.subarray(frame.size);
      this.handle(frame.fin, frame.op, frame.payload);
      if (this.closed) return;
    }
  }

  /**
   * One parsed frame: control frames answered here, data frames assembled.
   * @param fin - is this the message's last frame
   * @param op - the opcode
   * @param payload - the frame's bytes
   */
  private handle(fin: boolean, op: number, payload: Buffer): void {
    if (op === OP_PING) {
      this.send(OP_PONG, payload);
      return;
    }
    if (op === OP_PONG) return; // a keep-alive answer; nothing to do
    if (op === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString() : '';
      if (!this.closing) this.close(code === 1005 ? CLOSE_NORMAL : code, '');
      this.finish(code, reason);
      return;
    }
    if (op === OP_TEXT || op === OP_BINARY) {
      if (this.frags.length) {
        this.fail('a new message started before the last one finished');
        return;
      }
      this.fragOp = op;
    } else if (op !== OP_CONT) {
      this.fail(`unknown opcode 0x${op.toString(16)}`);
      return;
    } else if (!this.fragOp) {
      this.fail('a continuation frame with nothing to continue');
      return;
    }
    this.fragLen += payload.length;
    if (this.fragLen > MAX_MESSAGE) {
      this.fail(`message longer than ${MAX_MESSAGE} bytes`);
      return;
    }
    this.frags.push(payload);
    if (!fin) return;
    const body =
      this.frags.length === 1 ? this.frags[0]! : Buffer.concat(this.frags);
    const wasText = this.fragOp === OP_TEXT;
    this.frags = [];
    this.fragLen = 0;
    this.fragOp = 0;
    if (wasText) this.handlers.onText?.(body.toString('utf8'));
    else this.handlers.onBinary?.(new Uint8Array(body));
  }

  /**
   * A protocol violation: report it and close with 1002.
   * @param why - what was wrong
   */
  private fail(why: string): void {
    this.handlers.onError?.(new Error(why));
    this.close(1002, why);
  }

  /**
   * The connection is over: tell the owner once.
   * @param code - the close code
   * @param reason - the peer's reason
   */
  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose?.(code, reason);
  }
}

/** A frame taken off the buffer: where it ended, and what it said. */
interface Frame {
  fin: boolean;
  op: number;
  payload: Buffer;
  /** how many bytes of the buffer the frame occupied */
  size: number;
}

/**
 * Frame a payload.
 *
 * A masked frame carries a fresh 4-byte key and the payload XORed with it,
 * which is what the RFC asks of a client and what a browser server (and
 * this one) checks for.
 * @param op - the opcode
 * @param payload - the bytes
 * @param mask - mask the payload (client to server)
 * @returns the frame
 */
export function encodeFrame(
  op: number,
  payload: Buffer,
  mask: boolean
): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 0x10000 ? 4 : 10;
  const out = Buffer.alloc(head + (mask ? 4 : 0) + len);
  out[0] = 0x80 | op; // FIN set: every frame written here is a whole message
  if (len < 126) out[1] = len;
  else if (len < 0x10000) {
    out[1] = 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 127;
    // the high 32 bits are zero: MAX_MESSAGE keeps every payload far below
    out.writeUInt32BE(0, 2);
    out.writeUInt32BE(len, 6);
  }
  if (!mask) {
    payload.copy(out, head);
    return out;
  }
  // the mask bit, beside the length byte that is already in place
  out[1] = out[1]! | 0x80;
  const key = randomBytes(4);
  key.copy(out, head);
  for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i]! ^ key[i & 3]!;
  return out;
}

/**
 * Read one frame off the front of a buffer.
 * @param buf - the bytes received so far
 * @param wantMask - true when the peer must mask (a server reading a client)
 * @returns the frame, null when it is not all here yet, or an Error for a
 *   protocol violation
 */
export function decodeFrame(
  buf: Buffer,
  wantMask: boolean
): Frame | null | Error {
  if (buf.length < 2) return null;
  const b0 = buf[0]!;
  const b1 = buf[1]!;
  if (b0 & 0x70) return new Error('reserved frame bits are set');
  const fin = !!(b0 & 0x80);
  const op = b0 & 0x0f;
  const masked = !!(b1 & 0x80);
  if (masked !== wantMask)
    return new Error(
      wantMask ? 'a client frame was not masked' : 'a server frame was masked'
    );
  let len = b1 & 0x7f;
  let at = 2;
  if (len === 126) {
    if (buf.length < at + 2) return null;
    len = buf.readUInt16BE(at);
    at += 2;
  } else if (len === 127) {
    if (buf.length < at + 8) return null;
    const hi = buf.readUInt32BE(at);
    len = buf.readUInt32BE(at + 4);
    at += 8;
    if (hi) return new Error('frame longer than this end will read');
  }
  if (len > MAX_MESSAGE)
    return new Error(`frame longer than ${MAX_MESSAGE} bytes`);
  // a control frame is never fragmented and never longer than 125 bytes
  if (op >= 0x8 && (!fin || len > 125))
    return new Error('a malformed control frame');
  let key: Buffer | null = null;
  if (masked) {
    if (buf.length < at + 4) return null;
    key = buf.subarray(at, at + 4);
    at += 4;
  }
  if (buf.length < at + len) return null;
  const payload = Buffer.from(buf.subarray(at, at + len));
  if (key) for (let i = 0; i < len; i++) payload[i] = payload[i]! ^ key[i & 3]!;
  return { fin, op, payload, size: at + len };
}

/**
 * The Sec-WebSocket-Accept value for a client key.
 * @param key - the client's Sec-WebSocket-Key header
 * @returns the base64 accept value
 */
export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

/** A connection the server accepted, with where it came from. */
export interface WsClient {
  conn: WsConnection;
  /** the peer's address, for the log line */
  from: string;
}

/** A listening WebSocket server. */
export interface WsServer {
  /** the port actually bound (a 0 in the request resolves here) */
  port: number;
  /** the host it bound to */
  host: string;
  /** stop listening and drop every connection */
  close(): Promise<void>;
  /** the underlying TCP server, for the rare test that needs it */
  raw: Server;
}

/**
 * Listen for WebSocket connections.
 *
 * The handshake is the whole of the HTTP this speaks: anything that is not
 * a GET with an Upgrade to websocket and a key gets a 400 and the socket is
 * closed. That is deliberate, this is not a web server.
 * @param host - the interface to bind
 * @param port - the port, 0 for one the OS picks
 * @param onClient - called once per accepted connection
 * @returns the server
 */
export async function listenWs(
  host: string,
  port: number,
  onClient: (client: WsClient) => void
): Promise<WsServer> {
  const conns = new Set<WsConnection>();
  const server = createServer((socket) => {
    socket.setNoDelay(true);
    let head = Buffer.alloc(0);
    /**
     * Collect the request head, then either upgrade or refuse.
     * @param chunk - bytes off the socket
     */
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        // a request head this long is not one of ours
        if (head.length > 8192) socket.destroy();
        return;
      }
      socket.off('data', onData);
      const req = head.subarray(0, end).toString('utf8');
      const rest = head.subarray(end + 4);
      const key = /\r\nsec-websocket-key:[ \t]*(\S+)/i.exec(req)?.[1];
      const upgrade = /\r\nupgrade:[ \t]*websocket/i.test(req);
      if (!key || !upgrade || !/^GET /i.test(req)) {
        socket.end(
          'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n' +
            'Content-Length: 46\r\n\r\n' +
            'this port serves a WebSocket gateway, not HTTP\n'
        );
        return;
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
      );
      const conn = new WsConnection(socket, false);
      conns.add(conn);
      socket.on('close', () => conns.delete(conn));
      onClient({
        conn,
        from: `${socket.remoteAddress || '?'}:${socket.remotePort || 0}`,
      });
      // Bytes that arrived glued to the handshake are already frames. They
      // are re-emitted a tick later so the owner's onClient callback has
      // installed its handlers first: replaying them synchronously would
      // parse the first message before anything was listening for it.
      if (rest.length) setImmediate(() => socket.emit('data', rest));
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  });
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(port, host, () => {
      server.off('error', rej);
      res();
    });
  });
  const addr = server.address();
  return {
    port: typeof addr === 'object' && addr ? addr.port : port,
    host,
    raw: server,
    close: async () => {
      for (const c of conns) c.close(CLOSE_NORMAL, 'the gateway is stopping');
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}

/**
 * Open a WebSocket connection to a ws:// URL.
 *
 * Written rather than taken from the runtime because the package supports
 * Node 20, where there is no WebSocket global (it arrived in 22), and
 * because the same frame codec then serves both ends of the gateway.
 * @param url - a ws://host:port/path URL
 * @returns the connection, once the handshake succeeded
 */
export async function connectWs(url: string): Promise<WsConnection> {
  const u = new URL(url);
  if (u.protocol !== 'ws:')
    throw new Error(
      `${url}: only ws:// is supported here (wss:// needs a TLS front end)`
    );
  const port = Number(u.port || 80);
  const key = randomBytes(16).toString('base64');
  const socket = connect({ host: u.hostname, port });
  socket.setNoDelay(true);
  return new Promise<WsConnection>((res, rej) => {
    /**
     * Fail the connect attempt with a readable message.
     * @param e - what went wrong
     */
    const fail = (e: Error): void => {
      socket.destroy();
      rej(e);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(
        `GET ${u.pathname || '/'}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
      let head = Buffer.alloc(0);
      /**
       * Read the handshake answer, then hand the socket to a connection.
       * @param chunk - bytes off the socket
       */
      const onData = (chunk: Buffer): void => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          if (head.length > 8192)
            fail(new Error(`${url}: no handshake answer`));
          return;
        }
        socket.off('data', onData);
        const res101 = head.subarray(0, end).toString('utf8');
        if (!/^HTTP\/1\.1 101/i.test(res101)) {
          fail(
            new Error(
              `${url}: the server refused the WebSocket upgrade (${res101.split('\r\n')[0]})`
            )
          );
          return;
        }
        const accept = /\r\nsec-websocket-accept:[ \t]*(\S+)/i.exec(
          res101
        )?.[1];
        if (accept !== acceptKey(key)) {
          fail(new Error(`${url}: the handshake answer did not match the key`));
          return;
        }
        socket.off('error', fail);
        const rest = head.subarray(end + 4);
        const conn = new WsConnection(socket, true);
        // as on the server side: a tick later, so whoever awaited this
        // promise has taken the handlers before the first message parses
        if (rest.length) setImmediate(() => socket.emit('data', rest));
        res(conn);
      };
      socket.on('data', onData);
    });
  });
}
