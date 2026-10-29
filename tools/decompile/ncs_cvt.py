#!/usr/bin/env python3
"""BMW's <BR>CVT.000 -- which value every coding function takes for THIS car.

The coding files (.C0x) say where a function lives in a module and what its
values look like; they do not say which value a car should have. The CVT
does: for each function (FSW) it names the value (PSW) a car gets, under an
AUFTRAGSAUSDRUCK over the car's equipment. NCS Expert codes a module "from
the vehicle order" with it, and Process car codes every module that way.

    python3 tools/decompile/ncs_cvt.py                 # summarise the corpus
    python3 tools/decompile/ncs_cvt.py --write         # -> data/ncs-cvt.json
    python3 tools/decompile/ncs_cvt.py --check         # invariants, exit 1 on fail

CONTAINER. Framed like every DATEN file (ncs_daten.records()), the rows in
file order under the file's own schema:

    GRUPPE            {S}    a group of functions decided together (HandyTyp)
    INDIVID           {S}    a group the driver personalises (Key Memory)
    AUFTRAGSAUSDRUCK  A      a predicate; the rows below it apply when it holds
    FSW_PSW           WW     FSWINDEX, PSWINDEX: function = value
    FSW               W      FSWINDEX: a function the INDIVID group covers

The indexes are the chassis's own keyword tables (SWTFSW/SWTPSW/SWTASW06 on
the E46) -- the same numbering the coding files and SGET use. Functions and
values are written out by NAME (the coding files' FSW and PSW keywords, which
is how a module's read is keyed); the predicates keep their ids, which
CodingSelect.aswIds speaks. Verified on
E46CVT.000: group HandyTyp gives HANDY_TYP = nokia_3110 under NOKIA and
typ_wird_ermittelt under SIEMENS_GSM; group feste_Daten_E46 gives 1262
functions their value under S1 (the chassis keyword E46: always).

THE GROUPS ARE IN FILE ORDER and the INDIVID groups follow every GRUPPE.
Which value wins when two rules both hold and name the same function is the
evaluator's question (core/coding/cvt.js), not the decoder's: this keeps the
rows exactly as the file orders them.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # tools/
from _cli import parse_args                                     # noqa: E402
import ncs_daten as N                                           # noqa: E402
from ncs_sget import expr_text, refs_of                         # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATEN = os.path.join(ROOT, 'vendor', 'EC-APPS', 'NCSEXPER', 'DATEN')
OUT = os.path.join(ROOT, 'data', 'ncs-cvt.json')
OUT_JS = os.path.join(ROOT, 'app', 'renderer', 'data', 'cvt.js')


def _names(payload):
    """A {S} row: a count, then that many NUL-terminated names."""
    if not payload:
        return []
    n = payload[0]
    parts = payload[1:].split(b'\0')
    return [p.decode('latin1') for p in parts[:n]]


def _u16(b, at):
    return b[at] | (b[at + 1] << 8)


def _keywords(path, kind):
    """The chassis's own SWT<kind> table beside the CVT: id -> name."""
    d = os.path.dirname(path)
    for n in sorted(os.listdir(d)):
        if re.fullmatch(rf'SWT{kind}\d+\.dat', n, re.I):
            return N._load_swt(os.path.join(d, n))
    return {}


def parse_file(path):
    """One CVT file -> {'chassis', 'groups': [...], 'failed': n, 'unnamed': n}.

    Each group: {'name', 'kind': 'GRUPPE'|'INDIVID', 'rules': [{'expr',
    'exprHex', 'refs', 'set': [[FSW, PSW], ...], 'fsw': [FSW, ...]}]}, the
    functions and values by name ('#<id>' for an id the table lacks).
    """
    fsw_names = _keywords(path, 'FSW')
    psw_names = _keywords(path, 'PSW')
    unnamed = 0

    def name(table, i):
        nonlocal unnamed
        if i in table:
            return table[i]
        unnamed += 1
        return f'#{i}'

    data = open(path, 'rb').read()
    secs = N.schema(data)
    seq = {name: secs[name]['seq'] for name in
           ('GRUPPE', 'INDIVID', 'AUFTRAGSAUSDRUCK', 'FSW_PSW', 'FSW')
           if name in secs}
    groups, failed = [], 0
    group = rule = None
    for s, payload, _at in N.records(data):
        payload = bytes(payload)
        if s in (seq.get('GRUPPE'), seq.get('INDIVID')) and payload:
            names = _names(payload)
            if not names:
                continue
            kind = 'GRUPPE' if s == seq.get('GRUPPE') else 'INDIVID'
            group = {'name': names[0], 'kind': kind, 'rules': []}
            groups.append(group)
            rule = None
        elif s == seq.get('AUFTRAGSAUSDRUCK') and group is not None:
            ln = payload[0] if payload else 0
            blob = payload[1:1 + ln]
            try:
                text = expr_text(blob)
            except ValueError:
                failed += 1
                rule = None
                continue
            rule = {'expr': text, 'exprHex': blob.hex().upper(),
                    'refs': refs_of(blob), 'set': [], 'fsw': []}
            group['rules'].append(rule)
        elif s == seq.get('FSW_PSW') and rule is not None and len(payload) >= 4:
            rule['set'].append([name(fsw_names, _u16(payload, 0)),
                                name(psw_names, _u16(payload, 2))])
        elif s == seq.get('FSW') and rule is not None and len(payload) >= 2:
            rule['fsw'].append(name(fsw_names, _u16(payload, 0)))

    base = os.path.basename(path).upper()
    m = re.match(r'([A-Z0-9]+)CVT', base)
    return {'chassis': m.group(1) if m else base, 'groups': groups,
            'failed': failed, 'unnamed': unnamed}


