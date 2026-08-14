#!/usr/bin/env python3
"""Extract ISTA diagnostic content into the app's fault database.

BMWeb's Fault Lookup already shows ISTA fault-description fields (from an earlier
one-off extraction that was never committed). This rebuilds that data
reproducibly AND adds the guided-diagnostic layer, so the app can grow from a
DTC list into "Diagnostic Plans and Trouble Codes".

TWO DATABASES, one is the index and one is the content -- this is exactly how
ISTA's own RheingoldDatabaseSQLiteConnector.dll does it (decompiled to confirm):

    DiagDocDb.decrypted.sqlite        the STRUCTURE
      XEP_FAULTCODES.ID == RG_ECUFAULT_DOCIDS.ECUFAULT_ID  (fault -> its doc)
      RG_ECUFAULT_DOCIDS.CONTENT_ENGB   -> an English content id
      XEP_FAULTLABELS.CODE / .SAECODE   -> DTC number + SAE P-code + title
      XEP_INFOOBJECTS / XEP_REFINFOOBJECTS -> diagnosis documents per component
         │ content id + language
         ▼
    xmlvalueprimitive_ENGB.sqlite     the CONTENT
      SELECT data FROM xmlvalueprimitive WHERE id = <content id>
      (per-language file; ISTA opens xmlvalueprimitive_<LANG>.sqlite)

A fault's own CONTENT_ENGB always resolves to an <FKB> (Fehlerkodebeschreibung)
document -- the description/set-condition/service-measure fields the modal
already renders. The <DIAGNOSISDOCUMENT> guided procedures attach to components
in the diagnosis tree, reached via XEP_REFINFOOBJECTS, and are added on top.

Output (mirrors the shape lookup.js already consumes):
    data/ista/faultinfo.json   hexOrCode -> {docIdx -> {description, setCondition,
                               monitoring, serviceMeasure, ...}}     (Tier 1: FKB)
    data/ista/faulttests.json  slug -> {title, chapters:[{heading, blocks:[...]}]}
                               block = {t:"p"|"bullet", s} | {t:"table", rows}
                               the DIAGNOSISDOCUMENT functional descriptions (Tier 2)

Usage:
    tools/ista_extract.py --diagdoc DiagDocDb.decrypted.sqlite \
                          --content xmlvalueprimitive_ENGB.sqlite \
                          --out data/ista [--limit N] [--fkb-only]
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET


# ---- ISTA FKB (fault-description) XML -> flat fields ------------------------
# The FKB schema is a fixed set of German-named sections, each wrapping
# PARAGRAPHs. Map them to the same keys lookup.js's _infoFields already renders.
FKB_FIELDS = {
    "BESCHREIBUNG": "description",
    "SETZBEDINGUNG": "setCondition",
    "UEBERWACHUNGSBEDINGUNG": "monitoring",
    "SPANNUNGSBEDINGUNG": "monitoring",       # nested voltage cond -> monitoring
    "ZEITBEDINGUNG": "timeCondition",
    "MASSNAHMEIMSERVICE": "serviceMeasure",
    "SERVICEHINWEIS": "serviceNote",
    "PANNENHINWEIS": "breakdownNote",
    "SICHTBAREAUSWIRKUNG": "impact",
    "WARNLEUCHTE": "warningLamp",
    "CCMELDUNG": "ccMessage",
    "FAHRERINFORMATION": "driverInfo",
}


def _text_of(el):
    """All PARAGRAPH/text under an element, joined, whitespace-normalised."""
    parts = []
    for p in el.iter():
        if p.tag in ("PARAGRAPH", "LISTENTRY") and p.text and p.text.strip():
            parts.append(p.text.strip())
    if not parts and el.text and el.text.strip():
        parts.append(el.text.strip())
    out = "\n".join(parts)
    return re.sub(r"[ \t]+", " ", out).strip()


def parse_fkb(xml):
    """<FKB> document -> {field: text}. Empty sections are dropped."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    if root.tag != "FKB":
        return None
    out = {}
    # KLEMME (terminal) is a name+status pair, not a paragraph block
    for kl in root.iter("KLEMME"):
        name = kl.findtext("KLEMMENNAME", "").strip()
        status = kl.findtext("KLEMMENSTATUS", "").strip()
        if name:
            out["terminal"] = f"{name} {status}".strip()
    for section, field in FKB_FIELDS.items():
        for el in root.iter(section):
            txt = _text_of(el)
            if txt and field not in out:
                out[field] = txt
    return out or None


# ---- ISTA DIAGNOSISDOCUMENT (guided procedure) XML -> chapters --------------
# Content is emitted as a list of typed BLOCKS so a real <TABLE> stays a table
# instead of being flattened into orphaned cell paragraphs:
#   {"t": "p",     "s": "prose text"}
#   {"t": "bullet","s": "list item"}
#   {"t": "table", "rows": [["cell", "cell"], ...]}   # first row may be a header


