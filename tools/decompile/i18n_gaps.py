#!/usr/bin/env python3
"""The untranslated captions of the corpus, as work for translators.

`ipo_i18n.js --gaps` lists every caption no dictionary carries, per ECU.
This folds that into DISTINCT strings, keeps the ones that carry words (an
identifier, a number, a bare punctuation mark is not a caption to
translate), sorts them by how many ECUs show them, and hands out slices:

    python3 tools/decompile/i18n_gaps.py --slice 3/8 -o /tmp/slice3.json
    python3 tools/decompile/i18n_gaps.py --stats

A slice is a JSON list of {"s": caption, "n": ECUs showing it, "ecus": up
to three of them}. Translations go to data/inpa-i18n/_corpus.part<k>.json
as {"German caption": "English caption"}; `--merge` folds every part file
into _corpus.json (dropping empty or unchanged entries), removes the parts,
and reports what it kept.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OVR = os.path.join(ROOT, "data", "inpa-i18n")
IDENT = re.compile(r"^[A-Z0-9_./\-:%, ]+$")


def gaps():
    """caption -> set of ECUs, from the resolver's own report."""
    txt = subprocess.run(
        ["node", os.path.join(ROOT, "tools", "decompile", "ipo_i18n.js"), "--gaps"],
        capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    out = {}
    cur = None
    for line in txt.split("\n"):
        m = re.match(r"^([A-Za-z0-9_]+): \d+ captions", line)
        if m:
            cur = m.group(1)
            continue
        m = re.match(r'^  "(.*)"$', line)
        if m and cur:
            out.setdefault(m.group(1), set()).add(cur)
    return out


def worth(s):
    """A caption with words in it, not an identifier, number or mark."""
    return bool(re.search(r"[A-Za-zÄÖÜäöüß]{3,}", s)) \
        and not IDENT.match(s)


def main():
    argv = sys.argv[1:]
    if "--merge" in argv:
        # the resolver already reads the part files as dictionaries (its
        # _corpus*.json glob), so the gap list has shrunk by then and cannot
        # be the yardstick; the keys came from the gap list to begin with
        merged = {}
        kept = dropped = 0
        parts = []
        for f in sorted(os.listdir(OVR)):
            if not re.match(r"^_corpus\.part.*\.json$", f):
                continue
            parts.append(os.path.join(OVR, f))
            part = json.load(open(parts[-1], encoding="utf-8"))
            for k, v in part.items():
                if not isinstance(v, str) or not v.strip() or v == k:
                    dropped += 1
                    continue
                merged[k] = v
                kept += 1
        target = os.path.join(OVR, "_corpus.json")
        if os.path.exists(target):
            old = json.load(open(target, encoding="utf-8"))
            old.update(merged)
            merged = old
        with open(target, "w", encoding="utf-8") as fh:
            json.dump(dict(sorted(merged.items())), fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        for f in parts:
            os.remove(f)
        print(f"_corpus.json: {len(merged)} entries ({kept} taken from parts, "
              f"{dropped} dropped, {len(parts)} part files folded in)")
        return
    g = gaps()
    items = sorted(((s, e) for s, e in g.items() if worth(s)),
                   key=lambda x: (-len(x[1]), x[0]))
    if "--stats" in argv:
        print(f"distinct untranslated: {len(g)}; with words: {len(items)}; "
              f"occurrences: {sum(len(e) for e in g.values())}")
        return
    k, n = 1, 1
    if "--slice" in argv:
        k, n = map(int, argv[argv.index("--slice") + 1].split("/"))
    out = argv[argv.index("-o") + 1] if "-o" in argv else None
    # round-robin so every slice gets the same spread of common and rare
    mine = [{"s": s, "n": len(e), "ecus": sorted(e)[:3]}
            for i, (s, e) in enumerate(items) if i % n == k - 1]
    text = json.dumps(mine, ensure_ascii=False, indent=0)
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"slice {k}/{n}: {len(mine)} captions -> {out}")
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
