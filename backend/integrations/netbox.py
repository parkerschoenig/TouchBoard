"""NetBox integration: rack elevation, device count, IP addresses."""
import httpx

_TIMEOUT = 12.0


async def fetch(widget: dict, data_source: dict | None) -> dict:
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
