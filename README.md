# BMacW / BMWeb

BMW diagnostics for macOS (app form) and the browser. Read fault codes, watch live values,
run actuator tests and inspect coding data over a K+DCAN cable, with no Windows,
no virtual machine, and no EDIABAS install.

INPA is a Windows application built on BMW's EDIABAS engine. It reads two kinds
of proprietary file: `.prg` modules that describe how to talk to each ECU, and
`.IPO` screens that describe what to draw. BMacW reimplements both halves. It
decompiles the screens ahead of time into JSON, and interprets the ECU modules
at runtime with its own virtual machine.


## Coverage

| | |
|---|---|
| Chassis | 21 (E36 through F30, R50/R56, RR1) |
| ECUs | 1015 |
| Decompiled screens | 21,101 across 832 ECUs |
| Diagnostic jobs | 23,956 |
| Fault codes | 51,484 |

Every ECU the app can open renders from its own decompiled INPA screen. There is
no fallback renderer and no hand written layout.


## How it works

Four pieces, none of them BMW's code.

**The screen decompiler** (`tools/ipo_ir.py`) turns each `.IPO` into JSON: menus,
F-key numbers, screens, gauges with their scales, lamps, and which job feeds each
row. The renderer interprets that file directly, so a screen looks the way INPA
drew it because it is the same description.

**The BEST2 virtual machine** (`app/renderer/bestvm.js`) executes the bytecode
inside a `.prg`. EDIABAS compiles each ECU's logic to a 184 opcode instruction
set; the VM runs it, including the register file, byte stack, string table and
table lookups. This is what turns raw bytes off the wire into named results. It
agrees with the real EDIABAS engine on 100% of 3,730 results across 460 jobs.

**The static data layer** holds what the VM needs: lifted job code, SGBD tables,
job metadata and per ECU screens, all generated from the BMW files by the tools
in `tools/`.

**The transport** moves bytes. That is the only part that has to be native, and
it differs by host: Web Serial in a browser, a small serial proxy in the macOS
shell.


## Two builds, one renderer

The same renderer runs in both. `app/renderer/webshim.js` decides at load time
where data and bytes come from.

**macOS app.** A Cocoa window around WKWebView. The shell serves the renderer
over loopback, owns `/dev/cu.usbserial*`, and provides PDF export, CSV logging,
durable settings and window chrome. About 600 lines of C#, no EDIABAS.

**Web build.** `scripts/build/build-web.sh` produces a static directory. Reading ECU
data works with no cable and no server. Running a job needs a K+DCAN cable and a
browser with Web Serial, which means desktop Chrome or Edge.

```sh
scripts/build/build-web.sh
python3 -m http.server -d dist-web 8080
```


## Offline download

Either build can package itself: Settings has a **Download offline copy**
button that zips the app plus one car's data, in the browser tab, with no
server involved. The result runs by opening `index.html`: double-click it or
drag it into a browser. No install, no launcher script, no internet. The
copy is branded BMWeb, since it always runs in a browser whoever exported it.

The ECU data is embedded in the page rather than fetched, which is what lets
a page opened straight from disk read it at all (a `file://` page gets an
opaque origin where `fetch()` is blocked). Fault descriptions are always
included, so codes read with their English text, not as bare hex.

One chassis per download by default, 2 to 13 MB, where the whole site is
about 200 MB and zipping that in a tab would hold it all in memory. "All
chassis" is offered, with that warning.

What works offline: browsing every screen, job, table and coding view, the
fault lookup, and demo mode's simulated values. Running a job against a real
car needs a K+DCAN cable and a browser with Web Serial (desktop Chrome or
Edge). Writes are refused, as in any web build.


## THOR WiFi adapter

The THOR WiFi dongle is a Deep-OBD-style custom adapter (the EdiabasLib
DEEPOBDWIFI protocol, not an ELM327): an ESP-Link WiFi bridge at
`192.168.4.1:23` carrying BMW-FAST-framed telegrams, which is exactly what
the VM speaks. One catch: browsers cannot open raw TCP sockets, and no web
API changes that today (Direct Sockets is restricted to Isolated Web Apps,
and port 23 is on the browser blocked-port list besides). So the web build
ships `thor_bridge.js`, a dependency-free WebSocket relay that runs locally
and pipes bytes to the adapter. Loopback WebSockets are exempt from
mixed-content blocking, so this works even on an https host like GitHub
Pages.

**Web build or GitHub Pages:**

1. Install node (nodejs.org), then run the relay:
   `node thor_bridge.js` from the served directory, or download
   `thor_bridge.js` from the site and run it anywhere.
