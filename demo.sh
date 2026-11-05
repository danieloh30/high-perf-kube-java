#!/bin/sh
# Terminal-only demo lifecycle; no process control is exposed through the app.
set -eu
DEMO_SCRIPT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v python3 >/dev/null 2>&1; then
  echo 'demo.sh requires Python 3.9+ (standard library only).' >&2
  exit 1
fi
exec python3 "$DEMO_SCRIPT_ROOT/scripts/demo.py" "$@"
