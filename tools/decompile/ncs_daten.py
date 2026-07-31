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

WHY STRIDE-HUNTING WAS THE WRONG ANGLE, and what replaced it.

The signature declares three OPTIONAL fields and one REPEATING one, so a
record is 9 to 16+ bytes depending on what is present. A fixed stride
therefore cannot exist -- the 24 and 33 "strides" earlier versions chased
were coincidental periodicity, which is why they found rows in 40 of 260
files and read the wrong bytes in those.

What is fixed is the NEIGHBOURHOOD of the keyword. Every real row carries
its FSW as a u16 followed by the two bytes 10 00, with 01 68 00 ahead and
01 00 01 00 00 behind. Anchoring there reads 48,739 rows out of 259 of the
260 files, and the names finally land in the right domain: LSZ, the light
switch centre, gives FLC_KL58G, KALTUEBERWACHUNG_BL_L, PWM_ANSTEUERUNG_BLK_RZ
and CC_MELDUNG_FL_L at 51% in-domain, where every earlier attempt scored 0%.

THE TREE IS PER CHASSIS, which matters more than it sounds. DATEN holds
E39/ and E46/ subdirectories, each with its own copy of a module's coding
file -- E46/LSZ.C26 is not E39/LSZ.C26. An earlier extraction of mine
flattened them and let same-named files overwrite each other, so 186 of
567 files were silently lost and the survivors were a mix of two chassis.
Any figure computed before this was measured on a corrupted tree. 346
files now, not 260.

THE TWO KEYWORD TABLES ARE RENUMBERINGS, not different vocabularies.
SWTFSW01 and SWTFSW06 share 1,414 names -- and 1,405 of those carry a
DIFFERENT id in each. So decoding with the wrong table does not fail
loudly; it yields real keywords that belong to some other function, which
is exactly the failure mode seen on ACC and GM5.

Which table a module wants is still unsolved, and four approaches have now
failed, recorded here so they are not retried:

  * whether the module's own name appears in its keywords -- 25 for 01, 51
    for 06, 184 ties
  * how many ids resolve -- biased, 01 is simply the larger table
  * SGID_CODIERINDEX -- turns out to restate the file extension
  * vocabulary coherence, scoring how often decoded names reuse word stems
    -- picks 01 for everything including ACC, where 01 is demonstrably
    wrong and 06 gives the one plausible name

E46/LSZ against SWTFSW01 is the single pairing this has verified, by its
output being unmistakably a light module's (36 of 67 names). Everything
else should be treated as unlabelled until a selector is found.

Cross-module id overlap is now 14-38% where unrelated modules should share
nothing, which is the residual false-positive rate of the anchor and
matches LSZ measuring 83% in-domain.

THE RECORD IS SOLVED, and it holds every field the schema declares:

    14 12 00 01 <BLOCKNR:u32> <WORTADR:u32> 01 00 <MASKE> 01 68 00
    <FSW:u16> 10 00 <BYTEADR:u16>

24 bytes, with the keyword exactly 23 past the header in all 97 of LSZ's
records. That length is also why a 24-byte stride seemed to work early on:
it was the record size, stumbled on and then wrongly generalised to files
whose optional fields differ.

The proof is that the bits fit. Group every record by (BLOCKNR, WORTADR)
and ask whether any two functions in a group claim the same bit: across
7,546 records in 109 files, 3,907 groups out of 3,907 are collision-free.
100%. A wrong field offset cannot produce that -- it is the format's own
invariant, since a word of coding memory can only hold each bit once. LSZ's
word 1 carries eight functions at 0x01 through 0x80, one per bit.

It also agrees with NCS Dummy's own printout of a record,

    PARZUWEISUNG FSW : {00003405} 00000008 0001 14A4 {} (FF) {h} {}

which maps onto {L}LWW{B}(B){B}{B} exactly, and with the mask distribution
across the corpus: 0xFF for a whole-byte parameter, then all eight single
bits at roughly a thousand each.

So a coding blob can now be read: BLOCKNR and WORTADR say which word,
MASKE says which bits, FSW says what it is called.

