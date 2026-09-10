# bmweb-cli

[BMWeb](https://bmweb.danner.ink/)'s tools as a command line. Read what an
INPA `.IPO` script does, compile an `.IPS` / `.SRC` source into a real
`.IPO`, search every module the site ships for the key that does a thing,
decode or compare the report links the app's Garage shares, list what a
module's SGBD declares (its jobs and their arguments, results and lookup
tables), and, with a K+DCAN cable, run jobs, read every fault memory of a
car, and drive a module's INPA screens from the terminal.

The commands run the app's own code: the `.IPO` reader and the source
compiler, the job search, the Garage report codec, the transport (framing,
the K-line exchange, the Web Serial bus), the BEST2 job VM, the `.IPO` VM
and the program that runs a module's script are the same files the site
loads, copied into the package at build time. There is one implementation,
and this is a second way to reach it.

```
npm i -g bmweb-cli
bmweb --help
```

Node 20 or later. One optional dependency, `serialport`, used only by the
commands that talk to the car; if it did not install, `npm i -g serialport`.

## What is in the package

Only the project's own code. Nothing BMW-derived ships with it: no scripts,
no SGBDs, no fault database, no parts data. Everything the tool needs that
it does not carry is fetched from the site (or `--api <url>`) and kept
under `$XDG_CACHE_HOME/bmweb-cli/` (default `~/.cache/bmweb-cli/`) for a
day: the job search index (about 2.5 MB), and, for the `sgbd` commands,
`job --info` and the commands on the cable, the chassis archives the app
itself loads (`api/chassis/E46.chassis`, about 20 MB for an E46), the
group bytecode and the shared tables.
`--refresh` fetches again; when the site cannot be reached the cached copy
is used and a warning says so.

## Offline commands

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

The package carries the app's own home script (`runtime/home/bmweb-home.ips`
and its `bmweb.h`, both written by the project), which reads like any other:

```
$ bmweb ipo info "$(npm root -g)/bmweb-cli/runtime/home/bmweb-home.ips" \
    -I "$(npm root -g)/bmweb-cli/runtime/home"
```

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

### `bmweb ipo compile <file.IPS> [-I dir]... [-o out] [--exec]`

Compile an INPA source. Includes are looked up beside the script and in
each `-I` directory, by file name, case-insensitively, the way INPA's own
tooling finds them; a missing one is named rather than half-compiled.

```
$ bmweb ipo compile MY_SCRIPT.IPS -I ~/INPA/SGDAT
MY_SCRIPT.IPS: compiled 8 procedures (2 menus, 3 screens, 3 functions, 0 state machines), includes INPA.H
wrote /home/me/MY_SCRIPT.IPO (44902 bytes, INPA's .IPO container)

$ bmweb ipo compile MY_SCRIPT.IPS
bmweb: MY_SCRIPT.IPS: missing include INPA.H (searched /home/me; pass -I <dir> with the INPA headers)
```

What it writes is a real `.IPO`: INPA's own binary container, the same
block layout the shipped scripts use. The writer is the app's own, and it
is held to reproduction -- every script in a full INPA install decodes and
re-encodes to its own bytes exactly, so the bytes it writes for a source
are the bytes that format calls for.

`--exec` writes the app's exec form instead (`{procs, byid}` as JSON, the
token stream the runtime executes and the same shape the Script runner
builds from a dropped file), which is what this command wrote before it
could write the container.

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

### `bmweb sgbd jobs <sgbd> [--api url] [--refresh] [--json]`

Every job an SGBD declares, with the arguments it takes, the results it
returns, a comment, and whether the app's write gate would ask about it
before sending it. Nothing is sent and no port is opened: this is the
module's shipped declaration, the same one the app's Tool32 lists a job
from. A diagnostic group (`d_motor`, `d_0012`) is read from its own group
file rather than resolved on the wire, so it lists the job names and the
tables the group carries.

