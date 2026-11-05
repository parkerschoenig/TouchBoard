import { api } from "./api.js";
import { renderWidget, openWidgetAppearancePopover } from "./widgets.js";
import { STYLES, FONTS, THEME_PRESETS, DISPLAY_THEMES, SHAPES, PATTERNS, OWNING_STYLES, applyTheme, applyCardStyle, loadFont } from "./theme.js";
import { getPrefs, setPref } from "./editor/app-theme.js";
import * as G from "./editor/geometry.js";
import { createHistory } from "./editor/history.js";
import { openPalette, isPaletteOpen } from "./editor/palette.js";
import { TEMPLATES, applyTemplate, miniMap } from "./editor/templates.js";
import { exportPage, importPage } from "./editor/page-io.js";
import { createInspector } from "./editor/inspector.js";
import { createTiledOverlay } from "./editor/tiled.js";

let currentTheme = { style: "classic", font: "inter", shape: "theme", pattern: "none" };
let currentCardSettings = {};
let prefs = getPrefs();

const byId = (id) => document.getElementById(id);

function _makeDraggable(element, handleEl) {
  handleEl.style.cursor = "grab";
  handleEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input, select, textarea, a, label")) return;
    const rect = element.getBoundingClientRect();
    element.style.margin = "0";
    element.style.left = rect.left + "px";
    element.style.top  = rect.top  + "px";
    element.style.transform = "none";
    const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
    handleEl.style.cursor = "grabbing";
    const move = (e) => {
      element.style.left = Math.max(0, Math.min(window.innerWidth  - element.offsetWidth,  e.clientX - ox)) + "px";
      element.style.top  = Math.max(0, Math.min(window.innerHeight - element.offsetHeight, e.clientY - oy)) + "px";
    };
    const up = () => { handleEl.style.cursor = "grab"; document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    e.preventDefault();
  });
}

// GridStack's bundled CSS only includes .gs-12 rules.
// Generate rules for every column count so any `columns` value works.
(function injectGridStackColumns(max) {
  const rules = [];
  for (let n = 1; n <= max; n++) {
    if (n === 12) continue;
    const unit = 100 / n;
    rules.push(`.gs-${n}>.grid-stack-item{width:${unit.toFixed(4)}%}`);
    for (let k = 1; k < n; k++) {
      rules.push(`.gs-${n}>.grid-stack-item[gs-x="${k}"]{left:${(k * unit).toFixed(4)}%}`);
    }
    for (let k = 2; k <= n; k++) {
      rules.push(`.gs-${n}>.grid-stack-item[gs-w="${k}"]{width:${(k * unit).toFixed(4)}%}`);
    }
  }
  const style = document.createElement("style");
  style.textContent = rules.join("\n");
  document.head.appendChild(style);
})(48);

// Grid size comes from the board (columns × rows), 24 × 16 unless changed in
// the inspector. Cards are positioned in these cells on the editor and display.
let COLS = 24;
let ROWS = 16;
const MIN_W   = 2;   // minimum card width in grid units
const MIN_H   = 2;   // minimum card height in grid units
const DEF_W   = 6;   // default drop width
const DEF_H   = 4;   // default drop height
const CARD_INSET = 5; // px on the real screen; the display uses a 10px gap and 5px padding
// Multi-page widgets cycle through several screens, so they can't be stacked.
const MULTIPAGE_TYPES = new Set(["proxmox", "truenas", "netbox", "weather"]);
// Default card size per widget type, in 24 × 16 cells (scaled to the board).
const DEFAULT_SIZE = {
  clock: [6, 4], weather: [6, 6], ping: [6, 6], stream: [8, 6], netbox: [6, 12], truenas: [6, 6],
  proxmox: [10, 10], adguard: [6, 6], opnsense: [8, 6], calendar: [8, 8], bookmarks: [6, 6],
  rest: [6, 4], nowplaying: [8, 6], notes: [6, 6], photos: [8, 8], rss: [6, 8], lights: [8, 6],
};
function defaultSize(type) {
  const [w, h] = DEFAULT_SIZE[type] || [DEF_W, DEF_H];
  return [Math.max(MIN_W, Math.round(w * COLS / 24)), Math.max(MIN_H, Math.round(h * ROWS / 16))];
}

let board          = { columns: COLS, rows: ROWS, pages: [{ id: 1, name: "Page 1", layout: [] }], options: {} };
let currentPageIdx = 0;
let stacks  = [];
let widgets = [];
let widgetsById = {};
let pingTargets = [];  // global ping target library
let pingPickerEl = null; // reference to current picker in widget modal
let dataSources = [];
let grid;
let saveTimer = null;
let dispW = 1920;
let dispH = 720;
let stageScale = 1;
let editingProfileId = null; // which profile the editor is currently working on
let editingProfileName = "";
let selectedStackId = null;
let history = null;
let inspector = null;
let tiled = null;
const cardWidgetIdx = {};   // stack id → index of the widget shown on its card

function currentPage() {
  return board.pages[currentPageIdx] ?? board.pages[0];
}

const placedIds = new Set();   // stacks placed on the CURRENT page
// All placed stacks are phantom — auto-created on drop, deleted when removed.
const phantomStackIds = new Set();
const liveData = {};

function reindex() {
  widgetsById = Object.fromEntries(widgets.map((w) => [w.id, w]));
}

// ── preview scaling ───────────────────────────────────────────────────────────
// The board is laid out at the screen's real resolution on a stage, and the
// stage is scaled down to fit. Cards, gaps and text match the display exactly.

function calcPreview() {
  const area = byId("canvas-area");
  const tabsH = byId("page-tabs-bar")?.offsetHeight || 0;
  const statusH = byId("statusbar")?.offsetHeight || 0;
  const availW = Math.max(240, (area?.clientWidth || window.innerWidth) - 48);
  const availH = Math.max(160, (area?.clientHeight || window.innerHeight) - tabsH - statusH - 64);
  const scale = Math.min(availW / dispW, availH / dispH, 1);
  return { scale, w: Math.round(dispW * scale), h: Math.round(dispH * scale) };
}

function updatePreviewSize() {
  const { scale, w, h } = calcPreview();
  stageScale = scale;
  const vp = byId("preview-viewport");
  const stage = byId("ed-stage");
  vp.style.width  = w + "px";
  vp.style.height = h + "px";
  stage.style.width  = dispW + "px";
  stage.style.height = dispH + "px";
  stage.style.transform = `scale(${scale})`;
  const gs = byId("gs-grid");
  gs.style.setProperty("--cols", COLS);
  gs.style.setProperty("--rows", ROWS);
  if (grid) grid.cellHeight(dispH / ROWS);
  updateStatus();
  requestAnimationFrame(() => { updateToolbar(); tiled?.render(); });
}

// px size of a w×h card on the real screen
function cellPx(w, h) {
  if (!w || !h) return "";
  const pw = Math.round(w * dispW / COLS - CARD_INSET * 2), ph = Math.round(h * dispH / ROWS - CARD_INSET * 2);
  return `${pw} × ${ph} px`;
}

// ── layout persistence ────────────────────────────────────────────────────────

function currentLayout() {
  if (!grid) return [];
  return grid.getGridItems().map((el) => {
    const n = el.gridstackNode;
    const node = { stack_id: Number(el.dataset.stackId), x: n.x, y: n.y, w: n.w, h: n.h, item_type: el.dataset.itemType || "stack" };
    if (n.locked || n.noMove) node.locked = true;
    return node;
  });
}

let _savePromise = Promise.resolve();
function saveLayoutSoon({ record = true, delay = 300 } = {}) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    currentPage().layout = currentLayout();
    _savePromise = api.updateBoard({ columns: COLS, rows: ROWS, pages: board.pages })
      .catch(() => toast("Couldn't save the layout. Check the connection."))
      .then(() => {
        if (record) history?.record();
        updateTabMinimaps();
        inspector?.render();
      });
  }, delay);
}
async function saveNow({ record = true } = {}) {
  clearTimeout(saveTimer);
  currentPage().layout = currentLayout();
  await api.updateBoard({ columns: COLS, rows: ROWS, pages: board.pages });
  if (record) history?.record();
  updateTabMinimaps();
}
function saveOptionsSoon() {
  clearTimeout(saveOptionsSoon._t);
  saveOptionsSoon._t = setTimeout(() => {
    api.updateProfileBoard(editingProfileId, { options: board.options || {} }).catch(() => toast("Couldn't save the display settings."));
  }, 350);
}

// ── live widget data ──────────────────────────────────────────────────────────

async function fetchLiveData() {
  const ids = Object.keys(widgetsById);
  await Promise.all(
    ids.map(async (id) => {
      try { liveData[id] = await api.widgetData(Number(id)); } catch { /* ignore */ }
    })
  );
}

// ── toast ────────────────────────────────────────────────────────────────────

function toast(msg, { action = null, ms = 4000 } = {}) {
  document.querySelector(".ed-toast")?.remove();
  const t = Object.assign(document.createElement("div"), { className: "ed-toast" });
  t.append(Object.assign(document.createElement("span"), { textContent: msg }));
  if (action) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: action.label });
    b.addEventListener("click", () => { t.remove(); action.run(); });
    t.appendChild(b);
  }
  document.body.appendChild(t);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.remove(), ms);
}

// ── helpers ───────────────────────────────────────────────────────────────────

const WIDGET_TYPES = [
  { type: "clock",      label: "Clock",           icon: "🕐" },
  { type: "weather",    label: "Weather",         icon: "⛅" },
  { type: "notes",      label: "Notes",           icon: "📝" },
  { type: "bookmarks",  label: "Bookmarks",       icon: "🔖" },
  { type: "rest",       label: "REST / JSON",     icon: "🧩" },
  { type: "ping",       label: "Ping",            icon: "📡" },
  { type: "photos",     label: "Photo frame",     icon: "🖼️" },
  { type: "rss",        label: "RSS / news",      icon: "📰" },
  { type: "stream",     label: "Camera / Stream", icon: "📹" },
  { type: "nowplaying", label: "Now playing",     icon: "🎬" },
  { type: "netbox",     label: "NetBox",          icon: "🗄️" },
  { type: "truenas",    label: "TrueNAS",         icon: "💾" },
  { type: "proxmox",    label: "Proxmox",         icon: "🖥️" },
  { type: "adguard",    label: "AdGuard",         icon: "🛡️" },
  { type: "opnsense",   label: "OPNsense",        icon: "🔥" },
  { type: "calendar",   label: "Calendar",        icon: "📅" },
  { type: "lights",     label: "Lights",          icon: "💡" },
];

const WIDGET_CATEGORIES = [
  { label: "Utilities",    types: ["clock", "weather", "notes", "bookmarks", "rest"],                   color: "#f59e0b" },
  { label: "Media",        types: ["photos", "rss", "stream", "nowplaying"],                            color: "#f472b6" },
  { label: "Ping",         types: ["ping"],                                                             color: "#a78bfa" },
  { label: "Integrations", types: ["netbox", "truenas", "proxmox", "adguard", "opnsense", "calendar", "lights"], color: "#34d399" },
];

function typeColor(type) {
  return WIDGET_CATEGORIES.find(c => c.types.includes(type))?.color || "#8b96a5";
}

// Toggle contextual tips and keep the Settings-menu state pill in sync.
function setTipsEnabled(on, persist = true) {
  document.body.classList.toggle("tips-on", on);
  const st = byId("tips-menu-state");
  if (st) { st.textContent = on ? "On" : "Off"; st.classList.toggle("on", on); }
  if (persist) api.updateSettings({ tips_enabled: String(on) }).catch(() => {});
}

function buildPingMini(widget) {
  const data    = liveData[widget.id];
  const targets = widget.config?.targets || [];
  const wrap    = document.createElement("div");
  wrap.className = "palette-ping-mini";
  for (const t of targets.slice(0, 5)) {
    const dot = document.createElement("span");
    dot.className = "palette-ping-dot";
    const result = data?.data?.targets?.find(
      (r) => r.address === t.address || r.label === t.label
    );
    if (result) dot.classList.add(result.up ? "up" : "down");
    dot.title = t.label || t.address;
    wrap.appendChild(dot);
  }
  if (targets.length > 5) {
    const more = document.createElement("span");
    more.className = "palette-ping-more";
    more.textContent = `+${targets.length - 5}`;
    wrap.appendChild(more);
  }
  return wrap;
}

// ── sidebar section toggles ───────────────────────────────────────────────────

function setupSectionToggles() {
  document.querySelectorAll(".sb-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".sb-section").classList.toggle("collapsed");
    });
  });
}

// ── widget sidebar section ────────────────────────────────────────────────────

const _CAT_EMPTY_HINT = {
  "Utilities":    "Click + to add a clock, weather, notes, bookmarks or a REST widget.",
  "Media":        "Click + to add a photo frame, news feed, camera or what's playing on Plex / Jellyfin.",
  "Ping":         "Click + to add a ping monitor.",
  "Integrations": "Click + to connect Proxmox, TrueNAS, NetBox, AdGuard, OPNsense or a calendar.",
};

function placedWidgetIds() {
  const ids = new Set();
  for (const p of board.pages) for (const n of p.layout || []) {
    const s = stacks.find((x) => x.id === n.stack_id);
    s?.widget_ids.forEach((id) => ids.add(id));
  }
  return ids;
}

function renderWidgets() {
  const list = byId("widget-list");
  if (!list) return;
  list.innerHTML = "";
  byId("widget-count").textContent = widgets.length;
  const q = (byId("lib-search")?.value || "").trim().toLowerCase();
  const onBoard = placedWidgetIds();

  for (const cat of WIDGET_CATEGORIES) {
    const catWidgets = widgets.filter((w) => cat.types.includes(w.type) &&
      (!q || w.title.toLowerCase().includes(q) || w.type.includes(q)));
    if (q && !catWidgets.length) continue;

    const group = document.createElement("div");
    group.className = "sb-cat-group";

    const header = document.createElement("div");
    header.className = "sb-cat-header";
    header.style.setProperty("--cat", cat.color);

    const arrow = Object.assign(document.createElement("span"), { className: "sb-arrow sb-cat-arrow", textContent: "▾" });
    const label = Object.assign(document.createElement("span"), { className: "sb-cat-label", textContent: cat.label });
    const count = Object.assign(document.createElement("span"), { className: "sb-cat-count", textContent: catWidgets.length });

    const btnGroup = document.createElement("div");
    btnGroup.className = "sb-cat-btn-group";

    if (cat.label === "Ping") {
      const targetsBtn = Object.assign(document.createElement("button"), {
        className: "sb-cat-targets-btn", textContent: "Targets", title: "Manage ping targets and groups",
      });
      targetsBtn.addEventListener("click", (e) => { e.stopPropagation(); openSettingsPanel("Ping Targets"); });
      btnGroup.appendChild(targetsBtn);
    }

    const addBtn = Object.assign(document.createElement("button"), {
      className: "sb-cat-add-btn", textContent: "＋", title: `New ${cat.label} widget`,
    });
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (cat.label === "Integrations") openIntegrationWizard();
      else if (cat.label === "Ping") openWidgetModal(null, { typeFilter: cat.types });
      else openCategoryWizard(cat.label);
    });
    btnGroup.appendChild(addBtn);

    header.append(arrow, label, count, btnGroup);

    const body = document.createElement("div");
    body.className = "sb-cat-body";

    if (catWidgets.length) {
      for (const w of catWidgets) body.appendChild(buildWidgetItem(w, onBoard.has(w.id)));
    } else {
      body.appendChild(Object.assign(document.createElement("div"), {
        className: "palette-no-stacks sb-cat-empty",
        textContent: _CAT_EMPTY_HINT[cat.label] || "Click + to add a widget.",
      }));
    }

    header.addEventListener("click", () => {
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      arrow.style.transform = hidden ? "" : "rotate(-90deg)";
    });

    group.append(header, body);
    list.appendChild(group);
  }
  if (q && !list.children.length) {
    list.appendChild(Object.assign(document.createElement("div"), { className: "palette-no-stacks", textContent: `No widgets match "${q}".` }));
  }
  setupDragIn();
}

// Small badge marking whether a widget can be stacked onto another card.
function _stackBadge(type) {
  const stackable = !MULTIPAGE_TYPES.has(type);
  const span = document.createElement("span");
  span.className = "sb-stack-badge" + (stackable ? "" : " nostack");
  const label = stackable ? "Stackable" : "Can't be stacked (multi-page widget)";
  span.dataset.tip = label;
  span.title = label;
  span.innerHTML = stackable
    ? '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 2.2 14 5 8 7.8 2 5 8 2.2Z"/><path d="M2.4 8 8 10.6 13.6 8"/><path d="M2.4 11 8 13.6 13.6 11"/></svg>'
    : '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 2.2 14 5 8 7.8 2 5 8 2.2Z"/><line x1="2.8" y1="13.2" x2="13.2" y2="2.8"/></svg>';
  return span;
}

