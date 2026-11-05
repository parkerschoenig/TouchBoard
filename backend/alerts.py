"""Threshold alerts per widget, with optional ntfy / webhook notifications.

Widget config:
  "alerts": [
    {"metric": "cpu",        "op": ">", "warn": 80, "crit": 95},
    {"metric": "latency:*",  "op": ">", "warn": 50, "crit": 200},   # wildcard
    {"metric": "pool:tank",  "op": ">", "warn": 80, "crit": 90}
  ],
  "alert_on_down":  true,    # ping / bookmarks: a target that is down is critical (default on)
  "alert_on_error": false    # integration errors raise a warning

The result is attached to every envelope as `alert` so the display can color
the card, jump to it, and the editor can show what fired.
"""
from __future__ import annotations

import asyncio
import fnmatch
import time

import httpx

from . import db

_LEVELS = {None: 0, "warn": 1, "crit": 2}


def _cmp(value: float, op: str, threshold) -> bool:
    try:
        t = float(threshold)
    except (TypeError, ValueError):
        return False
    return value < t if op == "<" else value > t


def evaluate(widget: dict, data: dict | None, metrics: dict) -> dict:
    cfg = widget.get("config") or {}
    items: list[dict] = []

    if isinstance(data, dict) and data.get("error"):
        if cfg.get("alert_on_error"):
            items.append({"key": "error", "value": None, "level": "warn", "message": str(data["error"])[:160]})
        return _summary(items)

    if widget.get("type") in ("ping", "bookmarks") and cfg.get("alert_on_down", True):
        targets = (data or {}).get("targets") if widget["type"] == "ping" else list(((data or {}).get("checks") or {}).values())
        for t in targets or []:
            if t.get("up") is False:
                label = t.get("label") or t.get("address") or "target"
                items.append({"key": f"down:{label}", "value": None, "level": "crit", "message": f"{label} is down"})

    for rule in cfg.get("alerts") or []:
        pattern = str(rule.get("metric") or "").strip()
        if not pattern:
            continue
        op = rule.get("op") if rule.get("op") in (">", "<") else ">"
        keys = [k for k in metrics if fnmatch.fnmatchcase(k, pattern)] if any(c in pattern for c in "*?[") else [pattern]
        for key in keys:
            value = metrics.get(key)
            if value is None:
                continue
            level = None
            if rule.get("crit") not in (None, "") and _cmp(value, op, rule["crit"]):
                level = "crit"
            elif rule.get("warn") not in (None, "") and _cmp(value, op, rule["warn"]):
                level = "warn"
            if level:
                label = key.split(":", 1)[-1] if ":" in key else key
                items.append({"key": key, "value": value, "level": level,
                              "message": f"{label} {op} {rule.get(level)} ({round(value, 1)})"})
    return _summary(items)


def _summary(items: list[dict]) -> dict:
    level = None
    for it in items:
        if _LEVELS[it["level"]] > _LEVELS[level]:
            level = it["level"]
    return {"level": level, "items": items}


class Notifier:
    """Sends a notification when an alert item rises to the configured level,
    and a "resolved" one when it clears. Repeats are throttled per item."""

    def __init__(self) -> None:
        self._state: dict[tuple[int, str], str] = {}
        self._last_sent: dict[tuple[int, str], float] = {}
        self._settings: dict = {}
        self._settings_ts = 0.0

    def _cfg(self) -> dict:
        now = time.monotonic()
        if now - self._settings_ts > 10:
            try:
                self._settings = db.get_all_settings()
            except Exception:
                pass
            self._settings_ts = now
        return self._settings

    def forget(self, widget_id: int) -> None:
        for k in [k for k in self._state if k[0] == widget_id]:
            self._state.pop(k, None)
            self._last_sent.pop(k, None)

    def process(self, widget: dict, alert: dict) -> None:
        s = self._cfg()
        ntfy, hook = (s.get("notify_ntfy_url") or "").strip(), (s.get("notify_webhook_url") or "").strip()
        min_level = _LEVELS.get(s.get("notify_min_level") or "crit", 2)
        try:
            cooldown = max(0.0, float(s.get("notify_cooldown_min") or 15)) * 60
        except ValueError:
            cooldown = 900.0

        wid = widget["id"]
        current = {it["key"]: it for it in alert.get("items", [])}
        events = []
        for key, it in current.items():
            k = (wid, key)
            prev = self._state.get(k)
            self._state[k] = it["level"]
            if _LEVELS[it["level"]] >= min_level and _LEVELS[it["level"]] > _LEVELS.get(prev, 0):
                if time.monotonic() - self._last_sent.get(k, -1e9) >= cooldown or _LEVELS.get(prev, 0) > 0:
                    events.append((it, False))
                    self._last_sent[k] = time.monotonic()
        for k in [k for k in self._state if k[0] == wid and k[1] not in current]:
            prev = self._state.pop(k)
            if _LEVELS.get(prev, 0) >= min_level:
                events.append(({"key": k[1], "level": prev, "value": None, "message": f"{k[1].split(':', 1)[-1]} recovered"}, True))

        if events and (ntfy or hook):
            asyncio.create_task(self._send(widget, events, ntfy, hook))

    async def _send(self, widget: dict, events, ntfy: str, hook: str) -> None:
        async with httpx.AsyncClient(timeout=8.0) as client:
            for it, resolved in events:
                title = f"TouchBoard · {widget.get('title') or widget.get('type')}"
                msg = it["message"]
                try:
                    if ntfy:
                        await client.post(ntfy, content=msg.encode(), headers={
                            "Title": title,
                            "Priority": "3" if resolved else ("5" if it["level"] == "crit" else "4"),
                            "Tags": "white_check_mark" if resolved else ("rotating_light" if it["level"] == "crit" else "warning"),
                        })
                    if hook:
                        await client.post(hook, json={
                            "widget_id": widget["id"], "widget": widget.get("title"), "type": widget.get("type"),
                            "level": it["level"], "key": it["key"], "value": it.get("value"),
                            "message": msg, "resolved": resolved, "ts": time.time(),
                        })
                except Exception:
                    pass  # notification endpoints are best-effort


notifier = Notifier()
