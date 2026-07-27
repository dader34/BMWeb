#!/usr/bin/env python3
"""Layer 3b: join recognised .IPO screens with SGBD metadata.

Layer 2 recognises screens from the bytecode. Layer 3a harvests what the ECU
can answer. This joins them, and the join is the point: MS45's Ident card needs
BOTH sources, because five of its eighteen fields are not in the .IPO at all.

The merge rules, in order of trust:

  1. a field the .IPO carries wins on LABEL — that is INPA's own caption, and
     INPA's wording is the thing we are reproducing
  2. the SGBD contributes the JOB each field is read from (bytecode does not
     reliably say) and any field INPA shows that the bytecode omits
  3. an SGBD field is only added to a screen when the screen's own recogniser
     claims it — never "everything the ECU can answer", or the card stops being
     INPA's screen and becomes a database dump

Every field keeps a `source`: "ipo", "sgbd", or "ipo+sgbd" when both agree.
Nothing here promotes a write; layer 2's writes_unverified is passed through
untouched.

    python3 tools/ipo_enrich.py               # summary
    python3 tools/ipo_enrich.py MS450         # one ECU's enriched screens
    python3 tools/ipo_enrich.py --write       # data/inpa-screens/_enriched.json
"""
import os
import re
import sys
import json
import glob
import collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_screens as L1                                        # noqa: E402
import ipo_recognize as L2                                      # noqa: E402

OUT = L1.OUT
SGBD_CACHE = os.path.join(OUT, "_sgbd.json")
# INPA's own Activate grouping, where the .IPO declares one (tools/ipo_actmenus.py)
ACTMENUS = os.path.join(OUT, "_actmenus.json")
# each ECU's real INPA root menu, with ITS OWN F-key numbers (tools/ipo_rootmenu.py)
ROOTMENUS = os.path.join(OUT, "_rootmenus.json")
# INPA's Coding screen (root F3), where the .IPO describes one
CODING = os.path.join(OUT, "_coding.json")
STATUS = os.path.join(OUT, "_status.json")
# per-gauge unit and min/max from INPA's gauge dialect (tools/ipo_gauges.py)
GAUGES = os.path.join(OUT, "_gauges.json")
# INPA's nested Activate menu, where the .IPO declares one (tools/ipo_submenus.py)
SUBMENUS = os.path.join(OUT, "_submenus.json")
# INPA's Read memory screen with its own region bounds (tools/ipo_memory.py)
MEMORY = os.path.join(OUT, "_memory.json")
ECU_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "vendor", "EDIABAS", "Ecu")

# how the app already resolves an INPA code to an SGBD file (ConfigEndpoints:
# FindLayoutFile). Kept identical so the pipeline pairs things the same way the
# runtime does.
SUFFIXES = ["ds0", "ds2", "ds1", "_n", "ds"]

# which harvested jobs may feed which recognised screen. Deliberately narrow:
# the screen keeps INPA's shape, the SGBD only fills it in.
# Fully anchored: these are matched with .fullmatch(), not .match(). An
# unanchored alternative like "REFERENZ_LESEN$" silently fails under .match(),
# which is why HARDWARE_REFERENZ_LESEN went missing.
SCREEN_JOBS = {
    "identity": re.compile(r"IDENT|INFO|SERIENNUMMER_LESEN"
                           r"|\w*REFERENZ_LESEN|PRUEFCODE_LESEN", re.I),
    "aif": re.compile(r"AIF_LESEN", re.I),
}

# INFO describes the SGBD FILE, not the car: who wrote the driver, its revision,
# its language. Those are facts about BMW's tooling and must never appear on an
# ECU's identity card next to a real part number.
FILE_META = {"ECU", "ORIGIN", "REVISION", "AUTHOR", "COMMENT", "PACKAGE",
             "SPRACHE", "VERSION", "DATE", "TITLE"}


def sgbd_names():
    return sorted(os.path.basename(f)[:-4]
                  for f in glob.glob(os.path.join(ECU_DIR, "*.prg")))


def pair(ecu, names_lower):
    """INPA code -> SGBD name, using the runtime's own suffix rules."""
    e = ecu.lower()
    if e in names_lower:
        return names_lower[e]
    for suf in SUFFIXES:
        for cand, real in names_lower.items():
            if cand.endswith(suf) and cand[:-len(suf)] == e:
                return real
    return None


