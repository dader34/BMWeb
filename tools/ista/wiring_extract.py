#!/usr/bin/env python3
"""The workshop tool's own wiring documents, per chassis.

A test module never names a document. It asks for a CLASS with a format
preference, and the tool resolves that against the documents valid for the
car in front of it:

    DocumentHandler(Add, __IndirectDocument(null, "Schaltplan",
                    "Funktionsschaltplan|Bauteilschaltplan"), 0)
    DocumentHandler(Add, __IndirectDocument(null, "Funktionsbeschreibung",
                    "FBFunktionsbeschreibung"), 1)

So the app needs the same document set, under the tool's own identifiers,
gated by the same validity rules. Six classes answer those requests:

    Schaltplan / SchaltplanLanguage   circuit diagrams, SVG
    Funktionsbeschreibung             function descriptions, XML
    Einbauort                         installation locations, XML
    Steckeransicht                    connector views, XML
    Pinbelegung                       pin assignments, XML

Output per chassis, beside the other extracts:

    data/ista/wiring/<CHASSIS>/index.json      one entry per document
    data/ista/wiring/<CHASSIS>/svg/<id>.svgz   the diagrams, gzipped SVG
    data/ista/wiring/<CHASSIS>/body/<nn>.json  the XML documents, sharded

The identifier is the tool's own (SSP-BTS-SP0000011109), so a module's
request resolves against these rows directly rather than through a mapping
of our own invention.

    python3 tools/ista/wiring_extract.py \
        --diagdoc ~/.../DiagDocDb.decrypted.sqlite \
        --content ~/.../xmlvalueprimitive_ENGB.sqlite \
        --chassis E46 --out data/ista/wiring
"""
import argparse
import gzip
import json
import os
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validity_rules import (  # noqa: E402
    chassis_char_ids,
    decode_rule,
    read_char_names,
    read_typekeys,
    rule_applies,
)

# the six classes a module's document request can name, and the short type
# the app stores them under
CLASSES = {
    "Schaltplan": "diagram",
    "SchaltplanLanguage": "diagram",
    "Funktionsbeschreibung": "function",
    "Einbauort": "location",
    "Steckeransicht": "connector",
    "Pinbelegung": "pinout",
}

# how many body shards the XML documents are split across
SHARDS = 64


def node_class_ids(con):
    """Class name -> node class id, for the six classes.

    @param con: an open DiagDocDb connection
    """
    q = ",".join("?" * len(CLASSES))
    rows = con.execute(
        f"SELECT ID, NAME FROM XEP_NODECLASSES WHERE NAME IN ({q})",
        tuple(CLASSES),
    )
    return {r[0]: r[1] for r in rows}


def strip_ns(tag):
    """An XML tag without its namespace.

    @param tag: the raw tag
    """
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def xml_text(raw):
    """An XML document reduced to its readable lines.

    The tool's XML bodies wrap text in element trees whose tag names vary by
    class; what every class has in common is that the words a technician
    reads are the element text. So the text is collected in document order
    rather than by hunting for tags this build happens to know.

    @param raw: the stored document text
    """
    if not raw:
        return None
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return None
    lines = []
    for el in root.iter():
        for part in (el.text, el.tail):
            s = (part or "").strip()
            if s:
                lines.append(re.sub(r"\s+", " ", s))
    return lines or None


def svg_bytes(raw):
    """The SVG of a diagram document, or None when it is not one.

    @param raw: the stored document text
    """
    if not raw:
        return None
    s = raw.lstrip()
    i = s.find("<svg")
    return s[i:] if i >= 0 else None


def read_rows(diag, classes):
    """Every document of the six classes with its content id.

    @param diag: an open DiagDocDb connection
    @param classes: node class id -> class name
    """
    ids = tuple(classes)
    return list(
        diag.execute(
            "SELECT i.ID, i.NODECLASS, i.IDENTIFIER, i.TITLE_ENGB, io.CONTENT_ENGB "
            "FROM XEP_INFOOBJECTS i "
            "JOIN XEP_REFCONTENTS rc ON rc.ID=i.CONTROLID "
            "JOIN XEP_IOCONTENTS io ON io.CONTROLID=rc.CONTENTCONTROLID "
            f"WHERE i.NODECLASS IN {ids} AND io.CONTENT_ENGB>0"
        )
    )


# A location/connector/pinout document names the component it is about in two
# structured places, and ISTA reads both: the identifier's own designator field
# (EBO-EBO-E46_EB6217B is chassis E46, designator B6217) and the title, which
# for a location document IS the designator list ("B6217, X6217"). Nothing here
# matches on words.
DESIGNATOR_IDENT = re.compile(
    r"^(?:EBO|STA|PIB)-(?:EBO|STA|PIB)-[A-Z0-9_]+_[ESP]([A-Z]{1,2}\d{1,6})[A-Z]?$"
)
DESIGNATOR_TITLE = re.compile(r"\b([A-Z]{1,2}\d{2,6})\b")
DESIGNATOR_TYPES = ("location", "connector", "pinout")