function buildWidgetItem(w, onBoard = false) {
  const item = document.createElement("div");
  item.className = "sb-widget-item" + (onBoard ? " on-board" : "");
  item.style.borderLeftColor = typeColor(w.type);
  item.dataset.widgetId = w.id;
  const [dw, dh] = defaultSize(w.type);
  item.setAttribute("gs-w", dw);
  item.setAttribute("gs-h", dh);

  const head = document.createElement("div");
  head.className = "sb-widget-head";

  const badge = document.createElement("span");
  badge.className = "palette-type-badge";
  badge.textContent = w.type;
  badge.style.borderColor = typeColor(w.type);
  badge.style.color = typeColor(w.type);

  const name = document.createElement("span");
  name.className = "sb-widget-name";
  name.textContent = w.title;
  if (onBoard) name.title = "Already on a page";

  const placeBtn = Object.assign(document.createElement("button"), {
    className: "sb-icon-btn sb-place-btn", title: "Add to this page in the first free space", textContent: "＋",
  });
  const editBtn = Object.assign(document.createElement("button"), { className: "sb-icon-btn", title: "Edit widget", textContent: "✎" });
  const delBtn = Object.assign(document.createElement("button"), { className: "sb-icon-btn danger", title: "Delete widget", textContent: "✕" });

  head.append(_stackBadge(w.type), badge, name, placeBtn, editBtn, delBtn);
  item.appendChild(head);

  for (const b of [placeBtn, editBtn, delBtn]) b.addEventListener("pointerdown", (e) => e.stopPropagation());
  placeBtn.addEventListener("click", (e) => { e.stopPropagation(); placeWidget(w.id); });
  editBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openWidgetModal(w); });
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete widget "${w.title}"?`)) return;
    await deleteWidgetAndScrub(w);
  });
  item.addEventListener("dblclick", () => placeWidget(w.id));
  return item;
}

// GridStack drag-in: sidebar items become draggable onto the grid, with the
// live placeholder and touch support that native HTML5 drag lacked.
function setupDragIn() {
  if (!window.GridStack) return;
  GridStack.setupDragIn(".sb-widget-item", {
    appendTo: "body",
    helper: (el) => {
      const ghost = el.cloneNode(true);
      ghost.classList.add("sb-drag-ghost");
      ghost.style.width = el.offsetWidth + "px";
      return ghost;
    },
  });
}

function makeSbRow(labelText, input) {
  const row = document.createElement("div");
  row.className = "sb-form-row";
  const lbl = document.createElement("div");
  lbl.className = "sb-form-label"; lbl.textContent = labelText;
  row.append(lbl, input);
  return row;
}

// ── Credential field helpers ──────────────────────────────────────────────────

function makeListField(f, initialValue = "") {
  const wrap = document.createElement("div");
  wrap.className = "cred-list-wrap";
  wrap.dataset.credKey = f.key;

  const entries = initialValue ? initialValue.split("\n").filter(Boolean) : [];

  const addBtn = Object.assign(document.createElement("button"), {
    type: "button", className: "cred-list-add",
    textContent: f.addLabel || `+ Add another ${f.label}`,
  });

  function addEntry(val = "") {
    const row = document.createElement("div");
    row.className = "cred-list-row";
    const inp = Object.assign(document.createElement("input"), {
      className: "sb-form-input", type: "url",
      placeholder: f.placeholder || "https://…",
      value: val,
    });
    const del = Object.assign(document.createElement("button"), {
      type: "button", className: "cred-list-del", textContent: "×", title: "Remove",
    });
    del.addEventListener("click", () => row.remove());
    row.append(inp, del);
    wrap.insertBefore(row, addBtn);
  }

  addBtn.addEventListener("click", () => addEntry());
  wrap.appendChild(addBtn);

  if (entries.length) { for (const v of entries) addEntry(v); }
  else addEntry();
  wrap._getValue = () =>
    [...wrap.querySelectorAll(".cred-list-row input")]
      .map(i => i.value.trim()).filter(Boolean).join("\n");
  return wrap;
}

function makeCredField(f, initialValue = "") {
  if (f.type === "list") return makeListField(f, initialValue);
  if (f.type === "textarea") {
    const ta = Object.assign(document.createElement("textarea"), {
      className: "sb-form-input", placeholder: f.placeholder || f.label, rows: 4,
    });
    ta.dataset.credKey = f.key;
    if (initialValue) ta.value = initialValue;
    return ta;
  }
  const inp = Object.assign(document.createElement("input"), {
    className: "sb-form-input", placeholder: f.placeholder || f.label, type: f.type || "text",
  });
  inp.dataset.credKey = f.key;
  return inp;
}

function readCredFields(container) {
  const creds = {};
  for (const el of container.querySelectorAll("[data-cred-key]")) {
    const val = typeof el._getValue === "function" ? el._getValue() : el.value.trim();
    if (val) creds[el.dataset.credKey] = val;
  }
  return creds;
}

// Draggable view-order list used in NetBox and TrueNAS widget config.
// viewDefs: [{key, label}, ...] — full ordered set for this widget type.
// savedViews: [{key, enabled}, ...] | null — persisted config or null for defaults.
// Returns { el, getViews() }.
function buildViewOrderUI(viewDefs, savedViews) {
  // Merge saved order with full def list (handles new fields added later)
  const ordered = [];
  if (savedViews?.length) {
    for (const sv of savedViews) {
      const def = viewDefs.find(d => d.key === sv.key);
      if (def) ordered.push({ key: sv.key, label: def.label, enabled: sv.enabled !== false });
    }
    for (const def of viewDefs) {
      if (!ordered.find(o => o.key === def.key))
        ordered.push({ key: def.key, label: def.label, enabled: true });
    }
  } else {
    viewDefs.forEach(d => ordered.push({ key: d.key, label: d.label, enabled: true }));
  }

  const container = document.createElement("div");
  container.className = "view-order-list";
  let dragSrc = null;

  const render = () => {
    container.innerHTML = "";
    ordered.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "view-order-row" + (item.enabled ? "" : " vod");
      row.draggable = true;

      const handle = Object.assign(document.createElement("span"), { className: "view-order-handle", textContent: "⠿" });

      const tog = document.createElement("input");
      tog.type = "checkbox"; tog.className = "view-order-check"; tog.checked = item.enabled;
      tog.addEventListener("change", () => { ordered[i].enabled = tog.checked; row.classList.toggle("vod", !tog.checked); });

      const lbl = Object.assign(document.createElement("span"), { className: "view-order-label", textContent: item.label });

      row.addEventListener("dragstart", e => { dragSrc = i; e.dataTransfer.effectAllowed = "move"; row.classList.add("dragging"); });
      row.addEventListener("dragend",   () => { row.classList.remove("dragging"); dragSrc = null; });
      row.addEventListener("dragover",  e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
      row.addEventListener("drop",      e => {
        e.preventDefault();
        if (dragSrc === null || dragSrc === i) return;
        const [moved] = ordered.splice(dragSrc, 1);
        ordered.splice(i, 0, moved);
        render();
      });

      row.append(handle, tog, lbl);
      container.appendChild(row);
    });
  };

  render();
  return { el: container, getViews: () => ordered.map(({ key, enabled }) => ({ key, enabled })) };
}

// ── widget modal ──────────────────────────────────────────────────────────────

function buildPingLibraryPicker(w) {
  const selectedIds = new Set(w?.config?.target_ids || []);

  const wrap = document.createElement("div");
  wrap.className = "ping-picker";

  if (!pingTargets.length) {
    wrap.appendChild(Object.assign(document.createElement("div"), {
      className: "w-empty",
      textContent: "No ping targets defined. Add targets in Settings → Ping Targets.",
    }));
    wrap.getSelectedIds = () => [];
    return wrap;
  }

  const groups = {};
  const ungrouped = [];
  for (const t of pingTargets) {
    if (t.group) { (groups[t.group] = groups[t.group] || []).push(t); }
    else { ungrouped.push(t); }
  }

  function buildGroup(name, targets) {
    const groupEl = document.createElement("div");
    groupEl.className = "pp-group";

    const head = document.createElement("div");
    head.className = "pp-group-head";

    const arrow = Object.assign(document.createElement("span"), { className: "pp-group-arrow", textContent: "▼" });
    const nameSpan = Object.assign(document.createElement("span"), { className: "pp-group-name", textContent: name });
    const countBadge = document.createElement("span");
    countBadge.className = "pp-count-badge";

    function updateCount() {
      const sel = targets.filter(t => selectedIds.has(t.id)).length;
      countBadge.textContent = `${sel} / ${targets.length}`;
    }

    const selectAllBtn = Object.assign(document.createElement("button"), { type: "button", className: "pp-select-all-btn" });

    function updateSelectAll() {
      const allSel = targets.every(t => selectedIds.has(t.id));
      selectAllBtn.textContent = allSel ? "Deselect All" : "Select All";
    }

    selectAllBtn.addEventListener("click", () => {
      const allSel = targets.every(t => selectedIds.has(t.id));
      for (const t of targets) {
        if (allSel) selectedIds.delete(t.id); else selectedIds.add(t.id);
      }
      body.querySelectorAll(".pp-chip").forEach((chip, i) => {
        chip.classList.toggle("pp-chip-selected", selectedIds.has(targets[i].id));
      });
      updateCount(); updateSelectAll();
    });

    head.append(arrow, nameSpan, countBadge, selectAllBtn);

    const body = document.createElement("div");
    body.className = "pp-group-body";

    for (const t of targets) {
      const chip = Object.assign(document.createElement("button"), {
        type: "button",
        className: "pp-chip" + (selectedIds.has(t.id) ? " pp-chip-selected" : ""),
        textContent: t.label || t.address,
      });
      chip.addEventListener("click", () => {
        if (selectedIds.has(t.id)) selectedIds.delete(t.id); else selectedIds.add(t.id);
        chip.classList.toggle("pp-chip-selected", selectedIds.has(t.id));
        updateCount(); updateSelectAll();
      });
      body.appendChild(chip);
    }

    head.addEventListener("click", (e) => {
      if (e.target === selectAllBtn || selectAllBtn.contains(e.target)) return;
      const collapsed = body.classList.toggle("pp-group-body-collapsed");
      arrow.style.transform = collapsed ? "rotate(-90deg)" : "";
    });

    updateCount(); updateSelectAll();
    groupEl.append(head, body);
    return groupEl;
  }

  for (const [grp, targets] of Object.entries(groups)) {
    wrap.appendChild(buildGroup(grp, targets));
  }

  if (ungrouped.length) {
    wrap.appendChild(buildGroup("Ungrouped", ungrouped));
  }

  wrap.getSelectedIds = () => [...selectedIds];
  return wrap;
}

async function openWidgetModal(w = null, opts = {}) {
  const dlg = byId("widget-modal");
  dlg.innerHTML = "";

  const head = document.createElement("div");
  head.className = "modal-head";
  const titleEl = document.createElement("h2");
  const inStack = w && stacks.some(s => s.widget_ids.includes(w.id) && s.widget_ids.length > 1);
  const newTypeMeta = !w && opts.defaultType ? WIDGET_TYPES.find(x => x.type === opts.defaultType) : null;
  if (w) titleEl.textContent = inStack ? "Edit Stack" : "Edit Widget";
  else if (newTypeMeta) titleEl.textContent = `${newTypeMeta.icon} ${newTypeMeta.label}`;
  else titleEl.textContent = "New Widget";
  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-close-btn"; closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => dlg.close());
  head.append(titleEl, closeBtn);
  dlg.appendChild(head);

  const body = document.createElement("div");
  body.className = "modal-body";

  if (opts.backTo) {
    const backBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "small wizard-back-btn", textContent: "← Back",
    });
    backBtn.addEventListener("click", () => opts.backTo());
    body.appendChild(backBtn);
  }

  const nameInput = Object.assign(document.createElement("input"), {
    className: "sb-form-input", placeholder: "Widget name", value: w?.title || "",
  });
  body.appendChild(makeSbRow("Name", nameInput));

  const availableTypes = opts.typeFilter
    ? WIDGET_TYPES.filter(wt => opts.typeFilter.includes(wt.type))
    : WIDGET_TYPES;
  let type = opts.defaultType || w?.type || availableTypes[0]?.type || "clock";

  // Type selector (new widget only; hidden when only one type available)
  const typeSel = document.createElement("select");
  typeSel.className = "sb-form-input";
  for (const wt of availableTypes) {
    const opt = document.createElement("option");
    opt.value = wt.type; opt.textContent = wt.label;
    if (wt.type === type) opt.selected = true;
    typeSel.appendChild(opt);
  }
  if (!w && availableTypes.length > 1) body.appendChild(makeSbRow("Type", typeSel));

  // Config section — rebuilt when type changes
  const cfgWrap = document.createElement("div");
  cfgWrap.className = "wm-config-wrap";
  body.appendChild(cfgWrap);

  let allDataSources = [];
  try { allDataSources = await api.listDataSources(); } catch {}

  let getConfig = () => ({});

  function buildConfigFields(t) {
    cfgWrap.innerHTML = "";
    getConfig = () => ({});
    const cfg = w?.config || {};

    const inp = (placeholder, value = "", inputType = "text") => Object.assign(document.createElement("input"), {
      className: "sb-form-input", placeholder, value, type: inputType,
    });
    const sel = (opts, current) => {
      const s = document.createElement("select");
      s.className = "sb-form-input";
      for (const [val, label] of opts) {
        const o = document.createElement("option");
        o.value = val; o.textContent = label;
        if (val === current) o.selected = true;
        s.appendChild(o);
      }
      return s;
    };

    if (t === "clock") {
      const modeSel  = sel([["digital","Digital"],["analog","Analog"]], cfg.clock_mode || "digital");
      const fmtSel   = sel([["12h","12-hour"],["24h","24-hour"]], cfg.clock_format || "12h");

      const DIGITAL_STYLES = [["minimal","Minimal"],["full","Bold"],["retro","Retro"],["neon","Neon"],["mono","Matrix"]];
      const ANALOG_STYLES  = [["minimal","Minimal"],["classic","Classic"],["modern","Modern"],["neon","Neon"]];
      const STYLE_COLORS   = { minimal:"#e6edf3", full:"#e6edf3", retro:"#f97316", neon:"#22d3ee", mono:"#4ade80", classic:"#ffffff", modern:"#ffffff" };

      const styleSel = document.createElement("select");
      styleSel.className = "sb-form-input";
      function updateStyleOptions() {
        const cur = styleSel.value || cfg.clock_style || "minimal";
        const opts = modeSel.value === "analog" ? ANALOG_STYLES : DIGITAL_STYLES;
        styleSel.innerHTML = "";
        let found = false;
        for (const [v, l] of opts) {
          const o = Object.assign(document.createElement("option"), { value: v, textContent: l });
          if (v === cur) { o.selected = true; found = true; }
          styleSel.appendChild(o);
        }
        if (!found) styleSel.options[0].selected = true;
      }
      updateStyleOptions();

      const tzInp = inp("e.g. America/Phoenix", cfg.clock_timezone || "");

      const colorInp = document.createElement("input");
      colorInp.type = "color";
      colorInp.className = "sb-form-input";
      colorInp.style.cssText = "width:44px;height:32px;padding:2px 4px;cursor:pointer;";
      function getDefaultColor() { return STYLE_COLORS[styleSel.value] || "#e6edf3"; }
      colorInp.value = cfg.clock_color || getDefaultColor();

      const glowSlider = document.createElement("input");
      glowSlider.type = "range";
      glowSlider.min = "0"; glowSlider.max = "100"; glowSlider.step = "5";
      glowSlider.className = "sb-form-input";
      glowSlider.style.cssText = "padding:0;height:22px;cursor:pointer;";
      glowSlider.value = cfg.clock_glow != null ? cfg.clock_glow : 100;

      const previewEl = document.createElement("div");
      previewEl.className = "wm-clock-preview";

      function _digitalTick(fmt, style, tz, color, glow) {
        let h, m, s;
        try {
          const parts = new Intl.DateTimeFormat("en", { timeZone: tz || undefined, hour: "numeric", minute: "numeric", second: "numeric", hour12: false }).formatToParts(new Date());
          h = +parts.find(p => p.type === "hour").value;
          m = +parts.find(p => p.type === "minute").value;
          s = +parts.find(p => p.type === "second").value;
        } catch { const n = new Date(); h = n.getHours(); m = n.getMinutes(); s = n.getSeconds(); }

        let ampm = "";
        if (fmt === "12h") { ampm = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; }
        const hm  = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
        const sec = String(s).padStart(2,"0");

        const THEMES = {
          minimal: { color:"#e6edf3", font:"inherit",                          weight:200, size:54, ls:"-4px", showSec:false },
          full:    { color:"#e6edf3", font:"inherit",                          weight:700, size:44, ls:"-2px", showSec:true },
          retro:   { color:"#f97316", font:"'Courier New', monospace",         weight:700, size:42, ls:"2px",  showSec:true, shadow:"0 0 14px rgba(249,115,22,.5)" },
          neon:    { color:"#22d3ee", font:"'Orbitron', sans-serif",           weight:600, size:38, ls:"3px",  showSec:true, shadow:"0 0 18px rgba(34,211,238,.55),0 0 40px rgba(34,211,238,.2)" },
          mono:    { color:"#4ade80", font:"'Courier New', monospace",         weight:400, size:44, ls:"3px",  showSec:true },
        };
        const t = THEMES[style] || THEMES.minimal;
        const c = color || t.color;
        const glowFactor = glow != null ? Number(glow) / 100 : 1;
        function _hexGlow(hex, alpha) {
          const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
          return `rgba(${r},${g},${b},${(alpha * glowFactor).toFixed(2)})`;
        }
        let shadow = null;
        if (style === "retro") shadow = `0 0 14px ${_hexGlow(c, 0.5)}`;
        else if (style === "neon") shadow = `0 0 18px ${_hexGlow(c, 0.55)},0 0 40px ${_hexGlow(c, 0.2)}`;

        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;align-items:center;justify-content:center;width:100%;height:100%;";

        const inner = document.createElement("div");
        inner.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;";

        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:baseline;gap:6px;";
        const hmEl = document.createElement("span");
        hmEl.textContent = hm;
        hmEl.style.cssText = `font-size:${t.size}px;font-weight:${t.weight};letter-spacing:${t.ls};line-height:1;font-variant-numeric:tabular-nums;color:${c};font-family:${t.font};${shadow ? `text-shadow:${shadow};` : ""}`;
        row.appendChild(hmEl);
        if (t.showSec) {
          const secEl = document.createElement("span");
          secEl.textContent = sec;
          secEl.style.cssText = `font-size:20px;font-weight:300;color:${c};opacity:0.45;font-variant-numeric:tabular-nums;font-family:${t.font};${shadow ? `text-shadow:${shadow};` : ""}`;
          row.appendChild(secEl);
        }
        inner.appendChild(row);
        if (ampm) {
          const ampmEl = document.createElement("div");
          ampmEl.textContent = ampm;
          ampmEl.style.cssText = `font-size:${style === "minimal" ? 17 : 14}px;font-weight:500;color:${c};opacity:0.65;font-family:${t.font};`;
          inner.appendChild(ampmEl);
        }
        wrap.appendChild(inner);
        return wrap;
      }

      let _previewTimer = null;
      function updateClockPreview() {
        clearInterval(_previewTimer);
        const mode = modeSel.value, fmt = fmtSel.value, style = styleSel.value;
        const tz = tzInp.value.trim(), color = colorInp.value, glow = Number(glowSlider.value);
        previewEl.innerHTML = "";
        if (mode === "analog") {
          const clockEl = renderWidget({ id: -99, type: "clock", title: "", config: { clock_mode: "analog", clock_style: style, clock_timezone: tz, clock_color: color, clock_glow: glow, clock_accent: accentColorInp.value } }, null);
          clockEl.style.cssText = "width:100px;height:100px;flex:none;padding:0;overflow:visible;";
          previewEl.appendChild(clockEl);
        } else {
          previewEl.appendChild(_digitalTick(fmt, style, tz, color, glow));
          _previewTimer = setInterval(() => { previewEl.innerHTML = ""; previewEl.appendChild(_digitalTick(fmt, style, tz, color, glow)); }, 1000);
        }
      }

      const glowRow = makeSbRow("Glow", glowSlider);

      const accentColorInp = document.createElement("input");
      accentColorInp.type = "color";
      accentColorInp.className = "sb-form-input";
      accentColorInp.style.cssText = "width:44px;height:32px;padding:2px 4px;cursor:pointer;";
      accentColorInp.value = cfg.clock_accent || "#e879f9";
      const accentRow = makeSbRow("Accent", accentColorInp);

      function updateConditionalRows() {
        const mode = modeSel.value, style = styleSel.value;
        glowRow.style.display   = (style === "retro" || style === "neon") ? "" : "none";
        accentRow.style.display = (mode === "analog" && style === "neon") ? "" : "none";
      }
      updateConditionalRows();

      modeSel.addEventListener("change", () => { updateStyleOptions(); colorInp.value = getDefaultColor(); accentColorInp.value = "#e879f9"; glowSlider.value = 100; updateConditionalRows(); updateClockPreview(); });
      styleSel.addEventListener("change", () => { colorInp.value = getDefaultColor(); accentColorInp.value = "#e879f9"; glowSlider.value = 100; updateConditionalRows(); updateClockPreview(); });
      [fmtSel, colorInp, accentColorInp].forEach(el => el.addEventListener("change", updateClockPreview));
      colorInp.addEventListener("input", updateClockPreview);
      accentColorInp.addEventListener("input", updateClockPreview);
      glowSlider.addEventListener("input", updateClockPreview);
      tzInp.addEventListener("input", updateClockPreview);

      cfgWrap.append(makeSbRow("Mode", modeSel), makeSbRow("Format", fmtSel), makeSbRow("Style", styleSel));
      cfgWrap.appendChild(previewEl);
      cfgWrap.append(makeSbRow("Color", colorInp), accentRow, glowRow, makeSbRow("Timezone", tzInp));
      setTimeout(updateClockPreview, 0);

      getConfig = () => ({ clock_mode: modeSel.value, clock_format: fmtSel.value, clock_style: styleSel.value, clock_color: colorInp.value, clock_accent: accentColorInp.value, clock_glow: Number(glowSlider.value), clock_timezone: tzInp.value.trim() });

    } else if (t === "weather") {
      const locNameInp = inp("City name or zip code", cfg.location_name || "");
      const latInp     = inp("Latitude",  String(cfg.latitude  ?? ""));
      const lonInp     = inp("Longitude", String(cfg.longitude ?? ""));
      const unitsSel   = sel([["fahrenheit","°F"],["celsius","°C"]], cfg.units || "fahrenheit");
      const daysSel    = sel([["5","5 days"],["7","7 days"]], String(cfg.forecast_days || 7));
      const geoBtn = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Search location" });
      const geoResults = document.createElement("div");
      geoResults.className = "wm-geo-results";
      geoBtn.addEventListener("click", async () => {
        const q = locNameInp.value.trim(); if (!q) return;
        geoBtn.disabled = true; geoBtn.textContent = "Searching…";
        try {
          const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`);
          const j = await r.json();
          geoResults.innerHTML = "";
          for (const loc of (j.results || [])) {
            const opt = Object.assign(document.createElement("div"), {
              className: "wm-geo-option",
              textContent: `${loc.name}, ${loc.admin1 || ""}, ${loc.country}`,
            });
            opt.addEventListener("click", () => {
              locNameInp.value = loc.name; latInp.value = loc.latitude; lonInp.value = loc.longitude;
              geoResults.innerHTML = "";
            });
            geoResults.appendChild(opt);
          }
        } finally { geoBtn.disabled = false; geoBtn.textContent = "Search location"; }
      });
      const locRow = document.createElement("div");
      locRow.className = "wm-loc-row";
      locNameInp.style.width = "auto";
      locNameInp.style.flex = "1";
      locRow.append(locNameInp, geoBtn);
      cfgWrap.append(makeSbRow("Location", locRow), geoResults,
        makeSbRow("Latitude", latInp), makeSbRow("Longitude", lonInp),
        makeSbRow("Units", unitsSel), makeSbRow("Forecast days", daysSel));
      getConfig = () => ({ location_name: locNameInp.value.trim(), latitude: parseFloat(latInp.value), longitude: parseFloat(lonInp.value), units: unitsSel.value, forecast_days: Number(daysSel.value) });

    } else if (t === "ping") {
      pingPickerEl = buildPingLibraryPicker(w);
      cfgWrap.appendChild(pingPickerEl);
      getConfig = () => ({ target_ids: pingPickerEl.getSelectedIds() });

    } else if (t === "netbox") {
      const rackInp = inp("Rack name filter (optional)", cfg.rack_name || "");
      cfgWrap.appendChild(makeSbRow("Rack name", rackInp));
      const nbViewDefs = [
        { key: "rack",    label: "Elevation" },
        { key: "devices", label: "Device Count" },
        { key: "ips",     label: "IP Addresses" },
        { key: "vms",     label: "Virtual Machines" },
      ];
      const nbViewUI = buildViewOrderUI(nbViewDefs, cfg.views || null);
      const nbViewLbl = Object.assign(document.createElement("div"), { className: "sb-form-label", textContent: "Display sections" });
      nbViewLbl.style.marginTop = "10px";
      cfgWrap.append(nbViewLbl, nbViewUI.el);
      getConfig = () => ({ rack_name: rackInp.value.trim(), views: nbViewUI.getViews() });

    } else if (t === "truenas") {
      const poolInp = inp("Pool name filter (optional)", cfg.pool_name || "");
      cfgWrap.appendChild(makeSbRow("Pool name", poolInp));
      const tnViewDefs = [
        { key: "storage", label: "Storage" },
        { key: "memory",  label: "Memory" },
        { key: "cpu",     label: "CPU" },
      ];
      const tnViewUI = buildViewOrderUI(tnViewDefs, cfg.views || null);
      const tnViewLbl = Object.assign(document.createElement("div"), { className: "sb-form-label", textContent: "Display sections" });
      tnViewLbl.style.marginTop = "10px";
      cfgWrap.append(tnViewLbl, tnViewUI.el);
      getConfig = () => ({ pool_name: poolInp.value.trim(), views: tnViewUI.getViews() });

    } else if (t === "proxmox") {
      getConfig = () => ({});
    } else if (t === "adguard") {
      getConfig = () => ({});
    } else if (t === "opnsense") {
      getConfig = () => ({});
    } else if (t === "stream") {
      const urlInp = inp("Stream URL (e.g. http://host/stream.m3u8)", cfg.stream_url || "");
      cfgWrap.appendChild(makeSbRow("Stream URL", urlInp));
      getConfig = () => ({ stream_url: urlInp.value.trim() });
    } else if (t === "calendar") {
      const viewSel = document.createElement("select");
      viewSel.className = "sb-form-input";
      for (const [v, l] of [["list", "List"], ["week", "Week (7 days)"], ["month", "Month"]]) {
        const opt = Object.assign(document.createElement("option"), { value: v, textContent: l });
        if ((cfg.calendar_view || "list") === v) opt.selected = true;
        viewSel.appendChild(opt);
      }
      const daysInp = Object.assign(document.createElement("input"), {
        className: "sb-form-input", type: "number", min: "1", max: "90",
        value: cfg.days_ahead ?? 7,
      });
      const maxInp  = Object.assign(document.createElement("input"), {
        className: "sb-form-input", type: "number", min: "1", max: "50",
        value: cfg.max_events ?? 25,
      });
      cfgWrap.append(makeSbRow("View", viewSel), makeSbRow("Days ahead", daysInp), makeSbRow("Max events", maxInp));
      getConfig = () => ({ calendar_view: viewSel.value, days_ahead: Number(daysInp.value) || 7, max_events: Number(maxInp.value) || 25 });
    } else if (t === "notes") {
      const ta = Object.assign(document.createElement("textarea"), {
        className: "sb-form-input wm-notes-text", rows: 9, value: cfg.text || "",
        placeholder: "## Heading\n- list item\n- [ ] to-do\n**bold**, *italic*, `code`, [link](https://…)",
      });
      const sizeSel = sel([["0.85", "Small"], ["1", "Medium"], ["1.3", "Large"], ["1.7", "Extra large"]], String(cfg.size || 1));
      const alignSel = sel([["left", "Left"], ["center", "Center"], ["right", "Right"]], cfg.align || "left");
      const tintOn = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!cfg.tint });
      const tint = Object.assign(document.createElement("input"), { type: "color", className: "sb-form-input", value: cfg.tint || "#fbbf24" });
      tint.style.cssText = "width:44px;height:32px;padding:2px 4px;";
      const tintRow = document.createElement("div");
      tintRow.className = "wm-inline";
      tintRow.append(tintOn, tint);
      const openSel = sel([["qr", "Show a QR code"], ["new", "New tab"], ["same", "Same tab"]], cfg.open || "qr");
      const preview = document.createElement("div");
      preview.className = "wm-live-preview";
      const draw = () => {
        preview.innerHTML = "";
        preview.appendChild(renderWidget({ id: -1, type: "notes", title: "", config: { text: ta.value, size: Number(sizeSel.value), align: alignSel.value, tint: tintOn.checked ? tint.value : "" } }, null, { hideTitle: true }));
      };
      [ta, sizeSel, alignSel, tintOn, tint].forEach((x) => x.addEventListener("input", draw));
      draw();
      cfgWrap.append(makeSbRow("Note (Markdown)", ta), preview, makeSbRow("Text size", sizeSel), makeSbRow("Align", alignSel),
        makeSbRow("Tint", tintRow), makeSbRow("Tapping a link on the display", openSel));
      getConfig = () => ({ text: ta.value, size: Number(sizeSel.value), align: alignSel.value, tint: tintOn.checked ? tint.value : "", open: openSel.value });

    } else if (t === "bookmarks") {
      const layoutSel = sel([["tiles", "Tiles"], ["list", "List with status"], ["dock", "Dock (one row)"]], cfg.layout || "tiles");
      const openSel = sel([["new", "New tab"], ["same", "Same tab"], ["qr", "Show a QR code (wall panels)"]], cfg.open || "new");
      const groups = structuredClone(cfg.groups?.length ? cfg.groups : [{ name: "Apps", items: [] }]);
      const editor = document.createElement("div");
      editor.className = "wm-bm-editor";
      const drawGroups = () => {
        editor.innerHTML = "";
        groups.forEach((g, gi) => {
          const box = document.createElement("div");
          box.className = "wm-bm-group";
          const gHead = document.createElement("div");
          gHead.className = "wm-bm-ghead";
          const gName = inp("Group name", g.name || "");
          gName.addEventListener("input", () => { g.name = gName.value; });
          const gDel = Object.assign(document.createElement("button"), { type: "button", className: "small danger", textContent: "Remove group" });
          gDel.addEventListener("click", () => { groups.splice(gi, 1); if (!groups.length) groups.push({ name: "Apps", items: [] }); drawGroups(); });
          gHead.append(gName, gDel);
          box.appendChild(gHead);
          (g.items ||= []).forEach((it, ii) => {
            const row = document.createElement("div");
            row.className = "wm-bm-row";
            const label = inp("Label", it.label || "");
            const url = inp("https://…", it.url || "");
            const icon = inp("auto", it.icon || "");
            icon.title = "auto (site icon), letters, di:jellyfin (dashboard-icons), si:plex (simple-icons) or an image URL";
            const check = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!it.check, title: "Check whether it's up" });
            const checkLbl = document.createElement("label");
            checkLbl.className = "wm-bm-check";
            checkLbl.append(check, " up?");
            const up = Object.assign(document.createElement("button"), { type: "button", className: "sw-arrow", textContent: "↑", title: "Move up" });
            const del = Object.assign(document.createElement("button"), { type: "button", className: "sw-remove", textContent: "✕", title: "Remove" });
            label.addEventListener("input", () => { it.label = label.value; });
            url.addEventListener("input", () => { it.url = url.value.trim(); });
            icon.addEventListener("input", () => { it.icon = icon.value.trim(); });
            check.addEventListener("change", () => { it.check = check.checked; });
            up.addEventListener("click", () => { if (ii > 0) { [g.items[ii - 1], g.items[ii]] = [g.items[ii], g.items[ii - 1]]; drawGroups(); } });
            del.addEventListener("click", () => { g.items.splice(ii, 1); drawGroups(); });
            row.append(label, url, icon, checkLbl, up, del);
            box.appendChild(row);
          });
          const addLink = Object.assign(document.createElement("button"), { type: "button", className: "sb-add-target", textContent: "+ Link" });
          addLink.addEventListener("click", () => { g.items.push({ label: "", url: "", icon: "auto", check: false }); drawGroups(); box.querySelector(".wm-bm-row:last-of-type input")?.focus(); });
          box.appendChild(addLink);
          editor.appendChild(box);
        });
        const addGroup = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "+ Group" });
        addGroup.addEventListener("click", () => { groups.push({ name: `Group ${groups.length + 1}`, items: [] }); drawGroups(); });
        editor.appendChild(addGroup);
      };
      drawGroups();

      // Import: Homepage services.yaml, a browser bookmarks export, or "Label | URL" lines
      const importBox = Object.assign(document.createElement("textarea"), { className: "sb-form-input", rows: 4,
        placeholder: "Paste a Homepage services.yaml, a browser bookmarks export (HTML), or lines like  Jellyfin | http://jellyfin.lan:8096" });
      const importBtn = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Import links" });
      importBtn.addEventListener("click", () => {
        const found = parseBookmarkImport(importBox.value);
        if (!found.length) { importBtn.textContent = "Nothing found"; setTimeout(() => (importBtn.textContent = "Import links"), 1500); return; }
        for (const fg of found) {
          const existing = groups.find((g) => g.name === fg.name);
          if (existing) existing.items.push(...fg.items); else groups.push(fg);
        }
        importBox.value = "";
        drawGroups();
      });
      const importWrap = document.createElement("details");
      importWrap.className = "wm-details";
      importWrap.append(Object.assign(document.createElement("summary"), { textContent: "Import links" }), importBox, importBtn);
      cfgWrap.append(makeSbRow("Layout", layoutSel), makeSbRow("Tapping a link on the display", openSel), editor, importWrap);
      getConfig = () => ({
        layout: layoutSel.value, open: openSel.value,
        groups: groups.map((g) => ({ name: (g.name || "").trim() || "Apps", items: (g.items || []).filter((i) => i.url) })),
      });

    } else if (t === "rest") {
      const urlInp = inp("https://api.example.com/v1/status  or  /relative/to/connection", cfg.url || "");
      const methodSel = sel([["GET", "GET"], ["POST", "POST"]], cfg.method || "GET");
      const bodyTa = Object.assign(document.createElement("textarea"), { className: "sb-form-input", rows: 3, value: cfg.body || "", placeholder: '{"query": "…"}' });
      const bodyRow = makeSbRow("Request body", bodyTa);
      const syncBody = () => { bodyRow.style.display = methodSel.value === "POST" ? "" : "none"; };
      methodSel.addEventListener("change", syncBody); syncBody();
      const modeSel = sel([["stats", "Numbers"], ["gauge", "Gauges"], ["list", "List only"]], cfg.display || "stats");
      const fields = structuredClone(cfg.fields || []);
      const fieldsEl = document.createElement("div");
      fieldsEl.className = "wm-rest-fields";
      const drawFields = () => {
        fieldsEl.innerHTML = "";
        fields.forEach((f, i) => {
          const row = document.createElement("div");
          row.className = "wm-rest-row";
          const label = inp("Label", f.label || ""), path = inp("data.value", f.path || "");
          const fmt = sel([["auto", "Auto"], ["number", "Number"], ["percent", "Percent"], ["bytes", "Bytes"], ["duration", "Duration (s)"], ["bool", "Yes / no"], ["text", "Text"]], f.format || "auto");
          const unit = inp("unit", f.unit || ""), max = inp("max", f.max ?? "", "number");
          max.title = "Gauge maximum (default 100)";
          const del = Object.assign(document.createElement("button"), { type: "button", className: "sw-remove", textContent: "✕" });
          label.addEventListener("input", () => (f.label = label.value)); path.addEventListener("input", () => (f.path = path.value.trim()));
          fmt.addEventListener("change", () => (f.format = fmt.value)); unit.addEventListener("input", () => (f.unit = unit.value));
          max.addEventListener("input", () => (f.max = max.value === "" ? null : Number(max.value)));
          del.addEventListener("click", () => { fields.splice(i, 1); drawFields(); });
          row.append(label, path, fmt, unit, max, del);
          fieldsEl.appendChild(row);
        });
        const add = Object.assign(document.createElement("button"), { type: "button", className: "sb-add-target", textContent: "+ Field" });
        add.addEventListener("click", () => { fields.push({ label: "", path: "", format: "auto" }); drawFields(); });
        fieldsEl.appendChild(add);
      };
      drawFields();
      const lst = cfg.list || {};
      const listPath = inp("items[*]", lst.path || ""), listLabel = inp("name", lst.label || ""), listValue = inp("status", lst.value || "");
      const listLimit = inp("10", lst.limit ?? 10, "number");
      const listRow = document.createElement("div");
      listRow.className = "wm-rest-row";
      listRow.append(listPath, listLabel, listValue, listLimit);

      // Try the request and click values in the response to add them as fields.
      const testBtn = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Test request" });
      const out = document.createElement("div");
      out.className = "wm-json";
      testBtn.addEventListener("click", async () => {
        testBtn.disabled = true; testBtn.textContent = "Requesting…"; out.innerHTML = "";
        try {
          const r = await fetch("/api/rest/preview", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: urlInp.value.trim(), method: methodSel.value, body: bodyTa.value, data_source_id: Number(cfgWrap.querySelector("[data-ds-select]")?.value) || null }) });
          const res = await r.json();
          if (res.error) out.textContent = res.error;
          else {
            out.appendChild(Object.assign(document.createElement("div"), { className: "wm-json-status", textContent: `HTTP ${res.status} · click a value to add it as a field` }));
            out.appendChild(jsonTree(res.body, "", (path, key) => { fields.push({ label: key, path, format: "auto" }); drawFields(); }));
          }
        } catch (e) { out.textContent = "Request failed."; }
        testBtn.disabled = false; testBtn.textContent = "Test request";
      });
      cfgWrap.append(makeSbRow("URL", urlInp), makeSbRow("Method", methodSel), bodyRow, testBtn, out,
        makeSbRow("Show as", modeSel),
        Object.assign(document.createElement("div"), { className: "sb-form-label", textContent: "Fields (label, JSON path, format, unit, gauge max)" }), fieldsEl,
        Object.assign(document.createElement("div"), { className: "sb-form-label", textContent: "List (optional): items path, label path, value path, limit" }), listRow);
      getConfig = () => ({
        ...cfg, url: urlInp.value.trim(), method: methodSel.value, body: bodyTa.value, display: modeSel.value,
        fields: fields.filter((f) => f.path || f.label),
        list: listPath.value.trim() ? { path: listPath.value.trim(), label: listLabel.value.trim(), value: listValue.value.trim(), limit: Number(listLimit.value) || 10 } : null,
      });

    } else if (t === "nowplaying") {
      const userChk = Object.assign(document.createElement("input"), { type: "checkbox", checked: cfg.show_user !== false });
      const devChk = Object.assign(document.createElement("input"), { type: "checkbox", checked: cfg.show_device !== false });
      const maxInp = inp("4", cfg.max_sessions ?? 4, "number");
      cfgWrap.append(makeSbRow("Show who's watching", userChk), makeSbRow("Show the device", devChk), makeSbRow("Most sessions shown", maxInp));
      getConfig = () => ({ ...cfg, show_user: userChk.checked, show_device: devChk.checked, max_sessions: Math.max(1, Number(maxInp.value) || 4) });

    } else if (t === "photos") {
      const srcSel = sel([["folder", "A folder on the TouchBoard server"], ["urls", "Image URLs"]], cfg.source || "folder");
      const folderInp = inp("/srv/photos/frame", cfg.folder || "");
      const urlsTa = Object.assign(document.createElement("textarea"), { className: "sb-form-input", rows: 4, value: (cfg.urls || []).join("\n"), placeholder: "One image URL per line" });
      const folderRow = makeSbRow("Folder (read recursively)", folderInp), urlsRow = makeSbRow("Image URLs", urlsTa);
      const syncSrc = () => { folderRow.style.display = srcSel.value === "folder" ? "" : "none"; urlsRow.style.display = srcSel.value === "urls" ? "" : "none"; };
      srcSel.addEventListener("change", syncSrc); syncSrc();
      const intervalInp = inp("20", cfg.interval ?? 20, "number");
      const fitSel = sel([["cover", "Fill the card (crop)"], ["contain", "Fit inside (no crop)"]], cfg.fit || "cover");
      const shuffle = Object.assign(document.createElement("input"), { type: "checkbox", checked: cfg.shuffle !== false });
      const kb = Object.assign(document.createElement("input"), { type: "checkbox", checked: cfg.kenburns !== false });
      const cap = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!cfg.caption });
      cfgWrap.append(makeSbRow("Source", srcSel), folderRow, urlsRow, makeSbRow("Seconds per photo", intervalInp), makeSbRow("Fit", fitSel),
        makeSbRow("Shuffle", shuffle), makeSbRow("Slow zoom (Ken Burns)", kb), makeSbRow("Show file name", cap));
      getConfig = () => ({ source: srcSel.value, folder: folderInp.value.trim(), urls: urlsTa.value.split("\n").map((s) => s.trim()).filter(Boolean),
        interval: Math.max(5, Number(intervalInp.value) || 20), fit: fitSel.value, shuffle: shuffle.checked, kenburns: kb.checked, caption: cap.checked });

    } else if (t === "rss") {
      const feedsTa = Object.assign(document.createElement("textarea"), { className: "sb-form-input", rows: 4, value: (cfg.feeds || []).join("\n"), placeholder: "One feed URL per line (RSS or Atom)" });
      const layoutSel = sel([["list", "Headline list"], ["spotlight", "One big headline at a time"]], cfg.layout || "list");
      const maxInp = inp("20", cfg.max_items ?? 20, "number");
      const rotInp = inp("12", cfg.rotate_sec ?? 12, "number");
      const srcChk = Object.assign(document.createElement("input"), { type: "checkbox", checked: cfg.show_source !== false });
      const imgChk = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!cfg.show_images });
      const openSel = sel([["qr", "Show a QR code"], ["new", "New tab"], ["same", "Same tab"]], cfg.open || "qr");
      cfgWrap.append(makeSbRow("Feeds", feedsTa), makeSbRow("Layout", layoutSel), makeSbRow("Most headlines", maxInp),
        makeSbRow("Spotlight: seconds per headline", rotInp), makeSbRow("Show the source", srcChk), makeSbRow("Show images", imgChk),
        makeSbRow("Tapping a headline on the display", openSel));
      getConfig = () => ({ feeds: feedsTa.value.split("\n").map((s) => s.trim()).filter(Boolean), layout: layoutSel.value,
        max_items: Math.max(1, Number(maxInp.value) || 20), rotate_sec: Math.max(5, Number(rotInp.value) || 12),
        show_source: srcChk.checked, show_images: imgChk.checked, open: openSel.value });

    } else if (t === "lights") {
      const chk = (on) => Object.assign(document.createElement("input"), { type: "checkbox", checked: on });
      const picked = new Set(cfg.entities || []);
      let order = [];
      const listEl = Object.assign(document.createElement("div"), { className: "lt-pick" });
      const groupChk = chk(cfg.group_by_area !== false);
      const swChk = chk(!!cfg.include_switches);
      const loginChk = chk(!!cfg.require_login);
      const say = (text) => { listEl.innerHTML = ""; listEl.appendChild(Object.assign(document.createElement("div"), { className: "lt-pick-msg", textContent: text })); };
      const load = async () => {
        const dsId = Number(cfgWrap.querySelector("[data-ds-select]")?.value);
        if (!dsId) { say("Pick a Home Assistant connection below, then choose lights here."); return; }
        say("Loading lights from Home Assistant…");
        let r;
        try { r = await (await fetch(`/api/datasources/${dsId}/ha-entities`)).json(); } catch (e) { r = { ok: false, error: e.message }; }
        if (!r.ok) { say(`Couldn't load lights: ${r.error || "unknown error"}`); return; }
        listEl.innerHTML = "";
        order = r.entities.map((x) => x.id);
        if (!r.entities.length) { say("Home Assistant has no lights or switches yet."); return; }
        let area = null;
        for (const it of r.entities) {
          const a = it.area || (it.domain === "switch" ? "Switches" : "No area");
          if (a !== area) { area = a; listEl.appendChild(Object.assign(document.createElement("div"), { className: "lt-pick-area", textContent: a })); }
          const row = document.createElement("label");
          row.className = "lt-pick-row";
          const box = chk(picked.has(it.id));
          box.addEventListener("change", () => { box.checked ? picked.add(it.id) : picked.delete(it.id); });
          const name = Object.assign(document.createElement("span"), { textContent: it.name + (it.group ? "  (room / group)" : "") });
          const meta = Object.assign(document.createElement("small"), { textContent: `${it.id}${it.available ? "" : " · unavailable"}` });
          row.append(box, name, meta);
          listEl.appendChild(row);
        }
      };
      cfgWrap.addEventListener("change", (e) => { if (e.target.matches?.("[data-ds-select]")) load(); });
      setTimeout(load, 0);
      const hint = Object.assign(document.createElement("div"), { className: "settings-ds-hint",
        textContent: "Tick the lights for this card. With none ticked, it shows every light (Hue rooms left out)." });
      cfgWrap.append(makeSbRow("Lights", listEl), hint, makeSbRow("Group by area", groupChk),
        makeSbRow("With none ticked, include switches", swChk), makeSbRow("Only signed-in users can switch them", loginChk));
      getConfig = () => ({ ...cfg,
        entities: [...order.filter((id) => picked.has(id)), ...[...picked].filter((id) => !order.includes(id))],
        group_by_area: groupChk.checked, include_switches: swChk.checked, require_login: loginChk.checked });
    }

    // Integration picker for types that need (or can use) a data source
    const intTypes = { netbox: ["netbox"], truenas: ["truenas"], proxmox: ["proxmox"], adguard: ["adguard"], opnsense: ["opnsense"], calendar: ["google_calendar"], nowplaying: ["plex", "jellyfin"], rest: ["rest"], lights: ["homeassistant"] };
    if (intTypes[t]) {
      const intHead = Object.assign(document.createElement("div"), {
        className: "sb-form-label", textContent: "Integration",
      });
      intHead.style.marginTop = "12px";
      cfgWrap.appendChild(intHead);

      const dsSel = document.createElement("select");
      dsSel.className = "sb-form-input";

      function populateDsSel(sources) {
        const prev = dsSel.value;
        while (dsSel.options.length) dsSel.remove(0);
        const noneOpt = document.createElement("option");
        noneOpt.value = ""; noneOpt.textContent = "— none —";
        dsSel.appendChild(noneOpt);
        for (const ds of sources.filter(ds => intTypes[t].includes(ds.type))) {
          const o = document.createElement("option");
          o.value = ds.id; o.textContent = ds.name;
          dsSel.appendChild(o);
        }
        dsSel.value = prev || (w?.data_source_id ? String(w.data_source_id) : "");
      }

      dsSel.dataset.dsSelect = "1";
      populateDsSel(allDataSources);
      cfgWrap.appendChild(makeSbRow(t === "rest" ? "Connection (optional: base URL + secret headers)" : "Data source", dsSel));

      // Inline integration credential editing
      const inlineCredsWrap = document.createElement("div");
      inlineCredsWrap.className = "inline-creds-wrap";

      function renderInlineCreds(existingCreds = null) {
        inlineCredsWrap.innerHTML = "";
        const dsId = Number(dsSel.value);
        if (!dsId) return;
        const ds = allDataSources.find(d => d.id === dsId);
        if (!ds) return;
        const imeta = INTEGRATION_META[ds.type] || { fields: [], hint: "" };
        if (!imeta.fields.length) return;

        const head = Object.assign(document.createElement("div"), { className: "sb-form-label", textContent: "Edit integration" });
        head.style.marginTop = "10px";
        inlineCredsWrap.appendChild(head);
        if (imeta.hint) {
          const hint = Object.assign(document.createElement("div"), { className: "settings-ds-hint", textContent: imeta.hint });
          inlineCredsWrap.appendChild(hint);
        }

        function buildFields(creds) {
          const existingFieldsWrap = inlineCredsWrap.querySelector(".inline-creds-fields");
          if (existingFieldsWrap) existingFieldsWrap.remove();
          const fieldsWrap = document.createElement("div");
          fieldsWrap.className = "inline-creds-fields";
          for (const f of imeta.fields) fieldsWrap.appendChild(makeSbRow(f.label, makeCredField(f, creds[f.key] ?? "")));
          inlineCredsWrap.insertBefore(fieldsWrap, inlineCredsWrap.querySelector(".small.primary") || null);
        }

        const saveCredsBtn = Object.assign(document.createElement("button"), {
          type: "button", className: "small primary", textContent: "Save integration",
        });
        saveCredsBtn.style.marginTop = "6px";
        saveCredsBtn.addEventListener("click", async () => {
          const credentials = readCredFields(inlineCredsWrap);
          if (!Object.keys(credentials).length) return;
          saveCredsBtn.disabled = true; saveCredsBtn.textContent = "Saving…";
          try {
            await api.updateDataSource(dsId, { credentials });
            saveCredsBtn.textContent = "Saved ✓";
            setTimeout(() => { saveCredsBtn.disabled = false; saveCredsBtn.textContent = "Save integration"; }, 2000);
          } catch (e) {
            saveCredsBtn.disabled = false; saveCredsBtn.textContent = "Save integration";
          }
        });
        inlineCredsWrap.appendChild(saveCredsBtn);

        if (existingCreds !== null) {
          buildFields(existingCreds);
        } else {
          buildFields({});
          api.getDataSourceCredentials(dsId).then(creds => {
            const anyFilled = [...inlineCredsWrap.querySelectorAll("input, textarea")].some(el => el.value.trim());
            if (!anyFilled) buildFields(creds);
          }).catch(() => {});
        }
      }

      dsSel.addEventListener("change", renderInlineCreds);
      renderInlineCreds();
      cfgWrap.appendChild(inlineCredsWrap);

      // Refresh async to pick up data sources added/deleted since the modal opened
      api.listDataSources().then(fresh => {
        allDataSources = fresh;
        const prevId = dsSel.value;
        populateDsSel(fresh);
        // Only re-render creds if the selected DS changed (e.g. deleted)
        if (dsSel.value !== prevId) renderInlineCreds();
      }).catch(() => {});

      const origGetConfig = getConfig;
      getConfig = () => ({ ...origGetConfig(), _dsId: Number(dsSel.value) || null });
    }
  }

  buildConfigFields(type);
  if (!w) typeSel.addEventListener("change", () => { type = typeSel.value; buildConfigFields(type); updateRefreshVisibility(); });

  const refreshInput = Object.assign(document.createElement("input"), {
    className: "sb-form-input", type: "number", min: "2",
    placeholder: "15", value: w?.refresh_interval_sec ?? 15,
  });
  const refreshRow = makeSbRow("Refresh (sec)", refreshInput);
  body.appendChild(refreshRow);
  function updateRefreshVisibility() { refreshRow.style.display = type === "clock" || type === "notes" ? "none" : ""; }
  updateRefreshVisibility();
  dlg.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "modal-footer";

  if (w) {
    const delBtn = Object.assign(document.createElement("button"),
      { type: "button", className: "small danger", textContent: "Delete widget" });
    delBtn.style.marginRight = "auto";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete widget "${w.title}"?`)) return;
      await deleteWidgetAndScrub(w);
      dlg.close();
    });
    footer.appendChild(delBtn);
  }

  const cancelBtn = Object.assign(document.createElement("button"),
    { type: "button", className: "small", textContent: "Cancel" });
  cancelBtn.addEventListener("click", () => dlg.close());

  const saveBtn = Object.assign(document.createElement("button"),
    { type: "button", className: "small primary", textContent: w ? "Save" : "Create" });
  saveBtn.addEventListener("click", async () => {
    const finalType  = w ? w.type : type;
    const title      = nameInput.value.trim() || "Untitled";
    const refresh    = finalType === "clock" ? 0 : finalType === "notes" ? 300 : Math.max(2, Number(refreshInput.value) || 15);
    const configData = getConfig();
    const dsId       = configData._dsId !== undefined ? configData._dsId : (w?.data_source_id ?? null);
    delete configData._dsId;
    saveBtn.disabled = true; saveBtn.textContent = w ? "Saving…" : "Creating…";
    try {
      if (w) {
        const updated = await api.updateWidget(w.id, { title, config: configData, refresh_interval_sec: refresh, data_source_id: dsId });
        const idx = widgets.findIndex(x => x.id === w.id);
        if (idx >= 0) widgets[idx] = updated;
        Object.assign(w, updated);
        reindex();
        renderWidgets(); refreshGridCards();
        inspector?.render(true);
        dlg.close();
      } else {
        const created = await api.createWidget({ type: finalType, title, config: configData, refresh_interval_sec: refresh, data_source_id: dsId });
        widgets.push(created);
        reindex();
        renderWidgets();
        dlg.close();
        if (opts.onCreated) opts.onCreated(created);
        else toast(`Created ${created.title}. Drag it onto the board, or tap ＋ on it.`);
      }
    } catch {
      saveBtn.disabled = false; saveBtn.textContent = w ? "Save" : "Create";
    }
  });

  footer.append(cancelBtn, saveBtn);
  dlg.appendChild(footer);
  dlg.showModal();
  nameInput.focus();
}

// ── import helpers for the bookmarks and REST forms ──────────────────────────

// Homepage services.yaml, a Netscape bookmarks HTML export, or "Label | URL" lines.
function parseBookmarkImport(text) {
  const src = (text || "").trim();
  if (!src) return [];
  // Browser bookmarks export (HTML)
  if (/<a\s[^>]*href=/i.test(src)) {
    const doc = new DOMParser().parseFromString(src, "text/html");
    const items = [...doc.querySelectorAll("a[href]")]
      .filter((a) => /^https?:/i.test(a.getAttribute("href")))
      .map((a) => ({ label: a.textContent.trim() || a.href, url: a.getAttribute("href"), icon: "auto", check: false }));
    return items.length ? [{ name: "Imported", items }] : [];
  }
  // Homepage services.yaml
  if (/^\s*-\s*[^:]+:\s*$/m.test(src) && /href:/i.test(src)) {
    const groups = [];
    let group = null, item = null;
    for (const raw of src.split(/\r?\n/)) {
      if (!raw.trim() || raw.trim().startsWith("#")) continue;
      const indent = raw.length - raw.trimStart().length;
      const m = raw.trim().match(/^-\s*(.+?):\s*$/);
      if (m && indent === 0) { group = { name: m[1].replace(/^["']|["']$/g, ""), items: [] }; groups.push(group); item = null; continue; }
      if (m && group) { item = { label: m[1].replace(/^["']|["']$/g, ""), url: "", icon: "auto", check: false }; group.items.push(item); continue; }
      const kv = raw.trim().match(/^(href|icon):\s*(.+)$/i);
      if (kv && item) {
        const v = kv[2].trim().replace(/^["']|["']$/g, "");
        if (kv[1].toLowerCase() === "href") item.url = v;
        else item.icon = /^https?:/.test(v) ? v : v.startsWith("si-") ? `si:${v.slice(3)}` : `di:${v.replace(/\.(png|svg|webp)$/i, "")}`;
      }
    }
    return groups.map((g) => ({ ...g, items: g.items.filter((i) => i.url) })).filter((g) => g.items.length);
  }
  // Plain lines
  const items = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [a, b] = l.split("|").map((s) => s.trim());
    const url = b || a;
    if (!/^https?:\/\//i.test(url)) return null;
    return { label: b ? a : url.replace(/^https?:\/\//, "").split("/")[0], url, icon: "auto", check: false };
  }).filter(Boolean);
  return items.length ? [{ name: "Imported", items }] : [];
}

// Clickable JSON tree for the REST widget's "Test request".
function jsonTree(value, path, onPick, depth = 0) {
  const wrap = document.createElement("div");
  wrap.className = "wm-json-node";
  const child = (k, v) => {
    const p = typeof k === "number" ? `${path}[${k}]` : (/^[A-Za-z_$][\w$]*$/.test(k) ? (path ? `${path}.${k}` : k) : `${path}['${k}']`);
    const row = document.createElement("div");
    row.className = "wm-json-row";
    const keyEl = Object.assign(document.createElement("span"), { className: "wm-json-key", textContent: typeof k === "number" ? `[${k}]` : k });
    row.appendChild(keyEl);
    if (v && typeof v === "object") {
      const det = document.createElement("details");
      if (depth < 1) det.open = true;
      const sum = Object.assign(document.createElement("summary"), { textContent: Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}` });
      det.appendChild(sum);
      det.addEventListener("toggle", () => {
        if (det.open && det.childElementCount === 1) det.appendChild(jsonTree(v, p, onPick, depth + 1));
      }, { once: false });
      if (det.open) det.appendChild(jsonTree(v, p, onPick, depth + 1));
      row.appendChild(det);
    } else {
      const val = Object.assign(document.createElement("button"), { type: "button", className: "wm-json-val", textContent: JSON.stringify(v), title: `Add ${p}` });
      val.addEventListener("click", () => onPick(p, typeof k === "number" ? `${path.split(".").pop()} ${k}` : k));
      row.appendChild(val);
    }
    wrap.appendChild(row);
  };
  if (Array.isArray(value)) value.slice(0, 50).forEach((v, i) => child(i, v));
  else if (value && typeof value === "object") Object.entries(value).slice(0, 80).forEach(([k, v]) => child(k, v));
  else {
    const val = Object.assign(document.createElement("button"), { type: "button", className: "wm-json-val", textContent: JSON.stringify(value) });
    val.addEventListener("click", () => onPick(path || "$", "value"));
    wrap.appendChild(val);
  }
  return wrap;
}

