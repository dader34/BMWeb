#!/usr/bin/env python3
"""BMW's three plain-text chassis tables: SGFAM, AT and ZST.

Unlike SGET and the .C0x coding files -- binary, framed, and decoded by
ncs_daten/ncs_sget -- these three ship as latin-1 text with CRLF endings and
`;` or `//` comments. They are read here directly.

    python3 tools/decompile/ncs_tables.py            # summarise the corpus
    python3 tools/decompile/ncs_tables.py --write    # -> data/ncs-tables.json
    python3 tools/decompile/ncs_tables.py --check    # invariants, exit 1 on fail

WHAT EACH FILE IS FOR
---------------------
<BR>SGFAM.DAT -- the ECU family map. One `S` row per logical control unit:

    S KMB  A_KMB46  C_KMB46  1   1
    S LSZ  A_LSZ    C_LSZ    0   1
      ^SG  ^ASW-SGBD ^CABD   ^FA ^ZCS

The last two columns are what make a vehicle-identity screen possible without
hardcoding ECU names per chassis: they mark which modules hold the vehicle
order (FA) and which hold the central coding key (ZCS). On E46 that is exactly
KMB (both), EWS (FA) and LSZ (ZCS).

<BR>AT.000 -- the Auftragsdatei, the token dictionary for a vehicle order.
`W` rows map an SA catalog number to the named equipment keywords it implies:

    W 205    AUTOMATIK        //Automatic Getriebe
    W 210    DSC3             //Dynamische Stab. Control III

<BR>ZST.000 -- the ZCS decoding table. Each `H` row carries three hex masks
over the car's own ZCS keys and the keywords that hold when they match:

    H 261  N0699 00000000 0000000000000080 0000000000 1 FOND_AIRBAG
             ^date ^GM(8)  ^SA(16)          ^VN(10)  ^flag ^keywords

The mask widths are 8/16/10 for all 276 E46 rows, matching the GM/SA/VN key
widths core/coding/zcs.js already parses out of the 20-byte ZCS region.

THE NUMBERING BRIDGE. There are three namespaces: a ZCS key yields BIT
INDICES 0..63, the order and the option catalogue speak SA CATALOG NUMBERS
(205 automatic), and an SGET predicate tests KEYWORD IDS of the chassis's
SWTASW table (S37 is AUTOMATIK; see parse_asw). Keywords are the common
ground: ZST maps key bits to them, AT maps catalogue numbers to them, and
SWTASW numbers them for the predicates:

    ZCS keys -> ZST mask match -> keywords -> SWTASW id -> SGET
    order SA numbers -> AT -> keywords -> SWTASW id -> SGET

Not every keyword crosses over -- of 76 E46 ZST keywords, 44 are in AT. The
rest are body/market names (COUP, MEXICO) and `*_CI_nn` coding-index stamps
(KMBI_CI_04), which name a module revision rather than an option. Both are
kept: they are what the tables say, and the CI stamps say which .Cxx a module
should be read against.

<BR>ZST.K00 -- the SA-NUMBER -> ZCS-BIT table, and the reason an E39 option
list can be complete. ZST.000 is the DECODING table, and BMW retires rows in
it: on E39 the rows for 0194, 0364 and 0645 are all-zero masks, and 0223,
0316, 0403, 0677 never had one. The K00 sidecar is the ENCODING table the
factory writes a key from, and it still carries every one of them. It is not
text: it is the same framed, checksummed container as the .C0x coding files
(ncs_daten.records), and its MONTAGEAUFTRAG section is one record per SA
number -- SALA, then the GM/SA/VN masks the option sets:

    0223  GMS 00000000  SAS 0000000000000001  VNS 0000000000

Inverting it (a row holds when the car's key has the row's bits) against an
E39 M5's keys reproduces PA Soft's / NCS Expert's option list exactly, where
ZST.000 alone recovers six of thirteen. Ten chassis ship a K00 (E31..E53,
R50), all under DATEN/E39; each is parsed under the chassis its NAME says.
"""

