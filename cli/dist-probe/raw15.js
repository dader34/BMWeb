// ../../probe/raw15.ts
import { createRequire } from "node:module";
var require2 = createRequire("/private/tmp/claude-501/-Users-dannerbaumgartner-Development-code-projects-inpa-mac-bridge/04b10d70-1556-47cf-9a07-a306c5a4b53e/scratchpad/wt-builtins/cli/");
var { SerialPort } = require2("serialport");
var port = new SerialPort({ path: process.argv[2] || "/dev/cu.usbserial-AH01BRM5", baudRate: 9600, dataBits: 8, stopBits: 1, parity: "even", autoOpen: false });
await new Promise((res, rej) => port.open((e) => e ? rej(e) : res()));
var set = (s) => new Promise((res) => port.set(s, () => res()));
var bytes = 0;
var chunks = [];
port.on("data", (b) => {
  bytes += b.length;
  chunks.push([...b].map((x) => x.toString(16).padStart(2, "0")).join(" "));
});
var out = Buffer.from([184, 18, 241, 2, 26, 128, 195]);
for (let i = 0; i < 2; i++) {
  bytes = 0;
  chunks = [];
  await set({ dtr: true, rts: false, brk: false });
  await new Promise((res, rej) => port.write(out, (e) => e ? rej(e) : res()));
  await new Promise((res) => port.drain(() => res()));
  await new Promise((r) => setTimeout(r, 1e3 / 9600 * 11 * out.length + 5));
  await set({ dtr: false, rts: false, brk: false });
  await new Promise((r) => setTimeout(r, 800));
  console.log(`attempt ${i}: ${bytes} bytes  ${chunks.join(" | ")}`);
}
await new Promise((res) => port.close(() => res()));
process.stdout.write("", () => process.exit(0));
