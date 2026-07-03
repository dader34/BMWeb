#!/usr/bin/env python3
"""inpa2json — convert BMW INPA ``.ips`` / ``.IPO`` screen definitions to JSON.

Standalone by design: Python 3.8+ standard library only, no repo imports, no
network. Copy this single file anywhere, point it at INPA files, and consume
the JSON from any tool (BMacW, shell scripts, other diagnostic frontends).

Input formats
=============
``.ips``
    INPA screen *source* (C-like, ISO-8859-1 encoded). Two authoring dialects
    exist in the wild; both are handled:

    declarative (newer, e.g. ``ms43_sp2.ips``)::

        text(1,0,"max Überdrehzahl");            // row label
        text(2,0,"[1/min]");                     // unit, bracketed
        INPAapiJob(sgbd,"STATUS_...","","");     // job + args
        ergebnisAnalogAusgabe("STAT_.._WERT", 3,0, 0.0, 10240.0, ...);
        //                     result key             min   max  (exact!)

    imperative (older, e.g. ``dkg_90.ips``)::

        ftextout("Status Analogwerte 1 lesen",1,0,1,0);  // heading (attr=1)
        INPAapiJob(sgbd,"STATUS_ISTWERTE_LESEN","","");  // screen job
        ftextout("Motortemperatur [°C]",1,0,0,1);         // row label (attr=0)
        INPAapiResultAnalog(real_zahl,"STAT_.._WERT",1); // result read

    The declarative dialect yields exact labels, units, jobs, result keys AND
    gauge min/max. The imperative dialect yields exact labels/units/keys/job
    but carries no range in source.

``.IPO``
    Compiled INPA screen programs. No source is available, so readable strings
    are scraped heuristically: a comma-separated label list immediately
    followed by a semicolon-separated result-key list forms a screen row
    group; the nearest preceding EDIABAS job token names the polling job.
    Labels/units are best-effort and should be verified by the consumer.

Output schema
=============
One JSON object per input (see ``--schema`` for the machine-readable JSON
Schema)::

    {
      "source":  "<input file name>",
      "format":  "ips" | "ipo",
      "parser":  "inpa2json/1.1",
      "screens": [
        {
          "proc":    str|null,       # SCREEN procedure name (menu link key)
          "group":   str|null,       # screen title, source language (German)
          "job":     str|null,       # EDIABAS job polled for this screen
          "args":    str|null,       # job argument string, if any
          "render":  "analog"|"text",
          "columns": 1|2,            # 2 = paired bank layout (Bank1/Bank2)
          "method":  "ips-declarative"|"ips-imperative"|"ipo-strings",
          "rows": [
            { "key": str,            # EDIABAS result name (STAT_.._WERT)
              "label": str|null,     # display label, source language
              "unit":  str|null,     # display unit ("1/min", "°C", ...)
              "min": num, "max": num # ONLY present for ips-declarative
            } ]
        } ],
      "menus": [                     # INPA MENU tree (.ips only; [] for .IPO)
        { "name":  str,              # MENU procedure name
          "title": str|null,         # setmenutitle(), e.g. "Status lesen"
          "items": [
            { "key":     int,        # ITEM number (F-key / list position)
              "label":   str|null,   # entry text, source language
              "screen":  str|null,   # -> screens[].proc opened by this item
              "submenu": str|null    # -> menus[].name activated by this item
            } ] } ],
      "inputs": [ { "job": str|null, "prompt": str } ]
    }

The menu *tree* is reconstructed by the consumer: an item's ``submenu`` names
another menu. The graph is CYCLIC ("Zurück" items link back to the main
menu), so pick the root by convention — the menu named ``m_main``/``m_haupt*``
if present, else the first menu in file order — and guard traversal against
cycles. Item labels set only at runtime via ``setitem`` are captured from the
first such call.

``method`` states how much a consumer may trust each screen:

===================  ========================================================
ips-declarative      everything exact, including min/max
ips-imperative       labels/units/keys/job exact; supply your own gauge range
ipo-strings          heuristic scrape; verify labels/units before trusting
===================  ========================================================

Multi-job screens are split into one screen per (job, args) pair so consumers
can poll a single job per screen. Labels are NOT translated — they stay in
the source language. Output is deterministic: same input, same bytes out.

Usage
=====
::

    inpa2json.py FILE [FILE ...]        JSON to stdout (object, or array for
                                        multiple inputs)
    inpa2json.py DIR -o OUTDIR          convert every .ips/.ipo under DIR,
                                        one <base>.json per input in OUTDIR
    inpa2json.py FILE --pretty          indented output
    inpa2json.py --schema               print the JSON Schema and exit
    inpa2json.py --selftest             run embedded regression tests
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

__version__ = "1.1"
PARSER_ID = "inpa2json/" + __version__

#: INPA sources are ISO-8859-1 ("latin-1") with CRLF line endings.
IPS_ENCODING = "iso-8859-1"

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class Row:
    """One displayed value: an EDIABAS result key with its presentation."""

    key: str
    label: Optional[str]
    unit: Optional[str]
    #: Gauge range; populated only by the declarative .ips dialect, where the
    #: exact range is present in source. ``None`` elsewhere.
    min: Optional[float] = None
    max: Optional[float] = None
    #: Per-row job binding used internally before screens are split; the
    #: public schema carries the job at screen level.
    job: Optional[str] = None
    args: Optional[str] = None
    render: str = "analog"

    def to_public(self) -> Dict[str, object]:
        """Serialize for output; min/max included only when known exactly."""
        out: Dict[str, object] = {"key": self.key, "label": self.label,
                                  "unit": self.unit}
        if self.min is not None and self.max is not None:
            out["min"], out["max"] = self.min, self.max
        return out


@dataclass
class Screen:
    """One INPA screen: a titled group of rows polled from one job."""

    group: Optional[str]
    job: Optional[str]
    args: Optional[str]
    render: str
    columns: int
    method: str
    #: Originating SCREEN procedure name (``s_status_analog1``); menu items
    #: reference screens by this name. ``None`` for .IPO scrapes (no procs).
    proc: Optional[str] = None
    rows: List[Row] = field(default_factory=list)

    def to_public(self) -> Dict[str, object]:
        return {"proc": self.proc, "group": self.group, "job": self.job,
                "args": self.args, "render": self.render,
                "columns": self.columns, "method": self.method,
                "rows": [r.to_public() for r in self.rows]}


@dataclass
class MenuItem:
    """One numbered entry of an INPA MENU: label plus navigation targets."""

    key: int
    label: Optional[str]
    #: SCREEN procedure opened by this item (matches ``Screen.proc``).
    screen: Optional[str] = None
    #: Submenu (another ``Menu.name``) activated by this item.
    submenu: Optional[str] = None

    def to_public(self) -> Dict[str, object]:
        return {"key": self.key, "label": self.label,
                "screen": self.screen, "submenu": self.submenu}


@dataclass
class Menu:
    """One INPA ``MENU m_name() { ITEM(..) {..} .. }`` block.

    The menu *tree* is reconstructed by the consumer: an item's ``submenu``
    names another menu. The graph is cyclic ("Zurück" items back-link to the
    main menu), so pick the root by convention — ``m_main``/``m_haupt*`` if
    present, else the first menu in file order — and guard against cycles.
    """

    name: str
    title: Optional[str]
    items: List[MenuItem] = field(default_factory=list)

    def to_public(self) -> Dict[str, object]:
        return {"name": self.name, "title": self.title,
                "items": [i.to_public() for i in self.items]}


@dataclass
class Document:
    """Complete conversion result for one input file."""

    source: str
    format: str
    screens: List[Screen] = field(default_factory=list)
    menus: List[Menu] = field(default_factory=list)
    inputs: List[Dict[str, Optional[str]]] = field(default_factory=list)

    def to_public(self) -> Dict[str, object]:
        return {"source": self.source, "format": self.format,
                "parser": PARSER_ID,
                "screens": [s.to_public() for s in self.screens],
                "menus": [m.to_public() for m in self.menus],
                "inputs": self.inputs}


# ---------------------------------------------------------------------------
# .ips source parsing
# ---------------------------------------------------------------------------

_RE_SCREEN = re.compile(r"\bSCREEN\s+(\w+)\s*\([^)]*\)\s*\{", re.I)
_RE_TEXT = re.compile(r'\btext\s*\(\s*(\d+)\s*,\s*\d+\s*,\s*"([^"]*)"', re.I)
_RE_JOB = re.compile(
    r'\bINPAapiJob\s*\(\s*\w+\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"', re.I)
#: ergebnisAnalogAusgabe("KEY", col, row, dispMin, dispMax, scaleMin, scaleMax)
_RE_ANALOG_OUT = re.compile(
    r'\bergebnisAnalogAusgabe\s*\(\s*"([^"]+)"\s*,\s*\d+\s*,\s*\d+\s*,'
    r"\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)", re.I)
_RE_DIGITAL_OUT = re.compile(
    r'\bergebnis(?:Digital|Text)Ausgabe\s*\(\s*"([^"]+)"', re.I)
_RE_HEADING = re.compile(r'\bueberschrift2?\s*\(\s*"([^"]*)"', re.I)
#: ftextout("text", row, col, attr, ...) — attr 1 marks a heading, 0 a label.
_RE_FTEXTOUT = re.compile(
    r'\bf?textout\s*\(\s*"([^"]*)"\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d+)', re.I)
_RE_RESULT_READ = re.compile(
    r'\bINPAapiResult(Analog|Int|Digital|Text)\s*\(\s*\w+\s*,\s*"([^"]+)"',
    re.I)
#: Trailing bracketed unit inside a label: "Motortemperatur [°C]" -> "°C".
_RE_UNIT_IN_LABEL = re.compile(r"\[([^\]]*)\]\s*$")
#: F-key menu rows ("< F1 >  Information") are navigation, never row labels.
_RE_FKEY_ROW = re.compile(r"<\s*(?:Shift\s*\+\s*)?F\d+\s*>", re.I)
#: One combined scanner for declarative-dialect events, in source order.
_RE_DECL_EVENT = re.compile(
    r"(?P<title>\bueberschrift2?\s*\([^;]*)|"
    r"(?P<text>\btext\s*\([^;]*)|"
    r"(?P<job>\bINPAapiJob\s*\([^;]*)|"
    r"(?P<analog>\bergebnisAnalogAusgabe\s*\([^;]*)|"
    r"(?P<digital>\bergebnis(?:Digital|Text)Ausgabe\s*\([^;]*)", re.I)
#: One combined scanner for imperative-dialect events, in source order.
_RE_IMP_EVENT = re.compile(
    r'(?P<label>\bf?textout\s*\(\s*"[^"]*"\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+)|'
    r"(?P<read>\bINPAapiResult(?:Analog|Int|Digital|Text)\s*\([^;]*)", re.I)


def _iter_screen_blocks(src: str) -> Iterator[Tuple[str, str]]:
    """Yield ``(procedure_name, body)`` per SCREEN block, brace-matched.

    INPA screens are ``SCREEN s_name() { ... }`` procedures; bodies may nest
    braces (if/while), so we match them properly rather than by regex.
    """
    for m in _RE_SCREEN.finditer(src):
        i, depth = m.end(), 1
        while i < len(src) and depth:
            ch = src[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            i += 1
        yield m.group(1), src[m.end():i - 1]


def _humanize_proc_name(name: str) -> str:
    """Fallback screen title from a procedure name: ``s_status_analog1`` ->
    ``Status analog 1``. Used only when the source provides no heading."""
    text = re.sub(r"^s_", "", name).replace("_", " ").strip()
    text = re.sub(r"(?<=[a-z])(\d+)$", r" \1", text)
    return (text[:1].upper() + text[1:]) if text else name


def _as_number(value: float) -> float:
    """Return ints for whole numbers so JSON reads ``8000``, not ``8000.0``."""
    return int(value) if float(value).is_integer() else value


def _is_two_column(rows: List[Row]) -> bool:
    """BMW banks a second sensor with a ``_2_`` infix (``STAT_INT_2_WERT``);
    such key pairs render as INPA's two-column Bank1/Bank2 layout."""
    return (len(rows) >= 2
            and any(re.search(r"_2_|_2_WERT$", r.key) for r in rows))