def corpus():
    """Every CVT file under DATEN (`<CHASSIS>CVT.<nnn>`), sorted."""
    out = []
    for dirpath, _, names in os.walk(DATEN):
        for n in names:
            if re.match(r'^[A-Z0-9]+CVT\.\d+$', n.upper()):
                out.append(os.path.join(dirpath, n))
    return sorted(set(out))


def main():
    """CLI entry: summarise the corpus, ``--check`` its invariants (exit 1 on
    failure), or ``--write`` the JSON and JS outputs."""
    ns = parse_args(__doc__,
                    flags={'--write': 'write data/ncs-cvt.json and the renderer JS',
                           '--check': 'verify the invariants; exit 1 on failure'})
    files = corpus()
    if not files:
        sys.exit(f'no CVT files under {DATEN} (run scripts/setup/fetch.sh)')

    seen = {}
    for f in files:
        r = parse_file(f)
        ch = r['chassis']
        if ch in seen and len(seen[ch]['groups']) >= len(r['groups']):
            continue                        # same chassis shipped twice: keep richer
        seen[ch] = r

    tot_groups = tot_rules = tot_set = tot_fail = tot_unnamed = 0
    for ch, r in sorted(seen.items()):
        rules = sum(len(g['rules']) for g in r['groups'])
        sets = sum(len(x['set']) for g in r['groups'] for x in g['rules'])
        indiv = sum(1 for g in r['groups'] if g['kind'] == 'INDIVID')
        tot_groups += len(r['groups'])
        tot_rules += rules
        tot_set += sets
        tot_fail += r['failed']
        tot_unnamed += r['unnamed']
        if not ns.check:
            print(f"  {ch:6s} {len(r['groups']):4d} groups ({indiv} individual)  "
                  f"{rules:5d} rules  {sets:6d} values"
                  + (f"  ({r['failed']} unparsed)" if r['failed'] else '')
                  + (f"  ({r['unnamed']} ids not in the keyword tables)"
                     if r['unnamed'] else ''))
    print(f"{len(seen)} chassis, {tot_groups} groups, {tot_rules} rules, "
          f"{tot_set} values, {tot_fail} unparsed, {tot_unnamed} unnamed")

    if ns.check:
        bad = 0
        if tot_set == 0:
            print('FAIL: no values parsed'); bad += 1
        if tot_fail > tot_rules * 0.01:
            print(f'FAIL: {tot_fail}/{tot_rules} rules unparsed (>1%)'); bad += 1
        # BMW's keyword tables have holes the CVT still names (E46: value 32,
        # which feste_Daten gives ANZAHL_NACHWISCHZYKLEN, is in no SWTPSW): a
        # few per cent is the data; a misread would leave most unnamed
        if tot_unnamed > tot_set * 0.08:
            print(f'FAIL: {tot_unnamed} ids not in the keyword tables (>8%)'); bad += 1
        # the E46 anchor: HandyTyp names HANDY_TYP = nokia_3110 when the car
        # has NOKIA (S2) and not SIEMENS_GSM (S3)
        e46 = seen.get('E46')
        if e46:
            handy = next((g for g in e46['groups'] if g['name'] == 'HandyTyp'), None)
            if not handy or [handy['rules'][0]['expr'], handy['rules'][0]['set']] \
                    != ['S2,!S3', [['HANDY_TYP', 'nokia_3110']]]:
                print('FAIL: E46 HandyTyp is not HANDY_TYP = nokia_3110 under S2,!S3')
                bad += 1
        for ch, r in seen.items():
            for g in r['groups']:
                for x in g['rules']:
                    if x['expr'] and not re.fullmatch(r'[S0-9+,!()]+', x['expr']):
                        print(f"FAIL: {ch} {g['name']} bad expr {x['expr']!r}")
                        bad += 1
                        break
        if bad:
            sys.exit(1)
        print('CVT invariants OK')

    if ns.write:
        payload = {ch: {'groups': r['groups']} for ch, r in sorted(seen.items())}
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, 'w') as fh:
            json.dump(payload, fh, separators=(',', ':'), sort_keys=True)
        print(f'wrote {OUT} ({os.path.getsize(OUT)} bytes)')
        os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
        with open(OUT_JS, 'w') as fh:
            fh.write('// BMW CVT: the value each coding function takes, under '
                     'the AUFTRAGSAUSDRUCK deciding it.\n')
            fh.write('// Generated by tools/decompile/ncs_cvt.py '
                     '-- do not edit by hand.\n')
            fh.write('window.BMW_CVT=')
            json.dump(payload, fh, separators=(',', ':'), sort_keys=True)
            fh.write(';\n')
        print(f'wrote {OUT_JS} ({os.path.getsize(OUT_JS)} bytes)')


if __name__ == '__main__':
    main()
