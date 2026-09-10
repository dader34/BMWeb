#!/usr/bin/env python3
"""Extract ISTA's workshop reference documents into the app's data folder.

Five document classes, one shape. Each is an entry in the index with a
validity RULE, and a body in the content store:

    TechnischeDaten     5,915  capacities, clearances, alignment, brakes
    Anziehdrehmoment    3,634  tightening-torque tables
    Betriebsstoffe        216  operating-fluid service-information chapters
    Spezialwerkzeug     7,104  special tools
    SISpezialwerkzeuge  2,793  service information about special tools

TWO DATABASES, index and content, the way ista_extract.py already reads them
(and the way ISTA's own connector does):

    DiagDocDb.decrypted.sqlite        the STRUCTURE
      XEP_INFOOBJECTS.NODECLASS -> which of the five classes
      XEP_INFOOBJECTS.CONTROLID -> XEP_REFCONTENTS.ID
        -> .CONTENTCONTROLID    -> XEP_IOCONTENTS.CONTROLID
        -> .CONTENT_ENGB        -> a content id      (100% coverage, verified)
      XEP_RULES.ID = the doc id -> the validity blob
      XEP_VEHICLES + XEP_CHARACTERISTICS -> a type key's characteristic set
         │
         ▼
    xmlvalueprimitive_ENGB.sqlite     the CONTENT

THE VALIDITY RULE is a small expression tree, not a bag of ids. The blob is
a prefix encoding:

    0x01  AND   int32 LE operand count, then that many operands
    0x02  OR    the same
    0x10  NOT   one operand
    0x11  EQ    int64 LE characteristic-root id, int64 LE value id

96.7% of the 19,618 rules parse to exactly the length of their blob -- no
trailing bytes, which is what says the grammar is right rather than merely
plausible. The other 3.3% open with one of five opcodes nobody has decoded
(0x03, 0x04, 0x09, 0x0e, 0x0f, 0x12, 0x13; they look like date or I-level
comparisons). Those documents are kept and flagged `unsure`: a workshop
would rather see a document that might not apply than silently lose one
that does. The app marks them.

(The older tools/wiring/ista_rules.py reads the same blobs by scanning for
any 4-byte value that happens to be a known characteristic id. That finds
the ids but cannot see AND/OR/NOT, so it cannot tell "E46 and M54" from
"E46 or M54". This decodes the structure instead. It is left alone because
the wiring index is built against its behaviour.)

Output, under data/ista/techdata/ (gitignored, uploaded to the dataset):

    index.json          every doc: id, class, title, group numbers, rule tree,
                        `unsure`, and the shard its body is in
    roots.json          characteristic-root id -> name ("Engine", "Body", ...)
    typekeys.json       type key -> {root id: [value ids]}, for the car filter
    body/<class>-<group>.json   bodies, sharded by class and main group

Usage:
    tools/ista/technical_data_extract.py \
        --diagdoc ~/.../DiagDocDb.decrypted.sqlite \
        --content ~/.../xmlvalueprimitive_ENGB.sqlite \
        --out data/ista/techdata [--limit N]
"""
import argparse
import json
import os
import sqlite3
import struct
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
# the table and block walkers are the same ones the fault extractor uses; the
# document bodies here are the same CALS tables and PARAGRAPH/LIST prose
from ista_extract import Content, _collect_blocks, _flat, _parse_table

# ---- the five classes -------------------------------------------------------
# id -> (slug, the label the app's "Type" column shows)
CLASSES = {
    46478722: ("techdata", "Technical data"),
    46453506: ("torque", "Tightening torques"),
    46463234: ("fluids", "Operating fluids"),
    46451074: ("tools", "Special tools"),
    46460546: ("tools", "Special tools"),
}

# ISTA's own top-level tree for the workshop-equipment side. Documents that
# carry a main group of their own (technical data, torques) are filed under
# that instead; these are the nodes the equipment classes hang from.
EQUIPMENT_TREE = [
    ("0", "General"),
    ("1", "Special tools"),
    ("2", "Measurement / test equipment / operating instructions"),
    ("3", "Wheel alignment"),
    ("4", "Washing and cleaning systems"),
    ("5", "Body repairs / painting"),
    ("6", "Lifting equipment"),
    ("7", "Tyre service"),
    ("8", "Other equipment"),
]

