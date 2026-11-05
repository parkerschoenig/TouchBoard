// Tiled pages: cards always fill the page, and dragging the line between two
// cards resizes both sides at once (like a tiling window manager). Stored as
// ordinary x/y/w/h nodes, so the display renders tiled pages unchanged.
//
// ctx: { stage, nodes() -> [{stackId,x,y,w,h}], cols(), rows(), cellSize() -> {cw, ch},
//        apply(nodes) (live preview), commit() (save + history) }

import { dividers, moveDivider } from "./geometry.js";

export function createTiledOverlay(ctx) {
  const layer = document.createElement("div");
  layer.className = "ed-tiled-layer";
  ctx.stage.appendChild(layer);

  function render() {
    layer.innerHTML = "";
    const nodes = ctx.nodes();
    const { cw, ch } = ctx.cellSize();
    for (const d of dividers(nodes)) {
      const el = document.createElement("div");
      el.className = `ed-divider ed-divider-${d.axis}`;
      if (d.axis === "v") {
        el.style.left = `${d.pos * cw}px`;
        el.style.top = `${d.from * ch}px`;
        el.style.height = `${(d.to - d.from) * ch}px`;
      } else {
        el.style.top = `${d.pos * ch}px`;
        el.style.left = `${d.from * cw}px`;
        el.style.width = `${(d.to - d.from) * cw}px`;
      }
      el.title = "Drag to resize both sides";
      el.appendChild(Object.assign(document.createElement("span"), { className: "ed-divider-grip" }));
      el.addEventListener("pointerdown", (e) => start(e, d, el));
      layer.appendChild(el);
    }
  }

  function start(e, div, el) {
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    el.classList.add("is-dragging");
    const base = ctx.nodes();
    const { cw, ch } = ctx.cellSize();
    const scale = ctx.scale ? ctx.scale() : 1;
    const origin = div.axis === "v" ? e.clientX : e.clientY;
    const size = div.axis === "v" ? cw : ch;
    let lastDelta = 0;
    const move = (ev) => {
      const px = ((div.axis === "v" ? ev.clientX : ev.clientY) - origin) / scale;
      const delta = Math.round(px / size);
      if (delta === lastDelta) return;
      const res = moveDivider(base, div, delta);
      lastDelta = delta;
      ctx.apply(res.nodes);
      const off = res.delta * size;
      el.style[div.axis === "v" ? "left" : "top"] = `${div.pos * size + off}px`;
    };
    const up = () => {
      el.releasePointerCapture?.(e.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (lastDelta) ctx.commit();
      render();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  return {
    render,
    show(on) { layer.hidden = !on; if (on) render(); },
    destroy() { layer.remove(); },
  };
}
