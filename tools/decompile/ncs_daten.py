#!/usr/bin/env python3
"""BMW's coding description files (.C0x), decoded.

    tools/decompile/ncs_daten.py LSZ.C26          # one file, full listing
    tools/decompile/ncs_daten.py --corpus         # coverage over all of them

WHAT THESE ARE. A module hands back its coding as a binary blob. NCS Expert
turns that into "fold mirrors on lock" using these files, which say which
bit at which address carries which function. The SGBDs already name their
own coding values for 53 ECUs (tools/decompile/coding_map.py finds those);
these cover the rest -- 260 files across 109 modules.

THE FORMAT IS SELF-DESCRIBING, which is what makes it tractable. Each file
opens with a SCHEMA: a run of sections, each declaring its own name, a type
signature and the field names that signature fills. So the reader does not
need a hardcoded table of record layouts -- it reads the layout out of the
file and then applies it.

    PARZUWEISUNG_FSW  {L}LWW{B}(B){B}{B}
                      BLOCKNR,WORTADR,BYTEADR,FSW,INDEX,MASKE,EINHEIT,INDIVID

That is the record that matters: block number, word and byte address, the
FUNCTION KEYWORD, a bit index and a mask. Everything needed to find a
function's bits inside the blob and put them back.

THE ENCODING, worked out against LSZ.C26 and checked across the corpus.
A section NAME is framed:

    <u8 len><u8 00><u8 3><u8 seq><u8 00><name><NUL>

    len   is strlen + 3, counting the seq and both NULs
    3     marks "this is a section name"
    seq   the section's index, 0 upward, so the order is explicit

Its signature and field list follow as the next two NUL-terminated strings.
They carry their own small headers whose middle byte differs (4 and 5), but
their position after the name is what identifies them, and reading them
positionally survives the variations across the corpus.

A type signature is a string of letter codes, where {} marks a field that
may be absent and () marks one that repeats:

    L long (4 bytes)   W word (2)   B byte (1)   S string (NUL-terminated)
    A a further signature, applied to a nested record

WHAT IS DONE AND WHAT IS NOT. The schema reads, on all 260 files, and it is
the SAME schema in every one -- the preamble is byte-identical and always
ends at 1148, so it is a fixed template and everything after it is that
module's own data. Walking those data records is the part still open: the
rows carry the framing the schema describes, but the record boundaries do
not fall out of a single stride (LWS5's tail repeats every 24 bytes; the
body before it does not), so the reader stops at the schema rather than
emitting rows it cannot stand behind.

Read-only: decodes files on disk, never talks to a car.
"""

import argparse
import glob
import json
import os
import re
import sys

DATEN = 'vendor/EC-APPS/NCSEXPER/DATEN'

KIND_NAME = 3
KIND_SIG = 4
KIND_FIELDS = 5

# One letter of a type signature -> how many bytes it eats. S and A are
# variable and handled by the reader rather than by width.
WIDTH = {'L': 4, 'W': 2, 'B': 1}


def strings(data):
    """Every NUL-terminated printable run, with the header byte before it.

    The schema is a flat run of these. Scanning for the strings and reading
    their small headers is what survives the corpus: the name framing is
    exact, and the signature and field list are identified by following it.
    """
    out = []
    for m in re.finditer(rb'[\x20-\x7e]{1,120}\x00', data):
        s = m.group()[:-1].decode('latin1')
        i = m.start()
        if i < 5:
            continue
        ln, _, kind, seq, _ = data[i - 5:i]
        out.append({'at': i, 'kind': kind, 'seq': seq, 'text': s,
                    'named': kind == KIND_NAME and ln == len(s) + 3})
    return out


def parse_signature(sig):
    """A type signature into a list of {code, optional, repeating}."""
    out = []
    i = 0
    while i < len(sig):
        c = sig[i]
        if c == '{':
            j = sig.index('}', i)
            for k in sig[i + 1:j]:
                out.append({'code': k, 'optional': True, 'repeating': False})
            i = j + 1
        elif c == '(':
            j = sig.index(')', i)
            for k in sig[i + 1:j]:
                out.append({'code': k, 'optional': False, 'repeating': True})
            i = j + 1
        else:
            out.append({'code': c, 'optional': False, 'repeating': False})
            i += 1
    return out


def schema(data):
    """The file's declared sections: name -> {signature, fields}.

    A section is a (name, signature, fields) triple appearing in that order.
    Some sections declare no signature (a bare value); those are kept with
    an empty one rather than dropped, because their NAME is still the key
    the data records are grouped under.
    """
    secs = {}
    cur = None
    for s in strings(data):
        if s['named']:
            cur = {'name': s['text'], 'seq': s['seq'], 'sig': '', 'fields': []}
            secs[s['text']] = cur
        elif cur is not None and not cur['sig'] \
                and re.fullmatch(r'[LWBSA(){}]+', s['text']):
            cur['sig'] = s['text']
        elif cur is not None and not cur['fields'] and ',' in s['text'] \
                and re.fullmatch(r'[A-Z0-9_,]+', s['text']):
            cur['fields'] = [f.strip() for f in s['text'].split(',')]
        elif cur is not None and not cur['fields'] and not cur['sig'] \
                and re.fullmatch(r'[A-Z0-9_]+', s['text']):
            cur['fields'] = [s['text']]     # a lone field, e.g. WERT
    return secs


# A coding row, in the data section. The rows are fixed 24-byte records and
# each opens with the same three bytes, which is what makes them findable:
# the schema says what the fields ARE, but not where a record begins, and
# the section headers between them are not a reliable stride.
ROW_MARK = b'\x14\x10\x00'
ROW_LEN = 24

