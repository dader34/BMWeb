#!/usr/bin/env python3
"""Generate data/chassis-config/*.json from INPA's own menu files.

Python twin of src/EdiabasMac/InpaConfig.cs plus the /api/chassis endpoint's
variantGroups block. The C# path cannot build in this tree (the csproj pulls
engine sources from vendor/ediabaslib-src, which is not vendored here and
includes locally-patched files that upstream ediabaslib does not ship), so
this tool regenerates the committed cache the server used to write via
tools/export/web_export.py refresh_cache(). Keep the two in step: any parsing
or resolution change here must land in InpaConfig.cs too, and vice versa.

    python3 tools/export/inpa_config.py            # write data/chassis-config
    python3 tools/export/inpa_config.py --check    # diff against cache, no write
    python3 tools/export/inpa_config.py --legacy   # pre-fix behaviour (fidelity proof)

Fidelity notes, verified byte-identical against the committed cache in
--legacy mode (macOS: file lookups are case-INSENSITIVE, which is what the
C# ran on):
  * File.Exists(prg + ".prg") matches any casing, so the direct-candidate
    branch always returns the LOWERCASED candidate ("carb" even though the
    file is CARB.PRG). Mixed-case cache values (D50M57D0, ME9N45) only come
    from the .ipo-variants fallback, which returns the on-disk stem casing
    via FindPrgCaseInsensitive.
  * FindGrpCaseInsensitive's exact branch returns the QUERY string (the IPO
    token, e.g. "D_0012"), not the on-disk stem.

Fixes over the legacy behaviour (each mirrored in InpaConfig.cs):
  1. Chassis with no .ENG menu fall back to the .GER menu (CFGDAT first,
     then SGDAT, where this dump keeps them): recovers K25/K40 (motorcycles).
     Labels for those chassis are German -- BMW never shipped English ones.
  2. BMW_ALT.ENG (the only config for E31/E34/E38 and legacy E36) and
     SONDER.ENG (special tests) are read. BMW_ALT nests per-chassis sections
     (ROOT_E31_MOTOR...) which are split into E31/E34/E38 chassis of their
     own; its E36 entries merge into E36 (new codes only). The generic
     engine/gearbox menus (MOTOR/Antrieb/ENGINE/GETRIEBE, organised by
     cylinder count, and the ENTW/MR_ENTW dev menus) stay out: their entries
     duplicate the per-chassis menus except for E31/E34/E38 engines, which
     BMW_ALT now provides.
  3. Sections beyond the old 5-name allowlist are kept, not dropped:
     ROOT_KAROSSERIE_SITZ (seats), ROOT_KAROSSERIE_TUER (doors),
     ROOT_SICHERHEITSMODULE (airbag satellites), ROOT_SICHERHEITSFAHRZEUG,
     ROOT_NAVIGATION, and anything unrecognised gets a prettified name
     instead of vanishing.
  4. Section headers match case-insensitively: F30.ENG's [ROOT_Navigation]
     is a real boundary now, so its cic entry no longer leaks into Body.
  5. Entries whose SGBD does not resolve try _f/_b suffixed siblings
     (a-sitz -> A-SITZ_F), a _E<nn> -> _<nn> alias (KGM_E60 -> KGM_60) and
     the motorcycle menus' <SGBD>W3 naming (MRDWAW3 -> MRDWA), and every
     entry still dropped is PRINTED instead of silently lost.
"""
import os
import re
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
CFGDAT = os.path.join(ROOT, "vendor", "EC-APPS", "INPA", "CFGDAT")
SGDAT = os.path.join(ROOT, "vendor", "EC-APPS", "INPA", "SGDAT")
ECU = os.path.join(ROOT, "vendor", "EDIABAS", "Ecu")
OUT = os.path.join(ROOT, "data", "chassis-config")

ENC = "cp1252"

