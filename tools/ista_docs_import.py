#!/usr/bin/env python3
"""Extract ISTA reference documents (all text types) into a per-chassis bundle.

The Wiring Diagrams app was built from the WDS ISO, which only carries wiring
schematics (ISTA's SSP type). ISTA's DiagDocDb holds far more: repair
instructions (REP), pin assignments (PIB), installation locations (EBO),
connector views (STA), functional descriptions (FUB), technical data (TED),
tightening torques (AZD), special tools (SWZ), service information (SIT/SBS/
SWS/FTD/NEU), and more. This extracts the TEXT-bodied types (graphics-only SSP
and executable ABL / attached-PDF ANL are handled elsewhere / deferred) into a
.docs bundle shaped like the .wiring / .chassis archives the renderer already
inflates.

RESOLUTION CHAIN (proven against the E46 A1 pin-assignment doc):

    XEP_INFOOBJECTS   doc row: ID, INFOTYPE, TITLE_ENGB, CONTROLID
        │ CONTROLID
        ▼
    XEP_REFCONTENTS   ID(=controlid) -> CONTENTCONTROLID
        │
        ▼
    XEP_IOCONTENTS    CONTROLID(=contentcontrolid) -> CONTENT_ENGB (content id)
        │ content id
        ▼
    xmlvalueprimitive_ENGB.sqlite   id -> data (the document body XML)

WHICH DOCS BELONG TO A CHASSIS. Same authority as wiring: the applicability
index (build_applicability.py) decodes ISTA's own validity rules. A doc is in
E46's bundle if the applicability index says its rule names E46 (or it is
generally valid and its identifier/tree ties it to E46). This spike selects by
identifier chassis-token OR applicability, and packs one chassis.

BODY SCHEMAS. The taxonomy collapses to a few root elements, each parsed into
the SAME typed-block format ista_extract.py already uses so the renderer has
one code path:
    {"t":"p","s":..} | {"t":"bullet","s":..} | {"t":"table","rows":[[..],..]}
    {"t":"h","s":..}  (a sub-heading inside a chapter)

    DIAGNOSISDOCUMENT   EBO, FUB, PIB, STA  (FUNCTIONALDESCRIPTION | PINASSIGNMENTS)
    REPAIRMANUALDOCUMENT REP, FEB, REH
    SI / SERVICEDOCUMENT FTD, SIT, SBS, SWS, NEU, GPI, COM
    TECHNICALDATA        TED
    TIGHTENINGTORQUES    AZD
    SPECIALTOOLDOCUMENT  SWZ
    INTRODUCTION         MSM

Output: data/ista-docs/<CHASSIS>.docs  (a zip: manifest.json + docs/<id>.json)
    manifest = {chassis, types:{TYPE:count}, docs:[{id,type,title,tree?}]}
    docs/<id>.json = {id, type, title, chapters:[{heading, blocks:[...]}]}

Usage:
    tools/ista_docs_import.py --diagdoc DiagDocDb.decrypted.sqlite \\
        --content xmlvalueprimitive_ENGB.sqlite --chassis E46 \\
        --out data/ista-docs [--limit N] [--type PIB]
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET
import zipfile

# reuse the proven inline-text + table helpers from the fault extractor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ista_extract import _flat, _text_of, _parse_table  # noqa: E402

# text-bodied types this tool ingests (graphics/executable/PDF excluded)
TEXT_TYPES = [
    "REP", "EBO", "PIB", "STA", "FUB", "TED", "AZD", "SWZ",
    "FTD", "SIT", "SBS", "SWS", "NEU", "MSM", "FEB", "REH", "COM", "GPI",
]


# ---- generic block collection ----------------------------------------------
# A superset of ista_extract._collect_blocks that also emits sub-headings as
# {"t":"h"} so repair steps and multi-section docs keep their structure.
def _blocks(el):
    out = []

    def walk(node):
        for child in node:
            tag = child.tag
            if tag == "HEADING":
                t = _flat(child)
                if t:
                    out.append({"t": "h", "s": t})
            elif tag == "PARAGRAPH":
                t = _flat(child)
                if t:
                    out.append({"t": "p", "s": t})
            elif tag in ("LISTENTRY", "LISTELEMENT"):
                t = _text_of(child)
                if t:
                    out.append({"t": "bullet", "s": t})
            elif tag == "TABLE":
                rows = _parse_table(child)
                if not rows:
                    continue
                if max(len(r) for r in rows) == 1:
                    for r in rows:
                        out.append({"t": "bullet", "s": r[0]})
                else:
                    out.append({"t": "table", "rows": rows})
            else:
                walk(child)

    walk(el)
    return out


# ---- schema parsers: each -> {title, chapters:[{heading, blocks:[...]}]} -----
def _rows_from_generic_table(parent, rowtags, headtag, celltags):
    """Flat table schemas (PIB pin tables, plug tables) that use their own
    element names instead of the CALS TABLE/ROW/ENTRY model. celltags is the
    ordered list of cell element names; headtag names the header row."""
    rows = []
    for row in parent:
        if row.tag == headtag or row.tag in rowtags:
            cells = []
            for ct in celltags:
                el = row.find(ct)
                cells.append(_flat(el) if el is not None else "")
            if any(c for c in cells):
                rows.append(cells)
    return rows


def parse_pinassignments(root):
    """DIAGNOSISDOCUMENT/PINASSIGNMENTS -> connector-view + per-plug pin tables."""
    pa = root.find("PINASSIGNMENTS")
    if pa is None:
        return None
    title = (pa.findtext("DOCUMENTTITLE") or pa.findtext("HEADING") or "").strip()
    chapters = []
    for plug in pa.findall("PLUG"):
        heading = (plug.findtext("HEADING") or "").strip()
        tbl = plug.find("PLUGTABLE")
        blocks = []
        if tbl is not None:
            rows = _rows_from_generic_table(
                tbl, ("PLUGROW",), "PLUGHEADROW",
                ("PLUGNUMBER", "PLUGTYPE", "PLUGDESCRIPTION"))
            if rows:
                blocks.append({"t": "table", "rows": rows})
        if blocks:
            chapters.append({"heading": heading, "blocks": blocks})
    # PINS blocks: rows are split across PINROW1 (main) + PINROW2 (continuation)
    cols = ("PINPIN", "PINTYPE", "PINDESCRIPTION", "PINTESTERDISPLAY",
            "PINPORT", "PINMEASURINGHINTS")
    for pins in pa.findall("PINS"):
        heading = (pins.findtext("HEADING") or "").strip()
        tbl = pins.find("PINTABLE")
        if tbl is None:
            continue
        header = tbl.find("PINHEADROW")
        rows = []
        if header is not None:
            rows.append([_flat(header.find(c)) if header.find(c) is not None
                         else "" for c in cols])
        # merge each PINROW1 with the PINROW2 that follows it
        pending = None
        for row in tbl:
            if row.tag == "PINROW1":
                if pending is not None:
                    rows.append(pending)
                pending = [_flat(row.find(c)) if row.find(c) is not None
                           else "" for c in cols]
            elif row.tag == "PINROW2" and pending is not None:
                for i, c in enumerate(cols):
                    el = row.find(c)
                    if el is not None:
                        extra = _flat(el)
                        if extra:
                            pending[i] = (pending[i] + " " + extra).strip()
        if pending is not None:
            rows.append(pending)
        # drop all-empty columns so a sparse table stays readable
        rows = _trim_empty_cols(rows)
        if len(rows) > 1:
            chapters.append({"heading": heading,
                             "blocks": [{"t": "table", "rows": rows}]})
    if not chapters:
        return None
    return {"title": title, "chapters": chapters}


def _trim_empty_cols(rows):
    if not rows:
        return rows
    ncol = max(len(r) for r in rows)
    keep = [i for i in range(ncol)
            if any(len(r) > i and r[i].strip() for r in rows[1:] or rows)]
    if not keep:
        return rows
    return [[r[i] if len(r) > i else "" for i in keep] for r in rows]


def parse_functional(root):
    """DIAGNOSISDOCUMENT/FUNCTIONALDESCRIPTION (FUB, EBO, STA text)."""
    fd = root.find("FUNCTIONALDESCRIPTION")
    if fd is None:
        return None
    title = (fd.findtext("DOCUMENTTITLE") or "").strip()
    chapters = []
    intro = fd.find("FUNCDESCINTRODUCTORY")
    if intro is not None:
        b = _blocks(intro)
        if b:
            chapters.append({"heading": "", "blocks": b})
    for ch in fd.findall("CHAPTER"):
        heading = (ch.findtext("HEADING") or "").strip()
        b = _blocks(ch)
        if b:
            chapters.append({"heading": heading, "blocks": b})
    return {"title": title, "chapters": chapters} if chapters else None


def parse_diagnosisdocument(xml):
    """Root DIAGNOSISDOCUMENT dispatches on its child schema."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    if root.tag != "DIAGNOSISDOCUMENT":
        return None
    if root.find("PINASSIGNMENTS") is not None:
        return parse_pinassignments(root)
    if root.find("FUNCTIONALDESCRIPTION") is not None:
        return parse_functional(root)
    # some EBO/STA carry a bare body: collect everything
    b = _blocks(root)
    return {"title": "", "chapters": [{"heading": "", "blocks": b}]} if b else None