// ── category wizard (utilities, media) ──────────────────────────────────────

function openCategoryWizard(label = "Utilities") {
  const cat = WIDGET_CATEGORIES.find((c) => c.label === label) || WIDGET_CATEGORIES[0];
  const dlg = byId("widget-modal");
  dlg.innerHTML = "";
  const head = document.createElement("div");
  head.className = "modal-head";
  const closeBtn = Object.assign(document.createElement("button"), { className: "modal-close-btn", textContent: "✕" });
  closeBtn.addEventListener("click", () => dlg.close());
  head.append(Object.assign(document.createElement("h2"), { textContent: `Add ${label === "Media" ? "a media" : "a utility"} widget` }), closeBtn);
  const body = document.createElement("div");
  body.className = "modal-body";
  body.appendChild(Object.assign(document.createElement("p"), { className: "wizard-step-hint", textContent: "Pick the widget you want to add:" }));
  const gridEl = document.createElement("div");
  gridEl.className = "wizard-type-grid";
  const tile = (icon, text, color, onClick) => {
    const b = document.createElement("button");
    b.className = "wizard-type-tile"; b.type = "button";
    b.style.setProperty("--tile-color", color);
    b.innerHTML = `<span class="wzt-icon"></span><span class="wzt-label"></span>`;
    b.querySelector(".wzt-icon").textContent = icon;
    b.querySelector(".wzt-label").textContent = text;
    b.addEventListener("click", onClick);
    gridEl.appendChild(b);
  };
  for (const t of cat.types) {
    const wt = WIDGET_TYPES.find((x) => x.type === t);
    if (t === "nowplaying") {
      tile("🎬", "Plex", INTEGRATION_META.plex.color, () => openIntegrationWizard("plex", { backTo: () => openCategoryWizard(label) }));
      tile("🎬", "Jellyfin", INTEGRATION_META.jellyfin.color, () => openIntegrationWizard("jellyfin", { backTo: () => openCategoryWizard(label) }));
      continue;
    }
    tile(wt?.icon || "⚙️", wt?.label || t, typeColor(t), () => openWidgetModal(null, { defaultType: t, typeFilter: [t], backTo: () => openCategoryWizard(label) }));
  }
  body.appendChild(gridEl);
  dlg.append(head, body);
  dlg.showModal();
}
const openUtilityWizard = () => openCategoryWizard("Utilities");


// ── integration wizard ────────────────────────────────────────────────────────

async function openIntegrationWizard(preType = null, wopts = {}) {
  const dlg = byId("widget-modal");
  dlg.innerHTML = "";

  const head = document.createElement("div");
  head.className = "modal-head";
  const titleEl = Object.assign(document.createElement("h2"), { textContent: "Add Integration Widget" });
  const closeBtn = Object.assign(document.createElement("button"), { className: "modal-close-btn", textContent: "✕" });
  closeBtn.addEventListener("click", () => dlg.close());
  head.append(titleEl, closeBtn);

  const body = document.createElement("div");
  body.className = "modal-body";

  const footer = document.createElement("div");
  footer.className = "modal-footer";

  dlg.append(head, body, footer);
  dlg.showModal();
  _makeDraggable(dlg, head);

  // Load sources in background; type grid doesn't need them — Step 2 does
  let sources = [];
  const sourcesReady = api.listDataSources().then(r => { sources = r; }).catch(() => {});

  function showStep1() {
    body.innerHTML = "";
    footer.innerHTML = "";
    titleEl.textContent = "Add Integration Widget";

    const hint = Object.assign(document.createElement("p"), {
      className: "wizard-step-hint",
      textContent: "Pick the service you want to connect:",
    });
    body.appendChild(hint);

    const grid = document.createElement("div");
    grid.className = "wizard-type-grid";
    for (const [key, meta] of Object.entries(INTEGRATION_META)) {
      if (wopts.only && !wopts.only.includes(key)) continue;
      if (!wopts.only && meta.optional) continue;
      const wt = WIDGET_TYPES.find(w => w.type === (meta.widgetType || key));
      const tile = document.createElement("button");
      tile.className = "wizard-type-tile";
      tile.type = "button";
      tile.style.setProperty("--tile-color", meta.color);
      tile.innerHTML = `<span class="wzt-icon">${wt?.icon || "⚙️"}</span><span class="wzt-label">${meta.label}</span>`;
      tile.addEventListener("click", () => showStep2(key));
      grid.appendChild(tile);
    }
    body.appendChild(grid);
  }

  async function showStep2(type) {
    await sourcesReady;
    body.innerHTML = "";
    footer.innerHTML = "";
    const meta = INTEGRATION_META[type];
    const wt   = WIDGET_TYPES.find(w => w.type === (meta.widgetType || type));
    titleEl.textContent = `${wt?.icon || ""} ${meta.label}`;

    if (!preType || wopts.backTo) {
      const backBtn = Object.assign(document.createElement("button"), {
        type: "button", className: "small wizard-back-btn", textContent: "← Back",
      });
      backBtn.addEventListener("click", () => (wopts.backTo ? wopts.backTo() : showStep1()));
      body.appendChild(backBtn);
    }

    const nameInput = Object.assign(document.createElement("input"), {
      className: "sb-form-input", placeholder: "Widget name", value: meta.label,
    });
    body.appendChild(makeSbRow("Widget name", nameInput));

    const compatible = sources.filter(ds => ds.type === type);
    let useExistingId = compatible.length ? compatible[0].id : null;
    let addNew = compatible.length === 0;

    const dsSection = document.createElement("div");
    body.appendChild(dsSection);

    const errEl = Object.assign(document.createElement("div"), { className: "settings-form-error hidden" });
    body.appendChild(errEl);

    function renderDsSection() {
      dsSection.innerHTML = "";

      if (compatible.length > 0) {
        const connLbl = Object.assign(document.createElement("div"), {
          className: "sb-form-label", textContent: "Connection",
        });
        connLbl.style.marginTop = "12px";
        dsSection.appendChild(connLbl);

        const radioWrap = document.createElement("div");
        radioWrap.className = "wizard-ds-options";

        for (const ds of compatible) {
          const lbl = document.createElement("label");
          lbl.className = "wizard-radio-lbl";
          const radio = Object.assign(document.createElement("input"), { type: "radio", name: "ds-choice" });
          radio.value = String(ds.id);
          radio.checked = !addNew && ds.id === useExistingId;
          radio.addEventListener("change", () => { useExistingId = ds.id; addNew = false; renderDsSection(); });
          lbl.append(radio, ` ${ds.name}`);
          radioWrap.appendChild(lbl);
        }

        const newLbl = document.createElement("label");
        newLbl.className = "wizard-radio-lbl";
        const newRadio = Object.assign(document.createElement("input"), { type: "radio", name: "ds-choice" });
        newRadio.value = "__new__";
        newRadio.checked = addNew;
        newRadio.addEventListener("change", () => { useExistingId = null; addNew = true; renderDsSection(); });
        newLbl.append(newRadio, " Add new connection");
        radioWrap.appendChild(newLbl);
        dsSection.appendChild(radioWrap);
      }

      if (addNew) {
        let urlInput = null;
        if (!meta.noBaseUrl) {
          urlInput = Object.assign(document.createElement("input"), {
            className: "sb-form-input", placeholder: "https://…", type: "url",
          });
          dsSection.appendChild(makeSbRow("Base URL", urlInput));
        }

        for (const f of meta.fields) {
          const inp = makeCredField(f);
          dsSection.appendChild(makeSbRow(f.label, inp));
        }

        const guide = INTEGRATION_GUIDES[type];
        if (guide) {
          const gWrap = document.createElement("div");
          gWrap.className = "intg-guide-wrap";
          const gArrow = Object.assign(document.createElement("span"), { className: "igt-arrow", textContent: "▶" });
          const gToggle = Object.assign(document.createElement("button"), { type: "button", className: "intg-guide-toggle" });
          gToggle.append(gArrow, " Setup Guide");
          const gContent = document.createElement("div");
          gContent.className = "intg-guide-content hidden";
          gToggle.addEventListener("click", () => {
            const open = gContent.classList.toggle("hidden") === false;
            gArrow.style.transform = open ? "rotate(90deg)" : "";
            if (open) {
              gContent.innerHTML = "";
              const ol = Object.assign(document.createElement("ol"), { className: "igt-steps" });
              guide.steps.forEach(s => { const li = document.createElement("li"); li.innerHTML = s; ol.appendChild(li); });
              gContent.appendChild(ol);
            }
          });
          gWrap.append(gToggle, gContent);
          dsSection.appendChild(gWrap);
        }

        dsSection._getUrl   = () => urlInput ? urlInput.value.trim() : "";
        dsSection._getCreds = () => readCredFields(dsSection);
      }
    }

    renderDsSection();

    const cancelBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "small", textContent: "Cancel",
    });
    cancelBtn.addEventListener("click", () => dlg.close());

    const saveBtn = Object.assign(document.createElement("button"), {
      type: "button", className: "small primary", textContent: "Create Widget",
    });

    saveBtn.addEventListener("click", async () => {
      const title = nameInput.value.trim() || meta.label;
      let dsId = null;
      errEl.classList.add("hidden");

      if (addNew) {
        const url = dsSection._getUrl?.();
        if (!meta.noBaseUrl && !url) { errEl.textContent = "Base URL is required."; errEl.classList.remove("hidden"); return; }
        saveBtn.disabled = true; saveBtn.textContent = "Saving connection…";
        try {
          const ds = await api.createDataSource({ type, name: title, base_url: url || "https://calendar.google.com", credentials: dsSection._getCreds?.() || {} });
          sources.push(ds);
          dsId = ds.id;
        } catch (e) {
          errEl.textContent = e.message || "Failed to save connection.";
          errEl.classList.remove("hidden");
          saveBtn.disabled = false; saveBtn.textContent = "Create Widget";
          return;
        }
      } else {
        dsId = useExistingId;
      }

      if (!dsId) return;

      saveBtn.textContent = "Creating widget…";
      try {
        const created = await api.createWidget({ type: meta.widgetType || type, title, config: {}, refresh_interval_sec: meta.refresh || 15, data_source_id: dsId });
        widgets.push(created);
        reindex();
        dlg.close();
        renderWidgets();
        if (meta.configureAfter) openWidgetModal(created, { onCreated: wopts.onCreated });
        else if (wopts.onCreated) wopts.onCreated(created);
        else toast(`Created ${created.title}. Drag it onto the board, or tap ＋ on it.`);
      } catch (e) {
        errEl.textContent = e.message || "Failed to create widget.";
        errEl.classList.remove("hidden");
        saveBtn.disabled = false; saveBtn.textContent = "Create Widget";
      }
    });

    footer.append(cancelBtn, saveBtn);
  }

  if (preType) showStep2(preType);
  else showStep1();
}

// ── stack modal ───────────────────────────────────────────────────────────────

function openStackModal(stack) {
  const dlg = byId("stack-modal");
  dlg.innerHTML = "";

  // ── Header ────────────────────────────────────────────────────────────────
  const head = document.createElement("div");
  head.className = "modal-head";
  const titleEl = document.createElement("h2");
  titleEl.textContent = "Edit Stack";
  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-close-btn"; closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => dlg.close());
  head.append(titleEl, closeBtn);
  dlg.appendChild(head);

  // ── Body ──────────────────────────────────────────────────────────────────
  const body = document.createElement("div");
  body.className = "modal-body";

  // Name
  const nameInput = document.createElement("input");
  nameInput.className = "sb-form-input"; nameInput.placeholder = "Stack name";
  nameInput.value = stack.name;
  nameInput.addEventListener("change", async () => {
    stack.name = nameInput.value.trim() || stack.name;
    nameInput.value = stack.name;
    await api.updateStack(stack.id, { name: stack.name });
    refreshPlacedCard(stack);
    refreshGridCards();
  });
  body.appendChild(makeSbRow("Name", nameInput));

  // Widget chips
  const chipsLbl = document.createElement("div");
  chipsLbl.className = "sb-form-label"; chipsLbl.textContent = "Widgets in stack";
  body.appendChild(chipsLbl);

  const chips = document.createElement("div");
  chips.className = "ep-chips";
  body.appendChild(chips);

  // Add-widget row
  const addRow = document.createElement("div");
  addRow.className = "ep-add-row";
  const sel = document.createElement("select");
  sel.className = "sb-form-input";
  const addBtn = Object.assign(document.createElement("button"),
    { type: "button", className: "small", textContent: "Add" });
  addRow.append(sel, addBtn);
  body.appendChild(addRow);

  function currentIds() { return stack.widget_ids; }

  let dragSrcIdx = null;

  function refreshChips() {
    chips.innerHTML = "";
    const ids = currentIds();
    if (!ids.length) {
      chips.appendChild(Object.assign(document.createElement("span"), {
        className: "empty-state small", textContent: "No widgets yet",
      }));
      return;
    }
    ids.forEach((wid, idx) => {
      const w = widgetsById[wid]; if (!w) return;
      const row = document.createElement("div");
      row.className = "stack-widget-row"; row.draggable = true; row.dataset.idx = idx;

      const grip = Object.assign(document.createElement("span"), { className: "sw-grip", textContent: "⠿" });
      const badge = Object.assign(document.createElement("span"), { className: "chip-type", textContent: w.type });
      badge.style.borderColor = badge.style.color = typeColor(w.type);
      const lbl = Object.assign(document.createElement("span"), { className: "sw-label", textContent: w.title });

      const editBtn = Object.assign(document.createElement("button"), { type: "button", className: "sw-arrow", textContent: "✎", title: "Edit widget" });
      editBtn.addEventListener("click", () => {
        dlg.close();
        openWidgetModal(w);
        byId("widget-modal").addEventListener("close", () => openStackModal(stack), { once: true });
      });

      const upBtn = Object.assign(document.createElement("button"), { type: "button", className: "sw-arrow", textContent: "↑" });
      upBtn.disabled = idx === 0;
      upBtn.addEventListener("click", async () => {
        const arr = currentIds(); [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
        await applyOrder(arr);
      });

      const dnBtn = Object.assign(document.createElement("button"), { type: "button", className: "sw-arrow", textContent: "↓" });
      dnBtn.disabled = idx === ids.length - 1;
      dnBtn.addEventListener("click", async () => {
        const arr = currentIds(); [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
        await applyOrder(arr);
      });

      const x = Object.assign(document.createElement("button"), { type: "button", className: "sw-remove", textContent: "✕" });
      x.addEventListener("click", async () => {
        const arr = currentIds().filter((id) => id !== wid);
        await applyOrder(arr);
      });

      row.append(grip, badge, lbl, editBtn, upBtn, dnBtn, x);

      // drag-to-reorder
      row.addEventListener("dragstart", (e) => { dragSrcIdx = idx; row.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
      row.addEventListener("dragend",   () => { dragSrcIdx = null; chips.querySelectorAll(".stack-widget-row").forEach((r) => r.classList.remove("dragging", "drag-over")); });
      row.addEventListener("dragover",  (e) => { e.preventDefault(); row.classList.add("drag-over"); });
      row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
      row.addEventListener("drop",      async (e) => {
        e.preventDefault(); row.classList.remove("drag-over");
        if (dragSrcIdx === null || dragSrcIdx === idx) return;
        const arr = [...currentIds()];
        const [moved] = arr.splice(dragSrcIdx, 1);
        arr.splice(idx, 0, moved);
        await applyOrder(arr);
      });

      chips.appendChild(row);
    });
  }

  async function applyOrder(newIds) {
    stack.widget_ids = newIds;
    await api.updateStack(stack.id, { widget_ids: stack.widget_ids });
    refreshPlacedCard(stack);
    refreshChips(); refreshSel();
    saveLayoutSoon();
  }

  function refreshSel() {
    sel.innerHTML = '<option value="">add widget…</option>';
    const ids = currentIds();
    for (const w of widgets) {
      if (ids.includes(w.id)) continue;
      if (MULTIPAGE_TYPES.has(w.type)) continue;
      if (!widgetsById[w.id]) continue;
      const opt = document.createElement("option");
      opt.value = w.id; opt.textContent = `${w.title} (${w.type})`;
      sel.appendChild(opt);
    }
    addRow.style.display = sel.options.length <= 1 ? "none" : "";
  }

  addBtn.addEventListener("click", async () => {
    const wid = Number(sel.value); if (!wid) return;
    await applyOrder([...currentIds(), wid]);
  });

  refreshChips(); refreshSel();
  dlg.appendChild(body);

  // ── Footer ────────────────────────────────────────────────────────────────
  const footer = document.createElement("div");
  footer.className = "modal-footer";

  const delBtn = Object.assign(document.createElement("button"),
    { type: "button", className: "small danger", textContent: "Remove from layout" });
  delBtn.style.marginRight = "auto";
  delBtn.addEventListener("click", async () => {
    if (!confirm(`Remove "${stack.name}" from the layout?`)) return;
    if (placedIds.has(stack.id)) {
      const el = [...grid.getGridItems()].find((e) => Number(e.dataset.stackId) === stack.id);
      if (el) grid.removeWidget(el);
      placedIds.delete(stack.id);
    }
    await api.deleteStack(stack.id).catch(() => {});
    phantomStackIds.delete(stack.id);
    stacks = stacks.filter((s) => s.id !== stack.id);
    for (const wId of stack.widget_ids) {
      const wEl = document.querySelector(`.sb-widget-item[data-widget-id="${wId}"]`);
      if (wEl) { wEl.classList.add("returning"); wEl.addEventListener("animationend", () => wEl.classList.remove("returning"), { once: true }); }
    }
    dlg.close();
    syncPaletteStates(); saveLayoutSoon();
  });
  footer.appendChild(delBtn);

  const doneBtn = Object.assign(document.createElement("button"),
    { type: "button", className: "small primary", textContent: "Done" });
  doneBtn.addEventListener("click", () => dlg.close());
  footer.appendChild(doneBtn);

  dlg.appendChild(footer);
  dlg.showModal();
  nameInput.focus();
  nameInput.select();
}

function syncPaletteStates() {
  const hint = byId("grid-empty-hint");
  if (hint) hint.style.display = placedIds.size === 0 ? "flex" : "none";
}

// Deletes a widget, scrubs it out of every stack that references it, and — if
// that leaves a stack with no widgets left — removes that now-empty card from
// the board grid and deletes the stack too, rather than leaving a dangling
// "No widgets" card behind.
async function deleteWidgetAndScrub(w) {
  await api.deleteWidget(w.id);
  const emptied = [];
  for (const s of stacks) {
    if (s.widget_ids.includes(w.id)) {
      s.widget_ids = s.widget_ids.filter((id) => id !== w.id);
      await api.updateStack(s.id, { widget_ids: s.widget_ids });
      if (s.widget_ids.length === 0) emptied.push(s);
    }
  }
  widgets = widgets.filter((x) => x.id !== w.id);
  reindex();
  for (const s of emptied) {
    const item = grid && [...grid.getGridItems()].find((el) => Number(el.dataset.stackId) === s.id);
    if (item) grid.removeWidget(item);
    placedIds.delete(s.id);
    phantomStackIds.delete(s.id);
    stacks = stacks.filter((x) => x.id !== s.id);
    await api.deleteStack(s.id).catch(() => {});
  }
  if (emptied.length) { syncPaletteStates(); saveLayoutSoon(); }
  renderWidgets();
  refreshGridCards();
  inspector?.render(true);
}

// Refresh all placed grid cards (e.g. after a widget is renamed/deleted)
function refreshGridCards() {
  if (!grid) return;
  for (const el of grid.getGridItems()) {
    const stackId = Number(el.dataset.stackId);
    const stack   = stacks.find((s) => s.id === stackId);
    if (!stack) continue;
    // Update name in drag handle without replacing the whole content (preserves GridStack drag binding)
    const nameEl = el.querySelector(".layout-drag-name");
    if (nameEl) nameEl.textContent = stack.name;
    refreshWidgetArea(el, stack);
  }
}

// ── placed grid items ─────────────────────────────────────────────────────────

function showIntegrationToast() { toast("Multi-page widgets can't be stacked"); }
function showPageFullToast() { toast("No room on this page"); }

function stackWidgets(stack) {
  return stack.widget_ids.map((id) => widgetsById[id]).filter(Boolean);
}
function currentWidgetOf(stack) {
  const ws = stackWidgets(stack);
  if (!ws.length) return null;
  const i = Math.min(cardWidgetIdx[stack.id] || 0, ws.length - 1);
  return ws[i];
}
function hasMultipage(stack) {
  return stack.widget_ids.some((id) => MULTIPAGE_TYPES.has(widgetsById[id]?.type));
}
function gridItemFor(stackId) {
  return grid ? grid.getGridItems().find((el) => Number(el.dataset.stackId) === stackId) : null;
}

function buildPlacedContent(stack) {
  const content = document.createElement("div");
  content.className = "grid-stack-item-content";

  const card = document.createElement("div");
  card.className = "layout-stack-card" + (stack.widget_ids.length > 1 ? " is-multi" : "");
  if (hasMultipage(stack)) card.dataset.integration = "1";

  // Name label (overlay, so the card's content lines up with the display)
  const dragHandle = document.createElement("div");
  dragHandle.className = "layout-drag-handle";
  dragHandle.append(
    Object.assign(document.createElement("span"), { className: "layout-drag-grip", textContent: "⠿" }),
    Object.assign(document.createElement("span"), { className: "layout-drag-name", textContent: stack.name }),
  );
  card.appendChild(dragHandle);

  const widgetArea = document.createElement("div");
  widgetArea.className = "layout-widget-area";
  // Widgets are previews here: block their own taps (links, toggles) except view dots.
  widgetArea.addEventListener("click", (e) => {
    if (!e.target.closest(".lc-pag-dot") && !e.target.closest(".widget-ctrl") && !e.target.closest(".tb-ctrl")) e.stopPropagation();
  }, true);

  const pagBar = document.createElement("div");
  pagBar.className = "lc-pag-bar";

  function renderPage() {
    const ws = stackWidgets(stack);
    widgetArea.innerHTML = "";
    if (!ws.length) {
      widgetArea.appendChild(Object.assign(document.createElement("div"), { className: "placed-empty", textContent: "No widgets" }));
      pagBar.innerHTML = ""; return;
    }
    const idx = Math.min(cardWidgetIdx[stack.id] || 0, ws.length - 1);
    cardWidgetIdx[stack.id] = idx;
    widgetArea.appendChild(renderWidget(ws[idx], liveData[ws[idx].id] || null, { editable: true }));
    pagBar.innerHTML = "";
    if (ws.length <= 1) return;
    const dots = document.createElement("div");
    dots.className = "lc-pag-dots";
    ws.forEach((w, i) => {
      const lv = liveData[w.id]?.alert?.level;
      const d = Object.assign(document.createElement("span"), { className: "lc-pag-dot" + (i === idx ? " active" : "") + (lv ? ` alert-${lv}` : "") });
      d.title = w.title;
      d.addEventListener("click", (e) => { e.stopPropagation(); cardWidgetIdx[stack.id] = i; renderPage(); if (selectedStackId === stack.id) inspector?.render(true); });
      dots.appendChild(d);
    });
    pagBar.append(dots);
  }

  renderPage();
  card._renderPage = renderPage;
  card._navigatePage = (dir) => {
    const ws = stackWidgets(stack);
    const next = Math.max(0, Math.min(ws.length - 1, (cardWidgetIdx[stack.id] || 0) + dir));
    if (next !== (cardWidgetIdx[stack.id] || 0)) { cardWidgetIdx[stack.id] = next; renderPage(); if (selectedStackId === stack.id) inspector?.render(true); }
  };
  card.append(widgetArea, pagBar);

  // Card buttons (used when the inspector panel is turned off)
  const actions = document.createElement("div");
  actions.className = "layout-card-actions";
  const editBtn = Object.assign(document.createElement("button"), { className: "layout-card-btn", title: "Edit / Appearance", textContent: "✎" });
  editBtn.dataset.tip = "Edit widget appearance and stack settings";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const w = currentWidgetOf(stack);
    openWidgetAppearancePopover(editBtn, w, liveData[w?.id]?.data, () => openStackModal(stack));
  });
  const removeBtn = Object.assign(document.createElement("button"), { className: "layout-card-btn remove", title: "Remove from layout", textContent: "↙" });
  removeBtn.dataset.tip = "Remove from board";
  removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removeCard(stack.id); });
  for (const b of [editBtn, removeBtn]) b.addEventListener("pointerdown", (e) => e.stopPropagation());
  actions.append(editBtn, removeBtn);
  card.appendChild(actions);

  card.addEventListener("pointerdown", (e) => {
    if (e.button && e.button !== 0) return;
    selectStack(stack.id);
  });
  card.addEventListener("dblclick", (e) => {
    if (e.target.closest(".lc-pag-dot")) return;
    const w = currentWidgetOf(stack);
    if (w) openWidgetModal(w);
  });

  content.appendChild(card);
  return content;
}

