#!/usr/bin/env python3
"""Emit the MS45.1 Identity screen — INPA's "ID-data" card.

INPA draws this as a colon-aligned list, one row per field, and its captions are
in the .IPO right beside the result they label:

    ID_BMW_NR      "BMWTeilenummer          :  "
    ID_HW_NR       "Hardwareversion         :  "
    ID_DATUM       "Herstelldatum [TT.MM.JJ]:  "

So the labels are INPA's own rather than invented, and the field ORDER is the
order INPA prints them, which is not the order the SGBD returns them in.

Beyond IDENT, the screen pulls the serial number, hardware/data references and
the test stamp — each its own job, all read-only.

    python3 tools/ms45_identity.py            # print
    python3 tools/ms45_identity.py --write    # merge into MS450.json
"""
import os
import re
import sys
import json
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

API = os.environ.get("BMACW_API", "http://127.0.0.1:8777")
SGBD = "ms450ds0"
IPO = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "vendor", "EC-APPS", "INPA", "SGDAT", "MS450.IPO")
LAYOUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "data", "inpa-layouts", "enriched", "MS450.json")

# INPA's captions are German; these render them in English while keeping the
# same field order and meaning
LABELS = {
    "ID_BMW_NR": "BMW part number",
    "ID_HW_NR": "Hardware version",
    "ID_COD_INDEX": "Coding index",
    "ID_DIAG_INDEX": "Diagnosis index",
    "ID_VAR_INDEX": "Variant index",
    "ID_DATUM": "Manufacture date",
    "ID_LIEF_NR": "Supplier",
    "ID_LIEF_TEXT": "Supplier name",
    "ID_SW_NR_MCV": "Software (MCV)",
    "ID_SW_NR_FSV": "Software (FSV)",
    "ID_SW_NR_OSV": "Software (OSV)",
    "ID_SW_NR_RES": "Software (reserved)",
    "ID_SG_ADR": "ECU address",
    "ID_EWS_SS": "EWS interface",
    "SERIENNUMMER": "Serial number",
    "HARDWARE_REFERENZ": "Hardware reference",
    "DATEN_REFERENZ": "Data reference",
    "PRUEFCODE": "Test code",
}

# the jobs whose results make up the card, in the order INPA reads them
JOBS = ["IDENT", "SERIENNUMMER_LESEN", "HARDWARE_REFERENZ_LESEN",
        "DATEN_REFERENZ_LESEN", "PRUEFCODE_LESEN"]

# INPA prints the ID_ fields in this order, which differs from the SGBD's
_IPO_CAPTION = re.compile(rb"\x06(ID_[A-Z0-9_]+)\x0a\x06([\x20-\x7e\xa0-\xff]{4,40}:\s*)\x0a")


def api(path):
    with urllib.request.urlopen(f"{API}{path}", timeout=60) as r:
        return json.load(r)


def inpa_order():
    """The ID_ fields in the order INPA's own screen prints them."""
    with open(IPO, "rb") as f:
        data = f.read()
    seen, out = set(), []
    for m in _IPO_CAPTION.finditer(data):
        key = m.group(1).decode("latin-1")
        if key not in seen:
            seen.add(key)
            out.append((key, m.group(2).decode("latin-1").strip(" :")))
    return out


def build():
    order = inpa_order()
    ordered_keys = [k for k, _ in order]

    fields, seen = [], set()
    for job in JOBS:
        try:
            rows = api(f"/api/ecu/{SGBD}/results/{job}")
        except Exception:                       # noqa: BLE001 - job not present
            continue
        keys = []
        for line in rows:
            key = line.partition(" : ")[0].strip()
            if key and not key.startswith("_") and key != "JOB_STATUS":
                keys.append(key)
        # follow INPA's field order for the IDENT card, source order elsewhere
        if job == "IDENT":
            keys.sort(key=lambda k: ordered_keys.index(k)
                      if k in ordered_keys else len(ordered_keys))
        for key in keys:
            if key in seen or key not in LABELS:
                continue
            seen.add(key)
            fields.append({"key": key, "label": LABELS[key], "job": job})
    return {"title": "ID-data", "subtitle": "ECU identity · read-only",
            "jobs": JOBS, "fields": fields}


def main():
    ident = build()
    if "--write" not in sys.argv:
        print(f"{ident['title']} — {len(ident['fields'])} fields\n")
        for f in ident["fields"]:
            print(f"   {f['label']:22} {f['key']:24} ({f['job']})")
        return 0

    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    lay["identity"] = ident
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(lay, f, ensure_ascii=False, indent=1)
    print(f"identity: {len(ident['fields'])} fields -> {os.path.relpath(LAYOUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
