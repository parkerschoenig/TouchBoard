"""Polls each widget on its own interval, caches the latest result, and pushes
updates to SSE subscribers. A single loop ticks once per second and runs any
widget whose interval has elapsed, so widget create/update/delete is picked up
automatically with no per-widget task bookkeeping.
"""
import asyncio
import json
import time

from . import db
from . import integrations
from . import secrets

_TICK = 1.0


class Poller:
    def __init__(self) -> None:
        self.cache: dict[int, dict] = {}          # widget_id -> latest result envelope
        self._last_run: dict[int, float] = {}     # widget_id -> monotonic ts
        self._subscribers: set[asyncio.Queue] = set()
        self._task: asyncio.Task | None = None

    # ── lifecycle ─────────────────────────────────────────────────────────────
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

    # ── pub/sub ───────────────────────────────────────────────────────────────
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._subscribers.add(q)
        # prime new subscriber with current snapshot
        for widget_id, envelope in self.cache.items():
            try:
                q.put_nowait(envelope)
            except asyncio.QueueFull:
                pass
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def _publish(self, envelope: dict) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(envelope)
            except asyncio.QueueFull:
                pass

    # ── main loop ─────────────────────────────────────────────────────────────
    async def _run(self) -> None:
        while True:
            try:
                await self._tick()
            except Exception:
                pass
            await asyncio.sleep(_TICK)

    async def _tick(self) -> None:
        now = time.monotonic()
        widgets = db.list_widgets()
        live_ids = {w["id"] for w in widgets}
        # drop cache for deleted widgets
        for gone in set(self.cache) - live_ids:
            self.cache.pop(gone, None)
            self._last_run.pop(gone, None)

        due = []
        for w in widgets:
            interval = max(2, w["refresh_interval_sec"])
            last = self._last_run.get(w["id"], 0.0)
            if w["id"] not in self._last_run or (now - last) >= interval:
                due.append(w)

        if due:
            await asyncio.gather(*[self._poll_widget(w, now) for w in due])

    async def _poll_widget(self, widget: dict, now: float) -> None:
        self._last_run[widget["id"]] = now
        data_source = None
        if widget.get("data_source_id"):
            ds = db.get_data_source(widget["data_source_id"], with_secret=True)
            if ds:
                ds["credentials"] = secrets.decrypt(ds.get("secret"))
                data_source = ds
        data = await integrations.fetch(widget, data_source)
        envelope = {"widget_id": widget["id"], "type": widget["type"], "data": data, "ts": time.time()}
        self.cache[widget["id"]] = envelope
        self._publish(envelope)


poller = Poller()


async def sse_stream(request) -> "asyncio.AsyncIterator[str]":
    q = poller.subscribe()
    try:
        # initial comment so the client opens the stream promptly
        yield ": connected\n\n"
        while True:
            if await request.is_disconnected():
                break
            try:
                envelope = await asyncio.wait_for(q.get(), timeout=15.0)
                yield f"data: {json.dumps(envelope)}\n\n"
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
    finally:
        poller.unsubscribe(q)
