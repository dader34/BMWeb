#!/usr/bin/env python3
"""Decode INPA's character-grid screen layout from .IPO bytecode.

INPA draws on a fixed character grid, which is why its screens have that rigid,
always-in-the-same-place look. The .IPO is not machine code -- it is a stack
bytecode, and the layout is recoverable from it:

    06 <string> 0a      push string
    03 <n> 00           push int
    05 <8 bytes>        push double (IEEE-754, LITTLE-endian)

A call is implied by how many arguments follow the string, so the three draw
forms are told apart by ARITY -- reading a fixed operand index instead is what
makes a decode look almost-right and scramble every other screen:

    ftextout(text, row, col, attr, attr)        4 ints
    result  (KEY,  fmt, row, col, attr, attr)   5 ints
    analog  (KEY,  fmt, row, col) + 4 doubles   3 ints, then 0x05 runs

The doubles on the analog form are the gauge scale: VANOS intake decodes as
60.0/155.0 and exhaust as 135.0/40.0 -- independently matching the ranges the
SGBD's own _RESULTS descriptions state.

One wrinkle: a result's row is not always absolute. VANOS uses real rows (23,
26), while the throttle/idle screen emits four values all claiming row 1, where
it means "advance a row" (see resolve_rows). Ground truth for the whole model is
MS45's "LL - Drehzahl verstellen", whose real INPA appearance is known: title
row 5, labels "LL - Istwert"/"LL - Sollwert" at row 10 cols 10/40, values at
row 12 -- which this reproduces exactly.

    python3 tools/ipo_grid.py MS450.IPO                    # list screens
    python3 tools/ipo_grid.py MS450.IPO "LL - Drehzahl"    # one screen's grid
    python3 tools/ipo_grid.py MS450.IPO --json
"""
import os
import re
import sys
import json
import struct

SGDAT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "..", "vendor", "EC-APPS", "INPA", "SGDAT")

_RESULT = re.compile(r"^(STAT_|STATUS_|JOB_|STOP_|_TEL)")
# INPA's own footer hints and separator rules are drawn like any other text but
# are chrome, not a screen heading — starting a screen on one swallows the real
# title that follows
_CHROME = re.compile(r"Shift\s*>|INPA beenden|^[=\-_]{4,}$|^\s*<\s*F\d+\s*>")
# EDIABAS plumbing that is never drawn on screen
_PLUMBING = {"JOB_STATUS", "OKAY", "ERROR"}
# the ECU's internal variable names ride alongside the captions ("MFF_AD_ADD_MMV_2",
# "LSHPWM_UP_1;LSHPWM_UP_2"). INPA does not print them, so neither do we.
_VARNAME = re.compile(r"^[A-Z][A-Z0-9_]{3,}(;[A-Z][A-Z0-9_]+)*$")
MAX_ROW, MAX_COL = 40, 100
# a screen's draw calls sit within this many bytes of its heading; beyond that
# the stream has moved on to other code
SCREEN_SPAN = 900


# The .IPO is a stack bytecode: a string is pushed, then its arguments, and the
# call is implied by how many arguments follow. Two draw calls matter, and they
# differ in ARITY — which is the whole reason fixed-index reads kept failing:
#
#   ftextout(text, row, col, attr, attr)          4 args
#   result  (KEY, fmt, row, col, attr, attr)      5 args  (leading format field)
#
# Verified on "MS45 LL - Drehzahl verstellen": title row 5 col 10, the labels at
# row 10 cols 10/40, and their values at row 12 cols 0/45 — matching INPA.
_PUSH = rb"\x03([\x00-\xff])\x00"
_RE_TEXT = re.compile(rb"\x06([\x20-\x7e\xa0-\xff]{1,60})\x0a" + _PUSH * 4
                      + rb"(?!\x03)", re.DOTALL)
_RE_KEY = re.compile(rb"\x06([A-Z_][A-Z0-9_]{2,50})\x0a")
_OP_STR, _OP_DOUBLE, _OP_PUSH = 0x06, 0x05, 0x03


def _args_at(data, k):
    """The 03-push run starting at k -> ([ints], offset after them)."""
    out = []
    while k + 2 < len(data) and data[k] == _OP_PUSH and data[k + 2] == 0x00:
        out.append(data[k + 1])
        k += 3
    return out, k


def _doubles_at(data, k):
    """The 05-push run starting at k -> ([floats], offset after them).

    0x05 pushes an 8-byte IEEE-754 double, LITTLE-endian. These carry the gauge
    scale: VANOS intake reads 60.0/155.0, exhaust 135.0/40.0 — the same ranges
    the SGBD's own _RESULTS descriptions state.
    """
    out = []
    while k + 8 < len(data) and data[k] == _OP_DOUBLE:
        out.append(struct.unpack("<d", data[k + 1:k + 9])[0])
        k += 9
    return out, k


