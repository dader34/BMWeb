#!/usr/bin/env python3
"""Emit the MS45.1 Special screens — INPA's Speicher and EWS/CAS root keys.

Two real INPA screens live here, both decoded from MS450.IPO.

Speicher (root F7, "MS45 Read memory") is a hex dump. INPA's own F-key captions
are already English in the bytecode:

    < F1 >  Memory lin. reading      < F5 >  Address+10h
    < F2 >  SRAM lin. reading        < F6 >  Address-10h
    < F3 >  User info field          < F7 >  Address+100h
    < F4 >  ext. Read memory         < F8 >  Address-100h

It reads through SPEICHER_LESEN_ASCII, whose argument is "<REGION>;0x<addr>;<n>"
-- the .IPO shows "LAR;0x" for linear and "ROMX;0x40000;8" for the external
EEPROM, so the region tokens and the address/count shape are INPA's, not
invented.

EWS/CAS start-value alignment (Shift+F6 / Shift+F7) is a SEQUENCE, not a menu:
INPA runs ordered steps and waits between them. Both variants decode to the
same shape --

    CAS (E6x/E65):  DME_STARTWERT_ABGLEICH -> EWS_STARTWERT -> wait 2s -> EWS_EMPFANG
    EWS3:           WECHSELCODE_SYNC_DME   -> EWS_STARTWERT -> wait 2s -> EWS_EMPFANG

This resets the DME and EWS/CAS to a common start value. If it does not
complete, the car may not start -- the renderer confirms before running it.

    python3 tools/ms45_special.py            # print
    python3 tools/ms45_special.py --write    # merge into MS450.json
"""
import os
import re
import sys
import json

IPO = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "vendor", "EC-APPS", "INPA", "SGDAT", "MS450.IPO")
LAYOUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "data", "inpa-layouts", "enriched", "MS450.json")

MEM_JOB = "SPEICHER_LESEN_ASCII"

# INPA's four memory regions, in its own F1..F4 order. The token goes in front
# of the ";0x<addr>;<n>" argument. The bounds are INPA's own, printed on the
# screen beside each region ("Address 000000-06FFFF", "Number of bytes 1-254"),
# so a read cannot be aimed outside the area INPA itself allows.
REGIONS = [
    {"token": "LAR", "fkey": "Memory lin. reading", "label": "Linear memory",
     "key": "Linear", "start": "0x000000", "low": "0x000000",
     "high": "0x06FFFF", "count": 16},
    {"token": "SRAM", "fkey": "SRAM lin. reading", "label": "SRAM",
     "key": "SRAM", "start": "0x3F9800", "low": "0x3F9800",
     "high": "0x3FFFFF", "count": 16},
    {"token": "UIF", "fkey": "User info field", "label": "User info field",
     "key": "UIF", "start": "0x000000", "low": "0x000000",
     "high": "0x00000D", "count": 16,
     "note": "14 AIF positions with 64 byte, area 0-13"},
    {"token": "ROMX", "fkey": "ext. Read memory", "label": "External flash",
     "key": "EXT-FLASH", "start": "0x040000", "low": "0x040000",
     "high": "0x06FFFF", "count": 16},
]

# INPA's own limit, printed under every region
MAX_BYTES = 254

# INPA's address-stepping keys (F5..F8), as signed byte offsets. `label` is
# INPA's caption, verified against the bytecode; `key` is what the softkey bar
# shows -- four keys reading "Address±N" side by side all ellipsise to "Addr…",
# so the bar drops the repeated word and keeps the part that differs.
STEPS = [{"label": "Address+10h", "key": "+10h", "delta": 0x10},
         {"label": "Address-10h", "key": "−10h", "delta": -0x10},
         {"label": "Address+100h", "key": "+100h", "delta": 0x100},
         {"label": "Address-100h", "key": "−100h", "delta": -0x100}]

# the immobilizer sync, one entry per INPA variant. `wait` is the pause INPA
# takes between the request and reading the answer ("Wartezeit von 2 s").
SYNC = [
    {
        "key": "cas",
        "title": "CAS start-value alignment",
        "caption": "E6x/E65 — DME and CAS to a common start value",
        "steps": [
            {"job": "DME_STARTWERT_ABGLEICH", "label": "Request alignment from the DME"},
            {"job": "EWS_STARTWERT", "label": "Reset DME and CAS to start value"},
            {"job": "EWS_EMPFANG", "label": "Read reception status", "wait": 2.0},
        ],
    },
    {
        "key": "ews3",
        "title": "EWS start-value alignment",
        "caption": "EWS3 — DME and EWS to a common start value",
        "steps": [
            {"job": "WECHSELCODE_SYNC_DME", "label": "Sync the DME rolling code"},
            {"job": "EWS_STARTWERT", "label": "Reset DME and EWS to start value"},
            {"job": "EWS_EMPFANG", "label": "Read reception status", "wait": 2.0},
        ],
    },
]

# the caption INPA prints over the memory screen
_TITLE = re.compile(rb"\x06(MS45 Read memory)\x0a")
# "< F1 >  Memory lin. reading" — INPA's own softkey captions, already English
_FKEY = re.compile(rb"\x06<\s*F(\d+)\s*>\s+([\x20-\x7e]{3,32})\x0a")


def memory_screen():
    """The Speicher screen, with INPA's title and F-key captions verified."""
    with open(IPO, "rb") as f:
        data = f.read()
    title_m = _TITLE.search(data)
    # pull the captions INPA actually ships so the labels above are not guesses
    captions = {}
    for m in _FKEY.finditer(data):
        cap = m.group(2).decode("latin-1").strip()
        if cap.startswith(("Memory", "SRAM", "User info", "ext. Read", "Address")):
            captions.setdefault(cap, int(m.group(1)))
    regions, steps = [], []
    for r in REGIONS:
        r = dict(r)
        r["verified"] = r["fkey"] in captions
        regions.append(r)
    for s in STEPS:
        s = dict(s)
        s["verified"] = s["label"] in captions
        steps.append(s)
    return {"title": title_m.group(1).decode("latin-1") if title_m else "Read memory",
            "caption": "hex dump — pick a region, then step the address",
            "job": MEM_JOB, "maxBytes": MAX_BYTES,
            "regions": regions, "steps": steps}


def build():
    return {"title": "Special", "subtitle": "memory dump and immobilizer sync",
            "memory": memory_screen(), "sync": SYNC}


def main():
    spec = build()
    if "--write" not in sys.argv:
        mem = spec["memory"]
        print(f"{spec['title']}\n\n  {mem['title']} (via {mem['job']})")
        for r in mem["regions"]:
            ok = "ok " if r["verified"] else "?? "
            print(f"     {ok}{r['token']:6} {r['fkey']:22} "
                  f"{r['low']}-{r['high']}  start {r['start']}")
        for s in mem["steps"]:
            ok = "ok " if s["verified"] else "?? "
            print(f"     {ok}{'':6} {s['label']:22} {s['delta']:+#7x}")
        for s in spec["sync"]:
            print(f"\n  {s['title']} ({s['caption']})")
            for i, st in enumerate(s["steps"], 1):
                wait = f"  [wait {st['wait']}s first]" if st.get("wait") else ""
                print(f"     {i}. {st['job']:26} {st['label']}{wait}")
        return 0

    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    lay["special"] = spec
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(lay, f, ensure_ascii=False, indent=1)
    print(f"special: memory + {len(spec['sync'])} sync sequences "
          f"-> {os.path.relpath(LAYOUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