import glob
import gzip
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # tools/
from _cli import parse_args                                     # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATEN = os.path.join(ROOT, 'vendor', 'EC-APPS', 'NCSEXPER', 'DATEN')
OUT = os.path.join(ROOT, 'data', 'ncs-tables.json')
# Same convention as sget.js / datenmap.js: a JS file assigning a global, which
# the renderer loads lazily (translate.js _lazyScript).
OUT_JS = os.path.join(ROOT, 'app', 'renderer', 'data', 'tables.js')

# A keyword is an uppercase identifier. Numbers, dates (N0999) and the hex
# masks are positional and read by index, never by this pattern.
KEYWORD = re.compile(r'^[A-Z][A-Z0-9_]*$')
# `KMBI_CI_04` -- a coding-index stamp, not an equipment option.
CI_STAMP = re.compile(r'^(?P<sg>[A-Z0-9]+)_CI_(?P<idx>\d+)$')


def lines(path):
    """Decoded, comment-stripped, non-empty lines.

    These files are latin-1 (German umlauts in the change log) with CRLF
    endings. Reading them as UTF-8 raises on the very first header line.
    """
    with open(path, encoding='latin-1') as fh:
        raw = fh.read()
    out = []
    for ln in raw.replace('\r\n', '\n').replace('\r', '\n').split('\n'):
        # `//` is AT/ZST's comment, `;` is SGFAM's. Both also appear as
        # trailing comments on data rows, so strip rather than skip.
        for mark in ('//', ';'):
            i = ln.find(mark)
            if i >= 0:
                ln = ln[:i]
        ln = ln.rstrip()
        if ln.strip():
            out.append(ln)
    return out


def keywords_from(parts):
    """The identifier tokens in a row's tail."""
    return [p for p in parts if KEYWORD.match(p)]


# ---- SGFAM: the ECU family map --------------------------------------------

def parse_sgfam(path):
    """-> {SG: {asw, cabd, fa, zcs}}.

    Rows are `S <SG> <CABD> <C_SGBD> <ZCS> <FA>` -- every chassis's file says
    so in its own header line ("; SG CABD C_SGBD ZCS FA KOMMENTAR"). ZCS
    comes FIRST: the flags were read the other way round, which made the
    E46's old cluster (KMB, which holds the central coding key) an order
    master and its newer one (AKMB, which holds the vehicle order) a key
    master. Rows with any other leading token are metadata and skipped.

    The keys keep their historical names: `asw` is the row's CABD column (the
    A_<name> coding script) and `cabd` its C_SGBD column (the coding SGBD).
    """
    out = {}
    for ln in lines(path):
        p = ln.split()
        if len(p) < 4 or p[0] != 'S':
            continue
        sg, asw, cabd = p[1], p[2], p[3]
        # The flags are optional in some chassis files; absent means "not a
        # master", which is the safe reading -- it offers no identity read
        # rather than offering one that cannot work.
        zcs = len(p) > 4 and p[4] == '1'
        fa = len(p) > 5 and p[5] == '1'
        out[sg] = {'asw': asw, 'cabd': cabd, 'fa': fa, 'zcs': zcs}
    return out


# ---- AT: SA catalog number -> equipment keywords ---------------------------