def _strip_bracket_unit(label: str) -> Tuple[str, Optional[str]]:
    """Split ``"Motortemperatur [°C]"`` into ``("Motortemperatur", "°C")``.

    A bare ``[-]`` or empty bracket means "no unit" and maps to ``None``.
    """
    m = _RE_UNIT_IN_LABEL.search(label)
    if not m:
        return label, None
    unit = m.group(1).strip()
    stripped = _RE_UNIT_IN_LABEL.sub("", label).strip()
    return stripped, (unit if unit not in ("", "-") else None)


def _parse_ips_declarative(body: str) -> Tuple[List[Row], Optional[str]]:
    """Extract rows from the declarative dialect of one SCREEN body.

    Walks layout calls in source order: ``text(1,..)`` sets the pending row
    label, ``text(2,..)`` the pending unit, ``INPAapiJob`` the current
    job/args, and each ``ergebnis*Ausgabe`` consumes them into a row. Analog
    outputs carry the exact display range in their 4th/5th arguments.

    Returns ``(rows, heading)``; both empty/None when the body contains no
    declarative output calls.
    """
    rows: List[Row] = []
    heading: Optional[str] = None
    pending_label: Optional[str] = None
    pending_unit: Optional[str] = None
    current_job: Optional[str] = None
    current_args: Optional[str] = None

    for event in _RE_DECL_EVENT.finditer(body):
        segment = event.group(0)
        kind = event.lastgroup
        if kind == "title":
            m = _RE_HEADING.search(segment)
            if m and m.group(1).strip():
                heading = m.group(1).strip()
        elif kind == "text":
            m = _RE_TEXT.search(segment)
            if not m:
                continue
            slot, value = m.group(1), m.group(2).strip()
            if slot == "1":
                pending_label = value
            elif slot == "2":
                unit = value.strip("[]").strip()
                pending_unit = unit if unit not in ("", "-") else None
        elif kind == "job":
            m = _RE_JOB.search(segment)
            if m:
                current_job = m.group(1) or None
                current_args = m.group(2) or None
        elif kind == "analog":
            m = _RE_ANALOG_OUT.search(segment)
            if not m:
                continue
            rows.append(Row(
                key=m.group(1),
                label=pending_label or m.group(1),
                unit=pending_unit,
                min=_as_number(float(m.group(2))),
                max=_as_number(float(m.group(3))),
                job=current_job, args=current_args, render="analog"))
            pending_label = pending_unit = None
        elif kind == "digital":
            m = _RE_DIGITAL_OUT.search(segment)
            if not m:
                continue
            rows.append(Row(
                key=m.group(1),
                label=pending_label or m.group(1),
                unit=pending_unit,
                job=current_job, args=current_args, render="text"))
            pending_label = pending_unit = None
    return rows, heading


