#!/usr/bin/env python3
"""Harvest every SGBD lookup table — locations, argument options, status codes.

An SGBD carries its own reference data in tables, and the jobs point at them:
STEUERN_DIGITAL's ORT argument is documented "table BITS NAME TEXT", meaning
the legal values are BITS.NAME and the labels are BITS.TEXT. That convention is
the SGBD's, not one ECU's, so harvesting it needs no per-ECU code.

Three kinds are worth keeping, and the tool records which is which rather than
dumping everything into one bucket:

  location   ORT -> ORTTEXT. Where a fault or info entry happened, in the
             ECU's own words ("Alarmspeicher: Tuerkontakt Fahrertuer").
             FORTTEXTE is fault locations, IORTTEXTE info locations.
  options    the legal values of a job argument, referenced by an ARGCOMMENT
  reference  everything else the SGBD declares (status codes, suppliers)

Read-only: this reads schema, never runs a job against a car. It needs the app
running so the EDIABAS engine can answer _TABLES/_TABLE offline.

    python3 tools/sgbd_tables.py                 # summary
    python3 tools/sgbd_tables.py zke5            # one SGBD
    python3 tools/sgbd_tables.py --write         # data/inpa-screens/_tables.json
"""
import os
import re
import sys
import json
import glob
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ECU_DIR = os.path.join(HERE, "..", "..", "vendor", "EDIABAS", "Ecu")
OUT = os.path.join(HERE, "..", "..", "data", "inpa-screens")

API = os.environ.get("BMACW_API")

# "table BITS NAME TEXT" in a job's argument comment: which table, which column
# holds the value to send, which holds the label
TABLE_REF = re.compile(r"\btable\s+(\w+)\s+(\w+)\s+(\w+)", re.I)

# a location table maps a code to where something happened
LOCATION = re.compile(r"ORTTEXTE?$|^ORTE?$", re.I)


def _base():
    if API:
        return API
    import subprocess
    try:
        out = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a",
                              "-c", "InpaMac.A"], capture_output=True,
                             text=True, timeout=15).stdout
        m = re.search(r"127\.0\.0\.1:(\d+)", out)
        return f"http://127.0.0.1:{m.group(1)}" if m else None
    except Exception:                       # noqa: BLE001
        return None


def _get(base, path, timeout=60):
    with urllib.request.urlopen(base + path, timeout=timeout) as r:
        return json.load(r)


def referenced_tables(base, sgbd, jobs):
    """{TABLE: {value column, label column}} for tables a job argument names."""
    refs = {}
    for job in jobs:
        try:
            d = _get(base, f"/api/ecu/{sgbd}/arguments/{job}")
        except Exception:                   # noqa: BLE001
            continue
        for spec in d.get("arguments", []):
            for key, val in spec.items():
                if not key.startswith("ARGCOMMENT"):
                    continue
                m = TABLE_REF.search(str(val))
                if m:
                    refs.setdefault(m.group(1).upper(),
                                    {"value": m.group(2), "label": m.group(3),
                                     "jobs": []})["jobs"].append(job)
    return refs


def kind_of(name, refs):
    if LOCATION.search(name):
        return "location"
    if name.upper() in refs:
        return "options"
    return "reference"


def harvest(base, sgbd):
    """Every table this SGBD declares, with its rows and what it is for."""
    try:
        names = _get(base, f"/api/ecu/{sgbd}/tables")
        jobs = [j for j in _get(base, f"/api/ecu/{sgbd}/jobs")
                if not j.startswith("_")]
    except Exception:                       # noqa: BLE001 - unloadable SGBD
        return None
    if not names:
        return None

    refs = referenced_tables(base, sgbd, jobs)
    tables = {}
    for name in names:
        try:
            rows = _get(base, f"/api/ecu/{sgbd}/table/{name}")
        except Exception:                   # noqa: BLE001 - unreadable table
            continue
        if not rows:
            continue
        entry = {"kind": kind_of(name, refs), "columns": list(rows[0]),
                 "rows": rows}
        ref = refs.get(name.upper())
        if ref:
            entry["value_column"] = ref["value"]
            entry["label_column"] = ref["label"]
            entry["used_by"] = sorted(set(ref["jobs"]))
        tables[name] = entry
    return {"sgbd": sgbd, "tables": tables}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

    base = _base()
    if not base:
        print("the app is not running — start it so the EDIABAS engine can\n"
              "answer _TABLES/_TABLE offline, or set BMACW_API.", file=sys.stderr)
        return 2

    if args:
        rec = harvest(base, args[0])
        if rec is None:
            print(f"no tables for {args[0]}", file=sys.stderr)
            return 1
        print(json.dumps(rec, ensure_ascii=False, indent=1))
        return 0

    # CASE-INSENSITIVE ON PURPOSE (same trap as ipo_ir.py --write): the
    # vendor tree mixes *.prg and *.PRG, and globbing one spelling silently
    # dropped 187 of the 1,006 SGBDs. Dedupe by lowered stem.
    names = sorted({os.path.basename(f)[:-4].lower()
                    for f in glob.glob(os.path.join(ECU_DIR, "*"))
                    if f.lower().endswith(".prg")})
    recs, t0 = {}, time.time()
    kinds = {"location": 0, "options": 0, "reference": 0}
    rows = 0
    for i, sgbd in enumerate(names, 1):
        rec = harvest(base, sgbd)
        if not rec or not rec["tables"]:
            continue
        recs[sgbd] = rec
        for t in rec["tables"].values():
            kinds[t["kind"]] += 1
            rows += len(t["rows"])
        if i % 100 == 0:
            print(f"   {i}/{len(names)}…", file=sys.stderr)

    print(f"{len(names)} SGBDs, {len(recs)} with tables, "
          f"{sum(len(r['tables']) for r in recs.values())} tables, "
          f"{rows} rows in {time.time() - t0:.0f}s\n")
    for k, v in kinds.items():
        print(f"   {k:10} {v}")

    if write:
        os.makedirs(OUT, exist_ok=True)
        dest = os.path.join(OUT, "_tables.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(recs, f, ensure_ascii=False)
        print(f"\nwrote {len(recs)} SGBDs -> {os.path.relpath(dest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
