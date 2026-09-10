/**
 * @file `gateway`: one machine owns the cable, another drives it.
 *
 * WHAT THIS IS. A dumb byte pipe with the Web Serial API's shape on both
 * ends. The host opens the local serial port exactly as `job` does and
 * serves it over a WebSocket; the client (this package's GatewayPort, or
 * the app's gateway-port.js in a browser) presents that socket as a port
 * object and hands it to the app's own bus. Every wire fact the transport
 * knows -- the reopen for a concept change, DTR as the K-line transmit
 * enable, the echo dropped by count, the timeouts measured to the first
 * byte -- runs on the CLIENT, unchanged, because the client is where the
 * bus is. The host only moves bytes and line states.
 *
 * WHAT THIS IS NOT. It is not a gate. The write gate lives on the client
 * (the app's classifier, `job`'s y/N or --yes, the TUI's confirmations),
 * and this end never sees a job name, only bytes. So anyone who can reach
 * the listening port can drive the car: bind 127.0.0.1 unless a LAN is
 * meant, and treat --listen 0.0.0.0 as handing over the keys.
 *
 * THE PROTOCOL. JSON text frames for control, binary frames for the bytes
 * the wire carries, so a read arrives as one frame with no base64 and no
 * copy in either direction.
 *
 *   client -> host, text:   {"id":1,"op":"open","config":{...}}
 *                           {"id":2,"op":"close"}
 *                           {"id":3,"op":"setSignals","signals":{...}}
 *                           {"id":4,"op":"getSignals"}
 *   client -> host, binary: the bytes to write, exactly as given
 *   host -> client, text:   {"id":1,"ok":true}
 *                           {"id":4,"ok":true,"signals":{...}}
 *                           {"id":2,"ok":false,"error":"..."}
 *                           {"event":"hello","port":"/dev/cu.usbserial-X",...}
 *   host -> client, binary: bytes as they arrive off the wire, streamed
 *
 * The hello names the device the host is serving, so the client's cable
 * chip can say which cable, on which machine, is driving the car. The
 * WebSocket's own close carries everything else: there is no "goodbye"
 * message, because a socket that has gone cannot send one.
 *
 * A write needs no reply: the wire has no acknowledgement to give and the
 * app's own transport never waited for one. Every failure travels back as
 * the same message text a local port would have raised, so the client can
 * throw it verbatim and the app cannot tell the difference.
 */
import { CliError } from './args.ts';
import {
  choosePort,
  listPorts,
  NodeSerialPort,
  openSerialportBinding,
  type BindingOpener,
  type PortConfig,
  type PortInfo,
} from './serial.ts';
import {
  CLOSE_NORMAL,
  CLOSE_POLICY,
  listenWs,
  type WsConnection,
  type WsServer,
} from './ws.ts';

/** The default address the gateway listens on: this machine only. */
export const DEFAULT_LISTEN = '127.0.0.1:6801';

/** One control message from the client. */
interface Request {
  id?: number;
  op?: string;
  config?: PortConfig;
  signals?: Record<string, boolean>;
}

/** How the gateway is steered. */
export interface GatewayOptions {
  /** the device path; the single candidate when absent */
  port?: string;
  /** host:port to listen on (DEFAULT_LISTEN when absent) */
  listen?: string;
  /** how a binding is opened (a test hands in a fake car) */
  opener?: BindingOpener;
  /** the candidates, when a test supplies them */
  ports?: PortInfo[];
  /** where the log lines go (stdout unless a test captures them) */
  log?: (line: string) => void;
}

/** A running gateway. */
export interface RunningGateway {
  /** the port it is listening on */
  port: number;
  /** the host it bound to */
  host: string;
  /** the serial device it serves */
  device: string;
  /** stop listening, drop the client, close the cable */
  stop(): Promise<void>;
}

/**
 * Split a `host:port` (or a bare port, or a bare host) into its parts.
 * @param listen - the --listen value
 * @returns the host and port
 */
export function parseListen(listen: string): { host: string; port: number } {
  const [dh, dp] = DEFAULT_LISTEN.split(':') as [string, string];
  const text = String(listen || '').trim();
  if (!text) return { host: dh, port: Number(dp) };
  // a bare number is a port on the default host
  if (/^\d+$/.test(text)) return { host: dh, port: Number(text) };
  const at = text.lastIndexOf(':');
  if (at < 0) return { host: text, port: Number(dp) };
  const host = text.slice(0, at) || dh;
  const port = Number(text.slice(at + 1));
  // 0 is allowed and means "any free port the OS picks", which is how a
  // test binds without racing whatever else is on the machine
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new CliError(`--listen ${listen}: not a port number`);
  // an IPv6 literal is written [::1]:6801; strip the brackets for bind()
  return { host: host.replace(/^\[|\]$/g, ''), port };
}

/**
 * Serve one local serial port over a WebSocket.
 *
 * The cable is opened lazily, by the client's `open`, exactly as the bus
 * opens a local port: the gateway holds the device only while a client is
 * driving it, so the host machine can still use it in between.
 * @param opts - the device, the address, the log
 * @returns the running gateway
 */
