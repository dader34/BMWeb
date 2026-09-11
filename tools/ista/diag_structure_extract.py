#!/usr/bin/env python3
"""Extract ISTA's three diagnosis STRUCTURES for one chassis.

The repair extract ships documents. This ships the three trees a workshop
NAVIGATES to reach them, which is the half of ISTA a document list cannot
replace: you rarely know a document's title, you know a symptom ("noise from
exhaust system"), a function ("Tank ventilation"), or a component ("A65
ABS/DSC control unit"), and ISTA's answer to each is a different tree.

    fault-pattern        XEP_PERCEIVEDSYMPTOMS, the customer-complaint tree
                         ("Fault pattern function" / "Component fault
                         pattern"). Its leaves point AT diagnosis objects, so
                         a symptom lands on the same nodes the other two
                         trees hold, from the customer's words instead.
    function-structure   the Function net: Power train / Chassis and
                         suspension / Body / Supply, subdivided by function.
    component-structure  the Component structure: the same car sorted by the
                         physical part, which is how you arrive when you have
                         a connector number rather than a symptom.

HOW THE TREES ARE STORED, and the one join that is easy to get wrong:

    XEP_DIAGNOSISOBJECTS      a node: ID, CONTROLID, NODECLASS, TITLE_ENGB
    XEP_REFDIAGNOSISTREE      the edges, as (ID, DIAGNOSISOBJECTCONTROLID)

A node's children are the rows whose ID equals THE PARENT'S CONTROLID, not
its ID -- the edge table keys on the control id, and joining on ID instead
silently returns an empty child list for every node, which reads as "this
tree is one level deep" rather than as an error. The two roots are the
exception: they carry CONTROLID = 0, so the first level is reached by their
ID (7863179 Function net root, 7863691 Component structure root).

The trees are DAGs, not trees: 2,535 distinct nodes in the E46 function
branch are reached by 2,853 edges, because sub-assemblies are shared between
parents. They are emitted as a tree anyway, with a repeated subtree repeated,
because that is what ISTA draws and what a reader expects to be able to
expand twice. A node already on the path from the root is NOT re-expanded,
so a cycle cannot run away.

WHICH BRANCH A CHASSIS GETS. The level under each root is a platform branch
(BMW01, BMW02, E38, PL2..PL6, MINI, Motorcycle, Non-electrical diagnosis),
and each branch carries a validity rule in XEP_RULES keyed by the branch
node's ID. That rule is the answer, decoded by validity_rules.py and
evaluated against the chassis's characteristic ids. No title matching is
involved, and none is wanted -- there is no branch titled "E46".

For E46 the rules decide it outright:

    BMW01                     BMW PKW AND (E36 OR E46 OR E52 OR E53)   applies
    Non-electrical diagnosis  BMW I OR BMW PKW OR MINI PKW OR ...      applies
    every other branch        a rule naming other chassis              no

So E46's COMPONENT structure is BMW01 alone, and its FUNCTION structure is
BMW01 plus the brand-wide Non-electrical diagnosis branch, which is a real
second branch of the function net rather than an ambiguity: it holds the
mechanical complaints that belong to no control unit.

Branches whose OWN rule does not decode (E38, E3802, E39, E3902 carry an
opcode the grammar does not know) would be treated as applying, the same
widening-not-narrowing direction validity_rules.py documents -- but only
when NO branch decoded to yes. A decoded yes is evidence; an undecodable
rule is merely the absence of a no, so it never dilutes a decided answer.

When more than one branch applies, ALL of them are shipped and the branch
title is kept as the tree's first level under a synthetic root, so nothing
is silently chosen between them; --branch forces one.

DOCUMENTS ON A NODE:

    XEP_REFINFOOBJECTS r JOIN XEP_INFOOBJECTS i ON i.ID = r.INFOOBJECTID
    WHERE r.ID = <node CONTROLID> AND r.LINK_TYPE_ID = 'DiagobjDocumentLink'

`type` is the short code a workshop reads, and it is NOT guessed from the
node class: XEP_INFOOBJECTS.INFOTYPE carries it, one value per class across
all 271,417 rows (only class 5083266/41153666 share a code, both 'ABL', and
46492802/46493442 both 'SSP'). The map below is that column, materialised so
the output does not depend on a column staying populated, with the class
names read from XEP_NODECLASSES. Classes seen in the two E46 branches:

    FUB 46455938  Funktionsbeschreibung    function description   text
    EBO 46483714  Einbauort                installation location  text
    STA 42874990082 Steckeransicht         plug connector view    text
    PIB 46484994  Pinbelegung              pin assignments        text
    SIT 46470274  Serviceinformation       service information    text
    SSP 46493442  SchaltplanLanguage       circuit diagram        SVG, no body

A class not in the map keeps its NODECLASS as the type, rendered as
"C<class>", rather than being dropped or labelled as something it is not.

WHICH DOCUMENTS GET A BODY. A body is shipped only where the stored content
is a text document this extractor parses:

    <DIAGNOSISDOCUMENT>  FUB, EBO, STA, PIB -- parsed into {title, sections}
    <SERVICEDOCUMENT>    SIT -- parsed by the same block collector
    svg                  SSP -- NOT shipped

Measured over E46's 19,055 referenced documents: 8,311 get a body, 10,744 do
not. SSP alone is 10,048 of those, and every one is an `<svg>` wiring
diagram, not prose -- it appears in the tree with its id, type and title and
NO body, because a wiring diagram belongs to the wiring importer and
inventing a text body for one would be a lie about what ISTA holds. Another
511 rows are classes this extractor does not parse at all (REP, which is the
repair extract's, plus FEB/ANL/STG/FTD/COM). The last 185 -- 170 EBO, 14 STA,
1 FUB -- are text documents whose content row is simply absent from the
English store. All three counts are reported in index.json rather than being
folded into one "missing" number.

The DIAGNOSISDOCUMENT schema is not one schema. Each class opens with its own
section element under the root, and each of those has its own shape:

    FUNCTIONALDESCRIPTION / FUNCTIONTESTINSTRUCTIONS / DESIREDVALUES
                          FUNCDESCINTRODUCTORY then CHAPTER/SUBSECTION2
    HELPINFORMATION       SUBSECTION1, each a heading and paragraphs
    INSTALLATIONLOCATION  a GRAPHIC and a LEGENDTABLE of name/explanation
    PLUGIMAGE             a GRAPHIC and loose paragraphs
    PINASSIGNMENTS        a PLUGTABLE and a PINTABLE, whose rows are split
                          across alternating PINROW1/PINROW2 elements

They are read into one {heading, blocks} shape so the renderer has one job,
with LEGENDTABLE/PLUGTABLE/PINTABLE turned into real tables rather than
flattened to prose. PINROW2 is merged onto the PINROW1 above it: the source
splits one pin's six columns across two elements, and emitting them as two
rows would show every pin twice, half-empty.

WHAT IS DROPPED, and why:
  - GRAPHIC SRC: the picture pool is the repair extract's, and these trees
    reference it rather than owning it. The graphic's presence is kept as a
    {t:"pic", s:<name>} block so a reader sees that a figure belongs there;
    resolving it to a stream id is the picture pipeline's job, not this one.
  - LINKID on graphics, COLSPEC widths, MOREROWS/ROTATE: layout of the
    original page, not content.
  - every TITLE_* but TITLE_ENGB, and the other HINWEIS_*/language columns:
    this is the English extract.
  - SELECTABLE=0 symptoms are KEPT, marked `sel:0`: they are the tree's
    grouping rows, and dropping them would orphan their children.
  - a node with no documents anywhere under it is kept. An empty branch is
    a fact about the car, and pruning it would make the tree disagree with
    the one ISTA draws.

Output, under data/ista/diag/<CHASSIS>/ (gitignored, uploaded to the
dataset). Every file is gzipped JSON with sorted keys and stable ordering,
so two runs over the same databases produce byte-identical files:

    index.json                  what was written, with counts (NOT gzipped,
                                so a reader can see the manifest first)
    fault-pattern.json.gz       {id,label,kids,n} and leaf `docs`
    function-structure.json.gz  the same shape
    component-structure.json.gz the same shape
    docs/<id>.json.gz           one parsed body per text document

Usage:
    tools/ista/diag_structure_extract.py \\
        --diagdoc ~/.../DiagDocDb.decrypted.sqlite \\
        --content ~/.../xmlvalueprimitive_ENGB.sqlite \\
        --chassis E46 --out data/ista/diag
"""
import argparse
import gzip
import json
import os
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from validity_rules import (  # noqa: E402
    chassis_char_ids,
    decode_rule,
    read_char_names,
    read_typekeys,
    rule_applies,
)

