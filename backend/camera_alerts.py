"""Watches every Frigate connection for new detections and pushes each one to
the displays over SSE ({"type": "camera_event", ...}). Each screen decides
which cameras and labels pop up (profile option camera_popup)."""
from __future__ import annotations

import asyncio
import json
import time

from . import db, secrets
from .integrations import frigate

_INTERVAL = 2.0      # seconds between checks
_RETRY = 15.0        # wait after an error
_OVERLAP = 60.0      # re-ask for this many seconds back; event ids stop repeats


class CameraWatcher:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._state: dict[int, dict] = {}

    def start(self) -> None:
        if not self._task:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        for st in self._state.values():
            await st["client"].close()
        self._state.clear()

    def status(self, ds_id: int) -> dict:
        st = self._state.get(ds_id)
        return {"watching": bool(st), "error": st["error"] if st else None}

    async def _run(self) -> None:
        while True:
            try:
                await self._tick()
            except Exception:
                pass
            await asyncio.sleep(_INTERVAL)

    async def _tick(self) -> None:
        from .poller import poller   # late import: poller imports integrations

        sources = [d for d in db.list_data_sources() if d.get("type") == "frigate"]
        live = {d["id"] for d in sources}
        for gone in set(self._state) - live:
            await self._state.pop(gone)["client"].close()

        for meta in sources:
            ds = db.get_data_source(meta["id"], with_secret=True)
            if not ds:
                continue
            ds["credentials"] = secrets.decrypt(ds.get("secret"))
            sig = json.dumps([ds["base_url"], ds["credentials"]], sort_keys=True)
            st = self._state.get(ds["id"])
            if not st or st["sig"] != sig:
                if st:
                    await st["client"].close()
                # only detections that start after we begin watching
                st = self._state[ds["id"]] = {"client": frigate.FrigateClient(ds), "sig": sig, "since": time.time() - 5,
                                              "newest": 0.0, "seen": {}, "error": None, "retry_at": 0.0}
            if time.time() < st["retry_at"]:
                continue
            try:
                events = await st["client"].events_after(max(st["since"], st["newest"] - _OVERLAP))
                st["error"] = None
            except Exception as exc:
                st["error"] = str(exc) or type(exc).__name__
                st["retry_at"] = time.time() + _RETRY
                continue
            for ev in sorted(events, key=lambda e: e.get("start_time") or 0):
                eid, start = ev.get("id"), float(ev.get("start_time") or 0)
                if not eid or eid in st["seen"] or start < st["since"]:
                    continue
                st["seen"][eid] = start
                st["newest"] = max(st["newest"], start)
                poller._publish(frigate.event_payload(ds, ev))
            if len(st["seen"]) > 500:   # keep the id memory small
                for k in sorted(st["seen"], key=st["seen"].get)[:250]:
                    st["seen"].pop(k, None)


watcher = CameraWatcher()
