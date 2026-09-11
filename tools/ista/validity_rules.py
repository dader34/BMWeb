#!/usr/bin/env python3
"""The validity-rule grammar shared by every ISTA document extract.

A document's applicability is an expression tree, not a bag of ids, and the
blob in XEP_RULES is that tree in a prefix encoding. The grammar below is
ISTA's own: it is what the tool's rule engine reads (RuleExpression.Deserialize
in the core framework assembly, one byte of expression type followed by that
type's payload), not a fit to the data. Every blob in the corpus decodes.

    byte  type                 payload
    0x01  AND                  int32 LE operand count, then the operands
    0x02  OR                   the same
    0x03  NOT                  one operand
    0x04  DATE                 byte compare operator, int64 LE model year and
                               month as one number (200203 = 2002/03)
    0x06  ISTUFE               int64 LE integration-level id
    0x07  VALID_FROM           int64 LE
    0x08  VALID_TO             int64 LE
    0x09  COUNTRY              int64 LE country id
    0x0a  ECUGROUP             int64 LE
    0x0b  ECUVARIANT           int64 LE
    0x0c  ECUCLIQUE            int64 LE
    0x0d  EQUIPMENT            int64 LE equipment id
    0x0e  SALAPA               int64 LE SA/LA/PA id
    0x0f  SIFA                 int64 LE
    0x11  CHARACTERISTIC       int64 LE root (data class) id, int64 LE value id
    0x12  ECUREPRESENTATIVE    int64 LE
    0x13  MANUFACTORINGDATE    byte compare operator, int64 LE production
                               date ticks
    0x14  ISTUFEX              byte compare operator, byte flag, int64 LE id

    0x00 COMP, 0x05 VALUE and 0x10 VARIABLE exist in the type enum but the
    engine refuses to deserialise them, so no stored rule carries one.

Compare operators: 0 equal, 1 not equal, 2 greater, 3 greater or equal,
4 less, 5 less or equal, always read as <vehicle value> <op> <rule value>.
A DATE leaf compares the car's model year and month (year * 100 + month,
the tool's Modelljahr/Modellmonat); a MANUFACTORINGDATE leaf compares the
production date in .NET ticks: 100 ns units since 0001-01-01.

WHAT AN UNDECODED RULE MEANS. A blob that does not parse, or that parses but
leaves bytes over, yields no tree and the document is flagged `unsure`. With
the real grammar that is a corrupt row, not a gap in the decoder. An unsure
document is SHOWN for every car, marked: a document that might not apply is
a smaller problem than a repair step that quietly went missing.

WHAT THE EVALUATOR KNOWS. A characteristic leaf is decided from the car's
characteristic ids (its type key's build). NOT negates, as it must. A
production-date leaf is decided when the caller knows the build date and
applies otherwise. Leaves about equipment, SA codes, country, integration
level and installed ECU variants need facts the extract does not carry per
car, so they apply until a caller supplies them: that keeps the result
wider, never narrower, than the truth.
"""
import struct

# expression types, ISTA's numbering
OP_AND, OP_OR, OP_NOT = 0x01, 0x02, 0x03
OP_DATE, OP_MFD, OP_ISTUFEX = 0x04, 0x13, 0x14
OP_EQ = 0x11

# one int64 payload each: the leaf name the tree carries
OPS_SINGLE = {
    0x06: "istufe",
    0x07: "validfrom",
    0x08: "validto",
    0x09: "country",
    0x0A: "ecugroup",
    0x0B: "ecuvariant",
    0x0C: "ecuclique",
    0x0D: "equipment",
    0x0E: "salapa",
    0x0F: "sifa",
    0x12: "ecurep",
}

# the compare operators, by their byte
CMP_OPS = ("eq", "ne", "gt", "ge", "lt", "le")

# an AND/OR wider than this is a corrupt length, not a real rule; the widest
# real one seen in the corpus is far below it
MAX_OPERANDS = 4096

# the leaf kinds a caller may decide with facts (see rule_applies)
FACT_LEAVES = ("salapa", "equipment", "country", "istufe", "istufex",
               "ecugroup", "ecuvariant", "ecuclique", "ecurep", "sifa",
               "validfrom", "validto")


class RuleParseError(Exception):
    """A rule used an opcode, or a length, outside ISTA's grammar."""