# ---- the trees --------------------------------------------------------------
# the two structure roots. Both carry CONTROLID = 0, so their first level is
# reached by ID rather than by control id (see the module docstring).
FUNCTION_ROOT = 7863179
COMPONENT_ROOT = 7863691

# ---- the document classes ---------------------------------------------------
# NODECLASS -> (short code, the class's name in XEP_NODECLASSES). The short
# code is XEP_INFOOBJECTS.INFOTYPE, which is constant per class; this table
# is that column materialised so the output does not depend on a nullable
# column, and so an unknown class is visibly unknown rather than silently
# mislabelled. A class absent here is emitted as "C<class>".
DOC_CLASSES = {
    5083266: ("ABL", "Flow"),
    41153666: ("ABL", "IDESProgramm"),
    46445826: ("REP", "Reparaturanleitung"),
    46451074: ("SWZ", "Spezialwerkzeug"),
    46453506: ("AZD", "Anziehdrehmoment"),
    46455938: ("FUB", "Funktionsbeschreibung"),
    46460546: ("SWS", "SISpezialwerkzeuge"),
    46463234: ("SBS", "Betriebsstoffe"),
    46465666: ("NEU", "Neuigkeiten"),
    46467586: ("FTD", "FahrzeugtechnikDiagnose"),
    46470274: ("SIT", "Serviceinformation"),
    46474754: ("FEB", "Fehlerbehebung"),
    46478722: ("TED", "TechnischeDaten"),
    46483714: ("EBO", "Einbauort"),
    46484994: ("PIB", "Pinbelegung"),
    46492802: ("SSP", "Schaltplan"),
    46493442: ("SSP", "SchaltplanLanguage"),
    46494082: ("BNT", "Bordnetztopologie"),
    46496258: ("FKB", "Fehlerkodebeschreibung"),
    48160002: ("GPI", "ProgrammierungAllgemein"),
    40039961218: ("ANL", "Anlage"),
    40039963394: ("MSM", "MobilesServiceModul"),
    42874990082: ("STA", "Steckeransicht"),
    60605392130: ("STG", "Stoergeraeusch"),
    62193066626: ("VUL", "VorschriftenLeitfaeden"),
    99999999995: ("COM", "Zusammenstellung"),
    99999999996: ("REH", "Reparaturhinweis"),
}

