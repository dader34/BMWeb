#!/usr/bin/env python3
"""Extract ISTA's repair instructions into the app's data folder.

The Repair/Maintenance section's documents: NODECLASS 46445826
("Reparaturanleitung", 67,634 rows, every one with English content), plus
class 99999999996 ("Reparaturhinweis", 185 short notes) which ISTA files in
the same tree. Service information (46470274) is NOT here: ISTA shows those
under Troubleshooting, and that is where they belong.

TWO DATABASES AND A PICTURE STORE, the same joins the workshop-reference
extract uses:

    DiagDocDb.decrypted.sqlite        the STRUCTURE
      XEP_INFOOBJECTS.NODECLASS -> repair instruction or repair note
      XEP_INFOOBJECTS.CONTROLID -> XEP_REFCONTENTS.ID
        -> .CONTENTCONTROLID    -> XEP_IOCONTENTS.CONTROLID
        -> .CONTENT_ENGB        -> a content id
      XEP_RULES.ID = the doc id -> the validity blob
      XEP_INFOSEGMENTS.GRAFIKNUMMER -> .CONTENTID, a picture's stream id
         │
         ▼
    xmlvalueprimitive_ENGB.sqlite     the document BODIES
    streamdataprimitive_OTHER.sqlite  the PICTURES

TWO SCHEMA GENERATIONS, one document model. 72% of the corpus is the old
flat <REPAIRMANUALDOCUMENT>: PROCESSTITLE with the group numbers, then
OPERATINGSTEPs of ILLUSTRATION / PARAGRAPH / HINT. 26% is the newer
namespaced <rep:REPAIRMANUALDOCUMENT_MOD>, which splits the job into
PREPROCESSES / KEYPROCESS / POSTPROCESSES, wraps every sentence in
tf:TEXTFRAGMENT, and -- the reason it is worth parsing properly -- carries
its tightening torques INLINE, on the step that needs them, as structured
tigh:TIGHTENING elements rather than as prose. Both are read into the same
{sections: [{title, steps: [...]}]} shape so the renderer has one job.

WHAT THE PICTURES COST, and why they are not all here. A GRAPHIC SRC names
a PNG in the stream store, and those PNGs are photographs saved without
compression -- 57 KB on average for a 316x238 image. The whole corpus
references 113,286 distinct pictures: 1.6 GB even re-encoded, which no
upload budget reaches. Per chassis it is ~10,000 pictures, ~110 MB, which
one does. So the index and the bodies ship for every chassis (they are
text, and cheap) and the PICTURES ship per chassis, for the chassis asked
for. A chassis whose pictures were not uploaded still browses, searches and
reads every step; the illustration is simply absent, and the app says so
rather than drawing a broken image.

WHAT IS DROPPED FROM THE XML, and why:
  - GRA-SYM-GRCI0000-*  ISTA's own warning/note icons. 8,253 of the 9,516
    unresolved picture references are these. They are UI furniture, not
    content, and the app draws its own hint badges, so shipping 20 copies
    of a yellow triangle would cost bytes and gain nothing.
  - SQS-VERIFIED / SQS-DOCUMENT-VERIFIED attributes: BMW's internal
    editorial review flags. They say nothing to a mechanic.
  - VALIDITYID / VALIDITYINFO on nested processes: a German-language rule
    string duplicating the document's own XEP_RULES blob, which is already
    decoded and evaluated. Keeping both would let them disagree.
  - LINKID on graphics: an intra-document anchor the flat renderer has no
    use for; the SRC is what resolves a picture.
  - st:SPECIALTOOLDOCUMENT subtrees inlined into steps: the tool catalogue
    is the Workshop tab's job and already ships there. The step keeps the
    tool's number and name as text so the reference is not lost.

Output, under data/ista/repair/ (gitignored, uploaded to the dataset):

    index.json              the group tree and the per-chassis document lists
    groups.json             main group / subgroup number -> name
    <chassis>/index.json    that chassis's documents: id, title, numbers,
                            validity rule, `unsure`, and its body shard
    <chassis>/body/NN.json  bodies, sharded by main group
    <chassis>/pics/<id>.webp   the illustrations, when --pictures was given

Usage:
    tools/ista/repair_extract.py \\
        --diagdoc ~/.../DiagDocDb.decrypted.sqlite \\
        --content ~/.../xmlvalueprimitive_ENGB.sqlite \\
        --streams ~/.../streamdataprimitive_OTHER.sqlite \\
        --out data/ista/repair --chassis E46 --pictures
"""
import argparse
import io
import json
import os
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ista_extract import Content
from validity_rules import (
    chassis_char_ids,
    decode_rule,
    read_char_names,
    read_typekeys,
    rule_applies,
)

