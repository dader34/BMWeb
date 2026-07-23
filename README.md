# BMacW

BMW diagnostics on macOS. Runs the EDIABAS engine and INPA's data natively over a
K+DCAN cable, with no Windows install or virtual machine.

Read and clear fault codes, watch live values as gauge bars, run actuator tests,
and back up the MS45 DME flash. The interface mirrors INPA's layout, with an
optional modern theme.


## Status

Works on the bench and on the car (tested against an E46 with an MS45.1 DME).
Fault reading, live status, and actuator tests are functional. Flashing is
read/backup only for now; writing is not enabled.


## Requirements

- macOS on Apple Silicon
- .NET 10 and Node.js
- A K+DCAN USB cable (appears as `/dev/tty.usbserial-*`)
- BMW EDIABAS and INPA data (from BMW Standard Tools)

The EDIABAS and INPA data (`vendor/EDIABAS/Ecu`, `vendor/EC-APPS`) is committed via
Git LFS, so a clone with LFS pulls it automatically. The original BMW Standard Tools
package is also available [here](https://drive.google.com/drive/folders/1Odd9etzajiDBUYiso5NsTMZSoTOkeTXl).


## Setup

1. Clone with Git LFS so the BMW data comes down:

   ```
   git lfs install
   git clone <repo-url>
   ```

   The data lives at `vendor/EDIABAS/Ecu` and `vendor/EC-APPS`.

2. Build and start the app (requires the .NET SDK with the `macos` workload:
   `dotnet workload install macos`):

   ```
   dotnet build src/InpaMac.App
   open src/InpaMac.App/bin/Debug/net10.0-macos/osx-arm64/BMacW.app
   ```

Everything runs in that one process — the UI, the diagnostic API, and the
EDIABAS engine. Plug in the cable, turn the ignition on, and select your
chassis.


## How it works

- `src/InpaMac.App/` is the app: a native macOS window (WKWebView) showing
  `app/renderer/`, with the EDIABAS engine and the JSON API hosted in-process.
- `app/renderer/` is the UI — plain HTML/JS, no framework, no build step.
- `src/InpaMac.Api/` is the diagnostic JSON API as a library.
- `src/InpaMac.Server/` hosts that API standalone on `127.0.0.1:8777` — a
  development harness for curl/scripts, not needed to run the app.
- `src/EdiabasMac/` wraps the EDIABAS engine, the serial transport, and the MS45
  flash routines.
- `tools/` holds the INPA layout extractors (`inpa2json.py` converts any
  .ips/.IPO to portable JSON), a PowerPC disassembler, and the fault-map
  builders.


## Installing a release build

The `.dmg` is unsigned (there is no Apple Developer account behind it), so macOS
flags it on first launch. After dragging BMacW to Applications, clear the
download quarantine once:

```
xattr -dr com.apple.quarantine /Applications/BMacW.app
```

Or run the helper, which also re-signs the bundle ad-hoc:

```
./scripts/install-macos.sh
```

Then open BMacW normally.


## Packaging

`dotnet build src/InpaMac.App` produces the `BMacW.app` bundle. Release
packaging (`dotnet publish` with the BMW data bundled under `Resources/data`,
plus a `.dmg`) is being rebuilt for the native app; the 0.1.x `.dmg` releases
were produced by the retired Electron shell.


## Fault-code translations

BMacW shows an English description for each fault code it reads. These are
generated from the authoritative BMW SGBD `FORTTEXTE` tables (per ECU), not
hand-maintained. See [CONTRIBUTING.md](CONTRIBUTING.md).


## License

GPLv3. The DME flash code is ported from
[terraphantm/MS45-Flasher](https://github.com/terraphantm/MS45-Flasher), which is
GPLv3. See `LICENSE` and `NOTICE.md`.
