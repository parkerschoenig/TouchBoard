"""Integration registry. Each module exposes `async def fetch(widget, data_source) -> dict`."""
from . import ping, proxmox, truenas, netbox, weather, clock, adguard

REGISTRY = {
    "ping":     ping.fetch,
    "weather":  weather.fetch,
    "clock":    clock.fetch,
    "proxmox":  proxmox.fetch,
    "truenas":  truenas.fetch,
    "netbox":   netbox.fetch,
    "adguard":  adguard.fetch,
}


async def fetch(widget: dict, data_source: dict | None) -> dict:
    fn = REGISTRY.get(widget["type"])
    if not fn:
        return {"error": f"unknown widget type {widget['type']!r}"}
    try:
        return await fn(widget, data_source)
    except Exception as exc:  # surface integration errors to the widget, don't crash poller
        return {"error": str(exc)}