```
$ bmweb sgbd jobs lws5
NAME                       ARGS                                       RESULTS                                                                 COMMENT                              WRITE
-------------------------  -----------------------------------------  ----------------------------------------------------------------------  -----------------------------------  -----
ABGLEICH_LESEN                                                        JOB_STATUS, ABGL_LRW_OFFSET, ABGL_LWS_ID, ABGL_FGSTNR, _TEL_ANTWORT     OKAY, wenn fehlerfrei
ABGLEICH_SCHREIBEN                                                    JOB_STATUS, _TEL_ANTWORT                                                 OKAY, wenn fehlerfrei                yes
ABGLEICH_VORGEBEN          ABGL_LRW_OFFSET, ABGL_LWS_ID, ABGL_FGSTNR  JOB_STATUS, _TEL_AN_SG, _TEL_ANTWORT                                     OKAY, wenn fehlerfrei                yes
CODIERUNG_LESEN            BLOCK                                      JOB_STATUS, COD_DATEN, _TEL_AN_SG, _TEL_ANTWORT                          OKAY, wenn fehlerfrei
FS_LESEN                                                              JOB_STATUS, F_HEX_CODE, F_ORT_NR, F_ORT_TEXT, F_HFK, F_ART_ANZ, +4 more  OKAY, wenn fehlerfrei
FS_LOESCHEN                                                           JOB_STATUS, _TEL_ANTWORT                                                 OKAY, wenn fehlerfrei                yes
...

24 jobs, 9 the app would ask about before sending
```

The WRITE column is the app's classifier (`isWriteJob`), the same verdict
`bmweb job` gates on: a read token in the name wins, a write token makes a
write, and an unknown name is a write. A cell that lists only the first few
names says how many more there are; `--json` and `bmweb job <sgbd> <JOB>
--info` carry every one.

The site's export writes a job's results as `NAME : comment` and keeps no
comment above them, so COMMENT is the `JOB_COMMENT` result where the SGBD's
author wrote one and the first declared result's comment otherwise.

### `bmweb sgbd tables <sgbd> [--api url] [--refresh] [--json]`

The lookup tables an SGBD carries for its own bytecode -- the ones its jobs
read with `tabset` to turn a byte into a word -- with the rows and columns
of each.

```
$ bmweb sgbd tables ms450ds0
NAME                      ROWS  COLS  COLUMNS
------------------------  ----  ----  ---------------------------------------------------
AUTHENTISIERUNG           4     2     AUTH_NR, AUTH_TEXT
BAUDRATE                  7     3     NR, BAUD, BAUD_TEXT
BETRIEBSSTUNDENSTATUS     4     2     WERT, UWTEXT
BITS                      72    4     NAME, BYTE, MASK, VALUE
CBSKENNUNG                16    3     NR, CBS_K, CBS_K_TEXT
...

53 tables (bmweb sgbd table ms450ds0 <NAME> prints one)
```

These are the module's own tables. The four shared table files (`t_pcod`,
`t_scod`, `t_ausb`, `t_grtb`, which an SGBD reads with `tabsetex`) belong
to no one module -- every job VM is handed all of them -- so they are not
listed here, and a module is never said to carry them.

### `bmweb sgbd table <sgbd> <NAME> [--api url] [--refresh] [--json]`

One table's rows.

```
$ bmweb sgbd table ms450ds0 BAUDRATE
NR    BAUD      BAUD_TEXT
----  --------  --------------------
0x01  PC9600    Baudrate 9.6 kBaud
0x02  PC19200   Baudrate 19.2 kBaud
0x03  PC38400   Baudrate 38.4 kBaud
0x04  PC57600   Baudrate 57.6 kBaud
0x05  PC115200  Baudrate 115.2 kBaud
0x06  SB        Specific Baudrate
0xXY  --        unbekannte Baudrate

7 rows in BAUDRATE
```

