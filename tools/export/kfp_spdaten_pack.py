#!/usr/bin/env python3
"""Pack WebKFP's SP-Daten small enough to ship.

    python3 tools/export/kfp_spdaten_pack.py <sp-daten dir> <out dir>
    python3 tools/export/kfp_spdaten_pack.py <sp-daten dir> <out dir> --only E46,E39
    python3 tools/export/kfp_spdaten_pack.py <sp-daten dir> <out dir> --verify

e.g. ~/Development/code/BMWFILES/sp-daten  ~/Development/code/BMWFILES/sp-daten-packed

The loose layout (kfp_spdaten.py) is one file per file, unchanged. That is
22,508 files and 40 GB, which no offline build can carry and which an
anonymous client cannot even fetch without being rate limited.

WHY IT PACKS SO WELL. A program or data file is Intel HEX text, and a
module's folder holds every released version of it: dozens of files that are
mostly the same bytes, often SHIFTED (a recompiled program moves everything
after the change). Three things, in this order of effect:

  1. THE HEX IS TAKEN APART. Each record line ":LLAAAATT<data>CC" becomes its
     data bytes, appended to one PAYLOAD stream, and one byte of SKELETON
     saying "the next record, where the last one ended, same length". The
     address and checksum that made every line differ from its twin in the
     next version are gone: the payload is the module's memory image, and
     two versions of it are long identical runs wherever they agree, however
     the lines fell. Comment lines and anything that is not a clean record
     stay in the skeleton as they are.
  2. THE PAYLOADS OF A MODULE'S VERSIONS ARE COMPRESSED TOGETHER, with a
     32 MB window (zstd --long=25), so each version costs only what is new
     in it.
  3. THE SAME FILE UNDER SEVERAL CHASSIS IS KEPT ONCE (15 GB of the 40).

WHAT DOES NOT PACK. A dozen families are head-unit, navigation and telephone
images: firmware that is already compressed, hundreds of megabytes a file,
so neither the split nor the window finds anything, and a gigabyte is a
gigabyte. --skip leaves them out (they stay in the loose set, which WebKFP
still reads online). Everything else, 546 families, is under 1 GB.

A file comes back exactly: every record is rebuilt as upper-case hex with
its checksum recomputed, which is only done for a line that was written
that way (anything else is kept verbatim), and --verify unpacks every file
of every pack and compares it with the original byte for byte.

THE 32 MB WINDOW IS DELIBERATE. The browser's decoder (fzstd) reads a match
offset through 32 bits and gets offsets of 64 MB and more wrong, silently.
A window of 2^25 keeps every offset under that, and costs nothing here: a
version's twin is the file before it, a megabyte or two back.

THE LAYOUT

    <out>/index.json            the loose index, plus where each file is:
                                  "packs": ["GD20.0.spk", ...]
                                  "sizes": [its bytes, ...]
                                  "leftOut": [families --skip left out]
                                  per module, per chassis:
                                  "at": {"<file>": [pack number, place in it]}
    <out>/packs/<MODULE>.<n>.spk

A module's files are split over packs of about PACK_BYTES of original text,
so reading one file never means unpacking a whole gigabyte module.

A PACK
    "BSPK2\\n"
    u32 LE   length of the header
    header   JSON: {"files": [{"name", "size", "crc",
                               "sk": [start, length], "pay": [start, length]}...],
                    "skel": [packed length, length],
                    "pay":  [packed length, length]}
             crc is the CRC-32 of the file; sk and pay are its part of each
             stream once unpacked
    skeleton one zstd frame
    payload  one zstd frame

THE SKELETON of a file is one op per line, the lines joined by "\\n":
    0                      a record that follows the last: same length and
                           type, at the address where the last one ended,
                           ending in a carriage return or not as the last did
    1 LL AH AL TT CR       a record, given in full
    2 varint(n) n bytes    a line kept as it is (its carriage return too)
    3                      the whole file is its payload, as it is (a file
                           that is not hex at all)
A record takes its LL data bytes from the payload, in order.
"""
import argparse
import binascii
import hashlib
import json
import os
import struct
import subprocess
import sys
import zlib
from concurrent.futures import ProcessPoolExecutor

MAGIC = b"BSPK2\n"
# original text per pack: what one read costs a browser in memory and time
PACK_BYTES = 160 * 1024 * 1024
HEX = set(b"0123456789ABCDEF")
# 2^25: every match offset stays below what the browser's decoder reads right
WINDOW_LOG = 25


def varint(n, out):
    while n >= 128:
        out.append(n & 127 | 128)
        n >>= 7
    out.append(n)


