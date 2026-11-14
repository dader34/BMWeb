#!/usr/bin/env python3
"""Extract what ISTA's Text Search searches, per chassis.

The tool's text search (FulltextSearchTabItemViewModel ->
JobPerformFullTextSearch -> DatabaseProviderSQLite.GetOccurrences) does not
search a tree. It searches EVERY document in the database:

    title     UPPER(TITLE) LIKE '%TERM%', over documents with VERSTECKT = 0
              and GENERELL = 0 whose type is one the search admits
              (OccurencesValidInfoTypes)
    number    IDENTIFIKATOR or SWZNUMMER LIKE '%TERM%', the same documents
    structure diagnosis objects whose title matches, and every document
              under them (the app answers this from the trees
              info_tree_extract.py ships)
    content   a full-text index over the bodies (not shipped; see below)

and then keeps a hit only when it is valid for the vehicle, is not of a
type the tool never lists (IsDocumentTypeHidden), and has no hidden
diagnosis object above it (IsAnyParentObjectHidden).

This ships the documents the title and number searches run over, for one
chassis: everything those three checks leave, with the rule the chassis
alone could not decide still attached, to be asked of the one car.

EACH TERM ALSO MATCHES ITS SYNONYMS. A typed word is looked up in ISOTERM
and every preferred or permitted term of the same concept is searched
beside it (GetPreferedTermForSearchTerm), so "battery" also finds what BMW
files under its preferred word for it. terms.json.gz ships that lookup for
English: {"<TERM, upper case>": ["<term>", ...]}.

THE CONTENT SEARCH IS NOT HERE. It runs over an FTS index of every body,
which is gigabytes; the app offers the box and says the index is not in
the build.

    python3 tools/ista/search_index_extract.py              # every mapped chassis
    python3 tools/ista/search_index_extract.py --chassis E46

Writes data/ista/search/<CHASSIS>.json.gz:

    {"docs": [[id, type, title, number, tool number, rule index], ...],
     "rules": [rule, ...]}        rule index -1: no rule to ask

Rules repeat heavily between documents, so each distinct one ships once.
The output is BMW-derived data: data/ista/ is gitignored and hosted like
the rest of the ISTA extracts.
"""
import argparse
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
sys.path.insert(0, HERE)

from diag_structure_extract import write_json_gz  # noqa: E402
from ecu_tree_extract import CHASSIS_TREE  # noqa: E402
from validity_rules import (  # noqa: E402
    chassis_char_ids,
    decode_rule,
    read_char_names,
    read_typekeys,
    rule_eval,
)

BMWFILES = os.environ.get("BMWFILES", os.path.expanduser("~/Development/code/BMWFILES"))

# BMW.Rheingold.DatabaseProvider.OccurencesValidInfoTypes, the default
VALID_TYPES = (
    "AKL,ANL,API,AZD,BNT,EBO,FEB,FKB,FTD,FUB,GPI,MSM,NEU,PIB,REP,SBS,SIT,"
    "SSP,STA,STG,SWS,SWZ,TED,COM,REH"
).split(",")

# DatabaseUtil.IsDocumentTypeHidden: never listed, whatever matched
HIDDEN_TYPES = {"VUL", "GPI", "FKB", "ANL", "STG", "NEU", "BNT"}


def hidden_controls(con):
    """Control ids of every diagnosis object that is hidden or under one.

    IsAnyParentObjectHidden walks UP from each object a document hangs on;
    walking DOWN once from every hidden object marks the same set.
    """
    hidden = set()
    for oid, control in con.execute(
            "SELECT ID, CONTROLID FROM XEP_DIAGNOSISOBJECTS WHERE VERSTECKT <> 0"):
        hidden.add(control or oid)
    kids = {}
    for parent, child in con.execute(
            "SELECT ID, DIAGNOSISOBJECTCONTROLID FROM XEP_REFDIAGNOSISTREE"):
        kids.setdefault(parent, []).append(child)
    todo = list(hidden)
    while todo:
        for child in kids.get(todo.pop(), ()):
            if child not in hidden:
                hidden.add(child)
                todo.append(child)
    return hidden


