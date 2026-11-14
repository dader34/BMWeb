#!/usr/bin/env python3
"""Pack an offline build's data: each file once, like beside like, in zstd packs.

    python3 scripts/build/pack_offline.py <site dir> <out dir>

e.g. dist-web  release-builds/packed

An offline build carries every car, and the per-car archives it is made of
repeat themselves. THE ECUS: api/chassis/*.chassis hold 4,081 ECU archives
of which 1,415 are distinct, each deflated alone, 486 MB of a 1 GB download.
Stored once, laid end to end by name so that a variant sits beside the ECU
it varies, and compressed as zstd frames with a 32 MB window, they are a
sixth of that.

WHAT THIS WRITES, under <out dir>, as an OVERLAY for a staged copy of the
site (scripts/build/offline-build.mjs lays it over each variant):

    api/ecu-packs/index.json    which car has which ECU, and where each is
    api/ecu-packs/ecu-NNN.zst   the packs
    replaced.json               the site's files the overlay takes the place
                                of, to be left out of the build

The app reads these with core/packs.js and its own zstd decoder
(vendor/fzstd.js); core/webshim/api-router.js is the reader for the ECUs.
The site dir itself is not touched, and the hosted site does not use packs:
a hosted reader fetches one car's archive, and a pack is a slice of every car.

THE INDEX
    {"version": 1,
     "packs": ["ecu-000.zst", ...],  "raw": [unpacked bytes, ...],
     "ecus": [[pack, offset, length, crc32], ...],
     "chassis": {"E46": {"config": [pack, offset, length, crc32],
                         "ecus": {"<sgbd>": <number in "ecus">, ...}}, ...}}

THE PARTS CATALOGUE (data/etk/*.etk, 6 GB, the complete build only) is
mostly pictures, and a picture is in the bundle of every car that uses the
part: 177,878 pictures, 42,506 distinct, 6.6 GB for 1.4 GB. Pictures do not
compress, so they are not packed: each is written ONCE, as a plain file,
under data/etk/img/<first two characters of its name>/<name>, and the app
shows it by its address like any image. (One name is one picture across
every car; that is checked here, and it is what lets them be shared.) A
car's tree.json, with a list of the pictures its bundle held (img.json) and
its side files, goes into packs under data/etk/packs like the rest.

THE PLAIN DATA FILES the app fetches one at a time (the WinKFP scripts and
their SGBDs in data/kfp, the coding data, the group files, ISTA's technical
data and tables: FILE_SETS) go the same way, into data/packs, as ONE list
named "site" whose members are their paths in the site. The app's own file
fetch answers those paths out of the packs (core/webshim/api-router.js
packedFilesFetch), so no reader of them changes.

THE WIRING ARCHIVES (data/wiring/*.wiring, 159 MB) and THE DOCUMENT ARCHIVES
(data/docs/*.docs) are packed the same way as the ISTA bundles below, into
data/wiring/packs and data/docs/packs: a car's schematics are mostly the
next model year's.

THE ISTA BUNDLES (data/ista/bundles/*.ista, 324 MB) are the same story one
level down: a car's test modules, diagnosis documents and schematics, most
of them shared with other cars or one edit away from another car's, every
one gzipped alone. Their members are stored once, UNZIPPED, like beside
like:

    data/ista/packs/index.json     {"version", "packs", "raw",
                                    "archives": {"E46.ista": [list file,
                                                 its length, its crc32]}}
    data/ista/packs/E46.idx.zst    that car's members, as zstd'd JSON:
                                   {"abl/X.json.gz": [pack, offset, length,
                                                      crc32, was gzipped]}
    data/ista/packs/ista-NNN.zst   the packs

A member that was gzipped is kept as what it unzips to, and the app hands
it on re-wrapped (a stored gzip, which costs nothing to make or to undo):
what a reader gunzips is byte for byte what it always got.

AN ECU IN A PACK IS ITS OWN ARCHIVE WITH THE MEMBERS STORED, not deflated:
the same names and the same bytes, so the app unzips it exactly as it does
the original, and zstd sees the JSON instead of 60 small deflate streams.

THE 32 MB WINDOW (--long=25) is the decoder's limit, not a tuning choice:
fzstd gets a match offset of 64 MB or more wrong. See vendor/fzstd.js.

Everything written is read back here (with the zstd command) and compared
with the original, member by member. That the APP's decoder reads it too is
scripts/build/verify_packs.mjs's check.
"""
import argparse
import glob
import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor

