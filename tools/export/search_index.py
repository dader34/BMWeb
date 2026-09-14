#!/usr/bin/env python3
"""Build the corpus-wide job search index: every INPA key and screen, by what it does.

WHY THIS IS AN EXPORT STEP. The shipped corpus is ~1100 distinct .IPO scripts
holding ~93k menu keys and ~20k screens. Answering "which screen reads the
steering angle sensor?" at runtime would mean downloading and scanning every
.chassis archive -- hundreds of megabytes -- so the scan runs once, here, and
ships one file the app fetches in full.

WHAT IS AN ENTRY. One key or one screen, in one script:

  - a KEY entry ("k"): a menu ITEM. Its label is what INPA prints on the F-key
    bar, and the jobs are what pressing it sends -- taken from the item's own
    `job` when it has one, plus the jobs of the screen it opens.
  - a SCREEN entry ("s"): a screen the script can show, its title, the jobs its
    LINE blocks send on their own, and the result keys it paints.

KEYED BY SGBD, NOT BY CHASSIS. The same .prg is copied into every car folder
that can carry it (ms411ds2 sits in 18 chassis trees), so indexing per chassis
would repeat the same 40 keys 18 times. Each module is scanned once and carries
the list of chassis that own it; the app expands that when it groups results.

TRANSLATIONS. INPA's own scripts are a mix: some print English, some German
with a per-ECU dictionary beside them. A search for "fault memory" must find
"Fehlerspeicher lesen", so both forms are indexed -- the German as written and
its English through the same two-tier exact dictionary the renderer paints
with (the ECU's own map, then the shared INPA chrome table), normalised the
same way (irI18nKey in screens/ir.js).

WRITE KEYS ARE MARKED, NOT HIDDEN. A key the IR flags `writeJob` still belongs
in the index -- knowing where the clear-adaptations key lives is the point --
but the app must never press it for the user, so the flag rides along.

    python3 tools/export/search_index.py --out dist-web    # standalone
"""
import gzip
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
TREE = os.path.join(ROOT, "data", "chassis")
SHARED_I18N = os.path.join(ROOT, "data", "inpa-i18n", "_shared.json")

# The index format version. The app refuses an index it does not understand
# rather than mis-reading a field that moved.
INDEX_VERSION = 1

# A job name as the .IPO writes it. Anything else in an item's `job` field is
# not a job (an empty string, a placeholder) and would only add search noise.
JOB_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,}$")

# Result keys per screen entry. A memory-dump screen paints the same key on 16
# rows and a status screen can declare over a hundred; the first few identify
# what the screen reads, and the rest is weight with no search value.
MAX_KEYS_PER_ENTRY = 24

# Jobs per entry. A key that reaches a helper can name a dozen; the ones it
# sends first are the ones that describe it.
MAX_JOBS_PER_ENTRY = 8

# INPA's own chrome, on nearly every menu of every script. These keys do
# nothing to the car -- they leave, print the screen, or toggle the row
# selection -- so 17k copies of "Print screen" would only ever bury a real
# answer. The screen they sit on is still indexed; only the key is dropped.
CHROME_ACTIONS = frozenset(("exit", "printscreen", "select", "deselect"))


def i18n_key(s):
    """A caption's dictionary lookup form.

    The .IPO prints a caption padded to its column ("Drehzahl      :") and the
    same words appear elsewhere trimmed; both mean one thing. Mirrors
    irI18nKey in app/renderer/screens/ir.js -- if the two disagree, the index
    finds a caption the screen does not show under that name.

    Args:
        s: the caption as the script wrote it.

    Returns:
        The collapsed form: whitespace squeezed, trimmed, trailing ':' or '='
        dropped.
    """
    return re.sub(r"\s*[:=]\s*$", "", re.sub(r"\s+", " ", str(s)).strip())


def norm_map(mapping):
    """Index a caption dictionary by collapsed caption, first entry winning.

    Args:
        mapping: a {caption: translation} dictionary.

    Returns:
        The same entries keyed by `i18n_key`.
    """
    out = {}
    for k, v in mapping.items():
        nk = i18n_key(k)
        if nk and nk not in out:
            out[nk] = v
    return out


def load_shared():
    """The shared INPA chrome dictionary, keyed by collapsed caption.

    Returns:
        {collapsed caption: English}, empty when the file is absent.
    """
    if not os.path.exists(SHARED_I18N):
        return {}
    with open(SHARED_I18N, encoding="utf-8") as f:
        return norm_map(json.load(f))


