"""SQLite persistence layer. Single file DB, stdlib sqlite3 — no ORM needed."""
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("TOUCHBOARD_DB", Path(__file__).parent.parent / "data" / "touchboard.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS user (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT    NOT NULL UNIQUE,
  password_hash       TEXT    NOT NULL,
  is_default_password INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS data_source (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  secret     BLOB,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  columns    INTEGER NOT NULL DEFAULT 6,
  layout     TEXT NOT NULL DEFAULT '[]',
  disp_w     INTEGER NOT NULL DEFAULT 1920,
  disp_h     INTEGER NOT NULL DEFAULT 720,
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS widget (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  type                 TEXT NOT NULL,
  title                TEXT NOT NULL,
  config               TEXT NOT NULL DEFAULT '{}',
  data_source_id       INTEGER REFERENCES data_source(id) ON DELETE SET NULL,
  refresh_interval_sec INTEGER NOT NULL DEFAULT 30,
  profile_id           INTEGER REFERENCES profile(id) ON DELETE CASCADE,
  created_at           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stack (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  widget_ids TEXT NOT NULL DEFAULT '[]',
  cycle_mode TEXT NOT NULL DEFAULT 'tap',
  profile_id INTEGER REFERENCES profile(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ping_target (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  address    TEXT NOT NULL,
  grp        TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _ensure_profile_columns(conn: sqlite3.Connection) -> None:
    """Add profile_id to widget/stack if migrating from a pre-profiles DB
    (fresh installs already get it from SCHEMA's CREATE TABLE)."""
    for table in ("widget", "stack"):
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if "profile_id" not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN profile_id INTEGER REFERENCES profile(id) ON DELETE CASCADE")


def _migrate_board_to_profile(conn: sqlite3.Connection) -> None:
    """One-time migration: fold the old singleton `board` row (plus disp_w/disp_h
    settings) into a single "Default" profile, and claim all existing widgets/
    stacks into it. Runs at most once — subsequent calls find no `board` table
    and skip immediately."""
    if not _table_exists(conn, "board"):
        return
    try:
        board_row = conn.execute("SELECT columns, layout FROM board WHERE id = 1").fetchone()
        settings = dict(conn.execute(
            "SELECT key, value FROM setting WHERE key IN ('disp_w', 'disp_h')"
        ).fetchall())
        disp_w = int(settings.get("disp_w", 1920))
        disp_h = int(settings.get("disp_h", 720))
        columns = board_row["columns"] if board_row else 6
        layout = board_row["layout"] if board_row else "[]"

        cur = conn.execute(
            "INSERT INTO profile (name, columns, layout, disp_w, disp_h, is_active, created_at)"
            " VALUES ('Default', ?, ?, ?, ?, 1, ?)",
            (columns, layout, disp_w, disp_h, _now()),
        )
        default_id = cur.lastrowid
        conn.execute("UPDATE widget SET profile_id = ? WHERE profile_id IS NULL", (default_id,))
        conn.execute("UPDATE stack SET profile_id = ? WHERE profile_id IS NULL", (default_id,))
        conn.execute("DROP TABLE board")
        conn.execute("DELETE FROM setting WHERE key IN ('disp_w', 'disp_h')")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def init_db() -> None:
    from .auth import hash_password, DEFAULT_PASSWORD

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        _ensure_profile_columns(conn)
        _migrate_board_to_profile(conn)
        # Fresh install (no legacy board, no profile yet) — seed one empty profile
        if conn.execute("SELECT 1 FROM profile LIMIT 1").fetchone() is None:
            conn.execute(
                "INSERT INTO profile (name, columns, layout, disp_w, disp_h, is_active, created_at)"
                " VALUES ('Default', 6, '[]', 1920, 720, 1, ?)",
                (_now(),),
            )
        # Seed default admin account
        conn.execute(
            "INSERT OR IGNORE INTO user (username, password_hash, is_default_password, created_at)"
            " VALUES ('admin', ?, 1, ?)",
            (hash_password(DEFAULT_PASSWORD), _now()),
        )
        defaults = [
            ("theme_style",          "classic"),
            ("theme_font",           "inter"),
            ("card_bg_color",        "#171c24"),
            ("card_bg_opacity",      "1"),
            ("card_gradient",        "false"),
            ("card_bg2_color",       "#0e1116"),
            ("card_bg2_opacity",     "0"),
            ("card_gradient_dir",    "180"),
            ("card_stroke_color",    "#2b3a50"),
            ("card_stroke_opacity",  "1"),
            ("card_stroke_width",    "1"),
            ("card_accent_color",    "#3b82f6"),
            ("card_accent_opacity",  "1"),
            ("card_accent_width",    "3"),
            ("card_glow",            "false"),
            ("card_glow_color",      "#3b82f6"),
            ("card_glow_opacity",    "0.3"),
            ("card_glow_size",       "12"),
            ("card_presets",         "[]"),
            ("board_bg_color",       "#060912"),
            ("onboarding_done",      "false"),
            ("tips_enabled",         "true"),
        ]
        for key, value in defaults:
            conn.execute("INSERT OR IGNORE INTO setting (key, value) VALUES (?, ?)", (key, value))
        conn.commit()
    finally:
        conn.close()


# ── row → dict helpers ────────────────────────────────────────────────────────

def _widget_to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "type": r["type"],
        "title": r["title"],
        "config": json.loads(r["config"]),
        "data_source_id": r["data_source_id"],
        "refresh_interval_sec": r["refresh_interval_sec"],
        "created_at": r["created_at"],
    }


def _stack_to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "widget_ids": json.loads(r["widget_ids"]),
        "cycle_mode": r["cycle_mode"],
        "created_at": r["created_at"],
    }


def _datasource_to_dict(r: sqlite3.Row, include_secret: bool = False) -> dict:
    d = {
        "id": r["id"],
        "type": r["type"],
        "name": r["name"],
        "base_url": r["base_url"],
        "has_secret": r["secret"] is not None,
        "created_at": r["created_at"],
    }
    return d


# ── widgets ───────────────────────────────────────────────────────────────────

def list_widgets(profile_id: int | None = None) -> list[dict]:
    conn = connect()
    try:
        if profile_id is None:
            rows = conn.execute("SELECT * FROM widget ORDER BY id").fetchall()
        else:
            rows = conn.execute("SELECT * FROM widget WHERE profile_id = ? ORDER BY id", (profile_id,)).fetchall()
        return [_widget_to_dict(r) for r in rows]
    finally:
        conn.close()


def get_widget(widget_id: int) -> dict | None:
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM widget WHERE id = ?", (widget_id,)).fetchone()
        return _widget_to_dict(r) if r else None
    finally:
        conn.close()


def create_widget(data: dict, profile_id: int) -> dict:
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO widget (type, title, config, data_source_id, refresh_interval_sec, profile_id, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                data["type"],
                data["title"],
                json.dumps(data.get("config", {})),
                data.get("data_source_id"),
                data.get("refresh_interval_sec", 30),
                profile_id,
                _now(),
            ),
        )
        conn.commit()
        return get_widget(cur.lastrowid)
    finally:
        conn.close()


def update_widget(widget_id: int, data: dict) -> dict | None:
    existing = get_widget(widget_id)
    if not existing:
        return None
    merged = {**existing, **{k: v for k, v in data.items() if v is not None}}
    conn = connect()
    try:
        conn.execute(
            "UPDATE widget SET type=?, title=?, config=?, data_source_id=?, refresh_interval_sec=? WHERE id=?",
            (
                merged["type"],
                merged["title"],
                json.dumps(merged["config"]),
                merged["data_source_id"],
                merged["refresh_interval_sec"],
                widget_id,
            ),
        )
        conn.commit()
        return get_widget(widget_id)
    finally:
        conn.close()


def delete_widget(widget_id: int) -> bool:
    conn = connect()
    try:
        w = conn.execute("SELECT profile_id FROM widget WHERE id = ?", (widget_id,)).fetchone()
        cur = conn.execute("DELETE FROM widget WHERE id = ?", (widget_id,))
        # scrub from any stacks in the same profile
        if w:
            for r in conn.execute(
                "SELECT id, widget_ids FROM stack WHERE profile_id = ?", (w["profile_id"],)
            ).fetchall():
                ids = json.loads(r["widget_ids"])
                if widget_id in ids:
                    ids = [i for i in ids if i != widget_id]
                    conn.execute("UPDATE stack SET widget_ids=? WHERE id=?", (json.dumps(ids), r["id"]))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ── stacks ────────────────────────────────────────────────────────────────────

def list_stacks(profile_id: int | None = None) -> list[dict]:
    conn = connect()
    try:
        if profile_id is None:
            rows = conn.execute("SELECT * FROM stack ORDER BY id").fetchall()
        else:
            rows = conn.execute("SELECT * FROM stack WHERE profile_id = ? ORDER BY id", (profile_id,)).fetchall()
        return [_stack_to_dict(r) for r in rows]
    finally:
        conn.close()


def get_stack(stack_id: int) -> dict | None:
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM stack WHERE id = ?", (stack_id,)).fetchone()
        return _stack_to_dict(r) if r else None
    finally:
        conn.close()


def create_stack(data: dict, profile_id: int) -> dict:
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO stack (name, widget_ids, cycle_mode, profile_id, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                data["name"],
                json.dumps(data.get("widget_ids", [])),
                data.get("cycle_mode", "tap"),
                profile_id,
                _now(),
            ),
        )
        conn.commit()
        return get_stack(cur.lastrowid)
    finally:
        conn.close()


def update_stack(stack_id: int, data: dict) -> dict | None:
    existing = get_stack(stack_id)
    if not existing:
        return None
    merged = {**existing, **{k: v for k, v in data.items() if v is not None}}
    conn = connect()
    try:
        conn.execute(
            "UPDATE stack SET name=?, widget_ids=?, cycle_mode=? WHERE id=?",
            (merged["name"], json.dumps(merged["widget_ids"]), merged["cycle_mode"], stack_id),
        )
        conn.commit()
        return get_stack(stack_id)
    finally:
        conn.close()


def delete_stack(stack_id: int) -> bool:
    conn = connect()
    try:
        s = conn.execute("SELECT profile_id FROM stack WHERE id = ?", (stack_id,)).fetchone()
        cur = conn.execute("DELETE FROM stack WHERE id = ?", (stack_id,))
        # scrub from that stack's own profile's pages
        if s and s["profile_id"] is not None:
            prof = conn.execute("SELECT layout FROM profile WHERE id = ?", (s["profile_id"],)).fetchone()
            if prof:
                pages = _parse_pages(prof["layout"])
                for page in pages:
                    page["layout"] = [n for n in page["layout"] if n.get("stack_id") != stack_id]
                conn.execute("UPDATE profile SET layout=? WHERE id=?", (json.dumps(pages), s["profile_id"]))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ── profiles (boards) ──────────────────────────────────────────────────────────

def _parse_pages(raw: str) -> list[dict]:
    """Parse layout JSON, migrating old flat-array format to pages format."""
    data = json.loads(raw)
    if not data:
        return [{"id": 1, "name": "Page 1", "layout": []}]
    # Old format: flat list of layout nodes (have stack_id key, no 'name')
    if isinstance(data[0], dict) and "stack_id" in data[0] and "name" not in data[0]:
        return [{"id": 1, "name": "Page 1", "layout": data}]
    return data


def _profile_to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "columns": r["columns"],
        "disp_w": r["disp_w"],
        "disp_h": r["disp_h"],
        "is_active": bool(r["is_active"]),
        "created_at": r["created_at"],
    }


def list_profiles() -> list[dict]:
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM profile ORDER BY id").fetchall()
        return [_profile_to_dict(r) for r in rows]
    finally:
        conn.close()


def get_profile(profile_id: int) -> dict | None:
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM profile WHERE id = ?", (profile_id,)).fetchone()
        if not r:
            return None
        d = _profile_to_dict(r)
        d["pages"] = _parse_pages(r["layout"])
        return d
    finally:
        conn.close()


def get_active_profile_id() -> int:
    conn = connect()
    try:
        r = conn.execute("SELECT id FROM profile WHERE is_active = 1").fetchone()
        if r:
            return r["id"]
        # defensive self-heal: shouldn't happen, but never leave the app with no active profile
        r = conn.execute("SELECT id FROM profile ORDER BY id LIMIT 1").fetchone()
        if not r:
            raise RuntimeError("no profiles exist")
        conn.execute("UPDATE profile SET is_active = 1 WHERE id = ?", (r["id"],))
        conn.commit()
        return r["id"]
    finally:
        conn.close()


def create_profile(name: str, clone_from: int | None = None) -> dict:
    conn = connect()
    try:
        now = _now()
        if clone_from is not None:
            src = conn.execute("SELECT * FROM profile WHERE id = ?", (clone_from,)).fetchone()
            if not src:
                raise ValueError("source profile not found")
            cur = conn.execute(
                "INSERT INTO profile (name, columns, layout, disp_w, disp_h, is_active, created_at)"
                " VALUES (?, ?, '[]', ?, ?, 0, ?)",
                (name, src["columns"], src["disp_w"], src["disp_h"], now),
            )
            new_id = cur.lastrowid

            widget_id_map: dict[int, int] = {}
            for w in conn.execute("SELECT * FROM widget WHERE profile_id = ? ORDER BY id", (clone_from,)).fetchall():
                wc = conn.execute(
                    "INSERT INTO widget (type, title, config, data_source_id, refresh_interval_sec, profile_id, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (w["type"], w["title"], w["config"], w["data_source_id"], w["refresh_interval_sec"], new_id, now),
                )
                widget_id_map[w["id"]] = wc.lastrowid

            stack_id_map: dict[int, int] = {}
            for s in conn.execute("SELECT * FROM stack WHERE profile_id = ? ORDER BY id", (clone_from,)).fetchall():
                remapped_widget_ids = [widget_id_map[i] for i in json.loads(s["widget_ids"]) if i in widget_id_map]
                sc = conn.execute(
                    "INSERT INTO stack (name, widget_ids, cycle_mode, profile_id, created_at) VALUES (?, ?, ?, ?, ?)",
                    (s["name"], json.dumps(remapped_widget_ids), s["cycle_mode"], new_id, now),
                )
                stack_id_map[s["id"]] = sc.lastrowid

            pages = _parse_pages(src["layout"])
            for page in pages:
                for node in page.get("layout", []):
                    if node.get("stack_id") in stack_id_map:
                        node["stack_id"] = stack_id_map[node["stack_id"]]
            conn.execute("UPDATE profile SET layout = ? WHERE id = ?", (json.dumps(pages), new_id))
        else:
            cur = conn.execute(
                "INSERT INTO profile (name, columns, layout, disp_w, disp_h, is_active, created_at)"
                " VALUES (?, 6, '[]', 1920, 720, 0, ?)",
                (name, now),
            )
            new_id = cur.lastrowid
        conn.commit()
        return get_profile(new_id)
    finally:
        conn.close()


def rename_profile(profile_id: int, name: str) -> dict | None:
    conn = connect()
    try:
        cur = conn.execute("UPDATE profile SET name = ? WHERE id = ?", (name, profile_id))
        conn.commit()
        return get_profile(profile_id) if cur.rowcount else None
    finally:
        conn.close()


def update_profile_board(profile_id: int, data: dict) -> dict | None:
    current = get_profile(profile_id)
    if not current:
        return None
    columns = data.get("columns", current["columns"])
    pages   = data.get("pages",   current["pages"])
    disp_w  = data.get("disp_w",  current["disp_w"])
    disp_h  = data.get("disp_h",  current["disp_h"])
    conn = connect()
    try:
        conn.execute(
            "UPDATE profile SET columns=?, layout=?, disp_w=?, disp_h=? WHERE id=?",
            (columns, json.dumps(pages), disp_w, disp_h, profile_id),
        )
        conn.commit()
        return get_profile(profile_id)
    finally:
        conn.close()


def set_active_profile(profile_id: int) -> dict | None:
    conn = connect()
    try:
        if not conn.execute("SELECT 1 FROM profile WHERE id = ?", (profile_id,)).fetchone():
            return None
        conn.execute("UPDATE profile SET is_active = 0")
        conn.execute("UPDATE profile SET is_active = 1 WHERE id = ?", (profile_id,))
        conn.commit()
        return get_profile(profile_id)
    finally:
        conn.close()


def delete_profile(profile_id: int) -> str | None:
    """Returns None on success, or an error string if the delete was refused."""
    conn = connect()
    try:
        count = conn.execute("SELECT COUNT(*) c FROM profile").fetchone()["c"]
        if count <= 1:
            return "cannot delete the last remaining profile"
        row = conn.execute("SELECT is_active FROM profile WHERE id = ?", (profile_id,)).fetchone()
        if not row:
            return "not_found"
        if row["is_active"]:
            return "cannot delete the active profile — switch to another profile first"
        conn.execute("DELETE FROM profile WHERE id = ?", (profile_id,))
        conn.commit()
        return None
    finally:
        conn.close()


# ── data sources ──────────────────────────────────────────────────────────────

def list_data_sources() -> list[dict]:
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM data_source ORDER BY id").fetchall()
        return [_datasource_to_dict(r) for r in rows]
    finally:
        conn.close()


def get_data_source(ds_id: int, with_secret: bool = False):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM data_source WHERE id = ?", (ds_id,)).fetchone()
        if not r:
            return None
        d = _datasource_to_dict(r)
        if with_secret:
            d["secret"] = r["secret"]
        return d
    finally:
        conn.close()


def create_data_source(data: dict, secret_blob: bytes | None) -> dict:
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO data_source (type, name, base_url, secret, created_at) VALUES (?, ?, ?, ?, ?)",
            (data["type"], data["name"], data["base_url"], secret_blob, _now()),
        )
        conn.commit()
        return get_data_source(cur.lastrowid)
    finally:
        conn.close()


