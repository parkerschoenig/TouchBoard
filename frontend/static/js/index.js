import { api } from "./api.js";

const byId = (id) => document.getElementById(id);

let widgets = [];
let stacks = [];
let widgetsById = {};
let editingWidgetId = null;

function reindex() {
  widgetsById = Object.fromEntries(widgets.map((w) => [w.id, w]));
}

// ── Widget list ───────────────────────────────────────────────────────────────

function renderWidgets() {
  const list = byId("widget-list");
  list.innerHTML = "";
  if (!widgets.length) {
    list.innerHTML = '<div class="empty-state">No widgets yet. Create one to get started.</div>';
    return;
  }
  for (const w of widgets) list.appendChild(buildWidgetCard(w));
}

function buildWidgetCard(w) {
  const card = document.createElement("div");
  card.className = "item-card";

  const left = document.createElement("div");
  left.className = "item-card-left";

  const badge = document.createElement("span");
  badge.className = "type-badge";
  badge.textContent = w.type;

  const title = document.createElement("span");
  title.className = "item-title";
  title.textContent = w.title;

  const meta = document.createElement("span");
  meta.className = "item-meta";
  const tc = w.config?.targets?.length ?? 0;
  meta.textContent =
    w.type === "ping"
      ? `${tc} target${tc !== 1 ? "s" : ""} · refresh ${w.refresh_interval_sec}s`
      : `refresh ${w.refresh_interval_sec}s`;

  left.appendChild(badge);
  left.appendChild(title);
  left.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "small";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => openWidgetModal(w));

  const delBtn = document.createElement("button");
  delBtn.className = "small danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", async () => {
    if (!confirm(`Delete widget "${w.title}"?`)) return;
    await api.deleteWidget(w.id);
    widgets = widgets.filter((x) => x.id !== w.id);
    reindex();
    renderWidgets();
    renderStacks();
  });

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  card.appendChild(left);
  card.appendChild(actions);
  return card;
}

// ── Stack list ────────────────────────────────────────────────────────────────

function renderStacks() {
  const list = byId("stack-list");
  list.innerHTML = "";
  if (!stacks.length) {
    list.innerHTML =
      '<div class="empty-state">No stacks yet. Create one to group widgets.</div>';
    return;
  }
  for (const s of stacks) list.appendChild(buildStackCard(s));
}

function buildStackCard(stack) {
  const card = document.createElement("div");
  card.className = "item-card stack-card";

  // ── header ──────────────────────────────────────────────────────────────────
  const head = document.createElement("div");
  head.className = "stack-card-head";

  const nameInput = document.createElement("input");
  nameInput.className = "stack-name-input";
  nameInput.value = stack.name;
  nameInput.addEventListener("change", async () => {
    stack.name = nameInput.value;
    await api.updateStack(stack.id, { name: stack.name });
  });

  const delBtn = document.createElement("button");
  delBtn.className = "small danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", async () => {
    if (!confirm(`Delete stack "${stack.name}"?`)) return;
    await api.deleteStack(stack.id);
    stacks = stacks.filter((s) => s.id !== stack.id);
    renderStacks();
  });

  head.appendChild(nameInput);
  head.appendChild(delBtn);
  card.appendChild(head);

  // ── widget chips ─────────────────────────────────────────────────────────────
  const chipsWrap = document.createElement("div");
  chipsWrap.className = "stack-chips";
  card.appendChild(chipsWrap);

  // ── add-widget row ───────────────────────────────────────────────────────────
  const addRow = document.createElement("div");
  addRow.className = "add-widget-row";
  const sel = document.createElement("select");
  const addBtn = document.createElement("button");
  addBtn.className = "small";
  addBtn.textContent = "+";
  addRow.appendChild(sel);
  addRow.appendChild(addBtn);
  card.appendChild(addRow);

  function refreshChips() {
    chipsWrap.innerHTML = "";
    if (!stack.widget_ids.length) {
      const empty = document.createElement("span");
      empty.className = "empty-state small";
      empty.textContent = "No widgets — add one below.";
      chipsWrap.appendChild(empty);
      return;
    }
    for (const wid of stack.widget_ids) {
      const w = widgetsById[wid];
      if (!w) continue;
      const chip = document.createElement("div");
      chip.className = "widget-chip";

      const b = document.createElement("span");
      b.className = "chip-type";
      b.textContent = w.type;

      const lbl = document.createElement("span");
      lbl.textContent = w.title;

      const sp = document.createElement("span");
      sp.className = "spacer";

      const x = document.createElement("span");
      x.className = "chip-x";
      x.textContent = "✕";
      x.title = "Remove from stack";
      x.addEventListener("click", async () => {
        stack.widget_ids = stack.widget_ids.filter((id) => id !== wid);
        await api.updateStack(stack.id, { widget_ids: stack.widget_ids });
        refreshChips();
        refreshSel();
      });

      chip.appendChild(b);
      chip.appendChild(lbl);
      chip.appendChild(sp);
      chip.appendChild(x);
      chipsWrap.appendChild(chip);
    }
  }

  function refreshSel() {
    sel.innerHTML = '<option value="">add widget…</option>';
    for (const w of widgets) {
      if (stack.widget_ids.includes(w.id)) continue;
      const opt = document.createElement("option");
      opt.value = w.id;
      opt.textContent = w.title;
      sel.appendChild(opt);
    }
  }

  addBtn.addEventListener("click", async () => {
    const wid = Number(sel.value);
    if (!wid) return;
    stack.widget_ids = [...stack.widget_ids, wid];
    await api.updateStack(stack.id, { widget_ids: stack.widget_ids });
    refreshChips();
    refreshSel();
  });

  refreshChips();
  refreshSel();
  return card;
}

