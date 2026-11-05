"""Fetch and cache site icons for the bookmarks widget.

Icons are cached on disk next to the database for a week (failures for a day),
so a display that reloads doesn't hit every site again. Only URLs that are
saved in a bookmarks widget are ever fetched — the route looks the URL up by
widget id and item index, it never takes a URL from the request.
"""
import asyncio
import hashlib
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx

from .db import DB_PATH

_DIR = DB_PATH.parent / "cache" / "favicons"
_TTL_OK = 7 * 86400
_TTL_MISS = 86400
_MAX_BYTES = 512 * 1024
_TIMEOUT = 6.0
_locks: dict[str, asyncio.Lock] = {}


class _IconLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[tuple[int, str]] = []

    def handle_starttag(self, tag, attrs):
        if tag != "link":
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        rel = a.get("rel", "").lower()
        href = a.get("href", "")
        if not href or "icon" not in rel:
            return
        score = 0
        if "apple-touch-icon" in rel:
            score = 180
        sizes = a.get("sizes", "")
        for part in sizes.split():
            try:
                score = max(score, int(part.lower().split("x")[0]))
            except ValueError:
                pass
        if href.lower().endswith(".svg"):
            score = max(score, 120)
        self.links.append((score or 16, href))


def _key(url: str) -> str:
    p = urlparse(url)
    return hashlib.sha1(f"{p.scheme}://{p.netloc}".encode()).hexdigest()


async def _get(client: httpx.AsyncClient, url: str) -> tuple[bytes, str, str] | None:
    """GET with a size cap. Returns (body, content_type, final_url) or None."""
    try:
        async with client.stream("GET", url) as r:
            if r.status_code != 200:
                return None
            body = b""
            async for chunk in r.aiter_bytes():
                body += chunk
                if len(body) > _MAX_BYTES:
                    return None
            ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
            return body, ctype, str(r.url)
    except Exception:
        return None


def _is_image(ctype: str) -> bool:
    return ctype.startswith("image/") or ctype in ("application/octet-stream", "application/ico")


async def _discover(url: str) -> tuple[bytes, str] | None:
    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=False, follow_redirects=True,
                                 headers={"User-Agent": "TouchBoard/2 (favicon fetch)"}) as client:
        page = await _get(client, url)
        candidates: list[str] = []
        if page is not None and "html" in page[1]:
            parser = _IconLinks()
            try:
                parser.feed(page[0].decode("utf-8", errors="ignore")[:200_000])
            except Exception:
                pass
            candidates += [urljoin(page[2], href) for _s, href in sorted(parser.links, reverse=True)]
        p = urlparse(url)
        candidates.append(f"{p.scheme}://{p.netloc}/favicon.ico")
        for c in candidates[:4]:
            r = await _get(client, c)
            if r is not None and r[0] and _is_image(r[1]):
                ctype = "image/svg+xml" if c.lower().split("?")[0].endswith(".svg") else (r[1] or "image/x-icon")
                if ctype == "application/octet-stream":
                    ctype = "image/x-icon"
                return r[0], ctype
    return None


async def get_icon(url: str) -> tuple[bytes, str] | None:
    if not url.startswith(("http://", "https://")):
        return None
    key = _key(url)
    data_path, type_path, miss_path = _DIR / f"{key}.bin", _DIR / f"{key}.type", _DIR / f"{key}.miss"
    now = time.time()
    if data_path.exists() and now - data_path.stat().st_mtime < _TTL_OK:
        return data_path.read_bytes(), type_path.read_text() if type_path.exists() else "image/x-icon"
    if miss_path.exists() and now - miss_path.stat().st_mtime < _TTL_MISS:
        return None
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        if data_path.exists() and now - data_path.stat().st_mtime < _TTL_OK:
            return data_path.read_bytes(), type_path.read_text() if type_path.exists() else "image/x-icon"
        found = await _discover(url)
        _DIR.mkdir(parents=True, exist_ok=True)
        if not found:
            miss_path.write_text("")
            return None
        body, ctype = found
        data_path.write_bytes(body)
        type_path.write_text(ctype)
        miss_path.unlink(missing_ok=True)
        return body, ctype
