#!/usr/bin/env python3
"""Resolve the curated service tasks against every chassis, once, at build time.

WHY A BUILD STEP. data/service-functions.json says what each task IS -- what
it does to the car, what must be true first, and how to recognise the INPA key
that performs it. It does NOT say where that key lives, because the answer is
different on all 26 chassis and nobody can maintain 26 tables by hand. The
answer is already in the decoded IR: every module script's menus, the label on
each key and the job it sends. This walks that tree once and writes the
finished mapping, so the app opens a task list instantly instead of scanning
hundreds of megabytes of archives in the browser.

WHAT RESOLUTION MEANS. A task resolves onto one menu ITEM of one module
script. The item is a candidate when all three hold:

  1. the module is one the task could live in (`modules`, matched against the
     SGBD and the module's label -- an engine adaptation reset must not
     resolve onto the gearbox's identically-named key);
  2. the item's job is one of the task's `jobs`, OR its printed label is one
     of the task's `keys`;
  3. no `deny` word appears in the label.

A WRITE TASK NEVER RESOLVES ONTO A READ KEY. The trap is real and shipped:
on E46's lws5, the key labelled "Read error memory" sends ABGLEICH_LESEN, so
matching the job family alone would offer a READ key as the steering angle
CALIBRATION. Every candidate is therefore checked against the same
read/write classifier the runtime guards writes with (core/bestvm's
isWriteJob, mirrored here in `job_writes`), and a write task drops any item
whose job classifies as a read.

WHAT THE `writeJob` FLAG IS AND IS NOT. The IR sets `writeJob` on items the
decoder could prove write. It is sound but INCOMPLETE: several keys that
plainly change the car carry no flag at all -- STEUERN_BATTERIETAUSCH_
REGISTRIEREN, FAHRZEUG_HOEHE_ABGLEICHEN, STEUERN_FENSTERHEBER_EINLERNEN and
the DSC bleeding jobs are all unflagged in the shipped corpus. So the flag is
used as EVIDENCE (a flagged item scores higher) and never as a gate: gating
on it hid seven real tasks behind "not in INPA for this chassis", which is a
worse lie than showing the key. The user-facing risk badge comes from the
curated `risk`, not from the flag, and the runtime asks for confirmation on
its own reading of the job either way.

A JOB HIT OUTRANKS A LABEL HIT, and an item matching both outranks either,
because a label is a translation and a job name is what actually goes down the
wire. Ties break on the shorter label -- INPA's own key, not a variant of it
with a qualifier appended.

    python3 tools/export/service_functions.py                 # standalone
    python3 tools/export/service_functions.py --out dist-web
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
TREE = os.path.join(ROOT, "data", "chassis")
CATALOGUE = os.path.join(ROOT, "data", "service-functions.json")

# The resolved format's version. The app refuses a file it does not
# understand rather than reading a moved field into nonsense.
RESOLVED_VERSION = 1

# How many modules may answer one task on one chassis. A task that resolves
# onto a dozen scripts is a matcher that is too loose, not a car with a dozen
# steering angle sensors; the best few are kept and the rest dropped so the
# app's task row stays readable.
MAX_HITS_PER_TASK = 6

# INPA's own chrome, on nearly every menu. These never perform a service
# task, and one of them ("Print") carries no job at all, so a stray label
# match on them would be pure noise.
CHROME_ACTIONS = frozenset(("exit", "printscreen", "select", "deselect"))

# JOBS THAT DO NOT IDENTIFY A TASK ON THEIR OWN.
#
# The later engines clear adaptations through ONE selective job whose argument
# says which subsystem to clear, so a single job name sits under ~20 different
# keys: "Drosselklappe", "Lambdasonden", "VANOS", "Klopfen", "Alle
# Adaptionen". The job tells you a selective delete happens; only the LABEL
# says what gets deleted. Resolving on the job alone would offer the throttle
# task the VANOS key, so for these the label must carry the match, and a job
# hit only strengthens a label hit that already stands.
#
# This is deliberately a small, named list rather than a heuristic: a job is
# only listed here once the corpus shows it spread across keys that mean
# different things.
SHARED_JOBS = frozenset(
    (
        "ADAP_SELEKTIV_LOESCHEN",
        "START_ADAP_SELEKTIV_LOESCHEN",
        "SIA_RESET",
        "STEUERN_SIA_RESET",
    )
)

# The synthetic folders in data/chassis that are not cars: 'vehicle' holds
# INPA's whole-car scripts (E46.IPO), 'other' the modules no config names.
# A whole-car script's stem IS its chassis, so it is folded into that car;
# 'other' belongs to no car and is skipped.
VEHICLE_DIR = "vehicle"
OTHER_DIR = "other"


# THE READ/WRITE CLASSIFIER, mirrored from the runtime's write guard
# (app/renderer/core/bestvm/write-guard.js). Same tokens, same order, same
# default-deny, so a task's resolved key is classified here exactly as the
# guard will classify it when the key is pressed. If the two ever disagree,
# this file offers a key the guard then refuses, so test_service_functions.js
# asserts the two agree over every job the mapping resolves.
_READ_TOKEN = re.compile(
    r"(LESEN|_LES\b|\bLES_|READ|STATUS|IDENT|ANZEIGE|ABFRAG|ANZAHL|ZUSTAND|GET_)",
    re.I,
)
_CONFIG_READ_TOKEN = re.compile(r"CONFIG", re.I)
_WRITE_TOKEN = re.compile(
    r"(SCHREIB|STEUERN|_SETZEN|SETZEN|LOESCH|FLASH|PROGRAMMIER|(?:\b|_)START"
    r"|(?:\b|_)STOP|RESET|CODIER|WRITE|\bSET\b|DOWNLOAD|UPLOAD|ABGLEICH"
    r"|ADAPTION|SLEEP|WAKEUP|POWER_?DOWN|AUTHENTIS|INITIALISIER|EINSTELL"
    r"|AKTIVIER|DEAKTIVIER|TILGUNG|ANLERN|TEACH|CLEAR)",
    re.I,
)
_INFO_READ_TOKEN = re.compile(r"(?:\b|_)INFO", re.I)


def job_writes(name):
    """Whether a job name must be treated as a write.

    Args:
        name: the SGBD job name, any case.

    Returns:
        True for a write or an unrecognised name (default-deny), False when
        the name says it only reads.
    """
    n = str(name or "")
    if _READ_TOKEN.search(n):
        return False
    if _CONFIG_READ_TOKEN.search(n) and not _WRITE_TOKEN.search(n):
        return False
    if _WRITE_TOKEN.search(n):
        return True
    if _INFO_READ_TOKEN.search(n):
        return False
    return True


def norm(s):
    """A label in the form the matcher compares: collapsed and case-folded.

    Args:
        s: the label as the script wrote it.

    Returns:
        Lower-case, whitespace squeezed, trailing ':' or '=' dropped.
    """
    return re.sub(r"\s*[:=]\s*$", "", re.sub(r"\s+", " ", str(s or "")).strip()).lower()


def load_catalogue():
    """The curated task list.

    Returns:
        The parsed catalogue dict.

    Raises:
        SystemExit: when the file is missing or will not parse -- it is
            committed source, so its absence is a broken checkout, not a
            build without data.
    """
    try:
        with open(CATALOGUE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        sys.exit(f"cannot read {CATALOGUE}: {e}")


def module_dirs():
    """Every module folder in the tree, grouped by the chassis that owns it.

    The tree copies a script into every car that can carry it, so the same
    SGBD appears under many chassis; each copy is its own answer because the
    question ("where is this task on THIS car?") is per chassis.

    Returns:
        {chassis id: [(sgbd, folder, ecu record)]}, chassis upper-case.
    """
    out = {}
    if not os.path.isdir(TREE):
        return out
    for cid in sorted(os.listdir(TREE)):
        cdir = os.path.join(TREE, cid)
        if not os.path.isdir(cdir) or cid == OTHER_DIR:
            continue
        for name in sorted(os.listdir(cdir)):
            d = os.path.join(cdir, name)
            rec_path = os.path.join(d, "ecu.json")
            if not os.path.isfile(rec_path):
                continue
            if not os.path.isfile(os.path.join(d, "screens.json")):
                continue
            try:
                with open(rec_path, encoding="utf-8") as f:
                    rec = json.load(f)
            except (OSError, ValueError):
                continue
            sgbd = str(rec.get("sgbd") or "").lower()
            if not sgbd:
                continue
            # a whole-car script has no chassis folder of its own; its stem
            # names the car it belongs to (data/chassis/vehicle/e46 -> E46)
            owner = sgbd.upper() if cid == VEHICLE_DIR else cid.upper()
            out.setdefault(owner, []).append((sgbd, d, rec))
    return out


def module_matches(spec_modules, sgbd, rec):
    """Whether a task could live in this module.

    An empty `modules` means "any module" -- the right answer for a task like
    a control unit reset, which every script carries.

    Args:
        spec_modules: the task's `modules` list.
        sgbd: the module's SGBD, lower-case.
        rec: its ecu.json record.

    Returns:
        True when the module is a candidate.
    """
    if not spec_modules:
        return True
    hay = " ".join(
        (sgbd, str(rec.get("label") or ""), str(rec.get("code") or ""))
    ).lower()
    return any(m.lower() in hay for m in spec_modules)


def item_score(item, spec):
    """How well one menu item answers one task.

    Args:
        item: the IR menu item.
        spec: the task's `match` block.

    Returns:
        (score, why) -- score 0 means no match. `why` is 'job', 'key' or
        'both', and rides into the output so a reviewer can see WHY a row
        resolved without re-running the matcher.
    """
    label = norm(item.get("label"))
    job = str(item.get("job") or "")
    # a deny word anywhere in the label rejects the item outright: INPA
    # reuses one job across keys that read and keys that write, and the
    # label is the only thing that tells them apart
    for bad in spec.get("deny") or ():
        if bad.lower() in label:
            return 0, ""
    job_hit = any(job.upper() == j.upper() for j in spec.get("jobs") or () if job)
    key_hit = any(norm(k) == label for k in spec.get("keys") or () if label)
    if job_hit and key_hit:
        return 3, "both"
    # A shared job names the MECHANISM, not the task: on its own it cannot
    # say which subsystem this key clears, so it needs the label to agree.
    if job_hit and job.upper() not in SHARED_JOBS:
        return 2, "job"
    if key_hit:
        return 1, "key"
    return 0, ""


def scan_module(sgbd, folder, rec, tasks):
    """Every task hit in one module script.

    Args:
        sgbd: the module's SGBD.
        folder: its folder.
        rec: its ecu.json record.
        tasks: the catalogue's task list.

    Returns:
        {task id: [hit]} -- each hit names the menu, the F-key number, the
        label as printed and why it matched.
    """
    try:
        with open(os.path.join(folder, "screens.json"), encoding="utf-8") as f:
            ir = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    for task in tasks:
        spec = task.get("match") or {}
        if not module_matches(spec.get("modules"), sgbd, rec):
            continue
        wants_write = task.get("risk") == "write"
        for menu_name, menu in (ir.get("menus") or {}).items():
            if not isinstance(menu, dict):
                continue
            for item in menu.get("items") or ():
                if not isinstance(item, dict):
                    continue
                if str(item.get("action") or "") in CHROME_ACTIONS:
                    continue
                if not item.get("label"):
                    continue
                job = str(item.get("job") or "")
                flagged = bool(item.get("writeJob"))
                # A WRITE TASK NEVER RESOLVES ONTO A READ KEY. Classified by
                # the runtime's own rules, so what is offered here is what
                # the guard will accept when it is pressed. A key with no job
                # at all runs a script body rather than sending anything, so
                # its name cannot classify it: the IR flag decides, and an
                # unflagged one is let through on the label's word alone.
                if job:
                    if job_writes(job) != wants_write:
                        continue
                elif flagged and not wants_write:
                    continue
                score, why = item_score(item, spec)
                if not score:
                    continue
                # the IR's proof-of-write is evidence, not a gate: it breaks
                # ties towards the key the decoder could prove changes the car
                if flagged == wants_write:
                    score += 1
                out.setdefault(task["id"], []).append(
                    {
                        "sgbd": sgbd,
                        "module": str(rec.get("label") or rec.get("code") or sgbd),
                        "menu": menu_name,
                        "nr": item.get("nr"),
                        "label": str(item.get("label")),
                        "job": job,
                        "screen": str(item.get("screen") or "") or None,
                        "why": why,
                        # how the runtime's guard will classify this key when
                        # it is pressed; the app shows it beside the row
                        "writes": job_writes(job) if job else flagged,
                        "_score": score,
                    }
                )
    return out


def rank(hits):
    """Order a task's hits best first and cap them.

    A job hit outranks a label hit because a job name is what goes down the
    wire while a label is a translation. Ties break on the shorter label:
    INPA's own key rather than a qualified variant of it.

    Args:
        hits: the unordered hit list.

    Returns:
        The best `MAX_HITS_PER_TASK`, one per module, with the score dropped.
    """
    hits.sort(key=lambda h: (-h["_score"], len(h["label"]), h["sgbd"], h["menu"]))
    out = []
    seen = set()
    # ONE ROW PER MODULE. The app offers each hit as a module to run the task
    # on ("also on: DDE 5.0, MS45"), so two rows naming the same module are
    # not a second choice -- they are the same choice listed twice, which is
    # what the E46 CO adjustment looked like before this rule (four rows all
    # reading "MS45.1 for M54", one per menu the key sits on).
    #
    # Which of a module's copies wins is already settled by the sort: the
    # highest-scoring key, then the shortest label. A script that repeats one
    # key across variant-gated menus (lws5's _5_0 and _5_2) genuinely has one
    # answer, and the runtime presses by CAPTION, so whichever menu the script
    # actually lands on is the one that gets pressed.
    # De-duplicated by DISPLAY LABEL as well as by SGBD, because that is what
    # the reader actually sees: a script shipped as several dataset variants
    # (ms410ds0, ms410ds1, ms410ds2) presents as three identical "MS 41.0"
    # buttons, which is a choice the user cannot make. The variants carry the
    # same key, so the first is the answer for all of them.
    for h in hits:
        sig = (h["sgbd"], norm(h["module"]))
        if h["sgbd"] in seen or sig[1] in seen:
            continue
        seen.add(h["sgbd"])
        seen.add(sig[1])
        out.append({k: v for k, v in h.items() if k != "_score"})
        if len(out) >= MAX_HITS_PER_TASK:
            break
    return out


def build(out_dir=None, verbose=True):
    """Resolve every task on every chassis and write the mapping.

    Args:
        out_dir: an export root to write api/ into as well (dist-web); the
            committed copy under data/ is always written.
        verbose: print the per-chassis summary, as the other steps do.

    Returns:
        (chassis count, resolved (chassis, task) pair count).
    """
    cat = load_catalogue()
    tasks = cat.get("tasks") or []
    by_chassis = {}
    for chassis, mods in sorted(module_dirs().items()):
        found = {}
        for sgbd, folder, rec in mods:
            for tid, hits in scan_module(sgbd, folder, rec, tasks).items():
                found.setdefault(tid, []).extend(hits)
        if found:
            by_chassis[chassis] = {tid: rank(h) for tid, h in sorted(found.items())}

    doc = {
        "v": RESOLVED_VERSION,
        "tasks": [
            {
                k: t[k]
                for k in ("id", "name", "category", "what", "before", "after", "risk")
                if k in t
            }
            for t in tasks
        ],
        "categories": cat.get("categories") or [],
        "chassis": by_chassis,
    }
    blob = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    targets = [os.path.join(ROOT, "data", "service-functions.chassis.json")]
    if out_dir:
        targets.append(os.path.join(out_dir, "data", "service-functions.chassis.json"))
    for path in targets:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(blob)

    pairs = sum(len(v) for v in by_chassis.values())
    if verbose:
        print(
            f"  service-functions.chassis.json: {len(tasks)} tasks resolved to "
            f"{pairs} (chassis, task) pairs over {len(by_chassis)} chassis "
            f"({len(blob) // 1024} KB)"
        )
        for chassis in sorted(by_chassis):
            got = len(by_chassis[chassis])
            print(f"    {chassis}: {got}/{len(tasks)}")
    return len(by_chassis), pairs


def main():
    """CLI entry: resolve into data/ and optionally an export root.

    Returns:
        The process exit code; non-zero when nothing resolved at all.
    """
    argv = sys.argv[1:]
    if "-h" in argv or "--help" in argv:
        print(__doc__)
        return 0
    out = argv[argv.index("--out") + 1] if "--out" in argv else None
    n_chassis, pairs = build(out)
    return 0 if n_chassis and pairs else 1


if __name__ == "__main__":
    sys.exit(main())
