#!/usr/bin/env python3
"""Emit the MS45.1 AIF screen — INPA's "user information field" (Ausbau-Info-Feld).

Every time the DME is flashed, the programming tester writes a record: who did
it, when, at what mileage, with which dataset. The AIF is that log, and INPA's
F-keys page through it — "aktuell" is the most recent, "AIF 1".."AIF 14" the
history behind it.

The screen is in the .IPO as caption/':'/result triples, one field per odd row:

    'Vehicle identification nr.' row 1  ... ':' ... AIF_FG_NR
    'Assembly no.'              row 3  ... ':' ... AIF_ZB_NR
    'Programming date'          row 5  ... ':' ... AIF_DATUM

Unlike the Ident screen, INPA's own AIF captions are already English, so the
labels below are lifted verbatim rather than translated — and the field ORDER
is INPA's print order, taken from the row number it draws each one at.

AIF_LESEN returns one result set per stored record, so the records are pages of
one job's output rather than separate reads.

    python3 tools/ms45_aif.py            # print
    python3 tools/ms45_aif.py --write    # merge into MS450.json
"""
import os
import re
import sys
import json

IPO = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "vendor", "EC-APPS", "INPA", "SGDAT", "MS450.IPO")
LAYOUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "data", "inpa-layouts", "enriched", "MS450.json")

JOB = "AIF_LESEN"

# how many history records INPA's own menu exposes ("aktuell" + AIF 1..14)
RECORDS = 15

# push-int operand: 03 <n> 00. `.` cannot match \x0a without DOTALL — value 10
# encodes as a newline byte, and a bare dot would silently drop those rows.
_PUSH = rb"\x03(.)\x00"

# a field is drawn as three strings sharing a row: the caption, the ':' and the
# result key. Each string is followed by (row, col, attr, attr).
_FIELD = re.compile(
    rb"\x06([\x20-\x7e\xa0-\xff]{3,50})\x0a" + _PUSH * 4
    + rb"\x06:\x0a" + _PUSH * 4
    + rb"\x06(AIF_[A-Z0-9_]+)\x0a", re.DOTALL)


def fields():
    """The AIF fields in the order INPA prints them (by screen row)."""
    with open(IPO, "rb") as f:
        data = f.read()
    seen, out = set(), []
    for m in _FIELD.finditer(data):
        key = m.group(10).decode("latin-1")
        if key in seen:
            continue                       # the screen is emitted twice
        seen.add(key)
        out.append({"key": key,
                    "label": m.group(1).decode("latin-1").strip(),
                    "row": m.group(2)[0]})
    out.sort(key=lambda f: f["row"])
    return [{"key": f["key"], "label": f["label"]} for f in out]


def build():
    return {"title": "User information", "subtitle": "AIF · programming history",
            "job": JOB, "records": RECORDS, "fields": fields()}


def main():
    aif = build()
    if "--write" not in sys.argv:
        print(f"{aif['title']} — {len(aif['fields'])} fields, "
              f"{aif['records']} records via {aif['job']}\n")
        for f in aif["fields"]:
            print(f"   {f['label']:30} {f['key']}")
        return 0

    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    lay["aif"] = aif
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(lay, f, ensure_ascii=False, indent=1)
    print(f"aif: {len(aif['fields'])} fields -> {os.path.relpath(LAYOUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
