// Kiosk display. Renders one board (the active profile, or the one named in
// ?profile=) as a CSS grid that matches the editor cell for cell, and keeps it
// live over SSE.
//
// Display behavior comes from the profile's `options` (set in the editor's
// inspector when nothing is selected):
//   rotate_sec          rotate pages every N seconds (0 = off); pages with
//                       rotate:false are skipped
//   rotate_pause_sec    pause rotation for N seconds after someone touches it
//   stack_cycle         cycle cards automatically: stacks take turns and
//                       multi-page widgets step through their pages
//   stack_cycle_sec     how often cycling stacks advance
//
// A stack's own cycle_mode: "tap" (the default) follows stack_cycle, "auto"
// always cycles, "manual" only moves when tapped.
//   alert_takeover      jump to a card when it turns critical
//   staleness           dim cards whose data stopped updating
//   wake_lock           keep the screen awake (where the browser allows it)
//   pixel_shift         nudge the board a few pixels every few minutes
//   night               {enabled, start "22:00", end "07:00", brightness 0.35, page}
//   edit_on_display     long-press to rearrange cards (needs a signed-in session)

import { renderWidget } from "./widgets.js";
import { applyTheme, applyCardStyle } from "./theme.js";
import { timeAgo } from "./primitives.js";
import { initDisplayEdit } from "./display-edit.js";

const params = new URLSearchParams(location.search);
const PROFILE_REF = params.get("profile");

const boardEl     = document.getElementById("board");
const indicatorEl = document.getElementById("page-indicator");
const piNameEl    = document.getElementById("pi-name");
const piDotsEl    = document.getElementById("pi-dots");

const offlineEl = Object.assign(document.createElement("div"), { className: "display-offline hidden", textContent: "Reconnecting…" });
const dimEl = Object.assign(document.createElement("div"), { className: "display-dim" });
document.body.append(offlineEl, dimEl);

let pages          = [];
let currentPageIdx = 0;
let columns        = 24;
let rows           = 16;
let options        = {};
let widgetsById    = {};
let stackById      = {};
const envelopeCache = {};
const activeIndex   = {};
const cellByStack   = {};
const lastCycleAt   = {};
const touchedAt     = {};

let lastFull = null;
let lastStructureKey = null;
let isAnimating = false;
let editing = false;
let lastInteraction = 0;
let lastPageChange = Date.now();
let holdUntil = 0;
let sseOnline = true;
let sseDownSince = 0;
const bootAt = Date.now();

const opt = (k, d) => (options && options[k] !== undefined && options[k] !== null ? options[k] : d);
const now = () => Date.now();

// ── theme / settings ─────────────────────────────────────────────────────────
function applySettings(s) {
  applyTheme({ style: s.theme_style, font: s.theme_font, shape: s.theme_shape, pattern: s.theme_pattern });
  applyCardStyle(s);
  document.body.style.backgroundColor = s.board_bg_color || "";
  boardEl.style.backgroundColor = s.board_bg_color || "";
  document.documentElement.style.setProperty("--widget-font-scale", s.widget_font_scale || "1");
}
fetch("/api/settings").then((r) => r.json()).then(applySettings).catch(() => {});

// ── page indicator ───────────────────────────────────────────────────────────
function showIndicator() {
  if (pages.length <= 1) { indicatorEl.classList.remove("visible"); return; }
  const page = pages[currentPageIdx];
  piNameEl.textContent = page?.name || "";
  piDotsEl.innerHTML = "";
  pages.forEach((p, i) => {
    const d = document.createElement("span");
    d.className = "pi-dot" + (i === currentPageIdx ? " active" : "");
    d.dataset.page = String(i);
    d.title = p?.name || `Page ${i + 1}`;
    piDotsEl.appendChild(d);
  });
  indicatorEl.setAttribute("aria-label", `${page?.name || "Page"} (${currentPageIdx + 1} of ${pages.length}). Tap for next page`);
  indicatorEl.classList.add("visible");
}