def update_data_source(ds_id: int, data: dict, secret_blob: bytes | None) -> dict | None:
    conn = connect()
    try:
        parts, vals = [], []
        if "name" in data:
            parts.append("name=?"); vals.append(data["name"])
        if "base_url" in data:
            parts.append("base_url=?"); vals.append(data["base_url"])
        if secret_blob is not None:
            parts.append("secret=?"); vals.append(secret_blob)
        if parts:
            vals.append(ds_id)
            conn.execute(f"UPDATE data_source SET {', '.join(parts)} WHERE id=?", vals)
            conn.commit()
        return get_data_source(ds_id)
    finally:
        conn.close()


def delete_data_source(ds_id: int) -> bool:
    conn = connect()
    try:
        cur = conn.execute("DELETE FROM data_source WHERE id = ?", (ds_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ── ping targets ──────────────────────────────────────────────────────────────

def _ping_target_to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "label": r["label"],
        "address": r["address"],
        "group": r["grp"],
        "created_at": r["created_at"],
    }


def list_ping_targets() -> list[dict]:
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM ping_target ORDER BY id").fetchall()
        return [_ping_target_to_dict(r) for r in rows]
    finally:
        conn.close()


def get_ping_target(pt_id: int) -> dict | None:
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM ping_target WHERE id = ?", (pt_id,)).fetchone()
        return _ping_target_to_dict(r) if r else None
    finally:
        conn.close()


def create_ping_target(data: dict) -> dict:
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO ping_target (label, address, grp, created_at) VALUES (?, ?, ?, ?)",
            (data["label"], data["address"], data.get("group", ""), _now()),
        )
        conn.commit()
        return get_ping_target(cur.lastrowid)
    finally:
        conn.close()


