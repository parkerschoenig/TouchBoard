# TouchBoard

A touchscreen-first monitoring dashboard for homelabs. Build a layout of **widget
stacks** in any browser, then drive a wall-mounted touch panel with a kiosk browser
pointed at the same server. Tap a stack to cycle through the widgets inside it.

- **Edit anywhere, display anywhere.** The server is headless; the panel is just a
  kiosk browser. No GPU/display passthrough to the container.
- **Widget stacks.** A stack holds several widgets and shows one at a time; a tap on the
  touchscreen advances to the next (dot indicator at the bottom).
- **Auto-scales** to any panel resolution (tested on 1920×720) — the board fills the
  viewport via a CSS grid.

## Architecture

```
  Laptop browser  ──edit──►  ┌──────────────────────────────┐
  Touch panel     ──kiosk──► │ TouchBoard (LXC / container)  │ ──► Proxmox / TrueNAS
  (Pi/mini-PC)               │ FastAPI + SQLite + SSE poller │     NetBox / ping targets
                             └──────────────────────────────┘
```

The server serves the UI **and** proxies every integration, so API tokens stay
server-side and there are no browser CORS issues. Live data is pushed to the panel over
Server-Sent Events.

- Editor:  `http://<host>:8011/`
- Display: `http://<host>:8011/display`

## Widgets

| Type    | Status   | Notes                                              |
|---------|----------|----------------------------------------------------|
| ping    | ✅ ready | URL (HTTP), `host:port` (TCP), or bare IP (ICMP)   |
| proxmox | phase 2  | host CPU/memory/uptime                              |
| truenas | phase 2  | pool capacity / ARC / CPU                           |
| netbox  | phase 2  | rack elevation                                     |

## Run it

### Docker
```bash
docker compose up -d --build
# editor at http://localhost:8011/
```

### Proxmox LXC
Create a Debian/Ubuntu LXC, get this directory inside it, then:
```bash
bash scripts/install-lxc.sh
```
Installs a venv + a `touchboard` systemd service on port 8011 and prints the URLs.

### Local dev
```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8011
```

## Kiosk setup (the touch panel)

The panel runs on its own small host (Raspberry Pi, mini-PC, or the panel's SBC).
Install Chromium and point it at the **display** URL in kiosk mode.

One-off:
```bash
chromium --kiosk --app=http://<touchboard-host>:8011/display \
  --noerrdialogs --disable-pinch --overscroll-history-navigation=0
```

Auto-start on boot via systemd (on the panel host, as your desktop user):
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
Tip: disable the screen blanker (`xset s off -dpms`) so the panel stays on.

## Configuration

| Env var                 | Purpose                                                        |
|-------------------------|----------------------------------------------------------------|
| `TOUCHBOARD_DB`         | SQLite path (default `./data/touchboard.db`)                   |
| `TOUCHBOARD_SECRET_KEY` | Fernet key encrypting data-source credentials. If unset, one is generated next to the DB. Set it explicitly so credentials survive container recreation. |

Generate a key:
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```
