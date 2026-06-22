import { api } from "./api.js";
import { renderWidget } from "./widgets.js";
import { STYLES, FONTS, THEME_PRESETS, applyTheme, applyCardStyle, hexToRgba } from "./theme.js";

let currentTheme = { style: "classic", font: "inter" };
let currentCardSettings = {};

const byId = (id) => document.getElementById(id);

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

// Fixed freeform grid — 24 columns × 16 rows, items snap to these cells
const COLS    = 24;
const ROWS    = 16;
const MIN_W   = 2;   // minimum card width in grid units
const MIN_H   = 2;   // minimum card height in grid units
const DEF_W   = 6;   // default drop width
const DEF_H   = 4;   // default drop height
const INTEGRATION_TYPES = new Set(["proxmox", "truenas", "netbox"]);

let board          = { columns: COLS, pages: [{ id: 1, name: "Page 1", layout: [] }] };
let currentPageIdx = 0;
let stacks  = [];
let widgets = [];
let widgetsById = {};
let pingTargets = [];  // global ping target library
let pingPickerEl = null; // reference to current picker in widget modal
let grid;
let saveTimer = null;
let dispW = 1920;
let dispH = 720;

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

function calcPreview() {
  const sidebarW = document.querySelector(".stack-palette")?.offsetWidth || 360;
  const topbarH  = document.querySelector(".topbar")?.offsetHeight  || 44;
  const tabsH    = byId("page-tabs-bar")?.offsetHeight || 0;
  const pad = 32;
  const availW = Math.max(300, window.innerWidth  - sidebarW - pad);
  const availH = Math.max(200, window.innerHeight - topbarH  - tabsH - pad - 18);
  const scale  = Math.min(availW / dispW, availH / dispH, 1);
  return { w: Math.round(dispW * scale), h: Math.round(dispH * scale) };
}

function updatePreviewSize() {
  const { w, h } = calcPreview();
  const vp = byId("preview-viewport");
  vp.style.width  = w + "px";
  vp.style.height = h + "px";
  if (grid) grid.cellHeight(Math.round(h / ROWS));
}

// ── layout persistence ────────────────────────────────────────────────────────

function currentLayout() {
  if (!grid) return [];
  return grid.getGridItems().map((el) => {
    const n = el.gridstackNode;
    return { stack_id: Number(el.dataset.stackId), x: n.x, y: n.y, w: n.w, h: n.h, item_type: el.dataset.itemType || "stack" };
  });
}

function saveLayoutSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    currentPage().layout = currentLayout();
    await api.updateBoard({ columns: COLS, pages: board.pages });
  }, 400);
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

// ── helpers ───────────────────────────────────────────────────────────────────

const WIDGET_TYPES = [
  { type: "clock",   label: "Clock",   icon: "🕐" },
  { type: "weather", label: "Weather", icon: "⛅" },
  { type: "ping",    label: "Ping",    icon: "📡" },
  { type: "netbox",  label: "NetBox",  icon: "🗄️" },
  { type: "truenas", label: "TrueNAS", icon: "💾" },
  { type: "proxmox", label: "Proxmox", icon: "🖥️" },
];

const WIDGET_CATEGORIES = [
  { label: "Utilities",    types: ["clock", "weather"],             color: "#f59e0b" },
  { label: "Ping",         types: ["ping"],                         color: "#a78bfa" },
  { label: "Integrations", types: ["netbox", "truenas", "proxmox"], color: "#34d399" },
];

function typeColor(type) {
  return WIDGET_CATEGORIES.find(c => c.types.includes(type))?.color || "#8b96a5";
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

function renderWidgets() {
  const list = byId("widget-list");
  if (!list) return;
  list.innerHTML = "";
  byId("widget-count").textContent = widgets.length;

  if (!widgets.length) {
    list.appendChild(Object.assign(document.createElement("div"), {
      className: "palette-no-stacks",
      textContent: "No widgets yet. Click ＋ to create one.",
    }));
    return;
  }

  for (const cat of WIDGET_CATEGORIES) {
    const catWidgets = widgets.filter((w) => cat.types.includes(w.type));
    if (!catWidgets.length) continue;

    const group = document.createElement("div");
    group.className = "sb-cat-group";

    const header = document.createElement("div");
    header.className = "sb-cat-header";
    header.style.setProperty("--cat", cat.color);

    const arrow = Object.assign(document.createElement("span"), { className: "sb-arrow sb-cat-arrow", textContent: "▾" });
    const label = Object.assign(document.createElement("span"), { className: "sb-cat-label", textContent: cat.label });
    const count = Object.assign(document.createElement("span"), { className: "sb-cat-count", textContent: catWidgets.length });
    header.append(arrow, label, count);

    const body = document.createElement("div");
    body.className = "sb-cat-body";
    for (const w of catWidgets) body.appendChild(buildWidgetItem(w));

    header.addEventListener("click", () => {
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      arrow.style.transform = hidden ? "" : "rotate(-90deg)";
    });

    group.append(header, body);
    list.appendChild(group);
  }
}

function buildWidgetItem(w) {
  const item = document.createElement("div");
  item.className = "sb-widget-item";
  item.style.borderLeftColor = typeColor(w.type);
  item.draggable = true;
  item.dataset.widgetId = w.id;
  item.addEventListener("dragstart", (e) => {
    if (e.target.closest("button")) { e.preventDefault(); return; }
    e.dataTransfer.setData("text/plain", `widget:${w.id}`);
    if (INTEGRATION_TYPES.has(w.type)) {
      e.dataTransfer.setData("application/x-tb-integration", "1");
    }
    e.dataTransfer.effectAllowed = "copy";
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => item.classList.remove("dragging"));

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

  const editBtn = document.createElement("button");
  editBtn.className = "sb-icon-btn";
  editBtn.title = "Edit widget";
  editBtn.textContent = "✎";

  const delBtn = document.createElement("button");
  delBtn.className = "sb-icon-btn danger";
  delBtn.title = "Delete widget";
  delBtn.textContent = "✕";

  head.append(badge, name, editBtn, delBtn);
  item.appendChild(head);

  editBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    openWidgetModal(w);
  });

  delBtn.addEventListener("click", async () => {
    if (!confirm(`Delete widget "${w.title}"?`)) return;
    await api.deleteWidget(w.id);
    // Remove from any stacks that contain it
    for (const s of stacks) {
      if (s.widget_ids.includes(w.id)) {
        s.widget_ids = s.widget_ids.filter((id) => id !== w.id);
        await api.updateStack(s.id, { widget_ids: s.widget_ids });
      }
    }
    widgets = widgets.filter((x) => x.id !== w.id);
    reindex();
    renderWidgets();
    refreshGridCards();
  });

  return item;
}


