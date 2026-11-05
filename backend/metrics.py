"""Pull numeric metrics out of each integration's result.

The poller keeps a short history of every metric (for sparklines) and the
alert rules refer to metrics by key, so one function per widget type maps its
data to a flat {key: number | None} dict. Keys are stable, human-readable and
safe to show in the editor ("cpu", "latency:Router", "pool:tank").
"""
from __future__ import annotations

from typing import Any


def _num(v: Any) -> float | None:
    try:
        if v is None or isinstance(v, bool):
            return None
        f = float(v)
        return f if f == f else None  # drop NaN
    except (TypeError, ValueError):
        return None


def _ping_like(data: dict, key: str = "targets") -> dict:
    out: dict[str, float | None] = {}
    targets = data.get(key) or []
    up = 0
    for t in targets:
        label = t.get("label") or t.get("address") or "?"
        out[f"latency:{label}"] = _num(t.get("latency_ms")) if t.get("up") else None
        up += 1 if t.get("up") else 0
    if targets:
        out["up_pct"] = round(up / len(targets) * 100, 1)
        out["down"] = float(len(targets) - up)
    return out


def _proxmox(d: dict) -> dict:
    out = {"cpu": _num(d.get("cluster_cpu_pct")), "ram": _num(d.get("cluster_mem_pct"))}
    for n in d.get("nodes") or []:
        out[f"cpu:{n.get('name')}"] = _num(n.get("cpu_pct"))
        out[f"ram:{n.get('name')}"] = _num(n.get("mem_pct"))
    return out


def _truenas(d: dict) -> dict:
    out: dict[str, float | None] = {"cpu": _num(d.get("cpu_pct"))}
    total, free = _num(d.get("mem_total")), _num(d.get("mem_free"))
    if total and free is not None:
        out["mem_used_pct"] = round((total - free) / total * 100, 1)
    for p in d.get("pools") or []:
        t, u = _num(p.get("total")), _num(p.get("used"))
        if t:
            out[f"pool:{p.get('name')}"] = round((u or 0) / t * 100, 1)
    return out


def _opnsense(d: dict) -> dict:
    out = {"cpu": _num(d.get("cpu_pct")), "mem": _num(d.get("mem_pct"))}
    for i in d.get("interfaces") or []:
        name = i.get("name") or i.get("device")
        out[f"rx:{name}"] = _num(i.get("rx_mbps"))
        out[f"tx:{name}"] = _num(i.get("tx_mbps"))
    return out


def _adguard(d: dict) -> dict:
    return {"queries": _num(d.get("queries_today")), "blocked_pct": _num(d.get("blocked_pct"))}


def _weather(d: dict) -> dict:
    cur = d.get("current") or {}
    return {"temp": _num(cur.get("temperature")), "humidity": _num(cur.get("humidity"))}


def _rest(d: dict) -> dict:
    out = {}
    for v in d.get("values") or []:
        n = _num(v.get("value"))
        if n is not None:
            out[f"field:{v.get('label')}"] = n
    return out


def _bookmarks(d: dict) -> dict:
    checks = d.get("checks") or {}
    targets = [{"label": c.get("label"), "up": c.get("up"), "latency_ms": c.get("latency_ms")} for c in checks.values()]
    return _ping_like({"targets": targets})


def _nowplaying(d: dict) -> dict:
    return {"streams": float(len(d.get("sessions") or []))}


def _rss(d: dict) -> dict:
    return {"items": float(len(d.get("items") or []))}


_EXTRACTORS = {
    "ping": _ping_like,
    "proxmox": _proxmox,
    "truenas": _truenas,
    "opnsense": _opnsense,
    "adguard": _adguard,
    "weather": _weather,
    "rest": _rest,
    "bookmarks": _bookmarks,
    "nowplaying": _nowplaying,
    "rss": _rss,
}


def extract(widget_type: str, data: dict | None) -> dict[str, float | None]:
    if not isinstance(data, dict) or data.get("error"):
        return {}
    fn = _EXTRACTORS.get(widget_type)
    if not fn:
        return {}
    try:
        return {k: v for k, v in fn(data).items() if k}
    except Exception:  # a malformed payload must never break the poll loop
        return {}
