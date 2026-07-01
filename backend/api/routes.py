"""REST + SSE routes."""
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

from .. import db, secrets, integrations, backup, update_check
from ..auth import generate_token, hash_password, verify_password
from ..models import (
    BackupExportIn,
    BackupImportIn,
    BoardUpdate,
    ChangePasswordIn,
    DataSourceIn,
    DataSourceUpdate,
    LoginIn,
    PingTargetIn,
    PingTargetUpdate,
    SettingsPatch,
    StackIn,
    StackUpdate,
    UserIn,
    UserUpdate,
    WidgetIn,
    WidgetUpdate,
)
from ..poller import poller, sse_stream  # noqa: F401 (poller used for force_poll)

router = APIRouter(prefix="/api")


# ── auth dependency ───────────────────────────────────────────────────────────

def current_user(tb_session: str = Cookie(default=None)) -> dict:
    if not tb_session:
        raise HTTPException(401, "not authenticated")
    user = db.get_user_by_session(tb_session)
    if not user:
        raise HTTPException(401, "invalid or expired session")
    return user


# ── auth endpoints (public) ───────────────────────────────────────────────────

@router.post("/auth/login")
def login(body: LoginIn, response: Response):
    pw_hash = db.get_user_password_hash_by_username(body.username)
    if not pw_hash or not verify_password(body.password, pw_hash):
        raise HTTPException(401, "invalid username or password")
    user = db.get_user_by_username(body.username)
    token = generate_token()
    db.create_session(user["id"], token)
    response.set_cookie("tb_session", token, httponly=True, samesite="lax", max_age=30 * 86400)
    return user


@router.post("/auth/logout", status_code=204)
def logout(response: Response, tb_session: str = Cookie(default=None)):
    if tb_session:
        db.delete_session(tb_session)
    response.delete_cookie("tb_session")


@router.get("/settings")  # public — display + login pages need it
def get_settings():
    from ..demo import DEMO_MODE
    settings = db.get_all_settings()
    # demo_mode is never persisted — inject it live, or strip it if env var is off
    if DEMO_MODE:
        settings["demo_mode"] = "true"
    else:
        settings.pop("demo_mode", None)
    return settings

@router.patch("/settings")
def patch_settings(body: SettingsPatch, user: dict = Depends(current_user)):
    db.set_settings({k: str(v) for k, v in body.model_dump(exclude_none=True).items()})
    settings = db.get_all_settings()
    poller._publish({"type": "settings_update", "data": settings})
    return settings


@router.get("/update-check")  # public — display + login pages need it, same as /settings
def get_update_check():
    return update_check.get_state()


@router.get("/auth/me")
def me(user: dict = Depends(current_user)):
    return user


@router.post("/auth/change-password")
def change_password(body: ChangePasswordIn, user: dict = Depends(current_user)):
    pw_hash = db.get_user_password_hash(user["id"])
    if not pw_hash or not verify_password(body.current_password, pw_hash):
        raise HTTPException(400, "current password is incorrect")
    if len(body.new_password) < 8:
        raise HTTPException(400, "new password must be at least 8 characters")
    db.update_user(user["id"], {"password_hash": hash_password(body.new_password)})
    return db.get_user(user["id"])


# ── user management ───────────────────────────────────────────────────────────

@router.get("/users")
def get_users(user: dict = Depends(current_user)):
    return db.list_users()


@router.post("/users", status_code=201)
def post_user(body: UserIn, user: dict = Depends(current_user)):
    if db.get_user_by_username(body.username):
        raise HTTPException(409, "username already taken")
    return db.create_user(body.username, hash_password(body.password))


@router.put("/users/{user_id}")
def put_user(user_id: int, body: UserUpdate, user: dict = Depends(current_user)):
    data = {}
    if body.username is not None:
        existing = db.get_user_by_username(body.username)
        if existing and existing["id"] != user_id:
            raise HTTPException(409, "username already taken")
        data["username"] = body.username
    if body.password is not None:
        if len(body.password) < 8:
            raise HTTPException(400, "password must be at least 8 characters")
        data["password_hash"] = hash_password(body.password)
    updated = db.update_user(user_id, data)
    if not updated:
        raise HTTPException(404, "user not found")
    return updated


@router.delete("/users/{user_id}", status_code=204)
def del_user(user_id: int, user: dict = Depends(current_user)):
    if user_id == user["id"]:
        raise HTTPException(400, "cannot delete your own account")
    if not db.delete_user(user_id):
        raise HTTPException(404, "user not found")


# ── widgets ───────────────────────────────────────────────────────────────────

@router.get("/widgets")
def get_widgets(user: dict = Depends(current_user)):
    return db.list_widgets()


@router.post("/widgets", status_code=201)
def post_widget(body: WidgetIn, user: dict = Depends(current_user)):
    return db.create_widget(body.model_dump())


@router.get("/widgets/{widget_id}/data")
def widget_data(widget_id: int):
    # Public — used by the display page without login
    if not db.get_widget(widget_id):
        raise HTTPException(404, "widget not found")
    envelope = poller.cache.get(widget_id)
    return envelope or {"widget_id": widget_id, "data": None, "ts": None}


@router.get("/widgets/{widget_id}")
def get_one_widget(widget_id: int, user: dict = Depends(current_user)):
    w = db.get_widget(widget_id)
    if not w:
        raise HTTPException(404, "widget not found")
    return w


@router.put("/widgets/{widget_id}")
def put_widget(widget_id: int, body: WidgetUpdate, user: dict = Depends(current_user)):
    w = db.update_widget(widget_id, body.model_dump(exclude_unset=True))
    if not w:
        raise HTTPException(404, "widget not found")
    poller._publish({"type": "widget_update", "widget_id": widget_id})
    return w


