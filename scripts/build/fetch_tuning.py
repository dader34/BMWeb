#!/usr/bin/env python3
"""Fetch the XDF definition library into an offline build's data/ directory.

    python3 scripts/build/fetch_tuning.py <dataset> <dist>/data

A different dataset from everything else the build pulls (bmw-files, not
bmweb-etk), which is why it needs its own step rather than another pattern on
the ISTA fetch. 32 definitions, ~29 MB, so it ships with every variant.

The floor below is the same guard the ISTA fetch carries: snapshot_download
exits 0 when its patterns match nothing, so without it the build would succeed
and the Tuning screen would come up empty only once someone opened it with no
internet.
"""
import os
import sys

from huggingface_hub import snapshot_download

# ANONYMOUS DOWNLOADS ARE RATE LIMITED HARD. A release fetches tens of
# thousands of small files, and without a token the hub starts answering 429
# part way through -- the build then crawls at one file per 245-second
# backoff. The workflow already holds an HF_TOKEN secret; passing it makes
# the same fetch run at full speed. It stays optional so a fork without the
# secret still builds, just slowly.

FLOOR = 20  # 32 today; a floor, so regenerating the library does not fail CI


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: fetch_tuning.py <dataset> <dist>/data")
    repo, out = sys.argv[1:3]
    snapshot_download(
        repo_id=repo,
        repo_type="dataset",
        local_dir=out,
        allow_patterns=["tuning/xdf/*"],
        token=os.environ.get("HF_TOKEN") or None,
        max_workers=8,
    )
    d = os.path.join(out, "tuning", "xdf")
    names = os.listdir(d) if os.path.isdir(d) else []
    xdf = [n for n in names if n.lower().endswith(".xdf")]
    if len(xdf) < FLOOR:
        raise SystemExit(
            f"error: tuning/xdf has {len(xdf)} definitions, expected at least "
            f"{FLOOR} (the dataset moved, or the pattern matched nothing)"
        )
    if not os.path.exists(os.path.join(d, "index.json")):
        raise SystemExit("error: tuning/xdf/index.json is missing; the library needs it")
    print(f"  tuning/xdf {len(xdf)} definitions")


if __name__ == "__main__":
    main()
