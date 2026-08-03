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
import collections

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
import ipo_screens as L1                                        # noqa: E402
import ipo_layout as L2                                         # noqa: E402

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


def item_labels(data):
    """INPA's short ITEM label for each softkey caption, e.g. Valves/Dig.out.

    The ITEM label and the softkey caption are two names for one entry
    ("Valves" / "Solenoid Valves"), and a child SCREEN is often titled after
    the short one. Pairing them lets a level titled "Valves" be found from the
    caption "Solenoid Valves" without inventing a similarity rule -- the pair
    comes from the file, matched word-prefix-wise since INPA abbreviates per
    word.
    """
    return [m.group(2).decode("latin-1").strip()
            for m in L2._RE_ITEM.finditer(data)
            if m.group(2).decode("latin-1").strip()]


def _short_for(label, shorts):
    """The ITEM label that abbreviates this softkey caption, if any."""
    want = _norm(label).split()
    if not want:
        return None
    for cand in shorts:
        parts = _norm(cand).split()
        if not parts or len(parts) > len(want):
            continue
        # INPA drops leading words as often as it truncates them: the caption
        # "Solenoid Valves" is the ITEM "Valves", "Digital output" is
        # "Dig.out". So align the short form against the END of the caption,
        # word by word, each short word opening the caption word it faces.
        tail = want[len(want) - len(parts):]
        if all(w.startswith(c) or c.startswith(w)
               for c, w in zip(parts, tail)) and len(parts[0]) >= 3:
            return cand
    return None


def dispatch_targets(data):
    """Which captions open a SCREEN, from INPA's own dispatch bytecode.

    Every ITEM carries a setscreen/setmenu call (02 <op> <id> 00) naming what
    it opens; ipo_layout already decodes those, so this asks it rather than
    inferring structure from where captions sit. An entry with a target is a
    menu; one with none runs a job inline.

    This is what settles "Digital output": its ITEM (INPA's short form
    "Dig.out") targets the screen s_steuern_digital, while "W-valve" and
    "Blower" target nothing at all.
    """
    screens, menus = L2._decl_tables(data)
    opens = {}
    for m in L2._RE_ITEM.finditer(data):
        label = m.group(2).decode("latin-1").strip()
        if not label:
            continue
        target, kind = L2._item_target(data, m.end(), screens, menus)
        if target:
            opens.setdefault(_norm(label), (target, kind))
    return opens


def _opens_screen(label, opens):
    """True when this caption's ITEM opens a screen of its own.

    INPA abbreviates the ITEM label, and it abbreviates each WORD: the softkey
    "Digital output" is the item "Dig.out", "W-valve" is "Water valve". So
    compare word by word, each item word being a prefix of the softkey's.
    """
    want = _norm(label).split()
    if not want:
        return False
    for item_label in opens:
        cand = _norm(item_label).split()
        if not cand or len(cand) > len(want):
            continue
        # every item word must open the corresponding softkey word
        if all(w.startswith(c) or c.startswith(w)
               for c, w in zip(cand, want)) and len(cand[0]) >= 3:
            return True
    return False


# short tag, full caption, then the argument VALUE the entry sends:
#     'SV 2'  'Solenoid Valve 2'  MAGNETVENTIL_2
# Some ECUs expose one actuator job whose argument names the component, so a
# menu entry is an argument value rather than a job of its own.
# the value is an identifier, but a SHORT one is legitimate: INPA emits
# 'L5' 'L5' 'L5' where short, caption and value are the same two-character
# name, so requiring three characters silently drops those entries.
# tokens that appear in the value slot but name a state, not a component
_NOT_A_VALUE = {"OKAY", "ON", "OFF", "EIN", "AUS", "JA", "NEIN", "YES", "NO",
                "ERROR", "BUSY", "START", "STOP", "END", "EXIT"}

_ARGVAL = re.compile(rb"\x06([\x20-\x7e\xa0-\xff]{1,40})\x0a"
                     rb"\x06([\x20-\x7e\xa0-\xff]{1,40})\x0a"
                     rb"\x06([A-Z][A-Z0-9_]{1,30})\x0a")


