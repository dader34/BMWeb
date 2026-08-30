#!/usr/bin/env python3
"""Restore the header row of tables the dumper filed under COLUMN0..n.

Diag.TableRows looked for the header as "the first row with no digits" --
so a real header such as ORT, UW1_NR, UW2_NR, UW3_NR, UW4_NR was refused,
`head` stayed on the blank leading set, every column was named COLUMNn and
the true header was kept as data row 0. EDIABAS itself has no heuristic:
the first row IS the header (EdiabasNet.IndexTable, j == 0).

Because that row survived as row 0, the repair is exact: for a table whose
keys are all COLUMNn and whose row 0 is a full row of non-numeric names,
rekey rows 1..n by row 0. Anything else is left alone and listed.

    tools/sgbd/repair_table_headers.py            # dry run: what would change
    tools/sgbd/repair_table_headers.py --write    # rewrite data/ecu-src in place
"""
import glob, gzip, json, os, re, sys

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
SRC = os.path.join(ROOT, "data", "ecu-src")
DATAISH = re.compile(r"^(0x[0-9a-f]+|[-+]?\d+([.,]\d+)?|-+|)$", re.I)


def generic(keys):
    return bool(keys) and all(re.fullmatch(r"COLUMN\d+", k) for k in keys)


def repair(rows):
    """rows -> (fixed rows | None, reason)"""
    if not rows:
        return None, "empty"
    keys = list(rows[0].keys())
    if not generic(keys):
        return None, "named"
    head = [rows[0].get(f"COLUMN{i}", "") for i in range(len(keys))]
    # every cell named, and the FIRST one a name rather than a value. Later
    # cells may legitimately look like values: FORTMATRIX heads its bit
    # columns "ORT, 0x00, 0x01, ..." and that is the header, not a row.
    if any(not h for h in head) or DATAISH.match(head[0]):
        return None, f"row0 not a header: {head}"
    if len(set(h.upper() for h in head)) != len(head):
        return None, f"duplicate header names: {head}"
    out = []
    for r in rows[1:]:
        out.append({head[i]: r.get(f"COLUMN{i}", "") for i in range(len(head))})
    return out, "fixed"


def main():
    write = "--write" in sys.argv
    n_files = n_tables = n_rows = 0
    skipped = {}
    by_table = {}
    for f in sorted(glob.glob(os.path.join(SRC, "*.tables.json.gz"))):
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            tables = json.load(fh)
        changed = False
        for name, rows in tables.items():
            if not isinstance(rows, list) or not rows or not generic(list(rows[0].keys())):
                continue
            fixed, why = repair(rows)
            if fixed is None:
                skipped.setdefault(why[:40], []).append(f"{os.path.basename(f)}:{name}")
                continue
            tables[name] = fixed
            changed = True
            n_tables += 1
            n_rows += len(fixed)
            by_table[name.upper()] = by_table.get(name.upper(), 0) + 1
        if changed:
            n_files += 1
            if write:
                with gzip.open(f, "wt", encoding="utf-8") as fh:
                    json.dump(tables, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"{'rewrote' if write else 'would rewrite'} {n_tables} tables in {n_files} SGBDs ({n_rows} rows)")
    for k, v in sorted(by_table.items(), key=lambda kv: -kv[1])[:15]:
        print(f"  {k:24s} {v}")
    for why, items in skipped.items():
        print(f"  left alone ({why}): {len(items)}  e.g. {items[:3]}")


if __name__ == "__main__":
    main()
