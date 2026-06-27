import os

DEMO_MODE: bool = os.environ.get("DEMO_MODE", "").strip() not in ("", "0", "false", "False")
