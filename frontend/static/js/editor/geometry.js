// Pure grid geometry for the editor: occupancy, free spots, fill-to-neighbor,
// and the shared edges that tiled pages resize together. Nodes are
// {x, y, w, h} in grid cells. No DOM here, so it's easy to test in Node.

export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function inBounds(n, cols, rows) {
  return n.x >= 0 && n.y >= 0 && n.w >= 1 && n.h >= 1 && n.x + n.w <= cols && n.y + n.h <= rows;
}

export function isFree(n, nodes, cols, rows, ignore = null) {
  return inBounds(n, cols, rows) && nodes.every((o) => o === ignore || !overlaps(n, o));
}

// First free spot for a w×h card, scanning outward from (px, py). Shrinks the
// size step by step (down to minW×minH) when nothing that big fits.
export function findFreeSpot(nodes, cols, rows, w, h, { px = 0, py = 0, minW = 2, minH = 2 } = {}) {
  w = Math.min(w, cols); h = Math.min(h, rows);
  const sizes = [];
  for (let sh = h; sh >= minH; sh--) for (let sw = w; sw >= minW; sw--) sizes.push([sw, sh]);
  sizes.sort((a, b) => b[0] * b[1] - a[0] * a[1] || b[0] - a[0]);
  for (const [sw, sh] of sizes) {
    let best = null, bestD = Infinity;
    for (let y = 0; y + sh <= rows; y++) {
      for (let x = 0; x + sw <= cols; x++) {
        const n = { x, y, w: sw, h: sh };
        if (!isFree(n, nodes, cols, rows)) continue;
        const d = Math.hypot(x - px, y - py);
        if (d < bestD) { bestD = d; best = n; }
      }
    }
    if (best) return best;
  }
  return null;
}

// Grow one edge of `n` as far as it can go without overlapping `others`.
export function growEdge(n, others, cols, rows, edge) {
  const out = { ...n };
  const ok = (c) => isFree(c, others, cols, rows);
  const step = { e: [0, 0, 1, 0], w: [-1, 0, 1, 0], s: [0, 0, 0, 1], n: [0, -1, 0, 1] }[edge];
  if (!step) return out;
  for (;;) {
    const c = { x: out.x + step[0], y: out.y + step[1], w: out.w + step[2], h: out.h + step[3] };
    if (!ok(c)) break;
    Object.assign(out, c);
  }
  return out;
}

// Grow in every direction (right, down, left, up), repeating until stable.
export function fillSpace(n, nodes, cols, rows) {
  const others = nodes.filter((o) => o !== n);
  let cur = { ...n };
  for (const e of ["e", "s", "w", "n"]) cur = growEdge(cur, others, cols, rows, e);
  return cur;
}

// Expand every card into empty space so a page is fully tiled (where possible).
export function tileAll(nodes, cols, rows) {
  const out = nodes.map((n) => ({ ...n }));
  for (let i = 0; i < out.length; i++) {
    const grown = fillSpace(out[i], out, cols, rows);
    out[i] = Object.assign(out[i], grown);
  }
  return out;
}

// Shared edges for tiled resizing. Returns dividers:
//   {axis: "v", pos: x, from: y0, to: y1, a: [indices left], b: [indices right]}
//   {axis: "h", pos: y, from: x0, to: x1, a: [indices above], b: [indices below]}
// Cards on both sides of a divider resize together when it's dragged.
export function dividers(nodes) {
  const out = [];
  for (const axis of ["v", "h"]) {
    const positions = new Set();
    nodes.forEach((n) => positions.add(axis === "v" ? n.x + n.w : n.y + n.h));
    for (const pos of positions) {
      const a = [], b = [];
      nodes.forEach((n, i) => {
        if ((axis === "v" ? n.x + n.w : n.y + n.h) === pos) a.push(i);
        if ((axis === "v" ? n.x : n.y) === pos) b.push(i);
      });
      if (!a.length || !b.length) continue;
      // Connected components along the divider: cards whose spans overlap chain together.
      const span = (i) => (axis === "v" ? [nodes[i].y, nodes[i].y + nodes[i].h] : [nodes[i].x, nodes[i].x + nodes[i].w]);
      const items = [...a.map((i) => ({ i, side: "a" })), ...b.map((i) => ({ i, side: "b" }))]
        .map((it) => ({ ...it, s: span(it.i) }))
        .sort((p, q) => p.s[0] - q.s[0]);
      let group = null;
      const flush = () => {
        if (group && group.a.length && group.b.length) out.push(group);
      };
      for (const it of items) {
        if (!group || it.s[0] >= group.to) {
          flush();
          group = { axis, pos, from: it.s[0], to: it.s[1], a: [], b: [] };
        }
        group.to = Math.max(group.to, it.s[1]);
        group[it.side].push(it.i);
      }
      flush();
    }
  }
  return out;
}

// Move a divider by `delta` cells, clamped so every card keeps its minimum size.
export function moveDivider(nodes, div, delta, minSize = 2) {
  const key = div.axis === "v" ? ["x", "w"] : ["y", "h"];
  let lo = -Infinity, hi = Infinity;
  for (const i of div.a) lo = Math.max(lo, minSize - nodes[i][key[1]]);
  for (const i of div.b) hi = Math.min(hi, nodes[i][key[1]] - minSize);
  const d = Math.max(lo, Math.min(hi, delta));
  if (!d) return { nodes, delta: 0 };
  const next = nodes.map((n) => ({ ...n }));
  for (const i of div.a) next[i][key[1]] += d;
  for (const i of div.b) { next[i][key[0]] += d; next[i][key[1]] -= d; }
  return { nodes: next, delta: d };
}

// Rescale a layout between grid densities (e.g. 24×16 → 12×8).
export function rescale(nodes, fromCols, fromRows, toCols, toRows, minW = 1, minH = 1) {
  const fx = toCols / fromCols, fy = toRows / fromRows;
  return nodes.map((n) => {
    const x = Math.round(n.x * fx), y = Math.round(n.y * fy);
    const x2 = Math.round((n.x + n.w) * fx), y2 = Math.round((n.y + n.h) * fy);
    return { ...n, x, y, w: Math.max(minW, x2 - x), h: Math.max(minH, y2 - y) };
  });
}
