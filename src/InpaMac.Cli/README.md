# InpaMac CLI

A native macOS EDIABAS command-line front-end for BMW diagnostics, sharing the
same `EdiabasMac` backend (`Diag`, `FaultReader`, `InpaConfig`, `MenuGen`,
`FlashService`) that powers the GUI. Talks K+DCAN over an FTDI serial cable
(`/dev/tty.usbserial*`, auto-detected). Default SGBD `ms450ds0` (E46 MS45.1 DME).

The original flat-argv commands live in `Program.cs`; the extended subcommand set
lives in `Commands.cs` (the dispatcher) and its sibling `*Commands.cs` files.
`Commands.TryDispatch` gets first refusal on every invocation and falls through
to `Program.cs` for the commands it does not own (`allsgbds`, `dumpargs`,
`dumptable`, `dumpjobs`, `simrun`, `simbatch`, `chassis`).

## Running

```
dotnet build src/InpaMac.Cli
dotnet run  --project src/InpaMac.Cli -- <command> [args]
# packaged: inpamac <command> [args]
```

`inpamac help` prints the full reference. Every command accepts the global
options below.

## Global options

| option | meaning |
|---|---|
| `--port DEV` | K+DCAN serial device (default: auto-detect) |
| `--sgbd NAME` | SGBD to load (default `ms450ds0`) |
| `--json` | machine-readable JSON on stdout (available on every command) |
| `--quiet`, `-q` | suppress prose |
| `--verbose`, `-v` | keep the `_TEL_*` request/answer telegram echoes |
| `--confirm`, `--yes`, `-y` | required for every destructive/write op |

## Commands

### Vehicle / chassis (offline)
| command | example |
|---|---|
| `chassis [ID]` | `chassis` / `chassis E46` — the INPA nav tree |
| `ecus [ID]` | `ecus E46` — ECUs by section, with SGBD + address group |
| `ecu <CODE\|SGBD> [--chassis E46]` | `ecu MS450 --chassis E46` — one ECU's metadata + variants |
| `sgbd <CODE> [--chassis E46]` | `sgbd MS450 --chassis E46` — offline SGBD/group resolution |
| `allsgbds` | every SGBD across every chassis (Program.cs) |

### Jobs (offline metadata; `run` is live)
| command | example |
|---|---|
| `jobs [SGBD] [--filter S]` | `jobs ms450ds0 --filter STATUS` |
| `results <JOB> [SGBD]` | `results IDENT ms450ds0` — result schema |
| `arguments <JOB> [SGBD]` (alias `args`) | `arguments STEUERN_E_LUEFTER ms450ds0` |
| `tables [SGBD]` / `tables <TABLE> [SGBD]` | `tables BITS zke5` — dump a lookup table |
| `run <JOB> [ARG] [SGBD]` | `run STATUS_UBATT ms450ds0` (live) |

`run` refuses a job whose name looks like a write/actuator (`*_SCHREIBEN`,
`*_LOESCHEN`, `STEUERN_*`, `RESET`, flash verbs) unless `--confirm` is given.

### Identification
| command | example |
|---|---|
| `ident [SGBD] [--group D_00xx]` | `ident ms450ds0` — IDENT: part no, HW/SW, coding + variant index (live) |
| `info [SGBD]` | `info ms450ds0` — SGBD INFO card (live) |
| `serial [SGBD]` | `serial ms450ds0` — module serial number (live) |

### Faults
| command | example |
|---|---|
| `read [SGBD] [--group D_00xx]` | `read ms450ds0` — read fault memory, sibling-variant label merge (live) |
| `clear [SGBD] --confirm` | `clear ms450ds0 --confirm` — **ERASE** fault memory, then verify (live) |
| `report [SGBD] [--out F] [--format json\|text]` | `report ms450ds0 --out faults.json --format json` |

### Status / live data (live)
| command | example |
|---|---|
| `status [JOB] [SGBD] [--poll] [--interval MS] [--count N]` | `status STATUS_MESSWERTE ms450ds0 --poll --interval 500` |
| `battery [SGBD]` | `battery ms450ds0` — the DME's reported Kl.87 voltage (STATUS_UBATT) |

Battery/ignition here is the ECU's own reading, **not** INPA's adapter-sensed
value (that is a GUI-only UTILITY emulation, not a bus job).

### Coding
| command | example |
|---|---|
| `coding read [SGBD]` | `coding read zke5` — coding bytes + coding index (safe) |
| `coding write <SGBD> --data <HEX> --confirm` | see gating below |

Coding **write** mirrors the renderer's `coding-write.js`: it picks the write job
from what the SGBD exposes (`CODIERDATEN_SCHREIBEN` / `CODIERUNG_SCHREIBEN`),
prints exactly what it will do, backs up the previous coding, writes, then
proves the change by re-reading. It is **doubly gated**: it does nothing unless
BOTH `BMACW_ALLOW_CODING_WRITE=1` (env) AND `--confirm` are present. Modules that
use the binary `C_S_AUFTRAG`/`C_CHECKSUM` (cfg-chunked) or file-based coding path
are **refused** — their checksum is computed by the module's own flow and is not
reproduced natively here; use the GUI for those.

### Variant / group probe (live)
| command | example |
|---|---|
| `resolve <D_00xx\|CODE> [--chassis E46]` | `resolve D_0012` / `resolve MS450 --chassis E46` |

Loads the diagnostic-address group `.grp`, runs `IDENTIFIKATION`, and reports
which concrete SGBD is actually installed (the `VARIANTE` result, lowercased).

### Adapter
| command | example |
|---|---|
| `ports` | list serial devices, mark the auto-detected one |
| `adapter [--port DEV]` | show the selected transport |

### Decode tooling (wraps python; needs the dev repo)
`tools <sub> <ECU-stem> [...]` shells out to `python3 tools/...`. Names are
ECU/SGBD **stems** (e.g. `GSDS2`, `ms450ds0`), never file paths.

| sub | wraps | example |
|---|---|---|
| `disasm` | `ipo_disasm.py` | `tools disasm GSDS2 m_main` |
| `ir` | `ipo_ir.py` | `tools ir RDC` (full UI IR, JSON) |
| `screens` | `ipo_screens.py` | `tools screens RDC` |
| `vm` | `ipo_vm.py` | `tools vm GSDS2 m_status` (run the VM on a proc) |
| `status` | `ipo_status.py` | `tools status GSDS2` |
| `memory` | `ipo_memory.py` | `tools memory MS450` |
| `coding` | `ipo_coding.py` | `tools coding ZKE5` |
| `spec` | `sgbd/sgbd_spec.py` | `tools spec ms450ds0 STATUS_UBATT` |

## Safety

Reads run freely. Every write requires `--confirm` and prints exactly what it
will do first:

- **clear** (fault erase) — `--confirm`; verifies empty afterward.
- **coding write** — `--confirm` **and** `BMACW_ALLOW_CODING_WRITE=1`; backs up,
  writes, proves by re-read; refuses unsupported checksum paths.
- **run** with a write/actuator-looking job — `--confirm`.
- **flashing** (via `FlashService`) — `--confirm` **and** `BMACW_ALLOW_FLASH_WRITE=1`;
  not surfaced as a CLI command here (the write path is UNVERIFIED — bench-test
  required — so it is intentionally not exposed).

## Exit codes

| code | meaning |
|---|---|
| 0 | ok |
| 2 | usage error |
| 3 | runtime error |
| 4 | no device / not found |
| 5 | needs `--confirm` (and/or env gate) |
| 6 | write done but verification failed |
| 7 | unsupported write path |
