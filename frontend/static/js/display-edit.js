// Edit on the display: long-press the board to rearrange the current page in
// place, like a phone home screen. Cards wiggle; drag to move, drag the corner
// to resize, tap − to remove, + Add to place a widget, Done to save.
//
// It needs a signed-in session in this browser (the display itself is public),
// and saves through the same API the editor uses.

const LONG_PRESS_MS = 700;
const MOVE_TOLERANCE = 10;

async function jsonFetch(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  if (!r.ok) throw Object.assign(new Error(`${method} ${url} → ${r.status}`), { status: r.status });
  return r.json();
}

function toast(msg, ms = 3500) {
  document.querySelector(".display-toast")?.remove();
  const t = Object.assign(document.createElement("div"), { className: "display-toast", textContent: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function initDisplayEdit(ctx) {
  let pressTimer = null, startX = 0, startY = 0;

  ctx.boardEl.addEventListener("pointerdown", (e) => {
    if (document.body.classList.contains("display-editing") || !ctx.enabled()) return;
    if (e.target.closest("a, button, input, [data-interactive]")) return;
    startX = e.clientX; startY = e.clientY;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => begin(), LONG_PRESS_MS);
  });
  const cancelPress = (e) => {
    if (e.type === "pointermove" && Math.hypot(e.clientX - startX, e.clientY - startY) < MOVE_TOLERANCE) return;
    clearTimeout(pressTimer);
  };
  ["pointerup", "pointercancel", "pointermove", "wheel"].forEach((t) => ctx.boardEl.addEventListener(t, cancelPress, { passive: true }));
  ctx.boardEl.addEventListener("contextmenu", (e) => { if (ctx.enabled()) e.preventDefault(); });

  async function begin() {
    try {
      await jsonFetch("GET", "/api/auth/me");
    } catch (err) {
      toast(err.status === 401 ? "Sign in on this screen (open /login) to edit it here." : "Couldn't check your sign-in.");
      return;
    }
    const { full, pageIdx, columns, rows } = ctx.state();
    if (!full?.board) return;
    session(full, pageIdx, columns, rows);
  }

  function session(full, pageIdx, columns, rows) {
    const profileId = full.board.id;
    const pages = JSON.parse(JSON.stringify(full.board.pages));
    const page = pages[pageIdx];
    const layout = page.layout || (page.layout = []);
    const stacks = Object.fromEntries(full.stacks.map((s) => [s.id, s]));
    const widgets = Object.fromEntries(full.widgets.map((w) => [w.id, w]));
    const removed = new Set();
    const created = new Set();

    ctx.setEditing(true);
    const panel = ctx.boardEl.querySelector(".board-panel");
    panel.style.setProperty("--de-cols", columns);
    panel.style.setProperty("--de-rows", rows);
    const bar = document.createElement("div");
    bar.className = "de-bar";
    bar.innerHTML = `<button type="button" class="de-btn de-add">+ Add</button>
      <span class="de-hint">Drag to move · corner to resize · − to remove</span>
      <button type="button" class="de-btn de-cancel">Cancel</button>
      <button type="button" class="de-btn de-done">Done</button>`;
    document.body.appendChild(bar);

    const cellPx = () => {
      const r = panel.getBoundingClientRect();
      const cs = getComputedStyle(panel);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      return { r, cw: (r.width - padX) / columns, ch: (r.height - padY) / rows, left: r.left + parseFloat(cs.paddingLeft), top: r.top + parseFloat(cs.paddingTop) };
    };
    const place = (el, n) => {
      el.style.gridColumn = `${n.x + 1} / span ${n.w}`;
      el.style.gridRow = `${n.y + 1} / span ${n.h}`;
    };
    const fits = (n, self) => n.x >= 0 && n.y >= 0 && n.x + n.w <= columns && n.y + n.h <= rows &&
      layout.every((o) => o === self || removed.has(o.stack_id) || !overlaps(n, o));

    const ghost = Object.assign(document.createElement("div"), { className: "de-ghost" });
    panel.appendChild(ghost);

    function decorate(cellEl, node) {
      cellEl.classList.add("de-cell");
      const minus = Object.assign(document.createElement("button"), { type: "button", className: "de-minus", textContent: "−", title: "Remove from page" });
      const grip = Object.assign(document.createElement("span"), { className: "de-resize", title: "Resize" });
      cellEl.append(minus, grip);
      minus.addEventListener("pointerdown", (e) => e.stopPropagation());
      minus.addEventListener("click", (e) => {
        e.stopPropagation();
        removed.add(node.stack_id);
        cellEl.remove();
      });
      const drag = (mode) => (e) => {
        if (e.target === minus) return;
        e.preventDefault(); e.stopPropagation();
        const { cw, ch } = cellPx();
        const sx = e.clientX, sy = e.clientY;
        const orig = { ...node };
        let cand = { ...node };
        cellEl.setPointerCapture(e.pointerId);
        cellEl.classList.add("de-dragging");
        ghost.style.display = "block";
        place(ghost, cand);
        const move = (ev) => {
          const dx = Math.round((ev.clientX - sx) / cw), dy = Math.round((ev.clientY - sy) / ch);
          cand = mode === "move"
            ? { ...orig, x: Math.max(0, Math.min(columns - orig.w, orig.x + dx)), y: Math.max(0, Math.min(rows - orig.h, orig.y + dy)) }
            : { ...orig, w: Math.max(2, Math.min(columns - orig.x, orig.w + dx)), h: Math.max(2, Math.min(rows - orig.y, orig.h + dy)) };
          cellEl.style.translate = mode === "move" ? `${ev.clientX - sx}px ${ev.clientY - sy}px` : "";
          place(ghost, cand);
          ghost.classList.toggle("bad", !fits(cand, node));
          if (mode === "resize") place(cellEl, cand);
        };
        const up = () => {
          cellEl.removeEventListener("pointermove", move);
          cellEl.removeEventListener("pointerup", up);
          cellEl.removeEventListener("pointercancel", up);
          cellEl.classList.remove("de-dragging");
          cellEl.style.translate = "";
          ghost.style.display = "none";
          if (fits(cand, node)) Object.assign(node, { x: cand.x, y: cand.y, w: cand.w, h: cand.h });
          place(cellEl, node);
        };
        cellEl.addEventListener("pointermove", move);
        cellEl.addEventListener("pointerup", up);
        cellEl.addEventListener("pointercancel", up);
      };
      cellEl.addEventListener("pointerdown", drag("move"));
      grip.addEventListener("pointerdown", drag("resize"));
    }

    for (const node of layout) {
      const cellEl = panel.querySelector(`.stack-cell[data-stack-id="${node.stack_id}"]`);
      if (cellEl) decorate(cellEl, node);
    }

    function freeSpot(w, h) {
      for (const [tw, th] of [[w, h], [Math.max(2, w - 2), h], [Math.max(2, w - 2), Math.max(2, h - 1)], [3, 3], [2, 2]]) {
        for (let y = 0; y + th <= rows; y++) for (let x = 0; x + tw <= columns; x++) {
          const n = { x, y, w: tw, h: th };
          if (fits(n, null)) return n;
        }
      }
      return null;
    }

    function openPicker() {
      document.querySelector(".de-sheet")?.remove();
      const sheet = document.createElement("div");
      sheet.className = "de-sheet";
      const placedWidgets = new Set(layout.filter((n) => !removed.has(n.stack_id)).flatMap((n) => stacks[n.stack_id]?.widget_ids || []));
      const list = Object.values(widgets).sort((a, b) => (placedWidgets.has(a.id) - placedWidgets.has(b.id)) || a.title.localeCompare(b.title));
      sheet.innerHTML = `<div class="de-sheet-head">Add a widget to this page<button type="button" class="de-btn de-sheet-close">Close</button></div>`;
      const grid = document.createElement("div");
      grid.className = "de-sheet-grid";
      for (const w of list) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "de-pick";
        b.innerHTML = `<b></b><small></small>`;
        b.querySelector("b").textContent = w.title;
        b.querySelector("small").textContent = w.type + (placedWidgets.has(w.id) ? " · on this page" : "");
        b.addEventListener("click", async () => {
          const spot = freeSpot(6, 4);
          if (!spot) { toast("No room on this page."); return; }
          try {
            const s = await jsonFetch("POST", `/api/stacks?profile_id=${profileId}`, { name: w.title, widget_ids: [w.id] });
            stacks[s.id] = s;
            created.add(s.id);
            const node = { stack_id: s.id, ...spot, item_type: "widget" };
            layout.push(node);
            const cellEl = document.createElement("div");
            cellEl.className = "stack-cell";
            cellEl.dataset.stackId = s.id;
            const body = document.createElement("div");
            body.className = "display-widget-body";
            body.appendChild(ctx.renderWidget(w));
            cellEl.appendChild(body);
            place(cellEl, node);
            panel.appendChild(cellEl);
            decorate(cellEl, node);
            sheet.remove();
          } catch { toast("Couldn't add that widget."); }
        });
        grid.appendChild(b);
      }
      if (!list.length) grid.textContent = "No widgets yet. Create them in the editor.";
      sheet.appendChild(grid);
      sheet.querySelector(".de-sheet-close").addEventListener("click", () => sheet.remove());
      document.body.appendChild(sheet);
    }

    async function finish(save) {
      bar.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        if (save) {
          page.layout = layout.filter((n) => !removed.has(n.stack_id));
          await jsonFetch("PUT", `/api/board?profile_id=${profileId}`, { pages });
          for (const id of removed) await jsonFetch("DELETE", `/api/stacks/${id}`).catch(() => {});
          toast("Saved.");
        } else {
          for (const id of created) await jsonFetch("DELETE", `/api/stacks/${id}`).catch(() => {});
        }
      } catch {
        toast("Couldn't save. Your changes weren't applied.");
      }
      bar.remove();
      document.querySelector(".de-sheet")?.remove();
      ctx.setEditing(false);
      await ctx.rebuild();
    }

    bar.querySelector(".de-add").addEventListener("click", openPicker);
    bar.querySelector(".de-cancel").addEventListener("click", () => finish(false));
    bar.querySelector(".de-done").addEventListener("click", () => finish(true));
  }
}