def parse_at(path):
    """-> {'sa': {num: [keyword...]}, 'kw': {keyword: [num...]},
    'time': {mmyy: [keyword...]}}.

    A row runs on over `>>>` lines: the keyword list of the row above,
    continued. They used to be skipped, which cut every long row short.

    `Z` and `A` rows are the TIME-CRITERION rows ("Zeitkriteriumzeilen" in
    the file's own words), keyed `#MMYY`: what holds for a car built to the
    state of that month. They are where a car coded by its vehicle order gets
    the keywords no option carries -- PU01, and each module's revision stamps
    (KMBI_CI_08, LSZ_CI_34 ...) -- and module selection is decided on exactly
    those. Each row is complete in itself (the 09/04 row lists every earlier
    state too), so a car's own criterion is looked up, not accumulated.

    `W` rows carry the SA number in field 1 and the keywords after it. A row
    may also carry a conditional (`=205+(EU31,EV91)`) saying the keyword only
    applies to some builds; that is a fitment rule we do not evaluate here, so
    the tokens are dropped and only plain keywords kept -- claiming an
    unconditional mapping we have not checked would be worse than omitting it.
    """
    sa, kw, time = {}, {}, {}
    rows = []
    into = None            # the keyword list a `>>>` line continues
    for ln in lines(path):
        p = ln.split()
        if p and p[0] == '>>>':
            if rows and rows[-1] is not None:
                for n in keywords_from(p[1:]):
                    if n not in rows[-1]['kw']:
                        rows[-1]['kw'].append(n)
            if into is not None:
                owner, key = into
                for n in keywords_from(p[1:]):
                    if n not in owner[key]:
                        owner[key].append(n)
                    if owner is sa:
                        kw.setdefault(n, [])
                        if key not in kw[n]:
                            kw[n].append(key)
            continue
        into = None
        rows.append(_at_row(p))
        if len(p) >= 2 and p[0] in ('Z', 'A') and \
                re.fullmatch(r'#\d{4}', p[1]):
            code = p[1][1:]
            time.setdefault(code, [])
            for n in keywords_from(p[2:]):
                if n not in time[code]:
                    time[code].append(n)
            into = (time, code)
            continue
        if len(p) < 2 or p[0] != 'W':
            continue
        num = p[1]
        if not num.isdigit():
            continue
        tail = p[2:]
        # A conditional row starts its tail with `=...`; its keywords hold only
        # under that expression.
        if tail and tail[0].startswith('='):
            continue
        names = keywords_from(tail)
        if not names:
            continue
        # SA numbers are written both bare and zero-padded (261 / 0261).
        # Normalise to the unpadded form the SGET predicates use (S261).
        num = str(int(num))
        sa.setdefault(num, [])
        for n in names:
            if n not in sa[num]:
                sa[num].append(n)
            kw.setdefault(n, [])
            if num not in kw[n]:
                kw[n].append(num)
        into = (sa, num)
    return {'sa': sa, 'kw': kw, 'time': time,
            'rows': [r for r in rows if r is not None]}


def _at_row(p):
    """One AT row as the factory tool walks it (AT_PROC.C GetAtFile), or
    None for a line that is not a row.

    `Z`/`A` rows (ZEIT, ZEITALT) hold for the car whose time criterion is
    their `#MMYY`. `W` (BESTELLUNG, field SALA) and `E`/`H`/`K`
    (ERGAENZUNG, HISTORIE, KUNDENDIENST, field WORT) hold when their code is
    one of the order's codes, compared as written; then a date (`V0302`
    before 03/02, `N0302` from 03/02 on) and an order-code condition
    (`=185`) may narrow them. Every keyword of a row that holds is the car's.
    The `{k, code, date, cond, kw}` it returns is what select.js evaluates.
    """
    if len(p) < 2 or p[0] not in ('W', 'E', 'H', 'K', 'Z', 'A'):
        return None
    kind, code, rest = p[0], p[1], p[2:]
    if kind in ('Z', 'A'):
        if not re.fullmatch(r'#\d{4}', code):
            return None
        return {'k': kind, 'code': code[1:], 'date': None, 'cond': None,
                'kw': keywords_from(rest)}
    date = cond = None
    if rest and re.fullmatch(r'[VN]\d{4}', rest[0]):
        date, rest = rest[0], rest[1:]
    if rest and rest[0].startswith('='):
        cond, rest = rest[0][1:], rest[1:]
    return {'k': kind, 'code': code.upper(), 'date': date, 'cond': cond,
            'kw': keywords_from(rest)}


