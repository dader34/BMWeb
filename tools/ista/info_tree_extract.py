#!/usr/bin/env python3
"""Extract the trees ISTA's structure pages browse, as the tool builds them.

EVERY STRUCTURE PAGE IN THE TOOL IS ONE MECHANISM. Product structure,
Operating fluids, Workshop equipment and Mobile service (and the function
and component structures, which diag_structure_extract.py ships with their
document bodies) are all a DiagnosisObjectsTree over XEP_DIAGNOSISOBJECTS,
told apart only by the root they start from and the document types the
page shows (InfoBrowserTreeFactory, DiagnosisObjectsTree, InfoObjFilter):

    product   DiagnosticObjectConstructiveRoot      Product structure, and
                                                    Operating fluids, which
                                                    is this same tree shown
                                                    with other types
    sws       DiagnosticObjectRegisterStructure     Workshop equipment
              named "SWS"
    mob       DiagnosticObjectRegisterStructure     Mobile service
              named "MOB"

WHAT THE TOOL DOES, step for step (DiagnosisObjectsTreeNode):

  children   the rows XEP_REFDIAGNOSISTREE files under the node's control
             id (a root has none, so its own id stands in)
  shown      a node whose every ancestor and itself passes its validity
             rule for the car (IsNodePathValid) and none of which is hidden
             (VERSTECKT, IsNodePathHidden)
  title      under the product root a main group is "<HG number> <title>"
             and a subgroup "<HG/UG number> <title>" (TitleMode)
  order      by SortingTag: the group number, else the sort order and the
             title, with every run of digits padded so "2" sorts before
             "10" (PadNumberInString)
  documents  the info objects XEP_REFINFOOBJECTS links to the node's
             control id, each passing its own rule and not hidden, and then
             the same of every shown child, each document once

VALIDITY IS DECIDED TWICE, as everywhere in these extracts. Here a rule is
run against the chassis, which is the union of its builds, and what it
rules out is dropped. What passes ships with its rule, and the app asks it
again of the one car. A rule that does not decode keeps its node or
document, as the tool keeps what it cannot rule out.

    python3 tools/ista/info_tree_extract.py              # every mapped chassis
    python3 tools/ista/info_tree_extract.py --chassis E46

Writes data/ista/infotree/<CHASSIS>.json.gz:

    {"trees": {"product": [node, ...], "sws": [...], "mob": [...]},
     "docs": {"<id>": [type, title, rule?]}}
    node = {"id": control id, "t": title, "r": rule?, "d": [doc id, ...],
            "k": [node, ...]}

THE BODIES of the documents no other extract carries go with it. The
repair extract holds the repair instructions (REP) and the workshop
reference extract holds TED, AZD, SBS, SWZ and SWS; the product tree also
lists service information, repair notes, function descriptions and more
(SIT, REH, FTD, FEB, COM, MSM ...), and a document that lists but cannot
be opened is half a page. With --content those are parsed by the same
reader the diagnosis structures use and written beside the trees:

    data/ista/infotree/<CHASSIS>/docs/<id>.json.gz

and types.json, the names the Filters dialog gives each document type
(XEP_WSCONFIGFILTERS, as DatabaseProvider.GetInfoTypeByAbbreviation reads
it): {"REP": "Repair Instructions (REP)", ...}.

The output is BMW-derived data: data/ista/ is gitignored and hosted like
the rest of the ISTA extracts.
"""
import argparse
import json
import xml.etree.ElementTree as ET
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
sys.path.insert(0, HERE)

import diag_structure_extract  # noqa: E402
from diag_structure_extract import (  # noqa: E402
    Content,
    Diag,
    _flat,
    _local,
    parse_document,
    write_bodies,
    write_json_gz,
)
from ecu_tree_extract import CHASSIS_TREE  # noqa: E402
from validity_rules import (  # noqa: E402
    chassis_char_ids,
    decode_rule,
    read_char_names,
    read_typekeys,
    rule_eval,
)

BMWFILES = os.environ.get("BMWFILES", os.path.expanduser("~/Development/code/BMWFILES"))