# surfaced sections, INPA display order, English names. The first five are
# the legacy allowlist; the rest are the sections the old code dropped.
SECTION_ORDER = [
    ("ROOT_MOTOR", "Engine"),
    ("ROOT_GETRIEBE", "Transmission"),
    ("ROOT_FAHRWERK", "Chassis"),
    ("ROOT_KAROSSERIE", "Body"),
    ("ROOT_KAROSSERIE_TUER", "Doors"),
    ("ROOT_KAROSSERIE_SITZ", "Seats"),
    ("ROOT_SICHERHEITSMODULE", "Safety modules"),
    ("ROOT_SICHERHEITSFAHRZEUG", "Vehicle safety"),
    ("ROOT_ELEKTRIK", "Electrics"),
    ("ROOT_SONSTIGES", "Other"),
    ("ROOT_NAVIGATION", "Navigation"),
    ("ROOT_KOMMUNIKATION", "Communication"),
]
LEGACY_KEYS = {"ROOT_MOTOR", "ROOT_GETRIEBE", "ROOT_FAHRWERK",
               "ROOT_KAROSSERIE", "ROOT_KOMMUNIKATION"}

# cross-ECU tokens that show up in many engine .ipo scripts but are never
# the engine's own SGBD (see the C# for the MSS54M3/EWS story).
GENERIC_IPO_TOKENS = {
    "EWS", "EWS3", "DME", "KAT", "HLM", "LMM", "ASC", "ASR", "MSR",
    "SIM", "VON", "BIT", "DSP", "CAS", "FLASH", "UTILITY",
}

SEC_RE_LEGACY = re.compile(r"^\[(ROOT_[A-Z0-9_]+)\]$")
SEC_RE = re.compile(r"^\[(ROOT_[A-Z0-9_]+)\]$", re.IGNORECASE)
TOKEN_RE = re.compile(r"\b([A-Z][A-Z0-9_]{2,12})\b")
GROUP_TOKEN_RE = re.compile(r"D_00[0-9A-Fa-f]{2}")