# ---- ZST: ZCS key bits -> equipment keywords -------------------------------

def parse_zst(path):
    """-> [{key, date, gm, sa, vn, keywords, ci}].

    `H <key> <date> <GM:8> <SA:16> <VN:10> <flag> <keywords...>`.

    The three hex fields are MASKS, not values: a row applies when the car's
    corresponding key has those bits set. A row whose masks are all zero
    matches nothing and is BMW's own way of retiring an entry ("ausblenden
    fuer ZEKO"); those are kept but marked, so a later reader can see the
    retraction rather than silently inheriting the live row above it.
    """
    rows = []
    for ln in lines(path):
        p = ln.split()
        if len(p) < 6 or p[0] != 'H':
            continue
        key, date, gm, sa, vn = p[1], p[2], p[3], p[4], p[5]
        if not (re.fullmatch(r'[0-9A-Fa-f]{8}', gm)
                and re.fullmatch(r'[0-9A-Fa-f]{16}', sa)
                and re.fullmatch(r'[0-9A-Fa-f]{10}', vn)):
            continue
        names = keywords_from(p[7:] if len(p) > 7 else [])
        ci = {}
        opts = []
        for n in names:
            m = CI_STAMP.match(n)
            if m:
                ci[m.group('sg')] = int(m.group('idx'))
            else:
                opts.append(n)
        rows.append({
            'key': key, 'date': date,
            'gm': gm.upper(), 'sa': sa.upper(), 'vn': vn.upper(),
            'keywords': opts,
            'names': names,
            'ci': ci,
            'empty': not (int(gm, 16) or int(sa, 16) or int(vn, 16)),
        })
    return rows


# ---- ZST.K00: SA catalog number -> the ZCS bits that option sets -----------

def _k00_fields(sig, payload):
    """Decode one K00 record by its section signature.

    ncs_daten.parse_payload reads `A` as a coding value list, which is right
    for .C0x files and wrong here: in K00 an `A` is a length-prefixed byte
    array holding a mask. So the four codes are read literally: S = NUL
    string, B = u8, W = u16 LE, A = u8 length + that many bytes (as hex),
    (X) = u16 count + values. Anything else in the signature is a decode
    bug and raises rather than yielding a shifted row.
    """
    import struct
    from ncs_daten import parse_signature
    out = []
    i = 0
    for f in parse_signature(sig):
        c = f['code']
        if f['repeating']:
            n = struct.unpack_from('<H', payload, i)[0]
            i += 2
            fmt, size = {'W': ('<H', 2), 'B': ('<B', 1), 'L': ('<I', 4)}[c]
            out.append([struct.unpack_from(fmt, payload, i + k * size)[0]
                        for k in range(n)])
            i += n * size
        elif c == 'S':
            j = payload.index(b'\0', i)
            out.append(payload[i:j].decode('latin-1'))
            i = j + 1
        elif c == 'A':
            n = payload[i]
            out.append(payload[i + 1:i + 1 + n].hex().upper())
            i += 1 + n
        elif c in ('B', 'W', 'L'):
            fmt, size = {'W': ('<H', 2), 'B': ('<B', 1), 'L': ('<I', 4)}[c]
            out.append(struct.unpack_from(fmt, payload, i)[0])
            i += size
        else:
            raise ValueError(f'K00 signature code {c!r}')
    if i != len(payload):
        raise ValueError(f'K00 record not fully consumed ({i}/{len(payload)})')
    return out


