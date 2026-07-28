#!/usr/bin/env python3
"""Mine INPA's Activate menu structure from an .IPO — groups, not job names.

Our Activations screen listed the SGBD's job names ("Digital", "Interior
lighting Off"). INPA never shows those. Its Activate screen is a menu:

    Activate  ->  Input / Output / Radio / FUNK
                  each of which lists   PW / C.Lock / Contact / WiWa /
                                        A-Theft / Mirror / Others

and each group carries the token that selects its components:

    'Activate / Inputs'   PW  EIN_fh   C.Lock  EIN_zv   Contact  EIN_kontakt ...
    'Activate / Outputs'  PW  AUS_fh   C.Lock  AUS_zv   WiWa     AUS_wiwa    ...

The bytecode alternates label, filter-token, label, filter-token, so the pairing
is recoverable without knowing anything about this particular ECU. EIN_/AUS_
also say which direction the group drives, which is what makes an "Outputs"
group safe to show as drivable and an "Inputs" group a read.

HOW COMMON IS THIS? Measured, not assumed: of 763 .IPO files, exactly ONE
(ZKE5) carries EIN_/AUS_ group filters, and only ZKE5 uses the
"Activate / <sub>" heading. 339 files have a plain "Activate" screen with no
sub-grouping. So this decodes a real INPA structure where it exists rather than
a corpus-wide convention -- which is why it emits nothing for the other 762
instead of inventing groups for them.

Read-only: this decodes an .IPO, it never talks to a car.

    python3 tools/ipo_actmenus.py            # corpus summary
    python3 tools/ipo_actmenus.py ZKE5       # one ECU
    python3 tools/ipo_actmenus.py --write    # data/inpa-screens/_actmenus.json
"""
import os
import re
import sys
import json
import collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_screens as L1                                        # noqa: E402

OUT = L1.OUT

# the screen heading that opens a group list, e.g. 'Activate / Outputs'
_HEADING = re.compile(rb"\x06(Ansteuern|Activate)\s*/\s*"
                      rb"([\x20-\x7e]{2,24})\x0a", re.I)
# a printable INPA string
_STR = re.compile(rb"\x06([\x20-\x7e\xa0-\xff]{1,40})\x0a")
# the token that selects a group's components; the prefix is the direction
_FILTER = re.compile(r"^(EIN|AUS|ON|OFF)_(\w+)$", re.I)
# INPA's state display after a drive: it runs the job, then prints the current
# signal state rather than treating the send as fire-and-forget.
#   STEUERN_DIGITAL · OKAY · 'ACTIVATED DIGITAL VALUE' · 'Signal : ' · EIN / AUS
# That readout is why INPA needs no separate stop job: the EIN_ group switches
# on, its AUS_ counterpart switches off, and the display says which you are in.
_STATE = re.compile(rb"\x06([A-Z][A-Z0-9_]{5,})\x0a\x06\x0a\x06OKAY\x0a"
                    rb"[^\x06]{0,8}\x06(ACTIVATED[\x20-\x7e]{0,24})\x0a"
                    rb"\x06([\x20-\x7e]{2,20}:\s*)\x0a", re.DOTALL)
# chrome that is never a component group, whether or not it ends the list
_CHROME = re.compile(r"^(Select|Deselect|Print(\s*screen)?|Back|Exit|End|Ende|"
                     r"Drucken|Auswahl|Abbruch|Zur(ü|ue)ck|Change\b.*)$", re.I)
# INPA prints its softkey help as "< F1 >  Window regulator"; the caption is
# the part after the key, and a Shift row is chrome
_FKEY_PREFIX = re.compile(r"^<\s*(Shift)?\s*>?\s*\+?\s*<?\s*F\d+\s*>\s*")
_SHIFT_ROW = re.compile(r"^<\s*Shift", re.I)
# the list ends where the next screen begins: another heading, a job name, or
# the result chrome INPA prints under the screen
_END = re.compile(r"^(Ansteuern|Activate)\s*/|^[A-Z][A-Z0-9_]{5,}$|"
                  r"^(OKAY|ACTIVATED\b.*|Signal\s*:|EIN|AUS)$")


