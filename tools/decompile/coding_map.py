#!/usr/bin/env python3
"""What each ECU's coding actually MEANS, mined from the SGBDs.

    tools/decompile/coding_map.py            -> data/inpa-screens/_codingmap.json

BMW's own coding tool (NCS Expert) needs the DATEN files to make sense of a
module's coding: the module hands back a binary blob and the DATEN files say
which bit at which address is "fold mirrors on lock". We do not ship those
files and they are not ours to redistribute.

But for a good number of ECUs BMW put that meaning in the SGBD itself. LSZ's
CODIERUNG_LESEN does not return a blob -- it returns 44 NAMED results, each
with its own description:

    COD_AL_FEHLERMELDUNG_EIN   int   "0 oder 1 Fehlermeldung fuer Abblendlicht"

That is the whole map, shipped in the .prg, no DATEN needed. This finds every
ECU where that is true and writes down what can be read, what can be written,
and which reads pair with which writes.

THE PAIRING IS THE USEFUL PART. A write job's arguments and a read job's
results are the same fields under different names -- RDC reads
STAT_AREACODE and writes AREACODE, reads STAT_REIFENTYP and writes
REIFENTYP. Matching them is what turns "here are some values" into "here is
a form you can edit and send back", so it is done here rather than guessed
in the renderer.

WHAT IS DELIBERATELY LEFT OUT: writes whose argument is a bare binary buffer
or a filename. LWS5's only write takes DATEI -- a .COD file path -- and a
handful of others take an opaque CODEBLOCK. Those cannot be assembled from
named values, so they are recorded as unsupported rather than offered as an
editor that would send something meaningless.

Read-only: reads the generated metadata, never talks to a car.
"""

import glob
import gzip
import json
import os
import re
import sys

SRC = 'data/ecu-src'
OUT = 'data/inpa-screens/_codingmap.json'
# ...and the renderer's own copy, lazily loaded like faultmeta.js. Only the
# ECUs with something to show are shipped: 21 of the 53 answer CODIERUNG_LESEN
# with a single opaque buffer, which is a blob we cannot label and so cannot
# offer an editor for.
OUT_JS = 'app/renderer/data/codingmap.js'

# The jobs that hand back a module's coding.
READ_JOBS = ('CODIERUNG_LESEN', 'CODIERDATEN_LESEN', 'COD_LESEN')

# A result that is plumbing, not a coding value.
NOISE = re.compile(r'^(JOB_STATUS|_TEL|_SG|SG_)', re.I)

# Types we can present as an editable field. A binary buffer or a filename
# cannot be built from named values, so an ECU whose only write takes one is
# readable but not codeable here.
EDITABLE = ('int', 'real', 'string')


def strip_prefix(name):
    """The bare field name, for pairing a read against a write.

    BMW prefixes reads and not writes (STAT_AREACODE vs AREACODE), and
    sometimes prefixes the coding itself (COD_AL_FEHLERMELDUNG_EIN). Reduce
    both sides to the same stem so the two can meet.
    """
    n = name.upper()
    for p in ('STAT_', 'STATUS_', 'COD_', 'CODIER_'):
        if n.startswith(p):
            n = n[len(p):]
    return n.rstrip('_')


def clean_comment(c):
    """BMW's own description, minus the part that says nothing.

    Almost every coding comment opens with "0 oder 1" or "0/1", which is the
    type, not the meaning, and reads as noise once the field is a switch.
    """
    c = (c or '').strip()
    c = re.sub(r'^\s*0\s*(oder|/|-|,)\s*1\s*[:,-]?\s*', '', c, flags=re.I)
    c = re.sub(r'^\s*\(?\s*0\s*=\s*\w+\s*,?\s*1\s*=\s*\w+\s*\)?\s*[:,-]?\s*',
               '', c, flags=re.I)
    return c.strip()


def is_switch(result, comment):
    """Does this field only ever hold 0 or 1?

    Worth knowing: a switch is a toggle in the UI, anything else is a number
    to type. BMW says so in the comment ("0 oder 1 ...") far more reliably
    than the declared type does, since everything is `int`.
    """
    if result.get('type') != 'int':
        return False
    return bool(re.match(r'^\s*0\s*(oder|/|-|,)\s*1\b', comment or '', re.I))


