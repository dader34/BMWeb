#!/usr/bin/env python3
"""Write tools/verify/fixtures/etk-rules-E46.json: two E46 diagrams as the
bundle and the rules sidecar carry them, plus what the catalogue shows for
several cars according to tools/etk_rules.py (the Python oracle). The JS
evaluator (screens/etk/rules.js) is tested against it.

    python3 tools/verify/make_etk_rules_fixture.py [--db etk.sqlite] [--etk data/etk]

Needs the dump and a built E46.etk + E46.rules.json.gz (tools/etk_import.py
--chassis E46 --rules)."""
import argparse
import gzip
import json
import os
import sqlite3
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import etk_rules  # noqa: E402

BTNRS = ['51_3267', '34_0760']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=os.path.expanduser('~/Development/code/BMWFILES/etk/etk.sqlite'))
    ap.add_argument('--etk', default=os.path.join(HERE, '..', '..', 'data', 'etk'))
    args = ap.parse_args()
    con = sqlite3.connect('file:%s?mode=ro' % args.db, uri=True)
    tree = json.loads(zipfile.ZipFile(os.path.join(args.etk, 'E46.etk')).read('tree.json'))
    side = json.load(gzip.open(os.path.join(args.etk, 'E46.rules.json.gz')))
    # the bundle's variant index of a (mospid, type key): w_fztyp order, as build() reads it
    vidx = {}
    for i, (mospid, key) in enumerate(con.execute(
            "SELECT fztyp_mospid, fztyp_typschl FROM w_fztyp WHERE fztyp_baureihe='E46'")):
        vidx[(mospid, key)] = i
        assert tree['variants'][i]['key'] == key
    diagrams = {}
    for mg in tree['maingroups']:
        for g in mg['groups']:
            for d in g['diagrams']:
                if d['btnr'] in BTNRS:
                    diagrams[d['btnr']] = {'parts': d['parts'], 'rules': side['dg'][d['btnr']]}
    used = set()
    for d in diagrams.values():
        for r in d['rules'].get('rules', []):
            for og in r['og']:
                for _, eid in og[3]:
                    used.add(str(eid))
    el = {k: v for k, v in side['el'].items() if k in used}

    def car(mosp, key, prod, steer, gear=None, vin=None, typ=None, werk=None, sa=(), answers=None):
        c = etk_rules.Car()
        c.mosp, c.prod, c.steer, c.gear = mosp, prod, steer, gear
        c.vin, c.by_vin, c.typ, c.werk = vin, bool(vin), typ, werk
        c.sa = list(sa)
        c.answers = dict(answers or {})
        js = {'variant': vidx[(mosp, key)], 'prod': int(prod[:6]), 'steer': steer, 'auto': gear,
              'byVin': bool(vin), 'vin': vin, 'typ': typ, 'werk': werk, 'sa': list(sa),
              'answers': {str(k): v for k, v in (answers or {}).items()}}
        return c, js

    et37 = dict(mosp=47720, key='ET37', prod='20040900', steer='L', vin='NJ87379', typ='ET37', werk='92')
    cases = [
        ('51_3267', 'ET37 by VIN, headlight washers unknown', car(**et37)),
        ('51_3267', 'ET37 by VIN, with headlight washers', car(**et37, answers={35172: '1'})),
        ('51_3267', 'ET37 by VIN, without headlight washers', car(**et37, answers={35172: '2'})),
        ('51_3267', 'ET37 by VIN, shadow line in the order', car(**et37, sa=['S760A'])),
        ('51_3267', 'ET37 by VIN, order has 346 (chrome line), not 760', car(**et37, sa=['$346'])),
        ('51_3267', 'ET37 picked by hand, 09/2004', car(47720, 'ET37', '20040900', 'L')),
        ('34_0760', '328Ci coupe picked by hand, 06/1999', car(47618, 'BM51', '19990600', 'L')),
        ('34_0760', '328Ci coupe picked by hand, 10/1999, right-hand drive', car(47618, 'BM51', '19991000', 'R')),
    ]
    out_cases = []
    for btnr, name, (c, js) in cases:
        res = etk_rules.run(con, btnr, c)
        expect = sorted('%s|%s' % (ln.bildnr, ln.sachnr) for ln in res['lines'])
        out_cases.append({'btnr': btnr, 'name': name, 'car': js, 'expect': expect,
                          'rules': {b.kuerzel: ('decided' if all(v for k, v in (res['relevant'] or {}).items()
                                                                  if k.rstrip('0123456789') == b.kuerzel)
                                                 else 'open') if any(k.rstrip('0123456789') == b.kuerzel
                                                                      for k in (res['relevant'] or {}))
                                    else 'false' for b in res['rules']}})
    path = os.path.join(HERE, 'fixtures', 'etk-rules-E46.json')
    with open(path, 'w') as f:
        json.dump({'diagrams': diagrams, 'el': el, 'cases': out_cases}, f, separators=(',', ':'), sort_keys=True)
    print('wrote %s: %d diagrams, %d elements, %d cases (%d bytes)' % (
        path, len(diagrams), len(el), len(out_cases), os.path.getsize(path)))
    for c in out_cases:
        print('  %-55s %3d rows  %s' % (c['name'], len(c['expect']), c['rules']))


if __name__ == '__main__':
    main()