def draw_calls(data, start=0, end=None):
    """Every positioned draw: (offset, kind, name, row, col, scale).

    Three call shapes, distinguished by what follows the pushed string:

      ftextout(text, row, col, attr, attr)          4 int args
      result  (KEY,  fmt, row, col, attr, attr)     5 int args
      analog  (KEY,  fmt, row, col) + 4 doubles     3 int args, then 0x05 runs

    The analog form is the common one (175 calls) and is why a fixed-arity read
    found only 10 results: most values are gauges, not plain text-outs.
    """
    seg = data[start:end if end is not None else len(data)]
    out = []
    for m in _RE_TEXT.finditer(seg):
        out.append((start + m.start(), "text",
                    m.group(1).decode("latin-1", "replace"),
                    m.group(2)[0], m.group(3)[0], None))
    for m in _RE_KEY.finditer(seg):
        args, k = _args_at(seg, m.end())
        scale, _ = _doubles_at(seg, k)
        if len(args) >= 5:                       # result(fmt, row, col, ...)
            row, col = args[1], args[2]
        elif len(args) == 3 and scale:           # analog(fmt, row, col) + range
            row, col = args[1], args[2]
        else:
            continue
        out.append((start + m.start(), "result",
                    m.group(1).decode("latin-1", "replace"), row, col,
                    (min(scale), max(scale)) if scale else None))
    out.sort()
    return out


def screens(data):
    """Screens as {title, offset, elements}, split where a heading restarts.

    A screen begins at a heading (a text draw near the top of the grid) and runs
    until the next one. No cursor emulation is needed: every drawn element
    carries its own row/col once the two call arities are read correctly.
    """
    calls = draw_calls(data)
    marks = [n for n, (_o, kind, name, row, col, _s) in enumerate(calls)
             if kind == "text" and 1 <= row <= 6 and col <= MAX_COL
             and re.search(r"[A-Za-z]{3}", name) and not _CHROME.search(name)
             and not _RESULT.match(name)]
    found = []
    for idx, n in enumerate(marks):
        stop = marks[idx + 1] if idx + 1 < len(marks) else len(calls)
        # a screen's draws sit together in the stream; running all the way to
        # the next heading swallows unrelated code between them, which is what
        # collapses 13 screens onto each other's rows
        base = calls[n][0]
        els = []
        for _o, kind, name, row, col, scale in calls[n:stop]:
            if _o - base > SCREEN_SPAN:
                break
            # _VARNAME only strips CAPTIONS that are really internal variable
            # names; a result's key is supposed to look like one
            if not name.strip() or name in _PLUMBING:
                continue
            if kind == "text" and _VARNAME.match(name.strip()):
                continue
            if row > MAX_ROW or col > MAX_COL:
                continue
            el = {"kind": kind, ("key" if kind == "result" else "text"):
                  name.strip(), "row": row, "col": col}
            if scale:
                el["min"], el["max"] = scale
            els.append(el)

        # a caption back at the top of the grid is the next screen redrawing, so
        # cut there — the byte cap alone still lets a neighbour bleed in
        trimmed, last = [], -1
        for e in els:
            if trimmed and e["kind"] == "text" and e["row"] <= 6 and e["row"] < last:
                break
            trimmed.append(e)
            last = e["row"]

        resolve_rows(trimmed)
        if any(e["kind"] == "result" for e in trimmed):
            found.append({"title": calls[n][2].strip(),
                          "offset": calls[n][0], "elements": trimmed})
    return found


def resolve_rows(els):
    """Turn a result's relative row advance into an absolute grid row, in place.

    A result's row field is not always absolute. VANOS uses real rows (23, 26),
    but the throttle/idle screen emits four values all claiming row 1 — there it
    means "advance one row", and INPA steps down each time the left column comes
    round again. Reading it as absolute stacks the whole screen on one line.

    So: a row that is <= the caption's row is treated as an advance from the
    current cursor; anything larger is taken at face value.
    """
    cursor = 0
    seen_cols = set()
    for e in els:
        if e["kind"] == "text":
            cursor = e["row"]
            seen_cols.clear()
            continue
        if e["row"] > cursor:                 # a real, absolute row
            cursor = e["row"]
            seen_cols = {e["col"]}
            continue
        # relative: the first value drops below its caption, and revisiting a
        # column means the next line has started
        if not seen_cols or e["col"] in seen_cols:
            seen_cols.clear()
            cursor += e["row"] or 1
        seen_cols.add(e["col"])
        e["row"] = cursor


def render(scr, width=78):
    """ASCII preview of one screen's grid, as INPA would lay it out.

    A result with no coordinate flows after the caption it belongs to, which is
    how INPA draws it -- the caption is the anchor.
    """
    rows = {}
    for e in scr["elements"]:
        rows.setdefault(e["row"], []).append(e)
    lines = []
    for r in sorted(rows):
        line = [" "] * width
        for e in sorted(rows[r], key=lambda x: x["col"]):
            s = e.get("text") or f"<{e['key']}>"
            c = min(e["col"], width - 1)
            for n, ch in enumerate(s[:width - c]):
                line[c + n] = ch
        lines.append(f"{r:3} |{''.join(line).rstrip()}")
    return "\n".join(lines)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    name = args[0] if args else "MS450.IPO"
    path = name if os.path.exists(name) else os.path.join(SGDAT, name)
    with open(path, "rb") as f:
        data = f.read()
    found = screens(data)

    if "--json" in sys.argv:
        json.dump(found, sys.stdout, ensure_ascii=False, indent=1)
        return 0

    want = args[1] if len(args) > 1 else None
    if want:
        for scr in found:
            if want.lower() in scr["title"].lower():
                print(f"=== {scr['title']} @0x{scr['offset']:06x} ===")
                print(render(scr))
                print()
        return 0

    print(f"{len(found)} screens with a decoded grid in {os.path.basename(path)}\n")
    for scr in found:
        res = sum(1 for e in scr["elements"] if e["kind"] == "result")
        print(f"  @0x{scr['offset']:06x} {scr['title'][:44]:46} "
              f"{len(scr['elements']):3} elements ({res} live)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
