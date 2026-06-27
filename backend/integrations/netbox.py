"""NetBox integration: rack elevation, device count, IP addresses, virtual machines."""
import httpx

_TIMEOUT = 12.0

_DEMO_DATA = {
    "total_devices": 14,
    "total_ips": 38,
    "total_vms": 8,
    "rack": {
        "name": "12U Homelab Rack",
        "site": "Home Lab",
        "u_height": 12,
        "devices": [
            {"name": "Storage Server", "role": "Storage",  "position": 1, "u_height": 2, "status": "active"},
            {"name": "Core Switch",    "role": "Network",  "position": 3, "u_height": 1, "status": "active"},
            {"name": "Compute A",      "role": "Compute",  "position": 4, "u_height": 2, "status": "active"},
            {"name": "Compute B",      "role": "Compute",  "position": 6, "u_height": 2, "status": "active"},
            {"name": "UPS",            "role": "Power",    "position": 8, "u_height": 2, "status": "active"},
            {"name": "DNS Appliance",  "role": "DNS",      "position": 10,"u_height": 1, "status": "active"},
        ],
    },
    "ips": [
        {"address": "10.0.1.1/24",  "status": "active", "dns_name": "gateway",     "assigned_device": "Core Switch"},
        {"address": "10.0.1.10/24", "status": "active", "dns_name": "storage",     "assigned_device": "Storage Server"},
        {"address": "10.0.1.20/24", "status": "active", "dns_name": "media-host",  "assigned_device": ""},
        {"address": "10.0.1.21/24", "status": "active", "dns_name": "app-server",  "assigned_device": ""},
        {"address": "10.0.1.22/24", "status": "active", "dns_name": "web-server",  "assigned_device": ""},
        {"address": "10.0.1.25/24", "status": "active", "dns_name": "indexer",     "assigned_device": ""},
        {"address": "10.0.2.10/24", "status": "active", "dns_name": "compute-a",   "assigned_device": "Compute A"},
        {"address": "10.0.2.11/24", "status": "active", "dns_name": "compute-b",   "assigned_device": "Compute B"},
    ],
    "vms": [
        {"name": "ubuntu-docker"},
        {"name": "pihole"},
        {"name": "nginx-proxy"},
        {"name": "dev-workstation"},
        {"name": "minecraft"},
        {"name": "homeassistant"},
        {"name": "monitoring"},
        {"name": "backup-agent"},
    ],
}


