#!/usr/bin/env python3
"""Emit the SHIPPABLE artifacts of the jobs-to-JSON work, and measure them.

Everything before this tool verified the extraction; this is the step that
actually produces what the web app downloads. Three commands:

    python3 tools/sgbd_export.py --specs      # data/job-specs/<sgbd>.json
    python3 tools/sgbd_export.py --tables     # data/sgbd-tables/<sgbd>.json
    python3 tools/sgbd_export.py --coverage   # what the IR SCREENS can show

--specs writes one JSON per E46 SGBD: every job the compiled INPA UI
references, each with its lifted spec, plus a "connection" block (protocol
framing and the init exchange the ECU demands, derived by running the real
engine against a stub simulator -- the same ground truth the value harness
uses). A job the spec format cannot express keeps its gaps; nothing is
guessed.

--tables exports every SGBD table the specs reference (status tables,
FUmweltTexte lookups) via the engine's table API, so the browser walker can
resolve runtime-keyed scales without the engine.

--coverage answers the question that matters for shipping: of the result
KEYS the IR screens actually display, how many does some job spec on that
screen decode? This is the user-facing number -- a result no screen shows
does not gate the web app, however interesting its bytecode is.

Every mode runs its work to completion even when pieces fail, then exits
NONZERO with an "EXPORT INCOMPLETE" summary if anything did. That is the
lesson of dist-web and the wiring shipping broken: a WARNING that scrolls
past an exit 0 is invisible to CI. --allow-partial downgrades the summary
back to exit 0 for a caller that has decided partial output is acceptable.
"""
import os
import sys
import json
import glob
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # tools/, for sibling modules
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]
import sgbd_survey as S                                       # noqa: E402
import sgbd_spec as SP
import ecu_tree as ET                                        # noqa: E402
import sgbd_value_diff as V                                   # noqa: E402
import sgbd_bulk_verify as B                                  # noqa: E402

ROOT = os.path.join(HERE, "..", "..")
SPEC_DIR = os.path.join(ROOT, "data", "job-specs")
TABLE_DIR = os.path.join(ROOT, "data", "sgbd-tables")
IR_DIR = os.path.join(ROOT, "data", "inpa-ir")


def _decodable(r):
    """Can a walker produce this result from a response?"""
    return (r.get("const") is not None or r.get("bytes")
            or r.get("enumMap") or r.get("values"))