export async function startGateway(
  opts: GatewayOptions = {}
): Promise<RunningGateway> {
  const log = opts.log || ((l: string) => process.stdout.write(`${l}\n`));
  const candidates = opts.ports || (await listPorts());
  const device = choosePort(opts.port, candidates);
  const opener = opts.opener || openSerialportBinding;
  const { host, port } = parseListen(opts.listen || DEFAULT_LISTEN);

  /** the one client allowed at a time, and the cable it is driving */
  let client: WsConnection | null = null;
  let serial: NodeSerialPort | null = null;
  /** the loop pumping the port's reader into the socket, while it runs */
  let pumping = false;

  /**
   * Close the cable, if one is open, and stop the pump.
   * @returns nothing
   */
  const dropCable = async (): Promise<void> => {
    const s = serial;
    serial = null;
    pumping = false;
    if (!s) return;
    try {
      await s.close();
    } catch {
      /* the device is going away either way */
    }
  };

  /**
   * Read the port forever and send every chunk on as a binary frame.
   *
   * WHY A PUMP. The app's timeouts are time-to-first-byte, so bytes must
   * cross the socket as they arrive rather than being gathered into an
   * answer: a read parked on the client is waiting for exactly this frame.
   * @param s - the open port
   * @param conn - the client to feed
   */
  const pump = async (s: NodeSerialPort, conn: WsConnection): Promise<void> => {
    const reader = s.readable.getReader();
    pumping = true;
    while (pumping && serial === s) {
      let r: { value?: Uint8Array; done: boolean };
      try {
        r = await reader.read();
      } catch {
        return; // the port went away; the close event says so
      }
      if (r.done) return;
      if (r.value && r.value.length && client === conn)
        conn.sendBinary(r.value);
    }
  };

  /**
   * Answer one control message.
   * @param conn - the client
   * @param req - what it asked
   */
  const handle = async (conn: WsConnection, req: Request): Promise<void> => {
    const id = req.id;
    /**
     * Send one reply, when the request carried an id to answer.
     * @param body - the reply fields beside the id
     */
    const reply = (body: Record<string, unknown>): void => {
      if (id === undefined) return;
      conn.sendText(JSON.stringify({ id, ...body }));
    };
    try {
      if (req.op === 'open') {
        if (serial) await dropCable();
        const s = new NodeSerialPort(device, opener);
        await s.open(req.config as PortConfig);
        serial = s;
        reply({ ok: true });
        // the pump runs for as long as this port lives; it is not awaited
        void pump(s, conn);
        return;
      }
      if (req.op === 'close') {
        await dropCable();
        reply({ ok: true });
        return;
      }
      if (req.op === 'setSignals') {
        if (!serial) throw new Error(`${device} is not open`);
        await serial.setSignals(req.signals || {});
        reply({ ok: true });
        return;
      }
      if (req.op === 'getSignals') {
        if (!serial) {
          // a local port answers null rather than throwing here, because
          // the bus reads the lines to poll KL15 whether or not it is open
          reply({ ok: true, signals: null });
          return;
        }
        reply({ ok: true, signals: await serial.getSignals() });
        return;
      }
      throw new Error(`unknown op ${String(req.op)}`);
    } catch (e) {
      // the same text a local port would have raised, so the client can
      // throw it verbatim and the app sees no difference
      reply({ ok: false, error: (e as Error).message || String(e) });
    }
  };

  const server: WsServer = await listenWs(host, port, (c) => {
    if (client) {
      log(`  refused ${c.from}: a client is already driving the cable`);
      c.conn.on({});
      c.conn.close(CLOSE_POLICY, 'this gateway already has a client');
      return;
    }
    client = c.conn;
    log(`  client ${c.from} connected`);
    /** control messages are serialised: one open must finish before the next */
    let queue: Promise<void> = Promise.resolve();
    c.conn.on({
      onText: (text) => {
        let req: Request;
        try {
          req = JSON.parse(text) as Request;
        } catch {
          c.conn.sendText(JSON.stringify({ ok: false, error: 'not JSON' }));
          return;
        }
        queue = queue.then(() => handle(c.conn, req));
      },
      onBinary: (bytes) => {
        // a write: straight to the wire, no reply. An error here cannot be
        // answered (the write carried no id), so it is logged and the next
        // control message reports the port as gone.
        const s = serial;
        if (!s) {
          log(`  write of ${bytes.length} bytes with no port open, dropped`);
          return;
        }
        const w = s.writable.getWriter();
        w.write(bytes).catch((e: Error) => {
          log(`  write failed: ${e.message}`);
        });
      },
      onClose: () => {
        if (client !== c.conn) return;
        client = null;
        log(`  client ${c.from} disconnected, cable closed`);
        void dropCable();
      },
    });
    c.conn.sendText(
      JSON.stringify({ event: 'hello', port: device, gateway: 'bmweb' })
    );
  });

  const shown = host === '0.0.0.0' || host === '::' ? host : host;
  log(`gateway: ${device} served at ws://${shown}:${server.port}`);
  log(
    '  this is a byte pipe with no gate of its own: anyone who can reach ' +
      'this port can drive the car.'
  );
  log(
    host === '127.0.0.1' || host === 'localhost' || host === '::1'
      ? '  listening on this machine only (--listen 0.0.0.0:PORT serves the LAN)'
      : '  listening beyond this machine; the port is open to whoever can route to it'
  );
  log('  one client at a time; the cable is closed when the client goes.');

  return {
    port: server.port,
    host,
    device,
    stop: async () => {
      await server.close();
      client = null;
      await dropCable();
    },
  };
}

/**
 * `gateway`: serve the cable and stay up until Ctrl+C.
 *
 * The command does not return lines the way the others do; it prints as it
 * goes and resolves when the process is asked to stop.
 * @param opts - see GatewayOptions
 * @returns nothing, once stopped
 */
export async function gatewayCommand(
  opts: GatewayOptions = {}
): Promise<string[]> {
  const g = await startGateway(opts);
  await new Promise<void>((res) => {
    /**
     * Ctrl+C: close the cable and the socket, then let the process end.
     */
    const bye = (): void => {
      process.off('SIGINT', bye);
      process.off('SIGTERM', bye);
      process.stdout.write('\ngateway: stopping, the cable is closed\n');
      g.stop().then(res, res);
    };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  });
  return [];
}
