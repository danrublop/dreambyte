#!/usr/bin/env bash
# Build the two dev bundles the real-pixel parity harness needs, then run it under
# Electron. See scripts/smoke/composite-parity-pixel-smoke.mjs for what it proves.
set -euo pipefail
cd "$(dirname "$0")/../.."

ESBUILD=../../node_modules/.bin/esbuild

"$ESBUILD" scripts/smoke/_smoke-t2-deps.ts --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.json --external:electron --outfile=/tmp/smoke-t2.cjs

"$ESBUILD" scripts/smoke/_parity-preview-deps.ts --bundle --format=iife --platform=browser \
  --tsconfig=tsconfig.json --outfile=/tmp/parity-preview.js

exec npx electron scripts/smoke/composite-parity-pixel-smoke.mjs
