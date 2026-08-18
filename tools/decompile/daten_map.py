#!/usr/bin/env python3
"""What a module's coding blob MEANS, from BMW's own DATEN files.

    tools/decompile/daten_map.py        -> app/renderer/data/datenmap.js

WHY THIS EXISTS ALONGSIDE coding_map.py. That one mines the SGBDs, which
name their own coding values for 32 shippable ECUs. The rest hand back a
binary blob and say nothing about it -- ACC's CODIERUNG_LESEN returns one
CODIER_DATA buffer and no labels at all. DATEN is what NCS Expert reads to
label exactly those: which bit at which address is which function, and
what values that function may hold.

WHAT ONE ROW CARRIES, after ncs_daten.py decodes the record stream:

    block 0  word 1  byte 1  mask 0x02   FEHLER_STANDLICHT
                                         melden=00  nicht_melden=01

so the address locates the bits inside the blob and the enum says what the
settings are called. VALUES ARE MASK-NORMALISED: the byte in the file is
the field's own value, already shifted down past the mask's trailing zeros
(LWR_VORZEICHEN, mask 0x03, reads aktiv=03), so applying one is
(byte & ~mask) | (value << shift) and reading one is the inverse. The
renderer does that arithmetic; this file only has to preserve it exactly.

NAMING IS BY SGBD, not by DATEN's own filename, because the app opens ECUs
by SGBD. Most match outright (LSZ, LCM, EWS, RDC); a few are the same box
under two names and are aliased below, each one verified by token overlap
against that SGBD's own coding map rather than assumed from the spelling.

Read-only: reads files on disk, never talks to a car.
"""

import csv
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ncs_daten as N                                    # noqa: E402

OUT = 'app/renderer/data/datenmap.js'

# NCS Dummy's community keyword translations (revtor, IcemanBHE, joako et
# al.), shipped with the freeware as Translations.csv. Covers about two
# thirds of the FSW vocabulary with real English -- the renderer's own
# dictionary was built for E39/E46 result names and word-for-words the rest.
TRANSLATIONS = 'vendor/NCSDummy/Translations.csv'

# DATEN module -> the SGBD the app knows it as. Only where the two names
# differ and the pairing is EVIDENCED: the percentage is how much of the
# SGBD's own coding vocabulary the DATEN file's keywords cover (--audit
# recomputes them). GM4 is left out at 13%, IHKA_E38 at 8%: a rename that
# cannot be corroborated is a guess, and a guess here mislabels a car.
ALIASES = {
    'MK20E_I': 'ascmk20',   # 81%
    'KMB_E46': 'kombi46',   # 69%
    'GM5': 'zke5',          # 51%
    'GM3': 'zke4',          # 50%
    'KMB_E36': 'kombi36',   # 39%
}

# Every chassis SP-Daten v74 ships coding data for. Each carries its own
# keyword tables, which is why ncs_daten.rows() is told the directory.
CHASSIS = ('E36', 'E38', 'E39', 'E46', 'E52', 'E53', 'E60', 'E65',
           'E70', 'E83', 'E85', 'E89', 'K1X', 'K24', 'KH2', 'R50',
           'R56', 'RR1')


def stem(s):
    s = re.sub(r'^(COD|STAT|STATUS|CODIER)_', '', s.upper())
    return set(t for t in s.split('_') if len(t) > 2)


def sgbd_tokens(cm, name):
    out = set()
    for f in cm.get(name, {}).get('fields', []):
        if f.get('type') != 'binary':
            out |= stem(f['name'])
    return out


def coverage(daten_tokens, sgbd_toks):
    """How much of the SGBD's vocabulary the DATEN keywords account for.
    Prefix-tolerant, because the two abbreviate differently (FEHLER vs
    FEHLERMELDUNG, RUECKLICHT vs SL_HINTEN)."""
    if not sgbd_toks:
        return None
    hits = sum(1 for w in sgbd_toks
               if any(t.startswith(w) or w.startswith(t) for t in daten_tokens))
    return round(100 * hits / len(sgbd_toks))


def load_translations():
    """Keyword -> English, keyed by lowercased FSW/PSW keyword.

    Bracketed annotations ("[wert_01: off] [time_s=data]") are per-value
    notes tacked onto the function's line, not part of its name, so they
    are stripped. Identity rows ("100%,100%") and empty translations carry
    no information and are dropped -- the fallback shows the keyword anyway.
    """
    out = {}
    # NCS Dummy ships Translations.csv as CP1252 (`file` says ISO-8859) --
    # reading it as UTF-8 with errors='replace' turned every accent into
    # U+FFFD, so "Coupé" shipped as "Coup?" in the app. Try strict UTF-8
    # first (a future re-export could legitimately be UTF-8; pure ASCII
    # decodes identically either way), fall back to CP1252.
    try:
        enc = 'utf-8'
        with open(TRANSLATIONS, 'rb') as probe:
            try:
                probe.read().decode('utf-8')
            except UnicodeDecodeError:
                enc = 'cp1252'
        fh = open(TRANSLATIONS, newline='', encoding=enc)
    except OSError:
        print(f'WARNING: no {TRANSLATIONS} -- English labels will be '
              'absent; scripts/setup/fetch.sh --coding installs it',
              file=sys.stderr)
        return out
    with fh:
        for row in csv.reader(fh):
            if len(row) < 2 or row[0] in ('CONTRIBUTORS', 'LASTMODIFIED'):
                continue
            k = row[0].strip().lower()
            v = re.sub(r'\s*\[[^\]]*\]', '', row[1]).strip()
            if k and v and v.lower() != k:
                out[k] = v
    return out


