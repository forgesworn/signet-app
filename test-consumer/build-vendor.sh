#!/usr/bin/env bash
# Bundle src/verify.js and src/relay-consumer.js (with their @noble, @scure
# and nostr-tools deps) into static ESM files the harness loads with no build
# step and no network.
#
# Re-run after editing either source. The output is committed so the harness
# works straight from a clone, and minified because these are vendored
# bundles nobody reads — thousands of added lines make every later commit
# crawl through per-line hooks for no benefit.
set -euo pipefail
cd "$(dirname "$0")"
npx --yes esbuild src/verify.js \
  --bundle \
  --minify \
  --format=esm \
  --platform=browser \
  --target=es2020 \
  --outfile=vendor/signet-verify.js
echo "→ vendor/signet-verify.js ($(wc -c < vendor/signet-verify.js) bytes)"

npx --yes esbuild src/relay-consumer.js \
  --bundle \
  --minify \
  --format=esm \
  --platform=browser \
  --target=es2020 \
  --outfile=vendor/signet-relay.js
echo "→ vendor/signet-relay.js ($(wc -c < vendor/signet-relay.js) bytes)"
