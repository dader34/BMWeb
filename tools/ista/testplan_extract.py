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

THE RULES ARE DECIDED AGAINST THE CHASSIS, three-valued, by the same decoder
the other extracts use (validity_rules.py): no rule keeps, undecided keeps,
only a decided no drops. The tool decides them against one car; a rule about
equipment this build has no fact for is therefore kept rather than guessed.

    python3 tools/ista/testplan_extract.py --chassis E46
    python3 tools/ista/testplan_extract.py --chassis E46 --db /path/DiagDocDb.sqlite

Writes data/ista/testplan/<CHASSIS>.json.gz:

    faults   {"<ecu variant>:<code, decimal>": [object id, ...]}
    objects  {"<id>": {"t": title, "i": [info id, ...], "k": [child id, ...]}}
    infos    {"<id>": {"t": title, "y": type, "n": identifier}}

Only DATATYPE 'F' fault codes are read: that is the type the tool asks for
when it resolves a fault from a control unit. `k` is present only where the
calculation would descend (no ABL among the object's own info objects).

The output is BMW-derived data: data/ista/ is gitignored and hosted like the
rest of the ISTA extracts.
"""
import argparse
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
            if oid not in seen:
                seen.add(oid)
                reached.append(oid)

    # every object the calculation can arrive at: the linked ones, and below
    # an object with no test module of its own, its children (and so on)
    info_rows = {}
    objects = {}
    wanted = set()
    while reached:
        oid = reached.pop()
        cid, title = plan.objects[oid]
        own = plan.infos(cid)
        wanted.update(own)
        entry = {"t": title, "i": own}
        objects[str(oid)] = entry
        missing = [i for i in own if i not in info_rows]
        for chunk in (missing[n:n + 500] for n in range(0, len(missing), 500)):
            marks = ",".join("?" * len(chunk))
            for iid, typ, ident, ttl in con.execute(
                    "SELECT ID, INFOTYPE, IDENTIFIER, TITLE_ENGB FROM XEP_INFOOBJECTS "
                    f"WHERE ID IN ({marks})", chunk):
                info_rows[iid] = {"t": ttl or "", "y": typ or "", "n": ident or ""}
        if all(info_rows.get(i, {}).get("y") != "ABL" for i in own):
            kids = plan.children(cid)
            if kids:
                entry["k"] = kids
            for kid in kids:
                if kid not in seen:
                    seen.add(kid)
                    reached.append(kid)

    infos = {str(i): info_rows[i] for i in sorted(wanted) if i in info_rows}
    os.makedirs(ns.out, exist_ok=True)
    path = os.path.join(ns.out, f"{chassis}.json.gz")
    write_json_gz(path, {
        "version": 1, "chassis": chassis,
        "faults": faults, "objects": objects, "infos": infos,
    })
    types = {}
    for row in infos.values():
        types[row["y"]] = types.get(row["y"], 0) + 1
    top = ", ".join(f"{k or '-'} {v}" for k, v in sorted(types.items(), key=lambda kv: -kv[1])[:8])
    variants = len({k.split(":")[0] for k in faults})
    print(f"{chassis}: {len(faults)} fault codes on {variants} variants -> "
          f"{len(objects)} objects, {len(infos)} info objects ({top})")
    print(f"  {os.path.getsize(path) // 1024} KB -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
