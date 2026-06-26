// ── Experimental full-app theme switcher (TEST) ──────────────────────────────
// Lets you preview complete app redesigns without touching saved settings.
// Activate via ?theme=bridge|aurora|graphite, the floating picker (bottom-right),
// or localStorage. Pass nothing / "default" to fall back to the normal look.
//
// This is intentionally self-contained so it's trivial to remove later:
//   1. delete this file
//   2. drop the 3 import lines (layout-editor.js, display.js, login.js)
//   3. delete the "EXPERIMENTAL THEMES" block at the bottom of app.css

const STORAGE_KEY = "tb_test_theme";

export const TEST_THEMES = [
  { key: "default",  label: "Default",  dot: "#3b82f6", font: null,
    fontUrl: null },
  { key: "bridge",   label: "Bridge",   dot: "#7c5cff",
    font: "Space Grotesk",
    fontUrl: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" },
  { key: "aurora",   label: "Aurora",   dot: "#2dd4bf",
    font: "Sora",
    fontUrl: "https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&display=swap" },
  { key: "graphite", label: "Graphite", dot: "#f5a524",
    font: "IBM Plex Sans",
    fontUrl: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" },
];

function loadFont(theme) {
  if (!theme || !theme.fontUrl) return;
  let link = document.getElementById("tb-theme-font");
  if (!link) {
    link = Object.assign(document.createElement("link"), { rel: "stylesheet", id: "tb-theme-font" });
    document.head.appendChild(link);
  }
  if (link.href !== theme.fontUrl) link.href = theme.fontUrl;
}

export function applyTestTheme(key, persist = true) {
  const theme = TEST_THEMES.find(t => t.key === key) || TEST_THEMES[0];
  if (theme.key === "default") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme.key;
    loadFont(theme);
  }

  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, theme.key); } catch (_) {}
  }
  document.querySelectorAll(".tb-theme-pick").forEach(b =>
    b.classList.toggle("active", b.dataset.key === theme.key));
  return theme.key;
}

function initialTheme() {
  return "bridge";
}

function buildPicker(active) {
  if (document.getElementById("tb-theme-switcher")) return;
  const wrap = document.createElement("div");
  wrap.id = "tb-theme-switcher";
  wrap.className = "tb-theme-switcher";

  const label = Object.assign(document.createElement("span"), {
    className: "tb-theme-switcher-label", textContent: "Preview theme",
  });
  wrap.appendChild(label);

  const pills = document.createElement("div");
  pills.className = "tb-theme-pills";
  for (const t of TEST_THEMES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tb-theme-pick" + (t.key === active ? " active" : "");
    btn.dataset.key = t.key;
    const dot = Object.assign(document.createElement("span"), { className: "tb-theme-pick-dot" });
    dot.style.background = t.dot;
    btn.append(dot, document.createTextNode(t.label));
    btn.addEventListener("click", () => applyTestTheme(t.key));
    pills.appendChild(btn);
  }
  wrap.appendChild(pills);

  const collapse = Object.assign(document.createElement("button"), {
    type: "button", className: "tb-theme-switcher-toggle", title: "Hide theme preview", textContent: "✕",
  });
  collapse.addEventListener("click", () => wrap.classList.toggle("collapsed"));
  wrap.appendChild(collapse);

  document.body.appendChild(wrap);
}

export function initThemeSwitcher({ showPicker = false } = {}) {
  const active = applyTestTheme(initialTheme(), false);
  if (showPicker) {
    if (document.body) buildPicker(active);
    else document.addEventListener("DOMContentLoaded", () => buildPicker(active), { once: true });
  }
}
