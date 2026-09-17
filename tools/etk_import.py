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

THE CALLOUT HOTSPOTS (--hotspots, <chassis>.hs.json.gz):
    w_grafik_hs[grafikid] -> the clickable rectangles drawn over one graphic

ETK ships, per graphic, the rectangle each callout number occupies on the
drawing:

    w_grafik_hs(grafikhs_grafikid, grafikhs_art, grafikhs_bildposnr,
                grafikhs_topleft_x, grafikhs_topleft_y,
                grafikhs_bottomright_x, grafikhs_bottomright_y)

COORDINATE SPACE. The x/y values are PIXELS OF THE 'Z' RENDERING of that
graphic, which is exactly the image this importer ships: load_grafik prefers
grafik_art='Z' over the small 'T' thumbnail. So a rectangle maps onto the
shipped image by dividing through img.naturalWidth/naturalHeight -- no scale
factor, no offset. grafikhs_art is 'Z' for every row in the catalogue, which
is consistent with that. Rows whose rectangle falls outside the image are
dropped rather than clamped, because an out-of-range rectangle means the row
belongs to a rendering we did not ship.

THE POS KEY. grafikhs_bildposnr IS the callout number, the same value
w_btzeilen.btzeilen_bildposnr carries and the same string this importer
writes as each part's `pos` in tree.json (see `callouts` in build()). That is
what joins a rectangle to its parts rows. The relation is many-to-many: one
pos can own several rectangles (a part drawn in two places), and several
parts can share one pos (fitment variants of the same position).

WHY A SEPARATE FILE. The .etk bundles are 6.86 GB published as-is; adding a
few kilobytes of rectangles to each would mean re-uploading all of them. The
hotspots ride alongside as <chassis>.hs.json.gz (tens of KB), fetched through
the same local-then-dataset path. A chassis with no file, or a diagram with
no rectangles, keeps the plain non-interactive drawing.

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


def comment_text(con, names, komm_id, cache):
    """The English text of one ETK line comment (w_komm), as the catalogue
    prints it: the fixed pieces plain ("For vehicles with", "and"), the named
    pieces (an option, a package) with their sign -- "+M Sports package" is
    with it, "-Sport Line" without."""
    if komm_id in cache:
        return cache[komm_id]
    pieces = []
    for pos, tc, vz, darst in con.execute(
            "SELECT komm_pos, komm_textcode, komm_vz, komm_darstellung "
            "FROM w_komm WHERE komm_id=? ORDER BY komm_pos", (komm_id,)):
        text = (names.get(tc) or '').strip()
        if not text:
            continue
        if darst == 'N' and vz in ('+', '-'):
            text = vz + text
        pieces.append(text)
    out = ' '.join(pieces)
    cache[komm_id] = out
    return out


def line_conditions(con, btnrs, names):
    """(btnr, line pos) -> the validity of that parts line, or nothing.

    THE FITMENT TABLE SAYS WHICH VEHICLE TYPES A LINE IS FOR; THE LINE ITSELF
    SAYS WHEN AND UNDER WHAT CONDITION. w_btzeilen carries a from-month
    (eins) and a to-month (auslf), a steering side, an automatic/manual flag,
    a condition letter (bedkez) and the comment the catalogue prints beside
    the line ("For vehicles with +Headlight cleaning system"). Without these
    a 2004 car was shown the pre-facelift bumper trim next to its own.

    Short keys, the same the app reads: f from, t to (both YYYYMM), s
    steering L/R, a gearbox A/M, k the catalogue's Kat mark (+ or -), c the
    condition letter, n the note."""
    out = {}
    cache = {}
    for btnr, pos, eins, auslf, bedkez, lenkg, auto, kat, kvor, knach in chunked_in(
            con,
            "SELECT btzeilen_btnr, btzeilen_pos, btzeilen_eins, btzeilen_auslf, "
            "btzeilen_bedkez, btzeilen_lenkg, btzeilen_automatik, btzeilen_kat, "
            "btzeilen_kommvor, btzeilen_kommnach "
            "FROM w_btzeilen WHERE btzeilen_btnr IN (%s)", sorted(btnrs)):
        rec = {}
        if eins:
            rec['f'] = int(eins) // 100
        if auslf:
            rec['t'] = int(auslf) // 100
        if lenkg in ('L', 'R'):
            rec['s'] = lenkg
        if auto in ('A', 'M'):
            rec['a'] = auto
        if kat in ('+', '-'):
            rec['k'] = kat
        if bedkez:
            rec['c'] = str(bedkez)
        notes = [comment_text(con, names, k, cache) for k in (kvor, knach) if k]
        notes = [n for n in notes if n]
        if notes:
            rec['n'] = ' / '.join(notes)
        if rec:
            out[(btnr, pos)] = rec
    return out


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

    # 4a. the line's own validity: dates, steering, gearbox, condition, note,
    #     and the quantity when it is not 1
    conds = line_conditions(con, btnr_list, names)
    for key, q in line_quantities(con, mospids, btnrs).items():
        conds.setdefault(key, {})['q'] = q
    sups = part_supplements(con, all_sachnr)

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
            cond = conds.get((btnr, pos))
            if cond:
                p['ln'] = [cond]   # the line's validity (see line_conditions)
            if sachnr in sups:
                p['sup'] = sups[sachnr]   # the Supplement column (M8X16)
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


