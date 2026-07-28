#!/usr/bin/env python3
"""Mine INPA's gauge dialect — caption, unit and real min/max per readout.

Some mined layouts carry rows with no unit and no range: KLIMA_5B's Analog
input screen has 53 rows, 33 of them bare. Those render as a 0..100 bar with no
unit, which is a guess wearing the costume of a measurement.

INPA declares them properly, in a dialect the earlier miners did not read:

    'Outside temperature ( Via K-Bus )'   row/col
    '[degrees C]'                         row/col
    STAT_TAUSSEN_WERT
    <double 45.0> <double 40.0> <double 45.0> <double 40.0>

caption, then the unit in brackets, then the result key, then four IEEE-754
doubles (min, max repeated). The doubles are little-endian, as everywhere else
in this format.

SIGN: the bytes hold 45.0 for a gauge whose real floor is -45 °C. There is no
negate opcode here (unlike the MS45 step keys), and nothing in the surrounding
bytecode distinguishes -45..40 from 45..40. So this tool does NOT invent a
sign: it reports what the file says and flags `descending` when min > max, which
is the signature of a range whose floor is negative. A consumer that already
knows the real range (the SGBD, or a hand-built layout) should keep its own.

Read-only: decodes an .IPO, never talks to a car.

    python3 tools/ipo_gauges.py               # corpus summary
    python3 tools/ipo_gauges.py KLIMA_5B      # one ECU
    python3 tools/ipo_gauges.py --write       # data/inpa-screens/_gauges.json
"""
import os
import re
import sys
import json
import glob
import struct

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_screens as L1                                        # noqa: E402

OUT = L1.OUT

_P = rb"\x03(.)\x00"
# caption + position, '[unit]' + position, result key
# named groups: the optional position pushes make positional indexes fragile
_GAUGE = re.compile(rb"\x06(?P<label>[\x20-\x7e\xa0-\xff]{3,44})\x0a"
                    + rb"(?:\x03.\x00){0,2}"
                    + rb"\x06\[(?P<unit>[^\]]{1,16})\]\x0a"
                    + rb"(?:\x03.\x00){0,2}"
                    + rb"\x06(?P<key>[A-Z][A-Z0-9_]{3,})\x0a", re.DOTALL)
# the little-endian doubles that follow: min, max (repeated for the second page)
_DOUBLE = re.compile(rb"\x05(.{8})", re.DOTALL)

# the job that drives a screen, so gauges can be attributed to one
_JOB = re.compile(rb"\x06(STATUS_[A-Z0-9_]+|MESSWERTE?[A-Z0-9_]*)\x0a")

# how far past a caption its doubles may sit
_TAIL = 96


def _doubles(data, pos):
    out = []
    for m in _DOUBLE.finditer(data, pos, pos + _TAIL):
        try:
            out.append(struct.unpack("<d", m.group(1))[0])
        except struct.error:                # truncated tail
            break
        if len(out) >= 2:
            break
    return out


def gauges(data):
    """Every captioned gauge in the file, keyed by result name."""
    out = {}
    for m in _GAUGE.finditer(data):
        key = m.group("key").decode("latin-1")
        label = m.group("label").decode("latin-1").strip()
        unit = m.group("unit").decode("latin-1").strip()
        if not L1._clean(label) or key in out:
            continue
        ds = _doubles(data, m.end())
        g = {"key": key, "label": label, "unit": unit, "source": "ipo"}
        if len(ds) >= 2:
            lo, hi = ds[0], ds[1]
            g["min"], g["max"] = lo, hi
            # min > max means the floor is negative and the sign is not in the
            # bytes; say so rather than silently emitting a backwards range
            if lo > hi:
                g["descending"] = True
        out[key] = g
    return out


def extract(path):
    with open(path, "rb") as f:
        data = f.read()
    return {"ecu": os.path.basename(path)[:-4], "gauges": list(gauges(data).values())}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

    if args:
        rec = extract(os.path.join(L1.SGDAT, args[0] + ".IPO"))
        print(f"{rec['ecu']}: {len(rec['gauges'])} gauges\n")
        for g in rec["gauges"]:
            rng = (f"{g['min']:g}..{g['max']:g}"
                   + ("  (descending — negative floor)" if g.get("descending") else "")
                   if "min" in g else "")
            print(f"   {g['label'][:38]:40} {g['unit']:12} {g['key']:28} {rng}")
        return 0

    results, tot, desc = {}, 0, 0
    for path in sorted(glob.glob(os.path.join(L1.SGDAT, "*.IPO"))):
        rec = extract(path)
        if not rec["gauges"]:
            continue
        results[rec["ecu"]] = rec["gauges"]
        tot += len(rec["gauges"])
        desc += sum(1 for g in rec["gauges"] if g.get("descending"))

    print(f"{len(results)} ECUs, {tot} gauges with a unit "
          f"({desc} with a descending range)")

    if write:
        os.makedirs(OUT, exist_ok=True)
        dest = os.path.join(OUT, "_gauges.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False)
        print(f"wrote {len(results)} ECUs -> {os.path.relpath(dest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