def shift_of(mask):
    """Trailing-zero count: how far the field sits up inside its byte."""
    if not mask:
        return 0
    s = 0
    while not (mask >> s) & 1:
        s += 1
    return s


def read_module(paths):
    """Every variant of one module, as {variant: [rows]}.

    A module ships one file per coding variant (LSZ.C26 .. LSZ.C37) and
    they are NOT the same content, so all of them travel: the app cannot
    know which a given car wants until it has read the module's own
    coding index, and showing the wrong variant's labels would be worse
    than showing several.
    """
    out = {}
    for p in sorted(paths):
        rr = N.rows(open(p, "rb").read(), chassis=N.chassis_of(p))
        if not rr:
            continue
        fields = []
        for r in rr:
            if not r['name']:
                continue                       # unresolved id: nothing to show
            fields.append({
                'name': r['name'],
                'block': r['block'],
                'word': r['word'],
                'byte': r['byte'],
                'mask': r['mask'],
                'shift': shift_of(r['mask']),
                # (label, value) pairs; value is the mask-normalised number
                # for a plain setting, or a hex string when the parameter
                # is a whole buffer (a characteristic curve, say)
                'values': [[n, v] for n, v in r['psw']],
            })
        if fields:
            out[os.path.basename(p).split('.')[-1]] = fields

    # FOLD IDENTICAL VARIANTS. A module ships one file per coding index and
    # neighbouring indices are usually the same sheet -- LCM's eleven come
    # to three distinct layouts. Keeping every copy tripled the payload for
    # nothing, so identical ones collapse to a single entry listing the
    # indices it serves. Distinct layouts are all still here.
    folded = {}
    for var, fields in out.items():
        key = json.dumps(fields, sort_keys=True)
        folded.setdefault(key, []).append(var)
    return {'+'.join(sorted(v)): json.loads(k) for k, v in folded.items()}


def main():
    cm = {}
    try:
        cm = json.load(open('data/inpa-screens/_codingmap.json'))
    except OSError:
        # not fatal, but not nothing either: without the coding map the
        # SGBD cross-refs are absent and every alias audit reads 0%
        print('WARNING: no data/inpa-screens/_codingmap.json -- coding '
              'cross-refs will be absent; run tools/decompile/coding_map.py '
              'first', file=sys.stderr)

    sgbds = {os.path.basename(p).split('.')[0].lower()
             for p in glob.glob('data/ecu-src/*.meta.json.gz')}
    if not sgbds:
        sys.exit('no data/ecu-src: run the SGBD export first')

    # gather DATEN files per module per chassis
    mods = {}
    for ch in CHASSIS:
        d = f'{N.DATEN}/{ch}'
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if '.C' not in fn.upper():
                continue
            mods.setdefault(fn.split('.')[0].upper(), {}) \
                .setdefault(ch, []).append(f'{d}/{fn}')

    out = {}
    skipped = []
    for mod, by_ch in sorted(mods.items()):
        target = ALIASES.get(mod, mod.lower())
        if target not in sgbds:
            skipped.append(mod)
            continue
        entry = out.setdefault(target, {'sgbd': target, 'daten': mod,
                                        'chassis': {}})
        for ch, paths in by_ch.items():
            variants = read_module(paths)
            if variants:
                entry['chassis'][ch] = variants

    out = {k: v for k, v in out.items() if v['chassis']}

    # English labels ride in the same file, keyed once by keyword rather
    # than repeated per row: the same FSW appears in dozens of variants
    # across chassis, and per-row labels would triple the payload. Only
    # keywords the map actually uses travel.
    trans = load_translations()
    fsw, psw = set(), set()
    for e in out.values():
        for variants in e['chassis'].values():
            for fields in variants.values():
                for r in fields:
                    fsw.add(r['name'].lower())
                    for n, _ in r['values']:
                        psw.add(str(n).lower())
    i18n = {k: trans[k] for k in (fsw | psw) if k in trans}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        fh.write('// GENERATED by tools/decompile/daten_map.py -- what a '
                 "module's coding blob\n// MEANS, from BMW's DATEN files: "
                 'address, mask and the values each\n// function may hold. '
                 'Lazy-loaded by loadDatenMap().\n'
                 '// BMW_DATEN_I18N: keyword -> English, from NCS Dummy\'s '
                 'Translations.csv.\n'
                 'window.BMW_DATEN_MAP=')
        json.dump(out, fh, separators=(',', ':'), sort_keys=True)
        fh.write(';\nwindow.BMW_DATEN_I18N=')
        json.dump(i18n, fh, separators=(',', ':'), sort_keys=True,
                  ensure_ascii=False)
        fh.write(';\n')

    n_var = sum(len(v) for e in out.values() for v in e['chassis'].values())
    n_row = sum(len(f) for e in out.values() for v in e['chassis'].values()
                for f in v.values())
    n_enum = sum(1 for e in out.values() for v in e['chassis'].values()
                 for f in v.values() for r in f if len(r['values']) > 1)
    print(f'{len(out)} ECUs carry a DATEN coding description')
    print(f'  {n_var} coding variants, {n_row} named functions, '
          f'{n_enum} with a value list')
    if trans:
        print(f'  {len(i18n)} English labels: '
              f'{sum(1 for k in fsw if k in i18n)}/{len(fsw)} function '
              f'keywords, {sum(1 for k in psw if k in i18n)}/{len(psw)} '
              'value keywords')
    print(f'  {len(skipped)} DATEN modules match no SGBD the app ships')
    size = os.path.getsize(OUT)
    print(f'-> {OUT} ({size // 1024} KB)')


if __name__ == '__main__':
    sys.exit(main())