// ── rendering ────────────────────────────────────────────────────────────────
function idsOf(stack) { return stack.widget_ids.filter((id) => widgetsById[id]); }

function currentWidgetId(stack) {
  const ids = idsOf(stack);
  if (!ids.length) return null;
  return ids[(activeIndex[stack.id] || 0) % ids.length];
}

const LEVEL = { warn: 1, crit: 2 };
function stackAlert(stack) {
  let worst = null;
  for (const id of idsOf(stack)) {
    const lv = envelopeCache[id]?.alert?.level;
    if (lv && (LEVEL[lv] || 0) > (LEVEL[worst] || 0)) worst = lv;
  }
  return worst;
}

function renderCell(stack) {
  const cell = cellByStack[stack.id];
  if (!cell) return;
  const ids = idsOf(stack);
  cell.bodyEl.innerHTML = "";

  const wid = currentWidgetId(stack);
  if (wid == null) {
    cell.bodyEl.appendChild(Object.assign(document.createElement("div"), { className: "w-empty", textContent: `"${stack.name}" has no widgets` }));
  } else {
    cell.bodyEl.appendChild(renderWidget(widgetsById[wid], envelopeCache[wid] || null));
  }
  const worst = stackAlert(stack);
  cell.el.classList.toggle("alert-warn", worst === "warn");
  cell.el.classList.toggle("alert-crit", worst === "crit");

  cell.dotsEl.innerHTML = "";
  if (ids.length > 1) {
    const active = (activeIndex[stack.id] || 0) % ids.length;
    ids.forEach((id, i) => {
      const d = document.createElement("span");
      const lv = envelopeCache[id]?.alert?.level;
      d.className = "pd" + (i === active ? " active" : "") + (lv ? ` alert-${lv}` : "");
      d.addEventListener("click", (e) => { e.stopPropagation(); noteTouch(stack.id); activeIndex[stack.id] = i; renderCell(stack); });
      cell.dotsEl.appendChild(d);
    });
  }
  updateStale(cell);
}

function buildPagePanel(page) {
  const panel = document.createElement("div");
  panel.className = "board-panel" + (page?.mode === "tiled" ? " is-tiled" : "");
  const layout = page?.layout || [];
  if (!layout.length) {
    panel.innerHTML = `<div class="board-empty"><div>Nothing on this page yet.</div><a href="/">Open the editor →</a></div>`;
    return panel;
  }
  panel.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  panel.style.gridTemplateRows    = `repeat(${rows}, minmax(0, 1fr))`;

  const shownAt = now();
  layout.forEach((node, i) => {
    // Each card holds for a full interval after the page appears, and cards
    // flip a moment apart rather than all at once.
    if (stackById[node.stack_id]) lastCycleAt[node.stack_id] = shownAt + i * 1500;
  });
  for (const node of layout) {
    const stack = stackById[node.stack_id];
    if (!stack) continue;
    const el = document.createElement("div");
    el.className = "stack-cell";
    el.dataset.stackId = stack.id;
    el.style.gridColumn = `${node.x + 1} / span ${node.w}`;
    el.style.gridRow    = `${node.y + 1} / span ${node.h}`;

    const bodyEl = Object.assign(document.createElement("div"), { className: "display-widget-body" });
    const dotsEl = Object.assign(document.createElement("div"), { className: "stack-dots" });
    const staleEl = Object.assign(document.createElement("div"), { className: "stale-badge" });
    el.append(bodyEl, dotsEl, staleEl);

    // Widgets that handle their own taps stop the click, so note the touch here.
    el.addEventListener("pointerdown", () => noteTouch(stack.id), true);
    el.addEventListener("click", (e) => {
      if (editing) return;
      // Links, buttons and widget controls handle their own taps.
      if (e.target.closest("a, button, input, textarea, select, [data-interactive], .widget-ctrl")) return;
      noteTouch(stack.id);
      cycle(stack);
    });
    el.addEventListener("wheel", (e) => {
      if (editing) return;
      const ids = idsOf(stack);
      if (ids.length < 2) return;
      let t = e.target;
      while (t && t !== el) {
        if (t.scrollHeight > t.clientHeight + 2) {
          const atTop = t.scrollTop <= 0;
          const atBottom = t.scrollTop + t.clientHeight >= t.scrollHeight - 2;
          if (!((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom))) return;
          break;
        }
        t = t.parentElement;
      }
      e.preventDefault();
      noteTouch(stack.id);
      const cur = activeIndex[stack.id] || 0;
      activeIndex[stack.id] = e.deltaY > 0 ? (cur + 1) % ids.length : (cur - 1 + ids.length) % ids.length;
      renderCell(stack);
    }, { passive: false });

    panel.appendChild(el);
    cellByStack[stack.id] = { el, bodyEl, dotsEl, staleEl, stack };
    renderCell(stack);
  }
  return panel;
}

