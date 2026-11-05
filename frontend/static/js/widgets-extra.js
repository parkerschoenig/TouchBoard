// Renderers for the v2 widgets: bookmarks, REST/JSON, now playing, notes,
// photo frame and RSS. Each takes (widget, data, envelope) like the others in
// widgets.js and returns an element.

import {
  el, sparkline, series, fmtValue, fmtClock, timeAgo, markdownLite,
  monoColor, monogram, openLink, levelOf,
} from "./primitives.js";

// ── Bookmarks ────────────────────────────────────────────────────────────────

const _bmGroup = new Map(); // widget id → selected group index

function _bmIconSrc(widget, index, icon) {
  const v = String(icon || "auto").trim();
  if (v === "letters") return null;
  if (v === "auto" || !v) return widget.id > 0 ? `/api/widgets/${widget.id}/favicon/${index}` : null;
  if (v.startsWith("di:")) return `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/${encodeURIComponent(v.slice(3))}.png`;
  if (v.startsWith("si:")) return `https://cdn.simpleicons.org/${encodeURIComponent(v.slice(3))}`;
  if (/^https?:\/\//.test(v) || v.startsWith("/")) return v;
  return null;
}

function _bmIcon(widget, index, item) {
  const wrap = el("span", "bm-ico");
  const label = item.label || item.url || "?";
  wrap.style.setProperty("--c", item.color || monoColor(label));
  const letters = el("span", "bm-letters", monogram(label));
  wrap.appendChild(letters);
  const src = _bmIconSrc(widget, index, item.icon);
  if (src) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = src;
    img.addEventListener("load", () => wrap.classList.add("has-img"));
    img.addEventListener("error", () => img.remove());
    wrap.appendChild(img);
  }
  return wrap;
}