function makeSbRow(labelText, input) {
  const row = document.createElement("div");
  row.className = "sb-form-row";
  const lbl = document.createElement("div");
  lbl.className = "sb-form-label"; lbl.textContent = labelText;
  row.append(lbl, input);
  return row;
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

async function openWidgetModal(w = null) {
  const dlg = byId("widget-modal");
  dlg.innerHTML = "";

  const head = document.createElement("div");
  head.className = "modal-head";
  const titleEl = document.createElement("h2");
  titleEl.textContent = w ? "Edit Widget" : "New Widget";
  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-close-btn"; closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => dlg.close());
  head.append(titleEl, closeBtn);
  dlg.appendChild(head);

  const body = document.createElement("div");
  body.className = "modal-body";

  const nameInput = Object.assign(document.createElement("input"), {
    className: "sb-form-input", placeholder: "Widget name", value: w?.title || "",
  });
  body.appendChild(makeSbRow("Name", nameInput));

  let type = w?.type || "clock";

  // Type selector (new widget only)
  const typeSel = document.createElement("select");
  typeSel.className = "sb-form-input";
  for (const wt of WIDGET_TYPES) {
    const opt = document.createElement("option");
    opt.value = wt.type; opt.textContent = wt.label;
    if (wt.type === type) opt.selected = true;
    typeSel.appendChild(opt);
  }
  if (!w) body.appendChild(makeSbRow("Type", typeSel));

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
      const styleSel = sel([["minimal","Minimal"],["full","Full"]], cfg.clock_style || "minimal");
      const tzInp    = inp("e.g. America/Phoenix", cfg.clock_timezone || "");
      cfgWrap.append(makeSbRow("Mode", modeSel), makeSbRow("Format", fmtSel), makeSbRow("Style", styleSel), makeSbRow("Timezone", tzInp));
      getConfig = () => ({ clock_mode: modeSel.value, clock_format: fmtSel.value, clock_style: styleSel.value, clock_timezone: tzInp.value.trim() });

    } else if (t === "weather") {
      const locNameInp = inp("City name", cfg.location_name || "");
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
      cfgWrap.append(makeSbRow("Location", locNameInp), geoBtn, geoResults,
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
    }

    // Integration picker for types that need a data source
    const intTypes = { netbox: "netbox", truenas: "truenas", proxmox: "proxmox" };
    if (intTypes[t]) {
      const intHead = Object.assign(document.createElement("div"), {
        className: "sb-form-label", textContent: "Integration",
      });
      intHead.style.marginTop = "12px";
      cfgWrap.appendChild(intHead);

      const compatible = allDataSources.filter(ds => ds.type === intTypes[t]);
      const dsSel = document.createElement("select");
      dsSel.className = "sb-form-input";
      const noneOpt = document.createElement("option");
      noneOpt.value = ""; noneOpt.textContent = "— none —";
      dsSel.appendChild(noneOpt);
      for (const ds of compatible) {
        const o = document.createElement("option");
        o.value = ds.id; o.textContent = ds.name;
        if (ds.id === w?.data_source_id) o.selected = true;
        dsSel.appendChild(o);
      }
      cfgWrap.appendChild(makeSbRow("Data source", dsSel));

      const origGetConfig = getConfig;
      getConfig = () => ({ ...origGetConfig(), _dsId: Number(dsSel.value) || null });
    }
  }

  buildConfigFields(type);
  if (!w) typeSel.addEventListener("change", () => { type = typeSel.value; buildConfigFields(type); });

  const refreshInput = Object.assign(document.createElement("input"), {
    className: "sb-form-input", type: "number", min: "2",
    placeholder: "15", value: w?.refresh_interval_sec ?? 15,
  });
  body.appendChild(makeSbRow("Refresh (sec)", refreshInput));
  dlg.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "modal-footer";

  if (w) {
    const delBtn = Object.assign(document.createElement("button"),
      { type: "button", className: "small danger", textContent: "Delete widget" });
    delBtn.style.marginRight = "auto";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete widget "${w.title}"?`)) return;
      await api.deleteWidget(w.id);
      for (const s of stacks) {
        if (s.widget_ids.includes(w.id)) {
          s.widget_ids = s.widget_ids.filter(id => id !== w.id);
          await api.updateStack(s.id, { widget_ids: s.widget_ids });
        }
      }
      widgets = widgets.filter(x => x.id !== w.id);
      reindex();
      dlg.close();
      renderWidgets(); refreshGridCards();
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
    const refresh    = Math.max(2, Number(refreshInput.value) || 15);
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
      } else {
        const created = await api.createWidget({ type: finalType, title, config: configData, refresh_interval_sec: refresh, data_source_id: dsId });
        widgets.push(created);
        reindex();
        renderWidgets();
      }
      dlg.close();
    } catch {
      saveBtn.disabled = false; saveBtn.textContent = w ? "Save" : "Create";
    }
  });

  footer.append(cancelBtn, saveBtn);
  dlg.appendChild(footer);
  dlg.showModal();
  nameInput.focus();
}

// ── palette (widget stacks) ───────────────────────────────────────────────────

// ── stack modal ───────────────────────────────────────────────────────────────

function refreshPlacedCard(stack) {
  if (!grid) return;
  const gridEl = [...grid.getGridItems()].find((e) => Number(e.dataset.stackId) === stack.id);
  if (!gridEl) return;
  const old = gridEl.querySelector(".grid-stack-item-content");
  if (old) old.replaceWith(buildPlacedContent(stack));
}

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

      row.append(grip, badge, lbl, upBtn, dnBtn, x);

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
  }

  function refreshSel() {
    sel.innerHTML = '<option value="">add widget…</option>';
    const ids = currentIds();
    for (const w of widgets) {
      if (ids.includes(w.id)) continue;
      if (INTEGRATION_TYPES.has(w.type)) continue;
      const wEl = document.querySelector(`.sb-widget-item[data-widget-id="${w.id}"]`);
      if (!wEl) continue;
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

function showIntegrationToast() {
  let toast = document.getElementById("integration-stack-toast");
  if (!toast) {
    toast = Object.assign(document.createElement("div"), {
      id: "integration-stack-toast", className: "integration-toast",
      textContent: "Integrations cannot be stacked",
    });
    document.body.appendChild(toast);
  }
  toast.classList.add("visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function buildPlacedContent(stack, initialPage = 0) {
  const content = document.createElement("div");
  content.className = "grid-stack-item-content";

  const card = document.createElement("div");
  card.className = "layout-stack-card";
  if (stack.widget_ids.some(id => INTEGRATION_TYPES.has(widgetsById[id]?.type))) {
    card.dataset.integration = "1";
  }

  const dragHandle = document.createElement("div");
  dragHandle.className = "layout-drag-handle";
  dragHandle.title = "Drag to move";
  const gripSpan = document.createElement("span");
  gripSpan.className = "layout-drag-grip"; gripSpan.textContent = "⠿";
  const nameSpan = document.createElement("span");
  nameSpan.className = "layout-drag-name"; nameSpan.textContent = stack.name;
  dragHandle.append(gripSpan, nameSpan);
  card.appendChild(dragHandle);

  const validWidgets = stack.widget_ids.map((id) => widgetsById[id]).filter(Boolean);
  let pageIdx = Math.min(initialPage, Math.max(0, validWidgets.length - 1));

  const widgetArea = document.createElement("div");
  widgetArea.className = "layout-widget-area";
  // Block clicks on widget internals (links, rack toggles, etc.)
  // Allow .lc-pag-dot clicks through so within-widget view navigation works.
  widgetArea.addEventListener("click", (e) => {
    if (!e.target.closest(".lc-pag-dot") && !e.target.closest(".widget-ctrl")) e.stopPropagation();
  }, true);

  // Pagination bar (dots + arrows) — only shown for multi-widget stacks
  const pagBar = document.createElement("div");
  pagBar.className = "lc-pag-bar";

  function renderPage() {
    widgetArea.innerHTML = "";
    if (!validWidgets.length) {
      widgetArea.appendChild(Object.assign(document.createElement("div"), { className: "placed-empty", textContent: "No widgets" }));
      pagBar.innerHTML = ""; return;
    }
    widgetArea.appendChild(renderWidget(validWidgets[pageIdx], liveData[validWidgets[pageIdx].id] || null, { editable: true }));
    if (validWidgets.length <= 1) { pagBar.innerHTML = ""; return; }
    // Rebuild pagination dots
    pagBar.innerHTML = "";
    const dots = document.createElement("div");
    dots.className = "lc-pag-dots";
    validWidgets.forEach((_, i) => {
      const d = Object.assign(document.createElement("span"), { className: "lc-pag-dot" + (i === pageIdx ? " active" : "") });
      d.addEventListener("click", (e) => { e.stopPropagation(); pageIdx = i; renderPage(); });
      dots.appendChild(d);
    });
    pagBar.append(dots);
  }

  renderPage();
  card._renderPage   = renderPage;
  card._navigatePage = (dir) => {
    const next = Math.max(0, Math.min(validWidgets.length - 1, pageIdx + dir));
    if (next !== pageIdx) { pageIdx = next; renderPage(); }
  };
  card.append(widgetArea, pagBar);

  // ── merge-drop: accept sidebar widgets dragged onto this card ────────────
  const vp = byId("preview-viewport");
  card.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/plain")) return;
    const isIntegrationDrag = e.dataTransfer.types.includes("application/x-tb-integration");
    if (card.dataset.integration || isIntegrationDrag) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    card.classList.add("merge-target");
    vp.classList.remove("drag-over");
  });
  card.addEventListener("dragleave", (e) => {
    if (!card.contains(e.relatedTarget)) card.classList.remove("merge-target");
  });
  card.addEventListener("drop", async (e) => {
    e.preventDefault();
    card.classList.remove("merge-target");
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw.startsWith("widget:")) return;
    const draggedId = Number(raw.slice(7));
    const draggedIsIntegration = INTEGRATION_TYPES.has(widgetsById[draggedId]?.type);
    // Both are integrations — block with toast, don't let it bubble to the viewport
    if (card.dataset.integration && draggedIsIntegration) {
      e.stopPropagation();
      showIntegrationToast();
      return;
    }
    // One side is an integration — let the event bubble to the viewport drop zone
    if (card.dataset.integration || draggedIsIntegration) return;
    e.stopPropagation();
    await mergeWidgetIntoStack(stack, draggedId);
  });

  const actions = document.createElement("div");
  actions.className = "layout-card-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "layout-card-btn"; editBtn.title = "Edit"; editBtn.textContent = "✎";
  editBtn.dataset.tip = "Edit widget or stack";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openStackModal(stack);
  });

  const removeBtn = document.createElement("button");
  removeBtn.className = "layout-card-btn remove"; removeBtn.title = "Remove from layout"; removeBtn.textContent = "↙";
  removeBtn.dataset.tip = "Remove from board";
  removeBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const item = grid && [...grid.getGridItems()].find((el) => Number(el.dataset.stackId) === stack.id);
    if (!item) return;
    grid.removeWidget(item);
    placedIds.delete(stack.id);
    phantomStackIds.delete(stack.id);
    stacks = stacks.filter((s) => s.id !== stack.id);
    await api.deleteStack(stack.id).catch(() => {});
    for (const wId of stack.widget_ids) {
      const wEl = document.querySelector(`.sb-widget-item[data-widget-id="${wId}"]`);
      if (wEl) { void wEl.offsetWidth; wEl.classList.add("returning"); wEl.addEventListener("animationend", () => wEl.classList.remove("returning"), { once: true }); }
    }
    syncPaletteStates();
    saveLayoutSoon();
  });

  actions.append(editBtn, removeBtn);
  card.appendChild(actions);

  content.appendChild(card);
  return content;
}

async function mergeWidgetIntoStack(stack, widgetId) {
  const widget = widgetsById[widgetId];
  if (!widget || stack.widget_ids.includes(widgetId)) return;
  if (INTEGRATION_TYPES.has(widget.type)) return;
  if (stack.widget_ids.some(id => INTEGRATION_TYPES.has(widgetsById[id]?.type))) return;

  const newIds = [...stack.widget_ids, widgetId];
  const updated = await api.updateStack(stack.id, { widget_ids: newIds });
  stack.widget_ids = updated.widget_ids;


  // Rebuild the card content, then animate the new card
  const gridEl = grid && [...grid.getGridItems()].find((e) => Number(e.dataset.stackId) === stack.id);
  if (gridEl) {
    const old = gridEl.querySelector(".grid-stack-item-content");
    const newContent = buildPlacedContent(stack);
    if (old) old.replaceWith(newContent);
    const newCard = newContent.querySelector(".layout-stack-card");
    if (newCard) {
      newCard.classList.add("merging");
      newCard.addEventListener("animationend", () => newCard.classList.remove("merging"), { once: true });
    }
  }

  saveLayoutSoon();
}

// Expand a just-placed grid item's height so its widget area doesn't scroll.
function autoFitHeight(item) {
  requestAnimationFrame(() => {
    const widgetArea = item.querySelector(".layout-widget-area");
    if (!widgetArea) return;
    const overflow = widgetArea.scrollHeight - widgetArea.clientHeight;
    if (overflow <= 2) return; // within rounding tolerance
    const gsEl = byId("gs-grid");
    const pxPerRow = gsEl.getBoundingClientRect().height / ROWS;
    if (pxPerRow <= 0) return;
    const extraRows = Math.ceil(overflow / pxPerRow);
    const n = item.gridstackNode;
    if (!n) return;
    const newH = Math.min(ROWS - n.y, n.h + extraRows);
    if (newH > n.h) grid.update(item, { h: newH });
  });
}

// Find best placement for a new card near the drop point.
// Returns { x, y, w, h } — width shrinks to fill available gap, height kept at preferH.
function findFreeCellAndSize(preferX, preferY, preferW, preferH) {
  const occupied = new Set();
  for (const el of grid.getGridItems()) {
    const n = el.gridstackNode;
    if (!n) continue;
    for (let r = n.y; r < n.y + n.h; r++)
      for (let c = n.x; c < n.x + n.w; c++)
        occupied.add(`${r},${c}`);
  }

  // How many consecutive free columns starting at (x,y) for height h?
  const gapWidth = (x, y, h) => {
    let w = 0;
    while (x + w < COLS) {
      let colFree = true;
      for (let r = y; r < y + h && colFree; r++)
        if (occupied.has(`${r},${x + w}`)) colFree = false;
      if (!colFree) break;
      w++;
    }
    return w;
  };

  const tryPlace = (x, y) => {
    if (x < 0 || y < 0 || y + preferH > ROWS) return null;
    const gw = gapWidth(x, y, preferH);
    if (gw < MIN_W) return null;
    return { x, y, w: Math.min(gw, preferW), h: preferH };
  };

  const direct = tryPlace(preferX, preferY);
  if (direct) return direct;

  // BFS outward from drop point
  const seen = new Set([`${preferX},${preferY}`]);
  const queue = [[preferX, preferY]];
  while (queue.length) {
    const [x, y] = queue.shift();
    const r = tryPlace(x, y);
    if (r) return r;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
      const nx = x + dx, ny = y + dy, key = `${nx},${ny}`;
      if (!seen.has(key) && nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS) {
        seen.add(key); queue.push([nx, ny]);
      }
    }
  }
  return { x: 0, y: 0, w: preferW, h: preferH }; // fallback
}

function buildGridItem(stack, node, type = "stack") {
  const item = document.createElement("div");
  item.className = "grid-stack-item";
  item.dataset.stackId = stack.id;
  item.dataset.itemType = type; // "widget" or "stack" — drives drop-zone selection

  if (node) {
    const clampedY = Math.min(node.y, ROWS - Math.max(node.h, MIN_H));
    item.setAttribute("gs-x", Math.max(0, node.x));
    item.setAttribute("gs-y", Math.max(0, clampedY));
    item.setAttribute("gs-w", Math.max(MIN_W, node.w));
    item.setAttribute("gs-h", Math.max(MIN_H, node.h));
  } else {
    item.setAttribute("gs-w", DEF_W);
    item.setAttribute("gs-h", DEF_H);
  }
  item.setAttribute("gs-min-w", MIN_W);
  item.setAttribute("gs-min-h", MIN_H);

  item.appendChild(buildPlacedContent(stack));
  return item;
}

// ── drop zone (palette → grid) ────────────────────────────────────────────────

function setupDropZone() {
  const vp   = byId("preview-viewport");
  const gsEl = byId("gs-grid");

  vp.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    vp.classList.add("drag-over");
  });

  vp.addEventListener("dragleave", (e) => {
    if (!vp.contains(e.relatedTarget)) vp.classList.remove("drag-over");
  });

  vp.addEventListener("drop", async (e) => {
    e.preventDefault();
    vp.classList.remove("drag-over");

    const raw = e.dataTransfer.getData("text/plain");
    if (!raw.startsWith("widget:")) return;

    const widgetId = Number(raw.slice(7));
    const widget = widgetsById[widgetId];
    if (!widget) return;

    const rect  = gsEl.getBoundingClientRect();
    const cellW = rect.width  / COLS;
    const cellH = rect.height / ROWS;
    const rawX = Math.max(0, Math.min(COLS - DEF_W, Math.floor((e.clientX - rect.left) / cellW)));
    const rawY = Math.max(0, Math.min(ROWS - DEF_H, Math.floor((e.clientY - rect.top)  / cellH)));

    // Create a phantom stack — deleted when the card is removed
    const stack = await api.createStack({ name: widget.title, widget_ids: [widgetId] });
    stacks.push(stack);
    phantomStackIds.add(stack.id);

    const { x: gx, y: gy, w: gw, h: gh } = findFreeCellAndSize(rawX, rawY, DEF_W, DEF_H);
    const item = buildGridItem(stack, { x: gx, y: gy, w: gw, h: gh }, "widget");
    gsEl.appendChild(item);
    grid.makeWidget(item);
    autoFitHeight(item);

    placedIds.add(stack.id);
    syncPaletteStates();
    saveLayoutSoon();
  });
}

// ── live data / SSE ───────────────────────────────────────────────────────────

function refreshWidgetArea(el, stack) {
  const content = el.querySelector(".grid-stack-item-content");
  const card    = content?.querySelector(".layout-stack-card");
  if (!card) return;

  // Prefer the initGridItem closure — it preserves pageIdx, arrows, and dot listeners.
  if (card._renderPage) { card._renderPage(); return; }

  // Fallback for any card not yet initialised via initGridItem.
  const validWidgets = stack.widget_ids.map((id) => widgetsById[id]).filter(Boolean);
  const area    = card.querySelector(".layout-widget-area");
  const pagBar  = card.querySelector(".lc-pag-bar");
  if (!area) return;

  area.innerHTML = "";
  if (!validWidgets.length) {
    area.appendChild(Object.assign(document.createElement("div"), { className: "placed-empty", textContent: "No widgets" }));
    if (pagBar) pagBar.innerHTML = "";
    return;
  }
  area.appendChild(renderWidget(validWidgets[0], liveData[validWidgets[0].id] || null, { editable: true }));
  if (pagBar) pagBar.innerHTML = "";
}

function onEnvelope(env) {
  liveData[env.widget_id] = env;
  if (!grid) return;
  for (const el of grid.getGridItems()) {
    const stackId = Number(el.dataset.stackId);
    const stack   = stacks.find((s) => s.id === stackId);
    if (stack?.widget_ids.includes(env.widget_id)) {
      refreshWidgetArea(el, stack);
    }
  }
}

function connectSSE() {
  const es = new EventSource("/api/stream");
  es.onmessage = (e) => { try { onEnvelope(JSON.parse(e.data)); } catch (_) {} };
}

// ── page tabs ─────────────────────────────────────────────────────────────────

function renderPageTabs() {
  const bar   = byId("page-tabs-bar");
  const addBtn = byId("page-tab-add");
  for (const el of [...bar.querySelectorAll(".page-tab")]) el.remove();

  for (let i = 0; i < board.pages.length; i++) {
    const page = board.pages[i];
    const tab  = document.createElement("div");
    tab.className = "page-tab" + (i === currentPageIdx ? " active" : "");
    tab.dataset.pageIdx = i;

    const nameSpan = document.createElement("span");
    nameSpan.className = "page-tab-name";
    nameSpan.textContent = page.name;

    function startRename() {
      const inp = document.createElement("input");
      inp.className = "page-tab-input";
      inp.value = page.name;
      inp.style.width = Math.max(60, nameSpan.offsetWidth + 10) + "px";
      nameSpan.replaceWith(inp);
      inp.focus(); inp.select();
      const commit = () => {
        page.name = inp.value.trim() || page.name;
        inp.replaceWith(nameSpan);
        nameSpan.textContent = page.name;
        saveLayoutSoon();
      };
      inp.addEventListener("blur", commit);
      inp.addEventListener("keydown", (e2) => {
        if (e2.key === "Enter")  { e2.preventDefault(); commit(); }
        if (e2.key === "Escape") { inp.replaceWith(nameSpan); }
      });
    }
    nameSpan.addEventListener("dblclick", (e) => { e.stopPropagation(); startRename(); });

    const renameBtn = document.createElement("button");
    renameBtn.className = "page-tab-rename-btn";
    renameBtn.title = "Rename page";
    renameBtn.textContent = "✎";
    renameBtn.addEventListener("click", (e) => { e.stopPropagation(); startRename(); });

    // Drag-to-reorder
    tab.draggable = true;
    tab.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(i));
      e.dataTransfer.effectAllowed = "move";
      tab.classList.add("dragging");
    });
    tab.addEventListener("dragend", () => tab.classList.remove("dragging"));
    tab.addEventListener("dragover", (e) => { e.preventDefault(); tab.classList.add("drag-over"); });
    tab.addEventListener("dragleave", () => tab.classList.remove("drag-over"));
    tab.addEventListener("drop", (e) => {
      e.preventDefault(); tab.classList.remove("drag-over");
      const fromIdx = Number(e.dataTransfer.getData("text/plain"));
      if (fromIdx === i) return;
      currentPage().layout = currentLayout();
      const [moved] = board.pages.splice(fromIdx, 1);
      board.pages.splice(i, 0, moved);
      if      (currentPageIdx === fromIdx)                              currentPageIdx = i;
      else if (fromIdx < currentPageIdx && i >= currentPageIdx)        currentPageIdx--;
      else if (fromIdx > currentPageIdx && i <= currentPageIdx)        currentPageIdx++;
      renderBoard(); renderPageTabs(); saveLayoutSoon();
    });

    tab.addEventListener("click", () => { if (i !== currentPageIdx) switchPage(i); });
    tab.append(nameSpan, renameBtn);

    if (board.pages.length > 1) {
      const del = document.createElement("button");
      del.className = "page-tab-del"; del.title = "Remove page"; del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm(`Remove page "${page.name}"? Cards on this page will be lost.`)) return;
        board.pages.splice(i, 1);
        if (currentPageIdx >= board.pages.length) currentPageIdx = board.pages.length - 1;
        renderBoard(); renderPageTabs(); saveLayoutSoon();
      });
      tab.appendChild(del);
    }

    bar.insertBefore(tab, addBtn);
  }
}

function switchPage(idx) {
  currentPage().layout = currentLayout();
  currentPageIdx = idx;
  renderBoard();
  renderPageTabs();
}

// ── render board ──────────────────────────────────────────────────────────────

function renderBoard() {
  grid.removeAll();
  placedIds.clear();

  const nodeByStack = Object.fromEntries(currentPage().layout.map((n) => [n.stack_id, n]));
  const gsEl = byId("gs-grid");

  for (const stack of stacks) {
    const node = nodeByStack[stack.id];
    if (!node) continue;
    const savedType = node.item_type || (phantomStackIds.has(stack.id) ? "widget" : "stack");
    const item = buildGridItem(stack, node, savedType);
    gsEl.appendChild(item);
    grid.makeWidget(item);
    placedIds.add(stack.id);
  }
  syncPaletteStates();
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
    hint: "Create an API token in Proxmox under Datacenter → Permissions → API Tokens. Base URL: https://host:8006",
  },
  truenas: {
    label: "TrueNAS", color: "#0095d5",
    fields: [
      { key: "username", label: "Username", placeholder: "e.g. root" },
      { key: "password", label: "Password", type: "password", placeholder: "Account password" },
    ],
    hint: "Enter the username and password for your TrueNAS account.",
  },
  netbox: {
    label: "NetBox", color: "#9c27b0",
    fields: [
      { key: "token", label: "API Token", type: "password", placeholder: "Paste your NetBox API token" },
    ],
    hint: "Find your token in NetBox under Admin → API Tokens",
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

      // Inline edit panel (toggled by ✎)
      const editPanel = document.createElement("div");
      editPanel.className = "settings-edit-panel hidden";
      buildEditForm(editPanel, ds, () => {
        editPanel.classList.add("hidden");
        editPanel.innerHTML = "";
        renderIntegrationsTab();
      });
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

    const credFields = document.createElement("div");
    credFields.className = "settings-cred-fields";

    const hintEl = document.createElement("div");
    hintEl.className = "settings-ds-hint";

    function refreshCredFields() {
      credFields.innerHTML = "";
      const meta = INTEGRATION_META[typeSel.value];
      hintEl.textContent = meta.hint;
      urlInput.placeholder = meta.fields.length ? "https://…" : "https://…";
      for (const f of meta.fields) {
        const inp = Object.assign(document.createElement("input"), {
          className: "sb-form-input",
          placeholder: f.placeholder || f.label,
          type: f.type || "text",
        });
        inp.dataset.credKey = f.key;
        const row = document.createElement("div");
        row.className = "sb-form-row";
        const lbl = document.createElement("div");
        lbl.className = "sb-form-label"; lbl.textContent = f.label;
        row.append(lbl, inp);
        credFields.appendChild(row);
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
      if (open && !guideContent.children.length) populateGuide();
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
      const name = nameInput.value.trim();
      const base_url = urlInput.value.trim();
      if (!name || !base_url) {
        errEl.textContent = "Name and URL are required.";
        errEl.classList.remove("hidden"); return;
      }
      const credentials = {};
      for (const inp of credFields.querySelectorAll("[data-cred-key]")) {
        if (inp.value.trim()) credentials[inp.dataset.credKey] = inp.value.trim();
      }
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
      makeSbRow("Base URL", urlInput),
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
    for (const f of meta.fields) {
      const inp = Object.assign(document.createElement("input"), {
        className: "sb-form-input",
        placeholder: `${f.placeholder || f.label} (leave blank to keep current)`,
        type: f.type || "text",
      });
      inp.dataset.credKey = f.key;
      const row = document.createElement("div");
      row.className = "sb-form-row";
      const lbl = document.createElement("div");
      lbl.className = "sb-form-label"; lbl.textContent = f.label;
      row.append(lbl, inp);
      credFields.appendChild(row);
    }

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
      const base_url = urlInput.value.trim();
      if (!name || !base_url) {
        errEl.textContent = "Name and URL are required.";
        errEl.classList.remove("hidden"); return;
      }
      const credentials = {};
      for (const inp of credFields.querySelectorAll("[data-cred-key]")) {
        if (inp.value.trim()) credentials[inp.dataset.credKey] = inp.value.trim();
      }
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

    formFooter.append(cancelBtn, saveBtn);
    wrap.append(
      typeLbl,
      makeSbRow("Name", nameInput),
      makeSbRow("Base URL", urlInput),
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
    const createGrpBtn = Object.assign(document.createElement("button"), { type: "button", className: "small primary", textContent: "+ Create Group" });
    grpSectionHead.appendChild(createGrpBtn);
    contentEl.appendChild(grpSectionHead);

    // Inline create-group form (hidden until button clicked)
    const createGrpForm = document.createElement("div");
    createGrpForm.className = "pt-add-form hidden";
    const newGrpInput = Object.assign(document.createElement("input"), { className: "sb-form-input", placeholder: "Group name" });
    const saveGrpBtn  = Object.assign(document.createElement("button"), { type: "button", className: "small primary", textContent: "Save" });
    const cancelGrpBtn = Object.assign(document.createElement("button"), { type: "button", className: "small", textContent: "Cancel" });
    createGrpForm.append(newGrpInput, saveGrpBtn, cancelGrpBtn);
    contentEl.appendChild(createGrpForm);

    createGrpBtn.addEventListener("click", () => {
      createGrpForm.classList.remove("hidden");
      createGrpBtn.classList.add("hidden");
      newGrpInput.focus();
    });
    cancelGrpBtn.addEventListener("click", () => {
      createGrpForm.classList.add("hidden");
      createGrpBtn.classList.remove("hidden");
      newGrpInput.value = "";
    });
    saveGrpBtn.addEventListener("click", () => {
      const name = newGrpInput.value.trim();
      if (!name || existingGroups.includes(name)) { newGrpInput.focus(); return; }
      // Groups only exist when targets reference them — pre-populate datalist and show it
      // The group becomes "real" when a target is added with that group name.
      // Store it temporarily so the add-target form can pick it up.
      if (!existingGroups.includes(name)) existingGroups.push(name);
      const opt = document.createElement("option"); opt.value = name; datalist.appendChild(opt);
      newGrpInput.value = "";
      createGrpForm.classList.add("hidden");
      createGrpBtn.classList.remove("hidden");
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
      applyCardStyle(st, previewScope);
      applyCardStyle(st, byId("preview-viewport"));
      applyTheme(theme, byId("preview-viewport"));
      previewScope.dataset.style = theme.style;
      previewScope.dataset.font  = theme.font;
    };

    let _saveTimer = null;
    const saveSettings = () => {
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(() => {
        api.updateSettings({
          theme_style: theme.style, theme_font: theme.font,
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
        }).then(() => {
          Object.assign(currentCardSettings, st, { card_presets: JSON.stringify(presets) });
          Object.assign(currentTheme, theme);
        });
      }, 500);
    };

    const update = () => { applyToPreview(); saveSettings(); };

    // ── buildControls: clears and rebuilds the controls pane ─────────────────
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
      styleSec.appendChild(Object.assign(document.createElement("div"), { className: "ds-section-label", textContent: "Style" }));
      const styleGrid = document.createElement("div");
      styleGrid.className = "ds-style-grid";
      for (const s of STYLES) {
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

      // ── Background section ────────────────────────────────────────────────
      const bgSec = document.createElement("div");
      bgSec.className = "ds-section";
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
      borderSec.className = "ds-section";
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
      accentSec.className = "ds-section";
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
      glowSec.className = "ds-section";
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
        document.body.classList.toggle("tips-on", checked);
        api.updateSettings({ tips_enabled: String(checked) }).catch(() => {});
        // Update topbar toggle button if present
        const tb = byId("tips-toggle-btn");
        if (tb) tb.classList.toggle("active", checked);
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

  if (section === "Ping Targets") renderPingTargetsTab();
  else if (section === "Users") renderUsersTab();
  else if (section === "Integrations") renderIntegrationsTab();
  else if (section === "Designer") renderDesignerTab();
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
        ["Layout", "Drag stacks onto the canvas to arrange your dashboard"],
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

async function init() {
  // Auth check — redirect to login if not authenticated
  let currentUser;
  try {
    currentUser = await api.me();
  } catch {
    window.location.href = "/login";
    return;
  }
  if (!currentUser) { window.location.href = "/login"; return; }

  const userEl = byId("topbar-user");
  if (userEl) userEl.textContent = currentUser.username;

  byId("logout-btn").addEventListener("click", async () => {
    await api.logout().catch(() => {});
    window.location.href = "/login";
  });

  if (currentUser.is_default_password) {
    await showChangePasswordModal();
  }

  const full = await api.boardFull();
  board   = full.board;
  // Normalize: backend always returns pages now, but guard for safety
  if (!board.pages || !board.pages.length) {
    board.pages = [{ id: 1, name: "Page 1", layout: board.layout || [] }];
  }
  stacks  = full.stacks;
  widgets = full.widgets;
  reindex();

  await loadPingTargets();
  fetchLiveData().then(() => { renderWidgets(); refreshGridCards(); });

  const settings = await api.getSettings();

  // Apply contextual tips state
  initTooltips();
  const tipsActive = settings.tips_enabled !== "false";
  if (tipsActive) document.body.classList.add("tips-on");

  // Wire up topbar tips toggle button
  const tipToggleBtn = byId("tips-toggle-btn");
  if (tipToggleBtn) {
    if (tipsActive) tipToggleBtn.classList.add("active");
    tipToggleBtn.addEventListener("click", () => {
      const nowOn = document.body.classList.toggle("tips-on");
      tipToggleBtn.classList.toggle("active", nowOn);
      api.updateSettings({ tips_enabled: String(nowOn) }).catch(() => {});
    });
  }

  if (settings.onboarding_done !== "true") {
    // Also fetch auth/me to check if password is still default
    api.me().then(me => {
      showOnboarding({ ...settings, is_default_password: me.is_default_password });
    }).catch(() => {
      showOnboarding(settings);
    });
  }

  currentTheme.style = settings.theme_style || "classic";
  currentTheme.font  = settings.theme_font  || "inter";
  Object.assign(currentCardSettings, settings);
  applyTheme(currentTheme, byId("preview-viewport"));
  applyCardStyle(currentCardSettings, byId("preview-viewport"));
  if (settings.board_bg_color) { const _vp = byId("preview-viewport"); if (_vp) _vp.style.backgroundColor = settings.board_bg_color; }
  dispW = parseInt(settings.disp_w || "") || 1920;
  dispH = parseInt(settings.disp_h || "") || 720;
  byId("res-w").value = dispW;
  byId("res-h").value = dispH;

  // Migrate layouts stored with old column counts to the fixed COLS×ROWS grid
  if (board.columns !== COLS) {
    const colScale = COLS / (board.columns || 6);
    const rowScale = ROWS / 12; // old MAX_ROWS was 12
    for (const page of board.pages) {
      for (const node of page.layout || []) {
        node.x = Math.round(node.x * colScale);
        node.w = Math.max(MIN_W, Math.round(node.w * colScale));
        node.y = Math.round(node.y * rowScale);
        node.h = Math.max(MIN_H, Math.round(node.h * rowScale));
      }
    }
    board.columns = COLS;
    api.updateBoard({ columns: COLS, pages: board.pages });
  }

  const { w: initW, h: initH } = calcPreview();
  const vp = byId("preview-viewport");
  vp.style.width  = initW + "px";
  vp.style.height = initH + "px";

  const gsEl = byId("gs-grid");
  grid = GridStack.init(
    {
      column: COLS,
      cellHeight: Math.round(initH / ROWS),
      maxRow: ROWS,
      margin: 4,
      float: true,
      minW: MIN_W,
      minH: MIN_H,
      handle: ".layout-drag-handle",
      resizable: { handles: "e,w,s,se,sw,n,ne,nw" },
    },
    gsEl
  );

  grid.on("change", () => saveLayoutSoon());

  let lastMouseX = 0, lastMouseY = 0;
  let isDraggingGridItem = false, currentDraggedEl = null, mergeCandidateEl = null;

  document.addEventListener("mousemove", (e) => {
    lastMouseX = e.clientX; lastMouseY = e.clientY;
    if (!isDraggingGridItem || !currentDraggedEl) return;

    const draggedStackId = Number(currentDraggedEl.dataset.stackId);
    const draggedStack   = stacks.find(s => s.id === draggedStackId);
    const draggedHasIntegration = draggedStack?.widget_ids.some(id => INTEGRATION_TYPES.has(widgetsById[id]?.type));

    let found = null;
    for (const item of grid.getGridItems()) {
      if (item === currentDraggedEl) continue;
      const r = item.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        found = item; break;
      }
    }

    for (const item of grid.getGridItems()) {
      if (item === currentDraggedEl) continue;
      const card = item.querySelector(".layout-stack-card");
      if (!card) continue;
      const targetStack = stacks.find(s => s.id === Number(item.dataset.stackId));
      const targetHasIntegration = targetStack?.widget_ids.some(id => INTEGRATION_TYPES.has(widgetsById[id]?.type));
      card.classList.toggle("merge-target", item === found && !draggedHasIntegration && !targetHasIntegration);
    }
    mergeCandidateEl = found;
  });
  document.addEventListener("mouseup",   (e) => { lastMouseX = e.clientX; lastMouseY = e.clientY; });

  const sidebar = document.querySelector(".stack-palette");

  grid.on("dragstart", (_ev, el) => {
    isDraggingGridItem = true;
    currentDraggedEl   = el;
    mergeCandidateEl   = null;
    sidebar.classList.add("drag-receiving");
    el.dataset.dragStartCol = el.gridstackNode?.x ?? -1;
    el.dataset.dragStartRow = el.gridstackNode?.y ?? -1;
    byId("palette-drop-zone").classList.add("active");
  });

  grid.on("dragstop", async (_ev, el) => {
    isDraggingGridItem = false;
    currentDraggedEl   = null;
    const candidate    = mergeCandidateEl;
    mergeCandidateEl   = null;

    // Clear any merge highlights
    for (const item of grid.getGridItems()) {
      item.querySelector(".layout-stack-card")?.classList.remove("merge-target");
    }

    sidebar.classList.remove("drag-receiving");
    byId("palette-drop-zone").classList.remove("active");
    const sidebarRect = sidebar.getBoundingClientRect();
    const overSidebar =
      lastMouseX >= sidebarRect.left && lastMouseX <= sidebarRect.right &&
      lastMouseY >= sidebarRect.top  && lastMouseY <= sidebarRect.bottom;

    if (overSidebar) {
      const stackId = Number(el.dataset.stackId);
      const stack = stacks.find((s) => s.id === stackId);
      el.classList.add("ejecting");
      setTimeout(async () => {
        grid.removeWidget(el);
        placedIds.delete(stackId);
        phantomStackIds.delete(stackId);
        stacks = stacks.filter((s) => s.id !== stackId);
        await api.deleteStack(stackId).catch(() => {});
        for (const wId of (stack?.widget_ids || [])) {
          const wEl = document.querySelector(`.sb-widget-item[data-widget-id="${wId}"]`);
          if (wEl) {
            wEl.classList.remove("returning");
            void wEl.offsetWidth;
            wEl.classList.add("returning");
            wEl.addEventListener("animationend", () => wEl.classList.remove("returning"), { once: true });
          }
        }
        syncPaletteStates();
        saveLayoutSoon();
      }, 200);
      return;
    }

    // Card-to-card merge: mouse released over another placed card
    if (candidate) {
      const draggedStackId = Number(el.dataset.stackId);
      const draggedStack   = stacks.find(s => s.id === draggedStackId);
      const targetStackId  = Number(candidate.dataset.stackId);
      const targetStack    = stacks.find(s => s.id === targetStackId);

      if (draggedStack && targetStack) {
        const draggedHasIntegration = draggedStack.widget_ids.some(id => INTEGRATION_TYPES.has(widgetsById[id]?.type));
        const targetHasIntegration  = targetStack.widget_ids.some(id => INTEGRATION_TYPES.has(widgetsById[id]?.type));

        if (draggedHasIntegration || targetHasIntegration) {
          // Revert dragged card to its original position
          const origX = Number(el.dataset.dragStartCol ?? -1);
          const origY = Number(el.dataset.dragStartRow ?? -1);
          if (origX >= 0 && origY >= 0) grid.update(el, { x: origX, y: origY });
          showIntegrationToast();
          return;
        }

        // Merge all widgets from dragged stack into target stack
        const newIds  = [...new Set([...targetStack.widget_ids, ...draggedStack.widget_ids])];
        const updated = await api.updateStack(targetStackId, { widget_ids: newIds });
        targetStack.widget_ids = updated.widget_ids;

        grid.removeWidget(el);
        placedIds.delete(draggedStackId);
        phantomStackIds.delete(draggedStackId);
        stacks = stacks.filter(s => s.id !== draggedStackId);
        await api.deleteStack(draggedStackId).catch(() => {});

        const targetGridEl = [...grid.getGridItems()].find(e => Number(e.dataset.stackId) === targetStackId);
        if (targetGridEl) {
          const old = targetGridEl.querySelector(".grid-stack-item-content");
          const newContent = buildPlacedContent(targetStack);
          if (old) old.replaceWith(newContent);
          const newCard = newContent.querySelector(".layout-stack-card");
          if (newCard) {
            newCard.classList.add("merging");
            newCard.addEventListener("animationend", () => newCard.classList.remove("merging"), { once: true });
          }
        }

        syncPaletteStates();
        saveLayoutSoon();
        return;
      }
    }

    const gsRect = gsEl.getBoundingClientRect();
    const overGrid =
      lastMouseX >= gsRect.left && lastMouseX <= gsRect.right &&
      lastMouseY >= gsRect.top  && lastMouseY <= gsRect.bottom;
    if (!overGrid) return;
  });

  setupDropZone();
  setupSectionToggles();
  connectSSE();

  // ── new widget button ──────────────────────────────────────────────────────
  byId("new-widget-btn").addEventListener("click", () => {
    byId("sb-widgets").classList.remove("collapsed");
    openWidgetModal(null);
  });

  // ── topbar settings nav ────────────────────────────────────────────────────
  for (const btn of document.querySelectorAll(".topbar-settings-btn")) {
    btn.addEventListener("click", () => openSettingsPanel(btn.dataset.section));
  }

  renderWidgets();
  renderPageTabs();
  renderBoard();

  byId("page-tab-add").addEventListener("click", () => {
    currentPage().layout = currentLayout();
    const newId = Math.max(0, ...board.pages.map((p) => p.id)) + 1;
    board.pages.push({ id: newId, name: `Page ${newId}`, layout: [] });
    currentPageIdx = board.pages.length - 1;
    renderBoard(); renderPageTabs(); saveLayoutSoon();
  });

  requestAnimationFrame(() => updatePreviewSize());

  function onResChange() {
    dispW = Math.max(320, parseInt(byId("res-w").value) || 1920);
    dispH = Math.max(240, parseInt(byId("res-h").value) || 720);
    api.updateSettings({ disp_w: String(dispW), disp_h: String(dispH) });
    byId("res-w").value = dispW;
    byId("res-h").value = dispH;
    updatePreviewSize();
  }
  byId("res-w").addEventListener("change", onResChange);
  byId("res-h").addEventListener("change", onResChange);

  window.addEventListener("resize", updatePreviewSize);
}

init();
