#!/usr/bin/env python3
"""Parse INPA .ips screen source into BMacW's _screen layout JSON.

INPA .ips files are the C-like *source* for the on-screen "Nacharbeitsprogramm"
masks (compiled to the .IPO blobs that tools/ipo_layout.py scrapes heuristically).
Parsing the source gives EXACT labels, units, jobs, result keys — and for the
declarative dialect, exact gauge min/max — no guessing.

Two dialects exist for value screens:

  DECLARATIVE (ms43_sp2, ms42_n):
      text(1,0,"max Überdrehzahl");            # row label
      text(2,0,"[1/min]");                     # unit in brackets
      INPAapiJob(sgbd,"STATUS_...","","");     # job + args
      ergebnisAnalogAusgabe("STAT_..._WERT", 3,0, 0.0, 10240.0, ...);
      #                      ^key                   ^min  ^max   (exact range!)

  IMPERATIVE (dkg_90, frm3):
      ftextout("Status Analogwerte 1 lesen",1,0,1,0);   # heading (4th arg = 1)
      INPAapiJob(sgbd,"STATUS_ISTWERTE_LESEN","","");   # one job per screen
      ftextout("Motortemperatur [°C]",1,0,0,1);          # row label (4th arg = 0)
      INPAapiResultAnalog(real_zahl,"STAT_MOTORTEMPERATUR_WERT",1);
      # label→key paired by source order; unit from the label's [..];
      # NO range in source → the app's rangeFor() unit heuristic supplies it.

Output matches the app's enriched layout shape served by /api/ecu/{sgbd}/layout:
    { "ecu": "<file>.ips", "screens": [ { group, job, args, render, columns,
        rows: [ { key, label, unit, min?, max? } ] } ], "inputs": [] }

Screens whose rows drive DIFFERENT jobs are split into one screen per job,
because the renderer (live.js showInpaScreen) polls a single screen.job.
Labels stay German; the app's translate.js does the English pass at render time.
Deterministic, no LLM.

Usage:
    ips_layout.py <file.ips> [--json]          one file, summary or JSON
    ips_layout.py --emit-all <sgdat-dir> <out-dir> [--force]
                                               batch: write <base>.json per .ips
                                               (skips existing files unless --force,
                                               so hand-curated layouts are safe)
"""
import json
import re
import sys
from pathlib import Path

# INPA .ips are latin-1 (ISO-8859-1) with CRLF
ENC = "iso-8859-1"

# --- layout primitives -------------------------------------------------------
RE_SCREEN = re.compile(r'\bSCREEN\s+(\w+)\s*\([^)]*\)\s*\{', re.I)
RE_TEXT = re.compile(r'\btext\s*\(\s*(\d+)\s*,\s*\d+\s*,\s*"([^"]*)"', re.I)
RE_JOB = re.compile(r'\bINPAapiJob\s*\(\s*\w+\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"', re.I)
# ergebnisAnalogAusgabe("KEY", dispCol, dispRow, dispMin, dispMax, scaleMin, scaleMax)
RE_ANALOG = re.compile(
    r'\bergebnisAnalogAusgabe\s*\(\s*"([^"]+)"\s*,\s*\d+\s*,\s*\d+\s*,'
    r'\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)', re.I)
RE_DIGITAL = re.compile(r'\bergebnis(?:Digital|Text)Ausgabe\s*\(\s*"([^"]+)"', re.I)
RE_TITLE = re.compile(r'\b(?:ueberschrift|ueberschrift2)\s*\(\s*"([^"]*)"', re.I)

# imperative dialect: ftextout("text", row, col, attr, ...) — attr 1 = heading,
# attr 0 = plain row label. value reads land in a variable.
RE_FTEXT = re.compile(
    r'\bf?textout\s*\(\s*"([^"]*)"\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d+)', re.I)
RE_RESULT = re.compile(
    r'\bINPAapiResult(Analog|Int|Digital|Text)\s*\(\s*\w+\s*,\s*"([^"]+)"', re.I)
# a bracketed unit inside a label, e.g. "Motortemperatur [°C]" -> °C
RE_UNIT_IN_LABEL = re.compile(r'\[([^\]]*)\]\s*$')
# F-key menu rows ("< F1 >  Information") are navigation, never value labels
RE_FKEY = re.compile(r'<\s*(?:Shift\s*\+\s*)?F\d+\s*>', re.I)


