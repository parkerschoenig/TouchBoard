# TouchBoard

A touchscreen-first monitoring dashboard for homelabs and self-hosted infrastructure. Design a multi-page layout of widgets, integrations, and stacks in any browser — then point any display at the server URL.

![demo](https://img.shields.io/badge/live_demo-touchboard.onrender.com-3b82f6?style=flat-square)

## Features

- **Visual drag-and-drop layout editor** — place, resize, and stack widgets freely on a configurable grid
- **Widget stacks** — group multiple widgets in one card; tap/click to cycle through them, or scroll the dot indicator to jump between pages
- **Multi-page boards** — organize widgets across pages; swipe, arrow-key, or scroll the page indicator to navigate
- **Live data via SSE** — all widget data is pushed to the display in real time over Server-Sent Events
- **Integrations stay server-side** — API tokens never touch the browser; no CORS issues
- **Display-anywhere** — the editor and display are separate URLs; run the display in a kiosk browser on any panel
- **Theme & card styling** — dark/light mode, accent colors, card backgrounds

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

### Docker (recommended)

```bash
docker compose up -d --build
# Editor:  http://localhost:8011/
# Display: http://localhost:8011/display
```

### Proxmox LXC

Create a Debian/Ubuntu LXC, copy this repo inside it, then:

```bash
bash scripts/install-lxc.sh
```

Installs a Python venv and a `touchboard` systemd service on port 8011.

### Local dev

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8011
```

---

## Kiosk setup

The display panel runs a kiosk browser pointed at `/display`. Install Chromium on the panel host (Raspberry Pi, mini-PC, etc.) and launch it in kiosk mode:

```bash
chromium --kiosk --app=http://<touchboard-host>:8011/display \
  --noerrdialogs --disable-pinch --overscroll-history-navigation=0
```

**Auto-start on boot** (on the panel host, as your desktop user):

```ini
# ~/.config/systemd/user/kiosk.service
[Unit]
Description=TouchBoard kiosk
After=graphical-session.target

[Service]
ExecStart=/usr/bin/chromium --kiosk --app=http://<touchboard-host>:8011/display \
  --noerrdialogs --disable-pinch --overscroll-history-navigation=0
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
| `TOUCHBOARD_SECRET_KEY` | auto-generated | Fernet key used to encrypt data-source credentials. Set this explicitly so credentials survive container recreation. |

Generate a secret key:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

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

A live demo with simulated data is available at **touchboard-demo.onrender.com** (may take ~30 s to wake from cold start).

Demo credentials: `admin` / `touchboard`