def arg_values(data):
    """caption -> the argument value INPA sends for it."""
    out = {}
    for m in _ARGVAL.finditer(data):
        short = m.group(1).decode("latin-1").strip()
        caption = m.group(2).decode("latin-1").strip()
        value = m.group(3).decode("latin-1").strip()
        # the caption must read like one, and the value like an identifier
        if not caption or caption.startswith(";") or "_" in caption:
            continue
        # state words and status tokens are not components: "Blower" sits
        # beside an OFF in its own screen, and treating that as the value it
        # sends makes a real actuator look like another variant's entry
        if value.startswith("STEUERN_") or value in _NOT_A_VALUE:
            continue
        out.setdefault(_norm(caption), (value, short))
        # INPA also captions the same entry short ("EDS 4" for the menu's
        # "Electric pressure controller EDS 4"), so index the short form too
        if short and not short.startswith(";"):
            out.setdefault(_norm(short), (value, short))
    return out


def resolve_jobs(data, items, sites, submenu_titles=(), opens=None,
                 argvals=None, _depth=0):
    """Attach each leaf's job: the call site its caption sits closest to."""
    for e in items:
        if e.get("items"):
            resolve_jobs(data, e["items"], sites, submenu_titles, opens,
                         argvals, _depth + 1)
            continue
        # A caption that opens a screen is a submenu, checked BEFORE the
        # argument table: "Displaytest" opens s_steuern_display and also
        # happens to appear beside a DISPLAY_TEST value, and treating it as a
        # value would turn a menu into a one-shot test.
        if opens and _opens_screen(e["label"], opens):
            e["submenu"] = True
            continue
        # an entry that is an argument VALUE rather than a job of its own:
        # GSDS2 drives every solenoid through STEUERN_STELLGLIED, choosing the
        # component with STELLGL=MAGNETVENTIL_2 and so on
        # a job the dispatch resolved outranks the value table: the value is
        # only how a single-job ECU picks its component
        if argvals and not e.get("job"):
            key = _norm(e["label"])
            hit = argvals.get(key)
            if not hit:
                # the menu spells it out ("Electric pressure controller EDS 4")
                # where the value table abbreviates ("EDS 4"): match on the
                # TAIL of the caption, the same way INPA shortens elsewhere
                words = key.split()
                for n in range(2, min(len(words), 4) + 1):
                    hit = argvals.get(" ".join(words[-n:]))
                    if hit:
                        break
            if hit:
                e["argValue"] = hit[0]
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


def tree(levels, root, seen=None, shorts=()):
    """Link levels by caption: an entry opens the level of the same name."""
    seen = seen or set()
    if root in seen:                        # INPA's menus are cyclic (Back)
        return []
    seen.add(root)
    node = []
    for it in levels.get(root, []):
        entry = {"fkey": it["fkey"], "label": it["label"]}
        # A child level carries either the entry's own caption, or INPA's
        # SHORT form of it: GSDS2's "Solenoid Valves" opens a level titled
        # "Valves", which is the ITEM label for the same entry.
        key = it["label"] if it["label"] in levels else None
        if key is None and shorts:
            cand = _short_for(it["label"], shorts)
            if cand in levels:
                key = cand
        if key and key not in seen:
            kids = tree(levels, key, set(seen), shorts)
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
            shorts = item_labels(data)
            t = resolve_jobs(data, tree(levels, root, shorts=shorts), sites,
                             titles, dispatch_targets(data), arg_values(data))
            # only worth recording when something actually nests
            if any("items" in e for e in t):
                out[root] = t
    return {"ecu": os.path.basename(path)[:-4], "submenus": out}


def _count(items):
    return sum(1 + _count(e.get("items", [])) for e in items)


def _show(items, depth=1):
    for e in items:
        job = (f"   -> {e['job']}" if e.get("job")
               else f"   = {e['argValue']}" if e.get("argValue") else "")
        print("   " + "  " * depth + f"F{e['fkey']:<3} {e['label']}{job}")
        if "items" in e:
            _show(e["items"], depth + 1)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

    if args:
        rec = extract(L1.ipo_path(args[0]))
        for root, items in rec["submenus"].items():
            print(f"{root}:")
            _show(items)
        if not rec["submenus"]:
            print("(no nested submenu declared)")
        return 0

    results, nodes = {}, 0
    for path in L1.ipo_paths():
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
