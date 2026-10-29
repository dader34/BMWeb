#!/usr/bin/env python3
"""Every chassis's NCS coding files, keyed the way NCS Expert keys them.

    tools/decompile/daten_files.py      -> app/renderer/data/daten/<CHASSIS>.json

NCS never matches names. It goes module list (SGFAM) -> coding SGBD ->
coding index -> selection table (SGET: slot + CBD -> SGNAME, SGBD, CABD) ->
the coding file SGNAME.Cxx. So the files travel under their own names
(IHK_E46, GM5, PDC, ...), every one of them, one file per chassis that the
Coding app loads when it codes that chassis. datenmap.js (keyed by
diagnostic SGBD, for the older coding screens) is unchanged.

Each module entry has the shape a datenmap.js entry has, scoped to the one
chassis -- {daten, chassis: {CH: variants}, layout: {CH: layout}, blocks} --
so the same decoding code reads both. The English labels for the keywords
the chassis uses ride along as `i18n`.

Read-only: reads files on disk, never talks to a car.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ncs_daten as N                                    # noqa: E402
from daten_map import CHASSIS, load_translations, read_module  # noqa: E402

OUT = 'app/renderer/data/daten'


def main():
    """CLI entry: one JSON per chassis. Run from the repository root."""
    trans = load_translations()
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for ch in CHASSIS:
        d = f'{N.DATEN}/{ch}'
        if not os.path.isdir(d):
            continue
        by_mod = {}
        for fn in sorted(os.listdir(d)):
            if '.C' not in fn.upper():
                continue
            by_mod.setdefault(fn.split('.')[0].upper(), []).append(f'{d}/{fn}')
        mods = {}
        words = set()
        for mod, paths in sorted(by_mod.items()):
            variants, blocks, lay = read_module(paths)
            if not variants:
                continue
            entry = {'daten': mod, 'chassis': {ch: variants},
                     'layout': {ch: lay}}
            if blocks:
                entry['blocks'] = {str(k): v for k, v in blocks.items()}
                words.update(str(b).lower() for b in blocks.values())
            for fields in variants.values():
                for r in fields:
                    words.add(r['name'].lower())
                    words.update(str(n).lower() for n, _ in r['values'])
            mods[mod] = entry
        out = {'chassis': ch, 'modules': mods,
               'i18n': {k: trans[k] for k in sorted(words) if k in trans}}
        path = f'{OUT}/{ch}.json'
        with open(path, 'w') as fh:
            json.dump(out, fh, separators=(',', ':'), sort_keys=True,
                      ensure_ascii=False)
        total += len(mods)
        print(f'{ch}: {len(mods)} coding modules, '
              f'{os.path.getsize(path) // 1024} KB')
    print(f'{total} coding modules across {len(CHASSIS)} chassis -> {OUT}/')


if __name__ == '__main__':
    main()
