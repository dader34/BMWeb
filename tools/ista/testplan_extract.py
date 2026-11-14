#!/usr/bin/env python3
"""Extract what ISTA's test plan calculation reads, for one chassis.

"Calculate test plan" is three lookups, and this ships the rows each one
returns so the app can run the same calculation offline. They are taken from
the tool's own database provider (DatabaseProviderSQLite, de-obfuscated), not
inferred from the result:

  GetDiagObjectsByFaultCode
      XEP_REFDIAGOBJECTS WHERE ID = <fault code id>      -> the diagnosis
      objects a fault points at, through DIAGNOSISOBJECTCONTROLID. The link
      is dropped when the FAULT's own validity rule says no, and an object is
      dropped when it is not valid for the vehicle.
  GetInfoObjectsByDiagObjectControlId
      XEP_REFINFOOBJECTS WHERE ID = <object control id>  -> EVERY info
      object linked to the object. There is no filter on the link type: the
      plan lists documents (FUB, SSP, ...) beside test modules (ABL).
  GetChildDiagObjects
      XEP_REFDIAGNOSISTREE WHERE ID = <object control id> -> the objects
      beneath one. The calculation descends into these only when an object
      has no test module of its own.

VALID FOR THE VEHICLE is IsDiagObjectValid: the object's own rule holds, and
so does the rule of at least one chain of parents up to a root. That chain is
what scopes the result to a platform -- the branch an E46 lives under carries
the rule that names it -- so a fault code shared with another series does not
pull that series' components in.

THE RULES ARE DECIDED TWICE. Here, against the CHASSIS, three-valued, by the
same decoder the other extracts use (validity_rules.py): no rule keeps,
undecided keeps, only a decided no drops -- that is what cuts the database
down to one series. Then again in the app, against the CAR: a chassis is the
union of its builds, so "an M54 or an N42" is true of an E46 and false of
any one E46. Every rule that survives the first pass is therefore shipped
(`r`) for the app to decide with the car's own engine, build date and
options, which is the question the tool itself asks.

An object's `r` is the whole of IsDiagObjectValid in one tree: its own rule
AND (any one chain of its parents' rules). An info object's is its own rule;
it is only ever reached from an object that is already valid.

    python3 tools/ista/testplan_extract.py --chassis E46
    python3 tools/ista/testplan_extract.py --chassis E46 --db /path/DiagDocDb.sqlite

FAULT PATTERNS go through the same objects. A symptom points at diagnosis
objects exactly as a fault code does (GetDiagAndInfoObjectsByPerceivedSymptomsId:
XEP_REFDIAGOBJECTS WHERE ID = <symptom id>), and the page that picks one
shows THREE trees over one table (PerceivedSymptomsTree): the component
fault patterns (RootCon), the functional ones (RootFun, with RootFM's
children filed under the same root) and the older Fault patterns tree
(RootOld). A node is shown when it is a car's (PKW is 1 or unset) and its own
rule holds, and only under a parent that is shown; siblings are ordered by
the tool's SortingTag.

Writes data/ista/testplan/<CHASSIS>.json.gz:

    faults      {"<ecu variant>:<code, decimal>": [object id, ...]}
    faultRules  {"<ecu variant>:<code, decimal>": rule}   where the fault has one
    objects     {"<id>": {"t": title, "i": [info id, ...], "k": [child id, ...], "r": rule}}
    infos       {"<id>": {"t": title, "y": type, "n": identifier, "r": rule}}
    symptoms    {"<symptom id>": [object id, ...]}
    trees       [{"id", "label", "vfc", "sel", "r", "kids": [...]}, ...]  the roots
    noAnswer    {"<ecu group>": [{"c": code, "t": text}, ...]}  see below

A CONTROL UNIT THAT DOES NOT ANSWER gets a fault of its own. When a module
fails to identify, the tool adds the virtual fault codes filed under its ECU
group with ECUNOANSWER = 1 (VehicleIdent.AddVirtualErrorCodesIfNeeded) --
"S 0003 No communication possible with ..." -- and shows them in the fault
memory. They carry no relevance verdict, so they never reach the test plan;
`noAnswer` is what the fault memory lists for a silent module.

Only DATATYPE 'F' fault codes are read: that is the type the tool asks for
when it resolves a fault from a control unit. `k` lists an object's valid
children wherever the calculation can descend: below an object with no test
module of its own on the fault path, and below every object on the symptom
path, which always descends.

The output is BMW-derived data: data/ista/ is gitignored and hosted like the
rest of the ISTA extracts.
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
from validity_rules import (  # noqa: E402
    chassis_char_ids,
    decode_rule,
    read_char_names,
    read_typekeys,
    rule_eval,
)

BMWFILES = os.environ.get("BMWFILES", os.path.expanduser("~/Development/code/BMWFILES"))

# The parent the symptom table's four vocabularies hang off; it is not a row.
SYMPTOM_VIRTUAL_PARENT = 7866251


def _dedupe(trees):
    seen, out = set(), []
    for t in trees:
        key = json.dumps(t, sort_keys=True)
        if key not in seen:
            seen.add(key)
            out.append(t)
    return out


def all_of(trees):
    """AND of rule trees, where None is "no rule" and drops out."""
    kept = _dedupe([t for t in trees if t is not None])
    if not kept:
        return None
    return kept[0] if len(kept) == 1 else {"op": "and", "kids": kept}


def any_of(trees):
    """OR of rule trees; one with no rule makes the whole thing no rule."""
    if any(t is None for t in trees):
        return None
    kept = _dedupe(trees)
    return kept[0] if len(kept) == 1 else {"op": "or", "kids": kept}


class Plan:
    """The tables the calculation reads, and the validity checks over them."""

    def __init__(self, con, ids):
        self.con = con
        self.ids = ids
        self.rules = dict(con.execute("SELECT ID, RULE FROM XEP_RULES"))
        self._rule = {}
        self._valid = {}
        # object id -> (control id, title); control id -> [object ids]
        self.objects = {}
        self.by_control = {}
        self.roots = set()
        for oid, cid, title in con.execute(
                "SELECT ID, CONTROLID, TITLE_ENGB FROM XEP_DIAGNOSISOBJECTS ORDER BY ID"):
            self.objects[oid] = (cid or 0, title or "")
            if cid:
                self.by_control.setdefault(cid, []).append(oid)
            else:
                # a root has no control id; its children hang off its ID
                self.roots.add(oid)
        # the tree's edges: (parent control id, child control id)
        self.parents = {}
        self.kids = {}
        for parent, child in con.execute(
                "SELECT ID, DIAGNOSISOBJECTCONTROLID FROM XEP_REFDIAGNOSISTREE"):
            self.parents.setdefault(child, []).append(parent)
            self.kids.setdefault(parent, []).append(child)

    def rule_tree(self, key):
        """A rule as the app's evaluator reads it, or None for none/undecodable."""
        tree, unsure = decode_rule(self.rules.get(key))
        return None if unsure else tree

    def parents_rule(self, cid, seen=()):
        """parents_ok as a rule: None when always valid, False when never."""
        if not cid:
            return None
        ups = self.parents.get(cid, ())
        if not ups:
            return None
        chains = []
        for up in ups:
            if not up or up in self.roots:
                return None
            oids = self.by_control.get(up)
            if not oids:
                return None
            if not self.rule_ok(oids[0]) or up in seen:
                continue
            above = self.parents_rule(up, seen + (cid,))
            if above is False:
                continue
            chain = all_of([self.rule_tree(oids[0]), above])
            if chain is None:
                return None
            chains.append(chain)
        if not chains:
            return False
        return any_of(chains)

    def object_rule(self, oid):
        """IsDiagObjectValid as one rule tree, or None when it always holds."""
        above = self.parents_rule(self.objects[oid][0])
        return all_of([self.rule_tree(oid), None if above is False else above])

    def rule_ok(self, key):
        """A validity rule's verdict: False only when it decodes to a no."""
        if key not in self._rule:
            tree, unsure = decode_rule(self.rules.get(key))
            self._rule[key] = True if (unsure or tree is None) else (
                rule_eval(tree, self.ids) is not False)
        return self._rule[key]

    def parents_ok(self, cid, seen=()):
        """AreAllParentDiagObjectsValid: one chain of parents holds to a root."""
        if not cid:
            return True
        ups = self.parents.get(cid, ())
        if not ups:
            return True
        candidates = []
        for up in ups:
            if not up or up in self.roots:
                return True
            oids = self.by_control.get(up)
            if not oids:
                return True
            if self.rule_ok(oids[0]) and up not in seen:
                candidates.append(up)
        return any(self.parents_ok(up, seen + (cid,)) for up in candidates)

    def valid(self, oid):
        """IsDiagObjectValid: its own rule, then its parents."""
        if oid not in self._valid:
            cid = self.objects[oid][0]
            self._valid[oid] = self.rule_ok(oid) and self.parents_ok(cid)
        return self._valid[oid]

    def infos(self, cid):
        """The info objects linked to one object, in id order, valid ones only."""
        out = []
        for (iid,) in self.con.execute(
                "SELECT DISTINCT INFOOBJECTID FROM XEP_REFINFOOBJECTS WHERE ID = ? "
                "ORDER BY INFOOBJECTID", (cid,)):
            if self.rule_ok(iid):
                out.append(iid)
        return out

    def children(self, cid):
        """The valid objects directly beneath one, in id order."""
        out = []
        for child in sorted(set(self.kids.get(cid, ()))):
            for oid in self.by_control.get(child, ()):
                if self.valid(oid):
                    out.append(oid)
        return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--chassis", default="E46", help="development code, e.g. E46")
    ap.add_argument("--db", default=os.path.join(
        BMWFILES, "ista", "databases", "DiagDocDb.decrypted.sqlite"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "ista", "testplan"))
    ns = ap.parse_args()
    if not os.path.exists(ns.db):
        raise SystemExit(f"no database at {ns.db} (see $BMWFILES/ista/README.md)")
    chassis = ns.chassis.upper()
    con = sqlite3.connect(f"file:{ns.db}?mode=ro", uri=True)
    ids = chassis_char_ids(read_typekeys(con), read_char_names(con), chassis)
    if not ids:
        raise SystemExit(f"{chassis}: no characteristic ids; not in this database")
    plan = Plan(con, ids)

    faults = {}
    fault_rules = {}
    reached = []
    seen = set()
    rows = con.execute(
        "SELECT f.ID, f.CODE, lower(v.NAME), r.DIAGNOSISOBJECTCONTROLID "
        "FROM XEP_FAULTCODES f "
        "JOIN XEP_ECUVARIANTS v ON v.ID = f.ECUVARIANTID "
        "JOIN XEP_REFDIAGOBJECTS r ON r.ID = f.ID "
        "WHERE f.DATATYPE = 'F' AND f.CODE IS NOT NULL "
        "ORDER BY v.NAME, f.CODE, f.ID, r.DIAGNOSISOBJECTCONTROLID")
    for fid, code, variant, cid in rows:
        if not plan.rule_ok(fid):
            continue
        for oid in plan.by_control.get(cid, ()):
            if not plan.valid(oid):
                continue
            hit = faults.setdefault(f"{variant}:{code}", [])
            if oid not in hit:
                hit.append(oid)
            rule = plan.rule_tree(fid)
            if rule is not None:
                fault_rules[f"{variant}:{code}"] = rule
            if oid not in seen:
                seen.add(oid)
                reached.append(oid)

    # ---- the symptom trees, and the objects each symptom points at ----------
    sym = {}
    kids_of = {}
    for sid, parent, title, sel, vfc, vnr, pkw in con.execute(
            "SELECT ID, PARENTID, TITLE_ENGB, SELECTABLE, VFC_TYP, VFC_NR, PKW "
            "FROM XEP_PERCEIVEDSYMPTOMS ORDER BY ID"):
        sym[sid] = (parent, title or "", sel, vfc or "", vnr or "", pkw)
        kids_of.setdefault(parent, []).append(sid)

    def sorting_tag(sid):
        """XEP_PERCEIVEDSYMPTOMSEX.SortingTag: how siblings are ordered."""
        parent, title, _sel, vfc, _nr, _pkw = sym[sid]
        up = sym.get(parent, (None, "", None, "", "", None))[3]
        if up in ("RootFM", "RootFun"):
            return {"FA": "B_", "FO_F": "A_"}.get(vfc, "") + title
        return {"FO_K": "C_", "FO_F": "C_", "FA": "B_", "FL_F": "A_"}.get(vfc, "") + title

    def node_valid(sid):
        """PerceivedSymptomsTreeNode.IsNodeValid, for a car."""
        pkw = sym[sid][5]
        return (pkw is None or pkw == 1) and plan.rule_ok(sid)

    symptom_links = {}
    symptom_objects = []

    def build(sid, path, extra=()):
        parent, title, sel, vfc, _nr, _pkw = sym[sid]
        node = {"id": sid, "label": title}
        rule = plan.rule_tree(sid)
        if rule is not None:
            node["r"] = rule
        if vfc:
            node["vfc"] = vfc
        if sel == 0:
            node["sel"] = 0
        hit = []
        for (cid,) in con.execute(
                "SELECT DIAGNOSISOBJECTCONTROLID FROM XEP_REFDIAGOBJECTS WHERE ID = ? "
                "ORDER BY DIAGNOSISOBJECTCONTROLID", (sid,)):
            for oid in plan.by_control.get(cid, ()):
                if plan.valid(oid) and oid not in hit:
                    hit.append(oid)
        if hit:
            symptom_links[str(sid)] = hit
            symptom_objects.extend(hit)
        below = [k for k in list(kids_of.get(sid, ())) + list(extra)
                 if k not in path and node_valid(k)]
        kids = [build(k, path | {sid}) for k in sorted(below, key=lambda k: (sorting_tag(k), k))]
        if kids:
            node["kids"] = kids
        return node

    tops = {sym[s][3]: s for s in kids_of.get(SYMPTOM_VIRTUAL_PARENT, ())}
    trees = []
    for root_type in ("RootCon", "RootFun", "RootOld"):
        root = tops.get(root_type)
        if root is None or not node_valid(root):
            continue
        # the functional tree files RootFM's children under RootFun too
        second = tops.get("RootFM") if root_type == "RootFun" else None
        extra = kids_of.get(second, ()) if second is not None else ()
        trees.append(build(root, frozenset(), extra))

    # every object the calculation can arrive at: the linked ones, and below
    # an object with no test module of its own, its children (and so on);
    # below a symptom's objects the tool always descends
    info_rows = {}
    objects = {}
    wanted = set()
    always = set()
    stack = list(symptom_objects)
    while stack:
        oid = stack.pop()
        if oid in always:
            continue
        always.add(oid)
        stack.extend(plan.children(plan.objects[oid][0]))
    for oid in always:
        if oid not in seen:
            seen.add(oid)
            reached.append(oid)
    while reached:
        oid = reached.pop()
        cid, title = plan.objects[oid]
        own = plan.infos(cid)
        wanted.update(own)
        entry = {"t": title, "i": own}
        rule = plan.object_rule(oid)
        if rule is not None:
            entry["r"] = rule
        objects[str(oid)] = entry
        missing = [i for i in own if i not in info_rows]
        for chunk in (missing[n:n + 500] for n in range(0, len(missing), 500)):
            marks = ",".join("?" * len(chunk))
            for iid, typ, ident, ttl in con.execute(
                    "SELECT ID, INFOTYPE, IDENTIFIER, TITLE_ENGB FROM XEP_INFOOBJECTS "
                    f"WHERE ID IN ({marks})", chunk):
                info_rows[iid] = {"t": ttl or "", "y": typ or "", "n": ident or ""}
                rule = plan.rule_tree(iid)
                if rule is not None:
                    info_rows[iid]["r"] = rule
        if oid in always or all(info_rows.get(i, {}).get("y") != "ABL" for i in own):
            kids = plan.children(cid)
            if kids:
                entry["k"] = kids
            for kid in kids:
                if kid not in seen:
                    seen.add(kid)
                    reached.append(kid)

    infos = {str(i): info_rows[i] for i in sorted(wanted) if i in info_rows}

    # ---- a control unit that does not answer --------------------------------
    no_answer = {}
    for group, vid, code, label in con.execute(
            "SELECT lower(g.NAME), v.ID, v.CODE, "
            "  (SELECT l.TITLE_ENGB FROM XEP_REFFAULTLABELS rl "
            "   JOIN XEP_VIRTUALFAULTLABELS l ON l.ID = rl.LABELID "
            "   WHERE rl.ID = v.ID ORDER BY l.ID LIMIT 1) "
            "FROM XEP_VIRTUALFAULTCODES v JOIN XEP_ECUGROUPS g ON g.ID = v.PARENTID "
            "WHERE v.ECUNOANSWER = 1 ORDER BY g.NAME, v.CODE, v.ID"):
        if not plan.rule_ok(vid):
            continue
        row = {"c": code or "", "t": label or ""}
        rule = plan.rule_tree(vid)
        if rule is not None:
            row["r"] = rule
        no_answer.setdefault(group, []).append(row)
    os.makedirs(ns.out, exist_ok=True)
    path = os.path.join(ns.out, f"{chassis}.json.gz")
    write_json_gz(path, {
        "version": 1, "chassis": chassis,
        "faults": faults, "faultRules": fault_rules,
        "objects": objects, "infos": infos,
        "symptoms": symptom_links, "trees": trees, "noAnswer": no_answer,
    })
    types = {}
    for row in infos.values():
        types[row["y"]] = types.get(row["y"], 0) + 1
    top = ", ".join(f"{k or '-'} {v}" for k, v in sorted(types.items(), key=lambda kv: -kv[1])[:8])
    variants = len({k.split(":")[0] for k in faults})
    print(f"{chassis}: {len(faults)} fault codes on {variants} variants -> "
          f"{len(objects)} objects, {len(infos)} info objects ({top})")
    def count(node):
        return 1 + sum(count(k) for k in node.get("kids", ()))
    shape = ", ".join(f"{t['label']} {count(t) - 1}" for t in trees)
    print(f"  symptom trees: {shape or '(none)'}; {len(symptom_links)} symptoms point at objects")
    ruled = sum(1 for o in objects.values() if "r" in o) + sum(1 for i in infos.values() if "r" in i)
    print(f"  {ruled} rules shipped for the car to decide, {len(fault_rules)} on fault codes; "
          f"{len(no_answer)} ECU groups with a no-answer fault")
    print(f"  {os.path.getsize(path) // 1024} KB -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
