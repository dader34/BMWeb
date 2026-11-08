#!/usr/bin/env python3
"""Compare the WDS tree's own applicability with BMWeb's (ISTA-rule) filter.

    tools/wiring/wds_vs_ista.py --wds-tree ".../release/us/e46/tree/e46_wds_us_files.xml" \\
        --db BMWFILES/ista/databases/DiagDocDb.decrypted.sqlite \\
        --index data/wiring-applicability.json.gz \\
        --etk data/etk/E46.etk --rulefacts app/renderer/data/ista/techdata/rulefacts.json

BMWeb's wiring viewer filters a chassis's WDS schematics by ISTA's validity
rules (screens/wiring/applicability.js, the Python twin being
tools/ista/validity_rules.py). The WDS application has no filter of its own:
its tree names carry the conditions (tools/wiring/wds_rules.py). This tool
evaluates both for every schematic of the chassis against every type key the
ETK bundle knows, at a few build months each, and reports where they differ:

  WDS shows / BMWeb hides   ISTA's rule is tighter than the WDS text (an end
                            date, a market, a body the name does not say)
  WDS hides / BMWeb shows   ISTA's rule lacks a condition the WDS name has
                            (mostly an engine or model restriction)

Per DOCUMENT: WDS shows a schematic when ANY of its leaves applies (the same
SP number hangs under several conditioned leaves). The ISTA side is evaluated
exactly as the app does it for a VIN-identified car: the type key's
characteristic ids, the production month as the DATE fact, the rule facts
(ECU cliques, SA table) loaded, identification level 3.

Only what both sides can decide is compared; a leaf about an option or an
ECU family the car's facts cannot settle is undecided on the WDS side and
left out of the agreement figure.
"""
import argparse
import collections
import gzip
import json
import os
import re
import sqlite3
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "ista"))
import wds_rules  # noqa: E402
import validity_rules as vr  # noqa: E402

BODY = {"Saloon": "Lim", "Touring": "Tou", "Coupe": "Cou", "convertible": "Cab", "Compact": "com"}
TKBODY = {"SED": "Lim", "SAL": "Lim", "TOUR": "Tou", "COUPE": "Cou", "CONV": "Cab", "COMP": "com"}
DIESEL = {"M47", "M47N", "M57", "M57N"}
ROOT_BASIC = "2000016666796"


def read_tree(path):
    """Every leaf of a WDS tree file with its folder path."""
    s = open(path, encoding="utf-8", errors="replace").read()
    tok = re.compile(r"<(folder|leaf|/folder|root|/root)\b([^>]*)>")
    attr = re.compile(r'(\w+)="([^"]*)"')
    stack, out = [], []
    for m in tok.finditer(s):
        tag, a = m.group(1), dict(attr.findall(m.group(2)))
        if tag == "folder":
            stack.append(a.get("name", ""))
        elif tag == "/folder":
            stack.pop()
        elif tag == "leaf":
            mm = re.search(r"file=([A-Z]+\d+)\.htm", a.get("link", ""))
            out.append({"name": a.get("name", ""), "doc": mm.group(1) if mm else None, "path": list(stack)})
    return out


def car_atom(v, market):
    """The WDS atoms one ETK variant can answer: body, steering, market, engine, model."""
    motor, body, model = v["motor"], v["body"], v["model"].split()[0]

    def f(t):
        t = t.strip()
        if t in BODY:
            return body == BODY[t]
        if t == "left-hand drive":
            return v["steer"] == "L"
        if t == "right-hand drive":
            return v["steer"] == "R"
        if t in ("USA_LHD", "EUR_LHD", "EUR_RHD"):
            if v["steer"] != ("L" if t.endswith("LHD") else "R"):
                return False
            return None if market is None else market == ("US" if t.startswith("USA") else "ECE")
        m = re.match(r"^(M\d\d|N\d\d|S\d\d|M\d\d/TU) engine$", t)
        if m:
            return motor == m.group(1).replace("/TU", "N")
        if t == "Diesel engine":
            return motor in DIESEL
        if t.startswith("DDE "):
            return None if motor in DIESEL else False
        if t.startswith("DME "):
            return None if motor not in DIESEL else False
        m = re.match(r"^(M3|M3CSL|\d{3}[A-Za-z]*)_(?:A_)?([A-Z]\d\d)_([A-Z]+)$", t)
        if m:
            mod, eng, bd = m.groups()
            if mod == "M3CSL":
                return None
            okm = v["model"].startswith("M3") if mod == "M3" else model.lower() == mod.lower()
            if not okm or motor != eng or body != TKBODY.get(bd):
                return False
            return None if "_A_" in t else True
        if t == "all-wheel drive":
            return "xi" in model.lower() or "xd" in model.lower()
        if t == "3 Series_E46":
            return True
        return None

    return f


def wds_leaf(leaf, atom, ym):
    conds = [c for p in leaf["path"] for c in wds_rules.conditions_of(p)] + wds_rules.conditions_of(leaf["name"])
    if not conds:
        return True
    vals = [wds_rules.ev(c, atom, ym) for c in conds]
    if any(x is False for x in vals):
        return False
    return None if any(x is None for x in vals) else True


