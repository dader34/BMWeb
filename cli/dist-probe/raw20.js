// ../../probe/raw20.ts
import { createRequire } from "node:module";
var require2 = createRequire("/private/tmp/claude-501/-Users-dannerbaumgartner-Development-code-projects-inpa-mac-bridge/04b10d70-1556-47cf-9a07-a306c5a4b53e/scratchpad/wt-builtins/cli/");
var { SerialPort } = require2("serialport");
var mode = process.argv[3] || "sleep";
var port = new SerialPort({ path: process.argv[2] || "/dev/cu.usbserial-AH01BRM5", baudRate: 9600, dataBits: 8, stopBits: 1, parity: "even", autoOpen: false });
await new Promise((res, rej) => port.open((e) => e ? rej(e) : res()));
var set = (s) => new Promise((res) => port.set(s, () => res()));
var get = () => new Promise((res) => port.get(() => res()));
var out = Buffer.from([184, 18, 241, 2, 26, 128, 195]);
var results = [];
for (let i = 0; i < 3; i++) {
  let bytes = 0, first = -1;
  const t0 = Date.now();
  const h = (b) => {
    if (first < 0) first = Date.now() - t0;
    bytes += b.length;
  };
  port.on("data", h);
  await set({ dtr: true, rts: false, brk: false });
  await new Promise((res, rej) => port.write(out, (e) => e ? rej(e) : res()));
  await new Promise((r) => setTimeout(r, 13));
  await set({ dtr: false, rts: false, brk: false });
  if (mode === "kick") {
    const end = Date.now() + 600;
    while (Date.now() < end && bytes < 43) {
      await get();
      await new Promise((r) => setTimeout(r, 5));
    }
  } else await new Promise((r) => setTimeout(r, 600));
  port.off("data", h);
  results.push(`${bytes}B@${first}ms`);
}
console.log(`${mode}:`, results.join("  "));
await new Promise((res) => port.close(() => res()));
process.stdout.write("", () => process.exit(0));
