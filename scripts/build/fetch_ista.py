#!/usr/bin/env python3
"""Fetch the ISTA datasets into an offline build's data/ directory.

Called by ci-fetch-hf-data.sh; separate from it only because the shell script
already carries one heredoc and two do not nest readably.

    python3 scripts/build/fetch_ista.py <dataset> <dist>/data "<glob> <glob> ..."

The check at the end is the point. A snapshot that quietly matches nothing
still exits 0, so the build would succeed and the app would look right until
someone opened it with no internet -- which is the one thing an offline build
exists to survive. Each set therefore has to arrive with at least a floor of
files, and the two indexes the scan cannot run without have to be present by
name.
"""
import os
import sys
import shutil
import zipfile

from huggingface_hub import snapshot_download

# ANONYMOUS DOWNLOADS ARE RATE LIMITED HARD. A release fetches tens of
# thousands of small files, and without a token the hub starts answering 429
# part way through -- the build then crawls at one file per 245-second
# backoff. The workflow already holds an HF_TOKEN secret; passing it makes
# the same fetch run at full speed. It stays optional so a fork without the
# secret still builds, just slowly.

# a floor, not a count: these grow, and an exact number would fail every time
# the data is regenerated. What matters is that the set is not empty or a stub.
# bundles is one .ista per chassis -- 26 today, so 20 leaves room for a
# chassis to be dropped without failing the build.
FLOORS = {"ecu-tree": 40, "bundles": 20, "ecufn": 500}
# the sets that arrive as transport archives (tools/ista/build_extract_bundles.py)
# and are unpacked here: checked only when the archives were asked for
EXTRACT_FLOORS = {"xaml": 100, "infotree": 30, "search": 15, "faultcodes": 500,
                  "testplan": 15, "ecu-names": 15}
# the scan reads both of these directly; without either it falls back to the
# network, which is exactly what this fetch exists to prevent
NEEDED = ("ecu-tree/index.json", "ecu-tree/scan-extras.json")


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__.strip().splitlines()[-1])
    repo, out, want = sys.argv[1:4]
    snapshot_download(
        repo_id=repo,
        repo_type="dataset",
        local_dir=out,
        allow_patterns=want.split(),
        token=os.environ.get("HF_TOKEN") or None,
        max_workers=8,
    )
    # THE REPAIR MANUAL TRAVELS AS ARCHIVES AND LANDS AS FILES. Its 54,655
    # pictures are handed to <img src>, which cannot read from a zip, so a
    # packaged build needs them loose on disk -- but fetching them one at a
    # time is what made this step take fifty minutes. They ship as ~101
    # transport archives and are unpacked here into the layout the app
    # expects. The archives themselves are not part of the build.
    bundles = os.path.join(out, "ista", "repair-bundles")
    if os.path.isdir(bundles):
        dest = os.path.join(out, "ista", "repair")
        os.makedirs(dest, exist_ok=True)
        n = 0
        for name in sorted(os.listdir(bundles)):
            if not name.endswith(".zip"):
                continue
            with zipfile.ZipFile(os.path.join(bundles, name)) as zf:
                zf.extractall(dest)
                n += len(zf.namelist())
        print(f"  repair    {n} files unpacked from archives")
        shutil.rmtree(bundles, ignore_errors=True)

    # THE SCREENS' OWN EXTRACTS TRAVEL THE SAME WAY. The page layouts, the
    # structure trees, the search indexes, the fault code lists, the test
    # plans and the unit names are 9,253 small files the hosted site reads a
    # few at a time; fetched loose here they would be three quarters of an
    # hour of rate limiting. One archive per set, unpacked into the layout
    # the app expects (each holds paths under ista/).
    extracts = os.path.join(out, "ista", "extract-bundles")
    floors = dict(FLOORS)
    if os.path.isdir(extracts):
        n = 0
        for name in sorted(os.listdir(extracts)):
            if not name.endswith(".zip"):
                continue
            with zipfile.ZipFile(os.path.join(extracts, name)) as zf:
                zf.extractall(os.path.join(out, "ista"))
                n += len(zf.namelist())
        print(f"  extracts  {n} files unpacked from archives")
        shutil.rmtree(extracts, ignore_errors=True)
        floors.update(EXTRACT_FLOORS)
    elif "ista/extract-bundles/*" in want.split():
        raise SystemExit("error: ista/extract-bundles matched nothing; without it the ISTA "
                         "pages have no layouts, trees or search in an offline build")

    ista = os.path.join(out, "ista")
    for sub, floor in floors.items():
        d = os.path.join(ista, sub)
        n = len(os.listdir(d)) if os.path.isdir(d) else 0
        if n < floor:
            raise SystemExit(
                f"error: ista/{sub} has {n} files, expected at least {floor} "
                "(the dataset moved, or the pattern matched nothing)"
            )
        print(f"  {sub:10} {n} files")
    for f in NEEDED:
        if not os.path.exists(os.path.join(ista, f)):
            raise SystemExit(f"error: ista/{f} is missing; the tree scan needs it")
    for sub in ("techdata", "repair"):
        d = os.path.join(ista, sub)
        if os.path.isdir(d):
            print(f"  {sub:10} {len(os.listdir(d))} entries")


if __name__ == "__main__":
    main()