async def fetch(widget: dict, data_source: dict | None) -> dict:
    from ..demo import DEMO_MODE
    if DEMO_MODE:
        return _DEMO_DATA

    if not data_source:
        return {"error": "No NetBox data source configured. Add one in Settings → Integrations."}

    base_url = data_source["base_url"].rstrip("/")
    token = (data_source.get("credentials") or {}).get("token", "")
    if not token:
        return {"error": "No API token found for this data source."}

    headers = {"Authorization": f"Token {token}", "Accept": "application/json"}
    cfg = widget.get("config", {})
    rack_name = (cfg.get("rack_name") or "").strip()

    result: dict = {}

    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=False) as client:

        # ── Total device count ────────────────────────────────────────────────
        try:
            r = await client.get(f"{base_url}/api/dcim/devices/?limit=1", headers=headers)
            r.raise_for_status()
            result["total_devices"] = r.json().get("count", 0)
        except Exception as exc:
            result["total_devices"] = None
            result["devices_error"] = str(exc)

        # ── IP addresses (first 25, sorted) ───────────────────────────────────
        try:
            r = await client.get(
                f"{base_url}/api/ipam/ip-addresses/?limit=25&ordering=address",
                headers=headers,
            )
            r.raise_for_status()
            data = r.json()
            result["total_ips"] = data.get("count", 0)

            def _assigned_device(ip: dict) -> str:
                obj = ip.get("assigned_object") or {}
                # dcim.interface → has a nested "device"; virtualization.vminterface → has "virtual_machine"
                dev = obj.get("device") or obj.get("virtual_machine") or {}
                return dev.get("name", "")

            result["ips"] = [
                {
                    "address":         ip.get("address", ""),
                    "status":          (ip.get("status") or {}).get("value", ""),
                    "description":     ip.get("description", ""),
                    "dns_name":        ip.get("dns_name", ""),
                    "vrf":             (ip.get("vrf") or {}).get("name", ""),
                    "assigned_device": _assigned_device(ip),
                }
                for ip in data.get("results", [])
            ]
        except Exception as exc:
            result["total_ips"] = None
            result["ips"] = []
            result["ips_error"] = str(exc)

        # ── Virtual machines ──────────────────────────────────────────────
        try:
            r = await client.get(
                f"{base_url}/api/virtualization/virtual-machines/?limit=50&ordering=name",
                headers=headers,
            )
            r.raise_for_status()
            data = r.json()
            result["total_vms"] = data.get("count", 0)
            result["vms"] = [
                {
                    "name":    vm.get("name", ""),
                    "status":  (vm.get("status") or {}).get("value", ""),
                    "cluster": (vm.get("cluster") or {}).get("name", ""),
                    "vcpus":   vm.get("vcpus"),
                    "memory":  vm.get("memory"),
                }
                for vm in data.get("results", [])
            ]
        except Exception as exc:
            result["total_vms"] = None
            result["vms"] = []
            result["vms_error"] = str(exc)

        # ── Rack elevation ────────────────────────────────────────────────────
        if not rack_name:
            result["rack"] = {"error": "No rack name configured"}
        else:
            try:
                r = await client.get(
                    f"{base_url}/api/dcim/racks/?name={rack_name}&limit=1",
                    headers=headers,
                )
                r.raise_for_status()
                racks = r.json().get("results", [])
                if not racks:
                    result["rack"] = {"error": f"Rack '{rack_name}' not found in NetBox"}
                else:
                    rack   = racks[0]
                    rack_id   = rack["id"]
                    u_height  = rack.get("u_height", 42)
                    site      = (rack.get("site") or {}).get("name", "")

                    # Devices endpoint gives correct position + role;
                    # device_type is abbreviated in list responses so we
                    # batch-fetch device_types separately for accurate u_height.
                    r = await client.get(
                        f"{base_url}/api/dcim/devices/?rack_id={rack_id}&face=front&limit=0",
                        headers=headers,
                    )
                    r.raise_for_status()
                    devices = r.json().get("results", [])

                    dt_ids = {
                        str((d.get("device_type") or {}).get("id"))
                        for d in devices
                        if (d.get("device_type") or {}).get("id") is not None
                    }
                    dt_heights: dict = {}
                    if dt_ids:
                        params = [("id", v) for v in dt_ids] + [("limit", "0")]
                        r2 = await client.get(
                            f"{base_url}/api/dcim/device-types/",
                            params=params,
                            headers=headers,
                        )
                        if r2.is_success:
                            for dt in r2.json().get("results", []):
                                dt_heights[dt["id"]] = dt.get("u_height", 1)

                    device_list = []
                    for d in devices:
                        pos = d.get("position")
                        if pos is None:
                            continue
                        role = d.get("role") or d.get("device_role") or {}
                        dt_id = (d.get("device_type") or {}).get("id")
                        device_list.append({
                            "name":     d.get("name", "Unknown"),
                            "role":     role.get("name", ""),
                            "position": int(pos),
                            "u_height": dt_heights.get(dt_id, 1),
                            "status":   (d.get("status") or {}).get("value", "active"),
                        })

                    result["rack"] = {
                        "name":     rack_name,
                        "site":     site,
                        "u_height": u_height,
                        "devices":  device_list,
                    }
            except Exception as exc:
                result["rack"] = {"error": str(exc)}

    return result
