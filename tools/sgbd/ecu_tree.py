#!/usr/bin/env python3
"""Where a generator's output goes: data/chassis/<CHASSIS>/<ECU>/<file>.

The tree is laid out by CAR, not by kind, so everything about one ECU sits in
one folder and you can work on it without hunting through six parallel
directories:

    data/chassis/E90/MSD80/
        ecu.json        identity: code, label, section, sgbd, group
        job-code.json   BEST2 bytecode for the VM
        meta.json       jobs, results, arguments (the .prg description block)
        tables.json     SGBD tables
        screens.json    the decompiled INPA UI (IR)
        i18n.json       per-ECU caption translations
        faults.json     fault-code map

THE DUPLICATION IS DELIBERATE AND IT IS NOT FREE. 58% of SGBDs appear in more
than one chassis -- rdc_60 is in 13, ews in 12 -- so a per-car tree stores
those files once per car: 310 distinct ECUs become 838 folders, about 2.7x the
bytes. That was chosen for ease of working on a single ECU.

What that buys has to be paid for in ONE place, or the copies drift. Every
generator calls write_ecu() rather than opening a path itself, so a single
regeneration always updates every car that shares the ECU. Nothing writes into
this tree by hand.
"""
import os
import sys
import json
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
TREE = os.path.join(ROOT, "data", "chassis")
CONFIG = os.path.join(ROOT, "data", "chassis-config")

_OWNERS = None


def owners():
    """{sgbd: [(chassis, ecu_code), ...]} -- every car each SGBD serves.

    Read from data/chassis-config, which is INPA's own CFGDAT resolved against
    the .prg tree. That is the only thing that knows which ECUs a car has.
    """
    global _OWNERS
    if _OWNERS is not None:
        return _OWNERS
    out = {}
    for p in sorted(glob.glob(os.path.join(CONFIG, "*.json"))):
        cid = os.path.basename(p)[:-5]
        if cid == "index":
            continue
        try:
            with open(p) as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            continue
        for sec in cfg.get("sections", []):
            for e in sec.get("ecus", []):
                # the entry's own SGBD and its sibling dsN builds alike: all
                # of them serve this car, and without the siblings write_ecu
                # dropped them ("no chassis-config entry names this SGBD")
                for sgbd in [e.get("sgbd")] + list(e.get("variants") or []):
                    sgbd = (sgbd or "").lower()
                    if sgbd:
                        out.setdefault(sgbd, []).append((cid, e["code"]))
    _OWNERS = out
    return out


def ecu_dirs(sgbd):
    """Every folder this SGBD's output belongs in. Empty if no car uses it."""
    return [os.path.join(TREE, cid, code)
            for cid, code in owners().get(str(sgbd).lower(), [])]


def write_ecu(sgbd, name, obj, raw=None):
    """Write one file into every car that uses this SGBD.

    `obj` is JSON-serialised; pass `raw` (bytes/str) instead for content that
    is already encoded. Returns the number of copies written, which is 0 when
    no chassis config names the SGBD. That case is PRINTED here, not left to
    each caller: several generators funnel through this function and most of
    them ignored the return value, so exports for unclaimed SGBDs vanished
    without a trace.
    """
    dirs = ecu_dirs(sgbd)
    if not dirs:
        print(f"  ecu_tree: DROPPED {name} for {sgbd}: "
              f"no chassis-config entry names this SGBD", file=sys.stderr)
    payload = raw if raw is not None else json.dumps(
        obj, ensure_ascii=False, separators=(",", ":"))
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    for d in dirs:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), "wb") as f:
            f.write(payload)
    return len(dirs)


def read_ecu(sgbd, name):
    """Read one file back. Any copy will do; they are written together."""
    for d in ecu_dirs(sgbd):
        p = os.path.join(d, name)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)
    return None


def all_sgbds():
    """Every SGBD some chassis references."""
    return sorted(owners().keys())
