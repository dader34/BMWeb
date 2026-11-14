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
for the chassis alone keeps its variant and ships the rule, so the app can ask
it of the one car (an M54 car's engine unit is a DME, not a DDE).

    python3 tools/ista/ecu_names_extract.py              # every mapped chassis
    python3 tools/ista/ecu_names_extract.py --chassis E46

THE UNITS A K-BUS CAR MIGHT CARRY come from here too. For the series that
are identified over the K-bus, the tool does not stop at the units it
expects: VehicleIdent.GetFullVehicleECU walks a fixed list of group files
and adds the unit of every group whose own validity rule holds for the car
and that has at least one variant valid for it. Those are the grey boxes on
a tree: possible on this car, not confirmed. "full" is that list, cut to
the chassis, each entry with the rule still to be asked of the one car.

Writes data/ista/ecu-names/<CHASSIS>.json:
    {"variants": {"<sgbd>": "<short>"},
     "groups": {"<group>": [["<short>", rule?], ...]},   rule: asked of the one car
     "full": [{"g": "<group>", "r": rule}, ...]}      (K-bus series only)
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
from testplan_extract import all_of, any_of  # noqa: E402
from validity_rules import (  # noqa: E402
    chassis_char_ids,
    decode_rule,
    read_char_names,
    read_typekeys,
    rule_eval,
)

BMWFILES = os.environ.get("BMWFILES", os.path.expanduser("~/Development/code/BMWFILES"))


# VehicleIdent.GetFullVehicleECU's list, in its order (blank and repeated
# entries are the tool's own).
FULL_GROUPS = (
    "d_0000,d_0008,d_000d,d_0010,d_0011,d_0012,d_motor,d_0013,d_0014,d_0015,"
    "d_0016,d_0020,d_0021,d_0022,d_0024,d_0028,d_002c,d_002e,d_0030,d_0032,"
    "d_0035,d_0036,d_003b,d_0040,d_0044,d_0045,d_0050,d_0056,d_0057,d_0059,"
    "d_005a,d_005b,d_0060,d_0068,d_0069,d_006a,d_006c,d_0070,d_0071,d_0072,"
    "d_007f,d_0080,d_0086,d_0099,d_009a,d_009b,d_009c,d_009d,d_009e,d_00a0,"
    "d_00a4,d_00a6,d_00a7,d_00ac,d_00b0,d_00b9,d_00bb,d_00c0,d_00c8,d_00cd,"
    "d_00d0,d_00da,d_00e0,d_00e8,d_00ed,d_00f0,d_00f5,d_00ff,d_b8_d0,,"
    "d_m60_10,d_m60_12,d_spmbt,d_spmft,d_szm,d_zke3bt,d_zke3ft,d_zke3pm,"
    "d_zke3sb,d_zke3sd,d_zke_gm,d_zuheiz,d_sitz_f,d_sitz_b,d_0047,d_0048,"
    "d_00ce,d_00ea,d_abskwp,d_0031,d_0019,d_smac,d_0081,d_xen_l,d_xen_r"
).split(",")

# The series identified over the K-bus, where the tool walks that list.
KBUS_CHASSIS = {"E36", "E38", "E39", "E46", "E52", "E53", "E83", "E85", "R50"}


def full_list(con, ids):
    """GetFullVehicleECU for a chassis: [{"g": group, "r": rule}]."""
    rules = dict(con.execute("SELECT ID, RULE FROM XEP_RULES"))

    def rule(key):
        """(tree or None, holds for the chassis)."""
        tree, unsure = decode_rule(rules.get(key))
        if unsure or tree is None:
            return None, True
        return tree, rule_eval(tree, ids) is not False

    out = []
    for name in FULL_GROUPS:
        row = con.execute(
            "SELECT ID FROM XEP_ECUGROUPS WHERE NAME = ? COLLATE NOCASE", (name,)).fetchone()
        if not name or not row:
            continue
        own, ok = rule(row[0])
        if not ok:
            continue
        # at least one variant valid for the car
        kept = [t for t, good in (rule(v) for (v,) in con.execute(
            "SELECT ID FROM XEP_ECUVARIANTS WHERE ECUGROUPID = ?", (row[0],))) if good]
        if not kept:
            continue
        both = all_of([own, any_of(kept)])
        out.append({"g": name, **({"r": both} if both is not None else {})})
    return out


def names_for(con, ids, groups):
    """The two lookups for one chassis, over the groups its tree names."""
    rules = dict(con.execute("SELECT ID, RULE FROM XEP_RULES"))

    def rule(vid):
        """(tree or None, holds for the chassis)."""
        tree, unsure = decode_rule(rules.get(vid))
        if unsure or tree is None:
            return None, True
        return tree, rule_eval(tree, ids) is not False

    variants = {}
    found = {}
    rows = con.execute(
        "SELECT lower(g.NAME), v.ID, lower(v.NAME), r.STEUERGERAETEKUERZEL "
        "FROM XEP_ECUGROUPS g "
        "JOIN XEP_ECUVARIANTS v ON v.ECUGROUPID = g.ID "
        "LEFT JOIN XEP_REFECUCLIQUES rc ON rc.ID = v.ID "
        "LEFT JOIN XEP_ECUCLIQUES c ON c.ID = rc.ECUCLIQUEID "
        "LEFT JOIN XEP_ECUREPS r ON r.ID = c.ECUREPID "
        "ORDER BY g.NAME, v.NAME")
    for group, vid, name, short in rows:
        if group not in groups or not name or not short:
            continue
        variants[name] = short
        tree, ok = rule(vid)
        if ok:
            found.setdefault(group, {}).setdefault(short, []).append(tree)
    # a name stands for the car when ANY of its variants is valid for it
    by_group = {}
    for group, shorts in found.items():
        by_group[group] = []
        for short, trees in shorts.items():
            both = any_of(trees)
            by_group[group].append([short] if both is None else [short, both])
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
        if chassis in KBUS_CHASSIS:
            out["full"] = full_list(con, ids)
        with open(os.path.join(ns.out, f"{chassis}.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        one = sum(1 for v in out["groups"].values() if len(v) == 1)
        print(f"  {chassis:5} {len(out['variants']):4} variants  "
              f"{len(out['groups']):3} groups ({one} with one name)"
              f"  {len(out.get('full', [])):3} possible")
    return 0


if __name__ == "__main__":
    sys.exit(main())
