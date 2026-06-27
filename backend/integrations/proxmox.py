"""Proxmox VE stats via API token authentication.

Auth header: PVEAPIToken=username@realm!tokenid=apikey

Fetches:
  /api2/json/nodes                    → node list (cpu, mem, uptime, status)
  /api2/json/nodes/{node}/qemu        → VMs per node
  /api2/json/nodes/{node}/lxc         → LXCs per node
  /api2/json/nodes/{node}/storage     → storage per node
"""
import asyncio
import httpx

_TIMEOUT = 12.0

_DEMO_DATA = {
    "uptime": 1_209_600,
    "cluster_cpu_pct": 34.2,
    "cluster_mem_pct": 61.7,
    "nodes": [
        {"name": "node-a", "status": "online", "cpu_pct": 38.1, "mem_pct": 65.4},
        {"name": "node-b", "status": "online", "cpu_pct": 30.3, "mem_pct": 57.9},
    ],
    "vms": [
        {"id": 100, "name": "ubuntu-docker",  "status": "running", "cpu_pct": 12.3, "mem_pct": 44.1},
        {"id": 101, "name": "pihole",          "status": "running", "cpu_pct":  2.1, "mem_pct": 18.6},
        {"id": 102, "name": "nginx-proxy",     "status": "running", "cpu_pct":  4.7, "mem_pct": 22.3},
        {"id": 103, "name": "dev-workstation", "status": "stopped", "cpu_pct":  0.0, "mem_pct":  0.0},
        {"id": 104, "name": "minecraft",       "status": "running", "cpu_pct": 18.9, "mem_pct": 71.2},
    ],
    "lxcs": [
        {"id": 200, "name": "homeassistant", "status": "running", "cpu_pct":  5.4, "mem_pct": 31.0},
        {"id": 201, "name": "monitoring",    "status": "running", "cpu_pct":  8.2, "mem_pct": 42.5},
        {"id": 202, "name": "backup-agent",  "status": "running", "cpu_pct":  1.1, "mem_pct": 12.8},
    ],
    "storage": [
        {"storage": "local-lvm", "node": "node-a", "status": "active", "used": 214_748_364_800, "total": 500_107_862_016},
        {"storage": "local-lvm", "node": "node-b", "status": "active", "used": 107_374_182_400, "total": 500_107_862_016},
        {"storage": "nfs-nas",   "node": "node-a", "status": "active", "used": 858_993_459_200, "total": 2_000_398_934_016},
    ],
}


async def fetch(widget: dict, data_source: dict | None) -> dict:
    from ..demo import DEMO_MODE
    if DEMO_MODE:
        return _DEMO_DATA

    if not data_source:
        return {"error": "No Proxmox data source configured. Add one in Settings → Integrations."}

    creds    = data_source.get("credentials") or {}
    username = creds.get("username", "").strip()
    token_id = creds.get("token_id", "").strip()
    api_key  = creds.get("api_key", "").strip()
    realm    = (creds.get("realm", "") or "pam").strip()

    if not username or not token_id or not api_key:
        return {"error": "Missing credentials. Set username, token ID, and API key in Settings → Integrations."}

    base_url = data_source["base_url"].rstrip("/")
    token    = f"{username}@{realm}!{token_id}={api_key}"
    headers  = {"Authorization": f"PVEAPIToken={token}"}

    result: dict = {"nodes": [], "vms": [], "lxcs": [], "storage": []}

    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=False) as client:

        async def get(path: str):
            r = await client.get(f"{base_url}/api2/json/{path}", headers=headers)
            r.raise_for_status()
            return r.json().get("data") or []

        # ── nodes ─────────────────────────────────────────────────────────────
        try:
            raw_nodes = await get("nodes")
        except Exception as exc:
            return {"error": f"Cannot reach Proxmox API: {exc}"}

        nodes = []
        uptime = 0
        total_cpu_pct = 0.0
        total_mem_used = 0
        total_mem_total = 0

        for n in raw_nodes:
            cpu_pct  = round(float(n.get("cpu") or 0) * 100, 1)
            mem_used  = int(n.get("mem")    or 0)
            mem_total = int(n.get("maxmem") or 0)
            mem_pct   = round(mem_used / mem_total * 100, 1) if mem_total else 0.0
            node_uptime = int(n.get("uptime") or 0)

            nodes.append({
                "name":      n.get("node", ""),
                "status":    n.get("status", "unknown"),
                "cpu_pct":   cpu_pct,
                "mem_pct":   mem_pct,
                "mem_used":  mem_used,
                "mem_total": mem_total,
            })

            if n.get("status") == "online":
                total_cpu_pct   += cpu_pct
                total_mem_used  += mem_used
                total_mem_total += mem_total
                uptime = max(uptime, node_uptime)

        result["nodes"]           = nodes
        result["uptime"]          = uptime
        result["cluster_cpu_pct"] = round(total_cpu_pct / len(nodes), 1) if nodes else 0.0
        result["cluster_mem_pct"] = round(total_mem_used / total_mem_total * 100, 1) if total_mem_total else 0.0

        # ── VMs, LXCs, Storage (per online node) ──────────────────────────────
        online_nodes = [n["name"] for n in nodes if n["status"] == "online"]

        async def fetch_node(node_name: str):
            vms_out  = []
            lxcs_out = []
            stor_out = []

            try:
                raw_vms = await get(f"nodes/{node_name}/qemu")
                for v in raw_vms:
                    mem_total = int(v.get("maxmem") or 0)
                    mem_used  = int(v.get("mem")    or 0)
                    vms_out.append({
                        "vmid":    v.get("vmid"),
                        "name":    v.get("name", f"vm-{v.get('vmid')}"),
                        "node":    node_name,
                        "status":  v.get("status", "unknown"),
                        "cpu_pct": round(float(v.get("cpu") or 0) * 100, 1),
                        "mem_pct": round(mem_used / mem_total * 100, 1) if mem_total else 0.0,
                    })
            except Exception:
                pass

            try:
                raw_lxcs = await get(f"nodes/{node_name}/lxc")
                for c in raw_lxcs:
                    mem_total = int(c.get("maxmem") or 0)
                    mem_used  = int(c.get("mem")    or 0)
                    lxcs_out.append({
                        "vmid":    c.get("vmid"),
                        "name":    c.get("name", f"ct-{c.get('vmid')}"),
                        "node":    node_name,
                        "status":  c.get("status", "unknown"),
                        "cpu_pct": round(float(c.get("cpu") or 0) * 100, 1),
                        "mem_pct": round(mem_used / mem_total * 100, 1) if mem_total else 0.0,
                    })
            except Exception:
                pass

            try:
                raw_stor = await get(f"nodes/{node_name}/storage")
                for s in raw_stor:
                    used  = int(s.get("used")  or 0)
                    total = int(s.get("total") or 0)
                    stor_out.append({
                        "storage": s.get("storage", ""),
                        "node":    node_name,
                        "status":  "active" if s.get("active") else "inactive",
                        "used":    used,
                        "total":   total,
                    })
            except Exception:
                pass

            return vms_out, lxcs_out, stor_out

        node_results = await asyncio.gather(*[fetch_node(n) for n in online_nodes])

        for vms, lxcs, stor in node_results:
            result["vms"]     += vms
            result["lxcs"]    += lxcs
            result["storage"] += stor

        # Sort VMs and LXCs: running first, then by name
        for key in ("vms", "lxcs"):
            result[key].sort(key=lambda x: (x["status"] != "running", x["name"].lower()))

    return result
