#!/usr/bin/env python3
"""The validity-rule grammar shared by every ISTA document extract.

A document's applicability is an expression tree, not a bag of ids, and the
blob in XEP_RULES is that tree in a prefix encoding:

    0x01  AND       int32 LE operand count, then that many operands
    0x02  OR        the same
    0x10  NOT       one operand
    0x11  EQ        int64 LE characteristic-root id, int64 LE value id
    0x03  |  0x04   one operand, qualified by something not decoded
    0x12  |  0x13   the same
    0x09  |  0x0e   an int64 literal, no operand
    0x0f            the same

The first four opcodes were established by the workshop-reference extract.
The last seven were fitted here, by taking every repair-instruction rule the
four-opcode grammar rejected and scoring each candidate arity by how many
blobs then parse to exactly their own length. Nothing else is evidence: a
grammar that consumes the blob exactly, across tens of thousands of blobs,
is right; one that leaves a byte over is guessing.

    four opcodes   61,996 of 67,632 repair rules clean   (91.7%)
    all eleven     66,433 of 67,632 repair rules clean   (98.2%)

0x03 is unary because its operand is a well-formed EQ that starts one byte
after it, with no count field in between. 0x09/0x0e/0x0f are an int64
literal because skipping eight bytes is the only arity that raises the clean
count. 0x04/0x12/0x13 only ever occur inside blobs that fail for some other
reason, so their arity is not established by the data -- they are read as
unary because that is the shape of their neighbours, and a document whose
rule contains one is still decoded rather than dropped.

WHAT AN UNDECODED RULE MEANS. A blob that does not parse, or that parses but
leaves bytes over, yields no tree and the document is flagged `unsure`. An
unsure document is SHOWN for every car, marked. In a workshop a document
that might not apply is a smaller problem than a repair step that quietly
went missing, so the flag is the honest failure, not exclusion.

WHAT `soft` MEANS. 0x03/0x04/0x12/0x13 qualify their operand with a
condition nobody has decoded -- they look like date or I-level comparisons.
The tree keeps the operand and marks the node `soft`, so the app evaluates
what IS known and the extra condition is treated as satisfied. That widens
the result rather than narrowing it, which is the same direction `unsure`
errs in and for the same reason.
"""
import struct

# the decoded opcodes
OP_AND, OP_OR, OP_NOT, OP_EQ = 0x01, 0x02, 0x10, 0x11

# one operand, qualified by a condition that is not decoded
OPS_SOFT = (0x03, 0x04, 0x12, 0x13)

# an int64 literal standing alone, no operand
OPS_LITERAL = (0x09, 0x0E, 0x0F)

# an AND/OR wider than this is a corrupt length, not a real rule; the widest
# real one seen in the corpus is far below it
MAX_OPERANDS = 4096


class RuleParseError(Exception):
    """A rule used an opcode, or a length, this decoder does not know."""


def parse_rule(blob, pos=0):
    """Decode a validity blob into a small expression tree.

    Returns (tree, next position). A tree node is one of:
        {"op": "and"|"or", "kids": [...]}
        {"op": "not", "kids": [one]}
        {"op": "soft", "kids": [one]}      an undecoded qualifier
        {"op": "eq", "root": <root id>, "val": <value id>}
        {"op": "lit"}                      an undecoded int64 literal
    Raises RuleParseError on anything outside the grammar above, so the
    caller can flag the document rather than guess at its applicability.

    @param blob: the RULE column's bytes
    @param pos: where to start reading
    """
    if pos >= len(blob):
        raise RuleParseError("rule ended early")
    op = blob[pos]
    pos += 1
    if op in (OP_AND, OP_OR):
        (count,) = struct.unpack_from("<i", blob, pos)
        pos += 4
        if count < 0 or count > MAX_OPERANDS:
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
    if op in OPS_SOFT:
        kid, pos = parse_rule(blob, pos)
        return {"op": "soft", "kids": [kid]}, pos
    if op in OPS_LITERAL:
        # the literal itself is not understood, so it is not carried: the
        # node exists only to keep the byte count honest
        return {"op": "lit"}, pos + 8
    raise RuleParseError(f"opcode {op:#04x}")


