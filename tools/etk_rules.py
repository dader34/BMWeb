#!/usr/bin/env python3
"""The ETK's own line filter, ported from the catalogue's Java client.

    tools/etk_rules.py --db etk.sqlite --btnr 51_3267 --vin NJ87379
    tools/etk_rules.py --db etk.sqlite --btnr 51_3267 --vin NJ87379 --text 35172=1
    tools/etk_rules.py --db etk.sqlite --btnr 51_3267 --mosp 47720 --prod 200409 --steer L
    tools/etk_rules.py --db etk.sqlite --btnr 51_3267 --vin NJ87379 --explain

WHAT THIS IS. BMW's ETK (v3.2.20, 01/2020) is a Java application; its line
filter lives in javaclient.jar, packages webetk.app.bteanzeige (CurrentBTE,
Bedingung, Obergruppe, Element, Changepoint) and webetk.app (Bedingungsmenge).
This file is that logic, method for method, against the etk.sqlite dump
(see docs/etk-filter-rules.md for the walk-through and the table map). It is
the ORACLE for the app's port: given a diagram and a car it prints exactly the
rows the catalogue would show, so the JS side can be checked against it.

THE PIPELINE (BaseTextteil.aktualisierenZeilenFzg, in this order):

  1. load the lines of the diagram for the car's model column (mospid)
  2. auswertenEinschraenkungFzg: steering, gearbox, build month -- per line,
     with the catalogue's tolerances (2 months early, 1 month late, unless
     the car came from a VIN)
  3. auswertenBedingungen: the option/paint/text CONDITIONS -- each diagram
     carries rule expressions over equipment codes; a line tagged with a
     rule letter stays only if its rule evaluates true (or unknown); when a
     rule is fully decided the untagged fallback rows at that callout go
  4. removeKabelbaumRows: wiring-harness rows (alter_kz) only show for a
     dealer VIN with a day-exact build date, so offline they always go
  5. auswertenChangepoints: VIN/plant/date cut-ins (w_btzeilen_cp)
  6. auswertenFahrzeugAlter: rows that apply only to cars older/younger
     than N months (bed_art A/B, bed_alter)
  7. auswertenPGBedingungen: '--' rows tagged with a PG rule letter
"""
import argparse
import datetime
import re
import sqlite3
import sys

T, F, U = 'T', 'F', '?'
ISO = 'en'


# ---------------------------------------------------------------- helpers --
def oder(a, b):
    """Bedingung.ODER: three-valued OR."""
    if a == T or b == T:
        return T
    if a == U or b == U:
        return U
    return F


def und(a, b):
    """Bedingung.UND: three-valued AND."""
    if a == F or b == F:
        return F
    if a == U or b == U:
        return U
    return T


def modify_date(yyyy, mm, months):
    """WebetkUtils.modifyDate: shift a month, back as YYYYMM00."""
    y, m = int(yyyy), int(mm) - 1 + months
    y += m // 12
    m = m % 12 + 1
    return '%04d%02d00' % (y, m)


def name_of(con, textcode, cache={}):
    if textcode in cache:
        return cache[textcode]
    row = con.execute(
        "SELECT ben_text FROM w_ben_gk WHERE ben_textcode=? AND ben_iso=? LIMIT 1",
        (textcode, ISO)).fetchone()
    cache[textcode] = (row[0] if row else '') or ''
    return cache[textcode]


# ------------------------------------------------- the condition evaluator --
class Element:
    """webetk.app.bteanzeige.Element: one equipment code in a rule group."""

    def __init__(self, vz, elemid, regelzeile, ausweisung):
        self.vz = vz or ''
        self.elemid = elemid
        self.regelzeile = regelzeile or ''
        self.ausweisung = ausweisung or ''
        self.code = ''

    def ausw_char(self, i):
        if not self.ausweisung:
            return ' '
        if len(self.ausweisung) == 1:
            return self.ausweisung[0]
        return self.ausweisung[i]

    def set_ausw(self, c, i):
        self.ausweisung = self.ausweisung[:i] + c + self.ausweisung[i + 1:]

    def set_value(self, value):
        """Element.setAusweisung(String): the user's/VIN's answer for this
        code -- '0' unknown, '1' fitted, '2' not fitted -- becomes T/F/? per
        column, honouring the element's sign and the decision-table row."""
        regel = self.regelzeile or None
        value = value if value is not None else '0'
        for i in range(len(self.ausweisung)):
            if self.ausweisung[i] == '-':
                continue
            rz = regel[i] if regel else 'X'
            if value == '0':
                self.set_ausw(U, i)
                continue
            if (rz == 'X' and self.vz == '+') or (rz == '0' and self.vz == '-'):
                self.set_ausw(T if value == '1' else F, i)
            if (rz == 'X' and self.vz == '-') or (rz == '0' and self.vz == '+'):
                self.set_ausw(F if value == '1' else T, i)


