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


def chunked_in(con, sql, ids, chunk=900):
    """Run an IN-list query in chunks of <=900 ids and yield the rows.

    SQLite caps bound parameters (999 by default), and an E-chassis easily
    references thousands of mospids/btnrs/sachnrs. `sql` carries one %s where
    the placeholder list goes."""
    ids = list(ids)
    for i in range(0, len(ids), chunk):
        part = ids[i:i + chunk]
        q = ','.join('?' * len(part))
        yield from con.execute(sql % q, part)


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
    # 1. the vehicle variants of this chassis, with their attributes. Each is a
    # mospid+type-key row in w_fztyp: model name, body, engine, steering, gearbox,
    # date. This drives the variant picker (ETK's Series->Body->Model drill-down).
    variants = []          # [{mospid, key, model, body, motor, steer, gear, date}]
    mospid_vidx = {}       # mospid -> list of variant indices (a mospid can have
                           #           several type-keys = several variants)
    for mospid, key, model, body, motor, steer, gear, date in con.execute(
            "SELECT fztyp_mospid, fztyp_typschl, fztyp_erwvbez, fztyp_karosserie, "
            "fztyp_motor, fztyp_lenkung, fztyp_getriebe, fztyp_einsatz "
            "FROM w_fztyp WHERE fztyp_baureihe=?", (chassis,)):
        vi = len(variants)
        variants.append({
            'key': key, 'model': model or '', 'body': body or '',
            'motor': motor or '', 'steer': steer or '', 'gear': gear or '',
            'date': date or '',
        })
        mospid_vidx.setdefault(mospid, []).append(vi)
    mospids = list(mospid_vidx.keys())
    if not mospids:
        return None

    # 2. which diagrams (btnr) this chassis's parts appear on, via fitment. Keep
    # the mospids per (btnr,pos,sachnr) so the viewer can filter to one variant.
    btnrs = set()
    part_rows = {}   # btnr -> { (pos, sachnr): set(variant indices) }
    for btnr, pos, sachnr, mospid in chunked_in(con,
            "SELECT btzeilenv_btnr, btzeilenv_pos, btzeilenv_sachnr, btzeilenv_mospid "
            "FROM w_btzeilen_verbauung WHERE btzeilenv_mospid IN (%s)", mospids):
        btnrs.add(btnr)
        d = part_rows.setdefault(btnr, {})
        s = d.setdefault((pos, sachnr), set())
        for vi in mospid_vidx.get(mospid, ()):
            s.add(vi)
    if not btnrs:
        return None

    # 3. diagram metadata: group (hg/fg) + image id, per btnr
    btnr_list = list(btnrs)
    diagrams = {}   # btnr -> {hg, fg, grafikid, textcode}
    for btnr, hg, fg, gid, tc in chunked_in(con,
            "SELECT bildtaf_btnr, bildtaf_hg, bildtaf_fg, bildtaf_grafikid, bildtaf_textc "
            "FROM w_bildtaf WHERE bildtaf_btnr IN (%s)", btnr_list):
        diagrams[btnr] = {'hg': hg, 'fg': fg, 'grafikid': gid, 'textcode': tc}

    # 4. callout numbers per part-line (btnr,pos -> bildposnr)
    callouts = {}
    for btnr, pos, callout in chunked_in(con,
            "SELECT btzeilen_btnr, btzeilen_pos, btzeilen_bildposnr "
            "FROM w_btzeilen WHERE btzeilen_btnr IN (%s)", btnr_list):
        callouts[(btnr, pos)] = callout

    # 5. part names: sachnr -> textcode -> English
    # The FULL 11-digit BMW part number is main-group + subgroup + the 7-digit
    # sachnr: teil_hauptgr(2) + teil_untergrup(2) + teil_sachnr(7). We keep the
    # prefix so the viewer can show "11 13 7 791 531" instead of just "7791531".
    all_sachnr = {s for rows in part_rows.values() for (_, s) in rows.keys()}
    part_name = {}
    part_prefix = {}   # sachnr -> "1113" (hauptgr+untergrup)
    if all_sachnr:
        for sachnr, tc, hg, ug in chunked_in(con,
                "SELECT teil_sachnr, teil_textcode, teil_hauptgr, teil_untergrup "
                "FROM w_teil WHERE teil_sachnr IN (%s)", all_sachnr):
            part_name[sachnr] = names.get(tc, '')
            if hg and ug:
                part_prefix[sachnr] = f"{hg}{ug}"

    # 6. group names. ETK's browse is two levels: a MAIN group (HG, "11 Engine")
    # shown as an icon grid, then function groups (FG) under it. We keep both:
    # the HG for the grid + icon, the FG for the sub-list.
    hg_name, fg_name = {}, {}
    for hg, fg, tc in con.execute("SELECT hgfg_hg, hgfg_fg, hgfg_textcode FROM w_hgfg"):
        fg_name[(hg, fg)] = names.get(tc, '')
        if fg in ('00', '', None):   # the HG-level row carries the main-group name
            hg_name[hg] = names.get(tc, '')

    def load_grafik(gid):
        """Fetch one grafikid as (bytes, ext), preferring the Z (full) variant."""
        row = con.execute(
            "SELECT grafik_format, grafik_blob FROM w_grafik WHERE grafik_grafikid=? "
            "ORDER BY (grafik_art='Z') DESC, length(grafik_blob) DESC LIMIT 1",
            (gid,)).fetchone()
        if not row:
            return None, None
        return to_png(row[1], row[0])

    # ---- assemble the tree, grouped by MAIN group (HG) for the icon grid ----
    # tree = { chassis, variants:[...], maingroups:[ {hg, name, icon,
    #            groups:[ {fg, name, diagrams:[ {btnr,name,img,parts:[{pos,sachnr,name,fit}]} ]} ] } ] }
    # part 'fit' is the sorted list of variant indices it applies to (for filtering).
    used_gids = {}   # grafikid -> (bytes, ext)  (diagram images we reference)
    failed_gids = set()  # referenced but unusable (no blob / TIF w/o PIL / bad data)
    icons = {}       # hg -> icon ref  (main-group tile thumbnails)
    maingroups = {}
    for btnr in sorted(diagrams):
        d = diagrams[btnr]
        hg = d['hg']
        mg = maingroups.setdefault(hg, {
            'hg': hg, 'name': hg_name.get(hg) or hg, 'icon': None, 'groups': {},
        })
        fgkey = d['fg']
        fg = mg['groups'].setdefault(fgkey, {
            'fg': fgkey, 'name': fg_name.get((hg, fgkey)) or f"{hg}/{fgkey}", 'diagrams': [],
        })
        parts = []
        for (pos, sachnr), fit in sorted(part_rows.get(btnr, {}).items()):
            p = {
                'pos': callouts.get((btnr, pos), pos),
                'sachnr': sachnr,
                'name': part_name.get(sachnr, ''),
                'fit': sorted(fit),
            }
            pre = part_prefix.get(sachnr)
            if pre:
                p['pre'] = pre   # 4-digit group prefix for the full 11-digit number
            parts.append(p)
        img_ref = None
        gid = d['grafikid']
        if gid:
            if gid not in used_gids and gid not in failed_gids:
                data, ext = load_grafik(gid)
                if data:
                    used_gids[gid] = (data, ext)
                else:
                    failed_gids.add(gid)   # ships with img:null; counted below
            if gid in used_gids:
                img_ref = f"{gid}.{used_gids[gid][1]}"
        fg['diagrams'].append({
            'btnr': btnr,
            'name': names.get(d['textcode'], '') or btnr,
            'img': img_ref,
            'parts': parts,
        })

    # main-group icons (the 44 BMW-car tile thumbnails), one per HG we use
    for hg in maingroups:
        row = con.execute(
            "SELECT hgthb_grafikid FROM w_hg_thumbnail "
            "WHERE hgthb_hg=? AND hgthb_produktart='P' LIMIT 1", (hg,)).fetchone()
        if row and row[0]:
            gid = 'icon_' + str(row[0])
            if gid not in used_gids:
                data, ext = load_grafik(row[0])
                if data:
                    used_gids[gid] = (data, ext)
            if gid in used_gids:
                maingroups[hg]['icon'] = f"{gid}.{used_gids[gid][1]}"

    # flatten maingroups' fg dict to a sorted list
    mg_list = []
    for hg in sorted(maingroups):
        mg = maingroups[hg]
        mg['groups'] = sorted(mg['groups'].values(), key=lambda x: x['fg'])
        mg_list.append(mg)

    tree = {
        'chassis': chassis,
        'variants': variants,
        'maingroups': mg_list,
        # keep flat groups too for backward-compat with the current viewer
        'groups': [g for mg in mg_list for g in mg['groups']],
    }

    # ---- pack the .etk archive: tree.json + img/<gid>.<ext> ----
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f'{chassis}.etk')
    ndiag = sum(len(g['diagrams']) for g in tree['groups'])
    nparts = sum(len(dg['parts']) for g in tree['groups'] for dg in g['diagrams'])
    # write to a temp name and os.replace() into place: an interrupted build
    # must not leave a truncated .etk that a later index-merge lists as valid
    tmp_path = out_path + '.tmp'
    try:
        with zipfile.ZipFile(tmp_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            z.writestr('tree.json', json.dumps(tree, ensure_ascii=False, separators=(',', ':')))
            for gid, (data, ext) in used_gids.items():
                # images are already compressed (jpg/png) -> store, don't re-deflate
                z.writestr(f'img/{gid}.{ext}', data, zipfile.ZIP_STORED)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    os.replace(tmp_path, out_path)
    size = os.path.getsize(out_path)
    if not quiet:
        print(f"  {chassis}: {ndiag} diagrams, {nparts} part-lines, "
              f"{len(used_gids)} images -> {size/1e6:.1f} MB"
              + (f"  ({len(failed_gids)} diagram images missing/unconvertible)"
                 if failed_gids else ""))
    return (ndiag, nparts, size)


def build_vin_index(con, out_dir):
    """Write vin-index.json.gz: every BMW production-number range mapped to the
    vehicle it identifies, so the viewer can decode a VIN.

    A BMW VIN's last 7 characters are the sequential production number. ETK's
    w_fgstnr stores which range each vehicle covers; joined to w_fztyp it yields
    the exact variant. Ranges are sorted by `von` for binary search; variants
    are deduped into a lookup table to keep the file small (~10 MB gzipped).
    """
    import gzip
    rows = con.execute(
        "SELECT f.fgstnr_von, f.fgstnr_bis, t.fztyp_baureihe, f.fgstnr_mospid, "
        "       f.fgstnr_prod, t.fztyp_erwvbez, t.fztyp_karosserie, "
        "       t.fztyp_motor, t.fztyp_lenkung "
        "FROM w_fgstnr f "
        "JOIN w_fztyp t ON t.fztyp_typschl=f.fgstnr_typschl "
        "              AND t.fztyp_mospid=f.fgstnr_mospid "
        "ORDER BY f.fgstnr_von").fetchall()
    variants = {}          # (chassis,mospid,model,body,motor,steer) -> index
    def vidx(r):
        key = (r[2], r[3], r[5] or '', r[6] or '', r[7] or '', r[8] or '')
        if key not in variants:
            variants[key] = len(variants)
        return variants[key]
    ranges = [[r[0], r[1], vidx(r), r[4]] for r in rows]   # [von,bis,vidx,proddate]
    vlist = [list(k) for k, _ in sorted(variants.items(), key=lambda kv: kv[1])]
    payload = json.dumps({'variants': vlist, 'ranges': ranges},
                         separators=(',', ':')).encode()
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, 'vin-index.json.gz')
    with open(path, 'wb') as f:
        f.write(gzip.compress(payload, 6))
    print(f"wrote {path} ({len(ranges):,} ranges, {len(vlist)} variants, "
          f"{os.path.getsize(path)/1e6:.1f} MB)")


