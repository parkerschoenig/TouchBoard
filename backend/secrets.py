"""Encrypt data-source credentials at rest with Fernet.

Key comes from TOUCHBOARD_SECRET_KEY env var. If unset, a key is generated and
persisted next to the DB so restarts can still decrypt — fine for a homelab, but
set the env var explicitly for anything you care about.
"""
import json
import os
from pathlib import Path

from cryptography.fernet import Fernet

from .db import DB_PATH

_KEY_FILE = DB_PATH.parent / "secret.key"


def _load_key() -> bytes:
    env = os.environ.get("TOUCHBOARD_SECRET_KEY")
    if env:
        return env.encode()
    if _KEY_FILE.exists():
        return _KEY_FILE.read_bytes()
    _KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    _KEY_FILE.write_bytes(key)
    try:
        os.chmod(_KEY_FILE, 0o600)
    except OSError:
        pass
    return key


def encrypt(credentials: dict) -> bytes:
    return Fernet(_load_key()).encrypt(json.dumps(credentials).encode())


def decrypt(blob: bytes) -> dict:
    if not blob:
        return {}
    return json.loads(Fernet(_load_key()).decrypt(blob).decode())
