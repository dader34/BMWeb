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
    content/<xx>.json.gz    the words of two characters and more that
                            start with xx:
                            {"<word>": [first place, then the gaps], ...}

A search fetches only the shards its terms start with (a few tens of
kilobytes each), reads every word that begins with the term, and joins the
places. The chassis's own search index (search_index_extract.py) then says
which of those documents this car may see, exactly as for a title hit.

WHICH DOCUMENTS: the ones some chassis's search index lists, so the union
of data/ista/search/<CHASSIS>.json.gz. Run that extract first.

WHICH WORDS: exactly the tool's. Its index is FTS4 with the "simple"
tokenizer over the stored XML as it is, markup and all: lower-cased runs of
ASCII letters and digits, and of anything above ASCII. So a tool number in
an attribute is found, and so is a tag's name; and every word is kept,
however short or common, because a term the tool would match must match
here.

A ONE-CHARACTER TERM is a prefix too, and matches any word beginning with
that character. Rather than every shard that starts with it, a search
fetches one list made for the purpose:

    content/1<x>.json.gz    every document holding a word that begins
                            with x: {"": [first place, then the gaps]}

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
import json
import os
import re
import sqlite3
import sys
from array import array

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
sys.path.insert(0, HERE)

from diag_structure_extract import write_json_gz  # noqa: E402

BMWFILES = os.environ.get("BMWFILES", os.path.expanduser("~/Development/code/BMWFILES"))

# FTS4 "simple": ASCII letters and digits, and every character above ASCII
WORD = re.compile("[0-9a-z\\u0080-\\U0010ffff]+")
FOLD = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
PLAIN = re.compile("[0-9a-z]")


def words(data):
    """The distinct words the tool's index holds for one stored body.

    The simple tokenizer folds ASCII case only and reads the text as it is
    stored, so nothing is stripped or unescaped first.
    """
    return set(WORD.findall((data or "").translate(FOLD)))


def shard_of(word):
    """The file a word of two characters or more is in."""
    key = word[:2]
    return key if PLAIN.fullmatch(key[0]) and PLAIN.fullmatch(key[1]) else "__"


def initial_of(word):
    """The one-character list a word belongs to."""
    return word[0] if PLAIN.fullmatch(word[0]) else "_"


def gaps_of(places):
    """Places as the first one, then the gap to each next."""
    seq = sorted(set(places))
    return [seq[0]] + [b - a for a, b in zip(seq, seq[1:])]


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
    initials = {}
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
        found = words(data)
        for word in found:
            got = postings.get(word)
            if got is None:
                got = postings[word] = array("I")
            got.extend(docs)
        for first in {initial_of(w) for w in found}:
            got = initials.get(first)
            if got is None:
                got = initials[first] = array("I")
            got.extend(docs)
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
        # a one-character word is answered by its initial's list
        if len(word) >= 2:
            shards.setdefault(shard_of(word), {})[word] = gaps_of(docs)
    for first, docs in initials.items():
        shards[f"1{first}"] = {"": gaps_of(docs)}
    biggest = 0
    for key, table in shards.items():
        size = write_json_gz(os.path.join(out, f"{key}.json.gz"), table)
        total += size
        biggest = max(biggest, size)
    print(f"  {read} bodies read, {len(postings)} words in {len(shards)} files; "
          f"{total // (1024 * 1024)} MB in all, largest file {biggest // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