def _groups_after(data, pos, limit=400):
    """Walk label/filter pairs following a heading until the chrome starts."""
    out = []
    pending = None
    for m in _STR.finditer(data, pos, pos + limit):
        s = m.group(1).decode("latin-1").strip()
        if not s:
            continue
        # Shift rows are always chrome (Deselect/Exit)
        if _SHIFT_ROW.match(s):
            continue
        s = _FKEY_PREFIX.sub("", s).strip()
        if not s or _CHROME.match(s):
            continue
        if _END.match(s):
            break
        f = _FILTER.match(s)
        if f:
            # a filter closes the label before it
            if pending:
                out.append({"label": pending, "filter": s,
                            "direction": f.group(1).lower(), "key": f.group(2)})
                pending = None
            continue
        # two labels in a row: the first had no filter (INPA's "Mirror")
        if pending:
            out.append({"label": pending, "filter": None,
                        "direction": None, "key": None})
        pending = s
    if pending:
        out.append({"label": pending, "filter": None,
                    "direction": None, "key": None})
    return out


def state_displays(data):
    """The job -> state-readout captions INPA prints after driving."""
    out = {}
    for m in _STATE.finditer(data):
        job = m.group(1).decode("latin-1")
        if not job.startswith(("STEUERN", "ANSTEUERN")):
            continue
        out.setdefault(job, {
            "job": job,
            "title": m.group(2).decode("latin-1").strip(),
            "caption": m.group(3).decode("latin-1").strip(),
        })
    return out


def extract(path):
    """The Activate menus one .IPO declares, keyed by heading."""
    with open(path, "rb") as f:
        data = f.read()
    menus = {}
    for m in _HEADING.finditer(data):
        title = m.group(2).decode("latin-1").strip()
        groups = _groups_after(data, m.end())
        if not groups:
            continue
        # keep the richest sighting: INPA emits the screen more than once
        if title not in menus or len(groups) > len(menus[title]["groups"]):
            menus[title] = {"title": title, "groups": groups}
    # pair each EIN_ group with the AUS_ group that undoes it, and vice versa.
    # This is INPA's stop: there is no _ENDE job, the opposite group IS the off
    # switch, so the UI can offer it without inventing a mechanism.
    by_key = {}
    for menu in menus.values():
        for g in menu["groups"]:
            if g.get("key"):
                by_key.setdefault(g["key"], {})[g.get("direction")] = {
                    "menu": menu["title"], "label": g["label"],
                    "filter": g["filter"],
                }
    for menu in menus.values():
        for g in menu["groups"]:
            pair = by_key.get(g.get("key") or "", {})
            other = "aus" if g.get("direction") == "ein" else "ein"
            if pair.get(other):
                g["opposite"] = pair[other]

    return {"ecu": os.path.basename(path)[:-4], "menus": list(menus.values()),
            "stateDisplays": list(state_displays(data).values())}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

    if args:
        path = os.path.join(L1.SGDAT, args[0] + ".IPO")
        if not os.path.exists(path):
            print(f"no such .IPO: {args[0]}", file=sys.stderr)
            return 1
        print(json.dumps(extract(path), ensure_ascii=False, indent=1))
        return 0

    results, stats = {}, collections.Counter()
    for path in sorted(__import__("glob").glob(os.path.join(L1.SGDAT, "*.IPO"))):
        rec = extract(path)
        if not rec["menus"]:
            continue
        results[rec["ecu"]] = rec
        stats["ecus"] += 1
        for menu in rec["menus"]:
            stats["menus"] += 1
            stats["groups"] += len(menu["groups"])
            stats["with filter"] += sum(1 for g in menu["groups"] if g["filter"])

    print(f"{stats['ecus']} ECUs with an Activate menu\n")
    for k in ("menus", "groups", "with filter"):
        print(f"   {k:12} {stats[k]}")

    if write:
        os.makedirs(OUT, exist_ok=True)
        dest = os.path.join(OUT, "_actmenus.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        print(f"\nwrote {len(results)} ECUs -> {os.path.relpath(dest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
