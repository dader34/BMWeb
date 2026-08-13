#!/usr/bin/env python3
"""Turn BMW's ETK parts catalogue into per-chassis bundles the app can open.

    tools/etk_import.py --db etk.sqlite [--chassis E46] --out data/etk

ETK is BMW's Electronic Parts Catalogue. Its data is a TransBase database
(dumped to etk.sqlite -- see the etk-database-extracted memory for how). The
raw schema is 129 German-named tables; this reshapes the parts/diagrams/names
for ONE chassis into a single .etk archive, the same shape as the .wiring
archives the renderer already unzips (fflate): a tree.json plus the exploded-
view images, packed per car.

THE JOIN PATH (proven against the real data):
    w_fztyp[baureihe=E46]        -> mospids (the 146 vehicle variants of an E46)
    w_btzeilen_verbauung[mospid] -> (btnr, pos, sachnr)   which parts fit
    w_bildtaf[btnr]              -> the diagram page (+ hg/fg group, grafikid)
    w_hgfg[hg,fg]                -> assembly-group name (Engine, Cooling, ...)
    w_grafik[grafikid]           -> the exploded-view image blob (JPG/PNG/TIF)
    w_teil[sachnr] / w_ben_gk    -> part number + English name
    w_btzeilen[btnr,pos]         -> the callout number on the diagram

All display text is a `textcode` resolved through w_ben_gk filtered to English
(ben_iso='en'). TIFs are converted to PNG so the browser can draw them.

WHAT IS DROPPED. The 100+ condition/marketing/admin tables (w_bed_*, w_sft_*,
w_tc_*, REACH, prices): a parts *viewer* needs the tree, the diagrams, the
part numbers and names, and the fitment. The rest is generator plumbing.
"""

import argparse
import io
import json
import os
import sqlite3
import sys
import zipfile

# The app's chassis ids ARE ETK's baureihe codes (E46, E60, F10, ...), so no
# mapping table is needed -- a happy accident that makes this line up with the
# vehicle grid the renderer already shows.

try:
    from PIL import Image
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False


def resolve_names(con, iso='en'):
    """textcode -> display text, in one dict. w_ben_gk is the text store; every
    name in the catalogue is a code resolved here. English by default."""
    names = {}
    for code, text in con.execute(
            "SELECT ben_textcode, ben_text FROM w_ben_gk WHERE ben_iso=?", (iso,)):
        names[code] = text
    return names


def chassis_list(con):
    """Every baureihe that looks like an app chassis (E/F/G/K/R + digits)."""
    ids = []
    for (b,) in con.execute("SELECT DISTINCT baureihe_baureihe FROM w_baureihe"):
        if b and b[0] in 'EFGKIRU' and any(c.isdigit() for c in b):
            ids.append(b)
    return sorted(set(ids))


def to_png(blob, fmt):
    """Diagrams are JPG/PNG/TIF. Browsers can't draw TIF, so convert those to
    PNG; pass JPG/PNG straight through (already browser-native)."""
    fmt = (fmt or '').upper()
    if fmt in ('JPG', 'JPEG', 'PNG'):
        return blob, ('jpg' if fmt.startswith('JP') else 'png')
    if fmt == 'TIF' and HAVE_PIL:
        try:
            im = Image.open(io.BytesIO(blob))
            out = io.BytesIO()
            im.save(out, format='PNG')
            return out.getvalue(), 'png'
        except Exception:
            return None, None
    return None, None