def _export_one(sgbd):
    """Extract + probe one SGBD, write its spec file; returns a summary.

    Top-level so ProcessPoolExecutor can pickle it. Each worker spawns its
    own dotnet probes into per-SGBD scratch dirs (see sgbd_bulk_verify), so
    workers cannot trample each other.
    """
    try:
        data, jobs = SP.load(sgbd)
    except SystemExit:
        return (sgbd, None, 0, 0, False)
    ir = S.ir_jobs_for(sgbd)
    out = {"format": 1, "sgbd": sgbd, "jobs": {}}
    first_job = None
    n_res = n_dec = 0
    for name, addr in jobs:
        if name.startswith("_") or name.upper() not in ir:
            continue
        first_job = first_job or name
        try:
            spec = SP.extract(data, addr, sgbd, name)
        except Exception as e:                              # noqa: BLE001
            spec = {"sgbd": sgbd, "job": name,
                    "gaps": [f"extract failed: {e}"]}
        out["jobs"][name] = spec
        res = [r for r in spec.get("results", [])
               if not r.get("name", "").startswith("_")]
        n_res += len(res)
        n_dec += sum(1 for r in res if _decodable(r))
    # The init exchange and framing, derived by running the REAL engine
    # against a stub sim -- what it sends first is what the ECU needs.
    conn_err = None
    if first_job:
        try:
            init = B.discover_init(sgbd, first_job)
            reqs = B.discover(sgbd, [first_job], init)
            probe = reqs.get(first_job)
            conn = {}
            if probe:
                conn["protocol"] = "ds2" if B.is_ds2(probe) else "fast"
                conn["address"] = probe[1] if conn["protocol"] == "fast" \
                    else probe[0]
            if init:
                conn["init"] = [{"send": list(init[0]),
                                 "expect": list(init[1] or [])}]
            if conn:
                out["connection"] = conn
        except Exception as e:                              # noqa: BLE001
            # a crashed probe is NOT "this ECU needs no init" -- say which,
            # or conn=no hides a broken discovery behind a plausible answer
            conn_err = f"{type(e).__name__}: {e}"
    path = os.path.join(SPEC_DIR, f"{sgbd}.json")
    with open(path, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    return (sgbd, len(out["jobs"]), n_res, n_dec,
            conn_err or bool(out.get("connection")))


def export_specs(targets):
    os.makedirs(SPEC_DIR, exist_ok=True)
    # Extraction is pure Python and the probes are dotnet subprocesses, so
    # a PROCESS pool parallelises both; the serial run spent most of its
    # wall clock waiting on one dotnet at a time.
    from concurrent.futures import ProcessPoolExecutor
    workers = min(6, os.cpu_count() or 4)
    grand_jobs = grand_res = grand_dec = 0
    conn_failed = []
    # warm the CLI binary once, before workers race to build it
    B.cli_cmd("--version")
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for sgbd, nj, nr, nd, conn in ex.map(_export_one, targets):
            if nj is None:
                print(f"  {sgbd:12} -- no .prg, skipped")
                continue
            grand_jobs += nj
            grand_res += nr
            grand_dec += nd
            path = os.path.join(SPEC_DIR, f"{sgbd}.json")
            # conn is True/False from discovery, or an error string when the
            # probe itself failed -- keep the two visibly different
            if isinstance(conn, str):
                conn_failed.append(sgbd)
                conn_s = f"FAILED ({conn})"
            else:
                conn_s = "yes" if conn else "no"
            print(f"  {sgbd:12} {nj:3} jobs "
                  f"{os.path.getsize(path)//1024:5} KB "
                  f"conn={conn_s}")
    print(f"specs: {grand_jobs} jobs, {grand_res} results, "
          f"{grand_dec} decodable ({100*grand_dec/max(grand_res,1):.1f}%)")
    if conn_failed:
        print(f"WARNING: connection discovery FAILED (not merely absent) for "
              f"{len(conn_failed)} SGBDs: {', '.join(conn_failed[:10])}"
              + (" ..." if len(conn_failed) > 10 else ""))
    # main() turns these into a nonzero exit: a WARNING that scrolls past
    # and an exit 0 is how partial spec sets shipped before
    return conn_failed


def export_tables(targets):
    os.makedirs(TABLE_DIR, exist_ok=True)
    # table fetches are HTTP calls to the engine API: thread them
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(_export_tables_one, targets))
    # failures MUST outlive the scroll: a listing that fell back to the
    # spec-referenced subset is the exact regression the comment in
    # _export_tables_one warns about (a third of MS450's lookup text gone)
    no_listing = [s for s, lf, _ in results if lf]
    dropped = sum(nf for _, _, nf in results)
    if no_listing:
        print(f"WARNING: table listing failed for {len(no_listing)} SGBDs "
              f"(exported only spec-referenced tables): "
              f"{', '.join(no_listing[:10])}"
              + (" ..." if len(no_listing) > 10 else ""))
    if dropped:
        print(f"WARNING: {dropped} declared tables failed to fetch "
              f"and were dropped")
    # returned so main() can FAIL the run: these two warnings describe the
    # exact regression that shipped a third of MS450's lookup text missing,
    # and an exit 0 is what let it ship
    return no_listing, dropped


def _export_tables_one(sgbd):
    # EVERY table the .prg declares, not just the ones a lifted spec field
    # happens to name. MS450 declares 53 and the spec fields named 20, so a
    # third of its lookup text was missing -- STATUS_MESSWERTBLOCK's unit
    # column resolved to "" because the table holding it was never shipped.
    # The VM reaches tables the lifter never modelled, so the export has to
    # come from the SGBD, not from our summary of it.
    names = set()
    listing_failed = False
    table_failures = 0
    port = os.environ.get("BMACW_PORT")
    if port:
        import urllib.request
        try:
            listing = json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/ecu/{sgbd}/tables", timeout=60))
            for t in (listing if isinstance(listing, list) else []):
                n = t if isinstance(t, str) else t.get("name")
                if n:
                    names.add(n)
        except Exception as e:                              # noqa: BLE001
            # falling back to spec-referenced tables only is exactly the
            # regression described above -- shout, or it ships again
            listing_failed = True
            print(f"  {sgbd:12} WARNING: table listing failed "
                  f"({type(e).__name__}: {e}) -- exporting only "
                  f"spec-referenced tables")
    path = os.path.join(SPEC_DIR, f"{sgbd}.json")
    if os.path.exists(path):
        spec_file = json.load(open(path))
        for spec in spec_file.get("jobs", {}).values():
            if spec.get("statusTable"):
                names.add(spec["statusTable"])
            for t in spec.get("tables", []):
                names.add(t)
            for r in spec.get("results", []):
                lk = r.get("lookup")
                if lk and lk.get("table"):
                    names.add(lk["table"])
    if not names:
        return (sgbd, listing_failed, table_failures)
    tables = {}
    for t in sorted(names):
        try:
            rows = V.sgbd_table(sgbd, t)
        except Exception as e:                              # noqa: BLE001
            # a dropped table is not "declared and empty": say which
            table_failures += 1
            print(f"  {sgbd:12} WARNING: table {t} fetch failed "
                  f"({type(e).__name__}: {e}) -- dropped")
            rows = None
        if rows:
            tables[t] = rows
    if tables:
        tp = os.path.join(TABLE_DIR, f"{sgbd}.json")
        with open(tp, "w") as f:
            json.dump(tables, f, ensure_ascii=False,
                      separators=(",", ":"))
        print(f"  {sgbd:12} {len(tables):2} tables "
              f"{os.path.getsize(tp)//1024:5} KB")
    return (sgbd, listing_failed, table_failures)


