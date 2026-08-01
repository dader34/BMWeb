#!/usr/bin/env python3
"""BMW's coding description files (.C0x), decoded.

    tools/decompile/ncs_daten.py LSZ.C26          # one file, full listing
    tools/decompile/ncs_daten.py --corpus         # coverage over all of them
    tools/decompile/ncs_daten.py --validate       # names vs the SGBDs' own

WHAT THESE ARE. A module hands back its coding as a binary blob. NCS Expert
turns that into "fold mirrors on lock" using these files, which say which
bit at which address carries which function. The SGBDs already name their
own coding values for 53 ECUs (tools/decompile/coding_map.py finds those);
these cover the rest.

THE CONTAINER IS FRAMED AND CHECKSUMMED, which is the fact every earlier
version of this tool missed. After the schema, the whole file is one stream
of records:

    <u8 len> <u8 seq> <u8 00> <payload: len bytes> <u8 xor>

where `seq` indexes the schema's own section list (PARZUWEISUNG_FSW is
section 18 in every file here, so its records open <len> 12 00) and the
final byte is the XOR of everything from <len> through the payload. The
sections stream in declaration order, many records each. E46/LSZ.C26 tiles
into 358 such records with 5 stray bytes (a preamble before DATEINAME) and
lands exactly on end-of-file, all 110 coding payloads parsing under the
signature with exact length consumption. Across the corpus: 345 of 346
files yield rows, 20,670 of them, 97% resolving to a keyword, with 51
residual bit collisions (0.25%) against the memory-model invariant.

FIELD ENCODING inside a payload follows the signature literally:

    {X}  optional:  a flag byte, 00 = absent, 01 = present + the value
    (X)  repeating: a u16 LE count, then that many values
    L/W/B  u32/u16/u8, little-endian    S  a NUL-terminated string

so PARZUWEISUNG_FSW's {L}LWW{B}(B){B}{B} over
BLOCKNR,WORTADR,BYTEADR,FSW,INDEX,MASKE,EINHEIT,INDIVID is, for one LSZ row:

    01 00000000  00000000  0100  0806  00  0100 01  01 68  00
    ^  BLOCKNR=0 WORTADR=0 BYTE=1 FSW  ^   1 mask ^  'h'   INDIVID absent
    present                            INDEX absent  EINHEIT

NCS Dummy's published printout of a record from another DATEN release --
PARZUWEISUNG FSW : {00003405} 00000008 0001 14A4 {} (FF) {h} {} -- mirrors
this encoding brace for brace: {} is the 00 flag, (FF) the counted list,
{h} the same EINHEIT byte 0x68 our records carry.

PARZUWEISUNG_PSW1 records (W(B): PSW,DATUM) follow their FSW record and are
the function's VALUE ENUM: the parameter keyword and the bytes it writes.
LSZ's KALTUEBERWACHUNG_BL carries aktiv=00 / nicht_aktiv=01. That is
exactly what a coding editor needs and what no earlier version extracted.

THE KEYWORD TABLE IS CHOSEN PER FILE, not per module and not per chassis.
With real ids, resolution finally discriminates: E39/ACC resolves 100%
against SWTFSW01 and 63% against SWTFSW06; E46/LSZ is 98% against 06 and
62% against 01; E46/EKP_DS2 wants 01 even though the E46 directory ships
06. So the per-chassis table copies are just each release's majority
table, and the right rule is to score both tables against a file's own ids
and keep the winner. The PSW table follows the same suffix.

HOW THE OLD READER WENT WRONG, recorded so nobody anchors again. It keyed
on the bytes 01 68 00 <u16> 10 00. In the real format that is the tail of
one record and the head of the next: EINHEIT 'h', INDIVID absent, then the
record's XOR checksum, then the next record's length byte -- and a PSW1
record's length is almost always 5. So its "FSW" was <checksum><0x05>:
97.6% of extracted ids landed in 0x05xx (the table spreads evenly across
0x00-0x0e), only 399 distinct names appeared in 13,511 rows, and a
stem-overlap validation scored a lucky-looking 78% that no honest read of
the ids could support. Every conclusion drawn from those rows -- including
"SWTFSW01 is the table for everything" -- was built on that artifact.

WHAT VALIDATES THE PARSE NOW. Structure first: the checksum authenticates
every record, and payloads parse under the declared signature with exact
length consumption, corpus-wide. Then the outside check: E46/LSZ.C26 under
the 06 tables aligns with the LSZ SGBD's own coding map line for line --
word 0 bits 01/04/08/10/20 are the five KALTUEBERWACHUNG flags in the
SGBD's order, FEHLER_* per lamp matches COD_*_FEHLERMELDUNG_EIN, and the
whole-byte fields (ABSCHALTUNG_UNTERSPG, mask FF) sit where the SGBD puts
its numeric values. --validate runs a stem-overlap ranking against all 53
SGBD maps; treat it as a weak lower bound, because the two vocabularies
abbreviate differently (FEHLER vs FEHLERMELDUNG, RUECKLICHT vs SL_HINTEN)
and a token metric misses synonyms that are obvious side by side.

Also worth knowing: this archive ships coding data for E39 and E46 only,
though COAPI.INI declares paths for twenty-odd chassis. NCS Dummy's
example record (BLOCKNR 0x3405, FSW 0x14A4) appears in none of these
files: that printout is from a release this archive does not contain.

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
    """The file's declared sections: name -> {seq, signature, fields}.

    A section is a (name, signature, fields) triple appearing in that order.
    Some sections declare no signature (a bare value); those are kept with
    an empty one rather than dropped, because their NAME is still the key
    the data records are grouped under -- and their seq is the byte that
    identifies their records in the data stream.
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