def decode_rule(blob):
    """(tree, unsure) for a validity blob.

    A rule that does not decode, or that decodes but leaves bytes over,
    yields (None, True): no rule the app can evaluate, and a flag saying the
    document's applicability was not established. A document with no rule at
    all is (None, False) -- it applies to everything, which is a real answer,
    not a failure to read one.

    @param blob: the RULE column's bytes, or None
    """
    if not blob:
        return None, False
    try:
        tree, pos = parse_rule(blob, 0)
    except (RuleParseError, struct.error, IndexError):
        return None, True
    if pos != len(blob):
        # decoded, but not all of it -- treat as undecoded rather than
        # trusting a tree built from part of the blob
        return None, True
    return tree, False


def rule_applies(rule, ids):
    """Does a decoded rule hold for a car?

    Total by design: an absent rule applies to everything, and a node the
    grammar could not pin down applies rather than excluding. Both err
    towards showing a document, for the reason in this module's docstring.

    This is the Python twin of repairRuleApplies / techDataRuleApplies in
    the renderer -- the extractor uses it to count and shard, the app uses
    it to filter, and they must agree.

    @param rule: a tree from parse_rule, or None
    @param ids: the set of characteristic value ids the car carries
    """
    if not rule:
        return True
    op = rule.get("op")
    if op == "eq":
        return rule["val"] in ids
    if op == "and":
        return all(rule_applies(k, ids) for k in rule.get("kids", ()))
    if op == "or":
        return any(rule_applies(k, ids) for k in rule.get("kids", ()))
    if op == "not":
        kids = rule.get("kids") or [None]
        return not rule_applies(kids[0], ids)
    if op == "soft":
        kids = rule.get("kids") or [None]
        return rule_applies(kids[0], ids)
    return True


# ---- the vehicle characteristic maps ---------------------------------------
# the characteristic root that names a car's chassis (E46, F10 ...)
CHASSIS_ROOT = 53088651


def read_typekeys(con):
    """Type key (VIN chars 4-7) -> {root id: [value ids]}.

    This is what turns a car into something a rule can be evaluated against:
    the rule asks "is characteristic X among this car's", and this is the
    set. Values are grouped by root so the app can also SHOW them (the
    development code, engine, body and so on) without a second query.

    @param con: an open DiagDocDb connection
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
    """Characteristic value id -> its name, for showing a car's build.

    @param con: an open DiagDocDb connection
    """
    return {
        str(cid): name
        for cid, name in con.execute(
            "SELECT ID, NAME FROM XEP_CHARACTERISTICS "
            "WHERE NAME IS NOT NULL AND NAME<>''"
        )
    }


def read_roots(con):
    """Characteristic-root id -> its English name.

    @param con: an open DiagDocDb connection
    """
    return {
        str(rid): name
        for rid, name in con.execute(
            "SELECT ID, TITLE_ENGB FROM XEP_CHARACTERISTICROOTS "
            "WHERE TITLE_ENGB IS NOT NULL AND TITLE_ENGB<>''"
        )
    }


def chassis_char_ids(typekeys, char_names, chassis):
    """Every characteristic id any type key of one chassis carries.

    Broader than a real car, but broad in the honest direction: a chassis
    with no VIN still sees its own documents rather than none. The app's
    repairCarKeys does the same fold for a car the Garage has no VIN for.

    @param typekeys: read_typekeys output
    @param char_names: read_char_names output
    @param chassis: the development code, e.g. "E46"
    """
    want = str(chassis).upper()
    wanted_ids = {
        int(cid) for cid, name in char_names.items() if str(name).upper() == want
    }
    if not wanted_ids:
        return set()
    out = set()
    root = str(CHASSIS_ROOT)
    for by_root in typekeys.values():
        codes = by_root.get(root) or []
        if not any(int(c) in wanted_ids for c in codes):
            continue
        for vals in by_root.values():
            out.update(int(v) for v in vals)
    return out