function refreshPlacedCard(stack) {
  const el = gridItemFor(stack.id);
  if (!el) return;
  const old = el.querySelector(".grid-stack-item-content");
  if (old) old.replaceWith(buildPlacedContent(stack));
  el.classList.toggle("is-selected", stack.id === selectedStackId);
}

function buildGridItem(stack, node, type = "stack") {
  const item = document.createElement("div");
  item.className = "grid-stack-item";
  item.dataset.stackId = stack.id;
  item.dataset.itemType = type;
  if (node) {
    const w = Math.max(MIN_W, Math.min(COLS, node.w));
    const h = Math.max(MIN_H, Math.min(ROWS, node.h));
    item.setAttribute("gs-x", Math.max(0, Math.min(COLS - w, node.x)));
    item.setAttribute("gs-y", Math.max(0, Math.min(ROWS - h, node.y)));
    item.setAttribute("gs-w", w);
    item.setAttribute("gs-h", h);
    if (node.locked) { item.setAttribute("gs-locked", "true"); item.setAttribute("gs-no-move", "true"); item.setAttribute("gs-no-resize", "true"); item.classList.add("is-locked"); }
  } else {
    item.setAttribute("gs-w", DEF_W);
    item.setAttribute("gs-h", DEF_H);
  }
  item.setAttribute("gs-min-w", MIN_W);
  item.setAttribute("gs-min-h", MIN_H);
  item.appendChild(buildPlacedContent(stack));
  return item;
}

function addCard(stack, node, type = "widget") {
  const gsEl = byId("gs-grid");
  const item = buildGridItem(stack, node, type);
  gsEl.appendChild(item);
  grid.makeWidget(item);
  placedIds.add(stack.id);
  phantomStackIds.add(stack.id);
  syncPaletteStates();
  return item;
}

// ── card actions ─────────────────────────────────────────────────────────────

function pageNodes() {
  return grid ? grid.getGridItems().map((el) => ({ ...el.gridstackNode, stackId: Number(el.dataset.stackId), el })) : [];
}

// Place a widget on the current page: at `at` if given and free, else the
// nearest free space (shrinking it if needed).
async function placeWidget(widgetId, at = null) {
  const w = widgetsById[widgetId];
  if (!w) return null;
  const nodes = pageNodes();
  let spot = at && G.isFree(at, nodes, COLS, ROWS) ? at : null;
  if (!spot) {
    const [dw, dh] = at ? [at.w, at.h] : defaultSize(w.type);
    spot = G.findFreeSpot(nodes, COLS, ROWS, dw, dh, { px: at?.x || 0, py: at?.y || 0, minW: MIN_W, minH: MIN_H });
  }
  if (!spot) { showPageFullToast(); return null; }
  const stack = await api.createStack({ name: w.title, widget_ids: [widgetId] });
  stacks.push(stack);
  const item = addCard(stack, spot, "widget");
  if (!at) autoFitHeight(item);
  saveLayoutSoon();
  selectStack(stack.id);
  renderWidgets();
  return stack;
}

// Expand a just-placed grid item's height so its widget area doesn't scroll.
function autoFitHeight(item) {
  requestAnimationFrame(() => {
    const widgetArea = item.querySelector(".layout-widget-area");
    if (!widgetArea) return;
    const overflow = widgetArea.scrollHeight - widgetArea.clientHeight;
    if (overflow <= 2) return;
    const extraRows = Math.ceil(overflow / (dispH / ROWS));
    const n = item.gridstackNode;
    if (!n) return;
    const newH = Math.min(ROWS - n.y, n.h + extraRows);
    if (newH > n.h) grid.update(item, { h: newH });
  });
}

async function removeCard(stackId, { undoable = true } = {}) {
  const item = gridItemFor(stackId);
  const stack = stacks.find((s) => s.id === stackId);
  if (!item || !stack) return;
  item.classList.add("ejecting");
  await new Promise((r) => setTimeout(r, 180));
  grid.removeWidget(item);
  placedIds.delete(stackId);
  phantomStackIds.delete(stackId);
  stacks = stacks.filter((s) => s.id !== stackId);
  if (selectedStackId === stackId) selectStack(null);
  await api.deleteStack(stackId).catch(() => {});
  syncPaletteStates();
  saveLayoutSoon();
  renderWidgets();
  if (undoable) toast(`Removed ${stack.name}`, { action: { label: "Undo", run: () => history?.undo() } });
}

async function duplicateCard(stackId) {
  const stack = stacks.find((s) => s.id === stackId);
  const src = gridItemFor(stackId)?.gridstackNode;
  if (!stack || !src) return;
  const nodes = pageNodes();
  const tries = [{ ...src, x: src.x + src.w }, { ...src, y: src.y + src.h }, { ...src, x: src.x - src.w }, { ...src, y: src.y - src.h }];
  let spot = tries.find((n) => G.isFree({ x: n.x, y: n.y, w: n.w, h: n.h }, nodes, COLS, ROWS));
  if (spot) spot = { x: spot.x, y: spot.y, w: spot.w, h: spot.h };
  else spot = G.findFreeSpot(nodes, COLS, ROWS, src.w, src.h, { px: src.x, py: src.y, minW: MIN_W, minH: MIN_H });
  if (!spot) { showPageFullToast(); return; }
  const copy = await api.createStack({ name: stack.name, widget_ids: [...stack.widget_ids], cycle_mode: stack.cycle_mode });
  stacks.push(copy);
  addCard(copy, spot, gridItemFor(stackId)?.dataset.itemType || "stack");
  saveLayoutSoon();
  selectStack(copy.id);
}

function setLocked(stackId, on) {
  const el = gridItemFor(stackId);
  if (!el) return;
  grid.update(el, { locked: on, noMove: on, noResize: on });
  el.classList.toggle("is-locked", on);
  saveLayoutSoon();
  updateToolbar();
  inspector?.render(true);
}

function fillCard(stackId, edge = null) {
  const el = gridItemFor(stackId);
  if (!el) return;
  const n = el.gridstackNode;
  const others = pageNodes().filter((o) => o.el !== el);
  const cur = { x: n.x, y: n.y, w: n.w, h: n.h };
  const next = edge ? G.growEdge(cur, others, COLS, ROWS, edge) : G.fillSpace(cur, [cur, ...others], COLS, ROWS);
  if (JSON.stringify(next) !== JSON.stringify(cur)) { grid.update(el, next); saveLayoutSoon(); }
}

function updateNode(stackId, patch) {
  const el = gridItemFor(stackId);
  if (!el) return;
  const n = el.gridstackNode;
  const next = { x: n.x, y: n.y, w: n.w, h: n.h, ...patch };
  next.w = Math.max(MIN_W, Math.min(COLS, next.w)); next.h = Math.max(MIN_H, Math.min(ROWS, next.h));
  next.x = Math.max(0, Math.min(COLS - next.w, next.x)); next.y = Math.max(0, Math.min(ROWS - next.h, next.y));
  if (!G.isFree(next, pageNodes().filter((o) => o.el !== el), COLS, ROWS)) { toast("That space is taken"); inspector?.render(true); return; }
  grid.update(el, next);
  saveLayoutSoon();
}

async function moveCardToPage(stackId, pageIdx, { copy = false } = {}) {
  if (pageIdx === currentPageIdx || !board.pages[pageIdx]) return;
  const el = gridItemFor(stackId);
  const stack = stacks.find((s) => s.id === stackId);
  if (!el || !stack) return;
  const n = el.gridstackNode;
  const target = board.pages[pageIdx];
  const targetNodes = target.layout || [];
  let spot = { x: n.x, y: n.y, w: n.w, h: n.h };
  if (!G.isFree(spot, targetNodes, COLS, ROWS)) spot = G.findFreeSpot(targetNodes, COLS, ROWS, n.w, n.h, { px: n.x, py: n.y, minW: MIN_W, minH: MIN_H });
  if (!spot) { toast(`No room on ${target.name}`); return; }
  let movedId = stackId;
  if (copy) {
    const c = await api.createStack({ name: stack.name, widget_ids: [...stack.widget_ids], cycle_mode: stack.cycle_mode });
    stacks.push(c);
    movedId = c.id;
  } else {
    grid.removeWidget(el);
    placedIds.delete(stackId);
    if (selectedStackId === stackId) selectStack(null);
  }
  target.layout = [...targetNodes, { stack_id: movedId, ...spot, item_type: el.dataset.itemType || "stack" }];
  saveLayoutSoon();
  toast(`${copy ? "Copied" : "Moved"} ${stack.name} to ${target.name}`, { action: { label: "Go there", run: () => switchPage(pageIdx) } });
}

async function mergeWidgetIntoStack(stack, widgetId) {
  const widget = widgetsById[widgetId];
  if (!widget || stack.widget_ids.includes(widgetId)) return;
  if (MULTIPAGE_TYPES.has(widget.type) || hasMultipage(stack)) { showIntegrationToast(); return; }
  const updated = await api.updateStack(stack.id, { widget_ids: [...stack.widget_ids, widgetId] });
  stack.widget_ids = updated.widget_ids;
  cardWidgetIdx[stack.id] = stack.widget_ids.length - 1;
  refreshPlacedCard(stack);
  gridItemFor(stack.id)?.querySelector(".layout-stack-card")?.classList.add("merging");
  saveLayoutSoon();
  inspector?.render(true);
}

async function mergeStacks(targetStackId, draggedStackId) {
  const target = stacks.find((s) => s.id === targetStackId);
  const dragged = stacks.find((s) => s.id === draggedStackId);
  if (!target || !dragged) return false;
  if (hasMultipage(target) || hasMultipage(dragged)) { showIntegrationToast(); return false; }
  const updated = await api.updateStack(target.id, { widget_ids: [...new Set([...target.widget_ids, ...dragged.widget_ids])] });
  target.widget_ids = updated.widget_ids;
  const el = gridItemFor(dragged.id);
  if (el) grid.removeWidget(el);
  placedIds.delete(dragged.id);
  phantomStackIds.delete(dragged.id);
  stacks = stacks.filter((s) => s.id !== dragged.id);
  await api.deleteStack(dragged.id).catch(() => {});
  refreshPlacedCard(target);
  gridItemFor(target.id)?.querySelector(".layout-stack-card")?.classList.add("merging");
  selectStack(target.id);
  saveLayoutSoon();
  return true;
}

// ── selection + floating toolbar ─────────────────────────────────────────────

function selectStack(stackId) {
  if (stackId === selectedStackId) { updateToolbar(); return; }
  selectedStackId = stackId;
  for (const el of grid?.getGridItems() || []) el.classList.toggle("is-selected", Number(el.dataset.stackId) === stackId);
  document.body.classList.toggle("has-selection", stackId != null);
  updateToolbar();
  updateStatus();
  inspector?.render(true);
}

function toolbarButton(label, title, onClick, cls = "") {
  const b = Object.assign(document.createElement("button"), { type: "button", className: cls, textContent: label, title });
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

function updateToolbar() {
  const bar = byId("card-toolbar");
  if (!bar) return;
  const el = selectedStackId != null ? gridItemFor(selectedStackId) : null;
  const stack = stacks.find((s) => s.id === selectedStackId);
  if (!el || !stack || document.body.classList.contains("is-dragging")) { bar.classList.add("hidden"); return; }
  const locked = !!el.gridstackNode?.locked;
  bar.innerHTML = "";
  bar.append(
    toolbarButton("Edit", "Edit the widget's settings", () => { const w = currentWidgetOf(stack); if (w) openWidgetModal(w); }),
    toolbarButton("Stack ▾", "Add another widget to this card", (e) => openStackMenu(stack, e.currentTarget)),
    toolbarButton("Duplicate", "Duplicate (Ctrl+D)", () => duplicateCard(stack.id)),
    toolbarButton("Fill", "Grow into empty space (F)", () => fillCard(stack.id)),
    toolbarButton(locked ? "Unlock" : "Lock", "Lock in place (L)", () => setLocked(stack.id, !locked)),
    toolbarButton("Remove", "Remove from the page (Delete)", () => removeCard(stack.id), "danger"),
  );
  bar.classList.remove("hidden");
  const areaEl = byId("canvas-area");
  const area = areaEl.getBoundingClientRect();
  const vp = byId("preview-viewport").getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  // Above the card if that stays inside the preview (never over the page
  // tabs), else below it, else just inside its top edge.
  let y;
  if (r.top - bh - 8 >= vp.top) y = r.top - bh - 8;
  else if (r.bottom + bh + 8 <= vp.bottom) y = r.bottom + 8;
  else y = Math.max(vp.top, r.top) + 8;
  const top = y - area.top + areaEl.scrollTop;
  let left = r.left - area.left + r.width / 2 - bw / 2 + areaEl.scrollLeft;
  left = Math.max(6, Math.min(area.width - bw - 6, left));
  bar.style.top = `${top}px`;
  bar.style.left = `${left}px`;
}

function stackableWidgets(stack) {
  if (hasMultipage(stack)) return [];
  return widgets.filter((w) => !stack.widget_ids.includes(w.id) && !MULTIPAGE_TYPES.has(w.type));
}

function openStackMenu(stack, anchor) {
  document.querySelector(".ed-menu")?.remove();
  const menu = Object.assign(document.createElement("div"), { className: "ed-menu" });
  const options = stackableWidgets(stack);
  if (!options.length) {
    menu.appendChild(Object.assign(document.createElement("div"), { className: "ed-menu-empty", textContent: hasMultipage(stack) ? "Multi-page widgets can't be stacked." : "No other widgets to add." }));
  }
  for (const w of options) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: `${w.title}` });
    b.appendChild(Object.assign(document.createElement("small"), { textContent: w.type }));
    b.addEventListener("click", () => { menu.remove(); mergeWidgetIntoStack(stack, w.id); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${Math.min(window.innerWidth - menu.offsetWidth - 8, r.left)}px`;
  setTimeout(() => document.addEventListener("pointerdown", function close(e) {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("pointerdown", close); }
  }), 0);
}

function updateStatus() {
  const bar = byId("statusbar");
  if (!bar) return;
  const page = currentPage();
  const sel = stacks.find((s) => s.id === selectedStackId);
  const n = sel ? gridItemFor(sel.id)?.gridstackNode : null;
  const parts = [
    `${dispW} × ${dispH}`,
    `${COLS} × ${ROWS} grid`,
    page?.mode === "tiled" ? "Tiled page" : "Free page",
    `Preview ${Math.round(stageScale * 100)}%`,
  ];
  if (n) parts.push(`${sel.name}: ${n.x},${n.y} · ${n.w} × ${n.h} cells · ${cellPx(n.w, n.h)}`);
  bar.textContent = parts.join("   ·   ");
}

// ── hold-to-stack while dragging ─────────────────────────────────────────────
// Hovering the middle of another card for a moment arms "stack onto it"; the
// card is locked meanwhile so GridStack doesn't push it out from under you.

const pointer = { x: 0, y: 0 };
const dwell = { el: null, armed: false, timer: null, lockedByUs: false };
const DWELL_MS = 450;

function trackPointer(e) {
  const t = e.touches?.[0] || e;
  pointer.x = t.clientX; pointer.y = t.clientY;
  if ("altKey" in e) pointer.alt = e.altKey;
  if (document.body.classList.contains("is-dragging")) updateDwell();
}
["mousemove", "pointermove", "touchmove"].forEach((t) => document.addEventListener(t, trackPointer, { passive: true, capture: true }));

function clearDwell() {
  clearTimeout(dwell.timer);
  if (dwell.el) {
    dwell.el.classList.remove("stack-target", "stack-armed");
    if (dwell.lockedByUs) grid.update(dwell.el, { locked: false });
  }
  Object.assign(dwell, { el: null, armed: false, timer: null, lockedByUs: false });
}

let draggingEl = null; // in-grid drag source (null for drag-in from the library)
let dragInWidgetId = null;
function updateDwell() {
  let found = null;
  for (const el of grid.getGridItems()) {
    if (el === draggingEl || el.classList.contains("grid-stack-placeholder")) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width * 0.25, cy = r.top + r.height * 0.25;
    if (pointer.x >= cx && pointer.x <= r.right - r.width * 0.25 && pointer.y >= cy && pointer.y <= r.bottom - r.height * 0.25) { found = el; break; }
  }
  if (found === dwell.el) return;
  clearDwell();
  if (!found) return;
  const target = stacks.find((s) => s.id === Number(found.dataset.stackId));
  const draggedStack = draggingEl ? stacks.find((s) => s.id === Number(draggingEl.dataset.stackId)) : null;
  const draggedMulti = draggedStack ? hasMultipage(draggedStack) : MULTIPAGE_TYPES.has(widgetsById[dragInWidgetId]?.type);
  if (!target || hasMultipage(target) || draggedMulti) return;
  dwell.el = found;
  if (!found.gridstackNode?.locked) { grid.update(found, { locked: true }); dwell.lockedByUs = true; }
  found.classList.add("stack-target");
  dwell.timer = setTimeout(() => { dwell.armed = true; found.classList.add("stack-armed"); }, DWELL_MS);
}

// ── size readout on the placeholder ──────────────────────────────────────────
function showSizeReadout(el) {
  const n = el?.gridstackNode;
  const ph = byId("gs-grid").querySelector(".grid-stack-placeholder > .placeholder-content");
  if (!n || !ph) return;
  ph.dataset.size = `${n.w} × ${n.h} · ${cellPx(n.w, n.h)}`;
}

// ── draw to place ────────────────────────────────────────────────────────────

function cellAt(clientX, clientY) {
  const r = byId("gs-grid").getBoundingClientRect();
  const x = Math.floor(((clientX - r.left) / r.width) * COLS);
  const y = Math.floor(((clientY - r.top) / r.height) * ROWS);
  return { x: Math.max(0, Math.min(COLS - 1, x)), y: Math.max(0, Math.min(ROWS - 1, y)) };
}

function setupDrawToPlace() {
  const stage = byId("ed-stage");
  const rectEl = byId("draw-rect");
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".grid-stack-item, .ed-divider, .ed-quickpick")) return;
    selectStack(null);
    if (!prefs.drawToPlace || currentPage().mode === "tiled") return;
    const start = cellAt(e.clientX, e.clientY);
    let rect = null, moved = false;
    stage.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const c = cellAt(ev.clientX, ev.clientY);
      const x = Math.min(start.x, c.x), y = Math.min(start.y, c.y);
      rect = { x, y, w: Math.abs(c.x - start.x) + 1, h: Math.abs(c.y - start.y) + 1 };
      if (!moved && (rect.w > 1 || rect.h > 1)) moved = true;
      if (!moved) return;
      const ok = rect.w >= MIN_W && rect.h >= MIN_H && G.isFree(rect, pageNodes(), COLS, ROWS);
      rectEl.classList.remove("hidden");
      rectEl.classList.toggle("bad", !ok);
      Object.assign(rectEl.style, {
        left: `${rect.x * dispW / COLS}px`, top: `${rect.y * dispH / ROWS}px`,
        width: `${rect.w * dispW / COLS}px`, height: `${rect.h * dispH / ROWS}px`,
      });
      rectEl.firstElementChild.textContent = `${rect.w} × ${rect.h}`;
    };
    const up = () => {
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", up);
      stage.removeEventListener("pointercancel", up);
      if (!moved || !rect) { rectEl.classList.add("hidden"); return; }
      if (rect.w < MIN_W || rect.h < MIN_H || !G.isFree(rect, pageNodes(), COLS, ROWS)) {
        rectEl.classList.add("hidden");
        if (rect.w < MIN_W || rect.h < MIN_H) toast(`Cards are at least ${MIN_W} × ${MIN_H} cells`);
        else toast("That space overlaps another card");
        return;
      }
      openQuickPick(rect, rectEl);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
  });
}

function openQuickPick(rect, rectEl) {
  document.querySelector(".ed-quickpick")?.remove();
  const pick = Object.assign(document.createElement("div"), { className: "ed-quickpick" });
  const input = Object.assign(document.createElement("input"), { type: "search", placeholder: "What goes here?", className: "sb-form-input" });
  const list = Object.assign(document.createElement("div"), { className: "ed-quickpick-list" });
  pick.append(input, list);
  const onBoard = placedWidgetIds();
  const close = () => { pick.remove(); rectEl.classList.add("hidden"); document.removeEventListener("pointerdown", outside, true); };
  const outside = (e) => { if (!pick.contains(e.target)) close(); };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    list.innerHTML = "";
    const ws = widgets.filter((w) => !q || w.title.toLowerCase().includes(q) || w.type.includes(q))
      .sort((a, b) => onBoard.has(a.id) - onBoard.has(b.id) || a.title.localeCompare(b.title));
    for (const w of ws.slice(0, 12)) {
      const b = Object.assign(document.createElement("button"), { type: "button" });
      b.append(Object.assign(document.createElement("span"), { textContent: w.title }),
        Object.assign(document.createElement("small"), { textContent: w.type + (onBoard.has(w.id) ? " · on a page" : "") }));
      b.addEventListener("click", async () => { close(); await placeWidget(w.id, rect); });
      list.appendChild(b);
    }
    const types = WIDGET_TYPES.filter((t) => !q || t.label.toLowerCase().includes(q) || t.type.includes(q));
    if (types.length) list.appendChild(Object.assign(document.createElement("div"), { className: "ed-quickpick-sep", textContent: "New widget" }));
    for (const t of types) {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "is-new" });
      b.append(Object.assign(document.createElement("span"), { textContent: `${t.icon}  ${t.label}` }));
      b.addEventListener("click", () => { close(); createThenPlace(t.type, rect); });
      list.appendChild(b);
    }
  };
  input.addEventListener("input", draw);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter") list.querySelector("button")?.click();
  });
  draw();
  byId("canvas-area").appendChild(pick);
  const area = byId("canvas-area").getBoundingClientRect();
  const r = rectEl.getBoundingClientRect();
  const left = Math.min(area.width - pick.offsetWidth - 8, Math.max(8, r.left - area.left));
  let top = r.bottom - area.top + 8;
  if (top + pick.offsetHeight > area.height) top = Math.max(8, r.top - area.top - pick.offsetHeight - 8);
  pick.style.left = `${left + byId("canvas-area").scrollLeft}px`;
  pick.style.top = `${top + byId("canvas-area").scrollTop}px`;
  input.focus();
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
}

function createThenPlace(type, rect) {
  const onCreated = (w) => placeWidget(w.id, rect);
  if (type === "nowplaying") return openIntegrationWizard(null, { onCreated, only: ["plex", "jellyfin"] });
  const integ = Object.entries(INTEGRATION_META).find(([, m]) => (m.widgetType || null) === type && !m.optional);
  if (integ) return openIntegrationWizard(integ[0], { onCreated });
  openWidgetModal(null, { defaultType: type, typeFilter: [type], onCreated });
}

// ── live data / SSE ───────────────────────────────────────────────────────────

function refreshWidgetArea(el) {
  const card = el.querySelector(".layout-stack-card");
  card?._renderPage?.();
}

function rerenderCardsFor(widgetId) {
  if (!grid) return;
  if (widgetsById[widgetId]?.type === "stream") return; // re-rendering would interrupt the video
  for (const el of grid.getGridItems()) {
    const stack = stacks.find((s) => s.id === Number(el.dataset.stackId));
    if (stack?.widget_ids.includes(widgetId)) refreshWidgetArea(el);
  }
}

function onEnvelope(env) {
  liveData[env.widget_id] = env;
  rerenderCardsFor(env.widget_id);
  const sel = stacks.find((s) => s.id === selectedStackId);
  if (sel && currentWidgetOf(sel)?.id === env.widget_id) inspector?.render(false);
}

function connectSSE() {
  const es = new EventSource("/api/stream");
  es.onmessage = (e) => {
    try {
      const env = JSON.parse(e.data);
      if (env.type === "widget_update") rerenderCardsFor(env.widget_id);
      else if (env.type === "config_restored") window.location.reload();
      else if (env.type === "settings_update") byId("preview-viewport")?.style.setProperty("--widget-font-scale", env.data?.widget_font_scale || "1");
      else if (env.widget_id != null) onEnvelope(env);
    } catch (_) {}
  };
}

// ── page tabs ─────────────────────────────────────────────────────────────────

function updateTabMinimaps() {
  document.querySelectorAll(".page-tab").forEach((tab) => {
    const page = board.pages[Number(tab.dataset.pageIdx)];
    const old = tab.querySelector(".ed-minimap");
    if (page && old) old.replaceWith(miniMap(page.layout || [], COLS, ROWS));
  });
}

function renderPageTabs() {
  const bar   = byId("page-tabs-bar");
  const addBtn = byId("page-tab-add");
  for (const el of [...bar.querySelectorAll(".page-tab")]) el.remove();

  board.pages.forEach((page, i) => {
    const tab  = document.createElement("div");
    tab.className = "page-tab" + (i === currentPageIdx ? " active" : "") + (page.mode === "tiled" ? " is-tiled" : "");
    tab.dataset.pageIdx = i;
    tab.title = `${page.name}${page.mode === "tiled" ? " · tiled" : ""}${page.rotate === false ? " · not in rotation" : ""}`;

    const nameSpan = Object.assign(document.createElement("span"), { className: "page-tab-name", textContent: page.name });

    function startRename() {
      const inp = Object.assign(document.createElement("input"), { className: "page-tab-input", value: page.name });
      inp.style.width = Math.max(60, nameSpan.offsetWidth + 10) + "px";
      nameSpan.replaceWith(inp);
      inp.focus(); inp.select();
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        page.name = inp.value.trim() || page.name;
        inp.replaceWith(nameSpan);
        nameSpan.textContent = page.name;
        saveLayoutSoon();
        inspector?.render(true);
      };
      inp.addEventListener("blur", commit);
      inp.addEventListener("keydown", (e2) => {
        if (e2.key === "Enter")  { e2.preventDefault(); commit(); }
        if (e2.key === "Escape") { done = true; inp.replaceWith(nameSpan); }
      });
    }
    nameSpan.addEventListener("dblclick", (e) => { e.stopPropagation(); startRename(); });

    // drag tabs to reorder (native drag is fine here: mouse only, non-essential)
    tab.draggable = true;
    tab.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-tb-page", String(i));
      e.dataTransfer.effectAllowed = "move";
      tab.classList.add("dragging");
    });
    tab.addEventListener("dragend", () => tab.classList.remove("dragging"));
    tab.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("application/x-tb-page")) { e.preventDefault(); tab.classList.add("drag-over"); } });
    tab.addEventListener("dragleave", () => tab.classList.remove("drag-over"));
    tab.addEventListener("drop", (e) => {
      e.preventDefault(); tab.classList.remove("drag-over");
      const raw = e.dataTransfer.getData("application/x-tb-page");
      if (raw === "") return;
      const fromIdx = Number(raw);
      if (fromIdx === i) return;
      currentPage().layout = currentLayout();
      const [moved] = board.pages.splice(fromIdx, 1);
      board.pages.splice(i, 0, moved);
      if      (currentPageIdx === fromIdx)                       currentPageIdx = i;
      else if (fromIdx < currentPageIdx && i >= currentPageIdx) currentPageIdx--;
      else if (fromIdx > currentPageIdx && i <= currentPageIdx) currentPageIdx++;
      renderBoard(); renderPageTabs(); saveLayoutSoon();
    });

    tab.addEventListener("click", () => { if (i !== currentPageIdx) switchPage(i); });
    tab.append(miniMap(page.layout || [], COLS, ROWS), nameSpan);

    if (board.pages.length > 1) {
      const del = Object.assign(document.createElement("button"), { className: "page-tab-del", title: "Remove page", textContent: "✕" });
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove page "${page.name}"? Its cards are removed too (the widgets stay in the library).`)) return;
        currentPage().layout = currentLayout();
        board.pages.splice(i, 1);
        if (currentPageIdx >= board.pages.length) currentPageIdx = board.pages.length - 1;
        else if (i < currentPageIdx) currentPageIdx--;
        renderBoard(); renderPageTabs();
        await saveNow();
        // the page's stacks are no longer used anywhere — clean them up
        try {
          await fetch(`/api/board/cleanup?profile_id=${editingProfileId}`, { method: "POST" });
          const fresh = await api.listStacks();
          stacks = fresh;
        } catch { /* best effort */ }
        renderWidgets();
      });
      tab.appendChild(del);
    }
    bar.insertBefore(tab, addBtn);
  });
}