class Resolver:
    """The SGBD/group resolution half of InpaConfig, over preloaded listings."""

    def __init__(self, legacy=False):
        self.legacy = legacy
        ecu_names = sorted(os.listdir(ECU)) if os.path.isdir(ECU) else []
        # stem (lower) -> on-disk stem casing, any .prg/.PRG
        self.prg = {}
        for n in ecu_names:
            if n.lower().endswith(".prg"):
                self.prg[os.path.splitext(n)[0].lower()] = os.path.splitext(n)[0]
        self.grp = {os.path.splitext(n)[0].lower(): os.path.splitext(n)[0]
                    for n in ecu_names if n.lower().endswith(".grp")}
        sg_names = sorted(os.listdir(SGDAT)) if os.path.isdir(SGDAT) else []
        self.ipo = {}
        for n in sg_names:
            stem, ext = os.path.splitext(n)
            if ext.lower() == ".ipo":
                self.ipo.setdefault(stem.lower(), n)
        self._ipo_text = {}

    def _read_sgdat(self, name):
        if name not in self._ipo_text:
            try:
                with open(os.path.join(SGDAT, name), "r", encoding=ENC,
                          errors="replace") as f:
                    self._ipo_text[name] = f.read()
            except OSError:
                self._ipo_text[name] = ""
        return self._ipo_text[name]

    def find_prg(self, base):
        """FindPrgCaseInsensitive: on-disk stem casing, or None."""
        return self.prg.get(base.lower())

    def sgbd_from_ipo(self, code):
        n = self.ipo.get(code.lower())
        if not n:
            return None
        m = re.search(r"SGBD[:=]\s*([A-Za-z0-9_]+)", self._read_sgdat(n))
        return m.group(1) if m else None

    def sgbd_variants_from_ipo(self, code, chassis_id):
        n = self.ipo.get(code.lower())
        if not n:
            return []
        text = self._read_sgdat(n)
        names, seen = [], set()
        for m in TOKEN_RE.finditer(text):
            t = m.group(1)
            if t.lower() not in seen:
                seen.add(t.lower())
                names.append(t)
        code_up = code.upper()
        mnum = re.search(r"\d+", chassis_id or "")
        chassis_num = mnum.group(0) if mnum else ""

        def rank(t):
            prefix = t.upper().startswith(code_up)
            if prefix and chassis_num and chassis_num in t:
                return 0
            if prefix:
                return 1
            return 2

        return sorted(names, key=lambda t: (rank(t),
                                            1 if t in GENERIC_IPO_TOKENS else 0))

    def sibling_sgbds(self, code, primary):
        """The OTHER dsN variants of an ENTRY code, beside the one chosen.

        resolve_sgbd stops at the first candidate that exists, and its only
        suffix is "ds0" -- so an ECU shipping bms46ds0.prg AND bms46ds1.prg
        contributed just ds0 to the config, and everything downstream keys
        off the config: sgbd_survey.all_shipped_sgbds() never named ds1, so
        it was never exported, even though the extractor reads it fine (106
        jobs against ds0's 96) and its screens were already harvested.

        These are returned separately from `sgbd` rather than replacing it.
        resolve_sgbd answers "which SGBD IS this menu entry", one name, and
        three callers plus the C# twin rely on that; the siblings are extra
        data the exporters may also ship, not a second answer to that
        question.
        """
        base = re.sub(r"ds\d$", "", primary)
        if base == primary:
            return []          # not a dsN name: nothing to be a sibling of
        out = [p for p in self.prg
               if re.match(re.escape(base) + r"ds\d$", p) and p != primary]
        return sorted(out)

    def resolve_sgbd(self, code, chassis_id):
        """ENTRY code -> real SGBD .prg name (no extension), or None."""
        from_ipo = self.sgbd_from_ipo(code)
        for cand in [c for c in (from_ipo, code + "ds0", code) if c]:
            prg = cand.lower()
            # File.Exists is case-insensitive here, so a direct candidate
            # always comes back lowercased when any casing of it exists.
            if prg in self.prg:
                return prg
        if not self.legacy:
            # fix 5: motorcycle menus name entries <SGBD>W3 (MRDWAW3 ->
            # MRDWA.PRG); without this the variant scan picks a stray token.
            m = re.match(r"^(.*)w3$", code, re.IGNORECASE)
            if m and m.group(1).lower() in self.prg:
                return m.group(1).lower()
        for variant in self.sgbd_variants_from_ipo(code, chassis_id):
            hit = self.find_prg(variant.lower())
            if hit:
                return hit
        if not self.legacy:
            # fix 5: seat modules ship per-side SGBDs (a-sitz -> A-SITZ_F/_B)
            for suf in ("_f", "_b"):
                hit = self.find_prg(code.lower() + suf)
                if hit:
                    return hit
            # fix 5: chassis-suffixed codes drop the E (KGM_E60 -> KGM_60)
            m = re.match(r"^(.*_)[eE](\d+)$", code)
            if m:
                hit = self.find_prg((m.group(1) + m.group(2)).lower())
                if hit:
                    return hit
        return None

    def ipo_group_tokens(self, code):
        """Distinct D_00xx tokens in the entry's compiled .IPO (uppercase-ext)."""
        n = self.ipo.get(code.lower())
        if not n:
            return []
        out, seen = [], set()
        for m in GROUP_TOKEN_RE.finditer(self._read_sgdat(n)):
            if m.group(0).lower() not in seen:
                seen.add(m.group(0).lower())
                out.append(m.group(0))
        return out

    def find_grp(self, name):
        """FindGrpCaseInsensitive: returns the QUERY casing on a hit."""
        return name if name.lower() in self.grp else None

    def group_file_for(self, code):
        for token in self.ipo_group_tokens(code):
            if token.lower() == "d_0080":
                continue  # functional broadcast, not a real ECU group
            hit = self.find_grp(token)
            if hit:
                return hit
        m = re.search(r"_([0-9A-Fa-f]{2})$", code or "")
        if m:
            hit = self.find_grp("D_00" + m.group(1).upper())
            if hit:
                return hit
        return None


def pretty(root_key):
    s = root_key.replace("ROOT_", "").lower()
    return (s[0].upper() + s[1:]) if s else root_key


def section_name(key, legacy):
    for k, name in SECTION_ORDER:
        if k == key.upper():
            return None if (legacy and k not in LEGACY_KEYS) else name
    return None