def parse_generic_root(xml, expect=None):
    """REPAIRMANUALDOCUMENT / TECHNICALDATA / TIGHTENINGTORQUES /
    SPECIALTOOLDOCUMENT / INTRODUCTION / SI / SERVICEDOCUMENT: walk the whole
    tree into blocks, using any DOCUMENTTITLE/HEADING found as the title."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    if expect and root.tag != expect:
        # SI vs SERVICEDOCUMENT etc. are interchangeable within a type; accept any
        pass
    # prefer a real document-title element over the first stray HEADING/TITLE
    title = (root.findtext(".//DOCUMENTTITLE")
             or root.findtext(".//PROCESSTITLE/PROCESSDESC")   # REP
             or root.findtext(".//PROCESSDESC")
             or root.findtext(".//SI_TITLE")                   # SI / service docs
             or (root.find(".//HEADING") is not None
                 and _flat(root.find(".//HEADING")))
             or "")
    title = re.sub(r"\s+", " ", title).strip()
    blocks = _blocks(root)
    if not blocks:
        return None
    # split into chapters on top-level {"t":"h"} boundaries for readability
    chapters, cur = [], {"heading": "", "blocks": []}
    for blk in blocks:
        if blk["t"] == "h":
            if cur["blocks"]:
                chapters.append(cur)
            cur = {"heading": blk["s"], "blocks": []}
        else:
            cur["blocks"].append(blk)
    if cur["blocks"]:
        chapters.append(cur)
    return {"title": title, "chapters": chapters} if chapters else None


def parse_body(xml):
    """Dispatch on the root element to the right schema parser."""
    m = re.match(r"\s*(?:<\?xml[^>]*\?>\s*)?<([A-Z0-9_]+)", xml)
    if not m:
        return None
    root = m.group(1)
    if root == "DIAGNOSISDOCUMENT":
        return parse_diagnosisdocument(xml)
    if root == "svg":
        return None            # graphics handled by the wiring pipeline
    return parse_generic_root(xml)


# ---- resolution chain -------------------------------------------------------
class Store:
    def __init__(self, diag, content):
        self.d = sqlite3.connect(diag)
        self.c = sqlite3.connect(content)
        self.dc, self.cc = self.d.cursor(), self.c.cursor()

    def body(self, infoobj_id):
        row = self.dc.execute(
            "SELECT CONTROLID FROM XEP_INFOOBJECTS WHERE ID=?",
            (infoobj_id,)).fetchone()
        if not row or row[0] is None:
            return None
        ctrl = row[0]
        ccids = [r[0] for r in self.dc.execute(
            "SELECT CONTENTCONTROLID FROM XEP_REFCONTENTS WHERE ID=?", (ctrl,))]
        for ccid in ccids:
            r = self.dc.execute(
                "SELECT CONTENT_ENGB FROM XEP_IOCONTENTS WHERE CONTROLID=?",
                (ccid,)).fetchone()
            if r and r[0]:
                b = self.cc.execute(
                    "SELECT data FROM xmlvalueprimitive WHERE id=? AND deleted=0",
                    (r[0],)).fetchone()
                if b and b[0]:
                    return b[0]
        return None

    # ---- component tree ----------------------------------------------------
    # ISTA groups a component's documents under a diagnosis-tree node whose id
    # is a XEP_REFINFOOBJECTS.ID with LINK_TYPE_ID='DiagobjDocumentLink'. That
    # same id is a XEP_DIAGNOSISOBJECTS.CONTROLID (the component, e.g. A1
    # "Control unit, General Module"), and XEP_REFDIAGNOSISTREE gives its parent
    # chain up to the "Components" root -- exactly the component browser tree.
    def load_tree(self):
        if getattr(self, "_parent", None) is not None:
            return
        self._parent = {}
        for pid, cid in self.dc.execute(
                "SELECT ID, DIAGNOSISOBJECTCONTROLID FROM XEP_REFDIAGNOSISTREE"):
            self._parent[cid] = pid
        self._objname = {}
        for cid, code, title in self.dc.execute(
                "SELECT CONTROLID, NAME, TITLE_ENGB FROM XEP_DIAGNOSISOBJECTS"):
            # a component reads best as "A1 Control unit, General Module"
            nm = (title or "").strip()
            code = (code or "").strip()
            if code and not nm.startswith(code):
                nm = (code + " " + nm).strip()
            self._objname[cid] = nm or code

    def doc_nodes(self, doc_id):
        """The tree node ids that link this document (usually one)."""
        return [r[0] for r in self.dc.execute(
            "SELECT ID FROM XEP_REFINFOOBJECTS "
            "WHERE INFOOBJECTID=? AND LINK_TYPE_ID='DiagobjDocumentLink'",
            (doc_id,))]

    def node_chain(self, node):
        """node -> [ (id, name), ... ] from the component up to (not incl.) the
        unnamed structure roots. Empty if the node isn't a named diag object."""
        chain, seen, x = [], set(), node
        while x and x not in seen:
            seen.add(x)
            nm = self._objname.get(x)
            if not nm:                 # reached an unnamed structure root: stop
                break
            chain.append((x, nm))
            x = self._parent.get(x)
            if not x:
                break
        return chain