@router.delete("/widgets/{widget_id}", status_code=204)
def remove_widget(widget_id: int, user: dict = Depends(current_user)):
    if not db.delete_widget(widget_id):
        raise HTTPException(404, "widget not found")


# ── stacks ────────────────────────────────────────────────────────────────────

@router.get("/stacks")
def get_stacks(user: dict = Depends(current_user)):
    return db.list_stacks()


@router.post("/stacks", status_code=201)
def post_stack(body: StackIn, user: dict = Depends(current_user)):
    return db.create_stack(body.model_dump())


@router.put("/stacks/{stack_id}")
def put_stack(stack_id: int, body: StackUpdate, user: dict = Depends(current_user)):
    s = db.update_stack(stack_id, body.model_dump(exclude_unset=True))
    if not s:
        raise HTTPException(404, "stack not found")
    return s


@router.delete("/stacks/{stack_id}", status_code=204)
def remove_stack(stack_id: int, user: dict = Depends(current_user)):
    if not db.delete_stack(stack_id):
        raise HTTPException(404, "stack not found")


# ── board ─────────────────────────────────────────────────────────────────────

@router.get("/board")
def get_board():
    # Public — used by the display page
    return db.get_board()


@router.put("/board")
def put_board(body: BoardUpdate, user: dict = Depends(current_user)):
    payload = body.model_dump(exclude_unset=True)
    if "layout" in payload and payload["layout"] is not None:
        payload["layout"] = [n if isinstance(n, dict) else n.model_dump() for n in payload["layout"]]
    return db.update_board(payload)


@router.get("/board/full")
def get_board_full():
    # Public — used by the display page
    return {
        "board": db.get_board(),
        "stacks": db.list_stacks(),
        "widgets": db.list_widgets(),
    }


# ── data sources ──────────────────────────────────────────────────────────────

@router.get("/datasources")
def get_data_sources(user: dict = Depends(current_user)):
    return db.list_data_sources()


@router.post("/datasources", status_code=201)
def post_data_source(body: DataSourceIn, user: dict = Depends(current_user)):
    blob = secrets.encrypt(body.credentials) if body.credentials else None
    return db.create_data_source(body.model_dump(), blob)


@router.patch("/datasources/{ds_id}")
def patch_data_source(ds_id: int, body: DataSourceUpdate, user: dict = Depends(current_user)):
    data = body.model_dump(exclude_none=True)
    creds = data.pop("credentials", None)
    blob = secrets.encrypt(creds) if creds else None
    updated = db.update_data_source(ds_id, data, blob)
    if not updated:
        raise HTTPException(404, "data source not found")
    if blob:  # credentials changed — re-poll affected widgets immediately
        poller.force_poll_datasource(ds_id)
    return updated


@router.delete("/datasources/{ds_id}", status_code=204)
def remove_data_source(ds_id: int, user: dict = Depends(current_user)):
    if not db.delete_data_source(ds_id):
        raise HTTPException(404, "data source not found")


@router.get("/datasources/{ds_id}/credentials")
def get_data_source_credentials(ds_id: int, user: dict = Depends(current_user)):
    ds = db.get_data_source(ds_id, with_secret=True)
    if not ds:
        raise HTTPException(404, "data source not found")
    creds = secrets.decrypt(ds.get("secret")) or {}
    # Migrate legacy single ical_url → ical_urls so the list field pre-populates
    if "ical_url" in creds and "ical_urls" not in creds:
        creds["ical_urls"] = creds["ical_url"]
    return creds


# ── backup / restore ──────────────────────────────────────────────────────────

@router.post("/backup/export")
def backup_export(body: BackupExportIn, user: dict = Depends(current_user)):
    try:
        return backup.export_backup(body.passphrase)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post("/backup/import")
def backup_import(body: BackupImportIn, user: dict = Depends(current_user)):
    try:
        backup.restore_backup(body.backup, body.passphrase)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    poller.reset()
    poller._publish({"type": "config_restored"})
    return {"ok": True}


# ── ping targets ──────────────────────────────────────────────────────────────

@router.get("/ping-targets")
def get_ping_targets(user: dict = Depends(current_user)):
    return db.list_ping_targets()


@router.post("/ping-targets", status_code=201)
def post_ping_target(body: PingTargetIn, user: dict = Depends(current_user)):
    return db.create_ping_target(body.model_dump())


@router.put("/ping-targets/{pt_id}")
def put_ping_target(pt_id: int, body: PingTargetUpdate, user: dict = Depends(current_user)):
    r = db.update_ping_target(pt_id, body.model_dump(exclude_none=True))
    if not r:
        raise HTTPException(404)
    return r


@router.delete("/ping-targets/{pt_id}", status_code=204)
def del_ping_target(pt_id: int, user: dict = Depends(current_user)):
    if not db.delete_ping_target(pt_id):
        raise HTTPException(404)


# ── debug ─────────────────────────────────────────────────────────────────────

@router.get("/debug/widget/{widget_id}")
async def debug_widget(widget_id: int, user: dict = Depends(current_user)):
    w = db.get_widget(widget_id)
    if not w:
        raise HTTPException(404, "widget not found")
    data_source = None
    if w.get("data_source_id"):
        ds = db.get_data_source(w["data_source_id"], with_secret=True)
        if ds:
            ds["credentials"] = secrets.decrypt(ds.get("secret"))
            data_source = ds
    data = await integrations.fetch(w, data_source)
    return {"widget": w, "data_source_id": w.get("data_source_id"), "result": data}


# ── live stream ───────────────────────────────────────────────────────────────

@router.get("/stream")
async def stream(request: Request):
    # Public — used by the display page
    return StreamingResponse(
        sse_stream(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