# Types whose bodies another extract already ships (repair_extract.py and
# technical_data_extract.py); everything else is written here.
BODY_ELSEWHERE = {"REP", "TED", "AZD", "SBS", "SWZ", "SWS"}

# The product root's node class: under it a node is titled by its group
# number (DiagnosisObjectsTreeNode.Children).
CONSTRUCTIVE_ROOT_CLASS = 5215490


def pad_numbers(text):
    """XEP_DIAGNOSISOBJECTSEX.PadNumberInString: the natural-order key."""
    if not text:
        return ""
    spaced = re.sub(r"(?<=[0-9])(?=[A-Za-z])|(?<=[A-Za-z])(?=[0-9])", " ", text)
    return "".join(p.rjust(8, "0") if p.isdigit() else p for p in spaced.split(" ") if p)


_HEADINGS = ("TITLE", "HEADLINE", "HEADING", "SUBJECT", "LEAD-TITLE")


def parse_generic(xml):
    """Any document body as headed sections of paragraphs and tables.

    The diagnosis reader knows the service and repair schemas. The product
    tree also lists overviews (technical data, tightening torques, operating
    fluids), repair notes and mobile-service pages, each in a schema of its
    own. Rather than a reader per schema, this reads them by SHAPE, which
    they share:

      a heading element   starts a section (the first one titles the page)
      a TABLE             is a table, row by row, entry by entry
      a GRAPHIC           is a figure
      a RECORD            an element whose children are all short plain
                          values (a name, a value, a unit) is one table
                          row, and consecutive records make one table;
                          sibling sentences are a list
      anything with text  and no structure beneath it is a paragraph

    Nothing is interpreted, so nothing is misread: what the document holds
    is what is shown, in its order.

    @param xml: the stored body
    @returns: {title, kind, sections} or None when it holds no text
    """
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    for node in root.iter():
        node.tag = _local(node.tag)
    sections = []
    current = {"blocks": [], "title": ""}
    title = ""

    def flush():
        nonlocal current
        if current["blocks"]:
            sections.append(current)
        current = {"blocks": [], "title": ""}

    def add_row(cells):
        last = current["blocks"][-1] if current["blocks"] else None
        if last and last.get("t") == "table" and last.get("_rec") and \
                len(last["rows"][0]) == len(cells):
            last["rows"].append(cells)
        else:
            current["blocks"].append({"_rec": 1, "head": 0, "rows": [cells], "t": "table"})

    def walk(node):
        nonlocal title
        for child in node:
            tag = child.tag
            kids = list(child)
            if tag in _HEADINGS:
                text = _flat(child)
                if not text:
                    continue
                if not title:
                    title = text
                    continue
                flush()
                current["title"] = text
            elif tag == "TABLE":
                rows = [
                    [_flat(e) for e in row.iter("ENTRY")] for row in child.iter("ROW")]
                rows = [r for r in rows if any(r)]
                if rows:
                    current["blocks"].append({"head": 0, "rows": rows, "t": "table"})
            elif tag == "GRAPHIC":
                src = (child.get("SRC") or "").strip()
                if src and not src.startswith("--"):
                    current["blocks"].append({"s": src, "t": "pic"})
            elif not kids:
                text = _flat(child)
                if text:
                    current["blocks"].append({"s": text, "t": "p"})
            elif (child.text or "").strip():
                # mixed content: prose with inline markup
                text = _flat(child)
                if text:
                    current["blocks"].append({"s": text, "t": "p"})
            elif len(kids) >= 2 and all(not list(k) for k in kids) and \
                    not any(k.tag in _HEADINGS or k.tag == "GRAPHIC" for k in kids):
                cells = [_flat(k) for k in kids]
                if not any(cells):
                    continue
                # short values side by side are a record; sentences that
                # happen to be siblings are a list
                if max(len(c) for c in cells) <= 48:
                    add_row(cells)
                else:
                    for c in cells:
                        if c:
                            current["blocks"].append({"s": c, "t": "bullet"})
            else:
                walk(child)

    walk(root)
    flush()
    for sec in sections:
        for block in sec["blocks"]:
            block.pop("_rec", None)
    if not sections:
        return None
    return {"kind": "generic", "sections": sections, "title": title}