function switchPage(idx) {
  if (idx === currentPageIdx || !board.pages[idx]) return;
  currentPage().layout = currentLayout();
  currentPageIdx = idx;
  selectStack(null);
  renderBoard();
  renderPageTabs();
  inspector?.render(true);
}

async function addPage(name, layout = [], extra = {}) {
  currentPage().layout = currentLayout();
  const newId = Math.max(0, ...board.pages.map((p) => p.id)) + 1;
  board.pages.push({ id: newId, name: name || `Page ${newId}`, layout, ...extra });
  currentPageIdx = board.pages.length - 1;
  renderBoard(); renderPageTabs();
  await saveNow();
  renderWidgets();
  inspector?.render(true);
  return board.pages[currentPageIdx];
}

// ── render board ──────────────────────────────────────────────────────────────

function renderBoard() {
  grid.removeAll(true, false);
  // removeAll can leave elements behind when called mid-update; clear them out
  byId("gs-grid").querySelectorAll(":scope > .grid-stack-item:not(.grid-stack-placeholder)").forEach((e) => e.remove());
  grid.batchUpdate();
  placedIds.clear();
  const page = currentPage();
  const gsEl = byId("gs-grid");
  for (const node of page.layout || []) {
    const stack = stacks.find((s) => s.id === node.stack_id);
    if (!stack) continue;
    const item = buildGridItem(stack, node, node.item_type || "stack");
    gsEl.appendChild(item);
    grid.makeWidget(item);
    placedIds.add(stack.id);
    phantomStackIds.add(stack.id);
  }
  grid.batchUpdate(false);
  const isTiled = page.mode === "tiled";
  document.body.classList.toggle("page-tiled", isTiled);
  grid.enableResize(!isTiled);
  tiled?.show(isTiled);
  if (selectedStackId != null && !placedIds.has(selectedStackId)) selectStack(null);
  else for (const el of grid.getGridItems()) el.classList.toggle("is-selected", Number(el.dataset.stackId) === selectedStackId);
  syncPaletteStates();
  updateStatus();
  updateToolbar();
}

// ── settings modal ───────────────────────────────────────────────────────────

const INTEGRATION_GUIDES = {
  proxmox: {
    title: "Setting up Proxmox API access",
    steps: [
      `In your Proxmox web UI go to <strong>Datacenter → Permissions → Users</strong> and create a new user — e.g. <code>touchboard@pve</code>.`,
      `Under <strong>Datacenter → Permissions → Add → User Permission</strong>, set path to <code>/</code>, user to your new user, role to <code>PVEAuditor</code>.`,
      `Go to <strong>Datacenter → Permissions → API Tokens</strong>, select your user, click <strong>Add</strong>. Uncheck "Privilege Separation". Note the Token ID and Secret.`,
      `Enter the <strong>username</strong> (e.g. <code>touchboard</code>), <strong>realm</strong> (e.g. <code>pve</code>), <strong>Token ID</strong>, and token <strong>Secret</strong> in the fields above.`,
      `Base URL format: <code>https://&lt;proxmox-host&gt;:8006</code>`,
    ],
  },
  truenas: {
    title: "Setting up TrueNAS access",
    steps: [
      `<strong>TrueNAS SCALE:</strong> Go to <strong>Credentials → Local Users</strong> and create a new user — e.g. <code>touchboard</code>.`,
      `Add the user to the built-in <strong>Readonly Admin</strong> group (via the user's "Auxiliary Groups" field when creating or editing).`,
      `<strong>TrueNAS CORE:</strong> Go to <strong>Accounts → Users</strong>, create a local user, and add it to the <code>operator</code> group.`,
      `Enter the username and password in the fields above. Base URL format: <code>http://&lt;truenas-ip&gt;</code>`,
    ],
  },
  netbox: {
    title: "Getting a NetBox API token",
    steps: [
      `Log into your NetBox instance and click your <strong>username</strong> in the top-right corner, then select <strong>Profile</strong>.`,
      `Click the <strong>API Tokens</strong> tab, then click <strong>+ Add a Token</strong>. Leave permissions at default.`,
      `Copy the generated token and paste it into the <strong>API Token</strong> field above.`,
      `Base URL format: <code>http://&lt;netbox-host&gt;</code> (no trailing slash)`,
    ],
  },
  adguard: {
    title: "Setting up AdGuard Home access",
    steps: [
      `Open your AdGuard Home web interface and go to <strong>Settings → Access Settings</strong>.`,
      `Use your AdGuard Home <strong>login username and password</strong> in the fields above.`,
      `Base URL format: <code>http://&lt;adguard-ip&gt;:3000</code>`,
    ],
  },
  opnsense: {
    title: "Setting up OPNsense API access",
    steps: [
      `Log into OPNsense and go to <strong>System → Access → Users</strong>.`,
      `Edit your user and scroll to the <strong>API Keys</strong> section. Click <strong>+</strong> to generate a key.`,
      `Download the key file and copy the <strong>Key</strong> and <strong>Secret</strong> into the fields above.`,
      `Base URL format: <code>https://&lt;opnsense-ip&gt;</code>`,
    ],
  },
  plex: {
    title: "Finding your Plex token",
    steps: [
      `Sign in to Plex Web, open any item, click <strong>⋯ → Get Info → View XML</strong>.`,
      `The address bar now ends in <code>X-Plex-Token=…</code>. Copy the value after the <code>=</code>.`,
      `Base URL format: <code>http://&lt;plex-server&gt;:32400</code>`,
    ],
  },
  jellyfin: {
    title: "Creating a Jellyfin API key",
    steps: [
      `In Jellyfin go to <strong>Dashboard → API Keys</strong> and click <strong>+</strong>.`,
      `Name it <code>TouchBoard</code> and copy the key into the field above.`,
      `Base URL format: <code>http://&lt;jellyfin-server&gt;:8096</code>`,
    ],
  },
  homeassistant: {
    title: "Connecting Home Assistant",
    steps: [
      `In Home Assistant, click your name (bottom left) → <strong>Security</strong> → <strong>Long-lived access tokens</strong> → <strong>Create token</strong>. Name it <code>TouchBoard</code>.`,
      `Copy the token into the field above. It's shown only once.`,
      `Base URL format: <code>http://&lt;home-assistant&gt;:8123</code> or your HTTPS proxy address.`,
      `The token stays encrypted on the TouchBoard server; the display only ever asks TouchBoard to switch the lights on that card.`,
    ],
  },
  rest: {
    title: "Using a REST connection",
    steps: [
      `Set the base URL of the API, e.g. <code>http://homeassistant.lan:8123/api</code>.`,
      `Put any secret headers in <strong>Headers</strong>, one per line: <code>Authorization: Bearer …</code>. They're encrypted on the server and never sent to the display.`,
      `In a REST / JSON widget, pick this connection and use a path relative to the base URL.`,
    ],
  },
  google_calendar: {
    title: "Getting the Google Calendar private ICS URL",
    steps: [
      `Open <strong>Google Calendar</strong> at calendar.google.com.`,
      `In the left sidebar, hover over the calendar you want and click the three-dot menu → <strong>Settings and sharing</strong>.`,
      `Scroll down to the <strong>Integrate calendar</strong> section.`,
      `Copy the <strong>Secret address in iCal format</strong> (the URL ending in <code>.ics</code>).`,
      `Paste it into the <strong>ICS URL</strong> field above.`,
    ],
  },
};

