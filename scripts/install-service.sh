#!/usr/bin/env bash
# Install TouchBoard as a systemd service.
# Run from any directory: sudo bash /path/to/TouchBoard/scripts/install-service.sh [port]
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: run this script with sudo or as root." >&2
  exit 1
fi

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PORT=${1:-8011}
SERVICE=touchboard

echo "==> Setting up TouchBoard in $DIR"

# Create / repair venv
if [ ! -f "$DIR/.venv/bin/pip" ]; then
  echo "==> Creating virtualenv"
  rm -rf "$DIR/.venv"
  python3 -m venv "$DIR/.venv"
fi

echo "==> Installing dependencies"
"$DIR/.venv/bin/pip" install --quiet --upgrade pip
"$DIR/.venv/bin/pip" install --quiet -r "$DIR/requirements.txt"

# Generate a fresh Fernet key
SECRET_KEY=$("$DIR/.venv/bin/python3" -c \
  "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")

SERVICE_FILE=/etc/systemd/system/${SERVICE}.service

echo "==> Writing $SERVICE_FILE"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=TouchBoard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$DIR
Environment=TOUCHBOARD_SECRET_KEY=$SECRET_KEY
ExecStart=$DIR/.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
echo ""
echo "TouchBoard is running as a service."
echo "  Editor:  http://${IP}:${PORT}/"
echo "  Display: http://${IP}:${PORT}/display"
echo ""
echo "Useful commands:"
echo "  systemctl status $SERVICE"
echo "  systemctl restart $SERVICE"
echo "  journalctl -u $SERVICE -f     # live logs"
