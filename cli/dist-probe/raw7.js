// src/args.ts
var CliError = class extends Error {
};

// src/serial.ts
var NodeSerialPort = class {
  path;
  opener;
  binding = null;
  /** chunks heard and not yet read */
  chunks = [];
  /** reads waiting for bytes, oldest first, when the queue is empty */
  waiters = [];
  /** the lines as last set, so a partial setSignals keeps the others */
  lines = { dtr: false, rts: false, brk: false };
  /** the wire trace sink, when the CLI wants one */
  info;
  /**
   * @param path - the device path
   * @param opener - how a binding is opened
   * @param info - vendor and product ids, when known (portLabel shows them)
   */
  constructor(path, opener, info = {}) {
    this.path = path;
    this.opener = opener;
    this.info = info;
  }
  /** Is a binding open (Web Serial's SerialPort.connected). */
  get connected() {
    return !!this.binding;
  }
  /**
   * Open the device with the given settings.
   * @param cfg - baud, bits, parity
   */
  async open(cfg) {
    if (this.binding) throw new Error(`${this.path} is already open`);
    const b = await this.opener(this.path, cfg);
    this.binding = b;
    this.chunks = [];
    b.onData((chunk) => this.push(chunk));
  }
  /**
   * Close the device: the binding goes, a waiting read is told `done`.
   */
  async close() {
    const b = this.binding;
    this.binding = null;
    this.wakeAll();
    this.chunks = [];
    if (b) await b.close();
  }
  /** Tell every waiting read the port is done, and forget them. */
  wakeAll() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w({ value: void 0, done: true });
  }
  /**
   * Bytes the binding heard: to the waiting read, else queued.
   * @param chunk - the bytes
   */
  push(chunk) {
    if (!chunk.length) return;
    const w = this.waiters.shift();
    if (w) {
      w({ value: chunk, done: false });
      return;
    }
    this.chunks.push(chunk);
  }
  /** The readable side: getReader() hands back the one reader. */
  get readable() {
    return {
      getReader: () => ({
        read: () => this.read(),
        cancel: async () => this.cancel(),
        releaseLock: () => {
        }
      })
    };
  }
  /** The writable side: getWriter() hands back the one writer. */
  get writable() {
    return {
      getWriter: () => ({
        write: (bytes) => this.write(bytes),
        releaseLock: () => {
        }
      })
    };
  }
  /**
   * One read: the next chunk, or `done` when the port is closed.
   * @returns the read result
   */
  read() {
    const next = this.chunks.shift();
    if (next) return Promise.resolve({ value: next, done: false });
    if (!this.binding) return Promise.resolve({ value: void 0, done: true });
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
  /**
   * Cancel the reader: a waiting read is told `done`, buffered bytes go.
   */
  cancel() {
    this.chunks = [];
    this.wakeAll();
  }
  /**
   * Write bytes. Resolves when the OS has them, not when they have left the
   * wire: the bus then holds DTR for the telegram's own byte time, and
   * waiting for transmission here would double that hold and lose the
   * ECU's answer (the reference interface's DtrTimeCorrCom is 0.3 ms).
   * @param bytes - the framed request
   */
  async write(bytes) {
    if (!this.binding) throw new Error(`${this.path} is not open`);
    await this.binding.write(bytes);
  }
  /**
   * Drive the modem lines. A partial call keeps the lines it does not name,
   * as Web Serial does; the binding always gets all three, because
   * `serialport` would otherwise assert the ones left unsaid.
   * @param s - the lines to set
   */
  async setSignals(s) {
    if (!this.binding) throw new Error(`${this.path} is not open`);
    if (s.dataTerminalReady !== void 0)
      this.lines.dtr = !!s.dataTerminalReady;
    if (s.requestToSend !== void 0) this.lines.rts = !!s.requestToSend;
    if (s.break !== void 0) this.lines.brk = !!s.break;
    await this.binding.set({ ...this.lines });
  }
  /**
   * Read the modem lines (KL15 arrives on DSR or DCD of a K+DCAN cable).
   * @returns the lines, or null when the binding cannot say
   */
  async getSignals() {
    if (!this.binding) return null;
    const st = await this.binding.get();
    if (!st) return null;
    return {
      dataSetReady: !!st.dsr,
      dataCarrierDetect: !!st.dcd,
      clearToSend: !!st.cts
    };
  }
  /**
   * The USB ids, for the bus's port label.
   * @returns what is known
   */
  getInfo() {
    return this.info;
  }
  /** Web Serial's disconnect event; a pulled USB cable is not watched here. */
  addEventListener() {
  }
};
var serialportModule = null;
async function loadSerialport() {
  if (serialportModule) return serialportModule;
  try {
    serialportModule = await import("serialport");
  } catch {
    throw new CliError(
      "the serialport package is not installed; run: npm i -g serialport (or reinstall bmweb-cli with its optional dependencies)"
    );
  }
  return serialportModule;
}
async function openSerialportBinding(path, cfg) {
  const mod = await loadSerialport();
  const port2 = new mod.SerialPort({
    path,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: cfg.parity,
    autoOpen: false,
    // keep the lines where we leave them across close/open
    hupcl: false
  });
  await new Promise(
    (res, rej) => port2.open(
      (e) => e ? rej(new CliError(`cannot open ${path}: ${e.message}`)) : res()
    )
  );
  const call = (fn) => new Promise((res, rej) => fn((e) => e ? rej(e) : res()));
  const binding = {
    write: (bytes) => call((cb) => port2.write(Buffer.from(bytes), cb)),
    onData: (fn) => port2.on("data", (b) => fn(new Uint8Array(b))),
    set: (s) => call(
      (cb) => port2.set(
        {
          dtr: s.dtr,
          rts: s.rts,
          brk: s.brk,
          cts: false,
          dsr: false,
          ...process.platform === "linux" ? { lowLatency: true } : {}
        },
        cb
      )
    ),
    get: () => new Promise((res) => port2.get((e, st) => res(e || !st ? null : st))),
    close: () => new Promise((res) => port2.close(() => res()))
  };
  await binding.set({ dtr: false, rts: false, brk: false });
  return binding;
}

// ../../probe/raw7.ts
var port = new NodeSerialPort(process.argv[2] || "/dev/cu.usbserial-AH01BRM5", openSerialportBinding);
await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: "even" });
var reader = port.readable.getReader();
var writer = port.writable.getWriter();
var pending = reader.read();
await writer.write(new Uint8Array([184, 18, 241, 2, 26, 128, 195]));
var r = await Promise.race([pending, new Promise((res) => setTimeout(() => res("TIMEOUT"), 1200))]);
var v = r.value;
console.log("no-setSignals armed-first read:", r === "TIMEOUT" ? "TIMEOUT" : [...v || []].map((x) => x.toString(16).padStart(2, "0")).join(" "));
await port.close();
process.stdout.write("", () => process.exit(0));
