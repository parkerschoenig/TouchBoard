// Editor theme + editing preferences, remembered per device (localStorage).
//
// Themes restyle the editor chrome only; the board preview always shows the
// display theme chosen in the Designer.
//   studio   quiet graphite, dense, hairline borders (default)
//   daylight light chrome for daytime editing
//   console  keyboard-first, monospace, amber
//   cockpit  touch-first: large targets, dock and bottom sheets
//
// Editing modes (all on by default):
//   inspector   right-hand inspector panel (off = floating popovers on cards)
//   drawToPlace drag across empty grid to place a widget

const KEY = "tb_editor_prefs";

export const APP_THEMES = [
  { key: "studio",   label: "Studio",   blurb: "Quiet graphite chrome; the board is the brightest thing on screen." },
  { key: "daylight", label: "Daylight", blurb: "Light chrome for daytime editing." },
  { key: "console",  label: "Console",  blurb: "Keyboard-first and monospace, with an amber accent." },
  { key: "cockpit",  label: "Cockpit",  blurb: "Touch-first: big buttons, a dock and bottom sheets." },
];

const FONT_URLS = {
  studio: "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap",
  daylight: "https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&display=swap",
  console: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap",
  cockpit: "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap",
};

function defaults() {
  const touchOnly = typeof matchMedia === "function" && matchMedia("(pointer: coarse) and (hover: none)").matches;
  return { theme: touchOnly ? "cockpit" : "studio", inspector: true, drawToPlace: true };
}

export function getPrefs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { /* private mode */ }
  const p = { ...defaults(), ...saved };
  if (!APP_THEMES.some((t) => t.key === p.theme)) p.theme = "studio";
  return p;
}

export function setPref(key, value) {
  const p = { ...getPrefs(), [key]: value };
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
  if (key === "theme") applyAppTheme(value);
  document.dispatchEvent(new CustomEvent("tb:prefs", { detail: p }));
  return p;
}

export function applyAppTheme(key = getPrefs().theme) {
  document.documentElement.dataset.appTheme = key;
  const url = FONT_URLS[key];
  if (url) {
    let link = document.getElementById("tb-app-font");
    if (!link) {
      link = Object.assign(document.createElement("link"), { rel: "stylesheet", id: "tb-app-font" });
      document.head.appendChild(link);
    }
    if (link.href !== url) link.href = url;
  }
  return key;
}

applyAppTheme();
