#!/usr/bin/env python3
"""The workshop-document extractor: the rule grammar, the body parsers, and
the real databases when this machine has them.

The pure half always runs. The database half needs the ISTA extracts and
SKIPS without them, the way the rest of the suite skips what it cannot reach
-- so this is safe to run anywhere, and says which half it ran.

    python3 tools/verify/test_techdata_extract.py
"""
import os
import struct
import sqlite3
import sys
import xml.etree.ElementTree as ET

sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "ista")
)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from technical_data_extract import (  # noqa: E402
    CLASSES,
    RuleParseError,
    decode_rule,
    group_number,
    parse_body,
    parse_rule,
    shard_key,
)

PASSED = 0


def ok(what):
    """Count a passing check."""
    global PASSED
    PASSED += 1
    if os.environ.get("V"):
        print("  ok", what)


def eq(a, b, what):
    """Assert equality with a readable failure."""
    assert a == b, f"{what}: {a!r} != {b!r}"
    ok(what)


# ---- the rule grammar, on blobs built by hand ------------------------------
def leaf(root, val):
    """An EQ node's bytes."""
    return b"\x11" + struct.pack("<q", root) + struct.pack("<q", val)


def group(op, *kids):
    """An AND/OR node's bytes."""
    return bytes([op]) + struct.pack("<i", len(kids)) + b"".join(kids)


def test_rules():
    """The prefix encoding decodes to the tree it describes."""
    tree, pos = parse_rule(leaf(7, 9))
    eq(tree, {"op": "eq", "root": 7, "val": 9}, "a leaf decodes")
    eq(pos, 17, "a leaf is 1 + 8 + 8 bytes")

    blob = group(0x01, leaf(1, 10), leaf(2, 20))
    tree, pos = parse_rule(blob)
    eq(tree["op"], "and", "0x01 is AND")
    eq(len(tree["kids"]), 2, "AND keeps both operands")
    eq(pos, len(blob), "and consumes exactly its blob")

    tree, _ = parse_rule(group(0x02, leaf(1, 10)))
    eq(tree["op"], "or", "0x02 is OR")

    tree, _ = parse_rule(b"\x03" + leaf(1, 10))
    eq(tree["op"], "not", "0x03 is NOT")
    eq(len(tree["kids"]), 1, "NOT takes one operand")

    # the dated and single-id leaves, ISTA's own payloads
    mfd = b"\x13\x03" + struct.pack("<q", 631820736000000000)
    tree, pos = parse_rule(mfd)
    eq(tree, {"op": "mfd", "cmp": "ge", "ticks": 631820736000000000}, "0x13 is a production-date compare")
    eq(pos, 10, "a dated leaf is 1 + 1 + 8 bytes")
    tree, pos = parse_rule(b"\x0e" + struct.pack("<q", 42))
    eq(tree, {"op": "salapa", "val": 42}, "0x0e is an SA/LA/PA id")
    eq(pos, 9, "a single-id leaf is 1 + 8 bytes")
    tree, pos = parse_rule(b"\x14\x02\x01" + struct.pack("<q", 5))
    eq(tree, {"op": "istufex", "cmp": "gt", "flag": True, "val": 5}, "0x14 is an I-level compare")
    eq(pos, 11, "an I-level leaf is 1 + 1 + 1 + 8 bytes")

    # nesting round-trips
    nested = group(0x01, group(0x02, leaf(1, 10), leaf(1, 11)), b"\x03" + leaf(2, 20))
    tree, pos = parse_rule(nested)
    eq(pos, len(nested), "a nested rule consumes its blob")
    eq(tree["kids"][0]["op"], "or", "the nested OR survives")
    eq(tree["kids"][1]["op"], "not", "the nested NOT survives")

    # an undecoded opcode is refused rather than guessed at
    try:
        parse_rule(b"\x05\x00\x00\x00\x00")
        raise AssertionError("0x05 (VALUE) should not parse")
    except RuleParseError:
        ok("a type the engine refuses raises")

    # decode_rule turns that into the flag the app reads
    eq(decode_rule(b"\x05\x00"), (None, True), "an undecodable rule is unsure")
    eq(decode_rule(b""), (None, False), "no rule at all is not unsure")
    eq(decode_rule(None), (None, False), "a null rule is not unsure")
    # decoded but with bytes left over is NOT trusted: a tree built from part
    # of a blob would be a confident wrong answer
    eq(
        decode_rule(leaf(1, 2) + b"\xff\xff"),
        (None, True),
        "trailing bytes make it unsure",
    )
    tree, unsure = decode_rule(leaf(1, 2))
    eq(unsure, False, "a clean rule is sure")
    eq(tree["op"], "eq", "and decodes")