def _cli_dumptable(table, sgbd):
    """Table rows via the prebuilt CLI: the embedded engine, offline.

    The engine's HTTP API died with the server era, but the checked-in
    InpaMac.Cli binary still carries the real EdiabasLib and answers _TABLE
    without any app running. Its output is two columns per row -- complete
    for the assignment table (ADR_VAR_DIAG -> SGBD IS its schema), lossy
    for anything wider.
    """
    import subprocess
    cli_dir = os.path.join(ROOT, "src", "InpaMac.Cli")
    cli = os.path.join(cli_dir, "bin", "Debug", "net9.0", "InpaMac.Cli")
    if not os.path.exists(cli):
        return None
    try:
        out = subprocess.run([cli, "dumptable", table.upper(), sgbd],
                             capture_output=True, text=True, timeout=300,
                             cwd=cli_dir)
    except Exception:                                       # noqa: BLE001
        return None
    rows = []
    for line in (out.stdout or "").splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        _, key, val = parts
        if key.upper() == "ADR_VAR_DIAG":                   # header row
            continue
        rows.append((key, val))
    return rows or None


def _txt(raw):
    """Table cell bytes -> text, the way the engine renders them.

    The SGBD text encoding is CP1252 (0x96 is an en dash there, and the
    engine-harvested ground truth shows the dash); latin-1 covers the five
    code points CP1252 leaves undefined rather than mangling them to U+FFFD.
    """
    try:
        return raw.decode("cp1252")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def _prg_tables(path):
    """Every table a .prg/.grp carries, read OFFLINE from the container.

    The engine-backed harvest (sgbd_tables.py, /api/ecu/<s>/table/) needs the
    app running; the tables it serves are sitting in the file all along.
    Layout, validated cell-for-cell against the engine's output for all 826
    E46 tables (823 exact, 2 en-dash encoding, 1 stale-harvest drift):

        header +0x84        plaintext int32 -> table region
        region              XOR-0xF7 int32 count, then count x 0x50 headers:
                            name[0x40], dataOff int32, 0, colCount, rowCount
        dataOff             (rowCount+1) x colCount NUL-terminated XOR'd
                            strings, row-major; row 0 is the column names

    Returns {name: [{col: cell, ...}, ...]} -- data rows only, keyed by the
    column-name row, which is exactly the shape bestvm.js opts.tables eats
    (tabseek scans data rows; tabrows reports len+1 for the header itself).
    Raises ValueError on a malformed region rather than shipping a table
    that silently stops short.
    """
    data = open(path, "rb").read()
    if len(data) < 0x88:
        return {}
    (toff,) = struct.unpack_from("<i", data, 0x84)
    if toff <= 0 or toff + 4 > len(data):
        return {}

    def xi(off):
        return struct.unpack("<i",
                             bytes(b ^ 0xF7 for b in data[off:off + 4]))[0]

    n = xi(toff)
    if n <= 0:
        return {}
    tables = {}
    pos = toff + 4
    for _ in range(n):
        if pos + 0x50 > len(data):
            raise ValueError(f"{path}: table header at 0x{pos:x} past EOF")
        hdr = bytes(b ^ 0xF7 for b in data[pos:pos + 0x50])
        name = _txt(hdr[:0x40].split(b"\0")[0])
        doff, _z, ncol, nrow = struct.unpack_from("<iiii", hdr, 0x40)
        pos += 0x50
        if ncol <= 0 or nrow < 0 or doff <= 0 or doff >= len(data):
            raise ValueError(f"{path}: table {name} bad header "
                             f"doff=0x{doff:x} ncol={ncol} nrow={nrow}")
        cells = []
        p = doff
        for _ in range((nrow + 1) * ncol):
            e = p
            while e < len(data) and data[e] != 0xF7:    # 0x00 ^ 0xF7
                e += 1
            if e >= len(data):
                raise ValueError(f"{path}: table {name} cell at 0x{p:x} "
                                 f"runs past EOF")
            cells.append(_txt(bytes(b ^ 0xF7 for b in data[p:e])))
            p = e + 1
        cols = cells[:ncol]
        tables[name] = [dict(zip(cols, cells[i * ncol:(i + 1) * ncol]))
                        for i in range(1, nrow + 1)]
    return tables


