#!/usr/bin/env python3
"""Emit the MS45.1 Adaption screen — INPA's selective adaptation clearing.

The DME learns as it runs: idle position, knock retard, lambda trims, VANOS
end-stops, throttle stops. INPA's root F8 "Adaption" menu (m_ada_loe) clears
those learned values one group at a time, so a repair does not leave the ECU
trimming around a fault that is no longer there.

Each entry is in the .IPO as a label, its F-key slot and the exact bitmask
argument the job takes:

    'idle-speed adaption'  idx 2  ADAP_SELEKTIV_LOESCHEN  '2;0;0'
    'knock adaption'       idx 3  ADAP_SELEKTIV_LOESCHEN  '4;0;0'

The mask is three semicolon-separated bytes, one bit per adaptation. INPA ships
24 slots but marks 12 of them "unused with the MS45" -- those are other DMEs'
bits and are dropped here, leaving exactly the 12 entries INPA's own menu shows
(LL, Klopf, Lambda, Vanos, DK, Saugrohr, Oktan, Varianten, Alle, Segment,
Sek Luft, Benzin im Oel).

Every entry is a WRITE: it erases learned data and cannot be undone from here,
so the renderer confirms each one.

    python3 tools/ms45_adaption.py            # print
    python3 tools/ms45_adaption.py --write    # merge into MS450.json
"""
import os
import re
import sys
import json

IPO = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "vendor", "EC-APPS", "INPA", "SGDAT", "MS450.IPO")
LAYOUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "data", "inpa-layouts", "enriched", "MS450.json")

JOB = "ADAP_SELEKTIV_LOESCHEN"

# INPA's own F-key captions (m_ada_loe), keyed by the decoded English label so
# the screen reads like INPA's while still saying what each one does
FKEY = {
    "idle-speed adaption": ("LL", "Idle speed"),
    "knock adaption": ("Klopf", "Knock control"),
    "O2-sensors adaption": ("Lambda", "Oxygen sensors"),
    "vanos adaption": ("Vanos", "VANOS"),
    "throttle-valve adaption": ("DK", "Throttle valve"),
    "air-intake modell adaption": ("Saugrohr", "Intake manifold"),
    "octane-value adaption": ("Oktan", "Octane value"),
    "learned variant": ("Varianten", "Learned variant"),
    "All adaption values": ("Alle", "All adaptations"),
    "segment-time, misfire adaption": ("Segment", "Segment time / misfire"),
    "secondary air system adaption": ("Sek Luft", "Secondary air"),
    "Fuel into oil": ("Benzin im Öl", "Fuel in oil"),
}

# a slot INPA ships but this ECU does not implement
_UNUSED = "unused with the ms45"

# <label> \x03<idx>\x00 <JOB> <mask>. `.` needs DOTALL: slot 10 encodes as \x0a
_ENTRY = re.compile(
    rb"\x06([\x20-\x7e\xa0-\xff]{3,44})\x0a"
    rb"\x03(.)\x00"
    rb"\x06" + JOB.encode() + rb"\x0a"
    rb"\x06([0-9;]{3,16})\x0a", re.DOTALL)


def entries():
    """The adaptations this DME actually implements, in INPA's slot order."""
    with open(IPO, "rb") as f:
        data = f.read()
    out, seen = [], set()
    for m in _ENTRY.finditer(data):
        label = m.group(1).decode("latin-1").strip()
        mask = m.group(3).decode("latin-1")
        if label.lower() == _UNUSED or mask in seen:
            continue                       # other DMEs' bits, or a repeat
        seen.add(mask)
        fkey, english = FKEY.get(label, (label, label))
        out.append({"slot": m.group(2)[0], "mask": mask,
                    "fkey": fkey, "label": english, "ipo": label})
    out.sort(key=lambda e: e["slot"])
    return out


def build():
    return {"title": "Adaption", "subtitle": "clear learned values · permanent",
            "job": JOB, "entries": entries()}


def main():
    ada = build()
    if "--write" not in sys.argv:
        print(f"{ada['title']} — {len(ada['entries'])} adaptations via {ada['job']}\n")
        for e in ada["entries"]:
            print(f"   slot {e['slot']:<3} {e['mask']:<10} {e['fkey']:<12} {e['label']}")
        return 0

    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    lay["adaption"] = ada
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(lay, f, ensure_ascii=False, indent=1)
    print(f"adaption: {len(ada['entries'])} entries -> {os.path.relpath(LAYOUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
