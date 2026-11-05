"""Home Assistant: lights, a thermostat and a TV remote you can use from the display.

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

Widget "thermostat" config: {"entity": "climate.living_room", "show_fan": true, "require_login": false}
Widget "tv" config: {"media_player": "media_player.tcl_roku_tv", "remote": "remote.tcl_roku_tv",
                     "favorites": ["Plex", "YouTube", "HDMI 1"], "require_login": false}

The token never leaves the server. The display toggles lights through
POST /api/widgets/{id}/lights, and works the thermostat and TV through
POST /api/widgets/{id}/control. Both accept only the entities that widget is
set to, and only the actions listed here.
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
    modes = set(a.get("supported_color_modes") or [])
    hs = a.get("hs_color")
    return {
        "id": s["entity_id"],
        "name": a.get("friendly_name") or s["entity_id"],
        "domain": s["entity_id"].split(".", 1)[0],
        "on": on,
        "available": st not in ("unavailable", "unknown", None),
        "brightness": round(b / 255 * 100) if on and isinstance(b, (int, float)) else None,
        "color": _hex(a.get("rgb_color")) if on else None,
        "dimmable": any(m != "onoff" for m in modes),
        # what the long-press panel offers: colour, a warm↔cool white range, or neither
        "color_capable": bool(modes & {"hs", "xy", "rgb", "rgbw", "rgbww"}),
        "temp_capable": "color_temp" in modes,
        "min_kelvin": a.get("min_color_temp_kelvin"),
        "max_kelvin": a.get("max_color_temp_kelvin"),
        "kelvin": a.get("color_temp_kelvin") if on and a.get("color_mode") == "color_temp" else None,
        "hue": round(hs[0]) if on and isinstance(hs, (list, tuple)) and hs and isinstance(hs[0], (int, float)) else None,
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


async def list_entities(ds: dict, domains: tuple[str, ...] = CONTROLLABLE) -> list[dict]:
    """Entities for the editor's pickers: lights and switches by default,
    or any domains asked for (climate, media_player, remote)."""
    if tuple(domains) == CONTROLLABLE:
        states, areas = await _states(ds)
        items = [_item(s, areas) for s in states]
        items.sort(key=lambda i: (i["domain"] != "light", i["area"] or "~", i["name"].lower()))
        return items
    async with _client(ds) as c:
        r = await c.get("/api/states")
        _check(r)
        out = []
        for st in r.json():
            eid = st.get("entity_id", "")
            if eid.split(".", 1)[0] not in domains:
                continue
            a = st.get("attributes") or {}
            out.append({"id": eid, "name": a.get("friendly_name") or eid, "domain": eid.split(".", 1)[0], "state": st.get("state"),
                        "source_list": a.get("source_list") or [], "hvac_modes": a.get("hvac_modes") or []})
    out.sort(key=lambda i: (i["domain"], i["name"].lower()))
    return out


# ── thermostat (climate.*) and TV (media_player.* + remote.*) ────────────────

# Roku remote keys Home Assistant's remote.send_command accepts (and nothing else)
TV_KEYS = {"up", "down", "left", "right", "select", "back", "home", "play", "reverse", "forward", "info",
           "volume_up", "volume_down", "volume_mute", "channel_up", "channel_down", "power", "search", "find_remote"}
_unit_cache: dict[str, tuple[float, str]] = {}


async def _state(c: httpx.AsyncClient, eid: str) -> dict | None:
    r = await c.get(f"/api/states/{eid}")
    if r.status_code == 404:
        return None
    _check(r)
    return r.json()


async def _unit(c: httpx.AsyncClient, key: str) -> str:
    hit = _unit_cache.get(key)
    if hit and time.monotonic() - hit[0] < _AREA_TTL:
        return hit[1]
    unit = "°F"
    try:
        r = await c.get("/api/config")
        if r.status_code == 200:
            unit = ((r.json().get("unit_system") or {}).get("temperature")) or unit
    except (httpx.HTTPError, ValueError):
        pass
    _unit_cache[key] = (time.monotonic(), unit)
    return unit


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


async def fetch_thermostat(widget: dict, data_source: dict | None) -> dict:
    if not data_source or data_source.get("type") != "homeassistant":
        return {"error": "Pick a Home Assistant connection for this widget."}
    eid = ((widget.get("config") or {}).get("entity") or "").strip()
    if not eid.startswith("climate."):
        return {"error": "Pick a thermostat in this widget's settings."}
    try:
        async with _client(data_source) as c:
            st = await _state(c, eid)
            unit = await _unit(c, f"{data_source.get('id')}|{data_source['base_url']}")
    except httpx.HTTPError as exc:
        return {"error": f"Cannot reach Home Assistant: {type(exc).__name__}"}
    except (PermissionError, RuntimeError) as exc:
        return {"error": str(exc)}
    if not st:
        return {"error": f"{eid} isn't in Home Assistant any more."}
    a = st.get("attributes") or {}
    return {
        "id": eid, "name": a.get("friendly_name") or eid, "mode": st.get("state"),
        "available": st.get("state") not in ("unavailable", "unknown"),
        "action": a.get("hvac_action"), "current": _num(a.get("current_temperature")), "humidity": _num(a.get("current_humidity")),
        "target": _num(a.get("temperature")), "low": _num(a.get("target_temp_low")), "high": _num(a.get("target_temp_high")),
        "modes": a.get("hvac_modes") or [], "fan": a.get("fan_mode"), "fan_modes": a.get("fan_modes") or [],
        "min": _num(a.get("min_temp")), "max": _num(a.get("max_temp")),
        "step": _num(a.get("target_temp_step")) or (1 if "F" in unit else 0.5), "unit": unit,
    }


async def fetch_tv(widget: dict, data_source: dict | None) -> dict:
    if not data_source or data_source.get("type") != "homeassistant":
        return {"error": "Pick a Home Assistant connection for this widget."}
    cfg = widget.get("config") or {}
    mp = (cfg.get("media_player") or "").strip()
    if not mp.startswith("media_player."):
        return {"error": "Pick the TV in this widget's settings."}
    try:
        async with _client(data_source) as c:
            st = await _state(c, mp)
    except httpx.HTTPError as exc:
        return {"error": f"Cannot reach Home Assistant: {type(exc).__name__}"}
    except (PermissionError, RuntimeError) as exc:
        return {"error": str(exc)}
    if not st:
        return {"error": f"{mp} isn't in Home Assistant any more."}
    a = st.get("attributes") or {}
    sources = a.get("source_list") or []
    favs = [f for f in cfg.get("favorites") or [] if f in sources] or sources[:6]
    state = st.get("state")
    return {
        "id": mp, "name": a.get("friendly_name") or mp, "state": state,
        "on": state not in ("off", "standby", "unavailable", "unknown", None),
        "available": state not in ("unavailable", "unknown", None),
        "app": a.get("app_name") or a.get("source"), "favorites": favs, "muted": bool(a.get("is_volume_muted")),
        "has_remote": bool((cfg.get("remote") or "").startswith("remote.")),
    }


async def call_service(ds: dict, domain: str, service: str, data: dict) -> None:
    async with _client(ds) as c:
        _check(await c.post(f"/api/services/{domain}/{service}", json=data))


async def control(ds: dict, widget: dict, state: dict, action: str, value=None, low=None, high=None) -> None:
    """Thermostat / TV actions from the display, checked against the widget's own
    entity and its current state. Raises ValueError for anything not allowed."""
    cfg = widget.get("config") or {}
    if widget["type"] == "thermostat":
        eid = state.get("id") or cfg.get("entity")
        lo, hi = state.get("min") or 40, state.get("max") or 95
        if action == "temperature":
            t = _num(value)
            if t is None or not lo <= t <= hi:
                raise ValueError(f"Temperature must be between {lo} and {hi}.")
            return await call_service(ds, "climate", "set_temperature", {"entity_id": eid, "temperature": t})
        if action == "range":
            if _num(low) is None or _num(high) is None or not lo <= low < high <= hi:
                raise ValueError("Heat-to must be below cool-to, both within range.")
            return await call_service(ds, "climate", "set_temperature", {"entity_id": eid, "target_temp_low": low, "target_temp_high": high})
        if action == "mode" and value in (state.get("modes") or []):
            return await call_service(ds, "climate", "set_hvac_mode", {"entity_id": eid, "hvac_mode": value})
        if action == "fan" and value in (state.get("fan_modes") or []):
            return await call_service(ds, "climate", "set_fan_mode", {"entity_id": eid, "fan_mode": value})
        raise ValueError("That isn't something this thermostat accepts.")
    if widget["type"] == "tv":
        mp, rm = cfg.get("media_player"), (cfg.get("remote") or "")
        if action == "key" and value in TV_KEYS:
            if rm.startswith("remote."):
                return await call_service(ds, "remote", "send_command", {"entity_id": rm, "command": value})
            fallback = {"volume_up": "volume_up", "volume_down": "volume_down", "play": "media_play_pause"}
            if value in fallback:
                return await call_service(ds, "media_player", fallback[value], {"entity_id": mp})
            raise ValueError("Pick the TV's remote entity in this widget's settings for that button.")
        if action == "source" and value in (state.get("favorites") or []):
            return await call_service(ds, "media_player", "select_source", {"entity_id": mp, "source": value})
        if action == "power":
            return await call_service(ds, "media_player", "turn_off" if state.get("on") else "turn_on", {"entity_id": mp})
        if action == "mute":
            return await call_service(ds, "media_player", "volume_mute", {"entity_id": mp, "is_volume_muted": not state.get("muted")})
        raise ValueError("That isn't something this TV card accepts.")
    raise ValueError("This card has no controls.")


async def act(ds: dict, entity_ids: list[str], action: str, brightness: int | None = None,
              rgb: list[int] | None = None, kelvin: int | None = None) -> None:
    """Call light/switch turn_on, turn_off or toggle for these entities. With
    turn_on, lights can also take a brightness (%), an RGB colour or a white
    colour temperature in kelvin (one of the two)."""
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
            if domain == "light" and action == "turn_on":
                if brightness is not None:
                    body["brightness_pct"] = max(1, min(100, int(brightness)))
                if rgb is not None:
                    body["rgb_color"] = [max(0, min(255, int(c))) for c in rgb]
                elif kelvin is not None:
                    body["color_temp_kelvin"] = int(kelvin)
            r = await c.post(f"/api/services/{domain}/{action}", json=body)
            _check(r)
