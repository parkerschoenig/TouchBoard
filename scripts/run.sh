#!/usr/bin/env bash
# TouchBoard — set up and start the server.
# Usage: bash scripts/run.sh [port]
set -euo pipefail

PORT=${1:-8011}

if [ ! -f .venv/bin/pip ]; then
  echo "==> Creating virtualenv"
  rm -rf .venv
  python3 -m venv .venv
fi

echo "==> Installing dependencies"
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt

IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
echo ""
echo "TouchBoard is running."
echo "  Editor:  http://${IP}:${PORT}/"
echo "  Display: http://${IP}:${PORT}/display"
echo ""

exec .venv/bin/uvicorn backend.main:app \
  --host 0.0.0.0 --port "$PORT"