def chassis_btnrs(con, chassis):
    """The diagrams (btnr) one chassis's bundle carries, and nothing else.

    Derived exactly the way build() derives them -- the chassis's mospids from
    w_fztyp, then the diagrams their parts are drawn on via the fitment table --
    so the hotspot file covers the same diagram set as the .etk beside it, with
    no orphan entries and no missing ones."""
    mospids = [r[0] for r in con.execute(
        "SELECT fztyp_mospid FROM w_fztyp WHERE fztyp_baureihe=?", (chassis,))]
    if not mospids:
        return set()
    btnrs = set()
    for (btnr,) in chunked_in(con,
            "SELECT DISTINCT btzeilenv_btnr FROM w_btzeilen_verbauung "
            "WHERE btzeilenv_mospid IN (%s)", mospids):
        btnrs.add(btnr)
    return btnrs


def line_quantities(con, mospids, btnrs):
    """(btnr, line pos) -> the quantity the catalogue lists for that line,
    the most common across the chassis's vehicles (it is per vehicle in the
    fitment table and all but never differs). Only quantities other than 1
    are returned; 1 is what a missing value means."""
    counts = {}
    for btnr, pos, q, mospid in chunked_in(con,
            "SELECT btzeilenv_btnr, btzeilenv_pos, btzeilenv_vmenge, btzeilenv_mospid "
            "FROM w_btzeilen_verbauung WHERE btzeilenv_mospid IN (%s)", mospids):
        if btnr not in btnrs or q is None:
            continue
        d = counts.setdefault((btnr, pos), {})
        d[str(q).strip()] = d.get(str(q).strip(), 0) + 1
    out = {}
    for key, d in counts.items():
        best = max(d.items(), key=lambda kv: (kv[1], kv[0]))[0]
        if best and best != '1':
            out[key] = best
    return out


def part_supplements(con, sachnrs):
    """sachnr -> the part's name supplement ("M8X16", the size or grade that
    tells one bolt from another), the ETK's Supplement column."""
    out = {}
    for sachnr, sup in chunked_in(con,
            "SELECT teil_sachnr, teil_benennzus FROM w_teil "
            "WHERE teil_sachnr IN (%s) AND teil_benennzus IS NOT NULL", sachnrs):
        s = str(sup or '').strip()
        if s:
            out[sachnr] = s
    return out