# ---- the classes ------------------------------------------------------------
# NODECLASS -> the short label the app's "Type" column shows, the way ISTA
# abbreviates them in its own Type/Title table
CLASSES = {
    46445826: "REP",
    99999999996: "HIN",
}

# XML namespaces of the newer generation. Only these five carry content; the
# editor namespace is authoring metadata and never read.
NS = {
    "rep": "http://bmw.com/2013/RepairManualDocument_Mod_1.0",
    "proc": "http://bmw.com/2013/Process_Mod_1.1",
    "hint": "http://bmw.com/2013/Hint_Mod_1.0",
    "tigh": "http://bmw.com/2013/Tightening_Mod_1.0",
    "tf": "http://bmw.com/2013/TextFragment_1.0",
    "st": "http://bmw.com/2007/SpecialTool_1.0",
}

# HINT TYPE / SIGNALWORD -> the kind the renderer styles. Both generations
# name the same five kinds in different vocabularies, so they are folded
# here rather than in the app: a warning must look like a warning whichever
# generation authored it.
HINT_KINDS = {
    "COMMON": "note",
    "NOTE": "note",
    "HINWEIS": "note",
    "INFO": "note",
    "INSTALL": "install",
    "PRELIMINARIES": "before",
    "ATTENTION": "caution",
    "ACHTUNG": "caution",
    "CAUTION": "caution",
    "WARNING": "warning",
    "WARNUNG": "warning",
    "DANGER": "danger",
    "DISPOSAL": "disposal",
    "RECYCLING": "disposal",
}

# picture-name prefixes the SRC carries that the segment table does not.
# "GRA-PIX-GRRB-27-001-96.png" is segment "GRRB-27-001-96"; the old style
# "GRRA4110-42.png" is segment "RA4110-42". Measured over 33,382 references
# in an 800-document sample: these lift resolution from 62.8% to 71.5%, and
# 8,253 of the remaining 9,516 misses are the GRCI0000 icons this drops on
# purpose, leaving 95.0% of real illustrations resolved.
PIC_PREFIXES = ("GRA-PIX-", "GRA-SYM-", "GRA-EGR-", "EGR-EGR-", "PIX-PIX-")

# ISTA's own icon set: UI furniture, never shipped (see the module docstring)
PIC_ICON_MARK = "GRCI0000"

# how wide a shipped illustration is drawn at most, and its WebP quality.
# The source PNGs are uncompressed photographs; at 480px/q65 they come to
# 17% of their original bytes, which is what makes a chassis's pictures fit.
PIC_MAX_WIDTH = 480
PIC_QUALITY = 65


def _text(el):
    """Full text of one element, inline children included, space-normalised.

    The same reason ista_extract._flat exists: a PARAGRAPH carries inline
    markup (tf:IMAGENUMBER, EMPHASIZE, HOTSPOT) and .text would stop at the
    first child, so "Release bolts (1)." would ship as "Release bolts".

    @param el: an Element
    @returns: the text, or "" when the element is empty
    """
    if el is None:
        return ""
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip()


def _text_outside(el, claimed):
    """Text of one element, skipping subtrees another block already took.

    The new generation nests a step's torque table INSIDE the instruction
    that tightens the fastener. That table is read as structured torque
    data, so flattening the instruction with itertext() would print the
    figure a second time as prose -- and a torque figure printed twice, in
    two formats, is exactly the ambiguity this extract exists to remove.

    @param el: the element whose text is wanted
    @param claimed: ids of elements already consumed by another block
    @returns: the text, or "" when everything under it was claimed
    """
    parts = []

    def walk(node):
        """Append this node's own text and tails, skipping claimed children."""
        if node.text:
            parts.append(node.text)
        for kid in node:
            if id(kid) not in claimed:
                walk(kid)
            # the tail belongs to the parent's flow, so it travels either way
            if kid.tail:
                parts.append(kid.tail)

    walk(el)
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def _local(tag):
    """An element's tag without its namespace.

    Both generations are walked by local name, because they name the same
    things -- OPERATINGSTEP, HINT, GRAPHIC -- and differ only in whether a
    namespace is bolted on.

    @param tag: the Element.tag string
    """
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find(el, *locals_):
    """The first descendant with one of these local names, or None.

    @param el: where to search
    @param locals_: local tag names to accept
    """
    want = set(locals_)
    for node in el.iter():
        if _local(node.tag) in want:
            return node
    return None


def _kids(el, *locals_):
    """The direct children with one of these local names.

    Direct children, not descendants: a PROCESS's STEPS must not pick up the
    steps of a process nested inside it, or a job would render twice.

    @param el: the parent
    @param locals_: local tag names to accept
    """
    want = set(locals_)
    return [k for k in el if _local(k.tag) in want]


