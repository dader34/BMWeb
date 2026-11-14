#!/usr/bin/env python3
"""Pack the ISTA extracts the app fetches a file at a time into transport archives.

The hosted site reads these as loose files, a few per screen:

    ista/xaml        the page layouts and their captions
    ista/infotree    the structure trees and their document bodies
    ista/search      the text-search indexes (titles, numbers, words)
    ista/faultcodes  the fault code lists
    ista/testplan    the test plans
    ista/ecu-names   the names on a control unit's tree button

That is 9,253 files, and a release build that fetched them one at a time
would spend three quarters of an hour being rate limited (1,000 requests
per 300 s with a token). So, like the repair manual
(build_repair_bundles.py), each set also goes up as ONE archive, for
TRANSPORT ONLY: the release fetch (scripts/build/fetch_ista.py) pulls six
files and unpacks them into exactly the layout the app expects. Nothing
about the hosted site or the app changes, and the loose files stay.

    python3 tools/ista/build_extract_bundles.py
    python3 tools/ista/build_extract_bundles.py --ista data/ista --out data/ista/extract-bundles

Upload the output folder to the dataset as ista/extract-bundles/ whenever
the loose sets are uploaded: the two must hold the same files.

The output is BMW-derived data: data/ista/ is gitignored and hosted like
the rest of the ISTA extracts.
"""
import argparse
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")

# the sets, by their folder under ista/ (the archive is named for it)
SETS = ("xaml", "infotree", "search", "faultcodes", "testplan", "ecu-names")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--ista", default=os.path.join(ROOT, "data", "ista"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "ista", "extract-bundles"))
    ns = ap.parse_args()
    os.makedirs(ns.out, exist_ok=True)
    for name in SETS:
        src = os.path.realpath(os.path.join(ns.ista, name))
        if not os.path.isdir(src):
            raise SystemExit(f"no {name} extract at {src}")
        path = os.path.join(ns.out, f"{name}.zip")
        n = 0
        with zipfile.ZipFile(path, "w") as zf:
            for dirpath, dirs, files in os.walk(src):
                dirs.sort()
                for leaf in sorted(files):
                    if leaf.startswith("."):
                        continue
                    full = os.path.join(dirpath, leaf)
                    rel = os.path.relpath(full, src).replace(os.sep, "/")
                    # a .gz is as small as it gets; the rest deflates
                    stored = leaf.endswith(".gz")
                    # a fixed date: the archive changes only when a file does
                    info = zipfile.ZipInfo(f"{name}/{rel}", (1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
                    info.external_attr = 0o644 << 16
                    with open(full, "rb") as f:
                        zf.writestr(info, f.read())
                    n += 1
        print(f"  {name + '.zip':16} {n:6} files  {os.path.getsize(path) / 1e6:6.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