# the classes whose stored content is a text document this extractor parses.
# Everything else -- SSP above all, whose content is an <svg> wiring diagram
# -- is listed in the tree with no body. See the module docstring.
TEXT_CLASSES = frozenset(
    {
        46455938,  # FUB  DIAGNOSISDOCUMENT
        46483714,  # EBO  DIAGNOSISDOCUMENT
        46484994,  # PIB  DIAGNOSISDOCUMENT
        42874990082,  # STA  DIAGNOSISDOCUMENT
        46470274,  # SIT  SERVICEDOCUMENT
    }
)

# document roots this extractor knows how to read
TEXT_ROOTS = ("DIAGNOSISDOCUMENT", "SERVICEDOCUMENT")

# the section elements that open a DIAGNOSISDOCUMENT, and the block collector
# each one wants. "chapters" is the FUNCDESCINTRODUCTORY + CHAPTER shape,
# "flat" is a run of headed subsections, and the three named ones have a
# bespoke table. Anything else falls back to "flat", which collects every
# paragraph, list and table in document order and so degrades to readable
# prose rather than to nothing.
SECTION_KINDS = {
    "FUNCTIONALDESCRIPTION": "chapters",
    "FUNCTIONTESTINSTRUCTIONS": "chapters",
    "DESIREDVALUES": "chapters",
    "HELPINFORMATION": "flat",
    "INSTALLATIONLOCATION": "location",
    "PLUGIMAGE": "flat",
    "PINASSIGNMENTS": "pins",
}

# block container tags walked through rather than emitted
_PASS_THROUGH = ("LIST", "GENERALLIST", "SUBSECTION2", "SUBSECTION3", "SECTION")


def _flat(el):
    """Full text of one element, inline children included, space-normalised.

    The same reason ista_extract._flat exists: a PARAGRAPH carries inline
    markup (EMPHASIZE, SUB, SUP, cross-references) and .text would stop at
    the first child, so "voltage above 9 V" would ship as "voltage above".

    @param el: an Element, or None
    @returns: the text, or "" when the element is empty
    """
    if el is None:
        return ""
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip()


def _table_rows(tbl):
    """A DocBook-style <TABLE> into rows of cell strings.

    @param tbl: a TABLE element
    @returns: a list of rows, each a list of cell strings
    """
    rows = []
    for grp in tbl.iter("TGROUP"):
        for section in grp:
            if section.tag not in ("THEAD", "TBODY"):
                continue
            for row in section.findall("ROW"):
                cells = [_flat(e) for e in row.findall("ENTRY")]
                if any(cells):
                    rows.append(cells)
    return rows


def _blocks(el, skip=()):
    """Walk a subtree in document order into typed content blocks.

    Blocks are {t:"p"|"bullet"|"pic", s} or {t:"table", rows}. A one-column
    table is a list wearing a table's clothes and is emitted as bullets, the
    same fold ista_extract makes.

    @param el: the element to walk
    @param skip: tag names whose subtrees another collector already took
    @returns: a list of blocks
    """
    out = []

    def walk(node):
        """Emit this node's blocks, descending through structural wrappers."""
        for child in node:
            tag = child.tag
            if tag in skip or tag in ("HEADING", "DOCUMENTTITLE"):
                continue
            if tag == "PARAGRAPH":
                text = _flat(child)
                if text:
                    out.append({"s": text, "t": "p"})
            elif tag in ("LISTENTRY", "LISTELEMENT"):
                text = _flat(child)
                if text:
                    out.append({"s": text, "t": "bullet"})
            elif tag == "GRAPHIC":
                src = (child.get("SRC") or "").strip()
                if src:
                    out.append({"s": src, "t": "pic"})
            elif tag == "TABLE":
                rows = _table_rows(child)
                if not rows:
                    continue
                if max(len(r) for r in rows) == 1:
                    for row in rows:
                        if row[0]:
                            out.append({"s": row[0], "t": "bullet"})
                else:
                    out.append({"rows": rows, "t": "table"})
            elif tag in _PASS_THROUGH:
                walk(child)
            else:
                walk(child)

    walk(el)
    return out


