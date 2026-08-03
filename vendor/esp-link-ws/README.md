# esp-link WebSocket bridge (BMWeb)

A patch for [esp-link](https://github.com/jeelabs/esp-link) that adds a
**binary WebSocket at `ws://192.168.4.1/bmweb`**, bridged straight to the
adapter UART.

With it flashed, BMWeb talks to the THOR from any browser with nothing else
running: no `thor_bridge.js` relay, no node, no shell. That includes
**iPhone and Android**, which is the point, WebSockets are the only
browser transport with no platform gaps (Web Serial is desktop-Chrome only;
Web Bluetooth does not exist on iOS).

Everything esp-link already does, the config UI, WiFi setup, OTA firmware
upload, the telnet bridge on port 23, keeps working. This only adds a
route.


## Why a patch and not a from-scratch firmware

Stock esp-link has no WebSocket. Its µC console looks like one but is HTTP
polling (`/console/text?start=N`), which is text-oriented: bytes >= 0x80 do
not survive, and BMW telegrams are full of them (0x82, 0xB8, 0xF1). Port 23
is raw telnet, which a browser cannot open at all.

Replacing the whole firmware would cost you the config UI and OTA upload -
and OTA is what makes this recoverable. Patching keeps them.


## What the files are

| file | what it is |
|---|---|
| `cgiwsbridge.c` / `.h` | the whole feature: handshake, RFC 6455 framing, UART bridge |
| `esp-link.patch` | the small edits to esp-link's own files |

The patch touches `esp-link/main.c` (an include, the route
`{ "/bmweb", cgiWsBridge, NULL }`, and a `cgiWsBridgeInit()` call) and
`httpd/httpd.c` (an include plus two hooks). No Makefile edit: the build
globs `esp-link/*.c`.

The `httpdRecvCb` hook is the load-bearing one. esp-link's HTTP server
treats every received byte as either a header byte or POST data; there is
no way for a CGI to claim the raw stream. A WebSocket has to keep the
socket open and read frames forever, so the receive path needs an early-out:

```c
  if (cgiWsBridgeOwns(conn)) { cgiWsBridgeRecv(conn, data, len); return; }
```

Without it the handshake succeeds and then every frame is parsed as a
malformed HTTP request. The second hook, in `httpdDisconCb`, clears the
connection so the next client is not refused as "already in use".


## Four things esp-link does that fight a WebSocket

All four were found the hard way, on hardware. If you port this elsewhere,
these are the traps.

**1. `httpdStartResponse` hardcodes HTTP/1.0 and `Connection: close`.**
RFC 6455 needs HTTP/1.1, and a duplicate `Connection` header whose first
value is `close` makes browsers abandon the upgrade. The symptom is
maddening: a raw client (curl, a Node socket) completes the handshake and
Chrome refuses it. So the 101 is written by hand with `httpdSend` rather
than through the helper.

**2. `HTTPD_CGI_MORE` re-invokes the CGI after every send.** It reads as
"keep this connection open", and it does, but `httpdSentCb` also calls
`conn->cgi(conn)` again each time a send completes. A handler that returns
it unconditionally retransmits its handshake forever, and every real answer
arrives buried behind another copy of the response header. The tell is a
"frame" that decodes to `TP/1.1 101 Switching Protocols`, the same buffer
resent, minus the two bytes already consumed. Hence the re-entry guard at
the top of `cgiWsBridge`.

**3. `httpdRecvCb` and `httpdSentCb` open with the same four lines.**
Anchoring a patch on `if (conn == NULL) return; // aborted connection`
lands it in whichever comes first. Anchor on the function signature.

**4. The SDK closes idle connections after 10 seconds, and httpd never
disarms it.** This is the one that looks like a hardware fault. The socket
opens, telegrams flow, live values appear, and ten seconds after the last
one the connection dies. `serial/serbridge.c` calls
`espconn_regist_time(...)` for exactly this reason; `httpd/httpd.c` never
does, reasonably, because an HTTP request is short-lived. A WebSocket is
the one thing served over HTTP that is held open, so it inherits a timeout
nobody meant for it. Cure, right after the upgrade:

```c
  espconn_regist_time(connData->conn, 0, 1);   /* 0 = never time out */
```

A client-side keepalive is worth having as well, since an AP or router in
between can impose its own idle timeout. A browser cannot send ping
opcodes, so send a **zero-length binary frame**: the receive path here is
`if (plen) uart0_tx_buffer(...)`, so an empty payload writes nothing to the
K-line. Traffic on the socket, silence on the wire.


## Built images

`firmware/user1.bin` and `firmware/user2.bin` are **already built** from tag
`V3.0.14`, the version your adapter reports, with checksums in
`firmware/SHA256SUMS`. If you trust them, skip to Flashing.

They were cross-compiled in esp-link's own Docker image, so the toolchain
matches upstream exactly (xtensa-lx106-elf + SDK 2.0.0.p1). Reproduce with:

```sh
git clone https://github.com/jeelabs/esp-link && cd esp-link
git checkout V3.0.14                       # capital V; match your unit
cp /path/to/esp-link-ws/cgiwsbridge.* esp-link/
# then the three edits in esp-link.patch, then:
docker build --platform linux/amd64 -t esp-link-ws .
docker run --rm --platform linux/amd64 -v $PWD:/esp-link esp-link-ws \
  sh -c "make clean && make VERSION=bmweb-ws.3"
```

`VERSION=` is what the Upgrade Firmware page shows as "Current firmware",
so it is how you tell at a glance which image is on the dongle. Stock reads
`esp-link v3.0.14.0-g963ffbb-dirty`; the shipped build reads
**`esp-link bmweb-ws.3`**. Bump the number on each new image.

Two traps around it. The Makefile derives VERSION from
`git describe --tags --match 'v*'`, lowercase `v`, which never matches the
`V3.0.14` tag, so an unoverridden build reads `no.tag`. And VERSION is
baked in via `-DVERSION` at compile time, so **`make clean` is required**:
without it only changed files recompile, `main.c` keeps its cached string,
and the build prints the new version while the image still carries the old
one.

`--platform linux/amd64` matters on Apple Silicon: the image is an old
amd64 Ubuntu and will not build native arm64.

The Makefile globs `esp-link/*.c`, so dropping `cgiwsbridge.c` in that
directory is all the build system needs, no Makefile edit.

Sanity checks worth repeating if you rebuild:

```sh
# the code is actually linked in, not silently dropped
xtensa-lx106-elf-nm build/httpd.user1.out | grep -i wsbridge   # 5 symbols
```

`user1.bin` came to 333,332 of 503,808 available bytes, comfortable, but
watch that number if you add more.


## Flashing

**Back up first.** This is the difference between an experiment and a
gamble:

```sh
esptool.py --port /dev/cu.usbserial-XXXX read_flash 0 0x400000 thor-backup.bin
```

That needs the adapter on USB serial. If you only ever flash over WiFi you
cannot take this backup, decide whether you are willing to open the case
and wire up TX/RX/GND before you start, because that is the recovery path
if an image does not boot.

Then OTA through esp-link's own **Upgrade Firmware** page (upload
`user1.bin` / `user2.bin` as it asks). No soldering, and esp-link keeps two
images so a bad upload falls back.


