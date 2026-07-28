#!/usr/bin/env python3
"""Mine INPA's Read status structure -- the status MENU and the pages it opens.

Our Status section was a flat MenuGen job list. INPA's is a menu of pages:

    GSDS2  Read status -> Switches   -> s_schalter
                          Valves     -> m_ventile_860_20
                          Internal   -> m_ventile_834
                          Gear       -> m_sonstige_732
                          System     -> m_sonstige_922
                          Analog2    -> s_ana2_732_832_851

so picking "Read status" should land on that list, not on every STATUS_* job the
SGBD happens to own. tools/ipo_gauges.py already mines each readout's unit and
range; this mines which PAGE a readout belongs to.

Menu bodies are delimited by the next declaration, not by a fixed span: INPA
emits `0c 81 <len> 00 <type> <name>` per proc, and everything between one
declaration and the next belongs to it. A fixed window either truncates long
menus or swallows the following one.

Dispatch ids are DECLARATION ids, resolved by ipo_layout._item_target. A
file-order reading was tried and is wrong: across 1069 sites where the two
schemes disagree, declaration-id matches the item's own label 859 times and
file-order only 83. Ids with no declaration (GSDS2's "Analog1") are left
unresolved rather than bent onto a neighbouring screen.

Read-only: decodes an .IPO, never talks to a car.

    python3 tools/ipo_status.py             # corpus summary
    python3 tools/ipo_status.py GSDS2       # one ECU
    python3 tools/ipo_status.py --write     # data/inpa-screens/_status.json
"""
import os
import re
import sys
import json
import glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_screens as L1                                        # noqa: E402
import ipo_layout                                               # noqa: E402

OUT = L1.OUT

# proc declaration: 0c 81 <len> 00 <type: 01 screen | 02 menu> <name>
_DECL = re.compile(rb"\x0c\x81(.)\x00(.)([A-Za-z][\x20-\x7e]{1,24})", re.DOTALL)

# the menu INPA's "Read status" key opens, and the screen it falls back to
_STATUS_MENU = re.compile(r"^m_status", re.I)
_STATUS_SCREEN = re.compile(r"^s_status", re.I)

# a page worth listing: analog readouts, switches, valves, per-area groups
_PAGE = re.compile(r"^[sm]_(ana|schalter|ventil|sonstige|status|digital|mwb)", re.I)

# INPA's own UI, not diagnostic pages
_CHROME = re.compile(r"^(Exit|Print(\s*screen)?|End|Ende|Back|Zur(ü|ue)ck|Select|"
                     r"Deselect|Auswahl|Abwahl|Druck|Drucken|Stop|Clear|Reset|"
                     r"Start|All|Gesamt|Ein|Aus|Off|On)$", re.I)

# the ECU root: a call to it is the menu's exit path, never a status page
_ROOT = re.compile(r"^[sm]_(main|info)", re.I)


def _base(name):
    """s_status_eingang and m_status_eingang are the same page."""
    return re.sub(r"^[sm]_", "", name).lower()


def _decls(data):
    """Every proc declaration in file order: (offset, kind, name)."""
    out = []
    for m in _DECL.finditer(data):
        n, t = m.group(1)[0], m.group(2)[0]
        name = m.group(3)[:n - 1].decode("latin-1", "replace")
        if len(name) >= 3 and t in (1, 2):
            out.append((m.start(), "screen" if t == 1 else "menu", name))
    out.sort()
    return out


def _body(decls, i, data):
    """Byte range of declaration i: up to the next declaration."""
    start = decls[i][0]
    end = decls[i + 1][0] if i + 1 < len(decls) else len(data)
    return start, end