def parse_sabits(path):
    """-> [{key, gm, sa, vn}] : one row per SA number, its masks.

    Only the MONTAGEAUFTRAG section is an SA -> bits list. HISTORIE repeats
    ZST.000's own rows and GRUNDVERCODUNG is the base key of the series, so
    both are left to the files that own them. A record that fails to decode
    is skipped, never guessed: a wrong mask would put an option on a car.
    """
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from ncs_daten import records, schema
    with open(path, 'rb') as fh:
        data = fh.read()
    secs = {v['seq']: v for v in schema(data).values()}
    rows = []
    for seq, payload, _off in records(data):
        sec = secs.get(seq)
        if not sec or sec['name'] != 'MONTAGEAUFTRAG':
            continue
        try:
            vals = dict(zip(sec['fields'], _k00_fields(sec['sig'], payload)))
        except Exception:
            continue
        key, gm, sa, vn = (vals.get('SALA'), vals.get('GMS', ''),
                           vals.get('SAS', ''), vals.get('VNS', ''))
        if not key or not key.isdigit():
            continue
        if not (len(gm) == 8 and len(sa) == 16 and len(vn) == 10):
            continue
        # An all-zero row constrains nothing: it is a retired number and
        # must never match a car (same rule as ZST.000's empty rows).
        if not (int(gm, 16) or int(sa, 16) or int(vn, 16)):
            continue
        rows.append({'key': key, 'gm': gm, 'sa': sa, 'vn': vn})
    return rows


# ---- which jobs answer with an identity, found by asking every SGBD --------
#
# A screen has to know WHICH JOB on which control unit returns the coding key
# or the vehicle order. Typing that list is how it goes wrong: the corpus
# spells the third coding key VM on one job and VN on another, names the E46
# cluster `kombi46` where BMW's own family table calls it KMB, and hides three
# identity jobs behind the name AIF_ZENTRALCODE_LESEN, which no pattern built
# from the obvious names would have caught.
#
# So the list is DERIVED. Every shipped SGBD declares its jobs and each job's
# results; a job answers with the coding key if it declares all three key
# results, and with the vehicle order if it declares one named for it. Across
# 27340 jobs exactly 20 qualify, under 5 distinct names.
#
# The renderer uses this as a CANDIDATE INDEX -- it still confirms against the
# ECU's live declaration before reading, so a car whose SGBD differs from the
# shipped copy is handled by the check, not by this file.

ECU_SRC = os.path.join(ROOT, 'data', 'ecu-src')

# The three coding keys, by role. Both spellings of the third are real.
KEY_ROLES = (re.compile(r'^GM$', re.I),
             re.compile(r'^SA$', re.I),
             re.compile(r'^V[NM]$', re.I))
FA_RESULT = re.compile(r'FAHRZEUGAUFTRAG|STANDARD_FA', re.I)
# A write is never an identity READ, whatever it declares.
WRITE_NAME = re.compile(r'SCHREIBEN|STEUERN|AUFTRAG_|_LOESCHEN|RESET', re.I)


def identity_jobs():
    """-> {sgbd: {'zcs': [{job, keys}], 'fa': [{job, result}]}}"""
    out = {}
    for path in sorted(glob.glob(os.path.join(ECU_SRC, '*.meta.json.gz'))):
        sgbd = os.path.basename(path).split('.')[0]
        try:
            with gzip.open(path) as fh:
                meta = json.load(fh)
        except Exception:
            continue
        for job, spec in (meta.get('jobs') or {}).items():
            if WRITE_NAME.search(job):
                continue
            names = [r.get('name') for r in (spec.get('results') or [])
                     if isinstance(r, dict) and r.get('name')]
            keys = [next((n for n in names if role.match(n)), None)
                    for role in KEY_ROLES]
            if all(keys):
                out.setdefault(sgbd, {}).setdefault('zcs', []).append(
                    {'job': job,
                     'keys': {'gm': keys[0], 'sa': keys[1], 'vn': keys[2]}})
                continue
            fa = next((n for n in names if FA_RESULT.search(n)), None)
            if fa:
                out.setdefault(sgbd, {}).setdefault('fa', []).append(
                    {'job': job, 'result': fa})
    return out


# ---- corpus ----------------------------------------------------------------