export function renderBookmarks(widget, data) {
  const cfg = widget.config || {};
  const layout = cfg.layout || "tiles";
  const groups = (cfg.groups || []).filter((g) => (g.items || []).length);
  const wrap = el("div", `w-bookmarks bm-${layout}`);
  if (!groups.length) { wrap.appendChild(el("div", "w-empty", "Add links in the widget settings")); return wrap; }

  // flat index per item, matching the backend's iter_items order
  let flat = 0;
  const indexed = (cfg.groups || []).map((g) => (g.items || []).map((it) => ({ it, i: flat++ })));
  const visibleGroups = (cfg.groups || []).map((g, gi) => ({ g, gi })).filter(({ g }) => (g.items || []).length);

  let sel = Math.min(_bmGroup.get(widget.id) ?? 0, visibleGroups.length - 1);
  if (visibleGroups.length > 1 && layout !== "dock") {
    const tabs = el("div", "bm-groups");
    visibleGroups.forEach(({ g }, k) => {
      const t = el("button", "bm-group tb-ctrl" + (k === sel ? " on" : ""), g.name || `Group ${k + 1}`);
      t.type = "button";
      t.addEventListener("click", (e) => {
        e.stopPropagation();
        _bmGroup.set(widget.id, k);
        wrap.replaceWith(renderBookmarks(widget, data));
      });
      tabs.appendChild(t);
    });
    wrap.appendChild(tabs);
  }

  const items = layout === "dock"
    ? visibleGroups.flatMap(({ gi }) => indexed[gi])
    : indexed[visibleGroups[sel].gi];
  const checks = data?.checks || {};
  const list = el("div", "bm-items");
  for (const { it, i } of items) {
    const st = checks[String(i)];
    const a = el("a", "bm-item" + (st ? (st.up ? " is-up" : " is-down") : ""));
    a.href = it.url || "#";
    a.dataset.interactive = "1";
    a.title = it.url || "";
    a.rel = "noopener noreferrer";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (document.body.classList.contains("layout-editor-page")) return;
      openLink(it.url, cfg.open || "new", it.label);
    });
    a.appendChild(_bmIcon(widget, i, it));
    if (layout === "list") {
      const txt = el("span", "bm-text");
      txt.append(el("span", "bm-label", it.label || it.url), el("span", "bm-host", (it.url || "").replace(/^https?:\/\//, "").replace(/\/$/, "")));
      a.appendChild(txt);
      const meta = el("span", "bm-meta");
      if (st) meta.textContent = st.up ? (st.latency_ms != null ? `${st.latency_ms} ms` : "up") : "down";
      a.appendChild(meta);
    } else if (layout !== "dock") {
      a.appendChild(el("span", "bm-label", it.label || it.url));
    }
    if (st && layout !== "list") a.appendChild(el("span", "bm-status"));
    list.appendChild(a);
  }
  wrap.appendChild(list);
  return wrap;
}

// ── Generic REST / JSON ──────────────────────────────────────────────────────

export function renderRest(widget, data, envelope) {
  const cfg = widget.config || {};
  const mode = cfg.display || "stats";
  const wrap = el("div", `w-rest rest-mode-${mode}`);
  if (!data) { wrap.appendChild(el("div", "w-empty", "Loading…")); return wrap; }
  const values = data.values || [];
  const rows = data.rows || [];

  if (mode === "gauge") {
    const g = el("div", "rest-gauges");
    for (const v of values) {
      const num = Number(v.value);
      const max = Number(v.max) || 100;
      const pct = Number.isFinite(num) ? Math.max(0, Math.min(100, (num / max) * 100)) : 0;
      const ring = el("div", `rest-ring lv-${levelOf(pct)}`);
      ring.style.setProperty("--p", pct.toFixed(1));
      const inner = el("div", "rest-ring-val");
      inner.append(el("b", "", fmtValue(v.value, v.format, v.decimals ?? 0, "")), el("small", "", v.unit || (max === 100 ? "%" : `/ ${max}`)));
      ring.appendChild(inner);
      const cell = el("div", "rest-gauge");
      cell.append(ring, el("div", "rest-label", v.label));
      g.appendChild(cell);
    }
    wrap.appendChild(g);
  } else if (values.length) {
    const grid = el("div", "rest-stats");
    grid.style.setProperty("--n", String(Math.min(values.length, 4)));
    for (const v of values) {
      const cell = el("div", "rest-stat");
      cell.append(el("div", "rest-label", v.label), el("div", "rest-value", fmtValue(v.value, v.format, v.decimals, v.unit)));
      const hist = series(envelope, `field:${v.label}`);
      if (cfg.sparklines !== false && hist.filter((x) => x != null).length > 1) cell.appendChild(sparkline(hist));
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
  }

  if (rows.length) {
    const list = el("div", "rest-list");
    for (const r of rows) {
      const row = el("div", "rest-row");
      row.append(el("span", "rest-row-label", String(r.label ?? "")), el("span", "rest-row-value", r.value == null ? "" : String(r.value)));
      list.appendChild(row);
    }
    wrap.appendChild(list);
  }
  if (!values.length && !rows.length) wrap.appendChild(el("div", "w-empty", "No fields configured"));
  return wrap;
}

// ── Now playing (Plex / Jellyfin) ────────────────────────────────────────────

const _npTimers = new Map();

function _hash(s) {
  let h = 0;
  for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

export function renderNowPlaying(widget, data, envelope) {
  const cfg = widget.config || {};
  const wrap = el("div", "w-nowplaying");
  if (!data) { wrap.appendChild(el("div", "w-empty", "Loading…")); return wrap; }
  const sessions = data.sessions || [];
  if (!sessions.length) {
    const idle = el("div", "np-idle");
    idle.append(el("div", "np-idle-icon", "▶"), el("div", "", "Nothing playing"));
    wrap.appendChild(idle);
    return wrap;
  }
  const ts = envelope?.ts || Date.now() / 1000;
  const progressEls = [];

  sessions.forEach((s, i) => {
    const row = el("div", "np-session" + (i === 0 ? " np-main" : ""));
    const art = el("div", "np-art");
    if ((s.art_url || s.art_path) && widget.id > 0) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = s.art_url || `/api/widgets/${widget.id}/art/${i}?k=${_hash(s.art_path)}`;
      img.addEventListener("error", () => img.remove());
      art.appendChild(img);
    }
    art.appendChild(el("span", "np-type", s.type === "track" ? "♪" : s.type === "episode" ? "TV" : "▶"));
    const info = el("div", "np-info");
    info.append(el("div", "np-title", s.title || "Unknown"), el("div", "np-sub", s.subtitle || ""));
    const who = [cfg.show_user !== false && s.user, cfg.show_device !== false && s.device].filter(Boolean).join(" · ");
    if (who) info.appendChild(el("div", "np-who", who));
    const bar = el("div", "np-bar");
    const fill = el("div", "np-fill");
    bar.appendChild(fill);
    const times = el("div", "np-times");
    const pos = el("span"), dur = el("span", "", fmtClock(s.duration_s));
    times.append(pos, dur);
    info.append(bar, times);
    if (s.state === "paused") row.classList.add("is-paused");
    row.append(art, info);
    wrap.appendChild(row);
    progressEls.push({ s, fill, pos });
  });

  // Advance progress smoothly between polls while playing.
  const tick = () => {
    const now = Date.now() / 1000;
    for (const { s, fill, pos } of progressEls) {
      const p = s.state === "playing" ? Math.min(s.duration_s || 0, s.position_s + (now - ts)) : s.position_s;
      fill.style.width = s.duration_s ? `${Math.min(100, (p / s.duration_s) * 100).toFixed(2)}%` : "0%";
      pos.textContent = fmtClock(p);
    }
  };
  tick();
  clearInterval(_npTimers.get(widget.id));
  _npTimers.set(widget.id, setInterval(() => { if (!wrap.isConnected) clearInterval(_npTimers.get(widget.id)); else tick(); }, 1000));
  return wrap;
}

// ── Notes ────────────────────────────────────────────────────────────────────

export function renderNotes(widget) {
  const cfg = widget.config || {};
  const wrap = el("div", "w-notes");
  if (cfg.tint) { wrap.classList.add("is-tinted"); wrap.style.setProperty("--note-tint", cfg.tint); }
  wrap.style.setProperty("--note-size", String(Number(cfg.size) || 1));
  wrap.style.textAlign = ["left", "center", "right"].includes(cfg.align) ? cfg.align : "left";
  const body = el("div", "notes-body");
  body.innerHTML = markdownLite(cfg.text || "");
  if (!(cfg.text || "").trim()) body.appendChild(el("div", "w-empty", "Write your note in the widget settings"));
  body.querySelectorAll("a").forEach((a) => {
    a.dataset.interactive = "1";
    a.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!document.body.classList.contains("layout-editor-page")) openLink(a.href, cfg.open || "qr", a.textContent);
    });
  });
  wrap.appendChild(body);
  return wrap;
}

