#!/usr/bin/env python3
"""Mine INPA's Read memory screen (root "Read memory" / "Speicher lesen").

The screen is a hex dump: pick a region, give an address and a byte count.
INPA prints each region's own limits beside it, so the bounds come from the
file rather than a guess:

    RAM   'Read RAM'   'Address 000000-FFFFFF'  'Number of bytes 1-250'
    ROM   'Read ROM'   'Address 000000-FFFFFF'  'Number of bytes 1-250'

tools/ms45_special.py decoded this for MS45 alone -- it is pinned to
MS450.IPO -- so every other ECU fell back to a bare "Read memory" job tile.
This reads it for any ECU that declares one in the token/caption/limits form
above.

MS45 itself is NOT one of them: it titles the screen "MS45 Read memory" and
lists its regions as softkeys ("< F1 >  Memory lin. reading"), a different
dialect that ms45_special.py already decodes into a hand-verified layout. This
tool deliberately leaves it there rather than half-reading it.

The region TOKEN is what goes in front of the job's argument (MS45 sends
"LAR;0x0000;16"), and it is the short caption INPA prints above the long one:
'RAM' over 'Read RAM', 'LAR' over 'Memory lin. reading'.

Read-only: decodes an .IPO, never talks to a car.

    python3 tools/ipo_memory.py             # corpus summary
    python3 tools/ipo_memory.py GSDS2       # one ECU
    python3 tools/ipo_memory.py --write     # data/inpa-screens/_memory.json
"""
import os
import re
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
import ipo_screens as L1                                        # noqa: E402

OUT = L1.OUT

# the screen title INPA prints over the dump
_TITLE = re.compile(rb"\x06(Read memory|Speicher lesen|Memory read)\x0a")

# a region: short token, long caption, then its declared limits. The warning
# text between them varies, so the address line is found by pattern, not offset.
_STR = re.compile(rb"\x06([\x20-\x7e\xa0-\xff]{1,60})\x0a")
_ADDR = re.compile(r"Address\s+([0-9A-Fa-f]{2,8})\s*-\s*([0-9A-Fa-f]{2,8})")
_BYTES = re.compile(r"[Nn]umber of bytes\s+(\d+)\s*-\s*(\d+)")

# a region token: short, upper-case-ish identifier, and NOT a bare hex number
_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_]{1,11}")
# ...but a run of hex digits is an ADDRESS, not a token: "FFFFFFFF" satisfies
# the identifier shape and is the upper bound printed under the region
_HEXNUM = re.compile(r"[0-9A-Fa-f]{4,}$")
_CHROME = re.compile(r"^(Exit|Print|Back|End|Ende|Select|Deselect|Read memory|"
                     r"Speicher lesen)$", re.I)

# the job the screen runs
_JOB = re.compile(rb"\x06(SPEICHER_LESEN[A-Z_]*|RAM_LESEN|ROM_LESEN)\x0a")

# how far past the title one screen's regions run
_SPAN = 1400


def regions(data, start, end):
    """Every region on the screen, with INPA's own bounds."""
    strs = [(m.start(), m.group(1).decode("latin-1").strip())
            for m in _STR.finditer(data, start, end)]
    out, i = [], 0
    while i < len(strs):
        _, token = strs[i]
        # A region opens with a short TOKEN followed by its longer caption.
        # The token is the identifier sent to the ECU (RAM / ROM / LAR / ROMX),
        # so it must look like one: bare hex ("3F9800") is the address line and
        # chrome ("Exit", "Print") is INPA's own UI, and taking either as a
        # token produced regions the ECU would reject.
        if (_TOKEN.fullmatch(token) and not _CHROME.match(token)
                and not _HEXNUM.match(token)
                and i + 1 < len(strs)
                and strs[i + 1][1].lower().startswith(("read ", "lese", "memory",
                                                       "sram", "user", "ext"))):
            caption = strs[i + 1][1]
            lo = hi = None
            nmin = nmax = None
            # scan ahead for this region's limits, stopping at the next token
            for _, s in strs[i + 2:i + 12]:
                a = _ADDR.search(s)
                if a and lo is None:
                    lo, hi = a.group(1), a.group(2)
                b = _BYTES.search(s)
                if b and nmin is None:
                    nmin, nmax = int(b.group(1)), int(b.group(2))
                if lo and nmin:
                    break
            if lo:
                out.append({"token": token, "label": caption,
                            "low": "0x" + lo.upper(), "high": "0x" + hi.upper(),
                            "start": "0x" + lo.upper(),
                            "maxBytes": nmax or 250, "source": "ipo"})
                i += 2
                continue
        i += 1
    # an ECU emits the screen once per variant; drop repeats
    seen, uniq = set(), []
    for r in out:
        if r["token"] in seen:
            continue
        seen.add(r["token"])
        uniq.append(r)
    return uniq


def extract(path):
    with open(path, "rb") as f:
        data = f.read()
    ecu = os.path.basename(path)[:-4]
    t = _TITLE.search(data)
    if not t:
        return {"ecu": ecu, "memory": None}

    regs = regions(data, t.end(), t.end() + _SPAN)
    if not regs:
        return {"ecu": ecu, "memory": None}

    j = _JOB.search(data)
    return {"ecu": ecu, "memory": {
        "title": t.group(1).decode("latin-1"),
        "caption": "hex dump — pick a region, then an address",
        "job": j.group(1).decode("latin-1") if j else None,
        "regions": regs,
    }}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

    if args:
        rec = extract(L1.ipo_path(args[0]))
        m = rec["memory"]
        if not m:
            print(f"{rec['ecu']}: no Read memory screen")
            return 0
        print(f"{rec['ecu']}: {m['title']} via {m['job']}\n")
        for r in m["regions"]:
            print(f"   {r['token']:10} {r['label'][:26]:28} "
                  f"{r['low']}-{r['high']}  max {r['maxBytes']} bytes")
        return 0

    results, regs = {}, 0
    for path in L1.ipo_paths():
        rec = extract(path)
        if not rec["memory"]:
            continue
        results[rec["ecu"]] = rec["memory"]
        regs += len(rec["memory"]["regions"])

    print(f"{len(results)} ECUs with a Read memory screen, {regs} regions")

    if write:
        os.makedirs(OUT, exist_ok=True)
        dest = os.path.join(OUT, "_memory.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        print(f"wrote {len(results)} ECUs -> {os.path.relpath(dest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
