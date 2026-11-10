// Right-hand inspector for the layout editor.
//
// With a card selected: name, position/size, lock, the widgets in its stack,
// the shown widget's appearance and refresh, sparklines and alert rules.
// With nothing selected: the page (name, free/tiled, rotation, import/export)
// and the screen's display behavior (rotation, night mode, alerts, …).

const SPARK_TYPES = new Set(["ping", "proxmox", "opnsense", "truenas", "rest"]);
const SPARK_OPT_IN = new Set(["ping"]); // graphs off unless switched on
const PAGED_TYPES = new Set(["weather", "netbox", "truenas"]); // widgets with several pages
const ALERT_TYPES = new Set(["ping", "proxmox", "truenas", "opnsense", "adguard", "weather", "rest", "bookmarks", "nowplaying", "rss"]);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function section(title, ...body) {
  return h("section", { class: "insp-sec" }, h("h3", { class: "insp-h", text: title }), ...body);
}
function row(label, control, hint) {
  return h("label", { class: "insp-row" }, h("span", { class: "insp-lbl", text: label }), control, hint ? h("span", { class: "insp-hint", text: hint }) : null);
}
function toggle(label, checked, onChange, hint) {
  const input = h("input", { type: "checkbox", class: "insp-switch", checked, onchange: (e) => onChange(e.target.checked) });
  return h("label", { class: "insp-row insp-toggle" }, input, h("span", { class: "insp-lbl", text: label }), hint ? h("span", { class: "insp-hint", text: hint }) : null);
}
function num(value, { min, max, step = 1, onChange }) {
  return h("input", { type: "number", class: "insp-input insp-num", value: String(value ?? ""), min, max, step, onchange: (e) => onChange(e.target.value === "" ? null : Number(e.target.value)) });
}
function select(options, value, onChange) {
  const s = h("select", { class: "insp-input", onchange: (e) => onChange(e.target.value) });
  for (const [v, l] of options) s.appendChild(h("option", { value: v, text: l }));
  s.value = value;
  return s;
}
function btn(text, onClick, cls = "") {
  return h("button", { type: "button", class: "insp-btn " + cls, onclick: onClick }, text);
}

// ── camera pop-ups: Frigate connections and cameras, fetched once a minute ───
const POP_LABELS = [["person", "People"], ["car", "Cars"], ["dog", "Dogs"], ["cat", "Cats"], ["bicycle", "Bikes"], ["package", "Packages"]];
let _frigate = { at: 0, promise: null };
function frigateInfo(fresh = false) {
  if (!fresh && _frigate.promise && Date.now() - _frigate.at < 60000) return _frigate.promise;
  _frigate.at = Date.now();
  _frigate.promise = (async () => {
    const sources = (await (await fetch("/api/datasources")).json()).filter((d) => d.type === "frigate");
    if (!sources.length) return { sources };
    const cams = await (await fetch(`/api/frigate/${sources[0].id}/cameras`)).json();
    return { sources, source: sources[0], ...cams };
  })().catch((e) => ({ sources: [], error: e.message }));
  return _frigate.promise;
}

function checks(options, picked, onChange) {
  const set = new Set(picked);
  return h("div", { class: "insp-checks" }, ...options.map(([v, label]) =>
    h("label", { class: "insp-check" },
      h("input", { type: "checkbox", checked: set.has(v), onchange: (e) => { e.target.checked ? set.add(v) : set.delete(v); onChange([...set]); } }),
      h("span", { text: label }))));
}

