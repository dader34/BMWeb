# BMacW / BMWeb

BMW diagnostics that runs anywhere. Read fault codes, watch live values, run
actuator tests and inspect coding data, with no Windows, no Windows VM, and
no EDIABAS install.

**The main build is a single HTML file.** One download, everything inside it -
the app, the BEST2 VM, and one car's ECU data. It opens in a browser on
Windows, macOS, iPhone and Android, needs no server and no internet, and talks
to the car over a WiFi adapter's own WebSocket. Downloaded from Settings, or
built with the exporter.

The macOS app exists for the **K+DCAN USB cable**. A browser reaches a USB
serial port only through Web Serial, which is Chrome and Edge on the desktop -
no Safari, no phone. The app owns the port itself, and adds native save
dialogs, PDF export and CSV logging.

So: **wireless works everywhere, the cable wants the app or Chrome.**

INPA is a Windows application built on BMW's EDIABAS engine. It reads two kinds
of proprietary file: `.prg` modules that describe how to talk to each ECU, and
`.IPO` screens that describe what to draw. BMacW reimplements both halves. It
decompiles the screens ahead of time into JSON, and interprets the ECU modules
at runtime with its own virtual machine.


## Coverage

| | |
|---|---|
| Chassis | 27 (E31 through F30, R50/R56, RR1, K25/K40) |
| ECUs | 1015 |
| Decompiled screens | 21,386 across 1,117 ECUs |
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

The same renderer runs in both. `app/renderer/core/webshim.js` decides at load
time where data and bytes come from, and the shell provides only what a web
page cannot do for itself: the USB cable and the file dialogs.

**The single file (BMWeb).** One `.html` with the app, the VM and one car's
data inlined, about 7 MB for an E46. No server, no internet, no unzipping.
Get it from **Settings → Download single file**, or build one directly:

```sh
scripts/build/build-web.sh                 # dist-web, the source of the export
python3 -m http.server -d dist-web 8080    # then use the Settings button
```

Everything is inlined because a `file://` page gets an opaque origin where
`fetch()` is blocked, so scripts, styles and ECU data all travel in the
document. That is also why it works from a phone's Downloads folder.

Two things to know on iOS: open it in a **browser**, not the Files-app
preview, which is Quick Look and restricts scripts (the page hangs on the
splash with no error). And it must stay `http://` or `file://`, an `https://`
page cannot open `ws://`, and a bare IP cannot hold a certificate.

**macOS app (BMacW).** A Cocoa window around WKWebView, for the K+DCAN cable.
The shell serves the renderer over loopback, owns `/dev/cu.usbserial*`, and
provides PDF export, CSV logging, durable settings and window chrome. About
600 lines of C#, no EDIABAS.

```sh
scripts/build/package-macos.sh             # -> dist-release/BMacW-*.dmg
```

The hosted site is the same `dist-web` tree. It is how you download the
single file; it is not how you talk to a car, because HTTPS cannot reach a
private-IP WebSocket.


## Offline download

Settings offers two, and they differ in shape rather than content:

**Download single file**, one `.html`, everything inside. The one to use on
a phone: it AirDrops, sits in Downloads, and opens by tapping it. No folder,
no unzipping. Wiring diagrams are excluded (72 MB against 7 for the rest of
an E46); fault text is a checkbox.

**Download offline copy**, a zip of the app plus one car's data, which
unpacks to a folder you open by double-clicking `index.html`. Right for a
computer, where a folder is easy to keep and the wiring diagrams are worth
having.

Both are produced in the browser tab with no server involved, and both are
branded BMWeb, since they always run in a browser whoever exported them.

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
DEEPOBDWIFI protocol, not an ELM327): an ESP8266 running esp-link in front of
an adapter MCU, carrying BMW-FAST-framed telegrams, exactly what the VM
speaks. **This is the transport that makes every platform work**, because it
needs nothing but a browser.

Stock esp-link offers a page no way in: port 23 is raw telnet, which a browser
cannot open, and the µC console is HTTP polling of a *text* endpoint, which
mangles every byte over 0x7F, and telegrams are full of them. So
`vendor/esp-link-ws/` adds a **binary WebSocket** at `ws://192.168.4.1/bmweb`,
bridged straight to the UART. Prebuilt images and flashing notes are in
`vendor/esp-link-ws/firmware/`; it flashes over esp-link's own OTA page and
keeps the config UI, WiFi setup and telnet bridge intact.

### Flashing the adapter

The dongle ships with stock esp-link, which serves only raw telnet on port
23, a browser cannot open that, so out of the box the adapter is
unreachable from a web page. Flashing replaces nothing you need: the config
pages, WiFi setup, OTA upload and the telnet bridge all keep working, and
the **adapter MCU is never touched** (it is a separate chip, and it holds
everything BMW-specific). The worst case is a non-booting ESP in front of a
perfectly intact adapter.

1. **Back up first, if you can.** `esptool.py --port /dev/cu.usbserial-XXXX
   read_flash 0 0x400000 thor-backup.bin`. This needs physical access to the
   ESP's TX/RX/GND pads. If your dongle is sealed, know that esp-link's
   two-slot fallback is then your only safety net.
2. Join the adapter's `Thor_Wifi` network and open **http://192.168.4.1**.
3. Go to **Upgrade Firmware**. It names the file it wants, `user1.bin` or
   `user2.bin`, whichever slot it is *not* running from. Upload that one
   from `vendor/esp-link-ws/firmware/`. The two are built for different
   flash offsets and are not interchangeable; the wrong one is rejected
   rather than half-written.