class Obergruppe:
    """webetk.app.bteanzeige.Obergruppe: one group of a rule, joined by a
    VArt: U/A = AND, O/R = OR, E/B = decision table (one column per rule
    number), T = boolean expression over the codes."""

    def __init__(self, ogid, vart, fzeile):
        self.id = ogid
        self.vart = vart or ''
        self.fzeile = fzeile or ''
        self.elems = []
        if self.vart in ('E', 'B'):
            self.ausweisung = ''.join(' ' if c == 'X' else '-' for c in self.fzeile)
        else:
            self.ausweisung = ' '

    def ausw_char(self, i):
        if not self.ausweisung:
            return ' '
        if len(self.ausweisung) == 1:
            return self.ausweisung[0]
        return self.ausweisung[i]

    def set_ausw(self, c, i=0):
        if len(self.ausweisung) <= 1:
            self.ausweisung = c
        else:
            self.ausweisung = self.ausweisung[:i] + c + self.ausweisung[i + 1:]

    def convert_fzeile(self):
        """A negated decision table: swap the X and 0 columns."""
        self.fzeile = ''.join('0' if c == 'X' else 'X' for c in self.fzeile if c in 'X0')
        self.ausweisung = ''.join(' ' if c == 'X' else '-' for c in self.fzeile)

    def auswerten(self):
        """-> every value known (no '?')."""
        if self.vart in ('O', 'U', 'A', 'R'):
            return self._index(0)
        if self.vart in ('E', 'B'):
            known = False
            for i in range(len(self.ausweisung)):
                if self.ausweisung[i] != '-':
                    if self._index(i):
                        known = True
            return known
        if self.vart == 'T':
            if not self.fzeile:
                return False
            env = {e.code: e.ausweisung == T for e in self.elems}
            try:
                val = eval_bool(self.fzeile, env)
            except ValueError as exc:
                sys.stderr.write('bad boolean rule %r: %s\n' % (self.fzeile, exc))
                return False
            self.set_ausw(T if val else F)
            return True
        return False

    def _index(self, i):
        known = True
        c = ' '
        for e in self.elems:
            ec = e.ausw_char(i)
            if self.vart in ('O', 'R'):
                c = oder(ec, c)
            if self.vart in ('U', 'A', 'E', 'B'):
                c = und(ec, c)
            if c == U:
                known = False
            self.set_ausw(c, i)
            if (self.vart in ('O', 'R') and c in (U, T)) or \
               (self.vart in ('U', 'E', 'B', 'A') and c == F):
                break
        return known


class Bedingung:
    """webetk.app.bteanzeige.Bedingung: one rule letter of a diagram. Its
    Gesamtterm joins the groups (SALA_P & AFL ...); the groups hold the
    codes. auswerten() tells which rule keys hold for the car."""

    def __init__(self, kuerzel, vz, gesamtterm):
        self.kuerzel = kuerzel
        self.vz = vz or ''
        self.gesamtterm = gesamtterm or ''
        self.ausweisung = ' '
        self.ogs = []

    def auswerten(self):
        """-> {rule key: fully decided}. A key is present when the rule is
        true or undecidable ('?' counts as true: the catalogue shows a line
        it cannot rule out)."""
        complete = True
        for og in self.ogs:
            if og.vart in ('E', 'B'):
                et_vz = self.gesamtterm[0] if self.gesamtterm else ''
                if self.vz == '-' and et_vz == '-':
                    self.vz = '+'
                    self.gesamtterm = self.gesamtterm[1:]
                elif self.vz == '-' or et_vz == '-':
                    self.vz = '+'
                    if et_vz == '-':
                        self.gesamtterm = self.gesamtterm[1:]
                    og.convert_fzeile()
                    self.ausweisung = og.ausweisung
            if og.vart == 'T' and self.vz == '-' and og.fzeile:
                og.fzeile = '!(' + og.fzeile + ')'
            if not og.auswerten():
                complete = False
        out = {}
        n = len(self.ausweisung)
        for i in range(1, n + 1):
            if self.ausweisung[i - 1] != '-':
                c = self._index(i - 1)
                if c != F:
                    key = self.kuerzel + (str(i) if n > 1 else '')
                    out[key] = complete
        return out

    def _index(self, i):
        """Bedingung.auswertenIndex: substitute each group's verdict into the
        Gesamtterm and reduce it with the catalogue's rewrite table."""
        if not self.gesamtterm:
            return ' '
        term = self.gesamtterm.replace(' ', '')
        for og in self.ogs:
            term = term.replace(og.id, og.ausw_char(i))
        rewrites = [
            ('T&T', T), ('T&F', F), ('T&?', U), ('F&T', F), ('F&F', F), ('F&?', F),
            ('?&T', U), ('?&F', F), ('?&?', U),
            ('T/T', T), ('T/F', T), ('T/?', T), ('F/T', T), ('F/F', F), ('F/?', U),
            ('?/T', T), ('?/F', U), ('?/?', U),
            ('(T)', T), ('(F)', F), ('(?)', U),
            ('-T', F), ('-F', T), ('-?', U), ('+T', T), ('+F', F), ('+?', U),
        ]
        while len(term) > 1:
            before = len(term)
            for src, dst in rewrites:
                term = term.replace(src, dst)
            if len(term) == before:
                term = T   # "nicht auswertbar => wird auf T gesetzt"
                break
        c = term[0]
        if self.vz == '-':
            c = F if c == T else T
        if c == U:
            c = T
        self.ausweisung = self.ausweisung[:i] + c + self.ausweisung[i + 1:]
        return c


