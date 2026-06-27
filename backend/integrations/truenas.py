"""TrueNAS stats via JSON-RPC 2.0 over WebSocket.

TrueNAS 25.04+ removed the REST API. All calls go through
  wss://host/api/current  using JSON-RPC 2.0.

Session flow:
  1. Connect to wss://host/api/current
  2. auth.login([username, password])    → true
  3. pool.query([])                      → pool list
  4. pool.dataset.query([[filter]], {})  → root dataset (usable capacity)
  5. system.info([])                     → physmem (fallback total RAM)
  6. core.subscribe(["reporting.realtime"]) → wait for collection_update
  7. sensor.query([])                    → CPU temperature
"""
import asyncio
import json
import ssl
from urllib.parse import urlparse

import websockets

_OPEN_TIMEOUT = 10.0
_RPC_TIMEOUT  = 15.0
_RT_TIMEOUT   = 10.0   # seconds to wait for a reporting.realtime notification


# ── CPU parsing ───────────────────────────────────────────────────────────────

def _parse_cpu_obj(cpu: dict, result: dict) -> None:
    if not cpu:
        return

    def _from_flat(d: dict):
        if "idle" in d:
            return round(100.0 - float(d["idle"]), 1)
        if "usage" in d:
            return round(float(d["usage"]), 1)
        if "percent" in d:
            return round(float(d["percent"]), 1)
        return None

    if any(k in cpu for k in ("idle", "usage", "percent", "user", "system")):
        v = _from_flat(cpu)
        if v is not None:
            result["cpu_pct"] = v
            return

    core_vals = []
    for key, val in cpu.items():
        if not isinstance(val, dict):
            continue
        v = _from_flat(val)
        if v is not None:
            if key == "cpu":
                result["cpu_pct"] = v
                return
            core_vals.append(v)

    if core_vals and "cpu_pct" not in result:
        result["cpu_pct"] = round(sum(core_vals) / len(core_vals), 1)


# ── JSON-RPC helpers ──────────────────────────────────────────────────────────

async def _rpc(ws, msg_id: int, method: str, params=None):
    """Send one JSON-RPC 2.0 request; skip any interleaved notifications; return result."""
    await ws.send(json.dumps({
        "jsonrpc": "2.0",
        "id": msg_id,
        "method": method,
        "params": params if params is not None else [],
    }))
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=_RPC_TIMEOUT)
        msg = json.loads(raw)
        if msg.get("id") == msg_id:
            if "error" in msg:
                err = msg["error"]
                reason = (err.get("data") or {}).get("reason") or err.get("message") or str(err)
                raise RuntimeError(reason)
            return msg.get("result")
        # Skip notifications (no id or different id) while waiting for our response


def _ds_int(val) -> int:
    """Parse a dataset field that may be an int or a {parsed, rawvalue} dict."""
    if isinstance(val, dict):
        return int(val.get("parsed") or val.get("rawvalue") or 0)
    return int(val or 0)


# ── main ──────────────────────────────────────────────────────────────────────

_DEMO_DATA = {
    "pools": [
        {"name": "data",   "status": "online", "used": 3_800_000_000_000, "total": 8_000_000_000_000},
        {"name": "backup", "status": "online", "used":   900_000_000_000, "total": 4_000_000_000_000},
    ],
    "mem_total": 34_359_738_368,
    "mem_used":  18_253_611_008,
    "mem_arc":    8_589_934_592,
    "cpu_pct": 12.4,
}


