#!/usr/bin/env python3
"""The export gate ships every variant a group can IDENTIFY, not just the
variants a chassis menu happens to list.

THE BUG THIS PINS. data/chassis-config is INPA's menu; a group's
IDENTIFIKATION can name a variant the menu never had. On a real E46 with an
MS45.1 -- verified module by module against the car with EDIABAS -- the groups
answered gs20, mrs4, ews3, ihka46_3, kombi46r and lws5_1b. Every one is a
module physically present and answering. None was in the E46 menu, so none was
exported, and the whole-vehicle scan could only say "<name> not in build" for
a module it had just correctly identified.

    python3 tools/verify/test_export_gate.py
"""
import os
import sys
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
sys.path.insert(0, os.path.join(ROOT, "tools", "sgbd"))

import ecu_tree as T                                          # noqa: E402

passed = 0


def ok(what):
    global passed
    passed += 1
    if os.environ.get("V"):
        print("  ok", what)


def fail(what):
    print(f"  FAIL  {what}")
    sys.exit(1)


# ---- 1. the ground truth from the car -------------------------------------
# These six were read over the wire with EDIABAS on a real E46 (part numbers
# 7544721 / 6933238 / 6905670 among them). If the gate stops shipping any of
# them, a present module goes back to reading as absent.
CAR = {
    "gs20": "d_0032",
    "mrs4": "d_00a4",
    "ews3": "d_0044",
    "ihka46_3": "d_005b",
    "kombi46r": "d_0080",
    "lws5_1b": "d_0057",
}

gv = T.group_variants()
if not gv:
    fail("group_variants() found nothing -- is data/groups generated?")
ok(f"group_variants() maps {len(gv)} groups")

for sgbd, group in CAR.items():
    where = [g for g, names in gv.items() if sgbd in names]
    if group not in where:
        fail(f"{sgbd} is no longer identifiable from {group} (found in {where})")
    # It must map to exactly ONE group. Several groups embed a copy of the
    # master ZuordnungsTabelle, whose rows describe the whole car; without the
    # GRUPPE filter ms450ds0 lands in d_rls and d_fdm_vs as well as d_0012.
    if len(where) != 1:
        fail(f"{sgbd} maps to {len(where)} groups {where}, expected only {group}")
ok(f"each of the {len(CAR)} modules read off the car maps to exactly one group")

if "ms450ds0" in gv.get("d_rls", set()):
    fail("the master-table GRUPPE filter regressed: ms450ds0 leaked into d_rls")
ok("a group's embedded master-table copy does not claim other groups' variants")


# ---- 2. every candidate is a REAL sgbd -------------------------------------
# This is what keeps the rule formulaic instead of a guess: a pool string that
# matches no shipped .prg is a caption or a status word, and is dropped.
prgs = T._prg_names()
if not prgs:
    fail("no .prg files found under vendor/EDIABAS/Ecu")
bogus = sorted({n for names in gv.values() for n in names} - prgs)
if bogus:
    fail(f"identifiable set contains non-SGBDs: {bogus[:8]}")
ok(f"all {len({n for v in gv.values() for n in v})} identifiable names are real .prg files")

reserved = sorted({n for names in gv.values() for n in names}
                  & T.RESERVED_NAMES)
if reserved:
    fail(f"EDIABAS literals leaked in as SGBDs: {reserved}")
ok("EDIABAS result/status literals are excluded")


# ---- 3. they reach the tree, in their OWN folders ---------------------------
own = T.owners()
for sgbd in CAR:
    places = [c for c in own.get(sgbd, []) if c[0] == "E46"]
    if not places:
        fail(f"{sgbd} has no home on E46 -- it will not be exported")
    # Its own folder, never the menu entry's. E46/airbag declares zae, and an
    # mrs4 written there is exactly the sibling clobber write_ecu refuses.
    if [p for p in places if p[1] != sgbd]:
        fail(f"{sgbd} placed in a foreign folder {places} -- write_ecu drops it")
ok("every identified variant gets its own E46 folder (no sibling clobber)")

# No placement may collide with a folder another SGBD already owns.
by_folder = {}
for sgbd, places in own.items():
    for cid, code in places:
        by_folder.setdefault((cid, code), set()).add(sgbd)
clashes = {k: v for k, v in by_folder.items() if len(v) > 1}
# Menu entries legitimately map sibling dsN builds onto one folder; only the
# NEW own-name folders must be exclusive.
bad = {k: v for k, v in clashes.items() if k[1] in v and len(v) > 1}
if bad:
    fail(f"own-name folders shared with another SGBD: {list(bad.items())[:3]}")
ok("no identified-variant folder is shared with a different SGBD")


# ---- 4. the gate really did widen ------------------------------------------
menu = set()
for p in sorted(glob.glob(os.path.join(T.CONFIG, "*.json"))):
    if os.path.basename(p) == "index.json":
        continue
    import json
    with open(p) as f:
        cfg = json.load(f)
    for sec in cfg.get("sections", []):
        for e in sec.get("ecus", []):
            if e.get("sgbd"):
                menu.add(e["sgbd"].lower())
            for v in e.get("variants") or []:
                menu.add(str(v).lower())
added = set(own) - menu
if len(added) < 50:
    fail(f"only {len(added)} variants added beyond the menu -- gate looks closed")
ok(f"the gate ships {len(added)} variants the menu never named "
   f"({len(own)} total, was {len(menu)})")

print(f"\nexport gate: {passed} checks passed")
