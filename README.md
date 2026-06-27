# TouchBoard

A touchscreen-first monitoring dashboard for homelabs and self-hosted infrastructure. Design a multi-page layout of widgets, integrations, and stacks in any browser - then point any display at the server URL.

[![demo](https://img.shields.io/badge/live_demo-touchboard.onrender.com-3b82f6?style=flat-square)](https://touchboard.onrender.com)

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

| Type                | Notes |
|---------------------|-------|
| **Proxmox**         | Per-node CPU, memory, uptime, and VM/CT resource summary |
| **TrueNAS**         | Pool storage, system memory, and CPU usage |
| **NetBox**          | Rack elevation view, device count, and IP address summary |
| **OPNsense**        | Firewall traffic, interface stats, and system health |
| **AdGuard Home**    | DNS query stats, block rate, and top blocked domains |
| **Google Calendar** | Upcoming events from Google Calendar or any ICS feed |
| **Stream**          | Live camera feed via HLS or RTSP |

---

## Installation

### Prerequisites

- Linux with systemd (Ubuntu 20.04+, Debian 11+, or similar)
- Python 3.10 or higher
- `iputils-ping` for ICMP monitoring (`apt install iputils-ping`)

### Install

Clone the repo and run the install script. It creates a virtualenv, installs dependencies, generates a secret key, and registers a systemd service — all in one step.

```bash
git clone https://github.com/parkerschoenig/TouchBoard.git
cd TouchBoard
sudo bash scripts/install-service.sh        # default port 8011
sudo bash scripts/install-service.sh 9000   # custom port
```

Once running:

```
  Editor:  http://<your-ip>:8011/
  Display: http://<your-ip>:8011/display
```

Default credentials: `admin` / `admin@touchboard` — you'll be prompted to change them on first login.

### Manage the service

```bash
systemctl status touchboard
systemctl restart touchboard
systemctl stop touchboard
journalctl -u touchboard -f    # live logs
```

> TouchBoard serves plain HTTP. To expose it over HTTPS, put it behind a reverse proxy (Caddy, nginx, Traefik, etc.).

---

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `TOUCHBOARD_DB` | `./data/touchboard.db` | SQLite database path |
| `TOUCHBOARD_SECRET_KEY` | auto-generated | Fernet key used to encrypt data-source credentials. The install script generates and stores this automatically. |

> If you ever need to rotate the key, edit `/etc/systemd/system/touchboard.service` and run `systemctl daemon-reload && systemctl restart touchboard`.

---

## Updating

Pull the latest code and re-run the install script:

```bash
cd <your-install-dir>
git pull
sudo bash scripts/install-service.sh
```

> Your data lives in `data/touchboard.db` and is untouched by updates. Export a backup first for safety (see [Backup & migration](#backup--migration)).

---

## Backup & migration

TouchBoard can export your entire board config - pages, stacks, widgets, ping targets, integrations, and settings - to a single encrypted file, then restore it on another install.

In the editor topbar, open **Backup**:

- **Export** - choose a passphrase and click **Download backup**. You'll get a `touchboard-backup-YYYY-MM-DD.tbk` file.
- **Restore** - select a `.tbk` file, enter its passphrase, and click **Restore from backup**.

Integration API keys are encrypted at rest with the server's `TOUCHBOARD_SECRET_KEY`. The backup re-encrypts them under the passphrase you choose, so:

- the file never contains plaintext credentials, and
- it restores cleanly onto a new server even if that server has a different `TOUCHBOARD_SECRET_KEY` — credentials are re-encrypted under the new key on import.

> Restoring **replaces all current board config**. User accounts are not included in a backup.

**Migrating to a new server:**

1. Install TouchBoard on the new server.
2. On the old server: **Backup → Export**, pick a passphrase, download the file.
3. On the new server: **Backup → Restore**, upload the file, enter the same passphrase.

---

## Display navigation

| Input | Action |
|-------|--------|
| Click / tap card | Cycle to next widget in stack |
| Scroll on card | Cycle through stack widgets |
| Scroll on page indicator | Change page |
| ← → arrow keys | Change page |
| Touch swipe left/right | Change page |

---

## Demo

A live demo with simulated data is available at **[touchboard.onrender.com](https://touchboard.onrender.com)** (may take ~30 s to wake from cold start).

Demo credentials: `admin` / `touchboard`