function cameraSection(o, set) {
  const cp = { enabled: false, labels: ["person"], cameras: [], seconds: 30, cooldown: 120, ...(o.camera_popup || {}) };
  const save = (k, v) => { cp[k] = v; set("camera_popup", { ...cp }); };
  const camsEl = h("div", { class: "insp-checks" }, h("span", { class: "insp-hint", text: "Loading cameras from Frigate…" }));
  const status = h("span", { class: "insp-hint" });
  const watch = h("span", { class: "insp-hint" });
  let info = null;
  const ago = (t) => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const showWatch = (res) => {
    if (!res?.source) { watch.textContent = ""; return; }
    if (res.error) { watch.textContent = `Frigate: ${res.error}`; watch.className = "insp-hint insp-warn"; return; }
    watch.className = "insp-hint";
    const ev = res.last_event;
    watch.textContent = ev ? `Last detection TouchBoard saw: ${ev.label} on ${ev.camera}, ${ago(ev.at)}.`
      : res.watching ? "Watching Frigate. No new detections since TouchBoard started." : "Starting to watch Frigate…";
  };
  const recheck = btn("Check again", () => { watch.textContent = "Checking…"; frigateInfo(true).then(showWatch); });
  const test = btn("Test pop-up", async () => {
    if (!info?.source) return;
    const camera = cp.cameras[0] || info.cameras?.[0];
    if (!camera) { status.textContent = "No cameras found in Frigate."; return; }
    const r = await fetch("/api/frigate/test", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: info.source.id, camera, label: cp.labels[0] || "person" }) });
    status.textContent = r.ok ? `Sent a test pop-up for ${camera} to every open screen.` : "Couldn't send the test.";
  });
  frigateInfo().then((res) => {
    info = res;
    showWatch(res);
    camsEl.innerHTML = "";
    if (!res.sources?.length) { camsEl.append(h("span", { class: "insp-hint", text: "Add a Frigate connection under Settings → Manage Integrations first." })); return; }
    if (res.ok === false || res.error) { camsEl.append(h("span", { class: "insp-hint insp-warn", text: `Frigate: ${res.error}` })); return; }
    camsEl.replaceWith(checks((res.cameras || []).map((c) => [c, c.replace(/_/g, " ")]), cp.cameras, (list) => save("cameras", list)));
  });
  return section("Camera pop-ups",
    toggle("Pop up a camera when Frigate sees something", !!cp.enabled, (v) => save("enabled", v),
      "Shows the camera full screen over any page, then goes back. Tap it to close early."),
    row("Detections", checks(POP_LABELS, cp.labels, (list) => save("labels", list.length ? list : ["person"]))),
    row("Cameras", camsEl, "None ticked = every camera."),
    row("Show for", h("div", { class: "insp-inline" }, num(cp.seconds, { min: 5, onChange: (v) => save("seconds", Math.max(5, v || 30)) }), h("span", { text: "s" }))),
    row("Then quiet for", h("div", { class: "insp-inline" }, num(cp.cooldown, { min: 0, onChange: (v) => save("cooldown", Math.max(0, v ?? 120)) }), h("span", { text: "s per camera" }))),
    h("div", { class: "insp-btns" }, test, recheck), status, watch);
}