def records(data):
    """Every framed record in the data stream: (seq, payload, offset).

    <len><seq><00><payload><xor-of-all-preceding>. The walker resyncs one
    byte at a time when a frame does not verify, which carries it over the
    schema region and the preamble without needing to know where the data
    begins; a chance false frame must get the zero byte AND the checksum
    right, which is one position in ~65,000.
    """
    out = []
    i = 0
    n = len(data)
    while i + 4 <= n:
        ln, seq, z = data[i], data[i + 1], data[i + 2]
        if z == 0 and seq <= 31 and i + 4 + ln <= n:
            x = 0
            for b in data[i:i + 3 + ln]:
                x ^= b
            if x == data[i + 3 + ln]:
                out.append((seq, data[i + 3:i + 3 + ln], i))
                i += 4 + ln
                continue
        i += 1
    return out


def _take(code, p, i):
    if code == 'L':
        if i + 4 > len(p):
            raise ValueError('short L')
        return int.from_bytes(p[i:i + 4], 'little'), i + 4
    if code == 'W':
        if i + 2 > len(p):
            raise ValueError('short W')
        return int.from_bytes(p[i:i + 2], 'little'), i + 2
    if code == 'B':
        if i >= len(p):
            raise ValueError('short B')
        return p[i], i + 1
    if code == 'S':
        j = p.index(0, i)
        return p[i:j].decode('latin1'), j + 1
    raise ValueError(f'unsupported code {code}')


def parse_payload(sig, p):
    """A record payload under its declared signature, strictly.

    Strict means the fields must consume the payload exactly and every
    optional flag must be 00 or 01 -- so a frame that verified by chance
    still fails here rather than yielding a garbage row.
    """
    vals = []
    i = 0
    for f in parse_signature(sig):
        if f['optional']:
            if i >= len(p) or p[i] not in (0, 1):
                raise ValueError('bad flag')
            present = p[i] == 1
            i += 1
            if not present:
                vals.append(None)
                continue
            v, i = _take(f['code'], p, i)
            vals.append(v)
        elif f['repeating']:
            if i + 2 > len(p):
                raise ValueError('short count')
            cnt = int.from_bytes(p[i:i + 2], 'little')
            i += 2
            seq = []
            for _ in range(cnt):
                v, i = _take(f['code'], p, i)
                seq.append(v)
            vals.append(seq)
        else:
            v, i = _take(f['code'], p, i)
            vals.append(v)
    if i != len(p):
        raise ValueError('length mismatch')
    return vals