def corpus():
    """-> {CHASSIS: {sgfam|at|zst: path}}.

    Files for many chassis sit together in one directory (E46's tables ship
    under DATEN/E39), so the chassis comes from the FILENAME, never the folder.
    """
    found = {}
    pats = [
        (re.compile(r'^([A-Z0-9]+)SGFAM\.DAT$'), 'sgfam'),
        (re.compile(r'^([A-Z0-9]+)AT\.000$'), 'at'),
        (re.compile(r'^([A-Z0-9]+)ZST\.000$'), 'zst'),
        (re.compile(r'^([A-Z0-9]+)ZST\.K00$'), 'sabits'),
        (re.compile(r'^([A-Z0-9]+)SGVT\.000$'), 'sgvt'),
    ]
    for dirpath, _, names in os.walk(DATEN):
        # A chassis's tables ship in two places: its OWN directory, and a
        # shared bundle in a sibling's (all ten SGFAMs also sit under E39).
        # They are NOT the same file -- E39/E46SGFAM.DAT lists 27 SGs and
        # names KMB/LSZ as the ZCS masters, while E46/E46SGFAM.DAT lists 4
        # and names AKMB/ALSZ against CABD C_LSZA. The chassis's own
        # directory is the one NCS Expert loads, so it wins; without this the
        # walk order decides, and it picked the stale copy.
        own = os.path.basename(dirpath).upper()
        for n in sorted(names):
            for pat, kind in pats:
                m = pat.match(n.upper())
                if not m:
                    continue
                ch = m.group(1)
                path = os.path.join(dirpath, n)
                if kind in found.get(ch, {}) and ch != own:
                    continue            # already have one; only own dir may override
                found.setdefault(ch, {})[kind] = path
    return found


def parse_asw(chassis):
    """-> {KEYWORD: id}: the chassis's own SWTASW table, or {}.

    THIS is the namespace an SGET predicate is written in. `S121` in
    E46SGET.000 is entry 121 of E46/SWTASW06.dat, KMBI_CI_07 -- the cluster's
    rows read "PU01 and KMBI_CI_07 and not (KMBI_CI_08 or S54B32)" -- and all
    145 numbers the E46 file uses resolve there. They are not SA catalogue
    numbers: catalogue number 205 is AUTOMATIK in E46AT.000, while S205 is
    PDC_CI_02 and AUTOMATIK is S37. A car's equipment reaches a predicate as
    keywords (from its coding key through ZST, from its order through AT),
    and the keyword's id here is what the predicate tests.
    """
    import glob as _glob
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import ncs_daten as N
    out = {}
    for path in sorted(_glob.glob(os.path.join(DATEN, chassis, '*'))):
        if not re.fullmatch(r'SWTASW\d+\.dat', os.path.basename(path), re.I):
            continue
        data = open(path, 'rb').read()
        sec = N.schema(data).get('SWT_EINTRAG')
        if not sec:
            continue
        for seq, payload, _at in N.records(data):
            if seq != sec['seq']:
                continue
            try:
                keyid, keyword = N.parse_payload(sec['sig'] or 'WS', payload)
            except (ValueError, IndexError):
                continue
            out[str(keyword).upper()] = keyid
        break
    return out


# ---- SGVT: module version -> keywords, and the order check ----------------

