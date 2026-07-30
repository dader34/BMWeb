#!/usr/bin/env python3
"""Mine INPA's Coding screen (root F3) from an .IPO.

INPA's Coding screen is a labelled read, not a list of jobs. On ZKE5 the
bytecode reads:

    'Coding'                                       the screen title
    COD_LESEN                                      the job it runs
    'Coding'  ':'  DATENSICHERUNG_BLOCK_0          row 1
    'Block 0' ':'  COD_DATEN                       row 4

so it is the same caption/':'/result shape the Ident and AIF cards use — one
labelled field per row, with INPA's own wording. The job differs per ECU
(COD_LESEN, CODIERDATEN_LESEN, C_FG_LESEN, C_AEI_LESEN), which is why the job
is read from the file rather than assumed.

Measured: 83 of 763 .IPO files carry a decodable Coding screen (244 fields).
The rest either have no Coding key at all or describe it in a form this does
not read, and get nothing rather than a guess.

Read-only: decodes an .IPO, never talks to a car.

    python3 tools/ipo_coding.py            # corpus summary
    python3 tools/ipo_coding.py ZKE5       # one ECU
    python3 tools/ipo_coding.py --write    # data/inpa-screens/_coding.json
"""
import os
import re
import sys
import json
import glob

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
import ipo_screens as L1                                        # noqa: E402

OUT = L1.OUT

# push-int operand; DOTALL because value 10 encodes as \x0a
_P = rb"\x03(.)\x00"

# the coding read job, whichever spelling this ECU uses
_JOB = re.compile(rb"\x06(COD_LESEN|CODIER[A-Z_]*_LESEN|C_[A-Z]{2,4}_LESEN)\x0a")

# NOT anchored on a "Coding" heading. That was tried and is wrong: GSDS2 prints
# "Coding Data" as a SECTION LABEL inside its Ident screen (at 55940, well
# inside the IDENT block that starts at 54046), so a heading anchor walked
# backwards into Ident's rows and produced a Coding screen identical to
# Identity. An ECU with no coding-named job simply has no Coding screen to
# mine, and saying so beats duplicating another one.

# caption + 4 ints, ':' + 4 ints, result key — one labelled row
_FIELD = re.compile(rb"\x06([\x20-\x7e\xa0-\xff]{2,40})\x0a" + _P * 4
                    + rb"\x06:\x0a" + _P * 4
                    + rb"\x06([A-Z][A-Z0-9_]{3,})\x0a", re.DOTALL)

# how far past the job name one screen's rows run
_SPAN = 600


def extract(path):
    with open(path, "rb") as f:
        data = f.read()
    m = _JOB.search(data)
    if not m:
        return {"ecu": os.path.basename(path)[:-4], "coding": None}

    job = m.group(1).decode("latin-1")
    fields, seen = [], set()
    for f in _FIELD.finditer(data, m.end(), m.end() + _SPAN):
        key = f.group(10).decode("latin-1")
        label = f.group(1).decode("latin-1").strip()
        if key in seen or not L1._clean(label):
            continue
        seen.add(key)
        fields.append({"key": key, "label": label.rstrip(": "),
                       "row": f.group(2)[0], "source": "ipo"})
    if not fields:
        return {"ecu": os.path.basename(path)[:-4], "coding": None}

    fields.sort(key=lambda x: x["row"])
    return {"ecu": os.path.basename(path)[:-4],
            "coding": {"title": "Coding", "subtitle": "coding data · read-only",
                       "job": job,
                       "fields": [{k: v for k, v in f.items() if k != "row"}
                                  for f in fields]}}


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

    results, fields = {}, 0
    for path in sorted(glob.glob(os.path.join(L1.SGDAT, "*.IPO"))):
        rec = extract(path)
        if not rec["coding"]:
            continue
        results[rec["ecu"]] = rec["coding"]
        fields += len(rec["coding"]["fields"])

    print(f"{len(results)} ECUs with a Coding screen, {fields} fields")

    if write:
        os.makedirs(OUT, exist_ok=True)
        dest = os.path.join(OUT, "_coding.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        print(f"wrote {len(results)} ECUs -> {os.path.relpath(dest)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
