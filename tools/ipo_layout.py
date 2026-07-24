#!/usr/bin/env python3
"""
ipo_layout.py: extract INPA screen layouts from compiled .IPO files.

Compiled .IPO files retain readable strings describing each screen: display
labels, the EDIABAS result keys they bind to, the job + args producing them, the
render type (analog gauge vs digital text), units, and input prompts.

Reproduces INPA's on-screen layout deterministically (no LLM) so BMacW renders
the same labels/units/ranges and knows which functions need input.

Usage:
    ipo_layout.py <file.IPO> [--json]        # one ECU
    ipo_layout.py --base <name> [--json]     # resolve <name>.IPO in SGDAT
    ipo_layout.py --list                     # list ECU base names

Heuristics from the observed string layout in BMW MSD/MSV/MEVD .IPOs:
  - label list (comma-sep) immediately followed by a result-key list
    (semicolon-sep STAT_*_WERT / *_WERT names).
  - nearest preceding EDIABAS job token (MESSWERTBLOCK_LESEN, STATUS_LESEN,
    STATUS_*, MESSWERTE_*) plus any hex/arg line after it give the call.
  - ergebnisAnalogAusgabe nearby = gauge bars; ergebnisDigitalAusgabe = text.
  - lines with 'input'/'Eingabe'/'parameter input' = input-required.
"""
import sys, os, re, json, subprocess

SGDAT = os.path.join(os.path.dirname(__file__), "..", "vendor", "EC-APPS",
                     "INPA", "SGDAT")

# EDIABAS jobs driving a measurement/status screen
JOB_RE = re.compile(r'^(MESSWERTBLOCK_LESEN|MESSWERTE_LESEN|STATUS_LESEN|'
                    r'STATUS_[A-Z0-9_]+|MW_[A-Z0-9_]+|MESSWERT[A-Z0-9_]*|'
                    r'LESE_[A-Z0-9_]+|[A-Z0-9_]*_LESEN)$')
RESULTKEY_RE = re.compile(r'^[A-Z0-9_]+_WERT(;[A-Z0-9_]+_WERT)*$')
HEXARG_RE = re.compile(r'^(0x[0-9A-Fa-f]+)(,0x[0-9A-Fa-f]+)*$')

# Triplet dialect (MS45.x etc.): value/label/unit keys on their own lines.
# A "real" job actually produces results (STATUS_* / MESSWERTBLOCK_LESEN);
# JOB_STATUS is an INPA screen-flow sentinel, not a result-producing job, so it
# is treated as transparent when attributing rows.
REALJOB_RE = re.compile(r'^(STATUS_[A-Z0-9_]+|MESSWERTBLOCK_LESEN|'
                        r'MESSWERTE_LESEN)$')
WERT_RE = re.compile(r'^([A-Z0-9_]+)_WERT$')
TEXTKEY_RE = re.compile(r'^[A-Z0-9_]+_TEXT$')
EINHKEY_RE = re.compile(r'^[A-Z0-9_]+_EINH$')
ANYKEY_RE = re.compile(r'^[A-Z0-9_]+_(WERT|TEXT|EINH|SOLL)$')
# a [unit] bracket or a bare unit token
UNITBRACKET_RE = re.compile(r'^\[([^\]]+)\]$')
UNIT_RE = re.compile(r'^\s*-?\d*\s*(%|mg/stk|mg/hub|V|A|°C|°KW|°|1/min|rpm|U/min|'
                     r'km/h|mbar|hpa|bar|Nm|ms|l/h|ohm|g/s|kPa)\s*$', re.I)
INPUT_RE = re.compile(r'(parameter input|input Coding|input clima|Eingabe|'
                      r'eingeben|geben sie|request telegram|abfrage\b)', re.I)


def ipo_strings(path):
    """readable strings from a compiled .IPO, in file order"""
    try:
        out = subprocess.run(["strings", "-n", "3", path], capture_output=True,
                             text=True, errors="replace").stdout
    except FileNotFoundError:
        with open(path, "rb") as f:
            data = f.read()
        out = "".join(c if 32 <= ord(c) < 127 else "\n"
                      for c in data.decode("latin-1"))
    return [ln.rstrip() for ln in out.splitlines()]