const INTEGRATION_META = {
  proxmox: {
    label: "Proxmox VE", color: "#e16000",
    fields: [
      { key: "username", label: "Username",  placeholder: "root" },
      { key: "realm",    label: "Realm",     placeholder: "pam" },
      { key: "token_id", label: "Token ID",  placeholder: "mytoken" },
      { key: "api_key",  label: "API Key",   type: "password", placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" },
    ],
    hint: "",
  },
  truenas: {
    label: "TrueNAS", color: "#0095d5",
    fields: [
      { key: "username", label: "Username", placeholder: "e.g. root" },
      { key: "password", label: "Password", type: "password", placeholder: "Account password" },
    ],
    hint: "",
  },
  netbox: {
    label: "NetBox", color: "#9c27b0",
    fields: [
      { key: "token", label: "API Token", type: "password", placeholder: "Paste your NetBox API token" },
    ],
    hint: "",
  },
  adguard: {
    label: "AdGuard Home", color: "#67b346",
    fields: [
      { key: "username", label: "Username", placeholder: "admin" },
      { key: "password", label: "Password", type: "password", placeholder: "Account password" },
    ],
    hint: "",
  },
  opnsense: {
    label: "OPNsense", color: "#f97316",
    fields: [
      { key: "api_key",    label: "API Key",    type: "password", placeholder: "API key" },
      { key: "api_secret", label: "API Secret", type: "password", placeholder: "API secret" },
    ],
    hint: "",
  },
  plex: {
    label: "Plex", color: "#e5a00d", widgetType: "nowplaying", refresh: 10,
    fields: [{ key: "token", label: "Plex token", type: "password", placeholder: "X-Plex-Token" }],
    hint: "",
  },
  jellyfin: {
    label: "Jellyfin", color: "#7b5cff", widgetType: "nowplaying", refresh: 10,
    fields: [{ key: "api_key", label: "API key", type: "password", placeholder: "Dashboard → API Keys" }],
    hint: "",
  },
  homeassistant: {
    label: "Home Assistant", color: "#18bcf2", widgetType: "lights", configureAfter: true, refresh: 5,
    fields: [{ key: "token", label: "Long-lived access token", type: "password", placeholder: "Profile → Security → Long-lived access tokens" }],
    hint: "The token is encrypted on the server and never sent to the display.",
  },
  rest: {
    label: "REST API", color: "#64748b", widgetType: "rest", optional: true, configureAfter: true, refresh: 30,
    fields: [
      { key: "headers", label: "Headers (one per line)", type: "textarea", placeholder: "Authorization: Bearer …\nX-Api-Key: …" },
      { key: "username", label: "Basic auth user (optional)", placeholder: "" },
      { key: "password", label: "Basic auth password", type: "password", placeholder: "" },
    ],
    hint: "Headers and passwords are encrypted on the server and never sent to the display.",
  },
  google_calendar: {
    label: "Google Calendar", color: "#4285f4",
    noBaseUrl: true,
    widgetType: "calendar",
    fields: [
      { key: "ical_urls", label: "ICS URL", type: "list", addLabel: "+ Add another ICS URL",
        placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics" },
    ],
    hint: "Get each URL from Google Calendar → Settings → (calendar) → Integrate calendar → Secret address in iCal format.",
  },
};

async function openSettingsPanel(section) {
  const dlg = byId("settings-modal");
  dlg.innerHTML = "";

  if (section === "Designer") {
    dlg.classList.add("designer-modal");
  } else {
    dlg.classList.remove("designer-modal");
  }

  const head = document.createElement("div");
  head.className = "modal-head";
  const titleEl = Object.assign(document.createElement("h2"), { textContent: section });
  const closeBtn = Object.assign(document.createElement("button"), { className: "modal-close-btn", textContent: "✕" });
  closeBtn.addEventListener("click", () => dlg.close());
  head.append(titleEl, closeBtn);
  dlg.appendChild(head);

  const contentEl = document.createElement("div");
  contentEl.className = "settings-content";
  dlg.appendChild(contentEl);

  // ── Profiles tab ───────────────────────────────────────────────────────────
  async function renderProfilesTab() {
    contentEl.innerHTML = "";

    let profiles = [];
    try { profiles = await api.listProfiles(); } catch { /* ignore */ }

    const addSection = document.createElement("div");
    addSection.className = "settings-add-section";
    const addBtn = document.createElement("button");
    addBtn.className = "settings-add-btn";
    addBtn.innerHTML = "<span>＋</span> New Profile";
    addSection.appendChild(addBtn);

    const addForm = document.createElement("div");
    addForm.className = "settings-add-form hidden";
    addSection.appendChild(addForm);

    addBtn.addEventListener("click", () => {
      addForm.classList.toggle("hidden");
      if (!addForm.classList.contains("hidden") && !addForm.children.length) {
        const nameInput = Object.assign(document.createElement("input"), {
          className: "sb-form-input", placeholder: "Profile name",
        });
        addForm.appendChild(makeSbRow("Name", nameInput));
        const createBtn = Object.assign(document.createElement("button"), {
          type: "button", className: "small primary", textContent: "Create",
        });
        createBtn.addEventListener("click", async () => {
          const name = nameInput.value.trim();
          if (!name) return;
          await api.createProfile(name);
          addForm.classList.add("hidden");
          addForm.innerHTML = "";
          renderProfilesTab();
          renderProfileMenu();
        });
        addForm.appendChild(createBtn);
      }
    });
    contentEl.appendChild(addSection);

    if (!profiles.length) {
      contentEl.appendChild(Object.assign(document.createElement("div"), {
        className: "settings-empty", textContent: "No profiles yet.",
      }));
      return;
    }

    const list = document.createElement("div");
    list.className = "settings-ds-list";

    for (const p of profiles) {
      const card = document.createElement("div");
      card.className = "settings-ds-card";

      const cardHead = document.createElement("div");
      cardHead.className = "settings-ds-head";

      const nameSpan = document.createElement("span");
      nameSpan.className = "settings-ds-name";
      nameSpan.textContent = p.name;
      if (p.is_active) {
        const badge = document.createElement("span");
        badge.className = "settings-ds-badge";
        badge.textContent = "Active";
        badge.style.setProperty("--ds-color", "#fbbf24");
        cardHead.appendChild(badge);
      }
      cardHead.appendChild(nameSpan);

      const editBtn = Object.assign(document.createElement("button"), {
        className: "sb-icon-btn", title: "Rename", textContent: "✎",
      });
      editBtn.addEventListener("click", async () => {
        const name = prompt("Rename profile", p.name);
        if (!name || !name.trim() || name === p.name) return;
        await api.renameProfile(p.id, name.trim());
        renderProfilesTab();
        renderProfileMenu();
      });

      const dupBtn = Object.assign(document.createElement("button"), {
        className: "sb-icon-btn", title: "Duplicate", textContent: "⧉",
      });
      dupBtn.addEventListener("click", async () => {
        await api.duplicateProfile(p.id, `${p.name} copy`);
        renderProfilesTab();
        renderProfileMenu();
      });

      const delBtn = Object.assign(document.createElement("button"), {
        className: "sb-icon-btn danger", title: "Delete", textContent: "✕",
      });
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete profile "${p.name}"? This also deletes its widgets and stacks.`)) return;
        try {
          await api.deleteProfile(p.id);
          renderProfilesTab();
          renderProfileMenu();
        } catch (err) {
          alert(err.message.includes("400") ? "Can't delete the active profile — switch to another one first." : "Couldn't delete profile.");
        }
      });

      cardHead.append(editBtn, dupBtn, delBtn);
      card.appendChild(cardHead);
      list.appendChild(card);
    }
    contentEl.appendChild(list);
  }

  // ── Integrations tab ──────────────────────────────────────────────────────
  async function renderIntegrationsTab() {
    contentEl.innerHTML = "";

    let sources = [];
    try { sources = await api.listDataSources(); } catch { /* ignore */ }

    // Add-integration button + expandable form
    const addSection = document.createElement("div");
    addSection.className = "settings-add-section";

    const addBtn = document.createElement("button");
    addBtn.className = "settings-add-btn";
    addBtn.innerHTML = "<span>＋</span> Add Integration";
    addSection.appendChild(addBtn);

    const addForm = document.createElement("div");
    addForm.className = "settings-add-form hidden";
    addSection.appendChild(addForm);

    addBtn.addEventListener("click", () => {
      addForm.classList.toggle("hidden");
      if (!addForm.classList.contains("hidden") && !addForm.children.length) {
        buildAddForm(addForm, () => {
          addForm.classList.add("hidden");
          addForm.innerHTML = "";
          renderIntegrationsTab();
        });
      }
    });

    contentEl.appendChild(addSection);

    // Existing integrations list
    if (!sources.length) {
      const empty = document.createElement("div");
      empty.className = "settings-empty";
      empty.textContent = "No integrations configured yet. Add one above to connect Proxmox, TrueNAS, or NetBox.";
      contentEl.appendChild(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "settings-ds-list";

    for (const ds of sources) {
      const meta = INTEGRATION_META[ds.type] || { label: ds.type, color: "#8b96a5", fields: [], hint: "" };
      const card = document.createElement("div");
      card.className = "settings-ds-card";

      const cardHead = document.createElement("div");
      cardHead.className = "settings-ds-head";

      const badge = document.createElement("span");
      badge.className = "settings-ds-badge";
      badge.textContent = meta.label;
      badge.style.setProperty("--ds-color", meta.color);

      const dsName = document.createElement("span");
      dsName.className = "settings-ds-name";
      dsName.textContent = ds.name;

      const dsUrl = document.createElement("span");
      dsUrl.className = "settings-ds-url";
      dsUrl.textContent = ds.base_url;

      const secretBadge = document.createElement("span");
      secretBadge.className = "settings-ds-secret";
      secretBadge.textContent = ds.has_secret ? "🔒 credentials saved" : "no credentials";

      const editBtn = document.createElement("button");
      editBtn.className = "sb-icon-btn";
      editBtn.title = "Edit integration";
      editBtn.textContent = "✎";

      const delBtn = document.createElement("button");
      delBtn.className = "sb-icon-btn danger";
      delBtn.title = "Delete integration";
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete integration "${ds.name}"?`)) return;
        await api.deleteDataSource(ds.id);
        renderIntegrationsTab();
      });

      cardHead.append(badge, dsName, editBtn, delBtn);
      card.append(cardHead, dsUrl, secretBadge);

      // Inline edit panel (built lazily on first expand)
      const editPanel = document.createElement("div");
      editPanel.className = "settings-edit-panel hidden";
      card.appendChild(editPanel);

      editBtn.addEventListener("click", () => {
        const wasHidden = editPanel.classList.contains("hidden");
        editPanel.classList.toggle("hidden");
        if (wasHidden && !editPanel.children.length) {
          buildEditForm(editPanel, ds, () => {
            editPanel.classList.add("hidden");
            editPanel.innerHTML = "";
            renderIntegrationsTab();
          });
        }
      });

      list.appendChild(card);
    }
    contentEl.appendChild(list);
  }

  function buildAddForm(container, onSaved) {
    const wrap = document.createElement("div");
    wrap.className = "settings-form-wrap";

    // Type selector
    const typeSel = document.createElement("select");
    typeSel.className = "sb-form-input";
    for (const [val, meta] of Object.entries(INTEGRATION_META)) {
      const opt = document.createElement("option");
      opt.value = val; opt.textContent = meta.label;
      typeSel.appendChild(opt);
    }

    const nameInput = Object.assign(document.createElement("input"),
      { className: "sb-form-input", placeholder: "Display name (e.g. Home Proxmox)" });

    const urlInput = Object.assign(document.createElement("input"),
      { className: "sb-form-input", placeholder: "https://…", type: "url" });
    const urlRow = makeSbRow("Base URL", urlInput);

    const credFields = document.createElement("div");
    credFields.className = "settings-cred-fields";

    const hintEl = document.createElement("div");
    hintEl.className = "settings-ds-hint";

    function refreshCredFields() {
      credFields.innerHTML = "";
      const meta = INTEGRATION_META[typeSel.value];
      hintEl.textContent = meta.hint;
      urlRow.style.display = meta.noBaseUrl ? "none" : "";
      for (const f of meta.fields) {
        const inp = makeCredField(f);
        credFields.appendChild(makeSbRow(f.label, inp));
      }
    }
    typeSel.addEventListener("change", refreshCredFields);
    refreshCredFields();

    // Setup guide
    const guideWrap = document.createElement("div");
    guideWrap.className = "intg-guide-wrap";
    const guideArrow = Object.assign(document.createElement("span"), { className: "igt-arrow", textContent: "▶" });
    const guideToggle = Object.assign(document.createElement("button"), { type: "button", className: "intg-guide-toggle" });
    guideToggle.append(guideArrow, " Setup Guide");
    const guideContent = document.createElement("div");
    guideContent.className = "intg-guide-content hidden";
    function populateGuide() {
      const gd = INTEGRATION_GUIDES[typeSel.value]; guideContent.innerHTML = "";
      if (!gd) return;
      const ol = Object.assign(document.createElement("ol"), { className: "igt-steps" });
      gd.steps.forEach(s => { const li = document.createElement("li"); li.innerHTML = s; ol.appendChild(li); });
      guideContent.appendChild(ol);
    }
    guideToggle.addEventListener("click", () => {
      const open = guideContent.classList.toggle("hidden") === false;
      guideArrow.style.transform = open ? "rotate(90deg)" : "";
      if (open) populateGuide();
    });
    typeSel.addEventListener("change", () => { if (!guideContent.classList.contains("hidden")) populateGuide(); });
    guideWrap.append(guideToggle, guideContent);

    const errEl = document.createElement("div");
    errEl.className = "settings-form-error hidden";

    const formFooter = document.createElement("div");
    formFooter.className = "settings-form-footer";

    const cancelBtn = Object.assign(document.createElement("button"),
      { type: "button", className: "small", textContent: "Cancel" });
    cancelBtn.addEventListener("click", onSaved);

    const saveBtn = Object.assign(document.createElement("button"),
      { type: "button", className: "small primary", textContent: "Save Integration" });

    saveBtn.addEventListener("click", async () => {
      const type = typeSel.value;
      const meta = INTEGRATION_META[type];
      const name = nameInput.value.trim();
      const base_url = meta?.noBaseUrl ? "https://calendar.google.com" : urlInput.value.trim();
      if (!name || (!meta?.noBaseUrl && !base_url)) {
        errEl.textContent = "Name and URL are required.";
        errEl.classList.remove("hidden"); return;
      }
      const credentials = readCredFields(credFields);
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      try {
        await api.createDataSource({ type, name, base_url, credentials });
        onSaved();
      } catch (e) {
        errEl.textContent = e.message || "Save failed.";
        errEl.classList.remove("hidden");
        saveBtn.disabled = false; saveBtn.textContent = "Save Integration";
      }
    });

    formFooter.append(cancelBtn, saveBtn);
    wrap.append(
      makeSbRow("Type", typeSel),
      makeSbRow("Name", nameInput),
      urlRow,
      credFields,
      hintEl,
      guideWrap,
      errEl,
      formFooter,
    );
    container.appendChild(wrap);
  }

  function buildEditForm(container, ds, onSaved) {
    const meta = INTEGRATION_META[ds.type] || { label: ds.type, color: "#8b96a5", fields: [], hint: "" };
    const wrap = document.createElement("div");
    wrap.className = "settings-form-wrap";

    const typeLbl = document.createElement("div");
    typeLbl.className = "settings-edit-type-lbl";
    typeLbl.textContent = `Editing ${meta.label} integration`;

    const nameInput = Object.assign(document.createElement("input"),
      { className: "sb-form-input", placeholder: "Display name", value: ds.name });

    const urlInput = Object.assign(document.createElement("input"),
      { className: "sb-form-input", placeholder: "https://…", type: "url", value: ds.base_url });

    const credFields = document.createElement("div");
    credFields.className = "settings-cred-fields";

    function buildCredFields(existingCreds = {}) {
      credFields.innerHTML = "";
      for (const f of meta.fields) {
        const existing = existingCreds[f.key] ?? "";
        const editF = f.type === "list" ? { ...f } : { ...f, placeholder: `${f.placeholder || f.label} (leave blank to keep current)` };
        const inp = makeCredField(editF, existing);
        const row = document.createElement("div");
        row.className = "sb-form-row";
        const lbl = document.createElement("div");
        lbl.className = "sb-form-label"; lbl.textContent = f.label;
        row.append(lbl, inp);
        credFields.appendChild(row);
      }
    }

    buildCredFields();
    api.getDataSourceCredentials(ds.id).then(creds => {
      const anyFilled = [...credFields.querySelectorAll("input, textarea")].some(el => el.value.trim());
      if (!anyFilled) buildCredFields(creds);
    }).catch(() => {});

    if (meta.hint) {
      const hintEl = document.createElement("div");
      hintEl.className = "settings-ds-hint";
      hintEl.textContent = meta.hint;
      wrap.appendChild(hintEl);
    }

    // Setup guide (inline expandable)
    const editGuideWrap = document.createElement("div");
    editGuideWrap.className = "intg-guide-wrap";
    const editGuideArrow = Object.assign(document.createElement("span"), { className: "igt-arrow", textContent: "▶" });
    const editGuideToggle = Object.assign(document.createElement("button"), { type: "button", className: "intg-guide-toggle" });
    editGuideToggle.append(editGuideArrow, " Setup Guide");
    const editGuideContent = document.createElement("div");
    editGuideContent.className = "intg-guide-content hidden";
    const editGd = INTEGRATION_GUIDES[ds.type];
    if (editGd) {
      const ol = Object.assign(document.createElement("ol"), { className: "igt-steps" });
      editGd.steps.forEach(s => { const li = document.createElement("li"); li.innerHTML = s; ol.appendChild(li); });
      editGuideContent.appendChild(ol);
    }
    editGuideToggle.addEventListener("click", () => {
      const open = editGuideContent.classList.toggle("hidden") === false;
      editGuideArrow.style.transform = open ? "rotate(90deg)" : "";
    });
    editGuideWrap.append(editGuideToggle, editGuideContent);

    const errEl = document.createElement("div");
    errEl.className = "settings-form-error hidden";

    const formFooter = document.createElement("div");
    formFooter.className = "settings-form-footer";

    const cancelBtn = Object.assign(document.createElement("button"),
      { type: "button", className: "small", textContent: "Cancel" });
    cancelBtn.addEventListener("click", onSaved);

    const saveBtn = Object.assign(document.createElement("button"),
      { type: "button", className: "small primary", textContent: "Update Integration" });

    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      const base_url = meta.noBaseUrl ? ds.base_url : urlInput.value.trim();
      if (!name || (!meta.noBaseUrl && !base_url)) {
        errEl.textContent = "Name and URL are required.";
        errEl.classList.remove("hidden"); return;
      }
      const credentials = readCredFields(credFields);
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      try {
        const body = { name, base_url };
        if (Object.keys(credentials).length) body.credentials = credentials;
        await api.updateDataSource(ds.id, body);
        onSaved();
      } catch (e) {
        errEl.textContent = e.message || "Update failed.";
        errEl.classList.remove("hidden");
        saveBtn.disabled = false; saveBtn.textContent = "Update Integration";
      }
    });

    const editUrlRow = makeSbRow("Base URL", urlInput);
    if (meta.noBaseUrl) editUrlRow.style.display = "none";
    formFooter.append(cancelBtn, saveBtn);
    wrap.append(
      typeLbl,
      makeSbRow("Name", nameInput),
      editUrlRow,
      credFields,
      editGuideWrap,
      errEl,
      formFooter,
    );
    container.appendChild(wrap);
  }

  // ── General tab (stub — removed from nav, kept so old code paths don't crash) ──
  function renderGeneralTab() { contentEl.innerHTML = ""; }

  function renderPingTargetsTab() {
    contentEl.innerHTML = "";

    const sorted = [...pingTargets].sort((a, b) => {
      const ga = (a.group || "").toLowerCase(), gb = (b.group || "").toLowerCase();
      if (ga !== gb) return ga < gb ? -1 : 1;
      return (a.label || "").toLowerCase() < (b.label || "").toLowerCase() ? -1 : 1;
    });
    const existingGroups = [...new Set(sorted.map((t) => t.group || "").filter(Boolean))];

    // Hidden datalist for group autocomplete
    const datalist = document.createElement("datalist");
    datalist.id = "pt-groups-datalist";
    for (const g of existingGroups) {
      const opt = document.createElement("option"); opt.value = g; datalist.appendChild(opt);
    }
    contentEl.appendChild(datalist);

    // ── 1. Groups ───────────────────────────────────────────────────────────
    const grpSectionHead = document.createElement("div");
    grpSectionHead.className = "pt-section-head";
    grpSectionHead.append(
      Object.assign(document.createElement("span"), { className: "settings-section-head", textContent: "Groups" }),
    );
    contentEl.appendChild(grpSectionHead);

    // Always-visible create-group form
    const createGrpForm = document.createElement("div");
    createGrpForm.className = "pt-add-form";
    const newGrpInput = Object.assign(document.createElement("input"), { className: "sb-form-input", placeholder: "Group name" });
    const saveGrpBtn  = Object.assign(document.createElement("button"), { type: "button", className: "small primary", textContent: "+ Create" });
    createGrpForm.append(newGrpInput, saveGrpBtn);
    contentEl.appendChild(createGrpForm);

    saveGrpBtn.addEventListener("click", () => {
      const name = newGrpInput.value.trim();
      if (!name || existingGroups.includes(name)) { newGrpInput.focus(); return; }
      if (!existingGroups.includes(name)) existingGroups.push(name);
      const opt = document.createElement("option"); opt.value = name; datalist.appendChild(opt);
      newGrpInput.value = "";
      renderGroupList();
    });

    const grpList = document.createElement("div");
    grpList.className = "pt-group-list";
    contentEl.appendChild(grpList);

    function renderGroupList() {
      grpList.innerHTML = "";
      if (!existingGroups.length) {
        grpList.appendChild(Object.assign(document.createElement("div"), { className: "settings-empty", textContent: "No groups yet." }));
        return;
      }
      for (const grpName of [...existingGroups].sort()) {
        const row = document.createElement("div");
        row.className = "pt-group-row";

        const nameSpan = Object.assign(document.createElement("span"), { className: "pt-group-row-name", textContent: grpName });
        const renameBtn = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Rename" });
        const deleteBtn = Object.assign(document.createElement("button"), { type: "button", className: "small danger", textContent: "Delete" });

        renameBtn.addEventListener("click", () => {
          const inp = Object.assign(document.createElement("input"), { className: "sb-form-input", value: grpName, placeholder: "New name" });
          inp.style.flex = "1";
          const okBtn  = Object.assign(document.createElement("button"), { type: "button", className: "small primary", textContent: "Save" });
          const noBtn  = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Cancel" });
          row.innerHTML = ""; row.append(inp, okBtn, noBtn);
          inp.focus(); inp.select();
          const doRename = async () => {
            const newName = inp.value.trim();
            if (!newName || newName === grpName) { renderPingTargetsTab(); return; }
            const targets = pingTargets.filter((t) => (t.group || "") === grpName);
            await Promise.all(targets.map((t) => api.updatePingTarget(t.id, { group: newName })));
            for (const t of targets) {
              const idx = pingTargets.findIndex((x) => x.id === t.id);
              if (idx >= 0) pingTargets[idx] = { ...pingTargets[idx], group: newName };
            }
            renderPingTargetsTab();
          };
          okBtn.addEventListener("click", doRename);
          inp.addEventListener("keydown", (e) => { if (e.key === "Enter") doRename(); if (e.key === "Escape") renderPingTargetsTab(); });
          noBtn.addEventListener("click", renderPingTargetsTab);
        });

        deleteBtn.addEventListener("click", async () => {
          const count = pingTargets.filter((t) => (t.group || "") === grpName).length;
          const msg = count
            ? `Delete group "${grpName}"? This will remove the group from ${count} target${count > 1 ? "s" : ""} (targets will not be deleted).`
            : `Delete group "${grpName}"?`;
          if (!confirm(msg)) return;
          const targets = pingTargets.filter((t) => (t.group || "") === grpName);
          await Promise.all(targets.map((t) => api.updatePingTarget(t.id, { group: "" })));
          for (const t of targets) {
            const idx = pingTargets.findIndex((x) => x.id === t.id);
            if (idx >= 0) pingTargets[idx] = { ...pingTargets[idx], group: "" };
          }
          renderPingTargetsTab();
        });

        row.append(nameSpan, renameBtn, deleteBtn);
        grpList.appendChild(row);
      }
    }
    renderGroupList();

    // ── 2. Add Target ───────────────────────────────────────────────────────
    contentEl.appendChild(Object.assign(document.createElement("div"), { className: "settings-section-head", textContent: "Targets", style: "margin-top:14px" }));

    const addForm = document.createElement("div");
    addForm.className = "pt-add-form";
    const aLabel = Object.assign(document.createElement("input"), { className: "sb-form-input", placeholder: "Label" });
    const aAddr  = Object.assign(document.createElement("input"), { className: "sb-form-input", placeholder: "IP or URL" });
    const aGroup = Object.assign(document.createElement("input"), { className: "sb-form-input", placeholder: "Group (optional)" });
    aGroup.setAttribute("list", "pt-groups-datalist");
    const aBtn   = Object.assign(document.createElement("button"), { type: "button", className: "small primary", textContent: "Add" });
    aBtn.addEventListener("click", async () => {
      const label = aLabel.value.trim(), address = aAddr.value.trim();
      if (!label || !address) return;
      const t = await api.createPingTarget({ label, address, group: aGroup.value.trim() });
      pingTargets.push(t);
      aLabel.value = ""; aAddr.value = ""; aGroup.value = "";
      renderPingTargetsTab();
    });
    addForm.append(aLabel, aAddr, aGroup, aBtn);
    contentEl.appendChild(addForm);

    if (!pingTargets.length) return;

    // ── 3. Target table ─────────────────────────────────────────────────────
    const table = document.createElement("table");
    table.className = "ping-targets-table";
    table.innerHTML = "<thead><tr><th>Label</th><th>Address</th><th>Group</th><th></th></tr></thead>";
    const tbody = document.createElement("tbody");

    for (const t of sorted) {
      const tr = document.createElement("tr");
      let editing = false;

      const lblTd  = Object.assign(document.createElement("td"), { textContent: t.label });
      const addrTd = Object.assign(document.createElement("td"), { textContent: t.address });
      const grpTd  = Object.assign(document.createElement("td"), { textContent: t.group || "—" });
      const actTd  = document.createElement("td");
      actTd.className = "pt-actions";

      const editBtn = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Edit" });
      const delBtn  = Object.assign(document.createElement("button"), { type: "button", className: "small danger", textContent: "Del" });

      editBtn.addEventListener("click", () => {
        if (editing) return;
        editing = true;
        const mkInput = (val) => Object.assign(document.createElement("input"), { className: "sb-form-input", value: val || "" });
        const li = mkInput(t.label), ai = mkInput(t.address), gi = mkInput(t.group);
        gi.setAttribute("list", "pt-groups-datalist");
        lblTd.innerHTML  = ""; lblTd.appendChild(li);
        addrTd.innerHTML = ""; addrTd.appendChild(ai);
        grpTd.innerHTML  = ""; grpTd.appendChild(gi);
        const saveBtn = Object.assign(document.createElement("button"), { type: "button", className: "small primary", textContent: "Save" });
        saveBtn.addEventListener("click", async () => {
          const updated = await api.updatePingTarget(t.id, { label: li.value.trim(), address: ai.value.trim(), group: gi.value.trim() });
          const idx = pingTargets.findIndex((x) => x.id === t.id);
          if (idx >= 0) pingTargets[idx] = updated;
          renderPingTargetsTab();
        });
        actTd.innerHTML = ""; actTd.append(saveBtn);
      });

      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete "${t.label}"?`)) return;
        await api.deletePingTarget(t.id);
        pingTargets = pingTargets.filter((x) => x.id !== t.id);
        renderPingTargetsTab();
      });

      actTd.append(editBtn, delBtn);
      tr.append(lblTd, addrTd, grpTd, actTd);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    contentEl.appendChild(table);
  }

  // ── Users tab ────────────────────────────────────────────────────────────────
  async function renderUsersTab() {
    contentEl.innerHTML = "";
    let users = [];
    try { users = await api.listUsers(); } catch { contentEl.textContent = "Failed to load users."; return; }

    // Add user form
    const addSection = document.createElement("div");
    addSection.className = "settings-subsection";
    const addTitle = Object.assign(document.createElement("div"), { className: "settings-section-title", textContent: "Add User" });
    const addForm = document.createElement("div");
    addForm.className = "user-add-form";
    const unInput = Object.assign(document.createElement("input"), { type: "text", className: "sb-form-input", placeholder: "Username" });
    const pwInput = Object.assign(document.createElement("input"), { type: "password", className: "sb-form-input", placeholder: "Password (min 8 chars)" });
    const addBtn  = Object.assign(document.createElement("button"), { type: "button", className: "small primary", textContent: "Add user" });
    const addErr  = Object.assign(document.createElement("div"), { className: "modal-inline-error" });
    addBtn.addEventListener("click", async () => {
      addErr.textContent = "";
      const username = unInput.value.trim();
      const password = pwInput.value;
      if (!username) { addErr.textContent = "Username required."; return; }
      if (password.length < 8) { addErr.textContent = "Password must be at least 8 characters."; return; }
      try {
        addBtn.disabled = true;
        await api.createUser({ username, password });
        unInput.value = ""; pwInput.value = "";
        renderUsersTab();
      } catch (e) {
        addErr.textContent = e.message.includes("409") ? "Username already taken." : (e.message || "Failed.");
        addBtn.disabled = false;
      }
    });
    addForm.append(unInput, pwInput, addBtn, addErr);
    addSection.append(addTitle, addForm);
    contentEl.appendChild(addSection);

    // User list
    const listSection = document.createElement("div");
    listSection.className = "settings-subsection";
    const listTitle = Object.assign(document.createElement("div"), { className: "settings-section-title", textContent: "Users" });
    listSection.appendChild(listTitle);

    for (const u of users) {
      const row = document.createElement("div");
      row.className = "user-row";

      const nameEl = Object.assign(document.createElement("span"), { className: "user-row-name", textContent: u.username });
      if (u.is_default_password) {
        const warn = Object.assign(document.createElement("span"), { className: "user-default-pw-badge", textContent: "default password" });
        nameEl.appendChild(warn);
      }

      const actions = document.createElement("div");
      actions.className = "user-row-actions";

      // Change password
      const cpBtn = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Change password" });
      cpBtn.addEventListener("click", () => {
        const wrap = document.createElement("div");
        wrap.className = "user-pw-form";
        const newPw = Object.assign(document.createElement("input"), { type: "password", className: "sb-form-input", placeholder: "New password" });
        const saveBtn = Object.assign(document.createElement("button"), { type: "button", className: "small primary", textContent: "Save" });
        const cancelBtn = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Cancel" });
        const err2 = Object.assign(document.createElement("div"), { className: "modal-inline-error" });
        saveBtn.addEventListener("click", async () => {
          if (newPw.value.length < 8) { err2.textContent = "Min 8 chars."; return; }
          try {
            await api.updateUser(u.id, { password: newPw.value });
            renderUsersTab();
          } catch { err2.textContent = "Failed."; }
        });
        cancelBtn.addEventListener("click", () => renderUsersTab());
        wrap.append(newPw, saveBtn, cancelBtn, err2);
        row.replaceWith(wrap);
      });

      // Rename
      const renameBtn = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Rename" });
      renameBtn.addEventListener("click", () => {
        const wrap = document.createElement("div");
        wrap.className = "user-pw-form";
        const newName = Object.assign(document.createElement("input"), { type: "text", className: "sb-form-input", value: u.username });
        const saveBtn = Object.assign(document.createElement("button"), { type: "button", className: "small primary", textContent: "Save" });
        const cancelBtn = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Cancel" });
        const err2 = Object.assign(document.createElement("div"), { className: "modal-inline-error" });
        saveBtn.addEventListener("click", async () => {
          if (!newName.value.trim()) { err2.textContent = "Required."; return; }
          try {
            await api.updateUser(u.id, { username: newName.value.trim() });
            renderUsersTab();
          } catch (e) { err2.textContent = e.message.includes("409") ? "Taken." : "Failed."; }
        });
        cancelBtn.addEventListener("click", () => renderUsersTab());
        wrap.append(newName, saveBtn, cancelBtn, err2);
        row.replaceWith(wrap);
      });

      // Delete
      const delBtn = Object.assign(document.createElement("button"), { type: "button", className: "small danger", textContent: "Delete" });
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete user "${u.username}"?`)) return;
        try { await api.deleteUser(u.id); renderUsersTab(); }
        catch (e) { alert(e.message || "Failed to delete."); }
      });

      if (u.username !== "admin") {
        actions.append(renameBtn);
      }
      actions.append(cpBtn);
      if (u.username !== "admin") {
        actions.append(delBtn);
      }
      row.append(nameEl, actions);
      listSection.appendChild(row);
    }

    contentEl.appendChild(listSection);
  }

  // ── Designer tab ────────────────────────────────────────────────────────────
  function renderDesignerTab() {
    contentEl.style.padding = "0";
    contentEl.style.overflow = "hidden";
    contentEl.style.display = "block";

    const layout = document.createElement("div");
    layout.className = "designer-layout";

    // ── Left: preview pane ────────────────────────────────────────────────────
    const previewPane = document.createElement("div");
    previewPane.className = "designer-preview-pane";
    const previewBoard = document.createElement("div");
    previewBoard.className = "designer-preview-board";
    previewBoard.style.backgroundColor = currentCardSettings.board_bg_color || "#060912";
    const previewScope = document.createElement("div");
    previewScope.className = "designer-preview-scope";
    previewScope.id = "designer-preview-scope";
    previewScope.innerHTML = `
    <div class="layout-stack-card" style="position:absolute;inset:0;width:100%;height:100%;">
      <div class="widget">
        <div class="widget-head">
          <span class="widget-title">Network Status</span>
        </div>
        <div class="widget-body">
          <div class="w-ping" style="display:flex;flex-direction:column;gap:8px;">
            <div class="ping-row" style="display:flex;align-items:center;gap:8px;">
              <span style="width:9px;height:9px;border-radius:50%;background:#22c55e;flex-shrink:0;display:inline-block;"></span>
              <span class="ping-label" style="flex:1;font-size:13px;">router.local</span>
              <span class="ping-meta" style="font-size:12px;">0.8 ms</span>
            </div>
            <div class="ping-row" style="display:flex;align-items:center;gap:8px;">
              <span style="width:9px;height:9px;border-radius:50%;background:#22c55e;flex-shrink:0;display:inline-block;"></span>
              <span class="ping-label" style="flex:1;font-size:13px;">homelab.local</span>
              <span class="ping-meta" style="font-size:12px;">1.2 ms</span>
            </div>
            <div class="ping-row" style="display:flex;align-items:center;gap:8px;">
              <span style="width:9px;height:9px;border-radius:50%;background:#ef4444;flex-shrink:0;display:inline-block;"></span>
              <span class="ping-label" style="flex:1;font-size:13px;">backup.local</span>
              <span style="font-size:12px;color:#ef4444;">—</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;
    previewBoard.appendChild(previewScope);
    previewPane.appendChild(previewBoard);
    layout.appendChild(previewPane);

    // ── Right: controls pane ──────────────────────────────────────────────────
    const controlsPane = document.createElement("div");
    controlsPane.className = "designer-controls-pane";
    layout.appendChild(controlsPane);
    contentEl.appendChild(layout);

    // ── State ─────────────────────────────────────────────────────────────────
    const st = { ...currentCardSettings };
    const theme = { ...currentTheme };
    let presets = [];
    try { presets = JSON.parse(currentCardSettings.card_presets || "[]"); } catch (_) {}

    const applyToPreview = () => {
      st.theme_style = theme.style;
      applyCardStyle(st, previewScope);
      applyCardStyle(st, byId("preview-viewport"));
      applyTheme(theme, byId("preview-viewport"));
      applyTheme(theme, previewScope);
      for (const sec of controlsPane.querySelectorAll(".ds-colors")) sec.classList.toggle("is-owned", OWNING_STYLES.has(theme.style));
      byId("preview-viewport").style.setProperty("--widget-font-scale", st.widget_font_scale || "1");
    };

    let _saveTimer = null;
    const saveSettings = () => {
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(() => {
        api.updateSettings({
          theme_style: theme.style, theme_font: theme.font, theme_shape: theme.shape || "theme", theme_pattern: theme.pattern || "none",
          card_bg_color: st.card_bg_color, card_bg_opacity: String(st.card_bg_opacity),
          card_gradient: String(st.card_gradient), card_bg2_color: st.card_bg2_color,
          card_bg2_opacity: String(st.card_bg2_opacity), card_gradient_dir: String(st.card_gradient_dir),
          card_stroke_color: st.card_stroke_color, card_stroke_opacity: String(st.card_stroke_opacity),
          card_stroke_width: String(st.card_stroke_width),
          card_accent_color: st.card_accent_color, card_accent_opacity: String(st.card_accent_opacity),
          card_accent_width: String(st.card_accent_width),
          card_glow: String(st.card_glow), card_glow_color: st.card_glow_color,
          card_glow_opacity: String(st.card_glow_opacity), card_glow_size: String(st.card_glow_size),
          card_presets: JSON.stringify(presets),
          board_bg_color: st.board_bg_color,
          widget_font_scale: String(st.widget_font_scale || "1"),
        }).then(() => {
          Object.assign(currentCardSettings, st, { card_presets: JSON.stringify(presets) });
          Object.assign(currentTheme, theme);
        });
      }, 500);
    };

    const update = () => { applyToPreview(); saveSettings(); };

    // ── buildControls: clears and rebuilds the controls pane ─────────────────
    let galSec = null;
    const buildControls = () => {
      controlsPane.innerHTML = "";

      // ── Helper: color swatch button ───────────────────────────────────────
      function makeColorBtn(hex, onHexChange) {
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "ds-color-btn";
        btn.style.background = hex;
        const inp = document.createElement("input");
        inp.type = "color"; inp.value = hex;
        inp.addEventListener("input", () => { btn.style.background = inp.value; onHexChange(inp.value); });
        btn.appendChild(inp);
        return btn;
      }

      // ── Helper: slider with filled track ──────────────────────────────────
      function makeSlider(val, min, max, step, unit, onVal) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;align-items:center;gap:6px;flex:1;";
        // Shell holds the custom track and the transparent range input stacked
        const shell = document.createElement("div");
        shell.className = "ds-slider-shell";
        // Track inset by 7px (thumb radius) on each side — fill % is now exact
        const trackBg = document.createElement("div");
        trackBg.className = "ds-track-bg";
        const trackFill = document.createElement("div");
        trackFill.className = "ds-track-fill";
        trackBg.appendChild(trackFill);
        const sl = document.createElement("input");
        sl.type = "range"; sl.min = min; sl.max = max; sl.step = step;
        sl.value = val; sl.className = "ds-slider";
        shell.append(trackBg, sl);
        const lbl = Object.assign(document.createElement("span"), {
          className: "ds-slider-val", textContent: parseFloat(val) + unit
        });
        function updateFill() {
          const frac = (parseFloat(sl.value) - parseFloat(min)) / (parseFloat(max) - parseFloat(min));
          trackFill.style.width = (frac * 100).toFixed(2) + "%";
        }
        updateFill();
        sl.addEventListener("input", () => { updateFill(); lbl.textContent = sl.value + unit; onVal(sl.value); });
        wrap.append(shell, lbl);
        return wrap;
      }

      // ── Helper: row with label ─────────────────────────────────────────────
      function makeRow(labelText, ...children) {
        const row = document.createElement("div");
        row.className = "ds-row";
        row.appendChild(Object.assign(document.createElement("span"), { className: "ds-row-label", textContent: labelText }));
        for (const c of children) row.appendChild(c);
        return row;
      }

      // ── Helper: toggle row ─────────────────────────────────────────────────
      function makeToggleRow(labelText, checked, onToggle) {
        const row = document.createElement("div");
        row.className = "ds-row ds-toggle-row";
        const tog = document.createElement("input");
        tog.type = "checkbox"; tog.className = "ds-toggle"; tog.checked = checked;
        tog.addEventListener("change", () => onToggle(tog.checked));
        row.append(tog, Object.assign(document.createElement("span"), { className: "ds-row-label", textContent: labelText }));
        return { row, tog };
      }

      // ── Display theme gallery (thumbnails of the current page) ────────────
      // Built once per Designer opening: each thumbnail is a full copy of the
      // page, far too heavy to rebuild on every click.
      if (!galSec) {
        galSec = document.createElement("div");
        galSec.className = "ds-section";
        galSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Display theme" }));
        const gal = document.createElement("div");
        gal.className = "ds-gallery";
        for (const dt of DISPLAY_THEMES) {
          const preset = THEME_PRESETS.find((p) => p.key === dt.preset) || {};
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ds-gallery-card";
          b._isActive = () => theme.style === dt.style && st.card_bg_color === preset.card_bg_color && st.card_accent_color === preset.card_accent_color;
          b.append(designerThumb(dt, preset), Object.assign(document.createElement("b"), { textContent: dt.label }),
            Object.assign(document.createElement("small"), { textContent: dt.blurb }));
          b.addEventListener("click", () => {
            const { key, label, accent, ...cardFields } = preset;
            Object.assign(st, cardFields, { board_bg_color: dt.board_bg_color });
            theme.style = dt.style; theme.font = dt.font; theme.shape = "theme"; theme.pattern = "none";
            previewBoard.style.backgroundColor = dt.board_bg_color;
            byId("preview-viewport").style.backgroundColor = dt.board_bg_color;
            update();
            buildControls();
          });
          gal.appendChild(b);
        }
        galSec.appendChild(gal);
      }
      for (const b of galSec.querySelectorAll(".ds-gallery-card")) b.classList.toggle("active", b._isActive());
      controlsPane.appendChild(galSec);

      // ── Board Background section ──────────────────────────────────────────
      const boardSec = document.createElement("div");
      boardSec.className = "ds-section";
      boardSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Board Background" }));
      boardSec.appendChild(makeRow("Color", makeColorBtn(st.board_bg_color || "#060912", v => {
        st.board_bg_color = v;
        previewBoard.style.backgroundColor = v;
        const vp = byId("preview-viewport");
        if (vp) vp.style.backgroundColor = v;
        update();
      })));
      controlsPane.appendChild(boardSec);

      // ── Themes section ────────────────────────────────────────────────────
      const themeSec = document.createElement("div");
      themeSec.className = "ds-section";
      themeSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Theme Presets" }));
      const themeGrid = document.createElement("div");
      themeGrid.className = "ds-theme-grid";
      for (const tp of THEME_PRESETS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ds-theme-btn";
        const isActive = st.card_bg_color === tp.card_bg_color && st.card_accent_color === tp.card_accent_color;
        if (isActive) btn.classList.add("active");
        const dot = Object.assign(document.createElement("span"), { className: "ds-theme-dot" });
        dot.style.background = tp.accent;
        btn.appendChild(dot);
        btn.appendChild(document.createTextNode(tp.label));
        btn.addEventListener("click", () => {
          const { key, label, accent, ...cardFields } = tp;
          Object.assign(st, cardFields);
          update();
          buildControls();
        });
        themeGrid.appendChild(btn);
      }
      themeSec.appendChild(themeGrid);
      controlsPane.appendChild(themeSec);

      // ── User presets section (only shown if presets exist) ─────────────────
      if (presets.length > 0) {
        const presetSec = document.createElement("div");
        presetSec.className = "ds-section";
        presetSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "My Presets" }));
        const presetGrid = document.createElement("div");
        presetGrid.className = "ds-preset-grid";
        for (let i = 0; i < presets.length; i++) {
          const p = presets[i];
          const pbtn = document.createElement("button");
          pbtn.type = "button"; pbtn.className = "ds-preset-btn";
          pbtn.appendChild(document.createTextNode(p.name));
          pbtn.addEventListener("click", () => {
            const { name, ...cardFields } = p;
            Object.assign(st, cardFields);
            update();
            buildControls();
          });
          const del = Object.assign(document.createElement("button"), { type: "button", className: "ds-preset-del", textContent: "✕" });
          del.title = "Delete preset";
          del.addEventListener("click", (e) => {
            e.stopPropagation();
            presets.splice(i, 1);
            saveSettings();
            buildControls();
          });
          pbtn.appendChild(del);
          presetGrid.appendChild(pbtn);
        }
        presetSec.appendChild(presetGrid);
        controlsPane.appendChild(presetSec);
      }

      // ── Style picker ──────────────────────────────────────────────────────
      const styleSec = document.createElement("div");
      styleSec.className = "ds-section";
      styleSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Base style (uses the colors below)" }));
      const styleGrid = document.createElement("div");
      styleGrid.className = "ds-style-grid";
      for (const s of STYLES.filter((x) => !OWNING_STYLES.has(x.key))) {
        const btn = Object.assign(document.createElement("button"), {
          type: "button",
          className: "ds-style-btn" + (theme.style === s.key ? " active" : ""),
          textContent: s.label
        });
        btn.dataset.key = s.key;
        btn.addEventListener("click", () => {
          theme.style = s.key;
          for (const b of styleGrid.querySelectorAll(".ds-style-btn")) b.classList.toggle("active", b.dataset.key === s.key);
          update();
        });
        styleGrid.appendChild(btn);
      }
      styleSec.appendChild(styleGrid);
      controlsPane.appendChild(styleSec);

      // ── Card shape + surface pattern (mix with any theme) ─────────────────
      const swatchSection = (label, items, current, key) => {
        const sec = document.createElement("div");
        sec.className = "ds-section";
        sec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: label }));
        const gridEl = document.createElement("div");
        gridEl.className = "ds-swatch-grid";
        for (const it of items) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ds-swatch" + (current === it.key ? " active" : "");
          b.title = it.blurb || it.label;
          const demo = document.createElement("div");
          demo.className = "ds-swatch-demo";
          demo.dataset.style = "classic";
          if (key === "shape") demo.dataset.shape = it.key === "theme" ? "soft" : it.key;
          else demo.dataset.pattern = it.key;
          demo.appendChild(Object.assign(document.createElement("div"), { className: "stack-cell" }));
          b.append(demo, document.createTextNode(it.label));
          b.addEventListener("click", () => { theme[key] = it.key; update(); buildControls(); });
          gridEl.appendChild(b);
        }
        sec.appendChild(gridEl);
        return sec;
      };
      controlsPane.appendChild(swatchSection("Card shape", SHAPES, theme.shape || "theme", "shape"));
      controlsPane.appendChild(swatchSection("Surface pattern", PATTERNS, theme.pattern || "none", "pattern"));

      // ── Font picker ───────────────────────────────────────────────────────
      const fontSec = document.createElement("div");
      fontSec.className = "ds-section";
      fontSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Font" }));
      const fontSel = document.createElement("select");
      fontSel.className = "ds-font-select";
      for (const f of FONTS) {
        const opt = Object.assign(document.createElement("option"), { value: f.key, textContent: f.label });
        if (f.key === theme.font) opt.selected = true;
        fontSel.appendChild(opt);
      }
      fontSel.addEventListener("change", () => { theme.font = fontSel.value; update(); });
      fontSec.appendChild(fontSel);
      controlsPane.appendChild(fontSec);

      // ── Widget Scale ──────────────────────────────────────────────────────
      const scaleSec = document.createElement("div");
      scaleSec.className = "ds-section";
      scaleSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Widget Scale" }));
      const scaleRow = document.createElement("div");
      scaleRow.className = "ds-scale-row";
      const scaleVal = parseFloat(st.widget_font_scale || "1");
      const scaleSlider = Object.assign(document.createElement("input"), {
        type: "range", min: "0.75", max: "2", step: "0.05",
        value: String(scaleVal), className: "ds-scale-slider",
      });
      const scaleLabel = Object.assign(document.createElement("span"), {
        className: "ds-scale-label", textContent: Math.round(scaleVal * 100) + "%",
      });
      scaleSlider.addEventListener("input", () => {
        const v = scaleSlider.value;
        scaleLabel.textContent = Math.round(parseFloat(v) * 100) + "%";
        st.widget_font_scale = v;
        update();
      });
      scaleRow.appendChild(scaleSlider);
      scaleRow.appendChild(scaleLabel);
      scaleSec.appendChild(scaleRow);
      controlsPane.appendChild(scaleSec);

      if (OWNING_STYLES.has(theme.style)) {
        controlsPane.appendChild(Object.assign(document.createElement("p"), { className: "ds-owned-note",
          textContent: "This display theme draws its own cards, so the color controls below are off. Pick Classic, Obsidian, Carbon, Nord or Light to use them." }));
      }

      // ── Background section ────────────────────────────────────────────────
      const bgSec = document.createElement("div");
      bgSec.className = "ds-section ds-colors" + (OWNING_STYLES.has(theme.style) ? " is-owned" : "");
      bgSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Background" }));
      bgSec.appendChild(makeRow("Color",
        makeColorBtn(st.card_bg_color || "#171c24", v => { st.card_bg_color = v; update(); }),
        makeSlider(Math.round((st.card_bg_opacity ?? 1) * 100), 0, 100, 1, "%",
          v => { st.card_bg_opacity = parseFloat(v) / 100; update(); })
      ));
      const { row: gradRow, tog: gradTog } = makeToggleRow("Gradient", st.card_gradient === "true", checked => {
        st.card_gradient = String(checked);
        gradSub.classList.toggle("hidden", !checked);
        update();
      });
      bgSec.appendChild(gradRow);
      const gradSub = document.createElement("div");
      gradSub.className = "ds-sub-controls" + (st.card_gradient === "true" ? "" : " hidden");
      gradSub.appendChild(makeRow("2nd color",
        makeColorBtn(st.card_bg2_color || "#0e1116", v => { st.card_bg2_color = v; update(); }),
        makeSlider(Math.round((st.card_bg2_opacity ?? 0) * 100), 0, 100, 1, "%",
          v => { st.card_bg2_opacity = parseFloat(v) / 100; update(); })
      ));
      gradSub.appendChild(makeRow("Direction",
        makeSlider(st.card_gradient_dir ?? 180, 0, 360, 1, "°",
          v => { st.card_gradient_dir = v; update(); })
      ));
      bgSec.appendChild(gradSub);
      controlsPane.appendChild(bgSec);

      // ── Border section ────────────────────────────────────────────────────
      const borderSec = document.createElement("div");
      borderSec.className = "ds-section ds-colors" + (OWNING_STYLES.has(theme.style) ? " is-owned" : "");
      borderSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Border" }));
      borderSec.appendChild(makeRow("Color",
        makeColorBtn(st.card_stroke_color || "#2b3a50", v => { st.card_stroke_color = v; update(); }),
        makeSlider(Math.round((st.card_stroke_opacity ?? 1) * 100), 0, 100, 1, "%",
          v => { st.card_stroke_opacity = parseFloat(v) / 100; update(); })
      ));
      borderSec.appendChild(makeRow("Width",
        makeSlider(st.card_stroke_width ?? 1, 0, 6, 1, "px",
          v => { st.card_stroke_width = parseInt(v); update(); })
      ));
      controlsPane.appendChild(borderSec);

      // ── Accent section ────────────────────────────────────────────────────
      const accentSec = document.createElement("div");
      accentSec.className = "ds-section ds-colors" + (OWNING_STYLES.has(theme.style) ? " is-owned" : "");
      accentSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Left Accent" }));
      accentSec.appendChild(makeRow("Color",
        makeColorBtn(st.card_accent_color || "#3b82f6", v => { st.card_accent_color = v; update(); }),
        makeSlider(Math.round((st.card_accent_opacity ?? 1) * 100), 0, 100, 1, "%",
          v => { st.card_accent_opacity = parseFloat(v) / 100; update(); })
      ));
      accentSec.appendChild(makeRow("Width",
        makeSlider(st.card_accent_width ?? 3, 0, 8, 1, "px",
          v => { st.card_accent_width = parseInt(v); update(); })
      ));
      controlsPane.appendChild(accentSec);

      // ── Glow section ──────────────────────────────────────────────────────
      const glowSec = document.createElement("div");
      glowSec.className = "ds-section ds-colors" + (OWNING_STYLES.has(theme.style) ? " is-owned" : "");
      glowSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Glow" }));
      const { row: glowRow } = makeToggleRow("Enable glow", st.card_glow === "true", checked => {
        st.card_glow = String(checked);
        glowSub.classList.toggle("hidden", !checked);
        update();
      });
      glowSec.appendChild(glowRow);
      const glowSub = document.createElement("div");
      glowSub.className = "ds-sub-controls" + (st.card_glow === "true" ? "" : " hidden");
      glowSub.appendChild(makeRow("Color",
        makeColorBtn(st.card_glow_color || "#3b82f6", v => { st.card_glow_color = v; update(); }),
        makeSlider(Math.round((st.card_glow_opacity ?? 0.3) * 100), 0, 100, 1, "%",
          v => { st.card_glow_opacity = parseFloat(v) / 100; update(); })
      ));
      glowSub.appendChild(makeRow("Size",
        makeSlider(st.card_glow_size ?? 12, 0, 40, 1, "px",
          v => { st.card_glow_size = parseInt(v); update(); })
      ));
      glowSec.appendChild(glowSub);
      controlsPane.appendChild(glowSec);

      // ── Widget content theme ──────────────────────────────────────────────
      const widgetThemeSec = document.createElement("div");
      widgetThemeSec.className = "ds-section";
      widgetThemeSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Widget Content" }));
      const allLight = widgets.every(w => w.config?.widget_theme === "light");
      const { row: wtRow, tog: wtTog } = makeToggleRow("Light mode (all widgets)", allLight, async (checked) => {
        // Update preview card
        const pw = previewScope.querySelector(".widget");
        if (pw) pw.classList.toggle("widget--light", checked);
        // Update every widget in memory and persist
        for (const w of widgets) {
          w.config = { ...(w.config || {}), widget_theme: checked ? "light" : "dark" };
          await api.updateWidget(w.id, {
            title: w.title, type: w.type, config: w.config,
            interval: w.interval, data_source_id: w.data_source_id,
          }).catch(console.warn);
        }
        // Re-render all live cards in the editor viewport to reflect the change
        refreshGridCards();
      });
      widgetThemeSec.appendChild(wtRow);
      controlsPane.appendChild(widgetThemeSec);

      // ── Contextual tips section ───────────────────────────────────────────
      const tipsSec = document.createElement("div");
      tipsSec.className = "ds-section";
      tipsSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Contextual Tips" }));
      const { row: tipsRow } = makeToggleRow("Show hover tips on UI elements", document.body.classList.contains("tips-on"), (checked) => {
        setTipsEnabled(checked);
      });
      tipsSec.appendChild(tipsRow);
      controlsPane.appendChild(tipsSec);

      // ── Save preset section ───────────────────────────────────────────────
      const saveSec = document.createElement("div");
      saveSec.className = "ds-section";
      saveSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Save as Preset" }));
      const saveRow = document.createElement("div");
      saveRow.className = "ds-save-row";
      const nameInput = Object.assign(document.createElement("input"), {
        type: "text", className: "ds-preset-name-input", placeholder: "Preset name…"
      });
      const saveBtn = Object.assign(document.createElement("button"), {
        type: "button", className: "ds-save-btn", textContent: "Save"
      });
      saveBtn.addEventListener("click", () => {
        const name = nameInput.value.trim();
        if (!name) return;
        presets.push({ name, ...st });
        nameInput.value = "";
        saveSettings();
        buildControls();
      });
      saveRow.append(nameInput, saveBtn);
      saveSec.appendChild(saveRow);
      controlsPane.appendChild(saveSec);
    }; // end buildControls

    buildControls();
    applyToPreview();
  }

  dlg.showModal();
  _makeDraggable(dlg, head);

  if (section === "Editor") { titleEl.textContent = "Editor preferences"; renderEditorPrefs(contentEl); }
  else if (section === "Notifications") { titleEl.textContent = "Alerts & notifications"; renderNotificationsTab(contentEl); }
  else if (section === "Profiles") renderProfilesTab();
  else if (section === "Ping Targets") renderPingTargetsTab();
  else if (section === "Users") renderUsersTab();
  else if (section === "Integrations") renderIntegrationsTab();
  else if (section === "Designer") renderDesignerTab();
  else if (section === "Backup") renderBackupTab();

  // ── Backup / Restore tab ──────────────────────────────────────────────────
  function renderBackupTab() {
    contentEl.innerHTML = "";

    const intro = Object.assign(document.createElement("p"), {
      className: "settings-ds-hint",
      textContent: "Migrate your board, stacks, widgets, ping targets, integrations, and settings to another server. The file is encrypted with a passphrase you choose - your integration API keys are never stored in plaintext.",
    });
    contentEl.appendChild(intro);

    // ── Export ────────────────────────────────────────────────────────────
    const exportSec = document.createElement("div");
    exportSec.className = "settings-form-wrap";
    exportSec.appendChild(Object.assign(document.createElement("div"),
      { className: "settings-edit-type-lbl", textContent: "Export backup" }));

    const expPass = Object.assign(document.createElement("input"), {
      className: "sb-form-input", type: "password", placeholder: "Choose a passphrase to encrypt the backup",
    });
    exportSec.appendChild(makeSbRow("Passphrase", expPass));

    const expErr = Object.assign(document.createElement("div"), { className: "settings-form-error hidden" });
    exportSec.appendChild(expErr);

    const expBtn = Object.assign(document.createElement("button"),
      { type: "button", className: "small primary", textContent: "Download backup" });
    expBtn.addEventListener("click", async () => {
      expErr.classList.add("hidden");
      const pass = expPass.value;
      if (pass.length < 6) { expErr.textContent = "Use a passphrase of at least 6 characters."; expErr.classList.remove("hidden"); return; }
      expBtn.disabled = true; expBtn.textContent = "Preparing…";
      try {
        const envelope = await api.exportBackup(pass);
        const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), {
          href: url, download: `touchboard-backup-${new Date().toISOString().slice(0,10)}.tbk`,
        });
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        expBtn.textContent = "Downloaded ✓";
        setTimeout(() => { expBtn.disabled = false; expBtn.textContent = "Download backup"; }, 2000);
      } catch (e) {
        expErr.textContent = e.message || "Export failed."; expErr.classList.remove("hidden");
        expBtn.disabled = false; expBtn.textContent = "Download backup";
      }
    });
    const expFooter = Object.assign(document.createElement("div"), { className: "settings-form-footer" });
    expFooter.appendChild(expBtn);
    exportSec.appendChild(expFooter);
    contentEl.appendChild(exportSec);

    // ── Import ────────────────────────────────────────────────────────────
    const importSec = document.createElement("div");
    importSec.className = "settings-form-wrap";
    importSec.style.marginTop = "14px";
    importSec.appendChild(Object.assign(document.createElement("div"),
      { className: "settings-edit-type-lbl", textContent: "Restore backup" }));
    importSec.appendChild(Object.assign(document.createElement("div"), {
      className: "settings-ds-hint",
      textContent: "Restoring replaces ALL current board config with the contents of the backup file.",
    }));

    const fileInput = Object.assign(document.createElement("input"), {
      className: "sb-form-input", type: "file", accept: ".tbk,.json,application/json",
    });
    importSec.appendChild(makeSbRow("Backup file", fileInput));

    const impPass = Object.assign(document.createElement("input"), {
      className: "sb-form-input", type: "password", placeholder: "Passphrase used when the backup was created",
    });
    importSec.appendChild(makeSbRow("Passphrase", impPass));

    const impErr = Object.assign(document.createElement("div"), { className: "settings-form-error hidden" });
    importSec.appendChild(impErr);

    const impBtn = Object.assign(document.createElement("button"),
      { type: "button", className: "small primary", textContent: "Restore from backup" });
    impBtn.addEventListener("click", async () => {
      impErr.classList.add("hidden");
      const file = fileInput.files?.[0];
      if (!file) { impErr.textContent = "Choose a backup file first."; impErr.classList.remove("hidden"); return; }
      if (!impPass.value) { impErr.textContent = "Enter the backup passphrase."; impErr.classList.remove("hidden"); return; }
      if (!confirm("This will REPLACE all current board config with the backup. Continue?")) return;
      impBtn.disabled = true; impBtn.textContent = "Restoring…";
      try {
        const envelope = JSON.parse(await file.text());
        await api.importBackup(envelope, impPass.value);
        impBtn.textContent = "Restored ✓ — reloading…";
        setTimeout(() => window.location.reload(), 800);
      } catch (e) {
        impErr.textContent = e.message?.includes("400")
          ? "Incorrect passphrase or invalid backup file."
          : (e.message || "Restore failed.");
        impErr.classList.remove("hidden");
        impBtn.disabled = false; impBtn.textContent = "Restore from backup";
      }
    });
    const impFooter = Object.assign(document.createElement("div"), { className: "settings-form-footer" });
    impFooter.appendChild(impBtn);
    importSec.appendChild(impFooter);
    contentEl.appendChild(importSec);
  }
}

// ── boot ──────────────────────────────────────────────────────────────────────

async function loadPingTargets() {
  try { pingTargets = await api.listPingTargets(); } catch { pingTargets = []; }
}

// ── Global wheel handler for editor widget cards ───────────────────────────
// Runs at capture phase (fires before GridStack) to scroll inner widget
// content (ww-body, nb-body, etc.) and flip multi-widget stack pages.
document.addEventListener("wheel", (e) => {
  if (!grid) return;
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;

  // Must be inside a placed card (anywhere: widget area or pag bar)
  const card = target.closest(".layout-stack-card");
  if (!card) return;

  // Helper: walk up from event target to card checking for un-exhausted scroll
  const _hasInternalScroll = (from, boundary) => {
    let el = from;
    while (el && el !== boundary) {
      if (el.scrollHeight > el.clientHeight + 2) {
        const atTop    = el.scrollTop <= 0;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        if (!((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom))) return true;
        break;
      }
      el = el.parentElement;
    }
    return false;
  };

  // Multi-widget stack pages
  if (card._navigatePage) {
    const pagBar   = card.querySelector(".lc-pag-bar");
    const stackDots = pagBar ? [...pagBar.querySelectorAll(".lc-pag-dot")] : [];
    if (stackDots.length > 1) {
      if (_hasInternalScroll(e.target, card)) return;
      e.preventDefault();
      e.stopPropagation();
      card._navigatePage(e.deltaY > 0 ? 1 : -1);
      return;
    }
  }

  // Within-widget view pages (TrueNAS, weather, netbox — ww-view-dots)
  const viewDotsBar = card.querySelector(".ww-view-dots");
  if (viewDotsBar) {
    const viewDots = [...viewDotsBar.querySelectorAll(".lc-pag-dot")];
    if (viewDots.length > 1) {
      if (_hasInternalScroll(e.target, card)) return;
      e.preventDefault();
      e.stopPropagation();
      const activeIdx = viewDots.findIndex((d) => d.classList.contains("active"));
      const newIdx = e.deltaY > 0
        ? Math.min(viewDots.length - 1, activeIdx + 1)
        : Math.max(0, activeIdx - 1);
      if (newIdx !== activeIdx) viewDots[newIdx].click();
      return;
    }
  }

  // Single widget: only handle scroll if cursor is inside the widget area
  const area = target.closest(".layout-widget-area");
  if (!area) return;

  let scrollEl = target;
  while (scrollEl && scrollEl !== area.parentElement) {
    if (scrollEl.scrollHeight > scrollEl.clientHeight + 2) break;
    scrollEl = scrollEl.parentElement;
  }
  if (!scrollEl || scrollEl === area.parentElement) scrollEl = area;
  if (scrollEl.scrollHeight <= scrollEl.clientHeight + 2) return;

  const atTop    = scrollEl.scrollTop <= 0;
  const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2;
  if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) return;

  e.preventDefault();
  e.stopPropagation();
  const delta = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
  scrollEl.scrollTop += delta;
}, { capture: true, passive: false });

async function showChangePasswordModal() {
  return new Promise((resolve) => {
    const dlg = byId("settings-modal");
    dlg.innerHTML = "";

    const head = document.createElement("div");
    head.className = "modal-head";
    const h2 = Object.assign(document.createElement("h2"), { textContent: "Change Default Password" });
    head.appendChild(h2);
    dlg.appendChild(head);

    const body = document.createElement("div");
    body.className = "modal-body";

    const notice = document.createElement("div");
    notice.className = "change-pw-notice";
    notice.textContent = "You're using the default admin password. Please set a new password before continuing.";
    body.appendChild(notice);

    const newPwInput   = Object.assign(document.createElement("input"), { type: "password", className: "sb-form-input", placeholder: "New password (min 8 chars)" });
    const confirmInput = Object.assign(document.createElement("input"), { type: "password", className: "sb-form-input", placeholder: "Confirm new password" });
    const errEl = Object.assign(document.createElement("div"), { className: "modal-inline-error" });

    body.append(
      makeSbRow("New password", newPwInput),
      makeSbRow("Confirm", confirmInput),
      errEl,
    );
    dlg.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const saveBtn = Object.assign(document.createElement("button"), { type: "button", className: "small primary", textContent: "Set password" });
    saveBtn.addEventListener("click", async () => {
      errEl.textContent = "";
      const np = newPwInput.value;
      if (np.length < 8)         { errEl.textContent = "Password must be at least 8 characters."; return; }
      if (np !== confirmInput.value) { errEl.textContent = "Passwords do not match."; return; }
      try {
        saveBtn.disabled = true; saveBtn.textContent = "Saving…";
        await api.changePassword("admin@touchboard", np);
        dlg.close();
        resolve();
      } catch (e) {
        errEl.textContent = e.message || "Failed to change password.";
        saveBtn.disabled = false; saveBtn.textContent = "Set password";
      }
    });
    footer.appendChild(saveBtn);
    dlg.appendChild(footer);

    dlg.addEventListener("cancel", (e) => e.preventDefault(), { once: true });
    dlg.showModal();
  });
}

function showOnboarding(settings) {
  const TOTAL = 5;
  let slide = 0;
  let tipsEnabled = true;
  let dontShowAgain = true;
  let pwDone = settings.is_default_password === false || settings.is_default_password === "false" || settings.is_default_password === 0;

  const dlg = document.createElement("dialog");
  dlg.className = "onboarding-modal";
  document.body.appendChild(dlg);
  dlg.addEventListener("cancel", e => e.preventDefault()); // block Escape key close

  function finish() {
    api.updateSettings({
      onboarding_done: dontShowAgain ? "true" : "false",
      tips_enabled: tipsEnabled ? "true" : "false",
    }).catch(() => {});
    dlg.close();
    dlg.remove();
  }

  function icon(svg) {
    const w = document.createElement("div");
    w.className = "ob-icon"; w.innerHTML = svg; return w;
  }

  const ICONS = {
    welcome: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/><path d="M9 21V12h6v9"/></svg>`,
    lock:    `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/><circle cx="12" cy="16" r="1" fill="currentColor"/></svg>`,
    compass: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" fill="rgba(59,130,246,0.2)" stroke="currentColor"/></svg>`,
    bulb:    `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21h6M12 3a6 6 0 016 6c0 2.5-1.5 4.5-3 5.5V17a1 1 0 01-1 1h-4a1 1 0 01-1-1v-2.5C7.5 13.5 6 11.5 6 9a6 6 0 016-6z"/></svg>`,
    rocket:  `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C12 2 8 6 8 12c0 2 .5 3.5 1 4.5L7 21l4-2h2l4 2-2-4.5c.5-1 1-2.5 1-4.5 0-6-4-10-4-10z"/><path d="M8 12H5l-2 3 3 1M16 12h3l2 3-3 1"/><circle cx="12" cy="10" r="1.5" fill="currentColor"/></svg>`,
  };

  function render() {
    dlg.innerHTML = "";
    const inner = document.createElement("div");
    inner.className = "ob-inner";

    // Progress dots
    const prog = document.createElement("div");
    prog.className = "ob-progress";
    for (let i = 0; i < TOTAL; i++) {
      const d = document.createElement("div");
      d.className = "ob-dot" + (i === slide ? " active" : i < slide ? " done" : "");
      prog.appendChild(d);
    }
    inner.appendChild(prog);

    // Slide content
    const slideEl = document.createElement("div");
    slideEl.className = "ob-slide";

    if (slide === 0) {
      const logoImg = document.createElement("img");
      logoImg.src = "/static/img/logo.png?v=3"; logoImg.alt = "TouchBoard";
      logoImg.className = "ob-logo-img";
      slideEl.appendChild(logoImg);
      slideEl.appendChild(Object.assign(document.createElement("h2"), { className: "ob-title", textContent: "Welcome to TouchBoard" }));
      slideEl.appendChild(Object.assign(document.createElement("p"), { className: "ob-body", textContent: "TouchBoard is a personal dashboard built for home labs and self-hosted infrastructure, designed with touchscreens in mind. Use it to monitor host and service availability, infrastructure metrics, and keep an eye on everything that matters in your network." }));
    }

    else if (slide === 1) {
      slideEl.appendChild(icon(ICONS.lock));
      slideEl.appendChild(Object.assign(document.createElement("h2"), { className: "ob-title", textContent: "Secure Your Account" }));
      slideEl.appendChild(Object.assign(document.createElement("p"), { className: "ob-body", textContent: "You're using the default admin password. We recommend changing it before continuing." }));

      if (pwDone) {
        const ok = document.createElement("div");
        ok.className = "ob-pw-done";
        ok.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Password already updated`;
        slideEl.appendChild(ok);
      } else {
        const form = document.createElement("div");
        form.className = "ob-pw-form";
        const cur  = Object.assign(document.createElement("input"), { type: "password", placeholder: "Current password" });
        const nw   = Object.assign(document.createElement("input"), { type: "password", placeholder: "New password" });
        const cnf  = Object.assign(document.createElement("input"), { type: "password", placeholder: "Confirm new password" });
        const msg  = Object.assign(document.createElement("div"), { className: "ob-pw-msg" });
        const chg  = Object.assign(document.createElement("button"), { type: "button", className: "ob-pw-change-btn", textContent: "Change Password" });
        const skip = Object.assign(document.createElement("div"), { className: "ob-pw-skip", textContent: "Skip for now →" });
        chg.addEventListener("click", async () => {
          msg.className = "ob-pw-msg"; msg.textContent = "";
          if (!cur.value || !nw.value) { msg.className = "ob-pw-msg err"; msg.textContent = "Please fill in all fields."; return; }
          if (nw.value !== cnf.value) { msg.className = "ob-pw-msg err"; msg.textContent = "Passwords do not match."; return; }
          if (nw.value.length < 6) { msg.className = "ob-pw-msg err"; msg.textContent = "Password must be at least 6 characters."; return; }
          try {
            await api.changePassword(cur.value, nw.value);
            pwDone = true;
            msg.className = "ob-pw-msg ok"; msg.textContent = "✓ Password changed successfully!";
            setTimeout(() => { slide = 2; render(); }, 900);
          } catch (e) {
            msg.className = "ob-pw-msg err";
            msg.textContent = e?.detail || "Incorrect current password.";
          }
        });
        skip.addEventListener("click", () => { slide = 2; render(); });
        form.append(cur, nw, cnf, msg, chg, skip);
        slideEl.appendChild(form);
      }
    }

    else if (slide === 2) {
      slideEl.appendChild(icon(ICONS.compass));
      slideEl.appendChild(Object.assign(document.createElement("h2"), { className: "ob-title", textContent: "How TouchBoard Works" }));
      const intro = Object.assign(document.createElement("p"), { className: "ob-body", textContent: "TouchBoard is built around a few simple concepts:" });
      slideEl.appendChild(intro);
      const ul = document.createElement("ul");
      ul.className = "ob-list";
      const items = [
        ["Widgets", "Data sources: ping monitors, clocks, stat counters, and more"],
        ["Integrations", "Connect external data sources to power your widgets"],
        ["Stacks", "Group widgets together; scroll in the editor or tap/click on the display to cycle between them"],
        ["Layout", "Drag widgets onto the board, or draw a card on the grid and pick what goes in it"],
        ["Designer", "Customize card appearance with themes, gradients, and glow effects"],
        ["Display", "Open /display on any screen to show your board fullscreen"],
      ];
      for (const [term, desc] of items) {
        const li = document.createElement("li");
        const dot = Object.assign(document.createElement("span"), { className: "ob-list-dot" });
        li.append(dot, Object.assign(document.createElement("span"), {
          innerHTML: `<strong>${term}</strong> - ${desc}`
        }));
        ul.appendChild(li);
      }
      slideEl.appendChild(ul);
    }

    else if (slide === 3) {
      slideEl.appendChild(icon(ICONS.bulb));
      slideEl.appendChild(Object.assign(document.createElement("h2"), { className: "ob-title", textContent: "In-App Tips" }));
      slideEl.appendChild(Object.assign(document.createElement("p"), { className: "ob-body", textContent: "TouchBoard can show contextual tips as you explore the editor to help you get started quickly." }));

      const togRow = document.createElement("div");
      togRow.className = "ob-tips-toggle-row";
      const tog = document.createElement("input");
      tog.type = "checkbox"; tog.className = "ds-toggle"; tog.checked = tipsEnabled;
      tog.addEventListener("change", () => { tipsEnabled = tog.checked; });
      const lbl = Object.assign(document.createElement("span"), { className: "ob-tips-label", textContent: "Enable in-app tips" });
      togRow.append(tog, lbl);
      slideEl.appendChild(togRow);
    }

    else if (slide === 4) {
      slideEl.appendChild(icon(ICONS.rocket));
      slideEl.appendChild(Object.assign(document.createElement("h2"), { className: "ob-title", textContent: "You're All Set!" }));
      slideEl.appendChild(Object.assign(document.createElement("p"), { className: "ob-body", textContent: "Thanks for trying TouchBoard. This project is in beta - you may encounter bugs. If you find any, please report them on GitHub." }));
      const donate = Object.assign(document.createElement("a"), {
        href: "https://ko-fi.com/parkertouchboard",
        className: "ob-donate-btn",
        innerHTML: "☕ &nbsp;Support Development",
        target: "_blank",
        rel: "noopener",
      });
      slideEl.appendChild(donate);
      slideEl.appendChild(Object.assign(document.createElement("p"), {
        className: "ob-beta-note",
        textContent: "TouchBoard is open source and free to use.",
      }));

      // Don't show again toggle
      const dnsRow = document.createElement("div");
      dnsRow.className = "ob-tips-toggle-row";
      dnsRow.style.marginTop = "16px";
      const dnsTog = document.createElement("input");
      dnsTog.type = "checkbox"; dnsTog.className = "ds-toggle"; dnsTog.checked = dontShowAgain;
      dnsTog.addEventListener("change", () => { dontShowAgain = dnsTog.checked; });
      const dnsLbl = Object.assign(document.createElement("span"), { className: "ob-tips-label", textContent: "Don't show again" });
      dnsRow.append(dnsTog, dnsLbl);
      slideEl.appendChild(dnsRow);
    }

    inner.appendChild(slideEl);

    // Nav row
    const nav = document.createElement("div");
    nav.className = "ob-nav";

    const skipAll = Object.assign(document.createElement("span"), { className: "ob-nav-skip", textContent: "Skip setup" });
    skipAll.addEventListener("click", finish);
    if (slide < 2) skipAll.style.visibility = "hidden";

    const btns = document.createElement("div");
    btns.className = "ob-nav-btns";

    if (slide > 0) {
      const back = Object.assign(document.createElement("button"), { type: "button", className: "ob-btn-back", textContent: "← Back" });
      back.addEventListener("click", () => { slide--; render(); });
      btns.appendChild(back);
    }

    if (slide < TOTAL - 1) {
      const next = Object.assign(document.createElement("button"), { type: "button", className: "ob-btn-next", textContent: "Next →" });
      next.addEventListener("click", () => { slide++; render(); });
      btns.appendChild(next);
    } else {
      const done = Object.assign(document.createElement("button"), { type: "button", className: "ob-btn-next", textContent: "Get Started →" });
      done.addEventListener("click", finish);
      btns.appendChild(done);
    }

    nav.append(skipAll, btns);
    inner.appendChild(nav);
    dlg.appendChild(inner);
    if (!dlg.open) dlg.showModal();
  }

  render();
}

function initTooltips() {
  let tipEl = null;
  let tipTarget = null;
  document.addEventListener("mouseover", (e) => {
    if (!document.body.classList.contains("tips-on")) return;
    const el = e.target.closest("[data-tip]");
    if (el === tipTarget) return;
    if (tipEl) { tipEl.remove(); tipEl = null; }
    tipTarget = el || null;
    if (!el) return;
    tipEl = document.createElement("div");
    tipEl.className = "g-tooltip";
    tipEl.textContent = el.dataset.tip;
    document.body.appendChild(tipEl);
    const r = el.getBoundingClientRect();
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    const below = !!el.closest(".topbar");
    let left = r.left + r.width / 2 - tw / 2;
    let top  = below ? r.bottom + 8 : r.top - th - 8;
    tipEl.style.left = Math.max(8, Math.min(window.innerWidth - tw - 8, left)) + "px";
    tipEl.style.top  = Math.max(8, top) + "px";
  });
  document.addEventListener("mouseout", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el && (!e.relatedTarget || !el.contains(e.relatedTarget))) {
      if (tipEl) { tipEl.remove(); tipEl = null; }
      tipTarget = null;
    }
  });
}

// The backend caches the actual GitHub call (checks every few hours), so
// polling this endpoint client-side is cheap — it's just reading local state.
async function checkForUpdate() {
  const badge = byId("update-badge");
  if (!badge) return;
  try {
    const state = await api.checkUpdate();
    if (state.update_available && state.url) {
      badge.href = state.url;
      badge.title = `Update available: ${state.label} — click to view on GitHub`;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  } catch { /* ignore — non-critical */ }
}

// Switching which profile the editor is working on reloads the page (simpler
// and safer than hot-swapping GridStack/page-tab state in place) — persist
// the choice across that reload via sessionStorage.
function switchEditingProfile(profileId) {
  sessionStorage.setItem("tb_editing_profile_id", String(profileId));
  window.location.reload();
}

async function renderProfileMenu(profiles) {
  const label = byId("profile-menu-label");
  const menu = byId("profile-menu");
  if (!label || !menu) return;
  profiles = profiles || await api.listProfiles().catch(() => []);

  const current = profiles.find((p) => p.id === editingProfileId);
  label.textContent = current ? current.name : "Profile";

  menu.innerHTML = "";
  for (const p of profiles) {
    const row = document.createElement("div");
    row.className = "topbar-menu-item profile-menu-row" + (p.id === editingProfileId ? " active" : "");

    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "profile-menu-name";
    nameBtn.textContent = p.name;
    if (p.is_active) nameBtn.title = "Currently live on /display";
    nameBtn.addEventListener("click", () => switchEditingProfile(p.id));
    row.appendChild(nameBtn);

    if (p.is_active) {
      row.appendChild(Object.assign(document.createElement("span"), {
        className: "profile-active-dot", title: "Live on /display",
      }));
    } else {
      const activateBtn = document.createElement("button");
      activateBtn.type = "button";
      activateBtn.className = "sb-icon-btn";
      activateBtn.title = "Set as active — makes this profile live on /display";
      activateBtn.textContent = "★";
      activateBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await api.activateProfile(p.id);
        renderProfileMenu();
      });
      row.appendChild(activateBtn);
    }
    menu.appendChild(row);
  }

  const divider = document.createElement("div");
  divider.className = "topbar-menu-divider";
  menu.appendChild(divider);

  const manageBtn = document.createElement("button");
  manageBtn.type = "button";
  manageBtn.className = "topbar-menu-item";
  manageBtn.textContent = "Manage Profiles…";
  manageBtn.addEventListener("click", () => {
    openSettingsPanel("Profiles");
    byId("profile-menu")?.classList.add("hidden");
  });
  menu.appendChild(manageBtn);
}

// Mini render of the current page in a given display theme (Designer gallery).
function designerThumb(dt, preset) {
  const W = 220, H = Math.round(W * dispH / dispW);
  const box = document.createElement("div");
  box.className = "ds-thumb";
  box.style.width = W + "px"; box.style.height = H + "px";
  const b = document.createElement("div");
  b.className = "ds-thumb-board";
  b.id = `ds-thumb-${dt.key}`;
  applyTheme({ style: dt.style, font: dt.font }, b);
  loadFont(dt.font);
  Object.assign(b.style, { width: dispW + "px", height: dispH + "px", transform: `scale(${W / dispW})`, backgroundColor: dt.board_bg_color,
    gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))` });
  const layout = grid ? currentLayout() : (currentPage().layout || []);
  for (const n of layout) {
    const stack = stacks.find((s) => s.id === n.stack_id);
    const w = stack && currentWidgetOf(stack);
    const cell = document.createElement("div");
    cell.className = "stack-cell";
    cell.style.gridColumn = `${n.x + 1} / span ${n.w}`;
    cell.style.gridRow = `${n.y + 1} / span ${n.h}`;
    if (w) {
      const body = Object.assign(document.createElement("div"), { className: "display-widget-body" });
      body.appendChild(renderWidget(w, liveData[w.id] || null, { still: true }));
      cell.appendChild(body);
    }
    b.appendChild(cell);
  }
  const { key, label, accent, ...cardFields } = preset;
  requestAnimationFrame(() => applyCardStyle({ ...cardFields, theme_style: dt.style }, b));
  box.appendChild(b);
  return box;
}

