/**
 * @file A serial port with the Web Serial API's shape, over the `serialport`
 * package.
 *
 * WHY THE BROWSER'S SHAPE. The app's transport (core/webshim/web-serial-bus.js,
 * WebSerialBus) holds every wire fact that cost real debugging on a Mac with
 * an FTDI K+DCAN cable: DTR as the K-line transmit enable held for the
 * telegram's byte time and no longer, DTR idling high for BMW-FAST and D-CAN
 * and low on every K-line concept with RTS never raised, the 5-baud ISO 9141
 * slow init bit-banged on the break line, a 115200 8N1 port reopened at
 * 9600 8E1 when the SGBD's concept says so, the echo dropped by count, the
 * pre-write drain that never arms a read, and readSome keeping a timed-out
 * read on `pending` so its bytes are never lost. All of it is written
 * against the four things a Web Serial port offers: open/close with a
 * PortConfig, a reader, a writer, and setSignals/getSignals. Giving Node a
 * port with exactly that surface runs the bus UNCHANGED, wire facts
 * included, rather than porting them and hoping nothing was dropped.
 *
 * The package's only runtime dependency, `serialport`, is optional: the
 * offline commands never load it, and a missing install is reported with
 * the command that fixes it the moment a port is needed.
 */
import { readdirSync } from 'node:fs';
import { CliError } from './args.ts';

/** Web Serial / native port settings, as framing.js's PortConfig. */
export interface PortConfig {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: 'none' | 'even' | 'odd';
  dtr?: boolean;
}

/** The modem-line state the bus sets (Web Serial's SerialOutputSignals). */
export interface OutputSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

/** The modem lines the bus reads (Web Serial's SerialInputSignals). */
export interface InputSignals {
  dataSetReady: boolean;
  dataCarrierDetect: boolean;
  clearToSend: boolean;
}

/**
 * The little a port needs from its binding: write bytes, hear bytes, drive
 * and read the modem lines, close. The real one wraps `serialport`; a test
 * hands in a fake car on the other end of the wire.
 */
export interface PortBinding {
  write(bytes: Uint8Array): Promise<void>;
  onData(fn: (chunk: Uint8Array) => void): void;
  set(signals: { dtr: boolean; rts: boolean; brk: boolean }): Promise<void>;
  get(): Promise<{ dsr?: boolean; dcd?: boolean; cts?: boolean } | null>;
  close(): Promise<void>;
}

/** Opens a binding on a device path with the given settings. */
export type BindingOpener = (
  path: string,
  cfg: PortConfig
) => Promise<PortBinding>;

/** What a read resolves with (Web Serial's ReadableStreamReadResult). */
export interface ReadResult {
  value: Uint8Array | undefined;
  done: boolean;
}

/** One candidate device, as `bmweb ports` lists it. */
export interface PortInfo {
  path: string;
  detail: string;
}

/**
 * The device names a K+DCAN cable shows up under: FTDI and clones on
 * macOS (cu.usbserial*), Silicon Labs (cu.SLAB*), WCH (cu.wchusbserial*),
 * and the Linux USB serial and CDC-ACM nodes.
 */
export const PORT_PATTERNS: RegExp[] = [
  /^cu\.usbserial/i,
  /^cu\.SLAB/i,
  /^cu\.wchusbserial/i,
  /^ttyUSB/i,
  /^ttyACM/i,
];

/**
 * A serial port with the Web Serial API's surface, over a PortBinding.
 *
 * `open(cfg)` creates a binding with those settings and `close()` drops it;
 * the bus reopens the port for a concept change (parity cannot be changed on
 * an open port, so a fresh binding is the honest reopen). The reader queues
 * what the binding hears and resolves one chunk per read, or `done` once the
 * port closes or the reader is cancelled, which is what readSome and the
 * bus's drain rely on.
 */
export class NodeSerialPort {
  readonly path: string;
  private readonly opener: BindingOpener;
  private binding: PortBinding | null = null;
  /** chunks heard and not yet read */
  private chunks: Uint8Array[] = [];
  /** the one read waiting for bytes, when the queue is empty */
  private waiter: ((r: ReadResult) => void) | null = null;
  /** the lines as last set, so a partial setSignals keeps the others */
  private lines = { dtr: false, rts: false, brk: false };
  /** the wire trace sink, when the CLI wants one */
  readonly info: { usbVendorId?: number; usbProductId?: number };