def _parse_ips_imperative(body: str) -> Tuple[List[Row], Optional[str]]:
    """Extract rows from the imperative dialect of one SCREEN body.

    Labels (``ftextout`` attr 0) and value reads (``INPAapiResultAnalog`` /
    ``Int``) interleave in source order; each read consumes the nearest
    preceding label. ``ftextout`` attr 1 is the screen heading. Text/Digital
    reads feed ident/menu screens (part numbers, enum text), not gauges, and
    reset the pending label instead of producing a row. Ranges do not exist
    in this dialect.
    """
    rows: List[Row] = []
    heading: Optional[str] = None
    pending_label: Optional[str] = None

    for event in _RE_IMP_EVENT.finditer(body):
        if event.lastgroup == "label":
            m = _RE_FTEXTOUT.search(event.group(0))
            if not m:
                continue
            text, attr = m.group(1).strip(), m.group(2)
            if (not re.search(r"[A-Za-zÄÖÜäöü]", text)
                    or _RE_FKEY_ROW.search(text)):
                continue  # separators, blanks, F-key menu rows
            if attr == "1":
                if heading is None:
                    heading = text
            else:
                pending_label = text
        else:
            m = _RE_RESULT_READ.search(event.group(0))
            if not m:
                continue
            kind, key = m.group(1).lower(), m.group(2)
            if kind not in ("analog", "int"):
                pending_label = None  # ident/enum read; label was not a gauge
                continue
            label, unit = _strip_bracket_unit(pending_label or key)
            rows.append(Row(key=key, label=label, unit=unit, render="analog"))
            pending_label = None
    return rows, heading