def _sections_chapters(sec):
    """FUNCDESCINTRODUCTORY + CHAPTER/SUBSECTION2 into headed sections.

    @param sec: the section element
    @returns: a list of {heading, blocks}
    """
    out = []
    intro = sec.find("FUNCDESCINTRODUCTORY")
    if intro is not None:
        blocks = _blocks(intro)
        if blocks:
            out.append({"blocks": blocks, "heading": ""})
    for chap in sec.findall("CHAPTER"):
        heading = _flat(chap.find("HEADING"))
        subs = chap.findall("SUBSECTION2")
        direct = _blocks(chap, skip=("SUBSECTION2",))
        if direct:
            out.append({"blocks": direct, "heading": heading})
        for sub in subs:
            blocks = _blocks(sub)
            if blocks:
                out.append(
                    {"blocks": blocks, "heading": _flat(sub.find("HEADING")) or heading}
                )
    return out


def _sections_flat(sec):
    """A run of headed SUBSECTION1s, or one unheaded section of blocks.

    @param sec: the section element
    @returns: a list of {heading, blocks}
    """
    out = []
    subs = sec.findall("SUBSECTION1")
    direct = _blocks(sec, skip=("SUBSECTION1",))
    if direct:
        out.append({"blocks": direct, "heading": ""})
    for sub in subs:
        blocks = _blocks(sub)
        if blocks:
            out.append({"blocks": blocks, "heading": _flat(sub.find("HEADING"))})
    return out


def _sections_location(sec):
    """INSTALLATIONLOCATION: the figure, then the legend as a two-column table.

    @param sec: the INSTALLATIONLOCATION element
    @returns: a list of {heading, blocks}
    """
    blocks = _blocks(sec, skip=("LEGENDTABLE",))
    sub = _flat(sec.find("GRAPHICSUBHEADING"))
    if sub:
        blocks.append({"s": sub, "t": "p"})
    rows = []
    for legend in sec.iter("LEGENDROW"):
        name = _flat(legend.find("LEGENDNAME"))
        why = _flat(legend.find("LEGENDEXPLANATION"))
        if name or why:
            rows.append([name, why])
    if rows:
        blocks.append({"rows": rows, "t": "table"})
    return [{"blocks": blocks, "heading": ""}] if blocks else []


# the pin table's columns, in the order the source's head row names them
_PIN_COLS = (
    "PINPIN",
    "PINTYPE",
    "PINDESCRIPTION",
    "PINTESTERDISPLAY",
    "PINPORT",
    "PINMEASURINGHINTS",
)
_PLUG_COLS = ("PLUGNUMBER", "PLUGTYPE", "PLUGDESCRIPTION")


def _fixed_table(parent, head_tag, row_tags, cols):
    """One of the bespoke *TABLE elements into rows of cell strings.

    A row's cells are read by column NAME, not by position, because the
    source omits empty ones -- taking them in document order would slide a
    "Connection" into the "Signal type" column. PINROW2 continues the
    PINROW1 above it rather than starting a row of its own; see the module
    docstring.

    @param parent: the element holding the table
    @param head_tag: the head row's tag
    @param row_tags: body row tags, the continuation ones after the first
    @param cols: the column element names, in order
    @returns: a list of rows, head row first when present
    """
    rows = []
    for node in parent.iter():
        if node.tag == head_tag or node.tag in row_tags:
            cells = [_flat(node.find(c)) for c in cols]
            if node.tag == row_tags[0] or node.tag == head_tag or not rows:
                rows.append(cells)
            else:
                # a continuation: fill the columns the opening row left blank
                for i, val in enumerate(cells):
                    if val and not rows[-1][i]:
                        rows[-1][i] = val
    return [r for r in rows if any(r)]


def _sections_pins(sec):
    """PINASSIGNMENTS: the plug overview table, then the pin table.

    @param sec: the PINASSIGNMENTS element
    @returns: a list of {heading, blocks}
    """
    out = []
    for holder, head, body_tags, cols in (
        (sec.find("PLUG"), "PLUGHEADROW", ("PLUGROW",), _PLUG_COLS),
        (sec.find("PINS"), "PINHEADROW", ("PINROW1", "PINROW2"), _PIN_COLS),
    ):
        if holder is None:
            continue
        rows = _fixed_table(holder, head, body_tags, cols)
        if rows:
            out.append(
                {
                    "blocks": [{"rows": rows, "t": "table"}],
                    "heading": _flat(holder.find("HEADING")),
                }
            )
    return out