def export_groups(chassis=None):
    """Export EVERY group SGBD and the variant assignment table.

    This is how EDIABAS answers "which SGBD is this ECU?", and without it a
    client can only talk to an ECU whose variant it was already told. A .grp
    is the same container as a .prg (see sgbd_spec.load), so its
    IDENTIFIKATION job runs on the same VM; what it needs alongside is
    ZuordnungsTabelle from t_grtb, which maps the identification answer
    (ADR_VAR_DIAG) to a concrete SGBD name.

    All output is self-contained under data/groups/: <g>.json.gz job code
    per group, variants.json for the mapping. Nothing goes through
    ecu_tree.write_ecu, which silently drops any SGBD chassis-config does
    not name -- exactly what kept every group unshipped until now.
    """
    out_dir = os.path.join(ROOT, "data", "groups")
    os.makedirs(out_dir, exist_ok=True)
    # The assignment table lives in t_grtb, a separate SGBD that every group
    # reaches with `tabsetex "ZuordnungsTabelle", "t_grtb"`. Its key
    # ADR_VAR_DIAG is "<ecu addr> <id pattern> <code>", e.g. "12 .0W. 0010"
    # -> ME9N45, with '.' and '-' as wildcards; the group's IDENTIFIKATION
    # job assembles that key from the ECU's identification response and
    # looks up the concrete SGBD name.
    # t_grtb's whole table set now also comes straight OFF THE DISK
    # (_prg_tables): the offline parse of ZuordnungsTabelle is cell-for-cell
    # identical to what the engine served, and it works with no app running
    # -- the case that used to print SKIPPED and ship no mapping at all.
    grtb_path = S.sgbd_path("t_grtb")
    grtb_tables = None
    if grtb_path:
        try:
            grtb_tables = _prg_tables(grtb_path)
        except (ValueError, struct.error) as e:
            print(f"  t_grtb tables offline parse FAILED: {e}")
    try:
        rows = V.sgbd_table("t_grtb", "ZuordnungsTabelle")
    except Exception:                                       # noqa: BLE001
        rows = None
    if not rows and grtb_tables:
        # keep the historical two-column row shape; the full five-column
        # rows (GRUPPE, BAUREIHE, STEUERGERAET) ship under "tables" below
        rows = [{"ADR_VAR_DIAG": r.get("ADR_VAR_DIAG", ""),
                 "SGBD": r.get("SGBD", "")}
                for r in grtb_tables.get("ZUORDNUNGSTABELLE", [])]
    if not rows:
        pairs = _cli_dumptable("ZUORDNUNGSTABELLE", "t_grtb")
        rows = [{"ADR_VAR_DIAG": k, "SGBD": v} for k, v in pairs or []]
    if rows:
        out = {"table": "ZuordnungsTabelle",
               "keyColumn": "ADR_VAR_DIAG", "sgbdColumn": "SGBD",
               "rows": rows}
        if grtb_tables:
            # EVERY t_grtb table, full columns: the group jobs tabsetex into
            # t_grtb by name (ZuordnungsTabelleUDS, ...Motorrad, ...Hybrid
            # exist beside the classic one), and a VM that can only see the
            # classic table dead-ends on those paths.
            out["tables"] = grtb_tables
        with open(os.path.join(out_dir, "variants.json"), "w") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        extra = f" + {len(grtb_tables)} t_grtb tables" if grtb_tables else ""
        print(f"  variants.json  {len(rows)} rows{extra}")
    else:
        print("  variants.json  SKIPPED (no engine API, no t_grtb.prg, "
              "no CLI binary)")
    # the group programs themselves: every .grp in the vendor tree, either
    # extension case, deduped by lowered stem
    import gzip as _gz
    import sgbd_code as C
    grp_path, groups = {}, []
    for pat in ("*.grp", "*.GRP"):
        for p in glob.glob(os.path.join(S.ECU_DIR, pat)):
            g = os.path.basename(p)[:-4].lower()
            if g not in grp_path:
                grp_path[g] = p
                groups.append(g)
    made = []
    failed = []
    n_tables = n_with = 0
    for g in sorted(groups):
        dest = os.path.join(out_dir, f"{g}.json.gz")
        try:
            r = C.export(g, all_jobs=True, dest=dest)
        except SystemExit as e:
            # C.export bails with SystemExit for "no such SGBD" and friends;
            # swallowing it dropped the group without a trace
            print(f"  {g:12} FAILED SystemExit: {e}")
            failed.append(g)
            continue
        except Exception as e:                              # noqa: BLE001
            print(f"  {g:12} FAILED {type(e).__name__}: {e}")
            failed.append(g)
            continue
        if not r:
            continue
        # GROUP-LOCAL TABLES ride in the same file. The newer-dialect groups
        # (d_0032, d_motor, ...) tabsetex their OWN tables -- D_0032 keeps a
        # local SGBD lookup and its own ZuordnungsTabelle copy -- and a code
        # export without them strands every one of those paths at the first
        # tabseek. Read offline from the .grp (same container layout as .prg,
        # see _prg_tables) and splice in as "tables", the exact rows-by-name
        # shape bestvm.js opts.tables consumes for ECU tables.
        try:
            tables = _prg_tables(grp_path[g])
        except (ValueError, struct.error) as e:
            # a group whose bytecode shipped but whose tables did not is a
            # half-exported group: count it as failed, not as done
            print(f"  {g:12} FAILED table parse: {e}")
            failed.append(g)
            continue
        if tables:
            with _gz.open(dest, "rt", encoding="utf-8") as f:
                out = json.load(f)
            out["tables"] = tables
            blob = _gz.compress(json.dumps(
                out, ensure_ascii=False, separators=(",", ":")).encode(), 6)
            with open(dest, "wb") as f:
                f.write(blob)
            r = (r[0], r[1], r[2], r[3], len(blob))
            n_with += 1
            n_tables += len(tables)
        made.append(r)
    for r in made[:10]:
        print(f"  {r[0]:12} {r[1]:3} jobs {r[2]:6} ops {r[4]//1024:4} KB")
    if len(made) > 10:
        print(f"  ... and {len(made) - 10} more")
    print(f"groups: {len(made)} of {len(groups)} in the vendor tree; "
          f"{n_tables} local tables across {n_with} groups")
    if failed:
        print(f"  {len(failed)} FAILED: {', '.join(failed[:10])}"
              + (" ..." if len(failed) > 10 else ""))
    # manifest, same reason job-code/index.json exists: the renderer checks
    # it before fetching, so a group we never exported is a quiet skip
    # instead of a 404 painting the console red
    with open(os.path.join(out_dir, "index.json"), "w") as f:
        json.dump({"format": 1, "groups": sorted(r[0] for r in made),
                   "variants": bool(rows)}, f, separators=(",", ":"))

    # WHICH VARIANTS EACH ADDRESS CAN ANSWER WITH. The renderer refuses to
    # open a module whose group is ambiguous until the car identifies itself
    # (ecu.js irBlockUnverified) -- D_ZKE_GM can be any of nine modules, and
    # showing one variant's screens for another answers confidently and
    # wrongly. Only the ambiguous groups are written: a group that can name
    # one variant has nothing to resolve and must not gate anything.
    amb = {g: sorted(n) for g, n in ET.group_variants().items() if len(n) > 1}
    with open(os.path.join(out_dir, "variants-by-group.json"), "w") as f:
        json.dump(amb, f, separators=(",", ":"), sort_keys=True)
    print(f"variants-by-group: {len(amb)} ambiguous groups")
    if not rows:
        # no variant mapping means no group can NAME the SGBD it resolved:
        # that is the feature, so its absence is a failure, not a log line
        failed.append("variants.json")
    return made, failed