def parse_rule(blob, pos=0):
    """Decode a validity blob into a small expression tree.

    Returns (tree, next position). A tree node is one of:
        {"op": "and"|"or", "kids": [...]}
        {"op": "not", "kids": [one]}
        {"op": "eq", "root": <root id>, "val": <value id>}   characteristic
        {"op": "mfd", "cmp": <cmp name>, "ticks": <int>}      production date
        {"op": "date", "cmp": <cmp name>, "ym": <int>}         model year*100+month
        {"op": "istufex", "cmp": <cmp name>, "flag": <bool>, "val": <id>}
        {"op": <leaf name from OPS_SINGLE>, "val": <id>}
    Raises RuleParseError on anything outside the grammar, so the caller can
    flag the document rather than guess at its applicability.

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
        (root, val) = struct.unpack_from("<qq", blob, pos)
        return {"op": "eq", "root": root, "val": val}, pos + 16
    if op in (OP_DATE, OP_MFD):
        cmp_byte = blob[pos]
        if cmp_byte >= len(CMP_OPS):
            raise RuleParseError(f"compare operator {cmp_byte}")
        (value,) = struct.unpack_from("<q", blob, pos + 1)
        if op == OP_MFD:
            return {"op": "mfd", "cmp": CMP_OPS[cmp_byte], "ticks": value}, pos + 9
        return {"op": "date", "cmp": CMP_OPS[cmp_byte], "ym": value}, pos + 9
    if op == OP_ISTUFEX:
        cmp_byte = blob[pos]
        if cmp_byte >= len(CMP_OPS):
            raise RuleParseError(f"compare operator {cmp_byte}")
        flag = blob[pos + 1] > 0
        (val,) = struct.unpack_from("<q", blob, pos + 2)
        return {"op": "istufex", "cmp": CMP_OPS[cmp_byte], "flag": flag, "val": val}, pos + 10
    if op in OPS_SINGLE:
        (val,) = struct.unpack_from("<q", blob, pos)
        return {"op": OPS_SINGLE[op], "val": val}, pos + 8
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


def compare(left, cmp, right):
    """<left> <cmp> <right> with ISTA's operator names.

    @param left: the vehicle's value
    @param cmp: a name from CMP_OPS
    @param right: the rule's value
    """
    if cmp == "eq":
        return left == right
    if cmp == "ne":
        return left != right
    if cmp == "gt":
        return left > right
    if cmp == "ge":
        return left >= right
    if cmp == "lt":
        return left < right
    return left <= right


def date_ticks(year, month, day=1):
    """.NET ticks for a calendar date, the unit ISTA stores dates in.

    @param year: four-digit year
    @param month: 1-12
    @param day: 1-31
    """
    import datetime

    d = datetime.date(int(year), int(month), int(day))
    days = d.toordinal()  # days since 0001-01-01, that date being 1
    return (days - 1) * 864_000_000_000


def rule_eval(rule, ids, facts=None):
    """Three-valued evaluation: True, False, or None for "not decidable".

    A leaf the caller has no fact for is None, and None propagates the way
    ISTA's engine would if it lacked the fact: NOT None is None, an AND is
    False on any False else None on any None, an OR is True on any True else
    None on any None. That keeps a NOT over an unknown leaf from turning a
    missing fact into an exclusion.

    @param rule: a tree from parse_rule, or None
    @param ids: the set of characteristic value ids the car carries
    @param facts: see rule_applies
    """
    if not rule:
        return True
    facts = facts or {}
    op = rule.get("op")
    if op == "eq":
        return rule["val"] in ids
    if op == "and":
        out = True
        for k in rule.get("kids", ()):
            v = rule_eval(k, ids, facts)
            if v is False:
                return False
            if v is None:
                out = None
        return out
    if op == "or":
        out = False
        for k in rule.get("kids", ()):
            v = rule_eval(k, ids, facts)
            if v is True:
                return True
            if v is None:
                out = None
        return out
    if op == "not":
        kids = rule.get("kids") or [None]
        v = rule_eval(kids[0], ids, facts)
        return None if v is None else not v
    if op == "mfd":
        built = facts.get("built")
        if built is None:
            return None
        return compare(built, rule["cmp"], rule["ticks"])
    if op == "date":
        ym = facts.get("ym")
        if ym is None:
            return None
        return compare(ym, rule["cmp"], rule["ym"])
    if op in FACT_LEAVES:
        have = facts.get(op)
        if have is None or op == "istufex":
            return None
        return rule["val"] in have
    return None


def rule_applies(rule, ids, facts=None):
    """Does a decoded rule hold for a car?

    Total by design: an absent rule applies to everything, and a rule whose
    outcome the facts cannot decide applies rather than excludes. Both err
    towards showing a document, for the reason in this module's docstring.

    This is the Python twin of techDataRuleApplies in the renderer -- the
    extractor uses it to count and shard, the app uses it to filter, and
    they must agree.

    @param rule: a tree from parse_rule, or None
    @param ids: the set of characteristic value ids the car carries
    @param facts: optional dict: "built" (production date in .NET ticks),
        "ym" (model year * 100 + month), and for each name in FACT_LEAVES a
        set of ids the car carries
    """
    return rule_eval(rule, ids, facts) is not False


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