def parse_document(xml):
    """One stored document body into {title, kind, sections}, or None.

    Returns None for anything that is not one of the text roots -- an <svg>
    wiring diagram, a body that does not parse -- so the caller ships the
    row without a body rather than with a wrong one.

    @param xml: the content store's text for the document, or None
    """
    if not xml:
        return None
    head = xml.lstrip()[:200]
    if not any(("<" + r) in head for r in TEXT_ROOTS):
        return None
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    if root.tag not in TEXT_ROOTS:
        return None
    if root.tag == "SERVICEDOCUMENT":
        blocks = _blocks(root, skip=("DOCINFO",))
        if not blocks:
            return None
        # the page's own HEADLINE is an empty layout element in every SIT
        # seen; the title a reader wants is the bulletin's subject, with the
        # service-information number beside it for the ones that carry it
        title = _flat(root.find(".//TOPIC/SUBJECT")) or _flat(
            root.find(".//HEADLINE")
        )
        return {
            "kind": "SERVICEDOCUMENT",
            "sections": [{"blocks": blocks, "heading": ""}],
            "title": title,
        }
    sec = next((child for child in root), None)
    if sec is None:
        return None
    kind = SECTION_KINDS.get(sec.tag, "flat")
    if kind == "chapters":
        sections = _sections_chapters(sec)
    elif kind == "location":
        sections = _sections_location(sec)
    elif kind == "pins":
        sections = _sections_pins(sec)
    else:
        sections = _sections_flat(sec)
    if not sections:
        return None
    return {
        "kind": sec.tag,
        "sections": sections,
        "title": _flat(sec.find("DOCUMENTTITLE")),
    }


# ---- the database side ------------------------------------------------------
class Diag:
    """The DiagDocDb queries these three trees need, with their caches.

    A tree walk asks for the same node's children and documents repeatedly
    (the structures are DAGs), and a chassis's branch is thousands of nodes,
    so the two hot queries are memoised. Nothing here writes.
    """

    def __init__(self, path):
        """Open DiagDocDb read-only.

        @param path: DiagDocDb.decrypted.sqlite
        """
        self.con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        self.con.execute("PRAGMA query_only=1")
        self._kids = {}
        self._docs = {}
        self._content = {}

    def children(self, key):
        """Child nodes of one tree key, ordered.

        @param key: the parent's CONTROLID, or a root's ID
        @returns: a list of (id, controlid, nodeclass, title)
        """
        if key in self._kids:
            return self._kids[key]
        rows = list(
            self.con.execute(
                "SELECT o.ID, o.CONTROLID, o.NODECLASS, o.TITLE_ENGB, o.SORT_ORDER "
                "FROM XEP_REFDIAGNOSISTREE t "
                "JOIN XEP_DIAGNOSISOBJECTS o "
                "  ON o.CONTROLID = t.DIAGNOSISOBJECTCONTROLID "
                "WHERE t.ID = ?",
                (key,),
            )
        )
        # SORT_ORDER first so the tree matches ISTA's own order, then title
        # and id so rows that share a sort order still land deterministically
        rows.sort(key=lambda r: (r[4] if r[4] is not None else 0, r[3] or "", r[0]))
        out = [(r[0], r[1], r[2], r[3]) for r in rows]
        self._kids[key] = out
        return out

    def documents(self, control_id):
        """Documents linked to one node, ordered by id.

        @param control_id: the node's CONTROLID
        @returns: a list of (id, nodeclass, title)
        """
        if control_id in self._docs:
            return self._docs[control_id]
        rows = sorted(
            self.con.execute(
                "SELECT i.ID, i.NODECLASS, i.TITLE_ENGB "
                "FROM XEP_REFINFOOBJECTS r "
                "JOIN XEP_INFOOBJECTS i ON i.ID = r.INFOOBJECTID "
                "WHERE r.ID = ? AND r.LINK_TYPE_ID = 'DiagobjDocumentLink'",
                (control_id,),
            )
        )
        # the same document can be linked twice; keep one row per id
        seen = set()
        out = []
        for doc_id, node_class, title in rows:
            if doc_id in seen:
                continue
            seen.add(doc_id)
            out.append((doc_id, node_class, title))
        self._docs[control_id] = out
        return out

    def content_id(self, doc_id):
        """The English content id for one document, or None.

        The chain the repair and fault extracts both use:
        XEP_INFOOBJECTS.CONTROLID -> XEP_REFCONTENTS.ID ->
        .CONTENTCONTROLID -> XEP_IOCONTENTS.CONTROLID -> .CONTENT_ENGB.

        @param doc_id: XEP_INFOOBJECTS.ID
        """
        if doc_id in self._content:
            return self._content[doc_id]
        row = self.con.execute(
            "SELECT io.CONTENT_ENGB FROM XEP_INFOOBJECTS i "
            "JOIN XEP_REFCONTENTS rc ON rc.ID = i.CONTROLID "
            "JOIN XEP_IOCONTENTS io ON io.CONTROLID = rc.CONTENTCONTROLID "
            "WHERE i.ID = ? AND io.CONTENT_ENGB > 0",
            (doc_id,),
        ).fetchone()
        out = row[0] if row else None
        self._content[doc_id] = out
        return out

    def symptoms(self):
        """The whole perceived-symptom table, id -> row.

        @returns: {id: (parent id, title, selectable)}
        """
        return {
            r[0]: (r[1], r[2], r[3])
            for r in self.con.execute(
                "SELECT ID, PARENTID, TITLE_ENGB, SELECTABLE "
                "FROM XEP_PERCEIVEDSYMPTOMS"
            )
        }

    def symptom_objects(self):
        """Symptom id -> the diagnosis objects it points at, ordered.

        @returns: {symptom id: [(object id, nodeclass, controlid, title)]}
        """
        out = {}
        for sid, oid, node_class, control_id, title in self.con.execute(
            "SELECT r.ID, o.ID, o.NODECLASS, o.CONTROLID, o.TITLE_ENGB "
            "FROM XEP_REFDIAGOBJECTS r "
            "JOIN XEP_DIAGNOSISOBJECTS o "
            "  ON o.CONTROLID = r.DIAGNOSISOBJECTCONTROLID"
        ):
            out.setdefault(sid, []).append((oid, node_class, control_id, title))
        for rows in out.values():
            rows.sort()
        return out

    def rules(self):
        """Object id -> its raw validity blob.

        @returns: {id: bytes}
        """
        return dict(self.con.execute("SELECT ID, RULE FROM XEP_RULES"))