def synonyms(con):
    """GetPreferedTermForSearchTerm as one table, for English."""
    langs = ("en-GB", "en-US")
    marks = ",".join("?" for _ in langs)
    by_concept = {}
    for concept, term in con.execute(
            f"SELECT CONCEPT_ID, TERM FROM ISOTERM WHERE LANGUAGE IN ({marks}) "
            "AND TERM_TYPE IN ('Vorzugsterm', 'Zugelassener Term')", langs):
        if term and term.strip():
            by_concept.setdefault(concept, set()).add(term.strip())
    out = {}
    for concept, term in con.execute(
            f"SELECT CONCEPT_ID, TERM FROM ISOTERM WHERE LANGUAGE IN ({marks}) "
            "AND TERM_TYPE IN ('Negativterm', 'Vorzugsterm', 'Zugelassener Term')",
            langs):
        key = (term or "").strip().upper()
        if not key:
            continue
        # a term that only stands for itself adds nothing to a search
        others = {t for t in by_concept.get(concept, ()) if t.upper() != key}
        if others:
            out.setdefault(key, set()).update(others)
    return {k: sorted(v) for k, v in sorted(out.items())}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--chassis", help="one development code, e.g. E46 (default: all mapped)")
    ap.add_argument("--db", default=os.path.join(
        BMWFILES, "ista", "databases", "DiagDocDb.decrypted.sqlite"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "ista", "search"))
    ns = ap.parse_args()
    if not os.path.exists(ns.db):
        raise SystemExit(f"no database at {ns.db} (see $BMWFILES/ista/README.md)")
    con = sqlite3.connect(f"file:{ns.db}?mode=ro", uri=True)
    typekeys, chars = read_typekeys(con), read_char_names(con)

    size = write_json_gz(os.path.join(ns.out, "terms.json.gz"), synonyms(con))
    print(f"  synonyms: {size // 1024} KB")

    types = [t for t in VALID_TYPES if t not in HIDDEN_TYPES]
    marks = ",".join("?" for _ in types)
    rows = con.execute(
        "SELECT ID, INFOTYPE, TITLE_ENGB, IDENTIFIKATOR, SWZNUMMER FROM XEP_INFOOBJECTS "
        f"WHERE VERSTECKT = 0 AND GENERELL = 0 AND INFOTYPE IN ({marks})", types).fetchall()
    rules = dict(con.execute("SELECT ID, RULE FROM XEP_RULES"))
    hidden = hidden_controls(con)
    under_hidden = {
        doc for node, doc in con.execute("SELECT ID, INFOOBJECTID FROM XEP_REFINFOOBJECTS")
        if node in hidden}

    wanted = [ns.chassis.upper()] if ns.chassis else sorted(CHASSIS_TREE)
    for chassis in wanted:
        ids = chassis_char_ids(typekeys, chars, chassis)
        if not ids:
            print(f"  {chassis}: not in this database, skipped")
            continue
        docs = []
        shared = {}
        trees = []
        for doc, kind, title, number, tool in rows:
            if doc in under_hidden:
                continue
            tree, unsure = decode_rule(rules.get(doc))
            index = -1
            if not unsure and tree is not None:
                if rule_eval(tree, ids) is False:
                    continue
                key = json.dumps(tree, sort_keys=True)
                if key not in shared:
                    shared[key] = len(trees)
                    trees.append(tree)
                index = shared[key]
            docs.append([doc, kind, title or "", number or "", tool or "", index])
        size = write_json_gz(
            os.path.join(ns.out, f"{chassis}.json.gz"),
            {"version": 1, "chassis": chassis, "docs": docs, "rules": trees})
        print(f"  {chassis:5} {len(docs):6} documents  {len(trees):5} rules  {size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