  /**
   * @param path - the device path
   * @param opener - how a binding is opened
   * @param info - vendor and product ids, when known (portLabel shows them)
   */
  constructor(
    path: string,
    opener: BindingOpener,
    info: { usbVendorId?: number; usbProductId?: number } = {}
  ) {
    this.path = path;
    this.opener = opener;
    this.info = info;
  }

  /** Is a binding open (Web Serial's SerialPort.connected). */
  get connected(): boolean {
    return !!this.binding;
  }

  /**
   * Open the device with the given settings.
   * @param cfg - baud, bits, parity
   */
  async open(cfg: PortConfig): Promise<void> {
    if (this.binding) throw new Error(`${this.path} is already open`);
    const b = await this.opener(this.path, cfg);
    this.binding = b;
    this.chunks = [];
    b.onData((chunk) => this.push(chunk));
  }

  /**
   * Close the device: the binding goes, a waiting read is told `done`.
   */
  async close(): Promise<void> {
    const b = this.binding;
    this.binding = null;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
    this.chunks = [];
    if (b) await b.close();
  }

  /**
   * Bytes the binding heard: to the waiting read, else queued.
   * @param chunk - the bytes
   */
  private push(chunk: Uint8Array): void {
    if (!chunk.length) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
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
   * @returns the read result
   */
  private read(): Promise<ReadResult> {
    const next = this.chunks.shift();
    if (next) return Promise.resolve({ value: next, done: false });
    if (!this.binding) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /**
   * Cancel the reader: a waiting read is told `done`, buffered bytes go.
   */
  private cancel(): void {
    this.chunks = [];
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  /**
   * Write bytes. Resolves when the OS has them, not when they have left the
   * wire: the bus then holds DTR for the telegram's own byte time, and
   * waiting for transmission here would double that hold and lose the
   * ECU's answer (the reference interface's DtrTimeCorrCom is 0.3 ms).
   * @param bytes - the framed request
   */
  private async write(bytes: Uint8Array): Promise<void> {
    if (!this.binding) throw new Error(`${this.path} is not open`);
    await this.binding.write(bytes);
  }

  /**
   * Drive the modem lines. A partial call keeps the lines it does not name,
   * as Web Serial does; the binding always gets all three, because
   * `serialport` would otherwise assert the ones left unsaid.
   * @param s - the lines to set
   */
  async setSignals(s: OutputSignals): Promise<void> {
    if (!this.binding) throw new Error(`${this.path} is not open`);
    if (s.dataTerminalReady !== undefined)
      this.lines.dtr = !!s.dataTerminalReady;
    if (s.requestToSend !== undefined) this.lines.rts = !!s.requestToSend;
    if (s.break !== undefined) this.lines.brk = !!s.break;
    await this.binding.set({ ...this.lines });
  }

  /**
   * Read the modem lines (KL15 arrives on DSR or DCD of a K+DCAN cable).
   * @returns the lines, or null when the binding cannot say
   */
  async getSignals(): Promise<InputSignals | null> {
    if (!this.binding) return null;
    const st = await this.binding.get();
    if (!st) return null;
    return {
      dataSetReady: !!st.dsr,
      dataCarrierDetect: !!st.dcd,
      clearToSend: !!st.cts,
    };
  }

  /**
   * The USB ids, for the bus's port label.
   * @returns what is known
   */
  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    return this.info;
  }

  /** Web Serial's disconnect event; a pulled USB cable is not watched here. */
  addEventListener(): void {}
}

/** The reader the bus takes from `readable`. */
export interface SerialReader {
  read(): Promise<ReadResult>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

/** The writer the bus takes from `writable`. */
export interface SerialWriter {
  write(bytes: Uint8Array): Promise<void>;
  releaseLock(): void;
}

/** The subset of `serialport`'s module the CLI uses. */
interface SerialportModule {
  SerialPort: {
    new (opts: Record<string, unknown>): SerialportHandle;
    list(): Promise<
      {
        path: string;
        manufacturer?: string;
        vendorId?: string;
        productId?: string;
        serialNumber?: string;
      }[]
    >;
  };
}

/** The subset of a `serialport` port the binding drives. */
interface SerialportHandle {
  open(cb: (e: Error | null) => void): void;
  close(cb: (e: Error | null) => void): void;
  write(data: Buffer, cb: (e: Error | null | undefined) => void): boolean;
  on(event: 'data', fn: (chunk: Buffer) => void): void;
  set(
    opts: Record<string, boolean>,
    cb: (e: Error | null | undefined) => void
  ): void;
  get(
    cb: (
      e: Error | null | undefined,
      st?: { cts: boolean; dsr: boolean; dcd: boolean }
    ) => void
  ): void;
}

/** The loaded module, once. */
let serialportModule: SerialportModule | null = null;

/**
 * Load `serialport`, naming the install command when it is absent.
 * @returns the module
 */
export async function loadSerialport(): Promise<SerialportModule> {
  if (serialportModule) return serialportModule;
  try {
    serialportModule =
      (await import('serialport')) as unknown as SerialportModule;
  } catch {
    throw new CliError(
      'the serialport package is not installed; run: npm i -g serialport ' +
        '(or reinstall bmweb-cli with its optional dependencies)'
    );
  }
  return serialportModule;
}

/**
 * The real binding: a `serialport` port opened on the path with the
 * settings. RTS is never raised and DTR starts low; the bus sets the idle
 * level a concept wants right after open. On Linux the FTDI driver's
 * latency timer is asked for its 1 ms setting (ASYNC_LOW_LATENCY), the
 * value the reference interface wants; other platforms take the driver's
 * default, and an echo failure says how to change it.
 * @param path - the device path
 * @param cfg - the settings
 * @returns the binding
 */
export async function openSerialportBinding(
  path: string,
  cfg: PortConfig
): Promise<PortBinding> {
  const mod = await loadSerialport();
  const port = new mod.SerialPort({
    path,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: cfg.parity,
    autoOpen: false,
    // keep the lines where we leave them across close/open
    hupcl: false,
  });
  await new Promise<void>((res, rej) =>
    port.open((e) =>
      e ? rej(new CliError(`cannot open ${path}: ${e.message}`)) : res()
    )
  );
  const call = (
    fn: (cb: (e: Error | null | undefined) => void) => void
  ): Promise<void> =>
    new Promise((res, rej) => fn((e) => (e ? rej(e) : res())));
  const binding: PortBinding = {
    write: (bytes) => call((cb) => port.write(Buffer.from(bytes), cb)),
    onData: (fn) => port.on('data', (b) => fn(new Uint8Array(b))),
    set: (s) =>
      call((cb) =>
        port.set(
          {
            dtr: s.dtr,
            rts: s.rts,
            brk: s.brk,
            cts: false,
            dsr: false,
            ...(process.platform === 'linux' ? { lowLatency: true } : {}),
          },
          cb
        )
      ),
    get: () =>
      new Promise((res) => port.get((e, st) => res(e || !st ? null : st))),
    close: () => new Promise((res) => port.close(() => res())),
  };
  await binding.set({ dtr: false, rts: false, brk: false });
  return binding;
}

/**
 * The candidate ports on this machine: what the device directory shows
 * under the K+DCAN patterns, with `serialport`'s vendor detail when the
 * package is installed. Listing needs no package, so a fresh install can
 * find its cable before anything else works.
 * @param devDir - the device directory (a test points elsewhere)
 * @returns the candidates, sorted by path
 */
export async function listPorts(devDir = '/dev'): Promise<PortInfo[]> {
  const found = new Map<string, string>();
  try {
    for (const name of readdirSync(devDir))
      if (PORT_PATTERNS.some((re) => re.test(name)))
        found.set(`${devDir}/${name}`, '');
  } catch {
    /* no device directory here */
  }
  try {
    const mod = await loadSerialport();
    for (const p of await mod.SerialPort.list()) {
      const base = p.path.split('/').pop() || p.path;
      if (!PORT_PATTERNS.some((re) => re.test(base))) continue;
      const detail = [
        p.manufacturer,
        p.vendorId && p.productId ? `${p.vendorId}:${p.productId}` : '',
        p.serialNumber ? `sn ${p.serialNumber}` : '',
      ]
        .filter(Boolean)
        .join('  ');
      found.set(p.path, detail);
    }
  } catch {
    /* the package is optional: the directory listing stands */
  }
  return [...found.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, detail]) => ({ path, detail }));
}

/**
 * The port to use: the one named, else the single candidate, else an
 * error that lists what was found so the next call can name one.
 * @param wanted - the --port value, when given
 * @param candidates - listPorts()'s answer
 * @returns the device path
 */
export function choosePort(
  wanted: string | undefined,
  candidates: PortInfo[]
): string {
  if (wanted) return wanted;
  if (candidates.length === 1) return (candidates[0] as PortInfo).path;
  if (!candidates.length)
    throw new CliError(
      'no K+DCAN cable found (looked for cu.usbserial*, cu.SLAB*, cu.wchusbserial*, ttyUSB*, ttyACM*); pass --port <device>'
    );
  throw new CliError(
    `several ports found; pass --port: ${candidates.map((c) => c.path).join(', ')}`
  );
}
