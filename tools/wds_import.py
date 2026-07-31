#!/usr/bin/env python3
"""Turn BMW's WDS into a wiring bundle the app can open.

    tools/wds_import.py --wds /Volumes/.../WDS\\ BMW/release/us [--chassis E46]

WDS (Wiring Diagram System) is BMW's own wiring documentation: the tool the
dealer used to trace a circuit. It ships as a frameset around a Java tree
applet, but the DATA under that is clean:

    <chassis>/tree/<chassis>_wds_us_files.xml   folders + leaves, per car
    svg/sp/SP0000014320.svgz                    a schematic (gzipped SVG)
    zinfo/<id>.htm                              a functional description

Both stores are SHARED across chassis, and a car references ~5,000 of them.
So the import is: read one car's tree, resolve what it references, and pack
those documents with the tree into one .wiring archive per car -- the same
shape as the .chassis archives the renderer already unzips (fflate), and the
same size class (3 to 18 MB).

WHY THE DIAGRAMS STAY SVG. A .svgz is literally gzip'd SVG, so the browser
draws it natively: vector at any zoom, real text, no tiles and no viewer
library. They are stored still-compressed inside the archive (they are
already small) and inflated in the renderer, which is exactly what the
chassis archives do with job code.

WHAT IS DROPPED. WDS's own HTML wrappers, its applet, and its stylesheets:
the renderer draws the tree and the document itself. Descriptions are
reduced to their <body> (titles, paragraphs, tables) since the rest is
frame plumbing.
"""

import argparse
import gzip
import io
import json
import os
import re
import sys
import zipfile

# WDS splits or merges some cars relative to the app's chassis ids, and a few
# of its folders are stubs pointing at another car ("E90 Data is taken from
# E87"). Map app id -> the WDS directories that carry its data.
CHASSIS_MAP = {
    'E38': ['e38new', 'e38old'],
    'E39': ['e39new', 'e39old'],
    'E46': ['e46'],
    'E52': ['e52'],
    'E53': ['e53'],
    'E60': ['e60e61'],
    'E63': ['e60e61'],
    'E65': ['e65e66'],
    'E70': ['e70'],
    'E83': ['e83'],
    'E85': ['e85', 'e52'],
    'E87': ['e87'],
    'E89': ['e89', 'e87'],
    'E90': ['e90', 'e87'],   # e90/tree holds only a readme naming E87
    'F01': ['f01'],
}

# leaf image= codes are WDS's own document taxonomy
DOC_KIND = {
    '11': 'schematic',
    '13': 'location',
    '15': 'connector',
    '17': 'pins',
    '19': 'specs',
    '21': 'help',
    '23': 'test',
    '25': 'description',
    '27': 'measurement',
}

LEAF_RE = re.compile(
    r'<leaf\s+name="(?P<name>[^"]*)"(?:\s+image="(?P<image>[0-9]+)")?'
    r'(?:\s+link="(?P<link>[^"]*)")?[^>]*>')
FOLDER_RE = re.compile(r'<folder\s+name="(?P<name>[^"]*)"[^>]*>')


def doc_id(link):
    """The document a leaf link points at, or None.

    Two shapes appear:
      ../svg/sp/wrapper.htm?file=SP0000014320.htm  -> SP0000014320 (schematic)
      ../zinfo/SCT0100FB1214_CAN.htm               -> that id (description)
    """
    if not link:
        return None
    m = re.search(r'file=([A-Za-z0-9_.-]+?)\.htm', link)
    if m:
        return m.group(1)
    m = re.search(r'/zinfo/([^"/]+?)\.htm', link)
    if m:
        return m.group(1)
    return None


def parse_tree(path):
    """WDS tree XML -> nested {name, kind, doc, children}.

    Hand-rolled rather than an XML parser: these files carry the odd
    unescaped & and stray entity, and a strict parse dies on documents that
    are otherwise perfectly readable.
    """
    src = open(path, encoding='utf-8', errors='replace').read()
    root = {'name': '', 'children': []}
    stack = [root]
    for tok in re.finditer(r'<folder[^>]*>|</folder>|<leaf[^>]*/?>', src):
        text = tok.group(0)
        if text.startswith('</folder'):
            if len(stack) > 1:
                stack.pop()
        elif text.startswith('<folder'):
            m = FOLDER_RE.match(text)
            node = {'name': (m.group('name') if m else '').strip(), 'children': []}
            stack[-1]['children'].append(node)
            stack.append(node)
        else:
            m = LEAF_RE.match(text)
            if not m:
                continue
            did = doc_id(m.group('link'))
            if not did:
                continue
            stack[-1]['children'].append({
                'name': (m.group('name') or '').strip(),
                'kind': DOC_KIND.get(m.group('image') or '', 'document'),
                'doc': did,
            })
    return root