def _cell_text(entry):
    """All PARAGRAPH text inside one <ENTRY>, space-joined."""
    parts = [p.text.strip() for p in entry.iter("PARAGRAPH")
             if p.text and p.text.strip()]
    if not parts and entry.text and entry.text.strip():
        parts = [entry.text.strip()]
    return " ".join(parts)


def _parse_table(tbl):
    """<TABLE><TGROUP><THEAD?/><TBODY><ROW><ENTRY>..  -> rows of cells, ordered
    by ENTRY COLNAME so columns line up even when the source omits empties."""
    rows = []
    for grp in tbl.iter("TGROUP"):
        for section in grp:
            if section.tag not in ("THEAD", "TBODY"):
                continue
            for row in section.findall("ROW"):
                cells = []
                for entry in row.findall("ENTRY"):
                    cells.append(_cell_text(entry))
                if any(c for c in cells):
                    rows.append(cells)
    # a table with a single column is really a list; caller flattens it
    return rows


def _collect_blocks(el):
    """Walk a chapter/section subtree in document order into typed blocks.
    Handles nested SUBSECTION2 / LIST / GENERALLIST and real TABLEs."""
    blocks = []

    def walk(node):
        for child in node:
            tag = child.tag
            if tag == "HEADING":
                continue
            if tag == "PARAGRAPH":
                if child.text and child.text.strip():
                    blocks.append({"t": "p", "s": child.text.strip()})
            elif tag in ("LISTENTRY", "LISTELEMENT"):
                t = _text_of(child)
                if t:
                    blocks.append({"t": "bullet", "s": t})
            elif tag == "TABLE":
                rows = _parse_table(child)
                if not rows:
                    continue
                if max(len(r) for r in rows) == 1:      # 1-col table == list
                    for r in rows:
                        blocks.append({"t": "bullet", "s": r[0]})
                else:
                    blocks.append({"t": "table", "rows": rows})
            else:
                walk(child)                 # SUBSECTION2, LIST, GENERALLIST, ...

    walk(el)
    return blocks