def build_vehicle_index(con, out_dir):
    """Write vehicles.json: the attribute drill-down tree, chassis -> body ->
    model -> [[steer, gear, year, mospid], ...]. Small enough (~30 KB gzipped,
    ~200 KB raw) to ship in the repo. Drives ETK's Series/Body/Model selectors.
    """
    rows = con.execute(
        "SELECT fztyp_baureihe, fztyp_karosserie, fztyp_erwvbez, fztyp_lenkung, "
        "       fztyp_getriebe, fztyp_einsatz, fztyp_mospid "
        "FROM w_fztyp "
        "ORDER BY fztyp_baureihe, fztyp_karosserie, fztyp_erwvbez").fetchall()
    tree = {}
    for ch, body, model, steer, gear, year, mospid in rows:
        (tree.setdefault(ch, {}).setdefault(body or '', {})
             .setdefault(model or '', []).append([steer or '', gear or '', year or '', mospid]))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, 'vehicles.json')
    with open(path, 'w') as f:
        json.dump(tree, f, separators=(',', ':'))
    print(f"wrote {path} ({len(tree)} chassis, {len(rows)} variants, "
          f"{os.path.getsize(path)/1e6:.2f} MB)")


def build_vehicle_thumbs(con, out_dir):
    """Write thumbs/<chassis>_<body>.jpg|png: the little car photos ETK shows
    on the Vehicle Identification screen (w_baureihe_kar_thb -> w_grafik).
    211 images, ~3 KB each -- small enough to ship in the repo. thumbs.json
    indexes what exists so the viewer never has to 404-probe.
    """
    tdir = os.path.join(out_dir, 'thumbs')
    os.makedirs(tdir, exist_ok=True)
    rows = con.execute(
        "SELECT t.baureihekar_baureihe, t.baureihekar_karosserie, "
        "       g.grafik_format, g.grafik_laenge, g.grafik_blob "
        "FROM w_baureihe_kar_thb t "
        "JOIN w_grafik g ON g.grafik_grafikid = t.baureihekar_grafikid").fetchall()
    index = {}
    total = 0
    for ch, body, fmt, laenge, blob in rows:
        if not blob:
            continue
        data = bytes(blob)
        if laenge and laenge < len(data):     # blobs are stored 4 KB-padded
            data = data[:laenge]
        # classics ship 3 KB 150x75 thumbs but modern chassis carry multi-MB
        # full-res press photos; normalise everything to a <=400px JPEG so the
        # whole set stays ~1 MB (the viewer box is ~90px tall)
        if HAVE_PIL:
            try:
                img = Image.open(io.BytesIO(data))
                if img.width > 400:
                    img = img.resize((400, round(img.height * 400 / img.width)),
                                     Image.LANCZOS)
                if img.mode in ('RGBA', 'P', 'LA'):
                    bg = Image.new('RGB', img.size, (255, 255, 255))
                    bg.paste(img.convert('RGBA'), mask=img.convert('RGBA').split()[-1])
                    img = bg
                elif img.mode != 'RGB':
                    img = img.convert('RGB')
                buf = io.BytesIO()
                img.save(buf, 'JPEG', quality=82)
                data = buf.getvalue()
            except Exception as e:              # keep the original bytes
                print(f"  note: could not re-encode thumb {ch}_{body}: {e}",
                      file=sys.stderr)
        # ch/body are DB columns used in a filename: strip path separators so
        # a stray value cannot write outside thumbs/
        safe = ''.join(c for c in f"{ch}_{body}" if c not in '/\\')
        name = f"{safe}.jpg"
        with open(os.path.join(tdir, name), 'wb') as f:
            f.write(data)
        index[f"{ch}_{body}"] = name
        total += len(data)
    with open(os.path.join(tdir, 'thumbs.json'), 'w') as f:
        json.dump(index, f, separators=(',', ':'))
    print(f"wrote {tdir}/ ({len(index)} car photos, {total/1e3:.0f} KB) + thumbs.json")