def _load_swt(path):
    """One SWT keyword table: id -> name. The table names its own layout
    (SWT_EINTRAG over KEYID,KEYWORD): a u16 id directly before each name."""
    if not os.path.exists(path):
        return {}
    data = open(path, 'rb').read()
    out = {}
    head = data.find(b'KEYID,KEYWORD\x00')
    start = head + 14 if head >= 0 else 0
    for m in re.finditer(rb'([A-Za-z][A-Za-z0-9_]{1,60})\x00', data[start:]):
        i = m.start() + start
        if i < 2:
            continue
        out[int.from_bytes(data[i - 2:i], 'little')] = m.group(1).decode()
    return out


_TABLES = {}


def fsw_tables():
    """Both function-keyword tables, keyed by suffix. Which one a FILE uses
    is decided by resolution of that file's own ids (see rows)."""
    if 'fsw' not in _TABLES:
        _TABLES['fsw'] = {s: _load_swt(f'{DATEN}/SWTFSW{s}.dat')
                          for s in ('01', '06')}
    return _TABLES['fsw']


def psw_tables():
    """Both parameter-keyword tables, same suffixes as the FSW pair."""
    if 'psw' not in _TABLES:
        _TABLES['psw'] = {s: _load_swt(f'{DATEN}/SWTPSW{s}.dat')
                          for s in ('01', '06')}
    return _TABLES['psw']


def keywords():
    """SWTFSW01 alone, kept for callers that want one flat table."""
    return fsw_tables().get('01', {})


def rows(data, kw=None):
    """The module's coding rows: block, word, bit, function and its values.

    Walks the framed records, parses PARZUWEISUNG_FSW payloads under the
    file's own declared signature, and attaches the PARZUWEISUNG_PSW1
    records that follow each one -- the value enum, as (name, data-hex)
    pairs. The keyword table is picked per file by which of the two
    resolves more of the file's ids; `kw` overrides that when a caller
    wants a specific table.
    """
    secs = schema(data)
    fsw_sec = secs.get('PARZUWEISUNG_FSW')
    if not fsw_sec:
        return []
    fsw_seq = fsw_sec['seq']
    fsw_sig = fsw_sec['sig'] or '{L}LWW{B}(B){B}{B}'
    psw_sec = secs.get('PARZUWEISUNG_PSW1')
    psw_seq = psw_sec['seq'] if psw_sec else None
    psw_sig = (psw_sec['sig'] or 'W(B)') if psw_sec else 'W(B)'

    out = []
    cur = None
    for seq, payload, at in records(data):
        if seq == fsw_seq:
            try:
                blk, wort, byte, fsw, _idx, masks, _ein, _ind = \
                    parse_payload(fsw_sig, payload)
            except (ValueError, IndexError):
                continue
            mask = 0
            for m in (masks or []):
                mask |= m
            cur = {'block': blk or 0, 'word': wort, 'byte': byte,
                   'mask': mask, 'fsw': fsw, 'name': None, 'psw': [],
                   'at': at}
            out.append(cur)
        elif psw_seq is not None and seq == psw_seq and cur is not None:
            try:
                psw, datum = parse_payload(psw_sig, payload)
            except (ValueError, IndexError):
                continue
            cur['psw'].append((psw, bytes(datum or [])))

    if kw is not None:
        pick, table = kw, '01'
    else:
        tabs = fsw_tables()
        if not any(tabs.values()):
            return out
        table = max(tabs, key=lambda s: sum(1 for r in out
                                            if r['fsw'] in tabs[s]))
        pick = tabs[table]
    ptab = psw_tables().get(table, {})
    for r in out:
        r['table'] = table
        r['name'] = pick.get(r['fsw'])
        r['psw'] = [(ptab.get(p, p), d.hex()) for p, d in r['psw']]
    return out