// ── screen presets ───────────────────────────────────────────────────────────

const SCREEN_PRESETS = [
  [800, 480, "Raspberry Pi 7\" Touch"],
  [1024, 600, "7\" panel"],
  [1280, 400, "Bar display"],
  [1280, 800, "10\" tablet"],
  [1920, 480, "Ultrawide bar"],
  [1920, 720, "Bar display"],
  [1920, 1080, "Full HD"],
  [2560, 1440, "QHD"],
  [2360, 1640, "iPad Air"],
  [2732, 2048, "iPad Pro 12.9\""],
];

function fillScreenPresets() {
  const sel = byId("screen-preset");
  sel.innerHTML = "";
  const all = [];
  for (const [w, h, name] of SCREEN_PRESETS) {
    all.push([`${w}x${h}`, `${w} × ${h} · ${name}`]);
    if (w !== h) all.push([`${h}x${w}`, `${h} × ${w} · ${name} (portrait)`]);
  }
  const key = `${dispW}x${dispH}`;
  const known = all.some(([k]) => k === key);
  for (const [k, label] of all) sel.appendChild(Object.assign(document.createElement("option"), { value: k, textContent: label }));
  sel.appendChild(Object.assign(document.createElement("option"), { value: "custom", textContent: known ? "Custom size…" : `${dispW} × ${dispH} · Custom` }));
  sel.value = known ? key : "custom";
  byId("custom-res").classList.toggle("hidden", known);
  byId("res-w").value = dispW;
  byId("res-h").value = dispH;
}

function setScreen(w, h) {
  dispW = Math.max(320, Math.min(7680, Math.round(w) || 1920));
  dispH = Math.max(240, Math.min(4320, Math.round(h) || 720));
  api.updateProfileBoard(editingProfileId, { disp_w: dispW, disp_h: dispH }).catch(() => {});
  fillScreenPresets();
  updatePreviewSize();
}

// ── grid density ─────────────────────────────────────────────────────────────

