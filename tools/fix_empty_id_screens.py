#!/usr/bin/env python3
"""Drop mined screens that can never render: an info-memory job asked for ID_*.

The old miner paired some screens titled "ECU identification" / "Info memory"
with IS_LESEN, whose results are the info-memory records (F_HEX_CODE, F_ORT_NR,
F_HFK ...). It never returns ID_LIEF_TEXT, so the screen draws one empty cell
and reports "0 values" -- on ZKE5 that is the whole Status F1 page.

These are identity screens that lost their job. tools/ipo_enrich.py now
generates a correct Identity card for the same ECUs from the .IPO captions plus
the SGBD schema, so the fix is to remove the broken screen rather than repair
it: the good one is already there and the layout endpoint merges it in.

Only screens whose rows are ENTIRELY ID_* keys are touched. A screen mixing
F_* and other results is a different question and is left alone.

    python3 tools/fix_empty_id_screens.py            # report
    python3 tools/fix_empty_id_screens.py --write    # remove them
"""
import os
import sys
import json
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
ENRICHED = os.path.join(HERE, "..", "data", "inpa-layouts", "enriched")

# jobs that return fault/info records, never identity fields
INFO_JOBS = {"IS_LESEN", "FS_LESEN"}


def broken(screen):
    """A screen that asks an info/fault job only for ID_ results."""
    job = (screen.get("job") or "").upper()
    keys = [r.get("key", "") for r in screen.get("rows", [])]
    return job in INFO_JOBS and keys and all(k.startswith("ID_") for k in keys)


def main():
    write = "--write" in sys.argv
    hits, changed = [], 0

    for path in sorted(glob.glob(os.path.join(ENRICHED, "*.json"))):
        try:
            with open(path, encoding="utf-8") as f:
                lay = json.load(f)
        except Exception:                   # noqa: BLE001 - not a layout
            continue
        screens = lay.get("screens")
        if not isinstance(screens, list):
            continue

        keep = [s for s in screens if not broken(s)]
        if len(keep) == len(screens):
            continue

        ecu = os.path.basename(path)[:-5]
        for s in screens:
            if broken(s):
                hits.append((ecu, s.get("job"), s.get("group"),
                             [r.get("key") for r in s.get("rows", [])]))
        if write:
            # menus address screens by index; drop the removed ones from any
            # index list so a menu never points at the wrong screen
            index_of = {id(s): i for i, s in enumerate(screens)}
            remap = {index_of[id(s)]: i for i, s in enumerate(keep)}
            for menu in lay.get("menus", []) or []:
                for item in menu.get("items", []) or []:
                    if isinstance(item.get("screens"), list):
                        item["screens"] = [remap[i] for i in item["screens"]
                                           if i in remap]
            lay["screens"] = keep
            with open(path, "w", encoding="utf-8") as f:
                json.dump(lay, f, ensure_ascii=False, indent=1)
            changed += 1

    print(f"{len(hits)} screen(s) that can never render:\n")
    for ecu, job, group, keys in hits:
        print(f"   {ecu:12} {job:9} {str(group)[:30]:32} {keys}")
    if write:
        print(f"\nremoved from {changed} layout file(s)")
    else:
        print("\n(dry run — pass --write to remove)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
