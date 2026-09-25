#!/usr/bin/env bash
# Signet Test Harness — local dev server.
#
# Fixed port 5175 (one above signet-app's 5174). Bound to 0.0.0.0 so
# phones/tablets on the same LAN can reach it for cross-device testing.
#
# Bookmark: http://localhost:5175/  (desktop)
#           http://<your-machine-ip>:5175/  (other devices on your LAN)
#
# Unlike a plain static server, this one also accepts POST /report from the
# callback page and appends every sign-in outcome to results/log.jsonl.

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required (apt install python3 / brew install python3)" >&2
  exit 1
fi

SCHEME=http
[ -f cert/harness.pem ] && [ -f cert/harness-key.pem ] && SCHEME=https
echo "Network access:      → ${SCHEME}://$(hostname -I 2>/dev/null | awk '{print $1}' || hostname):${SIGNET_HARNESS_PORT:-5175}/"
exec python3 server.py