The name is matched without regard to case, and a near miss is named:
`bmweb sgbd table lws5 BITS` answers `lws5 carries no table BITS`.

## Commands on the cable

These need a K+DCAN cable (an FTDI cable, or a clone) on the car's OBD
port, and the `serialport` package. The port is the single candidate when
there is one; otherwise name it with `--port`.

The wire is the app's own transport, run unchanged over a Node port with
the Web Serial API's shape. What that carries over, verified by the app on
a real E46 with an FTDI cable on a Mac: the port opens 115200 8N1 and is
reopened 9600 8E1 for a DS2 or KWP2000 module on its own; DTR idles high
for BMW-FAST and D-CAN and low on every K-line concept, RTS is never
raised, and on the K line DTR is held for exactly the telegram's byte time
as the transmit enable; the ISO 9141 slow init is bit-banged on the break
line; the echo a wired K line returns is dropped by count; every timeout is
time-to-first-byte and comes from the SGBD's own communication parameters;
a read that ran out of time is resumed, never abandoned, so no byte is
lost; a silent address is the ECU's answer of zero bytes, which the SGBD's
own bytecode branches on. An FTDI cable wants a 1 ms latency timer (set for
you on Linux; on macOS and Windows a driver setting), and an echo failure
(IFH-0003) says so.

**Run on a real car.** Since 0.1.4, `job`, `scan` and `tui` have been run
on an E46 over an FTDI K+DCAN cable on macOS. What that run fixed is in
`src/serial.ts`: on macOS a Node serial port never wakes on bytes an FTDI
cable sends back, so the reader polls the port's modem lines while it is
reading and picks the bytes up itself. The offline commands need no cable
and never open one.

Everything is still tested offline as well: the transport end to end
against a fake cable (the DS2 and BMW-FAST framing, the reopen, the DTR
sequence, the echo), and `job`, `scan` and `tui` against the fake car the
app's own runtime tests use, both directly and through a gateway on a real
socket. The gateway itself has not been on a car yet.

### `bmweb ports [--json]`

The serial ports a K+DCAN cable shows up as: `cu.usbserial*`, `cu.SLAB*`,
`cu.wchusbserial*`, `ttyUSB*`, `ttyACM*`, with the vendor detail when
`serialport` is installed. Needs no package to list.

```
$ bmweb ports
/dev/cu.usbserial-AB0JQ9XY  FTDI  0403:6001  sn AB0JQ9XY
```

### Gateway

One machine owns the cable; another drives it. `bmweb gateway` opens the
local port exactly as `job` does and serves it over a WebSocket, and
`--gateway` on `job`, `scan` and `tui` (and the app in a browser) hands
that socket to the same transport, which cannot tell it from a cable in
its own USB port.

Nothing about the wire moves. The framing, the checksums, the reopen for a
concept change, DTR as the K-line transmit enable, the echo dropped by
count, the timeouts measured to the first byte and every write
confirmation all run on the machine you typed the command on, because
that is where the bus is. The machine with the cable moves bytes and
modem-line states, and nothing else.

**It is a pipe, not a gate.** The gateway never sees a job name, only
bytes, so it cannot tell a read from a write and does not try. Anyone who
can reach the listening port can drive the car. It binds `127.0.0.1` by
default, which is this machine only; `--listen 0.0.0.0:6801` opens it to
whoever can route to the machine, and says so when it starts.

On the machine with the cable:

```
$ bmweb gateway --listen 0.0.0.0:6801
gateway: /dev/cu.usbserial-AB0JQ9XY served at ws://0.0.0.0:6801
  this is a byte pipe with no gate of its own: anyone who can reach this port can drive the car.
  listening beyond this machine; the port is open to whoever can route to it
  one client at a time; the cable is closed when the client goes.
  client 192.168.1.24:52233 connected
  client 192.168.1.24:52233 disconnected, cable closed
^C
gateway: stopping, the cable is closed
```

