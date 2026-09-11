#!/usr/bin/env python3
"""Extract ISTA's three diagnosis STRUCTURES for one chassis.

The repair extract ships documents. This ships the three trees a workshop
NAVIGATES to reach them, which is the half of ISTA a document list cannot
replace: you rarely know a document's title, you know a symptom ("noise from
exhaust system"), a function ("Tank ventilation"), or a component ("A65
ABS/DSC control unit"), and ISTA's answer to each is a different tree.

    fault-pattern        XEP_PERCEIVEDSYMPTOMS, the customer-complaint tree:
                         one root "Fault patterns" over the nine numbered
                         groups (01 Powertrain .. 09 Voltage supply, bus
                         systems). Its leaves point AT diagnosis objects, so
                         a symptom lands on the same nodes the other two
                         trees hold, from the customer's words instead. That
                         table holds three other vocabularies beside this
                         tree, and it is gated to the car by the same
                         validity rules; see build_symptoms for both.
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

WHICH DOCUMENTS GET A BODY. EVERY class the structures link, except the two
that hold no text at all:

    <DIAGNOSISDOCUMENT>      FUB, EBO, STA, PIB -- {title, sections}
    <SERVICEDOCUMENT>        SIT -- parsed by the same block collector
    <REPAIRMANUALDOCUMENT>   FEB, REP, TED, AZD, COM, REH, HIN and the rest
                             of the repair-manual generation, both schemas
    svg                      SSP -- no body, and never will have one
    compiled test module     ABL -- not in the content store at all

The first three are all read into one {heading, blocks} shape so the
renderer has one job. A REPAIRMANUALDOCUMENT comes in two generations: the
flat one whose prose hangs straight off the root, which the block collector
below reads directly, and the namespaced <rep:...._MOD> one whose text is
buried under proc:/tf:/hint: elements, which the repair extract already
knows how to read -- so parse_repair_body reuses that parser and folds its
step model into the block shape rather than teaching this file a second
copy of the newer schema.

The reason this matters is that FEB is the Fault pattern tree's OWN payload.
A workshop arrives at "Transfer box operating fluid leakage" from the
customer's words, and the document behind it is a REPAIRMANUALDOCUMENT of
TYPE="TROUBLESHOOTING". Leaving those unparsed made the one tree that is
navigated by symptom the one tree whose leaves said "not in this build".

Two classes genuinely have NO English text, and they keep their real reason:

    ABL  a compiled test module: it is executable, not prose
    SSP  an <svg> wiring diagram, which belongs to the wiring importer

Two more carry a content id whose row is absent from the English store
entirely -- not deleted, not in another state, simply not there: ANL (91
links for E46) and STG (8). Those rows still ship in the tree with their id,
type and title and no body, and the per-class table in index.json says so,
rather than the extract quietly dropping them or inventing prose.

WHAT THE PER-CLASS TABLE IS FOR. index.json carries docTypes: one row per
short code with `docs` linked and `body` written, and the same table is
printed in the -v log. A class that silently loses its bodies -- a schema
that shifts, a join that stops matching -- shows up as a zero there on the
next run instead of as a reader's "not in this build".

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

THE VALIDITY GATE, on documents and on nodes alike. Every document and every
structure node carries a rule in XEP_RULES keyed by its own id, and the rule
is the only thing that says which cars it is for. Before this gate, E46's
Fault pattern tree listed "AM2704_00156 - Transfer box operating fluid
leakage", whose rule reads

    Brand = BMW PKW
    AND Development code IN (E70, E71, F25)
    AND Power train = AWD

which is an X5/X6/X3 with all-wheel drive, and is false twice over for a
rear-drive 3 Series. It was there because the rule was read for the platform
branches and for the symptoms and for nothing else.

THE RULE IS THREE-VALUED, and the third value is not a no:

    no rule      keep. A document with no rule applies to every car.
    undecided    keep. A rule this build cannot decide -- a leaf about
                 equipment, country or installed ECU variants, which the
                 extract carries no fact for -- is the ABSENCE of evidence,
                 not evidence of absence. Dropping on it would delete a
                 repair step because the extract is missing a fact.
    false        drop. This is the only evidence that a document does not
                 belong to the car.

rule_eval in validity_rules.py returns exactly those three, and this file
drops on `is False` alone. A gated-out node takes its subtree with it: a
child of an excluded parent is excluded whatever its own rule says.

TWO WIDTHS, ONE GATE. The extract is per CHASSIS, so build_structure
evaluates against every characteristic id any E46 type key carries -- broad
in the honest direction, because a chassis with no VIN must still see its
own documents. The app then narrows to the CAR: istaDiagGate in trees.js is
the same three-valued rule run against one type key's ids, and it is what
removes what the chassis-wide pass could not. Measured for E46, the chassis
gate drops 6,790 of 13,262 document links and 1,030 of 6,954 nodes; the
runtime gate for one rear-drive 325i saloon (AN35) drops 8,336. The extract
therefore ships each document's decoded rule beside it, so the app can
finish the job without a second copy of the databases.

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
    rule_eval,
)

# the picture pool is the repair extract's, and these documents reference it;
# its two resolvers are reused rather than reimplemented so both extracts
# always address the same pooled file for the same figure. parse_body is
# reused for the same reason: the newer namespaced repair schema is already
# read correctly there, and a second copy here would drift from it.
from repair_extract import (  # noqa: E402
    parse_body,
    pic_name,
    read_segments,
    resolve_pic,
    write_pictures,
)

# ---- the trees --------------------------------------------------------------
# the two structure roots. Both carry CONTROLID = 0, so their first level is
# reached by ID rather than by control id (see the module docstring).
FUNCTION_ROOT = 7863179
COMPONENT_ROOT = 7863691

# XEP_PERCEIVEDSYMPTOMS holds four vocabularies, all four hanging off this
# one virtual parent, which is not itself a row in the table. See
# build_symptoms for why the Fault patterns root is found through it.
SYMPTOM_VIRTUAL_PARENT = 7866251

# VFC_TYP marks each vocabulary's root row, and it is the ONE column that
# names them: "RootOld" is the Fault patterns tree a workshop navigates,
# beside RootFun (Fault pattern function), RootCon (Component fault pattern)
# and RootFM (Standardised fault coding). It is null on every other row.
SYMPTOM_ROOT_TYPE = "RootOld"

# how many leading digits a car's fault-pattern group is titled with. The
# motorcycle groups carry three, and nothing but the digit count separates
# them (PKW and MOTORRAD are null on every one of the twelve).
CAR_GROUP_DIGITS = 2

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

# The two classes that hold no text and never will, with the reason each
# gives a reader. Everything else is attempted: a class whose content this
# file cannot read is a bug to find, not a row to drop silently.
#
#   ABL  a compiled test module. ISTA RUNS it; there is no prose to ship.
#   SSP  an <svg> wiring diagram, which belongs to the wiring importer.
NO_BODY_CLASSES = {
    5083266: "compiled test module",
    41153666: "compiled test module",
    46492802: "wiring diagram",
    46493442: "wiring diagram",
}

# document roots this extractor knows how to read. The first two are read by
# parse_document below; the repair-manual generation is read by
# parse_repair_body, which reuses the repair extract's own parser for the
# namespaced schema rather than keeping a second copy of it here.
TEXT_ROOTS = ("DIAGNOSISDOCUMENT", "SERVICEDOCUMENT")
REPAIR_ROOTS = ("REPAIRMANUALDOCUMENT", "REPAIRMANUALDOCUMENT_MOD")

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


def _group_digits(title):
    """How many digits a fault-pattern group's title leads with, else 0.

    "01 Powertrain" is 2 and "001 Drive" is 3; "Body equipment" is 0. The
    number must be followed by a space, so a symptom that merely starts with
    a figure ("4-wheel drive") is not mistaken for a group.

    @param title: the row's TITLE_ENGB, or None
    @returns: the leading digit count
    """
    text = str(title or "")
    n = 0
    while n < len(text) and text[n].isdigit():
        n += 1
    return n if n and text[n : n + 1] == " " else 0


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
    """A DocBook-style <TABLE> into rows of cell strings, and whether it heads.

    A THEAD row is a heading and a TBODY row is data, and the caller needs to
    know which the first row was: drawing a data row as a heading loses it,
    and drawing a heading as data makes a column name look like a value.

    @param tbl: a TABLE element
    @returns: (rows, has a head row)
    """
    rows = []
    headed = False
    for grp in tbl.iter("TGROUP"):
        for section in grp:
            if section.tag not in ("THEAD", "TBODY"):
                continue
            for row in section.findall("ROW"):
                cells = [_flat(e) for e in row.findall("ENTRY")]
                if not any(cells):
                    continue
                if section.tag == "THEAD" and not rows:
                    headed = True
                rows.append(cells)
    return rows, headed


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
                rows, headed = _table_rows(child)
                if not rows:
                    continue
                if max(len(r) for r in rows) == 1:
                    for row in rows:
                        if row[0]:
                            out.append({"s": row[0], "t": "bullet"})
                else:
                    block = {"rows": rows, "t": "table"}
                    if not headed:
                        block["head"] = 0
                    out.append(block)
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
        # a LEGENDTABLE has no head row: its rows are all name/explanation
        # pairs, so drawing the first as a heading would lose a real part
        blocks.append({"head": 0, "rows": rows, "t": "table"})
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


def resolve_pics(sections, segments, stats, wanted):
    """Turn every picture block's file name into the pooled stream id.

    THE PICTURE POOL IS SHARED WITH THE REPAIR EXTRACT, and these documents
    do not merely reference it: they link figures the repair manual never
    did, so the pool has to be TOLD about them. The app's repairPicUrl
    addresses a picture by stream id, so a block left carrying "B060052.png"
    could never be drawn. The same two-step the repair extract uses resolves
    it -- the SRC's candidate names, then XEP_INFOSEGMENTS -- and every id
    that resolves is collected in `wanted` so write_pictures can add the ones
    the pool has not got.

    A name that resolves to NO stream id has its block dropped. Keeping it
    drew a broken-image icon, which tells a reader the app is broken rather
    than that ISTA holds a figure this build cannot show; the count travels
    in stats instead, where it is visible in the log and in index.json.

    @param sections: the parsed sections, modified in place
    @param segments: repair_extract.read_segments output
    @param stats: a dict the resolved and dropped counts are added to
    @param wanted: a set collecting every resolved stream id, for the pool
    """
    for sec in sections:
        keep = []
        for block in sec.get("blocks", ()):
            if block.get("t") != "pic":
                keep.append(block)
                continue
            cid = resolve_pic(pic_name(block.get("s")), segments)
            if cid is None:
                # NOT kept. A figure block whose name resolves to no stream id
                # is a picture this build cannot draw, and leaving it in put a
                # broken-image icon on the page -- which tells a reader the app
                # is broken rather than that ISTA holds a figure it has not
                # got. The count says how many, in the log and in index.json.
                stats["picdrop"] = stats.get("picdrop", 0) + 1
                continue
            block["s"] = cid
            stats["pics"] = stats.get("pics", 0) + 1
            wanted.add(cid)
            keep.append(block)
        sec["blocks"] = keep


def _local(tag):
    """An element's tag without its namespace.

    The newer repair generation namespaces every element; the older one
    namespaces none, and they name the same things. Comparing local names is
    what lets one check cover both.

    @param tag: the Element.tag string
    """
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _steps_to_blocks(section):
    """One repair section's steps folded into this file's block shape.

    WHY FOLD RATHER THAN SHIP THE STEP MODEL. A repair instruction's model is
    numbered steps, and the repair manual's own renderer draws the number
    because a mechanic says "I'm on four". These documents are reached from a
    symptom or a component, are drawn by istaDiagBodyHtml, and that renderer
    speaks blocks -- so the steps are folded into paragraphs, bullets and
    figures here rather than a second document model being taught to the
    page. A hint keeps its word ("Warning", "Note") in front of its text, so
    the one thing in a repair document that must not be read as an ordinary
    sentence still announces itself.

    @param section: a parse_body section, {title, steps, phase}
    @returns: a list of blocks
    """
    out = []
    for step in section.get("steps") or ():
        for names in step.get("pics") or ():
            # pics arrive as the candidate-name list the repair extract
            # builds; the first is the name as authored, which is what
            # resolve_pics re-resolves against the pooled segments
            if names:
                out.append({"s": names[0], "t": "pic"})
        for line in step.get("text") or ():
            out.append({"s": line, "t": "p"})
        for hint in step.get("hints") or ():
            label = str(hint.get("title") or hint.get("kind") or "").strip()
            for line in hint.get("text") or ():
                out.append({"s": f"{label}: {line}" if label else line, "t": "p"})
            if not hint.get("text") and label:
                out.append({"s": label, "t": "p"})
        for torque in step.get("torques") or ():
            rows = []
            for screw in torque.get("screws") or ():
                for val in screw.get("values") or ():
                    rows.append(
                        [
                            screw.get("thread") or "",
                            val.get("kind") or "",
                            f"{val.get('value', '')} {val.get('unit', '')}".strip(),
                        ]
                    )
            if rows:
                conn = torque.get("connection")
                if conn:
                    out.append({"s": conn, "t": "p"})
                # a torque table has no head row of its own: every row is a
                # fastener, and drawing the first as a heading would lose one
                out.append({"head": 0, "rows": rows, "t": "table"})
    return out


def parse_repair_body(xml, root):
    """A REPAIRMANUALDOCUMENT into {title, kind, sections}, or None.

    TWO GENERATIONS, ONE SHAPE. The flat generation puts its prose straight
    under the root, and the block collector reads it in document order. The
    namespaced <rep:..._MOD> one buries the same prose under proc:/tf:/hint:
    elements that the collector walks past, so the repair extract's own
    parser reads it and _steps_to_blocks folds the result. Trying the flat
    read first is not a preference: it is what keeps a FEB -- which is prose
    with no OPERATINGSTEP at all, and is what the Fault pattern tree is FOR
    -- from being handed to a parser that answers None for it.

    @param xml: the content store's text
    @param root: the already-parsed root element
    @returns: the parsed body, or None when the document holds no text
    """
    title = _flat(_find_local(root, "PROCESSDESC")) or _flat(
        _find_local(root, "TITLE")
    )
    blocks = _blocks(root, skip=("PROCESSTITLE", "DOCINFO", "HINTS"))
    if blocks:
        sections = [{"blocks": blocks, "heading": ""}]
    else:
        # the namespaced generation: its text is under elements the collector
        # walks past, so the repair extract's parser reads it instead
        repair = parse_body(xml)
        if not repair:
            return None
        title = title or repair.get("title") or ""
        sections = []
        for sec in repair.get("sections") or ():
            folded = _steps_to_blocks(sec)
            if not folded:
                continue
            heading = sec.get("title") or ""
            phase = sec.get("phase")
            sections.append(
                {
                    "blocks": folded,
                    "heading": f"{phase}: {heading}" if phase and heading
                    else (phase or heading),
                }
            )
        if not sections:
            return None
    return {"kind": _local(root.tag), "sections": sections, "title": title}


def _find_local(root, name):
    """The first descendant with this local name, namespaces ignored.

    @param root: where to search
    @param name: the local tag name
    @returns: the Element, or None
    """
    for node in root.iter():
        if _local(node.tag) == name:
            return node
    return None


def parse_document(xml):
    """One stored document body into {title, kind, sections}, or None.

    Returns None only when the stored content really holds no text -- an
    <svg> wiring diagram, a body that does not parse, a document whose only
    paragraph is empty -- so the caller ships the row without a body rather
    than with a wrong one.

    @param xml: the content store's text for the document, or None
    """
    if not xml:
        return None
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    tag = _local(root.tag)
    if tag in REPAIR_ROOTS:
        return parse_repair_body(xml, root)
    if tag not in TEXT_ROOTS:
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

        VFC_TYP comes along because it is what names the four vocabularies'
        root rows; see build_symptoms.

        @returns: {id: (parent id, title, selectable, vfc type)}
        """
        return {
            r[0]: (r[1], r[2], r[3], r[4])
            for r in self.con.execute(
                "SELECT ID, PARENTID, TITLE_ENGB, SELECTABLE, VFC_TYP "
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

    def numbers(self):
        """Document id -> the number a workshop quotes it by.

        XEP_INFOOBJECTS.DOCNUMBER is the column named for this, and it is
        populated on every one of E46's 13,262 linked documents. It carries
        the code a reader recognises -- "FEB-FEB-NED_AM2704_00156",
        "PIB-PIB-E46_PA52A" -- except on REP rows, where it holds the bare AW
        number ("5434359") and IDENTIFIER holds the prefixed form. They agree
        on all but 32 of E46's rows; where they differ both are kept, longest
        first, so a search for either finds the document.

        @returns: {id: number}
        """
        out = {}
        for doc_id, number, ident in self.con.execute(
            "SELECT ID, DOCNUMBER, IDENTIFIER FROM XEP_INFOOBJECTS"
        ):
            parts = []
            for value in (number, ident):
                text = str(value or "").strip()
                if text and text not in parts:
                    parts.append(text)
            if parts:
                out[doc_id] = " ".join(parts)
        return out


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
            # the same three-valued gate as everywhere else: only a decided
            # False excludes a branch
            if rule_eval(tree, ids) is False:
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
def gate(rules, key, ids, stats, what):
    """The three-valued validity gate for one document or node.

    THE RULE, and it is the same one everywhere: no rule keeps, undecided
    keeps, FALSE drops. Only a rule that evaluates to False is evidence that
    a thing does not belong to this car -- a rule this build cannot decide is
    the absence of a fact, not the presence of a no, and dropping on it would
    delete a repair step because the extract carries no equipment list.

    @param rules: diag.rules() output
    @param key: the document's or node's id, which is its XEP_RULES key
    @param ids: the characteristic value ids to decide against
    @param stats: a counter dict, keyed "<what>Kept"/"<what>Dropped"/...
    @param what: "doc" or "node", for the stats keys
    @returns: (keep, the decoded rule, whether the blob failed to decode)
    """
    blob = rules.get(key)
    tree, unsure = decode_rule(blob)
    if unsure:
        verdict, bucket = True, "Unsure"
    elif tree is None:
        verdict, bucket = True, "NoRule"
    else:
        answer = rule_eval(tree, ids)
        verdict = answer is not False
        bucket = {True: "Yes", False: "Dropped", None: "Undecided"}[answer]
    stats[what + bucket] = stats.get(what + bucket, 0) + 1
    return verdict, tree, unsure


def walk_structure(diag, node, path, wanted, rules, ids, stats, numbers):
    """One structure node and everything under it into the emitted shape.

    GATED, node and document alike. A node the rule excludes returns None and
    takes its whole subtree with it, because a child of an excluded parent is
    excluded whatever its own rule says; a document the rule excludes is not
    listed on the node that links it.

    @param diag: a Diag
    @param node: (id, controlid, nodeclass, title)
    @param path: node ids on the way here, so a cycle cannot run away
    @param wanted: a set collecting every document id seen
    @param rules: diag.rules() output
    @param ids: the chassis's characteristic value ids
    @param stats: the gate's counters
    @param numbers: diag.numbers() output, the code a workshop quotes
    @returns: {id, label, kids, n}, or None when the gate excludes the node
    """
    node_id, control_id, _cls, title = node
    keep, _tree, _unsure = gate(rules, node_id, ids, stats, "node")
    if not keep:
        return None
    docs = []
    for doc_id, doc_class, doc_title in diag.documents(control_id):
        ok, rule, unsure = gate(rules, doc_id, ids, stats, "doc")
        if not ok:
            continue
        wanted.add((doc_id, doc_class))
        row = {"id": doc_id, "title": doc_title or "", "type": doc_type(doc_class)}
        number = numbers.get(doc_id)
        if number:
            row["num"] = number
        # the decoded rule travels with the row so the app can narrow the
        # chassis-wide answer to the actual car without a second copy of the
        # databases; `unsure` marks a blob the grammar could not read
        if rule is not None:
            row["rule"] = rule
        if unsure:
            row["unsure"] = 1
        docs.append(row)
    kids = []
    if node_id not in path:
        sub = path | {node_id}
        for child in diag.children(control_id):
            built = walk_structure(
                diag, child, sub, wanted, rules, ids, stats, numbers
            )
            if built is not None:
                kids.append(built)
    out = {
        "id": node_id,
        "kids": kids,
        "label": title or "",
        "n": len(docs) + sum(k["n"] for k in kids),
    }
    if docs:
        out["docs"] = docs
    return out


def build_structure(diag, branches, wanted, rules, ids, stats, numbers):
    """A whole structure tree for one chassis.

    A single applying branch becomes the tree's root, because that IS the
    chassis's structure. Several become the first level under a synthetic
    root, so nothing is silently chosen between them.

    @param diag: a Diag
    @param branches: resolve_branches output for one root
    @param wanted: a set collecting every document id seen
    @param rules: diag.rules() output
    @param ids: the chassis's characteristic value ids
    @param stats: the gate's counters
    @param numbers: diag.numbers() output
    @returns: the root node, or None when no branch applies
    """
    trees = []
    for b in branches:
        built = walk_structure(
            diag,
            (b["id"], b["controlId"], None, b["label"]),
            frozenset(),
            wanted,
            rules,
            ids,
            stats,
            numbers,
        )
        if built is not None:
            trees.append(built)
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


def build_symptoms(diag, rules, ids, wanted, stats, numbers):
    """The fault-pattern tree: ONE root, the numbered groups beneath it.

    WHICH ROWS ARE THIS TREE. XEP_PERCEIVEDSYMPTOMS is four vocabularies in
    one table, and only one of them is the Fault patterns tree a workshop
    navigates. All four hang off the same virtual parent 7866251, which is
    not itself a row, so taking "every row whose PARENTID is not in the
    table" yields 27 unrelated roots -- three of the four vocabularies plus
    24 rows whose parent is simply missing -- and the tree reads as a flat
    list of thousands.

    VFC_TYP is what tells the four apart, and it is the only column that
    does. It is null on all 5,350 other rows and set on exactly these:

        RootOld  Fault patterns                  the tree ISTA draws
        RootCon  Component fault pattern         the by-part index
        RootFun  Fault pattern function          the by-function index
        RootFM   Standardised fault coding       the SAE code vocabulary

    Titles cannot do this job: three of the four begin "Fault pattern", and
    RootCon's own children are numbered ("11 Engine", "12 Engine electrical
    system") exactly like the tree's, so matching on a leading number finds
    the wrong root. Nothing outside RootOld's descendants is in this tree.

    THE NUMBERED GROUPS. That root's children are twelve rows, each titled
    with a leading number: nine two-digit groups (01 Powertrain .. 09
    Voltage supply, bus systems) which are the car tree, and three
    three-digit ones (001 Drive, 002 Chassis and suspension, 003 Electrical
    system) which are the motorcycle tree. The digit COUNT is the only thing
    that separates those twelve -- PKW and MOTORRAD are null on every one of
    them -- so a car chassis takes the two-digit groups and the motorcycle
    ones are left out rather than shown as three extra top-level branches
    the car has not got.

    THE VALIDITY GATE. A symptom carries a rule in XEP_RULES keyed by its
    own id, and most do not: 12 of the 84 nodes under the nine groups have
    one. A symptom with no rule of its own INHERITS its parent's, which is
    what makes the sparse coverage work -- a group's rule scopes everything
    filed under it, and a child's own rule narrows it further. A gated-out
    node takes its subtree with it, since a child of an excluded parent is
    excluded whatever its own rule says.

    @param diag: a Diag
    @param rules: diag.rules() output
    @param ids: the chassis's characteristic value ids
    @param wanted: a set collecting every document id seen
    @param stats: a dict the gate's counts are written into
    @param numbers: diag.numbers() output
    @returns: the root node, or None when the root row is not in this database
    """
    rows = diag.symptoms()
    links = diag.symptom_objects()
    kids_of = {}
    for sid, (parent, _title, _sel, _vfc) in sorted(rows.items()):
        if parent != sid:
            kids_of.setdefault(parent, []).append(sid)

    # the root: the one row under the shared virtual parent whose VFC_TYP
    # marks it as this vocabulary's. Its three siblings are the others.
    root_id = next(
        (
            sid
            for sid in sorted(kids_of.get(SYMPTOM_VIRTUAL_PARENT, ()))
            if rows[sid][3] == SYMPTOM_ROOT_TYPE
        ),
        None,
    )
    if root_id is None:
        return None

    groups = [
        k
        for k in kids_of.get(root_id, ())
        if _group_digits(rows[k][1]) == CAR_GROUP_DIGITS
    ]
    stats["groups"] = len(groups)
    stats["seen"] = 0
    stats["kept"] = 0
    stats["norule"] = 0

    def build(sid, inherited, path):
        """One symptom and its subtree, or None when the gate excludes it.

        @param sid: the symptom's id
        @param inherited: the nearest ancestor's decoded rule, or None
        @param path: ids on the way here, so a cycle cannot run away
        """
        _parent, title, selectable, _vfc = rows[sid]
        stats["seen"] += 1
        blob = rules.get(sid)
        if blob is None:
            # no rule of its own: the parent's still applies to it
            stats["norule"] += 1
            rule, unsure = inherited, False
        else:
            rule, unsure = decode_rule(blob)
        if rule_eval(rule, ids) is False:
            return None
        stats["kept"] += 1

        docs = []
        seen = set()
        for obj_id, _cls, control_id, _obj_title in links.get(sid, ()):
            del obj_id
            for doc_id, doc_class, doc_title in diag.documents(control_id):
                if doc_id in seen:
                    continue
                seen.add(doc_id)
                # the document's OWN rule, not the symptom's: a symptom about
                # a fluid leak is filed under a group that applies to every
                # car, and it is the document behind it that says which car
                ok, doc_rule, doc_unsure = gate(rules, doc_id, ids, stats, "doc")
                if not ok:
                    continue
                wanted.add((doc_id, doc_class))
                row = {
                    "id": doc_id,
                    "title": doc_title or "",
                    "type": doc_type(doc_class),
                }
                number = numbers.get(doc_id)
                if number:
                    row["num"] = number
                if doc_rule is not None:
                    row["rule"] = doc_rule
                if doc_unsure:
                    row["unsure"] = 1
                docs.append(row)
        docs.sort(key=lambda d: (d["type"], d["title"], d["id"]))

        kids = []
        if sid not in path:
            sub = path | {sid}
            for kid in sorted(
                kids_of.get(sid, ()), key=lambda k: (rows[k][1] or "", k)
            ):
                built = build(kid, rule, sub)
                if built is not None:
                    kids.append(built)
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
        # a rule that did not decode leaves the node shown and marked, the
        # widening-not-narrowing direction validity_rules.py documents
        if unsure:
            out["unsure"] = 1
        return out

    root_rule, _unsure = decode_rule(rules.get(root_id))
    kids = []
    for gid in sorted(groups, key=lambda k: (rows[k][1] or "", k)):
        built = build(gid, root_rule, frozenset({root_id}))
        if built is not None:
            kids.append(built)
    return {
        "id": root_id,
        "kids": kids,
        "label": rows[root_id][1] or "Fault patterns",
        "n": sum(k["n"] for k in kids),
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


def search_text(body):
    """One parsed body as the lowercased plain text the search page matches.

    The Text Search page asks a case-insensitive SUBSTRING question of a
    document's words, so structure is exactly what it does not need: every
    heading, paragraph, bullet and table cell is run together, lowercased and
    whitespace-collapsed. Keeping the markup would only make the index bigger
    and the match no better.

    @param body: a parsed body {title, sections}
    @returns: the text
    """
    parts = [str(body.get("title") or "")]
    for sec in body.get("sections") or ():
        parts.append(str(sec.get("heading") or ""))
        for block in sec.get("blocks") or ():
            if block.get("t") == "table":
                for row in block.get("rows") or ():
                    parts.extend(str(c or "") for c in row)
            elif block.get("t") != "pic":
                # a pic block's `s` is a stream id, not words
                parts.append(str(block.get("s") or ""))
    return re.sub(r"\s+", " ", " ".join(parts)).strip().lower()


def write_bodies(diag, content, segments, wanted, out_dir, verbose=False):
    """Parse and write every document body the trees reference.

    EVERY CLASS IS ATTEMPTED except the two in NO_BODY_CLASSES, which hold no
    text at all. A class this file cannot read is a bug to find, not a row to
    drop quietly, and the per-class table it returns is what makes that
    visible: a class that silently stops parsing shows up as a zero in the
    next run's log and in index.json.

    @param diag: a Diag
    @param content: a Content over the body store
    @param segments: repair_extract.read_segments output, for the figures
    @param wanted: {(doc id, node class)} collected by the walks
    @param out_dir: the chassis folder
    @param verbose: print progress
    @returns: (stats, per-type counts, the wanted picture ids, the search index)
    """
    stats = {"bodies": 0, "bytes": 0, "nocontent": 0, "notext": 0, "unparsed": 0}
    by_type = {}
    pics = set()
    index = {}
    ordered = sorted(wanted)
    for n, (doc_id, node_class) in enumerate(ordered):
        code = doc_type(node_class)
        slot = by_type.setdefault(code, {"body": 0, "docs": 0, "nobody": 0})
        slot["docs"] += 1
        if node_class in NO_BODY_CLASSES:
            # the two that legitimately cannot: the reason travels with the
            # count, so "no body" never has to be guessed at
            slot["why"] = NO_BODY_CLASSES[node_class]
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
        resolve_pics(body["sections"], segments, stats, pics)
        body["id"] = doc_id
        body["type"] = code
        stats["bytes"] += write_json_gz(
            os.path.join(out_dir, "docs", f"{doc_id}.json.gz"), body
        )
        text = search_text(body)
        if text:
            index[str(doc_id)] = text
        stats["bodies"] += 1
        slot["body"] += 1
        if verbose and n and n % 2000 == 0:
            print(f"  {n} of {len(ordered)} documents...", file=sys.stderr)
    return stats, by_type, pics, index


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
    ap.add_argument(
        "--pics",
        help="streamdataprimitive_OTHER.sqlite, to add this extract's own "
        "figures to the shared picture pool",
    )
    ap.add_argument(
        "--pic-out",
        action="append",
        help="a pool folder to write pictures into; repeatable, so the "
        "repair extract's pool and the app's data folder stay in step",
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
    symptom_stats = {}
    gate_stats = {}
    numbers = diag.numbers()
    trees = {
        "component-structure": build_structure(
            diag, branches["component"], wanted, rules, ids, gate_stats, numbers
        ),
        "function-structure": build_structure(
            diag, branches["function"], wanted, rules, ids, gate_stats, numbers
        ),
        "fault-pattern": build_symptoms(
            diag, rules, ids, wanted, symptom_stats, numbers
        ),
    }
    if args.verbose and symptom_stats:
        print(
            f"  fault patterns: {symptom_stats['groups']} groups, "
            f"{symptom_stats['kept']} of {symptom_stats['seen']} symptoms kept, "
            f"{symptom_stats['norule']} inherited a parent's rule",
            file=sys.stderr,
        )
    if args.verbose:
        # the gate, in the direction that matters: what it DROPPED, and what
        # it kept only because the rule could not be decided
        print(
            "  validity gate: "
            f"{gate_stats.get('docDropped', 0)} document links and "
            f"{gate_stats.get('nodeDropped', 0)} nodes dropped; kept "
            f"{gate_stats.get('docYes', 0)} decided, "
            f"{gate_stats.get('docUndecided', 0)} undecided, "
            f"{gate_stats.get('docNoRule', 0)} with no rule, "
            f"{gate_stats.get('docUnsure', 0)} whose rule did not decode",
            file=sys.stderr,
        )

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
        body_stats, by_type, pool, search = {"skipped": True}, {}, set(), {}
    else:
        body_stats, by_type, pool, search = write_bodies(
            diag, content, read_segments(diag.con), wanted, out_dir, args.verbose
        )

    if search:
        files["search-index"] = {
            "bytes": write_json_gz(
                os.path.join(out_dir, "search-index.json.gz"), search
            ),
            "docs": len(search),
            "file": "search-index.json.gz",
        }
        if args.verbose:
            print(
                f"  search index: {len(search)} documents, "
                f"{files['search-index']['bytes'] / 1e6:.2f} MB gzipped",
                file=sys.stderr,
            )

    if args.verbose and by_type:
        # THE PER-CLASS COVERAGE TABLE. A class that silently loses its
        # bodies is invisible in a total; here it is a zero in a row.
        print("  bodies by document class:", file=sys.stderr)
        for code in sorted(by_type):
            row = by_type[code]
            why = f"  ({row['why']})" if row.get("why") else ""
            print(
                f"    {code}  {row['body']:>6} of {row['docs']:>6} linked{why}",
                file=sys.stderr,
            )

    pics_written = pics_missing = 0
    if args.pics and pool:
        streams = sqlite3.connect(f"file:{args.pics}?mode=ro", uri=True)
        streams.execute("PRAGMA query_only=1")
        for dest in [d for d in (args.pic_out or []) if d]:
            # the pool is SHARED with the repair extract, so a picture is
            # written to every pool the caller names and the two never
            # disagree about what a stream id draws
            wrote, gone, _bytes = write_pictures(streams, pool, dest, args.verbose)
            pics_written, pics_missing = wrote, gone
            if args.verbose:
                print(
                    f"  pictures: {wrote} in {dest}, "
                    f"{gone} not in the stream store",
                    file=sys.stderr,
                )
        streams.close()

    index = {
        "branches": branches,
        "bodies": body_stats,
        "chassis": chassis,
        "docTypes": {
            code: dict(counts) for code, counts in sorted(by_type.items())
        },
        "documents": len(wanted),
        "files": files,
        "gate": dict(sorted(gate_stats.items())),
        "pictures": {
            "dropped": body_stats.get("picdrop", 0),
            "missing": pics_missing,
            "resolved": len(pool),
            "written": pics_written,
        },
        "symptoms": symptom_stats,
        "version": 1,
    }
    write_json(os.path.join(out_dir, "index.json"), index)
    print(json.dumps(index, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
