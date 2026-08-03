# Prebuilt firmware, `bmweb-ws.3`

Flash these to a THOR (or any esp-link ESP8266) to add a binary WebSocket at
`ws://<adapter-ip>/bmweb`. BMWeb then talks to the car from any browser with
nothing else running, **including iPhone and Android**, which is the point:
WebSockets are the only browser transport with no platform gaps (Web Serial
is desktop-Chrome only; Web Bluetooth does not exist on iOS).

Everything esp-link already does keeps working: config pages, WiFi setup,
OTA upload, the telnet bridge on port 23.

| | |
|---|---|
| Base | esp-link `V3.0.14` (the version THOR units ship) |
| Version string | `esp-link bmweb-ws.3`, shown on the Upgrade Firmware page |
| Size | 333,332 of 503,808 bytes |
| Built with | esp-link's own Docker image (xtensa-lx106-elf + SDK 2.0.0.p1) |

Checksums are in `SHA256SUMS`. Verify with `shasum -a 256 -c SHA256SUMS`.

**Confirmed working** on a THOR (adapter type 0x10, firmware v1.15): 101
handshake, binary frames, and a valid ident round-trip
(`82 f1 f1 fd fd 5e` out, `85 f1 f1 fd 00 10 01 0f 84` back).


## Before you flash

**Take a backup, over USB serial, of the firmware you have now.** This is
the difference between an experiment and a gamble:

```sh
esptool.py --port /dev/cu.usbserial-XXXX read_flash 0 0x400000 thor-backup.bin
```

It needs physical access to the ESP's TX/RX/GND. If your dongle is sealed
and you cannot get at them, understand what you are accepting: esp-link's
two-slot fallback is then your only safety net, and a firmware that crashes
before its WiFi comes up would leave no way back in.

Two things this does **not** touch, worth knowing:

- **The adapter MCU.** A THOR has two processors. The ESP8266 does WiFi;
  a separate MCU speaks the actual BMW protocol (the K-line, the ident
  telegrams, baud switching). That firmware is proprietary, on a different
  chip, and nothing here goes near it. The worst case is a non-booting ESP
  in front of a perfectly intact adapter.
- **Your ESP config.** Baud, WiFi and pins live in flash outside the image.
  They normally survive, but check the Home page afterwards anyway: a wrong
  serial baud means the ident never answers even over a flawless WebSocket
  (a THOR wants **230400 8N1**).


## Flashing

Use esp-link's own **Upgrade Firmware** page, OTA, no soldering.

It keeps two slots and always writes the one it is NOT running from, then
switches. That is the fallback: a bad upload leaves the previous image
intact. **The page names the file it wants** ("Make sure you upload the file
called: user2.bin"), upload that one. The two files are built for different
flash offsets and are not interchangeable; upload the wrong one and it is
rejected rather than half-written.

After it reboots, the page should read `Current firmware: esp-link
bmweb-ws.3`.


## Checking it works

```sh
node tools/thor_ws_probe.js
```

Three steps, each isolating one failure: is the route there, does the
upgrade complete, do bytes reach the adapter MCU. A pass ends with
`VALID IDENT` and the adapter's type and firmware version. The ident is
addressed F1 -> F1 (tester to tester), so the adapter answers it itself -
no car, no ignition, safe to run anywhere.

Then in BMWeb: **Settings -> Adapter -> THOR**. Connecting tries the adapter
directly first and falls back to the relay, so there is nothing else to set;
the topbar reads "THOR direct" when it is live. Use the **THOR address**
field only to name a different address (an adapter on your LAN, a non-default
port).

The page must be served over `http://` or `file://`, an `https://` page
cannot open `ws://` (mixed content), and a bare IP cannot have a
certificate. An installed offline copy is the natural fit, since the phone
will be on the adapter's AP with no internet anyway.


## Licensing

esp-link is Thorsten von Eicken's, BSD 2-clause, see
`../LICENSE.esp-link.txt`, reproduced here as that license requires for
binary redistribution. The WebSocket bridge added on top
(`../cgiwsbridge.c`) is part of this project. Full source and build
instructions are in `../README.md`; nothing here is a binary you cannot
rebuild yourself.
