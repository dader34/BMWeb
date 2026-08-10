#!/bin/bash
# Superseded by scripts/setup/fetch.sh, which pulls everything from one host.
#
# This used to reach a different place per asset -- Google Drive for the
# vendor zip, two GitHub release repos for wiring and coding. Drive
# rate-limits and rewrites its URLs, and release assets need `gh` plus an
# auth dance. All of it is on Hugging Face now: plain HTTPS, resumable, no
# login. Kept as a shim so old instructions and muscle memory still work.
set -euo pipefail
cd "$(dirname "$0")"
echo "note: fetch-coding.sh is now fetch.sh coding -- running that" >&2
exec ./fetch.sh --coding "$@"