def eval_bool(expr, env):
    """The 'T' group's JEXL expression: !, &&, ||, parentheses, codes."""
    toks = re.findall(r'&&|\|\||[!()]|[A-Za-z0-9_]+', expr)
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else None

    def take():
        t = peek()
        pos[0] += 1
        return t

    def atom():
        t = take()
        if t == '!':
            return not atom()
        if t == '(':
            v = orx()
            if take() != ')':
                raise ValueError('missing )')
            return v
        if t is None or t in ('&&', '||', ')'):
            raise ValueError('unexpected %r' % t)
        return bool(env.get(t, False))

    def andx():
        v = atom()
        while peek() == '&&':
            take()
            v = atom() and v
        return v

    def orx():
        v = andx()
        while peek() == '||':
            take()
            v = andx() or v
        return v

    v = orx()
    if peek() is not None:
        raise ValueError('trailing %r' % peek())
    return v


# ----------------------------------------------------------------- the car --
class Car:
    """FzgSucheInfo, the part of it the filter reads."""

    def __init__(self):
        self.mosp = None
        self.typ = None
        self.werk = None
        self.prod = None          # YYYYMMDD, day 00 when month-exact
        self.steer = None         # L / R
        self.gear = None          # A / M
        self.vin = None           # 7-char production number
        self.by_vin = False
        self.sa = []              # option codes the car has, as S760A
        self.values = {}          # elemid -> '1': the order's codes (VIN table or --sa)
        self.answers = {}         # elemid -> '0'/'1'/'2' the reader answered (--text)

    @property
    def baujahr(self):
        return self.prod[:4] if self.prod else None

    @property
    def zulmonat(self):
        return self.prod[4:6] if self.prod else None


def identify(con, car, args):
    """RETRIEVE_MOSP_BY_FGSTNR / the explicit facts on the command line."""
    if args.vin:
        vin = args.vin.upper()
        if len(vin) == 17:
            vin = vin[10:]
        row = con.execute(
            "SELECT fgstnr_mospid, fgstnr_typschl, fgstnr_prod, fgstnr_werk FROM w_fgstnr "
            "WHERE fgstnr_anf=? AND fgstnr_von<=? AND fgstnr_bis>=?",
            (vin[:2], vin, vin)).fetchone()
        if not row:
            sys.exit('VIN %s is not in w_fgstnr' % vin)
        car.vin = vin
        car.by_vin = True
        car.mosp, car.typ, car.werk = row[0], row[1], row[3]
        car.prod = str(row[2])
        ft = con.execute(
            "SELECT fztyp_lenkung, fztyp_getriebe FROM w_fztyp WHERE fztyp_mospid=? AND fztyp_typschl=?",
            (car.mosp, car.typ)).fetchone()
        if ft:
            car.steer = ft[0] if ft[0] in ('L', 'R') else None
            car.gear = ft[1] if ft[1] in ('A', 'M') else None
        for (sid,) in con.execute(
                "SELECT fgstnrs_salaid FROM w_fgstnr_sala WHERE fgstnrs_fgstnr=?", (vin,)):
            car.values[sid] = '1'
    if args.mosp:
        car.mosp = int(args.mosp)
    if args.prod:
        p = re.sub(r'\D', '', args.prod)
        car.prod = (p + '00000000')[:8] if len(p) in (6, 8) else sys.exit('--prod YYYYMM or YYYYMMDD')
    if args.steer:
        car.steer = args.steer.upper()
    if args.gear:
        car.gear = args.gear.upper()
    if args.typ:
        car.typ = args.typ.upper()
    if args.werk:
        car.werk = args.werk
    if car.mosp is None:
        sys.exit('need --vin or --mosp')
    for code in (args.sa or '').split(','):
        code = code.strip().upper().lstrip('$')
        if code:
            car.sa.append(code)
    for kv in args.text or []:
        k, v = kv.split('=')
        car.answers[int(k)] = v


def resolve_sa(con, car):
    """LOAD_SS_BEDINGUNGEN_SALAPA: an option code the car carries -> the
    condition element(s) it is, valid at the build date (BMW reused the
    numbers). Accepts S760A, 760A, 760."""
    prod = int(car.prod) if car.prod else None
    for code in car.sa:
        m = re.match(r'^([A-Z])?(\d{3}|[0-9][A-Z0-9]{2})([A-Z])?$', code)
        if not m:
            continue
        art, pnr, hz = m.groups()
        sql = ("SELECT bedsala_id FROM w_bed_sala WHERE bedsala_produktart='P' AND bedsala_pnr=? "
               "AND bedsala_art NOT IN ('N','V')")
        params = [pnr]
        if prod:
            sql += " AND bedsala_gilt_v<=? AND ifnull(bedsala_gilt_b,99999999)>=?"
            params += [prod, prod]
        if art:
            sql += " AND bedsala_art=?"
            params.append(art)
        if hz:
            sql += " AND bedsala_hz=?"
            params.append(hz)
        for (sid,) in con.execute(sql, params):
            car.values[sid] = '1'