# Rule opcodes.
OP_AND, OP_OR, OP_NOT, OP_EQ = 0x01, 0x02, 0x10, 0x11

# How many files the special tools are split across (see shard_key).
TOOLS_SHARDS = 8


class RuleParseError(Exception):
    """A rule used an opcode this decoder does not know."""


def parse_rule(blob, pos=0):
    """Decode a validity blob into a small expression tree.

    Returns (tree, next position). A tree node is one of:
        {"op": "and"|"or", "kids": [...]}
        {"op": "not", "kids": [one]}
        {"op": "eq", "root": <root id>, "val": <value id>}
    Raises RuleParseError on an opcode outside the decoded grammar, so the
    caller can flag the document rather than guess at its applicability.
    """
    if pos >= len(blob):
        raise RuleParseError("rule ended early")
    op = blob[pos]
    pos += 1
    if op in (OP_AND, OP_OR):
        (count,) = struct.unpack_from("<i", blob, pos)
        pos += 4
        if count < 0 or count > 4096:
            raise RuleParseError(f"implausible operand count {count}")
        kids = []
        for _ in range(count):
            kid, pos = parse_rule(blob, pos)
            kids.append(kid)
        return {"op": "and" if op == OP_AND else "or", "kids": kids}, pos
    if op == OP_NOT:
        kid, pos = parse_rule(blob, pos)
        return {"op": "not", "kids": [kid]}, pos
    if op == OP_EQ:
        (root,) = struct.unpack_from("<q", blob, pos)
        (val,) = struct.unpack_from("<q", blob, pos + 8)
        return {"op": "eq", "root": root, "val": val}, pos + 16
    raise RuleParseError(f"opcode {op:#04x}")


def decode_rule(blob):
    """(tree, unsure) for a validity blob.

    A rule that does not decode, or that decodes but leaves bytes over,
    yields (None, True): no rule the app can evaluate, and a flag saying the
    document's applicability was not established. A document with no rule at
    all is (None, False) -- it applies to everything, which is a real answer.
    """
    if not blob:
        return None, False
    try:
        tree, pos = parse_rule(blob, 0)
    except (RuleParseError, struct.error):
        return None, True
    if pos != len(blob):
        # decoded, but not all of it -- treat as undecoded rather than
        # trusting a tree built from part of the blob
        return None, True
    return tree, False


# ---- the document bodies ----------------------------------------------------
def _validity(el):
    """A VALIDITY / VALIDITIES element as a flat dict of its children."""
    out = {}
    for child in el:
        text = _flat(child)
        if text:
            out[child.tag.lower()] = text
    return out


def parse_technical_data(root):
    """<TECHNICALDATA> -> {group numbers, name, validity, blocks}."""
    out = {"blocks": []}
    sub = root.find(".//SUBGROUPTITLE")
    if sub is not None:
        for tag, key in (
            ("MAINGROUPNUMBER", "mainGroup"),
            ("MAINGROUPNAME", "mainGroupName"),
            ("SUBGROUPNUMBER", "subGroup"),
            ("SUBGROUPNAME", "subGroupName"),
        ):
            el = sub.find(tag)
            if el is not None and _flat(el):
                out[key] = _flat(el)
    vals = [_validity(v) for v in root.findall(".//VALIDITY")]
    vals = [v for v in vals if v]
    if vals:
        out["validity"] = vals
    out["blocks"] = _collect_blocks(root)
    return out


