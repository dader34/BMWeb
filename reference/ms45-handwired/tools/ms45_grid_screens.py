#!/usr/bin/env python3
"""Attach INPA's decoded grid layout to the screens we already render.

tools/ipo_grid.py recovers where INPA physically draws each value (row/column on
its character grid) plus the gauge min/max carried as doubles. This pairs that
with the shipped layout: a grid screen is matched to the job that returns its
result keys, and the positions are written onto that screen as `grid`.

Only screens that resolve to exactly ONE job are emitted. A few grid screens
(the AIF/programming pages, over-rev and over-temp histories) draw keys no
shipped job returns, and one draws keys from two jobs -- wiring those would mean
guessing which job to poll, so they are skipped and reported.

    python3 tools/ms45_grid_screens.py            # show what would be attached
    python3 tools/ms45_grid_screens.py --write    # merge into MS450.json
"""
import os
import sys
import json
import collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_grid as G   # noqa: E402

IPO = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "vendor", "EC-APPS", "INPA", "SGDAT", "MS450.IPO")
LAYOUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "data", "inpa-layouts", "enriched", "MS450.json")


def build():
    with open(IPO, "rb") as f:
        data = f.read()
    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)

    # result key -> the job that returns it (from the layout we already ship)
    key2job = {}
    for s in lay["screens"]:
        for r in s["rows"]:
            key2job.setdefault(r["key"], s["job"])

    attached, skipped = {}, []
    for scr in G.screens(data):
        results = [e for e in scr["elements"] if e["kind"] == "result"]
        jobs = collections.Counter(key2job[e["key"]] for e in results
                                   if e["key"] in key2job)
        if len(jobs) != 1:
            skipped.append((scr["title"], list(jobs) or ["no job returns these keys"]))
            continue
        job = next(iter(jobs))
        # a degenerate scale (min == max) is not a range — those doubles are the
        # screen's step/precision fields, not a gauge span, so drop them rather
        # than hand the renderer a zero-width bar
        cells = [{"key": e["key"], "row": e["row"], "col": e["col"],
                  **({"min": e["min"], "max": e["max"]}
                     if "min" in e and e["min"] != e["max"] else {})}
                 for e in results if e["key"] in key2job]
        labels = [{"text": e["text"], "row": e["row"], "col": e["col"]}
                  for e in scr["elements"] if e["kind"] == "text"]
        # the richest decode wins if a job appears twice
        if job not in attached or len(cells) > len(attached[job]["cells"]):
            attached[job] = {"title": scr["title"], "labels": labels, "cells": cells}
    return attached, skipped


def main():
    attached, skipped = build()
    if "--write" not in sys.argv:
        for job, g in attached.items():
            print(f"{job}  ({g['title']})")
            for c in g["cells"]:
                rng = (f"  [{c['min']:g}..{c['max']:g}]"
                       if "min" in c else "")
                print(f"    r{c['row']:<3} c{c['col']:<3} {c['key']}{rng}")
        print(f"\n{len(attached)} screens would get a grid.")
        for title, why in skipped:
            print(f"  skipped: {title[:44]:46} {why}")
        return 0

    with open(LAYOUT, encoding="utf-8") as f:
        lay = json.load(f)
    n = 0
    for s in lay["screens"]:
        g = attached.get(s["job"])
        if not g:
            continue
        s["grid"] = {"labels": g["labels"], "cells": g["cells"]}
        # the decoded scale is better than a heuristic range, so adopt it
        by_key = {c["key"]: c for c in g["cells"]}
        for r in s["rows"]:
            c = by_key.get(r["key"])
            if c and "min" in c:
                r["min"], r["max"] = c["min"], c["max"]
        n += 1
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(lay, f, ensure_ascii=False, indent=1)
    print(f"grid attached to {n} screens -> {os.path.relpath(LAYOUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
