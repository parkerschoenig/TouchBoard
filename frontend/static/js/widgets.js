// Widget renderers. Each takes (widget, envelope) and returns an HTMLElement.
// `envelope` is the latest poll result: { widget_id, type, data, ts } or null.

import { api } from "./api.js";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ── Per-widget config save ────────────────────────────────────────────────────

async function _saveWidgetConfig(widget, patch) {
  widget.config = { ...(widget.config || {}), ...patch };
  await api.updateWidget(widget.id, {
    title: widget.title, type: widget.type, config: widget.config,
    interval: widget.interval, data_source_id: widget.data_source_id,
  }).catch(console.warn);
}

// ── Floating color-picker popover ─────────────────────────────────────────────

function _openPopover(anchor, buildFn) {
  document.querySelectorAll(".wc-popover-wrap").forEach(e => e.remove());
  const wrap = document.createElement("div");
  wrap.className = "wc-popover-wrap";
  document.body.appendChild(wrap);
  const pop = document.createElement("div");
  pop.className = "wc-popover";
  wrap.appendChild(pop);
  buildFn(pop, () => wrap.remove());
  const rect = anchor.getBoundingClientRect();
  pop.style.top = (rect.bottom + 6) + "px";
  requestAnimationFrame(() => {
    const left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8);
    pop.style.left = Math.max(8, left) + "px";
  });
  const onOutside = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) {
      wrap.remove();
      document.removeEventListener("mousedown", onOutside, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 10);
}

function _openNetBoxColorPicker(anchor, widget, data) {
  const devices = data?.rack?.devices || [];
  const roles   = [...new Set(devices.map(d => d.role).filter(Boolean))];
  _openPopover(anchor, (pop) => {
    pop.appendChild(el("div", "wc-title", "Role Colors"));
    if (!roles.length) {
      pop.appendChild(el("div", "wc-msg", "No device roles found. Switch to Rack Elevation view first."));
      return;
    }
    const saved = { ...(widget.config?.nb_role_colors || {}) };
    for (const role of roles) {
      const row = el("div", "wc-color-row");
      const inp = document.createElement("input");
      inp.type = "color"; inp.className = "wc-color-input";
      inp.value = saved[role] || _roleColor(role);
      inp.addEventListener("input", (e) => {
        saved[role] = e.target.value;
        document.querySelectorAll(".nb-rack-device").forEach(block => {
          if (block.querySelector(".nb-rack-device-role")?.textContent.trim() === role)
            block.style.setProperty("--dev-color", e.target.value);
        });
      });
      inp.addEventListener("change", () =>
        _saveWidgetConfig(widget, { nb_role_colors: { ...(widget.config?.nb_role_colors || {}), ...saved } })
      );
      row.append(inp, el("span", "wc-color-label", role));
      pop.appendChild(row);
    }
  });
}

function _openProxmoxColorPicker(anchor, widget, bodyEl) {
  _openPopover(anchor, (pop) => {
    pop.appendChild(el("div", "wc-title", "Bar Colors"));
    const defaults = { px_cpu_color: "#3b82f6", px_ram_color: "#9333ea" };
    for (const [key, label] of [["px_cpu_color", "CPU"], ["px_ram_color", "RAM"]]) {
      const row = el("div", "wc-color-row");
      const inp = document.createElement("input");
      inp.type = "color"; inp.className = "wc-color-input";
      inp.value = widget.config?.[key] || defaults[key];
      const barType = key === "px_cpu_color" ? "cpu" : "ram";
      inp.addEventListener("input", (e) => {
        bodyEl.querySelectorAll(`.px-bar-fill[data-bar-type="${barType}"]`)
          .forEach(f => (f.style.background = e.target.value));
      });
      inp.addEventListener("change", (e) =>
        _saveWidgetConfig(widget, { [key]: e.target.value })
      );
      row.append(inp, el("span", "wc-color-label", label));
      pop.appendChild(row);
    }
  });
}

// ── Shared view-dots builder ─────────────────────────────────────────────────

function buildViewDots(views, currentView, onSelect) {
  const bar = el("div", "ww-view-dots");
  for (const v of views) {
    const d = el("span", "lc-pag-dot" + (v === currentView ? " active" : ""));
    d.addEventListener("click", (e) => { e.stopPropagation(); onSelect(v); });
    bar.appendChild(d);
  }
  return bar;
}

// ── Weather ───────────────────────────────────────────────────────────────────

const WMO_ICON = {
  0:"☀️", 1:"🌤️", 2:"⛅", 3:"☁️",
  45:"🌫️", 48:"🌫️",
  51:"🌦️", 53:"🌦️", 55:"🌦️", 56:"🌦️", 57:"🌦️",
  61:"🌧️", 63:"🌧️", 65:"🌧️", 66:"🌧️", 67:"🌧️",
  71:"🌨️", 73:"🌨️", 75:"🌨️", 77:"❄️",
  80:"🌦️", 81:"🌦️", 82:"⛈️",
  85:"🌨️", 86:"🌨️",
  95:"⛈️", 96:"⛈️", 99:"⛈️",
};

// Cycles: "current" → "hourly" → "daily" → "current" → …
const _weatherView = new Map(); // widget_id → "current" | "hourly" | "daily"

