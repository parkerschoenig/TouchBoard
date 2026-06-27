import { api } from "./api.js";

const $ = (sel) => document.querySelector(sel);

let board = { columns: 6, layout: [] };
let stacks = [];
let widgets = [];
let widgetsById = {};
let grid; // GridStack instance
let saveTimer = null;

function reindex() {
  widgetsById = Object.fromEntries(widgets.map((w) => [w.id, w]));
}

// ── layout persistence ─────────────────────────────────────────────────────
function currentLayout() {
  return grid.getGridItems().map((el) => {
    const n = el.gridstackNode;
    return { stack_id: Number(el.dataset.stackId), x: n.x, y: n.y, w: n.w, h: n.h };
  });
}

function saveLayoutSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    board.layout = currentLayout();
    await api.updateBoard({ columns: board.columns, layout: board.layout });
  }, 400);
}

// ── stack item rendering ────────────────────────────────────────────────────
function buildStackItem(stack, node) {
  const item = document.createElement("div");
  item.className = "grid-stack-item";
  item.dataset.stackId = stack.id;
  item.setAttribute("gs-x", node ? node.x : 0);
  item.setAttribute("gs-y", node ? node.y : 0);
  item.setAttribute("gs-w", node ? node.w : 2);
  item.setAttribute("gs-h", node ? node.h : 2);

  const content = document.createElement("div");
  content.className = "grid-stack-item-content";
  item.appendChild(content);
  renderStackBody(content, stack);
  return item;
}

function renderStackBody(content, stack) {
  content.innerHTML = "";

  const head = document.createElement("div");
  head.className = "stack-head";
  const name = document.createElement("input");
  name.className = "stack-name";
  name.value = stack.name;
  name.addEventListener("change", async () => {
    await api.updateStack(stack.id, { name: name.value });
    stack.name = name.value;
  });
  const del = document.createElement("button");
  del.className = "icon-btn";
  del.textContent = "🗑";
  del.title = "Delete stack";
  del.addEventListener("click", async () => {
    if (!confirm(`Delete stack "${stack.name}"?`)) return;
    await api.deleteStack(stack.id);
    const item = content.closest(".grid-stack-item");
    grid.removeWidget(item);
    stacks = stacks.filter((s) => s.id !== stack.id);
  });
  // drag handle hint: only the head drags (set via gridstack handle option)
  head.appendChild(name);
  head.appendChild(del);
  content.appendChild(head);

  const body = document.createElement("div");
  body.className = "stack-body";

  const list = document.createElement("div");
  list.className = "stack-widgets";
  if (!stack.widget_ids.length) {
    const empty = document.createElement("div");
    empty.className = "stack-empty";
    empty.textContent = "No widgets yet — add one below.";
    list.appendChild(empty);
  }
  for (const wid of stack.widget_ids) {
    const w = widgetsById[wid];
    if (!w) continue;
    list.appendChild(buildChip(stack, w));
  }
  body.appendChild(list);

  // add-existing-widget row
  const available = widgets.filter((w) => !stack.widget_ids.includes(w.id));
  const row = document.createElement("div");
  row.className = "add-widget-row";
  const sel = document.createElement("select");
  sel.innerHTML =
    `<option value="">add widget…</option>` +
    available.map((w) => `<option value="${w.id}">${escapeHtml(w.title)}</option>`).join("");
  const addBtn = document.createElement("button");
  addBtn.textContent = "+";
  addBtn.addEventListener("click", async () => {
    const wid = Number(sel.value);
    if (!wid) return;
    stack.widget_ids = [...stack.widget_ids, wid];
    await api.updateStack(stack.id, { widget_ids: stack.widget_ids });
    renderStackBody(content, stack);
  });
  row.appendChild(sel);
  row.appendChild(addBtn);
  body.appendChild(row);

  content.appendChild(body);
}

