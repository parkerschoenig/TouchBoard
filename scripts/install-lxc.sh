#!/usr/bin/env bash
# TouchBoard — installer for a Debian/Ubuntu LXC (run as root inside the container).
# Sets up a venv + systemd service serving the dashboard on port 8011.
#
#   bash install-lxc.sh            # install from the current checkout
#   APP_SRC=/path/to/touchboard bash install-lxc.sh
set -euo pipefail

APP_DIR=/opt/touchboard
APP_SRC=${APP_SRC:-"$(cd "$(dirname "$0")/.." && pwd)"}
PORT=${PORT:-8011}
SERVICE=/etc/systemd/system/touchboard.service

echo "==> Installing system packages"
apt-get update
apt-get install -y --no-install-recommends python3 python3-venv iputils-ping rsync

echo "==> Copying app to ${APP_DIR}"
mkdir -p "$APP_DIR" "$APP_DIR/data"
rsync -a --delete \
  --exclude '.venv' --exclude 'data' --exclude '__pycache__' \
  "$APP_SRC"/backend "$APP_SRC"/frontend "$APP_SRC"/requirements.txt "$APP_DIR"/

echo "==> Creating virtualenv + installing deps"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"

echo "==> Writing systemd service"
cat > "$SERVICE" <<EOF
[Unit]
Description=TouchBoard dashboard
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${APP_DIR}
Environment=TOUCHBOARD_DB=${APP_DIR}/data/touchboard.db
ExecStart=${APP_DIR}/.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port ${PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> Enabling service"
systemctl daemon-reload
systemctl enable --now touchboard.service

IP=$(hostname -I | awk '{print $1}')
echo
echo "TouchBoard is running."
echo "  Editor:  http://${IP}:${PORT}/"
echo "  Display: http://${IP}:${PORT}/display"
echo
echo "Point your touch panel's kiosk browser at the display URL (see README)."
