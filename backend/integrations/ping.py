"""Ping / URL up-down checker.

Widget config:
  {
    "targets": [
      {"label": "Router",  "address": "192.168.1.1"},
      {"label": "NAS UI",  "address": "http://nas.local"},
      {"label": "SSH",     "address": "10.0.0.5:22"}
    ]
  }

Resolution rules per target address:
  - starts with http:// or https://  → TCP connect to host:port (no body download)
  - host:port                         → TCP connect
  - bare host/IP                      → system `ping -c1`, fall back to TCP:80
"""
import asyncio
import time
from urllib.parse import urlparse

_TCP_TIMEOUT  = 2.0
_PING_TIMEOUT = 2  # seconds, passed to `ping -W`


async def _check_http(address: str) -> dict:
    """TCP connect to the URL's host:port — fast, no body download."""
    parsed = urlparse(address)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    result = await _check_tcp(host, port)
    # Override the detail label to show the scheme
    if result["up"]:
        result["detail"] = f"{parsed.scheme.upper()}:{port} open"
    return result


async def _check_tcp(host: str, port: int) -> dict:
    start = time.perf_counter()
    try:
        fut = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(fut, timeout=_TCP_TIMEOUT)
        latency = (time.perf_counter() - start) * 1000
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return {"up": True, "latency_ms": round(latency, 1), "detail": f"TCP {port} open"}
    except Exception as exc:
        return {"up": False, "latency_ms": None, "detail": type(exc).__name__}


async def _check_icmp(host: str) -> dict:
    try:
        proc = await asyncio.create_subprocess_exec(
            "ping", "-c", "1", "-W", str(_PING_TIMEOUT), host,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=_PING_TIMEOUT + 1)
    except (FileNotFoundError, asyncio.TimeoutError):
        return None  # ping unavailable/blocked → caller falls back to TCP
    if proc.returncode == 0:
        latency = None
        text = stdout.decode(errors="ignore")
        if "time=" in text:
            try:
                latency = round(float(text.split("time=")[1].split()[0]), 1)
            except (IndexError, ValueError):
                latency = None
        return {"up": True, "latency_ms": latency, "detail": "ICMP reply"}
    return {"up": False, "latency_ms": None, "detail": "no ICMP reply"}


async def _check_target(target: dict) -> dict:
    address = (target.get("address") or "").strip()
    label = target.get("label") or address
    if not address:
        return {"label": label, "address": address, "up": False, "latency_ms": None, "detail": "no address"}

    if address.startswith(("http://", "https://")):
        result = await _check_http(address)
    else:
        host, _, port = address.partition(":")
        if port:
            result = await _check_tcp(host, int(port))
        else:
            result = await _check_icmp(host)
            # ICMP unavailable (None) or blocked (up=False) → try TCP fallback
            if result is None or not result["up"]:
                icmp_result = result
                for fallback_port in (443, 80):
                    tcp = await _check_tcp(host, fallback_port)
                    if tcp["up"]:
                        tcp["detail"] += " (ICMP blocked)"
                        result = tcp
                        break
                else:
                    # All fallbacks failed — keep ICMP result if we had one, else TCP error
                    if icmp_result is not None:
                        result = icmp_result
    out = {"label": label, "address": address, **result}
    if target.get("group"):
        out["group"] = target["group"]
    return out


async def fetch(widget: dict, data_source: dict | None) -> dict:
    cfg = widget.get("config", {})
    targets = list(cfg.get("targets", []))

    ids = cfg.get("target_ids", [])
    if ids:
        from .. import db as _db
        lib = {t["id"]: t for t in _db.list_ping_targets()}
        for tid in ids:
            t = lib.get(tid)
            if t:
                targets.append({"label": t["label"], "address": t["address"], "group": t.get("group", "")})

    results = await asyncio.gather(*[_check_target(t) for t in targets])
    up = sum(1 for r in results if r["up"])
    return {"targets": list(results), "up_count": up, "total": len(results)}