def audit_tables(targets):
    """Fail loudly when a shipped table set is missing declared tables.

    The VM reaches tables the lifter never modelled, so "the specs did not
    mention it" is not evidence a table is unused. This audit compares what
    each .prg DECLARES against what was exported -- the check that would
    have caught 523 missing tables corpus-wide instead of one ECU's unit
    column decoding as "".
    """
    import urllib.request
    port = os.environ.get("BMACW_PORT")
    if not port:
        print("audit needs BMACW_PORT")
        return 1
    bad = 0
    tot_decl = tot_ship = 0
    unreachable = []
    for sgbd in targets:
        p = os.path.join(TABLE_DIR, f"{sgbd}.json")
        shipped = set(json.load(open(p))) if os.path.exists(p) else set()
        try:
            listing = json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/ecu/{sgbd}/tables", timeout=60))
        except Exception as e:                              # noqa: BLE001
            # an ECU the engine cannot list is UNAUDITED, not clean --
            # counting it as clean is the same silence this audit exists
            # to break
            unreachable.append(sgbd)
            print(f"  {sgbd:12} UNREACHABLE ({type(e).__name__}: {e})")
            continue
        decl = {(t if isinstance(t, str) else t.get("name"))
                for t in (listing if isinstance(listing, list) else [])}
        decl = {d for d in decl if d}
        up = {x.upper() for x in shipped}
        missing = []
        for d in sorted(decl):
            if d.upper() in up:
                continue
            # A table can be DECLARED and genuinely EMPTY in the .prg
            # (alc_60's FUMWELTMATRIX has zero rows). There is nothing to
            # ship, so that is complete, not missing -- but prove it by
            # reading rather than assuming.
            try:
                if not V.sgbd_table(sgbd, d):
                    continue
            except Exception:                               # noqa: BLE001
                pass
            missing.append(d)
        tot_decl += len(decl)
        tot_ship += len(decl) - len(missing)
        if missing:
            bad += 1
            print(f"  {sgbd:12} missing {len(missing):3} of {len(decl):3}"
                  f"  e.g. {', '.join(missing[:3])}")
    print(f"tables declared {tot_decl}, shipped {tot_ship}"
          f" ({100 * tot_ship / max(tot_decl, 1):.1f}%)"
          f" -- {bad} SGBDs incomplete, {len(unreachable)} unaudited")
    if unreachable:
        print(f"  unaudited: {', '.join(unreachable[:10])}"
              + (" ..." if len(unreachable) > 10 else ""))
    return 1 if bad or unreachable else 0