def build(con, chassis, names, out_dir, quiet=False):
    """Pack one chassis into <chassis>.etk. Returns (diagrams, parts, bytes)
    or None if the chassis has no data."""
    # 1. the vehicle variants (mospids) of this chassis
    mospids = [r[0] for r in con.execute(
        "SELECT DISTINCT fztyp_mospid FROM w_fztyp WHERE fztyp_baureihe=?", (chassis,))]
    if not mospids:
        return None
    qmarks = ','.join('?' * len(mospids))

    # 2. which diagrams (btnr) this chassis's parts appear on, via fitment
    btnrs = set()
    part_rows = {}   # btnr -> list of (pos, callout, sachnr)
    for btnr, pos, sachnr in con.execute(
            "SELECT DISTINCT btzeilenv_btnr, btzeilenv_pos, btzeilenv_sachnr "
            "FROM w_btzeilen_verbauung WHERE btzeilenv_mospid IN (%s)" % qmarks, mospids):
        btnrs.add(btnr)
        part_rows.setdefault(btnr, []).append((pos, sachnr))
    if not btnrs:
        return None

    # 3. diagram metadata: group (hg/fg) + image id, per btnr
    bt_qmarks = ','.join('?' * len(btnrs))
    btnr_list = list(btnrs)
    diagrams = {}   # btnr -> {hg, fg, grafikid, textcode}
    for btnr, hg, fg, gid, tc in con.execute(
            "SELECT bildtaf_btnr, bildtaf_hg, bildtaf_fg, bildtaf_grafikid, bildtaf_textc "
            "FROM w_bildtaf WHERE bildtaf_btnr IN (%s)" % bt_qmarks, btnr_list):
        diagrams[btnr] = {'hg': hg, 'fg': fg, 'grafikid': gid, 'textcode': tc}

    # 4. callout numbers per part-line (btnr,pos -> bildposnr)
    callouts = {}
    for btnr, pos, callout in con.execute(
            "SELECT btzeilen_btnr, btzeilen_pos, btzeilen_bildposnr "
            "FROM w_btzeilen WHERE btzeilen_btnr IN (%s)" % bt_qmarks, btnr_list):
        callouts[(btnr, pos)] = callout

    # 5. part names: sachnr -> textcode -> English
    all_sachnr = {s for rows in part_rows.values() for (_, s) in rows}
    part_name = {}
    if all_sachnr:
        sn = list(all_sachnr)
        for i in range(0, len(sn), 900):
            chunk = sn[i:i + 900]
            q = ','.join('?' * len(chunk))
            for sachnr, tc in con.execute(
                    "SELECT teil_sachnr, teil_textcode FROM w_teil "
                    "WHERE teil_sachnr IN (%s)" % q, chunk):
                part_name[sachnr] = names.get(tc, '')

    # 6. assembly-group names (hg/fg -> English), from w_hgfg
    group_name = {}
    for hg, fg, tc in con.execute("SELECT hgfg_hg, hgfg_fg, hgfg_textcode FROM w_hgfg"):
        group_name[(hg, fg)] = names.get(tc, '')

    # ---- assemble the navigation tree: HG group -> diagrams -> parts ----
    # tree = { groups: [ {hg, fg, name, diagrams: [ {btnr, name, img, parts:[...] } ] } ] }
    used_gids = {}   # grafikid -> (bytes, ext)  (only images we actually reference)
    groups = {}
    for btnr in sorted(diagrams):
        d = diagrams[btnr]
        key = (d['hg'], d['fg'])
        g = groups.setdefault(key, {
            'hg': d['hg'], 'fg': d['fg'],
            'name': group_name.get(key) or f"{d['hg']}/{d['fg']}",
            'diagrams': [],
        })
        # parts on this diagram
        parts = []
        for pos, sachnr in sorted(part_rows.get(btnr, [])):
            parts.append({
                'pos': callouts.get((btnr, pos), pos),
                'sachnr': sachnr,
                'name': part_name.get(sachnr, ''),
            })
        img_ref = None
        gid = d['grafikid']
        if gid and gid not in used_gids:
            # each diagram has two variants: 'T' (thumbnail ~10KB) and 'Z' (the
            # full zoom image ~30KB). Always take Z -- the thumbnail is a blurry
            # mess when shown at any real size. Fall back to whatever exists.
            row = con.execute(
                "SELECT grafik_format, grafik_blob FROM w_grafik "
                "WHERE grafik_grafikid=? ORDER BY (grafik_art='Z') DESC, "
                "length(grafik_blob) DESC LIMIT 1", (gid,)).fetchone()
            if row:
                data, ext = to_png(row[1], row[0])
                if data:
                    used_gids[gid] = (data, ext)
        if gid in used_gids:
            img_ref = f"{gid}.{used_gids[gid][1]}"
        g['diagrams'].append({
            'btnr': btnr,
            'name': names.get(d['textcode'], '') or btnr,
            'img': img_ref,
            'parts': parts,
        })

    tree = {
        'chassis': chassis,
        'groups': sorted(groups.values(), key=lambda g: (g['hg'], g['fg'])),
    }

    # ---- pack the .etk archive: tree.json + img/<gid>.<ext> ----
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f'{chassis}.etk')
    ndiag = sum(len(g['diagrams']) for g in tree['groups'])
    nparts = sum(len(dg['parts']) for g in tree['groups'] for dg in g['diagrams'])
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.writestr('tree.json', json.dumps(tree, ensure_ascii=False, separators=(',', ':')))
        for gid, (data, ext) in used_gids.items():
            # images are already compressed (jpg/png) -> store, don't re-deflate
            z.writestr(f'img/{gid}.{ext}', data, zipfile.ZIP_STORED)
    size = os.path.getsize(out_path)
    if not quiet:
        print(f"  {chassis}: {ndiag} diagrams, {nparts} part-lines, "
              f"{len(used_gids)} images -> {size/1e6:.1f} MB")
    return (ndiag, nparts, size)


def main():
    ap = argparse.ArgumentParser(description="Pack ETK into per-chassis .etk bundles")
    ap.add_argument('--db', required=True, help='etk.sqlite (the dumped catalogue)')
    ap.add_argument('--chassis', help='one chassis id (default: all)')
    ap.add_argument('--out', default='data/etk', help='output dir for .etk archives')
    ap.add_argument('--iso', default='en', help='language for names (default en)')
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print(f"no {args.db}", file=sys.stderr); sys.exit(1)
    if not HAVE_PIL:
        print("note: Pillow not installed -- TIF diagrams will be skipped "
              "(pip install Pillow to include them)", file=sys.stderr)

    con = sqlite3.connect(args.db)
    print("resolving names...")
    names = resolve_names(con, args.iso)
    print(f"  {len(names)} names ({args.iso})")

    targets = [args.chassis] if args.chassis else chassis_list(con)
    print(f"building {len(targets)} chassis...")
    ok = 0
    for ch in targets:
        r = build(con, ch, names, args.out, quiet=False)
        if r:
            ok += 1
    print(f"done: {ok}/{len(targets)} chassis packed into {args.out}/")


if __name__ == '__main__':
    main()