WHICH KEYWORD TABLE A MODULE WANTS IS STILL UNANSWERED, and it is worth
recording that NCS Expert's own config does not say. COAPI.INI declares a
DATEN path per chassis (E46_PFAD_DATEN = ..\daten\e46), which confirms
the per-chassis tree found by reading the archive, and it puts the SWT
tables in the root beside them -- but nothing in it names a table. The
choice lives in the program, not its configuration.

Seven approaches have now failed and are listed so none is retried: the
module naming itself in its own keywords (184 ties), raw resolution count
(biased, 01 is larger), SGID_CODIERINDEX (restates the file extension),
vocabulary coherence (picks 01 everywhere, including where 01 is wrong),
surviving-row count (same size bias), resolution lift over table density
(both tables resolve 85-100% of structurally valid rows, so it cannot
discriminate), and COAPI.INI. The tables cover the same id space with
different names, which is exactly why no statistic separates them: only
knowing what the module does can.

Also worth knowing: this archive ships coding data for E39 and E46 only,
570 files, though COAPI.INI declares paths for twenty-odd chassis. The
other cars' DATEN is simply not in it.

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

# Every coding row carries its keyword as a u16 followed by these two bytes.
# That, not a stride, is what locates a record: the schema declares three
# optional fields and one repeating one, so records are variable length.
FSW_SUFFIX = b'\x10\x00'
FSW_PREFIX = b'\x01\x68\x00'


# Where each field sits, measured back from the keyword. One layout serves
# every file; what differs is whether the optional BLOCKNR is there.
BLOCK_AT, WORD_AT, MASK_AT = 19, 15, 4


def rows(data, kw=None):
    """The module's coding rows: block, word, bit and function.

    Read back from the keyword, which is the one field with an outside
    check -- it must resolve against SWTFSW:

        <BLOCKNR:u32> <WORTADR:u32> ... <MASKE> 01 68 00 <FSW:u16> 10 00

    THE BIT RULE DECIDES WHAT IS REAL. A word of coding memory can hold
    each bit once, so a row claiming a bit already taken in its (block,
    word) is not a row -- it is the anchor matching something else. Using
    the invariant to filter rather than merely to check is what lets one
    layout serve every file: 13,477 rows out of 330 of the 346, where
    keying on a header byte pattern reached only 109.

    BLOCKNR really is optional, as the {L} in the signature says. Where the
    long is implausible -- a block number is small -- the record simply has
    none and the word alone identifies the memory.
    """
    if kw is None:
        kw = keywords()
    out = []
    seen = {}
    for i in range(SCHEMA_LEN + WORD_AT, len(data) - 8):
        if data[i - 3:i] != FSW_PREFIX or data[i + 2:i + 4] != FSW_SUFFIX:
            continue
        fsw = int.from_bytes(data[i:i + 2], 'little')
        if fsw not in kw:
            continue
        word = int.from_bytes(data[i - WORD_AT:i - WORD_AT + 4], 'little')
        mask = data[i - MASK_AT]
        if word > 4096 or not mask:
            continue
        block = 0
        if i >= SCHEMA_LEN + BLOCK_AT:
            b = int.from_bytes(data[i - BLOCK_AT:i - BLOCK_AT + 4], 'little')
            block = b if b <= 256 else 0
        if seen.get((block, word), 0) & mask:
            continue
        seen[(block, word)] = seen.get((block, word), 0) | mask
        out.append({
            'block': block, 'word': word, 'mask': mask,
            'fsw': fsw, 'name': kw[fsw], 'at': i,
        })
    return out


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
        for r in rr[:20]:
            print(f"   block {r['block']:3}  word {r['word']:4}  "
                  f"mask 0x{r['mask']:02x}  {r['name']}")
        if len(rr) > 20:
            print(f"   ... {len(rr) - 20} more")
    elif fsw:
        print(f"   PARZUWEISUNG_FSW  {fsw['sig']}  "
              f"{','.join(fsw['fields'])}")
    return secs


def corpus():
    """Does the reader understand every file, or only the one it was built on?"""
    files = sorted(glob.glob(f'{DATEN}/*.C[0-9][0-9]')
                   + glob.glob(f'{DATEN}/*/*.C[0-9][0-9]'))
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