function renderWeather(widget, data) {
  const view = _weatherView.get(widget.id) || "current";
  const wrap = el("div", "w-weather");

  if (!data) { wrap.appendChild(el("div", "w-empty", "Loading weather…")); return wrap; }
  if (data.unavailable) { wrap.appendChild(el("div", "w-empty", "Weather temporarily unavailable")); return wrap; }
  if (data.error) { wrap.appendChild(el("div", "w-error", "Error: " + data.error)); return wrap; }

  const unitSym = data.unit === "fahrenheit" ? "°F" : "°C";

  const body = el("div", "ww-body");
  wrap.appendChild(body);

  if (view === "current") {
    // ── current conditions ────────────────────────────────────────────────────
    const cur  = data.current;
    const icon = WMO_ICON[cur.weathercode] ?? "🌡️";
    const row1 = el("div", "ww-main-row");
    row1.append(el("span", "ww-icon", icon), el("span", "ww-temp", `${Math.round(cur.temperature)}${unitSym}`));
    const metaRow = el("div", "ww-meta-row");
    metaRow.append(
      el("span", "ww-meta-item", `💧 ${cur.humidity}%`),
      el("span", "ww-meta-item", `💨 ${Math.round(cur.windspeed)} ${data.wind_unit}`),
    );
    body.append(
      el("div", "ww-location", data.location || ""),
      row1,
      el("div", "ww-cond", cur.label),
      el("div", "ww-feels", `Feels like ${Math.round(cur.feels_like)}${unitSym}`),
      metaRow,
    );

  } else if (view === "hourly") {
    // ── hourly (next 12 h) ────────────────────────────────────────────────────
    body.appendChild(el("div", "ww-view-title", "Hourly Forecast"));
    const rows = data.hourly || [];
    for (const h of rows) {
      const dt   = new Date(h.time);
      const time = dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const row  = el("div", "ww-hour-row");
      row.append(
        el("span", "ww-hour-time", time),
        el("span", "ww-day-icon", WMO_ICON[h.weathercode] ?? "🌡️"),
        el("span", "ww-hour-temp", `${Math.round(h.temperature)}${unitSym}`),
        el("span", "ww-day-precip", h.precip_prob > 0 ? `💧${h.precip_prob}%` : ""),
      );
      body.appendChild(row);
    }
    if (!rows.length) body.appendChild(el("div", "w-empty", "No hourly data"));

  } else {
    // ── N-day daily ───────────────────────────────────────────────────────────
    const dayCount = (data.daily || []).length;
    body.appendChild(el("div", "ww-view-title", `${dayCount}-Day Forecast`));
    for (const day of data.daily || []) {
      const date    = new Date(day.date + "T12:00:00");
      const isToday = date.toDateString() === new Date().toDateString();
      const name    = isToday ? "Today" : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      const row = el("div", "ww-day-row");
      row.append(
        el("span", "ww-day-name", name),
        el("span", "ww-day-icon", WMO_ICON[day.weathercode] ?? "🌡️"),
        el("span", "ww-day-cond", day.label),
        el("span", "ww-day-temp", `${Math.round(day.temp_max)}° / ${Math.round(day.temp_min)}°`),
      );
      if (day.precip_prob != null && day.precip_prob > 20)
        row.appendChild(el("span", "ww-day-precip", `💧${day.precip_prob}%`));
      body.appendChild(row);
    }
  }

  const weatherViews = ["current", "hourly", "daily"];
  wrap.appendChild(buildViewDots(weatherViews, view, (v) => {
    _weatherView.set(widget.id, v);
    wrap.replaceWith(renderWeather(widget, data));
  }));

  wrap.addEventListener("click", (e) => {
    e.stopPropagation();
    const next = view === "current" ? "hourly" : view === "hourly" ? "daily" : "current";
    _weatherView.set(widget.id, next);
    wrap.replaceWith(renderWeather(widget, data));
  });

  return wrap;
}

function renderPingRow(t) {
  const row = el("div", "ping-row");
  row.appendChild(el("span", "dot " + (t.up ? "up" : "down")));
  row.appendChild(el("span", "ping-label", t.label || t.address));
  const meta = el("span", "ping-meta");
  meta.textContent = t.up
    ? (t.latency_ms != null ? `${t.latency_ms} ms` : "up")
    : (t.detail || "down");
  row.appendChild(meta);
  return row;
}

function renderPing(widget, data) {
  const wrap = el("div", "w-ping");
  const targets = (data && data.targets) || [];
  if (!targets.length) {
    wrap.appendChild(el("div", "w-empty", "No targets configured"));
    return wrap;
  }

  const hasGroups = targets.some((t) => t.group);
  if (!hasGroups) {
    for (const t of targets) wrap.appendChild(renderPingRow(t));
    return wrap;
  }

  // Preserve order of first appearance for each group
  const groupOrder = [];
  const grouped = {};
  for (const t of targets) {
    const key = t.group || "";
    if (!grouped[key]) { grouped[key] = []; groupOrder.push(key); }
    grouped[key].push(t);
  }

  for (const key of groupOrder) {
    if (key) wrap.appendChild(el("div", "ping-group-header", key));
    for (const t of grouped[key]) wrap.appendChild(renderPingRow(t));
  }
  return wrap;
}