# --------------------------------------------------------------- the lines --
class Line:
    def __init__(self, r):
        (self.pos, self.bildnr, self.sachnr, self.kat, self.auto, self.lenkg, self.eins,
         self.auslf, self.bedkz, self.gruppe, self.block, self.bedkz_pg, self.menge,
         self.alter_kz, self.bed_art, self.bed_alter, self.name) = r
        self.eins = str(self.eins) if self.eins else ''
        self.auslf = str(self.auslf) if self.auslf else ''
        self.lenkg = self.lenkg or ''
        self.auto = self.auto or ''
        self.bildnr_int = 0
        self.cps = []
        self.removed = None

    def __repr__(self):
        return '%s %s %s %s' % (self.pos, self.bildnr, self.sachnr, self.name)


def load_lines(con, btnr, car):
    """LOAD_BTZEILEN_FZG, the columns the filter reads."""
    rows = con.execute(
        "SELECT z.btzeilen_pos, z.btzeilen_bildposnr, z.btzeilen_sachnr, z.btzeilen_kat, "
        "z.btzeilen_automatik, z.btzeilen_lenkg, z.btzeilen_eins, z.btzeilen_auslf, "
        "CASE WHEN z.btzeilen_bedkez IS NULL THEN NULL ELSE z.btzeilen_bedkez||ifnull(z.btzeilen_regelnr,'') END, "
        "z.btzeilen_gruppeid, z.btzeilen_blocknr, z.btzeilen_bedkez_pg, v.btzeilenv_vmenge, "
        "v.btzeilenv_alter_kz, v.btzeilenv_bed_art, v.btzeilenv_bed_alter, "
        "(SELECT ben_text FROM w_ben_gk WHERE ben_textcode=t.teil_textcode AND ben_iso=? LIMIT 1) "
        "FROM w_btzeilen_verbauung v JOIN w_btzeilen z ON z.btzeilen_btnr=v.btzeilenv_btnr AND z.btzeilen_pos=v.btzeilenv_pos "
        "LEFT JOIN w_teil t ON t.teil_sachnr=z.btzeilen_sachnr "
        "WHERE v.btzeilenv_mospid=? AND v.btzeilenv_btnr=? ORDER BY z.btzeilen_pos",
        (ISO, car.mosp, btnr)).fetchall()
    lines = []
    merk = 0
    for r in rows:
        ln = Line(r)
        if ln.bildnr is not None and ln.bildnr != '--':
            try:
                merk = int(ln.bildnr)
            except ValueError:
                merk = 0
        elif ln.bildnr is None:
            merk = 0
        ln.bildnr_int = merk
        lines.append(ln)
    return lines


def load_changepoints(con, btnr, car, lines):
    sql = ("SELECT btzeilenc_pos, btzeilenc_typschl, btzeilenc_werk, btzeilenc_art, btzeilenc_datum, "
           "btzeilenc_vin, btzeilenc_vin_proddatum, btzeilenc_vin_min, btzeilenc_vin_max, btzeilenc_alter "
           "FROM w_btzeilen_cp WHERE btzeilenc_mospid=? AND btzeilenc_btnr=?")
    params = [car.mosp, btnr]
    if car.typ and car.werk:
        sql += " AND btzeilenc_typschl=? AND btzeilenc_werk=?"
        params += [car.typ, car.werk]
    by_pos = {}
    for r in con.execute(sql + " ORDER BY btzeilenc_pos", params):
        by_pos.setdefault(r[0], []).append(r[1:])
    for ln in lines:
        ln.cps = by_pos.get(ln.pos, [])
    return [r for r in con.execute(
        "SELECT bildtafc_art, bildtafc_datum FROM w_bildtaf_cp WHERE bildtafc_btnr=?", (btnr,))]


# ------------------------------------------- step 2: steering/gearbox/date --
def einschraenkung(lines, car, explain):
    """CurrentBTE.auswertenEinschraenkungFzg, decoded from bytecode: walk the
    lines from the last up, drop a line whose steering, gearbox, start or end
    month contradicts the car, and with it the '--' lines hanging under it
    that fail the same test."""
    steer = car.steer or 'kA'
    gear = car.gear or 'kA'
    year = car.baujahr or 'kA'
    month = car.zulmonat or 'kA'
    if steer == gear == year == month == 'kA':
        return
    d_eins = d_ausl = 0
    if year != 'kA':
        if month == 'kA':
            d_eins = int(year + '1200')
            d_ausl = int(year + '0100')
        else:
            d_eins = d_ausl = int(year + month + '00')
    by_vin = car.by_vin

    def kill(i, why, test):
        ln = lines[i]
        if ln.bildnr != '--':
            j = i + 1
            while j < len(lines) and lines[j].bildnr == '--':
                if test(lines[j]):
                    lines[j].removed = why + ' (with its main row)'
                    explain.append(lines[j])
                    del lines[j]
                else:
                    j += 1
        ln.removed = why
        explain.append(ln)
        del lines[i]

    i = len(lines) - 1
    while i >= 0:
        ln = lines[i]
        if steer != 'kA' and ln.lenkg and ln.lenkg != steer:
            kill(i, 'steering %s is not %s' % (ln.lenkg, steer),
                 lambda z: z.lenkg and z.lenkg != steer)
        elif gear != 'kA' and ln.auto and ln.auto != gear:
            kill(i, 'gearbox %s is not %s' % (ln.auto, gear),
                 lambda z: z.auto and z.auto != gear)
        elif year != 'kA':
            def eins_of(z):
                return int(modify_date(z.eins[:4], z.eins[4:6], 0 if by_vin else -2))

            def ausl_of(z):
                return int(modify_date(z.auslf[:4], z.auslf[4:6], -1 if by_vin else 1))

            if ln.eins and d_eins < eins_of(ln):
                kill(i, 'from %s/%s is after the car' % (ln.eins[4:6], ln.eins[:4]),
                     lambda z: z.eins and d_eins < eins_of(z))
            elif ln.auslf and d_ausl > ausl_of(ln):
                kill(i, 'up to %s/%s is before the car' % (ln.auslf[4:6], ln.auslf[:4]),
                     lambda z: z.auslf and d_ausl > ausl_of(z))
        i -= 1


