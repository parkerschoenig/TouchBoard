// Starter layouts. Slots are in 24×16 cells and are rescaled to the board's
// grid. Applying one makes a new page: each slot takes an existing widget of
// that type (unplaced ones first), or a fresh widget for types that work
// without setup (clock, notes, bookmarks). Slots with nothing to show are skipped.

import { rescale } from "./geometry.js";

export const TEMPLATES = [
  {
    key: "overview", name: "Homelab overview", blurb: "Clock and weather on the left, Proxmox in the middle, storage and links on the right.",
    slots: [
      { type: "clock", x: 0, y: 0, w: 6, h: 5 }, { type: "weather", x: 0, y: 5, w: 6, h: 6 }, { type: "ping", x: 0, y: 11, w: 6, h: 5 },
      { type: "proxmox", x: 6, y: 0, w: 10, h: 16 },
      { type: "truenas", x: 16, y: 0, w: 8, h: 8 }, { type: "bookmarks", x: 16, y: 8, w: 8, h: 8 },
    ],
  },
  {
    key: "media", name: "Media room", blurb: "What's playing, a photo frame and headlines.",
    slots: [
      { type: "nowplaying", x: 0, y: 0, w: 9, h: 10 }, { type: "clock", x: 0, y: 10, w: 9, h: 6 },
      { type: "photos", x: 9, y: 0, w: 15, h: 10 }, { type: "rss", x: 9, y: 10, w: 15, h: 6 },
    ],
  },
  {
    key: "network", name: "Network", blurb: "Hosts, firewall, DNS filtering and a launcher.",
    slots: [
      { type: "ping", x: 0, y: 0, w: 8, h: 16 }, { type: "opnsense", x: 8, y: 0, w: 8, h: 9 },
      { type: "adguard", x: 8, y: 9, w: 8, h: 7 }, { type: "bookmarks", x: 16, y: 0, w: 8, h: 16 },
    ],
  },
  {
    key: "wall", name: "Wall calendar", blurb: "Big clock, the week ahead, weather and a note.",
    slots: [
      { type: "clock", x: 0, y: 0, w: 8, h: 6 }, { type: "weather", x: 0, y: 6, w: 8, h: 10 },
      { type: "calendar", x: 8, y: 0, w: 10, h: 16 }, { type: "notes", x: 18, y: 0, w: 6, h: 16 },
    ],
  },
  {
    key: "launcher", name: "Launcher", blurb: "A large grid of links with a clock and a note.",
    slots: [
      { type: "bookmarks", x: 0, y: 0, w: 16, h: 16 }, { type: "clock", x: 16, y: 0, w: 8, h: 6 }, { type: "notes", x: 16, y: 6, w: 8, h: 10 },
    ],
  },
];

const CREATABLE = {
  clock: { title: "Clock", config: { clock_mode: "digital", clock_format: "24h", clock_style: "full" }, refresh: 0 },
  notes: { title: "Notes", config: { text: "## Notes\n- Tap ✎ in the editor to write here" }, refresh: 300 },
  bookmarks: { title: "Bookmarks", config: { layout: "tiles", open: "new", groups: [{ name: "Apps", items: [] }] }, refresh: 60 },
};

// Mini SVG map of a layout, for template cards and page tabs.
export function miniMap(nodes, cols = 24, rows = 16, cls = "ed-minimap") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${cols} ${rows}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  for (const n of nodes) {
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", n.x + 0.25); r.setAttribute("y", n.y + 0.25);
    r.setAttribute("width", Math.max(0.2, n.w - 0.5)); r.setAttribute("height", Math.max(0.2, n.h - 0.5));
    r.setAttribute("rx", "0.5");
    svg.appendChild(r);
  }
  return svg;
}

// ctx: { widgets, placedWidgetIds(), createWidget(body), createStack(body), addPage(name, layout), cols, rows }
export async function applyTemplate(tpl, ctx) {
  const scaled = rescale(tpl.slots, 24, 16, ctx.cols, ctx.rows, 1, 1);
  const placed = ctx.placedWidgetIds();
  const used = new Set();
  const layout = [];
  for (let i = 0; i < tpl.slots.length; i++) {
    const slot = tpl.slots[i], pos = scaled[i];
    const candidates = ctx.widgets.filter((w) => w.type === slot.type && !used.has(w.id))
      .sort((a, b) => placed.has(a.id) - placed.has(b.id));
    let w = candidates[0];
    if (!w && CREATABLE[slot.type]) {
      const d = CREATABLE[slot.type];
      w = await ctx.createWidget({ type: slot.type, title: d.title, config: structuredClone(d.config), refresh_interval_sec: d.refresh });
    }
    if (!w) continue;
    used.add(w.id);
    const s = await ctx.createStack({ name: w.title, widget_ids: [w.id] });
    layout.push({ stack_id: s.id, x: pos.x, y: pos.y, w: pos.w, h: pos.h, item_type: "widget" });
  }
  return ctx.addPage(tpl.name, layout);
}