def update_ping_target(pt_id: int, data: dict) -> dict | None:
    existing = get_ping_target(pt_id)
    if not existing:
        return None
    label   = data.get("label",   existing["label"])
    address = data.get("address", existing["address"])
    grp     = data.get("group",   existing["group"])
    conn = connect()
    try:
        conn.execute(
            "UPDATE ping_target SET label=?, address=?, grp=? WHERE id=?",
            (label, address, grp, pt_id),
        )
        conn.commit()
        return get_ping_target(pt_id)
    finally:
        conn.close()


def delete_ping_target(pt_id: int) -> bool:
    conn = connect()
    try:
        cur = conn.execute("DELETE FROM ping_target WHERE id = ?", (pt_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ── users ─────────────────────────────────────────────────────────────────────

def _user_to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "username": r["username"],
        "is_default_password": bool(r["is_default_password"]),
        "created_at": r["created_at"],
    }


def list_users() -> list[dict]:
    conn = connect()
    try:
        return [_user_to_dict(r) for r in conn.execute("SELECT * FROM user ORDER BY id").fetchall()]
    finally:
        conn.close()


def get_user(user_id: int) -> dict | None:
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM user WHERE id = ?", (user_id,)).fetchone()
        return _user_to_dict(r) if r else None
    finally:
        conn.close()


def get_user_by_username(username: str) -> dict | None:
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM user WHERE username = ?", (username,)).fetchone()
        return _user_to_dict(r) if r else None
    finally:
        conn.close()


def get_user_password_hash(user_id: int) -> str | None:
    conn = connect()
    try:
        r = conn.execute("SELECT password_hash FROM user WHERE id = ?", (user_id,)).fetchone()
        return r["password_hash"] if r else None
    finally:
        conn.close()


def get_user_password_hash_by_username(username: str) -> str | None:
    conn = connect()
    try:
        r = conn.execute("SELECT password_hash FROM user WHERE username = ?", (username,)).fetchone()
        return r["password_hash"] if r else None
    finally:
        conn.close()


def create_user(username: str, password_hash: str) -> dict:
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO user (username, password_hash, is_default_password, created_at) VALUES (?, ?, 0, ?)",
            (username, password_hash, _now()),
        )
        conn.commit()
        return get_user(cur.lastrowid)
    finally:
        conn.close()