function renderStub(widget, data) {
  const wrap = el("div", "w-stub");
  const msg = (data && (data.message || data.status)) || "Not yet implemented";
  wrap.appendChild(el("div", "w-stub-type", widget.type));
  wrap.appendChild(el("div", "w-empty", msg));
  return wrap;
}

// ── Clock ─────────────────────────────────────────────────────────────────────

const _clockTimers = new Map(); // widget.id → intervalId

function _tzNow(tz) {
  try {
    if (!tz) throw 0;
    const str = new Date().toLocaleString("en-US", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const [hh, mm, ss] = str.split(":").map(Number);
    return { h: hh === 24 ? 0 : hh, m: mm, s: ss };
  } catch {
    const d = new Date();
    return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
  }
}

function buildAnalogSvg(style, tz) {
  const { h, m, s } = _tzNow(tz);
  const ns = "http://www.w3.org/2000/svg";
  function mkEl(tag, attrs) {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }
  function pt(deg, r) {
    const rad = (deg - 90) * Math.PI / 180;
    return [50 + r * Math.cos(rad), 50 + r * Math.sin(rad)];
  }

  const svg = mkEl("svg", { viewBox: "0 0 100 100", width: "100%", height: "100%", class: "wc-analog" });
  const hDeg = ((h % 12) + m / 60) * 30;
  const mDeg = (m + s / 60) * 6;
  const sDeg = s * 6;

  if (style !== "minimal") {
    svg.appendChild(mkEl("circle", { cx:50, cy:50, r:48, fill:"none", stroke:"currentColor", "stroke-width":"1.5", opacity:"0.35" }));
  }

  if (style === "classic") {
    for (let i = 0; i < 60; i++) {
      const major = i % 5 === 0;
      const [x1,y1] = pt(i * 6, major ? 41 : 45);
      const [x2,y2] = pt(i * 6, 48);
      svg.appendChild(mkEl("line", { x1,y1,x2,y2, stroke:"currentColor", "stroke-width": major ? "2" : "0.8", opacity: major ? "0.75" : "0.3" }));
    }
  } else if (style === "modern") {
    for (const angle of [0, 90, 180, 270]) {
      const [cx,cy] = pt(angle, 43);
      svg.appendChild(mkEl("circle", { cx,cy, r:"2.5", fill:"currentColor", opacity:"0.65" }));
    }
  }

  const [hx,hy] = pt(hDeg, 28);
  svg.appendChild(mkEl("line", { x1:50,y1:50,x2:hx,y2:hy, stroke:"white", "stroke-width":"4.5", "stroke-linecap":"round" }));
  const [mx,my] = pt(mDeg, 38);
  svg.appendChild(mkEl("line", { x1:50,y1:50,x2:mx,y2:my, stroke:"white", "stroke-width":"2.5", "stroke-linecap":"round" }));

  if (style !== "minimal") {
    const [sx,sy]   = pt(sDeg, 42);
    const [stx,sty] = pt(sDeg + 180, 12);
    svg.appendChild(mkEl("line", { x1:stx,y1:sty,x2:sx,y2:sy, stroke:"#f87171", "stroke-width":"1.5", "stroke-linecap":"round" }));
    svg.appendChild(mkEl("circle", { cx:50,cy:50, r:"2", fill:"#f87171" }));
  }
  svg.appendChild(mkEl("circle", { cx:50,cy:50, r:"3.5", fill:"white" }));

  return svg;
}

function buildDigitalEl(format, style, tz) {
  let { h, m, s } = _tzNow(tz);
  let ampm = "";
  if (format === "12h") {
    ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
  }
  const hStr = String(h).padStart(2, "0");
  const mStr = String(m).padStart(2, "0");
  const sStr = String(s).padStart(2, "0");

  const wrap = el("div", "wc-digital");

  if (style === "minimal") {
    wrap.appendChild(el("div", "wc-hm", `${hStr}:${mStr}`));
    if (ampm) wrap.appendChild(el("div", "wc-ampm", ampm));
  } else {
    const row = el("div", "wc-row");
    row.appendChild(el("span", "wc-hm", `${hStr}:${mStr}`));
    row.appendChild(el("span", "wc-sec", sStr));
    wrap.appendChild(row);
    if (ampm) wrap.appendChild(el("div", "wc-ampm", ampm));
  }
  return wrap;
}

function renderClock(widget, _data) {
  const cfg    = widget.config || {};
  const mode   = cfg.clock_mode     || "digital";
  const format = cfg.clock_format   || "12h";
  const style  = cfg.clock_style    || "clean";
  const tz     = cfg.clock_timezone || "";

  const wrap = el("div", `w-clock wc-${style}`);

  function tick() {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(mode === "analog" ? buildAnalogSvg(style, tz) : buildDigitalEl(format, style, tz));
  }

  tick();
  if (_clockTimers.has(widget.id)) clearInterval(_clockTimers.get(widget.id));
  _clockTimers.set(widget.id, setInterval(tick, 1000));

  return wrap;
}

// ── NetBox ────────────────────────────────────────────────────────────────────

const _netboxView = new Map(); // widget.id → "rack" | "devices" | "ips"

// Theme-matched palette — each unique role name gets a consistent color from this set
const _NB_PALETTE = ["#3b82f6","#6366f1","#8b5cf6","#0ea5e9","#14b8a6","#06b6d4","#a855f7","#2563eb","#0891b2","#7c3aed"];

function _roleColor(role, widgetConfig = {}) {
  const saved = widgetConfig?.nb_role_colors?.[role];
  if (saved) return saved;
  if (!role) return _NB_PALETTE[0];
  let h = 0;
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) & 0xffff;
  return _NB_PALETTE[h % _NB_PALETTE.length];
}

