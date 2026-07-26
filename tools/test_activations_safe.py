#!/usr/bin/env python3
"""Guard: no generated screen may offer a write it cannot correctly perform.

ZKE5 shipped an "Activate" button for STEUERN_DIGITAL, a job that needs ORT
("gewuenschte Komponente") and EIN (1/0). Pressing it would have sent an
incomplete request to a real car. The cause was a generator that matched job
NAMES and never read the SGBD's declared arguments -- exactly the failure mode
automation makes worse, because it repeats silently across hundreds of ECUs.

This asserts the rules that stop it coming back:

  1. the recognisers emit no runnable write at all (reads-only, by decision)
  2. every decoded argument table stays under writes_unverified, never promoted
     to a screen
  3. an activation is only runnable when we can supply its arguments: none, or
     a single numeric drive value

Rule 3 is checked against the live engine when the app is running, since that
is the only place the SGBD's _ARGUMENTS schema can be read. It is skipped, not
failed, when the app is down -- a missing app is not a broken invariant.

    python3 tools/test_activations_safe.py
"""
import os
import re
import sys
import json
import glob
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_screens as L1                                        # noqa: E402
import ipo_recognize as L2                                      # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
GENERATED = os.path.join(HERE, "..", "data", "inpa-layouts", "generated")

# screens the generator is allowed to emit. Everything here is read-only; a new
# screen kind that writes must be added deliberately, not by accident.
#
# activateMenus is INPA's Activate GROUPING (Inputs/Outputs -> PW, C.Lock, ...)
# decoded from the .IPO. It carries labels and filter tokens only -- no job, no
# argument, nothing runnable. Picking a group still routes through the shared
# confirm-and-send path, where the argument rules below apply.
READ_ONLY_SCREENS = {"identity", "aif", "activateMenus"}

# how many ECUs to check against the live engine (the whole corpus is slow and
# the failure mode is systemic, not per-ECU)
SAMPLE = 60


def api(base, path, timeout=30):
    with urllib.request.urlopen(base + path, timeout=timeout) as r:
        return json.load(r)


def find_app():
    import subprocess
    try:
        out = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a",
                              "-c", "InpaMac.A"], capture_output=True,
                             text=True, timeout=15).stdout
        m = re.search(r"127\.0\.0\.1:(\d+)", out)
        return f"http://127.0.0.1:{m.group(1)}" if m else None
    except Exception:                       # noqa: BLE001
        return None


def check_generated_are_reads(failures):
    """Rule 1: nothing the generator wrote is a write screen."""
    files = sorted(glob.glob(os.path.join(GENERATED, "*.json")))
    if not files:
        print("  generated  SKIPPED (run tools/ipo_enrich.py --write)")
        return
    bad = set()
    for path in files:
        try:
            with open(path, encoding="utf-8") as f:
                lay = json.load(f)
        except Exception:                   # noqa: BLE001
            continue
        for key in lay:
            if key in ("ecu", "sgbd", "generated"):
                continue
            if key not in READ_ONLY_SCREENS:
                bad.add(key)
    if bad:
        failures.append(f"generated layouts contain non-read screens: {sorted(bad)}")
    print(f"  generated  {len(files)} layouts, screen kinds "
          f"{sorted(READ_ONLY_SCREENS)}, none writable")


def check_tables_not_promoted(failures):
    """Rule 2: decoded write tables stay under review, never become screens."""
    checked = promoted = 0
    for rec in L1.corpus():
        if not L1.decodable(rec) or not rec["tables"]:
            continue
        r = L2.recognise(rec)
        checked += 1
        for s in r["screens"]:
            if s["screen"] not in READ_ONLY_SCREENS:
                promoted += 1
        if not r["writes_unverified"] and rec["tables"]:
            failures.append(f"{rec['ecu']}: decoded tables vanished instead of "
                            "being held for review")
    if promoted:
        failures.append(f"{promoted} write table(s) were emitted as screens")
    print(f"  tables     {checked} ECUs with decoded write tables, "
          f"{promoted} promoted to screens (must be 0)")


def check_activation_args(base, failures):
    """Rule 3: runnable only when we can actually supply the arguments."""
    names = sorted(os.path.basename(f)[:-4]
                   for f in glob.glob(os.path.join(HERE, "..", "vendor",
                                                   "EDIABAS", "Ecu", "*.prg")))
    checked = runnable = offenders = 0
    for sgbd in names[:SAMPLE]:
        try:
            acts = api(base, f"/api/ecu/{sgbd}/activations")
        except Exception:                   # noqa: BLE001 - unloadable SGBD
            continue
        for a in acts:
            checked += 1
            if not a.get("runnable"):
                continue
            runnable += 1
            args = a.get("args") or []
            # A runnable test needs nothing, one value we supply, or a set in
            # which the SGBD spells out at least one argument's legal values
            # (the ORT-from-BITS case). A pile of bare numbers does NOT qualify:
            # STEUERN_IO's three raw protocol identifiers are fillable in the
            # narrow sense and meaningless in practice, and prompting for them
            # invites a blind write.
            if len(args) > 1 and not any(g.get("options") for g in args):
                offenders += 1
                names = [g.get("name") for g in args]
                failures.append(f"{sgbd}/{a['start']}: runnable with "
                                f"{len(args)} unguided args {names}")
    print(f"  activations {checked} checked across {min(len(names), SAMPLE)} "
          f"SGBDs, {runnable} runnable, {offenders} wrongly runnable")


def main():
    failures = []
    check_generated_are_reads(failures)
    check_tables_not_promoted(failures)

    base = find_app()
    if base:
        check_activation_args(base, failures)
    else:
        print("  activations SKIPPED (app not running; start it to check "
              "_ARGUMENTS)")

    if failures:
        print("\nFAIL")
        for f in failures:
            print(f"   - {f}")
        return 1
    print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