def pic_name(src):
    """A GRAPHIC SRC as the name to look for, or None when it is an icon.

    @param src: the SRC attribute, e.g. "GRA-PIX-GRRB-27-001-96.png"
    @returns: the candidate names in preference order, or [] for an icon
    """
    s = re.sub(r"\.png$", "", str(src or "").strip(), flags=re.I).lstrip("-")
    if not s:
        return []
    if PIC_ICON_MARK in s.upper():
        return []
    out = [s]
    for pre in PIC_PREFIXES:
        if s.upper().startswith(pre):
            out.append(s[len(pre) :])
            break
    # the old generation prefixes the segment name with a bare "GR"
    for o in list(out):
        if o.upper().startswith("GR"):
            out.append(o[2:])
    return out


def hint_kind(raw):
    """A HINT TYPE or SIGNALWORD as the kind the renderer styles.

    Unknown kinds become a plain note rather than being dropped: the text is
    what matters, and an unstyled hint still reads.

    @param raw: the TYPE attribute or SIGNALWORD text
    """
    return HINT_KINDS.get(str(raw or "").strip().upper(), "note")


# ---- the bodies -------------------------------------------------------------
def parse_torque(el):
    """A tigh:TIGHTENING element as {connection, screws: [...]}.

    Torque is the one thing in a repair instruction that is dangerous to get
    wrong, so it is read from its own structured elements -- CONNECTION,
    DIMENSION, the PROPERTY/NUMERICVALUE pairs -- and never flattened into
    prose. A screw can carry several properties (a jointing torque AND an
    angle of rotation), and all of them travel.

    @param el: a tigh:TIGHTENING Element
    """
    out = {}
    conn = _text(_find(el, "CONNECTION"))
    if conn:
        out["connection"] = conn
    screws = []
    for sc in el.iter():
        if _local(sc.tag) != "SCREW":
            continue
        item = {}
        dim = _text(_find(sc, "DIMENSION"))
        if dim:
            item["thread"] = dim
        note = _text(_find(sc, "DESCRIPTION"))
        if note:
            item["note"] = note
        vals = []
        for prop in sc.iter():
            if _local(prop.tag) != "PROPERTY":
                continue
            kind = _text(_find(prop, "TYPE", "NAME", "DESIGNATION"))
            num = _find(prop, "NUMERICVALUE")
            if num is None:
                continue
            v = _text(_find(num, "VALUE"))
            u = _text(_find(num, "UNIT"))
            if not v:
                continue
            row = {"value": v}
            if u:
                row["unit"] = u
            if kind:
                row["kind"] = kind
            vals.append(row)
        if vals:
            item["values"] = vals
        if item:
            screws.append(item)
    if screws:
        out["screws"] = screws
    return out if out else None


def parse_hint(el):
    """A HINT / WARNING / DANGER / TECH_INFO element as one hint block.

    The two generations spell a hint differently -- the old one is a HINT
    with a TYPE and PARAGRAPHs, the new one a DANGER or TECH_INFO with a
    SIGNALWORD and TYPE_OF_DANGER / CONSEQUENCES / PROTECTION parts -- and
    both mean "stop and read this". They fold to the same block so the
    renderer styles them identically.

    @param el: the hint Element
    """
    tag = _local(el.tag)
    kind = hint_kind(el.get("TYPE") or _text(_find(el, "SIGNALWORD")) or tag)
    title = ""
    t = _find(el, "TITLE")
    if t is not None:
        title = _text(t)
    lines = []
    for part in el.iter():
        name = _local(part.tag)
        if name in ("TYPE_OF_DANGER", "CONSEQUENCES", "PROTECTION", "INFORMATION"):
            s = _text(part)
            if s:
                lines.append(s)
        elif name in ("PARAGRAPH", "SIMPLE_TEXTFRAGMENT"):
            # a PARAGRAPH inside one of the parts above is already covered
            if any(
                _local(p.tag) in ("TYPE_OF_DANGER", "CONSEQUENCES", "PROTECTION",
                                  "INFORMATION")
                for p in el.iter()
                if part in list(p.iter())[1:]
            ):
                continue
            s = _text(part)
            if s:
                lines.append(s)
    # the same sentence often appears as both a PARAGRAPH and its wrapper
    seen = set()
    text = []
    for s in lines:
        if s not in seen:
            seen.add(s)
            text.append(s)
    if not text and not title:
        return None
    out = {"kind": kind}
    if title:
        out["title"] = title
    if text:
        out["text"] = text
    return out


