"""Now playing: active sessions from Plex or Jellyfin.

Data source types:
  plex      base_url http://plex:32400   credentials {"token": "..."}
  jellyfin  base_url http://jellyfin:8096 credentials {"api_key": "..."}

Widget config:
  {"show_user": true, "show_device": true, "max_sessions": 4}

Artwork never goes to the browser with a token on it. Each session carries an
`art_path` on the server's own API, and /api/widgets/{id}/art/{n} fetches it
with the credentials and streams the image back.
"""
from __future__ import annotations

from urllib.parse import quote

import httpx

_TIMEOUT = 8.0
_TICKS = 10_000_000  # Jellyfin ticks per second


def _auth_headers(ds: dict) -> dict:
    creds = ds.get("credentials") or {}
    if ds["type"] == "plex":
        return {"X-Plex-Token": (creds.get("token") or "").strip(), "Accept": "application/json"}
    key = (creds.get("api_key") or "").strip()
    return {"Authorization": f'MediaBrowser Token="{key}"', "X-Emby-Token": key, "Accept": "application/json"}


def _plex(container: dict) -> list[dict]:
    out = []
    for m in (container.get("MediaContainer") or {}).get("Metadata") or []:
        kind = m.get("type")
        if kind == "episode":
            title = m.get("grandparentTitle") or m.get("title")
            sub = f"S{m.get('parentIndex', 0):02d}E{m.get('index', 0):02d} · {m.get('title', '')}"
            art = m.get("grandparentThumb") or m.get("thumb")
        elif kind == "track":
            title = m.get("title")
            sub = " · ".join(x for x in (m.get("grandparentTitle"), m.get("parentTitle")) if x)
            art = m.get("parentThumb") or m.get("thumb")
        else:
            title = m.get("title")
            sub = str(m.get("year") or "")
            art = m.get("thumb")
        dur = (m.get("duration") or 0) / 1000
        pos = (m.get("viewOffset") or 0) / 1000
        player = m.get("Player") or {}
        out.append({
            "title": title, "subtitle": sub, "type": {"episode": "episode", "track": "track"}.get(kind, "movie"),
            "user": (m.get("User") or {}).get("title"), "device": player.get("title") or player.get("product"),
            "state": "paused" if player.get("state") == "paused" else "playing",
            "duration_s": round(dur), "position_s": round(pos),
            "progress": round(pos / dur, 4) if dur else 0,
            "art_path": f"/photo/:/transcode?width=360&height=540&minSize=1&upscale=1&url={quote(art, safe='')}" if art else None,
        })
    return out


def _jellyfin(sessions: list) -> list[dict]:
    out = []
    for s in sessions or []:
        it = s.get("NowPlayingItem")
        if not it:
            continue
        kind = (it.get("Type") or "").lower()
        if kind == "episode":
            title = it.get("SeriesName") or it.get("Name")
            sub = f"S{it.get('ParentIndexNumber', 0):02d}E{it.get('IndexNumber', 0):02d} · {it.get('Name', '')}"
            art_id = it.get("SeriesId") or it.get("Id")
        elif kind == "audio":
            title = it.get("Name")
            sub = " · ".join(x for x in (", ".join(it.get("Artists") or []) or it.get("AlbumArtist"), it.get("Album")) if x)
            art_id = it.get("AlbumId") or it.get("Id")
        else:
            title = it.get("Name")
            sub = str(it.get("ProductionYear") or "")
            art_id = it.get("Id")
        ps = s.get("PlayState") or {}
        dur = (it.get("RunTimeTicks") or 0) / _TICKS
        pos = (ps.get("PositionTicks") or 0) / _TICKS
        out.append({
            "title": title, "subtitle": sub, "type": {"episode": "episode", "audio": "track"}.get(kind, "movie"),
            "user": s.get("UserName"), "device": s.get("DeviceName") or s.get("Client"),
            "state": "paused" if ps.get("IsPaused") else "playing",
            "duration_s": round(dur), "position_s": round(pos),
            "progress": round(pos / dur, 4) if dur else 0,
            "art_path": f"/Items/{art_id}/Images/Primary?maxHeight=360" if art_id else None,
        })
    return out


async def fetch(widget: dict, data_source: dict | None) -> dict:
    if not data_source or data_source.get("type") not in ("plex", "jellyfin"):
        return {"error": "Pick a Plex or Jellyfin connection for this widget."}
    base = data_source["base_url"].rstrip("/")
    path = "/status/sessions" if data_source["type"] == "plex" else "/Sessions?activeWithinSeconds=960"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, verify=False) as client:
            r = await client.get(base + path, headers=_auth_headers(data_source))
    except httpx.HTTPError as exc:
        return {"error": f"Cannot reach {data_source['type'].title()}: {type(exc).__name__}"}
    if r.status_code in (401, 403):
        return {"error": "Authentication failed. Check the token / API key."}
    if r.status_code >= 400:
        return {"error": f"{data_source['type'].title()} API error: {r.status_code}"}
    try:
        payload = r.json()
    except ValueError:
        return {"error": "Unexpected response (not JSON)."}
    sessions = _plex(payload) if data_source["type"] == "plex" else _jellyfin(payload)
    sessions.sort(key=lambda s: s["state"] != "playing")
    limit = int((widget.get("config") or {}).get("max_sessions") or 4)
    return {"server": data_source["type"], "sessions": sessions[:max(1, min(limit, 12))]}


async def fetch_art(data_source: dict, art_path: str) -> tuple[bytes, str] | None:
    url = data_source["base_url"].rstrip("/") + art_path
    headers = _auth_headers(data_source)
    headers["Accept"] = "image/*"
    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=False, follow_redirects=True) as client:
        r = await client.get(url, headers=headers)
    if r.status_code != 200 or len(r.content) > 4 * 1024 * 1024:
        return None
    return r.content, r.headers.get("content-type", "image/jpeg").split(";")[0]
