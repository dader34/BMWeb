# BMWeb

BMW diagnostics in a browser. INPA's screens, EDIABAS's ECU logic, ISTA's
fault documentation, WDS wiring diagrams and the ETK parts catalogue, running
as a static web page with no Windows, no VM and no EDIABAS install.

**https://bmweb.danner.ink/**

> **This project is in development. Use write jobs at your own risk.**

INPA is a Windows application built on BMW's EDIABAS engine. It reads two kinds
of proprietary file: `.prg` modules (SGBDs) that describe how to talk to each
ECU, and `.IPO` screens that describe what to draw. BMWeb reimplements both
halves in JavaScript: the screens are decompiled ahead of time into JSON, and
the ECU modules are executed at runtime by its own BEST2 virtual machine. The
car is reached over a K+DCAN USB cable through Web Serial, or over WiFi
through a THOR adapter's WebSocket, so the same page works on a laptop and on
a phone.


## Using it

**Hosted.** Open https://bmweb.danner.ink/. It installs as a progressive web
app (add to home screen / dock) and keeps working without a connection once
cached. Note that an `https://` page cannot open a socket to a THOR adapter
on the local network, so for WiFi diagnostics use an offline copy.

**Offline.** Every [release](https://github.com/dader34/BMWeb/releases) ships
self-contained builds; unzip one and open `index.html`. Nothing in them
fetches from the internet.

| Build | Where | Contents |
|---|---|---|
| `bmweb-<ver>-offline.zip` | GitHub release | diagnostics, coding, fault lookup with ISTA plans, wiring diagrams (~450 MB) |
| `bmweb-<ver>-offline-no-wiring.zip` | GitHub release | the same without the wiring diagrams (~300 MB) |
| `bmweb-<ver>-offline-complete.zip` | Hugging Face, linked from the release notes | everything above plus the ETK parts catalogue for every chassis (~6.5 GB) |

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

| | K+DCAN USB | THOR WiFi |
|---|---|---|
| Chrome / Edge, desktop | yes, via Web Serial | yes |
| Safari | no, Safari has no Web Serial | yes |
| iPhone / Android | no USB path on a phone | yes, the only option |

**K+DCAN cable** (Settings → Adapter → K+DCAN, the default). Plug the cable
straight into the machine, no hub, and click the cable chip in the top bar;
Web Serial only opens its port picker from a click, so there is no automatic
connect. On macOS the port is `cu.usbserial*`, `cu.SLAB*` or
`cu.wchusbserial*`; on Linux `ttyUSB*` or `ttyACM*`
(`scripts/setup/99-bmacw-kdcan.rules` grants the permission). The app opens
at 115200 8N1 and re-opens at 9600 8E1 for DS2/KWP2000 modules on its own.
FTDI cables want a 1 ms latency timer; the app cannot set it but will tell
you when `IFH-0003` looks like that.

**THOR WiFi adapter** (Settings → Adapter → THOR). A Deep-OBD-style adapter
(the EdiabasLib DEEPOBDWIFI protocol, **not** an ELM327) whose ESP8266 runs
esp-link. Plug it into the OBD port, join `Thor_Wifi`, pick THOR, click the
chip. The app reaches `ws://192.168.4.1/bmweb` and proves the link with an
identity exchange before trusting it. Stock esp-link has no WebSocket, so the
adapter needs the firmware in `vendor/esp-link-ws/` once; see
[Flashing the THOR adapter](#flashing-the-thor-adapter). `?ws=<host>` on the
URL points the app at an adapter on another address.

**Remote session** (Settings → Remote session). Whoever has the cable picks
"Share my car" and gets an 8-character code; anyone else opens the same app,
enters the code, and drives the car over a WebRTC data channel. Only the
car-touching requests cross the link; the helper sees the same screens.

**Demo mode** (Settings, or `?demo=1`) runs every screen against simulated
values, clearly badged, with no cable.


## What it does

Every module screen is BMW's own INPA screen, decompiled and rendered as it
was drawn. Modules BMW never drew a screen for say so rather than guessing at
a layout. A key press runs the key's own INPA bytecode, so computed arguments
(idle-raise setpoints, CO trim steps, adaptation clears) go to the wire
exactly as INPA sends them, and guided procedures (activate, wait, observe,
tear down) run their state machines live.

- **Fault memory** — read stored codes with English text and detail, clear them.
- **Error scan** — sweep every module in the car in one pass, export a PDF report.
- **Live values** — gauges updating continuously, several at once, CSV logging.
- **Activations** — drive real components; held actuators release when you leave.
- **Coding** — read a module's coding, stage changes, see exactly what would be
  sent; write with backup-first and verify-by-re-read.
- **Diagnostic Plans and Trouble Codes** — search 51,484 fault codes offline
  with P-codes and the matching ISTA service documents (set condition,
  monitoring, fault impact, lamp behaviour, service measures).
- **Wiring Diagrams** — BMW's WDS schematics as vectors, plus component
  locations, connector views and pin assignments. 15 chassis.
- **Parts Catalogue** — ETK part numbers, diagrams, supersessions, VIN
  decoding, 246 chassis bundles from the E3 to the G series.
- **Tool32** — run any SGBD job directly and read the raw result registers.
- **Tuning** — inspect ECU firmware images in a hex editor with TunerPro
  `.xdf` constants, flags and tables.
- A seven-step tour and a "how it works" walkthrough, from the Apps hub.


## Coverage

| | |
|---|---|
| Chassis | 26: E31 E34 E36 E38 E39 E46 E52 E53 E60 E65 E70 E83 E85 E87 E89 E90 F01 F07 F10 F25 F30 K25 K40 R50 R56 RR1 |
| ECU definitions (SGBDs) | 950 |
| Decompiled INPA screens | ~19,500 across ~800 ECUs |
| Diagnostic jobs | ~55,000 |
| Fault codes | 51,484 |
| Wiring diagrams | 15 chassis, E38 through F01 |

Per-chassis depth follows how many modules the car has: an E65 carries 96
module definitions, an E60 91, an E90 61, an E46 55, an F30 19.


## How it works

Four pieces, none of them BMW's code.

**The screen decompiler** (`tools/`) turns each `.IPO` into JSON: menus, F-key
numbers, screens, gauges with their scales, lamps, and which job feeds each
row. The renderer interprets that file directly, so a screen looks the way
INPA drew it because it is the same description.

**The BEST2 virtual machine** (`app/renderer/core/bestvm.js`) executes the
bytecode inside a `.prg`. EDIABAS compiles each ECU's logic to a 184-opcode
instruction set; the VM runs it — register file, byte stack, string table,
table lookups — and turns raw bytes off the wire into named results. Diffed
offline against the real EDIABAS engine (`src/InpaMac.Cli` links it for
exactly that), it agrees on 3,729 of 3,730 results over 460 jobs on an E46
corpus.

**The static data layer** holds what the VM needs — lifted job code, SGBD
tables, job metadata and per-ECU screens — all generated from the BMW files
by the tools in `tools/`. `data/ecu-src/` is one gzipped copy per SGBD and is
what is committed; `data/chassis/<CAR>/<ECU>/` is built from it and ignored.

**The transport** moves bytes: Web Serial or a THOR WebSocket in the browser.
`app/renderer/core/webshim.js` picks one at load time and installs itself
over `fetch`, so the renderer never knows which.


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


## Flashing the THOR adapter

Stock esp-link exposes only raw telnet on port 23, which a browser cannot
open. `vendor/esp-link-ws/` adds a binary WebSocket at `/bmweb` bridged to
the UART and keeps the config pages, WiFi setup, OTA and telnet intact. The
adapter MCU — the chip that holds everything BMW-specific — is never touched;
worst case is a non-booting ESP in front of an intact adapter.

1. Back up if you can: `esptool.py --port /dev/cu.usbserial-XXXX read_flash 0 0x400000 thor-backup.bin`
   (needs the ESP's TX/RX/GND pads; if the dongle is sealed, esp-link's
   two-slot fallback is your safety net).
2. Join `Thor_Wifi`, open http://192.168.4.1 → **Upgrade Firmware**. It names
   the slot it wants, `user1.bin` or `user2.bin`; upload that one from
   `vendor/esp-link-ws/firmware/`. The wrong one is rejected, not half-written.
3. After reboot the page reads `Current firmware: esp-link bmweb-ws.3`.
4. `node tools/thor_ws_probe.js` should end with `VALID IDENT`.

To use the adapter on your own LAN instead of its AP, set esp-link's WiFi
Station page and open the app with `?ws=<its address>`.


## Building from source

BMW's own files are **not in this repository**. Every screen, job and table
the app ships is generated from them; they are BMW's to distribute. Running
the built app needs none of this — only regenerating data does.

```sh
scripts/setup/fetch.sh --list       # what is available, and how big
scripts/setup/fetch.sh --vendor     # EDIABAS SGBDs + INPA screens, ~710 MB
scripts/setup/fetch.sh --coding     # NCS Expert coding definitions, 5.6 MB
scripts/setup/fetch.sh --wiring E46 # built wiring archives, one car or all
scripts/setup/fetch.sh --wds        # the raw WDS ISO, only to rebuild wiring
scripts/setup/check-vendor.sh       # what is installed, what is missing
```

Everything comes from one Hugging Face dataset
([CraigFf/bmw-files](https://huggingface.co/datasets/CraigFf/bmw-files)),
plain HTTPS, resumable. Needs `curl`, and `7z` for `--vendor`/`--wds`. The
expected layout:

```
vendor/
  EDIABAS/Ecu/                 *.prg   ECU modules (required)
  EC-APPS/INPA/SGDAT/          *.IPO   INPA screens (required)
  EC-APPS/INPA/CFGDAT/         *.ENG   chassis config (required)
  EC-APPS/NCSEXPER/DATEN/      coding definitions (optional)
  WDS/                         wiring source (optional)
app/renderer/data/wiring/      *.wiring  built wiring archives (optional)
```

### Build the site

This is what `.github/workflows/pages.yml` does:

```sh
scripts/setup/data-cache.sh expand        # data/inpa-ir/*.json.gz -> .json
python3 tools/export/build_ecu_tree.py    # data/chassis/<CAR>/<ECU>/
python3 tools/export/web_export.py --out dist-web
cp -R app/renderer/. dist-web/
python3 -m http.server -d dist-web 8080   # serve it
```

`scripts/build/build-web.sh` wraps the same steps with esbuild bundling and
gzip precompression. Other generators:

```sh
node scripts/build/build-faultdb.mjs      # app/renderer/data/faultdb.js + faultindex.js
tools/decompile/daten_map.py              # app/renderer/data/datenmap.js (coding labels)
tools/wds_import.py --wds vendor/WDS      # app/renderer/data/wiring/*.wiring
node scripts/build/offline-build.mjs --dist dist-web --out release-builds   # the 4 zips
```

Files under `app/renderer/data/` named `faultdb`, `faultindex`, `faultmeta`,
`faultinfo`, `pcodes`, `datenmap` are generated. Never edit them by hand.

### Check

```sh
tools/check.sh
```

Runs every guard on the pipeline: the `.IPO` round-trip, the decompiler
against known screens, IR emitter invariants, the interpreter against known
screens, the VM against captured telegrams, wire framing and checksums, the
write guard, the coding encoder round-trip, variant resolution, and more.
Checks that need the real EDIABAS engine skip cleanly unless `BMACW_PORT`
points at a running native shell.

### Release

Bump `<ApplicationDisplayVersion>` and `<ApplicationVersion>` in
`src/InpaMac.App/InpaMac.App.csproj` (the version stamp both workflows read)
and `version` in `package.json`, then push a `v<version>` tag.
`release-web.yml` builds `dist-web`, pulls the wiring archives from
[dader34/BMacW-wiring-images](https://github.com/dader34/BMacW-wiring-images),
and attaches the four offline zips to the GitHub Release. The tag must match
the csproj version or the job refuses to build.


## URL flags

| Flag | Effect |
|---|---|
| `?demo=1` | demo mode, simulated values |
| `?thor=1` | force the THOR transport |
| `?ws=<host>` | THOR adapter at another address (`host`, `host:port` or `ws://host/path`) |
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
app/renderer/          the app: IR interpreter, BEST2 VM, transport shim, screens
  core/                bestvm.js, webshim.js, coding-write.js, remote.js, journal.js
  screens/             apps hub, lookup, wiring, etk, tool32, tuning, coding
  data/                generated JS data (fault DB, coding labels, wiring archives)
data/ecu-src/          committed source: one gzipped copy per SGBD
data/inpa-ir/          decompiled INPA screens (gzipped)
data/chassis/          derived per-car tree (gitignored)
tools/                 decompilers, exporters, verify/ test harnesses, beta/ collector
scripts/setup/         fetch.sh, check-vendor.sh, data-cache.sh
scripts/build/         build-web.sh, build-bundle.sh, offline-build.mjs, build-faultdb.mjs
vendor/esp-link-ws/    WebSocket firmware for the THOR adapter, with prebuilt images
vendor/                BMW originals: NOT in the repo, supply your own
src/BMacW.Host/        C# shell core: static host, cable proxy (not released)
src/InpaMac.App/       macOS WKWebView shell around that core (not released)
src/InpaMac.Cli/       the real EDIABAS engine, kept only to verify the VM against
```

The native macOS shell is kept in the tree and still holds the version stamp,
but no desktop build is published; the browser is the product.


## Credits and license

Built on the file-format work in
[EdiabasLib](https://github.com/uholeschak/ediabaslib) by Ulrich Holeschak
(Apache 2.0). The DME flash code is ported from
[terraphantm/MS45-Flasher](https://github.com/terraphantm/MS45-Flasher)
(GPLv3), which makes the project as a whole **GPLv3**. See `LICENSE` and
`NOTICE.md`. EDIABAS, INPA, ISTA, ETK, WDS and the vehicle data are BMW's.