def parse_sgvt(path):
    """-> [{fam, cbd, exprHex, asw: [id...]}], in file order.

    The factory tool (SGV_PROC.C GetSgvtFile) looks up the row of the
    module's family and coding file (`KMB C08`): its predicate must hold for
    the car (else error 0x11A0, the coding file does not fit the order), and
    the VERSIONS_ASW records that follow it add keyword ids. A predicate
    continues in AUFTRAGSAUSDRUCK2 records.
    """
    import struct
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import ncs_daten as N
    data = open(path, 'rb').read()
    secs = N.schema(data)
    head = secs.get('AUFTRAGSAUSDRUCK')
    cont = secs.get('AUFTRAGSAUSDRUCK2')
    vers = secs.get('VERSIONS_ASW')
    if not head:
        return []
    rows = []

    def expr_of(b, i):
        n = b[i]
        return b[i + 1:i + 1 + n]

    for seq, payload, _at in N.records(data):
        b = bytes(payload)
        if seq == head['seq']:
            j = b.index(b'\0')
            fam = b[:j].decode('latin-1')
            k = b.index(b'\0', j + 1)
            cbd = b[j + 1:k].decode('latin-1')
            rows.append({'fam': fam.upper(), 'cbd': cbd.upper(),
                         'expr': expr_of(b, k + 1), 'asw': []})
        elif cont and seq == cont['seq'] and rows:
            rows[-1]['expr'] += expr_of(b, 0)
        elif vers and seq == vers['seq'] and rows:
            n = struct.unpack_from('<H', b, 0)[0]
            rows[-1]['asw'] += list(struct.unpack_from('<%dH' % n, b, 2))
    for r in rows:
        r['exprHex'] = r.pop('expr').hex().upper()
    return rows


def build():
    """Every chassis' parsed tables: ``{chassis: {sgfam, at, zst, sabits,
    asw}}`` (each key present only when that file exists for the chassis)."""
    out = {}
    for ch, paths in sorted(corpus().items()):
        entry = {}
        asw = parse_asw(ch)
        if asw:
            entry['asw'] = asw
        if 'sgfam' in paths:
            entry['sgfam'] = parse_sgfam(paths['sgfam'])
        if 'at' in paths:
            entry['at'] = parse_at(paths['at'])
        if 'zst' in paths:
            entry['zst'] = parse_zst(paths['zst'])
        if 'sabits' in paths:
            entry['sabits'] = parse_sabits(paths['sabits'])
        if 'sgvt' in paths:
            entry['sgvt'] = parse_sgvt(paths['sgvt'])
        if entry:
            out[ch] = entry
    return out