def update_user(user_id: int, data: dict) -> dict | None:
    conn = connect()
    try:
        parts, vals = [], []
        if "username" in data:
            parts.append("username=?"); vals.append(data["username"])
        if "password_hash" in data:
            parts.append("password_hash=?"); vals.append(data["password_hash"])
            parts.append("is_default_password=?"); vals.append(0)
        if not parts:
            return get_user(user_id)
        vals.append(user_id)
        conn.execute(f"UPDATE user SET {', '.join(parts)} WHERE id=?", vals)
        conn.commit()
        return get_user(user_id)
    finally:
        conn.close()


def delete_user(user_id: int) -> bool:
    conn = connect()
    try:
        cur = conn.execute("DELETE FROM user WHERE id = ?", (user_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ── settings ──────────────────────────────────────────────────────────────────

def get_all_settings() -> dict:
    conn = connect()
    try:
        rows = conn.execute("SELECT key, value FROM setting").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()

def set_setting(key: str, value: str) -> None:
    conn = connect()
    try:
        conn.execute("INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)", (key, value))
        conn.commit()
    finally:
        conn.close()

def set_settings(pairs: dict) -> None:
    """Write multiple settings in a single transaction."""
    conn = connect()
    try:
        for key, value in pairs.items():
            conn.execute("INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)", (key, value))
        conn.commit()
    finally:
        conn.close()


# ── backup / restore ──────────────────────────────────────────────────────────

def dump_config(profile_id: int) -> dict:
    """Raw snapshot of one profile's board/widgets/stacks, plus the global
    data sources/ping targets/settings (shared across all profiles).

    Auth tables (user/session) are intentionally excluded — backups are for
    migrating board config, not credentials to log in.
    """
    conn = connect()
    try:
        prof = conn.execute(
            "SELECT columns, layout, disp_w, disp_h FROM profile WHERE id = ?", (profile_id,)
        ).fetchone()
        return {
            "board": dict(prof) if prof else None,
            "data_sources": [dict(r) for r in conn.execute(
                "SELECT id, type, name, base_url, secret, created_at FROM data_source ORDER BY id")],
            "widgets": [dict(r) for r in conn.execute(
                "SELECT id, type, title, config, data_source_id, refresh_interval_sec, created_at"
                " FROM widget WHERE profile_id = ? ORDER BY id", (profile_id,))],
            "stacks": [dict(r) for r in conn.execute(
                "SELECT id, name, widget_ids, cycle_mode, created_at"
                " FROM stack WHERE profile_id = ? ORDER BY id", (profile_id,))],
            "ping_targets": [dict(r) for r in conn.execute(
                "SELECT id, label, address, grp, created_at FROM ping_target ORDER BY id")],
            "settings": [dict(r) for r in conn.execute("SELECT key, value FROM setting")],
        }
    finally:
        conn.close()


def restore_config(payload: dict, profile_id: int) -> None:
    """Replace one profile's board/widgets/stacks from a snapshot, preserving
    original IDs so cross-references (widget→data_source, stack→widget_ids,
    board→stack_id) stay intact. Data sources/ping targets/settings are global
    and get replaced/upserted for the whole app, same as before profiles existed.
    data_source `secret` blobs must already be encrypted for this server.
    """
    conn = connect()
    try:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("DELETE FROM widget WHERE profile_id = ?", (profile_id,))
        conn.execute("DELETE FROM stack WHERE profile_id = ?", (profile_id,))
        for t in ("data_source", "ping_target"):
            conn.execute(f"DELETE FROM {t}")

        b = payload.get("board")
        if b:
            conn.execute(
                "UPDATE profile SET columns=?, layout=?, disp_w=?, disp_h=? WHERE id=?",
                (b["columns"], b["layout"], b.get("disp_w", 1920), b.get("disp_h", 720), profile_id),
            )

        for r in payload.get("data_sources", []):
            conn.execute(
                "INSERT INTO data_source (id, type, name, base_url, secret, created_at) VALUES (?,?,?,?,?,?)",
                (r["id"], r["type"], r["name"], r["base_url"], r.get("secret"), r["created_at"]))
        for r in payload.get("widgets", []):
            conn.execute(
                "INSERT INTO widget (id, type, title, config, data_source_id, refresh_interval_sec, profile_id, created_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (r["id"], r["type"], r["title"], r["config"], r.get("data_source_id"),
                 r["refresh_interval_sec"], profile_id, r["created_at"]))
        for r in payload.get("stacks", []):
            conn.execute(
                "INSERT INTO stack (id, name, widget_ids, cycle_mode, profile_id, created_at) VALUES (?,?,?,?,?,?)",
                (r["id"], r["name"], r["widget_ids"], r["cycle_mode"], profile_id, r["created_at"]))
        for r in payload.get("ping_targets", []):
            conn.execute(
                "INSERT INTO ping_target (id, label, address, grp, created_at) VALUES (?,?,?,?,?)",
                (r["id"], r["label"], r["address"], r["grp"], r["created_at"]))
        # Upsert settings (don't delete first, so version-specific defaults survive)
        for r in payload.get("settings", []):
            conn.execute("INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)", (r["key"], r["value"]))

        conn.commit()
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.close()


# ── sessions ──────────────────────────────────────────────────────────────────

def create_session(user_id: int, token: str) -> None:
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO session (token, user_id, created_at) VALUES (?, ?, ?)",
            (token, user_id, _now()),
        )
        conn.commit()
    finally:
        conn.close()


def get_user_by_session(token: str) -> dict | None:
    conn = connect()
    try:
        r = conn.execute(
            "SELECT u.* FROM user u JOIN session s ON s.user_id = u.id WHERE s.token = ?",
            (token,),
        ).fetchone()
        return _user_to_dict(r) if r else None
    finally:
        conn.close()


def delete_session(token: str) -> None:
    conn = connect()
    try:
        conn.execute("DELETE FROM session WHERE token = ?", (token,))
        conn.commit()
    finally:
        conn.close()
