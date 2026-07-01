"""Periodically checks GitHub for a newer commit on main (or a tagged release)
than the one currently running, so the UI can show an "update available" badge.

Comparison is against the actual running git commit rather than a manually
maintained version file, so it stays correct without extra bookkeeping.
"""
import asyncio
import subprocess
import time
from pathlib import Path

import httpx

REPO = "parkerschoenig/TouchBoard"
_INTERVAL = 6 * 3600  # re-check GitHub every 6 hours
_TIMEOUT = 10.0
_REPO_ROOT = Path(__file__).parent.parent

_state: dict = {"checked_at": None, "update_available": False, "sha": None, "url": None, "label": None}


def _local_sha() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=_REPO_ROOT,
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


async def _latest_remote() -> tuple[str, str, str] | None:
    """Returns (sha, html_url, label) for the newest release, or main's HEAD if no release exists."""
    headers = {"Accept": "application/vnd.github+json"}
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=headers) as client:
        try:
            r = await client.get(f"https://api.github.com/repos/{REPO}/releases/latest")
            if r.status_code == 200:
                rel = r.json()
                tag = rel.get("tag_name")
                cr = await client.get(f"https://api.github.com/repos/{REPO}/commits/{tag}")
                if cr.status_code == 200:
                    return cr.json()["sha"], rel.get("html_url"), tag

            cr = await client.get(f"https://api.github.com/repos/{REPO}/commits/main")
            if cr.status_code == 200:
                data = cr.json()
                sha = data["sha"]
                return sha, data.get("html_url"), sha[:7]
        except Exception:
            return None
    return None


async def _check_once() -> None:
    local = _local_sha()
    if not local:
        return
    remote = await _latest_remote()
    if not remote:
        return
    sha, url, label = remote
    _state.update({
        "checked_at": time.time(),
        "update_available": sha != local,
        "sha": sha,
        "url": url,
        "label": label,
    })


class UpdateChecker:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if not self._task:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self) -> None:
        while True:
            try:
                await _check_once()
            except Exception:
                pass
            await asyncio.sleep(_INTERVAL)


checker = UpdateChecker()


def get_state() -> dict:
    return dict(_state)
