"""Encrypted, portable config backup for migrating a TouchBoard install.

The export bundles all board / widget / stack / integration / ping / setting
data into a single JSON file encrypted with a passphrase the user chooses
(PBKDF2-HMAC-SHA256 → Fernet). Data-source API keys are decrypted from this
server's key and re-encrypted under the passphrase, so:

  * the file never contains plaintext credentials, and
  * it restores onto a new server even though that server has a different
    TOUCHBOARD_SECRET_KEY (creds are re-encrypted under the new key on import).
"""
import base64
import json
import os
from datetime import datetime, timezone

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from . import db, secrets

FORMAT = "touchboard-backup"
VERSION = 1
_ITERATIONS = 200_000


def _derive_key(passphrase: str, salt: bytes, iterations: int = _ITERATIONS) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return base64.urlsafe_b64encode(kdf.derive(passphrase.encode()))


def export_backup(passphrase: str) -> dict:
    """Build an encrypted backup envelope from the current config."""
    if not passphrase:
        raise ValueError("passphrase required")

    snap = db.dump_config()
    # Swap each encrypted secret blob for its plaintext credentials dict so the
    # bundle is portable; the whole bundle is then re-encrypted under the passphrase.
    portable = []
    for ds in snap["data_sources"]:
        creds = secrets.decrypt(ds.get("secret")) if ds.get("secret") else {}
        portable.append({k: v for k, v in ds.items() if k != "secret"} | {"credentials": creds})
    snap["data_sources"] = portable

    salt = os.urandom(16)
    token = Fernet(_derive_key(passphrase, salt)).encrypt(json.dumps(snap).encode())
    return {
        "format": FORMAT,
        "version": VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "kdf": "pbkdf2-sha256",
        "iterations": _ITERATIONS,
        "salt": base64.b64encode(salt).decode(),
        "data": token.decode(),
    }


def restore_backup(envelope: dict, passphrase: str) -> None:
    """Decrypt a backup envelope and replace the current config with it."""
    if not isinstance(envelope, dict) or envelope.get("format") != FORMAT:
        raise ValueError("not a TouchBoard backup file")
    if not passphrase:
        raise ValueError("passphrase required")

    try:
        salt = base64.b64decode(envelope["salt"])
        iterations = int(envelope.get("iterations", _ITERATIONS))
        key = _derive_key(passphrase, salt, iterations)
        plaintext = Fernet(key).decrypt(envelope["data"].encode())
    except (InvalidToken, KeyError, ValueError, TypeError):
        raise ValueError("incorrect passphrase or corrupt backup file")

    snap = json.loads(plaintext)
    # Re-encrypt each data source's credentials under THIS server's key.
    for ds in snap.get("data_sources", []):
        creds = ds.pop("credentials", {}) or {}
        ds["secret"] = secrets.encrypt(creds) if creds else None
    db.restore_config(snap)