def _split_by_job(rows: List[Row], base_group: str, method: str,
                  proc: Optional[str] = None) -> List[Screen]:
    """Split a screen's rows into one Screen per consecutive (job, args) run.

    Consumers poll one job per screen, but INPA sources freely interleave jobs
    (``s_ueberdrehzahl`` polls three). Consecutive rows sharing (job, args)
    stay together; when a split produces single-row screens, the row label is
    the better title.
    """
    groups: List[Tuple[Optional[str], Optional[str], List[Row]]] = []
    for row in rows:
        if groups and (groups[-1][0], groups[-1][1]) == (row.job, row.args):
            groups[-1][2].append(row)
        else:
            groups.append((row.job, row.args, [row]))

    screens: List[Screen] = []
    for job, args, group_rows in groups:
        if len(groups) > 1 and len(group_rows) == 1 and group_rows[0].label:
            title: Optional[str] = group_rows[0].label
        else:
            title = base_group
        screens.append(Screen(
            group=title, job=job, args=args or None,
            render=("analog" if any(r.render == "analog" for r in group_rows)
                    else "text"),
            columns=2 if _is_two_column(group_rows) else 1,
            method=method, proc=proc, rows=group_rows))
    return screens


# --- MENU blocks -----------------------------------------------------------
#: ``MENU m_status()`` opens a declarative menu block.
_RE_MENU = re.compile(r"\bMENU\s+(\w+)\s*\([^)]*\)\s*\{", re.I)
#: ``ITEM( 1 ,"Analog")`` opens one numbered menu entry (body follows).
_RE_MENU_ITEM = re.compile(r'\bITEM\s*\(\s*(\d+)\s*,\s*"([^"]*)"\s*\)\s*\{',
                           re.I)
_RE_MENU_TITLE = re.compile(r'\bsetmenutitle\s*\(\s*"([^"]*)"', re.I)
#: ``setitem(4, "Fehler", TRUE)`` (re)labels an item dynamically in INIT.
_RE_SET_ITEM = re.compile(r'\bsetitem\s*\(\s*(\d+)\s*,\s*"([^"]*)"', re.I)
_RE_SET_SCREEN = re.compile(r"\bsetscreen\s*\(\s*(\w+)", re.I)
_RE_SET_MENU = re.compile(r"\bsetmenu\s*\(\s*(\w+)", re.I)


