"""Pydantic request/response schemas."""
from typing import Any, Literal, Optional
from pydantic import BaseModel, Field

WidgetType = Literal["ping", "weather", "clock", "proxmox", "truenas", "netbox", "adguard", "opnsense", "stream", "calendar"]
SourceType = Literal["proxmox", "truenas", "netbox", "adguard", "opnsense", "google_calendar"]


class WidgetIn(BaseModel):
    type: WidgetType
    title: str
    config: dict[str, Any] = Field(default_factory=dict)
    data_source_id: Optional[int] = None
    refresh_interval_sec: int = 30


class WidgetUpdate(BaseModel):
    type: Optional[WidgetType] = None
    title: Optional[str] = None
    config: Optional[dict[str, Any]] = None
    data_source_id: Optional[int] = None
    refresh_interval_sec: Optional[int] = None


class StackIn(BaseModel):
    name: str
    widget_ids: list[int] = Field(default_factory=list)
    cycle_mode: Literal["tap", "auto"] = "tap"


class StackUpdate(BaseModel):
    name: Optional[str] = None
    widget_ids: Optional[list[int]] = None
    cycle_mode: Optional[Literal["tap", "auto"]] = None


class LayoutNode(BaseModel):
    stack_id: int
    x: int = 0
    y: int = 0
    w: int = 2
    h: int = 2


class BoardUpdate(BaseModel):
    columns: Optional[int] = None
    layout: Optional[list[LayoutNode]] = None  # legacy, ignored if pages provided
    pages: Optional[list[dict]] = None


class DataSourceIn(BaseModel):
    type: SourceType
    name: str
    base_url: str
    # free-form credentials (token, api_key, user/pass) — encrypted at rest
    credentials: dict[str, Any] = Field(default_factory=dict)


class DataSourceUpdate(BaseModel):
    name: Optional[str] = None
    base_url: Optional[str] = None
    # Empty dict means "keep existing credentials"; non-empty re-encrypts
    credentials: Optional[dict[str, Any]] = None


class PingTargetIn(BaseModel):
    label: str
    address: str
    group: str = ""


class PingTargetUpdate(BaseModel):
    label: str | None = None
    address: str | None = None
    group: str | None = None


class LoginIn(BaseModel):
    username: str
    password: str


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str


class UserIn(BaseModel):
    username: str
    password: str


class UserUpdate(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None


class SettingsPatch(BaseModel):
    theme_style:         Optional[str] = None
    theme_font:          Optional[str] = None
    disp_w:              Optional[str] = None
    disp_h:              Optional[str] = None
    card_bg_color:       Optional[str] = None
    card_bg_opacity:     Optional[str] = None
    card_gradient:       Optional[str] = None
    card_bg2_color:      Optional[str] = None
    card_bg2_opacity:    Optional[str] = None
    card_gradient_dir:   Optional[str] = None
    card_stroke_color:   Optional[str] = None
    card_stroke_opacity: Optional[str] = None
    card_stroke_width:   Optional[str] = None
    card_accent_color:   Optional[str] = None
    card_accent_opacity: Optional[str] = None
    card_accent_width:   Optional[str] = None
    card_glow:           Optional[str] = None
    card_glow_color:     Optional[str] = None
    card_glow_opacity:   Optional[str] = None
    card_glow_size:      Optional[str] = None
    card_presets:        Optional[str] = None
    board_bg_color:      Optional[str] = None
    onboarding_done:     Optional[str] = None
    tips_enabled:        Optional[str] = None
    widget_font_scale:   Optional[str] = None


class BackupExportIn(BaseModel):
    passphrase: str


class BackupImportIn(BaseModel):
    passphrase: str
    backup: dict[str, Any]