function buildChip(stack, w) {
  const chip = document.createElement("div");
  chip.className = "widget-chip";
  const type = document.createElement("span");
  type.className = "chip-type";
  type.textContent = w.type;
  const title = document.createElement("span");
  title.textContent = w.title;
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const x = document.createElement("span");
  x.className = "x";
  x.textContent = "✕";
  x.title = "Remove from stack";
  x.addEventListener("click", async () => {
    stack.widget_ids = stack.widget_ids.filter((id) => id !== w.id);
    await api.updateStack(stack.id, { widget_ids: stack.widget_ids });
    const content = chip.closest(".grid-stack-item-content");
    renderStackBody(content, stack);
  });
  chip.appendChild(type);
  chip.appendChild(title);
  chip.appendChild(spacer);
  chip.appendChild(x);
  return chip;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ── render whole board ──────────────────────────────────────────────────────
function renderBoard() {
  grid.removeAll();
  const nodeByStack = Object.fromEntries(board.layout.map((n) => [n.stack_id, n]));
  for (const stack of stacks) {
    const item = buildStackItem(stack, nodeByStack[stack.id]);
    grid.el.appendChild(item);
    grid.makeWidget(item);
  }
}

// ── widget modal ────────────────────────────────────────────────────────────
function addTargetRow(label = "", address = "") {
  const wrap = $("#targets");
  const row = document.createElement("div");
  row.className = "target-row";
  row.innerHTML =
    `<input class="t-label" placeholder="Label" />` +
    `<input class="t-addr" placeholder="http://host or 10.0.0.1[:port]" />` +
    `<button class="x" type="button">✕</button>`;
  row.querySelector(".t-label").value = label;
  row.querySelector(".t-addr").value = address;
  row.querySelector(".x").addEventListener("click", () => row.remove());
  wrap.appendChild(row);
}

function openWidgetModal() {
  $("#targets").innerHTML = "";
  $("#w-title").value = "";
  $("#w-interval").value = 15;
  $("#w-type").value = "ping";
  addTargetRow("", "");
  $("#widget-modal").classList.add("open");
}

function closeWidgetModal() {
  $("#widget-modal").classList.remove("open");
}

async function saveWidget() {
  const type = $("#w-type").value;
  const title = $("#w-title").value.trim() || "Untitled";
  const refresh = Math.max(2, Number($("#w-interval").value) || 15);
  let config = {};
  if (type === "ping") {
    const targets = [...document.querySelectorAll("#targets .target-row")]
      .map((r) => ({
        label: r.querySelector(".t-label").value.trim(),
        address: r.querySelector(".t-addr").value.trim(),
      }))
      .filter((t) => t.address);
    config = { targets };
  }
  const w = await api.createWidget({ type, title, config, refresh_interval_sec: refresh });
  widgets.push(w);
  reindex();
  closeWidgetModal();
  // refresh stack bodies so the new widget appears in the "add widget" selects
  for (const item of grid.getGridItems()) {
    const stack = stacks.find((s) => s.id === Number(item.dataset.stackId));
    renderStackBody(item.querySelector(".grid-stack-item-content"), stack);
  }
}

// ── boot ────────────────────────────────────────────────────────────────────
async function init() {
  const full = await api.boardFull();
  board = full.board;
  stacks = full.stacks;
  widgets = full.widgets;
  reindex();

  $("#columns").value = board.columns;

  grid = GridStack.init({
    column: board.columns,
    cellHeight: 96,
    margin: 6,
    float: true,
    handle: ".stack-head",
  });

  grid.on("change", () => saveLayoutSoon());

  renderBoard();

  // toolbar
  $("#add-stack").addEventListener("click", async () => {
    const stack = await api.createStack({ name: "New stack", widget_ids: [] });
    stacks.push(stack);
    const item = buildStackItem(stack, { x: 0, y: 0, w: 2, h: 2 });
    grid.el.appendChild(item);
    grid.makeWidget(item);
    saveLayoutSoon();
  });

  $("#add-widget").addEventListener("click", openWidgetModal);
  $("#add-target").addEventListener("click", () => addTargetRow());
  $("#w-cancel").addEventListener("click", closeWidgetModal);
  $("#w-save").addEventListener("click", saveWidget);

  $("#columns").addEventListener("change", async () => {
    const cols = Math.max(1, Math.min(24, Number($("#columns").value) || 6));
    board.columns = cols;
    grid.column(cols);
    await api.updateBoard({ columns: cols, layout: currentLayout() });
  });
}

init();