def split(data):
    """One file as (skeleton, payload)."""
    sk = bytearray()
    pay = bytearray()
    pl = pa = pt = pcr = -1
    for ln in data.split(b"\n"):
        cr = 1 if ln.endswith(b"\r") else 0
        body = ln[:-1] if cr else ln
        rec = None
        # a clean record: upper-case hex, its length byte true, its checksum right
        if len(body) >= 11 and body[:1] == b":" and len(body) % 2 == 1 and HEX.issuperset(body[1:]):
            b = binascii.unhexlify(body[1:])
            if b[0] == len(b) - 5 and (sum(b) & 0xFF) == 0:
                rec = b
        if rec is not None:
            length, addr, kind = rec[0], (rec[1] << 8) | rec[2], rec[3]
            if length == pl and kind == pt and cr == pcr and addr == ((pa + pl) & 0xFFFF):
                sk.append(0)
            else:
                sk += bytes([1, length, rec[1], rec[2], kind, cr])
            pay += rec[4:-1]
            pl, pa, pt, pcr = length, addr, kind, cr
        else:
            sk.append(2)
            varint(len(ln), sk)
            sk += ln
    # not a hex file (the records are not most of it): keep it whole, in the
    # payload, where the long window is
    if len(pay) * 8 < len(data):
        return b"\x03", data
    return bytes(sk), bytes(pay)


def join(sk, pay, size):
    """The file a skeleton and its payload spell. The reference for the JS reader."""
    if sk == b"\x03":
        return bytes(pay)
    out = bytearray()
    i = p = 0
    pl = pa = pt = pcr = -1
    first = True
    while i < len(sk):
        op = sk[i]
        i += 1
        if not first:
            out.append(10)
        first = False
        if op in (0, 1):
            if op == 1:
                length, addr, kind, cr = sk[i], (sk[i + 1] << 8) | sk[i + 2], sk[i + 3], sk[i + 4]
                i += 5
            else:
                length, addr, kind, cr = pl, (pa + pl) & 0xFFFF, pt, pcr
            rec = bytes([length, addr >> 8, addr & 0xFF, kind]) + pay[p:p + length]
            p += length
            rec += bytes([(-sum(rec)) & 0xFF])
            out += b":" + binascii.hexlify(rec).upper()
            if cr:
                out.append(13)
            pl, pa, pt, pcr = length, addr, kind, cr
        elif op == 2:
            n = shift = 0
            while True:
                b = sk[i]
                i += 1
                n |= (b & 127) << shift
                if b < 128:
                    break
                shift += 7
            out += sk[i:i + n]
            i += n
        else:
            raise ValueError("bad skeleton")
    if len(out) != size:
        raise ValueError("unpacked to the wrong length")
    return bytes(out)


def zstd(data, long_window):
    """One zstd frame that says how long its content is."""
    args = ["zstd", "-q", "-19", "-T1", f"--stream-size={len(data)}", "-c"]
    if long_window:
        args.insert(3, f"--long={WINDOW_LOG}")
    done = subprocess.run(args, input=data, stdout=subprocess.PIPE, check=True)
    return done.stdout


def unzstd(data):
    done = subprocess.run(["zstd", "-q", "-d", f"--long={WINDOW_LOG}", "-c"],
                          input=data, stdout=subprocess.PIPE, check=True)
    return done.stdout


def encode(paths):
    """The pack for some files, as bytes. paths: [(name, path)]."""
    skel = bytearray()
    pay = bytearray()
    files = []
    for name, path in paths:
        with open(path, "rb") as f:
            data = f.read()
        sk, body = split(data)
        files.append({"name": name, "size": len(data),
                      "crc": zlib.crc32(data) & 0xFFFFFFFF,
                      "sk": [len(skel), len(sk)], "pay": [len(pay), len(body)]})
        skel += sk
        pay += body
    zs = zstd(bytes(skel), False)
    zp = zstd(bytes(pay), True)
    header = json.dumps({"files": files, "skel": [len(zs), len(skel)],
                         "pay": [len(zp), len(pay)]}, separators=(",", ":")).encode()
    return MAGIC + struct.pack("<I", len(header)) + header + zs + zp


def decode(pack):
    """Every file of a pack: [(name, bytes)]."""
    if pack[:len(MAGIC)] != MAGIC:
        raise ValueError("not a pack")
    at = len(MAGIC)
    (hlen,) = struct.unpack_from("<I", pack, at)
    at += 4
    header = json.loads(pack[at:at + hlen])
    at += hlen
    skel = unzstd(pack[at:at + header["skel"][0]])
    pay = unzstd(pack[at + header["skel"][0]:at + header["skel"][0] + header["pay"][0]])
    if len(skel) != header["skel"][1] or len(pay) != header["pay"][1]:
        raise ValueError("a stream unpacked to the wrong length")
    out = []
    for f in header["files"]:
        data = join(skel[f["sk"][0]:f["sk"][0] + f["sk"][1]],
                    pay[f["pay"][0]:f["pay"][0] + f["pay"][1]], f["size"])
        if zlib.crc32(data) & 0xFFFFFFFF != f["crc"]:
            raise ValueError(f"{f['name']}: unpacked wrong")
        out.append((f["name"], data))
    return out