def tri(w):
    return "N" if w is None else ("T" if w else "F")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wds-tree", required=True)
    ap.add_argument("--db", required=True, help="DiagDocDb.decrypted.sqlite")
    ap.add_argument("--index", required=True, help="wiring-applicability.json.gz")
    ap.add_argument("--etk", required=True, help="the chassis's .etk bundle (its variants are the cars)")
    ap.add_argument("--rulefacts", help="ista/techdata/rulefacts.json, as the app loads it")
    ap.add_argument("--months", default="3,15,27", help="months after each type key's introduction to test")
    ap.add_argument("--out", help="write the per-document disagreements here (JSON)")
    args = ap.parse_args()

    leaves = [l for l in read_tree(args.wds_tree) if l["doc"] and l["doc"].startswith("SP")]
    idx = json.load(gzip.open(args.index)) if args.index.endswith(".gz") else json.load(open(args.index))
    con = sqlite3.connect("file:%s?mode=ro" % args.db, uri=True)
    tk_all, names = vr.read_typekeys(con), vr.read_char_names(con)
    aux = json.load(open(args.rulefacts)) if args.rulefacts else {}
    variants = json.loads(zipfile.ZipFile(args.etk).read("tree.json"))["variants"]
    months = [int(x) for x in args.months.split(",")]

    cars = []
    for v in variants:
        tk = tk_all.get(v["key"])
        if not tk:
            continue
        market = None
        for x in tk.get(ROOT_BASIC, []):
            market = names.get(str(x))
        intro = int(str(v["date"])[:6]) if v["date"] else 199901
        yms = []
        for add in months:
            y, m = divmod(intro, 100)
            m += add
            y += (m - 1) // 12
            m = (m - 1) % 12 + 1
            yms.append(y * 100 + m)
        ids = {int(x) for vals in tk.values() for x in vals}
        cars.append((v, car_atom(v, market), yms, ids, {int(r) for r in tk}))

    bydoc = collections.defaultdict(list)
    for l in leaves:
        bydoc[l["doc"]].append(l)
    composed = {}
    for doc in bydoc:
        rec = idx["sp"].get(doc)
        if rec is None or rec.get("u"):
            composed[doc] = "skip"
            continue
        own = idx["rules"].get(rec["r"]) if rec.get("r") else None
        paths = [[idx["rules"].get(i) for i in p] for p in rec.get("p", [])]
        composed[doc] = vr.compose_rule(own, paths)

    conf = collections.Counter()
    perdoc = collections.defaultdict(collections.Counter)
    example = {}
    for doc, ls in bydoc.items():
        tree = composed[doc]
        if tree == "skip":
            continue
        for v, atom, yms, ids, roots in cars:
            for ym in yms:
                y, m = divmod(ym, 100)
                facts = {"ym": ym, "built": vr.date_ticks(y, m, 1), "roots": roots, "level": 3,
                         "prodart": "P", "aux": aux, "country": ""}
                i = True if tree is None else vr.rule_eval(tree, ids, facts)
                vals = [wds_leaf(l, atom, ym) for l in ls]
                w = True if any(x is True for x in vals) else (None if any(x is None for x in vals) else False)
                key = tri(w) + tri(i)
                conf[key] += 1
                if key in ("TF", "FT"):
                    perdoc[key][doc] += 1
                    example.setdefault((key, doc), (v["key"], v["model"], v["body"], v["steer"], ym))

    tot = sum(conf.values())
    print("schematics: %d in the WDS tree, %d in the ISTA index, %d cars (type keys) x %d months"
          % (len(bydoc), sum(1 for d in bydoc if composed[d] != "skip"), len(cars), len(months)))
    print("per document (WDS verdict, BMWeb verdict):")
    for k in sorted(conf):
        print("  %s %s  %8d  %5.1f%%" % (k[0], k[1], conf[k], 100 * conf[k] / tot))
    dec = sum(conf[k] for k in conf if "N" not in k)
    if dec:
        print("both decided: %d, agree %.2f%%" % (dec, 100 * (conf["TT"] + conf["FF"]) / dec))
    print("distinct documents  WDS shows / BMWeb hides: %d   WDS hides / BMWeb shows: %d"
          % (len(perdoc["TF"]), len(perdoc["FT"])))
    for key, title in (("FT", "WDS hides / BMWeb shows"), ("TF", "WDS shows / BMWeb hides")):
        print("\n== %s (top) ==" % title)
        for doc, n in perdoc[key].most_common(12):
            l = bydoc[doc][0]
            print("  %s  %5d  %s | %s" % (doc, n, l["name"][:70], " ".join(map(str, example[(key, doc)]))))
    if args.out:
        json.dump({k: {d: {"n": n, "name": bydoc[d][0]["name"], "car": example[(k, d)]} for d, n in c.items()}
                   for k, c in perdoc.items()}, open(args.out, "w"), indent=1)
        print("\nwrote", args.out)


if __name__ == "__main__":
    main()
