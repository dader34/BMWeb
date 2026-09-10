/**
 * @file The other end of the gateway: a remote cable with the Web Serial
 * API's shape.
 *
 * WHY THE SAME SHAPE AGAIN. NodeSerialPort exists because the app's bus is
 * written against open/close, a reader, a writer and setSignals/getSignals,
 * and giving Node that surface runs the bus unchanged with every wire fact
 * intact. A remote cable is the same argument once more: present the socket
 * as that same four-part surface and connectBus swaps one for the other,
 * with no line of transport code aware that the car is somewhere else.
 *
 * WHAT MOVES AND WHAT DOES NOT. Bytes and line states move. The framing,
 * the checksums, the echo strip, the reopen for a concept change, the
 * timeouts and the write gate all stay on this side, where the bus and the
 * command are. The host is a pipe.
 */
import { CliError } from './args.ts';
import type {
  InputSignals,
  OutputSignals,
  PortConfig,
  ReadResult,
  SerialReader,
  SerialWriter,
} from './serial.ts';
import { connectWs, type WsConnection } from './ws.ts';

/** How long a control call waits for the host's reply, in ms. */
const REPLY_MS = 10000;

/**
 * Turn what the user typed into a ws:// URL.
 *
 * `--gateway 192.168.1.9:6801`, `--gateway ws://192.168.1.9:6801` and a
 * bare host all mean the same thing; anything already carrying a scheme is
 * left alone so a wss:// front end can be named.
 * @param value - the --gateway value
 * @returns the URL
 */