def parse_step(el):
    """One OPERATINGSTEP as {pics, text, hints, torques}.

    Both generations put the same four things in a step: an illustration or
    two, the instructions, any hints attached to them, and -- new generation
    only -- the tightening torques for the fasteners the step touches.

    @param el: an OPERATINGSTEP Element
    """
    step = {}
    pics = []
    for g in el.iter():
        if _local(g.tag) != "GRAPHIC":
            continue
        names = pic_name(g.get("SRC"))
        if names:
            pics.append(names)
    if pics:
        step["pics"] = pics

    hints = []
    hint_nodes = []
    for h in el.iter():
        if _local(h.tag) in ("HINT", "WARNING", "DANGER", "TECH_INFO", "DAMAGE"):
            hint_nodes.append(h)
    for h in hint_nodes:
        # a hint nested inside another hint is part of it, not its own block
        if any(h is not o and h in list(o.iter())[1:] for o in hint_nodes):
            continue
        block = parse_hint(h)
        if block:
            hints.append(block)
    if hints:
        step["hints"] = hints

    torques = []
    for t in el.iter():
        if _local(t.tag) != "TIGHTENING":
            continue
        row = parse_torque(t)
        if row:
            torques.append(row)
    if torques:
        step["torques"] = torques

    # the instruction text: everything that is not already inside a hint or
    # a torque block, so a sentence is never printed twice
    claimed = set()
    for h in hint_nodes:
        for n in h.iter():
            claimed.add(id(n))
    for t in el.iter():
        if _local(t.tag) == "TIGHTENING":
            for n in t.iter():
                claimed.add(id(n))
    text = []
    for node in el.iter():
        if id(node) in claimed:
            continue
        name = _local(node.tag)
        if name == "INSTRUCTION":
            # NOT _text: an INSTRUCTION carries its torque table as a child,
            # and flattening the whole subtree would print the figure twice,
            # once as prose and once in the torque block below it
            s = _text_outside(node, claimed)
            if s:
                text.append(s)
        elif name == "PARAGRAPH" and not any(
            _local(p.tag) in ("INSTRUCTION", "TEXTFRAGMENT")
            for p in el.iter()
            if node in list(p.iter())[1:]
        ):
            s = _text_outside(node, claimed)
            if s:
                text.append(s)
    seen = set()
    keep = []
    for s in text:
        if s not in seen:
            seen.add(s)
            keep.append(s)
    if keep:
        step["text"] = keep
    return step if step else None


def parse_process(el):
    """A PROCESS (or the old generation's whole PROCESS block) as a section.

    @param el: the PROCESS Element
    @returns: {title, steps} or None when it has no steps
    """
    title = ""
    for t in el:
        if _local(t.tag) == "TITLE":
            title = _text(t)
            break
    steps = []
    holder = None
    for k in el:
        if _local(k.tag) == "STEPS":
            holder = k
            break
    for s in _kids(holder if holder is not None else el, "OPERATINGSTEP"):
        step = parse_step(s)
        if step:
            steps.append(step)
    if not steps:
        return None
    out = {"steps": steps}
    if title:
        out["title"] = title
    return out


def parse_body(xml):
    """A repair document body -> {title, mainGroup, subGroup, job, sections}.

    Returns None when the XML will not parse or carries no steps at all,
    which is the extractor's way of saying "there is nothing to show here"
    rather than shipping an empty document the app must apologise for.

    @param xml: the body XML text
    """
    if not xml:
        return None
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None

    out = {}
    kind = _local(root.tag)

    # the old generation states its group numbers; the new one does not, and
    # its AWNUMBER carries them instead ("2720010" is group 27, subgroup 20)
    title_el = _find(root, "PROCESSTITLE")
    if title_el is not None:
        for tag, key in (
            ("MAINGROUPNUMBER", "mainGroup"),
            ("SUBGROUPNUMBER", "subGroup"),
            ("JOBNUMBER", "job"),
            ("PROCESSDESC", "title"),
        ):
            v = _text(_find(title_el, tag))
            if v:
                out[key] = v
    if not out.get("title"):
        for t in root:
            if _local(t.tag) == "TITLE":
                out["title"] = _text(t)
                break
    aw = root.get("AWNUMBER") or ""
    if aw:
        out["aw"] = aw
    if not out.get("mainGroup") and len(aw) >= 4 and aw[:4].isdigit():
        out["mainGroup"] = aw[:2]
        out["subGroup"] = aw[2:4]
        if len(aw) > 4 and aw[4:].isdigit():
            out["job"] = aw[4:]

    sections = []
    if kind == "REPAIRMANUALDOCUMENT_MOD":
        # the new generation splits a job into what must be done first, the
        # job itself, and what puts the car back together; the labels are
        # the app's, because the source names them only by element
        for holder, label in (
            ("PREPROCESSES", "Preliminary work"),
            ("KEYPROCESS", None),
            ("POSTPROCESSES", "Concluding work"),
        ):
            node = None
            for k in root:
                if _local(k.tag) == holder:
                    node = k
                    break
            if node is None:
                continue
            for inc in node.iter():
                if _local(inc.tag) != "PROCESS":
                    continue
                sec = parse_process(inc)
                if not sec:
                    continue
                if label:
                    sec["phase"] = label
                sections.append(sec)
    else:
        for p in root.iter():
            if _local(p.tag) != "PROCESS":
                continue
            sec = parse_process(p)
            if sec:
                sections.append(sec)
        if not sections:
            # a REPAIRMANUALHINT has no PROCESS: its steps hang off the root
            sec = parse_process(root)
            if sec:
                sections.append(sec)

    # document-level hints, the ones that apply before any step
    top = []
    for k in root:
        if _local(k.tag) != "HINTS":
            continue
        for h in k.iter():
            if _local(h.tag) in ("HINT", "WARNING", "DANGER", "TECH_INFO"):
                block = parse_hint(h)
                if block and block not in top:
                    top.append(block)
    if top:
        out["hints"] = top

    if not sections and not top:
        return None
    if sections:
        out["sections"] = sections
    return out