def part_info(con, names, sachnrs):
    """sachnr -> what the catalogue's Part information window shows for it
    beyond the name: the part master (w_teil) and the tables hanging off it.
    Only what the dump carries -- prices, stock and customs codes are the
    dealer's own files, not the catalogue.

        w  weight, kg                    c  the description comment ("black")
        h  1 when hazardous goods        dn the DIN/norm number
        e  discontinued, YYYYMM          x  the exchange (remanufactured) part
        rep [[sachnr, name], ...]        superseded by
        for [[sachnr, name], ...]        replaces
        kit [[sachnr, name, qty, orderable], ...]   the parts of a set
        reach [[CAS number, substance, %, subcomponent], ...]

    Keys are left out when empty, so a plain bolt is one short record."""
    def name_of(sachnr):
        tc = textcodes.get(sachnr)
        return (names.get(tc) or '').strip() if tc else ''

    out = {}
    textcodes = {}
    sachnrs = {s for s in sachnrs if s}
    for sachnr, tc, kom, gew, gefahr, norm, entfall_kez, entfall_dat, tausch in chunked_in(
            con,
            "SELECT teil_sachnr, teil_textcode, teil_textcode_kom, teil_teile_gew, "
            "teil_gefahr_kl, teil_normnummer, teil_entfall_kez, teil_entfall_dat, "
            "teil_tausch FROM w_teil WHERE teil_sachnr IN (%s)", sachnrs):
        textcodes[sachnr] = tc
        rec = {}
        if gew and gew > 0:
            rec['w'] = round(float(gew), 3)
        comment = (names.get(kom) or '').strip() if kom else ''
        if comment:
            rec['c'] = comment
        if (gefahr or '').strip() == 'J':
            rec['h'] = 1
        if (norm or '').strip():
            rec['dn'] = norm.strip()
        if (entfall_kez or '').strip() == 'E' and entfall_dat:
            rec['e'] = int(entfall_dat) // 100
        if (tausch or '').strip():
            rec['x'] = tausch.strip()
        if rec:
            out[sachnr] = rec
    # the related parts need names of their own, and most are not in the
    # chassis's bundle; resolve them in one pass at the end
    related = {}
    rows = {}
    for old, new in chunked_in(con,
            "SELECT teilatb_sachnr_alt, teilatb_sachnr_neu FROM w_teil_atb "
            "WHERE teilatb_sachnr_alt IN (%s)", sachnrs):
        rows.setdefault(old, {}).setdefault('rep', []).append(new)
        related[new] = None
    for old, new in chunked_in(con,
            "SELECT teilatb_sachnr_alt, teilatb_sachnr_neu FROM w_teil_atb "
            "WHERE teilatb_sachnr_neu IN (%s)", sachnrs):
        rows.setdefault(new, {}).setdefault('for', []).append(old)
        related[old] = None
    for satz, pos, part, qty, orderable in chunked_in(con,
            "SELECT ke_sachnr_satz, ke_pos, ke_sachnr_einzelteil, ke_menge, "
            "ke_beziehbar FROM w_kompl_einzelteil WHERE ke_sachnr_satz IN (%s)", sachnrs):
        rows.setdefault(satz, {}).setdefault('kit', []).append(
            (pos or 0, part, str(qty or '').strip(), orderable))
        related[part] = None
    for sachnr, cas, subst, pct, sub in chunked_in(con,
            "SELECT teilreach_sachnr, teilreach_casnr, teilreach_casname, "
            "teilreach_gewanteil, teilreach_subcomponent FROM w_teil_reach "
            "WHERE teilreach_sachnr IN (%s)", sachnrs):
        rows.setdefault(sachnr, {}).setdefault('reach', []).append(
            [(cas or '').strip(), (subst or '').strip(),
             float(pct) if pct is not None else None, (sub or '').strip()])
    missing = {s for s in related if s not in textcodes}
    for sachnr, tc in chunked_in(con,
            "SELECT teil_sachnr, teil_textcode FROM w_teil "
            "WHERE teil_sachnr IN (%s)", missing):
        textcodes[sachnr] = tc
    for sachnr, r in rows.items():
        rec = out.setdefault(sachnr, {})
        for key in ('rep', 'for'):
            if r.get(key):
                rec[key] = [[s, name_of(s)] for s in sorted(set(r[key]))]
        if r.get('kit'):
            rec['kit'] = [[s, name_of(s), q, 1 if o == 'J' else 0]
                          for _, s, q, o in sorted(r['kit'])]
        if r.get('reach'):
            rec['reach'] = sorted(r['reach'], key=lambda x: (x[3], x[1]))
    return out