def _match_braces(src: str, open_pos: int) -> int:
    """Given the index just past an opening ``{``, return the index of its
    matching ``}`` (exclusive body end)."""
    depth, i = 1, open_pos
    while i < len(src) and depth:
        ch = src[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        i += 1
    return i - 1


def _parse_menu(name: str, body: str) -> Menu:
    """Parse one MENU body into a :class:`Menu`.

    ``ITEM(n,"label"){...}`` declares an entry; its body's ``setscreen`` /
    ``setmenu`` calls give the navigation targets. ``setitem(n,"label")``
    inside INIT relabels entries at runtime (conditionally); the first such
    label wins when the ITEM literal is empty. Items with neither a label
    nor a target are dead placeholders and are dropped.
    """
    title_match = _RE_MENU_TITLE.search(body)
    title = title_match.group(1).strip() if title_match else None

    dynamic_labels: Dict[int, str] = {}
    for m in _RE_SET_ITEM.finditer(body):
        key, label = int(m.group(1)), m.group(2).strip()
        if label and key not in dynamic_labels:
            dynamic_labels[key] = label

    items: List[MenuItem] = []
    for m in _RE_MENU_ITEM.finditer(body):
        key, literal = int(m.group(1)), m.group(2).strip()
        item_body = body[m.end():_match_braces(body, m.end())]
        screen_m = _RE_SET_SCREEN.search(item_body)
        submenu_m = _RE_SET_MENU.search(item_body)
        label = literal or dynamic_labels.get(key)
        item = MenuItem(key=key, label=label,
                        screen=screen_m.group(1) if screen_m else None,
                        submenu=submenu_m.group(1) if submenu_m else None)
        if item.label or item.screen or item.submenu:
            items.append(item)
    return Menu(name=name, title=title, items=items)


def _parse_ips_menus(src: str) -> List[Menu]:
    """Extract every MENU block from an .ips source, in file order."""
    menus: List[Menu] = []
    for m in _RE_MENU.finditer(src):
        body = src[m.end():_match_braces(src, m.end())]
        menu = _parse_menu(m.group(1), body)
        if menu.items:
            menus.append(menu)
    return menus


def parse_ips(path: Path) -> Document:
    """Parse an INPA ``.ips`` source file into a :class:`Document`.

    Screens: tries the declarative dialect per SCREEN first (richer: exact
    ranges) and falls back to the imperative dialect. Rows that cannot be
    tied to any EDIABAS job are ident/menu artifacts and are dropped.
    Menus: every ``MENU``/``ITEM`` block, with items linked to their target
    screens (``Screen.proc``) and submenus.
    """
    src = path.read_bytes().decode(IPS_ENCODING)
    doc = Document(source=path.name, format="ips")
    doc.menus = _parse_ips_menus(src)

    for proc_name, body in _iter_screen_blocks(src):
        rows, heading = _parse_ips_declarative(body)
        method = "ips-declarative"
        if not rows:
            rows, heading = _parse_ips_imperative(body)
            method = "ips-imperative"
        if not rows:
            continue

        # Screen-level job: rows that already carry one (declarative) win;
        # otherwise the body's single INPAapiJob applies (imperative).
        named_jobs = [(j, a) for j, a in _RE_JOB.findall(body) if j]
        if len({j for j, _ in named_jobs}) == 1:
            body_job, body_args = named_jobs[0][0], named_jobs[0][1] or None
        else:
            body_job = body_args = None
        for row in rows:
            if not row.job:
                row.job, row.args = body_job, body_args

        # A real gauge screen always knows its polling job; jobless rows come
        # from ident/menu screens mixing several jobs (addresses, AIF reads).
        rows = [r for r in rows if r.job]
        if not rows:
            continue

        base_group = heading or _humanize_proc_name(proc_name)
        doc.screens.extend(_split_by_job(rows, base_group, method,
                                         proc=proc_name))
    return doc


# ---------------------------------------------------------------------------
# .IPO compiled-blob scraping
# ---------------------------------------------------------------------------

_RE_IPO_JOB = re.compile(
    r"^(MESSWERTBLOCK_LESEN|MESSWERTE_LESEN|STATUS_LESEN|STATUS_[A-Z0-9_]+|"
    r"MW_[A-Z0-9_]+|MESSWERT[A-Z0-9_]*|LESE_[A-Z0-9_]+|[A-Z0-9_]*_LESEN)$")
_RE_IPO_KEYS = re.compile(r"^[A-Z0-9_]+_WERT(;[A-Z0-9_]+_WERT)*$")
_RE_IPO_HEXARGS = re.compile(r"^(0x[0-9A-Fa-f]+)(,0x[0-9A-Fa-f]+)*$")
_RE_IPO_UNIT = re.compile(
    r"^\s*-?\d*\s*(%|mg/stk|mg/hub|V|A|°C|°KW|°|1/min|rpm|U/min|km/h|mbar|"
    r"hpa|bar|Nm|ms|l/h|ohm|g/s|kPa)\s*$", re.I)
_RE_IPO_INPUT = re.compile(
    r"(parameter input|input Coding|input clima|Eingabe|eingeben|geben sie|"
    r"request telegram|abfrage\b)", re.I)
_RE_PRINTABLE_RUN = re.compile(rb"[\x20-\x7e]{3,}")


def _ipo_strings(path: Path) -> List[str]:
    """Printable-ASCII runs (>= 3 chars) from a compiled ``.IPO``, in file
    order — equivalent to ``strings -n 3`` but dependency-free. Umlauts are
    mangled by compilation and cannot be recovered here."""
    data = path.read_bytes()
    return [run.decode("latin-1").rstrip()
            for run in _RE_PRINTABLE_RUN.findall(data)]


def _looks_like_label_list(line: str) -> bool:
    """Heuristic: does this strings-table line hold display labels (comma
    separated German text) rather than code tokens or key lists?"""
    if ";" in line or "_WERT" in line:
        return False
    if not ("," in line or len(line.split()) >= 2):
        return False
    if not re.search(r"[A-Za-zÄÖÜäöü]{3,}", line):
        return False
    if re.match(r"^[a-z_]+$", line) and "," not in line:
        return False
    return True


def parse_ipo(path: Path) -> Document:
    """Scrape screen layouts from a compiled ``.IPO`` into a :class:`Document`.

    Everything here is heuristic (``method: ipo-strings``): the compiler kept
    display strings but discarded structure, so label↔key pairing relies on
    the observed convention that a comma-separated label list immediately
    precedes its semicolon-separated result-key list in the strings table.
    """
    lines = _ipo_strings(path)
    doc = Document(source=path.name, format="ipo")
    last_job: Optional[str] = None
    last_args: Optional[str] = None
    seen: set = set()

    for i, line in enumerate(lines):
        if _RE_IPO_JOB.match(line):
            last_job, last_args = line, None
            continue
        if _RE_IPO_HEXARGS.match(line) and last_job and last_args is None:
            last_args = line
            continue
        if _RE_IPO_INPUT.search(line):
            doc.inputs.append({"job": last_job,
                               "prompt": re.sub(r"\s+", " ", line).strip()})
            continue
        if not _RE_IPO_KEYS.match(line):
            continue

        keys = line.split(";")
        previous = lines[i - 1] if i > 0 else ""
        labels = ([re.sub(r"\s+", " ", part).strip()
                   for part in previous.split(",")]
                  if _looks_like_label_list(previous) else [])
        window = " ".join(lines[max(0, i - 6):i + 4])
        units = _RE_IPO_UNIT.findall(" ".join(lines[max(0, i - 3):i + 3]))

        signature = (last_job, tuple(keys))
        if signature in seen:  # the strings table repeats screens
            continue
        seen.add(signature)

        rows = [Row(key=key,
                    label=labels[n] if n < len(labels) else None,
                    unit=units[n] if n < len(units) else None)
                for n, key in enumerate(keys)]
        doc.screens.append(Screen(
            group=labels[0] if labels else None,
            job=last_job, args=last_args,
            render="analog" if "ergebnisAnalog" in window else "text",
            columns=2 if _is_two_column(rows) else 1,
            method="ipo-strings", rows=rows))
    return doc


# ---------------------------------------------------------------------------
# Format detection and conversion
# ---------------------------------------------------------------------------


def detect_format(path: Path) -> str:
    """Return ``"ips"`` or ``"ipo"`` for *path*, by extension, else by a
    printable-text sniff of the first 4 KiB (source files are >90% text)."""
    suffix = path.suffix.lower()
    if suffix == ".ips":
        return "ips"
    if suffix == ".ipo":
        return "ipo"
    head = path.read_bytes()[:4096]
    if not head:
        return "ips"
    printable = sum(32 <= b < 127 or b in (9, 10, 13) for b in head)
    return "ips" if printable / len(head) > 0.9 else "ipo"


def convert(path: Path) -> Document:
    """Convert one ``.ips``/``.IPO`` file; format is auto-detected."""
    if detect_format(path) == "ips":
        return parse_ips(path)
    return parse_ipo(path)


# ---------------------------------------------------------------------------
# Output JSON Schema (draft 2020-12)
# ---------------------------------------------------------------------------

SCHEMA: Dict[str, object] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "inpa2json output",
    "type": "object",
    "required": ["source", "format", "parser", "screens", "menus", "inputs"],
    "properties": {
        "source": {"type": "string"},
        "format": {"enum": ["ips", "ipo"]},
        "parser": {"type": "string"},
        "screens": {"type": "array", "items": {
            "type": "object",
            "required": ["proc", "group", "job", "args", "render", "columns",
                         "method", "rows"],
            "properties": {
                "proc": {"type": ["string", "null"],
                         "description": "SCREEN procedure name; menu items "
                                        "reference screens by this"},
                "group": {"type": ["string", "null"]},
                "job": {"type": ["string", "null"]},
                "args": {"type": ["string", "null"]},
                "render": {"enum": ["analog", "text"]},
                "columns": {"enum": [1, 2]},
                "method": {"enum": ["ips-declarative", "ips-imperative",
                                    "ipo-strings"]},
                "rows": {"type": "array", "items": {
                    "type": "object",
                    "required": ["key", "label", "unit"],
                    "properties": {
                        "key": {"type": "string"},
                        "label": {"type": ["string", "null"]},
                        "unit": {"type": ["string", "null"]},
                        "min": {"type": "number"},
                        "max": {"type": "number"},
                    }}}}}},
        "menus": {"type": "array", "items": {
            "type": "object",
            "required": ["name", "title", "items"],
            "properties": {
                "name": {"type": "string",
                         "description": "MENU procedure name; a menu no "
                                        "item references is a root"},
                "title": {"type": ["string", "null"]},
                "items": {"type": "array", "items": {
                    "type": "object",
                    "required": ["key", "label", "screen", "submenu"],
                    "properties": {
                        "key": {"type": "integer"},
                        "label": {"type": ["string", "null"]},
                        "screen": {"type": ["string", "null"],
                                   "description": "target screens[].proc"},
                        "submenu": {"type": ["string", "null"],
                                    "description": "target menus[].name"},
                    }}}}}},
        "inputs": {"type": "array", "items": {
            "type": "object",
            "required": ["job", "prompt"],
            "properties": {"job": {"type": ["string", "null"]},
                           "prompt": {"type": "string"}}}},
    },
}


