"""Photo frame: a slideshow from a folder on the server or a list of image URLs.

Widget config:
  {
    "source": "folder",            # folder | urls
    "folder": "/srv/photos/frame", # read recursively; only image files are served
    "urls": ["https://…/a.jpg"],
    "interval": 20,                # seconds per photo (client side)
    "fit": "cover",                # cover | contain
    "shuffle": true,
    "kenburns": true,
    "caption": false
  }

Folder images are served by /api/widgets/{id}/photo/{index}. The route only
serves files from this module's listing of the configured folder, so a request
can't reach anything outside it.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import time
from pathlib import Path

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}
_LIMIT = 5000
_TTL = 120.0
_cache: dict[str, tuple[float, list[Path]]] = {}


def _scan(folder: str) -> list[Path]:
    root = Path(folder).expanduser().resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Folder not found: {folder}")
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            p = Path(dirpath) / name
            if p.suffix.lower() in IMAGE_EXT:
                files.append(p)
                if len(files) >= _LIMIT:
                    return files
    return files


def list_folder(folder: str, fresh: bool = False) -> list[Path]:
    now = time.monotonic()
    hit = _cache.get(folder)
    if hit and not fresh and now - hit[0] < _TTL:
        return hit[1]
    files = _scan(folder)
    _cache[folder] = (now, files)
    return files


def photo_path(folder: str, index: int) -> Path | None:
    files = list_folder(folder)
    if 0 <= index < len(files):
        root = Path(folder).expanduser().resolve()
        p = files[index].resolve()
        if root in p.parents and p.is_file():
            return p
    return None


async def fetch(widget: dict, data_source: dict | None) -> dict:
    cfg = widget.get("config") or {}
    if (cfg.get("source") or "folder") == "urls":
        urls = [u.strip() for u in cfg.get("urls") or [] if str(u).strip().startswith(("http://", "https://"))]
        return {"source": "urls", "count": len(urls), "urls": urls}
    folder = (cfg.get("folder") or "").strip()
    if not folder:
        return {"error": "Set a folder path in the widget settings."}
    try:
        files = await asyncio.to_thread(list_folder, folder, True)
    except (FileNotFoundError, PermissionError) as exc:
        return {"error": str(exc)}
    names = [f.name for f in files] if cfg.get("caption") else []
    rev = hashlib.sha1("\n".join(str(f) for f in files).encode()).hexdigest()[:12]
    return {"source": "folder", "count": len(files), "rev": rev, "names": names[:1000]}
