#!/usr/bin/env python3
"""Put WebKFP's SP-Daten into an offline build, packed.

WebKFP programs a module from BMW's SP-Daten: the module's ZB table and its
program and data files. The hosted site fetches them as a flash asks for
them (screens/webkfp/data.js). An offline build cannot, so they have to be
in the build:

    <dist>/data/sp-daten/index.json      the index, CUT to what is here
    <dist>/data/sp-daten/packs/*.spk     the packs it names

    python3 scripts/build/fetch_spdaten.py <dataset> <dist>/data
    python3 scripts/build/fetch_spdaten.py <dataset> <dist>/data --max-module-mb 64
    python3 scripts/build/fetch_spdaten.py <dataset> <dist>/data --chassis "E46 E39"
    python3 scripts/build/fetch_spdaten.py --from ~/.../BMWFILES/sp-daten-packed <dist>/data

The source is the PACKED set (tools/export/kfp_spdaten_pack.py), on the
dataset under sp-daten-packed/ or in a local folder: every module family
but the head-unit images, 22,000 loose files and 16 GB of them, as a few
hundred packs and under 1 GB.

WHAT IS LEFT OUT IS LEFT OUT OF THE INDEX TOO. WebKFP offers what its index
lists, and an entry it could not then read is worse than no entry. So the
index written here names only the modules and chassis whose packs were
fetched, and renumbers the packs to match.

--max-module-mb leaves out a module family whose packs come to more than
that. The families that do not pack at all (head-unit, navigation and
telephone images: already-compressed firmware) are not in the packed set
to begin with; this trims further, for a smaller build. The television and
audio modules are the next largest (30 to 55 MB a family, also already
compressed): without the 35 families over 5 MB, the other 508 are about
a quarter of a gigabyte.

Every pack is checked against the size the index gives for it, and one
already present at that size is not fetched again.
"""
import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://huggingface.co/datasets/{repo}/resolve/main/sp-daten-packed/"


def get(url, tries=6):
    """One file's bytes; a rate limit or a dropped connection is retried."""
    headers = {"User-Agent": "bmweb-build"}
    token = os.environ.get("HF_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url.replace(" ", "%20"), headers=headers)
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == tries - 1:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError(url)


def cut(index, chassis, max_module):
    """The index for a build: (index, the source's pack numbers kept, families left out)."""
    kept = {}
    dropped = []
    for module, by_chassis in index["modules"].items():
        entries = {c: e for c, e in by_chassis.items()
                   if not chassis or c.upper() in chassis}
        if not entries:
            continue
        packs = {at[0] for e in entries.values() for at in e["at"].values()}
        size = sum(index["sizes"][p] for p in packs)
        if max_module and size > max_module:
            dropped.append((module, size))
            continue
        kept[module] = entries
    used = sorted({at[0] for by in kept.values() for e in by.values() for at in e["at"].values()})
    renumber = {old: new for new, old in enumerate(used)}
    modules = {
        module: {c: {**e, "at": {n: [renumber[at[0]], at[1]] for n, at in e["at"].items()}}
                 for c, e in by.items()}
        for module, by in kept.items()}
    out = {"version": 2,
           "packs": [index["packs"][p] for p in used],
           "sizes": [index["sizes"][p] for p in used],
           "modules": modules,
           # with what the packed set itself was made without
           "leftOut": sorted({m for m, _ in dropped} | set(index.get("leftOut", [])))}
    if chassis:
        out["chassis"] = sorted(chassis)
    return out, used, dropped


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("dataset", nargs="?", help="the bmw-files dataset, e.g. CraigFf/bmw-files")
    ap.add_argument("out", help="the build's data directory")
    ap.add_argument("--from", dest="local", help="a local packed folder instead of the dataset")
    ap.add_argument("--chassis", help='only these, e.g. "E46 E39" (default: all)')
    ap.add_argument("--max-module-mb", type=float, default=0,
                    help="leave out a module family whose packs are bigger than this")
    ns = ap.parse_args()
    if not ns.local and not ns.dataset:
        ap.error("give a dataset or --from")
    chassis = set(ns.chassis.upper().split()) if ns.chassis else None
    dest = os.path.join(ns.out, "sp-daten")

    if ns.local:
        with open(os.path.join(ns.local, "index.json"), encoding="utf-8") as f:
            index = json.load(f)
    else:
        base = BASE.format(repo=ns.dataset)
        try:
            index = json.loads(get(base + "index.json"))
        except urllib.error.HTTPError as e:
            raise SystemExit(
                f"error: {base}index.json: HTTP {e.code}. The packed SP-Daten are not on "
                f"{ns.dataset} (pack them with tools/export/kfp_spdaten_pack.py and upload "
                "the folder as sp-daten-packed/).")
    if index.get("version") != 2 or "sizes" not in index:
        raise SystemExit("error: that index is not a packed one (version 2 with sizes)")

    out_index, used, dropped = cut(index, chassis, ns.max_module_mb * 1024 * 1024)
    if not out_index["modules"]:
        raise SystemExit("error: nothing left to fetch")
    if chassis:
        have = {c.upper() for by in out_index["modules"].values() for c in by}
        absent = sorted(chassis - have)
        if absent:
            raise SystemExit(f"error: no SP-Daten for: {' '.join(absent)}")

    os.makedirs(os.path.join(dest, "packs"), exist_ok=True)
    wanted = {index["packs"][p]: index["sizes"][p] for p in used}
    # a pack an earlier, wider fetch left behind is not part of this build
    for old in os.listdir(os.path.join(dest, "packs")):
        if old not in wanted:
            os.remove(os.path.join(dest, "packs", old))
    index_path = os.path.join(dest, "index.json")
    if os.path.exists(index_path):
        os.remove(index_path)

    def fetch(item):
        name, size = item
        path = os.path.join(dest, "packs", name)
        if os.path.exists(path) and os.path.getsize(path) == size:
            return 0
        if ns.local:
            shutil.copyfile(os.path.join(ns.local, "packs", name), path + ".part")
        else:
            with open(path + ".part", "wb") as f:
                f.write(get(base + "packs/" + name))
        if os.path.getsize(path + ".part") != size:
            raise RuntimeError(f"{name}: {os.path.getsize(path + '.part')} bytes, "
                               f"the index says {size}")
        os.replace(path + ".part", path)
        return size

    total = sum(wanted.values())
    print(f"  {len(wanted)} packs, {total / 1e6:.0f} MB, "
          f"{len(out_index['modules'])} module families")
    for module, size in sorted(dropped, key=lambda d: -d[1]):
        print(f"  left out: {module} ({size / 1e6:.0f} MB)")
    with ThreadPoolExecutor(max_workers=4) as pool:
        done = sum(pool.map(fetch, sorted(wanted.items())))
    # last, so a fetch that died part way leaves no index to trust
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(out_index, f, separators=(",", ":"), sort_keys=True)
    print(f"  fetched {done / 1e6:.0f} MB into {dest}")


if __name__ == "__main__":
    main()