# ---------------------------------------------------------------------------
# Embedded self-test
# ---------------------------------------------------------------------------

_FIXTURE_DECLARATIVE = """\
SCREEN s_test()
{
    ueberschrift("Testwerte");
    text(1,0,"max Überdrehzahl");
    text(2,0,"[1/min]");
    INPAapiJob(sgbd,"STATUS_MAX","","");
    ergebnisAnalogAusgabe("STAT_MAX_WERT", 3,0, 0.0, 10240.0, 0.0, 10240.0);
    text(1,0,"Zähler");
    text(2,0,"[-]");
    INPAapiJob(sgbd,"STATUS_ZAEHLER","","");
    ergebnisAnalogAusgabe("STAT_ZAEHLER_WERT", 3,0, 0.0, 255, 0.0, 255);
}
"""

_FIXTURE_IMPERATIVE = """\
SCREEN s_status()
{
    ftextout("Status Analogwerte lesen",1,0,1,0);
    INPAapiJob(sgbd,"STATUS_LESEN","","");
    ftextout("Motortemperatur [°C]",1,0,0,1);
    INPAapiResultAnalog(real_zahl,"STAT_MOTORTEMPERATUR_WERT",1);
    ftextout("Batteriespannung [V]",6,0,0,1);
    INPAapiResultAnalog(real_zahl,"STAT_UBAT_WERT",1);
    ftextout("< F1 >  Menü",20,0,0,1);
}

MENU m_status()
{
    INIT {
        setmenutitle("Status lesen");
        setitem(2, "Digital", TRUE);
    }
    ITEM( 1 ,"Analog")  {
        setscreen( s_status ,TRUE);
        setmenu(m_status_analog);
    }
    ITEM( 2 ,"")  {
        setscreen( s_status_digital ,TRUE);
    }
    ITEM( 9 ,"")  {
    }
}
"""