class Translator:
    """The renderer's two-tier exact-dictionary lookup, for one module.

    The ECU's own map wins over the shared chrome table, and each is tried as
    written before its collapsed form -- the order irLabel paints in.
    """

    def __init__(self, own, shared):
        """
        Args:
            own: the module's own {caption: English} map (ir.i18n), or None.
            shared: the shared table, already collapsed (`load_shared`).
        """
        self.own = own or {}
        self.own_norm = norm_map(self.own)
        self.shared = shared

    def en(self, s):
        """The English of a caption, or None when no dictionary carries it.

        Args:
            s: the caption as the script wrote it.

        Returns:
            The translation, or None -- None means "already English, or BMW
            wrote it and nobody translated it", and the caller indexes the
            original alone rather than storing a duplicate.
        """
        if not s:
            return None
        if s in self.own:
            return self.own[s]
        nk = i18n_key(s)
        hit = self.own_norm.get(nk)
        if hit is None:
            hit = self.shared.get(nk)
        if hit is None or i18n_key(hit) == nk:
            return None
        return hit


def module_dirs():
    """Every scannable module folder in the tree, one per SGBD.

    The tree copies a module into every car that can carry it, so the first
    folder found for an SGBD is scanned and the rest only contribute their
    chassis id. The whole-vehicle scripts (data/chassis/vehicle/e46 and
    friends) are modules too: INPA reaches them by the chassis stem.

    Returns:
        (chosen, owners): {sgbd: folder} and {sgbd: sorted chassis ids}. A
        whole-vehicle script's owner is the chassis its stem names.
    """
    chosen, owners = {}, {}
    if not os.path.isdir(TREE):
        return chosen, owners
    for cid in sorted(os.listdir(TREE)):
        cdir = os.path.join(TREE, cid)
        if not os.path.isdir(cdir):
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
            # a whole-vehicle script has no chassis of its own; its stem IS
            # the car (#car/E46/e46), so that is the chassis it belongs to
            owner = cid if cid not in ("vehicle", "other") else (
                sgbd.upper() if cid == "vehicle" else None)
            if owner:
                owners.setdefault(sgbd, set()).add(owner.upper())
            if sgbd not in chosen:
                chosen[sgbd] = (d, rec)
    return chosen, {k: sorted(v) for k, v in owners.items()}


def screen_jobs(screen):
    """The job names a screen's own LINE blocks send.

    Args:
        screen: one entry of the IR's `screens` map.

    Returns:
        Job names in declaration order, de-duplicated.
    """
    out = []
    for j in screen.get("jobs") or ():
        n = j.get("name") if isinstance(j, dict) else None
        if n and JOB_NAME_RE.match(n) and n not in out:
            out.append(n)
    return out[:MAX_JOBS_PER_ENTRY]


def screen_keys(screen):
    """The result keys a screen paints.

    A screen names its readings twice over -- once per painted cell, once per
    logical LINE's `keys` list -- and the same key repeats down a column, so
    this de-duplicates and caps.

    Args:
        screen: one entry of the IR's `screens` map.

    Returns:
        Result-key names in declaration order.
    """
    out = []

    def add(k):
        if k and k not in out:
            out.append(k)

    for group in ("lines", "errorLines"):
        for line in screen.get(group) or ():
            if not isinstance(line, dict):
                continue
            for el in line.get("elements") or ():
                if isinstance(el, dict) and el.get("key"):
                    add(str(el["key"]))
            # a LINE's `keys` is one ';'-joined string per declaration
            for spec in line.get("keys") or ():
                for k in str(spec).split(";"):
                    add(k.strip())
            if len(out) > MAX_KEYS_PER_ENTRY * 2:
                break
    return out[:MAX_KEYS_PER_ENTRY]


def screen_text(screen):
    """A screen's static caption text, for entries whose title says little.

    Only the labelled cells: a value's caption ("Engine speed") is what a
    reader searches for, while rules of '=' characters are not.

    Args:
        screen: one entry of the IR's `screens` map.

    Returns:
        A list of caption strings, de-duplicated.
    """
    out = []
    for line in screen.get("lines") or ():
        if not isinstance(line, dict):
            continue
        cap = line.get("caption")
        if cap and str(cap).strip():
            s = str(cap).strip()
            if s not in out:
                out.append(s)
        for el in line.get("elements") or ():
            if not isinstance(el, dict) or el.get("t") != "text":
                continue
            s = str(el.get("s") or "").strip()
            # a divider rule carries no words
            if len(s) > 2 and re.search(r"[A-Za-zÄÖÜäöüß]", s) and s not in out:
                out.append(s)
    return out


