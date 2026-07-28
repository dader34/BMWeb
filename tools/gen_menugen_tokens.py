#!/usr/bin/env python3
"""Merge tools/translations/*_tokens.tsv into app/renderer/menugen-tokens.js.

The renderer builds ECU menus itself (menugen.js); this bakes the TSV token
extensions into a module it can load. Run after editing any *_tokens.tsv.
"""
import glob
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'app', 'renderer', 'menugen-tokens.js')


def main():
    toks = {}
    for f in sorted(glob.glob(os.path.join(ROOT, 'tools', 'translations', '*_tokens.tsv'))):
        for line in open(f, encoding='utf-8'):
            if '\t' not in line:
                continue
            k, v = line.split('\t', 1)
            k, v = k.strip().upper(), v.strip()
            if k and v:
                toks[k] = v
    with open(OUT, 'w', encoding='utf-8') as out:
        out.write('// GENERATED from tools/translations/*_tokens.tsv -- do not edit by hand.\n')
        out.write('// Regenerate: python3 tools/gen_menugen_tokens.py\n')
        out.write('// German job-name token -> English, merged over the base table in menugen.js.\n')
        out.write('const MENUGEN_TSV_TOKENS = ')
        json.dump(dict(sorted(toks.items())), out, ensure_ascii=False, indent=0)
        out.write(';\n')
    print(f'wrote {len(toks)} tokens -> {OUT}')


if __name__ == '__main__':
    main()
