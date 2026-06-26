# TouchBoard

A touchscreen-first monitoring dashboard for homelabs and self-hosted infrastructure. Design a multi-page layout of widgets, integrations, and stacks in any browser - then point any display at the server URL.

![demo](https://img.shields.io/badge/live_demo-touchboard.onrender.com-3b82f6?style=flat-square)

## Features

- **Visual drag-and-drop layout editor** - place, resize, and stack widgets freely on a configurable grid
- **Widget stacks** -  group multiple widgets in one card; tap/click to cycle through them, or scroll the dot indicator to jump between pages
- **Multi-page boards** - organize widgets across pages; swipe, arrow-key, or scroll the page indicator to navigate
- **Live data via SSE** - all widget data is pushed to the display in real time over Server-Sent Events
- **Integrations stay server-side** - API tokens never touch the browser; no CORS issues
- **Display-anywhere** - the editor and display are separate URLs; run the display in a kiosk browser on any panel
- **Theme & card styling** - dark/light mode, accent colors, card backgrounds

---

## Widgets

| Type        | Notes |
|-------------|-------|
| **Clock**   | Digital or analog, 12h/24h, any IANA timezone |
| **Weather** | Current conditions + 5 or 7-day forecast via Open-Meteo (no API key required) |
| **Ping**    | HTTP URL, `host:port` TCP, or bare IP (ICMP); color-coded latency |

## Integrations

| Type        | Notes |
|-------------|-------|
| **Proxmox** | Per-node CPU, memory, uptime, and VM/CT resource summary |
| **TrueNAS** | Pool storage, system memory, and CPU usage |
| **NetBox**  | Rack elevation view, device count, and IP address summary |

---

## Running

### Prerequisites

- Python 3.10 or higher
- `openssl` (standard on most Linux distributions)
- `ping` / `iputils-ping` for ICMP monitoring (install via `apt install iputils-ping` or `dnf install iputils`)

### Quick start

```bash
git clone <repo-url>
cd touchboard
bash scripts/run.sh
```

On first run the script:
1. Creates a Python virtualenv (`.venv/`)
2. Installs Python dependencies
3. Generates a self-signed TLS certificate (`cert.pem` / `key.pem`)
4. Starts the server on port **8011**

```
  Editor:  https://<your-ip>:8011/
  Display: https://<your-ip>:8011/display
```

Your browser will show a certificate warning the first time - click through to add a security exception. Subsequent visits will be seamless.

An optional port argument is supported:

```bash
bash scripts/run.sh 9000   # run on port 9000 instead
```

### Manual setup

If you prefer to control each step individually:

```bash
# 1. Create and activate a virtualenv
python3 -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Generate a self-signed certificate
openssl req -x509 -newkey rsa:4096 \
  -keyout key.pem -out cert.pem \
  -days 730 -nodes -subj "/CN=touchboard"

# 4. Start the server
uvicorn backend.main:app \
  --host 0.0.0.0 --port 8011 \
  --ssl-keyfile key.pem --ssl-certfile cert.pem
```

---

## Kiosk setup

The display panel runs a kiosk browser pointed at `/display`. Install Chromium on the panel host (Raspberry Pi, mini-PC, etc.) and launch it in kiosk mode:

```bash
chromium --kiosk --app=https://<touchboard-host>:8011/display \
  --noerrdialogs --disable-pinch --overscroll-history-navigation=0 \
  --ignore-certificate-errors
```

**Auto-start on boot** (on the panel host, as your desktop user):

```ini
# ~/.config/systemd/user/kiosk.service
[Unit]
Description=TouchBoard kiosk
After=graphical-session.target

[Service]
ExecStart=/usr/bin/chromium --kiosk --app=https://<touchboard-host>:8011/display \
  --noerrdialogs --disable-pinch --overscroll-history-navigation=0 \
  --ignore-certificate-errors
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now kiosk.service
```

> Tip: disable the screen blanker with `xset s off -dpms` so the panel stays on.

---

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `TOUCHBOARD_DB` | `./data/touchboard.db` | SQLite database path |
| `TOUCHBOARD_SECRET_KEY` | auto-generated | Fernet key used to encrypt data-source credentials. Set this explicitly so credentials survive server restarts. |

Generate a secret key:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

## Demo

A live demo with simulated data is available at **touchboard.onrender.com** (may take ~30 s to wake from cold start).

Demo credentials: `admin` / `touchboard`
