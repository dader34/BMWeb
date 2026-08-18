#!/usr/bin/env python3
"""Layer 1: generic .IPO screen extractor — no per-ECU code.

The MS45 work produced eleven hand-written tools, eight of them pinned to a
single .IPO. This module is what those tools had in common, generalised: the
patterns are the portable part, the MS45 specifics were not.

It decodes four structures INPA's bytecode uses across the whole corpus:

  fields    a labelled result on a screen row. INPA emits the caption, a ':'
            and the result key as three strings sharing a row:
                'Vehicle identification nr.' row 1 ... ':' ... AIF_FG_NR
  captions  the other field dialect, key first, label second (the Ident card):
                ID_BMW_NR  'BMWTeilenummer          :  '
  softkeys  '< F1 >  Memory lin. reading', INPA's own menu captions
  tables    label / slot / job / argument quadruples — the shape behind
            selective adaptation clearing, where the argument is a bitmask

Everything here is READ-ONLY extraction. It reports what the bytecode says and
attaches provenance; it never invents a screen, and callers must treat a job
argument decoded here as unverified until a car confirms it.

    python3 tools/ipo_screens.py                 # corpus summary
    python3 tools/ipo_screens.py MS450           # one ECU, as JSON
    python3 tools/ipo_screens.py --write         # data/inpa-screens/*.json
"""
import os
import re
import sys
import json
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
SGDAT = os.path.join(HERE, "..", "..", "vendor", "EC-APPS", "INPA", "SGDAT")
OUT = os.path.join(HERE, "..", "..", "data", "inpa-screens")

# push-int operand: 03 <n> 00. The `.` MUST be DOTALL — operand value 10
# encodes as \x0a, and a bare dot silently drops every row/slot numbered 10.
# This cost three separate bugs during the MS45 work; keep the DOTALL.
_P = rb"\x03(.)\x00"
# a printable INPA string: 06 <text> 0a
_S = rb"\x06([\x20-\x7e\xa0-\xff]{%d,%d})\x0a"

# caption + 4 ints (row,col,attr,attr), ':' + 4 ints, then the result key
_FIELD = re.compile((_S % (3, 50)) + _P * 4 + rb"\x06:\x0a" + _P * 4
                    + rb"\x06([A-Z][A-Z0-9_]{2,})\x0a", re.DOTALL)
# The other dialect: KEY first, then its colon-terminated caption. INPA usually
# pushes a small int between the two ('ID_BMW_NR' 03 01 00 'BMWTeilenummer :'),
# so the separator is optional — requiring the strings to be adjacent silently
# loses most of the Ident card.
_CAPTION = re.compile(rb"\x06([A-Z][A-Z0-9_]{2,})\x0a(?:" + _P + rb")?"
                      + (_S % (4, 40)), re.DOTALL)
# ...and the mirror image, caption first ('Seriennummer:' then SERIENNUMMER)
_CAPTION_R = re.compile((_S % (4, 40)) + rb"\x06([A-Z][A-Z0-9_]{2,})\x0a",
                        re.DOTALL)
# INPA's own softkey captions. The key and its caption are ONE string, so this
# cannot reuse _S (which starts its own \x06) — the label is matched inline:
#     '< F1 >  Memory lin. reading'
#     '< Shift > + < F10>  INPA beenden'
_SOFTKEY = re.compile(rb"\x06(?:<\s*(Shift)\s*>\s*\+\s*)?<\s*F(\d+)\s*>\s+"
                      rb"([\x20-\x7e\xa0-\xff]{2,40})\x0a")
# label / slot / job / argument — the selective-clear table shape
_TABLE = re.compile((_S % (3, 44)) + _P + rb"\x06([A-Z][A-Z0-9_]{5,})\x0a"
                    + (_S % (1, 16)), re.DOTALL)

# a caption must read like a caption, not a stray identifier or format string
_JUNK = re.compile(r"^[\s\-_=.:*#]*$|^%|^0x|;")
# INPA marks slots other ECUs use but this one does not
_UNUSED = re.compile(r"unused|nicht (belegt|verwendet)|not used", re.I)


def _txt(b):
    return b.decode("latin-1").strip()


def _clean(label):
    """True if this looks like a human caption rather than bytecode noise."""
    return bool(label) and not _JUNK.match(label) and len(label) >= 2


def fields(data):
    """Labelled result rows, de-duplicated, in screen-row order."""
    out, seen = [], set()
    for m in _FIELD.finditer(data):
        key, label, row = _txt(m.group(10)), _txt(m.group(1)), m.group(2)[0]
        if key in seen or not _clean(label):
            continue
        seen.add(key)
        out.append({"key": key, "label": label.rstrip(": "), "row": row,
                    "source": "ipo"})
    out.sort(key=lambda f: f["row"])
    return out