async def fetch(widget: dict, data_source: dict | None) -> dict:
    from ..demo import DEMO_MODE
    if DEMO_MODE:
        return _DEMO_DATA

    if not data_source:
        return {"error": "No TrueNAS data source configured. Add one in Settings → Integrations."}

    base_url    = data_source["base_url"].rstrip("/")
    creds       = data_source.get("credentials") or {}
    username    = creds.get("username", "").strip()
    password    = creds.get("password", "").strip()

    if not (username and password):
        return {"error": "No credentials configured. Add a username and password in Settings → Integrations."}

    cfg         = widget.get("config", {})
    pool_filter = (cfg.get("pool_name") or "").strip().lower()

    parsed = urlparse(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    ws_url = f"{scheme}://{parsed.netloc}/api/current"

    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode    = ssl.CERT_NONE

    result: dict = {}

    try:
        async with websockets.connect(
            ws_url,
            ssl=ssl_ctx,
            open_timeout=_OPEN_TIMEOUT,
            ping_interval=None,
            ping_timeout=None,
        ) as ws:
            _id = 0

            async def call(method, params=None):
                nonlocal _id
                _id += 1
                return await _rpc(ws, _id, method, params)

            # ── authenticate ──────────────────────────────────────────────────
            ok = await call("auth.login", [username, password])
            if not ok:
                return {"error": "TrueNAS authentication failed: username/password rejected. Check credentials in Settings → Integrations."}

            # ── pools ─────────────────────────────────────────────────────────
            try:
                pools_raw = await call("pool.query", []) or []
                pools = []
                for p in pools_raw:
                    pname = p.get("name", "")
                    if pool_filter and pname.lower() != pool_filter:
                        continue

                    used  = int(p.get("allocated") or 0)
                    free  = int(p.get("free") or 0)
                    total = used + free

                    # Root dataset = actual ZFS usable capacity (not raw drive size)
                    try:
                        ds_list = await call(
                            "pool.dataset.query",
                            [[["id", "=", pname]], {"select": ["id", "available", "used"]}],
                        ) or []
                        if ds_list:
                            root     = ds_list[0]
                            ds_avail = _ds_int(root.get("available"))
                            ds_used  = _ds_int(root.get("used"))
                            if ds_avail > 0 or ds_used > 0:
                                used, free, total = ds_used, ds_avail, ds_used + ds_avail
                    except Exception:
                        pass

                    pools.append({
                        "name":   pname,
                        "status": (p.get("status") or "UNKNOWN").upper(),
                        "total":  total,
                        "used":   used,
                        "free":   free,
                    })
                result["pools"] = pools
            except Exception as exc:
                result["pools"]       = []
                result["pools_error"] = f"{type(exc).__name__}: {exc}"

            # ── system info → fallback total RAM ──────────────────────────────
            try:
                info = await call("system.info", []) or {}
                if info.get("physmem"):
                    result["mem_total"]      = int(info["physmem"])
                    result["mem_total_only"] = True
            except Exception:
                pass

            # ── reporting.realtime (CPU + memory live stats) ──────────────────
            try:
                await call("core.subscribe", ["reporting.realtime"])

                loop     = asyncio.get_running_loop()
                deadline = loop.time() + _RT_TIMEOUT
                errors   = []
                while loop.time() < deadline:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    except asyncio.TimeoutError:
                        break
                    msg = json.loads(raw)
                    # Notifications have no "id" and method="collection_update"
                    if msg.get("method") == "collection_update":
                        p = msg.get("params") or {}
                        if p.get("collection") == "reporting.realtime":
                            fields = p.get("fields") or {}
                            mem    = fields.get("memory") or {}
                            total  = mem.get("physical_memory_total")
                            avail  = mem.get("physical_memory_available")
                            arc    = mem.get("arc_size")
                            if total is not None and avail is not None:
                                result["mem_total"] = int(total)
                                result["mem_free"]  = int(avail)
                                result["mem_used"]  = int(total - avail)
                                result.pop("mem_total_only", None)
                            if arc is not None:
                                result["mem_arc"] = int(arc)
                            _parse_cpu_obj(fields.get("cpu") or {}, result)
                            break
                    elif msg.get("id") is not None:
                        errors.append(f"unexpected rpc response: {msg}")

                if errors:
                    result["ws_errors"] = errors
            except Exception as exc:
                result["ws_errors"] = [f"{type(exc).__name__}: {exc}"]


    except Exception as exc:
        result.setdefault("pools", [])
        result["error"] = f"WebSocket connection failed: {type(exc).__name__}: {exc}"

    return result