# ---- the group numbering ---------------------------------------------------
def test_groups():
    """The source's ragged group codes normalise to their number."""
    eq(group_number("11"), "11", "a plain number")
    eq(group_number("2"), "02", "a single digit pads")
    eq(group_number("67-1"), "67", "a suffixed group keeps its number")
    eq(group_number("11-30"), "11", "so does a two-part one")
    eq(group_number("13 32"), "13", "and a spaced one")
    eq(group_number("65 Airbagsteuergerat"), "65", "and a named one")
    eq(group_number(""), "00", "nothing is group 00")
    eq(group_number(None), "00", "and so is null")
    eq(group_number("Engine"), "00", "a name with no number is 00")

    eq(shard_key("torque", "11"), "torque-11", "a shard is class and group")
    eq(shard_key("techdata", "67-1"), "techdata-67", "normalised in the key too")
    # the 9,785 special tools all declare group 1, so they are split further --
    # one 5 MB file to show one spanner is not a shard, it is a download
    a = shard_key("tools", "1", 100)
    b = shard_key("tools", "1", 101)
    assert a != b, f"tools split by id: {a} == {b}"
    ok("the special tools split across shards")


# ---- the body parsers, on the real shapes ----------------------------------
def test_bodies():
    """Each root element parses into the fields the app draws."""
    td = parse_body(
        """<TECHNICALDATA><SPLITTITLE><SUBGROUPTITLE>
        <MAINGROUPNUMBER>11</MAINGROUPNUMBER>
        <SUBGROUPNUMBER>24</SUBGROUPNUMBER>
        <SUBGROUPNAME>Connecting Rods</SUBGROUPNAME>
        </SUBGROUPTITLE><VALIDITY><ENGINE>M52</ENGINE><ADDITION>B 20</ADDITION>
        </VALIDITY></SPLITTITLE>
        <TABLE><TGROUP><TBODY><ROW>
        <ENTRY><PARAGRAPH>Bearing clearance</PARAGRAPH></ENTRY>
        <ENTRY><PARAGRAPH>0,020 mm</PARAGRAPH></ENTRY>
        </ROW></TBODY></TGROUP></TABLE></TECHNICALDATA>"""
    )
    eq(td["mainGroup"], "11", "technical data carries its group")
    eq(td["subGroupName"], "Connecting Rods", "and its subgroup name")
    eq(td["validity"][0]["engine"], "M52", "and its validity")
    assert any(b["t"] == "table" for b in td["blocks"]), "its table survives"
    ok("technical data parses")

    tq = parse_body(
        """<TIGHTENINGTORQUES>
        <TITLE><MAINGROUPNUMBER>11</MAINGROUPNUMBER>
        <MAINGROUPNAME>Engine</MAINGROUPNAME></TITLE>
        <TABLE><TGROUP><TBODY><ROW>
        <ENTRY><RELATION><PARAGRAPH>Damper bolt</PARAGRAPH></RELATION></ENTRY>
        <ENTRY><SCREW><PARAGRAPH>M12</PARAGRAPH></SCREW></ENTRY>
        <ENTRY><TORQUE><MEASURE>110</MEASURE><UNIT>Nm</UNIT></TORQUE></ENTRY>
        <ENTRY><VALIDITIES><VALIDITY><ENGINE>M54</ENGINE></VALIDITY></VALIDITIES></ENTRY>
        </ROW></TBODY></TGROUP></TABLE></TIGHTENINGTORQUES>"""
    )
    eq(tq["mainGroup"], "11", "torques carry their group")
    row = tq["torques"][0]
    eq(row["part"], "Damper bolt", "the part")
    eq(row["thread"], "M12", "the thread")
    eq(row["torque"], "110", "the figure")
    eq(row["unit"], "Nm", "AND ITS UNIT")
    eq(row["engines"], ["M54"], "the row's own engine validity")
    ok("torque rows parse")

    si = parse_body(
        """<SI-ENCLOSURE><PAGEHEADER><HEADLINE>SI 00 13 96</HEADLINE></PAGEHEADER>
        <TITLE>Approval conditions</TITLE>
        <PARAGRAPH>The following must be fulfilled:</PARAGRAPH>
        <GENERALLIST><LISTELEMENT><PARAGRAPH>Meets the requirements.</PARAGRAPH>
        </LISTELEMENT></GENERALLIST></SI-ENCLOSURE>"""
    )
    eq(si["title"], "Approval conditions", "a service chapter's title")
    eq(si["headline"], "SI 00 13 96", "and its headline")
    assert any(b["t"] == "p" for b in si["blocks"]), "its prose"
    ok("a service chapter parses")

    tool = parse_body(
        """<SPECIALTOOLDOCUMENT><TOOLNUMBER>0495608</TOOLNUMBER>
        <DESIGNATION><SUBSCRIPT>Foil</SUBSCRIPT></DESIGNATION>
        <TOOLNUMBEROLD>001161</TOOLNUMBEROLD>
        <CATEGORY>MW</CATEGORY></SPECIALTOOLDOCUMENT>"""
    )
    eq(tool["toolNumber"], "0495608", "a tool's number")
    eq(tool["designation"], "Foil", "its name, through the inline markup")
    eq(tool["toolNumberOld"], "001161", "and the number it replaced")
    ok("a special tool parses")

    eq(parse_body(""), None, "an empty body is None")
    eq(parse_body("not xml at all <"), None, "unparseable is None")
    ok("a bad body is refused, not guessed")


