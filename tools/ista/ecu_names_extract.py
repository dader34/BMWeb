#!/usr/bin/env python3
"""Extract the short names ISTA writes on a control unit's tree button.

The button's text is the unit's TITLE_ECUTREE, which ISTA fills in
VehicleDataConverter.FillEcuNames:

  1. the variants the unit could be: the one it identified as (its SGBD),
     else every variant of its group(s) whose validity rule holds for the
     car
  2. each variant's clique (XEP_REFECUCLIQUES -> XEP_ECUCLIQUES) names a
     representative (XEP_ECUREPS.STEUERGERAETEKUERZEL): "GM", "RAD", "MRS"
  3. when the variants agree on ONE representative, that is the title;
     otherwise it is "<series name>_0x<address>" (ECU.FillEcuTitleTree)

This ships the two lookups step 1 needs, per chassis: every variant's
representative, and for every group the tree names, the representatives of
the variants valid for that chassis. Validity is decided with the decoder
the other extracts use (validity_rules.py): a rule that cannot be decided
for the chassis alone keeps its variant, as the tool would for a car it
holds for.

    python3 tools/ista/ecu_names_extract.py              # every mapped chassis
    python3 tools/ista/ecu_names_extract.py --chassis E46

Writes data/ista/ecu-names/<CHASSIS>.json:
    {"variants": {"<sgbd>": "<short>"}, "groups": {"<group>": ["<short>", ...]}}
The output is BMW-derived data: data/ista/ is gitignored and hosted like
the rest of the ISTA extracts.
"""
import argparse
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
sys.path.insert(0, HERE)

from ecu_tree_extract import CHASSIS_TREE  # noqa: E402
from validity_rules import (  # noqa: E402
    chassis_char_ids,
    decode_rule,
    read_char_names,
    read_typekeys,
    rule_eval,
)

BMWFILES = os.environ.get("BMWFILES", os.path.expanduser("~/Development/code/BMWFILES"))


def names_for(con, ids, groups):
    """The two lookups for one chassis, over the groups its tree names."""
    rules = dict(con.execute("SELECT ID, RULE FROM XEP_RULES"))

    def holds(vid):
        tree, unsure = decode_rule(rules.get(vid))
        if unsure or tree is None:
            return True
        return rule_eval(tree, ids) is not False

    variants = {}
    by_group = {}
    rows = con.execute(
        "SELECT lower(g.NAME), v.ID, lower(v.NAME), r.STEUERGERAETEKUERZEL "
        "FROM XEP_ECUGROUPS g "
        "JOIN XEP_ECUVARIANTS v ON v.ECUGROUPID = g.ID "
        "LEFT JOIN XEP_REFECUCLIQUES rc ON rc.ID = v.ID "
        "LEFT JOIN XEP_ECUCLIQUES c ON c.ID = rc.ECUCLIQUEID "
        "LEFT JOIN XEP_ECUREPS r ON r.ID = c.ECUREPID "
        "ORDER BY g.NAME, v.NAME")
    for group, vid, name, short in rows:
        if group not in groups or not name:
            continue
        if short:
            variants[name] = short
        if holds(vid) and short:
            kept = by_group.setdefault(group, [])
            if short not in kept:
                kept.append(short)
    return {"variants": variants, "groups": by_group}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--chassis", help="one development code, e.g. E46 (default: all mapped)")
    ap.add_argument("--db", default=os.path.join(
        BMWFILES, "ista", "databases", "DiagDocDb.decrypted.sqlite"))
    ap.add_argument("--trees", default=os.path.join(ROOT, "data", "ista", "ecu-tree"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "ista", "ecu-names"))
    ns = ap.parse_args()
    if not os.path.exists(ns.db):
        raise SystemExit(f"no database at {ns.db} (see $BMWFILES/ista/README.md)")
    con = sqlite3.connect(f"file:{ns.db}?mode=ro", uri=True)
    typekeys, chars = read_typekeys(con), read_char_names(con)
    os.makedirs(ns.out, exist_ok=True)
    wanted = [ns.chassis.upper()] if ns.chassis else sorted(CHASSIS_TREE)
    for chassis in wanted:
        series = CHASSIS_TREE.get(chassis)
        path = os.path.join(ns.trees, f"{series}.json")
        if not series or not os.path.exists(path):
            raise SystemExit(f"{chassis}: no tree at {path} (run ecu_tree_extract.py first)")
        ids = chassis_char_ids(typekeys, chars, chassis)
        if not ids:
            print(f"  {chassis}: not in this database, skipped")
            continue
        with open(path, encoding="utf-8") as f:
            tree = json.load(f)
        groups = {g.lower() for e in tree["ecus"] for g in e.get("groups", [])}
        out = names_for(con, ids, groups)
        with open(os.path.join(ns.out, f"{chassis}.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        one = sum(1 for v in out["groups"].values() if len(v) == 1)
        print(f"  {chassis:5} {len(out['variants']):4} variants  "
              f"{len(out['groups']):3} groups ({one} with one name)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