On the machine driving it:

```
$ bmweb job ms450ds0 STATUS_LESEN --gateway 192.168.1.9:6801
ms450ds0 MS450DS0 STATUS_LESEN: 1 set

set 1
  STAT_MOTORDREHZAHL_WERT  812.5
  STAT_MOTORDREHZAHL_EINH  1/min
  JOB_STATUS               OKAY

$ bmweb job ms450ds0 FS_LOESCHEN --gateway 192.168.1.9:6801
FS_LOESCHEN on ms450ds0 is a write (it changes the module or drives something). Send it? [y/N] n
FS_LOESCHEN on ms450ds0: not sent (a write needs --yes or a y answer)
```

The question is asked here, on the driving machine, and a `n` means the
bytes never leave it. `--gateway` takes `host:port`, a bare host (port
6801 is assumed), or a full `ws://` / `wss://` URL. One client at a time:
a second connection is refused with a message, and the cable is closed
when the client goes, so the host machine can use its own port in
between.

#### From a browser

The app drives a gateway too. Set the address in Settings, under "Cable on
another machine", or open the page with `?gateway=ws://192.168.1.9:6801`,
which stores it. The topbar's cable chip then reads
`cable: gateway 192.168.1.9:6801 (/dev/cu.usbserial-AB0JQ9XY)`, so the car
never looks local when it is not.

Where this works is a browser rule, not ours: **a page served over http
(localhost, an offline export opened from a file, an offline copy served
on your own network) may open a plain `ws://` gateway. The hosted https
site may not** -- browsers block `ws://` from an https page as mixed
content, with no override. From https, only a `wss://` gateway works,
which means putting a TLS front end with a certificate the browser trusts
in front of it.

#### The protocol

JSON text frames for control, binary frames for the bytes the wire
carries, so a read crosses as one frame with no base64 and no copy.

| direction      | frame  | meaning                                                                                     |
| -------------- | ------ | ------------------------------------------------------------------------------------------- |
| client to host | text   | `{"id":1,"op":"open","config":{"baudRate":9600,"dataBits":8,"stopBits":1,"parity":"even"}}` |
| client to host | text   | `{"id":2,"op":"close"}`                                                                     |
| client to host | text   | `{"id":3,"op":"setSignals","signals":{"dataTerminalReady":true}}`                           |
| client to host | text   | `{"id":4,"op":"getSignals"}`                                                                |
| client to host | binary | the bytes to write, exactly as given                                                        |
| host to client | text   | `{"id":1,"ok":true}`, or `{"id":4,"ok":true,"signals":{...}}`                               |
| host to client | text   | `{"id":2,"ok":false,"error":"..."}`                                                         |
| host to client | text   | `{"event":"hello","port":"/dev/cu.usbserial-AB0JQ9XY","gateway":"bmweb"}`                   |
| host to client | binary | bytes as they arrive off the wire, streamed                                                 |

A write needs no reply: the wire has no acknowledgement to give, and the
transport never waited for one. Reads are streamed as the bytes arrive
rather than gathered into an answer, so a timeout still means
time-to-first-byte on the driving machine. `setSignals` keeps the lines it
does not name, as a local port does. Every failure travels back as the
same message text a local port would have raised, so the app throws it
verbatim and cannot tell the difference.

The WebSocket is RFC 6455 with no compression and no extensions, written
in the package itself (`src/ws.ts`) rather than pulled in, because the
package promises zero runtime dependencies and Node ships a WebSocket
client only from version 22 and no server at all.

### `bmweb job <sgbd> <JOB> [arg] [--results a,b] [--info] [--port p] [--gateway h:p] [--yes] [--json]`

One raw job on one module, like the app's Tool32: the SGBD's own bytecode
runs in the job VM over the cable, inside its EDIABAS session
(INITIALISIERUNG once, the communication parameters carried across jobs,
ENDE when another module is loaded), and the result sets print as tables.
A group name (`D_MOTOR`, `D_0012`) is resolved on the wire to the variant
that answers, as the app resolves it.