def screen_blocks(src: str):
    """Yield (proc_name, body) for each SCREEN block, brace-matched."""
    for m in RE_SCREEN.finditer(src):
        name = m.group(1)
        i = m.end()  # just past the opening {
        depth = 1
        while i < len(src) and depth:
            c = src[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            i += 1
        yield name, src[m.end():i - 1]


def _humanize_proc(name: str) -> str:
    """s_status_analog1 -> 'Status analog 1' (fallback group title)."""
    t = re.sub(r'^s_', '', name).replace('_', ' ').strip()
    t = re.sub(r'(?<=[a-z])(\d+)$', r' \1', t)
    return (t[:1].upper() + t[1:]) if t else name


def _parse_declarative(body: str):
    """Rows for the declarative dialect (text()/ergebnis*Ausgabe). Exact ranges."""
    rows = []
    cur_label = None
    cur_unit = None
    cur_job = None
    cur_args = None
    group = None

    for m in re.finditer(
        r'(?P<title>\bueberschrift2?\s*\([^;]*)|'
        r'(?P<text>\btext\s*\([^;]*)|'
        r'(?P<job>\bINPAapiJob\s*\([^;]*)|'
        r'(?P<analog>\bergebnisAnalogAusgabe\s*\([^;]*)|'
        r'(?P<digital>\bergebnis(?:Digital|Text)Ausgabe\s*\([^;]*)',
        body, re.I,
    ):
        seg = m.group(0)
        if m.lastgroup == "title":
            t = RE_TITLE.search(seg)
            if t and t.group(1).strip():
                group = t.group(1).strip()
        elif m.lastgroup == "text":
            tm = RE_TEXT.search(seg)
            if not tm:
                continue
            slot, val = tm.group(1), tm.group(2).strip()
            if slot == "1":
                cur_label = val
            elif slot == "2":
                u = val.strip("[]").strip()
                cur_unit = "" if u in ("-", "") else u
        elif m.lastgroup == "job":
            jm = RE_JOB.search(seg)
            if jm:
                cur_job = jm.group(1) or None
                cur_args = jm.group(2) or None
        elif m.lastgroup == "analog":
            am = RE_ANALOG.search(seg)
            if not am:
                continue
            mn, mx = float(am.group(2)), float(am.group(3))
            rows.append({
                "key": am.group(1), "label": cur_label or am.group(1),
                "unit": cur_unit or "", "min": _num(mn), "max": _num(mx),
                "job": cur_job, "args": cur_args, "render": "analog",
            })
            cur_label = cur_unit = None  # consumed
        elif m.lastgroup == "digital":
            dm = RE_DIGITAL.search(seg)
            if not dm:
                continue
            rows.append({
                "key": dm.group(1), "label": cur_label or dm.group(1),
                "unit": cur_unit or "", "render": "text",
                "job": cur_job, "args": cur_args,
            })
            cur_label = cur_unit = None
    return rows, group


def _parse_imperative(body: str):
    """Rows + heading for the imperative dialect (ftextout + INPAapiResult).

    A numeric value row is an Analog/Int read preceded by the nearest literal
    ftextout row label (attr 0, has letters, not an F-key menu row). The unit is
    the label's trailing "[..]". ftextout with attr 1 is the screen heading.
    Text/Digital reads are idents/enums (ID screens), skipped for gauge layouts.
    """
    rows = []
    title = None
    cur_label = None
    tok = re.compile(
        r'(?P<label>\bf?textout\s*\(\s*"[^"]*"\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+)|'
        r'(?P<read>\bINPAapiResult(?:Analog|Int|Digital|Text)\s*\([^;]*)', re.I)
    for m in tok.finditer(body):
        if m.lastgroup == "label":
            lm = RE_FTEXT.search(m.group(0))
            if not lm:
                continue
            txt, attr = lm.group(1).strip(), lm.group(2)
            if not re.search(r'[A-Za-zÄÖÜäöü]', txt) or RE_FKEY.search(txt):
                continue
            if attr == "1":
                if title is None:
                    title = txt
            else:
                cur_label = txt
        else:
            rm = RE_RESULT.search(m.group(0))
            if not rm:
                continue
            kind, key = rm.group(1).lower(), rm.group(2)
            # only analog/int reads are gauge values; text/digital are idents/enums
            if kind not in ("analog", "int"):
                cur_label = None
                continue
            label = cur_label or key
            unit = ""
            um = RE_UNIT_IN_LABEL.search(label)
            if um:
                u = um.group(1).strip()
                unit = "" if u in ("-", "") else u
                label = RE_UNIT_IN_LABEL.sub("", label).strip()
            rows.append({"key": key, "label": label, "unit": unit,
                         "job": None, "args": None, "render": "analog"})
            cur_label = None  # consumed
    return rows, title


def parse_screens(name: str, body: str):
    """Turn one SCREEN body into 0..n screen dicts (split when rows drive
    different jobs, since the renderer polls a single screen.job)."""
    rows, group = _parse_declarative(body)
    if not rows:
        rows, group = _parse_imperative(body)
    if not rows:
        return []

    # screen-level job: from agreeing rows, else the body's single INPAapiJob
    named = [(j, a) for j, a in RE_JOB.findall(body) if j]
    body_job, body_args = (named[0][0], named[0][1] or None) \
        if len({j for j, _ in named}) == 1 else (None, None)
    for r in rows:
        if not r.get("job"):
            r["job"], r["args"] = body_job, body_args
    # a real gauge screen always knows its polling job. rows with none are ident/
    # menu screens mixing several jobs (addresses, AIF reads) — not layouts.
    rows = [r for r in rows if r.get("job")]
    if not rows:
        return []

    base_group = group or _humanize_proc(name)

    # split rows into per-(job,args) screens, preserving order
    groups = []           # [(job, args, rows)]
    for r in rows:
        j, a = r.get("job"), r.get("args")
        if groups and groups[-1][0] == j and groups[-1][1] == a:
            groups[-1][2].append(r)
        else:
            groups.append((j, a, [r]))

    out = []
    for j, a, rs in groups:
        # single-row split screens read best titled by their row label
        g = rs[0]["label"] if len(groups) > 1 and len(rs) == 1 else base_group
        clean = []
        for r in rs:
            rr = {"key": r["key"], "label": r["label"], "unit": r["unit"]}
            if r["render"] == "analog" and "min" in r:
                rr["min"], rr["max"] = r["min"], r["max"]
            clean.append(rr)
        out.append({
            "proc": name,
            "group": g,
            "job": j,
            "args": a or None,
            "render": "analog" if any(r["render"] == "analog" for r in rs) else "text",
            "columns": 2 if _looks_two_col(rs) else 1,
            "rows": clean,
        })
    return out


def _num(x: float):
    return int(x) if float(x).is_integer() else x


def _looks_two_col(rows):
    keys = [r["key"] for r in rows]
    # BMW banks its second sensor with a _2_ infix or trailing _2 before _WERT
    return any(re.search(r'_2_|_2_WERT$', k) for k in keys) and len(keys) >= 2


def parse_file(path: Path):
    src = path.read_bytes().decode(ENC)
    screens = []
    for name, body in screen_blocks(src):
        screens.extend(parse_screens(name, body))
    return {"ecu": path.name, "screens": screens, "inputs": []}


def emit_all(sgdat: Path, out: Path, force: bool):
    out.mkdir(parents=True, exist_ok=True)
    written = skipped = empty = 0
    for f in sorted(sgdat.glob("*.ips")):
        result = parse_file(f)
        if not result["screens"]:
            empty += 1
            continue
        dst = out / (f.stem.lower() + ".json")
        if dst.exists() and not force:
            print(f"  skip (exists): {dst.name}")
            skipped += 1
            continue
        dst.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n",
                       encoding="utf-8")
        n = len(result["screens"])
        print(f"  wrote {dst.name}: {n} screen(s)")
        written += 1
    print(f"\n{written} written, {skipped} skipped (existing), "
          f"{empty} with no screens")
    return 0


def main(argv):
    if len(argv) >= 4 and argv[1] == "--emit-all":
        return emit_all(Path(argv[2]), Path(argv[3]), "--force" in argv[4:])
    if len(argv) < 2:
        print(__doc__.strip().splitlines()[-6], file=sys.stderr)
        print("usage: ips_layout.py <file.ips> [--json] | "
              "--emit-all <sgdat-dir> <out-dir> [--force]", file=sys.stderr)
        return 2
    path = Path(argv[1])
    result = parse_file(path)
    if "--json" in argv[2:]:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    print(f"{result['ecu']}: {len(result['screens'])} screen(s)")
    for s in result["screens"]:
        print(f"\n  [{s['proc']}]  group={s['group']!r}"
              f"  job={s['job']}  cols={s['columns']}  render={s['render']}")
        for r in s["rows"]:
            rng = f"  [{r['min']}..{r['max']}]" if "min" in r else ""
            print(f"      {r['key']:<40} {r['label']:<38} {r['unit']:<8}{rng}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
