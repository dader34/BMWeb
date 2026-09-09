# bmweb-cli

[BMWeb](https://bmweb.danner.ink/)'s tools as a command line. Read what an
INPA `.IPO` script does, compile an `.IPS` / `.SRC` source, search every
module the site ships for the key that does a thing, and decode or compare
the report links the app's Garage shares. No browser, no car.

The commands run the app's own code: the `.IPO` reader and the source
compiler, the job search and the Garage report codec are the same files the
site loads, copied into the package at build time. There is one
implementation, and this is a second way to reach it.

```
npm i -g bmweb-cli
bmweb --help
```

Node 20 or later. No runtime dependencies.

## What is in the package

Only the project's own code. Nothing BMW-derived ships with it: no scripts,
no SGBDs, no fault database, no parts data. The one thing the tool needs
that it does not carry, the job search index, is fetched from the site.

## Commands

### `bmweb ipo info <file>`

What a script is: form, entry point, includes, procedure counts, DLL
imports, and every menu with its keys, the screen each opens and the jobs it
sends. Takes a compiled `.IPO`, or an `.IPS` / `.SRC` source (compiled
first; pass `-I <dir>` with the INPA headers it includes).

```
$ bmweb ipo info PROBE.IPS -I inc
Script       PROBE (compiled from source)
Form         INPA diagnostic script
Entry        inpainit -> m_main / s_main
Includes     PROBE.H
Procedures   8 (2 menus, 3 screens, 3 functions, 0 state machines)
DLL imports  none

m_main  "Main"  (screen s_main)
  F1         Ident         s_ident        IDENT
  F2         Fault memory  s_fs (cyclic)  FS_LESEN, FS_LESEN_DETAIL
  F3         Clear faults                 FS_LOESCHEN [WRITE]
  F4         Helper                       IDENT
  F5         (no caption)  menu m_sub
  F10        Back                         DIAGNOSE_ENDE, (exit)
  Shift+F10  Print                        (printscreen)

m_sub
  F1  Sub key    STATUS_LESEN
```

The jobs are read from the script without running it: the constants each
key's body pushes before its `INPAapiJob` calls, plus what the screen it
opens sends from its own `LINE` blocks, following helper functions the key
calls. `[WRITE]` marks a job the app would ask about before sending (the
write classifier's verdict, minus the session plumbing every script sends).
A job whose name the script builds at run time is not shown.

### `bmweb ipo keys <file> [--menu m_x]`

The same keys as one table across every menu, or one menu.

```
$ bmweb ipo keys PROBE.IPS -I inc --menu m_main
MENU    KEY        LABEL         OPENS          JOBS                       WRITES
------  ---------  ------------  -------------  -------------------------  ------
m_main  F1         Ident         s_ident        IDENT
m_main  F2         Fault memory  s_fs (cyclic)  FS_LESEN, FS_LESEN_DETAIL
m_main  F3         Clear faults                 FS_LOESCHEN [WRITE]        yes
m_main  F4         Helper                       IDENT
m_main  F5         (no caption)  menu m_sub
m_main  F10        Back                         DIAGNOSE_ENDE, (exit)
m_main  Shift+F10  Print                        (printscreen)
```

### `bmweb ipo compile <file.IPS> [-I dir]... [-o out]`

Compile an INPA source. Includes are looked up beside the script and in
each `-I` directory, by file name, case-insensitively, the way INPA's own
tooling finds them; a missing one is named rather than half-compiled.

```
$ bmweb ipo compile MY_SCRIPT.IPS -I ~/INPA/SGDAT
MY_SCRIPT.IPS: compiled 8 procedures (2 menus, 3 screens, 3 functions, 0 state machines), includes INPA.H
wrote /home/me/MY_SCRIPT.ipoexec.json (the app's exec form; not INPA's binary .IPO)

$ bmweb ipo compile MY_SCRIPT.IPS
bmweb: MY_SCRIPT.IPS: missing include INPA.H (searched /home/me; pass -I <dir> with the INPA headers)
```

What it writes is the form the app runs: the script's procedures as the
token stream the runtime executes (`{procs, byid}`, the same shape the
Script runner builds from a dropped file). The app's compiler emits that,
not INPA's binary container, so the output is not a `.IPO` you could hand
to INPA itself. The `.IPO` byte writer lives in the repository's Python
tooling and is not part of this package.

### `bmweb search <query...> [--chassis E46] [--limit N] [--json]`

The corpus job search: every INPA key and screen in every module the site
ships, matched on what it is called (in German and in English) and the
jobs it sends. All words must match. Results are grouped by chassis, then
module, and every hit carries the deep link that opens it on the site.

```
$ bmweb search clear adaptation --chassis E46 --limit 4
E46
  ms410ds0  MS 41.0  (ms410ds0)
    F7  clear adaptation values    [WRITE]  https://bmweb.danner.ink/#car/E46/ms410ds0/m_fehler
  ms410ds1  MS 41.0  (ms410ds1)
    F7  clear adaptation values    [WRITE]  https://bmweb.danner.ink/#car/E46/ms410ds1/m_fehler
  ms410ds2  MS 41.0  (ms410ds2)
    F7  clear adaptation values    [WRITE]  https://bmweb.danner.ink/#car/E46/ms410ds2/m_fehler
  ms450ds0  MS45  (ms450ds0)
    F8  Clear selected adaptation values    https://bmweb.danner.ink/#car/E46/ms450ds0/m_main/s_ada_loe

4 of 5 results shown (raise --limit for more)
```

The index (`https://bmweb.danner.ink/api/search-index.json.gz`, about 2.5
MB) is fetched on first use and kept under `$XDG_CACHE_HOME/bmweb-cli/`
(default `~/.cache/bmweb-cli/`). It is refreshed when the copy is a day
old, or on `--refresh`; when the site cannot be reached the cached copy is
used and a warning says so.

### `bmweb report show <link-or-payload> [--json]`

Decode a link the Garage's Share button made (`...#report/<payload>`; the
bare payload is accepted too) and print the report: one row per fault with
its module, code, text, occurrence count and whether it was present at the
read, plus the addresses that stayed silent. An identification report
prints each module's ident fields with the app's captions.

```
$ bmweb report show 'https://bmweb.danner.ink/#report/q1WpV...'
Report   fault memories of E46 325i / E46
Read     2026-09-01T10:00:00Z
Modules  2 read, 1 with faults, 2 faults, 1 silent

MODULE    CODE  TEXT                          COUNT  STATE
--------  ----  ----------------------------  -----  -------
DME MS45  27C3  DMTL pump current too high    3      present
DME MS45  120   Lambda sensor heater, bank 1  1      stored
IHKA            no faults stored

Silent (1):
  D_0044  EGS  no answer
```

The code is the DTC from `F_HEX_CODE` when the module reports one, else the
DTC the fault text leads with, else the location number, which is how the
Garage itself identifies a fault when comparing reads. The link carries no
VIN, and nothing is fetched: the report is in the link.

### `bmweb report diff <link-a> <link-b> [--json]`

What changed between two shared reports, older first, using the app's own
comparison: new, cleared and still-present faults per module, ident fields
that moved, and modules that went silent or started answering. A fault
present in both reads is the same fault whatever its status byte or counter
did; a module the newer read has no record of is unread, not cleared.

```
$ bmweb report diff "$A" "$B"
From     2026-09-01T10:00:00Z  E46 325i
To       2026-09-08T12:00:00Z  E46 325i
Changes  1 new, 1 cleared, 1 still present, 1 module changed

DME MS45
  +  2A0B  Camshaft sensor, inlet        1
  -  120   Lambda sensor heater, bank 1  1
  =  27C3  DMTL pump current too high    5

IHKA  unchanged

Answering changed:
  answering now  EGS

+ new   - cleared   = still present   ~ ident field changed
```

### Every command

`--json` prints machine-readable output instead of a table. Errors are one
line on stderr and exit code 1. `bmweb <command> --help` lists a command's
options; `bmweb --version` prints the version.

## No car

v0.1 has no live-car access. The app talks to the car through Web Serial
in the browser; a serial transport for Node is a possible later addition.
Everything here works on files and on the site's index.

## Developing

The package lives in `cli/` of the [BMWeb repository](https://github.com/dader34/BMWeb).
`npm run build` copies the app files it runs into `runtime/`, bundles
`src/bmweb.ts` to `dist/bmweb.js` with esbuild and type-checks with `tsc`;
`npm test` runs the `node:test` suites the build produced. The repository's
`tools/check.sh` runs both.

## License

GPL-3.0, as the repository is. See `LICENSE`.