def parse_tightening_torques(root):
    """<TIGHTENINGTORQUES> -> group numbers plus the torque rows.

    The torque table is not prose: every row is a part, a thread, a step and
    a figure with a unit, and the app wants those as columns rather than as
    one run-together sentence. So the rows are read from the source's own
    RELATION / SCREW / OPERATINGSTEP / TORQUE elements where they exist, and
    fall back to the generic CALS walk where they do not.
    """
    out = {}
    title = root.find("TITLE")
    if title is not None:
        for tag, key in (
            ("MAINGROUPNUMBER", "mainGroup"),
            ("MAINGROUPNAME", "mainGroupName"),
        ):
            el = title.find(tag)
            if el is not None and _flat(el):
                out[key] = _flat(el)
    sub = root.find("SUBGROUPTITLE")
    if sub is not None:
        for tag, key in (
            ("MAINGROUPNUMBER", "mainGroup"),
            ("SUBGROUPNUMBER", "subGroup"),
            ("SUBGROUPNAME", "subGroupName"),
        ):
            el = sub.find(tag)
            if el is not None and _flat(el):
                out.setdefault(key, _flat(el))

    rows = []
    for row in root.iter("ROW"):
        rel = row.find(".//RELATION")
        screw = row.find(".//SCREW")
        step = row.find(".//OPERATINGSTEP")
        torque = row.find(".//TORQUE")
        if rel is None and screw is None and torque is None:
            continue
        item = {}
        if rel is not None and _flat(rel):
            item["part"] = _flat(rel)
        if screw is not None and _flat(screw):
            item["thread"] = _flat(screw)
        if step is not None and _flat(step):
            item["step"] = _flat(step)
        if torque is not None:
            measure = torque.find(".//MEASURE")
            unit = torque.find(".//UNIT")
            item["torque"] = _flat(measure) if measure is not None else _flat(torque)
            if unit is not None and _flat(unit):
                item["unit"] = _flat(unit)
        # per-row engine validity: the same table serves several engines and
        # the row says which, so the app can tag it
        engines = [_flat(e) for e in row.iter("ENGINE")]
        engines = [e for e in engines if e]
        if engines:
            item["engines"] = sorted(set(engines))
        if item:
            rows.append(item)
    if rows:
        out["torques"] = rows
    else:
        # no structured rows: keep the table as it stands
        tables = [_parse_table(t) for t in root.iter("TABLE")]
        tables = [t for t in tables if t]
        if tables:
            out["blocks"] = [{"t": "table", "rows": t} for t in tables]
    return out


def parse_si_enclosure(root):
    """<SI-ENCLOSURE> -> {title, hint, blocks}: a prose service chapter."""
    out = {}
    title = root.find("TITLE")
    if title is not None and _flat(title):
        out["title"] = _flat(title)
    head = root.find(".//HEADLINE")
    if head is not None and _flat(head):
        out["headline"] = _flat(head)
    hints = [_flat(h) for h in root.iter("HINT")]
    hints = [h for h in hints if h]
    if hints:
        out["hints"] = hints
    out["blocks"] = _collect_blocks(root)
    return out


def parse_special_tool(root):
    """<SPECIALTOOLDOCUMENT> -> the tool's numbers and what it is."""
    out = {}
    for tag, key in (
        ("TOOLNUMBER", "toolNumber"),
        ("TOOLNUMBEROLD", "toolNumberOld"),
        ("DESIGNATION", "designation"),
        ("REMARK", "remark"),
        ("CATEGORY", "category"),
    ):
        el = root.find(tag)
        if el is not None and _flat(el):
            out[key] = _flat(el)
    blocks = _collect_blocks(root)
    if blocks:
        out["blocks"] = blocks
    return out


# root element -> the parser for it
BODY_PARSERS = {
    "TECHNICALDATA": parse_technical_data,
    "TIGHTENINGTORQUES": parse_tightening_torques,
    "SI-ENCLOSURE": parse_si_enclosure,
    "SPECIALTOOLDOCUMENT": parse_special_tool,
}


def parse_body(xml):
    """A document body -> its structured form, or None when unparseable."""
    if not xml:
        return None
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    parser = BODY_PARSERS.get(root.tag)
    if parser is None:
        # an unexpected root still yields its prose rather than nothing
        blocks = _collect_blocks(root)
        return {"blocks": blocks} if blocks else None
    return parser(root)


