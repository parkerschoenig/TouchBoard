// Editor chrome theme (Studio) and editing preferences, remembered per device
// (localStorage). The board preview always shows the display theme chosen in
// the Designer.
//
// Editing modes (both on by default):
//   inspector   right-hand inspector panel (off = floating popovers on cards)
//   drawToPlace drag across empty grid to place a widget

const KEY = "tb_editor_prefs";
const FONT_URL = "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap";

function defaults() {
  return { theme: "studio", inspector: true, drawToPlace: true };
}

export function getPrefs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { /* private mode */ }
  return { ...defaults(), ...saved, theme: "studio" };
}

export function setPref(key, value) {
  const p = { ...getPrefs(), [key]: value, theme: "studio" };
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
  document.dispatchEvent(new CustomEvent("tb:prefs", { detail: p }));
  return p;
}

export function applyAppTheme() {
  document.documentElement.dataset.appTheme = "studio";
  if (!document.getElementById("tb-app-font")) {
    document.head.appendChild(Object.assign(document.createElement("link"), { rel: "stylesheet", id: "tb-app-font", href: FONT_URL }));
  }
  return "studio";
}

applyAppTheme();