def _ident_names_chassis(ident, chassis):
    """True if an ISTA identifier carries the chassis token. The token appears
    in several forms across doc types:
        EBO/PIB/STA:  ...-E46_...            (underscore-delimited)
        REP:          ...-RAE4611N42-...     ("RA" + chassis, then engine/digits)
        TED:          ...-TD16-E461614B1...  (chassis embedded, followed by digits)
    So match the chassis as a token whose left edge is a non-alphanumeric (or the
    'RA' repair prefix) and whose right edge is a non-letter (digit, '_' or end).
    The right edge must not be a LETTER, so 'E46' never matches inside 'E460'..;
    but a digit is allowed (E461614) because chassis+figure-number is REP/TED's
    own convention."""
    c = re.escape(chassis)
    # left: start | non-alnum | the RA repair prefix ; right: not a letter
    return re.search(r"(?:^|[^A-Za-z0-9]|RA)" + c + r"(?![A-Za-z])", ident or "") \
        is not None


def chassis_doc_ids(store, chassis, types, applic):
    """The doc ids belonging to a chassis. A doc qualifies if the applicability
    index says its rule names the chassis, OR its identifier carries the chassis
    token (covers docs the index leaves generally-valid)."""
    ids = {}
    q = ("SELECT ID, INFOTYPE, TITLE_ENGB, IDENTIFIER FROM XEP_INFOOBJECTS "
         "WHERE INFOTYPE IN (%s)" % ",".join("?" * len(types)))
    for did, itype, title, ident in store.dc.execute(q, types):
        ident = ident or ""
        by_ident = _ident_names_chassis(ident, chassis)
        by_rule = False
        if applic is not None:
            spid = _sp_of(ident)
            rec = applic.get(spid) if spid else None
            if rec and rec.get("c"):
                by_rule = chassis.upper() in [c.upper() for c in rec["c"]]
        if by_ident or by_rule:
            ids[did] = {"type": itype, "title": (title or "").strip(),
                        "ident": ident}
    return ids


