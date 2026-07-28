#!/usr/bin/env python3
"""Emit the MS45.1 System-check screens (INPA's F9 "System" branch).

These are not actuator toggles like the Activations menus. Each one is a
diagnostic ROUTINE the ECU runs on request, so the SGBD exposes it as a triplet:

    START_SYSTEMCHECK_<X>     begin the routine
    STOP_SYSTEMCHECK_<X>      abort it
    STATUS_SYSTEMCHECK_<X>    its state   (STAT_DIAGNOSE_TEXT / _WERT)
    STATUS_SYSTEMCHECK_<X>_WERT   the measurements it produced

INPA draws the state line plus the measurements underneath, and the softkeys are
just Start / Stop -- which is why these need their own screen type rather than
the actuator layout.

The pairing is derived from the SGBD's job list, so a check cannot be missed:
for every START_SYSTEMCHECK_<X> the ECU implements, the state and measurement
jobs are looked up by name.

    python3 tools/ms45_system_checks.py            # print
    python3 tools/ms45_system_checks.py --write    # merge into MS450.json
"""
import os
import re
import sys
import json
import urllib.request

API = os.environ.get("BMACW_API", "http://127.0.0.1:8777")
SGBD = "ms450ds0"
LAYOUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "data", "inpa-layouts", "enriched", "MS450.json")

# INPA's own caption for each check, from its m_system softkeys
TITLES = {
    "EVAUSBL": ("Injector cut-out", "EV"),
    "L_SONDE": ("O2 sensor test", "L-SONDEN"),
    "SEK_LUFT": ("Secondary-air system", "SLS"),
    "TEV_FUNC": ("Purge valve function", "TEV"),
    "DMTL": ("DMTL leak diagnosis", "DMTL"),
    "LLERH": ("Idle-speed raise", "LL"),
    "L_REGELUNG_AUS": ("Lambda control off", "L-REG"),
    "PM_MESSEMODE": ("Power-management measure mode", "PM"),
}

# the softkeys INPA shows on a system-check screen
KEYS = [
    {"fkey": 1, "label": "Start", "action": "start"},
    {"fkey": 2, "label": "Stop", "action": "stop"},
]


def api(path):
    with urllib.request.urlopen(f"{API}{path}", timeout=60) as r:
        return json.load(r)


def build():
    jobs = set(api(f"/api/ecu/{SGBD}/jobs"))
    checks = []
    for job in sorted(j for j in jobs if j.startswith("START_SYSTEMCHECK_")):
        name = job[len("START_SYSTEMCHECK_"):]
        title, caption = TITLES.get(name, (name.replace("_", " ").title(), name))
        entry = {
            "check": name,
            "title": title,
            "caption": caption,
            "start": job,
            "keys": list(KEYS),
        }
        stop = f"STOP_SYSTEMCHECK_{name}"
        if stop in jobs:
            entry["stop"] = stop
        # the routine's state line, and the measurements it produces
        for suffix, key in (("", "status"), ("_WERT", "values"),
                            ("_WERTE", "values")):
            cand = f"STATUS_SYSTEMCHECK_{name}{suffix}"
            if cand in jobs and key not in entry:
                entry[key] = cand
        if "status" in entry or "values" in entry:
            checks.append(entry)
    return checks


def main():
    checks = build()
    if "--write" not in sys.argv:
        for c in checks:
            print(f"{c['caption']:8} {c['title']}")
            print(f"         start={c['start']}")
            print(f"         stop ={c.get('stop', '-')}")
            print(f"         state={c.get('status', '-')}")
            print(f"         vals ={c.get('values', '-')}")
        print(f"\n{len(checks)} system checks. --write to merge.")
        return 0

    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    lay["systemChecks"] = checks
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(lay, f, ensure_ascii=False, indent=1)
    print(f"{len(checks)} system checks -> {os.path.relpath(LAYOUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