def coverage(targets):
    """Of the result keys the IR screens display, how many decode?"""
    total = covered = 0
    rows = []
    for sgbd in targets:
        path = os.path.join(SPEC_DIR, f"{sgbd}.json")
        if not os.path.exists(path):
            continue
        specs = json.load(open(path)).get("jobs", {})
        # result name -> decodable, across every job in the SGBD (INPA
        # screens pull results by NAME from whichever job produced them)
        dec_names = {}
        for spec in specs.values():
            for r in spec.get("results", []):
                nm = r.get("name", "").upper()
                dec_names[nm] = dec_names.get(nm) or bool(_decodable(r))
        stems = {sgbd}
        for suf in ("ds0", "ds2", "ds1", "_n", "ds"):
            if sgbd.endswith(suf):
                stems.add(sgbd[:-len(suf)])
        t = c = 0
        misses = {}
        for f in glob.glob(os.path.join(IR_DIR, "*.json")):
            if os.path.basename(f)[:-5].lower() not in stems:
                continue
            ir = json.load(open(f))
            for scr in ir.get("screens", {}).values():
                for line in scr.get("lines", []):
                    for el in (line.get("elements") or []):
                        key = (el.get("key") or "").upper()
                        if not key:
                            continue
                        # JOB_STATUS is produced by every job's validation
                        if key == "JOB_STATUS":
                            t += 1
                            c += 1
                            continue
                        t += 1
                        if dec_names.get(key):
                            c += 1
                        else:
                            misses[key] = misses.get(key, 0) + 1
        if t:
            rows.append((sgbd, c, t, misses))
            total += t
            covered += c
    rows.sort(key=lambda x: x[1] / x[2])
    for sgbd, c, t, misses in rows:
        line = f"  {sgbd:12} {c:5}/{t:<5} ({100*c/t:5.1f}%)"
        if misses:
            top = ", ".join(k for k, _ in sorted(misses.items(),
                                                 key=lambda kv: -kv[1])[:3])
            line += f"  missing: {top}"
        print(line)
    print(f"\nIR screen keys decodable: {covered}/{total} "
          f"({100*covered/max(total,1):.1f}%)")


def all_chassis():
    import urllib.request
    port = os.environ.get("BMACW_PORT")
    return json.load(urllib.request.urlopen(
        f"http://127.0.0.1:{port}/api/chassis", timeout=60))


def chassis_sgbds(chassis):
    import urllib.request
    port = os.environ.get("BMACW_PORT")
    c = json.load(urllib.request.urlopen(
        f"http://127.0.0.1:{port}/api/chassis/{chassis}", timeout=300))
    return sorted({(e.get("sgbd") or "").lower()
                   for s in c.get("sections", [])
                   for e in s.get("ecus", []) if e.get("sgbd")})