# ---- the group tree ---------------------------------------------------------
def group_number(raw, width=2):
    """A group number as its bare leading digits, zero-padded.

    The source is not consistent -- "11", "67-1", "13 32", "65 Airbag..." --
    and they all mean the group the number starts with. Anything with no
    leading digit files under 00, the same normalisation the workshop
    extract applies, so the two tabs agree on what group a document is in.

    @param raw: the number as authored
    @param width: how many digits the group has (2 main, 2 sub)
    """
    text = str(raw or "").strip()
    digits = ""
    for ch in text:
        if ch.isdigit():
            digits += ch
        else:
            break
    return digits.zfill(width)[:width] if digits else "0" * width


def group_names_from_index(path):
    """Main/sub group number -> name, voted from the workshop extract.

    The workshop reference documents state both the number and the name of
    their group; the repair instructions state only the number. So the names
    come from the extract that already ran, by majority vote per number.
    Returns ({}, {}) when that extract is not present -- the app then shows
    a group by its number alone, which is still navigable.

    @param path: the data/ista/techdata folder, or None
    """
    main = {}
    sub = {}
    if not path:
        return main, sub
    idx = os.path.join(path, "index.json")
    if not os.path.isfile(idx):
        return main, sub
    with open(idx, encoding="utf-8") as fh:
        docs = (json.load(fh) or {}).get("docs") or []
    votes_main = {}
    votes_sub = {}
    for d in docs:
        if d.get("mainGroup") and d.get("mainGroupName"):
            key = group_number(d["mainGroup"])
            votes_main.setdefault(key, {})
            name = str(d["mainGroupName"]).strip()
            votes_main[key][name] = votes_main[key].get(name, 0) + 1
        if d.get("subGroup") and d.get("subGroupName"):
            key = group_number(d.get("mainGroup")) + group_number(d["subGroup"])
            votes_sub.setdefault(key, {})
            name = str(d["subGroupName"]).strip()
            votes_sub[key][name] = votes_sub[key].get(name, 0) + 1
    for key, names in votes_main.items():
        main[key] = max(names.items(), key=lambda kv: (kv[1], -len(kv[0])))[0]
    for key, names in votes_sub.items():
        sub[key] = max(names.items(), key=lambda kv: (kv[1], -len(kv[0])))[0]
    return main, sub


def group_names_from_objects(diag):
    """Main/sub group number -> the name ISTA's own tree shows.

    THE AUTHORITATIVE SOURCE, and the reason the vote below it is only a
    fallback. ISTA does not name a group from the documents in it: it has
    named objects for exactly this, in XEP_DIAGNOSISOBJECTS --

        NODECLASS 5235202  the 42 main groups, HG_NUMMER + TITLE_ENGB
        NODECLASS 5236354  the 482 subgroups, HGUG_NUMMER (4 digits,
                           group and subgroup together) + TITLE_ENGB

    Their names are the ones on ISTA's screen, and they differ from what a
    vote over document text produces: the objects say "16 Fuel supply" and
    "17 Cooling" where the documents mostly say "Fuel Tank and Fuel Lines"
    and "Radiator". The subgroups are the bigger win -- a document states
    its subgroup NUMBER and almost never its name, so without these the
    tree shows a bare "2100" where ISTA shows "2100 Clutch, check".

    HG_NUMMER is null on the subgroup rows; their four digits carry both
    halves, which is also how ISTA prints them.

    @param diag: an open DiagDocDb connection
    @returns: (main, sub) dicts keyed the way group_number pads them
    """
    main = {}
    sub = {}
    for number, title in diag.execute(
        "SELECT HG_NUMMER, TITLE_ENGB FROM XEP_DIAGNOSISOBJECTS "
        "WHERE NODECLASS=5235202 AND TITLE_ENGB IS NOT NULL AND TITLE_ENGB<>''"
    ):
        if number is None or not str(number).strip():
            continue
        main[group_number(number)] = str(title).strip()
    for number, title in diag.execute(
        "SELECT HGUG_NUMMER, TITLE_ENGB FROM XEP_DIAGNOSISOBJECTS "
        "WHERE NODECLASS=5236354 AND TITLE_ENGB IS NOT NULL AND TITLE_ENGB<>''"
    ):
        text = str(number or "").strip()
        if len(text) < 4 or not text[:4].isdigit():
            continue
        # the key is group + subgroup, the same shape the document side builds
        sub[text[:4]] = str(title).strip()
    return main, sub