export function gatewayUrl(value: string): string {
  const text = String(value || '').trim();
  if (!text) throw new CliError('--gateway needs a host:port or a ws:// URL');
  if (/^wss?:\/\//i.test(text)) return text;
  if (/^https?:\/\//i.test(text)) return text.replace(/^http/i, 'ws');
  return `ws://${text.includes(':') ? text : `${text}:6801`}`;
}

/**
 * A serial port with the Web Serial API's surface, over a gateway socket.
 *
 * The reader queues what the host streams and resolves one chunk per read,
 * or `done` once the port is closed or the reader cancelled, which is what
 * readSome and the bus's drain rely on. It is deliberately the same
 * behaviour NodeSerialPort's reader has, because the bus reads both the
 * same way.
 */
export class GatewayPort {
  readonly url: string;
  private conn: WsConnection | null = null;
  /** the device the host reports serving, for the cable chip */
  private device = '';
  /** is a port open on the host */
  private opened = false;
  /** chunks the host sent and no read has taken */
  private chunks: Uint8Array[] = [];
  /** reads waiting for bytes, oldest first, when the queue is empty */
  private waiters: ((r: ReadResult) => void)[] = [];
  /** control calls in flight, by the id they will be answered with */
  private pending = new Map<
    number,
    { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void }
  >();
  /** the next control message's id */
  private nextId = 1;
  /** why the socket went, once it has */
  private gone: string | null = null;

  /**
   * @param url - the gateway's ws:// URL
   */
  constructor(url: string) {
    this.url = url;
  }

  /**
   * Open the socket to the host. Called once, before the bus takes the
   * port, so a gateway that is not there is reported before anything else.
   * @returns nothing
   */
  async dial(): Promise<void> {
    let conn: WsConnection;
    try {
      conn = await connectWs(this.url);
    } catch (e) {
      throw new CliError(
        `cannot reach the gateway at ${this.url}: ${(e as Error).message}`
      );
    }
    this.conn = conn;
    conn.on({
      onText: (text) => this.onControl(text),
      onBinary: (bytes) => this.push(bytes),
      onClose: (code, reason) => {
        this.gone =
          reason ||
          (code === 1008
            ? 'the gateway already has a client'
            : 'the gateway closed the connection');
        this.opened = false;
        // every waiting read is told done, every waiting call is failed:
        // a silent hang here would look to the app like a dead ECU
        this.wakeAll();
        for (const p of this.pending.values())
          p.rej(new Error(`the gateway connection ended: ${this.gone}`));
        this.pending.clear();
      },
    });
  }

  /** Is a port open on the host (Web Serial's SerialPort.connected). */
  get connected(): boolean {
    return this.opened;
  }

  /** What the host is serving, for the cable chip. */
  get remoteDevice(): string {
    return this.device;
  }

  /**
   * One control message from the host: a reply, or an event.
   * @param text - the JSON frame
   */
  private onControl(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return; // a frame this end cannot read is not a reply it is waiting on
    }
    if (typeof msg.event === 'string') {
      if (msg.event === 'hello' && typeof msg.port === 'string')
        this.device = msg.port;
      return;
    }
    const id = typeof msg.id === 'number' ? msg.id : null;
    if (id === null) return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (msg.ok === false)
      p.rej(new Error(String(msg.error || 'the gateway refused the call')));
    else p.res(msg);
  }

  /**
   * Send one control message and wait for its reply.
   * @param op - the operation
   * @param extra - the operation's fields
   * @returns the reply
   */
  private call(
    op: string,
    extra: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const conn = this.conn;
    if (!conn || this.gone)
      return Promise.reject(
        new Error(
          `the gateway connection is gone: ${this.gone || 'not dialled'}`
        )
      );
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`the gateway did not answer ${op} in ${REPLY_MS} ms`));
      }, REPLY_MS);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      this.pending.set(id, {
        res: (v) => {
          clearTimeout(timer);
          res(v);
        },
        rej: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      });
      conn.sendText(JSON.stringify({ id, op, ...extra }));
    });
  }

  /**
   * Open the remote device with the given settings.
   * @param cfg - baud, bits, parity
   */
  async open(cfg: PortConfig): Promise<void> {
    await this.call('open', { config: cfg });
    this.chunks = [];
    this.opened = true;
  }

  /** Close the remote device: a waiting read is told done. */
  async close(): Promise<void> {
    this.opened = false;
    this.wakeAll();
    this.chunks = [];
    if (!this.gone) await this.call('close');
  }

  /** Drop the socket itself, once the bus is finished with the port. */
  hangUp(): void {
    this.opened = false;
    this.wakeAll();
    if (this.conn && !this.gone) this.conn.close();
    this.conn = null;
  }

  /** Tell every waiting read the port is done, and forget them. */
  private wakeAll(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w({ value: undefined, done: true });
  }

  /**
   * Bytes the host streamed: to the waiting read, else queued.
   * @param chunk - the bytes
   */
  private push(chunk: Uint8Array): void {
    if (!chunk.length) return;
    const w = this.waiters.shift();
    if (w) {
      w({ value: chunk, done: false });
      return;
    }
    this.chunks.push(chunk);
  }

  /** The readable side: getReader() hands back the one reader. */
  get readable(): { getReader(): SerialReader } {
    return {
      getReader: () => ({
        read: () => this.read(),
        cancel: async () => this.cancel(),
        releaseLock: () => {},
      }),
    };
  }

  /** The writable side: getWriter() hands back the one writer. */
  get writable(): { getWriter(): SerialWriter } {
    return {
      getWriter: () => ({
        write: (bytes: Uint8Array) => this.write(bytes),
        releaseLock: () => {},
      }),
    };
  }

  /**
   * One read: the next chunk, or `done` when the port is closed.
   *
   * Waiters queue, as they do on a local port: the bus races a read against
   * a timeout and takes a fresh reader on every reopen, and a single waiter
   * slot would orphan the abandoned read and hand its bytes to whichever
   * handle happened to be held.
   * @returns the read result
   */
  private read(): Promise<ReadResult> {
    const next = this.chunks.shift();
    if (next) return Promise.resolve({ value: next, done: false });
    if (!this.opened) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Cancel the reader: a waiting read is told done, buffered bytes go. */
  private cancel(): void {
    this.chunks = [];
    this.wakeAll();
  }

  /**
   * Write bytes. As on a local port this resolves when the bytes are on
   * their way, not when they have left the car's wire: the bus then holds
   * DTR for the telegram's own byte time, and waiting for more here would
   * lengthen that hold and lose the ECU's answer.
   * @param bytes - the framed request
   */
  private async write(bytes: Uint8Array): Promise<void> {
    if (!this.opened) throw new Error(`${this.url} is not open`);
    const conn = this.conn;
    if (!conn) throw new Error(`the gateway connection is gone`);
    conn.sendBinary(bytes);
  }

  /**
   * Drive the remote modem lines. The host keeps the lines the call does
   * not name, exactly as a local port does.
   * @param s - the lines to set
   */
  async setSignals(s: OutputSignals): Promise<void> {
    if (!this.opened) throw new Error(`${this.url} is not open`);
    await this.call('setSignals', { signals: s });
  }

  /**
   * Read the remote modem lines (KL15 arrives on DSR of a K+DCAN cable).
   * @returns the lines, or null when the host cannot say
   */
  async getSignals(): Promise<InputSignals | null> {
    const r = await this.call('getSignals');
    const sig = r.signals as InputSignals | null | undefined;
    return sig || null;
  }

  /**
   * The USB ids. A gateway does not forward them: the chip says where the
   * cable is instead, which is the fact worth showing when it is not here.
   * @returns nothing known
   */
  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    return {};
  }

  /** Web Serial's disconnect event; the socket's close stands in for it. */
  addEventListener(): void {}
}
