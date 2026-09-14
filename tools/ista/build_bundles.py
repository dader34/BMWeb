#!/usr/bin/env python3
"""Pack each chassis's ISTA data into one .ista archive.

WHY A BUNDLE. The app and the release build both need a car's test modules,
schematics and diagnosis documents, and asking for them one file at a time is
26,037 requests for a release and hundreds for a technician who opens a few
screens -- enough to be rate limited part way through either. The .chassis
archives already took this bet for the SGBDs, and the comment in
api-router.js records why: "loose copies duplicated all 310 for 47 MB and
nothing read them". The ISTA data has exactly that shape.

One zip per chassis, laid out the way the app asks for the files:

    E46.ista
      abl/<CHASSIS>.json.gz   the chassis index (modules + fault links)
      abl/<MODULE>.json.gz    the recovered step graphs this car uses
      wiring/index.json       the designator and document index
      wiring/svg/*.svgz       schematics
      wiring/body/*.json      document bodies
      diag/*                  diagnosis structures

Modules shared between chassis are stored in each bundle that needs them --
about 48 MB across all 26, the same duplication the .chassis archives accept,
and cheap against one fetch per car.

    python3 tools/ista/build_bundles.py --out data/ista/bundles
"""
import argparse
import gzip
import io
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")


def add_tree(zf, src, prefix):
    """Every file under src, stored at prefix/ inside the archive."""
    n = 0
    if not os.path.isdir(src):
        return 0
    for dirpath, _dirs, files in os.walk(src):
        for name in sorted(files):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            zf.write(full, f"{prefix}/{rel}")
            n += 1
    return n


def modules_for(abl_dir, chassis):
    """The module graphs one chassis's index names, as (arcname, path)."""
    idx = os.path.join(abl_dir, f"{chassis}.json.gz")
    if not os.path.exists(idx):
        return None, []
    with gzip.open(idx, "rt", encoding="utf-8") as fh:
        data = json.load(fh)
    out = []
    for ident in data.get("modules") or {}:
        name = str(ident).replace("-", "_") + ".json.gz"
        # the pool is sharded; the app computes the same two hex digits
        h = 0
        for ch in str(ident).replace("_", "-"):
            h = (h * 31 + ord(ch)) & 0xFFFFFFFF
        shard = "%02x" % (h & 0xFF)
        for cand in (os.path.join(abl_dir, shard, name), os.path.join(abl_dir, name)):
            if os.path.exists(cand):
                out.append((f"abl/{name}", cand))
                break
    return idx, out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--abl", default=os.path.join(ROOT, "data/ista/abl"))
    ap.add_argument("--wiring", default=os.path.join(ROOT, "data/ista/wiring"))
    ap.add_argument("--diag", default=os.path.join(ROOT, "data/ista/diag"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data/ista/bundles"))
    ap.add_argument("--chassis", help="comma separated; every chassis by default")
    ns = ap.parse_args()

    names = (
        [c.strip().upper() for c in ns.chassis.split(",") if c.strip()]
        if ns.chassis
        else sorted(
            f[:-8]
            for f in os.listdir(ns.abl)
            if f.endswith(".json.gz") and not f.startswith("ABL") and ".full." not in f
        )
    )
    os.makedirs(ns.out, exist_ok=True)
    total = 0
    for chassis in names:
        idx, mods = modules_for(ns.abl, chassis)
        if idx is None:
            print(f"  {chassis:5} no index -- skipped", file=sys.stderr)
            continue
        path = os.path.join(ns.out, f"{chassis}.ista")
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            # the index, uncompressed inside since it is already gzip
            # under the name the app asks for, so istaAblIndex needs no
            # special case: it requests <CHASSIS>.json.gz either way
            zf.write(idx, f"abl/{chassis}.json.gz", compress_type=zipfile.ZIP_STORED)
            for arc, full in mods:
                zf.write(full, arc, compress_type=zipfile.ZIP_STORED)
            n_w = add_tree(zf, os.path.join(ns.wiring, chassis), "wiring")
            n_d = add_tree(zf, os.path.join(ns.diag, chassis), "diag")
        mb = os.path.getsize(path) / 1e6
        total += mb
        print(
            f"  {chassis:5} {len(mods):4} modules  {n_w:5} wiring  {n_d:5} diag"
            f"  -> {mb:6.1f} MB"
        )
    print(f"{len(names)} bundles, {total:.0f} MB total -> {ns.out}")


if __name__ == "__main__":
    main()