# unpacked bytes per pack: what opening one ECU costs (one pack is unpacked
# whole), against how much of its neighbours a file can be matched with
PACK_RAW = 32 * 1024 * 1024
WINDOW_LOG = 25


def zstd(data):
    """One zstd frame that says how long its content is."""
    done = subprocess.run(
        ["zstd", "-q", "-19", f"--long={WINDOW_LOG}", "-T1", f"--stream-size={len(data)}", "-c"],
        input=data, stdout=subprocess.PIPE, check=True)
    return done.stdout


def unzstd(data):
    done = subprocess.run(["zstd", "-q", "-d", f"--long={WINDOW_LOG}", "-c"],
                          input=data, stdout=subprocess.PIPE, check=True)
    return done.stdout


def members(blob):
    """An archive's members, in its order: [(name, bytes)]."""
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        return [(i.filename, z.read(i)) for i in z.infolist() if not i.is_dir()]


def stored(blob):
    """The same archive with every member stored, and nothing that varies
    from one build to the next (dates, attributes)."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
        for name, data in members(blob):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0
            z.writestr(info, data)
    return out.getvalue()


def write_packs(dest, prefix, blobs, jobs):
    """Lay blobs end to end into packs of about PACK_RAW and write them.

    blobs: [(key, bytes)] in the order they are to lie. Returns
    (pack names, their unpacked lengths, their packed lengths,
     {key: [pack, offset, length, crc32]}).
    """
    groups, group, held = [], [], 0
    for item in blobs:
        if group and held + len(item[1]) > PACK_RAW:
            groups.append(group)
            group, held = [], 0
        group.append(item)
        held += len(item[1])
    if group:
        groups.append(group)
    os.makedirs(dest, exist_ok=True)
    for old in glob.glob(os.path.join(dest, "*")):
        os.remove(old)

    def write(job):
        n, group = job
        raw = b"".join(data for _, data in group)
        packed = zstd(raw)
        # read it back before anything relies on it
        if unzstd(packed) != raw:
            raise SystemExit(f"error: pack {prefix}-{n} does not unpack to what went in")
        name = f"{prefix}-{n:03d}.zst"
        with open(os.path.join(dest, name), "wb") as f:
            f.write(packed)
        return name, len(raw), len(packed)

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        written = list(pool.map(write, enumerate(groups)))
    where = {}
    for n, group in enumerate(groups):
        offset = 0
        for key, data in group:
            where[key] = [n, offset, len(data), zlib.crc32(data) & 0xFFFFFFFF]
            offset += len(data)
    return [w[0] for w in written], [w[1] for w in written], [w[2] for w in written], where


def take(data):
    """A member as it is kept: (its bytes, unzipped if it was gzipped, 1 if so)."""
    if data[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(data), 1
        except (OSError, EOFError, zlib.error):
            pass      # only looked like gzip: kept as it is
    return data, 0


def pack_lists(out, dest_rel, prefix, label, lists, before, jobs):
    """Pack named lists of members: each distinct member once, like beside
    like, and per list a file saying where its members are.

    lists: {list name: {member name: bytes}}; `before` is what they weighed
    in the site, for the report.
    """
    unique = {}       # content -> (a name it goes by, its bytes)
    placed = {}       # list -> {member: (content, was gzipped)}
    refs = 0
    for name, mine in lists.items():
        placed[name] = {}
        for member, data in mine.items():
            data, gz = take(data)
            key = hashlib.blake2b(data, digest_size=16).digest()
            unique.setdefault(key, (member, data))
            placed[name][member] = (key, gz)
            refs += 1

    def like(item):
        # the same kind of thing, then the same document's name, so one
        # car's copy of a schematic lies beside the next car's
        name, data = item[1]
        folder, _, leaf = name.rpartition("/")
        stem, _, ext = leaf.partition(".")
        return (folder, ext, stem, len(data), item[0])

    order = sorted(unique.items(), key=like)
    dest = os.path.join(out, *dest_rel.split("/"))
    names, raw, packed, where = write_packs(
        dest, prefix, [(key, data) for key, (_, data) in order], jobs)

    index = {"version": 1, "packs": names, "raw": raw, "archives": {}}
    listed = 0
    for name, mine in sorted(placed.items()):
        body = json.dumps({member: where[key] + ([1] if gz else [])
                           for member, (key, gz) in sorted(mine.items())},
                          separators=(",", ":")).encode()
        packed_list = zstd(body)
        if unzstd(packed_list) != body:
            raise SystemExit(f"error: the list for {name} does not unpack to itself")
        fname = name.rsplit(".", 1)[0] + ".idx.zst"
        with open(os.path.join(dest, fname), "wb") as f:
            f.write(packed_list)
        index["archives"][name] = [fname, len(body), zlib.crc32(body) & 0xFFFFFFFF]
        listed += len(packed_list)
    with open(os.path.join(dest, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, separators=(",", ":"))

    after = sum(packed) + listed + os.path.getsize(os.path.join(dest, "index.json"))
    print(f"  {label}: {refs} files, {len(order)} distinct, {sum(raw) / 1e6:.0f} MB unpacked; "
          f"{before / 1e6:.0f} MB -> {after / 1e6:.0f} MB in {len(names)} packs", flush=True)


def pack_archives(site, out, pattern, dest_rel, prefix, label, jobs):
    """A set of zip archives as packs of their members. Returns the site
    files they replace ([] when the site has none of them)."""
    archives = sorted(glob.glob(os.path.join(site, *pattern.split("/"))))
    if not archives:
        print(f"  {label}: none in this site")
        return []
    lists = {os.path.basename(path): dict(members(open(path, "rb").read()))
             for path in archives}
    pack_lists(out, dest_rel, prefix, f"{label} ({len(archives)})", lists,
               sum(os.path.getsize(p) for p in archives), jobs)
    return [os.path.relpath(p, site).replace(os.sep, "/") for p in archives]


# Plain data files the app fetches one at a time, by folder (or one file).
# Only what every reader takes through fetch: a file a <script> or an <img>
# names has to stay a file.
FILE_SETS = (
    "data/kfp", "data/daten", "data/coding-dispatch", "data/groups",
    "data/ista/techdata", "data/ista/ecufn", "data/ista/ecu-tree",
    "data/ista/faulttests.json",
    # the ISTA pages' own extracts: layouts, structure trees and document
    # bodies, search indexes, fault code lists, test plans, unit names
    "data/ista/xaml", "data/ista/infotree", "data/ista/search",
    "data/ista/faultcodes", "data/ista/testplan", "data/ista/ecu-names",
)


def pack_files(site, out, jobs):
    """The plain data files, as one list ("site") keyed by their site paths.
    Returns the site files it replaces."""
    paths = []
    for rel in FILE_SETS:
        top = os.path.join(site, *rel.split("/"))
        if os.path.isfile(top):
            paths.append(top)
        for folder, _, names in os.walk(top):
            paths += [os.path.join(folder, n) for n in names]
    paths = sorted(p for p in paths if f"{os.sep}packs{os.sep}" not in p)
    if not paths:
        print("  data files: none in this site")
        return []
    rels = [os.path.relpath(p, site).replace(os.sep, "/") for p in paths]
    lists = {"site": {rel: open(p, "rb").read() for rel, p in zip(rels, paths)}}
    pack_lists(out, "data/packs", "files", "data files", lists,
               sum(os.path.getsize(p) for p in paths), jobs)
    return rels


# The parts catalogue's side files, fetched one at a time beside a car's
# bundle (its line validity, its filter rules, its callout rectangles).
ETK_SIDE_FILES = ("*.lines.json.gz", "*.rules.json.gz", "*.hs.json.gz")


def pack_etk(site, out, jobs):
    """The parts catalogue: each picture once, as a file; each car's tree
    and side files in packs. Returns the site files replaced."""
    folder = os.path.join(site, "data", "etk")
    archives = sorted(glob.glob(os.path.join(folder, "*.etk")))
    if not archives:
        print("  parts catalogue: none in this site")
        return []
    img_dir = os.path.join(out, "data", "etk", "img")
    if os.path.isdir(img_dir):
        shutil.rmtree(img_dir)
    seen = {}         # picture name -> (crc32, length) of the one written
    lists = {}        # archive -> {member: bytes}
    refs = pictures = 0
    for path in archives:
        mine = {}
        names = []
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                name = info.filename
                if not name.startswith("img/"):
                    mine[name] = z.read(info)
                    continue
                leaf = name[4:]
                if "/" in leaf or leaf in (".", ".."):
                    raise SystemExit(f"error: {path}: a picture path the catalogue "
                                     f"has no place for: {name}")
                names.append(leaf)
                refs += 1
                same = (info.CRC, info.file_size)
                if leaf in seen:
                    # ONE NAME, ONE PICTURE is what lets every car share the
                    # file. It holds for all 42,508 names in the catalogue;
                    # if it ever does not, say so rather than show one car
                    # another car's drawing.
                    if seen[leaf] != same:
                        raise SystemExit(
                            f"error: {os.path.basename(path)} has a different picture "
                            f"under the name {leaf} than an earlier car; the "
                            "catalogue's pictures can no longer be shared by name")
                    continue
                seen[leaf] = same
                data = z.read(info)
                dest = os.path.join(img_dir, etk_shard(leaf))
                os.makedirs(dest, exist_ok=True)
                with open(os.path.join(dest, leaf), "wb") as f:
                    f.write(data)
                pictures += len(data)
        if "tree.json" not in mine:
            raise SystemExit(f"error: {path} has no tree.json")
        # which pictures this car's bundle held: the app answers "no such
        # picture" for any other, as the bundle did
        mine["img.json"] = json.dumps(sorted(names), separators=(",", ":")).encode()
        lists[os.path.basename(path)] = mine

    sides = sorted(p for pat in ETK_SIDE_FILES for p in glob.glob(os.path.join(folder, pat)))
    if sides:
        lists["site"] = {os.path.relpath(p, site).replace(os.sep, "/"): open(p, "rb").read()
                         for p in sides}
    replaced = archives + sides
    before = sum(os.path.getsize(p) for p in replaced)
    print(f"  parts catalogue: {refs} pictures in {len(archives)} bundles, {len(seen)} distinct, "
          f"{pictures / 1e6:.0f} MB, each now one file under data/etk/img", flush=True)
    pack_lists(out, "data/etk/packs", "etk",
               f"parts catalogue trees and side files (with {pictures / 1e6:.0f} MB of pictures)",
               lists, before - 0, jobs)
    return [os.path.relpath(p, site).replace(os.sep, "/") for p in replaced]


def etk_shard(leaf):
    """The folder a catalogue picture is kept in: its name's first two
    characters, lower-cased (the app computes the same: screens/etk/data.mjs)."""
    head = leaf[:2].lower()
    return head if len(head) == 2 and all(c.isalnum() for c in head) else "_"


def pack_ecus(site, out, jobs):
    """The ECU packs. Returns the site files they replace."""
    archives = sorted(glob.glob(os.path.join(site, "api", "chassis", "*.chassis")))
    if not archives:
        raise SystemExit(f"error: no .chassis archives in {site}/api/chassis")
    unique = {}      # content -> (sgbd, the original .ecu bytes)
    chassis = {}     # id -> (config.json bytes, {sgbd: content})
    refs = 0
    for path in archives:
        cid = os.path.basename(path)[:-len(".chassis")]
        config, ecus = None, {}
        for name, data in members(open(path, "rb").read()):
            if name == "config.json":
                config = data
            elif name.startswith("ecu/") and name.endswith(".ecu"):
                key = hashlib.blake2b(data, digest_size=16).digest()
                sgbd = name[4:-4].lower()
                unique.setdefault(key, (sgbd, data))
                ecus[sgbd] = key
                refs += 1
            else:
                raise SystemExit(f"error: {path}: a member the packs have no place for: {name}")
        if config is None:
            raise SystemExit(f"error: {path} has no config.json")
        chassis[cid] = (config, ecus)

    # like beside like: by name, so ms450ds0 sits beside ms451ds0
    order = sorted(unique.items(), key=lambda kv: (kv[1][0], len(kv[1][1]), kv[0]))
    # the configs first, in a pack of their own kind
    blobs = [("config", cid, chassis[cid][0]) for cid in sorted(chassis)]
    for key, (sgbd, data) in order:
        blob = stored(data)
        # the stored archive must hold exactly what the original did
        if members(blob) != members(data):
            raise SystemExit(f"error: {sgbd} changed when its members were stored")
        blobs.append(("ecu", key, blob))

    dest = os.path.join(out, "api", "ecu-packs")
    names, raw, packed, where = write_packs(
        dest, "ecu", [((kind, key), data) for kind, key, data in blobs], jobs)
    number = {key: i for i, (key, _) in enumerate(order)}
    index = {
        "version": 1,
        "packs": names,
        "raw": raw,
        "ecus": [where[("ecu", key)] for key, _ in order],
        "chassis": {
            cid: {"config": where[("config", cid)],
                  "ecus": {sgbd: number[key] for sgbd, key in sorted(ecus.items())}}
            for cid, (_, ecus) in sorted(chassis.items())},
    }
    with open(os.path.join(dest, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, separators=(",", ":"))

    before = sum(os.path.getsize(p) for p in archives)
    after = sum(packed) + os.path.getsize(os.path.join(dest, "index.json"))
    print(f"  ECUs: {refs} in {len(archives)} archives, {len(order)} distinct, "
          f"{sum(raw) / 1e6:.0f} MB of JSON; "
          f"{before / 1e6:.0f} MB of archives -> {after / 1e6:.0f} MB in {len(names)} packs")
    return [os.path.relpath(p, site).replace(os.sep, "/") for p in archives]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("site", help="the built site (dist-web)")
    ap.add_argument("out", help="where the overlay goes")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--only",
                    help="pack only these, comma separated: "
                         "ecus, ista, wiring, docs, files, etk")
    ns = ap.parse_args()
    if subprocess.run(["zstd", "--version"], capture_output=True).returncode != 0:
        raise SystemExit("error: the zstd command is needed (brew/apt install zstd)")
    os.makedirs(ns.out, exist_ok=True)
    only = set(ns.only.split(",")) if ns.only else None
    replaced = []
    if not only or "ecus" in only:
        replaced += pack_ecus(ns.site, ns.out, ns.jobs)
    if not only or "ista" in only:
        replaced += pack_archives(ns.site, ns.out, "data/ista/bundles/*.ista",
                                  "data/ista/packs", "ista", "ISTA bundles", ns.jobs)
    if not only or "wiring" in only:
        replaced += pack_archives(ns.site, ns.out, "data/wiring/*.wiring",
                                  "data/wiring/packs", "wiring", "wiring archives", ns.jobs)
    if not only or "docs" in only:
        replaced += pack_archives(ns.site, ns.out, "data/docs/*.docs",
                                  "data/docs/packs", "docs", "document archives", ns.jobs)
    if not only or "files" in only:
        replaced += pack_files(ns.site, ns.out, ns.jobs)
    if not only or "etk" in only:
        replaced += pack_etk(ns.site, ns.out, ns.jobs)
    with open(os.path.join(ns.out, "replaced.json"), "w", encoding="utf-8") as f:
        json.dump(sorted(replaced), f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
