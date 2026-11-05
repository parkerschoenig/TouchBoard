"""Polls each widget on its own interval, caches the latest result, and pushes
updates to SSE subscribers.

A single loop ticks once per second and starts a task for every widget whose
interval has elapsed. Each poll runs on its own, so one slow integration (a
TrueNAS timeout, say) never delays the others, and a widget is never polled
twice at once. Widgets that aren't placed on any page are polled slowly.

Every envelope also carries:
  metrics  — current numeric values (see metrics.py)
  history  — the last HISTORY_LEN values of each metric, for sparklines
  alert    — threshold state (see alerts.py)
"""
import asyncio
import json
import time
from collections import deque

from . import alerts, db, integrations, metrics, secrets

_TICK = 1.0
_UNPLACED_INTERVAL = 60      # seconds between polls for widgets not on any page
_PLACED_CACHE_SEC = 5        # how long the "which widgets are placed" lookup is reused
HISTORY_LEN = 60             # points kept per metric


class Poller:
    def __init__(self) -> None:
        self.cache: dict[int, dict] = {}          # widget_id -> latest result envelope
        self.history: dict[int, dict[str, deque]] = {}
        self._last_run: dict[int, float] = {}     # widget_id -> monotonic ts
        self._inflight: dict[int, asyncio.Task] = {}   # widget_id -> running poll
        self._tasks: set[asyncio.Task] = set()
        self._subscribers: set[asyncio.Queue] = set()
        self._task: asyncio.Task | None = None
        self._placed: set[int] = set()
        self._placed_ts = 0.0

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
        for t in list(self._tasks):
            t.cancel()

    # ── pub/sub ───────────────────────────────────────────────────────────────
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
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

    def _placed_ids(self, now: float) -> set[int]:
        if now - self._placed_ts > _PLACED_CACHE_SEC:
            try:
                self._placed = db.placed_widget_ids()
            except Exception:
                pass
            self._placed_ts = now
        return self._placed

    async def _tick(self) -> None:
        now = time.monotonic()
        widgets = db.list_widgets()
        live_ids = {w["id"] for w in widgets}
        # drop cache for deleted widgets
        for gone in set(self.cache) - live_ids:
            self.cache.pop(gone, None)
            self._last_run.pop(gone, None)
            self.history.pop(gone, None)
            alerts.notifier.forget(gone)

        placed = self._placed_ids(now)
        for w in widgets:
            wid = w["id"]
            if wid in self._inflight:
                continue
            interval = max(2, w["refresh_interval_sec"])
            if wid not in placed:
                interval = max(interval, _UNPLACED_INTERVAL)
            last = self._last_run.get(wid)
            if last is None or (now - last) >= interval:
                self._start_poll(w, now)

    def _start_poll(self, widget: dict, now: float) -> asyncio.Task:
        self._last_run[widget["id"]] = now
        task = asyncio.create_task(self._poll_widget(widget))
        self._inflight[widget["id"]] = task
        self._tasks.add(task)

        def _done(t: asyncio.Task, wid=widget["id"]) -> None:
            self._tasks.discard(t)
            if self._inflight.get(wid) is t:
                self._inflight.pop(wid, None)
        task.add_done_callback(_done)
        return task

    async def _poll_widget(self, widget: dict) -> dict:
        data_source = None
        if widget.get("data_source_id"):
            ds = db.get_data_source(widget["data_source_id"], with_secret=True)
            if ds:
                ds["credentials"] = secrets.decrypt(ds.get("secret"))
                data_source = ds
        data = await integrations.fetch(widget, data_source)
        envelope = self._envelope(widget, data)
        self.cache[widget["id"]] = envelope
        self._publish(envelope)
        return envelope

    def _envelope(self, widget: dict, data: dict) -> dict:
        wid = widget["id"]
        current = metrics.extract(widget["type"], data)
        series = self.history.setdefault(wid, {})
        for key, value in current.items():
            series.setdefault(key, deque(maxlen=HISTORY_LEN)).append(None if value is None else round(value, 2))
        # forget metrics that disappeared (renamed ping target, removed pool…)
        for key in [k for k in series if k not in current]:
            series.pop(key, None)
        alert = alerts.evaluate(widget, data, current)
        alerts.notifier.process(widget, alert)
        return {
            "widget_id": wid, "type": widget["type"], "data": data, "ts": time.time(),
            "interval": widget["refresh_interval_sec"],
            "metrics": current,
            "history": {k: list(v) for k, v in series.items()},
            "alert": alert,
        }

    async def poll_now(self, widget_id: int) -> dict | None:
        """Poll one widget immediately (editor preview after a config change)."""
        w = db.get_widget(widget_id)
        if not w:
            return None
        running = self._inflight.get(widget_id)
        if running is not None:
            try:
                return await asyncio.shield(running)
            except Exception:
                return self.cache.get(widget_id)
        return await self._start_poll(w, time.monotonic())

    def force_poll(self, widget_id: int) -> None:
        self._last_run.pop(widget_id, None)

    def force_poll_datasource(self, ds_id: int) -> None:
        """Reset poll timers for all widgets on this data source so next tick re-fetches."""
        for w in db.list_widgets():
            if w.get("data_source_id") == ds_id:
                self._last_run.pop(w["id"], None)

    def reset(self) -> None:
        """Drop all cached results and poll timers (e.g. after a config restore)."""
        self.cache.clear()
        self._last_run.clear()
        self.history.clear()
        self._placed_ts = 0.0


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