# --------------------------------------------- step 3: the rule conditions --
def load_rules(con, btnr, car):
    """CurrentBTE.ladenBedingungenFzg: LOAD_BEDINGUNGEN_FZG -> Bedingung tree,
    plus LOAD_UEBERBEDINGUNGEN_FZG. Returns (rules, ueber, bte_bedkez)."""
    rows = con.execute(
        "SELECT DISTINCT g.btebg_kez, g.btebg_vz, g.btebg_gesamtterm, o.btebo_ogid, o.btebo_vart, "
        "o.btebo_fzeile, e.btebe_vz, e.btebe_elemid, e.btebe_pos "
        "FROM w_bte_bedkurz k JOIN w_bte_bedgesamt g ON g.btebg_btnr=k.btebk_btnr AND g.btebg_kez=k.btebk_kez "
        "JOIN w_bte_bedog o ON o.btebo_btnr=g.btebg_btnr AND o.btebo_kez=g.btebg_kez "
        "JOIN w_bte_bedelem e ON e.btebe_btnr=o.btebo_btnr AND e.btebe_kez=o.btebo_kez AND e.btebe_ogid=o.btebo_ogid "
        "WHERE k.btebk_btnr=? AND k.btebk_mospid=? "
        "UNION SELECT DISTINCT g.btebg_kez, g.btebg_vz, g.btebg_gesamtterm, o.btebo_ogid, o.btebo_vart, "
        "o.btebo_fzeile, e.btebe_vz, e.btebe_elemid, e.btebe_pos "
        "FROM w_bildtaf b JOIN w_bte_bedgesamt g ON g.btebg_btnr=b.bildtaf_btnr AND g.btebg_kez=b.bildtaf_bedkez "
        "JOIN w_bte_bedog o ON o.btebo_btnr=g.btebg_btnr AND o.btebo_kez=g.btebg_kez "
        "JOIN w_bte_bedelem e ON e.btebe_btnr=o.btebo_btnr AND e.btebe_kez=o.btebo_kez AND e.btebe_ogid=o.btebo_ogid "
        "WHERE b.bildtaf_btnr=? AND b.bildtaf_bedkez IS NOT NULL "
        "ORDER BY 1, 4, 9", (btnr, car.mosp, btnr)).fetchall()
    rules = []
    bed = og = None
    kez_merk = og_merk = ''
    vz = fz = None
    npos = 0
    et = False
    for kez, gvz, term, ogid, vart, fzeile, evz, elemid, pos in rows:
        if kez_merk != kez:
            vz = gvz
            bed = Bedingung(kez, gvz, term)
            rules.append(bed)
            kez_merk, og_merk = kez, ''
        if og_merk != ogid:
            fz = fzeile
            og = Obergruppe(ogid, vart, fzeile)
            et = vart in ('E', 'B')
            npos = 1
            if et:
                bed.ausweisung = og.ausweisung
            bed.ogs.append(og)
            og_merk = ogid
        ausw = ' '
        regel = None
        if et:
            if vz == '+':
                ausw = fz.replace('X', ' ').replace('0', '-')
            else:
                ausw = fz.replace('X', '-').replace('0', ' ')
            n = len(fz)
            regel = ''
            for _ in range(2 ** (npos - 1)):
                half = n // (2 ** npos)
                regel += 'X' * half + '0' * half
            npos += 1
        og.elems.append(Element(evz, elemid, regel, ausw))
    ueber = {}
    for kez, kezu in con.execute(
            "SELECT DISTINCT u.btebu_kez, u.btebu_kezueber FROM w_bte_bedkurz k JOIN w_bte_bedueber u "
            "ON u.btebu_btnr=k.btebk_btnr AND (u.btebu_kez=k.btebk_kez OR u.btebu_kezueber=k.btebk_kez) "
            "WHERE k.btebk_btnr=? AND k.btebk_mospid=? ORDER BY 1, 2", (btnr, car.mosp)):
        ueber.setdefault(kez, []).append(kezu)
    row = con.execute("SELECT bildtaf_bedkez FROM w_bildtaf WHERE bildtaf_btnr=?", (btnr,)).fetchone()
    return rules, ueber, (row[0] if row else None)