def parse_diagnosis_doc(xml):
    """<DIAGNOSISDOCUMENT> -> {title, chapters:[{heading, blocks:[...]}]}."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    if root.tag != "DIAGNOSISDOCUMENT":
        return None
    fd = root.find("FUNCTIONALDESCRIPTION")
    if fd is None:
        return None
    title = (fd.findtext("DOCUMENTTITLE") or "").strip()
    chapters = []
    # an introductory paragraph block sits outside the CHAPTERs
    intro = fd.find("FUNCDESCINTRODUCTORY")
    if intro is not None:
        b = _collect_blocks(intro)
        if b:
            chapters.append({"heading": "", "blocks": b})
    for ch in fd.findall("CHAPTER"):
        heading = (ch.findtext("HEADING") or "").strip()
        # a chapter may itself be split into SUBSECTION2s, each with a heading
        subs = ch.findall("SUBSECTION2")
        if subs:
            direct = _collect_blocks_shallow(ch)
            if direct:
                chapters.append({"heading": heading, "blocks": direct})
            for sub in subs:
                sh = (sub.findtext("HEADING") or "").strip()
                sb = _collect_blocks(sub)
                if sb:
                    chapters.append({"heading": sh or heading, "blocks": sb})
        else:
            blocks = _collect_blocks(ch)
            if blocks:
                chapters.append({"heading": heading, "blocks": blocks})
    if not chapters:                       # nothing worth showing
        return None
    return {"title": title, "chapters": chapters}


def _collect_blocks_shallow(ch):
    """Direct PARAGRAPH/LIST/TABLE children of a chapter, not descending into
    SUBSECTION2 (those are collected separately with their own heading)."""
    blocks = []
    for node in ch:
        if node.tag == "PARAGRAPH" and node.text and node.text.strip():
            blocks.append({"t": "p", "s": node.text.strip()})
        elif node.tag == "TABLE":
            rows = _parse_table(node)
            if rows:
                if max(len(r) for r in rows) == 1:
                    for r in rows:
                        blocks.append({"t": "bullet", "s": r[0]})
                else:
                    blocks.append({"t": "table", "rows": rows})
        elif node.tag == "LIST":
            for le in node.iter("LISTENTRY"):
                t = _text_of(le)
                if t:
                    blocks.append({"t": "bullet", "s": t})
    return blocks


# ---- content-store access ---------------------------------------------------
class Content:
    """xmlvalueprimitive lookup: id -> data (the DATA column, per ISTA's own
    GetXmlValuePrimitivesById: SELECT data ... WHERE id=@id)."""

    def __init__(self, path):
        self.con = sqlite3.connect(path)
        self.con.execute("PRAGMA query_only=1")

    def get(self, cid):
        if not cid:
            return None
        row = self.con.execute(
            "SELECT data FROM xmlvalueprimitive WHERE id=? AND deleted=0 "
            "ORDER BY modified DESC LIMIT 1", (cid,)).fetchone()
        return row[0] if row else None


# ---- extraction passes ------------------------------------------------------
def extract_fkb(diag, content, limit=None):
    """Tier 1: fault CODE -> FKB service-document fields.

    Keyed by the DTC number (XEP_FAULTLABELS.CODE) the app already uses. A code
    can carry several docs across ECU variants; index them 0..N like the
    existing faultinfo (hex -> {docIdx -> fields})."""
    cur = diag.execute(
        "SELECT f.CODE, r.CONTENT_ENGB "
        "FROM XEP_FAULTCODES f "
        "JOIN RG_ECUFAULT_DOCIDS r ON r.ECUFAULT_ID = f.ID "
        "WHERE r.CONTENT_ENGB IS NOT NULL AND r.CONTENT_ENGB != 0 "
        "ORDER BY f.CODE" + (f" LIMIT {int(limit)}" if limit else ""))
    out = {}
    seen = {}           # code -> {contentHash: docIdx} to dedupe identical docs
    n = miss = 0
    for code, cid in cur:
        if code is None:
            continue
        code = str(code)
        xml = content.get(cid)
        if not xml:
            miss += 1
            continue
        fields = parse_fkb(xml)
        if not fields:
            continue
        key = json.dumps(fields, sort_keys=True)
        bucket = seen.setdefault(code, {})
        if key in bucket:
            continue                       # identical doc already stored
        idx = str(len(bucket))
        bucket[key] = idx
        out.setdefault(code, {})[idx] = fields
        n += 1
        if n % 5000 == 0:
            print(f"  FKB: {n} docs ({len(out)} codes)...", file=sys.stderr)
    print(f"FKB: {n} docs across {len(out)} codes ({miss} content misses)",
          file=sys.stderr)
    return out


def extract_diagnosis_docs(diag, content, limit=None):
    """Tier 2: DIAGNOSISDOCUMENT functional descriptions, grouped by their
    info-object title (component). Reached from XEP_IOCONTENTS whose data is a
    DIAGNOSISDOCUMENT. Keyed by a slug of the component title so the modal can
    show 'how this system works / how to test it' beside a fault."""
    # every English XML io-content that is a diagnosis document
    cur = diag.execute(
        "SELECT c.CONTENT_ENGB, c.TITLE_ENGB "
        "FROM XEP_IOCONTENTS c "
        "WHERE c.CONTENT_ENGB IS NOT NULL AND c.CONTENT_ENGB != 0 "
        "AND c.INFORMATIONSFORMAT LIKE 'XML%'"
        + (f" LIMIT {int(limit)}" if limit else ""))
    out = {}
    n = 0
    for cid, title in cur:
        xml = content.get(cid)
        if not xml or "<DIAGNOSISDOCUMENT" not in xml[:64]:
            continue
        doc = parse_diagnosis_doc(xml)
        if not doc:
            continue
        name = doc["title"] or (title or "").strip()
        if not name:
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        if not slug:
            continue
        # on a title collision keep the RICHER doc (more paragraph text): the
        # store carries many empty stubs sharing a title with the real one
        weight = 0
        for ch in doc["chapters"]:
            for b in ch["blocks"]:
                if b["t"] in ("p", "bullet"):
                    weight += len(b["s"])
                elif b["t"] == "table":
                    weight += sum(len(c) for r in b["rows"] for c in r)
        prev = out.get(slug)
        if prev is None or weight > prev[1]:
            out[slug] = (doc, weight)
            if prev is None:
                n += 1
                if n % 1000 == 0:
                    print(f"  diag docs: {n}...", file=sys.stderr)
    result = {slug: doc for slug, (doc, _w) in out.items()}
    print(f"diagnosis documents: {len(result)} distinct components", file=sys.stderr)
    return result


def main():
    ap = argparse.ArgumentParser(description="Extract ISTA diagnostic content")
    ap.add_argument("--diagdoc", required=True, help="DiagDocDb.decrypted.sqlite")
    ap.add_argument("--content", required=True, help="xmlvalueprimitive_ENGB.sqlite")
    ap.add_argument("--out", default="data/ista", help="output dir")
    ap.add_argument("--limit", type=int, help="cap rows (for a quick test run)")
    ap.add_argument("--fkb-only", action="store_true", help="skip diagnosis docs")
    args = ap.parse_args()

    for p in (args.diagdoc, args.content):
        if not os.path.exists(p):
            sys.exit(f"missing: {p}")

    diag = sqlite3.connect(args.diagdoc)
    diag.execute("PRAGMA query_only=1")
    content = Content(args.content)
    os.makedirs(args.out, exist_ok=True)

    fkb = extract_fkb(diag, content, args.limit)
    with open(os.path.join(args.out, "faultinfo.json"), "w") as f:
        json.dump(fkb, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {args.out}/faultinfo.json", file=sys.stderr)

    if not args.fkb_only:
        docs = extract_diagnosis_docs(diag, content, args.limit)
        with open(os.path.join(args.out, "faulttests.json"), "w") as f:
            json.dump(docs, f, ensure_ascii=False, separators=(",", ":"))
        print(f"wrote {args.out}/faulttests.json", file=sys.stderr)


if __name__ == "__main__":
    main()
