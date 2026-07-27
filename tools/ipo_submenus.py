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

KNOWN GAP. An entry whose child screen INPA titles after the PARENT cannot be
told from a test by anything in this file: "Digital output" has no level of its
own name, and its caption sits nearest STEUERN_RELAIS_FRONTSCHEIBE -- the first
of the six relay tests it introduces. It is therefore reported as a leaf with
that job. Four rules were tried to catch it (content-titled linking, positional
linking, frequency dominance, distance ratios) and each swept up real leaves
(Displaytest, Water valve, Blower) with it, so the narrow rule stands: better
one entry wrong than three correct ones lost. Resolving it properly needs the
menu-dispatch bytecode, which is not decoded yet.

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

# the actuator job a leaf runs, and the strings around its call site
_JOB = re.compile(rb"\x06(STEUERN_[A-Z0-9_]+)\x0a")
# how far either side of a job call its own caption may sit
_JOB_NEAR = 320


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
    """Every softkey level in the file: {title: [{fkey,label}]}.

    A level whose title cannot be read is kept under a positional key so the
    caller can still link it: INPA does not always retitle a child screen, and
    the block after "< F3 >  Digital output" is that entry's contents even
    though the only heading before it is the PARENT's ("Activate").
    """
    out = {}
    order = []
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
        order.append((m.start(), title, items))
    out["__order__"] = order
    return out


def job_sites(data):
    """Every STEUERN_* call with the captions around it.

    A leaf screen reads: a short tag, the caption, an input prompt, then the
    job -- 'Freshair' / 'Fresh air flap' / 'Position (0-100 %)' /
    STEUERN_MOTOR_KLAPPENPOSITION. So the job a menu entry runs is the one
    whose call site its caption sits NEAREST to.
    """
    sites = []
    for m in _JOB.finditer(data):
        near = []
        lo = max(0, m.start() - _JOB_NEAR)
        for s in _TITLE.finditer(data, lo, m.start() + 80):
            txt = s.group(1).decode("latin-1").strip()
            if txt:
                near.append((abs(s.start() - m.start()), txt))
        sites.append((m.group(1).decode("latin-1"), near))
    return sites


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def resolve_jobs(data, items, sites, submenu_titles=(), _depth=0):
    """Attach each leaf's job: the call site its caption sits closest to."""
    for e in items:
        if e.get("items"):
            resolve_jobs(data, e["items"], sites, submenu_titles, _depth + 1)
            continue
        # A caption that heads another screen is a SUBMENU, even where this
        # tree could not link its children. Giving it the first job in its
        # section would put an actuator behind a menu: "Digital output" would
        # fire STEUERN_RELAIS_FRONTSCHEIBE, one of the six tests it contains.
        if e["label"] in submenu_titles:
            e["submenu"] = True
            continue
        want = _norm(e["label"])
        if not want:
            continue
        # every job whose call site this caption sits near, nearest first
        hits = []
        for job, near in sites:
            for dist, txt in near:
                if _norm(txt) == want:
                    hits.append((dist, job))
        if not hits:
            continue
        hits.sort()
        # A leaf caption sits right on its own job's call site; a menu heading
        # ("Digital output") sits a similar distance from every job in the
        # section it introduces. So claim the nearest only when it is CLEARLY
        # nearest -- a runner-up at a comparable distance means the caption is
        # not pointing at one job in particular.
        # Use the NEAREST call site, and nothing cleverer.
        #
        # Frequency was tried and does not separate these: a caption recurs
        # once per ECU variant AND once inside every section that mentions it,
        # so "Blower" is dominated by STEUERN_WASSERVENTIL (15/34) while its
        # own job is merely nearest. Distance ratios were tried too and simply
        # traded which entries broke. Nearest is the one signal that is right
        # whenever it is checkable here.
        #
        # Headings are excluded structurally instead, by `submenu_titles` --
        # a caption that heads a screen of its own is never a test -- which is
        # a fact from the file rather than a threshold.
        e["job"] = hits[0][1]
    return items


def _following_block(order, after, labels):
    """The next softkey block after `after` whose rows are this entry's list.

    Used when INPA leaves a child screen titled after its parent: the block is
    still the entry's contents, and its rows are ones the parent does not have.
    """
    for pos, title, items in order:
        if pos <= after:
            continue
        rows = {i["label"] for i in items}
        if rows & labels:                   # same level repeated, not a child
            return None
        return items
    return None


def tree(levels, root, seen=None):
    """Link levels by caption: an entry opens the level of the same name."""
    seen = seen or set()
    if root in seen:                        # INPA's menus are cyclic (Back)
        return []
    seen.add(root)
    node = []
    for it in levels.get(root, []):
        entry = {"fkey": it["fkey"], "label": it["label"]}
        # A child level normally carries the entry's own caption.
        if it["label"] in levels and it["label"] not in seen:
            kids = tree(levels, it["label"], set(seen))
            if kids:
                entry["items"] = kids
        # An entry whose child screen INPA leaves titled after the PARENT
        # ("Digital output"'s rows sit under a heading that reads "Activate")
        # stays a leaf. Claiming the next block positionally was tried and
        # attached digital-output rows to Displaytest and phantom children to
        # Water valve and Blower, which are real leaves with their own jobs.
        # A wrong tree is worse than a shallow one.
        node.append(entry)
    return node


def extract(path, roots=("Activate", "Ansteuern")):
    with open(path, "rb") as f:
        data = f.read()
    levels = menus(data)
    sites = job_sites(data)
    out = {}
    for root in roots:
        if root in levels:
            # Captions that head a screen of their own are submenus, whether
            # or not this tree linked their contents. This does not catch every
            # one -- INPA leaves some child screens titled after the PARENT, so
            # "Digital output" is indistinguishable from a test by title alone
            # and still resolves to the first job in its section. Widening the
            # rule to catch it was tried and swept up the real leaves with it
            # (Displaytest, Water valve, Blower), so the narrow version stands
            # and the renderer treats a linked `items` list as authoritative.
            titles = {t for t in levels if t not in ("__order__", root)}
            t = resolve_jobs(data, tree(levels, root), sites, titles)
            # only worth recording when something actually nests
            if any("items" in e for e in t):
                out[root] = t
    return {"ecu": os.path.basename(path)[:-4], "submenus": out}


def _count(items):
    return sum(1 + _count(e.get("items", [])) for e in items)


def _show(items, depth=1):
    for e in items:
        job = f"   -> {e['job']}" if e.get("job") else ""
        print("   " + "  " * depth + f"F{e['fkey']:<3} {e['label']}{job}")
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