def element_info(con, elemids):
    """w_bed + w_bed_sala/w_bed_afl: kind, code, name, exclusive group, SAZ."""
    out = {}
    for eid in elemids:
        r = con.execute(
            "SELECT b.bed_textcode, b.bed_egid, b.bed_ogid, e.eg_exklusiv, "
            "s.bedsala_art, s.bedsala_pnr, s.bedsala_hz, s.bedsala_saz, a.bedafl_code "
            "FROM w_bed b LEFT JOIN w_eg e ON e.eg_id=b.bed_egid "
            "LEFT JOIN w_bed_sala s ON s.bedsala_id=b.bed_elemid "
            "LEFT JOIN w_bed_afl a ON a.bedafl_id=b.bed_elemid WHERE b.bed_elemid=?", (eid,)).fetchone()
        if not r:
            out[eid] = dict(kind='?', code='', name='?', group=None, saz=False)
            continue
        tc, egid, ogid, excl, art, pnr, hz, saz, afl = r
        if ogid == 'AFL':
            kind, code = 'A', afl or ''
        elif ogid == 'TEXT':
            kind, code = 'T', ''
        else:
            kind, code = 'S', (art or '') + (pnr or '') + (hz or '')
        out[eid] = dict(kind=kind, code=code, name=name_of(con, tc),
                        group=str(egid) if (excl or '').upper() == 'J' else None,
                        saz=(saz or '').upper() == 'J')
    return out


def condition_values(info, car):
    """Bedingungsmenge.appendSchnittstellenBedingungen + insertBedingungen:
    the value '0'/'1'/'2' of every element for this car.

    * the car's own codes (VIN table or --sa) are '1'
    * when the car's codes are known at all, every other option code that is
      not retrofittable (SAZ) is '2' -- the catalogue trusts the order
    * in an exclusive group a '1' forces the siblings to '2'
    * anything else is '0' = unknown, which the rules treat as true
    * the reader's answers (--text) override, as the condition dialog does."""
    values = {}
    groups = {}
    iface = {eid for eid, v in car.values.items() if v == '1'}
    has_interface = bool(iface)
    for eid in sorted(info):
        g = info[eid]['group']
        if g:
            groups.setdefault(g, []).append(eid)
    for eid in sorted(info):
        if eid in iface:
            values[eid] = '1'
    for eid in sorted(info):
        if eid in values:
            continue
        inf = info[eid]
        val = '0'
        if inf['group'] and any(values.get(o) == '1' for o in groups.get(inf['group'], [])):
            val = '2'
        if inf['kind'] == 'S' and has_interface and not inf['saz']:
            val = '2'
        values[eid] = val
    for eid, v in car.answers.items():
        if v in ('0', '1', '2'):
            values[eid] = v
    for eid, v in list(values.items()):
        if v == '1' and info.get(eid, {}).get('group'):
            for o in groups.get(info[eid]['group'], []):
                if o != eid and values.get(o) != '1':
                    values[o] = '2'
    return values


def evaluate_rules(rules, info, values):
    """CurrentBTE.setzenAusweisungenElemente + auswertenAusweisungen."""
    for bed in rules:
        for og in bed.ogs:
            for e in og.elems:
                e.set_value(values.get(e.elemid, '0'))
                e.code = info.get(e.elemid, {}).get('code', '')
    out = {}
    for bed in rules:
        out.update(bed.auswerten())
    return out


def strip_digits(d):
    return {re.sub(r'[0-9]*', '', k).strip(): v for k, v in d.items()}


def apply_rules(lines, relevant, ueber, bte_bedkez, explain):
    """CurrentBTE.removeZeilenNichtRelevant and its four passes."""
    if bte_bedkez is not None and (relevant is None or strip_digits(relevant).get(bte_bedkez) is None):
        for ln in lines:
            ln.removed = 'the whole diagram is under rule %s, which fails' % bte_bedkez
            explain.append(ln)
        del lines[:]
    blocks = []

    def add_block(b):
        if b not in blocks:
            blocks.append(b)

    # ByBed: a tagged line whose rule did not come out true
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.bedkz is not None and (relevant is None or ln.bedkz not in relevant):
            add_block(ln.block)
            ln.removed = 'rule %s is false for the car' % ln.bedkz
            explain.append(ln)
            del lines[i]
            while i < len(lines) and lines[i].bildnr == '--':
                lines[i].removed = 'hangs under a line rule %s removed' % ln.bedkz
                explain.append(lines[i])
                del lines[i]
            i -= 1
        i += 1
    # OhneBed: a callout where a tagged line is fully decided true loses its
    # untagged fallback lines
    if relevant:
        decided = []
        for ln in lines:
            if ln.bedkz is not None and relevant.get(ln.bedkz) is True:
                if ln.bildnr_int not in decided:
                    decided.append(ln.bildnr_int)
                add_block(ln.block)
        for bp in decided:
            for ln in list(lines):
                if ln.bildnr_int == bp and ln.bedkz is None:
                    ln.removed = 'callout %02d is decided by a rule; this untagged line yields' % bp
                    explain.append(ln)
                    lines.remove(ln)
    # ByUeberBed: a line under rule K yields to a line of the same group
    # under K's over-rule K' when K' is fully decided true
    if relevant and ueber:
        i = 0
        while i < len(lines):
            ln = lines[i]
            hit = False
            if ln.bedkz is not None and ln.bedkz in relevant:
                for ku in ueber.get(ln.bedkz, []):
                    if relevant.get(ku) is True and any(
                            z.gruppe == ln.gruppe and z.bedkz == ku and
                            ((not z.cps and z.bildnr != '--') or (ln.cps and z.cps == ln.cps))
                            for z in lines):
                        hit = True
                        break
            if hit:
                add_block(ln.block)
                ln.removed = 'over-rule %s takes precedence over %s' % (ku, ln.bedkz)
                explain.append(ln)
                del lines[i]
                while i < len(lines) and lines[i].bildnr == '--':
                    lines[i].removed = 'hangs under a line over-rule %s removed' % ku
                    explain.append(lines[i])
                    del lines[i]
                i -= 1
            i += 1
    # checkZeilenByBlockNr: a block that lost a line loses its '--' lines
    for b in blocks:
        if b and b > 0:
            for ln in list(lines):
                if ln.block == b and ln.bildnr == '--':
                    ln.removed = 'its block %d lost a line' % b
                    explain.append(ln)
                    lines.remove(ln)