# ---- the real databases, when this machine has them ------------------------
DB_DIR = os.path.expanduser("~/Development/code/BMWFILES/ista/databases")
DIAGDOC = os.path.join(DB_DIR, "DiagDocDb.decrypted.sqlite")
CONTENT = os.path.join(DB_DIR, "xmlvalueprimitive_ENGB.sqlite")

# what the five classes hold, counted when this was written
EXPECTED = {
    46478722: 5915,
    46453506: 3634,
    46463234: 216,
    46451074: 7104,
    46460546: 2793,
}
# the type key of an E46 325i, and the floor its evaluation must clear
ET37_FLOOR = {"techdata": 100, "torque": 100, "fluids": 100}


def test_database():
    """Counts, body coverage, the grammar's parse rate, and one real car."""
    con = sqlite3.connect(f"file:{DIAGDOC}?mode=ro", uri=True)
    cur = con.cursor()
    ids = tuple(CLASSES)

    for node_class, want in EXPECTED.items():
        got = cur.execute(
            "SELECT COUNT(*) FROM XEP_INFOOBJECTS WHERE NODECLASS=?",
            (node_class,),
        ).fetchone()[0]
        eq(got, want, f"class {node_class} holds {want} documents")

    # the body join reaches every one of them
    with_body = dict(
        cur.execute(
            "SELECT i.NODECLASS, COUNT(*) FROM XEP_INFOOBJECTS i "
            "JOIN XEP_REFCONTENTS rc ON rc.ID=i.CONTROLID "
            "JOIN XEP_IOCONTENTS io ON io.CONTROLID=rc.CONTENTCONTROLID "
            f"WHERE i.NODECLASS IN {ids} AND io.CONTENT_ENGB>0 "
            "GROUP BY i.NODECLASS"
        )
    )
    for node_class, want in EXPECTED.items():
        eq(with_body.get(node_class), want, f"class {node_class} resolves a body")

    # the grammar's parse rate over every rule these documents carry
    doc_ids = {
        r[0]
        for r in cur.execute(
            f"SELECT ID FROM XEP_INFOOBJECTS WHERE NODECLASS IN {ids}"
        )
    }
    clean = unsure = 0
    for doc_id, blob in cur.execute("SELECT ID, RULE FROM XEP_RULES"):
        if doc_id not in doc_ids or not blob:
            continue
        tree, flag = decode_rule(blob)
        if flag:
            unsure += 1
        else:
            clean += 1
    total = clean + unsure
    rate = clean * 100.0 / total
    assert rate >= 95.0, f"the rule grammar parsed only {rate:.1f}%"
    ok(f"the rule grammar parses {rate:.1f}% of {total} rules")

    # one real car: an E46 325i must find real numbers of documents
    car = {
        r[0]
        for r in cur.execute(
            "SELECT c.ID FROM XEP_VEHICLES v "
            "JOIN XEP_CHARACTERISTICS c ON c.ID=v.CHARACTERISTICID "
            "JOIN XEP_CHARACTERISTICS tk ON tk.ID=v.TYPEKEYID "
            "WHERE tk.NAME='ET37'"
        )
    }
    assert car, "ET37 resolved to no characteristics"
    ok(f"ET37 resolves to {len(car)} characteristics")

    def applies(tree):
        """Evaluate a decoded rule against the car, as the app does."""
        if tree is None:
            return True
        op = tree["op"]
        if op == "eq":
            return tree["val"] in car
        if op == "and":
            return all(applies(k) for k in tree["kids"])
        if op == "or":
            return any(applies(k) for k in tree["kids"])
        if op == "not":
            return not applies(tree["kids"][0])
        return True

    rules = {r[0]: r[1] for r in cur.execute("SELECT ID, RULE FROM XEP_RULES")}
    hits = {}
    for doc_id, node_class in cur.execute(
        f"SELECT ID, NODECLASS FROM XEP_INFOOBJECTS WHERE NODECLASS IN {ids}"
    ):
        slug = CLASSES[node_class][0]
        tree, flag = decode_rule(rules.get(doc_id))
        if flag or applies(tree):
            hits[slug] = hits.get(slug, 0) + 1
    for slug, floor in ET37_FLOOR.items():
        got = hits.get(slug, 0)
        assert got >= floor, f"ET37 saw only {got} {slug} documents (want {floor}+)"
        ok(f"ET37 sees {got} {slug} documents")

    # and the bodies really parse, over a sample of each class
    if os.path.exists(CONTENT):
        content = sqlite3.connect(f"file:{CONTENT}?mode=ro", uri=True)
        for node_class in EXPECTED:
            rows = cur.execute(
                "SELECT io.CONTENT_ENGB FROM XEP_INFOOBJECTS i "
                "JOIN XEP_REFCONTENTS rc ON rc.ID=i.CONTROLID "
                "JOIN XEP_IOCONTENTS io ON io.CONTROLID=rc.CONTENTCONTROLID "
                "WHERE i.NODECLASS=? AND io.CONTENT_ENGB>0 LIMIT 40",
                (node_class,),
            ).fetchall()
            good = 0
            for (cid,) in rows:
                row = content.execute(
                    "SELECT data FROM xmlvalueprimitive WHERE id=? AND deleted=0",
                    (cid,),
                ).fetchone()
                if not row:
                    continue
                data = row[0]
                if isinstance(data, bytes):
                    data = data.decode("utf-8", "replace")
                if parse_body(data):
                    good += 1
            assert good >= len(rows) * 0.9, (
                f"class {node_class}: only {good}/{len(rows)} bodies parsed"
            )
            ok(f"class {node_class}: {good}/{len(rows)} sampled bodies parse")


def main():
    """Run the pure checks, then the database ones when reachable."""
    test_rules()
    test_groups()
    test_bodies()
    if os.path.exists(DIAGDOC):
        test_database()
    else:
        print(f"SKIP (no ISTA databases at {DB_DIR}): the database checks")
    print(f"test_techdata_extract: {PASSED} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