def section_index(key):
    for i, (k, _) in enumerate(SECTION_ORDER):
        if k == key.upper():
            return i
    return len(SECTION_ORDER)


def load_chassis(chassis_id, path, res, drops, legacy=False):
    """Parse one menu file -> {id, description, sections} (no variantGroups)."""
    description = chassis_id
    sections = []      # [{key, name, ecus}]
    current = None
    recognised_any = False
    sec_re = SEC_RE_LEGACY if legacy else SEC_RE

    with open(path, "r", encoding=ENC, errors="replace") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith(";"):
                continue
            m = sec_re.match(line)
            if m:
                key = m.group(1)
                known = section_name(key, legacy)
                if legacy and known is None:
                    current = None
                    continue
                current = {"key": key.upper() if not legacy else key,
                           "name": known if known else pretty(key),
                           "ecus": []}
                sections.append(current)
                recognised_any = True
                continue
            if line[:12].upper() == "DESCRIPTION=":
                if current is None and not recognised_any:
                    description = line[12:].strip()
                continue
            if current is not None and line[:6].upper() == "ENTRY=":
                parts = line[6:].split(",")
                code = parts[0].strip()
                label = parts[1].strip() if len(parts) > 1 else code
                if not code:
                    continue
                sgbd = res.resolve_sgbd(code, chassis_id)
                if sgbd is not None:
                    entry = {"code": code, "label": label, "sgbd": sgbd,
                             "group": res.group_file_for(code)}
                    sibs = res.sibling_sgbds(code, sgbd)
                    if sibs:
                        entry["variants"] = sibs
                    current["ecus"].append(entry)
                elif drops is not None:
                    drops.append((chassis_id, current["key"], code, label))

    sections = [s for s in sections if s["ecus"]]
    sections.sort(key=section_index_of_section)
    return {"id": chassis_id, "description": description, "sections": sections}


def section_index_of_section(s):
    return section_index(s["key"])


def variant_groups(res, chassis):
    """ECUs sharing a diagnostic address within one section (see the C#)."""
    groups = []
    for sec in chassis["sections"]:
        by_token = {}
        for ecu in sec["ecus"]:
            for token in res.ipo_group_tokens(ecu["code"]):
                if token.lower() == "d_0080":
                    continue
                lst = by_token.setdefault(token.lower(), [])
                if ecu["code"] not in lst:
                    lst.append(ecu["code"])
        for lst in by_token.values():
            if len(lst) >= 2:
                groups.append(lst)
    return groups


def chassis_file(chassis_id, legacy):
    """The menu file for a chassis: .ENG, then .GER (CFGDAT, then SGDAT)."""
    p = os.path.join(CFGDAT, chassis_id + ".ENG")
    if os.path.exists(p):
        return p, False
    if legacy:
        return None, False
    for q in (os.path.join(CFGDAT, chassis_id + ".GER"),
              os.path.join(SGDAT, chassis_id + ".GER")):
        if os.path.exists(q):
            return q, True
    return None, False


def chassis_ids(legacy):
    """Production chassis with a menu file."""
    ids = set()
    if os.path.isdir(CFGDAT):
        for n in os.listdir(CFGDAT):
            if n.endswith(".ENG"):
                ids.add(os.path.splitext(n)[0].upper())
    pat = re.compile(r"^(E|F|G|R|RR)\d")
    if not legacy:
        # fix 1: chassis whose menu only exists in German (K25/K40 here)
        for d in (CFGDAT, SGDAT):
            if os.path.isdir(d):
                for n in os.listdir(d):
                    if n.endswith(".GER"):
                        ids.add(os.path.splitext(n)[0].upper())
        pat = re.compile(r"^(E|F|G|R|RR|K)\d")
    return sorted(i for i in ids if pat.match(i))