class Content:
    """xmlvalueprimitive lookup: content id -> the stored document text."""

    def __init__(self, path):
        """Open the content store read-only.

        @param path: xmlvalueprimitive_ENGB.sqlite
        """
        self.con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        self.con.execute("PRAGMA query_only=1")

    def get(self, content_id):
        """The newest live content for one id as text, or None.

        @param content_id: a content id from XEP_IOCONTENTS.CONTENT_ENGB
        """
        if not content_id:
            return None
        row = self.con.execute(
            "SELECT data FROM xmlvalueprimitive WHERE id = ? AND deleted = 0 "
            "ORDER BY modified DESC LIMIT 1",
            (content_id,),
        ).fetchone()
        if row is None:
            return None
        data = row[0]
        if isinstance(data, bytes):
            data = data.decode("utf-8", "replace")
        return data


def doc_type(node_class):
    """The short code a workshop reads for one document class.

    @param node_class: XEP_INFOOBJECTS.NODECLASS
    @returns: the code, or "C<class>" for a class not in DOC_CLASSES
    """
    known = DOC_CLASSES.get(node_class)
    return known[0] if known else f"C{node_class}"


# ---- the branch decision ----------------------------------------------------
def resolve_branches(diag, chassis, rules, ids):
    """Which platform branches under each root apply to one chassis.

    The decision is the branch node's own validity rule, decoded and
    evaluated -- see the module docstring. A branch whose rule does not
    decode is included and marked, because validity_rules.py's whole
    posture is that an undecodable rule widens rather than excludes.

    @param diag: a Diag
    @param chassis: the development code, e.g. "E46"
    @param rules: diag.rules() output
    @param ids: the chassis's characteristic value ids
    @returns: {"function": [branch...], "component": [branch...]} where a
              branch is {id, controlId, label, rule, unsure}
    """
    out = {}
    for name, root in (("function", FUNCTION_ROOT), ("component", COMPONENT_ROOT)):
        picked = []
        for node_id, control_id, _cls, title in diag.children(root):
            tree, unsure = decode_rule(rules.get(node_id))
            if not rule_applies(tree, ids):
                continue
            picked.append(
                {
                    "controlId": control_id,
                    "id": node_id,
                    "label": title or "",
                    "rule": "decoded" if tree is not None else "none",
                    "unsure": bool(unsure),
                }
            )
        # a decoded rule that says yes is real evidence; an undecoded one is
        # only the absence of a no. When any branch decoded, keep those.
        decided = [b for b in picked if not b["unsure"]]
        out[name] = sorted(decided or picked, key=lambda b: (b["label"], b["id"]))
    return out


# ---- the tree walks ---------------------------------------------------------
def walk_structure(diag, node, path, wanted):
    """One structure node and everything under it into the emitted shape.

    @param diag: a Diag
    @param node: (id, controlid, nodeclass, title)
    @param path: node ids on the way here, so a cycle cannot run away
    @param wanted: a set collecting every document id seen
    @returns: {id, label, kids, n} with `docs` on a node that has any
    """
    node_id, control_id, _cls, title = node
    docs = []
    for doc_id, doc_class, doc_title in diag.documents(control_id):
        wanted.add((doc_id, doc_class))
        docs.append(
            {"id": doc_id, "title": doc_title or "", "type": doc_type(doc_class)}
        )
    kids = []
    if node_id not in path:
        sub = path | {node_id}
        for child in diag.children(control_id):
            kids.append(walk_structure(diag, child, sub, wanted))
    out = {
        "id": node_id,
        "kids": kids,
        "label": title or "",
        "n": len(docs) + sum(k["n"] for k in kids),
    }
    if docs:
        out["docs"] = docs
    return out