def fix_de(s):
    """normalise spacing; CP1252/umlaut mangling is lossy so not repaired"""
    return re.sub(r"\s+", " ", s).strip()


# --- INPA F-key menu tree (from raw .IPO bytecode) ---------------------------
# Compiled INPA screens keep the on-screen F-key bar as a MENU of ITEMs. The
# bytecode encodes each menu entry as a fixed opcode:
#
#     m_<name>\n                         menu header (a printable token)
#       ...
#     24 0a 00 00 <fkey> 00 <label>\n    ITEM(<fkey>, "<label>")
#
# where <fkey> is the F-key number (F1..F20; 9=Print, 10/20=Back/Exit by INPA
# convention) and <label> is the softkey caption shown in the bottom bar. The
# `strings` pass drops these opcodes, so we scan the raw bytes: this is the ONLY
# place the real F-key structure survives for ECUs with no .ips source (MS45.x).
# Ref → target-screen resolution isn't in the string itself (it's a setscreen
# pointer in surrounding bytecode); the label carries the meaning and the app
# resolves it to a mined screen by matching group/label at render time.
_RE_MENU_HDR = re.compile(rb'(m_[a-z0-9_]+)\x0a')
_RE_ITEM = re.compile(
    rb'\x24\x0a\x00\x00(.)\x00([\x20-\x7e\xc0-\xff][\x20-\x7e\xc0-\xff /.\-+]*?)\x0a')
# proc/menu declaration: 0c 81 <len> 00 <type=01 screen|02 menu> <name>\n <id> 00 00 00 0a
_RE_DECL = re.compile(
    rb'\x0c\x81.\x00([\x01\x02])([a-z][a-z0-9_]+)\x0a(.)\x00\x00\x00\x0a')
# after an ITEM's label, a setscreen/setmenu call: opcode (0x40/0x3e screen,
# 0x41/0x3f menu) followed by the target's 1-byte declaration id
_ITEM_CALL_OPS = (0x40, 0x3e, 0x41, 0x3f)
# standard INPA softkeys that are navigation, not category pages
_MENU_NAV_LABELS = {"Drucken", "Zurück", "Zurueck", "ENDE", "Ende", "Exit",
                    "Gesamt", "Auswahl"}


def _decl_tables(data):
    """id -> proc/menu name, split by namespace (screens vs menus)."""
    screens, menus = {}, {}
    for m in _RE_DECL.finditer(data):
        typ, name, pid = m.group(1)[0], m.group(2).decode("latin-1"), m.group(3)[0]
        (menus if typ == 2 else screens).setdefault(pid, name)
    return screens, menus


def _item_target(data, item_end, screens, menus):
    """Resolve the screen/menu an ITEM opens by decoding the setscreen/setmenu
    call in the bytes right after its label. Returns (target_name, kind) or
    (None, None) for inline-job items (e.g. MWB blocks that just set an arg)."""
    tail = data[item_end:item_end + 16]
    for k in range(len(tail) - 1):
        if tail[k] in _ITEM_CALL_OPS:
            op, tid = tail[k], tail[k + 1]
            if op in (0x41, 0x3f) and tid in menus:
                return menus[tid], "menu"
            if tid in screens:
                return screens[tid], "screen"
            if tid in menus:
                return menus[tid], "menu"
            return None, None
    return None, None