function _buildRack(rack, widgetConfig = {}) {
  const wrap = el("div", "nb-rack");
  if (!rack || rack.error) {
    wrap.appendChild(el("div", "nb-rack-error", (rack && rack.error) || "No rack data"));
    return wrap;
  }

  const hdr = el("div", "nb-rack-header");
  hdr.append(el("span", "nb-rack-name", rack.name), el("span", "nb-rack-meta", `${rack.u_height}U`));
  if (rack.site) hdr.appendChild(el("span", "nb-rack-site", rack.site));
  wrap.appendChild(hdr);

  const { u_height = 42, devices = [] } = rack;

  // slot map: index 0 = U1 (bottom), index u_height-1 = top U
  const slots = new Array(u_height).fill(null);
  for (const d of devices) {
    for (let u = d.position; u < d.position + d.u_height && u <= u_height; u++) {
      slots[u - 1] = d;
    }
  }

  const col = el("div", "nb-rack-col");
  let i = u_height - 1; // start from top
  while (i >= 0) {
    const d = slots[i];
    if (d) {
      let span = 0;
      while (i - span >= 0 && slots[i - span] === d) span++;
      const block = el("div", "nb-rack-device");
      block.style.setProperty("--span", span);
      block.style.setProperty("--dev-color", _roleColor(d.role, widgetConfig));

      const uLabel = d.u_height > 1
        ? `U${d.position}–U${d.position + d.u_height - 1}`
        : `U${d.position}`;
      const nameRow = el("div", "nb-rack-device-top");
      nameRow.append(el("span", "nb-rack-device-name", d.name), el("span", "nb-rack-device-u", uLabel));
      block.appendChild(nameRow);
      if (d.role) block.appendChild(el("span", "nb-rack-device-role", d.role));
      col.appendChild(block);
      i -= span;
    } else {
      let span = 0;
      while (i - span >= 0 && slots[i - span] === null) span++;
      const empty = el("div", "nb-rack-empty");
      empty.style.setProperty("--span", span);
      const topU = i + 1;
      const botU = i - span + 2;
      const uLabel = span === 1 ? `U${topU}` : `U${botU}–U${topU}`;
      empty.appendChild(el("span", "nb-rack-empty-u", uLabel));
      col.appendChild(empty);
      i -= span;
    }
  }
  wrap.appendChild(col);
  return wrap;
}

const _NB_ALL_VIEWS = ["rack", "devices", "ips", "vms"];

function _nbPages(widget) {
  const cv = widget.config?.views;
  if (!cv?.length) return [..._NB_ALL_VIEWS];
  const pages = cv.filter(v => v.enabled !== false).map(v => v.key).filter(k => _NB_ALL_VIEWS.includes(k));
  // Append any newly added views not yet present in the saved config
  for (const k of _NB_ALL_VIEWS) {
    if (!cv.some(v => v.key === k)) pages.push(k);
  }
  return pages.length ? pages : [..._NB_ALL_VIEWS];
}

function renderNetBox(widget, data) {
  const pages = _nbPages(widget);
  let view = _netboxView.get(widget.id) || pages[0];
  if (!pages.includes(view)) view = pages[0];

  const wrap = el("div", "w-netbox");

  if (!data) { wrap.appendChild(el("div", "w-empty", "Loading NetBox…")); return wrap; }
  if (data.error) { wrap.appendChild(el("div", "w-error", "Error: " + data.error)); return wrap; }

  const body = el("div", "nb-body");
  wrap.appendChild(body);

  if (view === "rack") {
    body.appendChild(_buildRack(data.rack, widget.config));

  } else if (view === "devices") {
    const count = data.total_devices;
    body.appendChild(el("div", "nb-big-num", count != null ? String(count) : "—"));
    body.appendChild(el("div", "nb-big-label", "Total Devices"));

  } else if (view === "ips") {
    body.appendChild(el("div", "nb-view-title",
      `IPs${data.total_ips != null ? " · " + data.total_ips + " total" : ""}`));
    for (const ip of data.ips || []) {
      const row = el("div", "nb-ip-row");
      const dot = el("span", "nb-ip-dot");
      dot.style.background = ip.status === "active" ? "#22c55e"
                           : ip.status === "deprecated" ? "#ef4444" : "#6b7280";
      row.append(dot, el("span", "nb-ip-addr", ip.address));
      const label = ip.assigned_device || ip.dns_name || ip.description;
      if (label) row.appendChild(el("span", "nb-ip-dns", label));
      body.appendChild(row);
    }
    if (!data.ips?.length) body.appendChild(el("div", "w-empty", "No IPs returned"));

  } else if (view === "vms") {
    body.appendChild(el("div", "nb-view-title",
      `Virtual Machines${data.total_vms != null ? " · " + data.total_vms + " total" : ""}`));
    for (const vm of data.vms || []) {
      const row = el("div", "nb-vm-row");
      row.appendChild(el("span", "nb-vm-name", vm.name));
      body.appendChild(row);
    }
    if (!data.vms?.length) body.appendChild(el("div", "w-empty", "No VMs returned"));
  }

  if (pages.length > 1) {
    wrap.appendChild(buildViewDots(pages, view, (v) => {
      _netboxView.set(widget.id, v);
      wrap.replaceWith(renderNetBox(widget, data));
    }));
    wrap.addEventListener("click", (e) => {
      e.stopPropagation();
      _netboxView.set(widget.id, pages[(pages.indexOf(view) + 1) % pages.length]);
      wrap.replaceWith(renderNetBox(widget, data));
    });
  }

  return wrap;
}

