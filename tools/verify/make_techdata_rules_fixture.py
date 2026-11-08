#!/usr/bin/env python3
"""Pin the renderer's validity-rule evaluator to its Python twin.

    tools/verify/make_techdata_rules_fixture.py \\
        --db BMWFILES/ista/databases/DiagDocDb.decrypted.sqlite \\
        --index data/wiring-applicability.json.gz --etk data/etk/E46.etk \\
        --rulefacts app/renderer/data/ista/techdata/rulefacts.json

techDataRuleEval (screens/techdata/data.js) and rule_eval
(tools/ista/validity_rules.py) must agree: the extractor counts and shards
with one, the app filters with the other. This samples real rule trees
from the wiring index -- every leaf kind the corpus has, plus a few
composed document rules -- and evaluates each against E46 type keys at a
few build months, once as a VIN-identified vehicle (level 3) and once with
no vehicle (the open, three-valued mode). The verdicts go to
tools/verify/fixtures/techdata-rules.json; test_techdata_rules.js replays
them through the JS evaluator.
"""
import argparse
import collections
import gzip
import json
import os
import random
import sqlite3
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools", "ista"))
import validity_rules as vr  # noqa: E402

OUT = os.path.join(HERE, "fixtures", "techdata-rules.json")


def ops_of(rule, acc):
    if not rule:
        return acc
    acc.add(rule.get("op"))
    for k in rule.get("kids") or []:
        ops_of(k, acc)
    return acc


def tri(v):
    return "N" if v is None else ("T" if v else "F")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True)
    ap.add_argument("--index", required=True)
    ap.add_argument("--etk", required=True, help="the chassis bundle whose variants are the cars")
    ap.add_argument("--rulefacts", required=True)
    ap.add_argument("--rules", type=int, default=240, help="rule trees to sample")
    ap.add_argument("--cars", type=int, default=16, help="type keys to sample")
    ap.add_argument("--seed", type=int, default=46)
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    rnd = random.Random(args.seed)

    idx = json.load(gzip.open(args.index))
    aux = json.load(open(args.rulefacts))
    con = sqlite3.connect("file:%s?mode=ro" % args.db, uri=True)
    tk_all = vr.read_typekeys(con)
    variants = json.loads(zipfile.ZipFile(args.etk).read("tree.json"))["variants"]

    # the rules: every leaf kind the corpus has gets a quota, the rest random
    by_op = collections.defaultdict(list)
    for rid, r in idx["rules"].items():
        for op in ops_of(r, set()):
            by_op[op].append(rid)
    picked = []
    seen = set()
    for op, rids in sorted(by_op.items()):
        for rid in rnd.sample(rids, min(12, len(rids))):
            if rid not in seen:
                seen.add(rid)
                picked.append(idx["rules"][rid])
    pool = [rid for rid in idx["rules"] if rid not in seen]
    for rid in rnd.sample(pool, max(0, args.rules - len(picked))):
        picked.append(idx["rules"][rid])
    # composed document rules: own AND (OR over ancestor paths)
    docs = [d for d, rec in idx["sp"].items() if rec.get("p") and rec.get("r")]
    for d in rnd.sample(docs, min(24, len(docs))):
        rec = idx["sp"][d]
        own = idx["rules"].get(rec["r"])
        paths = [[idx["rules"].get(i) for i in p] for p in rec["p"]]
        picked.append(vr.compose_rule(own, paths))

    # the cars: type keys with their ids, at three build months each
    cars = []
    keys = [v for v in variants if v["key"] in tk_all]
    for v in rnd.sample(keys, min(args.cars, len(keys))):
        tk = tk_all[v["key"]]
        intro = int(str(v["date"])[:6]) if v["date"] else 199901
        for add in (3, 27):
            y, m = divmod(intro, 100)
            m += add
            y += (m - 1) // 12
            m = (m - 1) % 12 + 1
            cars.append({
                "key": v["key"],
                "ids": sorted({int(x) for vals in tk.values() for x in vals}),
                "roots": sorted({int(r) for r in tk}),
                "ym": y * 100 + m,
                "built": vr.date_ticks(y, m, 1),
            })

    cases = []
    for ri, rule in enumerate(picked):
        for ci, car in enumerate(cars):
            ids = set(car["ids"])
            vehicle = {"ym": car["ym"], "built": car["built"], "roots": set(car["roots"]),
                       "level": 3, "prodart": "P", "aux": aux, "country": ""}
            open_ = {"ym": car["ym"], "built": car["built"], "roots": set(car["roots"])}
            cases.append([ri, ci, tri(vr.rule_eval(rule, ids, vehicle)), tri(vr.rule_eval(rule, ids, open_))])

    counts = collections.Counter(c[2] for c in cases), collections.Counter(c[3] for c in cases)
    json.dump({
        "about": "techDataRuleEval vs validity_rules.rule_eval; made by make_techdata_rules_fixture.py",
        "rulefacts": "app/renderer/data/ista/techdata/rulefacts.json",
        "rules": picked, "cars": cars,
        "cases": cases,  # [rule index, car index, vehicle verdict, open verdict] as T/F/N
    }, open(args.out, "w"), separators=(",", ":"))
    print("rules %d (ops: %s), cars %d, cases %d; vehicle %s, open %s; wrote %s" % (
        len(picked), " ".join(sorted(by_op)), len(cars), len(cases), dict(counts[0]), dict(counts[1]), args.out))


if __name__ == "__main__":
    main()