def mine(path):
    sgbd = os.path.basename(path).split('.')[0]
    try:
        meta = json.loads(gzip.open(path).read())
    except Exception:
        return None
    jobs = meta.get('jobs') or {}

    reads = [n for n in jobs if n.upper() in READ_JOBS]
    if not reads:
        return None

    # Values, from whichever read job names the most of them. An ECU can
    # carry several (COD_LESEN and CODIERUNG_LESEN both); the richest one is
    # the one worth showing.
    best, fields = None, []
    for r in reads:
        got = []
        for res in (jobs[r].get('results') or []):
            name = res.get('name') or ''
            if NOISE.match(name):
                continue
            comment = res.get('comment') or (res.get('comments') or [''])[0]
            got.append({
                'name': name,
                'stem': strip_prefix(name),
                'type': res.get('type'),
                'label': clean_comment(comment),
                'switch': is_switch(res, comment),
            })
        if len(got) > len(fields):
            best, fields = r, got
    if not fields:
        return None                      # a blob: nothing named to show

    # The write, if there is one we can actually assemble.
    write = None
    for n in sorted(jobs):
        u = n.upper()
        if 'SCHREIB' not in u or 'COD' not in u:
            continue
        args = jobs[n].get('arguments') or []
        if not args:
            continue
        kinds = {a.get('type') for a in args}
        supported = kinds.issubset(set(EDITABLE)) and 'binary' not in kinds
        # a lone string argument named like a file is a .COD path, not a value
        if len(args) == 1 and re.search(r'DATEI|FILE', args[0].get('name') or '', re.I):
            supported = False
        entry = {
            'job': n,
            'supported': supported,
            'args': [{
                'name': a.get('name'),
                'stem': strip_prefix(a.get('name') or ''),
                'type': a.get('type'),
                'label': clean_comment(a.get('comment')
                                       or (a.get('comments') or [''])[0]),
            } for a in args],
        }
        if not supported and write and write.get('supported'):
            continue                     # keep the better one
        write = entry
        if supported:
            break

    # Pair them: which read value feeds which write argument.
    if write:
        by_stem = {f['stem']: f['name'] for f in fields}
        for a in write['args']:
            a['from'] = by_stem.get(a['stem'])

    return sgbd, {
        'sgbd': sgbd,
        'read': best,
        'fields': fields,
        'write': write,
    }


def presentable(entry):
    """Is there anything here a person could actually read and edit?

    An ECU whose read job returns one `binary` result has handed back the
    coding blob itself -- ACC's CODIER_DATA is the whole module's coding as
    an unlabelled buffer. That is exactly the case the DATEN files exist to
    decode, and we do not decode it, so there is nothing to draw.
    """
    return [f for f in entry['fields'] if f['type'] != 'binary']


def main():
    out = {}
    for p in sorted(glob.glob(f'{SRC}/*.meta.json.gz')):
        got = mine(p)
        if got:
            out[got[0]] = got[1]

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(out, fh, separators=(',', ':'), sort_keys=True)

    # The renderer's copy: only ECUs with named values, and only those values.
    ship = {}
    for k, v in out.items():
        fields = presentable(v)
        if not fields:
            continue
        ship[k] = {'sgbd': v['sgbd'], 'read': v['read'], 'fields': fields,
                   'write': v.get('write')}
    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    with open(OUT_JS, 'w') as fh:
        fh.write('// GENERATED by tools/decompile/coding_map.py -- what each '
                 "ECU's coding MEANS,\n// mined from the SGBD's own result "
                 'names. Lazy-loaded by loadCodingMap().\n'
                 'window.BMW_CODING_MAP=')
        json.dump(ship, fh, separators=(',', ':'), sort_keys=True)
        fh.write(';\n')

    n_fields = sum(len(v['fields']) for v in out.values())
    n_write = sum(1 for v in out.values() if v.get('write'))
    n_ok = sum(1 for v in out.values()
               if (v.get('write') or {}).get('supported'))
    n_sw = sum(1 for v in out.values() for f in v['fields'] if f['switch'])
    print(f'{len(out)} ECUs describe their own coding')
    print(f'  {n_fields} named values ({n_sw} of them switches)')
    print(f'  {n_write} expose a coding write, {n_ok} of those assemblable '
          f'from named values')
    print(f'-> {OUT}')
    ship_fields = sum(len(v['fields']) for v in ship.values())
    print(f'{len(ship)} ECUs ship a readable coding page ({ship_fields} values); '
          f'{len(out) - len(ship)} return only an opaque blob')
    print(f'-> {OUT_JS}')


if __name__ == '__main__':
    sys.exit(main())
