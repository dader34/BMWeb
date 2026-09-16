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
        leaf = {"op": OPS_SINGLE[op], "val": val}
        if op in (0x07, 0x08):
            # VALID_FROM / VALID_TO hold a .NET DateTime.ToBinary() value:
            # the ticks in the low 62 bits, the kind in the top two. The
            # tool compares it with the wall clock, so the calendar date
            # travels with the leaf -- a 64-bit tick count does not survive
            # a JSON round trip into a double
            leaf["iso"] = binary_date(val)
        return leaf, pos + 8
    raise RuleParseError(f"opcode {op:#04x}")


def binary_date(value):
    """The calendar date (YYYY-MM-DD) inside a DateTime.ToBinary() value.

    @param value: the int64 the rule carries
    """
    import datetime

    ticks = value & ((1 << 62) - 1)
    try:
        d = datetime.datetime(1, 1, 1) + datetime.timedelta(microseconds=ticks // 10)
    except OverflowError:
        return None
    return d.strftime("%Y-%m-%d")


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

    TWO CALLERS, TWO MEANINGS OF `ids`. For ONE VEHICLE (facts carry a
    `level`), every leaf answers the way the tool's own evaluator does,
    including what it answers when a fact is missing -- see vehicle_leaf.
    For a SET of builds (a chassis fold at extract time), a leaf only some
    builds satisfy is None, and None propagates the way the tool's engine
    would if it lacked the fact: NOT None is None, an AND is False on any
    False else None on any None, an OR is True on any True else None on any
    None. That keeps a NOT over an undecided leaf from turning a set into
    an exclusion.

    @param rule: a tree from parse_rule, or None
    @param ids: the set of characteristic value ids the car carries
    @param facts: see rule_applies
    """
    if not rule:
        return True
    facts = facts or {}
    op = rule.get("op")
    if "level" in facts and op not in ("eq", "and", "or", "not"):
        return vehicle_leaf(rule, ids, facts)
    if op == "eq":
        # A CHARACTERISTIC THE CALLER KNOWS NOTHING ABOUT IS UNDECIDED. A car
        # identified by name (chassis, engine, body) rather than by its type
        # key carries facts for those three roots only; a leaf about its
        # steering or sales designation must stay open, not read as false
        # because the id is absent from a set that never held that root.
        roots = facts.get("roots")
        if roots is not None and rule.get("root") not in roots:
            return None
        if rule["val"] in ids:
            return True
        # A FOLD OF MANY BUILDS IS NOT ONE CAR. When `ids` stands for every
        # build of a chassis, a characteristic only some of them carry is
        # neither theirs nor not theirs: it is undecided, and NOT over it
        # stays undecided. Deciding it true dropped "not M54" documents from
        # every E46 at build time, because the union carried M54.
        may = facts.get("may")
        if may is None:
            may = getattr(ids, "may", None)
        if may is not None and rule["val"] in may:
            return None
        return False
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


# the identification level at which the tool has read the car's modules
# (IdentificationLevel.VINVehicleReadout); below it, the ECU and SA leaves
# answer from the data rather than from the car
LEVEL_READOUT = 5


def vehicle_leaf(rule, ids, facts):
    """One leaf, answered the way ISTA's rule engine answers it for a
    vehicle -- RheingoldCoreFramework.dll 4.15.16, RuleHandling.*Expression
    .Evaluate(Vehicle, IFFMDynamicResolver), read from the decompiled
    assembly. The tool is strictly boolean; a missing fact has a definite
    answer per leaf kind, and that answer is reproduced here, not softened.

    facts: "level" (IdentificationLevel: 1 type key only, 3 VIN, 5 modules
    read), "ym" (model year*100+month), "built" (production date ticks),
    "prodart" ("P"/"M"), "fa" (True when the order was read), "sa" (the
    order's SA, E and HO words, upper-cased), "ecus" (variant names the car
    answered as, lower-cased), "titles" (control-unit tree names the car's
    modules carry, upper-cased), "ilevel"/"ilevel_werk" (I-level strings),
    "country" (the workshop's country code), "today" (YYYY-MM-DD), and
    "aux" (read_rule_facts output). Any of them may be absent.

    @param rule: the leaf
    @param ids: the car's characteristic ids
    @param facts: the vehicle's facts
    """
    op = rule.get("op")
    aux = facts.get("aux") or {}
    val = rule.get("val")
    key = str(val)
    level = int(facts.get("level") or 0)
    if op == "date":
        # DateExpression: no model year and month -> false
        ym = facts.get("ym")
        return False if ym is None else compare(ym, rule["cmp"], rule["ym"])
    if op == "mfd":
        # ManufactoringDateExpression: the production date, else the model
        # month at day 1 (both are `built` here), else false
        built = facts.get("built")
        return False if built is None else compare(built, rule["cmp"], rule["ticks"])
    if op == "salapa":
        # SaLaPaExpression: unknown id or the other product type -> false;
        # no order read, or not yet a vehicle readout -> true; else hasSA
        row = (aux.get("salapas") or {}).get(key)
        if not row:
            return False
        name, ptype = row[0], row[1]
        if ptype != facts.get("prodart", "P"):
            return False
        if not facts.get("fa") or level < LEVEL_READOUT:
            return True
        return str(name).upper() in (facts.get("sa") or set())
    if op == "country":
        # CountryExpression: the WORKSHOP's outlet country, not the car's
        code = (aux.get("countries") or {}).get(key)
        return bool(code) and code == facts.get("country")
    if op == "istufe":
        # IStufeExpression: no I-level, or the "0" wildcard -> true
        have = facts.get("ilevel") or ""
        if not have or have == "0":
            return True
        return (aux.get("istufen") or {}).get(key) == have
    if op == "istufex":
        return istufex_leaf(rule, facts, aux)
    if op == "equipment":
        # EquipmentExpression: an unknown feature is false; a feature the
        # resolver has run for answers with the module's verdict (a verdict
        # the resolver could not read -- None -- is true, as the tool
        # answers); otherwise the feature's own rule decides, and holds
        # unless it is false
        row = (aux.get("equipment") or {}).get(key)
        if not row:
            return False
        ffm = facts.get("ffm") or {}
        name = str(row.get("n") or "")
        if name in ffm:
            return True if ffm[name] is None else bool(ffm[name])
        return rule_eval(row.get("r"), ids, facts) is not False
    if op == "ecuclique":
        return clique_leaf(val, ids, facts, aux)
    if op == "ecurep":
        # EcuRepresentativeExpression: unknown -> false; before a readout
        # -> true; else the control-unit tree carries that abbreviation
        kurz = (aux.get("ecureps") or {}).get(key)
        if not kurz:
            return False
        if level < LEVEL_READOUT or facts.get("titles") is None:
            return True
        return str(kurz).upper() in facts["titles"]
    if op == "sifa":
        # SiFaExpression: a dealer's protection-vehicle service; none here
        return False
    if op in ("validfrom", "validto"):
        # compared with the wall clock, never with the car
        iso = rule.get("iso")
        today = facts.get("today")
        if not iso or not today:
            return True
        return today >= iso if op == "validfrom" else today <= iso
    if op in ("ecuvariant", "ecugroup"):
        # never stored in this corpus; the group leaf before a readout is
        # true, the variant leaf false without its row
        return level < LEVEL_READOUT and op == "ecugroup"
    return False


def numeric_ilevel(s):
    """FormatConverter.ExtractNumericalILevel: the digits of a 14-character
    I-level ("E89X-21-03-500" -> 2103500), else None."""
    s = str(s or "")
    if len(s) != 14:
        return None
    try:
        return int(s.replace("-", "")[4:])
    except ValueError:
        return None


def istufex_leaf(rule, facts, aux):
    """IStufeXExpression: the factory or current I-level against the
    rule's, by series prefix then numerically, with the tool's own answers
    for an empty or unparsable level."""
    literal = (aux.get("istufen") or {}).get(str(rule.get("val")))
    if not literal:
        return False
    have = facts.get("ilevel_werk" if rule.get("flag") else "ilevel") or ""
    if not have or have == "0":
        return True
    parts = str(literal).split("-")
    if len(parts) > 1 and have[: len(parts[0])].upper() != parts[0].upper():
        return False
    a, b = numeric_ilevel(have), numeric_ilevel(literal)
    cmp = rule.get("cmp")
    if cmp == "eq":
        return (a or 0) == (b or 0) and (a is None) == (b is None)
    if cmp == "ne":
        return (a or 0) != (b or 0) or (a is None) != (b is None)
    if a is None or b is None:
        return False
    return compare(a, cmp, b)


def clique_leaf(val, ids, facts, aux):
    """EcuCliqueExpression: an unknown clique is true; one with no
    variants is false; before a vehicle readout a variant whose own rule
    and whose group's rule hold makes it true; after one, a variant the car
    answered as does."""
    clique = (aux.get("cliques") or {}).get(str(val))
    if not clique:
        return True
    variants = aux.get("variants") or {}
    groups = aux.get("groups") or {}
    names = [str(v) for v in clique.get("v") or []]
    if not names:
        return False
    ecus = facts.get("ecus")
    if int(facts.get("level") or 0) < LEVEL_READOUT or ecus is None:
        for vid in names:
            v = variants.get(vid) or {}
            if rule_eval(v.get("r"), ids, facts) is False:
                continue
            g = groups.get(str(v.get("g"))) if v.get("g") else None
            if g and rule_eval(g.get("r"), ids, facts) is False:
                continue
            return True
        return False
    for vid in names:
        v = variants.get(vid) or {}
        if str(v.get("n") or "").lower() in ecus:
            return True
    return False


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
        "ym" (model year * 100 + month), "roots" (the characteristic roots
        the ids cover; absent means all of them), and for each name in
        FACT_LEAVES a set of ids the car carries
    """
    return rule_eval(rule, ids, facts) is not False


def compose_rule(own, ancestors):
    """One tree for a document reached through a tree of gated nodes.

    ISTA reaches a document through its diagnosis tree, and every node on
    the way carries its own rule, so the document applies when its own rule
    holds AND some path down to it holds: own AND (OR over paths of AND over
    the path's rules). A document with no path is gated by its own rule
    alone. Trees may be None (no rule).

    @param own: the document's own tree, or None
    @param ancestors: a list of paths, each a list of trees
    """
    paths = []
    for path in ancestors or ():
        kids = [t for t in path if t]
        if not kids:
            # an ungated path reaches the document unconditionally
            paths = None
            break
        paths.append(kids[0] if len(kids) == 1 else {"op": "and", "kids": kids})
    kids = []
    if own:
        kids.append(own)
    if paths:
        kids.append(paths[0] if len(paths) == 1 else {"op": "or", "kids": paths})
    if not kids:
        return None
    return kids[0] if len(kids) == 1 else {"op": "and", "kids": kids}


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


def read_rule_facts(con):
    """The tables the vehicle leaves consult, keyed by the ids rules carry.

    Only what some rule references is kept: the SA/LA/PA rows (code and
    product type), the countries, the I-levels, the features with their
    own rules, the ECU representatives, and the ECU cliques a rule names
    with their variants, the variants' rules and their groups' rules --
    that is what EcuCliqueExpression walks before a vehicle readout.

    @param con: an open DiagDocDb connection
    """
    rules = {}
    for rid, blob in con.execute("SELECT ID, RULE FROM XEP_RULES"):
        tree, unsure = decode_rule(blob)
        if tree is not None:
            rules[rid] = tree
    refs = {}

    def walk(t):
        op = t.get("op")
        if op in ("and", "or", "not"):
            for k in t.get("kids", ()):
                walk(k)
        elif "val" in t and op != "eq":
            refs.setdefault(op, set()).add(t["val"])

    for t in rules.values():
        walk(t)
    out = {}
    want = refs.get("salapa", set())
    out["salapas"] = {
        str(sid): [name, ptype]
        for sid, name, ptype in con.execute(
            "SELECT ID, NAME, PRODUCT_TYPE FROM XEP_SALAPAS WHERE NAME IS NOT NULL"
        )
        if sid in want
    }
    want = refs.get("country", set())
    out["countries"] = {
        str(cid): code
        for cid, code in con.execute("SELECT ID, LAENDERKUERZEL FROM XEP_COUNTRIES")
        if cid in want
    }
    want = refs.get("istufe", set()) | refs.get("istufex", set())
    out["istufen"] = {
        str(iid): name
        for iid, name in con.execute("SELECT ID, NAME FROM XEP_ISTUFEN")
        if iid in want
    }
    want = refs.get("equipment", set())
    # THE FEATURE IS DETECTED BY A TEST MODULE. Each XEP_EQUIPMENT row links
    # one ABL (ServiceProcedureLink) that the tool's FFM resolver runs on
    # the car; its verdict decides the leaf. The module ships under its
    # DLL spelling (the first two dashes are underscores).
    module_of = {}
    for eid, ident in con.execute(
        "SELECT r.ID, io.IDENTIFIER FROM XEP_REFINFOOBJECTS r "
        "JOIN XEP_INFOOBJECTS io ON io.ID=r.INFOOBJECTID "
        "WHERE r.LINK_TYPE_ID='ServiceProcedureLink'"
    ):
        if eid in want and ident:
            module_of.setdefault(eid, str(ident).replace("-", "_", 2))
    out["equipment"] = {
        str(eid): {"n": name, "r": rules.get(eid), "m": module_of.get(eid)}
        for eid, name in con.execute("SELECT ID, NAME FROM XEP_EQUIPMENT")
        if eid in want
    }
    want = refs.get("ecurep", set())
    out["ecureps"] = {
        str(rid): kurz
        for rid, kurz in con.execute("SELECT ID, STEUERGERAETEKUERZEL FROM XEP_ECUREPS")
        if rid in want
    }
    want = refs.get("ecuclique", set())
    by_clique = {}
    for vid, cid in con.execute("SELECT ID, ECUCLIQUEID FROM XEP_REFECUCLIQUES"):
        if cid in want:
            by_clique.setdefault(cid, []).append(vid)
    out["cliques"] = {
        str(cid): {"k": kurz, "v": [str(v) for v in sorted(by_clique.get(cid, []))]}
        for cid, kurz in con.execute("SELECT ID, CLIQUENKURZBEZEICHNUNG FROM XEP_ECUCLIQUES")
        if cid in want
    }
    variant_ids = {v for vs in by_clique.values() for v in vs}
    out["variants"] = {}
    group_ids = set()
    for vid, name, gid in con.execute("SELECT ID, NAME, ECUGROUPID FROM XEP_ECUVARIANTS"):
        if vid not in variant_ids:
            continue
        out["variants"][str(vid)] = {"n": name, "g": str(gid) if gid else None, "r": rules.get(vid)}
        if gid:
            group_ids.add(gid)
    out["groups"] = {
        str(gid): {"n": name, "r": rules.get(gid)}
        for gid, name in con.execute("SELECT ID, NAME FROM XEP_ECUGROUPS")
        if gid in group_ids
    }
    return out


def read_salapas(con):
    """SA/LA/PA code -> the XEP_SALAPAS ids that carry it.

    A SALAPA leaf names an id, and the car's order names a code (403, 2VB),
    so this is the bridge the evaluator needs. Cars and motorcycles keep
    separate rows for one code and both are listed: a rule ANDs the chassis
    in, so the wrong product's id can never decide anything on its own.

    @param con: an open DiagDocDb connection
    """
    out = {}
    for sid, name in con.execute(
        "SELECT ID, NAME FROM XEP_SALAPAS WHERE NAME IS NOT NULL AND NAME<>''"
    ):
        out.setdefault(str(name).strip().upper(), []).append(sid)
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


class ChassisFold(set):
    """The characteristic ids of a whole chassis, as one evaluable set.

    Its members are the ids EVERY build of the chassis carries (the chassis
    code itself, mostly), and `may` holds the ids ANY build carries. rule_eval
    reads both: a leaf in the members is true, one outside `may` is false,
    and one in between is undecided -- the only sound answer for a set of
    cars, and what keeps a "not M54" document in the E46 bundle for the
    E46s that are not M54.
    """

    def __init__(self, must=(), may=()):
        super().__init__(must)
        self.may = set(may)


def chassis_char_ids(typekeys, char_names, chassis):
    """The characteristic ids of one chassis, as a ChassisFold.

    Broader than a real car, but broad in the honest direction: a chassis
    with no VIN still sees its own documents rather than none, and a
    document that only some of its builds carry is kept (undecided), never
    dropped. Empty when the chassis has no type key.

    @param typekeys: read_typekeys output
    @param char_names: read_char_names output
    @param chassis: the development code, e.g. "E46"
    """
    want = str(chassis).upper()
    wanted_ids = {
        int(cid) for cid, name in char_names.items() if str(name).upper() == want
    }
    if not wanted_ids:
        return ChassisFold()
    root = str(CHASSIS_ROOT)
    builds = []
    for by_root in typekeys.values():
        codes = by_root.get(root) or []
        if not any(int(c) in wanted_ids for c in codes):
            continue
        builds.append({int(v) for vals in by_root.values() for v in vals})
    if not builds:
        return ChassisFold()
    return ChassisFold(set.intersection(*builds), set.union(*builds))
