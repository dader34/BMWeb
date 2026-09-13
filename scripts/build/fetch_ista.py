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

from huggingface_hub import snapshot_download

# a floor, not a count: these grow, and an exact number would fail every time
# the data is regenerated. What matters is that the set is not empty or a stub.
FLOORS = {"ecu-tree": 40, "abl": 1000, "ecufn": 500}
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
        max_workers=8,
    )
    ista = os.path.join(out, "ista")
    for sub, floor in FLOORS.items():
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
    for sub in ("diag", "techdata", "wiring", "repair"):
        d = os.path.join(ista, sub)
        if os.path.isdir(d):
            print(f"  {sub:10} {len(os.listdir(d))} entries")


if __name__ == "__main__":
    main()
