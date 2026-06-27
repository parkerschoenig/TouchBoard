"""Seed the demo database with a layout that mirrors the production board's
geometry (pages, stack positions, sizes, resolution) but uses entirely
fabricated data — no real hostnames, IPs, credentials, or calendar details.

Idempotent via a version marker: bump _SEED_VERSION to force a re-seed.
All integration data is mocked at fetch time (see backend/integrations/*),
so data sources here carry placeholder URLs and no secrets.
"""
import json

from .. import db

_SEED_VERSION = "v1"


def seed():
    conn = db.connect()
    try:
        marker = conn.execute(
            "SELECT value FROM setting WHERE key='demo_seeded'"
        ).fetchone()
        if marker and marker[0] == _SEED_VERSION:
            return  # already seeded with the current demo layout

        # Wipe board config and re-seed
        for tbl in ("widget", "stack", "ping_target", "data_source"):
            conn.execute(f"DELETE FROM {tbl}")
        conn.execute("UPDATE board SET layout='[]', columns=24")

        now = db._now()

        # ── Data sources (placeholder endpoints; mocked at fetch time) ─────────
        ds = {}
        for type_, name, url in [
            ("proxmox",         "Proxmox",         "https://proxmox.demo.local"),
            ("netbox",          "NetBox",          "https://netbox.demo.local"),
            ("truenas",         "TrueNAS",         "https://truenas.demo.local"),
            ("adguard",         "AdGuard",         "https://adguard.demo.local"),
            ("opnsense",        "OPNsense",        "https://opnsense.demo.local"),
            ("google_calendar", "Google Calendar", "https://calendar.google.com"),
        ]:
            ds[type_] = conn.execute(
                "INSERT INTO data_source (type, name, base_url, secret, created_at) VALUES (?,?,?,NULL,?)",
                (type_, name, url, now),
            ).lastrowid

        # ── Ping targets (fabricated; RFC 5737 documentation IPs) ─────────────
        ping_rows = [
            ("Web Server",    "192.0.2.10", "Media"),
            ("App Server",    "192.0.2.11", "Media"),
            ("Indexer",       "192.0.2.12", "Media"),
            ("Downloader",    "192.0.2.13", "Media"),
            ("Media Server",  "192.0.2.14", "Media"),
            ("Reverse Proxy", "192.0.2.15", "Media"),
            ("NAS Primary",   "192.0.2.20", "Storage"),
            ("NAS Backup",    "192.0.2.21", "Storage"),
        ]
        pt = []
        for label, addr, grp in ping_rows:
            pt.append(conn.execute(
                "INSERT INTO ping_target (label, address, grp, created_at) VALUES (?,?,?,?)",
                (label, addr, grp, now),
            ).lastrowid)
        media_ids = pt[0:6]
        storage_ids = pt[6:8]

        # ── Widgets ───────────────────────────────────────────────────────────
        def w(type_, title, config, ds_key=None, interval=15):
            return conn.execute(
                "INSERT INTO widget (type, title, config, data_source_id, refresh_interval_sec, created_at)"
                " VALUES (?,?,?,?,?,?)",
                (type_, title, json.dumps(config), ds.get(ds_key), interval, now),
            ).lastrowid

        w_clock = w("clock", "Clock", {
            "clock_mode": "digital", "clock_format": "24h",
            "clock_style": "full", "clock_timezone": "America/New_York",
        }, interval=0)
        w_truenas = w("truenas", "TrueNAS", {
            "pool_name": "data",
            "views": [{"key": "storage", "enabled": True},
                      {"key": "memory", "enabled": True},
                      {"key": "cpu", "enabled": True}],
        }, ds_key="truenas")
        w_proxmox = w("proxmox", "Proxmox", {}, ds_key="proxmox")
        w_netbox = w("netbox", "NetBox", {
            "rack_name": "12U Homelab Rack",
            "views": [{"key": "rack", "enabled": True},
                      {"key": "ips", "enabled": True},
                      {"key": "vms", "enabled": True},
                      {"key": "devices", "enabled": True}],
        }, ds_key="netbox")
        w_weather = w("weather", "Weather", {
            "location_name": "New York", "latitude": 40.7128, "longitude": -74.0060,
            "units": "fahrenheit", "forecast_days": 7,
        })
        w_ping_all = w("ping", "All Pings", {"target_ids": media_ids + storage_ids})
        w_ping_media = w("ping", "Media Pings", {"target_ids": media_ids})
        w_ping_storage = w("ping", "Storage Pings", {"target_ids": storage_ids})
        w_adguard = w("adguard", "AdGuard", {"widget_theme": "dark", "ag_blocked_color": "#a02f22"}, ds_key="adguard")
        w_opnsense = w("opnsense", "OPNsense", {"widget_theme": "dark", "ops_cpu_color": "#ee6d11"}, ds_key="opnsense")
        w_calendar = w("calendar", "Google Calendar", {"calendar_view": "list", "days_ahead": 31, "max_events": 25}, ds_key="google_calendar")

        # ── Stacks ──────────────────────────────────────────────────────────────
        def s(name, widget_ids):
            return conn.execute(
                "INSERT INTO stack (name, widget_ids, cycle_mode, created_at) VALUES (?,?,?,?)",
                (name, json.dumps(widget_ids), "tap", now),
            ).lastrowid

        s_truenas = s("TrueNAS", [w_truenas])
        s_proxmox = s("Proxmox", [w_proxmox])
        s_netbox = s("NetBox", [w_netbox])
        s_clock = s("Clock", [w_clock])
        s_allpings = s("All Pings", [w_ping_all, w_ping_media, w_ping_storage])
        s_weather = s("Weather", [w_weather])
        s_adguard = s("AdGuard", [w_adguard])
        s_opnsense = s("OPNsense", [w_opnsense])
        s_calendar = s("Google Calendar", [w_calendar])
        s_storagepings = s("Storage Pings", [w_ping_storage])

        # ── Board layout (mirrors production geometry exactly) ────────────────
        layout = [
            {
                "id": 1, "name": "Page 1",
                "layout": [
                    {"stack_id": s_truenas,  "x": 12, "y": 0, "w": 4, "h": 6,  "item_type": "widget"},
                    {"stack_id": s_proxmox,  "x": 4,  "y": 0, "w": 8, "h": 16, "item_type": "widget"},
                    {"stack_id": s_netbox,   "x": 20, "y": 0, "w": 4, "h": 16, "item_type": "widget"},
                    {"stack_id": s_clock,    "x": 16, "y": 0, "w": 4, "h": 6,  "item_type": "widget"},
                    {"stack_id": s_allpings, "x": 0,  "y": 0, "w": 4, "h": 16, "item_type": "widget"},
                    {"stack_id": s_weather,  "x": 12, "y": 6, "w": 8, "h": 10, "item_type": "widget"},
                ],
            },
            {
                "id": 2, "name": "Page 2",
                "layout": [
                    {"stack_id": s_adguard,      "x": 0,  "y": 0, "w": 5,  "h": 9,  "item_type": "widget"},
                    {"stack_id": s_opnsense,     "x": 5,  "y": 0, "w": 7,  "h": 16, "item_type": "widget"},
                    {"stack_id": s_calendar,     "x": 12, "y": 0, "w": 12, "h": 16, "item_type": "widget"},
                    {"stack_id": s_storagepings, "x": 0,  "y": 9, "w": 5,  "h": 7,  "item_type": "widget"},
                ],
            },
        ]
        conn.execute("UPDATE board SET columns=24, layout=? WHERE id=1", (json.dumps(layout),))

        # ── Appearance / resolution settings ──────────────────────────────────
        for key, value in [
            ("theme_style",        "soft"),
            ("theme_font",         "inter"),
            ("disp_w",             "1920"),
            ("disp_h",             "720"),
            ("board_bg_color",     "#060912"),
            ("card_bg_color",      "#13111a"),
            ("card_bg_opacity",    "1"),
            ("card_bg2_color",     "#1a1628"),
            ("card_bg2_opacity",   "1"),
            ("card_gradient",      "true"),
            ("card_gradient_dir",  "135"),
            ("card_accent_color",  "#818cf8"),
            ("card_accent_opacity","1"),
            ("card_accent_width",  "3"),
            ("card_stroke_color",  "#2d2640"),
            ("card_stroke_opacity","1"),
            ("card_stroke_width",  "1"),
            ("card_glow",          "true"),
            ("card_glow_color",    "#818cf8"),
            ("card_glow_opacity",  "0.15"),
            ("card_glow_size",     "16"),
            ("widget_font_scale",  "1"),
            ("onboarding_done",    "false"),
            ("demo_seeded",        _SEED_VERSION),
        ]:
            conn.execute("INSERT OR REPLACE INTO setting (key, value) VALUES (?,?)", (key, value))

        conn.commit()
    finally:
        conn.close()