# ---- the vehicle characteristic maps ---------------------------------------
def read_roots(con):
    """Characteristic-root id -> its English name."""
    return {
        str(rid): name
        for rid, name in con.execute(
            "SELECT ID, TITLE_ENGB FROM XEP_CHARACTERISTICROOTS "
            "WHERE TITLE_ENGB IS NOT NULL AND TITLE_ENGB<>''"
        )
    }


def read_typekeys(con):
    """Type key (VIN chars 4-7) -> {root id: [value ids]}.

    This is what turns a car into something a rule can be evaluated against:
    the rule asks "is characteristic X among this car's", and this is the
    set. Values are grouped by root so the app can also SHOW them (the
    development code, engine, body and so on) without a second query.
    """
    out = {}
    for tk, root, cid in con.execute(
        "SELECT tk.NAME, c.PARENTID, c.ID FROM XEP_VEHICLES v "
        "JOIN XEP_CHARACTERISTICS c ON c.ID=v.CHARACTERISTICID "
        "JOIN XEP_CHARACTERISTICS tk ON tk.ID=v.TYPEKEYID "
        "WHERE tk.NAME IS NOT NULL AND tk.NAME<>''"
    ):
        by_root = out.setdefault(tk.upper(), {})
        vals = by_root.setdefault(str(root), [])
        if cid not in vals:
            vals.append(cid)
    return out


def read_char_names(con):
    """Characteristic value id -> its name, for showing a car's build."""
    return {
        str(cid): name
        for cid, name in con.execute(
            "SELECT ID, NAME FROM XEP_CHARACTERISTICS "
            "WHERE NAME IS NOT NULL AND NAME<>''"
        )
    }


# ---- the extraction ---------------------------------------------------------
def group_number(main_group):
    """The main group as its bare number.

    The source is not consistent: alongside "11" it carries "67-1", "11-30",
    "13 32" and even "65 Airbagsteuergerät". They all mean the group the
    number starts with, so the leading digits are the group and the rest is
    noise from however that particular document was authored. Anything with
    no leading digit files under 00.
    """
    text = str(main_group or "").strip()
    digits = ""
    for ch in text:
        if ch.isdigit():
            digits += ch
        else:
            break
    return digits.zfill(2)[:2] if digits else "00"


def shard_key(cls, main_group, doc_id=None):
    """Which body shard a document belongs in.

    One shard per class per main group, EXCEPT the special tools: all 9,785
    of them declare group 1, so that rule alone would build a single 5 MB
    file the app must fetch to show one spanner. They are split further by
    the last digit of the document id -- an arbitrary but even split, which
    is all that is wanted since nothing about a tool's number predicts which
    tool someone wants next.
    """
    grp = group_number(main_group)
    if cls == "tools" and doc_id is not None:
        return f"{cls}-{grp}-{abs(int(doc_id)) % TOOLS_SHARDS:02d}"
    return f"{cls}-{grp}"


