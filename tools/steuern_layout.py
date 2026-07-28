#!/usr/bin/env python3
"""Mine actuator-test (STEUERN_) labels from the INPA .IPO/.ips frontends.

INPA compiles each actuator test as a pair of blocks: the start job
(``STEUERN_X``) and its stop job (``STEUERN_X_ENDE``). Only the stop block
carries a human caption -- the "...Ansteuerung beendet!" acknowledgement INPA
prints when the test ends. The start block holds nothing but the job name and
its JOB_STATUS/OKAY check, so a nearest-string scan from the start job walks
into the NEXT actuator's caption and mislabels almost every entry
(STEUERN_TEV picking up 'KFK-Ansteuerung beendet!', both O2 banks swapping).

So: read the caption out of the _ENDE block and attach it to the start job,
then strip the acknowledgement wording down to the component name.

Output: {sgbd: {job: {"label": str, "raw": str}}} as JSON, for the
Activations section (MenuGen.Activations supplies the job pairing; this
supplies the names INPA actually shows).

    python3 tools/steuern_layout.py                 # write data/steuern-labels.json
    python3 tools/steuern_layout.py --print MS450   # dump one ECU to stdout
"""
import re
import os
import sys
import json
import glob

SGDAT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "..", "vendor", "EC-APPS", "INPA", "SGDAT")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "data", "steuern-labels.json")

# printable runs, latin-1: the .IPO keeps German captions in CP1252/latin-1
_RUN = re.compile(rb"[\x20-\x7e\xa0-\xff]{3,}")
# a bare code token, result name, or number is never a caption
_NOISE = re.compile(r"^(JOB_STATUS|OKAY|ERROR|[A-Z0-9_]+|[\d.,;x\s+-]+)$")
_STOP = re.compile(r"^(STEUERN_[A-Z0-9_]+?)_(ENDE|AUS|STOP)$")

# INPA screen chrome and job-failure text: these sit in the same string pool and
# would otherwise be captured as an actuator's name
_CHROME = re.compile(
    r"fehler\s+bei|job-?status|^\s*(drucken|print|info|status|auswahl|selection"
    r"|aktive\s+fehlermeldung|ende|exit|zur(ü|ue)ck|back|weiter)\s*$"
    r"|^\s*(activate|ansteuern|steuern|aktivieren|ein|aus|on|off|start|stop)\s*$",
    re.I)

# acknowledgement wording INPA appends to the component name; stripped so the
# button reads "E-Lüfter", not "E-Lüfteransteuerung beendet!"
_STRIP = [
    (re.compile(r"\s*-?\s*ansteuerung\s+beendet\s*!?\s*$", re.I), ""),
    (re.compile(r"\s*ansteuerung\s*$", re.I), ""),
    (re.compile(r"^\s*status\s+", re.I), ""),
    (re.compile(r"\s+(ein|aus|on|off)\s*$", re.I), ""),
    (re.compile(r"\s*!+\s*$"), ""),
]


def ipo_strings(path):
    """Printable latin-1 runs in file order (the .IPO string pool)."""
    with open(path, "rb") as f:
        data = f.read()
    return [m.group(0).decode("latin-1") for m in _RUN.finditer(data)]


def is_caption(s):
    """A human-readable caption, not a code token / result name / number."""
    s = s.strip()
    if not 4 <= len(s) <= 60:
        return False
    if _NOISE.fullmatch(s):
        return False
    if s.startswith(("STEUERN", "STATUS_", "STAT_", "_TEL", "ergebnis")):
        return False
    if _CHROME.search(s):
        return False
    return bool(re.search(r"[a-zäöüß]", s))


def clean(caption):
    """Acknowledgement text -> component name."""
    s = caption.strip()
    for pat, rep in _STRIP:
        s = pat.sub(rep, s)
    return s.strip(" -:\t") or caption.strip()


def mine(path):
    """{start_job: {"label", "raw"}} for one .IPO/.ips file."""
    seq = ipo_strings(path)
    out = {}
    for i, s in enumerate(seq):
        m = _STOP.fullmatch(s)
        if not m:
            continue
        start = m.group(1)
        if start in out:
            continue
        # the caption sits just past the stop job, before the next block's
        # JOB_STATUS/OKAY check
        for nxt in seq[i + 1:i + 6]:
            if not is_caption(nxt):
                continue
            label = clean(nxt)
            # stripping the acknowledgement can leave bare chrome ("Status")
            if len(label) < 2 or _CHROME.search(label):
                continue
            out[start] = {"label": label, "raw": nxt.strip()}
            break
    return out


def main():
    args = sys.argv[1:]
    want = None
    if "--print" in args:
        want = args[args.index("--print") + 1].lower()

    files = sorted(glob.glob(os.path.join(SGDAT, "*.[iI][pP][oO]"))
                   + glob.glob(os.path.join(SGDAT, "*.[iI][pP][sS]")))
    result = {}
    for f in files:
        sgbd = os.path.splitext(os.path.basename(f))[0].lower()
        if want and sgbd != want:
            continue
        found = mine(f)
        if found:
            result[sgbd] = found

    if want:
        for sgbd, jobs in result.items():
            print(f"# {sgbd}  ({len(jobs)} actuators)")
            for job in sorted(jobs):
                print(f"  {job:32} {jobs[job]['label']!r}"
                      f"   (raw: {jobs[job]['raw']!r})")
        return 0

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1, sort_keys=True)
    total = sum(len(v) for v in result.values())
    print(f"{total} actuator labels across {len(result)} ECUs -> "
          f"{os.path.relpath(OUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