def merge_group_names(diag, techdata_path):
    """The group names, objects first and the document vote as a fallback.

    A group ISTA has no object for still gets the name most of its
    documents give it, which is better than a bare number; a group that has
    an object takes the object's name, because that is the name on ISTA's
    screen.

    @param diag: an open DiagDocDb connection
    @param techdata_path: the workshop extract folder, or None
    @returns: (main, sub) and a small stats dict for the run's summary
    """
    voted_main, voted_sub = group_names_from_index(techdata_path)
    obj_main, obj_sub = group_names_from_objects(diag)
    main = dict(voted_main)
    sub = dict(voted_sub)
    main.update(obj_main)
    sub.update(obj_sub)
    stats = {
        "objMain": len(obj_main),
        "objSub": len(obj_sub),
        "votedOnlyMain": len([k for k in voted_main if k not in obj_main]),
        "votedOnlySub": len([k for k in voted_sub if k not in obj_sub]),
    }
    return main, sub, stats


# ---- the pictures -----------------------------------------------------------
def read_segments(diag):
    """Picture name -> its stream id, for every PNG segment.

    Upper-cased, first wins: the same GRAFIKNUMMER can appear under two
    formats (PIX and EGR) pointing at the same artwork.

    @param diag: an open DiagDocDb connection
    """
    out = {}
    for name, cid in diag.execute(
        "SELECT GRAFIKNUMMER, CONTENTID FROM XEP_INFOSEGMENTS "
        "WHERE GRAFIKNUMMER IS NOT NULL AND CONTENTID IS NOT NULL "
        "AND INFORMATIONSFORMAT LIKE '%PNG%'"
    ):
        out.setdefault(str(name).upper(), cid)
    return out


def resolve_pic(names, segments):
    """The stream id for a GRAPHIC's candidate names, or None.

    @param names: pic_name output
    @param segments: read_segments output
    """
    for n in names:
        cid = segments.get(str(n).upper())
        if cid is not None:
            return cid
    return None


def write_pictures(streams, wanted, out_dir, verbose=False):
    """Re-encode each wanted picture into out_dir as <stream id>.webp.

    Returns (written, missing, bytes). The source PNGs are photographs saved
    without compression, so they are downscaled to PIC_MAX_WIDTH and saved
    as WebP: measured over 200 pictures that is 17% of the original bytes,
    which is the difference between a chassis fitting the upload budget and
    not. Skips anything already written, so a re-run is cheap.

    @param streams: an open streamdataprimitive connection
    @param wanted: the stream ids to write
    @param out_dir: where the .webp files go
    @param verbose: print progress
    """
    try:
        from PIL import Image
    except ImportError:
        print(
            "  pictures need Pillow (pip install Pillow); skipping", file=sys.stderr
        )
        return 0, len(wanted), 0
    os.makedirs(out_dir, exist_ok=True)
    written = missing = total = 0
    for n, cid in enumerate(sorted(wanted)):
        dest = os.path.join(out_dir, f"{cid}.webp")
        if os.path.exists(dest):
            written += 1
            total += os.path.getsize(dest)
            continue
        row = streams.execute(
            "SELECT stream FROM streamdataprimitive WHERE id=? "
            "AND (deleted IS NULL OR deleted=0) ORDER BY modified DESC LIMIT 1",
            (cid,),
        ).fetchone()
        if row is None or not row[0]:
            missing += 1
            continue
        try:
            im = Image.open(io.BytesIO(row[0]))
            im.load()
        except Exception:
            missing += 1
            continue
        if im.width > PIC_MAX_WIDTH:
            height = max(1, round(im.height * PIC_MAX_WIDTH / im.width))
            im = im.resize((PIC_MAX_WIDTH, height), Image.LANCZOS)
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "WEBP", quality=PIC_QUALITY, method=5)
        data = buf.getvalue()
        with open(dest, "wb") as fh:
            fh.write(data)
        written += 1
        total += len(data)
        if verbose and n and n % 500 == 0:
            print(f"    {n} pictures...", file=sys.stderr)
    return written, missing, total