def parse_any(xml):
    """The diagnosis reader where it knows the schema, the shape reader else."""
    if not xml:
        return None
    return parse_document(xml) or parse_generic(xml)


class Trees:
    """The tables the tool reads, and its checks over them, for one chassis."""

    def __init__(self, con, ids):
        self.ids = ids
        self.rules = dict(con.execute("SELECT ID, RULE FROM XEP_RULES"))
        self._rule = {}
        # control id (or the id, for a root) -> the rows that carry it
        self.objects = {}
        for row in con.execute(
                "SELECT ID, CONTROLID, NODECLASS, TITLE_ENGB, VERSTECKT, HG_NUMMER, "
                "HGUG_NUMMER, GROBZEICHEN, SORT_ORDER, NAME FROM XEP_DIAGNOSISOBJECTS"):
            self.objects.setdefault(row[1] or row[0], []).append(row)
        self.kids = {}
        for parent, child in con.execute(
                "SELECT ID, DIAGNOSISOBJECTCONTROLID FROM XEP_REFDIAGNOSISTREE"):
            self.kids.setdefault(parent, []).append(child)
        self.links = {}
        for node, doc in con.execute("SELECT ID, INFOOBJECTID FROM XEP_REFINFOOBJECTS"):
            self.links.setdefault(node, []).append(doc)
        self.infos = {
            row[0]: row for row in con.execute(
                "SELECT ID, INFOTYPE, TITLE_ENGB, VERSTECKT, NODECLASS "
                "FROM XEP_INFOOBJECTS")}
        self.classes = dict(con.execute("SELECT NAME, ID FROM XEP_NODECLASSES"))
        self.docs = {}

    def rule(self, key):
        """(tree or None, holds for the chassis); undecodable holds."""
        if key not in self._rule:
            tree, unsure = decode_rule(self.rules.get(key))
            if unsure or tree is None:
                self._rule[key] = (None, True)
            else:
                self._rule[key] = (tree, rule_eval(tree, self.ids) is not False)
        return self._rule[key]

    def roots(self, nodeclass, name=None):
        """GetDiagObjectsByNodeclassName, optionally narrowed by NAME."""
        want = self.classes.get(nodeclass)
        found = [r for rows in self.objects.values() for r in rows if r[2] == want]
        if name is not None:
            found = [r for r in found if (r[9] or "") == name]
        return found[:1]

    def title(self, row, by_group):
        """XEP_DIAGNOSISOBJECTSEX.Title for the node's TitleMode."""
        text = row[3] or ""
        if by_group and row[5]:
            return f"{row[5]} {text}"
        if by_group and row[6]:
            return f"{row[6]} {text}"
        return text

    def sort_key(self, row, title):
        """XEP_DIAGNOSISOBJECTSEX.SortingTag."""
        if row[5]:
            return pad_numbers(row[5])
        if row[6]:
            return pad_numbers(row[6])
        order = "" if row[8] is None else str(row[8])
        if row[7]:
            return pad_numbers(f"{order} {row[7]}")
        plain = title.replace("-", " ")
        return pad_numbers(f"{order} {plain}" if order else plain)

    def documents(self, control):
        """The node's own documents: linked, valid, not hidden."""
        out = []
        for doc in self.links.get(control, ()):
            info = self.infos.get(doc)
            if not info or info[3]:
                continue
            tree, ok = self.rule(doc)
            if not ok:
                continue
            if doc not in self.docs:
                entry = [info[1] or "", info[2] or ""]
                if tree is not None:
                    entry.append(tree)
                self.docs[doc] = entry
            if doc not in out:
                out.append(doc)
        return out

    def node(self, row, by_group, path):
        """One shown node with everything under it, or None when not shown."""
        if row[4]:
            return None
        tree, ok = self.rule(row[0])
        if not ok:
            return None
        control = row[1] or row[0]
        title = self.title(row, by_group)
        out = {"id": control, "t": title}
        if tree is not None:
            out["r"] = tree
        docs = self.documents(control)
        if docs:
            out["d"] = docs
        kids = self.children(control, by_group, path | {control})
        if kids:
            out["k"] = kids
        out["_sort"] = self.sort_key(row, title)
        return out

    def children(self, control, by_group, path):
        """The shown children of a node, in the tool's order."""
        found = []
        for child in self.kids.get(control, ()):
            # the structure is a graph; a node already on the way down is
            # not walked into again
            if child in path:
                continue
            for row in self.objects.get(child, ()):
                node = self.node(row, by_group, path)
                if node:
                    found.append(node)
        found.sort(key=lambda n: n["_sort"])
        for n in found:
            del n["_sort"]
        return found

    def tree(self, nodeclass, name=None):
        """One page's tree: the root's shown children."""
        roots = self.roots(nodeclass, name)
        if not roots:
            return []
        root = roots[0]
        return self.children(
            root[1] or root[0], root[2] == CONSTRUCTIVE_ROOT_CLASS, {root[1] or root[0]})