def merge(screen, harvested):
    """Fill one recognised screen from the SGBD. Returns (fields, stats)."""
    pat = SCREEN_JOBS.get(screen["screen"])
    if not pat:
        return screen["fields"], collections.Counter()

    # every field the SGBD can answer, from jobs this screen is allowed to use
    sgbd_by_key = {}
    for job, fields in harvested.items():
        if not pat.fullmatch(job):
            continue
        for f in fields:
            sgbd_by_key.setdefault(f["key"], f)

    stats = collections.Counter()
    out, seen = [], set()

    # 1+2. INPA's fields keep INPA's label, gain the job they are read from
    for f in screen["fields"]:
        g = dict(f)
        hit = sgbd_by_key.get(f["key"])
        if hit:
            g["job"] = hit["job"]
            g["desc"] = hit["desc"]
            g["source"] = "ipo+sgbd"
            stats["confirmed"] += 1
        else:
            stats["ipo only"] += 1
        seen.add(f["key"])
        out.append(g)

    # 3. fields the ECU answers on this screen's jobs that the bytecode omitted.
    # These are marked `extra`: real ECU data, but NOT part of the screen INPA
    # draws, so a consumer can reproduce INPA exactly or show the richer card.
    for key, f in sgbd_by_key.items():
        if key in seen or key in FILE_META:
            stats["dropped file metadata"] += key in FILE_META
            continue
        out.append({"key": key, "label": f["desc"] or key, "job": f["job"],
                    "desc": f["desc"], "source": "sgbd", "extra": True})
        stats["added from sgbd"] += 1
    return out, stats


def enrich(rec, harvested):
    """One ECU: recognised screens, filled in from its SGBD."""
    r = L2.recognise(rec)
    total = collections.Counter()
    for s in r["screens"]:
        if harvested:
            s["fields"], st = merge(s, harvested)
            total.update(st)
        s["sources"] = sorted({f["source"] for f in s["fields"]})
    r["stats"] = dict(total)
    return r


# ---------------------------------------------------------------------------
# adapters: emit exactly the shape identity.js / aif.js already consume, so a
# generated ECU needs no renderer changes at all.
# ---------------------------------------------------------------------------

def as_identity(screen):
    """{title, subtitle, jobs[], fields[{key,label,extra}]} — identity.js."""
    fields = [{"key": f["key"], "label": f["label"], "source": f["source"],
               **({"extra": True} if f.get("extra") else {})}
              for f in screen["fields"]]
    jobs, seen = [], set()
    for f in screen["fields"]:
        j = f.get("job")
        if j and j not in seen:
            seen.add(j)
            jobs.append(j)
    return {"title": "ID-data", "subtitle": "ECU identity · read-only",
            "jobs": jobs or ["IDENT"], "fields": fields}


