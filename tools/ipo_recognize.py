#!/usr/bin/env python3
"""Layer 2: recognise INPA screens in layer-1 output — reads only.

Layer 1 says what strings are in an .IPO. This says what SCREEN they form, and
only when the evidence is strong enough to name one.

The corpus is not 763 unique designs. 763 files share 85 root-menu signatures,
and the top four cover nearly half of them:

    Information / Identification / Error memory / Read status / Activate
    Information / Identification / Coding / Error memory / Read status

So a recogniser is a rule that fires across hundreds of ECUs at once. Each one
claims a set of fields; whatever no recogniser claims is REPORTED, not dropped,
so a screen we cannot name shows up as work to do rather than vanishing.

Two rules this module will not break, both learned the hard way on MS45:

  * Never invent a screen. INPA has no Service menu and no flash screen on
    MS45; a recogniser that finds nothing must return nothing rather than
    assembling a plausible-looking page out of loose jobs.
  * Reads only. Layer 1 decodes actuator/adaptation arguments perfectly well,
    but an argument that has never been sent to a car is a hypothesis. Tables
    are carried through as `writes_unverified` for review and are NOT emitted
    as runnable screens.

    python3 tools/ipo_recognize.py                # corpus summary
    python3 tools/ipo_recognize.py MS450          # one ECU's screens
    python3 tools/ipo_recognize.py --write        # data/inpa-screens/_recognized.json
    python3 tools/ipo_recognize.py --unclaimed    # what nothing recognised
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

# ---------------------------------------------------------------------------
# recognisers
#
# Each takes layer-1 output and returns a screen dict or None. A screen carries
# the fields it claimed, so the caller can tell what is left over.
# ---------------------------------------------------------------------------

# the identity card: ECU part number, hardware/software versions, build date.
# Present on nearly every BMW ECU under some spelling of "Identification".
_IDENT_KEY = re.compile(r"^ID_|^IDENT|_NR$|_INDEX$|_DATUM$|SERIENNUMMER|"
                        r"HARDWARE|SOFTWARE|REFERENZ|PRUEFCODE", re.I)
# the AIF/UIF programming log
_AIF_KEY = re.compile(r"^AIF_|^UIF_", re.I)


def _claim(rec, pred):
    """Fields matching pred, from whichever dialect carries them."""
    out, seen = [], set()
    for f in rec["fields"] + rec["captions"]:
        if f["key"] in seen or not pred(f["key"]):
            continue
        seen.add(f["key"])
        out.append(f)
    return out


def recognise_identity(rec):
    got = _claim(rec, lambda k: _IDENT_KEY.search(k) and not _AIF_KEY.match(k))
    # an ident card is several fields agreeing, not one stray match
    if len(got) < 4:
        return None
    return {"screen": "identity", "title": "ID-data",
            "caption": "ECU identity · read-only", "fields": got,
            "confidence": "high" if len(got) >= 8 else "medium"}


def recognise_aif(rec):
    got = _claim(rec, lambda k: _AIF_KEY.match(k))
    if len(got) < 4:
        return None
    return {"screen": "aif", "title": "User information",
            "caption": "AIF · programming history", "fields": got,
            "confidence": "high" if len(got) >= 8 else "medium"}


RECOGNISERS = [recognise_identity, recognise_aif]


# ---------------------------------------------------------------------------

def recognise(rec):
    """All screens found in one ECU, plus what nothing claimed."""
    screens, claimed = [], set()
    for fn in RECOGNISERS:
        scr = fn(rec)
        if not scr:
            continue
        screens.append(scr)
        claimed.update(f["key"] for f in scr["fields"])

    unclaimed = [f for f in rec["fields"] + rec["captions"]
                 if f["key"] not in claimed]
    # de-dupe unclaimed by key, keeping first sighting
    seen, uniq = set(), []
    for f in unclaimed:
        if f["key"] in seen:
            continue
        seen.add(f["key"])
        uniq.append(f)

    return {"ecu": rec["ecu"], "screens": screens, "unclaimed": uniq,
            "softkeys": rec["softkeys"],
            # decoded but never sent to a car — review before trusting
            "writes_unverified": rec["tables"]}


def root_signature(rec):
    """The ECU's first few unshifted softkeys — its menu 'shape'."""
    keys = sorted((k for k in rec["softkeys"] if not k["shift"]),
                  key=lambda k: k["fkey"])
    out, seen = [], set()
    for k in keys:
        if k["fkey"] in seen:
            continue
        seen.add(k["fkey"])
        out.append(k["label"])
    return tuple(out[:5])


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv
    show_unclaimed = "--unclaimed" in sys.argv

    if args:
        path = os.path.join(L1.SGDAT, args[0] + ".IPO")
        if not os.path.exists(path):
            print(f"no such .IPO: {args[0]}", file=sys.stderr)
            return 1
        print(json.dumps(recognise(L1.extract(path)), ensure_ascii=False, indent=1))
        return 0

    results, stats = {}, collections.Counter()
    unclaimed_keys = collections.Counter()
    for rec in L1.corpus():
        if not L1.decodable(rec):
            stats["not decodable"] += 1
            continue
        r = recognise(rec)
        results[r["ecu"]] = r
        stats["ecus"] += 1
        for s in r["screens"]:
            stats[f"screen:{s['screen']}:{s['confidence']}"] += 1
        if not r["screens"]:
            stats["no screen recognised"] += 1
        if r["writes_unverified"]:
            stats["ecus with unverified write tables"] += 1
        for f in r["unclaimed"]:
            unclaimed_keys[f["key"]] += 1

    print(f"{stats['ecus']} decodable ECUs "
          f"({stats['not decodable']} skipped)\n")
    for k in sorted(stats):
        if k.startswith("screen:"):
            print(f"   {k[7:]:26} {stats[k]}")
    print()
    for k in ("no screen recognised", "ecus with unverified write tables"):
        print(f"   {k:34} {stats[k]}")

    if show_unclaimed:
        print(f"\n   {len(unclaimed_keys)} distinct unclaimed result keys; "
              f"most common (candidates for the next recogniser):")
        for key, n in unclaimed_keys.most_common(20):
            print(f"      {n:4}x  {key}")

    if write:
        os.makedirs(OUT, exist_ok=True)
        dest = os.path.join(OUT, "_recognized.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        print(f"\nwrote {len(results)} ECUs -> {os.path.relpath(dest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