2. Plug the THOR into the car; join its `Thor_Wifi` network.
3. Open the site, set Settings > Adapter to "THOR (WiFi)", and click the
   cable chip in the top bar to connect.

**Offline copy:** identical, and the zip already contains `thor_bridge.js`
next to `index.html`. The copy's own README repeats these steps.

**macOS app:** no relay at all. The shell opens the TCP socket itself
(TcpProxy, beside the serial proxy), so it is just: join `Thor_Wifi`, pick
Settings > Adapter > "THOR (WiFi)", click the cable chip.

The status chip shows the adapter firmware, and the topbar battery and
ignition indicators read live from the adapter, against any car. Running
diagnostic jobs through the THOR is still being wired up: the K-line and
D-CAN telegram wrapping is BMW-specific and untested until the car is
available.

Tip if you need internet while connected to the adapter's network: give the
machine a second link (Ethernet, or an iPhone via USB with Personal Hotspot)
and put it above Wi-Fi in System Settings > Network > service order.


## Wiring diagrams

BMW's own wiring documentation, from WDS (Wiring Diagram System, the tool the
dealer traced circuits on). Open a car and pick **Wiring diagrams**: BMW's
document tree on the left, the document on the right. 15 chassis are covered,
E38 through F01.

Per car that is roughly 2,000 to 5,500 wiring diagrams plus component
locations, connector views, pin assignments, specification values, test
procedures and functional descriptions. Search covers every document title in
the car at once.

The diagrams are **vector, not images**. WDS ships them as `.svgz`, which is
gzipped SVG, so the browser draws them directly: scroll to zoom, drag to pan,
and wire gauges, colour codes and connector numbers stay sharp at any
magnification. Nothing is rasterised and no viewer library is involved.

```sh
scripts/setup/fetch-wds.sh              # WDS v15 ISO (4.7 GB) -> vendor/WDS
tools/wds_import.py --wds vendor/WDS    # -> app/renderer/data/wiring/
```

That writes one `.wiring` archive per car (2 to 24 MB each). WDS is a build
input like the rest of the BMW data: it is not in this repository, and it is
optional, so `check-vendor.sh` reports it as absent rather than failing.
Everything else builds and runs without it; only the Wiring screen is missing.
The importer maps WDS's chassis names onto the app's (WDS splits `e60e61`,
and its E90 folder is a stub pointing at E87).


## Fault lookup

Beyond reading a car's memory, the app carries an offline fault database:
search any code across every chassis and module, or filter by either. Each
result shows the code, its P-code where one exists, and the English
description. Opening a code shows that ECU's service document: set condition,
monitoring conditions, fault impact, warning lamp behaviour, and service
measures.

Two sources feed it, and both are generated rather than hand edited:

- **BMW SGBD `FORTTEXTE` tables**, the fault text each ECU ships in its `.prg`.
  This is the same data EDIABAS reads over the cable.
- **BMW ISTA diagnostic database**, the dealer tool's reference, which supplies
  fleet wide descriptions, the BMW hex to SAE P-code mapping, and the service
  documents.

```sh
node scripts/build/build-faultdb.mjs   # writes app/renderer/faultdb.js + faultindex.js
```

`faultdb.js`, `faultindex.js`, `faultmeta.js`, `faultinfo.js` and `pcodes.js`
are all generated. Never edit them by hand.


## Safety

Write jobs are refused unless explicitly enabled. The guard sits in the VM
itself, before anything is transmitted, so a job that codes, clears or flashes
sends zero bytes rather than being stopped partway. `tools/test_writeguard.js`
asserts that.

The web build refuses writes outright, in both the shim and the VM.


## Status

Fault reading, live values, actuator tests and coding readout work. Flashing is
backup only; writing is not enabled.

The transport is the untested part. Both hosts share the framing and half duplex
echo handling, and neither has moved a byte over a real cable since the EDIABAS
engine was removed from the app path. Everything above the transport is verified
against that engine offline.


## Requirements

- macOS on Apple Silicon, or desktop Chrome/Edge for the web build
- A K+DCAN USB cable, which appears as `/dev/cu.usbserial-*`

Running a release build needs nothing else. The app reads only generated JSON.


## Building from source

BMW's own files are **not in this repository**. They are build inputs: every
screen, job and table the app ships is generated from them, and they are BMW's
to distribute, not ours. To build, or to regenerate data, you supply them.

### Get the BMW files

The package is publicly shared, so this is scripted:

```sh
scripts/setup/fetch-vendor.sh
```

