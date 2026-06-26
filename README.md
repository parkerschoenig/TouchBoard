# TouchBoard

A touchscreen-first monitoring dashboard for homelabs and self-hosted infrastructure. Design a multi-page layout of widgets, integrations, and stacks in any browser - then point any display at the server URL.

![demo](https://img.shields.io/badge/live_demo-touchboard.onrender.com-3b82f6?style=flat-square)

## Features

- **Visual drag-and-drop layout editor** - place, resize, and stack widgets freely on a configurable grid
- **Widget stacks** - group multiple widgets in one card; tap/click to cycle through them, or scroll the dot indicator to jump between pages
- **Multi-page boards** - organize widgets across pages; swipe, arrow-key, or scroll the page indicator to navigate
- **Live data via SSE** - all widget data is pushed to the display in real time over Server-Sent Events
- **Integrations stay server-side** - API tokens never touch the browser; no CORS issues
- **Display-anywhere** - the editor and display are separate URLs; open the display on any screen, tablet, or panel
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
3. Starts the server on port **8011**

```
  Editor:  http://<your-ip>:8011/
  Display: http://<your-ip>:8011/display
```

Open either URL from any device on your network. An optional port argument is supported:

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

# 3. Start the server
uvicorn backend.main:app --host 0.0.0.0 --port 8011
```

> TouchBoard serves plain HTTP. To expose it over HTTPS, put it behind a reverse proxy (Caddy, nginx, Traefik, etc.).

---

## Run as a service

To keep TouchBoard running across reboots, install it as a systemd service.

Create `/etc/systemd/system/TouchBoard.service` (adjust `User`, `WorkingDirectory`, and the port to your setup):

```ini
[Unit]
Description=TouchBoard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/touchboard
Environment=TOUCHBOARD_SECRET_KEY=replace-with-your-generated-key
ExecStart=/opt/touchboard/.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8011
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Then reload systemd and enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable TouchBoard    # start automatically on boot
sudo systemctl start TouchBoard     # start now
```

Manage it with the usual commands:

```bash
sudo systemctl status TouchBoard
sudo systemctl restart TouchBoard
sudo systemctl stop TouchBoard
sudo journalctl -u TouchBoard -f    # follow logs
```

> Set `TOUCHBOARD_SECRET_KEY` in the unit file (see [Configuration](#configuration)) so encrypted data-source credentials survive restarts.

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

---

## Backup & migration

TouchBoard can export your entire board config - pages, stacks, widgets, ping targets, integrations, and settings - to a single encrypted file, then restore it on another install.

In the editor topbar, open **Backup**:

- **Export** - choose a passphrase and click **Download backup**. You'll get a `touchboard-backup-YYYY-MM-DD.tbk` file.
- **Restore** - select a `.tbk` file, enter its passphrase, and click **Restore from backup**.

Integration API keys are encrypted at rest with the server's `TOUCHBOARD_SECRET_KEY`. The backup re-encrypts them under the passphrase you choose, so:

- the file never contains plaintext credentials, and
- it restores cleanly onto a new server even if that server has a different `TOUCHBOARD_SECRET_KEY` - credentials are re-encrypted under the new key on import.

> Restoring **replaces all current board config**. User accounts are not included in a backup.

**Migrating to a new server:**

1. Install TouchBoard on the new server (see [Running](#running)).
2. On the old server: **Backup → Export**, pick a passphrase, download the file.
3. On the new server: **Backup → Restore**, upload the file, enter the same passphrase.

---

## Updating TouchBoard

Pull the latest code and reinstall dependencies:

```bash
cd /opt/touchboard
git pull
.venv/bin/pip install -r requirements.txt
```

If you run it as a service, restart it:

```bash
sudo systemctl restart TouchBoard
```

If you launch it with the script instead, stop it (Ctrl-C) and re-run `bash scripts/run.sh`.

> Your data lives in `data/touchboard.db` and is left untouched by updates. For peace of mind, export a backup first (see [Backup & migration](#backup--migration)).

---

## Demo

A live demo with simulated data is available at **touchboard.onrender.com** (may take ~30 s to wake from cold start).

Demo credentials: `admin` / `touchboard`