def build_structure(diag, branches, wanted):
    """A whole structure tree for one chassis.

    A single applying branch becomes the tree's root, because that IS the
    chassis's structure. Several become the first level under a synthetic
    root, so nothing is silently chosen between them.

    @param diag: a Diag
    @param branches: resolve_branches output for one root
    @param wanted: a set collecting every document id seen
    @returns: the root node, or None when no branch applies
    """
    trees = [
        walk_structure(diag, (b["id"], b["controlId"], None, b["label"]), frozenset(), wanted)
        for b in branches
    ]
    if not trees:
        return None
    if len(trees) == 1:
        return trees[0]
    return {
        "id": 0,
        "kids": trees,
        "label": "Platforms",
        "n": sum(t["n"] for t in trees),
    }


def build_symptoms(diag, wanted):
    """The perceived-symptom tree, leaves carrying their linked documents.

    The table's PARENTID points outside itself for the 27 top rows (at a
    shared virtual root), so those are the forest's roots. A symptom's
    documents are the documents on the diagnosis objects it points at,
    deduplicated: several symptom rows commonly land on the same object.

    The tree is NOT filtered by chassis. The symptom vocabulary is the
    customer's, not the car's -- "noise from exhaust system" is a sentence
    about any BMW -- and it is the diagnosis objects behind a leaf that are
    chassis-specific. Filtering the words would hide a complaint the car can
    have; the objects underneath are what the other two trees scope.

    @param diag: a Diag
    @param wanted: a set collecting every document id seen
    @returns: a root node of the same {id, label, kids, n} shape
    """
    rows = diag.symptoms()
    links = diag.symptom_objects()
    kids_of = {}
    roots = []
    for sid, (parent, _title, _sel) in sorted(rows.items()):
        if parent in rows and parent != sid:
            kids_of.setdefault(parent, []).append(sid)
        else:
            roots.append(sid)

    def build(sid, path):
        """One symptom and its subtree."""
        _parent, title, selectable = rows[sid]
        docs = []
        seen = set()
        for obj_id, _cls, control_id, _obj_title in links.get(sid, ()):
            del obj_id
            for doc_id, doc_class, doc_title in diag.documents(control_id):
                if doc_id in seen:
                    continue
                seen.add(doc_id)
                wanted.add((doc_id, doc_class))
                docs.append(
                    {
                        "id": doc_id,
                        "title": doc_title or "",
                        "type": doc_type(doc_class),
                    }
                )
        docs.sort(key=lambda d: (d["type"], d["title"], d["id"]))
        kids = []
        if sid not in path:
            sub = path | {sid}
            for kid in sorted(
                kids_of.get(sid, ()), key=lambda k: (rows[k][1] or "", k)
            ):
                kids.append(build(kid, sub))
        out = {
            "id": sid,
            "kids": kids,
            "label": title or "",
            "n": len(docs) + sum(k["n"] for k in kids),
        }
        if docs:
            out["docs"] = docs
        # the grouping rows the workshop cannot pick: kept, because their
        # children hang off them, but marked so the app can grey them
        if not selectable:
            out["sel"] = 0
        return out

    trees = [build(r, frozenset()) for r in sorted(roots, key=lambda r: (rows[r][1] or "", r))]
    if len(trees) == 1:
        return trees[0]
    return {
        "id": 0,
        "kids": trees,
        "label": "Fault patterns",
        "n": sum(t["n"] for t in trees),
    }


# ---- writing ----------------------------------------------------------------
def write_json_gz(path, obj):
    """Write one gzipped JSON file, deterministically.

    Sorted keys, compact separators, and mtime 0 in the gzip header, so two
    runs over the same databases produce byte-identical files.

    @param path: where to write
    @param obj: the object to serialise
    @returns: the file's size in bytes
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    with open(path, "wb") as fh:
        with gzip.GzipFile(fileobj=fh, mode="wb", mtime=0) as gz:
            gz.write(raw.encode("utf-8"))
    return os.path.getsize(path)


def write_json(path, obj):
    """Write one plain JSON file, deterministically.

    @param path: where to write
    @param obj: the object to serialise
    @returns: the file's size in bytes
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, sort_keys=True, indent=1)
        fh.write("\n")
    return os.path.getsize(path)


