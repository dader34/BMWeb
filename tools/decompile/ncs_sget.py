#!/usr/bin/env python3
"""BMW's <BR>SGET.000 -- which ECUs a car actually has, and the predicate why.

An SGET file lists every control unit a chassis can carry. Each row names the
SGBD/CABD to talk to it, and carries an AUFTRAGSAUSDRUCK: a byte-coded boolean
expression over the car's equipment codes deciding whether THIS car has it.
Evaluating it is what turns "every module an E46 could ever have" into "the
modules in front of you".

    python3 tools/decompile/ncs_sget.py                 # summarise the corpus
    python3 tools/decompile/ncs_sget.py --write         # -> data/ncs-sget.json
    python3 tools/decompile/ncs_sget.py --check         # invariants, exit 1 on fail

CONTAINER. The same frames as a .C0x file (ncs_daten.records()), in three
row blocks of different shapes -- see parse_file().

The `A` field also differs in meaning: in .C0x it is a CABD OPERATION list
(fixed 5-byte entries), here it is the raw AUFTRAGSAUSDRUCK blob. ncs_daten's
decoder is deliberately left alone -- it is load-bearing for the .C0x corpus
(6173 rows, 0 fails) and must not learn a second meaning for `A`.

"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # tools/
from _cli import parse_args                                     # noqa: E402
import ncs_daten as N                                           # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATEN = os.path.join(ROOT, 'vendor', 'EC-APPS', 'NCSEXPER', 'DATEN')
OUT = os.path.join(ROOT, 'data', 'ncs-sget.json')
# The renderer loads shipped data as a JS file assigning a global, lazily
# (see translate.js _lazyScript), so emit that shape too -- same convention as
# datenmap.js / codingmap.js.
OUT_JS = os.path.join(ROOT, 'app', 'renderer', 'data', 'sget.js')

# ---- the predicate, decoded to text ---------------------------------------
#
# Mirrors app/renderer/core/coding/auftrag.js. Kept as TEXT here (not a tree):
# the JS side owns evaluation, this side just has to hand it the bytes and a
# human-readable form for tooling. Verified equal by test_coding_auftrag.js.

def expr_text(b):
    """Predicate bytes -> "(S99,S92+S3,S287)+!S420". '' when empty."""
    out = []
    i = 0
    while i < len(b):
        c = b[i]
        if c == 0x53:                       # 'S' + u16 LE
            if i + 2 >= len(b):
                raise ValueError('truncated S token')
            out.append('S%d' % (b[i + 1] | (b[i + 2] << 8)))
            i += 3
            continue
        if c in (0x2b, 0x2c, 0x21, 0x28, 0x29):
            out.append(chr(c))
        elif c in (0x5c, 0x00):
            pass                            # chunk seam / padding
        else:
            raise ValueError('unexpected byte 0x%02x' % c)
        i += 1
    return ''.join(out)


def refs_of(b):
    """Every equipment code the predicate tests, in first-seen order."""
    out = []
    i = 0
    while i < len(b):
        if b[i] == 0x53 and i + 2 < len(b):
            v = b[i + 1] | (b[i + 2] << 8)
            if v not in out:
                out.append(v)
            i += 3
        else:
            i += 1
    return out


# The three row blocks of an SGET file and the strings each row opens with
# (the file's own schema: SGAUSWAHL_VM is SSSSA.., _SGBD is SSSSSA.., _VMSGBD
# is SSSSSSA..). After the strings comes the AUFTRAGSAUSDRUCK, a u8 length
# and that many predicate bytes, then an optional INDEX.
BLOCKS = (
    ('SGAUSWAHL_VMSGBD', ('SGNAME', 'CBD', 'CABD', 'SGBD', 'UMRSG', 'VMG')),
    ('SGAUSWAHL_SGBD', ('SGNAME', 'CBD', 'CABD', 'SGBD', 'UMRSG')),
    ('SGAUSWAHL_VM', ('SGNAME', 'CBD', 'UMRSG', 'VMG')),
)
PREDICATE_BYTES = (0x53, 0x2b, 0x2c, 0x21, 0x28, 0x29, 0x5c)


def _row(payload, columns):
    """One framed row -> ({column: text}, predicate bytes), or None."""
    i = 0
    names = {}
    for col in columns:
        j = payload.find(0, i)
        if j < 0:
            return None
        text = payload[i:j]
        if not re.fullmatch(rb'[\x20-\x7e]*', text):
            return None
        names[col] = text.decode('latin1')
        i = j + 1
    if i >= len(payload) or not names.get('SGNAME'):
        return None
    ln = payload[i]
    blob = bytes(payload[i + 1:i + 1 + ln])
    if len(blob) != ln:
        return None
    # every byte of a predicate is a token or an 'S' operand
    k = 0
    while k < len(blob):
        if blob[k] == 0x53:
            k += 3
        elif blob[k] in PREDICATE_BYTES:
            k += 1
        else:
            return None
    if k != len(blob):
        return None
    return names, blob


def parse_file(path):
    """One SGET file -> {'chassis', 'rows': [...], 'failed': n}.

    THE FILE IS FRAMED like every other DATEN file -- <len><seq><00><payload>
    <xor>, ncs_daten.records() -- and its rows come in three blocks that the
    schema names and that DIFFER IN SHAPE:

        SGAUSWAHL_VM       SGNAME CBD UMRSG VMG                  (4 strings)
        SGAUSWAHL_SGBD     SGNAME CBD CABD SGBD UMRSG            (5 strings)
        SGAUSWAHL_VMSGBD   SGNAME CBD CABD SGBD UMRSG VMG        (6 strings)

    An earlier reader took the rows for an unframed run of five strings and
    looked for them by pattern. On the E46, whose rows are all of the middle
    kind, that found 146 of 148 (it wanted a name to start with a capital,
    and lost CVM_e46). On chassis that use the other two blocks the columns
    came out shifted by one, or nothing was found at all (E32, E34).

    Each row keeps the columns its block has, with '' for the ones it lacks,
    and says which block it came from in `kind`. verified against
    E46SGET.000, whose MRS3 row reads MRS3/C31/A_MRS3/C_MRS3/ABG +
    "(S99,S92+S3,S287)+!S420".
    """
    data = open(path, 'rb').read()
    secs = N.schema(data)
    recs = N.records(data)
    rows, failed = [], 0
    for block, columns in BLOCKS:
        sec = secs.get(block)
        if not sec:
            continue
        for seq, payload, _at in recs:
            if seq != sec['seq']:
                continue
            got = _row(bytes(payload), columns)
            if not got:
                continue          # a stretch of the schema that framed by chance
            names, blob = got
            try:
                text = expr_text(blob)
            except ValueError:
                failed += 1
                continue
            rows.append({
                'SGNAME': names['SGNAME'], 'CBD': names['CBD'],
                'CABD': names.get('CABD', ''), 'SGBD': names.get('SGBD', ''),
                'UMRSG': names['UMRSG'], 'VMG': names.get('VMG', ''),
                'kind': block[len('SGAUSWAHL_'):],
                'expr': text, 'exprHex': blob.hex().upper(),
                'refs': refs_of(blob),
            })

    base = os.path.basename(path).upper()
    m = re.match(r'([A-Z0-9]+)SGET', base)
    return {'chassis': m.group(1) if m else base, 'rows': rows, 'failed': failed}


def corpus():
    """Every SGET file under DATEN (`<CHASSIS>SGET.<nnn>`), sorted."""
    out = []
    for dirpath, _, names in os.walk(DATEN):
        for n in names:
            if re.match(r'^[A-Z0-9]+SGET\.\d+$', n.upper()):
                out.append(os.path.join(dirpath, n))
    return sorted(set(out))


def main():
    """CLI entry: summarise the corpus, ``--check`` its invariants (exit 1 on
    failure), or ``--write`` the JSON and JS outputs."""
    ns = parse_args(__doc__,
                    flags={'--write': 'write data/ncs-sget.json and the renderer JS',
                           '--check': 'verify the invariants; exit 1 on failure'})
    files = corpus()
    if not files:
        sys.exit(f'no SGET files under {DATEN} (run scripts/setup/fetch.sh)')

    write = ns.write
    check = ns.check

    seen, tot_rows, tot_fail, with_expr = {}, 0, 0, 0
    for f in files:
        r = parse_file(f)
        ch = r['chassis']
        if ch in seen and len(seen[ch]['rows']) >= len(r['rows']):
            continue                        # same chassis shipped twice: keep richer
        seen[ch] = r
    for ch, r in sorted(seen.items()):
        tot_rows += len(r['rows'])
        tot_fail += r['failed']
        with_expr += sum(1 for x in r['rows'] if x['expr'])
        if not check:
            print(f"  {ch:6s} {len(r['rows']):4d} rows  "
                  f"{sum(1 for x in r['rows'] if x['expr']):4d} with predicate"
                  + (f"  ({r['failed']} unparsed)" if r['failed'] else ''))

    print(f"{len(seen)} chassis, {tot_rows} rows, {with_expr} with a predicate, "
          f"{tot_fail} unparsed")

    if check:
        bad = 0
        if tot_rows == 0:
            print('FAIL: no rows parsed'); bad += 1
        # A wholesale misread shows up as mass parse failure, not a few odd rows.
        if tot_fail > tot_rows * 0.05:
            print(f'FAIL: {tot_fail}/{tot_rows} rows unparsed (>5%)'); bad += 1
        if with_expr == 0:
            print('FAIL: no predicates found'); bad += 1
        # Every predicate must re-lex: text is derived from bytes, so a
        # round-trip failure means the byte reading is wrong.
        for ch, r in seen.items():
            for row in r['rows']:
                if row['expr'] and not re.fullmatch(r'[S0-9+,!()]+', row['expr']):
                    print(f"FAIL: {ch} {row.get('SGBD')} bad expr {row['expr']!r}")
                    bad += 1
                    break
        if bad:
            sys.exit(1)
        print('SGET invariants OK')

    if write:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        payload = {ch: {'rows': r['rows']} for ch, r in sorted(seen.items())}
        with open(OUT, 'w') as fh:
            json.dump(payload, fh, separators=(',', ':'), sort_keys=True)
        print(f'wrote {OUT} ({os.path.getsize(OUT)} bytes)')

        os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
        with open(OUT_JS, 'w') as fh:
            fh.write('// BMW SGET: which ECUs a car has, and the '
                     'AUFTRAGSAUSDRUCK predicate deciding it.\n')
            fh.write('// Generated by tools/decompile/ncs_sget.py '
                     '-- do not edit by hand.\n')
            fh.write('window.BMW_SGET=')
            json.dump(payload, fh, separators=(',', ':'), sort_keys=True)
            fh.write(';\n')
        print(f'wrote {OUT_JS} ({os.path.getsize(OUT_JS)} bytes)')


if __name__ == '__main__':
    main()