# The schema preamble is byte-identical in all 260 files and always this
# long, so the data begins here in every one of them.
SCHEMA_LEN = 1148


def rows(data):
    """The module's coding rows: which function keyword lives where.

    FSW is BMW's function keyword number -- the identifier that
    SWTFSW*.DAT turns into a readable name ("fold mirrors on lock"). The
    index counts the rows within a block and is what the module's own
    coding memory is addressed by.
    """
    # THE STRIDE IS THE INVARIANT, not the marker. Rows are 24 bytes in
    # every module, but what sits at the head of one differs by family --
    # LWS5's begin 14 10 00, ACC's begin 00 01 00 -- so anchoring on any one
    # of them found rows in 64 files and nothing in the other 196. Instead,
    # find the byte triple that actually repeats at a 24-byte spacing in
    # THIS file, and walk from its first occurrence.
    body = data[SCHEMA_LEN:]
    if len(body) < ROW_LEN * 3:
        return []
    seen = {}
    for i in range(len(body) - ROW_LEN - 3):
        t = body[i:i + 3]
        # 00s and FFs are padding and unset fields; they repeat at every
        # stride and would outvote the real head of a row (LWS5's ff ff ff
        # occurs 89 times against the true marker's 65).
        if t in (b'\x00\x00\x00', b'\xff\xff\xff'):
            continue
        if t == body[i + ROW_LEN:i + ROW_LEN + 3]:
            seen[t] = seen.get(t, 0) + 1
    if not seen:
        return []
    mark = max(seen, key=lambda k: seen[k])
    if seen[mark] < 2:
        return []

    # Rows come in RUNS, not one unbroken table: LWS5's 72 rows sit 24 apart
    # except at four points where a block header of 82-83 bytes intervenes.
    # So follow the marker rather than the stride, and let the stride only
    # decide where to look next -- stopping at the first gap loses most of
    # the file, and stepping blindly by 24 drifts into the header.
    out = []
    i = body.find(mark)
    while 0 <= i and i + ROW_LEN <= len(body):
        out.append({
            'fsw': int.from_bytes(body[i + 3:i + 5], 'little'),
            'index': body[i + 7],
            'raw': body[i:i + 12].hex(' '),
        })
        nxt = body.find(mark, i + ROW_LEN)
        i = nxt
    return out


def summarise(path, verbose=False):
    data = open(path, 'rb').read()
    secs = schema(data)
    name = os.path.basename(path)
    fsw = secs.get('PARZUWEISUNG_FSW') or {}
    rr = rows(data)
    print(f'{name}  {len(data)} bytes  {len(secs)} sections  {len(rr)} coding rows')
    if verbose:
        for s in secs.values():
            sig = s['sig']
            flds = ','.join(s['fields'])
            print(f"   {s['name']:26} {sig:22} {flds}")
        print()
        for r in rr[:20]:
            print(f"   FSW {r['fsw']:6}   index {r['index']:3}")
        if len(rr) > 20:
            print(f"   ... {len(rr) - 20} more")
    elif fsw:
        print(f"   PARZUWEISUNG_FSW  {fsw['sig']}  "
              f"{','.join(fsw['fields'])}")
    return secs


def corpus():
    """Does the reader understand every file, or only the one it was built on?"""
    files = sorted(glob.glob(f'{DATEN}/*.C[0-9][0-9]'))
    if not files:
        sys.exit(f'no .C0x files in {DATEN} '
                 '(run scripts/setup/fetch-vendor.sh)')
    ok = 0
    sigs = {}
    no_fsw = []
    for p in files:
        try:
            secs = schema(open(p, 'rb').read())
        except Exception:
            continue
        if not secs:
            continue
        ok += 1
        fsw = secs.get('PARZUWEISUNG_FSW')
        if fsw:
            sigs[fsw['sig']] = sigs.get(fsw['sig'], 0) + 1
        else:
            no_fsw.append(os.path.basename(p))
    print(f'{ok}/{len(files)} files read')
    print(f'{len(files) - len(no_fsw)} carry PARZUWEISUNG_FSW')
    n_rows = 0
    empty = 0
    keywords = set()
    for p in files:
        rr = rows(open(p, 'rb').read())
        n_rows += len(rr)
        keywords |= {r['fsw'] for r in rr}
        if not rr:
            empty += 1
    print(f'{n_rows} coding rows, {len(keywords)} distinct function keywords'
          + (f', {empty} files with none' if empty else ''))
    print('\nits signature, and how many files use it:')
    for s, n in sorted(sigs.items(), key=lambda kv: -kv[1]):
        print(f'  {n:4}  {s}')
    if no_fsw:
        print(f'\nwithout one ({len(no_fsw)}): {", ".join(no_fsw[:8])}'
              + (' ...' if len(no_fsw) > 8 else ''))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('file', nargs='?', help='a .C0x file (name or path)')
    ap.add_argument('--corpus', action='store_true',
                    help='read every .C0x and report what is understood')
    ap.add_argument('-v', '--verbose', action='store_true',
                    help='list every section, not just the coding one')
    args = ap.parse_args()

    if args.corpus:
        return corpus()
    if not args.file:
        ap.print_help()
        return 1
    p = args.file if os.path.exists(args.file) else f'{DATEN}/{args.file}'
    if not os.path.exists(p):
        sys.exit(f'not found: {args.file}')
    summarise(p, args.verbose)


if __name__ == '__main__':
    sys.exit(main())