# ---- the extraction ---------------------------------------------------------
def read_documents(diag, content, limit=None, verbose=False):
    """Every repair document: its index entry and its parsed body.

    Returns (docs, stats) where a doc is {id, type, rule, unsure, body}.
    This is the expensive pass -- 67,634 bodies out of a 15 GB store -- and
    it runs ONCE, with the per-chassis filtering done afterwards against
    what it produced.

    @param diag: an open DiagDocDb connection
    @param content: an ista_extract.Content over the body store
    @param limit: stop after this many documents (a smoke run)
    @param verbose: print progress
    """
    ids = tuple(CLASSES)
    sql = (
        "SELECT i.ID, i.NODECLASS, i.TITLE_ENGB, io.CONTENT_ENGB "
        "FROM XEP_INFOOBJECTS i "
        "JOIN XEP_REFCONTENTS rc ON rc.ID=i.CONTROLID "
        "JOIN XEP_IOCONTENTS io ON io.CONTROLID=rc.CONTENTCONTROLID "
        f"WHERE i.NODECLASS IN {ids} AND io.CONTENT_ENGB>0"
    )
    rules = {r[0]: r[1] for r in diag.execute("SELECT ID, RULE FROM XEP_RULES")}
    rows = list(diag.execute(sql))
    if limit:
        rows = rows[:limit]

    docs = []
    stats = {"rows": len(rows), "bodies": 0, "unsure": 0, "norule": 0, "nobody": 0}
    for n, (doc_id, node_class, title, content_id) in enumerate(rows):
        body = parse_body(content.get(content_id))
        if body is None:
            stats["nobody"] += 1
            continue
        stats["bodies"] += 1
        tree, unsure = decode_rule(rules.get(doc_id))
        if unsure:
            stats["unsure"] += 1
        elif tree is None:
            stats["norule"] += 1
        docs.append(
            {
                "id": doc_id,
                "type": CLASSES[node_class],
                "title": (title or body.get("title") or "").strip(),
                "rule": tree,
                "unsure": unsure,
                "body": body,
            }
        )
        if verbose and n and n % 5000 == 0:
            print(f"  {n} of {len(rows)} documents...", file=sys.stderr)
    return docs, stats