# ------------------------------------------------------- steps 4, 5, 6, 7 --
def kabelbaum(lines, car, explain):
    """removeKabelbaumRows: alter_kz lines need a VIN with a day-exact date."""
    day_exact = bool(car.prod) and car.prod[6:8] != '00'
    if car.by_vin and day_exact:
        return
    for ln in list(lines):
        if ln.alter_kz:
            ln.removed = 'wiring-harness age row (needs a day-exact dealer VIN)'
            explain.append(ln)
            lines.remove(ln)


def cp_datum(art, datum, prod):
    if prod is None or datum is None:
        return True
    p = str(prod)
    if len(p) != 8:
        return True
    d = str(datum)
    if p[6:] == '00':
        d, p = d[:6], p[:6]
    return int(p) >= int(d) if art == 'FROM' else int(p) <= int(d)


def cp_vin(art, vin_cp, vin_prod, vin_min, prod, vin):
    if prod is None or vin_cp is None:
        return True
    p = str(prod)[:6]
    d = int(vin_prod)
    if art == 'FROM':
        if int(p) > d:
            return True
        if int(p) < d:
            return False
        return vin.upper() >= (vin_min or '').upper() and vin.upper() >= vin_cp.upper()
    if int(p) < d:
        return True
    if int(p) > d:
        return False
    return vin.upper() >= (vin_min or '').upper() and vin.upper() <= vin_cp.upper()


def cp_kb(art, alter, prod):
    if alter is None:
        return True
    now = datetime.date.today()
    m = now.month - 1 - int(alter)
    y = now.year + m // 12
    m = m % 12 + 1
    cutoff = int('%04d%02d%02d' % (y, m, min(now.day, 28)))
    if art == 'FROM':
        return not (int(prod) >= cutoff)
    return not (int(prod) <= cutoff)


def changepoints(lines, bte_cps, car, explain):
    """auswertenChangepoints: needs a VIN."""
    if not car.vin or not car.prod:
        return
    prod = int(car.prod)
    if any(not cp_datum(art, datum, prod) for art, datum in bte_cps):
        for ln in lines:
            ln.removed = 'the whole diagram is outside its changepoint window'
            explain.append(ln)
        del lines[:]
        return
    if not (car.typ and car.werk):
        return
    drop_hang = False
    for ln in list(lines):
        if drop_hang and ln.bildnr == '--':
            ln.removed = 'hangs under a changepoint-removed line'
            explain.append(ln)
            lines.remove(ln)
            continue
        drop_hang = False
        ok = True
        if not ln.cps:
            ok = not ln.alter_kz
        else:
            for typ, werk, art, datum, vin_cp, vin_prod, vin_min, vin_max, alter in ln.cps:
                if typ != car.typ:
                    continue
                if werk == 'NN':
                    ok = True
                    break
                if werk != car.werk:
                    continue
                if not cp_datum(art, datum, prod) or not cp_vin(art, vin_cp, vin_prod, vin_min, prod, car.vin) \
                        or not cp_kb(art, alter, prod):
                    ok = False
                    break
        if not ok:
            drop_hang = ln.bildnr != '--'
            ln.removed = 'changepoint: not built in for this VIN/plant/date'
            explain.append(ln)
            lines.remove(ln)


def fahrzeug_alter(lines, car, explain):
    """auswertenFahrzeugAlter: bed_art A = only cars older than N months,
    B = only younger."""
    if not car.prod:
        return
    y, m = int(car.prod[:4]), int(car.prod[4:6])
    built = datetime.datetime(y, m, 1)
    months = (datetime.datetime.now() - built).total_seconds() * 1000 / 2.628e9
    for ln in list(lines):
        if ln.bed_art and ln.bed_alter:
            if (ln.bed_art == 'A' and months < ln.bed_alter) or (ln.bed_art == 'B' and months > ln.bed_alter):
                ln.removed = 'car age rule %s %d months' % (ln.bed_art, ln.bed_alter)
                explain.append(ln)
                lines.remove(ln)


def pg_rules(lines, relevant, explain):
    """auswertenPGBedingungen: '--' lines tagged with a PG rule letter."""
    for ln in list(lines):
        if ln.bildnr == '--' and ln.bedkz_pg and (relevant is None or ln.bedkz_pg not in relevant):
            ln.removed = 'PG rule %s is false' % ln.bedkz_pg
            explain.append(ln)
            lines.remove(ln)


