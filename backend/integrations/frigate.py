"""Frigate NVR: detections that pop a camera up on the display.

Data source:
  type "frigate"
  base_url  http://frigate:5000   (internal port, no login)
         or https://frigate:8971  (with a Frigate user below)
  credentials {
    "username": "...", "password": "...",   # only for the authenticated port
    "go2rtc_url": "http://frigate:1984"      # where displays play the camera;
  }                                          # defaults to the Frigate host on 1984

Displays play the camera straight from go2rtc (HLS), the same way the camera
widget does, so no video passes through TouchBoard.
"""
from __future__ import annotations

from urllib.parse import quote, urlparse

import httpx

_TIMEOUT = 8.0


class FrigateClient:
    """One client per connection; logs in once (when a user is set) and keeps the cookie."""

    def __init__(self, ds: dict):
        creds = ds.get("credentials") or {}
        self.user = (creds.get("username") or "").strip()
        self.password = creds.get("password") or ""
        self.client = httpx.AsyncClient(base_url=ds["base_url"].rstrip("/"), timeout=_TIMEOUT, verify=False)
        self.logged_in = False

    async def close(self) -> None:
        await self.client.aclose()

    async def _login(self) -> None:
        r = await self.client.post("/api/login", json={"user": self.user, "password": self.password})
        if r.status_code >= 400:
            raise PermissionError("Frigate rejected the username or password.")
        self.logged_in = True

    async def get(self, path: str, **params):
        if self.user and not self.logged_in:
            await self._login()
        r = await self.client.get(path, params=params or None)
        if r.status_code == 401 and self.user:
            self.logged_in = False
            await self._login()
            r = await self.client.get(path, params=params or None)
        if r.status_code in (401, 403):
            raise PermissionError("Frigate needs a login: add a Frigate username and password, or use the internal port 5000.")
        if r.status_code >= 400:
            raise RuntimeError(f"Frigate API error {r.status_code}")
        return r.json()

    async def cameras(self) -> list[str]:
        cfg = await self.get("/api/config")
        return sorted((cfg.get("cameras") or {}).keys())

    async def events_after(self, after: float) -> list[dict]:
        evs = await self.get("/api/events", after=f"{after:.3f}", limit=25, include_thumbnails=0)
        return evs if isinstance(evs, list) else []


def stream_url(ds: dict, camera: str) -> str:
    creds = ds.get("credentials") or {}
    base = (creds.get("go2rtc_url") or "").strip().rstrip("/")
    if not base:
        host = urlparse(ds["base_url"]).hostname or "localhost"
        base = f"http://{host}:1984"
    return f"{base}/api/stream.m3u8?src={quote(camera or '')}&mp4"


def event_payload(ds: dict, ev: dict, test: bool = False) -> dict:
    sub = ev.get("sub_label")
    if isinstance(sub, (list, tuple)):
        sub = sub[0] if sub else None
    return {
        "type": "camera_event", "source_id": ds["id"], "test": test,
        "event_id": ev.get("id"), "camera": ev.get("camera") or "", "label": ev.get("label") or "",
        "sub_label": sub if isinstance(sub, str) else None, "zones": ev.get("zones") or [],
        "start_time": ev.get("start_time"), "stream_url": stream_url(ds, ev.get("camera") or ""),
    }