def _items(data, start, end, screens, menus):
    """The menu entries in one declaration body, in INPA's order.

    An item's targets are every dispatch between its label and the NEXT item's
    label -- not a fixed byte window. One entry can own several: GSDS2's
    "Analog2" is followed by seven calls (ids 18..24), one per gearbox variant
    (s_ana2_732_832_851, s_ana2_834, s_ana2_870, s_ana2_922, s_ana2_836,
    s_ana2_860, s_ana2_20), because INPA picks the page at runtime from the
    gearbox type. A 24-byte tail saw only the first call and, where INPA emits
    the selection logic before the call, none at all -- which read as
    "unresolved" for the very entries that have the most targets.
    """
    marks = [(m.start(), m.end(), m.group(2).decode("latin-1").strip())
             for m in ipo_layout._RE_ITEM.finditer(data, start, end)]
    out, seen = [], set()
    for i, (s, e, label) in enumerate(marks):
        stop = marks[i + 1][0] if i + 1 < len(marks) else end
        if not label or _CHROME.match(label) or label in seen:
            continue
        if not L1._clean(label):
            continue
        targets = []
        for c in ipo_layout._RE_ITEM_CALL.finditer(data, e, stop):
            op, tid = c.group(1)[0], c.group(2)[0]
            table = menus if op in (0x41, 0x3f) else screens
            other = screens if table is menus else menus
            name = table.get(tid) or other.get(tid)
            if not name:
                continue
            # the run ends at the menu's own exit path: every INPA menu closes
            # with a jump back to the root, and those calls sit after the last
            # real item, so a run that reaches them has over-read into chrome
            # (BC1's "RF and Tilt" otherwise collects s_main and s_info).
            if _ROOT.match(name):
                break
            # s_foo and m_foo are one page reached as screen or as menu, not two
            # variants: INPA declares both so the same content can be opened
            # from a key or from a list. 88 items corpus-wide look like
            # multi-target only because of this pairing.
            if any(_base(name) == _base(t) for t in targets):
                continue
            if name not in targets:
                targets.append(name)
        seen.add(label)
        # ids with no declaration stay unresolved rather than being bent onto a
        # neighbouring screen -- the same gap that makes GSDS2's F3 Coding key
        # dead (see tools/ipo_rootmenu.py).
        out.append({"label": label, "targets": targets,
                    "resolved": bool(targets)})
    return out


def extract(path):
    with open(path, "rb") as f:
        data = f.read()
    ecu = os.path.basename(path)[:-4]
    screens, menus = ipo_layout._decl_tables(data)
    decls = _decls(data)

    pages, root = [], None
    for i, (off, kind, name) in enumerate(decls):
        if not _STATUS_MENU.match(name):
            continue
        start, end = _body(decls, i, data)
        items = _items(data, start, end, screens, menus)
        if items:
            root = {"name": name, "items": items}
            break

    # the pages the status menu reaches, each with its own items
    if root:
        want = {t for it in root["items"] for t in it["targets"]}
        for i, (off, kind, name) in enumerate(decls):
            if name not in want or not _PAGE.match(name):
                continue
            start, end = _body(decls, i, data)
            sub = _items(data, start, end, screens, menus)
            pages.append({"name": name, "kind": kind, "items": sub})

    if not root:
        # no status menu: INPA opens a single status SCREEN directly
        has_screen = any(_STATUS_SCREEN.match(n) for _, k, n in decls if k == "screen")
        if not has_screen:
            return {"ecu": ecu, "status": None}
        return {"ecu": ecu, "status": {"kind": "screen", "menu": None, "pages": []}}

    return {"ecu": ecu, "status": {"kind": "menu", "menu": root, "pages": pages}}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

    if args:
        rec = extract(os.path.join(L1.SGDAT, args[0] + ".IPO"))
        st = rec["status"]
        if not st:
            print(f"{rec['ecu']}: no Read status screen")
            return 0
        if st["kind"] == "screen":
            print(f"{rec['ecu']}: a single status screen, no menu")
            return 0
        print(f"{rec['ecu']}: {st['menu']['name']}")
        for it in st["menu"]["items"]:
            if not it["resolved"]:
                arrow = "-> (id has no declaration)"
            elif len(it["targets"]) == 1:
                arrow = f"-> {it['targets'][0]}"
            else:
                arrow = f"-> {len(it['targets'])} variants: " \
                        + ", ".join(it["targets"][:3]) + " ..."
            print(f"   {it['label']:22} {arrow}")
        for p in st["pages"]:
            print(f"\n   {p['name']}  ({len(p['items'])} items)")
            for it in p["items"][:8]:
                print(f"      {it['label']}")
        return 0

    results, menus_n, pages_n = {}, 0, 0
    for path in sorted(glob.glob(os.path.join(L1.SGDAT, "*.IPO"))):
        rec = extract(path)
        if not rec["status"] or rec["status"]["kind"] != "menu":
            continue
        results[rec["ecu"]] = rec["status"]
        menus_n += 1
        pages_n += len(rec["status"]["pages"])

    unres = sum(1 for st in results.values()
                for it in st["menu"]["items"] if not it["resolved"])
    print(f"{menus_n} ECUs with a status MENU, {pages_n} sub-pages, "
          f"{unres} entries whose target id has no declaration")

    if write:
        os.makedirs(OUT, exist_ok=True)
        dest = os.path.join(OUT, "_status.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        print(f"wrote {len(results)} ECUs -> {os.path.relpath(dest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
