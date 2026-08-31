#!/usr/bin/env python3
"""Where a generator's output goes: data/chassis/<CHASSIS>/<ECU>/<file>.

The tree is laid out by CAR, not by kind, so everything about one ECU sits in
one folder and you can work on it without hunting through six parallel
directories:

    data/chassis/E90/MSD80/
        ecu.json        identity: code, label, section, sgbd, group
        job-code.json   BEST2 bytecode for the VM
        meta.json       jobs, results, arguments (the .prg description block)
        tables.json     SGBD tables
        screens.json    the decompiled INPA UI (IR)
        i18n.json       per-ECU caption translations
        faults.json     fault-code map

THE DUPLICATION IS DELIBERATE AND IT IS NOT FREE. 58% of SGBDs appear in more
than one chassis -- rdc_60 is in 13, ews in 12 -- so a per-car tree stores
those files once per car: 310 distinct ECUs become 838 folders, about 2.7x the
bytes. That was chosen for ease of working on a single ECU.

What that buys has to be paid for in ONE place, or the copies drift. Every
generator calls write_ecu() rather than opening a path itself, so a single
regeneration always updates every car that shares the ECU. Nothing writes into
this tree by hand.
"""
import os
import sys
import json
import glob
import gzip

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
TREE = os.path.join(ROOT, "data", "chassis")
CONFIG = os.path.join(ROOT, "data", "chassis-config")
GROUPS = os.path.join(ROOT, "data", "groups")
ECU_DIR = os.path.join(ROOT, "vendor", "EDIABAS", "Ecu")

_OWNERS = None
_PRGS = None

# Names that appear in a group's string pool but are not SGBDs: EDIABAS result
# and status literals, plus BMW's own XYZ catch-all for "identified nothing".
RESERVED_NAMES = {
    "done", "variante", "sgbd", "xyz", "ja", "nein", "error", "okay",
}


def _prg_names():
    """Every SGBD BMW actually ships a .prg for, lowercased."""
    global _PRGS
    if _PRGS is None:
        out = set()
        for pat in ("*.prg", "*.PRG"):
            for p in glob.glob(os.path.join(ECU_DIR, pat)):
                out.add(os.path.basename(p)[:-4].lower())
        _PRGS = out
    return _PRGS


def group_variants():
    """{group: {sgbd, ...}} -- what each shipped group can IDENTIFY.

    THE MENU IS NOT THE ONLY SOURCE OF TRUTH ABOUT WHAT IS IN A CAR.
    data/chassis-config lists the variants INPA's menu offers; a group's
    IDENTIFIKATION can legitimately name one the menu never had. On a real
    E46 with an MS45.1 (verified against the car with EDIABAS), the groups
    answered gs20, mrs4, ews3, ihka46_3, kombi46r and lws5_1b -- every one a
    module physically present and answering, every one absent from the E46
    menu, so none was exported and the scan could only say "not in build".

    The source is the group's own TABLES, BMW's own data: a local SGBD table
    (d_0032 lists GS20 at LI_NR 29) or a hardware->VARIANTE map (d_0012's
    HW9_TABELLE). Rows carrying a GRUPPE column that names a DIFFERENT group are
    skipped: several groups embed a copy of the master ZuordnungsTabelle, whose
    rows describe the whole car, not that group -- without this filter ms450ds0
    lands in d_rls and d_fdm_vs as well as d_0012.

    Only variants the tables actually name are kept, and each must name a real
    .prg. The candidate list is not the answer -- it is the set the group's own
    IDENTIFIKATION chooses among, run live against the car (webResolveVariant).
    A variant name that merely appears in the string pool is NOT taken: that
    would gate on a name the bytecode does not select, and the app is a straight
    .IPO emulator -- it runs the code and lets the ECU decide, it does not
    pre-decide from string shape.

    Some groups carry NO ZuordnungsTabelle and name their variants only in the
    IDENTIFIKATION bytecode: `move "IHKA46_3", S1 / ergs "VARIANTE", S1` -- an
    if/else-if chain that assigns the concrete name into the VARIANTE result
    per branch (D_005B, the E46 climate address, is one; its .grp has no
    tables at all). Those names are NOT loose pool strings: each is the operand
    of a `move` whose destination is the very register the bytecode then
    publishes as VARIANTE. Reading exactly that idiom is reading what the code
    selects, not its string shape -- so it is a legitimate second source, and
    without it ihka46_3 was never packed into E46 and the direct-open fault
    read decoded 0x1F against ihka38's table ("frei 0x1F") instead of
    ihka46_3's ("Drucksensor").
    """
    out = {}
    for path in sorted(glob.glob(os.path.join(GROUPS, "*.json.gz"))):
        g = os.path.basename(path)[:-8].lower()
        try:
            with gzip.open(path) as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        found = set()
        for rows in (data.get("tables") or {}).values():
            for r in rows:
                if not isinstance(r, dict):
                    continue
                gr = str(r.get("GRUPPE") or "").strip().lower()
                if gr and gr != g:
                    continue          # a master-table copy; not this group's
                for col in ("SGBD_NAME", "VARIANTE", "SGBD"):
                    n = str(r.get(col) or "").strip().lower()
                    if n and n not in RESERVED_NAMES and n in _prg_names():
                        found.add(n)
        for n in _variants_in_bytecode(data):
            if n not in RESERVED_NAMES and n in _prg_names():
                found.add(n)
        if found:
            out[g] = found
    return out


