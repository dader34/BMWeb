#!/usr/bin/env python3
"""Pack the repair manual into transport archives.

WHY THIS ONE IS DIFFERENT FROM .ista. The ISTA bundles are read by the app
itself -- a module graph is fetched and parsed, so it can come out of a zip
in memory. The repair pictures cannot: repairPicUrl hands its result to an
<img src>, and an <img> cannot read from an archive. They have to be loose
files on disk in a packaged build.

So these archives are for TRANSPORT ONLY. The release fetch pulls ~125 of
them instead of 55,480 separate files and unpacks them into exactly the
layout the app expects. Nothing about the hosted site or the app changes.

    repair-text.zip     every chassis's documents and indexes (~800 files)
    repair-pics-<NN>.zip  one per pool folder, ~550 pictures each

    python3 tools/ista/build_repair_bundles.py --repair data/ista/repair \
        --out data/ista/repair-bundles
"""
import argparse
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")


def add_tree(zf, src, prefix, store=False):
    """Every file under src, stored at prefix/ inside the archive."""
    n = 0
    ct = zipfile.ZIP_STORED if store else zipfile.ZIP_DEFLATED
    for dirpath, _dirs, files in os.walk(src):
        for name in sorted(files):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            arc = f"{prefix}/{rel}" if prefix else rel
            zf.write(full, arc, compress_type=ct)
            n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repair", default=os.path.join(ROOT, "data/ista/repair"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data/ista/repair-bundles"))
    ns = ap.parse_args()
    if not os.path.isdir(ns.repair):
        raise SystemExit(f"no repair extract at {ns.repair}")
    os.makedirs(ns.out, exist_ok=True)

    # 1. the text: every chassis folder and the loose indexes, in one archive
    text = os.path.join(ns.out, "repair-text.zip")
    n_text = 0
    with zipfile.ZipFile(text, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for entry in sorted(os.listdir(ns.repair)):
            full = os.path.join(ns.repair, entry)
            if entry == "pics":
                continue
            if os.path.isdir(full):
                n_text += add_tree(zf, full, entry)
            else:
                zf.write(full, entry)
                n_text += 1
    print(f"  repair-text.zip        {n_text:6} files  {os.path.getsize(text)/1e6:7.1f} MB")

    # 2. the pictures: one archive per pool folder. They are .webp already,
    #    so storing beats deflating -- it saves the CPU on both ends.
    pics = os.path.join(ns.repair, "pics")
    total = 0
    pools = sorted(d for d in os.listdir(pics) if os.path.isdir(os.path.join(pics, d)))
    for pool in pools:
        path = os.path.join(ns.out, f"repair-pics-{pool}.zip")
        with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as zf:
            n = add_tree(zf, os.path.join(pics, pool), f"pics/{pool}", store=True)
        total += n
    size = sum(
        os.path.getsize(os.path.join(ns.out, f)) for f in os.listdir(ns.out)
    ) / 1e6
    print(f"  repair-pics-*.zip      {total:6} files in {len(pools)} archives")
    print(f"{len(pools) + 1} archives, {size:.0f} MB -> {ns.out}")


if __name__ == "__main__":
    main()
