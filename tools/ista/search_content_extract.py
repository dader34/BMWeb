#!/usr/bin/env python3
"""Extract a word index for ISTA's "Search in document", small enough to ship.

The tool answers a content search from an FTS4 index over every document
body (xmlvalueprimitive_ENGB.sqlite, `fts`), asking it for each term as a
prefix: DATA MATCH '"term*"' (GetMatchingInfoObjectIdsForContentSearch).
The bodies are fifteen gigabytes. What a search needs from them is far
less: which documents hold which words.

SO THIS SHIPS THE WORDS, NOT THE BODIES. One inverted index for every
chassis at once:

    content/ids.json.gz     every indexed document's id, in order; a
                            document is named in the index by its place here
    content/<xx>.json.gz    the words starting with the two characters xx:
                            {"<word>": [first place, then the gaps], ...}

A search fetches only the shards its terms start with (a few tens of
kilobytes each), reads every word that begins with the term, and joins the
places. The chassis's own search index (search_index_extract.py) then says
which of those documents this car may see, exactly as for a title hit.

WHICH DOCUMENTS: the ones some chassis's search index lists, so the union
of data/ista/search/<CHASSIS>.json.gz. Run that extract first.

WHICH WORDS: the tool's tokenizer is FTS4's "simple" one, lower-cased runs
of letters and digits, and so is this. Three departures, each to keep the
index small or honest:
  - the tool indexes the stored XML as it is, markup and all, so a search
    for "paragraph" matches every document with a PARAGRAPH tag. Here only
    the text a reader sees is indexed.
  - words of one character are left out, and so is a short list of English
    function words nobody searches a workshop manual for.
  - a search term must have two characters to pick a shard.

A document's words come from the tool's own copy of the body
(fts_content), found from the document by the tool's own join
(GetInfoObjectIdsByIoContents).

    python3 tools/ista/search_content_extract.py

The output is BMW-derived data: data/ista/ is gitignored and hosted like
the rest of the ISTA extracts.
"""
import argparse
import glob
import gzip
import html
import json
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
sys.path.insert(0, HERE)

from diag_structure_extract import write_json_gz  # noqa: E402

BMWFILES = os.environ.get("BMWFILES", os.path.expanduser("~/Development/code/BMWFILES"))

TAG = re.compile(r"<[^>]*>")
# FTS4 "simple": ASCII letters and digits, and every character above ASCII
WORD = re.compile(r"[0-9a-z\u0080-￿]+")

STOP = frozenset(
    "the and of to in is a an for with on be or at by as are it this that from "
    "not if when all can must may will has have been was were its into than "
    "then there these those their which only also".split())


def words(data):
    """The distinct indexed words of one stored body."""
    text = html.unescape(TAG.sub(" ", data or "")).lower()
    return {w for w in WORD.findall(text) if len(w) >= 2 and w not in STOP}


def shard_of(word):
    """The file a word is in: its first two characters, when plain ASCII."""
    key = word[:2]
    return key if re.fullmatch(r"[0-9a-z]{2}", key) else "__"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--db", default=os.path.join(
        BMWFILES, "ista", "databases", "DiagDocDb.decrypted.sqlite"))
    ap.add_argument("--content", default=os.path.join(
        BMWFILES, "ista", "databases", "xmlvalueprimitive_ENGB.sqlite"))
    ap.add_argument("--search", default=os.path.join(ROOT, "data", "ista", "search"))
    ns = ap.parse_args()
    for path in (ns.db, ns.content):
        if not os.path.exists(path):
            raise SystemExit(f"no database at {path} (see $BMWFILES/ista/README.md)")

    # the documents some chassis can find
    wanted = set()
    for path in glob.glob(os.path.join(ns.search, "*.json.gz")):
        if os.path.basename(path) == "terms.json.gz":
            continue
        with gzip.open(path, "rt", encoding="utf-8") as f:
            wanted.update(d[0] for d in json.load(f)["docs"])
    if not wanted:
        raise SystemExit(f"no chassis indexes in {ns.search}: run search_index_extract.py first")
    ids = sorted(wanted)
    place = {doc: n for n, doc in enumerate(ids)}

    # body -> the documents that show it (GetInfoObjectIdsByIoContents)
    diag = sqlite3.connect(f"file:{ns.db}?mode=ro", uri=True)
    shows = {}
    for doc, body in diag.execute(
            "SELECT info.ID, cont.CONTENT_ENGB FROM XEP_INFOOBJECTS info "
            "JOIN XEP_REFCONTENTS ref ON ref.ID = info.CONTROLID "
            "JOIN XEP_IOCONTENTS cont ON cont.CONTROLID = ref.CONTENTCONTROLID "
            "WHERE cont.CONTENT_ENGB IS NOT NULL"):
        if doc in place:
            shows.setdefault(body, []).append(place[doc])
    print(f"  {len(ids)} documents, {len(shows)} bodies to read", file=sys.stderr)

    store = sqlite3.connect(f"file:{ns.content}?mode=ro", uri=True)
    postings = {}
    read = 0
    for body, data in store.execute("SELECT c0id, c1data FROM fts_content"):
        try:
            body = int(body)
        except (TypeError, ValueError):
            continue
        docs = shows.get(body)
        if not docs:
            continue
        if isinstance(data, bytes):
            data = data.decode("utf-8", "replace")
        for word in words(data):
            postings.setdefault(word, set()).update(docs)
        read += 1
        if read % 20000 == 0:
            print(f"  {read} bodies, {len(postings)} words...", file=sys.stderr)

    out = os.path.join(ns.search, "content")
    os.makedirs(out, exist_ok=True)
    for old in glob.glob(os.path.join(out, "*.json.gz")):
        os.remove(old)
    total = write_json_gz(os.path.join(out, "ids.json.gz"), ids)
    shards = {}
    for word, docs in postings.items():
        seq = sorted(docs)
        # the first place, then the gap to each next one
        gaps = [seq[0]] + [b - a for a, b in zip(seq, seq[1:])]
        shards.setdefault(shard_of(word), {})[word] = gaps
    biggest = 0
    for key, table in shards.items():
        size = write_json_gz(os.path.join(out, f"{key}.json.gz"), table)
        total += size
        biggest = max(biggest, size)
    print(f"  {read} bodies read, {len(postings)} words in {len(shards)} shards; "
          f"{total // (1024 * 1024)} MB in all, largest shard {biggest // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