def build_lines(con, chassis, names, out_dir, quiet=False):
    """Write <chassis>.lines.json.gz: the validity of every parts line the
    chassis's bundle carries, keyed the way the viewer can join it to a part
    row (the bundle keeps the callout, not the line number):

        {"v": 3, "ln": {"<btnr>": {"<callout>|<sachnr>": [{f,t,s,a,k,c,n,q}, ...]}},
         "sup": {"<sachnr>": "M8X16"}, "pt": {"<sachnr>": {...}}}

    sup is the Supplement column and pt the Part information window (see
    part_info), both per part so once per file.

    A callout and part number can appear on more than one line of a diagram
    (one window each), so the value is a list and the viewer keeps the part
    when ANY line fits. Rides beside the published bundle like the callout
    rectangles do; a bundle built after this carries the same records inline
    (part.ln) and the viewer prefers those.

    Returns (diagrams, lines, bytes) or None when nothing has a condition."""
    import gzip
    btnrs = chassis_btnrs(con, chassis)
    if not btnrs:
        return None
    conds = line_conditions(con, btnrs, names)
    mospids = [r[0] for r in con.execute(
        "SELECT fztyp_mospid FROM w_fztyp WHERE fztyp_baureihe=?", (chassis,))]
    qty = line_quantities(con, mospids, btnrs)
    # the quantity rides on the line record, so a line with only a quantity
    # gets a record too
    for key, q in qty.items():
        conds.setdefault(key, {})['q'] = q
    if not conds:
        return None
    callouts = {}
    sachnr_of = {}
    for btnr, pos, callout, sachnr in chunked_in(con,
            "SELECT btzeilen_btnr, btzeilen_pos, btzeilen_bildposnr, btzeilen_sachnr "
            "FROM w_btzeilen WHERE btzeilen_btnr IN (%s)", sorted(btnrs)):
        callouts[(btnr, pos)] = callout if callout is not None else pos
        sachnr_of[(btnr, pos)] = sachnr
    ln = {}
    for (btnr, pos), rec in sorted(conds.items()):
        key = f"{callouts.get((btnr, pos), pos)}|{sachnr_of.get((btnr, pos), '')}"
        recs = ln.setdefault(btnr, {}).setdefault(key, [])
        # a callout-less part is drawn on many lines with one and the same
        # validity; one record says it
        if rec not in recs:
            recs.append(rec)
    # the Supplement column and the Part information window: per part, so
    # once per file
    sachnrs = {s for s in sachnr_of.values() if s}
    sup = part_supplements(con, sachnrs)
    pt = part_info(con, names, sachnrs)
    payload = json.dumps({'v': 3, 'ln': ln, 'sup': sup, 'pt': pt},
                         ensure_ascii=False,
                         separators=(',', ':')).encode('utf-8')
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f'{chassis}.lines.json.gz')
    tmp_path = path + '.tmp'
    try:
        with open(tmp_path, 'wb') as f:
            with gzip.GzipFile(fileobj=f, mode='wb', mtime=0) as g:
                g.write(payload)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    os.replace(tmp_path, path)
    size = os.path.getsize(path)
    nlines = sum(len(v) for d in ln.values() for v in d.values())
    if not quiet:
        print(f"  {chassis}: {len(ln)} diagrams, {nlines} conditioned lines, "
              f"{len(pt)} parts with information -> {size/1e3:.1f} KB")
    return (len(ln), nlines, size)


