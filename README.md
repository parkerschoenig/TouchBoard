# TouchBoard

A touchscreen-first monitoring dashboard for homelabs and self-hosted infrastructure. Design a multi-page layout of widgets, integrations, and stacks in any browser - then point any display at the server URL.

[![demo](https://img.shields.io/badge/live_demo-touchboard.onrender.com-3b82f6?style=flat-square)](https://touchboard.onrender.com)

## Features

- **Layout editor with an inspector** - the board is previewed at the screen's real resolution, so what you see is exactly what the display shows. Select a card to edit its size, stack, appearance and alerts in the side panel
- **Several ways to place cards** - drag from the library, tap ＋ to drop into the first free space, or draw a rectangle on the grid and pick what goes in it. Pages can also be **tiled**: cards always fill the page and dragging the line between two cards resizes both
- **Undo, keyboard and command palette** - Ctrl Z / Ctrl Shift Z, arrow keys to move, Shift + arrows to resize, and Ctrl K to run any action
- **Display themes** - complete looks that restyle the cards and everything inside them (gauges, bars, type, status colors): Aurora Glass, Bento, HUD, Signal, Phosphor and Paper, plus Classic, Obsidian, Carbon, Nord and Light. The Designer shows live previews of your own board in each
- **Card shapes and surface patterns** - mix any theme with a card shape (Soft, Bento, Chamfer, Tab, Ticket, Brackets, Offset, Capsule) and a surface pattern (Dot grid, Blueprint, Hatch, Grain, Contour, Weave, Scanlines, Mesh gradient)
- **Widget stacks** - group several widgets in one card; tap the dots to switch, or let them cycle automatically
- **Multi-page boards** - swipe, arrow keys, or rotate pages on a timer
- **Alerts** - thresholds per widget metric (CPU, latency, pool usage, any REST value…), sparklines of recent history, a highlighted card, an optional jump to it, and push notifications via ntfy or a webhook
- **Built for always-on screens** - night schedule with dimming, burn-in pixel shift, stale-data indicators, an offline banner and screen wake lock
- **Per-screen boards** - `/display?profile=kitchen` pins a screen to one profile, so each screen can show its own board
- **Edit on the display** - long-press the display while signed in to move, resize, add or remove cards in place
- **Live data via SSE** - all widget data is pushed to the display in real time over Server-Sent Events
- **Integrations stay server-side** - API tokens never touch the browser; no CORS issues
- **Starter layouts and page export/import** - start a page from a template, or share a page as a JSON file (credentials are never included)

---

## Widgets

| Type        | Notes |
|-------------|-------|
| **Clock**   | Digital or analog, 12h/24h, any IANA timezone |
| **Weather** | Current conditions + 5 or 7-day forecast via Open-Meteo (no API key required) |
| **Ping**    | HTTP URL, `host:port` TCP, or bare IP (ICMP); color-coded latency with sparklines |
| **Bookmarks** | App launcher as tiles, a list with latency, or a dock. Optional up/down check per link, icons fetched from the site (or [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) / Simple Icons). On a wall panel, tapping can show a QR code to open the link on your phone. Imports a Homepage `services.yaml` or a browser bookmarks export |
| **REST / JSON** | Call any HTTP API and show values from the response as numbers, gauges or a list, picked with simple JSON paths (`data.items[0].value`, `items[*].name`). "Test request" shows the response so you can click values to add them. Secret headers live in an encrypted REST connection |
| **Notes** | Markdown notes: headings, lists, checkboxes, links |
| **Photo frame** | Slideshow from a folder on the TouchBoard server or a list of image URLs, with crossfade and a slow zoom |
| **RSS / news** | Headlines from RSS or Atom feeds, as a list or one large rotating headline |

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
| **Plex / Jellyfin** | Now playing: artwork, progress, who's watching and on which device. Artwork is proxied so the token stays on the server |

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

## Display

Open `http://<your-ip>:8011/display` on any screen. It shows the active profile, or a specific one with `?profile=<name or id>`.

| Input | Action |
|-------|--------|
| Tap a card | Next widget in its stack (links and buttons inside widgets handle their own taps) |
| Tap a stack dot | Jump to that widget |
| Scroll on card | Cycle through stack widgets |
| Scroll on page indicator | Change page |
| ← → arrow keys | Change page |
| Touch swipe left/right | Change page |
| Long-press (signed in) | Edit the page in place |

Per-screen behavior is set in the editor's inspector with no card selected: page rotation, automatic stack cycling, jumping to critical cards, stale-data dimming, wake lock, pixel shift, a night schedule (dim, optionally switch to a page), and whether editing on the display is allowed.

## Alerts & notifications

Select a card, then add thresholds under **Alerts** in the inspector. Metric names come from the widget (`cpu`, `ram`, `latency:Router`, `pool:tank`, `field:Queue`…) and `*` matches several (`latency:*`). Ping and Bookmarks widgets are critical when a target is down unless you turn that off.

Alerting cards are outlined on the editor and the display, and the display can jump to a card when it turns critical. To get a push notification, set an [ntfy](https://ntfy.sh) topic URL and/or a webhook URL in **Settings → Alerts & notifications** and use **Send a test**.

## Editor shortcuts

| Keys | Action |
|------|--------|
| Ctrl K | Command palette |
| Ctrl Z / Ctrl Shift Z | Undo / redo |
| Arrows / Shift + arrows | Move / resize the selected card |
| Ctrl D | Duplicate card |
| Delete | Remove card |
| L / F | Lock / fill empty space |
| Enter | Edit the card's widget |
| [ / ] | Previous / next page |
| / | Search the widget library |

Editing modes (inspector panel, draw to place) are under **Settings → Editor preferences** and are remembered per device.

---

## Demo

A live demo with simulated data is available at **[touchboard.onrender.com](https://touchboard.onrender.com)** (may take ~30 s to wake from cold start).

Demo credentials: `admin` / `touchboard`