def captions(data):
    """The caption dialect (Ident cards), both orders, in emission order."""
    out, seen = [], set()
    hits = [(m.start(), _txt(m.group(1)), _txt(m.group(3) or b""))
            for m in _CAPTION.finditer(data)]
    hits += [(m.start(), _txt(m.group(2)), _txt(m.group(1)))
             for m in _CAPTION_R.finditer(data)]
    for _, key, label in sorted(hits):
        # the caption half must read like one: it carries the colon
        if key in seen or ":" not in label or not _clean(label):
            continue
        seen.add(key)
        out.append({"key": key, "label": label.rstrip(": "), "source": "ipo"})
    return out


def softkeys(data):
    """INPA's own F-key captions, de-duplicated by (shift, number, label)."""
    out, seen = [], set()
    for m in _SOFTKEY.finditer(data):
        shift, n, label = bool(m.group(1)), int(m.group(2)), _txt(m.group(3))
        sig = (shift, n, label)
        if sig in seen or not _clean(label):
            continue
        seen.add(sig)
        out.append({"fkey": n, "shift": shift, "label": label, "source": "ipo"})
    return out


def tables(data):
    """label/slot/job/arg quadruples. Arguments are UNVERIFIED writes."""
    by_job = {}
    for m in _TABLE.finditer(data):
        label, slot = _txt(m.group(1)), m.group(2)[0]
        job, arg = _txt(m.group(3)), _txt(m.group(4))
        if not _clean(label) or not arg:
            continue
        e = by_job.setdefault(job, {"job": job, "entries": [], "source": "ipo"})
        if any(x["arg"] == arg for x in e["entries"]):
            continue
        e["entries"].append({"label": label, "slot": slot, "arg": arg,
                             "unused": bool(_UNUSED.search(label))})
    # a real table is a run of entries, not two strings that happened to line up
    out = []
    for t in by_job.values():
        if len(t["entries"]) < 3:
            continue
        t["entries"].sort(key=lambda x: x["slot"])
        t["supported"] = sum(1 for x in t["entries"] if not x["unused"])
        out.append(t)
    return out


def extract(path):
    """Everything layer 1 can see in one .IPO. No interpretation."""
    with open(path, "rb") as f:
        data = f.read()
    name = os.path.basename(path)[:-4]
    return {"ecu": name, "file": os.path.basename(path),
            "fields": fields(data), "captions": captions(data),
            "softkeys": softkeys(data), "tables": tables(data)}


def decodable(rec):
    return bool(rec["fields"] or rec["captions"] or rec["softkeys"])


def ipo_paths():
    """Every .IPO in SGDAT, whichever case BMW shipped it in.

    CASE-INSENSITIVE ON PURPOSE (same fix as ipo_ir.py). BMW shipped
    SGDAT with both spellings -- 763 files are *.IPO and 1025 are *.ipo
    -- so a glob of "*.IPO" on a case-sensitive filesystem silently
    lifted less than half the corpus. And on a CASE-INSENSITIVE
    filesystem globbing both patterns returns the same file twice, so
    dedupe by lowered stem: a directory holding both FOO.IPO and
    foo.ipo yields one path.
    """
    seen, out = set(), []
    for p in sorted(glob.glob(os.path.join(SGDAT, "*"))):
        if not p.lower().endswith(".ipo"):
            continue
        stem = os.path.basename(p)[:-4]
        if stem.lower() in seen:
            continue
        seen.add(stem.lower())
        out.append(p)
    return out


def ipo_path(ecu):
    """One ECU's .IPO, tolerating either extension case.

    Hardcoding + ".IPO" only ever worked because APFS is
    case-insensitive; on Linux it misses the 1025 lowercase files.
    Falls back to the .IPO spelling so callers' "no such .IPO"
    error paths still fire on a genuinely missing ECU.
    """
    for ext in (".IPO", ".ipo"):
        p = os.path.join(SGDAT, ecu + ext)
        if os.path.exists(p):
            return p
    return os.path.join(SGDAT, ecu + ".IPO")


def corpus(paths=None):
    for p in (paths or ipo_paths()):
        yield extract(p)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

    if args:                                # one ECU, full detail
        path = ipo_path(args[0])
        if not os.path.exists(path):
            print(f"no such .IPO: {args[0]}", file=sys.stderr)
            return 1
        print(json.dumps(extract(path), ensure_ascii=False, indent=1))
        return 0

    recs = list(corpus())
    ok = [r for r in recs if decodable(r)]
    tot = {k: sum(len(r[k]) for r in ok)
           for k in ("fields", "captions", "softkeys", "tables")}
    print(f"{len(recs)} .IPO files, {len(ok)} decodable "
          f"({len(recs) - len(ok)} with no readable screen data)\n")
    for k, v in tot.items():
        print(f"   {k:9} {v}")

    if write:
        os.makedirs(OUT, exist_ok=True)
        for r in ok:
            with open(os.path.join(OUT, r["ecu"] + ".json"), "w",
                      encoding="utf-8") as f:
                json.dump(r, f, ensure_ascii=False, indent=1)
        index = {r["ecu"]: {k: len(r[k]) for k in
                            ("fields", "captions", "softkeys", "tables")}
                 for r in ok}
        with open(os.path.join(OUT, "_index.json"), "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=1)
        print(f"\nwrote {len(ok)} files -> {os.path.relpath(OUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