def ship(chassis="E46"):
    """Assemble data/ecus/<CHASSIS>/<ECU>/ -- one self-contained folder per
    ECU holding EVERYTHING the web app needs for it:

        ecu.json       identity (code, label, section, sgbd, group)
        screens.json   the decompiled INPA UI (IR)
        jobs.json      the lifted job specs + connection block
        tables.json    the SGBD tables those specs reference
        i18n.json      per-ECU caption translations (hand-written source)
        faults.json    fault-code map (linked by the sgbd it declares)

    plus <CHASSIS>/index.json, the single entry point listing sections and
    their ECUs. Sources stay where their generators put them; this is the
    packaging step, so regenerating any input and re-running --ship keeps
    the tree honest.
    """
    import urllib.request
    port = os.environ.get("BMACW_PORT")
    if not port:
        raise SystemExit("--ship needs BMACW_PORT (chassis config API)")
    cfg = json.load(urllib.request.urlopen(
        f"http://127.0.0.1:{port}/api/chassis/{chassis}", timeout=60))
    # fault maps self-declare the sgbd they cover
    faults_by_sgbd = {}
    for p in glob.glob(os.path.join(ROOT, "data", "faults",
                                    chassis.lower(), "*.json")):
        try:
            faults_by_sgbd[json.load(open(p)).get("sgbd", "").lower()] = p
        except Exception as e:                              # noqa: BLE001
            # a corrupt fault map silently vanishing from ecus/ is data
            # loss with no witness -- name the file so someone can fix it
            print(f"  WARNING: fault map {p} unreadable "
                  f"({type(e).__name__}: {e}) -- skipped")
    root = os.path.join(ROOT, "ecus", chassis)
    os.makedirs(root, exist_ok=True)
    index = {"chassis": chassis, "sections": []}
    no_jobs = []                # ECUs shipped with NO job data at all
    for sec in cfg.get("sections", []):
        entry = {"name": sec["name"], "ecus": []}
        for e in sec.get("ecus", []):
            code = e["code"]
            sgbd = (e.get("sgbd") or "").lower()
            d = os.path.join(root, code)
            os.makedirs(d, exist_ok=True)
            parts = {"ecu": True}

            def put(name, obj):
                with open(os.path.join(d, name + ".json"), "w") as f:
                    json.dump(obj, f, ensure_ascii=False,
                              separators=(",", ":"))
                parts[name] = True

            put("ecu", {"code": code, "label": e.get("label"),
                        "section": sec["name"], "sgbd": sgbd,
                        "group": e.get("group")})
            # the IR is named by IPO stem: the code, or an sgbd stem
            stems = {code.lower(), sgbd}
            for suf in ("ds0", "ds2", "ds1", "_n", "ds"):
                if sgbd.endswith(suf):
                    stems.add(sgbd[:-len(suf)])
            for f in glob.glob(os.path.join(IR_DIR, "*.json")):
                if os.path.basename(f)[:-5].lower() in stems:
                    put("screens", json.load(open(f)))
                    break
            sp = os.path.join(SPEC_DIR, f"{sgbd}.json")
            spec = None
            if sgbd and os.path.exists(sp):
                spec = json.load(open(sp))
            # KEEP THE DATA EVEN WHEN THERE IS NO SCREEN TO SHOW IT ON.
            # Spec lifting is driven by what a screen invokes, so an ECU BMW
            # never drew a UI for lifts zero specs -- 15 of them, marked
            # ScreenCount=0 in BMW's own .ini. They still DECLARE plenty of
            # real work (hud_70 98 jobs, ulf_60 80 including BT_ANTENNA_TEST,
            # elv 13 with FS_LESEN/IDENT), all of it described in the .prg and
            # already exported to data/job-meta. Shipping an empty jobs.json
            # threw that away at the last step. Fall back to the metadata so
            # the job list survives into ecus/ -- INPA shows no screen for
            # these and neither do we, but the data is there to drive one.
            if not (spec or {}).get("jobs"):
                meta = ET.read_ecu(sgbd, "meta.json") if sgbd else None
                if meta:
                    if meta.get("jobs"):
                        spec = {"format": 1, "sgbd": sgbd,
                                "source": "job-meta",
                                "jobs": meta["jobs"]}
            if spec:
                put("jobs", spec)
            tp = os.path.join(TABLE_DIR, f"{sgbd}.json")
            if sgbd and os.path.exists(tp):
                put("tables", json.load(open(tp)))
            for f in glob.glob(os.path.join(ROOT, "data", "inpa-i18n",
                                            "*.json")):
                if os.path.basename(f)[:-5].lower() in stems:
                    put("i18n", json.load(open(f)))
                    break
            if sgbd in faults_by_sgbd:
                put("faults", json.load(open(faults_by_sgbd[sgbd])))
            entry["ecus"].append({"code": code, "label": e.get("label"),
                                  "parts": sorted(k for k, v in parts.items()
                                                  if v)})
            missing = [k for k in ("screens", "jobs") if k not in parts]
            note = f"  MISSING {','.join(missing)}" if missing else ""
            print(f"  {code:12} {' '.join(sorted(parts))}{note}")
            # missing SCREENS can be BMW's own doing (the ScreenCount=0
            # ECUs above never had a UI); missing JOBS after the job-meta
            # fallback means neither specs nor metadata exist -- that ECU
            # shipped as an empty shell, which is a failure to aggregate,
            # not a line to scroll past
            if "jobs" in missing:
                no_jobs.append(f"{chassis}/{code}")
        index["sections"].append(entry)
    with open(os.path.join(root, "index.json"), "w") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    total = sum(os.path.getsize(os.path.join(dp, fn))
                for dp, _, fns in os.walk(root) for fn in fns)
    print(f"shipped {root}: {total//1024} KB")
    return no_jobs


