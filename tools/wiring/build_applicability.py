#!/usr/bin/env python3
"""Build the WDS wiring VIN-applicability index from ISTA's DiagDocDb.

Each wiring schematic (XEP_INFOOBJECTS INFOTYPE='SSP', IDENTIFIER
'...-SP0000NNNNNN') carries a validity rule, and ISTA reaches it through
the diagnosis tree, whose nodes carry rules of their own. So a schematic
applies to a car when its OWN rule holds AND some path of tree nodes down
to it holds. Both are shipped as decoded rule trees, in ISTA's own grammar
(tools/ista/validity_rules.py), and the app evaluates them against the car
three-valued: true shows, false hides, undecidable keeps.

THE RULE IS A TREE, NOT A BAG OF IDS. The previous index slid a four-byte
window over the blob and kept any value that happened to be a chassis,
engine or body id. That has no notion of AND, OR or NOT, so a rule reading
"NOT engine M54" shipped as engine {M54} -- the exact inverse -- and a date
was any number in a plausible range preceded by a byte the real grammar
uses for NOT. Every blob decodes with the real grammar; one that does not
is a corrupt row and is shipped as `u` (unsure), which the app keeps.

Output (compact JSON, gzipped when the name ends in .gz):

    {"version": 2,
     "roots": {"chassis": 53088651, "engine": 53363595, "body": 53046411},
     "rules": {"<object id>": <tree>, ...},
     "sp": {"SP0000014320": {"r": "<own rule id>",
                              "p": [["<ancestor rule id>", ...], ...],
                              "c": ["E46"],
                              "u": 1}, ...}}

`r` names the document's own rule in `rules`, `p` lists every distinct
path of gated ancestors (nearest first) as rule ids, `c` is the chassis
list the composed rule holds for (every type key of the chassis folded
together -- what the reference-document importer packs bundles by) and `u`
marks a rule the grammar could not read. A document with neither `r` nor
`p` is generally valid.

Usage: build_applicability.py <DiagDocDb.decrypted.sqlite> <out.json[.gz]>
"""
import gzip
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))                        # tools/
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "ista"))  # tools/ista
from _cli import parse_args                                      # noqa: E402
from validity_rules import (                                     # noqa: E402
    CHASSIS_ROOT,
    RuleParseError,
    chassis_char_ids,
    compose_rule,
    parse_rule,
    read_char_names,
    read_typekeys,
    rule_applies,
)

ENGINE_ROOT = 53363595
BODY_ROOT = 53046411
# a document hangs under several tree nodes at most a handful of times; more
# distinct paths than this is a data oddity, not something to ship whole
MAX_PATHS = 8
MAX_DEPTH = 40


def sp_of(ident):
    """The SP document number inside an identifier, or None."""
    for part in str(ident or "").split("-"):
        if part.startswith("SP") and part[2:].isdigit():
            return part
    return None


class Rules:
    """Every rule blob, decoded once on first use."""

    def __init__(self, con):
        self.raw = {r[0]: r[1] for r in con.execute("SELECT ID, RULE FROM XEP_RULES")}
        self.trees = {}
        self.unsure = set()

    def get(self, obj_id):
        """(tree or None, unsure) for one object id."""
        if obj_id in self.trees:
            return self.trees[obj_id], obj_id in self.unsure
        blob = self.raw.get(obj_id)
        tree = None
        if blob:
            try:
                tree, end = parse_rule(blob)
                if end != len(blob):
                    raise RuleParseError("trailing bytes")
            except RuleParseError:
                tree = None
                self.unsure.add(obj_id)
        self.trees[obj_id] = tree
        return tree, obj_id in self.unsure


