// ../../probe/raw13.ts
import { createRequire } from "node:module";
var require2 = createRequire("/private/tmp/claude-501/-Users-dannerbaumgartner-Development-code-projects-inpa-mac-bridge/04b10d70-1556-47cf-9a07-a306c5a4b53e/scratchpad/wt-builtins/cli/");
var { SerialPort } = require2("serialport");
var path = process.argv[2] || "/dev/cu.usbserial-AH01BRM5";
var useDrain = process.argv[3] !== "nodrain";
var port = new SerialPort({ path, baudRate: 9600, dataBits: 8, stopBits: 1, parity: "even", autoOpen: false });
await new Promise((res, rej) => port.open((e) => e ? rej(e) : res()));
var bytes = 0;
port.on("data", (b) => {
  bytes += b.length;
});
await new Promise((res, rej) => port.write(Buffer.from([184, 18, 241, 2, 26, 128, 195]), (e) => e ? rej(e) : useDrain ? port.drain((d) => d ? rej(d) : res()) : res()));
await new Promise((r) => setTimeout(r, 900));
console.log(`${useDrain ? "WITH drain" : "NO drain"}: first exchange got ${bytes} bytes`);
await new Promise((res) => port.close(() => res()));
process.stdout.write("", () => process.exit(0));
