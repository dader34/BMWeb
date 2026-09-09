// src/args.ts
var CliError = class extends Error {
};

// src/serial.ts
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
  const port = new mod.SerialPort({
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
    (res, rej) => port.open(
      (e) => e ? rej(new CliError(`cannot open ${path}: ${e.message}`)) : res()
    )
  );
  const call = (fn) => new Promise((res, rej) => fn((e) => e ? rej(e) : res()));
  const binding = {
    write: (bytes) => call((cb) => port.write(Buffer.from(bytes), cb)),
    onData: (fn) => port.on("data", (b) => fn(new Uint8Array(b))),
    set: (s) => call(
      (cb) => port.set(
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
    get: () => new Promise((res) => port.get((e, st) => res(e || !st ? null : st))),
    close: () => new Promise((res) => port.close(() => res()))
  };
  await binding.set({ dtr: false, rts: false, brk: false });
  return binding;
}

// ../../probe/raw4.ts
var PATH = process.argv[2] || "/dev/cu.usbserial-AH01BRM5";
async function attempt(label) {
  const b = await openSerialportBinding(PATH, { baudRate: 9600, dataBits: 8, stopBits: 1, parity: "even" });
  const seen = [];
  b.onData((c) => seen.push([...c].map((x) => x.toString(16).padStart(2, "0")).join(" ")));
  await b.set({ dtr: true, rts: false, brk: false });
  await b.write(new Uint8Array([184, 18, 241, 2, 26, 128, 195]));
  await new Promise((r) => setTimeout(r, 9));
  await b.set({ dtr: false, rts: false, brk: false });
  await new Promise((r) => setTimeout(r, 800));
  console.log(`${label}:`, seen.length ? seen.join(" | ") : "(none)");
  await b.close();
}
await attempt("first open");
await new Promise((r) => setTimeout(r, 300));
await attempt("second open (after close)");
process.stdout.write("", () => process.exit(0));
