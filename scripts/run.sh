#!/usr/bin/env bash
# TouchBoard — set up and start the server with HTTPS.
# Usage: bash scripts/run.sh [port]
#   Generates a self-signed TLS certificate on first run if one is not already present.
set -euo pipefail

PORT=${1:-8011}
CERT=cert.pem
KEY=key.pem

if [ ! -d .venv ]; then
  echo "==> Creating virtualenv"
  python3 -m venv .venv
fi

echo "==> Installing dependencies"
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "==> Generating self-signed TLS certificate"
  openssl req -x509 -newkey rsa:4096 \
    -keyout "$KEY" -out "$CERT" \
    -days 730 -nodes \
    -subj "/CN=touchboard"
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
echo ""
echo "TouchBoard is running."
echo "  Editor:  https://${IP}:${PORT}/"
echo "  Display: https://${IP}:${PORT}/display"
echo ""
echo "Your browser will warn about the self-signed certificate — accept once to proceed."
echo ""

exec .venv/bin/uvicorn backend.main:app \
  --host 0.0.0.0 --port "$PORT" \
  --ssl-keyfile "$KEY" --ssl-certfile "$CERT"
