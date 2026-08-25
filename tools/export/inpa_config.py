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
  6. Group derivation is validated against what the group can identify (see
     group_file_for): T_GRTB.PRG first (BMW's own variant->group table), then
     .IPO tokens -- numeric AND named (D_ZKE_GM, D_XEN_L...) -- and the _xx
     address suffix, each accepted only when the group's decrypted string
     pool names the resolved SGBD, then an ecucomment scan over all groups.
     Legacy's first-existing-token-except-D_0080 rule mapped E46 kombi to
     D_000D (the E30-era cluster group) and chassis-suffixed codes like
     ALC_60/EKP_60/RDC_60 to whatever group had that hex address (D_0060 is
     the PDC group), which makes strict variant resolution mark present
     modules absent.
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
# INFRASTRUCTURE .PRGs THAT ARE NOT A MODULE'S SGBD. The token scan below is a
# last resort: it takes uppercase words out of an .IPO and keeps the first one
# that happens to name a file on disk. For F-series entries no real SGBD exists
# in this EDIABAS tree, so the walk ran past the ECU's own name into shared
# infrastructure and stopped at whichever of these it hit first --
#   T_GRTB  BMW's ZuordnungsTabelle, the variant->group table this very file
#           reads as a lookup (see group_file_for); 105 entries
#   f01     the chassis's own menu: its jobs are all *_FUNKTIONAL broadcasts
#           plus GRP2SGADR, i.e. it addresses many modules, it is not one; 85
# 190 of 1,249 shipped entries pointed at one of them, DSC_01 (stability
# control), ASA_01 (active steering) and EMF_01 (parking brake) among them.
# Both files exist and load, so the wrong-module read fails SILENTLY. None of
# the 190 has a real .prg available, so None is the honest answer.
# Detected from the .prg's own job list rather than named here, so a new
# chassis menu is caught without an edit: an ECU SGBD asks ONE module its own
# questions, while these ask MANY modules the same one. Corpus-wide this
# matches exactly three files -- t_grtb, f01, r56 -- and no real module.
#   FLASH   the flash-PROGRAMMING service, not any module's identity: E70's
#           FKA_70 (rear climate) and CHAMP_GW both landed on it. It is in
#           GENERIC_IPO_TOKENS already, but that only DEPRIORITISES a token --
#           with nothing better on the list it still won.
NOT_AN_ECU_SGBD = {"t_grtb", "flash"}


def _same_module(code, token):
    """Does this token name the ECU we are resolving, rather than a shared one?"""
    c, t = code.lower(), token.lower()
    return c.startswith(t) or t.startswith(c)


# the SGBD list a script declares carries version suffixes and dsN variants
# ("ZKE3_GM5/V0.07", "MS410DS1") -- compare on the bare stem
def _sgbd_stems(decl):
    out = set()
    for x in re.split(r"[,;\s]+", decl or ""):
        x = x.strip().lower()
        if not x:
            continue
        base = x.split("/")[0]
        out.add(x)
        out.add(base)
        out.add(re.sub(r"ds\d$", "", base))
    return {x for x in out if x}


def _declared_match(token, declared):
    t = token.lower()
    base = re.sub(r"ds\d$", "", t.split("/")[0])
    return t in declared or base in declared
# ...and a FUNCTIONAL GATEWAY is recognised from its own string pool rather
# than named here, so a new chassis menu is caught without an edit: it declares
# *_FUNKTIONAL broadcast jobs, which address many modules at once. A real
# module SGBD has none. Corpus-wide this matches f01 and r56 and nothing else.
_FUNKTIONAL_RUN = re.compile(rb"[A-Z0-9_]+_FUNKTIONAL")
GROUP_TOKEN_RE = re.compile(r"D_00[0-9A-Fa-f]{2}")
# named group references (D_ZKE_GM, D_MOTOR, ...): a full D_* identifier, so a
# D_0072B-style stem is not clipped to its numeric prefix
GROUP_NAME_RE = re.compile(r"D_[0-9A-Za-z_]+")
# printable runs in a decrypted (XOR 0xF7) SGBD body -- the string pool
POOL_RUN_RE = re.compile(rb"[ -~]{3,}")
# a T_GRTB ZuordnungsTabelle row starts with its ident column: "01 ---- 0110"
GRTB_ROW_RE = re.compile(r"^[0-9A-Fa-f]{2} [0-9A-Fa-f-]{4} [0-9A-Fa-f]{4}$")
# a chassis code inside an ecucomment (D_EXX: "for E60 E65 E70 E89X R56 RR1")
# describes applicability, not a member SGBD
CHASSIS_WORD_RE = re.compile(r"^(e|f|g|r|rr|k)\d+x?$")


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
        # stem (lower) -> on-disk FILENAME, to read the .grp body itself
        self.grp_file = {os.path.splitext(n)[0].lower(): n
                         for n in ecu_names if n.lower().endswith(".grp")}
        self._pool_cache = {}   # grp stem (lower) -> (all names, ecucomment names)
        self._grtb = None       # sgbd (lower) -> group name, from T_GRTB.PRG
        self._infra_cache = {}  # stem -> is it a table/gateway rather than an ECU
        self._decl_cache = {}   # code -> the SGBD names its script declares
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

    def _is_infrastructure(self, stem):
        """Is this .prg a lookup table or a broadcast gateway, not an ECU?

        Only consulted on the TOKEN-SCAN path, which is a last resort: a
        directly resolved SGBD is trusted as-is. See NOT_AN_ECU_SGBD.
        """
        key = stem.lower()
        if key in NOT_AN_ECU_SGBD:
            return True
        if key in self._infra_cache:
            return self._infra_cache[key]
        fn = self.prg.get(key)
        infra = False
        if fn:
            try:
                with open(os.path.join(ECU, fn + ".prg"), "rb") as f:
                    raw = f.read()
            except OSError:
                try:
                    with open(os.path.join(ECU, fn), "rb") as f:
                        raw = f.read()
                except OSError:
                    raw = b""
            # the pool is XOR 0xF7 in these dumps (same as group_pool below),
            # but plain in others -- check both rather than assume
            infra = bool(_FUNKTIONAL_RUN.search(raw)) or bool(
                _FUNKTIONAL_RUN.search(bytes(b ^ 0xF7 for b in raw)))
        self._infra_cache[key] = infra
        return infra

    def declared_sgbds(self, code):
        """The SGBD names this script says it drives, or None.

        __inpa_startup__ stores a header block into globals; the one that
        every INPAapiJob(sgbd, ...) reads as argument 0 is the SGBD list.
        Found by asking which global the job calls use, rather than assuming
        a slot number -- the header layout differs per script (13 in GSDS2,
        9 in AIRBAG, 5 in ABSASC5, 17 in ACC).
        """
        key = code.lower()
        if key in self._decl_cache:
            return self._decl_cache[key]
        out = None
        try:
            out = self._read_declared(key)
        except Exception:
            out = None
        self._decl_cache[key] = out
        return out

    def _read_declared(self, key):
        import ipo_disasm as D                      # decompiler, optional dep
        data, ps, pool, decls = D.load(key)
        if ps is None:
            return None
        procs = {}
        for k, (off, typ, nm, pid) in enumerate(decls):
            lo = off + 1 + len(nm) + 1 + 4 + 1
            hi = decls[k + 1][0] if k + 1 < len(decls) else ps
            try:
                procs[nm] = D.walk(data, lo, hi, pool)[0]
            except Exception:
                pass
        slot = None
        for nm, toks in procs.items():
            for i, t in enumerate(toks):
                if t["op"] == "call" and t.get("name") in (
                        D.JOB_CALLS | {"INP1apiJob"}):
                    pos = D.arg_positions(D.frame_of(toks, i))
                    if pos and pos[0][-1]["op"] == "var" \
                            and pos[0][-1].get("sc") == 0:
                        slot = pos[0][-1]["n"]
                        break
            if slot is not None:
                break
        if slot is None:
            return None
        st = procs.get("__inpa_startup__") or []
        for i, t in enumerate(st):
            if t["op"] == "store" and t.get("sc") == 0 and t["n"] == slot:
                prev = st[i - 1] if i else None
                if prev and prev["op"] == "const" \
                        and isinstance(prev.get("v"), str):
                    return _sgbd_stems(prev["v"])
        return None

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
            if not hit or self._is_infrastructure(hit):
                continue
            # A GENERIC token only wins when it IS this ECU (the EWS module
            # really is ews.prg). Unrelated, it is just the first shared word
            # in the .IPO that happens to name a file -- which is how DSC_01
            # landed on UTILITY and FKA_70 on FLASH. Excluding one such token
            # only uncovers the next, so the rule is relatedness, not a list.
            if variant.upper() in GENERIC_IPO_TOKENS \
                    and not _same_module(code, variant):
                continue
            # ...and THE SCRIPT ITSELF SAYS WHICH SGBDs IT DRIVES. __inpa_startup__
            # writes a header block, and one of those globals is the SGBD list
            # that every INPAapiJob(sgbd, ...) call then passes as argument 0.
            # That is how INPA knows what to load, so it is the authority here:
            #   AIRBAG   -> "ZAE,BAE,ZAE2,MRS2,MRS3,MRS4,MRS4RD"  (zae is real)
            #   ABSASC5  -> "ABS5, ASC5, ASC5D, ABD5, DSC5, ..."
            #   DDE73N57 -> "D73N57A0,D73N57E0,D72N47A0"          (NOT acc)
            # Without it the scan took "ACC" out of DDE73N57's display text
            # ("ACC Stop&Go", a feature the DME reports on) and pointed a
            # diesel DME at the cruise-control SGBD.
            declared = self.declared_sgbds(code)
            # `set()` is not "no declaration": the script stored an SGBD
            # global and it was empty, which says it names none. Only None
            # (no such global at all) leaves the scan unguarded.
            if declared is not None and not _declared_match(variant, declared):
                continue
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

    def ipo_named_group_tokens(self, code):
        """Distinct non-numeric D_* tokens in the .IPO (D_ZKE_GM, D_MOTOR...).

        The numeric D_00xx forms stay ipo_group_tokens' business; everything
        else that names an existing .grp is a candidate. Most D_* matches are
        job RESULT names (D_BMW_NR, D_SW_NR...), which never name a .grp and
        are filtered out by the caller's find_grp.
        """
        n = self.ipo.get(code.lower())
        if not n:
            return []
        out, seen = [], set()
        for m in GROUP_NAME_RE.finditer(self._read_sgdat(n)):
            t = m.group(0)
            if GROUP_TOKEN_RE.fullmatch(t):
                continue
            if t.lower() not in seen:
                seen.add(t.lower())
                out.append(t)
        return out

    def grp_pool(self, name):
        """(all printable names, ecucomment member names) of a .grp, lowercased.

        Group SGBD strings are XOR 0xF7 in this dump. The 'ecucomment:' string
        is the group's own member list ("ecucomment:bc1, zke3, zke4, zke5...")
        and is the trustworthy signal; the full string set additionally holds
        the members as standalone pool entries. The literal 't_grtb' is the
        external ZuordnungsTabelle reference every newer group carries, never
        a member, so it is dropped.
        """
        key = name.lower()
        if key not in self._pool_cache:
            names, members = set(), set()
            fn = self.grp_file.get(key)
            if fn:
                try:
                    with open(os.path.join(ECU, fn), "rb") as f:
                        dec = bytes(b ^ 0xF7 for b in f.read())
                except OSError:
                    dec = b""
                for m in POOL_RUN_RE.finditer(dec):
                    run = m.group(0).decode("latin-1").lower()
                    names.add(run)
                    if run.startswith("ecucomment:"):
                        for w in re.split(r"[,\s]+", run[len("ecucomment:"):]):
                            if w and not CHASSIS_WORD_RE.fullmatch(w):
                                members.add(w)
                names |= members
                names.discard("t_grtb")
                members.discard("t_grtb")
            self._pool_cache[key] = (names, members)
        return self._pool_cache[key]

    def pool_member(self, grp_name, sgbd):
        """Does the group's string pool name this SGBD at all?"""
        return (sgbd or "").lower() in self.grp_pool(grp_name)[0]

    def ecucomment_scan(self, sgbd):
        """The .grp whose ecucomment lists this SGBD: numeric groups first
        (address order), then named groups, both sorted -- deterministic."""
        want = (sgbd or "").lower()
        if not want:
            return None
        stems = sorted(self.grp)
        ordered = [s for s in stems if re.fullmatch(r"d_00[0-9a-f]{2}", s)] + \
                  [s for s in stems if not re.fullmatch(r"d_00[0-9a-f]{2}", s)]
        for stem in ordered:
            if want in self.grp_pool(stem)[1]:
                return self.grp[stem]
        return None

    def grtb_group(self, sgbd):
        """BMW's own variant->group table: T_GRTB.PRG, the ZuordnungsTabelle
        every newer D_* group delegates to. Rows are (ident, SGBD, GRUPPE,
        BAUREIHE, description); across the whole table no SGBD maps to two
        groups, so the lookup needs no chassis disambiguation."""
        if self._grtb is None:
            self._grtb = {}
            path = None
            if os.path.isdir(ECU):
                for n in os.listdir(ECU):
                    if n.lower() == "t_grtb.prg":
                        path = os.path.join(ECU, n)
                        break
            if path:
                try:
                    with open(path, "rb") as f:
                        dec = bytes(b ^ 0xF7 for b in f.read())
                except OSError:
                    dec = b""
                runs = [m.group(0).decode("latin-1")
                        for m in re.finditer(rb"[ -~]{2,}", dec)]
                i = 0
                while i < len(runs):
                    if GRTB_ROW_RE.match(runs[i]) and i + 2 < len(runs) \
                            and runs[i + 2].upper().startswith("D_"):
                        self._grtb.setdefault(runs[i + 1].lower(), runs[i + 2])
                        i += 3
                    else:
                        i += 1
        return self._grtb.get((sgbd or "").lower())

    def find_grp(self, name):
        """FindGrpCaseInsensitive: returns the QUERY casing on a hit."""
        return name if name.lower() in self.grp else None

    def group_file_for(self, code, sgbd):
        """The diagnostic-address group SGBD for a module, or None.

        Legacy took the first existing D_00xx token (except D_0080) and then
        an address spelled as the code's _xx suffix. Both misfire: KOMBI.IPO
        names D_000D (E30-era clusters) before D_0080 (where kombi46 really
        lives), and ALC_60's "_60" is the chassis, not an address (D_0060 is
        the E46 PDC group). fix 6 keeps the same candidate sources but only
        accepts a candidate that can actually identify this SGBD:

          1. T_GRTB.PRG, BMW's own variant->group table (KWP2000-era modules)
          2. .IPO tokens, numeric then named, accepted when the group's string
             pool names the resolved SGBD (this also retires the blanket
             D_0080 ban: a spurious broadcast reference never validates, the
             cluster's own reference does)
          3. the _xx address suffix, same pool test
          4. any group whose ecucomment member list has the SGBD
          5. nothing validated: the legacy order (numeric minus D_0080, then
             named tokens, then suffix) -- pools go stale (D_0012 never heard
             of D50M57D0), so an unvalidated address-token beats no group
        """
        if self.legacy:
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
        grtb = self.grtb_group(sgbd)
        if grtb:
            hit = self.find_grp(grtb)
            if hit:
                return hit
        tokens = self.ipo_group_tokens(code) + self.ipo_named_group_tokens(code)
        for token in tokens:
            hit = self.find_grp(token)
            if hit and self.pool_member(hit, sgbd):
                return hit
        m = re.search(r"_([0-9A-Fa-f]{2})$", code or "")
        suffix_hit = self.find_grp("D_00" + m.group(1).upper()) if m else None
        if suffix_hit and self.pool_member(suffix_hit, sgbd):
            return suffix_hit
        hit = self.ecucomment_scan(sgbd)
        if hit:
            return hit
        for token in self.ipo_group_tokens(code):
            if token.lower() == "d_0080":
                continue  # broadcast: unvalidated, the old rationale stands
            hit = self.find_grp(token)
            if hit:
                return hit
        # a media-box .IPO references every group on the MOST ring (NAV_60
        # names 16); prefer the one whose stem matches the entry's own name
        # (NAV_60 -> D_NAV), keeping .IPO order within a rank
        malpha = re.match(r"[A-Za-z]+", code or "")
        alpha = malpha.group(0).upper() if malpha else ""
        named = [t for t in self.ipo_named_group_tokens(code)
                 if self.find_grp(t)]

        def named_rank(token):
            stem = token[2:].upper()
            return 0 if alpha and (stem.startswith(alpha)
                                   or alpha.startswith(stem)) else 1

        if named:
            return self.find_grp(min(named, key=named_rank))
        return suffix_hit


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
                             "group": res.group_file_for(code, sgbd)}
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
                         "group": res.group_file_for(code, sgbd)})
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
                                 "group": res.group_file_for(code, sgbd)})
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