def _selftest() -> int:
    """Regression-test both dialect parsers against embedded fixtures."""
    import tempfile

    failures: List[str] = []

    def check(cond: bool, message: str) -> None:
        if not cond:
            failures.append(message)

    with tempfile.TemporaryDirectory() as tmp:
        decl = Path(tmp) / "decl.ips"
        decl.write_text(_FIXTURE_DECLARATIVE, encoding=IPS_ENCODING)
        doc = parse_ips(decl)
        check(len(doc.screens) == 2,
              f"declarative: expected 2 screens (job split), got "
              f"{len(doc.screens)}")
        s0 = doc.screens[0]
        check(s0.method == "ips-declarative", "declarative: wrong method")
        check(s0.job == "STATUS_MAX", f"declarative: job {s0.job!r}")
        check(s0.group == "max Überdrehzahl",
              f"declarative: split title {s0.group!r}")
        r0 = s0.rows[0]
        check((r0.key, r0.unit, r0.min, r0.max)
              == ("STAT_MAX_WERT", "1/min", 0, 10240),
              f"declarative: row {r0!r}")
        check(doc.screens[1].rows[0].unit is None,
              "declarative: '[-]' should map to no unit")

        imp = Path(tmp) / "imp.ips"
        imp.write_text(_FIXTURE_IMPERATIVE, encoding=IPS_ENCODING)
        doc = parse_ips(imp)
        check(len(doc.screens) == 1,
              f"imperative: expected 1 screen, got {len(doc.screens)}")
        s0 = doc.screens[0]
        check(s0.method == "ips-imperative", "imperative: wrong method")
        check(s0.group == "Status Analogwerte lesen",
              f"imperative: heading {s0.group!r}")
        check(s0.job == "STATUS_LESEN", f"imperative: job {s0.job!r}")
        check(len(s0.rows) == 2,
              f"imperative: expected 2 rows, got {len(s0.rows)}")
        check((s0.rows[0].label, s0.rows[0].unit)
              == ("Motortemperatur", "°C"),
              f"imperative: row0 {s0.rows[0]!r}")
        check(s0.rows[0].min is None,
              "imperative: must not fabricate ranges")
        check(s0.proc == "s_status", f"imperative: proc {s0.proc!r}")

        # menu extraction from the same imperative fixture
        check(len(doc.menus) == 1,
              f"menus: expected 1 menu, got {len(doc.menus)}")
        menu = doc.menus[0]
        check((menu.name, menu.title) == ("m_status", "Status lesen"),
              f"menus: header {(menu.name, menu.title)!r}")
        check(len(menu.items) == 2,
              f"menus: dead ITEM(9) must be dropped, got {len(menu.items)}")
        check((menu.items[0].key, menu.items[0].label,
               menu.items[0].screen, menu.items[0].submenu)
              == (1, "Analog", "s_status", "m_status_analog"),
              f"menus: item1 {menu.items[0]!r}")
        check((menu.items[1].label, menu.items[1].screen)
              == ("Digital", "s_status_digital"),
              "menus: setitem() label must fill empty ITEM literal")

        # .IPO scrape: synthesize a strings table inside binary padding.
        ipo = Path(tmp) / "test.IPO"
        ipo.write_bytes(b"\x00\x01" + b"STATUS_LESEN\x00"
                        b"Temperatur Bank1, Temperatur Bank2\x00"
                        b"STAT_T_WERT;STAT_T_2_WERT\x00" + b"\x02\x03")
        doc = parse_ipo(ipo)
        check(len(doc.screens) == 1,
              f"ipo: expected 1 screen, got {len(doc.screens)}")
        s0 = doc.screens[0]
        check(s0.method == "ipo-strings", "ipo: wrong method")
        check(s0.job == "STATUS_LESEN", f"ipo: job {s0.job!r}")
        check(s0.columns == 2, "ipo: _2_ keys should mark two columns")
        check([r.key for r in s0.rows] == ["STAT_T_WERT", "STAT_T_2_WERT"],
              f"ipo: keys {[r.key for r in s0.rows]!r}")

        # detection sniff without extension
        anon = Path(tmp) / "noext"
        anon.write_text(_FIXTURE_DECLARATIVE, encoding=IPS_ENCODING)
        check(detect_format(anon) == "ips", "detect: text sniff failed")

    if failures:
        for f in failures:
            print("FAIL:", f, file=sys.stderr)
        return 1
    print(f"selftest OK ({PARSER_ID})")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _collect_inputs(arguments: List[str]) -> List[Path]:
    """Expand file/directory arguments into a flat list of convertible files.

    Directories contribute every ``.ips``/``.ipo`` directly inside them
    (sorted, non-recursive — INPA keeps them flat in SGDAT).
    """
    files: List[Path] = []
    for arg in arguments:
        path = Path(arg)
        if path.is_dir():
            files.extend(sorted(
                p for p in path.iterdir()
                if p.suffix.lower() in (".ips", ".ipo")))
        else:
            files.append(path)
    return files


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="inpa2json",
        description="Convert BMW INPA .ips/.IPO screen definitions to "
                    "portable JSON (stdlib-only, deterministic).",
        epilog="Run with --schema for the machine-readable output schema.")
    parser.add_argument("paths", nargs="*", metavar="FILE_OR_DIR",
                        help=".ips/.IPO files, or directories containing "
                             "them (non-recursive)")
    parser.add_argument("-o", "--output-dir", metavar="DIR", type=Path,
                        help="write one <base>.json per input into DIR "
                             "instead of stdout")
    parser.add_argument("--pretty", action="store_true",
                        help="indent JSON output")
    parser.add_argument("--schema", action="store_true",
                        help="print the output JSON Schema and exit")
    parser.add_argument("--selftest", action="store_true",
                        help="run embedded regression tests and exit")
    parser.add_argument("--version", action="version", version=PARSER_ID)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_arg_parser().parse_args(argv)

    if args.schema:
        print(json.dumps(SCHEMA, indent=2))
        return 0
    if args.selftest:
        return _selftest()
    if not args.paths:
        print("error: no input files (see --help)", file=sys.stderr)
        return 2

    files = _collect_inputs(args.paths)
    if not files:
        print("error: no .ips/.ipo files found in the given paths",
              file=sys.stderr)
        return 1

    indent = 1 if args.pretty else None
    documents: List[Document] = []
    errors = 0
    for path in files:
        try:
            documents.append(convert(path))
        except OSError as exc:
            print(f"error: {path}: {exc}", file=sys.stderr)
            errors += 1
        except Exception as exc:  # parse bug — report file, keep going
            print(f"error: {path}: {type(exc).__name__}: {exc}",
                  file=sys.stderr)
            errors += 1

    if args.output_dir:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        # An .ips and an .IPO can share a stem (dkg_90.ips / DKG_90.IPO);
        # disambiguate those as <stem>.<format>.json so neither is lost.
        stem_counts: Dict[str, int] = {}
        for doc in documents:
            stem = Path(doc.source).stem.lower()
            stem_counts[stem] = stem_counts.get(stem, 0) + 1
        for doc in documents:
            stem = Path(doc.source).stem.lower()
            name = (f"{stem}.{doc.format}.json" if stem_counts[stem] > 1
                    else f"{stem}.json")
            dst = args.output_dir / name
            dst.write_text(
                json.dumps(doc.to_public(), ensure_ascii=False,
                           indent=indent) + "\n",
                encoding="utf-8")
            print(f"wrote {dst} ({len(doc.screens)} screens)")
    elif documents:
        payload = (documents[0].to_public() if len(documents) == 1
                   else [d.to_public() for d in documents])
        print(json.dumps(payload, ensure_ascii=False, indent=indent))

    if errors:
        return 1 if not documents else 0  # partial success still exits 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
