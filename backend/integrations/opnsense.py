"""OPNsense integration via REST API.

Auth: HTTP Basic Auth (api_key + api_secret).

Endpoints used:
  GET /api/diagnostics/activity/getActivity  → CPU + memory (top-style header strings)
  GET /api/diagnostics/traffic/interface     → cumulative byte counters per interface
"""
import asyncio
import re
import time
import httpx

_TIMEOUT = 10.0

# {widget_id: {"ts": float, "ifaces": {device: {"rx": int, "tx": int}}}}
_prev: dict = {}

_SIZE_RE = re.compile(r"^([\d.]+)([KMGT]?)$", re.IGNORECASE)
_UNITS   = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4, "": 1}


def _parse_size(s: str) -> int:
    """Parse '258M', '2116K', '8G' → bytes."""
    m = _SIZE_RE.match(s.strip())
    if not m:
        return 0
    return int(float(m.group(1)) * _UNITS.get(m.group(2).upper(), 1))


def _parse_headers(headers: list[str]) -> tuple[float, int, int]:
    """Return (cpu_pct, mem_used_bytes, mem_total_bytes) from top header lines."""
    cpu_pct  = 0.0
    mem_used = 0
    mem_total = 0

    for line in headers:
        # "CPU:  0.2% user,  0.0% nice,  0.0% system,  1.2% interrupt, 98.6% idle"
        m = re.search(r"([\d.]+)%\s+idle", line)
        if m:
            cpu_pct = round(100.0 - float(m.group(1)), 1)

        # "Mem: 109M Active, 1035M Inact, 107M Laundry, 447M Wired, 200M Buf, 258M Free"
        if line.lstrip().startswith("Mem:"):
            parts: dict[str, int] = {}
            for seg in line.split(":", 1)[1].split(","):
                seg = seg.strip().split()
                if len(seg) == 2:
                    parts[seg[1]] = _parse_size(seg[0])
            mem_total = sum(parts.values())
            mem_used  = mem_total - parts.get("Free", 0)

    return cpu_pct, mem_used, mem_total


async def _get(client: httpx.AsyncClient, url: str, auth: tuple) -> tuple[dict | None, str | None]:
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
        return None, f"Cannot reach OPNsense: {exc}"


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
            (activity_raw, activity_err), (traffic_raw, traffic_err) = await asyncio.gather(
                _get(client, f"{base_url}/api/diagnostics/activity/getActivity", auth),
                _get(client, f"{base_url}/api/diagnostics/traffic/interface", auth),
            )
        except Exception as exc:
            return {"error": f"Cannot reach OPNsense: {exc}"}

    errors = [e for e in [activity_err, traffic_err] if e]
    if errors:
        return {"error": " | ".join(errors)}

    # ── CPU + Memory from header strings ─────────────────────────────────────
    headers  = (activity_raw or {}).get("headers", [])
    cpu_pct, mem_used, mem_total = _parse_headers(headers)
    mem_pct  = round(mem_used / mem_total * 100, 1) if mem_total else 0.0

    # ── Traffic ──────────────────────────────────────────────────────────────
    ifaces_raw = (traffic_raw or {}).get("interfaces", {})

    # Temporary: show first interface's raw fields so we can see the byte field names
    if ifaces_raw:
        first_key = next(iter(ifaces_raw))
        return {"error": f"DEBUG first iface '{first_key}': {ifaces_raw[first_key]}"}

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