def write_bodies(diag, content, wanted, out_dir, verbose=False):
    """Parse and write every text document referenced by the trees.

    @param diag: a Diag
    @param content: a Content over the body store
    @param wanted: {(doc id, node class)} collected by the walks
    @param out_dir: the chassis folder
    @param verbose: print progress
    @returns: (stats, per-type counts)
    """
    stats = {"bodies": 0, "bytes": 0, "nocontent": 0, "notext": 0, "unparsed": 0}
    by_type = {}
    ordered = sorted(wanted)
    for n, (doc_id, node_class) in enumerate(ordered):
        code = doc_type(node_class)
        slot = by_type.setdefault(code, {"body": 0, "docs": 0, "nobody": 0})
        slot["docs"] += 1
        if node_class not in TEXT_CLASSES:
            stats["notext"] += 1
            slot["nobody"] += 1
            continue
        cid = diag.content_id(doc_id)
        xml = content.get(cid) if cid else None
        if not xml:
            # either no content row on the document, or a content id whose
            # row is absent from the English store. Both mean the same thing
            # to a reader -- ISTA holds no English body -- so they are one
            # count, and the row still ships in the tree without a body.
            stats["nocontent"] += 1
            slot["nobody"] += 1
            continue
        body = parse_document(xml)
        if body is None:
            stats["unparsed"] += 1
            slot["nobody"] += 1
            continue
        body["id"] = doc_id
        body["type"] = code
        stats["bytes"] += write_json_gz(
            os.path.join(out_dir, "docs", f"{doc_id}.json.gz"), body
        )
        stats["bodies"] += 1
        slot["body"] += 1
        if verbose and n and n % 2000 == 0:
            print(f"  {n} of {len(ordered)} documents...", file=sys.stderr)
    return stats, by_type


def count_nodes(node):
    """How many nodes one emitted tree holds, the root included.

    @param node: an emitted tree node, or None
    """
    if not node:
        return 0
    return 1 + sum(count_nodes(k) for k in node.get("kids", ()))


def main():
    """Run the extraction and write one chassis's diagnosis structures."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--diagdoc", required=True, help="DiagDocDb.decrypted.sqlite")
    ap.add_argument(
        "--content", required=True, help="xmlvalueprimitive_ENGB.sqlite"
    )
    ap.add_argument("--chassis", default="E46", help="development code, e.g. E46")
    ap.add_argument("--out", default="data/ista/diag", help="output folder")
    ap.add_argument(
        "--branch",
        help="platform branch title to force (e.g. BMW01), overriding the rule",
    )
    ap.add_argument(
        "--no-bodies", action="store_true", help="trees only, skip document bodies"
    )
    ap.add_argument("-v", "--verbose", action="store_true", help="print progress")
    args = ap.parse_args()

    chassis = args.chassis.upper()
    diag = Diag(args.diagdoc)
    content = Content(args.content)

    typekeys = read_typekeys(diag.con)
    char_names = read_char_names(diag.con)
    ids = chassis_char_ids(typekeys, char_names, chassis)
    if not ids:
        print(
            f"{chassis}: no characteristic ids; the chassis is not in this database",
            file=sys.stderr,
        )
        return 2
    rules = diag.rules()
    branches = resolve_branches(diag, chassis, rules, ids)
    if args.branch:
        want = args.branch.upper()
        for name in branches:
            branches[name] = [
                b for b in branches[name] if (b["label"] or "").upper() == want
            ]

    for name in ("function", "component"):
        picked = ", ".join(
            f"{b['label']}({b['rule']}{'/unsure' if b['unsure'] else ''})"
            for b in branches[name]
        )
        print(f"{chassis} {name} branch: {picked or '(none)'}", file=sys.stderr)

    out_dir = os.path.join(args.out, chassis)
    wanted = set()
    trees = {
        "component-structure": build_structure(diag, branches["component"], wanted),
        "function-structure": build_structure(diag, branches["function"], wanted),
        "fault-pattern": build_symptoms(diag, wanted),
    }

    files = {}
    for name in sorted(trees):
        tree = trees[name]
        if tree is None:
            continue
        path = os.path.join(out_dir, f"{name}.json.gz")
        files[name] = {
            "bytes": write_json_gz(path, tree),
            "docs": tree["n"],
            "file": f"{name}.json.gz",
            "nodes": count_nodes(tree),
        }
        if args.verbose:
            print(
                f"  {name}: {files[name]['nodes']} nodes, {tree['n']} doc links",
                file=sys.stderr,
            )

    if args.no_bodies:
        body_stats, by_type = {"skipped": True}, {}
    else:
        body_stats, by_type = write_bodies(
            diag, content, wanted, out_dir, args.verbose
        )

    index = {
        "branches": branches,
        "bodies": body_stats,
        "chassis": chassis,
        "docTypes": {
            code: dict(counts) for code, counts in sorted(by_type.items())
        },
        "documents": len(wanted),
        "files": files,
        "version": 1,
    }
    write_json(os.path.join(out_dir, "index.json"), index)
    print(json.dumps(index, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