function switchPage(idx, { animate = true } = {}) {
  if (idx < 0 || idx >= pages.length || isAnimating) return;
  const direction = idx > currentPageIdx ? 1 : idx < currentPageIdx ? -1 : 0;
  currentPageIdx = idx;
  lastPageChange = now();

  for (const k of Object.keys(cellByStack)) delete cellByStack[k];
  const newPanel = buildPagePanel(pages[idx]);
  const oldPanel = boardEl.querySelector(".board-panel");

  if (!oldPanel || direction === 0 || !animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    if (oldPanel) oldPanel.remove();
    boardEl.appendChild(newPanel);
    showIndicator();
    return;
  }
  isAnimating = true;
  newPanel.style.transform = `translateX(${direction * 100}%)`;
  boardEl.appendChild(newPanel);
  newPanel.getBoundingClientRect();
  const dur = 420, ease = "cubic-bezier(0.4, 0, 0.2, 1)";
  oldPanel.style.transition = newPanel.style.transition = `transform ${dur}ms ${ease}`;
  oldPanel.style.transform = `translateX(${-direction * 100}%)`;
  newPanel.style.transform = "translateX(0%)";
  let done = false;
  const cleanup = () => {
    if (done) return; done = true;
    oldPanel.remove();
    newPanel.style.transition = newPanel.style.transform = "";
    isAnimating = false;
    showIndicator();
  };
  newPanel.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, dur + 80);
}

function buildBoard(full) {
  columns     = full.board?.columns || 24;
  rows        = full.board?.rows || 16;
  options     = full.board?.options || {};
  widgetsById = Object.fromEntries(full.widgets.map((w) => [w.id, w]));
  stackById   = Object.fromEntries(full.stacks.map((s) => [s.id, s]));
  pages = full.board?.pages?.length ? full.board.pages : [{ id: 1, name: "Page 1", layout: [] }];

  if (!pages.some((p) => p.layout && p.layout.length)) {
    boardEl.innerHTML = `<div class="board-empty"><div>No cards placed yet.</div><a href="/">Open the editor →</a></div>`;
    indicatorEl.classList.remove("visible");
    return;
  }
  boardEl.querySelector(".board-empty")?.remove();
  if (currentPageIdx >= pages.length) currentPageIdx = 0;
  switchPage(currentPageIdx, { animate: false });
  setupWakeLock();
}

function cycle(stack) {
  const ids = idsOf(stack);
  if (ids.length < 2) return;
  activeIndex[stack.id] = ((activeIndex[stack.id] || 0) + 1) % ids.length;
  lastCycleAt[stack.id] = now();
  renderCell(stack);
}

// One step of automatic cycling: the next page of a multi-page widget (Weather,
// NetBox, TrueNAS), then the next widget in the stack starting on its first
// page, then back to the beginning.
const pagedRoot = (stack) => cellByStack[stack.id]?.bodyEl.querySelector(".w-paged") || null;
const canStep = (stack) => idsOf(stack).length > 1 || !!pagedRoot(stack);
function toFirstPage(stack) {
  const p = pagedRoot(stack);
  if (p && Number(p.dataset.pageIndex) !== 0) p._showPage(0);
}
function step(stack) {
  lastCycleAt[stack.id] = now();
  const p = pagedRoot(stack);
  if (p) {
    const i = Number(p.dataset.pageIndex) || 0;
    if (i + 1 < (Number(p.dataset.pageCount) || 1)) { p._showPage(i + 1); return; }
  }
  if (idsOf(stack).length > 1) { cycle(stack); toFirstPage(stack); }
  else toFirstPage(stack);
}