// ── TrueNAS ───────────────────────────────────────────────────────────────────

const _tnView = new Map(); // widget.id → "storage" | "memory" | "cpu"

function _fmtBytes(bytes) {
  if (bytes == null || bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
}

function _miniBar(pct, warn) {
  const wrap = el("div", "tn-bar-wrap");
  const fill = el("div", "tn-bar-fill");
  fill.style.width = Math.min(100, pct) + "%";
  if (warn) fill.classList.add("warn");
  wrap.appendChild(fill);
  return wrap;
}

function _gaugeColor(pct) {
  return pct > 85 ? "#ef4444" : pct > 65 ? "#fb923c" : "#22c55e";
}

// Multi-segment donut SVG. segments: [{color, pct}]
// center: optional {text, color} to render text in the middle of the ring
function _buildDonut(segments, center = null) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.classList.add("tn-donut-svg");

  function mkRing(stroke, pct, offset) {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", "18"); c.setAttribute("cy", "18"); c.setAttribute("r", "15.9155");
    c.setAttribute("fill", "none"); c.setAttribute("stroke", stroke);
    c.setAttribute("stroke-width", "3.8");
    c.setAttribute("stroke-dasharray", `${pct} ${100 - pct}`);
    c.setAttribute("stroke-dashoffset", String(offset));
    return c;
  }

  svg.appendChild(mkRing("#2d3748", 100, 0));
  let cum = 0;
  for (const { color, pct } of segments) {
    if (pct < 0.3) { cum += pct; continue; }
    svg.appendChild(mkRing(color, pct, 25 - cum));
    cum += pct;
  }

  if (center) {
    const txt = document.createElementNS(ns, "text");
    txt.setAttribute("x", "18");
    txt.setAttribute("y", "18");
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("dominant-baseline", "middle");
    txt.setAttribute("fill", center.color || "#e6edf3");
    txt.setAttribute("font-size", "6.5");
    txt.setAttribute("font-weight", "700");
    txt.textContent = center.text;
    svg.appendChild(txt);
  }

  return svg;
}

