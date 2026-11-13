#!/usr/bin/env python3
"""Extract what ISTA knows about each fault code: its weighting and whether
it is relevant.

Two columns of XEP_FAULTCODES decide what the tool does with a stored fault,
and neither is on the wire -- the car sends a fault location, the database
says what that location is worth:

  RELEVANCE   0 marks a fault the tool treats as not relevant ("bogus"): it
              is hidden from the fault memory by default and never reaches
              the test plan. A code the table does not list for the ECU
              variant has NO verdict, which the tool shows but also keeps
              out of the plan.
  WEIGHTING   25 / 50 / 75 / 100: how strongly the fault points at the
              components it is linked to (low, middle, strong, sure
              suspicion). The test plan's Priority column is computed from
              these counts per component.

    python3 tools/ista/faultcodes_extract.py
    python3 tools/ista/faultcodes_extract.py --db /path/DiagDocDb.sqlite --out data/ista/faultcodes

Writes <variant>.json per ECU variant -- {"<code, decimal>": [weighting,
relevance]} -- and index.json naming the variants. The variant name is the
SGBD the app already keys a module by (ms450ds0), lower-cased. The code is
left in DECIMAL, as the database stores it and as the fault location (F_ORT)
arrives; the hex a screen shows is a rendering of the same number.

Only DATATYPE 'F' rows are taken: that is the type the tool asks for when it
resolves a fault read from a control unit. Where a variant lists one code
more than once (validity periods), the newest row wins.

The output is BMW-derived data: data/ista/ is gitignored and hosted like the
rest of the ISTA extracts.
"""
import argparse
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
BMWFILES = os.environ.get("BMWFILES", os.path.expanduser("~/Development/code/BMWFILES"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--db", default=os.path.join(
        BMWFILES, "ista", "databases", "DiagDocDb.decrypted.sqlite"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "ista", "faultcodes"))
    ns = ap.parse_args()
    if not os.path.exists(ns.db):
        raise SystemExit(f"no database at {ns.db} (see $BMWFILES/ista/README.md)")
    db = sqlite3.connect(f"file:{ns.db}?mode=ro", uri=True)
    rows = db.execute(
        "select lower(v.NAME), f.CODE, f.WEIGHTING, f.RELEVANCE "
        "from XEP_FAULTCODES f join XEP_ECUVARIANTS v on v.ID = f.ECUVARIANTID "
        "where f.DATATYPE = 'F' and f.CODE is not null and v.NAME is not null "
        "order by v.NAME, f.CODE, f.ID")
    by = {}
    for variant, code, weight, rel in rows:
        # ordered by ID within a code, so a later row replaces an earlier one
        by.setdefault(variant, {})[str(code)] = [
            int(weight) if weight is not None else None,
            0 if rel == 0 else 1,
        ]
    os.makedirs(ns.out, exist_ok=True)
    for variant, codes in by.items():
        with open(os.path.join(ns.out, f"{variant}.json"), "w", encoding="utf-8") as f:
            json.dump(codes, f, separators=(",", ":"))
    with open(os.path.join(ns.out, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "variants": sorted(by)}, f, separators=(",", ":"))
    total = sum(len(c) for c in by.values())
    hidden = sum(1 for c in by.values() for w, r in c.values() if r == 0)
    print(f"{len(by)} variants, {total} fault codes ({hidden} not relevant) -> {ns.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
