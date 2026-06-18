import { api } from "./api.js";
import { renderWidget } from "./widgets.js";
import { applyTheme, applyCardStyle } from "./theme.js";

fetch("/api/settings").then(r => r.json()).then(s => {
  applyTheme({ style: s.theme_style, font: s.theme_font });
  applyCardStyle(s);
  if (s.board_bg_color) boardEl.style.backgroundColor = s.board_bg_color;
}).catch(() => {});

const boardEl     = document.getElementById("board");
const indicatorEl = document.getElementById("page-indicator");
const piNameEl    = document.getElementById("pi-name");
const piDotsEl    = document.getElementById("pi-dots");

const COLS = 24; // must match layout-editor COLS constant

let pages          = [];
let currentPageIdx = 0;
let columns        = COLS;
let widgetsById    = {};
const envelopeCache = {};
const activeIndex   = {};
const cellByStack   = {};

let isAnimating = false;

// ── page indicator ───────────────────────────────────────────────────────────
function showIndicator() {
  if (pages.length <= 1) { indicatorEl.classList.remove("visible"); return; }
  const page = pages[currentPageIdx];
  piNameEl.textContent = page?.name || "";
  piDotsEl.innerHTML = "";
  pages.forEach((_, i) => {
    const d = document.createElement("span");
    d.className = "pi-dot" + (i === currentPageIdx ? " active" : "");
    piDotsEl.appendChild(d);
  });
  indicatorEl.classList.add("visible");
}

// ── rendering ────────────────────────────────────────────────────────────────
function currentWidgetId(stack) {
  const ids = stack.widget_ids.filter((id) => widgetsById[id]);
  if (!ids.length) return null;
  return ids[(activeIndex[stack.id] || 0) % ids.length];
}

function renderCell(stack) {
  const cell = cellByStack[stack.id];
  if (!cell) return;
  const ids = stack.widget_ids.filter((id) => widgetsById[id]);
  cell.bodyEl.innerHTML = "";

  const wid = currentWidgetId(stack);
  if (wid == null) {
    const empty = document.createElement("div");
    empty.className = "w-empty";
    empty.textContent = `Stack "${stack.name}" has no widgets`;
    cell.bodyEl.appendChild(empty);
  } else {
    cell.bodyEl.appendChild(renderWidget(widgetsById[wid], envelopeCache[wid] || null));
  }

  cell.dotsEl.innerHTML = "";
  if (ids.length > 1) {
    const active = (activeIndex[stack.id] || 0) % ids.length;
    ids.forEach((_, i) => {
      const d = document.createElement("span");
      d.className = "pd" + (i === active ? " active" : "");
      cell.dotsEl.appendChild(d);
    });
  }
}

// Build a self-contained grid panel for one page (does not touch boardEl).
// Registers new stack cells in cellByStack.
function buildPagePanel(pageLayout, stackById) {
  const panel = document.createElement("div");
  panel.className = "board-panel";

  if (!pageLayout || !pageLayout.length) {
    panel.innerHTML =
      `<div class="board-empty"><div>No stacks on this page.</div>` +
      `<a href="/">Open the editor →</a></div>`;
    return panel;
  }

  const rows = Math.max(1, ...pageLayout.map((n) => n.y + n.h));
  panel.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  panel.style.gridTemplateRows    = `repeat(${rows}, 1fr)`;

  for (const node of pageLayout) {
    const stack = stackById[node.stack_id];
    if (!stack) continue;

    const cell   = document.createElement("div");
    cell.className = "stack-cell";
    cell.style.gridColumn = `${node.x + 1} / span ${node.w}`;
    cell.style.gridRow    = `${node.y + 1} / span ${node.h}`;

    const bodyEl = document.createElement("div");
    bodyEl.style.flex = "1"; bodyEl.style.minHeight = "0"; bodyEl.style.overflow = "hidden";
    const dotsEl = document.createElement("div");
    dotsEl.className = "stack-dots";
    cell.append(bodyEl, dotsEl);

    cell.addEventListener("click", () => cycle(stack));
    cell.addEventListener("wheel", (e) => {
      const ids = stack.widget_ids.filter((id) => widgetsById[id]);
      if (ids.length < 2) return;
      // Yield to internal scroll if target is inside a scrollable element not at its limit
      let el = e.target;
      while (el && el !== cell) {
        if (el.scrollHeight > el.clientHeight + 2) {
          const atTop    = el.scrollTop <= 0;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
          if (!((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom))) return;
          break;
        }
        el = el.parentElement;
      }
      e.preventDefault();
      const cur = activeIndex[stack.id] || 0;
      activeIndex[stack.id] = e.deltaY > 0
        ? (cur + 1) % ids.length
        : (cur - 1 + ids.length) % ids.length;
      renderCell(stack);
    }, { passive: false });

    panel.appendChild(cell);
    cellByStack[stack.id] = { el: cell, bodyEl, dotsEl, stack };
    renderCell(stack);
  }

  return panel;
}