async function setDensity(value) {
  const [c, r] = value.split("x").map(Number);
  if (!c || !r || (c === COLS && r === ROWS)) return;
  if (!confirm(`Change the grid to ${c} × ${r}? Every page is rescaled to match.`)) { inspector?.render(true); return; }
  currentPage().layout = currentLayout();
  for (const p of board.pages) p.layout = G.rescale(p.layout || [], COLS, ROWS, c, r, 1, 1);
  await api.updateBoard({ columns: c, rows: r, pages: board.pages });
  window.location.reload();
}

// ── page mode ────────────────────────────────────────────────────────────────

function setPageMode(mode) {
  const page = currentPage();
  page.mode = mode === "tiled" ? "tiled" : "free";
  if (page.mode === "tiled") {
    // grow every card into empty space so the page is tiled
    const nodes = pageNodes();
    const plain = nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
    const tiledNodes = G.tileAll(plain, COLS, ROWS);
    grid.batchUpdate();
    nodes.forEach((n, i) => grid.update(n.el, tiledNodes[i]));
    grid.batchUpdate(false);
  }
  page.layout = currentLayout();
  renderBoard(); renderPageTabs();
  saveLayoutSoon();
  inspector?.render(true);
}

// ── editor settings panels ───────────────────────────────────────────────────

function renderEditorPrefs(contentEl) {
  contentEl.innerHTML = "";
  const p = getPrefs();
  const intro = Object.assign(document.createElement("p"), { className: "settings-ds-hint", textContent: "These are saved on this device." });
  const modes = Object.assign(document.createElement("div"), { className: "settings-section-head", textContent: "Editing" });
  const mkToggle = (label, hint, key) => {
    const row = Object.assign(document.createElement("label"), { className: "ed-pref-row" });
    const input = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!p[key] });
    input.addEventListener("change", () => { setPref(key, input.checked); prefs = getPrefs(); applyPrefs(); });
    const text = document.createElement("span");
    text.append(Object.assign(document.createElement("b"), { textContent: label }), Object.assign(document.createElement("small"), { textContent: hint }));
    row.append(input, text);
    return row;
  };
  const note = Object.assign(document.createElement("p"), { className: "settings-ds-hint", textContent: "Tiled pages are set per page in the inspector (select nothing, then Page → Layout). Editing on the display is set per screen in the same place." });
  contentEl.append(intro, modes,
    mkToggle("Inspector panel", "Card and page settings in a panel on the right. Off: settings open from ✎ on each card.", "inspector"),
    mkToggle("Draw to place", "Drag across empty grid to draw a card, then choose what goes in it.", "drawToPlace"),
    note);
}

function renderNotificationsTab(contentEl) {
  contentEl.innerHTML = "";
  const s = currentCardSettings;
  const intro = Object.assign(document.createElement("p"), { className: "settings-ds-hint",
    textContent: "Set thresholds per widget in the inspector (select a card → Alerts). When one fires, TouchBoard can send a push notification." });
  const mk = (label, input) => makeSbRow(label, input);
  const ntfy = Object.assign(document.createElement("input"), { className: "sb-form-input", placeholder: "https://ntfy.sh/your-topic", value: s.notify_ntfy_url || "" });
  const hook = Object.assign(document.createElement("input"), { className: "sb-form-input", placeholder: "https://example.com/webhook (receives JSON)", value: s.notify_webhook_url || "" });
  const level = document.createElement("select");
  level.className = "sb-form-input";
  for (const [v, l] of [["crit", "Critical only"], ["warn", "Warnings and critical"]]) level.appendChild(Object.assign(document.createElement("option"), { value: v, textContent: l }));
  level.value = s.notify_min_level || "crit";
  const cool = Object.assign(document.createElement("input"), { className: "sb-form-input", type: "number", min: "0", value: s.notify_cooldown_min || "15" });
  const status = Object.assign(document.createElement("div"), { className: "settings-ds-hint" });
  const save = Object.assign(document.createElement("button"), { type: "button", className: "small primary", textContent: "Save" });
  const test = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Send a test" });
  save.addEventListener("click", async () => {
    const body = { notify_ntfy_url: ntfy.value.trim(), notify_webhook_url: hook.value.trim(), notify_min_level: level.value, notify_cooldown_min: String(Math.max(0, Number(cool.value) || 0)) };
    try { const r = await api.updateSettings(body); Object.assign(currentCardSettings, r); status.textContent = "Saved."; }
    catch { status.textContent = "Couldn't save. Check the URLs."; }
  });
  test.addEventListener("click", async () => {
    status.textContent = "Sending…";
    try {
      const r = await fetch("/api/notify/test", { method: "POST" });
      status.textContent = r.ok ? "Sent. Check your phone or endpoint." : (await r.json().catch(() => ({}))).detail || "Couldn't send.";
    } catch { status.textContent = "Couldn't send."; }
  });
  const footer = Object.assign(document.createElement("div"), { className: "settings-form-footer" });
  footer.append(test, save);
  contentEl.append(intro, mk("ntfy topic URL", ntfy), mk("Webhook URL", hook), mk("Notify on", level), mk("Repeat at most every (minutes)", cool), footer, status);
}

// ── starter layouts dialog ───────────────────────────────────────────────────

function openTemplates() {
  const dlg = byId("widget-modal");
  dlg.innerHTML = "";
  const head = Object.assign(document.createElement("div"), { className: "modal-head" });
  const close = Object.assign(document.createElement("button"), { className: "modal-close-btn", textContent: "✕" });
  close.addEventListener("click", () => dlg.close());
  head.append(Object.assign(document.createElement("h2"), { textContent: "Starter layouts" }), close);
  const body = Object.assign(document.createElement("div"), { className: "modal-body" });
  body.appendChild(Object.assign(document.createElement("p"), { className: "wizard-step-hint", textContent: "Each one becomes a new page. It uses your widgets where it can, and adds a clock, notes or bookmarks where you don't have one." }));
  const gridEl = Object.assign(document.createElement("div"), { className: "ed-tpl-grid" });
  for (const tpl of TEMPLATES) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "ed-tpl" });
    b.append(miniMap(tpl.slots, 24, 16, "ed-tpl-map"),
      Object.assign(document.createElement("b"), { textContent: tpl.name }),
      Object.assign(document.createElement("small"), { textContent: tpl.blurb }));
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await applyTemplate(tpl, templateCtx());
        dlg.close();
        toast(`Added the ${tpl.name} page`);
      } catch (e) { toast("Couldn't apply that layout."); b.disabled = false; }
    });
    gridEl.appendChild(b);
  }
  body.appendChild(gridEl);
  dlg.append(head, body);
  dlg.showModal();
}

function templateCtx() {
  return {
    get widgets() { return widgets; },
    placedWidgetIds,
    cols: COLS, rows: ROWS,
    dataSources,
    createWidget: async (b) => { const w = await api.createWidget(b); widgets.push(w); reindex(); renderWidgets(); return w; },
    createStack: async (b) => { const s = await api.createStack(b); stacks.push(s); return s; },
    addPage,
  };
}

function doExportPage() {
  currentPage().layout = currentLayout();
  exportPage(currentPage(), { stacks, widgetsById, dataSources, cols: COLS, rows: ROWS });
}
function doImportPage() {
  const input = byId("import-file");
  input.value = "";
  input.click();
}
async function onImportFile(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    dataSources = await api.listDataSources().catch(() => dataSources);
    const page = await importPage(f, templateCtx());
    toast(`Imported "${page.name}"`);
  } catch (err) { toast(err.message || "Couldn't import that file."); }
  e.target.value = "";
}

// ── command palette ──────────────────────────────────────────────────────────

function buildCommands() {
  const cmds = [];
  const sel = stacks.find((s) => s.id === selectedStackId);
  const add = (group, title, run, extra = {}) => cmds.push({ group, title, run, ...extra });
  if (sel) {
    add("Selected card", `Edit ${sel.name}`, () => { const w = currentWidgetOf(sel); if (w) openWidgetModal(w); }, { order: 1 });
    add("Selected card", "Duplicate card", () => duplicateCard(sel.id), { hint: "Ctrl D", order: 2 });
    add("Selected card", "Fill empty space", () => fillCard(sel.id), { hint: "F", order: 3 });
    add("Selected card", gridItemFor(sel.id)?.gridstackNode?.locked ? "Unlock card" : "Lock card", () => setLocked(sel.id, !gridItemFor(sel.id)?.gridstackNode?.locked), { hint: "L", order: 4 });
    add("Selected card", "Remove card", () => removeCard(sel.id), { hint: "Del", order: 5 });
    board.pages.forEach((p, i) => { if (i !== currentPageIdx) add("Selected card", `Move card to ${p.name}`, () => moveCardToPage(sel.id, i), { order: 6 }); });
    for (const w of stackableWidgets(sel)) add("Selected card", `Stack ${w.title} onto this card`, () => mergeWidgetIntoStack(sel, w.id), { order: 7 });
  }
  for (const w of widgets) add("Add to page", `Add ${w.title}`, () => placeWidget(w.id), { hint: w.type, keywords: w.type, order: 10 });
  for (const t of WIDGET_TYPES) add("New widget", `New ${t.label} widget…`, () => createThenPlace(t.type, null), { keywords: t.type, order: 20 });
  board.pages.forEach((p, i) => add("Pages", `Go to ${p.name}`, () => switchPage(i), { order: 30 }));
  add("Pages", "New page", () => addPage(), { order: 31 });
  add("Pages", "Starter layouts…", openTemplates, { order: 32 });
  add("Pages", currentPage().mode === "tiled" ? "Make this page a free grid" : "Make this page tiled", () => setPageMode(currentPage().mode === "tiled" ? "free" : "tiled"), { order: 33 });
  add("Pages", "Export this page", doExportPage, { order: 34 });
  add("Pages", "Import a page…", doImportPage, { order: 35 });
  add("Edit", "Undo", () => history.undo(), { hint: "Ctrl Z", order: 40 });
  add("Edit", "Redo", () => history.redo(), { hint: "Ctrl ⇧ Z", order: 41 });
  for (const dt of DISPLAY_THEMES) add("Display theme", `Display theme: ${dt.label}`, () => applyDisplayTheme(dt), { order: 55 });
  for (const s of SHAPES) add("Display theme", `Card shape: ${s.label}`, () => setBoardLook({ shape: s.key }), { order: 56 });
  for (const pt of PATTERNS) add("Display theme", `Surface pattern: ${pt.label}`, () => setBoardLook({ pattern: pt.key }), { order: 57 });
  add("Settings", prefs.drawToPlace ? "Turn off draw to place" : "Turn on draw to place", () => { setPref("drawToPlace", !prefs.drawToPlace); prefs = getPrefs(); applyPrefs(); }, { order: 60 });
  add("Settings", prefs.inspector ? "Hide the inspector panel" : "Show the inspector panel", () => { setPref("inspector", !prefs.inspector); prefs = getPrefs(); applyPrefs(); }, { order: 61 });
  for (const s of ["Designer", "Integrations", "Ping Targets", "Notifications", "Profiles", "Users", "Backup", "Editor"]) add("Settings", `Open ${s === "Editor" ? "editor preferences" : s}`, () => openSettingsPanel(s), { order: 62 });
  add("Display", "Open the display", () => window.open(byId("open-display-link").href, "_blank"), { order: 70 });
  return cmds;
}

async function applyDisplayTheme(dt) {
  const preset = THEME_PRESETS.find((p) => p.key === dt.preset) || {};
  const { key, label, accent, ...cardFields } = preset;
  const patch = { ...cardFields, theme_style: dt.style, theme_font: dt.font, theme_shape: "theme", theme_pattern: "none", board_bg_color: dt.board_bg_color };
  const body = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v)]));
  const saved = await api.updateSettings(body);
  Object.assign(currentCardSettings, saved);
  currentTheme.style = dt.style; currentTheme.font = dt.font; currentTheme.shape = "theme"; currentTheme.pattern = "none";
  applyBoardTheme();
  toast(`Display theme: ${dt.label}`);
}

async function setBoardLook({ shape, pattern }) {
  const body = {};
  if (shape) { body.theme_shape = shape; currentTheme.shape = shape; }
  if (pattern) { body.theme_pattern = pattern; currentTheme.pattern = pattern; }
  Object.assign(currentCardSettings, await api.updateSettings(body));
  applyBoardTheme();
}

function applyBoardTheme() {
  const vp = byId("preview-viewport");
  applyTheme(currentTheme, vp);
  applyCardStyle({ ...currentCardSettings, theme_style: currentTheme.style }, vp);
  vp.style.setProperty("--widget-font-scale", currentCardSettings.widget_font_scale || "1");
  vp.style.backgroundColor = currentCardSettings.board_bg_color || "";
}

function applyPrefs() {
  document.body.classList.toggle("has-inspector", !!prefs.inspector);
  document.body.classList.toggle("no-draw", !prefs.drawToPlace);
  requestAnimationFrame(updatePreviewSize);
}

// ── keyboard ─────────────────────────────────────────────────────────────────

function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(buildCommands); return; }
    if (document.querySelector("dialog[open]") || isPaletteOpen()) return;
    if (typing) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); history.redo(); return; }
    if (e.key === "[") { switchPage(Math.max(0, currentPageIdx - 1)); return; }
    if (e.key === "]") { switchPage(Math.min(board.pages.length - 1, currentPageIdx + 1)); return; }
    if (e.key === "/" ) { e.preventDefault(); byId("lib-search")?.focus(); return; }
    const sel = selectedStackId;
    if (sel == null) return;
    if (e.key === "Escape") { selectStack(null); return; }
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateCard(sel); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeCard(sel); return; }
    if (e.key.toLowerCase() === "l" && !mod) { setLocked(sel, !gridItemFor(sel)?.gridstackNode?.locked); return; }
    if (e.key.toLowerCase() === "f" && !mod) { fillCard(sel); return; }
    if (e.key === "Enter") { const s = stacks.find((x) => x.id === sel); const w = s && currentWidgetOf(s); if (w) openWidgetModal(w); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) {
      e.preventDefault();
      const el = gridItemFor(sel);
      const n = el?.gridstackNode;
      if (!n || n.locked) return;
      const [dx, dy] = arrows[e.key];
      updateNode(sel, e.shiftKey ? { w: n.w + dx, h: n.h + dy } : { x: n.x + dx, y: n.y + dy });
      updateToolbar(); updateStatus();
    }
  });
}

// ── undo / redo state ────────────────────────────────────────────────────────

function snapshot() {
  const pages = structuredClone(board.pages);
  if (grid) pages[currentPageIdx].layout = currentLayout();
  return { pages, stacks: stacks.map((s) => ({ id: s.id, name: s.name, widget_ids: [...s.widget_ids], cycle_mode: s.cycle_mode })) };
}

async function applySnapshot(snap) {
  clearTimeout(saveTimer);
  const idMap = {};
  const wanted = new Map(snap.stacks.map((s) => [s.id, s]));
  for (const s of [...stacks]) {
    if (!wanted.has(s.id)) { await api.deleteStack(s.id).catch(() => {}); stacks = stacks.filter((x) => x !== s); }
  }
  for (const ws of snap.stacks) {
    const ids = ws.widget_ids.filter((id) => widgetsById[id]);
    const cur = stacks.find((s) => s.id === ws.id);
    if (cur) {
      if (cur.name !== ws.name || JSON.stringify(cur.widget_ids) !== JSON.stringify(ids) || cur.cycle_mode !== ws.cycle_mode) {
        Object.assign(cur, await api.updateStack(cur.id, { name: ws.name, widget_ids: ids, cycle_mode: ws.cycle_mode }));
      }
    } else {
      const c = await api.createStack({ name: ws.name, widget_ids: ids, cycle_mode: ws.cycle_mode });
      stacks.push(c);
      idMap[ws.id] = c.id;
    }
  }
  board.pages = structuredClone(snap.pages);
  for (const p of board.pages) for (const n of p.layout || []) if (idMap[n.stack_id] != null) n.stack_id = idMap[n.stack_id];
  if (currentPageIdx >= board.pages.length) currentPageIdx = board.pages.length - 1;
  await api.updateBoard({ columns: COLS, rows: ROWS, pages: board.pages });
  renderBoard(); renderPageTabs(); renderWidgets();
  inspector?.render(true);
  return idMap;
}

function updateHistoryButtons() {
  if (!history) return;
  byId("undo-btn").disabled = !history.canUndo;
  byId("redo-btn").disabled = !history.canRedo;
}

// ── inspector context ────────────────────────────────────────────────────────

function inspectorCtx() {
  return {
    selectedStack: () => stacks.find((s) => s.id === selectedStackId) || null,
    currentWidget: (stack) => currentWidgetOf(stack),
    widgetsById: () => widgetsById,
    nodeOf: (id) => gridItemFor(id)?.gridstackNode,
    cellPx,
    envelope: (wid) => liveData[wid],
    currentPage, currentPageIdx: () => currentPageIdx,
    pageCount: () => board.pages.length,
    pageNames: () => board.pages.map((p) => p.name),
    options: () => board.options || {},
    cols: () => COLS, rows: () => ROWS,
    displayUrl: () => `/display?profile=${encodeURIComponent(editingProfileName || String(editingProfileId))}`,
    updateNode, setLocked: (id, v) => setLocked(id, v),
    fill: (id) => fillCard(id), duplicate: (id) => duplicateCard(id), remove: (id) => removeCard(id),
    moveToPage: (id, idx) => moveCardToPage(id, idx),
    showWidget: (id, i) => { cardWidgetIdx[id] = i; const s = stacks.find((x) => x.id === id); if (s) refreshPlacedCard(s); inspector.render(true); },
    stackableWidgets,
    addToStack: (stack, wid) => mergeWidgetIntoStack(stack, wid),
    removeFromStack: async (stack, wid) => {
      const u = await api.updateStack(stack.id, { widget_ids: stack.widget_ids.filter((x) => x !== wid) });
      stack.widget_ids = u.widget_ids; refreshPlacedCard(stack); saveLayoutSoon(); inspector.render(true);
    },
    reorder: async (stack, i, dir) => {
      const j = i + dir;
      if (j < 0 || j >= stack.widget_ids.length) return;
      const ids = [...stack.widget_ids]; [ids[i], ids[j]] = [ids[j], ids[i]];
      const u = await api.updateStack(stack.id, { widget_ids: ids });
      stack.widget_ids = u.widget_ids; cardWidgetIdx[stack.id] = j; refreshPlacedCard(stack); saveLayoutSoon(); inspector.render(true);
    },
    updateStack: async (stack, patch) => {
      Object.assign(stack, await api.updateStack(stack.id, patch));
      refreshPlacedCard(stack); saveLayoutSoon(); inspector.render(true);
    },
    editWidget: (w) => openWidgetModal(w),
    openColors: (anchor, w, stack) => openWidgetAppearancePopover(anchor, w, liveData[w.id]?.data, () => openStackModal(stack)),
    previewScale: (id, v) => gridItemFor(id)?.querySelector(".widget")?.style.setProperty("--w-scale", String(v)),
    updateWidgetConfig: async (w, patch) => {
      const updated = await api.updateWidget(w.id, { config: { ...(w.config || {}), ...patch } });
      Object.assign(w, updated); reindex(); rerenderCardsFor(w.id);
    },
    updateWidget: async (w, patch) => {
      const updated = await api.updateWidget(w.id, patch);
      Object.assign(w, updated); reindex(); rerenderCardsFor(w.id);
    },
    setPageProp: (k, v) => { currentPage()[k] = v; renderPageTabs(); saveLayoutSoon(); },
    setPageMode,
    setOption: (k, v) => { board.options = { ...(board.options || {}), [k]: v }; saveOptionsSoon(); },
    setDensity,
    openTemplates, exportPage: doExportPage, importPage: doImportPage,
  };
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function init() {
  let currentUser;
  try { currentUser = await api.me(); } catch { window.location.href = "/login"; return; }
  if (!currentUser) { window.location.href = "/login"; return; }

  const userEl = byId("topbar-user");
  if (userEl) userEl.textContent = currentUser.username;
  byId("logout-btn").addEventListener("click", async () => {
    await api.logout().catch(() => {});
    window.location.href = "/login";
  });

  checkForUpdate();
  setInterval(checkForUpdate, 30 * 60 * 1000);

  const profiles = await api.listProfiles();
  const storedId = Number(sessionStorage.getItem("tb_editing_profile_id"));
  editingProfileId = profiles.some((p) => p.id === storedId) ? storedId : (profiles.find((p) => p.is_active) ?? profiles[0])?.id;
  editingProfileName = profiles.find((p) => p.id === editingProfileId)?.name || "";
  api.setEditingProfile(editingProfileId);
  renderProfileMenu(profiles);

  const full = await api.boardFull();
  board = full.board;
  if (!board.pages || !board.pages.length) board.pages = [{ id: 1, name: "Page 1", layout: board.layout || [] }];
  board.options = board.options || {};
  stacks  = full.stacks;
  widgets = full.widgets;
  reindex();
  api.listDataSources().then((d) => { dataSources = d; }).catch(() => {});

  await loadPingTargets();
  fetchLiveData().then(() => { renderWidgets(); refreshGridCards(); });

  const settings = await api.getSettings();
  initTooltips();
  setTipsEnabled(settings.tips_enabled !== "false", false);
  byId("tips-menu-item")?.addEventListener("click", () => setTipsEnabled(!document.body.classList.contains("tips-on")));
  if (settings.onboarding_done !== "true" || currentUser.is_default_password) {
    showOnboarding({ ...settings, is_default_password: currentUser.is_default_password });
  }

  currentTheme.style   = settings.theme_style   || "classic";
  currentTheme.font    = settings.theme_font    || "inter";
  currentTheme.shape   = settings.theme_shape   || "theme";
  currentTheme.pattern = settings.theme_pattern || "none";
  Object.assign(currentCardSettings, settings);
  applyBoardTheme();
  dispW = board.disp_w || 1920;
  dispH = board.disp_h || 720;
  fillScreenPresets();

  // Migrate layouts stored with old column counts (pre-24-column boards)
  if (board.columns && board.columns < 12) {
    const colScale = 24 / board.columns, rowScale = 16 / 12;
    for (const page of board.pages) for (const node of page.layout || []) {
      node.x = Math.round(node.x * colScale); node.w = Math.max(MIN_W, Math.round(node.w * colScale));
      node.y = Math.round(node.y * rowScale); node.h = Math.max(MIN_H, Math.round(node.h * rowScale));
    }
    board.columns = 24;
    api.updateBoard({ columns: 24, rows: 16, pages: board.pages });
  }
  COLS = board.columns || 24;
  ROWS = board.rows || 16;

  const gsEl = byId("gs-grid");
  updatePreviewSize();
  grid = GridStack.init({
    column: COLS,
    cellHeight: dispH / ROWS,
    maxRow: ROWS,
    margin: 0,
    float: true,
    minW: MIN_W,
    minH: MIN_H,
    handle: ".layout-stack-card",
    draggable: { cancel: ".lc-pag-dot, .layout-card-actions, .layout-card-btn, button, input, select, textarea" },
    resizable: { handles: "e,w,s,se,sw,n,ne,nw" },
    alwaysShowResizeHandle: "mobile",
    acceptWidgets: ".sb-widget-item",
    animate: true,
  }, gsEl);
  gsEl.classList.add(`gs-${COLS}`);

  // ── grid events ──
  grid.on("change", () => { saveLayoutSoon(); updateToolbar(); updateStatus(); tiled?.render(); });

  grid.on("resizestart", (_e, el) => { document.body.classList.add("is-dragging"); updateToolbar(); showSizeReadout(el); });
  grid.on("resize", (_e, el) => showSizeReadout(el));
  grid.on("resizestop", (_ev, el) => {
    document.body.classList.remove("is-dragging");
    const n = el.gridstackNode;
    if (n) {
      // snap to the board edges when released within one cell of them
      let { x, y, w, h } = n, snapped = false;
      if (y > 0 && y <= 1) { h += y; y = 0; snapped = true; }
      if (x > 0 && x <= 1) { w += x; x = 0; snapped = true; }
      if (y + h < ROWS && y + h >= ROWS - 1) { h = ROWS - y; snapped = true; }
      if (x + w < COLS && x + w >= COLS - 1) { w = COLS - x; snapped = true; }
      if (snapped && G.isFree({ x, y, w, h }, pageNodes().filter((o) => o.el !== el), COLS, ROWS)) grid.update(el, { x, y, w, h });
    }
    selectStack(Number(el.dataset.stackId));
    updateToolbar();
  });

  const library = byId("library");
  grid.on("dragstart", (_ev, el) => {
    draggingEl = el;
    document.body.classList.add("is-dragging");
    library.classList.add("drag-receiving");
    byId("palette-drop-zone").classList.add("active");
    el.dataset.dragStartCol = el.gridstackNode?.x ?? -1;
    el.dataset.dragStartRow = el.gridstackNode?.y ?? -1;
    selectStack(Number(el.dataset.stackId));
    updateToolbar();
  });
  grid.on("drag", (_e, el) => showSizeReadout(el));

  grid.on("dragstop", async (_ev, el) => {
    const armed = dwell.armed ? dwell.el : null;
    clearDwell();
    draggingEl = null;
    document.body.classList.remove("is-dragging");
    library.classList.remove("drag-receiving");
    byId("palette-drop-zone").classList.remove("active");
    const stackId = Number(el.dataset.stackId);

    // dropped back on the library → remove
    const lr = library.getBoundingClientRect();
    if (pointer.x >= lr.left && pointer.x <= lr.right && pointer.y >= lr.top && pointer.y <= lr.bottom) {
      await removeCard(stackId);
      return;
    }
    // dropped on a page tab → move (Alt: copy)
    const tab = document.elementsFromPoint(pointer.x, pointer.y).find((n) => n.classList?.contains("page-tab"));
    if (tab) {
      const orig = { x: Number(el.dataset.dragStartCol), y: Number(el.dataset.dragStartRow) };
      if (orig.x >= 0) grid.update(el, orig);
      await moveCardToPage(stackId, Number(tab.dataset.pageIdx), { copy: !!pointer.alt });
      return;
    }
    // held over another card → stack
    if (armed) {
      const orig = { x: Number(el.dataset.dragStartCol), y: Number(el.dataset.dragStartRow) };
      if (orig.x >= 0) grid.update(el, orig);
      await mergeStacks(Number(armed.dataset.stackId), stackId);
      return;
    }
    selectStack(stackId);
    updateToolbar();
  });

  // drag-in from the library
  document.addEventListener("pointerdown", (e) => {
    const item = e.target.closest?.(".sb-widget-item");
    if (item && !e.target.closest("button")) {
      dragInWidgetId = Number(item.dataset.widgetId);
      draggingEl = null;
      document.body.classList.add("is-dragging");
      const end = () => { setTimeout(() => { document.body.classList.remove("is-dragging"); clearDwell(); }, 0); document.removeEventListener("pointerup", end); };
      document.addEventListener("pointerup", end);
    }
  }, true);
  grid.on("dropped", async (_ev, _prev, newNode) => {
    const el = newNode?.el;
    const widgetId = Number(el?.dataset.widgetId || dragInWidgetId);
    const armed = dwell.armed ? dwell.el : null;
    clearDwell();
    const spot = { x: newNode.x, y: newNode.y, w: newNode.w, h: newNode.h };
    if (el) grid.removeWidget(el, true, false);
    document.body.classList.remove("is-dragging");
    if (!widgetsById[widgetId]) return;
    if (armed) {
      const target = stacks.find((s) => s.id === Number(armed.dataset.stackId));
      if (target) { await mergeWidgetIntoStack(target, widgetId); return; }
    }
    await placeWidget(widgetId, spot);
  });

  setupDrawToPlace();
  setupSectionToggles();
  setupKeyboard();
  connectSSE();

  // tiled pages
  tiled = createTiledOverlay({
    stage: byId("ed-stage"),
    nodes: () => pageNodes().map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
    cellSize: () => ({ cw: dispW / COLS, ch: dispH / ROWS }),
    scale: () => stageScale,
    apply: (nodes) => {
      const els = pageNodes();
      grid.batchUpdate();
      els.forEach((n, i) => { const t = nodes[i]; if (t) grid.update(n.el, { x: t.x, y: t.y, w: t.w, h: t.h }); });
      grid.batchUpdate(false);
    },
    commit: () => saveLayoutSoon(),
  });

  // inspector
  inspector = createInspector(byId("inspector"), inspectorCtx());

  // history
  history = createHistory({ snapshot, apply: applySnapshot, onChange: updateHistoryButtons });
  byId("undo-btn").addEventListener("click", () => history.undo());
  byId("redo-btn").addEventListener("click", () => history.redo());

  // topbar nav
  for (const btn of document.querySelectorAll(".topbar-settings-btn[data-section]")) {
    btn.addEventListener("click", () => openSettingsPanel(btn.dataset.section));
  }
  const settingsMenuBtn = byId("settings-menu-btn"), settingsMenu = byId("settings-menu");
  settingsMenuBtn.addEventListener("click", (e) => { e.stopPropagation(); settingsMenu.classList.toggle("hidden"); });
  document.addEventListener("click", (e) => {
    if (!settingsMenu.classList.contains("hidden") && !settingsMenu.contains(e.target) && !settingsMenuBtn.contains(e.target)) settingsMenu.classList.add("hidden");
  });
  for (const item of document.querySelectorAll(".topbar-menu-item[data-section]")) {
    item.addEventListener("click", () => { openSettingsPanel(item.dataset.section); settingsMenu.classList.add("hidden"); });
  }
  const profileMenuBtn = byId("profile-menu-btn"), profileMenu = byId("profile-menu");
  profileMenuBtn.addEventListener("click", (e) => { e.stopPropagation(); profileMenu.classList.toggle("hidden"); });
  document.addEventListener("click", (e) => {
    if (!profileMenu.classList.contains("hidden") && !profileMenu.contains(e.target) && !profileMenuBtn.contains(e.target)) profileMenu.classList.add("hidden");
  });
  byId("cmdk-btn").addEventListener("click", () => openPalette(buildCommands));
  byId("templates-btn").addEventListener("click", openTemplates);
  byId("import-file").addEventListener("change", onImportFile);
  byId("lib-search").addEventListener("input", renderWidgets);
  byId("open-display-link").href = `/display?profile=${encodeURIComponent(editingProfileName || String(editingProfileId))}`;

  // screen size
  byId("screen-preset").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v === "custom") { byId("custom-res").classList.remove("hidden"); byId("res-w").focus(); return; }
    const [w, h] = v.split("x").map(Number);
    setScreen(w, h);
  });
  const onRes = () => setScreen(parseInt(byId("res-w").value), parseInt(byId("res-h").value));
  byId("res-w").addEventListener("change", onRes);
  byId("res-h").addEventListener("change", onRes);
  byId("rotate-btn").addEventListener("click", () => setScreen(dispH, dispW));

  document.addEventListener("tb:prefs", () => { prefs = getPrefs(); applyPrefs(); });
  applyPrefs();

  renderWidgets();
  renderPageTabs();
  renderBoard();
  inspector.render(true);
  history.reset();

  byId("page-tab-add").addEventListener("click", () => addPage());
  byId("canvas-area").addEventListener("scroll", () => updateToolbar(), { passive: true });
  window.addEventListener("resize", updatePreviewSize);
  new ResizeObserver(() => updatePreviewSize()).observe(byId("canvas-area"));
}

init();