def load_bmw_alt(res, drops):
    """BMW_ALT.ENG -> {chassis_id: {id, description, sections}}.

    Sections are named ROOT_<CHASSIS>_<SECTION>; [ROOT_<CHASSIS>] carries the
    chassis description. Entries resolve against their own chassis id.
    """
    path = os.path.join(CFGDAT, "BMW_ALT.ENG")
    out = {}
    if not os.path.exists(path):
        return out
    cur_chassis = None
    cur_section = None
    head_re = re.compile(r"^\[ROOT_(E\d+)\]$", re.IGNORECASE)
    sec_re = re.compile(r"^\[ROOT_(E\d+)_([A-Z0-9_]+)\]$", re.IGNORECASE)
    with open(path, "r", encoding=ENC, errors="replace") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith(";"):
                continue
            m = head_re.match(line)
            if m:
                cid = m.group(1).upper()
                cur_chassis = out.setdefault(
                    cid, {"id": cid, "description": cid, "sections": []})
                cur_section = None
                continue
            m = sec_re.match(line)
            if m:
                cid = m.group(1).upper()
                cur_chassis = out.setdefault(
                    cid, {"id": cid, "description": cid, "sections": []})
                key = "ROOT_" + m.group(2).upper()
                cur_section = {"key": key,
                               "name": section_name(key, False) or pretty(key),
                               "ecus": []}
                cur_chassis["sections"].append(cur_section)
                continue
            if line[:12].upper() == "DESCRIPTION=":
                if cur_chassis is not None and cur_section is None:
                    cur_chassis["description"] = line[12:].strip()
                continue
            if cur_section is not None and line[:6].upper() == "ENTRY=":
                parts = line[6:].split(",")
                code = parts[0].strip()
                label = parts[1].strip() if len(parts) > 1 else code
                if not code:
                    continue
                sgbd = res.resolve_sgbd(code, cur_chassis["id"])
                if sgbd is not None:
                    cur_section["ecus"].append(
                        {"code": code, "label": label, "sgbd": sgbd,
                         "group": res.group_file_for(code)})
                else:
                    drops.append((cur_chassis["id"] + " (BMW_ALT)",
                                  cur_section["key"], code, label))
    for ch in out.values():
        ch["sections"] = [s for s in ch["sections"] if s["ecus"]]
        ch["sections"].sort(key=section_index_of_section)
    return out


def load_sonder(res, drops):
    """SONDER.ENG: special tests, all under [ROOT]."""
    path = os.path.join(CFGDAT, "SONDER.ENG")
    if not os.path.exists(path):
        return None
    description = "Special tests"
    ecus = []
    in_root = False
    with open(path, "r", encoding=ENC, errors="replace") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith(";"):
                continue
            if line.upper() == "[ROOT]":
                in_root = True
                continue
            if line.startswith("["):
                in_root = False
                continue
            if not in_root:
                continue
            if line[:12].upper() == "DESCRIPTION=":
                description = line[12:].strip()
                continue
            if line[:6].upper() == "ENTRY=":
                parts = line[6:].split(",")
                code = parts[0].strip()
                label = parts[1].strip() if len(parts) > 1 else code
                if not code:
                    continue
                sgbd = res.resolve_sgbd(code, "SONDER")
                if sgbd is not None:
                    ecus.append({"code": code, "label": label, "sgbd": sgbd,
                                 "group": res.group_file_for(code)})
                else:
                    drops.append(("SONDER", "ROOT", code, label))
    if not ecus:
        return None
    return {"id": "SONDER", "description": description,
            "sections": [{"key": "ROOT_SONDER", "name": "Special tests",
                          "ecus": ecus}]}


def merge_sections(base, extra, tag):
    """Append extra's entries into base, new codes only, keeping order."""
    have = {e["code"].lower() for s in base["sections"] for e in s["ecus"]}
    added = 0
    for xs in extra["sections"]:
        dst = next((s for s in base["sections"]
                    if s["key"].upper() == xs["key"].upper()), None)
        news = [e for e in xs["ecus"] if e["code"].lower() not in have]
        if not news:
            continue
        if dst is None:
            dst = {"key": xs["key"], "name": xs["name"], "ecus": []}
            base["sections"].append(dst)
        for e in news:
            dst["ecus"].append(e)
            have.add(e["code"].lower())
            added += 1
    base["sections"].sort(key=section_index_of_section)
    return added