def summarise(path, verbose=False):
    data = open(path, 'rb').read()
    secs = schema(data)
    name = os.path.basename(path)
    fsw = secs.get('PARZUWEISUNG_FSW') or {}
    rr = rows(data)
    named = sum(1 for r in rr if r['name'])
    table = rr[0].get('table', '?') if rr else '-'
    print(f'{name}  {len(data)} bytes  {len(secs)} sections  '
          f'{len(rr)} coding rows  table SWTFSW{table}  '
          f'{named}/{len(rr)} named')
    if verbose:
        for s in secs.values():
            print(f"   {s['name']:26} {s['sig']:22} {','.join(s['fields'])}")
        print()
        for r in rr[:24]:
            ps = '/'.join(str(n) for n, _ in r['psw'][:3])
            print(f"   block {r['block']:3}  word {r['word']:4}  "
                  f"mask 0x{r['mask']:02x}  "
                  f"{r['name'] or '?' + str(r['fsw']):40} [{ps}]")
        if len(rr) > 24:
            print(f"   ... {len(rr) - 24} more")
    elif fsw:
        print(f"   PARZUWEISUNG_FSW  {fsw['sig']}  {','.join(fsw['fields'])}")
    return secs


def corpus():
    """Does the reader understand every file, or only the one it was built on?"""
    files = sorted(glob.glob(f'{DATEN}/*.C[0-9][0-9]')
                   + glob.glob(f'{DATEN}/*/*.C[0-9][0-9]'))
    if not files:
        sys.exit(f'no .C0x files in {DATEN} '
                 '(run scripts/setup/fetch-vendor.sh)')
    n_rows = named = empty = collisions = 0
    tables = {'01': 0, '06': 0}
    fsws = set()
    with_fsw = 0
    for p in files:
        rr = rows(open(p, 'rb').read())
        if rr:
            with_fsw += 1
            tables[rr[0]['table']] += 1
        else:
            empty += 1
        n_rows += len(rr)
        named += sum(1 for r in rr if r['name'])
        fsws |= {r['fsw'] for r in rr}
        # a word of coding memory holds each bit once, so two rows claiming
        # the same bit at the same (block, word, byte) address would mean a
        # misread. Leaving byte out of the key triples the count, which is
        # how BYTEADR was confirmed to be part of the address.
        seen = {}
        for r in rr:
            key = (r['block'], r['word'], r['byte'])
            if seen.get(key, 0) & r['mask']:
                collisions += 1
            seen[key] = seen.get(key, 0) | r['mask']
    print(f'{len(files)} files, {with_fsw} with coding rows'
          + (f', {empty} without' if empty else ''))
    print(f'{n_rows} rows, {named} named ({100 * named // max(1, n_rows)}%), '
          f'{len(fsws)} distinct function keywords')
    print(f'table picked per file: SWTFSW01 x {tables["01"]}, '
          f'SWTFSW06 x {tables["06"]}')
    print(f'bit collisions within a (block, word): {collisions}')


