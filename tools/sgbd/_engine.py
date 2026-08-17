#!/usr/bin/env python3
"""Shared plumbing for the tools/sgbd scripts: import paths and engine discovery.

Importing this module makes the sibling tool directories importable -- the
same three-line sys.path splice that used to be pasted into five scripts
(spec, abstract, code, diff, meta), each insertion stacking on the last.
It lives here once so the list of directories cannot drift between copies.

It also owns find_port()/find_base(): three scripts each carried their own
copy of "where is the running engine listening?", and the copies had already
drifted -- sgbd_diff probed `pgrep -f BMacW` and env BMACW_PORT while
sgbd_harvest/sgbd_tables used `lsof -c InpaMac.A` and env BMACW_API, so a
port that one tool found the next tool missed.
"""
import os
import re
import sys
import subprocess
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # tools/, for sibling modules
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d)
                for d in ("decompile", "sgbd", "export", "verify")]


def find_port():
    """Port of the running engine (the app or InpaMac.Server), or None.

    Order matters and each step is verified against what actually ships:

      1. BMACW_PORT -- the canonical env var: tools/check.sh, tools/verify/*,
         tools/export/* and scripts/build/build-web.sh all read or export it.
      2. BMACW_API -- the older spelling sgbd_harvest/sgbd_tables grew, a full
         base URL rather than a port. Honoured so existing invocations keep
         working; the port is parsed out of it.
      3. Probe 8777, the dev-run default (InpaMac.Server).
      4. lsof by process name. The packaged binary is
         BMacW.app/Contents/MacOS/InpaMac.App (see scripts/build/build-web.sh,
         which pgreps exactly that path), and `lsof -c` matches by prefix, so
         "InpaMac" catches the kernel-truncated name too.
      5. pgrep -f BMacW + lsof on the pid -- covers a process whose command
         name lsof -c cannot see (e.g. started via a wrapper) but whose .app
         path still says BMacW.
    """
    port = os.environ.get("BMACW_PORT")
    if port:
        return port
    api = os.environ.get("BMACW_API")
    if api:
        m = re.search(r":(\d+)/?$", api)
        if m:
            return m.group(1)
    try:
        urllib.request.urlopen("http://127.0.0.1:8777/api/health", timeout=3)
        return "8777"
    except Exception:                       # noqa: BLE001
        pass
    try:
        out = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a",
                              "-c", "InpaMac"], capture_output=True,
                             text=True, timeout=15).stdout
        m = re.search(r"127\.0\.0\.1:(\d+)", out)
        if m:
            return m.group(1)
    except Exception:                       # noqa: BLE001
        pass
    try:
        pid = subprocess.run(["pgrep", "-f", "BMacW"], capture_output=True,
                             text=True).stdout.split()
        if pid:
            out = subprocess.run(["lsof", "-aPi", "-p", pid[0]],
                                 capture_output=True, text=True).stdout
            for line in out.splitlines():
                if "LISTEN" in line:
                    m = re.search(r":(\d+) \(LISTEN\)", line)
                    if m:
                        return m.group(1)
    except Exception:                       # noqa: BLE001
        pass
    return None


def find_base():
    """Base URL of the running engine ("http://127.0.0.1:<port>"), or None.

    BMACW_API is returned verbatim when set -- it is already a base URL and
    callers append paths to it directly.
    """
    api = os.environ.get("BMACW_API")
    if api:
        return api
    port = find_port()
    return f"http://127.0.0.1:{port}" if port else None