def _variants_in_bytecode(data):
    """Variant names the IDENTIFIKATION bytecode ASSIGNS into VARIANTE.

    A group with no ZuordnungsTabelle picks its variant with an if/else-if
    chain: `move "IHKA46_3", S1 / ergs "VARIANTE", S1`. The name is the
    operand of a move whose destination register is the one the bytecode
    then publishes as the VARIANTE result -- i.e. a value the code selects,
    not a loose string in the pool. Collect the registers used as an `ergs
    "VARIANTE", <reg>` source, then every string moved into one of them.
    """
    st = data.get("strings") or []
    ops = data.get("ops") or []

    def lit(a):
        # a string operand [8, idx] into the pool; the pool holds strings as
        # str OR as raw byte arrays (this group file uses bytes)
        if (isinstance(a, list) and len(a) >= 2 and a[0] == 8
                and isinstance(a[1], int) and 0 <= a[1] < len(st)):
            v = st[a[1]]
            if isinstance(v, str):
                return v.rstrip("\x00")
            if isinstance(v, list):
                try:
                    return bytes(v).decode("latin1").rstrip("\x00")
                except (ValueError, TypeError):
                    return None
        return None

    var_regs = set()
    for op in ops:
        if op[0] == "ergs" and len(op[1]) >= 2:
            name = lit(op[1][0]); src = op[1][1]
            if name and name.upper() == "VARIANTE" and isinstance(src, list):
                var_regs.add(tuple(src))
    names = set()
    if not var_regs:
        return names
    for op in ops:
        if op[0] == "move" and len(op[1]) >= 2:
            dst = op[1][0]; val = lit(op[1][1])
            if isinstance(dst, list) and tuple(dst) in var_regs and val:
                v = val.strip().lower()
                if v:
                    names.add(v)
    return names


def owners():
    """{sgbd: [(chassis, ecu_code), ...]} -- every car each SGBD serves.

    Read from data/chassis-config, which is INPA's own CFGDAT resolved against
    the .prg tree. That is the only thing that knows which ECUs a car has.
    """
    global _OWNERS
    if _OWNERS is not None:
        return _OWNERS
    out = {}
    gvars = group_variants()
    for p in sorted(glob.glob(os.path.join(CONFIG, "*.json"))):
        cid = os.path.basename(p)[:-5]
        if cid == "index":
            continue
        try:
            with open(p) as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            continue
        for sec in cfg.get("sections", []):
            for e in sec.get("ecus", []):
                # a config entry without a code has no folder to live in;
                # skip it LOUDLY -- e["code"] used to raise KeyError here and
                # kill every generator funnelling through write_ecu
                code = e.get("code")
                if not code:
                    print(f"  ecu_tree: SKIPPED {cid} entry without a code "
                          f"(sgbd={e.get('sgbd')!r})", file=sys.stderr)
                    continue
                # the entry's own SGBD and its sibling dsN builds alike: all
                # of them serve this car, and without the siblings write_ecu
                # dropped them ("no chassis-config entry names this SGBD")
                for sgbd in [e.get("sgbd")] + list(e.get("variants") or []):
                    sgbd = (sgbd or "").lower()
                    if sgbd:
                        out.setdefault(sgbd, []).append((cid, code))
                # AND EVERY VARIANT THIS ENTRY'S GROUP CAN IDENTIFY. The
                # config row names the variants INPA's menu offers; the
                # group's own tables and bytecode name the ones the CAR can
                # report. Both are real, so both are exported -- see
                # group_variants() for why the menu alone is not enough.
                #
                # EACH GETS ITS OWN FOLDER, NOT THE MENU ENTRY'S. E46/airbag
                # declares zae; an mrs4 written there is exactly the sibling
                # clobber write_ecu refuses (see its docstring), and it would
                # be dropped. One folder, one SGBD: mrs4 lands in E46/mrs4,
                # keyed by the name the car reports, which is also the name
                # the sweep asks for after the group identifies it.
                grp = (e.get("group") or "").lower()
                own = (e.get("sgbd") or "").lower()
                for sgbd in gvars.get(grp, ()):
                    if sgbd == own:
                        continue      # already placed in its menu folder
                    out.setdefault(sgbd, []).append((cid, sgbd))
    # A variant reachable from several entries (E46 lists both D_0012 and
    # D_MOTOR for the engine) would otherwise be written twice into the same
    # folder. Order is preserved so the first owner still wins downstream.
    for sgbd, places in out.items():
        seen = set()
        out[sgbd] = [p for p in places
                     if not (p in seen or seen.add(p))]
    _OWNERS = out
    return out


