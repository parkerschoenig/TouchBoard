"""AdGuard Home integration via REST API.

Auth: HTTP Basic Auth (username + password).

Endpoints used:
  GET /control/stats             → queries/blocked counts today
  GET /control/filtering/status  → filter list with rules counts
"""
import asyncio
import httpx

_TIMEOUT = 10.0


async def fetch(widget: dict, data_source: dict | None) -> dict:
    if not data_source:
        return {"error": "No AdGuard data source configured. Add one in Settings → Integrations."}

    base_url = data_source["base_url"].rstrip("/")
    creds    = data_source.get("credentials") or {}
    username = creds.get("username", "").strip()
    password = creds.get("password", "").strip()

    if not username or not password:
        return {"error": "Missing credentials. Set username and password in Settings → Integrations."}

    auth = (username, password)

    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=False) as client:
        try:
            stats_r, filter_r = await asyncio.gather(
                client.get(f"{base_url}/control/stats", auth=auth),
                client.get(f"{base_url}/control/filtering/status", auth=auth),
            )
            stats_r.raise_for_status()
            filter_r.raise_for_status()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                return {"error": "Authentication failed. Check username and password."}
            return {"error": f"AdGuard API error: {e.response.status_code}"}
        except Exception as exc:
            return {"error": f"Cannot reach AdGuard: {exc}"}

    stats  = stats_r.json()
    fstats = filter_r.json()

    queries  = int(stats.get("num_dns_queries", 0))
    blocked  = int(stats.get("num_blocked_filtering", 0))
    blocked += int(stats.get("num_replaced_safebrowsing", 0))
    blocked += int(stats.get("num_replaced_parental", 0))
    blocked_pct = round(blocked / queries * 100, 2) if queries else 0.0

    domain_count = sum(
        int(f.get("rules_count", 0))
        for f in fstats.get("filters", [])
        if f.get("enabled", False)
    )

    return {
        "queries_today":  queries,
        "blocked_today":  blocked,
        "blocked_pct":    blocked_pct,
        "domains_on_blocklist": domain_count,
    }
