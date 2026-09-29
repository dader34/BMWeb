#!/usr/bin/env python3
"""Fetch the generated data the tools and the build read.

    python3 scripts/setup/fetch_repo_data.py [--force]

data/, app/renderer/data/ and the ISTA test fixtures are generated from a BMW
Standard Tools install and are not in this repository. They are published as
one archive, repo-data/repo-data.tar, in the bmw-files dataset, and unpacked
here to the paths everything has always read them from. CI runs this before
it builds; a fresh clone runs it once.

The archive is pinned by checksum in scripts/setup/repo-data.sha256, so a
build knows it got the data it was written against. After regenerating data,
repack the archive, publish it, and commit the new checksum.

ONE ARCHIVE, NOT LOOSE FILES. This is 6,300 files, and Hugging Face rate
limits anonymous downloads at 500 per 300 s, so fetching them one at a time
fails part way through.

REPO_DATA overrides the source with a local file or a URL, for testing an
archive before it is published. Standard library only.
"""
import hashlib
import os
import sys
import tarfile
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PIN = os.path.join(ROOT, "scripts", "setup", "repo-data.sha256")
# the checksum last unpacked, so a second run is a no-op (data/ is ignored)
STAMP = os.path.join(ROOT, "data", ".repo-data")
MIRRORS = ["CraigFf/bmw-files", "HarryG8/bmw-files", "VerilP0/bmw-files"]
# only these are unpacked, whatever the archive holds
ROOTS = ("data/", "app/renderer/data/", "tools/verify/fixtures/")
# hand-maintained and committed; an archive copy must not overwrite it
KEEP = ("data/service-functions.json",)


def download(urls, dest):
    last = None
    for url in urls:
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "fetch_repo_data.py"})
                with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            return url
                        f.write(chunk)
            except urllib.error.HTTPError as e:
                last = e
                if e.code in (401, 403, 404):
                    break  # this mirror does not have it; try the next
            except (urllib.error.URLError, OSError) as e:
                last = e
            time.sleep(3 * (attempt + 1))
    raise SystemExit(f"error: no source answered ({last})")


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def unpack(path):
    n = 0
    with tarfile.open(path, "r") as tar:
        for info in tar:
            if not info.isfile() or info.name in KEEP:
                continue
            dest = os.path.abspath(os.path.join(ROOT, info.name))
            if not info.name.startswith(ROOTS) or not dest.startswith(ROOT + os.sep):
                raise SystemExit(f"error: refusing archive member {info.name!r}")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            src = tar.extractfile(info)
            with open(dest, "wb") as f:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            n += 1
    return n


def main():
    with open(PIN, encoding="utf-8") as f:
        want = f.read().split()[0]
    try:
        with open(STAMP, encoding="utf-8") as f:
            have = f.read().strip()
    except OSError:
        have = ""
    if have == want and "--force" not in sys.argv[1:]:
        print(f"repo data up to date ({want[:16]})")
        return
    src = os.environ.get("REPO_DATA")
    if src and os.path.isfile(src):
        path, temp = src, False
    else:
        os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
        path, temp = os.path.join(ROOT, "data", ".repo-data.tar.part"), True
        urls = [src] if src else [
            f"https://huggingface.co/datasets/{m}/resolve/main/repo-data/repo-data.tar"
            for m in MIRRORS
        ]
        print(f"fetched {download(urls, path)}")
    try:
        got = sha256_of(path)
        if got != want:
            raise SystemExit(
                f"error: the archive is {got[:16]}, this checkout is pinned to "
                f"{want[:16]} (scripts/setup/repo-data.sha256)"
            )
        n = unpack(path)
    finally:
        if temp and os.path.exists(path):
            os.remove(path)
    with open(STAMP, "w", encoding="utf-8") as f:
        f.write(want + "\n")
    print(f"unpacked {n} files ({want[:16]})")


if __name__ == "__main__":
    main()