def tree_paths(con):
    """The diagnosis tree as the maps a walk upward needs."""
    parent_of = {}
    for pid, cid in con.execute(
        "SELECT ID, DIAGNOSISOBJECTCONTROLID FROM XEP_REFDIAGNOSISTREE"
    ):
        parent_of[cid] = pid
    objs_by_ctrl = {}
    for oid, ctrl in con.execute(
        "SELECT ID, CONTROLID FROM XEP_DIAGNOSISOBJECTS WHERE CONTROLID IS NOT NULL"
    ):
        objs_by_ctrl.setdefault(ctrl, []).append(oid)
    doc_ctrls = {}
    for cid, io_id in con.execute(
        "SELECT ID, INFOOBJECTID FROM XEP_REFINFOOBJECTS "
        "WHERE LINK_TYPE_ID='DiagobjDocumentLink'"
    ):
        doc_ctrls.setdefault(io_id, []).append(cid)
    return parent_of, objs_by_ctrl, doc_ctrls


def ancestor_paths(io_id, rules, parent_of, objs_by_ctrl, doc_ctrls):
    """Every distinct path of gated ancestors above a document, nearest
    first, as lists of object ids whose rule decoded. An ancestor whose rule
    is unsure is left out of the path: the app would treat it as undecided,
    which keeps the document, and that is what leaving it out does too."""
    paths = []
    seen = set()
    for start in doc_ctrls.get(io_id, ()):
        path = []
        ctrl, depth = start, 0
        while ctrl is not None and depth < MAX_DEPTH:
            for oid in sorted(objs_by_ctrl.get(ctrl, ())):
                tree, _unsure = rules.get(oid)
                if tree:
                    path.append(oid)
            ctrl = parent_of.get(ctrl)
            depth += 1
        key = tuple(path)
        if key in seen:
            continue
        seen.add(key)
        paths.append(path)
        if len(paths) >= MAX_PATHS:
            break
    return paths


def main():
    """CLI entry: decode every SSP wiring document's applicability."""
    ns = parse_args(__doc__, positional=("args", 2, "DiagDocDb.decrypted.sqlite OUT.json[.gz]"))
    db, out = ns.args
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rules = Rules(con)
    parent_of, objs_by_ctrl, doc_ctrls = tree_paths(con)

    # the chassis folds the reference-document importer packs by
    typekeys = read_typekeys(con)
    char_names = read_char_names(con)
    chassis_names = sorted(
        {
            str(char_names.get(str(v), "")).upper()
            for tk in typekeys.values()
            for v in tk.get(str(CHASSIS_ROOT), [])
        }
        - {""}
    )
    folds = {c: chassis_char_ids(typekeys, char_names, c) for c in chassis_names}

    index = {}
    shipped = {}
    stats = dict(total=0, own=0, gated=0, unsure=0, generic=0, paths=0)
    for io_id, ident in con.execute(
        "SELECT ID, IDENTIFIER FROM XEP_INFOOBJECTS WHERE INFOTYPE='SSP'"
    ):
        sp = sp_of(ident)
        if not sp:
            continue
        stats["total"] += 1
        own, unsure = rules.get(io_id)
        paths = ancestor_paths(io_id, rules, parent_of, objs_by_ctrl, doc_ctrls)
        rec = {}
        if own:
            rec["r"] = str(io_id)
            shipped[str(io_id)] = own
            stats["own"] += 1
        if unsure:
            rec["u"] = 1
            stats["unsure"] += 1
        if paths:
            rec["p"] = [[str(o) for o in p] for p in paths]
            for p in paths:
                for o in p:
                    shipped[str(o)] = rules.trees[o]
            stats["gated"] += 1
            stats["paths"] += len(paths)
        composed = compose_rule(own, [[rules.trees[o] for o in p] for p in paths])
        if composed:
            rec["c"] = [c for c in chassis_names if rule_applies(composed, folds[c])]
        if not rec:
            stats["generic"] += 1
        index[sp] = rec

    doc = {
        "version": 2,
        "roots": {"chassis": CHASSIS_ROOT, "engine": ENGINE_ROOT, "body": BODY_ROOT},
        "rules": shipped,
        "sp": index,
    }
    text = json.dumps(doc, separators=(",", ":"), sort_keys=True)
    if out.endswith(".gz"):
        with gzip.GzipFile(out, "wb", mtime=0) as fh:
            fh.write(text.encode("utf-8"))
    else:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text)
    print("stats:", stats, "rules shipped:", len(shipped))
    print("wrote", out, "sp entries:", len(index), f"{os.path.getsize(out) / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
