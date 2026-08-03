#!/usr/bin/env python3
"""Mine each ECU's real INPA root menu — the right entries, in INPA's F-key order.

Our ECU home screen was built from MenuGen's job buckets, so it showed
"F1 Status / F2 Faults / F3 Activations / F6 Service / F7 Special / F8 Other".
INPA shows something different, and numbers it differently:

    ZKE5:  F1 Information / F2 Identification / F3 Coding / F4 Error memory
           F5 Read status / F6 Activate  (F7 unused, F8 Select, F10 End)

The F-key numbers are the ECU's own — an ECU without Coding has Error memory on
F3, not F4 — so they cannot be inferred from a fixed list; they have to come out
of the bytecode per ECU.

INPA prints its softkey help as "< F1 >  Read status" (and "<Shift> + < F8 >"
for the shifted row), which is what this reads. Chrome that is INPA's own UI
rather than a diagnostic function — Select, Deselect, Print screen, End, Exit,
Change Editor — is dropped, since the app provides those natively.

Read-only: decodes an .IPO, never talks to a car.

    python3 tools/ipo_rootmenu.py            # corpus summary
    python3 tools/ipo_rootmenu.py ZKE5       # one ECU
    python3 tools/ipo_rootmenu.py --write    # data/inpa-screens/_rootmenus.json
"""
import os
import re
import sys
import json
import collections

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
import ipo_screens as L1                                        # noqa: E402
import ipo_layout                                               # noqa: E402

OUT = L1.OUT

# "< F5 >  Read status" / "<Shift> + < F8 >  Deselect"
_FKEY = re.compile(rb"\x06(?:<\s*(Shift)\s*>\s*\+\s*)?<\s*F(\d+)\s*>\s+"
                   rb"([\x20-\x7e\xa0-\xff]{2,40})\x0a")

# INPA's own UI, not ECU functions: the app has these natively
_CHROME = re.compile(r"^(Select|Deselect|Print(\s*screen)?|End|Ende|Exit|Back|"
                     r"Zur(ü|ue)ck|Auswahl|Abwahl|Bildschirmdruck|Drucken|"
                     r"Change\s+Editor|Abbruch)$", re.I)

# the caption that anchors a root menu: every INPA ECU menu opens with it
_ROOT_ANCHOR = re.compile(rb"\x06<\s*F1\s*>\s+(Information|Info)\x0a", re.I)

# how far past the anchor one menu's softkey help runs
_SPAN = 900

# A root key can be listed and still open nothing. GSDS2 prints "< F3 > Coding",
# but the file declares no s_code screen: its main-menu dispatch sends F3 to
# m_status, and INPA ships a SECOND root menu for the same ECU called
# m_main_nocode -- "main, no coding" -- which omits F3 entirely. The key is dead
# in INPA, so it must not become a screen here.
#
# Measured over the 89 ECUs that list a Coding key: 50 declare a real coding
# screen, 39 do not, and the 39 are almost all engine/transmission ECUs (DME*,
# DDE*, MS4xx, MSS5x, SMG2) -- coded by the factory tool, not by INPA. That
# split is the reason this checks the DECLARATION rather than whether
# tools/ipo_coding.py managed to read the screen: only 17 of the 50 are
# currently readable, and the other 33 are a miner gap, not a dead key.
_SECTION_DECL = {
    "coding": re.compile(r"^[sm]_(code|codier|kod)", re.I),
}


def _dead_keys(data, items):
    """Root keys INPA lists but declares no screen for."""
    screens, menus = ipo_layout._decl_tables(data)
    names = [n for n in list(screens.values()) + list(menus.values())]
    dead = []
    for it in items:
        if not re.match(r"^(Coding|Codierung)$", it["label"], re.I):
            continue
        if not any(_SECTION_DECL["coding"].match(n) for n in names):
            dead.append(it["fkey"])
    return dead


def root_menu(data):
    """The ECU's root entries as (fkey, caption), in INPA's own numbering."""
    m = _ROOT_ANCHOR.search(data)
    if not m:
        return []
    seen, out = set(), []
    for k in _FKEY.finditer(data, m.start(), m.start() + _SPAN):
        shift, num, cap = k.group(1), int(k.group(2)), k.group(3).decode("latin-1").strip()
        if shift:                       # the shifted row is INPA chrome
            continue
        if num in seen or _CHROME.match(cap):
            continue
        seen.add(num)
        out.append({"fkey": num, "label": cap})
    return out


def extract(path):
    with open(path, "rb") as f:
        data = f.read()
    items = root_menu(data)
    rec = {"ecu": os.path.basename(path)[:-4], "items": items}
    # keep the key in `items` so the F-key NUMBERING stays INPA's own, and mark
    # it dead separately -- dropping it here would renumber everything below it
    dead = _dead_keys(data, items) if items else []
    if dead:
        rec["deadKeys"] = dead
    return rec


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

    if args:
        path = L1.ipo_path(args[0])
        if not os.path.exists(path):
            print(f"no such .IPO: {args[0]}", file=sys.stderr)
            return 1
        rec = extract(path)
        print(json.dumps(rec, ensure_ascii=False, indent=1))
        return 0

    results, shapes = {}, collections.Counter()
    for path in L1.ipo_paths():
        rec = extract(path)
        if not rec["items"]:
            continue
        results[rec["ecu"]] = rec
        shapes[tuple(i["label"] for i in rec["items"])] += 1

    print(f"{len(results)} ECUs with a decodable root menu, "
          f"{len(shapes)} distinct shapes\n")
    for sig, n in shapes.most_common(6):
        print(f"   {n:4}  {' / '.join(sig)}")

    if write:
        os.makedirs(OUT, exist_ok=True)
        dest = os.path.join(OUT, "_rootmenus.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        print(f"\nwrote {len(results)} ECUs -> {os.path.relpath(dest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
