"""Password hashing and session token utilities. No third-party deps."""
import base64
import hashlib
import secrets

DEFAULT_PASSWORD = "admin@touchboard"


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 260_000)
    return base64.b64encode(salt + dk).decode()


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        data = base64.b64decode(stored_hash.encode())
        salt, dk = data[:16], data[16:]
        new_dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 260_000)
        return secrets.compare_digest(dk, new_dk)
    except Exception:
        return False


def generate_token() -> str:
    return secrets.token_urlsafe(32)
