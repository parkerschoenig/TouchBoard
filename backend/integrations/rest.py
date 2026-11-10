"""Generic REST / JSON widget: call any HTTP API and show values from it.

Widget config:
  {
    "url": "/api/v1/status",           # absolute, or relative to the data source's base URL
    "method": "GET",                   # GET | POST
    "body": "",                        # raw request body for POST (sent as JSON if it parses)
    "display": "stats",                # stats | gauge | list
    "fields": [                        # stats / gauge
      {"label": "Uptime", "path": "data.uptime", "format": "duration", "unit": "", "max": 100, "decimals": 1}
    ],
    "list": {"path": "items[*]", "label": "name", "value": "status", "limit": 10}
  }

An optional data source of type "rest" holds the base URL and secrets:
  credentials: {"headers": "Authorization: Bearer abc\\nX-Api-Key: 123",
                "username": "", "password": ""}      # basic auth, optional

Paths use a small JSONPath subset: a.b.c, a[0].b, a[*].b, a['key with spaces'],
a.length, and $ for the whole document.
"""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import urljoin

import httpx

_TIMEOUT = 10.0
_MAX_BYTES = 2 * 1024 * 1024


def _tokens(path: str) -> list[tuple]:
    path = (path or "").strip()
    if path.startswith("$"):
        path = path[1:]
    out: list[tuple] = []
    i = 0
    while i < len(path):
        c = path[i]
        if c == ".":
            i += 1
            continue
        if c == "[":
            j = path.find("]", i)
            if j == -1:
                raise ValueError(f"unclosed [ in path {path!r}")
            inner = path[i + 1:j].strip()
            if inner == "*":
                out.append(("*",))
            elif inner[:1] in "'\"":
                out.append(("key", inner[1:-1]))
            else:
                out.append(("idx", int(inner)))
            i = j + 1
        else:
            j = i
            while j < len(path) and path[j] not in ".[":
                j += 1
            name = path[i:j]
            out.append(("*",) if name == "*" else ("key", name))
            i = j
    return out


def resolve(doc: Any, path: str) -> tuple[list[Any], bool]:
    """Return (matches, multi). `multi` is True when the path has a wildcard."""
    nodes = [doc]
    multi = False
    for tok in _tokens(path):
        nxt: list[Any] = []
        for n in nodes:
            if tok[0] == "key":
                if isinstance(n, dict) and tok[1] in n:
                    nxt.append(n[tok[1]])
                elif tok[1] == "length" and isinstance(n, (list, dict, str)):
                    nxt.append(len(n))
            elif tok[0] == "idx":
                if isinstance(n, list) and -len(n) <= tok[1] < len(n):
                    nxt.append(n[tok[1]])
            else:
                multi = True
                if isinstance(n, list):
                    nxt.extend(n)
                elif isinstance(n, dict):
                    nxt.extend(n.values())
        nodes = nxt
    return nodes, multi


def first(doc: Any, path: str) -> Any:
    found, _ = resolve(doc, path)
    return found[0] if found else None


def _scalar(v: Any) -> Any:
    if isinstance(v, (dict, list)):
        return json.dumps(v)[:200]
    return v


def _headers(creds: dict) -> dict:
    out = {"Accept": "application/json"}
    for line in str(creds.get("headers") or "").splitlines():
        name, sep, value = line.partition(":")
        if sep and name.strip():
            out[name.strip()] = value.strip()
    return out


async def request(cfg: dict, data_source: dict | None) -> tuple[int, Any]:
    """Run the configured request. Returns (status_code, parsed_json_or_text)."""
    url = (cfg.get("url") or "").strip()
    creds = (data_source or {}).get("credentials") or {}
    if data_source and not url.startswith(("http://", "https://")):
        url = urljoin(data_source["base_url"].rstrip("/") + "/", url.lstrip("/"))
    if not url.startswith(("http://", "https://")):
        raise ValueError("Set a full URL (http://…), or pick a REST data source and use a relative path.")
    method = (cfg.get("method") or "GET").upper()
    if method not in ("GET", "POST"):
        method = "GET"
    auth = (creds["username"], creds.get("password", "")) if creds.get("username") else None
    kwargs: dict = {"headers": _headers(creds)}
    body = cfg.get("body")
    if method == "POST" and body:
        try:
            kwargs["json"] = json.loads(body)
        except (TypeError, ValueError):
            kwargs["content"] = str(body).encode()

    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=False, follow_redirects=True, auth=auth) as client:
        async with client.stream(method, url, **kwargs) as r:
            raw = b""
            async for chunk in r.aiter_bytes():
                raw += chunk
                if len(raw) > _MAX_BYTES:
                    raise ValueError("Response is larger than 2 MB.")
            status = r.status_code
    text = raw.decode("utf-8", errors="replace")
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


async def fetch(widget: dict, data_source: dict | None) -> dict:
    cfg = widget.get("config") or {}
    try:
        status, doc = await request(cfg, data_source)
    except httpx.HTTPError as exc:
        return {"error": f"Request failed: {type(exc).__name__}"}
    except ValueError as exc:
        return {"error": str(exc)}
    if status >= 400:
        return {"error": f"HTTP {status}"}

    values = []
    for f in cfg.get("fields") or []:
        path = f.get("path") or ""
        try:
            v = first(doc, path) if path else doc
        except ValueError as exc:
            v = f"bad path: {exc}"
        values.append({
            "label": f.get("label") or path or "value",
            "value": _scalar(v),
            "unit": f.get("unit") or "",
            "format": f.get("format") or "auto",
            "max": f.get("max"),
            "decimals": f.get("decimals"),
        })

    rows = []
    lst = cfg.get("list") or {}
    if lst.get("path"):
        try:
            items, _ = resolve(doc, lst["path"])
        except ValueError:
            items = []
        limit = int(lst.get("limit") or 10)
        for it in items[:max(1, min(limit, 100))]:
            rows.append({
                "label": _scalar(first(it, lst["label"]) if lst.get("label") else it),
                "value": _scalar(first(it, lst["value"])) if lst.get("value") else None,
            })
    return {"status": status, "values": values, "rows": rows}
