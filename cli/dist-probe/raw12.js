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
    write: (bytes2) => call((cb) => port.write(Buffer.from(bytes2), cb)),
    onData: (fn) => port.on("data", (b2) => fn(new Uint8Array(b2))),
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

// ../../probe/raw12.ts
var settle = Number(process.argv[3] || 0);
var b = await openSerialportBinding(process.argv[2] || "/dev/cu.usbserial-AH01BRM5", { baudRate: 9600, dataBits: 8, stopBits: 1, parity: "even" });
var bytes = 0;
b.onData((c) => {
  bytes += c.length;
});
if (settle) await new Promise((r) => setTimeout(r, settle));
await b.write(new Uint8Array([184, 18, 241, 2, 26, 128, 195]));
await new Promise((r) => setTimeout(r, 900));
console.log(`settle=${settle}ms -> first exchange got ${bytes} bytes`);
await b.close();
process.stdout.write("", () => process.exit(0));