function noteTouch(stackId) {
  lastInteraction = now();
  if (stackId != null) touchedAt[stackId] = now();
}

// ── staleness ───────────────────────────────────────────────────────────────
const NO_STALE = new Set(["clock", "notes", "stream", "photos"]);
function updateStale(cell) {
  if (!cell?.staleEl) return;
  let stale = false, text = "";
  if (opt("staleness", true)) {
    const wid = currentWidgetId(cell.stack);
    const w = widgetsById[wid];
    if (w && !NO_STALE.has(w.type)) {
      const env = envelopeCache[wid];
      const limit = Math.max(90, 3 * (w.refresh_interval_sec || 30));
      if (env?.ts) {
        stale = now() / 1000 - env.ts > limit;
        text = `Updated ${timeAgo(env.ts)}`;
      } else if (now() - bootAt > 60000) {
        stale = true; text = "Waiting for data";
      }
      if (!sseOnline && sseDownSince && now() - sseDownSince > 30000) { stale = true; text = text || "Offline"; }
    }
  }
  cell.el.classList.toggle("is-stale", stale);
  cell.staleEl.textContent = stale ? text : "";
}

// ── live updates ─────────────────────────────────────────────────────────────
function onEnvelope(env) {
  const hadPrev = env.widget_id in envelopeCache;
  const prevLevel = envelopeCache[env.widget_id]?.alert?.level || null;
  envelopeCache[env.widget_id] = env;
  if (env.alert?.level === "crit" && prevLevel !== "crit" && hadPrev) takeover(env.widget_id);
  if (widgetsById[env.widget_id]?.type === "stream") return; // re-rendering would restart the video
  for (const c of Object.values(cellByStack)) {
    if (c.stack.widget_ids.includes(env.widget_id)) {
      if (currentWidgetId(c.stack) === env.widget_id) renderCell(c.stack);
      else {
        // keep the stack's alert color and dots current even when another widget is showing
        const worst = stackAlert(c.stack);
        c.el.classList.toggle("alert-warn", worst === "warn");
        c.el.classList.toggle("alert-crit", worst === "crit");
      }
    }
  }
}

function takeover(widgetId) {
  if (!opt("alert_takeover", true) || editing) return;
  for (let p = 0; p < pages.length; p++) {
    for (const node of pages[p].layout || []) {
      const stack = stackById[node.stack_id];
      if (!stack) continue;
      const ids = idsOf(stack);
      const i = ids.indexOf(widgetId);
      if (i === -1) continue;
      activeIndex[stack.id] = i;
      holdUntil = now() + 120000;
      if (p !== currentPageIdx) switchPage(p);
      else renderCell(stack);
      requestAnimationFrame(() => {
        const cell = cellByStack[stack.id];
        if (cell) { cell.el.classList.remove("takeover"); void cell.el.offsetWidth; cell.el.classList.add("takeover"); }
      });
      return;
    }
  }
}

function connectSSE() {
  const es = new EventSource("/api/stream");
  let downTimer = null;
  es.onopen = () => {
    clearTimeout(downTimer);
    sseOnline = true; sseDownSince = 0;
    offlineEl.classList.add("hidden");
  };
  es.onerror = () => {
    if (!sseOnline) return;
    sseOnline = false; sseDownSince = now();
    clearTimeout(downTimer);
    downTimer = setTimeout(() => { if (!sseOnline) offlineEl.classList.remove("hidden"); }, 3000);
  };
  es.onmessage = (e) => {
    let env;
    try { env = JSON.parse(e.data); } catch { return; }
    if (env.type === "settings_update") applySettings(env.data || {});
    else if (env.type === "widget_update") refreshStructure();
    else if (env.type === "active_profile_changed") { if (!PROFILE_REF) refreshStructure(); }
    else if (env.type === "config_restored") window.location.reload();
    else if (env.widget_id != null) onEnvelope(env);
  };
}

