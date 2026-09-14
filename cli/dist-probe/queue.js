// src/serial.ts
var NodeSerialPort = class {
  path;
  opener;
  binding = null;
  /** chunks heard and not yet read */
  chunks = [];
  /** the one read waiting for bytes, when the queue is empty */
  waiter = null;
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
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: void 0, done: true });
    }
    this.chunks = [];
    if (b) await b.close();
  }
  /**
   * Bytes the binding heard: to the waiting read, else queued.
   * @param chunk - the bytes
   */
  push(chunk) {
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
      this.waiter = resolve;
    });
  }
  /**
   * Cancel the reader: a waiting read is told `done`, buffered bytes go.
   */
  cancel() {
    this.chunks = [];
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: void 0, done: true });
    }
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

// ../../probe/queue.ts
var onData = null;
var fake = {
  write: async () => {
  },
  onData: (fn) => {
    onData = fn;
  },
  set: async () => {
  },
  get: async () => null,
  close: async () => {
  }
};
var port = new NodeSerialPort("/dev/fake", async (_p, _c) => fake);
await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: "even" });
onData(new Uint8Array([184, 241, 18, 31]));
var reader = port.readable.getReader();
var r = await reader.read();
console.log('after "drain", first read returns:', [...r.value || []].map((x) => x.toString(16)).join(" "));
console.log("=> queued bytes survive into the next exchange and are mistaken for its echo");
process.exit(0);