It downloads `ec-apps.zip` (~710 MB) from the Drive folder linked below,
unpacks the two trees it needs with `7z`, and puts them in place. Needs `curl`
and `7z` (`brew install sevenzip`) and about 4 GB free while unpacking. It
no-ops if `vendor/` is already complete.

Not the `BMW_Standard_Tools_Setup` .exe in the same folder: that is a 32 MB
installer stub which downloads its payload at install time, so it holds no
`.prg` or `.IPO` at all.

To do it by hand instead: BMW Standard Tools contains an `EDIABAS` directory and
an `EC-APPS` directory. Copy them in so the tree looks exactly like this:

```
vendor/
  EDIABAS/
    Ecu/                *.prg     ECU modules: job code, tables, metadata
  EC-APPS/
    INPA/
      SGDAT/            *.IPO     INPA screens, and their *.ini siblings
      CFGDAT/           *.ENG     chassis config: which ECUs each car has
```

`EDIABAS/Bin` and `EDIABAS/Hardware` are Win32 tools and drivers, skip them.
Filename case does not matter, the tools match either. The installer is
[here](https://drive.google.com/drive/folders/1Odd9etzajiDBUYiso5NsTMZSoTOkeTXl)
if you would rather fetch it yourself.

### Get the wiring diagrams (optional)

A separate BMW product and a separate download, so it is a separate script:

```sh
scripts/setup/fetch-wds.sh
```

It downloads the WDS v15 English ISO (4.7 GB), mounts it, and copies the
~200 MB the importer actually reads into `vendor/WDS`: the shared `svg/` and
`zinfo/` document stores plus one document tree per chassis. The rest of the
disc is a Java applet and a frameset that the app replaces with its own
viewer. Needs `hdiutil` (so macOS; on Linux, mount the ISO and copy its
`release/us` tree to `vendor/WDS` by hand) and about 11 GB free while working.
It no-ops if `vendor/WDS` is already there, and resumes a part-finished
download.

Then build the per-car archives:

```sh
tools/wds_import.py --wds vendor/WDS
```

Skip all of this if you do not want wiring diagrams. Nothing else depends on
them, and `check-vendor.sh` reports them as absent rather than failing.

### Check the layout

Before anything else. It names exactly what is missing and where it goes:

```sh
scripts/setup/check-vendor.sh
```

### Build

```sh
tools/export/build_ecu_tree.py        # data/chassis/<CAR>/<ECU>/ from data/ecu-src
tools/wds_import.py --wds vendor/WDS  # wiring archives (optional, needs WDS)
scripts/build/build-web.sh            # static web build -> dist-web/
dotnet build src/InpaMac.App          # macOS app
scripts/build/package-macos.sh        # signed DMG (needs dist-web/ first)
tools/check.sh                        # every guard on the pipeline
```

`tools/check.sh` verifies the decompiler against known screens, the interpreter
across all 832 ECUs, the VM against captured telegrams, the write guard, and
that every table an SGBD references is shipped.

### Where the data lives

`data/ecu-src/` holds one gzipped copy per SGBD of the generated job code,
metadata and tables. That is what is committed. `data/chassis/<CAR>/<ECU>/` is
built from it and gitignored: everything about one ECU in one folder, which
means an SGBD used by several cars is stored once per car (310 distinct ECUs
become 1022 folders). Convenient to work in, wasteful to commit, so only the
deduplicated source is in git.

Two folders sit outside the cars: `other/` for ECUs INPA decompiles but no
chassis config references, and `vehicle/` for the whole-vehicle screens BMW
ships per car rather than per module. Neither is shipped.

## Layout

```
app/renderer/     the UI: IR interpreter, BEST2 VM, transport shim
src/InpaMac.App/  macOS shell: window, serial proxy, static file host
src/InpaMac.Cli/  the real EDIABAS engine, kept to verify the VM against
tools/            decompilers, exporters, test harnesses
data/ecu-src/     committed source: one gzipped copy per SGBD
data/chassis/     derived per-car tree (gitignored)
vendor/           BMW originals: NOT in the repo, supply your own
vendor/WDS/       BMW's wiring diagrams, optional (scripts/setup/fetch-wds.sh)
```

`src/InpaMac.Cli` still links EDIABAS on purpose. It is the ground truth the VM
is diffed against; the app itself ships no engine.


## Credits

Built on the file format work in
[EdiabasLib](https://github.com/uholeschak/ediabaslib) by Ulrich Holeschak.
EDIABAS, INPA and the vehicle data are BMW's.


## License

GPLv3. The DME flash code is ported from
[terraphantm/MS45-Flasher](https://github.com/terraphantm/MS45-Flasher), which is
GPLv3. See `LICENSE` and `NOTICE.md`.