def main():
    ap = argparse.ArgumentParser(description="Pack ETK into per-chassis .etk bundles")
    ap.add_argument('--db', required=True, help='etk.sqlite (the dumped catalogue)')
    ap.add_argument('--chassis', help='one chassis id (default: all)')
    ap.add_argument('--out', default='data/etk', help='output dir for .etk archives')
    ap.add_argument('--iso', default='en', help='language for names (default en)')
    ap.add_argument('--vin-index', action='store_true',
                    help='also write vin-index.json.gz (the VIN decoder data)')
    ap.add_argument('--vin-index-only', action='store_true',
                    help='write only vin-index.json.gz and exit')
    ap.add_argument('--vehicles-only', action='store_true',
                    help='write only vehicles.json (the attribute drill-down) and exit')
    ap.add_argument('--thumbs-only', action='store_true',
                    help='write only thumbs/ (the car photos) and exit')
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print(f"no {args.db}", file=sys.stderr); sys.exit(1)

    con = sqlite3.connect(args.db)

    if args.vin_index_only:
        build_vin_index(con, args.out)
        return
    if args.vehicles_only:
        build_vehicle_index(con, args.out)
        return

    # Everything past here fetches image blobs by grafikid. The dumped
    # etk.sqlite ships without an index on that column, and load_grafik is one
    # query per diagram (ordered by blob length!) -- unindexed, a full build
    # scans w_grafik per image and takes days instead of minutes.
    try:
        con.execute("CREATE INDEX IF NOT EXISTS idx_grafik_grafikid "
                    "ON w_grafik(grafik_grafikid)")
        con.commit()
    except Exception as e:
        print(f"warning: could not create idx_grafik_grafikid on "
              f"w_grafik(grafik_grafikid) ({e}) -- image lookups will be "
              f"slow (read-only database?)", file=sys.stderr)

    if args.thumbs_only:
        build_vehicle_thumbs(con, args.out)
        return

    if not HAVE_PIL:
        print("note: Pillow not installed -- TIF diagrams will be skipped "
              "(pip install Pillow to include them)", file=sys.stderr)
    print("resolving names...")
    names = resolve_names(con, args.iso)
    print(f"  {len(names)} names ({args.iso})")

    targets = [args.chassis] if args.chassis else chassis_list(con)
    print(f"building {len(targets)} chassis...")
    built = []
    for ch in targets:
        r = build(con, ch, names, args.out, quiet=False)
        if r:
            built.append(ch)
    print(f"done: {len(built)}/{len(targets)} chassis packed into {args.out}/")

    # index.json: the list of chassis that actually have a bundle, so the viewer
    # reads ONE file instead of HEAD-probing every car (a full build would be
    # ~250 requests to the data host otherwise). Merge with any existing index
    # when building a single chassis, so a partial run doesn't wipe the list.
    idx_path = os.path.join(args.out, 'index.json')
    have = set(built)
    if args.chassis and os.path.exists(idx_path):
        try:
            have |= set(json.load(open(idx_path)))
        except Exception as e:
            # fall through with this run's chassis only (a bad index would
            # otherwise silently drop every other chassis from the list)
            print(f"warning: could not merge existing {idx_path}: {e}",
                  file=sys.stderr)
    with open(idx_path, 'w') as f:
        json.dump(sorted(have), f)
    print(f"wrote {idx_path} ({len(have)} chassis)")

    if args.vin_index:
        build_vin_index(con, args.out)
    build_vehicle_index(con, args.out)   # tiny; always ship the drill-down tree


if __name__ == '__main__':
    main()