def main():
    """CLI entry: summarise the tables, ``--check`` their invariants (exit 1
    on failure), or ``--write`` the JSON and JS outputs."""
    ns = parse_args(__doc__,
                    flags={'--write': 'write data/ncs-tables.json and the renderer JS',
                           '--check': 'verify the invariants; exit 1 on failure'})
    data = build()
    idents = identity_jobs()
    if not data:
        sys.exit(f'no SGFAM/AT/ZST files under {DATEN} '
                 '(run scripts/setup/fetch.sh)')

    write = ns.write
    check = ns.check

    masters = 0
    for ch, e in sorted(data.items()):
        sgfam = e.get('sgfam') or {}
        fa = [k for k, v in sgfam.items() if v['fa']]
        zcs = [k for k, v in sgfam.items() if v['zcs']]
        masters += len(set(fa) | set(zcs))
        if not check:
            print(f"  {ch:6s} "
                  f"{len(sgfam):3d} SG  "
                  f"{len(e.get('at', {}).get('sa', {})):4d} SA  "
                  f"{len(e.get('zst', [])):4d} ZST  "
                  f"{len(e.get('sabits', [])):4d} SAbits"
                  + (f"  FA:{','.join(sorted(fa))}" if fa else '')
                  + (f"  ZCS:{','.join(sorted(zcs))}" if zcs else ''))

    n_jobs = sum(len(v.get('zcs', [])) + len(v.get('fa', []))
                 for v in idents.values())
    print(f'{len(data)} chassis, {masters} identity-master ECUs; '
          f'{n_jobs} identity jobs on {len(idents)} SGBDs')

    if check:
        bad = 0
        # The bridge is the reason these files are parsed at all: if ZST
        # keywords never reach AT numbers, the tables are being misread.
        crossed = 0
        for ch, e in data.items():
            at_kw = set((e.get('at') or {}).get('kw') or {})
            zst_kw = {k for r in e.get('zst') or [] for k in r['keywords']}
            crossed += len(at_kw & zst_kw)
        # Measured on the shipped corpus: E46 alone crosses 12 keywords
        # (520 fog lights, 534/857 climate, 261 rear airbags, 249/256 cruise,
        # 606 navigation...). Most ZST keywords are body/engine/market names
        # -- LL, LIM, COUP, M52B25 -- which have no SA number by design, so
        # the bar is "the bridge works", not "everything crosses".
        if crossed < 12:
            print(f'FAIL: only {crossed} ZST keywords resolve to an SA '
                  'number (expected at least 12)')
            bad += 1
        # The K00 inversion is pinned to a real car: an E39 M5 (PA Soft
        # photo, 2026-09-05) whose SA key 55A0001A914D9167 / VN 4B10100009
        # lists 0194 0223 0316 0364 0403 0645 0677 -- the seven numbers
        # ZST.000 cannot produce. If any of them stops holding, the K00
        # decode has shifted.
        e39 = data.get('E39', {})
        held = set()
        for r in e39.get('sabits') or []:
            ok = None
            for field, key in (('gm', '54930000'),
                               ('sa', '55A0001A914D9167'),
                               ('vn', '4B10100009')):
                m = r[field]
                if not int(m, 16):
                    continue
                if any((int(k, 16) & int(c, 16)) != int(c, 16)
                       for k, c in zip(key, m)):
                    ok = False
                    break
                ok = True
            if ok:
                held.add(str(int(r['key'])))
        want = {'194', '223', '316', '364', '403', '645', '677'}
        if not want <= held:
            print(f'FAIL: E39 K00 inversion missing {sorted(want - held)}')
            bad += 1
        # An SGFAM read that finds no identity master would silently disable
        # the identity screen rather than fail loudly.
        if not masters:
            print('FAIL: no FA/ZCS master ECU in any SGFAM')
            bad += 1
        for ch, e in data.items():
            for r in e.get('zst') or []:
                for f, w in (('gm', 8), ('sa', 16), ('vn', 10)):
                    if len(r[f]) != w:
                        print(f'FAIL: {ch} ZST {r["key"]} {f} width {len(r[f])}')
                        bad += 1
                        break
        # The identity index is what the screen reads to know which job on
        # which module answers. Empty means the ECU corpus moved and every
        # identity read would silently find nothing.
        if not idents:
            print('FAIL: no SGBD declares an identity job')
            bad += 1
        for sgbd, v in idents.items():
            for row in v.get('zcs', []):
                if set(row['keys']) != {'gm', 'sa', 'vn'}:
                    print(f'FAIL: {sgbd} {row["job"]} bad key roles')
                    bad += 1
        if bad:
            sys.exit(1)
        print(f'table invariants OK ({crossed} keywords bridge ZST -> AT, '
              f'{n_jobs} identity jobs)')

    if write:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        payload = dict(data)
        payload['_identity'] = idents
        with open(OUT, 'w') as fh:
            json.dump(payload, fh, separators=(',', ':'), sort_keys=True)
        print(f'wrote {OUT} ({os.path.getsize(OUT)} bytes)')

        os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
        with open(OUT_JS, 'w') as fh:
            fh.write('// BMW chassis tables: SGFAM (ECU family + identity '
                     'masters), AT (SA number -> keywords),\n')
            fh.write('// ZST (ZCS key bits -> keywords), SABITS (SA number '
                     '-> ZCS key bits, from ZST.K00).\n')
            fh.write('// Generated by tools/decompile/ncs_tables.py '
                     '-- do not edit by hand.\n')
            fh.write('window.BMW_TABLES=')
            json.dump(payload, fh, separators=(',', ':'), sort_keys=True)
            fh.write(';\n')
        print(f'wrote {OUT_JS} ({os.path.getsize(OUT_JS)} bytes)')


if __name__ == '__main__':
    main()
