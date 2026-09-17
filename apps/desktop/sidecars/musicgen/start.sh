#!/usr/bin/env bash
# Start the local MusicGen sidecar server. Run setup.sh first.
#   npm run music-sidecar:start   (or: bash sidecars/musicgen/start.sh)
set -euo pipefail

SIDECAR_DIR="${MUSICGEN_HOME:-$HOME/.dreambyte/sidecar/musicgen}"
PORT="${MUSICGEN_PORT:-8090}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -x "$SIDECAR_DIR/venv/bin/python" ]; then
  echo "Sidecar not set up. Run:  bash sidecars/musicgen/setup.sh" >&2
  exit 1
fi
# Always run the latest committed server.py (setup.sh copies it; refresh on start too).
cp "$SRC_DIR/server.py" "$SIDECAR_DIR/server.py"

echo "Starting MusicGen sidecar on http://127.0.0.1:$PORT"
echo "  → set MUSICGEN_URL=http://127.0.0.1:$PORT so Dreambyte uses it"
exec "$SIDECAR_DIR/venv/bin/python" "$SIDECAR_DIR/server.py" --port "$PORT" --preload
