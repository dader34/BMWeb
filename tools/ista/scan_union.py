#!/usr/bin/env python3
"""Derive the scan target list per chassis: ISTA's tree, plus what only INPA reaches.

The tree scanner walks ISTA's EcuTreeConfiguration (tools/ista/ecu_tree_extract.py).
That tree is a near-superset of what a chassis's INPA whole-car script sweeps --
94 groups against 41 on E46 -- but it is NOT a strict superset. ISTA draws one
box where INPA addresses a pair: E46's mirror memory is one SM/SPM box but two
groups on the wire (D_SPMFT/D_SPMBT), and its xenon lights are one LWR box but
D_XEN_L/D_XEN_R. Scanning the tree alone would silently stop reading those.

So the scan list is the UNION: every tree group, plus every group a shipped
whole-car script addresses that no tree entry carries. This file writes the
second half -- the extras -- read out of the decompiled scripts, so the list is
derived from the scripts themselves and not a table anyone has to maintain.

Input is INPA .SRC produced by tools/decompile/ipo_source.py; the sweep idioms
are fs_is_lesen("D_XXXX", ...) for a fault read and read_identification(...)
for an ident, both naming the group as a literal. Scripts that address modules
by SGBD instead (R50, E87, E90) name no groups, so they contribute nothing here
and their chassis fall back to the tree alone.

    python3 tools/ista/scan_union.py --src /tmp/e46.src /tmp/E53.src ...

Writes data/ista/ecu-tree/scan-extras.json: {chassis: [{group, label}]}.
"""
import argparse
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")

# The literal-group sweep idioms. Both name the group first and a human label
# in the last string argument; fs_is_lesen carries a "fs" selector between them
# (and on some chassis an extra numeric argument), hence the non-greedy middle.
SWEEP = re.compile(r'(?:fs_is_lesen|read_identification)\(\s*"(D_[^"]+)"(.*?)\)',
                   re.S)
LABEL = re.compile(r'"([^"]*)"\s*$')


def groups_in(src_text):
    """{group: label} for every group the script addresses by literal name."""
    found = {}
    for m in SWEEP.finditer(src_text):
        g = m.group(1).lower()
        lab = LABEL.search(m.group(2).strip())
        # first mention wins: the fault sweep and the ident sweep use the same
        # labels, and the fault sweep comes first in every script seen
        found.setdefault(g, lab.group(1) if lab else "")
    return found


def tree_groups(tree):
    """Every group any entry in a parsed tree carries."""
    out = set()
    for e in tree.get("ecus", []):
        for g in e.get("groups", []):
            out.add(str(g).lower())
    return out


def chassis_of(path):
    """The chassis id a .SRC belongs to: its filename stem, upper-cased."""
    return os.path.splitext(os.path.basename(path))[0].upper()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", nargs="+", required=True,
                    help="decompiled whole-car .SRC files (ipo_source.py)")
    ap.add_argument("--trees", default=os.path.join(ROOT, "data", "ista", "ecu-tree"))
    ns = ap.parse_args()

    index_path = os.path.join(ns.trees, "index.json")
    if not os.path.exists(index_path):
        raise SystemExit(f"no tree index at {index_path} (run ecu_tree_extract.py first)")
    index = json.load(open(index_path, encoding="utf-8"))
    chassis_tree = index.get("chassis", {})

    extras = {}
    for path in ns.src:
        if not os.path.exists(path):
            raise SystemExit(f"no such script: {path}")
        ch = chassis_of(path)
        series = chassis_tree.get(ch)
        if not series:
            print(f"  {ch:5} no tree maps this chassis -- skipped")
            continue
        tpath = os.path.join(ns.trees, f"{series}.json")
        if not os.path.exists(tpath):
            raise SystemExit(f"index names tree {series} but {tpath} is missing")
        have = tree_groups(json.load(open(tpath, encoding="utf-8")))
        want = groups_in(open(path, encoding="utf-8", errors="replace").read())
        if not want:
            # an SGBD-addressed script (R50/E87/E90) names no groups at all
            print(f"  {ch:5} addresses no groups by name -- tree alone")
            continue
        gap = {g: lab for g, lab in want.items() if g not in have}
        print(f"  {ch:5} script {len(want):3} groups | tree({series}) {len(have):3} "
              f"| only in script: {len(gap)}")
        if gap:
            extras[ch] = [{"group": g, "label": gap[g]} for g in sorted(gap)]

    out = os.path.join(ns.trees, "scan-extras.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "extras": extras}, f,
                  ensure_ascii=False, separators=(",", ":"))
    total = sum(len(v) for v in extras.values())
    print(f"{total} extra groups across {len(extras)} chassis -> {out}")


if __name__ == "__main__":
    main()