function renderTruenas(widget, data) {
  if (!data) {
    const w = el("div", "w-truenas"); w.appendChild(el("div", "w-empty", "Loading TrueNAS…")); return w;
  }
  if (data.error) {
    const w = el("div", "w-truenas"); w.appendChild(el("div", "w-error", data.error)); return w;
  }

  // Pages available from data
  const dataPages = new Set(["storage"]); // storage always available
  if (data.mem_total != null) dataPages.add("memory");
  if (data.cpu_pct   != null) dataPages.add("cpu");

  // Apply user-configured order/enable, filtered to what data provides
  const cv = widget.config?.views;
  const userOrder = cv?.length
    ? cv.filter(v => v.enabled !== false).map(v => v.key)
    : ["storage", "memory", "cpu"];
  const pages = userOrder.filter(k => dataPages.has(k));
  if (!pages.length) pages.push("storage");

  let view = _tnView.get(widget.id) || pages[0];
  if (!pages.includes(view)) view = pages[0];

  const wrap = el("div", "w-truenas");
  const body = el("div", "tn-body");
  wrap.appendChild(body);

  // ── Storage page ──────────────────────────────────────────────────────────
  if (view === "storage") {
    const pools = data.pools || [];
    if (!pools.length) {
      body.appendChild(el("div", "w-empty", "No pools found"));
      if (data.pools_error)
        body.appendChild(el("div", "tn-report-error", data.pools_error));
    } else {
      for (const pool of pools) {
        const pct  = pool.total > 0 ? Math.round(pool.used / pool.total * 100) : 0;
        const pDiv = el("div", "tn-pool");
        const head = el("div", "tn-pool-head");
        head.appendChild(el("span", "tn-pool-name", pool.name));
        const badge = el("span", `tn-pool-status tn-status-${pool.status.toLowerCase()}`);
        badge.textContent = pool.status;
        head.appendChild(badge);
        pDiv.appendChild(head);
        pDiv.appendChild(_miniBar(pct, pct > 85));
        const usage = el("div", "tn-usage-row");
        usage.appendChild(el("span", "tn-usage-pct", pct + "%"));
        usage.appendChild(el("span", "tn-usage-detail", `${_fmtBytes(pool.used)} / ${_fmtBytes(pool.total)}`));
        pDiv.appendChild(usage);
        body.appendChild(pDiv);
      }
    }
  }

  // ── Memory page ───────────────────────────────────────────────────────────
  else if (view === "memory") {
    const total = data.mem_total;
    const free  = data.mem_free ?? (total - (data.mem_used ?? 0));
    const arc   = data.mem_arc  ?? 0;
    const svc   = Math.max(0, total - free - arc);

    const freePct = (free / total) * 100;
    const arcPct  = (arc  / total) * 100;
    const svcPct  = (svc  / total) * 100;

    const page = el("div", "tn-page-memory");

    page.appendChild(_buildDonut([
      { color: "#3b82f6", pct: freePct },
      { color: "#9333ea", pct: arcPct  },
      { color: "#f97316", pct: svcPct  },
    ]));

    const legend = el("div", "tn-mem-legend");
    // Total row
    const totalRow = el("div", "tn-mem-legend-row");
    totalRow.appendChild(el("span", "tn-ml-label", "Total Memory"));
    totalRow.appendChild(el("span", "tn-ml-val", _fmtBytes(total)));
    legend.appendChild(totalRow);
    // Coloured rows
    for (const [color, label, bytes] of [
      ["#3b82f6", "Free",      free],
      ["#9333ea", "ZFS Cache", arc ],
      ["#f97316", "Services",  svc ],
    ]) {
      if (bytes <= 0) continue;
      const row = el("div", "tn-mem-legend-row");
      const lbl = el("span", "tn-ml-label", label);
      const val = el("span", "tn-ml-val",   _fmtBytes(bytes));
      lbl.style.color = color;
      val.style.color = color;
      row.appendChild(lbl);
      row.appendChild(val);
      legend.appendChild(row);
    }
    page.appendChild(legend);
    body.appendChild(page);
  }

  // ── CPU page ──────────────────────────────────────────────────────────────
  else if (view === "cpu") {
    const color = _gaugeColor(data.cpu_pct);
    const page  = el("div", "tn-page-cpu");
    page.appendChild(_buildDonut(
      [{ color, pct: data.cpu_pct }],
      { text: data.cpu_pct.toFixed(1) + "%", color },
    ));
    const cpuInfo = el("div", "tn-cpu-info");
    cpuInfo.appendChild(el("div", "tn-stat-label", "CPU Usage"));
    page.appendChild(cpuInfo);
    body.appendChild(page);
  }

  // ── Dot navigation ────────────────────────────────────────────────────────
  if (pages.length > 1) {
    wrap.appendChild(buildViewDots(pages, view, (v) => {
      _tnView.set(widget.id, v);
      wrap.replaceWith(renderTruenas(widget, data));
    }));
    wrap.addEventListener("click", (e) => {
      e.stopPropagation();
      _tnView.set(widget.id, pages[(pages.indexOf(view) + 1) % pages.length]);
      wrap.replaceWith(renderTruenas(widget, data));
    });
  }

  return wrap;
}

// ── Proxmox ───────────────────────────────────────────────────────────────────

function _fmtUptime(sec) {
  if (!sec) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
        m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || !parts.length) parts.push(`${m}m`);
  return parts.join(" ");
}

function _pxBar(pct, color, barType) {
  const wrap = el("div", "px-bar");
  const fill = el("div", "px-bar-fill");
  fill.style.width = Math.min(100, pct) + "%";
  fill.style.background = color;
  if (barType) fill.dataset.barType = barType;
  wrap.appendChild(fill);
  return wrap;
}

function _pxPct(pct) {
  const color = pct > 85 ? "#ef4444" : pct > 65 ? "#fb923c" : "#22c55e";
  const span = el("span", "px-pct", pct.toFixed(1) + "%");
  span.style.color = color;
  return span;
}

function _pxStatusDot(status) {
  const dot = el("span", "px-dot");
  dot.style.background = status === "running" || status === "online" || status === "active"
    ? "#22c55e" : status === "stopped" ? "#6b7280" : "#ef4444";
  return dot;
}

function _pxSection(title, count, total, items, columns) {
  const sec = el("div", "px-section");

  // Section header
  const head = el("div", "px-sec-head");
  head.appendChild(el("span", "px-sec-title", title));
  const badge = el("span", "px-sec-badge", `${count} / ${total}`);
  head.appendChild(badge);
  sec.appendChild(head);

  if (!items.length) return sec;

  const gridCols = `repeat(${columns.length}, 1fr)`;

  // Column headers
  const colHead = el("div", "px-row px-col-head");
  colHead.style.gridTemplateColumns = gridCols;
  for (const col of columns) {
    colHead.appendChild(el("span", "px-col", col.label));
  }
  sec.appendChild(colHead);

  // Rows
  for (const item of items) {
    const row = el("div", "px-row");
    row.style.gridTemplateColumns = gridCols;
    for (const col of columns) {
      const cell = el("span", "px-col");
      const val = col.render(item);
      if (typeof val === "string") cell.textContent = val;
      else cell.appendChild(val);
      row.appendChild(cell);
    }
    sec.appendChild(row);
  }

  return sec;
}