def build(legacy=False):
    """All chassis configs: {id: chassis_dict}, plus the ordered id list."""
    res = Resolver(legacy=legacy)
    drops = None if legacy else []
    out = {}
    german = []
    for cid in chassis_ids(legacy):
        path, is_ger = chassis_file(cid, legacy)
        if not path:
            continue
        if is_ger:
            german.append(cid)
        out[cid] = load_chassis(cid, path, res, drops, legacy=legacy)
    if not legacy:
        # fix 2: BMW_ALT chassis + legacy-E36 merge, and the special tests
        alt = load_bmw_alt(res, drops)
        merged = {}
        for cid, ch in alt.items():
            if cid in out:
                merged[cid] = merge_sections(out[cid], ch, "BMW_ALT")
            else:
                out[cid] = ch
        # SONDER is not a car. SONDER.ENG holds standalone special tests
        # (quick test, ABS bleed, steering-angle adjust) belonging to no
        # chassis, so listing it beside E46 and F30 offered a "vehicle"
        # that is not one. load_sonder() stays for whoever wants those
        # tests surfaced somewhere they fit.
        for ch in out.values():
            ch["variantGroups"] = variant_groups(res, ch)
        ids = sorted(out.keys())
        if german:
            print(f"  German-only menus (no .ENG shipped): {', '.join(german)}"
                  " -- labels stay German")
        for cid, n in merged.items():
            if n:
                print(f"  BMW_ALT: merged {n} legacy entries into {cid}")
        if drops:
            print(f"  {len(drops)} entries dropped (SGBD unresolved):")
            for cid, sec, code, label in drops:
                print(f"    {cid:14} {sec:24} {code:10} {label}")
    else:
        for ch in out.values():
            ch["variantGroups"] = variant_groups(res, ch)
        ids = sorted(out.keys())
    return ids, out


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def main():
    legacy = "--legacy" in sys.argv
    check = "--check" in sys.argv
    out_dir = OUT
    if "--out" in sys.argv:
        i = sys.argv.index("--out")
        if i + 1 >= len(sys.argv):
            # a trailing --out used to die with a bare IndexError
            sys.exit("--out needs a directory argument")
        out_dir = sys.argv[i + 1]

    ids, chassis = build(legacy=legacy)

    # NEVER OVERWRITE THE COMMITTED CACHE WITH AN EMPTY BUILD. Everything
    # here is derived from vendor/EC-APPS/INPA, which is gitignored -- so in
    # a fresh clone, or in a git worktree, chassis_ids() finds nothing and
    # returns []. That is not an error state the old code noticed: it wrote
    # index.json as "[]", left the 26 per-chassis files stale beside it
    # (the write loop below simply never runs), printed "0 chassis, 0
    # entries" and exited 0. Silent destruction of a committed file, with a
    # success code, in exactly the state a new checkout is in.
    if not ids:
        sys.exit("no chassis found: vendor/EC-APPS/INPA is missing "
                 "(run scripts/setup/fetch-vendor.sh)")

    if check:
        bad = 0
        for name, payload in [("index", dumps(ids))] + \
                             [(cid, dumps(chassis[cid])) for cid in ids]:
            p = os.path.join(OUT, f"{name}.json")
            old = open(p, "rb").read() if os.path.exists(p) else None
            new = payload.encode("utf-8")
            if old is None:
                print(f"  NEW      {name}.json ({len(new)} bytes)")
            elif old != new:
                print(f"  CHANGED  {name}.json ({len(old)} -> {len(new)} bytes)")
                bad += 1
            else:
                print(f"  ok       {name}.json")
        existing = {os.path.splitext(n)[0] for n in os.listdir(OUT)
                    if n.endswith(".json")} - {"index"}
        for gone in sorted(existing - set(ids)):
            print(f"  MISSING  {gone}.json (in cache, not regenerated)")
            bad += 1
        return 1 if bad else 0

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        f.write(dumps(ids))
    for cid in ids:
        with open(os.path.join(out_dir, f"{cid}.json"), "w",
                  encoding="utf-8") as f:
            f.write(dumps(chassis[cid]))
    total = sum(len(s["ecus"]) for c in chassis.values()
                for s in c["sections"])
    print(f"{len(ids)} chassis, {total} entries -> {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