def designator_index(index, bodies=None):
    """Map each component designator to the documents that are about it.

    A diagram's anchors carry designators (X6254, B6254, A6000); this is what
    turns a click on one into the component's installation location, connector
    view or pin assignment, the way ISTA opens them.

    ONE COMPONENT, ONE DOCUMENT PER KIND. A document ships as a run of
    revisions -- X6254's installation location is EB6254A through EB6254F --
    that differ only in which build of the car they apply to. Where the
    validity rules leave several of them standing for one car, their text is
    the same text, and offering the technician six identical choices is noise
    dressed up as a decision. So a revision whose body is already listed is
    dropped, and anything that genuinely reads differently is kept.

    @param index: the chassis index entries
    @param bodies: doc id (str) -> its rendered lines, when they are to hand
    @returns designator -> list of {id, type, title, identifier}
    """
    text = bodies or {}
    out = {}
    for entry in index:
        if entry["type"] not in DESIGNATOR_TYPES:
            continue
        keys = []
        hit = DESIGNATOR_IDENT.match(entry["identifier"])
        if hit:
            keys.append(hit.group(1))
        keys.extend(DESIGNATOR_TITLE.findall(entry["title"]))
        seen = set()
        body = tuple(text.get(str(entry["id"])) or ())
        for key in keys:
            if key in seen:
                continue
            seen.add(key)
            row = out.setdefault(key, [])
            if any(d["id"] == entry["id"] for d in row):
                continue
            # a revision that reads exactly like one already offered here
            if body and any(
                d["_body"] == body and d["type"] == entry["type"] for d in row
            ):
                continue
            row.append(
                {
                    "id": entry["id"],
                    "type": entry["type"],
                    "title": entry["title"],
                    "identifier": entry["identifier"],
                    "_body": body,
                }
            )
    for row in out.values():
        for doc in row:
            del doc["_body"]
    return out


def write_chassis(rows, rules, classes, ids, content, folder, verbose=False):
    """Write one chassis's documents; return its counts.

    A document with no rule applies to everything, and one whose rule cannot
    be decoded is kept rather than dropped: the same direction the other
    extracts err in, because a diagram that might apply is a smaller problem
    than a diagram that silently went missing.

    @param rows: read_rows output
    @param rules: doc id -> validity blob
    @param classes: node class id -> class name
    @param ids: the chassis's characteristic value ids
    @param content: a Content reader
    @param folder: data/ista/wiring/<CHASSIS>
    @param verbose: print progress
    """
    os.makedirs(os.path.join(folder, "svg"), exist_ok=True)
    os.makedirs(os.path.join(folder, "body"), exist_ok=True)
    index = []
    shards = {}
    stats = {"kept": 0, "diagrams": 0, "documents": 0, "nobody": 0, "unsure": 0}
    for n, (doc_id, node_class, identifier, title, content_id) in enumerate(rows):
        tree, unsure = decode_rule(rules.get(doc_id))
        if not unsure and not rule_applies(tree, ids):
            continue
        kind = CLASSES[classes[node_class]]
        raw = content.get(content_id)
        entry = {
            "id": doc_id,
            "identifier": identifier or "",
            "title": (title or "").strip(),
            "type": kind,
        }
        if unsure:
            entry["unsure"] = True
            stats["unsure"] += 1
        if kind == "diagram":
            svg = svg_bytes(raw)
            if svg is None:
                stats["nobody"] += 1
                continue
            with gzip.GzipFile(
                os.path.join(folder, "svg", f"{doc_id}.svgz"), "wb", mtime=0
            ) as fh:
                fh.write(svg.encode("utf-8"))
            stats["diagrams"] += 1
        else:
            lines = xml_text(raw)
            if lines is None:
                stats["nobody"] += 1
                continue
            shard = f"{doc_id % SHARDS:02d}"
            shards.setdefault(shard, {})[str(doc_id)] = lines
            entry["shard"] = shard
            stats["documents"] += 1
        index.append(entry)
        stats["kept"] += 1
        if verbose and n and n % 20000 == 0:
            print(f"  {n} of {len(rows)} rows...", file=sys.stderr)
    for shard, docs in shards.items():
        raw = json.dumps(docs, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with open(os.path.join(folder, "body", f"{shard}.json"), "w", encoding="utf-8") as fh:
            fh.write(raw)
    index.sort(key=lambda e: (e["type"], e["identifier"]))
    # every rendered body, flat, so the designator index can tell a genuine
    # second document from another revision of the first
    bodies = {}
    for docs in shards.values():
        bodies.update(docs)
    with open(os.path.join(folder, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(
            {
                "chassis": os.path.basename(folder),
                "documents": index,
                "designators": designator_index(index, bodies),
            },
            fh,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    return stats


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--diagdoc", required=True, help="DiagDocDb.decrypted.sqlite")
    ap.add_argument("--content", required=True, help="xmlvalueprimitive_ENGB.sqlite")
    ap.add_argument("--chassis", default="E46", help="development codes, comma separated")
    ap.add_argument("--out", default="data/ista/wiring", help="output folder")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    diag = sqlite3.connect(f"file:{args.diagdoc}?mode=ro", uri=True)
    diag.execute("PRAGMA query_only=1")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from diag_structure_extract import Content  # noqa: E402

    content = Content(args.content)
    classes = node_class_ids(diag)
    rows = read_rows(diag, classes)
    rules = {r[0]: r[1] for r in diag.execute("SELECT ID, RULE FROM XEP_RULES")}
    typekeys = read_typekeys(diag)
    char_names = read_char_names(diag)
    if args.verbose:
        print(f"{len(rows)} documents across {len(classes)} classes", file=sys.stderr)

    out = {}
    for chassis in [c.strip().upper() for c in args.chassis.split(",") if c.strip()]:
        ids = chassis_char_ids(typekeys, char_names, chassis)
        folder = os.path.join(args.out, chassis)
        stats = write_chassis(rows, rules, classes, ids, content, folder, args.verbose)
        size = sum(
            os.path.getsize(os.path.join(dp, f))
            for dp, _dn, fn in os.walk(folder)
            for f in fn
        )
        stats["mb"] = round(size / 1e6, 1)
        out[chassis] = stats
    print(json.dumps(out, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