def validate():
    """Check the decoded names against BMW's OTHER description of the same
    modules.

    14 of these modules also name their coding values in their own SGBD
    (coding_map.py); the two descriptions come from different BMW tools and
    neither derives from the other. Score a file's keywords against all 53
    SGBD coding maps and see where its own module ranks; chance is 1 in 53,
    and the null run repeats it with random keywords so file size and table
    density cannot masquerade as signal.

    TREAT THE NUMBER AS A LOWER BOUND. The vocabularies abbreviate
    differently (FEHLER vs FEHLERMELDUNG, RUECKLICHT vs SL_HINTEN), so a
    token metric misses matches that are obvious side by side -- the
    module docstring shows E46/LSZ aligning with its SGBD line for line.
    Prefix-tolerant matching below recovers some of that, not all.
    """
    import random

    def stem(s):
        s = re.sub(r'^(COD|STAT|STATUS|CODIER)_', '', s.upper())
        return set(t for t in s.split('_') if len(t) > 2)

    def covered(toks, want):
        hits = sum(1 for w in want
                   if any(t.startswith(w) or w.startswith(t) for t in toks))
        return hits / max(1, len(want))

    try:
        cm = json.load(open('data/inpa-screens/_codingmap.json'))
    except OSError:
        sys.exit('run tools/decompile/coding_map.py first')

    sgbd = {}
    for name, v in cm.items():
        toks = set()
        # named values only: an ECU whose "map" is one opaque CODIER_DATA
        # blob contributes tokens like DATA, which rank by noise
        for f in v['fields']:
            if f.get('type') != 'binary':
                toks |= stem(f['name'])
        if len(toks) >= 4:
            sgbd[name.upper()] = toks

    FAMILY = {'LSZ': {'LSZ', 'LCM'}, 'LCM': {'LSZ', 'LCM'},
              'ZKE4': {'ZKE4', 'ZKE5'}, 'ZKE5': {'ZKE4', 'ZKE5'}}

    kw_names = list(keywords().values())
    random.seed(7)
    real, null = [], []
    for p in sorted(glob.glob(f'{DATEN}/*/*.C[0-9]*')):
        mod = os.path.basename(p).split('.')[0].upper()
        if mod not in sgbd:
            continue
        rr = rows(open(p, 'rb').read())
        if len(rr) < 20:
            continue

        def rank(names, want):
            toks = set()
            for n in names:
                toks |= stem(n)
            if not toks:
                return None
            order = [m for _, m in sorted(
                ((covered(toks, s), m) for m, s in sgbd.items()),
                reverse=True)]
            fam = FAMILY.get(want, {want})
            got = [order.index(f) for f in fam if f in order]
            return min(got) + 1 if got else None

        r = rank([x['name'] for x in rr if x['name']], mod)
        if r:
            real.append((r, os.path.relpath(p, DATEN)))
        n = rank(random.sample(kw_names, min(len(rr), len(kw_names))), mod)
        if n:
            null.append(n)

    if not real:
        print('nothing to check')
        return 0
    top1 = sum(1 for r, _ in real if r == 1)
    top3 = sum(1 for r, _ in real if r <= 3)
    print(f'{len(real)} DATEN files have an SGBD coding map to check against')
    print(f'  own module ranked #1    {top1:3d}  ({100 * top1 // len(real)}%)')
    print(f'  own module in the top 3 {top3:3d}  ({100 * top3 // len(real)}%)')
    print(f'  chance, 1 of {len(sgbd)}          ~{100 // len(sgbd)}%')
    if null:
        n1 = sum(1 for r in null if r == 1)
        print(f'  NULL (random keywords)  {n1:3d}  ({100 * n1 // len(null)}%)')
    worst = sorted(real, reverse=True)[:5]
    if worst and worst[0][0] > 3:
        print('\n  worst:')
        for r, f in worst:
            if r > 3:
                print(f'    rank {r:3d}  {f}')
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('file', nargs='?', help='a .C0x file (name or path)')
    ap.add_argument('--corpus', action='store_true',
                    help='read every .C0x and report what is understood')
    ap.add_argument('--validate', action='store_true',
                    help="check decoded names against the SGBDs' own coding maps")
    ap.add_argument('-v', '--verbose', action='store_true',
                    help='list every section, not just the coding one')
    args = ap.parse_args()

    if args.corpus:
        return corpus()
    if args.validate:
        return validate()
    if not args.file:
        ap.print_help()
        return 1
    p = args.file
    if not os.path.exists(p):
        # the tree is per chassis: DATEN/E46/LSZ.C26
        hit = glob.glob(f'{DATEN}/{args.file}') + glob.glob(f'{DATEN}/*/{args.file}')
        p = hit[0] if hit else ''
    if not p or not os.path.exists(p):
        sys.exit(f'not found: {args.file}')
    summarise(p, args.verbose)


if __name__ == '__main__':
    sys.exit(main())
