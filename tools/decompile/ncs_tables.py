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
widths coding-zcs.js already parses out of the 20-byte ZCS region.

THE NUMBERING BRIDGE. SGET predicates test SA CATALOG NUMBERS (S205, S210);
a ZCS key yields only BIT INDICES 0..63. Those are different namespaces, and
comparing them directly is what made an equipment filter hide most of the car.
ZST maps bits to keywords and AT maps keywords to catalog numbers, so the two
files together are the missing translation:

    ZCS keys -> ZST mask match -> keywords -> AT -> SA numbers -> SGET

Not every keyword crosses over -- of 76 E46 ZST keywords, 44 are in AT. The
rest are body/market names (COUP, MEXICO) and `*_CI_nn` coding-index stamps
(KMBI_CI_04), which name a module revision rather than an option. Both are
kept: they are what the tables say, and the CI stamps say which .Cxx a module
should be read against.
"""

import glob
import gzip
import json
import os
import re
import sys

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

    Rows are `S <SG> <ASW-SGBD> <CABD> <fa> <zcs>`. Rows with any other
    leading token are metadata and skipped.
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
        fa = len(p) > 4 and p[4] == '1'
        zcs = len(p) > 5 and p[5] == '1'
        out[sg] = {'asw': asw, 'cabd': cabd, 'fa': fa, 'zcs': zcs}
    return out


# ---- AT: SA catalog number -> equipment keywords ---------------------------

def parse_at(path):
    """-> {'sa': {num: [keyword...]}, 'kw': {keyword: [num...]}}.

    `W` rows carry the SA number in field 1 and the keywords after it. A row
    may also carry a conditional (`=205+(EU31,EV91)`) saying the keyword only
    applies to some builds; that is a fitment rule we do not evaluate here, so
    the tokens are dropped and only plain keywords kept -- claiming an
    unconditional mapping we have not checked would be worse than omitting it.
    """
    sa, kw = {}, {}
    for ln in lines(path):
        p = ln.split()
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
    return {'sa': sa, 'kw': kw}


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
            'ci': ci,
            'empty': not (int(gm, 16) or int(sa, 16) or int(vn, 16)),
        })
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


def build():
    out = {}
    for ch, paths in sorted(corpus().items()):
        entry = {}
        if 'sgfam' in paths:
            entry['sgfam'] = parse_sgfam(paths['sgfam'])
        if 'at' in paths:
            entry['at'] = parse_at(paths['at'])
        if 'zst' in paths:
            entry['zst'] = parse_zst(paths['zst'])
        if entry:
            out[ch] = entry
    return out


def main():
    data = build()
    idents = identity_jobs()
    if not data:
        sys.exit(f'no SGFAM/AT/ZST files under {DATEN} '
                 '(run scripts/setup/fetch.sh)')

    write = '--write' in sys.argv
    check = '--check' in sys.argv

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
                  f"{len(e.get('zst', [])):4d} ZST"
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
            fh.write('// ZST (ZCS key bits -> keywords).\n')
            fh.write('// Generated by tools/decompile/ncs_tables.py '
                     '-- do not edit by hand.\n')
            fh.write('window.BMW_TABLES=')
            json.dump(payload, fh, separators=(',', ':'), sort_keys=True)
            fh.write(';\n')
        print(f'wrote {OUT_JS} ({os.path.getsize(OUT_JS)} bytes)')


if __name__ == '__main__':
    main()