def extract(diag, content, limit=None, verbose=False):
    """Walk every document of the five classes into an index and body shards.

    Returns (index, shards, stats).
    """
    cur = diag.cursor()
    ids = tuple(CLASSES)
    sql = (
        "SELECT i.ID, i.NODECLASS, i.TITLE_ENGB, io.CONTENT_ENGB "
        "FROM XEP_INFOOBJECTS i "
        "JOIN XEP_REFCONTENTS rc ON rc.ID=i.CONTROLID "
        "JOIN XEP_IOCONTENTS io ON io.CONTROLID=rc.CONTENTCONTROLID "
        f"WHERE i.NODECLASS IN {ids} AND io.CONTENT_ENGB>0"
    )
    rules = {r[0]: r[1] for r in cur.execute("SELECT ID, RULE FROM XEP_RULES")}

    index = []
    shards = {}
    stats = {
        "docs": 0,
        "bodies": 0,
        "unsure": 0,
        "norule": 0,
        "per_class": {},
    }
    rows = list(cur.execute(sql))
    if limit:
        rows = rows[:limit]
    for doc_id, node_class, title, content_id in rows:
        cls, type_label = CLASSES[node_class]
        body = parse_body(content.get(content_id))
        stats["docs"] += 1
        stats["per_class"][cls] = stats["per_class"].get(cls, 0) + 1
        if body is None:
            continue
        stats["bodies"] += 1
        tree, unsure = decode_rule(rules.get(doc_id))
        if unsure:
            stats["unsure"] += 1
        elif tree is None:
            stats["norule"] += 1

        main_group = body.get("mainGroup")
        entry = {
            "id": doc_id,
            "cls": cls,
            "type": type_label,
            "title": (title or body.get("title") or "").strip(),
        }
        for key in ("mainGroup", "mainGroupName", "subGroup", "subGroupName"):
            if body.get(key):
                entry[key] = body[key]
        # the special tools are the equipment tree's node 1; everything else
        # files under the main group its own body declares
        if cls == "tools":
            entry["mainGroup"] = "1"
            entry.setdefault("mainGroupName", "Special tools")
            main_group = "1"
        # the tree keys on the group NUMBER, so file and show the normalised
        # one -- otherwise "67-1" and "67" build two nodes for one group
        if entry.get("mainGroup"):
            entry["mainGroup"] = group_number(entry["mainGroup"]).lstrip("0") or "0"
        if tree is not None:
            entry["rule"] = tree
        if unsure:
            entry["unsure"] = True
        shard = shard_key(cls, main_group, doc_id)
        entry["shard"] = shard
        index.append(entry)
        shards.setdefault(shard, {})[str(doc_id)] = body
        if verbose and stats["docs"] % 2000 == 0:
            print(f"  {stats['docs']} documents...", file=sys.stderr)
    return index, shards, stats


def main():
    """Run the extraction and write the data folder."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--diagdoc", required=True, help="DiagDocDb.decrypted.sqlite")
    ap.add_argument("--content", required=True, help="xmlvalueprimitive_ENGB.sqlite")
    ap.add_argument("--out", default="data/ista/techdata", help="output folder")
    ap.add_argument("--limit", type=int, help="stop after N documents (a smoke run)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    diag = sqlite3.connect(f"file:{args.diagdoc}?mode=ro", uri=True)
    diag.execute("PRAGMA query_only=1")
    content = Content(args.content)

    verbose = not args.quiet
    if verbose:
        print("reading documents...", file=sys.stderr)
    index, shards, stats = extract(diag, content, args.limit, verbose)

    if verbose:
        print("reading the vehicle characteristic maps...", file=sys.stderr)
    roots = read_roots(diag)
    typekeys = read_typekeys(diag)
    char_names = read_char_names(diag)

    os.makedirs(os.path.join(args.out, "body"), exist_ok=True)

    def write(path, obj):
        """Write one compact JSON file and return its size in bytes."""
        full = os.path.join(args.out, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
        return os.path.getsize(full)

    total = 0
    total += write(
        "index.json",
        {
            "version": 1,
            "classes": {c: label for c, label in CLASSES.values()},
            "equipmentTree": [{"id": i, "name": n} for i, n in EQUIPMENT_TREE],
            "docs": index,
        },
    )
    total += write("roots.json", roots)
    total += write("typekeys.json", typekeys)
    total += write("characteristics.json", char_names)
    biggest = 0
    for name, docs in shards.items():
        size = write(os.path.join("body", f"{name}.json"), docs)
        biggest = max(biggest, size)
        total += size

    if verbose:
        print(
            f"\n{stats['docs']} documents, {stats['bodies']} with a body\n"
            f"  per class: {stats['per_class']}\n"
            f"  unsure (undecoded rule): {stats['unsure']}\n"
            f"  no rule at all (apply to every car): {stats['norule']}\n"
            f"  {len(shards)} body shards, largest {biggest / 1e6:.2f} MB\n"
            f"  {len(typekeys)} type keys, {len(roots)} characteristic roots\n"
            f"  total {total / 1e6:.2f} MB in {args.out}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
