#!/usr/bin/env python3
"""The repair manual's body-text index, one file per chassis.

Text Search's "Search in document" box needs the words inside every repair
instruction, and the app must not fetch thousands of body shards to answer
one search. So each chassis gets <CHASSIS>/search-index.json.gz: a map of
document id to that document's text, lowercased, every string the body
carries (step text, hints, torque labels) joined by spaces. repairBodyIndex
in screens/repair/data.js reads exactly that.

    python3 tools/ista/repair_search_index.py --root data/ista/repair
"""
import argparse
import glob
import gzip
import json
import os
import re
import sys

SPACES = re.compile(r"\s+")


def body_text(doc):
    """Every string in a document body, lowercased, joined by spaces.

    Picture ids are numbers and are skipped by construction: only strings
    are collected, wherever they sit in the body's tree.
    @param doc: the body as the extract wrote it
    """
    out = []

    def walk(x):
        if isinstance(x, str):
            out.append(x)
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(doc)
    return SPACES.sub(" ", " ".join(out)).strip().lower()


def load_shard(path):
    """A body shard, gzipped or plain.
    @param path: the shard file
    """
    if path.endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            return json.load(fh)
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def build_chassis(folder):
    """{doc id: text} for one chassis folder.
    @param folder: data/ista/repair/<CHASSIS>
    """
    index = {}
    for shard in sorted(glob.glob(os.path.join(folder, "body", "*"))):
        try:
            data = load_shard(shard)
        except (OSError, ValueError):
            continue
        for doc_id, body in (data or {}).items():
            text = body_text(body)
            if text:
                index[str(doc_id)] = text
    return index


def write_index(folder, index):
    """Write the chassis index, gzipped and deterministic.
    @param folder: the chassis folder
    @param index: {doc id: text}
    """
    raw = json.dumps(index, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    with gzip.GzipFile(os.path.join(folder, "search-index.json.gz"), "wb", mtime=0) as fh:
        fh.write(raw.encode("utf-8"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default="data/ista/repair", help="the repair data folder")
    ap.add_argument("--chassis", help="one chassis only")
    args = ap.parse_args()
    folders = (
        [os.path.join(args.root, args.chassis)]
        if args.chassis
        else sorted(
            p
            for p in glob.glob(os.path.join(args.root, "*"))
            if os.path.isdir(os.path.join(p, "body"))
        )
    )
    stats = {}
    for folder in folders:
        index = build_chassis(folder)
        write_index(folder, index)
        size = os.path.getsize(os.path.join(folder, "search-index.json.gz"))
        stats[os.path.basename(folder)] = {"docs": len(index), "kb": size // 1024}
    print(json.dumps(stats, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