def build_module(sgbd, folder, rec, shared):
    """Scan one module's IR into index entries.

    Args:
        sgbd: the module's SGBD, lower-case.
        folder: its folder in data/chassis.
        rec: its ecu.json record (label, code).
        shared: the shared caption dictionary (`load_shared`).

    Returns:
        (module, entries): the module record and its entries, or (None, []) if
        the IR will not parse.
    """
    try:
        with open(os.path.join(folder, "screens.json"), encoding="utf-8") as f:
            ir = json.load(f)
    except (OSError, ValueError):
        return None, []
    tr = Translator(ir.get("i18n"), shared)
    screens = ir.get("screens") or {}
    menus = ir.get("menus") or {}
    entries = []

    # KEYS. A key is what a user presses, so it is indexed even when its body
    # only opens a submenu -- "where do I get to the EWS pages" is a question
    # the label answers.
    for menu_name, menu in menus.items():
        if not isinstance(menu, dict):
            continue
        for item in menu.get("items") or ():
            if not isinstance(item, dict):
                continue
            label = str(item.get("label") or "").strip()
            scr = item.get("screen")
            sd = screens.get(scr) if isinstance(scr, str) else None
            jobs = []
            own_job = item.get("job")
            if own_job and JOB_NAME_RE.match(str(own_job)):
                jobs.append(str(own_job))
            if isinstance(sd, dict):
                for j in screen_jobs(sd):
                    if j not in jobs:
                        jobs.append(j)
            title = str(sd.get("title") or "").strip() if isinstance(sd, dict) else ""
            # a key with no label, no jobs and no screen is a structural ITEM
            # (INPA's blank bar slots); it can never be a search answer
            if not label and not jobs and not scr:
                continue
            action = str(item.get("action") or "")
            if action in CHROME_ACTIONS:
                continue
            e = {"t": "k", "m": menu_name, "n": item.get("nr")}
            if label:
                e["l"] = label
                en = tr.en(label)
                if en:
                    e["e"] = en
            if scr:
                e["s"] = scr
            if title:
                e["ti"] = title
                ten = tr.en(title)
                if ten:
                    e["tie"] = ten
            if jobs:
                e["j"] = jobs[:MAX_JOBS_PER_ENTRY]
            if item.get("writeJob"):
                e["w"] = 1
            if action:
                e["a"] = action
            entries.append(e)

    # SCREENS. A screen a key opens is already reachable through that key, but
    # its result keys and captions are not on the key's label -- and a screen
    # reached only by a script's own setscreen has no key at all. Both are
    # indexed; the app shows the key when a screen has one.
    for scr_name, sd in screens.items():
        if not isinstance(sd, dict):
            continue
        keys = screen_keys(sd)
        jobs = screen_jobs(sd)
        title = str(sd.get("title") or "").strip()
        text = screen_text(sd)
        if not (keys or jobs or title or text):
            continue
        e = {"t": "s", "s": scr_name}
        if title:
            e["ti"] = title
            ten = tr.en(title)
            if ten:
                e["tie"] = ten
        if jobs:
            e["j"] = jobs
        if keys:
            e["k"] = keys
        if text:
            # the captions searchable as one blob: individually they would
            # double the file for no extra matching power
            joined = " ".join(text)[:400]
            e["c"] = joined
            en_parts = [tr.en(t) for t in text]
            en_join = " ".join(p for p in en_parts if p)[:400]
            if en_join:
                e["ce"] = en_join
        entries.append(e)

    module = {
        "sgbd": sgbd,
        "label": str(rec.get("label") or rec.get("code") or sgbd),
        "code": str(rec.get("code") or ""),
    }
    if rec.get("kind") == "vehicle":
        module["vehicle"] = 1
    return module, entries


def build_index(out_dir, verbose=True):
    """Build the whole index and write it beside the other API artifacts.

    Args:
        out_dir: the export root (dist-web); the index lands in its api/.
        verbose: print a one-line summary, as the other export steps do.

    Returns:
        (entry count, written bytes).
    """
    shared = load_shared()
    chosen, owners = module_dirs()
    modules, entries = [], []
    for sgbd in sorted(chosen):
        folder, rec = chosen[sgbd]
        module, ents = build_module(sgbd, folder, rec, shared)
        if not module or not ents:
            continue
        module["chassis"] = owners.get(sgbd, [])
        # a module no car owns is still reachable by name (the _SGBD
        # catch-all), so it is indexed rather than dropped
        idx = len(modules)
        modules.append(module)
        for e in ents:
            e["i"] = idx
            entries.append(e)
    doc = {"v": INDEX_VERSION, "modules": modules, "entries": entries}
    api = os.path.join(out_dir, "api")
    os.makedirs(api, exist_ok=True)
    path = os.path.join(api, "search-index.json.gz")
    blob = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.GzipFile(path, "wb", compresslevel=9, mtime=0) as f:
        f.write(blob)
    size = os.path.getsize(path)
    if verbose:
        print(f"  search-index.json.gz: {len(entries)} entries over "
              f"{len(modules)} modules ({size // 1024} KB gz, "
              f"{len(blob) // 1024} KB raw)")
    return len(entries), size


def main():
    """CLI entry: build the index into `--out` (default dist-web).

    Returns:
        The process exit code.
    """
    out = os.path.join(ROOT, "dist-web")
    argv = sys.argv[1:]
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]
    if "-h" in argv or "--help" in argv:
        print(__doc__)
        return 0
    n, _size = build_index(out)
    return 0 if n else 1


if __name__ == "__main__":
    sys.exit(main())