// ── navigation ───────────────────────────────────────────────────────────────
function goToPage(idx) {
  if (!lastFull || pages.length <= 1) return;
  switchPage(Math.max(0, Math.min(pages.length - 1, idx)));
}

function setupNavigation() {
  document.addEventListener("keydown", (e) => {
    if (editing) return;
    if (e.key === "ArrowRight") { lastInteraction = now(); goToPage(currentPageIdx + 1); }
    if (e.key === "ArrowLeft")  { lastInteraction = now(); goToPage(currentPageIdx - 1); }
  });
  indicatorEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    lastInteraction = now();
    goToPage(e.deltaY > 0 ? currentPageIdx + 1 : currentPageIdx - 1);
  }, { passive: false });
  // Tap the switcher for the next page (wrapping), or a dot to jump to that page.
  indicatorEl.addEventListener("click", (e) => {
    if (editing || pages.length <= 1) return;
    e.stopPropagation();
    lastInteraction = now();
    const dot = e.target.closest(".pi-dot");
    const target = dot ? Number(dot.dataset.page) : (currentPageIdx + 1) % pages.length;
    if (target !== currentPageIdx) goToPage(target);
  });
  indicatorEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    indicatorEl.click();
  });

  let sx = null, sy = null;
  document.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; lastInteraction = now(); }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (sx === null || editing) { sx = null; return; }
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = sy = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    goToPage(dx < 0 ? currentPageIdx + 1 : currentPageIdx - 1);
  }, { passive: true });
  document.addEventListener("pointerdown", () => { lastInteraction = now(); }, { passive: true });
}

