"""OPNsense integration via REST API.

Auth: HTTP Basic Auth (api_key + api_secret).

Endpoints (OPNsense 23.x+):
  GET /api/diagnostics/cpu_usage        → CPU idle %
  GET /api/diagnostics/memory           → memory bytes
  GET /api/diagnostics/traffic/interface → cumulative byte counters per interface
"""
import asyncio
import time
import httpx

_TIMEOUT = 10.0

# {widget_id: {"ts": float, "ifaces": {device: {"rx": int, "tx": int}}}}
_prev: dict = {}


async def _get(client: httpx.AsyncClient, url: str, auth: tuple) -> tuple[dict | None, str | None]:
    """Fetch a single endpoint. Returns (data, error_str)."""
    try:
        r = await client.get(url, auth=auth)
        if r.status_code == 401:
            return None, "Authentication failed — check API key and secret"
        if r.status_code == 404:
            return None, f"404 Not Found: {url}"
        r.raise_for_status()
        return r.json(), None
    except httpx.HTTPStatusError as e:
        return None, f"HTTP {e.response.status_code} from {url}"
    except Exception as exc:
        return None, f"Cannot reach {url}: {exc}"


async def fetch(widget: dict, data_source: dict | None) -> dict:
    if not data_source:
        return {"error": "No OPNsense data source configured. Add one in Settings → Integrations."}

    base_url   = data_source["base_url"].rstrip("/")
    creds      = data_source.get("credentials") or {}
    api_key    = creds.get("api_key", "").strip()
    api_secret = creds.get("api_secret", "").strip()

    if not api_key or not api_secret:
        return {"error": "Missing API credentials. Set API key and secret in Settings → Integrations."}

    auth      = (api_key, api_secret)
    widget_id = str(widget.get("id", "default"))

    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=False, follow_redirects=True) as client:
        try:
            (cpu_raw, cpu_err), (mem_raw, mem_err), (traffic_raw, traffic_err) = await asyncio.gather(
                _get(client, f"{base_url}/api/diagnostics/cpu_usage", auth),
                _get(client, f"{base_url}/api/diagnostics/memory", auth),
                _get(client, f"{base_url}/api/diagnostics/traffic/interface", auth),
            )
        except Exception as exc:
            return {"error": f"Cannot reach OPNsense: {exc}"}

    errors = [e for e in [cpu_err, mem_err, traffic_err] if e]
    if errors:
        return {"error": " | ".join(errors)}

    # ── CPU ──────────────────────────────────────────────────────────────────
    if isinstance(cpu_raw, dict):
        total_cpu = cpu_raw.get("total", {})
        idle = float(total_cpu.get("idle", 0))
        cpu_pct = round(100.0 - idle, 1)
    else:
        idles = [float(c.get("idle", 0)) for c in (cpu_raw or []) if isinstance(c, dict)]
        cpu_pct = round(100.0 - (sum(idles) / len(idles) if idles else 0.0), 1)
    cpu_pct = max(0.0, min(100.0, cpu_pct))

    # ── Memory ───────────────────────────────────────────────────────────────
    mem_total = int((mem_raw or {}).get("total", 0))
    mem_used  = int((mem_raw or {}).get("real-used", (mem_raw or {}).get("used", 0)))
    mem_pct   = round(mem_used / mem_total * 100, 1) if mem_total else 0.0

    # ── Traffic ──────────────────────────────────────────────────────────────
    ifaces_raw = (traffic_raw or {}).get("interfaces", {})

    now_ts      = time.monotonic()
    prev        = _prev.get(widget_id, {})
    prev_ts     = prev.get("ts", now_ts)
    prev_ifaces = prev.get("ifaces", {})
    delta_t     = max(now_ts - prev_ts, 0.001)

    interfaces = []
    new_ifaces: dict = {}
    for device, info in ifaces_raw.items():
        if device.startswith("lo"):
            continue
        rx_bytes = int(info.get("inbytes", 0))
        tx_bytes = int(info.get("outbytes", 0))
        new_ifaces[device] = {"rx": rx_bytes, "tx": tx_bytes}

        if device in prev_ifaces:
            rx_delta = max(0, rx_bytes - prev_ifaces[device]["rx"])
            tx_delta = max(0, tx_bytes - prev_ifaces[device]["tx"])
            rx_mbps  = round(rx_delta * 8 / 1_000_000 / delta_t, 3)
            tx_mbps  = round(tx_delta * 8 / 1_000_000 / delta_t, 3)
        else:
            rx_mbps = 0.0
            tx_mbps = 0.0

        interfaces.append({
            "device":  device,
            "name":    info.get("name", device) or device,
            "rx_mbps": rx_mbps,
            "tx_mbps": tx_mbps,
        })

    _prev[widget_id] = {"ts": now_ts, "ifaces": new_ifaces}

    if prev_ifaces:
        interfaces.sort(key=lambda i: -(i["rx_mbps"] + i["tx_mbps"]))

    return {
        "cpu_pct":    cpu_pct,
        "mem_pct":    mem_pct,
        "mem_used":   mem_used,
        "mem_total":  mem_total,
        "interfaces": interfaces,
    }
