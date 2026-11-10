"""RSS / Atom feed reader.

Widget config:
  {
    "feeds": ["https://hnrss.org/frontpage", "https://www.phoronix.com/rss.php"],
    "max_items": 20,
    "show_source": true,
    "show_images": true,
    "open": "qr"        # same | new | qr — what tapping a headline does on the display
  }

Feeds are parsed with defusedxml so a hostile feed can't use XML entity tricks,
and each feed is cached for five minutes.
"""
from __future__ import annotations

import asyncio
import html
import re
import time
from email.utils import parsedate_to_datetime

import httpx
from dateutil import parser as dateparser
from defusedxml import ElementTree as ET

_TIMEOUT = 10.0
_MAX_BYTES = 3 * 1024 * 1024
_TTL = 300.0
_cache: dict[str, tuple[float, dict]] = {}

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "media": "http://search.yahoo.com/mrss/",
    "content": "http://purl.org/rss/1.0/modules/content/",
    "itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
}
_TAG = re.compile(r"<[^>]+>")
_IMG = re.compile(r"""<img[^>]+src=["']([^"']+)""", re.I)


def _text(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def _clean(s: str, limit: int = 280) -> str:
    s = html.unescape(_TAG.sub(" ", s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s[: limit - 1] + "…" if len(s) > limit else s


def _date(s: str) -> float | None:
    if not s:
        return None
    try:
        return parsedate_to_datetime(s).timestamp()
    except (TypeError, ValueError, IndexError):
        pass
    try:
        return dateparser.parse(s).timestamp()
    except (ValueError, OverflowError, TypeError):
        return None


def _image(item, desc_html: str) -> str | None:
    for path, attr in (("media:content", "url"), ("media:thumbnail", "url"), ("itunes:image", "href")):
        el = item.find(path, _NS)
        if el is not None and el.get(attr):
            return el.get(attr)
    enc = item.find("enclosure")
    if enc is not None and (enc.get("type") or "").startswith("image/"):
        return enc.get("url")
    m = _IMG.search(desc_html or "")
    return html.unescape(m.group(1)) if m else None


def parse(xml: bytes) -> dict:
    root = ET.fromstring(xml)
    items = []
    if root.tag.endswith("feed"):  # Atom
        title = _text(root.find("atom:title", _NS))
        for e in root.findall("atom:entry", _NS):
            link = ""
            for l in e.findall("atom:link", _NS):
                if l.get("rel", "alternate") == "alternate":
                    link = l.get("href", "")
                    break
            summary = _text(e.find("atom:summary", _NS)) or _text(e.find("atom:content", _NS))
            items.append({
                "title": _clean(_text(e.find("atom:title", _NS)), 200), "link": link,
                "ts": _date(_text(e.find("atom:published", _NS)) or _text(e.find("atom:updated", _NS))),
                "summary": _clean(summary), "image": _image(e, summary),
            })
    else:  # RSS 2.0 / 0.9x
        ch = root.find("channel")
        title = _text(ch.find("title")) if ch is not None else ""
        for it in (ch.findall("item") if ch is not None else root.iter("item")):
            desc = _text(it.find("description")) or _text(it.find("content:encoded", _NS))
            items.append({
                "title": _clean(_text(it.find("title")), 200), "link": _text(it.find("link")),
                "ts": _date(_text(it.find("pubDate"))),
                "summary": _clean(desc), "image": _image(it, desc),
            })
    return {"title": _clean(title, 80), "items": items}


async def _feed(client: httpx.AsyncClient, url: str) -> dict:
    hit = _cache.get(url)
    if hit and time.monotonic() - hit[0] < _TTL:
        return hit[1]
    async with client.stream("GET", url) as r:
        if r.status_code >= 400:
            raise ValueError(f"HTTP {r.status_code}")
        raw = b""
        async for chunk in r.aiter_bytes():
            raw += chunk
            if len(raw) > _MAX_BYTES:
                raise ValueError("feed larger than 3 MB")
    feed = parse(raw)
    _cache[url] = (time.monotonic(), feed)
    return feed


async def fetch(widget: dict, data_source: dict | None) -> dict:
    cfg = widget.get("config") or {}
    urls = [u.strip() for u in cfg.get("feeds") or [] if str(u).strip().startswith(("http://", "https://"))]
    if not urls:
        return {"error": "Add at least one feed URL in the widget settings."}
    errors, items = [], []
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True,
                                 headers={"User-Agent": "TouchBoard/2 (RSS reader)"}) as client:
        results = await asyncio.gather(*[_feed(client, u) for u in urls], return_exceptions=True)
    for url, res in zip(urls, results):
        if isinstance(res, Exception):
            errors.append(f"{url.split('//', 1)[-1][:50]}: {type(res).__name__ if not str(res) else res}")
            continue
        for it in res["items"]:
            it = dict(it, source=res["title"] or url.split("//", 1)[-1].split("/", 1)[0])
            items.append(it)
    items.sort(key=lambda x: x.get("ts") or 0, reverse=True)
    limit = max(1, min(int(cfg.get("max_items") or 20), 100))
    if not items and errors:
        return {"error": "; ".join(errors)[:300]}
    return {"items": items[:limit], "feed_errors": errors}