4. When it reboots, the page reads `Current firmware: esp-link bmweb-ws.3`.
5. Check it with `node tools/thor_ws_probe.js`, a pass ends with
   `VALID IDENT` and the adapter's type and firmware version. The ident is
   addressed tester-to-tester, so no car is involved.

Then just: join `Thor_Wifi`, open the app, **Settings → Adapter → THOR
(WiFi)**, and click the cable chip. There is no address to enter -
`192.168.4.1` is the ESP's own soft-AP address and never changes while you
are joined to it. The topbar reads "THOR direct" when it is live, along with
live battery and ignition off the adapter.

Confirmed end to end: adapter type 0x10, firmware v1.15, live values on an
iPhone with no laptop and no relay.

### Changing the address

Two reasons you might: you would rather reach the adapter over your own
network, or you changed its AP address. Both are esp-link settings, not app
settings.

- **Station mode** (adapter joins your WiFi): esp-link's **WiFi Station**
  page. It gets a normal DHCP address on your LAN, so you keep internet
  while using it, but at a car, with no network in range, it falls back to
  being its own AP.
- **A different AP address**: esp-link's **WiFi Soft-AP** page.

Either way, tell the app with `?ws=<host>` on the URL, for example
`index.html?ws=192.168.1.57`. A bare host, `host:port`, or a full
`ws://host/path` all work.

Tip if you need internet while on the adapter's network: give the machine a
second link (Ethernet, or an iPhone via USB with Personal Hotspot) and put it
above Wi-Fi in System Settings > Network > service order.

## Wiring diagrams

BMW's own wiring documentation, from WDS (Wiring Diagram System, the tool the
dealer traced circuits on). Open the main menu and pick **Wiring diagrams**: BMW's
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
scripts/setup/fetch-wiring.sh           # built archives, ~1 GB -> ready to use
scripts/setup/fetch-wiring.sh E46       # or just one car
```

That is the short way: one `.wiring` archive per car, already built, straight
into `app/renderer/data/wiring/`. To rebuild them from BMW's own ISO instead,
which you only need for a newer WDS release:

```sh
scripts/setup/fetch-wds.sh              # WDS v15 ISO (4.7 GB) -> vendor/WDS
tools/wds_import.py --wds vendor/WDS    # -> app/renderer/data/wiring/
```

Either way it is optional, and `check-vendor.sh` reports it as absent rather
than failing. Everything else builds and runs without it; only the Wiring
screen is missing.
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

### The short version

```sh
scripts/setup/fetch-vendor.sh     # required: EDIABAS + INPA, ~710 MB
scripts/setup/fetch-coding.sh     # optional: coding definitions, 5.6 MB
scripts/setup/fetch-wiring.sh     # optional: wiring diagrams, ~1 GB
scripts/setup/check-vendor.sh     # what is installed, what is missing
```

Only the first is needed to build and run. The other two each light up one
screen, and `check-vendor.sh` says how to get them if they are absent rather
than failing. Each section below explains what its script actually does.

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

The importer also takes `--images-out DIR`, which writes the component
photographs beside the archives instead of inside them, deduplicated across
chassis. That is how the hosted build is made: a GitHub Pages site may hold
1 GB and the archives are 1.02 GB, of which 878 MB is photographs. So the web
build ships the 144 MB of diagrams and text and pulls each picture from
[a CDN](https://github.com/dader34/BMacW-wiring-images) as it is needed,
keeping it in the browser's cache. The macOS app and offline copies keep the
images inside their archives and never touch the network for them.

### Coding definitions (optional)

The Coding screen labels a module's settings from two independent sources.
The first needs nothing extra: 32 ECUs name their own coding values inside
their SGBD, and `coding_map.py` mines those. The second is BMW's own coding
description, which is what NCS Expert reads, and covers the modules whose
SGBD hands back an unlabelled blob:

```sh
scripts/setup/fetch-coding.sh           # 5.6 MB, all 18 chassis
tools/decompile/daten_map.py            # -> app/renderer/data/datenmap.js
```

That is a slice of SP-Daten: 2,219 `.C0x` module files across E36 to RR1,
each chassis with the keyword tables that name its functions and values.
The full SP-Daten distribution is around 16 GB, but almost all of that is
ECU firmware for reprogramming, which nothing here uses; the coding
definitions are 17.7 MB of it.

**The keyword table is per chassis** and each archive carries its own: E39
uses `SWTFSW01`, E46 `SWTFSW06`, E60 `SWTFSW05`, E70 `SWTFSW11`. Reading a
module against the wrong one does not fail loudly, it returns real keywords
belonging to some other function, so chassis and table travel together.

Together the two sources describe 85 of the 310 shipped ECUs. Writes stay
blocked in either case: the screen reads, stages a change and shows exactly
what would be sent, and there is no send path in it at all.

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
across all 1,117 ECUs, the VM against captured telegrams, the write guard, and
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
src/BMacW.Host/   shell core: file host, cable, TCP, settings, paths
src/InpaMac.App/  macOS shell: AppKit window + WKWebView around that core
src/InpaMac.Cli/  the real EDIABAS engine, kept to verify the VM against
vendor/esp-link-ws/  WebSocket firmware for the THOR adapter, + prebuilt images
tools/            decompilers, exporters, test harnesses
data/ecu-src/     committed source: one gzipped copy per SGBD
data/chassis/     derived per-car tree (gitignored)
vendor/           BMW originals: NOT in the repo, supply your own
vendor/WDS/       BMW's wiring diagrams, optional (scripts/setup/fetch-wds.sh)
vendor/EC-APPS/NCSEXPER/DATEN/  coding definitions (scripts/setup/fetch-coding.sh)
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
