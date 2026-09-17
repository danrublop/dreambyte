#!/usr/bin/env bash
# One-time setup for the local MusicGen sidecar (text-prompt -> music, $0).
# Creates a Python venv OUTSIDE the repo (~/.dreambyte/sidecar/musicgen) and installs
# torch/transformers. The model weights download on first generation, not here.
#
#   bash sidecars/musicgen/setup.sh
#
# Then start the server with: npm run music-sidecar:start
set -euo pipefail

SIDECAR_DIR="${MUSICGEN_HOME:-$HOME/.dreambyte/sidecar/musicgen}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pick a torch-compatible Python (3.12 preferred; 3.11/3.13 ok). 3.14 is often too new.
PYBIN=""
for cand in python3.12 python3.11 python3.13 python3; do
  if command -v "$cand" >/dev/null 2>&1; then PYBIN="$cand"; break; fi
done
[ -n "$PYBIN" ] || { echo "No python3 found. Install Python 3.12 (brew install python@3.12)." >&2; exit 1; }
echo "Using $PYBIN ($($PYBIN --version 2>&1))"

mkdir -p "$SIDECAR_DIR"
if [ ! -x "$SIDECAR_DIR/venv/bin/python" ]; then
  echo "Creating venv at $SIDECAR_DIR/venv ..."
  "$PYBIN" -m venv "$SIDECAR_DIR/venv"
fi
"$SIDECAR_DIR/venv/bin/pip" install --quiet --upgrade pip wheel
echo "Installing deps (torch is large — a few minutes)..."
"$SIDECAR_DIR/venv/bin/pip" install --quiet -r "$SRC_DIR/requirements.txt"

# Keep the server script next to the venv so the start script has one place to look.
cp "$SRC_DIR/server.py" "$SIDECAR_DIR/server.py"

"$SIDECAR_DIR/venv/bin/python" -c "import torch,transformers,scipy;print('OK torch',torch.__version__,'transformers',transformers.__version__)"
echo ""
echo "Done. Start the sidecar with:  npm run music-sidecar:start"
echo "Then set MUSICGEN_URL=http://127.0.0.1:8090 for the app/agent to use it."
