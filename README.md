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

2. Install dependencies and start the app:

   ```
   cd app
   npm install
   npm start
   ```

The .NET sidecar is built and launched automatically. Plug in the cable, turn the
ignition on, and select your chassis.


## How it works

- `app/` is an Electron shell. It talks to a local sidecar over HTTP.
- `src/InpaMac.Server/` is the .NET sidecar. It exposes the diagnostic API on
  `127.0.0.1:8777` and drives EDIABAS.
- `src/EdiabasMac/` wraps the EDIABAS engine, the serial transport, and the MS45
  flash routines.
- `tools/` holds the INPA layout extractors, a PowerPC disassembler, and the
  fault-map builders.


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

`app/electron-builder.yml` builds the `.dmg`. The BMW data is bundled into the
app under `Resources/data` so the release runs standalone. A post-pack hook
(`app/build/after-pack.js`) re-signs the bundle ad-hoc after that data is copied
in, so the signature seal stays valid.


## License

GPLv3. The DME flash code is ported from
[terraphantm/MS45-Flasher](https://github.com/terraphantm/MS45-Flasher), which is
GPLv3. See `LICENSE` and `NOTICE.md`.
