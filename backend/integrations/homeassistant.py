"""Home Assistant: lights (and optionally switches) you can toggle from the display.

Data source:
  type "homeassistant", base_url http://homeassistant.lan:8123
  credentials {"token": "<long-lived access token>"}   (Profile → Security)

Widget "lights" config:
  {
    "entities": ["light.kitchen", "light.desk"],  # empty = every light
    "include_switches": false,   # with no entities picked, also list switch.*
    "group_by_area": true,       # headings per Home Assistant area
    "require_login": false       # only signed-in TouchBoard users may toggle
  }

The token never leaves the server. The display toggles through
POST /api/widgets/{id}/lights, which accepts only this widget's own entities
and only turn_on / turn_off / toggle on lights and switches.
"""
from __future__ import annotations

import json
import time

import httpx

CONTROLLABLE = ("light", "switch")
_TIMEOUT = 8.0
_AREA_TTL = 300.0
_area_cache: dict[str, tuple[float, dict]] = {}

# Area per light/switch in one round trip (areas aren't in /api/states).
_AREA_TEMPLATE = (
    "{%- set ents = (states.light | list) + (states.switch | list) -%}"
    "{{ {'ids': ents | map(attribute='entity_id') | list,"
    " 'areas': ents | map(attribute='entity_id') | map('area_name') | list} | tojson }}"
)


def _client(ds: dict) -> httpx.AsyncClient:
    token = ((ds.get("credentials") or {}).get("token") or "").strip()
    return httpx.AsyncClient(base_url=ds["base_url"].rstrip("/"), timeout=_TIMEOUT, verify=False,
                             headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})


def _check(r: httpx.Response) -> None:
    if r.status_code == 401:
        raise PermissionError("Home Assistant rejected the token. Create a new long-lived access token.")
    if r.status_code >= 400:
        raise RuntimeError(f"Home Assistant API error {r.status_code}")


async def _areas(client: httpx.AsyncClient, cache_key: str) -> dict:
    hit = _area_cache.get(cache_key)
    if hit and time.monotonic() - hit[0] < _AREA_TTL:
        return hit[1]
    areas: dict = {}
    try:
        r = await client.post("/api/template", json={"template": _AREA_TEMPLATE})
        if r.status_code == 200:
            doc = json.loads(r.text)
            areas = {i: (a or "") for i, a in zip(doc.get("ids") or [], doc.get("areas") or [])}
    except (httpx.HTTPError, ValueError):
        pass  # areas are a nicety; the lights still work without them
    _area_cache[cache_key] = (time.monotonic(), areas)
    return areas


def _hex(rgb) -> str | None:
    if isinstance(rgb, (list, tuple)) and len(rgb) == 3 and all(isinstance(c, (int, float)) for c in rgb):
        return "#{:02x}{:02x}{:02x}".format(*(max(0, min(255, int(c))) for c in rgb))
    return None


def _item(s: dict, areas: dict) -> dict:
    a = s.get("attributes") or {}
    st = s.get("state")
    on = st == "on"
    b = a.get("brightness")
    modes = a.get("supported_color_modes") or []
    return {
        "id": s["entity_id"],
        "name": a.get("friendly_name") or s["entity_id"],
        "domain": s["entity_id"].split(".", 1)[0],
        "on": on,
        "available": st not in ("unavailable", "unknown", None),
        "brightness": round(b / 255 * 100) if on and isinstance(b, (int, float)) else None,
        "color": _hex(a.get("rgb_color")) if on else None,
        "dimmable": any(m != "onoff" for m in modes),
        "area": areas.get(s["entity_id"], ""),
        "group": bool(a.get("is_hue_group")) or isinstance(a.get("entity_id"), list),
    }


async def _states(ds: dict) -> tuple[list[dict], dict]:
    async with _client(ds) as c:
        r = await c.get("/api/states")
        _check(r)
        states = [s for s in r.json() if isinstance(s, dict) and s.get("entity_id", "").split(".", 1)[0] in CONTROLLABLE]
        areas = await _areas(c, f"{ds.get('id')}|{ds['base_url']}")
    return states, areas


async def fetch(widget: dict, data_source: dict | None) -> dict:
    if not data_source or data_source.get("type") != "homeassistant":
        return {"error": "Pick a Home Assistant connection for this widget."}
    cfg = widget.get("config") or {}
    try:
        states, areas = await _states(data_source)
    except httpx.HTTPError as exc:
        return {"error": f"Cannot reach Home Assistant: {type(exc).__name__}"}
    except (PermissionError, RuntimeError) as exc:
        return {"error": str(exc)}
    by_id = {s["entity_id"]: s for s in states}
    wanted = [e for e in cfg.get("entities") or [] if isinstance(e, str)]
    if wanted:
        picked = [by_id[e] for e in wanted if e in by_id]
        missing = [e for e in wanted if e not in by_id]
    else:
        domains = CONTROLLABLE if cfg.get("include_switches") else ("light",)
        # Hue rooms/zones also appear as lights; leave them out of "everything"
        picked = [s for s in states if s["entity_id"].split(".", 1)[0] in domains and not _item(s, {})["group"]]
        picked.sort(key=lambda s: ((s.get("attributes") or {}).get("friendly_name") or s["entity_id"]).lower())
        missing = []
    return {"entities": [_item(s, areas) for s in picked], "missing": missing}


async def list_entities(ds: dict) -> list[dict]:
    """Every light and switch, for the editor's picker."""
    states, areas = await _states(ds)
    items = [_item(s, areas) for s in states]
    items.sort(key=lambda i: (i["domain"] != "light", i["area"] or "~", i["name"].lower()))
    return items


async def act(ds: dict, entity_ids: list[str], action: str, brightness: int | None = None) -> None:
    """Call light/switch turn_on, turn_off or toggle for these entities."""
    if action not in ("turn_on", "turn_off", "toggle"):
        raise ValueError("unsupported action")
    by_domain: dict[str, list[str]] = {}
    for e in entity_ids:
        d = e.split(".", 1)[0]
        if d in CONTROLLABLE:
            by_domain.setdefault(d, []).append(e)
    async with _client(ds) as c:
        for domain, ids in by_domain.items():
            body: dict = {"entity_id": ids}
            if domain == "light" and action == "turn_on" and brightness is not None:
                body["brightness_pct"] = max(1, min(100, int(brightness)))
            r = await c.post(f"/api/services/{domain}/{action}", json=body)
            _check(r)