def as_aif(screen):
    """{title, subtitle, job, records, fields[]} — aif.js."""
    fields = [{"key": f["key"], "label": f["label"], "source": f["source"],
               **({"extra": True} if f.get("extra") else {})}
              for f in screen["fields"]]
    return {"title": "User information", "subtitle": "AIF · programming history",
            "job": "AIF_LESEN", "records": 15, "fields": fields}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write" in sys.argv

    if not os.path.exists(SGBD_CACHE):
        print("no SGBD cache — run: python3 tools/sgbd_harvest.py --write",
              file=sys.stderr)
        return 2
    with open(SGBD_CACHE, encoding="utf-8") as f:
        cache = json.load(f)
    names_lower = {n.lower(): n for n in cache}

    if args:
        path = os.path.join(L1.SGDAT, args[0] + ".IPO")
        if not os.path.exists(path):
            print(f"no such .IPO: {args[0]}", file=sys.stderr)
            return 1
        rec = L1.extract(path)
        sg = pair(rec["ecu"], names_lower)
        out = enrich(rec, cache[sg]["harvested"] if sg else None)
        out["sgbd"] = sg
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0

    results, stats = {}, collections.Counter()
    for rec in L1.corpus():
        if not L1.decodable(rec):
            continue
        sg = pair(rec["ecu"], names_lower)
        out = enrich(rec, cache[sg]["harvested"] if sg else None)
        out["sgbd"] = sg
        results[rec["ecu"]] = out
        stats["ecus"] += 1
        stats["paired with an SGBD" if sg else "no SGBD found"] += 1
        for k, v in out["stats"].items():
            stats[k] += v

    print(f"{stats['ecus']} decodable ECUs\n")
    for k in ("paired with an SGBD", "no SGBD found"):
        print(f"   {k:24} {stats[k]}")
    print()
    for k in ("confirmed", "ipo only", "added from sgbd"):
        print(f"   fields {k:18} {stats[k]}")

    if write:
        dest = os.path.join(OUT, "_enriched.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False)
        print(f"\nwrote {len(results)} ECUs -> {os.path.relpath(dest)}")

        # ...and one file per ECU, in the shape the app's layout endpoint
        # serves. The combined file is for analysis; the app must not load
        # 30 MB to render one screen.
        actmenus = {}
        if os.path.exists(ACTMENUS):
            with open(ACTMENUS, encoding="utf-8") as f:
                actmenus = json.load(f)
        rootmenus = {}
        if os.path.exists(ROOTMENUS):
            with open(ROOTMENUS, encoding="utf-8") as f:
                rootmenus = json.load(f)
        codings = {}
        if os.path.exists(CODING):
            with open(CODING, encoding="utf-8") as f:
                codings = json.load(f)
        gauges = {}
        if os.path.exists(GAUGES):
            with open(GAUGES, encoding="utf-8") as f:
                gauges = json.load(f)
        submenus = {}
        if os.path.exists(SUBMENUS):
            with open(SUBMENUS, encoding="utf-8") as f:
                submenus = json.load(f)
        memory = {}
        if os.path.exists(MEMORY):
            with open(MEMORY, encoding="utf-8") as f:
                memory = json.load(f)
        statuses = {}
        if os.path.exists(STATUS):
            with open(STATUS, encoding="utf-8") as f:
                statuses = json.load(f)
        # full per-screen decode (tools/ipo_disasm.py): fields per screen
        decompiled = {}
        dec_path = os.path.join(OUT, "_decompiled.json")
        if os.path.exists(dec_path):
            with open(dec_path, encoding="utf-8") as f:
                decompiled = json.load(f)
        gen = os.path.join(os.path.dirname(OUT), "inpa-layouts", "generated")
        os.makedirs(gen, exist_ok=True)
        n = 0
        for ecu, r in results.items():
            screens = {s["screen"]: s for s in r["screens"]}
            if not screens:
                continue
            out = {"ecu": ecu, "sgbd": r.get("sgbd"), "generated": True}
            # INPA's Activate groups (Inputs/Outputs -> PW, C.Lock, WiWa ...),
            # for the ECUs whose .IPO actually declares them
            # INPA's own root menu for this ECU: which entries it has and the
            # F-key each sits on. 343 of 458 ECUs leave gaps (no Coding means
            # F3 is empty and Error memory stays on F4), so renumbering a
            # filtered list gets the keys wrong.
            if ecu in rootmenus:
                out["rootMenu"] = rootmenus[ecu]["items"]
                # keys INPA lists but declares no screen for (GSDS2's F3
                # Coding dispatches to m_status and the file ships a
                # m_main_nocode variant without it). Carried as F-key numbers
                # so the surviving keys keep INPA's own numbering.
                if rootmenus[ecu].get("deadKeys"):
                    out["deadRootKeys"] = rootmenus[ecu]["deadKeys"]
            # INPA's Coding screen: a labelled read, its own job per ECU
            if ecu in codings:
                out["coding"] = codings[ecu]
            # INPA's Read status structure: the page MENU, not a flat job list.
            # Only the menu is emitted -- which readouts sit on each page is
            # not decoded (declaration bodies hold dispatch, and the captions
            # live in a separate section), so the UI keeps sourcing values from
            # gaugeSpecs and uses this for INPA's own grouping and order.
            # an ECU whose status menu is not named m_status (RDC uses
            # m_rdc_status) is invisible to tools/ipo_status.py's name match;
            # derive it structurally instead: the root menu's Status item
            # names its softkey menu via setmenu, and that menu's items are
            # the pages
            if ecu not in statuses and ecu in decompiled:
                dmen = decompiled[ecu].get("menus") or {}
                root = dmen.get("m_main") or next(iter(dmen.values()), [])
                stat = next((i for i in root
                             if re.match(r"^(Status|Read status|Status lesen)",
                                         i.get("label", ""), re.I)
                             and i.get("menu")), None)
                if stat and stat["menu"] in dmen:
                    items = []
                    seen_tgt = {}
                    for it in dmen[stat["menu"]]:
                        lbl = it.get("label", "").strip()
                        tgt = it.get("target")
                        if not lbl or not tgt \
                                or re.match(r"^(Back|Exit|Print|Zur|End|Activ)",
                                            lbl, re.I):
                            continue
                        # a write item whose SCREEN duplicates a read item
                        # (RDC "MV write" opens the same s_abgleichwert_lesen
                        # as "MV read"): INPA's difference is an input dialog
                        # and a write job in the ITEM body, both refused until
                        # verified on a car. What remains is an exact
                        # duplicate of the read page, so drop it rather than
                        # list two identical entries.
                        if tgt in seen_tgt \
                                and re.search(r"write|schreiben|reset|clear|"
                                              r"loeschen|lösch", lbl, re.I):
                            continue
                        seen_tgt[tgt] = lbl
                        items.append({"label": lbl, "targets": [tgt],
                                      "resolved": True})
                    if items:
                        statuses = dict(statuses)
                        statuses[ecu] = {"menu": {"name": stat["menu"],
                                                  "items": items}}
            if ecu in statuses:
                menu_out = json.loads(json.dumps(statuses[ecu]["menu"]))
                # each page's REAL rows, from the decompiler: resolve the
                # item's target screens and take their fields (key, INPA's
                # caption, unit, range). Multi-target items are gearbox/
                # hardware variants of one page -- union them, dedup by key,
                # since the variant is only knowable with the car attached.
                dec = decompiled.get(ecu)
                # SGBD result descriptions, for fields the screen displays
                # without a caption (RDC's loop screens print results at
                # computed positions, so no static label exists). German descs
                # are fine here: the renderer routes labels through deGerman.
                sg = r.get("sgbd")
                desc_of = {}
                if sg and sg in cache:
                    for _j, _fl in cache[sg]["harvested"].items():
                        for _f in _fl:
                            if _f.get("desc"):
                                desc_of.setdefault(_f["key"], _f["desc"])
                if dec:
                    for it in menu_out.get("items", []):
                        fields, jobs, seen = [], [], set()
                        for tgt in it.get("targets", []):
                            scr = dec["screens"].get(tgt)
                            if not scr:
                                continue
                            for j in scr.get("jobs", []):
                                # the UI polls these automatically; a write
                                # job (RDC "MV write" -> ABGLEICHWERT_
                                # SCHREIBEN) must never ride along
                                if re.search(r"SCHREIBEN|STEUERN|RESET|"
                                             r"LOESCHEN|CLEAR|WRITE", j, re.I):
                                    continue
                                if j not in jobs:
                                    jobs.append(j)
                            for f in scr.get("fields", []):
                                k = f.get("key")
                                if not k or k in seen:
                                    continue
                                seen.add(k)
                                g = {x: f[x] for x in
                                     ("key", "label", "kind", "unit", "min",
                                      "max", "on", "off", "line")
                                     if f.get(x) is not None}
                                # "Voltage Clamp 30E [Volt]" carries its unit
                                # in the caption; split it out
                                lb = g.get("label") or ""
                                if "unit" not in g and lb.endswith("]") \
                                        and "[" in lb:
                                    g["unit"] = lb[lb.rindex("[") + 1:-1]
                                    g["label"] = lb[:lb.rindex("[")].strip()
                                if not g.get("label") and k in desc_of:
                                    g["label"] = desc_of[k]
                                fields.append(g)
                        if fields:
                            it["fields"] = fields
                        if jobs:
                            it["jobs"] = jobs
                out["statusMenu"] = menu_out
            # INPA's own unit and range per readout, for layouts whose rows
            # have neither. A `descending` range is NOT emitted: the sign is
            # absent from the bytes, so -45..40 and 45..40 are indistinguishable
            # and a backwards bar is worse than none.
            # INPA's nested Activate menu: the jobs sit under submenus rather
            # than in one flat list
            # INPA's Read memory screen, in the shape special.js consumes
            if ecu in memory:
                out["special"] = {
                    "title": "Special", "subtitle": "memory dump",
                    "memory": {**memory[ecu], "maxBytes":
                               max((r.get("maxBytes") or 250)
                                   for r in memory[ecu]["regions"])},
                    "sync": [],
                }
            if ecu in submenus:
                out["activateTree"] = submenus[ecu]
            if ecu in gauges:
                out["gaugeSpecs"] = [
                    {k: v for k, v in g.items() if k != "descending"}
                    for g in gauges[ecu] if not g.get("descending")
                ]
            if ecu in actmenus:
                out["activateMenus"] = actmenus[ecu]["menus"]
                # INPA's post-drive state readout ("Signal : EIN"), which is
                # why it needs no stop job
                if actmenus[ecu].get("stateDisplays"):
                    out["activateState"] = actmenus[ecu]["stateDisplays"]
            if "identity" in screens:
                out["identity"] = as_identity(screens["identity"])
            if "aif" in screens:
                out["aif"] = as_aif(screens["aif"])
            with open(os.path.join(gen, ecu + ".json"), "w",
                      encoding="utf-8") as f:
                json.dump(out, f, ensure_ascii=False, indent=1)
            n += 1
        print(f"wrote {n} per-ECU layouts -> {os.path.relpath(gen)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