def _sp_of(ident):
    m = re.search(r"(SP\d{10})", ident or "")
    return m.group(1) if m else None


def main():
    ap = argparse.ArgumentParser(description="Extract ISTA reference documents")
    ap.add_argument("--diagdoc", required=True)
    ap.add_argument("--content", required=True)
    ap.add_argument("--chassis", required=True)
    ap.add_argument("--out", default="data/ista-docs")
    ap.add_argument("--applicability", help="wiring-applicability.json[.gz] for "
                    "rule-based chassis selection (optional)")
    ap.add_argument("--type", help="restrict to one INFOTYPE (for spiking)")
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()

    for p in (args.diagdoc, args.content):
        if not os.path.exists(p):
            sys.exit("missing: " + p)

    applic = None
    if args.applicability and os.path.exists(args.applicability):
        import gzip
        raw = (gzip.open if args.applicability.endswith(".gz") else open)(
            args.applicability, "rb").read()
        applic = json.loads(raw).get("sp", {})

    store = Store(args.diagdoc, args.content)
    # applicability decoder (engine/body/dates) for VIN filtering, shared with
    # the wiring index so both read ISTA's rules the same way
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "wiring"))
    from ista_rules import RuleDecoder
    rules = RuleDecoder(store.d)
    types = [args.type] if args.type else TEXT_TYPES
    catalog = chassis_doc_ids(store, args.chassis, types, applic)
    print(f"{args.chassis}: {len(catalog)} candidate docs across "
          f"{len(set(v['type'] for v in catalog.values()))} types")

    store.load_tree()
    os.makedirs(args.out, exist_ok=True)
    bundle_path = os.path.join(args.out, f"{args.chassis}.docs")
    manifest = {"chassis": args.chassis, "types": {}, "count": 0}
    # a component-structure tree: node id -> {name, parent, docs:[docid]}. Built
    # only from branches that actually carry a doc for this chassis, so it's the
    # pruned component browser rather than the whole 78k-object ISTA tree.
    nodes = {}
    order = []                 # child->parent edges discovered, for stable build
    n_ok = n_empty = n_untreed = 0
    with zipfile.ZipFile(bundle_path, "w", zipfile.ZIP_DEFLATED) as z:
        for i, (did, meta) in enumerate(catalog.items()):
            if args.limit and i >= args.limit:
                break
            xml = store.body(did)
            if not xml:
                n_empty += 1
                continue
            parsed = parse_body(xml)
            if not parsed or not parsed.get("chapters"):
                n_empty += 1
                continue
            title = parsed.get("title") or meta["title"]
            applic = rules.doc_applicability(did)   # {e,b,f,t} for VIN filtering
            doc = {"id": did, "type": meta["type"], "title": title,
                   "chapters": parsed["chapters"]}
            z.writestr(f"docs/{did}.json",
                       json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
            manifest["types"][meta["type"]] = manifest["types"].get(
                meta["type"], 0) + 1
            manifest["count"] += 1
            n_ok += 1

            # place the doc in the component tree via its linking node's chain
            placed = False
            for node in store.doc_nodes(did):
                chain = store.node_chain(node)      # [(component..root)]
                if not chain:
                    continue
                # register every node in the chain and its child->parent edge
                for j, (cid, nm) in enumerate(chain):
                    if cid not in nodes:
                        nodes[cid] = {"name": nm, "parent": None, "docs": []}
                        order.append(cid)
                    parent = chain[j + 1][0] if j + 1 < len(chain) else None
                    nodes[cid]["parent"] = parent
                leaf = chain[0][0]                  # the component node
                nodes[leaf]["docs"].append(
                    dict({"id": did, "type": meta["type"], "title": title},
                         **({"a": applic} if applic else {})))
                placed = True
                break                                # one placement is enough
            if not placed:
                n_untreed += 1
                nodes.setdefault("_ungrouped", {
                    "name": "Other documents", "parent": None, "docs": []})
                nodes["_ungrouped"]["docs"].append(
                    dict({"id": did, "type": meta["type"], "title": title},
                         **({"a": applic} if applic else {})))

        tree = build_tree(nodes)
        manifest["nodes"] = len(nodes)
        z.writestr("tree.json",
                   json.dumps(tree, ensure_ascii=False, separators=(",", ":")))
        z.writestr("manifest.json",
                   json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))

    size = os.path.getsize(bundle_path)
    print(f"wrote {bundle_path}: {n_ok} docs, {len(nodes)} tree nodes "
          f"({n_empty} empty/unparsed, {n_untreed} ungrouped), {size/1e6:.1f} MB")
    print("  by type:", ", ".join(f"{k}={v}" for k, v in
                                   sorted(manifest["types"].items(),
                                          key=lambda x: -x[1])))


def build_tree(nodes):
    """Turn the flat {id:{name,parent,docs}} into nested {name, children:[],
    docs:[]}, sorted, with single roots collected under one synthetic root."""
    children = {}
    roots = []
    for cid, n in nodes.items():
        p = n.get("parent")
        if p and p in nodes:
            children.setdefault(p, []).append(cid)
        else:
            roots.append(cid)

    def build(cid):
        n = nodes[cid]
        kids = [build(k) for k in children.get(cid, [])]
        kids.sort(key=lambda c: c["name"].lower())
        docs = sorted(n["docs"], key=lambda d: (d["type"], d["title"].lower()))
        out = {"name": n["name"]}
        if kids:
            out["children"] = kids
        if docs:
            out["docs"] = docs
        return out

    built = [build(r) for r in roots]
    built.sort(key=lambda c: c["name"].lower())
    if len(built) == 1:
        return built[0]
    return {"name": "", "children": built}


if __name__ == "__main__":
    main()