def extract_menus(path):
    """Decode the INPA F-key menu tree from raw .IPO bytecode.

    Returns a list of menus, each ``{"name": "m_status", "items": [{"fkey": 1,
    "label": "Digital", "target": "s_digital", "target_kind": "screen"}, ...]}``.
    Items are grouped under the menu header they follow, in file order; `target`
    is the screen proc or submenu the F-key opens (null for inline-job items).
    Empty if the file carries no menu opcodes.
    """
    data = open(path, "rb").read()
    screens, menus_tbl = _decl_tables(data)

    events = []
    for m in _RE_MENU_HDR.finditer(data):
        events.append((m.start(), "menu", m.group(1).decode("latin-1"), None))
    for m in _RE_ITEM.finditer(data):
        fkey = m.group(1)[0]
        label = fix_de(m.group(2).decode("latin-1"))
        if label:
            tgt, kind = _item_target(data, m.end(), screens, menus_tbl)
            events.append((m.start(), "item", (fkey, label), (tgt, kind)))
    events.sort(key=lambda e: e[0])

    menus, order, cur = {}, [], None
    for _off, kind, payload, extra in events:
        if kind == "menu":
            cur = payload
            if cur not in menus:
                menus[cur] = []
                order.append(cur)
        elif kind == "item" and cur is not None:
            fkey, label = payload
            tgt, tkind = extra
            nav = label in _MENU_NAV_LABELS
            # skip duplicate opcodes the string table sometimes repeats
            if not any(it["fkey"] == fkey and it["label"] == label
                       for it in menus[cur]):
                menus[cur].append({"fkey": fkey, "label": label, "nav": nav,
                                   "target": tgt, "target_kind": tkind})
    return [{"name": n, "items": menus[n]} for n in order if menus[n]]


def looks_like_labels(s):
    if ";" in s or "_WERT" in s:
        return False
    if not ("," in s or len(s.split()) >= 2):
        return False
    # need at least one alpha word of len>=3
    if not re.search(r"[A-Za-zÄÖÜäöü]{3,}", s):
        return False
    # exclude code tokens
    if re.match(r"^[a-z_]+$", s) and "," not in s:
        return False
    return True


def _is_human_label(s):
    """a display label, not a code token / key / sentinel / hex / arg."""
    if not s:
        return False
    if ANYKEY_RE.match(s) or JOB_RE.match(s):
        return False
    if s in ("OKAY", "JOB_STATUS") or s.startswith("0x"):
        return False
    if ";" in s:            # semicolon key-mask line
        return False
    if not re.search(r"[A-Za-zÄÖÜäöü]{2,}", s):
        return False
    if re.fullmatch(r"[a-z_0-9]+", s):   # lowercase code token (proc/var name)
        return False
    return True


def _unit_near(lines, i):
    """unit for the WERT at line i: a [bracket] or bare unit token nearby."""
    for j in range(max(0, i - 4), min(len(lines), i + 4)):
        s = lines[j].strip()
        m = UNITBRACKET_RE.match(s)
        if m:
            return m.group(1).strip()
        if UNIT_RE.match(s):
            return s.strip()
    return None


def extract_triplets(lines):
    """Extract single-value screens in the TEXT/EINH/WERT triplet dialect.

    Each result value appears as its own `X_WERT` line, usually preceded by the
    sibling `X_TEXT` / `X_EINH` key lines, and grouped under the nearest
    preceding result-producing job (STATUS_* / MESSWERTBLOCK_LESEN).  All WERT
    keys sharing a job become the rows of one screen — mirroring how INPA polls
    one job per status screen and lists its values.

    Returns a list of screen dicts, or [] if this dialect isn't present.
    """
    has_triplet = any(TEXTKEY_RE.match(l) or EINHKEY_RE.match(l) for l in lines)
    if not has_triplet:
        return []

    cur_job = cur_args = None
    order = []                      # jobs in first-seen order
    rows_by_job = {}                # job -> list of (key, label, unit)
    seen_by_job = {}                # job -> set(keys) for de-dupe

    for i, ln in enumerate(lines):
        if REALJOB_RE.match(ln):
            cur_job = ln
            cur_args = None
            continue
        if HEXARG_RE.match(ln) and cur_job and cur_args is None:
            cur_args = ln
            continue
        # JOB_STATUS and every non-job line leave cur_job unchanged (transparent)
        m = WERT_RE.match(ln)
        if not (m and cur_job):
            continue
        seen = seen_by_job.setdefault(cur_job, set())
        if ln in seen:
            continue
        seen.add(ln)
        # label: prefer the human label immediately following the WERT (INPA
        # emits the display string right after the value key), else the nearest
        # human label just before the triplet block.
        label = None
        after = lines[i + 1] if i + 1 < len(lines) else ""
        if _is_human_label(after):
            label = after
        else:
            for j in range(i - 1, max(-1, i - 5), -1):
                if _is_human_label(lines[j]):
                    label = lines[j]
                    break
        unit = _unit_near(lines, i)
        if cur_job not in rows_by_job:
            order.append(cur_job)
            rows_by_job[cur_job] = []
        rows_by_job[cur_job].append((ln, fix_de(label) if label else None, unit))

    screens = []
    for job in order:
        rows = rows_by_job[job]
        keys = [r[0] for r in rows]
        labels = [r[1] for r in rows]
        units = [r[2] for r in rows if r[2]]
        screens.append({
            "job": job,
            "args": None,
            "result_keys": keys,
            "labels": labels,
            "render": "analog",
            "units": sorted(set(units)),
        })
    return screens