def write_chassis(docs, chassis, ids, out_root, main_names, sub_names, segments):
    """Write one chassis's index and body shards; return its wanted pictures.

    @param docs: read_documents output
    @param chassis: the development code
    @param ids: the chassis's characteristic value ids
    @param out_root: data/ista/repair
    @param main_names: main group number -> name
    @param sub_names: main+sub number -> name
    @param segments: read_segments output, for resolving illustrations
    """
    folder = os.path.join(out_root, chassis)
    os.makedirs(os.path.join(folder, "body"), exist_ok=True)
    index = []
    shards = {}
    wanted = set()
    for d in docs:
        if not d["unsure"] and not rule_applies(d["rule"], ids):
            continue
        body = d["body"]
        main = group_number(body.get("mainGroup"))
        sub = group_number(body.get("subGroup"))
        entry = {
            "id": d["id"],
            "type": d["type"],
            "title": d["title"] or "(untitled)",
            "g": main,
            "s": sub,
        }
        if body.get("job"):
            entry["job"] = str(body["job"])
        if body.get("aw"):
            entry["aw"] = body["aw"]
        if d["unsure"]:
            entry["unsure"] = True
        entry["shard"] = main
        index.append(entry)

        # resolve every illustration to its stream id, so the app asks for a
        # file name rather than re-deriving the naming rules in JavaScript
        out = json.loads(json.dumps(body))
        for sec in out.get("sections") or []:
            for step in sec.get("steps") or []:
                pics = []
                for names in step.get("pics") or []:
                    cid = resolve_pic(names, segments)
                    if cid is not None:
                        pics.append(cid)
                        wanted.add(cid)
                if pics:
                    step["pics"] = pics
                else:
                    step.pop("pics", None)
        out.pop("title", None)
        shards.setdefault(main, {})[str(d["id"])] = out

    total = 0
    groups = {}
    for e in index:
        node = groups.setdefault(e["g"], {"n": 0, "subs": {}})
        node["n"] += 1
        node["subs"][e["s"]] = node["subs"].get(e["s"], 0) + 1

    def write(path, obj):
        """Write one compact JSON file and return its size in bytes."""
        full = os.path.join(folder, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
        return os.path.getsize(full)

    tree = []
    for g in sorted(groups):
        node = groups[g]
        subs = [
            {
                "id": s,
                "name": sub_names.get(g + s, ""),
                "n": node["subs"][s],
            }
            for s in sorted(node["subs"])
        ]
        tree.append(
            {"id": g, "name": main_names.get(g, ""), "n": node["n"], "subs": subs}
        )
    total += write(
        "index.json",
        {"version": 1, "chassis": chassis, "tree": tree, "docs": index},
    )
    biggest = 0
    for name, bodies in shards.items():
        size = write(os.path.join("body", f"{name}.json"), bodies)
        biggest = max(biggest, size)
        total += size
    return {
        "docs": len(index),
        "shards": len(shards),
        "bytes": total,
        "biggest": biggest,
        "pics": wanted,
    }


def main():
    """Run the extraction and write the data folder."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--diagdoc", required=True, help="DiagDocDb.decrypted.sqlite")
    ap.add_argument("--content", required=True, help="xmlvalueprimitive_ENGB.sqlite")
    ap.add_argument("--streams", help="streamdataprimitive_OTHER.sqlite (pictures)")
    ap.add_argument("--out", default="data/ista/repair", help="output folder")
    ap.add_argument(
        "--techdata",
        default="data/ista/techdata",
        help="the workshop extract, for the group names",
    )
    ap.add_argument(
        "--chassis",
        default="",
        help="comma-separated development codes; default every chassis the app ships",
    )
    ap.add_argument(
        "--pictures",
        action="store_true",
        help="also write the illustrations (needs --streams and Pillow)",
    )
    ap.add_argument("--limit", type=int, help="stop after N documents (a smoke run)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    verbose = not args.quiet

    diag = sqlite3.connect(f"file:{args.diagdoc}?mode=ro", uri=True)
    diag.execute("PRAGMA query_only=1")
    content = Content(args.content)

    if verbose:
        print("reading the group names...", file=sys.stderr)
    main_names, sub_names, name_stats = merge_group_names(diag, args.techdata)
    if verbose:
        print(
            f"  {name_stats['objMain']} main and {name_stats['objSub']} subgroup "
            f"names from ISTA's own objects; "
            f"{name_stats['votedOnlyMain']}/{name_stats['votedOnlySub']} more "
            f"voted from the workshop extract",
            file=sys.stderr,
        )

    if verbose:
        print("reading the picture segment table...", file=sys.stderr)
    segments = read_segments(diag)

    if verbose:
        print("reading the repair documents...", file=sys.stderr)
    docs, stats = read_documents(diag, content, args.limit, verbose)

    if verbose:
        print("reading the vehicle characteristic maps...", file=sys.stderr)
    typekeys = read_typekeys(diag)
    char_names = read_char_names(diag)

    if args.chassis:
        chassis_list = [c.strip().upper() for c in args.chassis.split(",") if c.strip()]
    else:
        root = os.path.join("data", "chassis")
        chassis_list = sorted(
            d
            for d in (os.listdir(root) if os.path.isdir(root) else [])
            if re.fullmatch(r"[A-Z]{1,2}\d{2}", d)
        )

    os.makedirs(args.out, exist_ok=True)
    shipped = {}
    total_bytes = 0
    pic_bytes = 0
    for chassis in chassis_list:
        ids = chassis_char_ids(typekeys, char_names, chassis)
        if not ids:
            if verbose:
                print(f"  {chassis}: no type keys, skipped", file=sys.stderr)
            continue
        res = write_chassis(
            docs, chassis, ids, args.out, main_names, sub_names, segments
        )
        total_bytes += res["bytes"]
        row = {
            "docs": res["docs"],
            "shards": res["shards"],
            "bytes": res["bytes"],
            "pics": len(res["pics"]),
        }
        if args.pictures and args.streams and res["pics"]:
            streams = sqlite3.connect(f"file:{args.streams}?mode=ro", uri=True)
            streams.execute("PRAGMA query_only=1")
            if verbose:
                print(
                    f"  {chassis}: {len(res['pics'])} pictures...", file=sys.stderr
                )
            wrote, gone, size = write_pictures(
                streams, res["pics"], os.path.join(args.out, chassis, "pics"), verbose
            )
            streams.close()
            row["picsWritten"] = wrote
            row["picsMissing"] = gone
            row["picBytes"] = size
            pic_bytes += size
        shipped[chassis] = row
        if verbose:
            print(
                f"  {chassis}: {res['docs']} documents, "
                f"{res['bytes'] / 1e6:.2f} MB, {len(res['pics'])} pictures",
                file=sys.stderr,
            )

    top = os.path.join(args.out, "index.json")
    with open(top, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "version": 1,
                "chassis": shipped,
                "groups": {"main": main_names, "sub": sub_names},
            },
            fh,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    total_bytes += os.path.getsize(top)

    if verbose:
        print(
            f"\n{stats['rows']} rows, {stats['bodies']} with a body "
            f"({stats['nobody']} without)\n"
            f"  unsure (undecoded rule): {stats['unsure']}\n"
            f"  no rule at all (apply to every car): {stats['norule']}\n"
            f"  {len(shipped)} chassis written\n"
            f"  {total_bytes / 1e6:.2f} MB of documents"
            + (f", {pic_bytes / 1e6:.2f} MB of pictures" if pic_bytes else "")
            + f"\n  in {args.out}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