function renderProxmox(widget, data) {
  const wrap = el("div", "w-proxmox");
  if (!data) { wrap.appendChild(el("div", "w-empty", "Loading Proxmox…")); return wrap; }
  if (data.error) { wrap.appendChild(el("div", "w-error", data.error)); return wrap; }
  const cpuColor = widget.config?.px_cpu_color || "#3b82f6";
  const ramColor = widget.config?.px_ram_color || "#9333ea";

  // ── Header: uptime + cluster stats ───────────────────────────────────────
  const hdr = el("div", "px-header");

  const upEl = el("div", "px-uptime", `Uptime: ${_fmtUptime(data.uptime)}`);
  hdr.appendChild(upEl);

  const stats = el("div", "px-stats");
  for (const [label, pct] of [["CPU", data.cluster_cpu_pct], ["RAM", data.cluster_mem_pct]]) {
    const chip = el("div", "px-stat-chip");
    const color = pct > 85 ? "#ef4444" : pct > 65 ? "#fb923c" : "#22c55e";
    const ring = _buildDonut([{ color, pct }], { text: pct?.toFixed(1) + "%", color });
    ring.classList.add("px-mini-donut");
    chip.appendChild(ring);
    chip.appendChild(el("span", "px-stat-label", label));
    stats.appendChild(chip);
  }
  hdr.appendChild(stats);
  wrap.appendChild(hdr);

  const body = el("div", "px-body");
  wrap.appendChild(body);

  // ── Nodes ─────────────────────────────────────────────────────────────────
  const onlineNodes = (data.nodes || []).filter(n => n.status === "online").length;
  body.appendChild(_pxSection("Nodes", onlineNodes, data.nodes.length, data.nodes, [
    { label: "Name",  render: n => { const d = el("div","px-name-cell"); d.append(_pxStatusDot(n.status), el("span","",n.name)); return d; } },
    { label: "CPU",   render: n => { const d = el("div","px-bar-cell"); d.append(_pxBar(n.cpu_pct, cpuColor, "cpu"), _pxPct(n.cpu_pct)); return d; } },
    { label: "RAM",   render: n => { const d = el("div","px-bar-cell"); d.append(_pxBar(n.mem_pct, ramColor, "ram"), _pxPct(n.mem_pct)); return d; } },
  ]));

  // ── VMs ───────────────────────────────────────────────────────────────────
  const runningVms = (data.vms || []).filter(v => v.status === "running").length;
  body.appendChild(_pxSection("VMs", runningVms, data.vms.length, data.vms, [
    { label: "Name",  render: v => { const d = el("div","px-name-cell"); d.append(_pxStatusDot(v.status), el("span","",v.name)); return d; } },
    { label: "CPU",   render: v => v.status === "running" ? (() => { const d = el("div","px-bar-cell"); d.append(_pxBar(v.cpu_pct, cpuColor, "cpu"), _pxPct(v.cpu_pct)); return d; })() : el("span","px-muted","—") },
    { label: "RAM",   render: v => v.status === "running" ? (() => { const d = el("div","px-bar-cell"); d.append(_pxBar(v.mem_pct, ramColor, "ram"), _pxPct(v.mem_pct)); return d; })() : el("span","px-muted","—") },
  ]));

  // ── LXCs ──────────────────────────────────────────────────────────────────
  const runningLxcs = (data.lxcs || []).filter(c => c.status === "running").length;
  body.appendChild(_pxSection("LXCs", runningLxcs, data.lxcs.length, data.lxcs, [
    { label: "Name",  render: c => { const d = el("div","px-name-cell"); d.append(_pxStatusDot(c.status), el("span","",c.name)); return d; } },
    { label: "CPU",   render: c => c.status === "running" ? (() => { const d = el("div","px-bar-cell"); d.append(_pxBar(c.cpu_pct, cpuColor, "cpu"), _pxPct(c.cpu_pct)); return d; })() : el("span","px-muted","—") },
    { label: "RAM",   render: c => c.status === "running" ? (() => { const d = el("div","px-bar-cell"); d.append(_pxBar(c.mem_pct, ramColor, "ram"), _pxPct(c.mem_pct)); return d; })() : el("span","px-muted","—") },
  ]));

  // ── Storage ───────────────────────────────────────────────────────────────
  const activeStorage = (data.storage || []).filter(s => s.status === "active").length;
  body.appendChild(_pxSection("Storage", activeStorage, data.storage.length, data.storage, [
    { label: "Name", render: s => { const d = el("div","px-name-cell"); d.append(_pxStatusDot(s.status), el("span","",s.storage)); return d; } },
    { label: "Node", render: s => el("span","px-muted",s.node) },
  ]));

  return wrap;
}

function renderAdGuard(widget, data) {
  const wrap = el("div", "w-adguard");
  if (!data) { wrap.appendChild(el("div", "w-empty", "Loading AdGuard…")); return wrap; }
  if (data.error) { wrap.appendChild(el("div", "w-error", data.error)); return wrap; }

  function fmt(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000)     return (n / 1_000).toFixed(2) + "k";
    return String(n);
  }

  const stats = [
    { value: fmt(data.blocked_today),          label: "Blocked today",        color: "#c0392b", icon: "🛡️" },
    { value: data.blocked_pct.toFixed(2) + "%", label: "Blocked today",       color: "#9a7d0a", icon: "%" },
    { value: fmt(data.queries_today),           label: "Queries today",        color: "#1a6b6b", icon: "🔍" },
    { value: fmt(data.domains_on_blocklist),    label: "Domains on blocklist", color: "#1a6b3a", icon: "🌐" },
  ];

  const grid = el("div", "ag-grid");
  for (const s of stats) {
    const card = el("div", "ag-card");
    card.style.background = s.color;
    const iconEl = el("span", "ag-icon", s.icon);
    const valEl  = el("div", "ag-value", s.value);
    const lblEl  = el("div", "ag-label", s.label);
    card.append(iconEl, valEl, lblEl);
    grid.appendChild(card);
  }
  wrap.appendChild(grid);
  return wrap;
}

