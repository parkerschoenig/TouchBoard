"""Integration registry. Each module exposes `async def fetch(widget, data_source) -> dict`."""
from . import (
    adguard, bookmarks, clock, google_calendar, homeassistant, netbox, notes, nowplaying, opnsense, photos,
    ping, proxmox, rest, rss, stream, truenas, weather,
)

REGISTRY = {
    "ping":       ping.fetch,
    "weather":    weather.fetch,
    "clock":      clock.fetch,
    "proxmox":    proxmox.fetch,
    "truenas":    truenas.fetch,
    "netbox":     netbox.fetch,
    "adguard":    adguard.fetch,
    "opnsense":   opnsense.fetch,
    "stream":     stream.fetch,
    "calendar":   google_calendar.fetch,
    "bookmarks":  bookmarks.fetch,
    "rest":       rest.fetch,
    "nowplaying": nowplaying.fetch,
    "notes":      notes.fetch,
    "photos":     photos.fetch,
    "rss":        rss.fetch,
    "lights":     homeassistant.fetch,
    "thermostat": homeassistant.fetch_thermostat,
    "tv":         homeassistant.fetch_tv,
}


async def fetch(widget: dict, data_source: dict | None) -> dict:
    fn = REGISTRY.get(widget["type"])
    if not fn:
        return {"error": f"unknown widget type {widget['type']!r}"}
    try:
        return await fn(widget, data_source)
    except Exception as exc:  # surface integration errors to the widget, don't crash poller
        return {"error": str(exc) or type(exc).__name__}