def main():
    argv = sys.argv[1:]
    allow_partial = "--allow-partial" in argv
    # --ship's chassis names are ARGUMENTS TO --SHIP, not SGBDs. They used
    # to fall through into the target list too, so `--ship E46 --specs`
    # also tried to extract an SGBD called "e46" -- carve them out before
    # any mode reads targets. (The heuristic matches ship()'s old one: all
    # caps, four chars or fewer, which no SGBD name on disk is.)
    ship_chassis = []
    if "--ship" in argv:
        ship_chassis = [a for a in argv if not a.startswith("--")
                        and a.upper() == a and len(a) <= 4]
    targets = [a.lower() for a in argv
               if not a.startswith("--") and a not in ship_chassis]
    if not targets:
        if "--all-chassis" in argv:
            # ecu_tree.all_sgbds(), not the menu. A chassis config lists the
            # variants INPA offers; owners() adds every variant a group can
            # IDENTIFY (see ecu_tree.group_variants), and those are exactly
            # the ones a car reports for itself -- gs20, mrs4, ews3 and the
            # rest were all present on a real E46 and none was in the menu,
            # so none was exported and the sweep could only say
            # "not in build". Falls back to the menu union if the tree
            # module is unavailable for any reason.
            targets = sorted(ET.all_sgbds() or {g for ch in all_chassis()
                                                for g in chassis_sgbds(ch)})
            if "--force" not in argv:
                # keep what an earlier run already extracted
                targets = [t for t in targets if not os.path.exists(
                    os.path.join(SPEC_DIR, f"{t}.json"))]
        else:
            targets = S.e46_sgbds()
    # every mode runs to completion and REPORTS here rather than aborting:
    # a partial artifact you know about beats one you find in production.
    # (dist-web and the wiring both shipped broken from exporters that
    # printed WARNING and exited 0 -- this list is what ends that.)
    failures = []
    if "--specs" in argv:
        conn_failed = export_specs(targets)
        if conn_failed:
            failures.append("specs: connection discovery FAILED for "
                            f"{len(conn_failed)} SGBDs "
                            f"({', '.join(conn_failed[:10])}"
                            + (" ...)" if len(conn_failed) > 10 else ")"))
    if "--tables" in argv:
        no_listing, dropped = export_tables(targets)
        if no_listing:
            failures.append(f"tables: listing failed for {len(no_listing)} "
                            "SGBDs, only spec-referenced tables exported "
                            f"({', '.join(no_listing[:10])}"
                            + (" ...)" if len(no_listing) > 10 else ")"))
        if dropped:
            failures.append(f"tables: {dropped} declared tables failed to "
                            "fetch and were dropped")
    if "--coverage" in argv:
        coverage(targets)          # a measurement, not an artifact
    if "--groups" in argv:
        _, grp_failed = export_groups()
        if grp_failed:
            failures.append(f"groups: {len(grp_failed)} groups failed to "
                            f"export ({', '.join(grp_failed[:10])}"
                            + (" ...)" if len(grp_failed) > 10 else ")"))
    if "--audit" in argv:
        return audit_tables(targets)
    if "--ship" in argv:
        for ch in (ship_chassis or all_chassis()):
            print(f"[{ch}]")
            try:
                no_jobs = ship(ch)
            except Exception as e:                          # noqa: BLE001
                # keep shipping the OTHER chassis -- but a chassis that
                # died half-written is a failed export, not a log line
                print(f"  {ch}: FAILED {type(e).__name__}: {e}")
                failures.append(f"ship: {ch} FAILED ({type(e).__name__}: {e})")
                continue
            if no_jobs:
                failures.append(f"ship: {len(no_jobs)} ECUs shipped with no "
                                f"job data ({', '.join(no_jobs[:10])}"
                                + (" ...)" if len(no_jobs) > 10 else ")"))
    if len(sys.argv) < 2:
        print(__doc__)
    if failures:
        print("\nEXPORT INCOMPLETE:")
        for f in failures:
            print(f"  - {f}")
        if allow_partial:
            print("continuing anyway (--allow-partial)")
            return 0
        print("exiting 1; pass --allow-partial to accept a partial export")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
