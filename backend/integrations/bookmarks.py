"""Bookmarks: a launcher grid with optional up/down checks per link.

Widget config:
  {
    "layout": "tiles",            # tiles | list | dock
    "open":   "new",              # same | new | qr
    "groups": [
      {"name": "Media", "items": [
        {"label": "Jellyfin", "url": "http://jellyfin.lan:8096", "icon": "auto", "check": true}
      ]}
    ]
  }

`icon` is "auto" (favicon fetched and cached by the server), "letters", a
dashboard-icons slug like "si:jellyfin" / "di:jellyfin", or an image URL.

Checks reuse the ping integration's probe (TCP connect to the URL's host and
port), so they're cheap and don't download pages.
"""
import asyncio

from .ping import _check_target


def iter_items(cfg: dict):
    """Yield (flat_index, group_name, item) across all groups, in order.
    The flat index is how the favicon endpoint addresses an item."""
    i = 0
    for g in cfg.get("groups") or []:
        for item in g.get("items") or []:
            yield i, g.get("name") or "", item
            i += 1


async def fetch(widget: dict, data_source: dict | None) -> dict:
    cfg = widget.get("config") or {}
    items = list(iter_items(cfg))
    to_check = [(i, it) for i, _g, it in items if it.get("check") and (it.get("url") or "").strip()]

    async def check(i: int, it: dict):
        r = await _check_target({"label": it.get("label") or it.get("url"), "address": it["url"].strip()})
        return str(i), {"label": r["label"], "up": r["up"], "latency_ms": r.get("latency_ms"), "detail": r.get("detail")}

    results = await asyncio.gather(*[check(i, it) for i, it in to_check]) if to_check else []
    return {"count": len(items), "checks": dict(results)}