export function createInspector(root, ctx) {
  let lastKey = null;

  function render(force = false) {
    const sel = ctx.selectedStack();
    const key = sel ? `s:${sel.id}:${ctx.currentWidget(sel)?.id}` : `p:${ctx.currentPageIdx()}`;
    if (!force && key === lastKey && root.contains(document.activeElement)) return;
    lastKey = key;
    root.innerHTML = "";
    root.append(...(sel ? cardView(sel) : pageView()));
  }

  // ── selected card ──────────────────────────────────────────────────────────
  function cardView(stack) {
    const node = ctx.nodeOf(stack.id) || {};
    const widget = ctx.currentWidget(stack);
    const out = [];

    const name = h("input", { class: "insp-input insp-title", value: stack.name, "aria-label": "Card name",
      onchange: (e) => ctx.updateStack(stack, { name: e.target.value.trim() || stack.name }) });
    out.push(h("div", { class: "insp-head" }, name,
      h("div", { class: "insp-sub", text: stack.widget_ids.length > 1 ? `Stack of ${stack.widget_ids.length} widgets` : (widget ? widget.type : "Empty card") })));

    const pos = (k) => num(node[k], { min: k === "w" || k === "h" ? 1 : 0, onChange: (v) => v != null && ctx.updateNode(stack.id, { [k]: v }) });
    out.push(section("Layout",
      h("div", { class: "insp-grid4" },
        h("label", {}, h("span", { text: "X" }), pos("x")), h("label", {}, h("span", { text: "Y" }), pos("y")),
        h("label", {}, h("span", { text: "W" }), pos("w")), h("label", {}, h("span", { text: "H" }), pos("h"))),
      h("div", { class: "insp-hint", text: `${node.w ?? "?"} × ${node.h ?? "?"} cells · about ${ctx.cellPx(node.w, node.h)} on the screen` }),
      toggle("Lock in place", !!node.locked, (v) => ctx.setLocked(stack.id, v)),
      h("div", { class: "insp-btns" },
        btn("Fill space", () => ctx.fill(stack.id)), btn("Duplicate", () => ctx.duplicate(stack.id)),
        ctx.pageCount() > 1 ? select([["", "Move to page…"], ...ctx.pageNames().map((n, i) => [String(i), n]).filter(([i]) => Number(i) !== ctx.currentPageIdx())], "", (v) => v !== "" && ctx.moveToPage(stack.id, Number(v))) : null,
        btn("Remove", () => ctx.remove(stack.id), "danger"))));

    // stack contents
    const list = h("div", { class: "insp-stack" });
    stack.widget_ids.forEach((id, i) => {
      const w = ctx.widgetsById()[id];
      if (!w) return;
      list.appendChild(h("div", { class: "insp-stack-row" + (widget?.id === id ? " is-current" : "") },
        h("button", { type: "button", class: "insp-stack-name", title: "Show this widget", onclick: () => ctx.showWidget(stack.id, i) },
          h("span", { class: "insp-type", text: w.type }), w.title),
        btn("↑", () => ctx.reorder(stack, i, -1), "icon"), btn("↓", () => ctx.reorder(stack, i, 1), "icon"),
        btn("✎", () => ctx.editWidget(w), "icon"),
        stack.widget_ids.length > 1 ? btn("✕", () => ctx.removeFromStack(stack, id), "icon") : null));
    });
    const addable = ctx.stackableWidgets(stack);
    out.push(section("Widgets in this card", list,
      addable.length ? select([["", "+ Add a widget to this card…"], ...addable.map((w) => [String(w.id), `${w.title} (${w.type})`])], "", (v) => v && ctx.addToStack(stack, Number(v))) : null,
      stack.widget_ids.length > 1 || PAGED_TYPES.has(widget?.type) ? row("Auto-cycle", select([["tap", "Follow screen setting"], ["auto", "Always"], ["manual", "Only when tapped"]], stack.cycle_mode || "tap", (v) => ctx.updateStack(stack, { cycle_mode: v })),
        "“Cycle cards automatically” is under This screen (click empty grid).") : null));

    if (widget) {
      const cfg = widget.config || {};
      const scale = h("input", { type: "range", min: "0.5", max: "2", step: "0.05", value: String(Number(cfg.widget_scale) || 1), class: "insp-range",
        oninput: (e) => { scaleVal.textContent = Math.round(e.target.value * 100) + "%"; ctx.previewScale(stack.id, e.target.value); },
        onchange: (e) => ctx.updateWidgetConfig(widget, { widget_scale: Number(e.target.value) }) });
      const scaleVal = h("span", { class: "insp-val", text: Math.round((Number(cfg.widget_scale) || 1) * 100) + "%" });
      out.push(section(`Widget · ${widget.title}`,
        h("div", { class: "insp-btns" }, btn("Edit settings…", () => ctx.editWidget(widget), "primary"), btn("Colors…", (e) => ctx.openColors(e.currentTarget, widget, stack))),
        row("Size", h("div", { class: "insp-inline" }, scale, scaleVal)),
        toggle("Show title", !cfg.hide_title, (v) => ctx.updateWidgetConfig(widget, { hide_title: !v })),
        toggle("Light text", cfg.widget_theme === "light", (v) => ctx.updateWidgetConfig(widget, { widget_theme: v ? "light" : "dark" })),
        SPARK_TYPES.has(widget.type) ? toggle("Sparklines", SPARK_OPT_IN.has(widget.type) ? cfg.sparklines === true : cfg.sparklines !== false, (v) => ctx.updateWidgetConfig(widget, { sparklines: v })) : null,
        widget.type !== "clock" && widget.type !== "notes" ? row("Refresh every", h("div", { class: "insp-inline" },
          num(widget.refresh_interval_sec, { min: 2, onChange: (v) => v && ctx.updateWidget(widget, { refresh_interval_sec: Math.max(2, v) }) }), h("span", { text: "s" }))) : null));

      if (ALERT_TYPES.has(widget.type)) out.push(alertsSection(widget));
    }
    return out;
  }

  function alertsSection(widget) {
    const cfg = widget.config || {};
    const env = ctx.envelope(widget.id);
    const metrics = Object.keys(env?.metrics || {});
    const listId = `insp-metrics-${widget.id}`;
    const dl = h("datalist", { id: listId });
    const families = new Set();
    for (const m of metrics) {
      dl.appendChild(h("option", { value: m }));
      if (m.includes(":")) families.add(m.split(":")[0] + ":*");
    }
    families.forEach((f) => dl.appendChild(h("option", { value: f })));

    const status = h("div", { class: "insp-alert-status" });
    const alert = env?.alert;
    if (alert?.level) {
      status.classList.add(`lv-${alert.level}`);
      status.append(h("b", { text: alert.level === "crit" ? "Critical" : "Warning" }), ...alert.items.slice(0, 4).map((i) => h("div", { text: i.message })));
    } else status.append(h("span", { text: env ? "No alerts right now" : "Waiting for data" }));

    const rules = (cfg.alerts || []).map((r) => ({ ...r }));
    const rulesEl = h("div", { class: "insp-rules" });
    const save = () => ctx.updateWidgetConfig(widget, { alerts: rules.filter((r) => r.metric) });
    const drawRules = () => {
      rulesEl.innerHTML = "";
      rules.forEach((r, i) => {
        rulesEl.appendChild(h("div", { class: "insp-rule" },
          h("input", { class: "insp-input", list: listId, value: r.metric || "", placeholder: "metric, e.g. cpu", onchange: (e) => { r.metric = e.target.value.trim(); save(); } }),
          select([[">", ">"], ["<", "<"]], r.op || ">", (v) => { r.op = v; save(); }),
          h("input", { class: "insp-input insp-num warn", type: "number", value: r.warn ?? "", placeholder: "warn", title: "Warning at", onchange: (e) => { r.warn = e.target.value === "" ? null : Number(e.target.value); save(); } }),
          h("input", { class: "insp-input insp-num crit", type: "number", value: r.crit ?? "", placeholder: "crit", title: "Critical at", onchange: (e) => { r.crit = e.target.value === "" ? null : Number(e.target.value); save(); } }),
          btn("✕", () => { rules.splice(i, 1); save(); drawRules(); }, "icon")));
      });
    };
    drawRules();
    return section("Alerts", status, dl,
      ["ping", "bookmarks"].includes(widget.type) ? toggle("Critical when a target is down", cfg.alert_on_down !== false, (v) => ctx.updateWidgetConfig(widget, { alert_on_down: v })) : null,
      toggle("Warn when the integration errors", !!cfg.alert_on_error, (v) => ctx.updateWidgetConfig(widget, { alert_on_error: v })),
      rulesEl,
      h("div", { class: "insp-btns" }, btn("+ Threshold", () => { rules.push({ metric: metrics[0] || "", op: ">", warn: null, crit: null }); drawRules(); })),
      metrics.length ? h("div", { class: "insp-hint", text: `Metrics: ${metrics.slice(0, 6).join(", ")}${metrics.length > 6 ? "…" : ""}. Use * to match several, e.g. latency:*` }) : null);
  }

  // ── nothing selected: page + screen ───────────────────────────────────────
  function pageView() {
    const page = ctx.currentPage();
    const o = ctx.options();
    const set = (k, v) => ctx.setOption(k, v);
    const night = { enabled: false, start: "22:00", end: "07:00", brightness: 0.35, page: null, ...(o.night || {}) };
    const setNight = (k, v) => { night[k] = v; set("night", { ...night }); };
    const out = [];

    out.push(h("div", { class: "insp-head" }, h("div", { class: "insp-title-static", text: page.name }), h("div", { class: "insp-sub", text: "Select a card to edit it. These settings apply to the page and this screen." })));

    out.push(section("Page",
      row("Name", h("input", { class: "insp-input", value: page.name, onchange: (e) => ctx.setPageProp("name", e.target.value.trim() || page.name) })),
      row("Layout", select([["free", "Free grid"], ["tiled", "Tiled (no gaps)"]], page.mode || "free", (v) => ctx.setPageMode(v)),
        page.mode === "tiled" ? "Drag the lines between cards to resize both sides." : "Drag cards anywhere; they snap to the grid."),
      toggle("Include in page rotation", page.rotate !== false, (v) => ctx.setPageProp("rotate", v)),
      h("div", { class: "insp-btns" }, btn("Starter layouts…", () => ctx.openTemplates()), btn("Export page", () => ctx.exportPage()), btn("Import page…", () => ctx.importPage()))));

    const url = ctx.displayUrl();
    out.push(section("This screen",
      h("div", { class: "insp-url" }, h("code", { text: url }), btn("Copy", async (e) => {
        try { await navigator.clipboard.writeText(location.origin + url); e.target.textContent = "Copied"; } catch { e.target.textContent = "Select it"; }
      }, "icon")),
      h("div", { class: "insp-hint", text: "Open this address on a screen to pin it to this profile." }),
      row("Rotate pages every", h("div", { class: "insp-inline" }, num(o.rotate_sec ?? 0, { min: 0, onChange: (v) => set("rotate_sec", Math.max(0, v || 0)) }), h("span", { text: "s (0 = off)" }))),
      row("Pause after a touch", h("div", { class: "insp-inline" }, num(o.rotate_pause_sec ?? 60, { min: 0, onChange: (v) => set("rotate_pause_sec", Math.max(0, v || 0)) }), h("span", { text: "s" }))),
      toggle("Cycle cards automatically", !!o.stack_cycle, (v) => set("stack_cycle", v),
        "Stacked cards take turns, and Weather, NetBox and TrueNAS step through their pages. Stack cards by dragging one onto another and holding."),
      row("Switch every", h("div", { class: "insp-inline" }, num(o.stack_cycle_sec ?? 12, { min: 4, onChange: (v) => set("stack_cycle_sec", Math.max(4, v || 12)) }), h("span", { text: "s" }))),
      toggle("Jump to a card when it turns critical", o.alert_takeover !== false, (v) => set("alert_takeover", v)),
      toggle("Dim cards with stale data", o.staleness !== false, (v) => set("staleness", v)),
      toggle("Keep the screen awake", o.wake_lock !== false, (v) => set("wake_lock", v)),
      toggle("Shift pixels against burn-in", !!o.pixel_shift, (v) => set("pixel_shift", v)),
      toggle("Allow editing on the display", o.edit_on_display !== false, (v) => set("edit_on_display", v), "Long-press the display while signed in.")));

    out.push(cameraSection(o, set));

    out.push(section("Night mode",
      toggle("Dim on a schedule", !!night.enabled, (v) => setNight("enabled", v)),
      h("div", { class: "insp-inline" },
        row("From", h("input", { type: "time", class: "insp-input", value: night.start, onchange: (e) => setNight("start", e.target.value) })),
        row("To", h("input", { type: "time", class: "insp-input", value: night.end, onchange: (e) => setNight("end", e.target.value) }))),
      row("Brightness", h("div", { class: "insp-inline" }, h("input", { type: "range", class: "insp-range", min: "0.08", max: "1", step: "0.02", value: String(night.brightness),
        onchange: (e) => setNight("brightness", Number(e.target.value)) }))),
      row("Show page", select([["", "Stay on the current page"], ...ctx.pageNames().map((n, i) => [String(i), n])], night.page == null ? "" : String(night.page), (v) => setNight("page", v === "" ? null : Number(v))))));

    out.push(section("Grid",
      row("Cells", select([["12x8", "Coarse · 12 × 8"], ["24x16", "Standard · 24 × 16"], ["48x32", "Fine · 48 × 32"]], `${ctx.cols()}x${ctx.rows()}`, (v) => ctx.setDensity(v)),
        "Changing this rescales every page."),
      h("div", { class: "insp-keys" },
        ...[["Ctrl Z / Ctrl ⇧ Z", "Undo / redo"], ["Arrows", "Move selected card"], ["⇧ + arrows", "Resize"], ["Ctrl D", "Duplicate"],
          ["Delete", "Remove"], ["L / F", "Lock / fill space"], ["Ctrl K", "Command palette"], ["[ ]", "Previous / next page"]]
          .map(([k, d]) => h("div", {}, h("kbd", { text: k }), h("span", { text: d }))))));
    return out;
  }

  return { render, refreshStatus: () => render(false) };
}