// ── timers: rotation, auto-cycling stacks, night mode, staleness ────────────
function parseHM(s, def) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || def));
  return m ? Number(m[1]) * 60 + Number(m[2]) : parseHM(def, "00:00");
}
function isNight() {
  const n = opt("night", null);
  if (!n || !n.enabled) return false;
  const d = new Date(), m = d.getHours() * 60 + d.getMinutes();
  const a = parseHM(n.start, "22:00"), b = parseHM(n.end, "07:00");
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

let nightActive = false;
function updateNight() {
  const on = isNight();
  if (on !== nightActive) {
    nightActive = on;
    document.body.classList.toggle("is-night", on);
    const n = opt("night", {}) || {};
    dimEl.style.opacity = on ? String(Math.max(0, Math.min(0.92, 1 - Number(n.brightness ?? 0.35)))) : "0";
    if (on && Number.isInteger(n.page) && n.page >= 0 && n.page < pages.length) goToPage(n.page);
  }
}

let shiftStep = 0;
function pixelShift() {
  if (!opt("pixel_shift", false)) { boardEl.style.translate = ""; return; }
  const offsets = [[0, 0], [2, 1], [-1, 2], [-2, -1], [1, -2], [3, 0], [0, 3], [-3, 0], [0, -3]];
  const [x, y] = offsets[shiftStep++ % offsets.length];
  boardEl.style.translate = `${x}px ${y}px`;
}

function ticker() {
  if (editing || !lastFull) return;
  const t = now();
  // auto-cycling stacks
  const cycleMs = Math.max(4, Number(opt("stack_cycle_sec", 12))) * 1000;
  const cycleAll = !!opt("stack_cycle", false);
  for (const c of Object.values(cellByStack)) {
    const mode = c.stack.cycle_mode || "tap";
    if (!(mode === "auto" || (mode === "tap" && cycleAll))) continue;
    if (t - (touchedAt[c.stack.id] || 0) < 30000) continue;
    if (t - (lastCycleAt[c.stack.id] || 0) >= cycleMs && canStep(c.stack)) step(c.stack);
  }
  // page rotation
  const rot = Number(opt("rotate_sec", 0));
  const pauseMs = Math.max(0, Number(opt("rotate_pause_sec", 60))) * 1000;
  const nightPage = nightActive && Number.isInteger(opt("night", {})?.page);
  if (rot > 0 && pages.length > 1 && !nightPage && t >= holdUntil && t - lastInteraction >= pauseMs && t - lastPageChange >= rot * 1000) {
    for (let k = 1; k <= pages.length; k++) {
      const i = (currentPageIdx + k) % pages.length;
      if (pages[i].rotate !== false && (pages[i].layout || []).length) { if (i !== currentPageIdx) switchPage(i); else lastPageChange = t; break; }
    }
  }
}

// ── wake lock ────────────────────────────────────────────────────────────────
let wakeLock = null;
async function setupWakeLock() {
  if (!opt("wake_lock", true) || !("wakeLock" in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { /* not allowed here (no gesture yet, or not https) */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") setupWakeLock(); });
document.addEventListener("pointerdown", () => setupWakeLock(), { once: true });

// ── boot ─────────────────────────────────────────────────────────────────────
async function fetchFull() {
  const q = PROFILE_REF ? `?profile=${encodeURIComponent(PROFILE_REF)}` : "";
  const r = await fetch("/api/board/full" + q);
  if (!r.ok) throw new Error(r.status === 404 ? `No board named "${PROFILE_REF}"` : `HTTP ${r.status}`);
  return r.json();
}

async function refreshStructure(force = false) {
  if (editing) return;
  let full;
  try { full = await fetchFull(); }
  catch (err) {
    if (!lastFull) boardEl.innerHTML = `<div class="board-empty"><div>${String(err.message).replace(/</g, "&lt;")}</div><a href="/">Open the editor →</a></div>`;
    return;
  }
  lastFull = full;
  const key = JSON.stringify([
    full.board?.pages, full.board?.columns, full.board?.rows, full.board?.options,
    full.stacks.map((s) => [s.id, s.widget_ids, s.cycle_mode, s.name]),
    full.widgets.map((w) => [w.id, w.type, w.title, w.config, w.refresh_interval_sec]),
  ]);
  if (key === lastStructureKey && !force) return;
  lastStructureKey = key;
  buildBoard(full);
  updateNight();
}

// Prime envelopes for widgets that already have data (SSE also replays them).
async function primeData() {
  if (!lastFull) return;
  await Promise.all(lastFull.widgets.map(async (w) => {
    if (envelopeCache[w.id]) return;
    try {
      const r = await fetch(`/api/widgets/${w.id}/data`);
      const env = await r.json();
      if (env?.data && !envelopeCache[w.id]) onEnvelope(env);
    } catch { /* ignore */ }
  }));
}

async function checkForUpdate() {
  const badge = document.getElementById("display-update-badge");
  if (!badge) return;
  try {
    const state = await (await fetch("/api/update-check")).json();
    badge.classList.toggle("hidden", !state.update_available);
  } catch { /* ignore */ }
}

async function init() {
  setupNavigation();
  await refreshStructure();
  connectSSE();
  primeData();
  checkForUpdate();
  setInterval(refreshStructure, 15000);
  setInterval(checkForUpdate, 30 * 60 * 1000);
  setInterval(ticker, 1000);
  setInterval(updateNight, 30000);
  setInterval(pixelShift, 180000);
  setInterval(() => Object.values(cellByStack).forEach(updateStale), 15000);

  initDisplayEdit({
    boardEl,
    enabled: () => opt("edit_on_display", true),
    state: () => ({ full: lastFull, pageIdx: currentPageIdx, columns, rows }),
    setEditing: (on) => { editing = on; document.body.classList.toggle("display-editing", on); },
    rebuild: async () => { lastStructureKey = null; await refreshStructure(true); },
    renderWidget: (w) => renderWidget(w, envelopeCache[w.id] || null),
  });
}

init();