def extract(path):
    lines = ipo_strings(path)
    screens = []
    inputs = []
    last_job = None
    last_args = None

    for i, ln in enumerate(lines):
        if JOB_RE.match(ln):
            last_job = ln
            last_args = None
            continue
        if HEXARG_RE.match(ln) and last_job and last_args is None:
            last_args = ln
            continue
        if INPUT_RE.search(ln):
            inputs.append({"prompt": fix_de(ln), "near_job": last_job})
            continue
        # label list followed by result-key list = a screen row group
        if RESULTKEY_RE.match(ln):
            keys = ln.split(";")
            label_line = lines[i - 1] if i > 0 else ""
            labels = [fix_de(x) for x in label_line.split(",")] \
                if looks_like_labels(label_line) else []
            # scan a small window for analog/digital markers + units
            window = " ".join(lines[max(0, i - 6):i + 4])
            render = ("analog" if "ergebnisAnalog" in window
                      else "digital" if "ergebnisDigital" in window
                      else "value")
            units = UNIT_RE.findall(" ".join(lines[max(0, i - 3):i + 3]))
            screens.append({
                "job": last_job,
                "args": last_args,
                "result_keys": keys,
                "labels": labels if len(labels) == len(keys) else labels[:len(keys)],
                "render": render,
                "units": [u for u in units] if units else [],
            })

    # de-dupe; strings table often repeats screens
    seen, uniq = set(), []
    for s in screens:
        sig = (s["job"], tuple(s["result_keys"]))
        if sig in seen:
            continue
        seen.add(sig)
        uniq.append(s)

    # Triplet dialect (MS45.x): single-value screens grouped by job. Fires only
    # when TEXT/EINH keys are present, so comma/semicolon-list ECUs are
    # untouched. Where a job is covered by grouped triplets, that grouped screen
    # supersedes any fragmentary single-key rows from the pass above.
    triplets = extract_triplets(lines)
    if triplets:
        triplet_jobs = {t["job"] for t in triplets}
        uniq = [s for s in uniq if s["job"] not in triplet_jobs] + triplets

    menus = extract_menus(path)
    return {"ecu": os.path.basename(path), "screens": uniq, "inputs": inputs,
            "menus": menus}


def resolve(base):
    for ext in (".IPO", ".ipo"):
        p = os.path.join(SGDAT, base + ext)
        if os.path.exists(p):
            return p
    return None


def main():
    args = sys.argv[1:]
    as_json = "--json" in args
    args = [a for a in args if a != "--json"]
    if not args:
        print(__doc__)
        return 2
    if args[0] == "--list":
        bases = sorted({os.path.splitext(f)[0]
                        for f in os.listdir(SGDAT)
                        if f.lower().endswith(".ipo")})
        print("\n".join(bases))
        return 0
    if args[0] == "--base":
        path = resolve(args[1])
        if not path:
            print(f"not found: {args[1]}", file=sys.stderr)
            return 1
    else:
        path = args[0]
    data = extract(path)
    if as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(f"ECU {data['ecu']}: {len(data['screens'])} screens, "
              f"{len(data['inputs'])} input-prompts, {len(data['menus'])} menus")
        for mn in data["menus"]:
            keys = "  ".join(f"F{it['fkey']}:{it['label']}" for it in mn["items"])
            print(f"  [{mn['name']}] {keys}")
        for s in data["screens"][:30]:
            lab = " | ".join(s["labels"]) if s["labels"] else "(no labels)"
            print(f"  [{s['render']:7}] {s['job']} {s['args'] or ''}")
            print(f"            {lab}")
            print(f"            keys: {';'.join(s['result_keys'])}"
                  f"  units: {s['units']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