# ---------------------------------------------------------------- the run --
def run(con, btnr, car, filtered=True):
    explain = []
    lines = load_lines(con, btnr, car)
    total = len(lines)
    bte_cps = load_changepoints(con, btnr, car, lines)
    einschraenkung(lines, car, explain)
    rules, ueber, bte_bedkez = load_rules(con, btnr, car)
    elemids = sorted({e.elemid for b in rules for og in b.ogs for e in og.elems})
    info = element_info(con, elemids)
    resolve_sa(con, car)
    values = condition_values(info, car)
    relevant = evaluate_rules(rules, info, values) if rules else None
    if filtered and rules:
        apply_rules(lines, relevant, ueber, bte_bedkez, explain)
    if filtered:
        kabelbaum(lines, car, explain)
        changepoints(lines, bte_cps, car, explain)
        fahrzeug_alter(lines, car, explain)
        pg_rules(lines, relevant, explain)
    return dict(lines=lines, removed=explain, total=total, rules=rules, info=info,
                values=values, relevant=relevant, ueber=ueber, bte_bedkez=bte_bedkez)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--db', required=True)
    ap.add_argument('--btnr', required=True, help='diagram number, 51_3267')
    ap.add_argument('--vin', help='VIN or 7-char production number; sets model column, date, type, plant')
    ap.add_argument('--mosp', help='model column id when there is no VIN')
    ap.add_argument('--prod', help='build date YYYYMM or YYYYMMDD')
    ap.add_argument('--steer', help='L or R')
    ap.add_argument('--gear', help='A or M')
    ap.add_argument('--typ', help='type key, ET37')
    ap.add_argument('--werk', help='plant code, 92')
    ap.add_argument('--sa', help='option codes the car has: S760A,S346A or 760,346')
    ap.add_argument('--text', action='append', metavar='ELEMID=1|2',
                    help='answer a text/paint condition by element id (1 yes, 2 no)')
    ap.add_argument('--unfiltered', action='store_true', help="the catalogue's 'show all' view")
    ap.add_argument('--explain', action='store_true', help='also list the removed lines and why')
    ap.add_argument('--pos', help='only callout(s), 03 or 03,04')
    args = ap.parse_args()

    con = sqlite3.connect('file:%s?mode=ro' % args.db, uri=True)
    car = Car()
    identify(con, car, args)
    res = run(con, args.btnr, car, filtered=not args.unfiltered)

    print('car: mosp %s typ %s plant %s built %s steer %s gear %s%s' % (
        car.mosp, car.typ or '-', car.werk or '-', car.prod or '-', car.steer or '-',
        car.gear or '-', ' (by VIN %s)' % car.vin if car.vin else ''))
    if res['rules']:
        print('rules on %s for this car:' % args.btnr)
        for bed in res['rules']:
            keys = {k: v for k, v in (res['relevant'] or {}).items()
                    if re.sub(r'[0-9]*', '', k) == bed.kuerzel}
            verdict = ', '.join('%s=%s' % (k, 'decided' if v else 'open') for k, v in sorted(keys.items())) or 'false'
            print('  %s %s%s -> %s' % (bed.kuerzel, bed.vz, bed.gesamtterm, verdict))
            for og in bed.ogs:
                print('     %s [%s] %s' % (og.id, og.vart, og.fzeile or ''))
                for e in og.elems:
                    inf = res['info'].get(e.elemid, {})
                    print('        %s%s %s  value %s -> %s%s' % (
                        e.vz, inf.get('code') or 'TEXT', inf.get('name'), res['values'].get(e.elemid, '0'),
                        e.ausweisung, '  (retrofittable)' if inf.get('saz') else ''))
        if res['ueber']:
            print('  over-rules: ' + '; '.join('%s < %s' % (k, ','.join(v)) for k, v in res['ueber'].items()))
    if res['bte_bedkez']:
        print('  the diagram itself is under rule %s' % res['bte_bedkez'])
    want = set(args.pos.split(',')) if args.pos else None
    print('%d of %d lines shown:' % (len(res['lines']), res['total']))
    for ln in res['lines']:
        if want and ln.bildnr not in want:
            continue
        tags = ' '.join(x for x in (
            ('from %s/%s' % (ln.eins[4:6], ln.eins[:4])) if ln.eins else '',
            ('to %s/%s' % (ln.auslf[4:6], ln.auslf[:4])) if ln.auslf else '',
            ln.lenkg, ln.auto, ('rule ' + ln.bedkz) if ln.bedkz else '') if x)
        print('  %3d  %s  %s  %-32s %s' % (ln.pos, ln.bildnr, ln.sachnr, (ln.name or '')[:32], tags))
    if args.explain:
        print('%d removed:' % len(res['removed']))
        for ln in sorted(res['removed'], key=lambda z: z.pos):
            if want and ln.bildnr not in want:
                continue
            print('  %3d  %s  %s  %-32s -- %s' % (ln.pos, ln.bildnr, ln.sachnr, (ln.name or '')[:32], ln.removed))


if __name__ == '__main__':
    main()