function renderOpnsense(widget, data) {
  const wrap = el("div", "w-opnsense");
  if (!data) { wrap.appendChild(el("div", "w-empty", "Loading OPNsense…")); return wrap; }
  if (data.error) { wrap.appendChild(el("div", "w-error", data.error)); return wrap; }

  function fmtRate(mbps) {
    if (mbps < 1) return (mbps * 1000).toFixed(1) + " kb/s";
    return mbps.toFixed(1) + " Mb/s";
  }

  // ── Header donuts ─────────────────────────────────────────────────────────
  const hdr = el("div", "op-header");

  for (const { pct, color, label } of [
    { pct: data.cpu_pct, color: "#f97316", label: "CPU" },
    { pct: data.mem_pct, color: "#3b82f6", label: "Memory" },
  ]) {
    const wrap2 = el("div", "op-donut-wrap");
    const donut = _buildDonut([{ color, pct }], { text: pct?.toFixed(0) + "%", color });
    donut.classList.add("op-donut");
    wrap2.appendChild(donut);
    wrap2.appendChild(el("div", "op-donut-label", label));
    hdr.appendChild(wrap2);
  }
  wrap.appendChild(hdr);

  // ── Interface table ───────────────────────────────────────────────────────
  const table = el("div", "op-iface-table");
  const ifaces = data.interfaces || [];
  if (!ifaces.length) {
    table.appendChild(el("div", "w-empty", "No interfaces"));
  } else {
    for (const iface of ifaces) {
      const row = el("div", "op-iface-row");
      row.appendChild(el("span", "op-iface-name", iface.name || iface.device));
      const tx = el("span", "op-iface-tx", "↑ " + fmtRate(iface.tx_mbps));
      const rx = el("span", "op-iface-rx", "↓ " + fmtRate(iface.rx_mbps));
      row.append(tx, rx);
      table.appendChild(row);
    }
  }
  wrap.appendChild(table);
  return wrap;
}

const RENDERERS = { ping: renderPing, weather: renderWeather, clock: renderClock, netbox: renderNetBox, truenas: renderTruenas, proxmox: renderProxmox, adguard: renderAdGuard, opnsense: renderOpnsense };

// Public: build the full widget card (title + body) for a given envelope.
// opts.editable = true shows per-widget controls (theme toggle, color picker).
export function renderWidget(widget, envelope, opts = {}) {
  const card = el("div", "widget");
  if (widget.config?.widget_theme === "light") card.classList.add("widget--light");

  // Build body first so control closures can reference it
  const body = el("div", "widget-body");
  const data = envelope?.data ?? null;
  if (data?.error) {
    body.appendChild(el("div", "w-error", "Error: " + data.error));
  } else {
    body.appendChild((RENDERERS[widget.type] || renderStub)(widget, data));
  }

  const head = el("div", "widget-head");
  head.appendChild(el("span", "widget-title", widget.title));

  if (opts.editable) {
    const ctrlBar = el("div", "widget-ctrl-bar");

    // Theme toggle — all widget types
    const isLight = widget.config?.widget_theme === "light";
    const themeBtn = el("button", "widget-ctrl widget-ctrl-theme");
    themeBtn.title = isLight ? "Switch to dark" : "Switch to light";
    themeBtn.dataset.tip = "Toggle light/dark text";
    themeBtn.textContent = isLight ? "☾" : "☀";
    themeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const next = widget.config?.widget_theme === "light" ? "dark" : "light";
      await _saveWidgetConfig(widget, { widget_theme: next });
      card.classList.toggle("widget--light", next === "light");
      themeBtn.textContent = next === "light" ? "☾" : "☀";
      themeBtn.title       = next === "light" ? "Switch to dark" : "Switch to light";
    });
    ctrlBar.appendChild(themeBtn);

    // Paintbrush — NetBox role colors
    if (widget.type === "netbox") {
      const brushBtn = el("button", "widget-ctrl widget-ctrl-brush");
      brushBtn.title = "Edit role colors";
      brushBtn.dataset.tip = "Edit device role colors";
      brushBtn.textContent = "🖌";
      brushBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _openNetBoxColorPicker(brushBtn, widget, envelope?.data);
      });
      ctrlBar.appendChild(brushBtn);
    }

    // Paintbrush — Proxmox bar colors
    if (widget.type === "proxmox") {
      const brushBtn = el("button", "widget-ctrl widget-ctrl-brush");
      brushBtn.title = "Edit bar colors";
      brushBtn.dataset.tip = "Edit CPU/RAM bar colors";
      brushBtn.textContent = "🖌";
      brushBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _openProxmoxColorPicker(brushBtn, widget, body);
      });
      ctrlBar.appendChild(brushBtn);
    }

    head.appendChild(ctrlBar);
  }

  card.appendChild(head);
  card.appendChild(body);
  return card;
}