def collect_docs(node, out):
    if 'doc' in node:
        out.add(node['doc'])
    for c in node.get('children', ()):
        collect_docs(c, out)


def clean_description(html):
    """Keep the document, drop the frame plumbing.

    WDS descriptions are XHTML pages with BMW's stylesheet and a script
    block; the app supplies its own chrome, so only the body matters.
    """
    m = re.search(r'<body[^>]*>(.*?)</body>', html, re.S | re.I)
    body = m.group(1) if m else html
    body = re.sub(r'<script.*?</script>', '', body, flags=re.S | re.I)
    body = re.sub(r'<link[^>]*>', '', body, flags=re.I)
    # WDS links between documents keep working: rewrite to the app's scheme
    body = re.sub(r'href="[^"]*?(?:file=)?([A-Za-z0-9_.-]+)\.htm[^"]*"',
                  r'href="#wds/\1"', body, flags=re.I)
    return body.strip()


def build(wds_root, app_chassis, wds_dirs, out_dir, quiet=False):
    trees = []
    for d in wds_dirs:
        tdir = os.path.join(wds_root, d, 'tree')
        if not os.path.isdir(tdir):
            continue
        xmls = [f for f in os.listdir(tdir) if f.endswith('_files.xml')]
        if not xmls:
            continue  # a stub dir (e90 holds only a readme)
        trees.append((d, os.path.join(tdir, xmls[0])))
    if not trees:
        return None

    # One car, possibly several WDS trees (E39 splits new/old). Keep them as
    # named top-level folders rather than merging: BMW's split is by
    # production period and the diagrams genuinely differ.
    root = {'name': app_chassis, 'children': []}
    for d, xml in trees:
        sub = parse_tree(xml)
        label = {'new': 'Later production', 'old': 'Earlier production'}.get(
            d[3:], d.upper())
        if len(trees) == 1:
            root['children'].extend(sub['children'])
        else:
            root['children'].append({'name': label, 'children': sub['children']})

    wanted = set()
    collect_docs(root, wanted)

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f'{app_chassis}.wiring')
    kinds = {}
    missing = 0
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for did in sorted(wanted):
            svgz = os.path.join(wds_root, 'svg', 'sp', f'{did}.svgz')
            zinfo = os.path.join(wds_root, 'zinfo', f'{did}.htm')
            if os.path.exists(svgz):
                # already gzip: store as-is, the renderer inflates it
                with open(svgz, 'rb') as fh:
                    z.writestr(f'svg/{did}.svgz', fh.read(), zipfile.ZIP_STORED)
                kinds['svg'] = kinds.get('svg', 0) + 1
            elif os.path.exists(zinfo):
                html = open(zinfo, encoding='utf-8', errors='replace').read()
                z.writestr(f'doc/{did}.html', clean_description(html))
                kinds['doc'] = kinds.get('doc', 0) + 1
            else:
                missing += 1
        z.writestr('tree.json', json.dumps(root, ensure_ascii=False,
                                           separators=(',', ':')))
    size = os.path.getsize(out_path) / 1048576
    if not quiet:
        print(f'{app_chassis:6} {size:6.1f} MB  '
              f'{kinds.get("svg", 0):5} diagrams  {kinds.get("doc", 0):5} documents'
              + (f'  ({missing} not in this release)' if missing else ''))
    return out_path


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--wds', required=True,
                    help='WDS release directory (the one holding svg/, zinfo/ '
                         'and the per-chassis folders)')
    ap.add_argument('--chassis', help='one app chassis id (default: all mapped)')
    ap.add_argument('--out', default='app/renderer/data/wiring',
                    help='output directory for .wiring archives')
    args = ap.parse_args()

    if not os.path.isdir(os.path.join(args.wds, 'svg', 'sp')):
        sys.exit(f'not a WDS release directory (no svg/sp/): {args.wds}')

    todo = ([args.chassis.upper()] if args.chassis
            else sorted(CHASSIS_MAP))
    built = 0
    for ch in todo:
        dirs = CHASSIS_MAP.get(ch)
        if not dirs:
            print(f'{ch}: no WDS data (not in this release)')
            continue
        if build(args.wds, ch, dirs, args.out):
            built += 1
    print(f'\n{built} chassis written to {args.out}/')


if __name__ == '__main__':
    main()
