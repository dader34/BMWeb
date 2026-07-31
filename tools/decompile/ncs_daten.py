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

WHAT IS DONE AND WHAT IS NOT.

The SCHEMA reads, on all 260 files, and it is the same schema in every one:
the preamble is byte-identical and always ends at 1148, so it is a fixed
template and everything after it is that module's own data. That part is
solid, and so is the keyword table -- SWTFSW01.dat gives 3,801 FSW numbers
and their names.

THE ROW WALK IS NOT SOLID and should not be built on. Rows can be FOUND --
a byte triple repeats at a fixed spacing, the spacing differs by module (24
in LWS5, 33 in ACC) -- but the fields inside one are not being read
correctly, and three separate checks say so:

  * A module's rows decode to another module's functions. ACC (adaptive
    cruise) yields window and airbag names, LSZ (light switch) yields
    BAUREIHE_E31, LWS5 (steering angle) yields OELSERVICE_ZAEHLER. Zero
    in-domain hits for any of them.

  * The keyword table is DENSE: 3,749 ids spread over the u16 space, so
    5.6% of random values resolve to a name. "It resolved" is therefore
    weak evidence, and an earlier version of this file reported 59% as
    though it meant something. It means the rows are not random -- which
    they are not -- but not that the right field is being read.

  * Scanning a row for the offset with the highest keyword density finds
    +1 and +5 at 100%, and both return the SAME name for every row: they
    are part of the marker, not a field. Offset +3 varies but gives the
    wrong domain.

So the marker is probably not the head of a record. It may be a field
inside one, with the real record starting some bytes earlier, which would
put every offset measured from it wrong by a constant.

WHAT WOULD SETTLE IT, and what was tried. The plan was to test against an
ECU whose SGBD already names its coding values (coding_map.py finds 53).
That does not work directly: the SGBD's result names and NCS's keywords are
different vocabularies -- none of dwa4's 89 SGBD names appear in the
keyword table at all. A usable test needs a module whose .C0x can be
checked some other way: a known coding string for a known car, or the
NETTODAT trace of a read, which is what NCS Expert writes out and what
would pin the layout exactly.

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
# Row lengths seen across the corpus. LWS5 uses 24, ACC 33; the reader
# tries each and keeps whichever explains the most rows in the file.
STRIDES = (24, 33, 21, 30, 36, 42, 18, 27, 39, 45, 48)

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
    if len(body) < 96:
        return []

    # THE STRIDE IS NOT 24 EVERYWHERE EITHER. LWS5's rows are 24 bytes and
    # ACC's are 33 -- ACC has no triple at all repeating at 24, which is why
    # assuming that length found nothing in 220 of 260 files. So the row
    # length is discovered per file alongside the marker: try each plausible
    # length and keep the (length, marker) pair that explains the most rows.
    seen = {}
    for stride in STRIDES:
        for i in range(len(body) - stride - 3):
            t = body[i:i + 3]
            # 00s and FFs are padding and unset fields; they repeat at every
            # stride and would outvote the real head of a row (LWS5's
            # ff ff ff occurs 89 times against the true marker's 65).
            if t in (b'\x00\x00\x00', b'\xff\xff\xff'):
                continue
            if t == body[i + stride:i + stride + 3]:
                seen[(stride, t)] = seen.get((stride, t), 0) + 1
    if not seen:
        return []

    # COUNTING REPEATS IS NOT ENOUGH. A triple can sit 24 apart in a few
    # places and everywhere else besides: LSZ's winner occurred 450 times
    # with gaps of 5, 7 and 9, which is ordinary data, not the head of a
    # record. A real marker's occurrences are MOSTLY 24 apart. So score each
    # candidate by the share of its gaps that are exactly one row, and take
    # the best -- LWS5's marker scores 65 of 71, LSZ's noise scores a
    # handful of 450.
    # HOW MANY ROWS IT FINDS COMES FIRST, cleanliness second. Ranking by the
    # share of gaps that are one row put a triple occurring 11 times at a
    # perfect 1.0 above the true marker's 65 at 0.92 -- a marker that
    # explains eleven rows is not better than one that explains sixty-five.
    # So score by the count, and use the share only to reject the ones that
    # are ordinary data (LSZ's winner appeared 450 times with gaps of 5, 7
    # and 9).
    def score(stride, t):
        offs = [m.start() for m in re.finditer(re.escape(t), body)]
        if len(offs) < 3:
            return 0, 0.0
        good = sum(1 for a, b in zip(offs, offs[1:]) if b - a == stride)
        return good, good / (len(offs) - 1)

    best, best_score = None, (0, 0.0)
    for stride, t in seen:
        s = score(stride, t)
        if s[1] >= 0.4 and s > best_score:
            best, best_score = (stride, t), s
    if best is None or best_score[0] < 3:
        return []
    row_len, mark = best

    # Rows come in RUNS, not one unbroken table: LWS5's 72 rows sit 24 apart
    # except at four points where a block header of 82-83 bytes intervenes.
    # So follow the marker rather than the stride, and let the stride only
    # decide where to look next -- stopping at the first gap loses most of
    # the file, and stepping blindly by 24 drifts into the header.
    # Take the occurrences that are actually a row apart. Following every
    # occurrence swept in whatever else happened to match; requiring an
    # unbroken stride stopped at the first block header. The rows are the
    # ones in a run, so keep those and let a run end where it ends.
    offs = [m.start() for m in re.finditer(re.escape(mark), body)]
    keep = []
    for a, b in zip(offs, offs[1:]):
        if b - a == row_len:
            if not keep or keep[-1] != a:
                keep.append(a)
            keep.append(b)
    return [{
        'fsw': int.from_bytes(body[i + 3:i + 5], 'little'),
        'index': body[i + 7],
        'len': row_len,
        'raw': body[i:i + 12].hex(' '),
    } for i in keep if i + row_len <= len(body)]


def keywords():
    """FSW number -> BMW's own name for that function.

    SWTFSW01.dat is the table, and it says so itself: its schema declares
    SWT_EINTRAG over KEYID,KEYWORD. 3,801 entries, each a u16 id followed
    by the name.

    HOW FAR TO TRUST IT. On LSZ the names land where they should --
    FEHLER_NSL_RECHTS and KALTUEBERWACHUNG_NSL_R against a light switch
    centre, matching the COD_NSL_* values its own SGBD declares. On LWS5
    they do not: a steering angle sensor comes back with OELSERVICE_ZAEHLER
    and SIA_ANZEIGE, which belong to a service-interval module. So the row
    walk is right for some families and lands off-by-something for others,
    and 59% of rows corpus-wide resolve at all. Reported, not papered over.
    """
    p = f'{DATEN}/SWTFSW01.dat'
    if not os.path.exists(p):
        return {}
    data = open(p, 'rb').read()
    out = {}
    head = data.find(b'KEYID,KEYWORD\x00')
    start = head + 14 if head >= 0 else 0
    for m in re.finditer(rb'([A-Z][A-Z0-9_]{2,60})\x00', data[start:]):
        i = m.start() + start
        if i < 2:
            continue
        out[int.from_bytes(data[i - 2:i], 'little')] = m.group(1).decode()
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
        kw = keywords()
        for r in rr[:20]:
            print(f"   FSW {r['fsw']:6}   index {r['index']:3}   "
                  f"{kw.get(r['fsw'], '')}")
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