// ── Widget modal ──────────────────────────────────────────────────────────────

function addTargetRow(label = "", address = "") {
  const wrap = byId("targets");
  const row = document.createElement("div");
  row.className = "target-row";
  row.innerHTML =
    `<input class="t-label" placeholder="Label" />` +
    `<input class="t-addr" placeholder="http://host or 10.0.0.1[:port]" />` +
    `<button class="x small" type="button">✕</button>`;
  row.querySelector(".t-label").value = label;
  row.querySelector(".t-addr").value = address;
  row.querySelector(".x").addEventListener("click", () => row.remove());
  wrap.appendChild(row);
}

function openWidgetModal(widget = null) {
  editingWidgetId = widget ? widget.id : null;
  byId("widget-modal-title").textContent = widget ? "Edit Widget" : "New Widget";
  byId("targets").innerHTML = "";
  byId("w-title").value = widget ? widget.title : "";
  byId("w-interval").value = widget ? widget.refresh_interval_sec : 15;
  byId("w-type").value = widget ? widget.type : "ping";

  if (widget?.type === "ping" && widget.config?.targets?.length) {
    for (const t of widget.config.targets) addTargetRow(t.label, t.address);
  } else {
    addTargetRow();
  }
  byId("widget-modal").classList.add("open");
}

function closeWidgetModal() {
  byId("widget-modal").classList.remove("open");
}

async function saveWidget() {
  const type = byId("w-type").value;
  const title = byId("w-title").value.trim() || "Untitled";
  const refresh = Math.max(2, Number(byId("w-interval").value) || 15);
  let config = {};
  if (type === "ping") {
    config.targets = [...document.querySelectorAll("#targets .target-row")]
      .map((r) => ({
        label: r.querySelector(".t-label").value.trim(),
        address: r.querySelector(".t-addr").value.trim(),
      }))
      .filter((t) => t.address);
  }

  if (editingWidgetId) {
    const updated = await api.updateWidget(editingWidgetId, {
      type,
      title,
      config,
      refresh_interval_sec: refresh,
    });
    const idx = widgets.findIndex((w) => w.id === editingWidgetId);
    if (idx >= 0) widgets[idx] = updated;
  } else {
    const w = await api.createWidget({ type, title, config, refresh_interval_sec: refresh });
    widgets.push(w);
  }

  reindex();
  closeWidgetModal();
  renderWidgets();
  renderStacks();
}

// ── boot ──────────────────────────────────────────────────────────────────────

async function init() {
  const full = await api.boardFull();
  widgets = full.widgets;
  stacks = full.stacks;
  reindex();
  renderWidgets();
  renderStacks();

  byId("create-widget").addEventListener("click", () => openWidgetModal());
  byId("create-stack").addEventListener("click", async () => {
    const s = await api.createStack({ name: "New Stack", widget_ids: [] });
    stacks.push(s);
    renderStacks();
  });
  byId("add-target").addEventListener("click", () => addTargetRow());
  byId("w-cancel").addEventListener("click", closeWidgetModal);
  byId("w-save").addEventListener("click", saveWidget);
}

init();