```
$ bmweb job ms450ds0 STATUS_LESEN
ms450ds0 MS450DS0 STATUS_LESEN: 1 set

set 1
  STAT_MOTORDREHZAHL_WERT  812.5
  STAT_MOTORDREHZAHL_EINH  1/min
  JOB_STATUS               OKAY

$ bmweb job ms450ds0 FS_LOESCHEN
FS_LOESCHEN on ms450ds0 is a write (it changes the module or drives something). Send it? [y/N] n
FS_LOESCHEN on ms450ds0: not sent (a write needs --yes or a y answer)
```

The write gate is the app's classifier (`isWriteJob`): a read token in the
name wins, a write token makes a write, and an unknown name is a write.
A write goes out only with `--yes` or a `y` on the terminal; without a
terminal the answer is no. A write is never sent silently.

`--results` names the results to print, comma-separated and without regard
to case. The job still runs whole -- the flag narrows what is shown, not
what is asked of the module -- and `--json` is filtered the same way, so
the table and the JSON never disagree about what was read. A name that
matched nothing is a warning on stderr and the exit code stays 0.

```
$ bmweb job ms450ds0 STATUS_LESEN --results stat_motordrehzahl_wert,JOB_STATUS
ms450ds0 MS450DS0 STATUS_LESEN: 1 set

set 1
  STAT_MOTORDREHZAHL_WERT  812.5
  JOB_STATUS               OKAY
```

`--info` prints what the SGBD declares about the job -- its arguments, its
results and their comments -- instead of running it. It opens no port and
sends nothing, so it works with the cable unplugged and with the car
elsewhere; a job argument beside it is refused rather than quietly ignored.

```
$ bmweb job ms450ds0 AIF_LESEN --info
ms450ds0 AIF_LESEN

arguments (1)
  AIF_NUMMER  int  ==0 : aktuelles AIF > 0 : Nummer des zu lesenden AIF default = 0 : aktuelles AIF

results (21)
  AIF_ADRESSE_HIGH  AIF Adresse des AIF, High-Word
  AIF_ADRESSE_LOW   AIF Adresse des AIF, Low-Word
  AIF_FG_NR         Fahrgestellnummer 7-stellig
  AIF_FG_NR_LANG    Fahrgestellnummer 17-stellig falls vorhanden, sonst 7-stellig
  AIF_DATUM         Datum der SG-Programmierung in der Form TT.MM.JJJJ
  ...
  JOB_STATUS        OKAY, wenn fehlerfrei
```

A job that writes is headed `[WRITE]` here too, and `bmweb sgbd jobs`
below lists every job of a module at once.

`--gateway <host:port>` runs the same job on a cable another machine is
serving (see [Gateway](#gateway) below). The write gate does not move: it
is asked here, on the machine you typed the command on.

### `bmweb scan <chassis> [--port p] [--gateway h:p] [--share] [--json]`

INPA's own whole-vehicle script (E46 E53 E65 E83 E85 E87 E89 E90 R50 R56):
the script is opened, its fault-memory menu's read key is pressed, and what
it put on the wire is folded into the same report the app's Garage keeps,
one module per address that answered, the silent ones listed. `--share`
prints a link carrying the report, the same link the Garage's Share button
makes, which `bmweb report show` and the site both open.

```
$ bmweb scan E46 --share
E46: FS lesen (F1)
Engine
...
Scan     E46 fault memories (e46.ipo)
Read     2026-09-09T08:26:15.221Z
Modules  14 answered, 2 with faults, 3 faults, 5 silent

MODULE    CODE  TEXT                        COUNT  STATE
--------  ----  --------------------------  -----  -------
ms450ds0  27C3  DMTL pump current too high  3      present
...
Silent (5):
  D_0044  D_0044  ERROR_NO_ANSWER
  ...

Share: https://bmweb.danner.ink/#report/...
```

The script's progress window (which module it is asking) goes to stderr;
a key that would write is declined, a prompt is cancelled: the scan reads.

`--gateway <host:port>` scans a car on a cable another machine is serving.

### `bmweb tui [<chassis> <sgbd>] [--port p] [--gateway h:p] [--menu m_x]`

INPA's screens in the terminal. With a chassis and a module (SGBD or INPA
code, or the chassis itself for its whole-vehicle script), that module's
script runs the way the app runs it: its entry identifies the module, its
root menu's keys are on the number row (1..9 and 0 for F1..F10, the
shifted symbols `! @ # $ % ^ & * ( )` and Shift+F1..F10 for the shifted
bank), Esc is the script's own Back, q quits. The screen is INPA's grid
redrawn in place, a lamp as `(*) word`, a bar as `[####....] value`; the
status line and the script's progress window are the two bottom lines.