// ── Photo frame ──────────────────────────────────────────────────────────────

const _photoState = new Map(); // widget id → { order, pos, timer, rev }

function _shuffle(n) {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function renderPhotos(widget, data) {
  const cfg = widget.config || {};
  const wrap = el("div", "w-photos fit-" + (cfg.fit === "contain" ? "contain" : "cover") + (cfg.kenburns !== false ? " kenburns" : ""));
  if (!data) { wrap.appendChild(el("div", "w-empty", "Loading photos…")); return wrap; }
  const count = data.count || 0;
  if (!count) { wrap.appendChild(el("div", "w-empty", "No photos found")); return wrap; }

  const src = (i) => data.source === "urls" ? data.urls[i] : `/api/widgets/${widget.id}/photo/${i}?r=${data.rev || ""}`;
  let st = _photoState.get(widget.id);
  const key = `${data.source}:${data.rev || (data.urls || []).join("|")}:${count}:${cfg.shuffle !== false}`;
  if (!st || st.key !== key) {
    st = { key, order: cfg.shuffle !== false ? _shuffle(count) : [...Array(count).keys()], pos: 0, timer: null };
    _photoState.set(widget.id, st);
  }
  clearInterval(st.timer);

  const layers = [el("div", "ph-layer is-on"), el("div", "ph-layer")];
  wrap.append(...layers);
  const caption = el("div", "ph-caption");
  if (cfg.caption && data.names?.length) wrap.appendChild(caption);

  let front = 0;
  const show = (layer, idx) => {
    layer.innerHTML = "";
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.src = src(idx);
    layer.appendChild(img);
    if (cfg.caption && data.names?.[idx]) caption.textContent = data.names[idx].replace(/\.[^.]+$/, "");
  };
  show(layers[0], st.order[st.pos % count]);
  if (count > 1) {
    // preload the next one
    const pre = new Image(); pre.src = src(st.order[(st.pos + 1) % count]);
    const secs = Math.max(5, Number(cfg.interval) || 20);
    st.timer = setInterval(() => {
      if (!wrap.isConnected) { clearInterval(st.timer); return; }
      st.pos = (st.pos + 1) % count;
      const back = 1 - front;
      show(layers[back], st.order[st.pos]);
      layers[back].classList.add("is-on");
      layers[front].classList.remove("is-on");
      front = back;
      const next = new Image(); next.src = src(st.order[(st.pos + 1) % count]);
    }, secs * 1000);
  }
  return wrap;
}

// ── RSS ──────────────────────────────────────────────────────────────────────

const _rssSpot = new Map();

export function renderRss(widget, data) {
  const cfg = widget.config || {};
  const mode = cfg.layout || "list";
  const wrap = el("div", `w-rss rss-${mode}`);
  if (!data) { wrap.appendChild(el("div", "w-empty", "Loading feeds…")); return wrap; }
  const items = data.items || [];
  if (!items.length) { wrap.appendChild(el("div", "w-empty", "No headlines")); return wrap; }

  const open = (it) => (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!document.body.classList.contains("layout-editor-page")) openLink(it.link, cfg.open || "qr", it.title);
  };

  if (mode === "spotlight") {
    // One big headline at a time, rotating.
    let i = (_rssSpot.get(widget.id) || 0) % items.length;
    const card = el("a", "rss-spot");
    card.dataset.interactive = "1";
    const fill = () => {
      const it = items[i];
      card.innerHTML = "";
      card.href = it.link || "#";
      card.onclick = open(it);
      if (cfg.show_images !== false && it.image) {
        const img = document.createElement("img"); img.alt = ""; img.src = it.image;
        img.addEventListener("error", () => img.remove());
        card.appendChild(img);
      }
      const t = el("div", "rss-spot-text");
      t.append(el("div", "rss-title", it.title), el("div", "rss-meta", [cfg.show_source !== false && it.source, timeAgo(it.ts)].filter(Boolean).join(" · ")));
      if (it.summary) t.appendChild(el("div", "rss-summary", it.summary));
      card.appendChild(t);
    };
    fill();
    wrap.appendChild(card);
    const secs = Math.max(5, Number(cfg.rotate_sec) || 12);
    const timer = setInterval(() => {
      if (!wrap.isConnected) { clearInterval(timer); return; }
      i = (i + 1) % items.length; _rssSpot.set(widget.id, i); fill();
    }, secs * 1000);
    return wrap;
  }

  for (const it of items) {
    const row = el("a", "rss-item");
    row.href = it.link || "#";
    row.dataset.interactive = "1";
    row.addEventListener("click", open(it));
    if (cfg.show_images && it.image) {
      const img = document.createElement("img"); img.alt = ""; img.loading = "lazy"; img.src = it.image;
      img.addEventListener("error", () => img.remove());
      row.appendChild(img);
    }
    const t = el("div", "rss-text");
    t.append(el("div", "rss-title", it.title), el("div", "rss-meta", [cfg.show_source !== false && it.source, timeAgo(it.ts)].filter(Boolean).join(" · ")));
    row.appendChild(t);
    wrap.appendChild(row);
  }
  if (data.feed_errors?.length) {
    const note = el("div", "cal-feed-error", `⚠ ${data.feed_errors.length} feed(s) failed`);
    note.title = data.feed_errors.join("\n");
    wrap.appendChild(note);
  }
  return wrap;
}

export const EXTRA_RENDERERS = {
  bookmarks: renderBookmarks,
  rest: renderRest,
  nowplaying: renderNowPlaying,
  notes: renderNotes,
  photos: renderPhotos,
  rss: renderRss,
};
