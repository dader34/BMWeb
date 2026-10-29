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

NO NAMES ARE MATCHED. The coding files travel under NCS's own names, one
file per chassis (daten_files.py -> data/daten/<CHASSIS>.json), and the app
reaches them the way NCS Expert does: module list, coding index, selection
table. This file is what the two share: read_module() (one module's rows)
and the English labels. datenmap.js now carries only those labels
(BMW_DATEN_I18N), for every keyword any chassis's coding files use;
BMW_DATEN_MAP is left empty -- nothing looks a coding file up by an SGBD's
name any more.

Read-only: reads files on disk, never talks to a car.
"""

import csv
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

# Every chassis SP-Daten v74 ships coding data for. Each carries its own
# keyword tables, which is why ncs_daten.rows() is told the directory.
CHASSIS = ('E36', 'E38', 'E39', 'E46', 'E52', 'E53', 'E60', 'E65',
           'E70', 'E83', 'E85', 'E89', 'K1X', 'K24', 'KH2', 'R50',
           'R56', 'RR1')


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


def shift_of(mask: int) -> int:
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
    layouts = {}
    # BLOCKNR -> BMW's designation for that region, unioned across the
    # module's variants. Blocks are a property of the module's layout, not of
    # one variant, and neighbouring indices name them identically -- so this
    # rides once per module rather than being repeated on every field.
    blocks = {}
    for p in sorted(paths):
        raw = open(p, "rb").read()
        for bnr, bez in N.block_names(raw).items():
            blocks.setdefault(bnr, bez)
        rr = N.rows(raw, chassis=N.chassis_of(p))
        if not rr:
            continue
        fields = []
        for r in rr:
            if not r['name']:
                continue                       # unresolved id: nothing to show
            field = {
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
            }
            # one mask per byte, only when they are not all 0xFF (see
            # ncs_daten._masks): 'mask' is then the first byte's
            if r.get('masks'):
                field['masks'] = r['masks']
            # EINHEIT: how the value reads -- 'd' decimal, 'a'/'A' ASCII text,
            # 'b' binary. Omitted when 'h' (hex, the default) to keep the map
            # small. Governs display, and inverted, encoding.
            if r.get('unit') and r['unit'] != 'h':
                field['unit'] = r['unit']
            # OPERATION list [[op, operand], ...] -- a value transform on the
            # assembled bytes (e.g. [["-",48]] un-packs an ASCII digit). Only
            # DIR "property" fields carry them; needed to render and to encode.
            if r.get('ops'):
                field['ops'] = [[op, n] for op, n in r['ops']]
            # a DIR field is a computed property (VIN, date, key), read-only
            # in the coding UI -- not an aktiv/nicht_aktiv choice
            if r.get('dir'):
                field['dir'] = True
            fields.append(field)
        if fields:
            out[os.path.basename(p).split('.')[-1]] = fields
            layouts[os.path.basename(p).split('.')[-1]] = N.layout(raw)

    # FOLD IDENTICAL VARIANTS. A module ships one file per coding index and
    # neighbouring indices are usually the same sheet -- LCM's eleven come
    # to three distinct layouts. Keeping every copy tripled the payload for
    # nothing, so identical ones collapse to a single entry listing the
    # indices it serves. Distinct layouts are all still here.
    # The layout (memory organisation, named blocks) folds with the fields:
    # two indexes are one entry only when both agree. The coding indexes the
    # folded files serve are listed together.
    folded = {}
    for var, fields in out.items():
        lay = dict(layouts[var], index=None)
        key = json.dumps([fields, lay], sort_keys=True)
        folded.setdefault(key, []).append(var)
    variants = {}
    lay_out = {}
    for k, v in folded.items():
        name = '+'.join(sorted(v))
        variants[name] = json.loads(k)[0]
        lay = dict(layouts[v[0]])
        lay['index'] = sorted({i for var in v for i in layouts[var]['index']})
        lay_out[name] = lay
    return variants, blocks, lay_out


def main():
    """CLI entry: datenmap.js -- the English labels of every keyword any
    chassis's coding files use. Run from the repository root."""
    trans = load_translations()
    words = set()
    for ch in CHASSIS:
        d = f'{N.DATEN}/{ch}'
        if not os.path.isdir(d):
            continue
        by_mod = {}
        for fn in sorted(os.listdir(d)):
            if '.C' in fn.upper():
                by_mod.setdefault(fn.split('.')[0].upper(), []).append(
                    f'{d}/{fn}')
        for paths in by_mod.values():
            variants, blocks, _ = read_module(paths)
            words.update(str(b).lower() for b in (blocks or {}).values())
            for fields in variants.values():
                for r in fields:
                    words.add(r['name'].lower())
                    words.update(str(n).lower() for n, _ in r['values'])
    i18n = {k: trans[k] for k in sorted(words) if k in trans}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        fh.write('// GENERATED by tools/decompile/daten_map.py.\n'
                 '// BMW_DATEN_I18N: keyword -> English, from NCS Dummy\'s '
                 'Translations.csv, for every\n// keyword the coding files '
                 '(data/daten/<CHASSIS>.json) use. BMW_DATEN_MAP is empty:\n'
                 '// coding files are reached by NCS\'s own tables, never by '
                 'an SGBD\'s name.\n'
                 'window.BMW_DATEN_MAP={};\nwindow.BMW_DATEN_I18N=')
        json.dump(i18n, fh, separators=(',', ':'), sort_keys=True,
                  ensure_ascii=False)
        fh.write(';\n')
    print(f'{len(i18n)} English labels for {len(words)} keywords '
          f'-> {OUT} ({os.path.getsize(OUT) // 1024} KB)')


if __name__ == '__main__':
    sys.exit(main())