def build_hotspots(con, chassis, out_dir, quiet=False):
    """Write <chassis>.hs.json.gz: the clickable callout rectangles of every
    diagram that chassis's bundle carries.

    Shape (see the module docstring for the tables and the coordinate space):

        {"v": 1, "bt": {"<btnr>": [["<pos>", x1, y1, x2, y2], ...], ...}}

    Coordinates are pixels of the shipped ('Z') rendering of the diagram's
    graphic, top-left origin, so the viewer scales them by the rendered image's
    size over its naturalWidth/naturalHeight. `pos` is the callout key that
    joins a rectangle to the parts rows carrying the same `pos`.

    Kept deliberately small: integers only, no whitespace, gzipped. An E-chassis
    lands in the tens of KB, so it can ride beside the (much larger, already
    published) bundle instead of forcing a re-upload of it.

    Returns (diagrams with rectangles, rectangle count, bytes) or None when the
    chassis has no diagram with rectangles."""
    import gzip
    btnrs = chassis_btnrs(con, chassis)
    if not btnrs:
        return None

    # btnr -> grafikid. Several diagrams can share one graphic, so the
    # rectangles are fetched per DISTINCT graphic and fanned back out.
    bt_gid = {}
    for btnr, gid in chunked_in(con,
            "SELECT bildtaf_btnr, bildtaf_grafikid FROM w_bildtaf "
            "WHERE bildtaf_btnr IN (%s)", sorted(btnrs)):
        if gid:
            bt_gid[btnr] = gid
    if not bt_gid:
        return None

    # grafikid -> [[pos, x1, y1, x2, y2], ...]. art is 'Z' throughout the
    # catalogue, but filter on it anyway so a future 'T' (thumbnail-space) row
    # cannot leak in with coordinates of a different rendering.
    gid_rects = {}
    for gid, pos, x1, y1, x2, y2 in chunked_in(con,
            "SELECT grafikhs_grafikid, grafikhs_bildposnr, grafikhs_topleft_x, "
            "       grafikhs_topleft_y, grafikhs_bottomright_x, grafikhs_bottomright_y "
            "FROM w_grafik_hs WHERE grafikhs_art='Z' AND grafikhs_grafikid IN (%s)",
            sorted(set(bt_gid.values()))):
        if pos is None or None in (x1, y1, x2, y2):
            continue
        x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)
        # a zero-area or inverted rectangle is unclickable; normalise the order
        # and drop the degenerate ones rather than shipping dead hit targets
        lo_x, hi_x = min(x1, x2), max(x1, x2)
        lo_y, hi_y = min(y1, y2), max(y1, y2)
        if hi_x <= lo_x or hi_y <= lo_y:
            continue
        gid_rects.setdefault(gid, []).append(
            [str(pos), lo_x, lo_y, hi_x, hi_y])

    bt = {}
    nrect = 0
    for btnr in sorted(bt_gid):
        rects = gid_rects.get(bt_gid[btnr])
        if not rects:
            continue
        bt[btnr] = rects
        nrect += len(rects)
    if not bt:
        return None

    payload = json.dumps({'v': 1, 'bt': bt},
                         ensure_ascii=False,
                         separators=(',', ':')).encode('utf-8')
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f'{chassis}.hs.json.gz')
    # same temp-then-replace as the bundle: an interrupted run must not leave a
    # truncated .gz that the viewer would fail to gunzip
    tmp_path = path + '.tmp'
    try:
        with open(tmp_path, 'wb') as f:
            f.write(gzip.compress(payload, 9))
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    os.replace(tmp_path, path)
    size = os.path.getsize(path)
    if not quiet:
        print(f"  {chassis}: {len(bt)} diagrams with callouts, {nrect} rectangles "
              f"-> {size/1e3:.1f} KB")
    return (len(bt), nrect, size)


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
        """The index of this row's variant tuple, interned on first sight."""
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
    """CLI entry: pack the catalogue per chassis, plus the VIN index, the
    vehicle drill-down and the thumbnails on request."""
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
    ap.add_argument('--hotspots', action='store_true',
                    help='write only <chassis>.hs.json.gz (the diagram callout '
                         'rectangles) and exit; a full run always writes them')
    ap.add_argument('--lines', action='store_true',
                    help='write only <chassis>.lines.json.gz (each parts line\'s '
                         'validity: dates, steering, gearbox, condition, note) '
                         'and exit; a bundle built by a full run carries them inline')
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

    # Hotspots read no image blobs, so this runs before the w_grafik index
    # below (which exists only to make blob lookups bearable) and is fast
    # enough to re-run for every chassis on its own.
    if args.lines:
        targets = [args.chassis] if args.chassis else chassis_list(con)
        names = resolve_names(con, args.iso)
        print(f"writing line validity for {len(targets)} chassis...")
        nch = ndiag = nln = nbytes = 0
        for ch in targets:
            r = build_lines(con, ch, names, args.out, quiet=False)
            if r:
                nch += 1
                ndiag += r[0]
                nln += r[1]
                nbytes += r[2]
        print(f"done: {nch}/{len(targets)} chassis, {ndiag:,} diagrams, "
              f"{nln:,} conditioned lines, {nbytes/1e6:.2f} MB total")
        return

    if args.hotspots:
        targets = [args.chassis] if args.chassis else chassis_list(con)
        print(f"writing callout hotspots for {len(targets)} chassis...")
        nch = ndiag = nrect = nbytes = 0
        for ch in targets:
            r = build_hotspots(con, ch, args.out, quiet=False)
            if r:
                nch += 1
                ndiag += r[0]
                nrect += r[1]
                nbytes += r[2]
        print(f"done: {nch}/{len(targets)} chassis, {ndiag:,} diagrams with "
              f"callouts, {nrect:,} rectangles, {nbytes/1e6:.2f} MB total")
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
            # the callout rectangles ride beside the bundle and are derived from
            # the same diagram set, so they are written in the same pass -- a
            # bundle without its hotspots would silently lose the interaction
            build_hotspots(con, ch, args.out, quiet=False)
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