def digest(path):
    h = hashlib.blake2b(digest_size=16)
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.digest()


def pack_module(job):
    """One module family over every chassis: its packs and where each file is."""
    module, entries, src, out, verify = job
    # the distinct files, by content; a chassis's name for one -> its content
    unique = {}
    where = {}
    for chassis, entry in entries.items():
        for name in entry["files"]:
            path = os.path.join(src, *entry["path"].split("/"), name)
            key = digest(path)
            unique.setdefault(key, (name, path))
            where[(chassis, name)] = key
    # like beside like: the same kind of file, then by size, so a version
    # lands next to its neighbours and inside the window that can see them
    order = sorted(unique.items(), key=lambda kv: (
        kv[1][0].rsplit(".", 1)[-1].upper(), os.path.getsize(kv[1][1]), kv[1][0].upper()))
    groups, group, held = [], [], 0
    for key, (name, path) in order:
        size = os.path.getsize(path)
        if group and held + size > PACK_BYTES:
            groups.append(group)
            group, held = [], 0
        group.append((key, name, path))
        held += size
    if group:
        groups.append(group)
    place = {}
    names = []
    packed = 0
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in module)
    for n, group in enumerate(groups):
        blob = encode([(name, path) for _, name, path in group])
        if verify:
            for (_, name, path), (got_name, data) in zip(group, decode(blob)):
                with open(path, "rb") as f:
                    if got_name != name or f.read() != data:
                        raise SystemExit(f"error: {module}/{name} does not unpack to itself")
        fname = f"{safe}.{n}.spk"
        with open(os.path.join(out, "packs", fname), "wb") as f:
            f.write(blob)
        names.append(fname)
        packed += len(blob)
        for i, (key, _, _) in enumerate(group):
            place[key] = (n, i)
    at = {chassis: {name: place[where[(chassis, name)]] for name in entry["files"]}
          for chassis, entry in entries.items()}
    raw = sum(os.path.getsize(p) for _, p in unique.values())
    return module, names, at, raw, packed


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("src", help="the loose SP-Daten (holds index.json)")
    ap.add_argument("out", help="where the packs and their index go")
    ap.add_argument("--only", help="chassis to pack, comma separated (default: all)")
    ap.add_argument("--skip", help="module families to leave out, comma separated")
    ap.add_argument("--verify", action="store_true",
                    help="unpack every file and compare it with the original")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    ns = ap.parse_args()
    with open(os.path.join(ns.src, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    only = {c.strip().upper() for c in ns.only.split(",")} if ns.only else None
    skip = {m.strip().upper() for m in ns.skip.split(",")} if ns.skip else set()
    jobs = []
    for module, by_chassis in sorted(index["modules"].items()):
        if module.upper() in skip:
            continue
        entries = {c: e for c, e in by_chassis.items() if not only or c.upper() in only}
        if entries:
            jobs.append((module, entries, ns.src, ns.out, ns.verify))
    if not jobs:
        raise SystemExit("error: nothing to pack")
    os.makedirs(os.path.join(ns.out, "packs"), exist_ok=True)
    for old in os.listdir(os.path.join(ns.out, "packs")):
        if old.endswith(".spk"):
            os.remove(os.path.join(ns.out, "packs", old))

    packs = []
    modules = {}
    raw = packed = 0
    # the biggest first, so the long ones do not all end up last on one core
    jobs.sort(key=lambda j: -sum(sum(e["files"].values()) for e in j[1].values()))
    with ProcessPoolExecutor(max_workers=ns.jobs) as pool:
        for n, (module, names, at, r, p) in enumerate(pool.map(pack_module, jobs), 1):
            base = len(packs)
            packs.extend(names)
            modules[module] = {
                chassis: {**entry, "at": {
                    name: [base + at[chassis][name][0], at[chassis][name][1]]
                    for name in entry["files"]}}
                for chassis, entry in dict(jobs[n - 1][1]).items()}
            raw += r
            packed += p
            print(f"  {module:10} {len(names):3} packs  {r / 1e6:8.1f} MB -> {p / 1e6:7.1f} MB",
                  flush=True)
    sizes = [os.path.getsize(os.path.join(ns.out, "packs", name)) for name in packs]
    out_index = {"version": 2, "packs": packs, "sizes": sizes,
                 "modules": dict(sorted(modules.items())),
                 # what the source has and this does not: WebKFP lists these
                 # from the loose set when there is internet
                 "leftOut": sorted(m for m in index["modules"] if m.upper() in skip)}
    if only:
        out_index["chassis"] = sorted(only)
    with open(os.path.join(ns.out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(out_index, f, separators=(",", ":"), sort_keys=True)
    print(f"{len(modules)} modules, {len(packs)} packs: {raw / 1e9:.2f} GB of distinct files "
          f"-> {packed / 1e9:.2f} GB{' (verified)' if ns.verify else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
