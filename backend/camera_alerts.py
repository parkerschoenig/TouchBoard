"""Watches every Frigate connection for new detections and pushes each one to
the displays over SSE ({"type": "camera_event", ...}). Each screen decides
which cameras and labels pop up (profile option camera_popup)."""
from __future__ import annotations

import asyncio
import json
import logging
import time

from . import db, secrets
from .integrations import frigate

log = logging.getLogger("touchboard.camera_alerts")

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
        """What the editor shows under Camera pop-ups."""
        st = self._state.get(ds_id)
        if not st:
            return {"watching": False, "error": None, "last_event": None, "last_ok": None}
        return {"watching": True, "error": st["error"], "last_event": st["last_event"], "last_ok": st["last_ok"]}

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
                st = self._state[ds["id"]] = {"client": frigate.FrigateClient(ds), "sig": sig, "primed": False,
                                              "floor": 0.0, "newest": 0.0, "seen": {}, "error": None, "retry_at": 0.0,
                                              "last_event": None, "last_ok": None}
            if time.time() < st["retry_at"]:
                continue
            try:
                # All times are Frigate's own, so the two machines' clocks never need to agree.
                since = max(st["floor"], st["newest"] - _OVERLAP) if st["primed"] else 0
                events = await st["client"].events_after(since)
                if st["error"]:
                    log.info("Frigate %s: reachable again", ds["name"])
                st["error"], st["last_ok"] = None, time.time()
            except Exception as exc:
                msg = str(exc) or type(exc).__name__
                if msg != st["error"]:
                    log.warning("Frigate %s: %s", ds["name"], msg)
                st["error"] = msg
                st["retry_at"] = time.time() + _RETRY
                continue
            if not st["primed"]:
                # First look: whatever Frigate already has is history. New means starting
                # after Frigate's "now" (its Date header), or after its newest event.
                starts = [float(e.get("start_time") or 0) for e in events]
                now_frigate = st["client"].server_time
                st["floor"] = (now_frigate - 5) if now_frigate else max(starts, default=0.0)
                for e in events:
                    if e.get("id"):
                        st["seen"][e["id"]] = float(e.get("start_time") or 0)
                st["newest"] = max([st["floor"], *starts])
                st["primed"] = True
                continue
            for ev in sorted(events, key=lambda e: e.get("start_time") or 0):
                eid, start = ev.get("id"), float(ev.get("start_time") or 0)
                if not eid or eid in st["seen"] or start < st["floor"]:
                    continue
                st["seen"][eid] = start
                st["newest"] = max(st["newest"], start)
                st["last_event"] = {"camera": ev.get("camera"), "label": ev.get("label"), "at": time.time()}
                poller._publish(frigate.event_payload(ds, ev))
            if len(st["seen"]) > 500:   # keep the id memory small
                for k in sorted(st["seen"], key=st["seen"].get)[:250]:
                    st["seen"].pop(k, None)


watcher = CameraWatcher()
