#!/usr/bin/env python3
"""Fetch the WDS wiring archives into a build's data/wiring directory.

    python3 scripts/build/fetch_wiring.py <dataset> <dist>/data/wiring

One .wiring per covered chassis, from the dataset's wiring/ folder. The
archives there are COMPLETE: diagrams, descriptions and the photographs, about
1 GB together. A Pages site may hold 1 GB in all, so the photographs (img/,
~85% of the bytes) are dropped here and the build ships diagrams and text,
~150 MB. Pass --photos to keep them.

Standard library only, and no token: fifteen files is nowhere near the
anonymous rate limit.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile

FLOOR = 15  # one per covered chassis


def fetch(url, dest):
    """Download url to dest, retrying what a retry can fix."""
    last = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "fetch_wiring.py"})
            with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        return
                    f.write(chunk)
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (401, 403, 404):
                break
        except (urllib.error.URLError, OSError) as e:
            last = e
        time.sleep(3 * (attempt + 1))
    raise SystemExit(f"error: {url}: {last}")


def drop_photos(src, dest):
    """Copy an archive without its img/ members, each kept as it was stored."""
    kept = 0
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w") as zout:
        for info in zin.infolist():
            if info.filename.startswith("img/"):
                continue
            zout.writestr(info, zin.read(info), compress_type=info.compress_type)
            kept += 1
    return kept


def main():
    args = [a for a in sys.argv[1:] if a != "--photos"]
    photos = "--photos" in sys.argv[1:]
    if len(args) != 2:
        raise SystemExit("usage: fetch_wiring.py [--photos] <dataset> <dist>/data/wiring")
    repo, out = args
    os.makedirs(out, exist_ok=True)
    with urllib.request.urlopen(
        f"https://huggingface.co/api/datasets/{repo}/tree/main/wiring", timeout=60
    ) as r:
        names = sorted(
            e["path"].split("/")[-1]
            for e in json.load(r)
            if e["type"] == "file" and e["path"].endswith(".wiring")
        )
    if len(names) < FLOOR:
        raise SystemExit(
            f"error: {repo}/wiring has {len(names)} archives, expected at least {FLOOR}"
        )
    for name in names:
        dest = os.path.join(out, name)
        part = dest + ".part"
        fetch(f"https://huggingface.co/datasets/{repo}/resolve/main/wiring/{name}", part)
        if photos:
            os.replace(part, dest)
            with zipfile.ZipFile(dest) as z:
                kept = len(z.namelist())
        else:
            kept = drop_photos(part, dest)
            os.remove(part)
        if kept < 2:
            raise SystemExit(f"error: {name} holds {kept} files")
        print(f"  {name:14s} {kept:6d} files {os.path.getsize(dest) // 1024:7d} KB")
    print(f"  {len(names)} wiring archives")


if __name__ == "__main__":
    main()
