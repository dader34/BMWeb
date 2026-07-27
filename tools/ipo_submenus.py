#!/usr/bin/env python3
"""Mine INPA's nested submenus — the levels under a root key, not a flat list.

Our Activations screen listed the SGBD's 14 STEUERN_* jobs. INPA's Activate
screen for the same ECU is a MENU, and the jobs sit two levels down:

    Activate
      F1 Displaytest       -> Testpattern 1..4
      F2 Stepping motor    -> Init / Repair position / Fresh air flap /
                              Air circulation / Defroster / Ventilation /
                              Footwell / Stratification / Rear compartment
      F3 Digital output    -> Washer jet heating / Rear window defogger /
                              Auxiliary water pump / Park heating /
                              A/C compressor / DME-AC Signal / DME-KO Signal
      F4 Water valve
      F5 Blower
      F6 Cancel compressor deactivation

A screen is a TITLE string followed by its softkey help ("< F1 >  Displaytest"),
so a menu level is recoverable wherever INPA declares one -- this reads them for
any root key, not just Activate.

Levels are linked by caption: a level titled "Stepping motor" is the child of
the entry captioned "Stepping motor" one level up. That is INPA's own naming,
so the tree is its structure rather than an arrangement we invented.

An ECU ships several variants of a screen (IHKA38 / IHKA39 / IHKA46 ...) and
the richest sighting wins, since a variant this car does not have contributes
nothing but a shorter list.

Read-only: decodes an .IPO, never talks to a car.

    python3 tools/ipo_submenus.py               # corpus summary
    python3 tools/ipo_submenus.py KLIMA_5B      # one ECU
    python3 tools/ipo_submenus.py --write       # data/inpa-screens/_submenus.json
"""
import os
import re
import sys
import json
import glob
import collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_screens as L1                                        # noqa: E402

OUT = L1.OUT

# "< F5 >  Blower" / "<Shift> + < F10>  Exit"
_FKEY = re.compile(rb"\x06(?:<\s*(Shift)\s*>\s*\+\s*)?<\s*F(\d+)\s*>\s+"
                   rb"([\x20-\x7e\xa0-\xff]{2,40})\x0a")
# a plain string that can serve as a screen title
_TITLE = re.compile(rb"\x06([\x20-\x7e\xa0-\xff]{2,40})\x0a")

# INPA's own UI, never an ECU function
_CHROME = re.compile(r"^(Select|Deselect|Print(\s*screen)?|End|Ende|Exit|Back|"
                     r"Zur(ü|ue)ck|Auswahl|Abwahl|Bildschirmdruck|Drucken|"
                     r"Change\s+Editor|Abbruch|Cancel)$", re.I)

# how far back from a softkey block its title may sit
_LOOKBACK = 420


def _title_before(data, pos):
    """The last plain caption before a softkey block — INPA's screen title."""
    best = None
    for m in _TITLE.finditer(data, max(0, pos - _LOOKBACK), pos):
        s = m.group(1).decode("latin-1").strip()
        if not s or _CHROME.match(s):
            continue
        # skip the softkey help lines themselves and bare identifiers
        if s.startswith("<") or re.fullmatch(r"[A-Z][A-Z0-9_]{2,}", s):
            continue
        best = s
    return best


def menus(data):
    """Every softkey level in the file: {title: [{fkey,label}]}."""
    out = {}
    i = 0
    while True:
        m = _FKEY.search(data, i)
        if not m:
            break
        # walk the contiguous run of softkey lines that starts here
        # One block runs while the F-numbers ASCEND and the lines stay close.
        # A number going backwards is the next screen's help starting, not a
        # continuation -- without that check two adjacent menus merge into one.
        items, seen, end, last = [], set(), m.start(), 0
        for k in _FKEY.finditer(data, m.start(), m.start() + 900):
            if k.start() > end + 120:       # a gap means a different block
                break
            shift = k.group(1)
            num = int(k.group(2))
            cap = k.group(3).decode("latin-1").strip()
            if not shift and num <= last:
                break                        # numbering restarted: new screen
            end = k.end()
            if shift:
                continue                     # the shifted row is INPA chrome
            last = num
            if num in seen or _CHROME.match(cap):
                continue
            seen.add(num)
            items.append({"fkey": num, "label": cap})
        i = end
        if len(items) < 2:
            continue
        title = _title_before(data, m.start())
        if not title:
            continue
        # an ECU ships variants of a screen; keep the richest
        if title not in out or len(items) > len(out[title]):
            out[title] = items
    return out


def tree(levels, root, seen=None):
    """Link levels by caption: an entry opens the level of the same name."""
    seen = seen or set()
    if root in seen:                        # INPA's menus are cyclic (Back)
        return []
    seen.add(root)
    node = []
    for it in levels.get(root, []):
        entry = {"fkey": it["fkey"], "label": it["label"]}
        # A child level carries the entry's own caption. Nothing else counts:
        # matching on content instead ("Displaytest" -> a level titled
        # "Testpattern") attached the same four rows to every sibling, which
        # looks like structure and is noise. An entry whose level INPA titles
        # differently stays a leaf until its real link is decoded.
        if it["label"] in levels and it["label"] not in seen:
            kids = tree(levels, it["label"], set(seen))
            if kids:
                entry["items"] = kids
        node.append(entry)
    return node


def extract(path, roots=("Activate", "Ansteuern")):
    with open(path, "rb") as f:
        data = f.read()
    levels = menus(data)
    out = {}
    for root in roots:
        if root in levels:
            t = tree(levels, root)
            # only worth recording when something actually nests
            if any("items" in e for e in t):
                out[root] = t
    return {"ecu": os.path.basename(path)[:-4], "submenus": out}


def _count(items):
    return sum(1 + _count(e.get("items", [])) for e in items)


def _show(items, depth=1):
    for e in items:
        print("   " + "  " * depth + f"F{e['fkey']:<3} {e['label']}")
        if "items" in e:
            _show(e["items"], depth + 1)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

    if args:
        rec = extract(os.path.join(L1.SGDAT, args[0] + ".IPO"))
        for root, items in rec["submenus"].items():
            print(f"{root}:")
            _show(items)
        if not rec["submenus"]:
            print("(no nested submenu declared)")
        return 0

    results, nodes = {}, 0
    for path in sorted(glob.glob(os.path.join(L1.SGDAT, "*.IPO"))):
        rec = extract(path)
        if not rec["submenus"]:
            continue
        results[rec["ecu"]] = rec["submenus"]
        nodes += sum(_count(v) for v in rec["submenus"].values())

    print(f"{len(results)} ECUs with a nested Activate menu, {nodes} entries")

    if write:
        os.makedirs(OUT, exist_ok=True)
        dest = os.path.join(OUT, "_submenus.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        print(f"wrote {len(results)} ECUs -> {os.path.relpath(dest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