def ecu_dirs(sgbd):
    """Every folder this SGBD's output belongs in. Empty if no car uses it."""
    return [os.path.join(TREE, cid, code)
            for cid, code in owners().get(str(sgbd).lower(), [])]


def _folder_sgbd(d):
    """The SGBD a folder's ecu.json declares as its own, or None."""
    try:
        with open(os.path.join(d, "ecu.json")) as f:
            return (json.load(f).get("sgbd") or "").lower() or None
    except (OSError, ValueError):
        return None


def write_ecu(sgbd, name, obj, raw=None):
    """Write one file into every car that uses this SGBD.

    `obj` is JSON-serialised; pass `raw` (bytes/str) instead for content that
    is already encoded. Returns the number of copies written, which is 0 when
    no chassis config names the SGBD. That case is PRINTED here, not left to
    each caller: several generators funnel through this function and most of
    them ignored the return value, so exports for unclaimed SGBDs vanished
    without a trace.

    A folder is only written when its own ecu.json names THIS sgbd (or has
    no ecu.json yet -- a tree being bootstrapped). owners() maps the sibling
    dsN variants of an ECU onto the SAME folder, so a batch export used to
    write bms46ds0's job-code into E46/BMS46 and then OVERWRITE it with
    bms46ds1's, alphabetically last sibling winning -- and the VM then
    replayed bms46ds0's engine fixture against bms46ds1's program, whose
    injection-time offset constant is "0" where ds0's is "0.8"
    (test_bestvm: STATUS_EINSPRITZZEIT 1.06 vs the engine's 1.86; same
    silent clobber in 7 folders tree-wide, ms410/ms411/dm528 included).
    One folder, one file name: it must carry the SGBD its ecu.json declares.
    """
    dirs = []
    skipped = []
    for d in ecu_dirs(sgbd):
        own = _folder_sgbd(d)
        if own is None or own == str(sgbd).lower():
            dirs.append(d)
        else:
            skipped.append((d, own))
    if skipped and not dirs:
        where = ", ".join(f"{os.path.relpath(d, TREE)} (owned by {o})"
                          for d, o in skipped[:4])
        print(f"  ecu_tree: DROPPED {name} for {sgbd}: its folders belong "
              f"to a sibling variant -- {where}", file=sys.stderr)
    elif not dirs:
        print(f"  ecu_tree: DROPPED {name} for {sgbd}: "
              f"no chassis-config entry names this SGBD", file=sys.stderr)
    payload = raw if raw is not None else json.dumps(
        obj, ensure_ascii=False, separators=(",", ":"))
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    for d in dirs:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), "wb") as f:
            f.write(payload)
    return len(dirs)


def read_ecu(sgbd, name):
    """Read one file back. Any copy will do; they are written together."""
    for d in ecu_dirs(sgbd):
        p = os.path.join(d, name)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)
    return None


def all_sgbds():
    """Every SGBD BMW ships a .prg for -- the whole corpus.

    The app is a straight .IPO emulator: a group's IDENTIFIKATION runs live and
    the ECU names its own variant, so the ship list must not try to PREDICT
    which variants a car might have (that is what a menu, or a string-pool
    guess, does). Shipping every .prg means whatever the wire resolves to always
    has its data present, and no variant is gated by a build-time inference.
    """
    return sorted(_prg_names())
