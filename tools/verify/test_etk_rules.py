#!/usr/bin/env python3
"""The ETK line filter port (tools/etk_rules.py) against the catalogue's
known answers for the one car with ground truth: E46 ET37, built 09/2004
(VIN ...NJ87379), diagram 51_3267 callout 03 -- see docs/etk-filter-rules.md.

Needs the dump: ~/Development/code/BMWFILES/etk/etk.sqlite (zstd -d the .zst
next to it). Skips when it is not there, so check.sh passes on a machine
without the 7 GB file."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
DB = os.environ.get('ETK_SQLITE') or os.path.expanduser('~/Development/code/BMWFILES/etk/etk.sqlite')

if not os.path.exists(DB):
    print('SKIP test_etk_rules: no %s' % DB)
    sys.exit(0)

import sqlite3                      # noqa: E402
import etk_rules                    # noqa: E402


class Args:
    vin = 'NJ87379'
    mosp = prod = steer = gear = typ = werk = sa = None
    text = None


def rows(con, btnr, pos, text=None, sa=None):
    car = etk_rules.Car()
    a = Args()
    a.text = text
    a.sa = sa
    etk_rules.identify(con, car, a)
    res = etk_rules.run(con, btnr, car)
    return sorted(ln.sachnr for ln in res['lines'] if ln.bildnr == pos), car


def main():
    con = sqlite3.connect('file:%s?mode=ro' % DB, uri=True)
    fails = 0

    def check(name, got, want):
        nonlocal fails
        ok = got == want
        fails += 0 if ok else 1
        print('%s %s: %s' % ('ok  ' if ok else 'FAIL', name, ' '.join(got)))
        if not ok:
            print('     want: %s' % ' '.join(want))

    got, car = rows(con, '51_3267', '03')
    check('car identified by VIN', [str(car.mosp), car.typ, car.prod, car.steer or '-'],
          ['47720', 'ET37', '20040900', 'L'])
    # the pre-09/2001 rows go by date; both the rule-D rows and the untagged
    # fallback stay while the headlight-washer question is open
    check('callout 03, headlight washers unknown', got,
          sorted(['0030404', '0030405', '0030406', '0030407',
                  '7043407', '7043408', '7043409', '7043410']))
    got, _ = rows(con, '51_3267', '03', text=['35172=1'])
    check('callout 03, with headlight washers', got,
          sorted(['0030404', '0030405', '7043407', '7043408']))
    got, _ = rows(con, '51_3267', '03', text=['35172=2'])
    check('callout 03, without headlight washers', got,
          sorted(['0030406', '0030407', '7043409', '7043410']))
    # the evaluator's building blocks
    check('three-valued and/or', [etk_rules.und('T', '?'), etk_rules.und('F', '?'),
                                  etk_rules.oder('T', '?'), etk_rules.oder('F', '?')],
          ['?', 'F', 'T', '?'])
    check('boolean rule', [str(etk_rules.eval_bool('!(A)&&(B||C)&&! D', dict(A=False, B=True, D=False)))],
          ['True'])
    check('month shift', [etk_rules.modify_date('2004', '01', -2), etk_rules.modify_date('2004', '11', 2)],
          ['20031100', '20050100'])
    print('%s (%d failures)' % ('ALL PASS' if not fails else 'FAILED', fails))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
