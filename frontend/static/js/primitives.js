// Small shared building blocks for widgets: sparklines, value formatting,
// a safe Markdown subset, relative times, and opening links on a kiosk
// (same tab, new tab, or a QR code you scan with your phone).

const SVG_NS = "http://www.w3.org/2000/svg";

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

// ── sparkline ────────────────────────────────────────────────────────────────
// values: array of numbers (null = gap). Returns an <svg> that stretches to its
// box; color comes from CSS (currentColor) unless `color` is given.
export function sparkline(values, { color = null, fill = true, min = null, max = null, cls = "" } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 30");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "tb-spark " + cls);
  svg.setAttribute("aria-hidden", "true");
  const pts = (values || []).map((v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v)));
  const nums = pts.filter((v) => v != null);
  if (nums.length < 2) return svg;
  const lo = min != null ? min : Math.min(...nums);
  const hi = max != null ? max : Math.max(...nums);
  const span = hi - lo || 1;
  const n = pts.length;
  const x = (i) => (n === 1 ? 100 : (i / (n - 1)) * 100);
  const y = (v) => 28 - ((v - lo) / span) * 26;

  // Split into runs so gaps (nulls) break the line.
  const runs = [];
  let cur = [];
  pts.forEach((v, i) => {
    if (v == null) { if (cur.length) runs.push(cur); cur = []; }
    else cur.push([x(i), y(v)]);
  });
  if (cur.length) runs.push(cur);

  for (const run of runs) {
    const d = run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`).join("");
    if (fill && run.length > 1) {
      const area = document.createElementNS(SVG_NS, "path");
      area.setAttribute("d", `${d}L${run[run.length - 1][0].toFixed(2)},30L${run[0][0].toFixed(2)},30Z`);
      area.setAttribute("class", "tb-spark-area");
      if (color) area.style.fill = color;
      svg.appendChild(area);
    }
    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("d", d);
    line.setAttribute("class", "tb-spark-line");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    if (color) line.style.stroke = color;
    svg.appendChild(line);
  }
  const last = runs[runs.length - 1]?.slice(-1)[0];
  if (last) {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", last[0]); dot.setAttribute("cy", last[1]); dot.setAttribute("r", "1.6");
    dot.setAttribute("class", "tb-spark-dot");
    if (color) dot.style.fill = color;
    svg.appendChild(dot);
  }
  return svg;
}

// History for one metric from an envelope, or [] when absent.
export function series(envelope, key) {
  return envelope?.history?.[key] || [];
}

// ── level colors (theme tokens) ────────────────────────────────────────────
export function levelOf(pct, warn = 65, crit = 85) {
  if (pct == null) return "ok";
  return pct > crit ? "crit" : pct > warn ? "warn" : "ok";
}
export function levelColor(pct) {
  return `var(--tb-${levelOf(pct)})`;
}

// ── formatting ───────────────────────────────────────────────────────────────
export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return String(bytes ?? "—");
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (n < 0 ? "-" : "") + (v >= 100 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
}

export function fmtDuration(sec) {
  let s = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(r).padStart(2, "0")}`;
}

// format: auto | number | percent | bytes | duration | bool | text
export function fmtValue(value, format = "auto", decimals = null, unit = "") {
  if (value === null || value === undefined) return "—";
  const num = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value)) ? Number(value) : null);
  const dec = decimals === null || decimals === undefined || decimals === "" ? null : Number(decimals);
  const round = (n) => (dec != null ? n.toFixed(dec) : (Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : String(Math.round(n * 100) / 100)));
  let out;
  switch (format) {
    case "bytes": out = num != null ? fmtBytes(num) : String(value); break;
    case "duration": out = num != null ? fmtDuration(num) : String(value); break;
    case "percent": out = num != null ? round(num) + "%" : String(value); break;
    case "bool": out = value === true || value === "true" || value === 1 ? "Yes" : "No"; break;
    case "number": out = num != null ? round(num) : String(value); break;
    case "text": out = String(value); break;
    default: out = num != null ? round(num) : (typeof value === "boolean" ? (value ? "Yes" : "No") : String(value));
  }
  return unit ? `${out} ${unit}`.replace(/ %$/, "%") : out;
}

export function timeAgo(ts, now = Date.now() / 1000) {
  if (!ts) return "";
  const d = Math.max(0, now - ts);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// ── Markdown subset (escaped first, so no raw HTML gets through) ─────────────
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
export function markdownLite(src) {
  const lines = esc(src || "").split(/\r?\n/);
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { closeList(); out.push(`<h${m[1].length + 2} class="md-h">${inline(m[2])}</h${m[1].length + 2}>`); }
    else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      if (list !== "ul") { closeList(); out.push('<ul class="md-ul md-check">'); list = "ul"; }
      const done = m[1].toLowerCase() === "x";
      out.push(`<li class="${done ? "done" : ""}"><span class="md-box">${done ? "✓" : ""}</span>${inline(m[2])}</li>`);
    }
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (list !== "ul") { closeList(); out.push('<ul class="md-ul">'); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== "ol") { closeList(); out.push('<ol class="md-ol">'); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (/^\s*---+\s*$/.test(line)) { closeList(); out.push("<hr>"); }
    else if (!line.trim()) { closeList(); out.push('<div class="md-gap"></div>'); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join("");
}

// ── colors for monogram icons ──────────────────────────────────────────────
const MONO = ["#6366f1", "#0ea5e9", "#14b8a6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#3b82f6"];
export function monoColor(label) {
  let h = 0;
  for (const c of String(label || "?")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return MONO[h % MONO.length];
}
export function monogram(label) {
  const words = String(label || "?").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  const s = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2);
  return s.toUpperCase();
}

// ── QR codes + opening links on a kiosk ─────────────────────────────────────
export function qrSvg(text, { margin = 2 } = {}) {
  const Q = window.qrcode;
  if (!Q) return null;
  if (Q.stringToBytesFuncs?.["UTF-8"]) Q.stringToBytes = Q.stringToBytesFuncs["UTF-8"];
  const qr = Q(0, "M");
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const size = n + margin * 2;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin},${r + margin}h1v1h-1z`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.innerHTML = `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#0b0d12"/>`;
  return svg;
}

let _qrTimer = null;
export function openQrOverlay(url, title = "") {
  document.querySelector(".tb-qr-overlay")?.remove();
  clearInterval(_qrTimer);
  const ov = el("div", "tb-qr-overlay");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-label", "Scan to open");
  const card = el("div", "tb-qr-card");
  const code = qrSvg(url);
  if (code) card.appendChild(code);
  const txt = el("div", "tb-qr-text");
  txt.append(el("div", "tb-qr-title", title || "Scan to open on your phone"), el("div", "tb-qr-url", url));
  const left = el("div", "tb-qr-timer");
  txt.appendChild(left);
  card.appendChild(txt);
  ov.appendChild(card);
  let secs = 20;
  const tick = () => { left.textContent = `Tap anywhere to close · ${secs}s`; if (secs-- <= 0) close(); };
  const close = () => { clearInterval(_qrTimer); ov.remove(); };
  ov.addEventListener("click", (e) => { e.stopPropagation(); close(); });
  document.body.appendChild(ov);
  tick();
  _qrTimer = setInterval(tick, 1000);
}

// mode: same | new | qr
export function openLink(url, mode = "new", title = "") {
  if (!url) return;
  if (mode === "qr") return openQrOverlay(url, title);
  if (mode === "same") { window.location.href = url; return; }
  window.open(url, "_blank", "noopener");
}