def count(nodes):
    """How many nodes a tree holds."""
    return sum(1 + count(n.get("k", ())) for n in nodes)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--chassis", help="one development code, e.g. E46 (default: all mapped)")
    ap.add_argument("--db", default=os.path.join(
        BMWFILES, "ista", "databases", "DiagDocDb.decrypted.sqlite"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "ista", "infotree"))
    ap.add_argument("--content", default=os.path.join(
        BMWFILES, "ista", "databases", "xmlvalueprimitive_ENGB.sqlite"),
        help="the body store; bodies are skipped when it is absent")
    ap.add_argument("--no-bodies", action="store_true", help="trees only")
    ns = ap.parse_args()
    if not os.path.exists(ns.db):
        raise SystemExit(f"no database at {ns.db} (see $BMWFILES/ista/README.md)")
    con = sqlite3.connect(f"file:{ns.db}?mode=ro", uri=True)
    typekeys, chars = read_typekeys(con), read_char_names(con)
    # the Filters dialog's labels: a title ends in its abbreviation
    labels = {}
    for (title,) in con.execute("SELECT TITLE_ENGB FROM XEP_WSCONFIGFILTERS"):
        m = re.search(r"\(([A-Z]{3})\)\s*$", title or "")
        if m:
            labels.setdefault(m.group(1), title.strip())
    os.makedirs(ns.out, exist_ok=True)
    with open(os.path.join(ns.out, "types.json"), "w", encoding="utf-8") as f:
        json.dump(labels, f, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    wanted = [ns.chassis.upper()] if ns.chassis else sorted(CHASSIS_TREE)
    bodies = not ns.no_bodies and os.path.exists(ns.content)
    diag = Diag(ns.db) if bodies else None
    content = Content(ns.content) if bodies else None
    for chassis in wanted:
        ids = chassis_char_ids(typekeys, chars, chassis)
        if not ids:
            print(f"  {chassis}: not in this database, skipped")
            continue
        trees = Trees(con, ids)
        out = {
            "version": 1,
            "chassis": chassis,
            "trees": {
                "product": trees.tree("DiagnosticObjectConstructiveRoot"),
                "sws": trees.tree("DiagnosticObjectRegisterStructure", "SWS"),
                "mob": trees.tree("DiagnosticObjectRegisterStructure", "MOB"),
            },
            "docs": {str(k): v for k, v in trees.docs.items()},
        }
        size = write_json_gz(os.path.join(ns.out, f"{chassis}.json.gz"), out)
        sizes = " ".join(f"{k}={count(v)}" for k, v in out["trees"].items())
        print(f"  {chassis:5} {sizes}  docs={len(out['docs'])}  {size // 1024} KB")
        if bodies:
            need = {
                (doc, trees.infos[doc][4])
                for doc, entry in trees.docs.items()
                if entry[0] not in BODY_ELSEWHERE
            }
            # the shared writer, reading unknown schemas by shape
            diag_structure_extract.parse_document = parse_any
            stats, by_type, _pics, _index = write_bodies(
                diag, content, {}, need, os.path.join(ns.out, chassis))
            got = " ".join(
                f"{t}={c['body']}/{c['docs']}" for t, c in sorted(by_type.items()))
            print(f"        bodies: {stats['bodies']} written  {got}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