## Using it from BMWeb

Nothing to configure. **Settings -> Adapter -> THOR**, and connecting tries
the adapter directly first (10s), falling back to the relay or the shell's
socket if it does not answer. The topbar reads "THOR direct" when the
adapter answered, "THOR via relay" when it did not, so the label always
names what actually carried the bytes.

The **THOR address** field is only for naming a different address, an
adapter put on your LAN with esp-link's Station mode, or a non-default port.
Setting it also disables the relay fallback: someone who names an adapter
means that adapter, and quietly using a relay instead would hide a wrong
address or unflashed firmware.

`ThorWifiBus` wraps job telegrams per EdiabasLib's `CreateAdapterTelegram`,
and the framing/checksum layer is transport-agnostic, it does not care
whether bytes arrive via relay, native socket, or this.

**The page must be served over `http://` or `file://`, or installed as an
offline PWA.** An `https://` page cannot open `ws://` (mixed content), and
there is no way to get a valid certificate for `192.168.4.1`. Since the
phone will be joined to the adapter's AP with no internet anyway, an
installed offline copy is the natural fit.


## Design notes, and what to be careful about

**Binary frames only.** `WS_OP_BIN`, never text. A text frame is UTF-8 and
mangles every byte >= 0x80. This is the single most important line in the
file and the reason the console endpoint is useless for telegrams.

**Client frames are always masked** (RFC 6455 requires it); server frames
must not be. Both directions are handled.

**Coalescing.** UART bytes arrive a few at a time. Sending a frame per
chunk would be brutal on an ESP8266's heap and on the radio, so RX is
buffered and flushed on a short idle timer (`WS_FLUSH_MS`) or when the
buffer fills. A BMW answer is tens of bytes, so it lands in one frame in
practice, but the browser side must still treat the stream as a stream and
not assume one frame == one telegram. BMWeb's `readFrame` already does,
because a serial port has the same property.

**One client at a time.** A second connection is refused rather than
silently interleaved into the same UART, two diagnostic sessions sharing
one K-line would corrupt both.

**Large frames are rejected.** Anything past `WS_MAX_FRAME` closes the
connection instead of being written to the UART. Nothing BMWeb sends comes
close; this is a guard against a malformed length field wandering off into
memory.

**Baud.** The UART speed is esp-link's own setting (your unit: 230400 8N1),
which is the ESP-to-adapter-MCU link, *not* the K-line speed. The K-line
baud rides inside each telegram's config header, which BMWeb builds. Do not
"fix" one to match the other.