With no arguments it starts on the app's own home, an INPA script of the
project's own (`home/bmweb-home.ips`): F1 picks a chassis then a module,
F2 the chassis's whole-vehicle script, and `scriptchange` hands the screen
to that script. A pick is a list the keyboard walks: Up/Down move the bar,
typing narrows the list to the rows containing the text, Enter picks, Esc
cancels. The home starts with or without a cable.

The TUI runs on the terminal's alternate screen (the buffer vim and htop
use), so the shell's scrollback is never touched and quitting restores it;
a screen redraws in place, only the lines that changed. A viewer longer
than the terminal (a fault protocol, a report) scrolls: Up/Down a line,
PgUp/PgDn a page, Home/End to either end, with a line under it saying
which rows are shown.

Every dialog INPA opens is a prompt: a message waits for Enter, an input
asks for the number (or hex, or text) within the declared range, the
two-word box takes y/n, the component picker (togglelist) and Select are
the same list picker (Space marks several where several may be picked),
save-as asks for a file name. **Every write is asked first**, exactly as the app asks: a key
whose body can send a write names the jobs and waits for y; a screen that
sends one on every refresh asks once for as long as it is open; n or
Enter abandons the key. On quit the leaving menu's Back job (the script's
own release of whatever it energised) goes to the module, then the
script's `inpaexit` (its DIAGNOSE_ENDE), the same release-on-leave the app
performs.

The module data the script needs (its `.IPO`, the SGBD bytecode, the
tables) comes from the site's chassis archive, cached as described above.

`--gateway <host:port>` drives a cable another machine is serving. Every
confirmation still happens here, on your keyboard.

### Every command

`--json` prints machine-readable output instead of a table. Errors are one
line on stderr and exit code 1. `bmweb <command> --help` lists a command's
options; `bmweb --version` prints the version.

## Developing

The package lives in `cli/` of the [BMWeb repository](https://github.com/dader34/BMWeb).
`npm run build` copies the app files it runs into `runtime/` (the list is
`src/runtime-files.json`, in the app's load order), bundles `src/bmweb.ts`
to `dist/bmweb.js` with esbuild and type-checks with `tsc`; `npm test` runs
the `node:test` suites the build produced, every one of them offline: the
serial tests drive the app's bus over a fake cable, the job, scan and tui
tests drive the app's runtime against a fake car and a scripted terminal,
with a module script written for the tests in INPA's language, and the
gateway tests run `job`, `scan` and `tui` a second time through a real
gateway on a port the OS picks. The repository's `tools/check.sh` runs all
of it.

Set `BMWEB_VERBOSE=1` to see what the app's runtime logs: the wire trace
the bus dumps after an error, each variant probe's verdict, the cable
events. It goes to stderr; without it the runtime is silent and a command's
output is only its own.

## License

GPL-3.0, as the repository is. See `LICENSE`.
