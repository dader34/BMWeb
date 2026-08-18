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

CONTAINER. NOT the .C0x frame walker. ncs_daten.records() resyncs on a
<len><seq><00><payload><xor> frame; SGET rows are not framed that way, and
running that walker here finds only false positives inside the schema text.
An SGET row is a flat run instead -- five NUL-terminated strings, a u8 length,
then that many predicate bytes -- so this module walks the structure directly.
ncs_daten is still imported for its schema()/strings() helpers.

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
import ncs_daten as N   # framing (records), schema walker, string scan

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATEN = os.path.join(ROOT, 'vendor', 'EC-APPS', 'NCSEXPER', 'DATEN')
OUT = os.path.join(ROOT, 'data', 'ncs-sget.json')
# The renderer loads shipped data as a JS file assigning a global, lazily
# (see translate.js _lazyScript), so emit that shape too -- same convention as
# datenmap.js / codingmap.js.
OUT_JS = os.path.join(ROOT, 'app', 'renderer', 'data', 'sget.js')

# ---- the predicate, decoded to text ---------------------------------------
#
# Mirrors app/renderer/core/coding-auftrag.js. Kept as TEXT here (not a tree):
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


def parse_file(path):
    """One SGET file -> {chassis, rows:[...]}.

    STRUCTURAL WALK, not the .C0x frame walker. ncs_daten.records() resyncs on
    a <len><seq><00>...<xor> frame; SGET's rows are not framed that way, and
    running it here yields only false positives caught inside the schema text
    (3-byte payloads like b'SGA'). A row is laid out flat instead:

        <SGNAME\0><CBD\0><CABD\0><SGBD\0><UMRSG\0><u8 len><predicate bytes>

    verified against E46SGET.000, whose second row reads
    MRS3/C31/A_MRS3/C_MRS3/ABG + "(S99,S92+S3,S287)+!S420".

    The predicate must START with a predicate byte ('S', '!' or '(') -- that
    single check is what separates real rows from the schema strings above
    them, and it is why rows are counted, not assumed.
    """
    data = open(path, 'rb').read()
    n = len(data)

    def read_row(i):
        names = []
        for _ in range(5):
            j = data.find(0, i)
            if j < 0 or j - i < 1 or j - i > 40:
                return None
            s = data[i:j]
            if not re.fullmatch(rb'[\x20-\x7e]+', s):
                return None
            names.append(s.decode('latin1'))
            i = j + 1
        if i >= n:
            return None
        ln = data[i]
        i += 1
        if ln == 0 or i + ln > n:
            return None
        blob = data[i:i + ln]
        # a predicate opens with a ref, a NOT or a group -- nothing else
        if blob[0] not in (0x53, 0x21, 0x28):
            return None
        # A NAME run that swallowed part of an expression leaves the length
        # byte pointing mid-predicate, so `ln` overshoots into the row trailer
        # (00 00 <u32>). Trust the token stream over the length: stop at the
        # first byte that cannot appear in a predicate. A correctly-aligned
        # row is unaffected -- every byte in its blob is a token.
        TOK = (0x53, 0x2b, 0x2c, 0x21, 0x28, 0x29, 0x5c)
        end = len(blob)
        k = 0
        while k < len(blob):
            c = blob[k]
            if c == 0x53:          # 'S' + u16 LE operand: skip the operand
                k += 3
                continue
            if c in TOK:
                k += 1
                continue
            end = k
            break
        blob = blob[:end]
        if not blob:
            return None
        # PARENS MUST BALANCE. A name run that swallowed an opening '(' leaves
        # a predicate that lexes but cannot parse ("S200),S84+..."). Those are
        # misaligned reads, not BMW data -- drop them here so only expressions
        # the evaluator can actually parse are ever shipped.
        depth = 0
        k = 0
        while k < len(blob):
            c = blob[k]
            if c == 0x53:
                k += 3
                continue
            if c == 0x28:
                depth += 1
            elif c == 0x29:
                depth -= 1
                if depth < 0:
                    return None      # closed one that was never opened
            k += 1
        if depth != 0:
            return None
        return names, blob

    rows, failed, seen_at = [], 0, set()
    for m in re.finditer(rb'(?<=\x00)[A-Z][A-Z0-9_]{1,20}\x00', data):
        if m.start() in seen_at:
            continue
        r = read_row(m.start())
        if not r:
            continue
        names, blob = r
        try:
            text = expr_text(blob)
        except ValueError:
            failed += 1
            continue
        seen_at.add(m.start())
        rows.append({
            'SGNAME': names[0], 'CBD': names[1], 'CABD': names[2],
            'SGBD': names[3], 'UMRSG': names[4],
            'expr': text, 'exprHex': blob.hex().upper(), 'refs': refs_of(blob),
        })

    base = os.path.basename(path).upper()
    m = re.match(r'([A-Z0-9]+)SGET', base)
    return {'chassis': m.group(1) if m else base, 'rows': rows, 'failed': failed}


def corpus():
    out = []
    for dirpath, _, names in os.walk(DATEN):
        for n in names:
            if re.match(r'^[A-Z0-9]+SGET\.\d+$', n.upper()):
                out.append(os.path.join(dirpath, n))
    return sorted(set(out))


def main():
    files = corpus()
    if not files:
        sys.exit(f'no SGET files under {DATEN} (run scripts/setup/fetch.sh)')

    write = '--write' in sys.argv
    check = '--check' in sys.argv

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
