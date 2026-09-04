# BMWeb

BMW diagnostics in a browser. Read and clear fault memory, watch live values,
run activations, code modules, look up fault documentation, browse wiring
diagrams and the parts catalogue, from a static web page with no Windows and
nothing to install.

**https://bmweb.danner.ink/**

> **This project is in development. Use write jobs at your own risk.**

Each module's screens are described in JSON and drawn by an interpreter; each
module's diagnostic logic runs in the app's own bytecode virtual machine. The
car is reached over a K+DCAN USB cable through Web Serial.


## Using it

**Hosted.** Open https://bmweb.danner.ink/. It installs as a progressive web
app (add to home screen / dock) and keeps working without a connection once
cached.

**Offline.** Every [release](https://github.com/dader34/BMWeb/releases) ships
self-contained builds; unzip one and open `index.html`. Nothing in them
fetches from the internet.

| Build | Where | Contents |
|---|---|---|
| `bmweb-<ver>-offline.zip` | GitHub release | diagnostics, coding, fault lookup with service plans, wiring diagrams (~450 MB) |
| `bmweb-<ver>-offline-no-wiring.zip` | GitHub release | the same without the wiring diagrams (~300 MB) |
| `bmweb-<ver>-offline-complete.zip` | Hugging Face, linked from the release notes | everything above plus the parts catalogue for every chassis (~6.5 GB) |

The parts catalogue is 5.8 GB on its own, more than a GitHub release asset
may hold, which is why the complete build lives on Hugging Face. The two
GitHub builds hide the Parts entry rather than offer a screen that would
need the network.

On iPhone, open the page in Safari or from the home screen, not from the
Files-app preview: Quick Look restricts scripts and the page hangs on the
splash with no error.


## Connecting to a car

Ignition in position 2, engine off, healthy battery. Most "the ECU rejected
the request" errors are a car in the wrong state or a sagging battery.

| | K+DCAN USB |
|---|---|
| Chrome / Edge, desktop | yes, via Web Serial |
| Safari | no, Safari has no Web Serial |
| iPhone / Android | no USB path in a mobile browser |

Live diagnostics need Web Serial, which is desktop Chrome/Edge only. On a phone
the app runs fully for everything offline — fault lookup, wiring diagrams,
service documents, the parts catalogue — but cannot reach the car from the
browser.

**K+DCAN cable** (Settings → Adapter → K+DCAN, the default). Plug the cable
straight into the machine, no hub, and click the cable chip in the top bar;
Web Serial only opens its port picker from a click, so there is no automatic
connect. On macOS the port is `cu.usbserial*`, `cu.SLAB*` or
`cu.wchusbserial*`; on Linux `ttyUSB*` or `ttyACM*`
(`scripts/setup/99-bmacw-kdcan.rules` grants the permission). The app opens
at 115200 8N1 and re-opens at 9600 8E1 for DS2/KWP2000 modules on its own.
FTDI cables want a 1 ms latency timer; the app cannot set it but will tell
you when `IFH-0003` looks like that.

**Remote session** (Settings → Remote session). Whoever has the cable picks
"Share my car" and gets an 8-character code; anyone else opens the same app,
enters the code, and drives the car over a WebRTC data channel. Only the
car-touching requests cross the link; the helper sees the same screens.

**Demo mode** (Settings, or `?demo=1`) runs every screen against simulated
values, clearly badged, with no cable.


## What it does

Every module screen is rendered from its own screen definition, as designed.
Modules with no screen definition say so rather than guessing at a layout. A
key press runs that key's own logic in the VM, so computed arguments
(idle-raise setpoints, CO trim steps, adaptation clears) go to the wire as
designed, and guided procedures (activate, wait, observe, tear down) run
their state machines live.

- **Fault memory** — read stored codes with English text and detail, clear them.
- **Error scan** — sweep every module in the car in one pass, export a PDF report.
- **Live values** — gauges updating continuously, several at once, CSV logging.
- **Activations** — drive real components; held actuators release when you leave.
- **Coding** — read a module's coding, stage changes, see exactly what would be
  sent; write with backup-first and verify-by-re-read.
- **Diagnostic Plans and Trouble Codes** — search 51,484 fault codes offline
  with P-codes and the matching service documents (set condition,
  monitoring, fault impact, lamp behaviour, service measures).
- **Wiring Diagrams** — factory schematics as vectors, plus component
  locations, connector views and pin assignments. 15 chassis.
- **Parts Catalogue** — part numbers, diagrams, supersessions, VIN
  decoding, 246 chassis bundles from the E3 to the G series.
- **Job runner** — run any diagnostic job on a module directly and read the
  raw result registers.
- **Tuning** — inspect ECU firmware images in a hex editor with TunerPro
  `.xdf` constants, flags and tables.
- A seven-step tour and a "how it works" walkthrough, from the Apps hub.


## Coverage

| | |
|---|---|
| Chassis | 26: E31 E34 E36 E38 E39 E46 E52 E53 E60 E65 E70 E83 E85 E87 E89 E90 F01 F07 F10 F25 F30 K25 K40 R50 R56 RR1 |
| ECU definitions | 950 |
| Module screens | ~19,500 across ~800 ECUs |
| Diagnostic jobs | ~55,000 |
| Fault codes | 51,484 |
| Wiring diagrams | 15 chassis, E38 through F01 |

Per-chassis depth follows how many modules the car has: an E65 carries 96
module definitions, an E60 91, an E90 61, an E46 55, an F30 19.


## How it works

Four pieces.

**The screen interpreter** draws each module's screens from a JSON
description: menus, F-key numbers, screens, gauges with their scales, lamps,
and which job feeds each row.

**The virtual machine** (`app/renderer/core/bestvm.js`) executes each
module's diagnostic logic, a 184-opcode instruction set — register file, byte
stack, string table, table lookups — and turns raw bytes off the wire into
named results. Diffed offline against a reference engine (`src/InpaMac.Cli`
exists for exactly that), it agrees on 3,729 of 3,730 results over 460 jobs
on an E46 corpus.

**The static data layer** holds what the VM needs — job code, tables, job
metadata and per-ECU screens — generated by the tools in `tools/`.
`data/ecu-src/` is one gzipped copy per ECU definition and is what is
committed; `data/chassis/<CAR>/<ECU>/` is built from it and ignored.

**The transport** moves bytes over Web Serial in the browser.
`app/renderer/core/webshim.js` installs itself over `fetch`, so the renderer
never knows how the bytes reach the car.


## Safety

Every job is classified before it runs. Anything the classifier does not
recognise is treated as a write, not assumed safe, and a blocked write is
blocked inside the VM before a single byte is transmitted
(`tools/verify/test_writeguard.js` asserts that). What does change the car is
gated rather than forbidden:

- actuator tests confirm before firing, are registered before they are sent,
  and are released when you leave the screen;
- a permanent write (EEPROM, service reset) always confirms, whatever the
  setting;
- coding writes take a backup first and re-read the module afterwards; a
  mismatch is reported as a verification error, not a success.

Flashing is backup (read) only.


## URL flags

| Flag | Effect |
|---|---|
| `?demo=1` | demo mode, simulated values |
| `?api=<base>` | alternate API base |
| `?dtc=<code>&sgbd=<name>` | deep link to a fault lookup entry |
| `#apps`, `#apps/wiring/…`, `#apps/parts/…`, `#apps/tool32` | Apps hub routes |


## Beta feedback

A **Report** button next to the Settings gear bundles the app and browser
version, the current screen, the session journal (screens, jobs, errors) and
the last wire telegrams, with VINs masked, and posts them to the collector in
`tools/beta/` (endpoint configurable in Settings). If the send fails it
saves the report as a `.json` you can attach by hand.


## Layout

```
app/renderer/          the app: screen interpreter, bytecode VM, transport shim, screens
  core/                bestvm.js, webshim.js, coding-write.js, remote.js, journal.js
  screens/             apps hub, lookup, wiring, etk, tool32, tuning, coding
  data/                generated JS data (fault DB, coding labels, wiring archives)
data/ecu-src/          committed source: one gzipped copy per ECU definition
data/inpa-ir/          module screens (gzipped)
data/chassis/          derived per-car tree (gitignored)
tools/                 generators, exporters, verify/ test harnesses, beta/ collector
scripts/setup/         fetch.sh, check-vendor.sh, data-cache.sh
scripts/build/         build-web.sh, build-bundle.sh, offline-build.mjs, build-faultdb.mjs
vendor/                build inputs: NOT in the repo
src/BMacW.Host/        C# shell core: static host, cable proxy (not released)
src/InpaMac.App/       macOS WKWebView shell around that core (not released)
src/InpaMac.Cli/       reference engine, kept only to verify the VM against
```

The native macOS shell is kept in the tree and still holds the version stamp,
but no desktop build is published; the browser is the product.


## Credits and license

Built on the file-format work in
[EdiabasLib](https://github.com/uholeschak/ediabaslib) by Ulrich Holeschak
(Apache 2.0). The DME flash code is ported from
[terraphantm/MS45-Flasher](https://github.com/terraphantm/MS45-Flasher)
(GPLv3), which makes the project as a whole **GPLv3**. See `LICENSE` and
`NOTICE.md`.