function switchPage(idx, full) {
  if (idx < 0 || idx >= pages.length) return;
  if (isAnimating) return;

  // Determine slide direction before updating currentPageIdx
  const direction = idx > currentPageIdx ? 1 : idx < currentPageIdx ? -1 : 0;
  currentPageIdx = idx;

  const stackById = Object.fromEntries(full.stacks.map((s) => [s.id, s]));

  // Clear cell registry before building new panel
  for (const k of Object.keys(cellByStack)) delete cellByStack[k];

  const newPanel = buildPagePanel(pages[idx].layout, stackById);
  const oldPanel = boardEl.querySelector(".board-panel");

  // No animation on initial load or same-page refresh
  if (!oldPanel || direction === 0) {
    if (oldPanel) oldPanel.remove();
    boardEl.appendChild(newPanel);
    showIndicator();
    return;
  }

  // Slide animation: new panel starts off-screen, both translate simultaneously
  isAnimating = true;
  const startOffset = direction * 100;     // % new panel starts from
  const endOffset   = direction * -100;    // % old panel moves to

  newPanel.style.transform = `translateX(${startOffset}%)`;
  boardEl.appendChild(newPanel);

  // Force reflow so the browser registers the starting transform before we transition
  newPanel.getBoundingClientRect();

  const dur  = 420;
  const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
  oldPanel.style.transition = `transform ${dur}ms ${ease}`;
  newPanel.style.transition = `transform ${dur}ms ${ease}`;
  oldPanel.style.transform  = `translateX(${endOffset}%)`;
  newPanel.style.transform  = "translateX(0%)";

  const cleanup = () => {
    oldPanel.remove();
    newPanel.style.transition = "";
    newPanel.style.transform  = "";
    isAnimating = false;
    showIndicator();
  };

  newPanel.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, dur + 80); // fallback if transitionend misfires
}

function buildBoard(full) {
  columns     = full.board.columns || COLS;
  widgetsById = Object.fromEntries(full.widgets.map((w) => [w.id, w]));

  const raw = full.board.pages ?? full.board.layout ?? [];
  if (raw.length && raw[0] && "stack_id" in raw[0]) {
    pages = [{ id: 1, name: "Page 1", layout: raw }];
  } else if (raw.length && raw[0] && "layout" in raw[0]) {
    pages = raw;
  } else {
    pages = [{ id: 1, name: "Page 1", layout: [] }];
  }

  if (!pages.some((p) => p.layout && p.layout.length)) {
    boardEl.innerHTML =
      `<div class="board-empty"><div>No stacks placed yet.</div>` +
      `<a href="/">Open the editor →</a></div>`;
    indicatorEl.classList.remove("visible");
    return;
  }
  if (currentPageIdx >= pages.length) currentPageIdx = 0;
  switchPage(currentPageIdx, full);
}

function cycle(stack) {
  const ids = stack.widget_ids.filter((id) => widgetsById[id]);
  if (ids.length < 2) return;
  activeIndex[stack.id] = ((activeIndex[stack.id] || 0) + 1) % ids.length;
  renderCell(stack);
}

// ── live updates ─────────────────────────────────────────────────────────────
function onEnvelope(env) {
  envelopeCache[env.widget_id] = env;
  for (const c of Object.values(cellByStack)) {
    if (currentWidgetId(c.stack) === env.widget_id) renderCell(c.stack);
  }
}

function connectSSE() {
  const es = new EventSource("/api/stream");
  es.onmessage = (e) => { try { onEnvelope(JSON.parse(e.data)); } catch (_) {} };
}

// ── navigation ───────────────────────────────────────────────────────────────
let lastFull = null;

function goToPage(idx) {
  if (!lastFull || pages.length <= 1) return;
  switchPage(Math.max(0, Math.min(pages.length - 1, idx)), lastFull);
}

function setupNavigation() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") goToPage(currentPageIdx + 1);
    if (e.key === "ArrowLeft")  goToPage(currentPageIdx - 1);
  });

  // Scroll on page indicator to change pages
  indicatorEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    goToPage(e.deltaY > 0 ? currentPageIdx + 1 : currentPageIdx - 1);
  }, { passive: false });

  // Touch swipe for page navigation
  let touchStartX = null;
  let touchStartY = null;
  document.addEventListener("touchstart", (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    touchStartX = null; touchStartY = null;
    // Only count as a horizontal swipe if dx dominates
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    goToPage(dx < 0 ? currentPageIdx + 1 : currentPageIdx - 1);
  }, { passive: true });
}

// ── boot ─────────────────────────────────────────────────────────────────────
async function refreshStructure() {
  const full = await api.boardFull();
  lastFull = full;
  buildBoard(full);
}

async function init() {
  setupNavigation();
  await refreshStructure();
  connectSSE();
  setInterval(refreshStructure, 15000);
}

init();
