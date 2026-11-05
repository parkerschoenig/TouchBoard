// Export one page (its cards, stacks and widget settings) as a JSON file, and
// import such a file as a new page. Integration credentials are never in the
// file: widgets keep only the type and name of their connection, and on import
// they're matched to a connection with the same type (and name, if possible).

import { rescale } from "./geometry.js";

const FORMAT = "touchboard-page";

export function exportPage(page, { stacks, widgetsById, dataSources, cols, rows }) {
  const stackIds = new Set((page.layout || []).map((n) => n.stack_id));
  const pageStacks = stacks.filter((s) => stackIds.has(s.id));
  const widgetIds = new Set(pageStacks.flatMap((s) => s.widget_ids));
  const dsById = Object.fromEntries((dataSources || []).map((d) => [d.id, d]));
  const payload = {
    format: FORMAT, version: 1, exported_at: new Date().toISOString(),
    grid: { columns: cols, rows },
    page: { name: page.name, mode: page.mode || "free", rotate: page.rotate !== false, layout: page.layout || [] },
    stacks: pageStacks.map((s) => ({ id: s.id, name: s.name, widget_ids: s.widget_ids, cycle_mode: s.cycle_mode })),
    widgets: [...widgetIds].map((id) => widgetsById[id]).filter(Boolean).map((w) => ({
      id: w.id, type: w.type, title: w.title, config: w.config, refresh_interval_sec: w.refresh_interval_sec,
      data_source: w.data_source_id && dsById[w.data_source_id] ? { type: dsById[w.data_source_id].type, name: dsById[w.data_source_id].name } : null,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `touchboard-page-${(page.name || "page").replace(/[^\w-]+/g, "-").toLowerCase()}.json`,
  });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ctx: { createWidget, createStack, addPage, dataSources, cols, rows }
export async function importPage(file, ctx) {
  const data = JSON.parse(await file.text());
  if (data?.format !== FORMAT) throw new Error("This isn't a TouchBoard page file.");
  const sources = ctx.dataSources || [];
  const widgetMap = {};
  for (const w of data.widgets || []) {
    let dsId = null;
    if (w.data_source) {
      const match = sources.find((d) => d.type === w.data_source.type && d.name === w.data_source.name)
        || sources.find((d) => d.type === w.data_source.type);
      dsId = match ? match.id : null;
    }
    const created = await ctx.createWidget({
      type: w.type, title: w.title, config: w.config || {}, refresh_interval_sec: w.refresh_interval_sec ?? 30, data_source_id: dsId,
    });
    widgetMap[w.id] = created.id;
  }
  const stackMap = {};
  for (const s of data.stacks || []) {
    const ids = (s.widget_ids || []).map((id) => widgetMap[id]).filter(Boolean);
    if (!ids.length) continue;
    const created = await ctx.createStack({ name: s.name, widget_ids: ids, cycle_mode: s.cycle_mode || "tap" });
    stackMap[s.id] = created.id;
  }
  const g = data.grid || { columns: 24, rows: 16 };
  const nodes = (data.page?.layout || []).filter((n) => stackMap[n.stack_id]);
  const scaled = rescale(nodes, g.columns, g.rows, ctx.cols, ctx.rows, 1, 1);
  const layout = scaled.map((n) => ({ ...n, stack_id: stackMap[n.stack_id] }));
  return ctx.addPage(data.page?.name || "Imported page", layout, { mode: data.page?.mode, rotate: data.page?.rotate });
}
