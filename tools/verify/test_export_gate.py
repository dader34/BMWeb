#!/usr/bin/env python3
"""A module the car reports must be shipped and resolvable -- the emulator way.

THE BUG THIS PINS. data/chassis-config is INPA's menu; a car carries modules the
menu never lists. On a real E46 with an MS45.1 -- verified module by module
against the car with EDIABAS -- the groups answered gs20, mrs4, ews3, ihka46_3,
kombi46r and lws5_1b. Every one is physically present and answering; none is in
the E46 menu. If the build does not ship them, a present module reads as absent.

The app is a STRAIGHT .IPO EMULATOR: it does not predict which variants a car
has. A group's IDENTIFIKATION runs live over the wire and the ECU names its own
variant (webResolveVariant). So the contract this pins is:

  1. every SGBD BMW ships a .prg for is EXPORTED (the whole corpus), so whatever
     the wire resolves to always has data -- no variant is gated by a build-time
     guess, and in particular the six the car reported are all present; and
  2. each of those six is resolvable LIVE -- the group it answers on carries an
     IDENTIFIKATION for the VM to run.

What is NOT asserted, on purpose: that group_variants() pre-lists a variant, or
that it lands in an E46 menu folder. Predicting the variant list from a group's
string pool was the old model; it gated variants the bytecode never selects. The
corpus ships everything and the live probe decides.

    python3 tools/verify/test_export_gate.py
"""
import gzip
import json
import os
import sys

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


# The six read over the wire with EDIABAS on a real E46 (part numbers 7544721 /
# 6933238 / 6905670 among them), each with the group its IDENTIFIKATION answers
# on. If any stops being shipped or resolvable, a present module goes absent.
CAR = {
    "gs20": "d_0032",
    "mrs4": "d_00a4",
    "ews3": "d_0044",
    "ihka46_3": "d_005b",
    "kombi46r": "d_0080",
    "lws5_1b": "d_0057",
}


# ---- 1. the whole corpus ships -- no variant is predicted away -------------
ship = set(T.all_sgbds())
if not ship:
    fail("all_sgbds() is empty -- is vendor/EDIABAS/Ecu present?")
prgs = T._prg_names()
missing = sorted(prgs - ship)
if missing:
    fail(f"{len(missing)} shipped .prg not in all_sgbds(): {missing[:8]}")
ok(f"all_sgbds() ships the whole corpus ({len(ship)} SGBDs)")


# ---- 2. every module the car reported is shipped --------------------------
for sgbd in CAR:
    if sgbd not in ship:
        fail(f"{sgbd} is not shipped -- a present module will read as absent")
    if sgbd not in prgs:
        fail(f"{sgbd} names no real .prg under vendor/EDIABAS/Ecu")
ok(f"all {len(CAR)} modules read off the car are shipped")


# ---- 3. each is resolvable LIVE -- its group carries an IDENTIFIKATION -----
# The emulator resolves the variant by running the group's IDENTIFIKATION over
# the wire (webResolveVariant), not from a precomputed list. So the group each
# module answers on must carry that job for the VM to run.
GROUPS = os.path.join(ROOT, "data", "groups")
for sgbd, group in CAR.items():
    path = os.path.join(GROUPS, f"{group}.json.gz")
    if not os.path.exists(path):
        fail(f"{sgbd}: group {group} not shipped -- nothing to run to resolve it")
    try:
        with gzip.open(path) as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        fail(f"{sgbd}: group {group} unreadable ({e})")
    jobs = data.get("jobs") or {}
    if "IDENTIFIKATION" not in jobs:
        fail(f"{sgbd}: group {group} has no IDENTIFIKATION -- cannot resolve live")
ok(f"each of the {len(CAR)} modules resolves live from its group's "
   "IDENTIFIKATION")


# ---- 4. the tables source stays formulaic (no pool guessing) ---------------
# group_variants() is no longer the ship gate; it now only supplies the
# ZuordnungsTabelle candidates the live resolver's VM reads. Whatever it names
# must be a real .prg and never an EDIABAS literal -- decoded from tables, not
# guessed from the string pool.
gv = T.group_variants()
named = {n for names in gv.values() for n in names}
bogus = sorted(named - prgs)
if bogus:
    fail(f"group_variants() named non-SGBDs (pool leak?): {bogus[:8]}")
reserved = sorted(named & T.RESERVED_NAMES)
if reserved:
    fail(f"EDIABAS literals leaked into group_variants(): {reserved}")
ok(f"group_variants() names only real SGBDs from tables ({len(named)} across "
   f"{len(gv)} groups)")


print(f"\nexport gate: {passed} checks passed")
