export const PALETTES = [
  { key: "default",   label: "Default",   bg: "#0e1116", accent: "#3b82f6" },
  { key: "carbon",    label: "Carbon",    bg: "#0a0a0a", accent: "#f59e0b" },
  { key: "nord",      label: "Nord",      bg: "#2e3440", accent: "#88c0d0" },
  { key: "obsidian",  label: "Obsidian",  bg: "#13111a", accent: "#818cf8" },
  { key: "solarized", label: "Solarized", bg: "#002b36", accent: "#b58900" },
  { key: "light",     label: "Light",     bg: "#f8fafc", accent: "#3b82f6" },
  { key: "forest",    label: "Forest",    bg: "#0d1f17", accent: "#34d399" },
];

export const STYLES = [
  { key: "classic",  label: "Classic"  },
  { key: "glass",    label: "Glass"    },
  { key: "sharp",    label: "Sharp"    },
  { key: "soft",     label: "Soft"     },
  { key: "aurora",   label: "Aurora"   },
  { key: "bento",    label: "Bento"    },
  { key: "hud",      label: "HUD"      },
  { key: "signal",   label: "Signal"   },
  { key: "phosphor", label: "Phosphor" },
  { key: "paper",    label: "Paper"    },
];

// Styles that draw their own card surface, gauges and type. The Designer's
// card color controls don't apply to them.
export const OWNING_STYLES = new Set(["aurora", "bento", "hud", "signal", "phosphor", "paper"]);
// Styles with light cards: widget text switches to dark ink.
export const LIGHT_STYLES = new Set(["signal", "paper"]);

// Card shapes and surface patterns mix with any display theme.
// "theme" / "none" leave the theme's own choice in place.
export const SHAPES = [
  { key: "theme",    label: "Theme default", blurb: "Whatever the display theme uses" },
  { key: "soft",     label: "Soft",     blurb: "12 px rounded corners" },
  { key: "bento",    label: "Bento",    blurb: "Large 26 px corners, like phone widgets" },
  { key: "chamfer",  label: "Chamfer",  blurb: "Cut corners, like instrument panels" },
  { key: "tab",      label: "Tab",      blurb: "A folder tab along the top" },
  { key: "ticket",   label: "Ticket",   blurb: "Notches in both sides" },
  { key: "brackets", label: "Brackets", blurb: "Corner marks only, no box" },
  { key: "offset",   label: "Offset",   blurb: "Square with a hard shadow" },
  { key: "capsule",  label: "Capsule",  blurb: "Very round corners; a full pill on small cards" },
];
export const PATTERNS = [
  { key: "none",      label: "None" },
  { key: "dots",      label: "Dot grid" },
  { key: "blueprint", label: "Blueprint" },
  { key: "hatch",     label: "Hatch" },
  { key: "grain",     label: "Grain" },
  { key: "contour",   label: "Contour" },
  { key: "weave",     label: "Weave" },
  { key: "scanlines", label: "Scanlines" },
  { key: "mesh",      label: "Mesh gradient" },
];

// Complete display themes: a style, a color preset, a font and a board
// background applied together (card shape and pattern reset to the theme's own).
export const DISPLAY_THEMES = [
  { key: "classic", label: "Classic", style: "classic", preset: "default", font: "inter", board_bg_color: "#060912",
    blurb: "The original look: solid cards with a colored left edge." },
  { key: "aurora", label: "Aurora Glass", style: "aurora", preset: "aurora", font: "manrope", board_bg_color: "#070a16",
    blurb: "Frosted cards over a slow-moving gradient, thin numerals and gradient rings." },
  { key: "bento", label: "Bento", style: "bento", preset: "default", font: "manrope", board_bg_color: "#0b0c0f",
    blurb: "Soft, tinted tiles like phone widgets, with heavy numerals and pill bars." },
  { key: "hud", label: "HUD", style: "hud", preset: "default", font: "rajdhani", board_bg_color: "#030b14",
    blurb: "Chamfered panels on a blueprint grid, segmented gauges, cyan on navy." },
  { key: "signal", label: "Signal", style: "signal", preset: "default", font: "archivo", board_bg_color: "#dfe2e6",
    blurb: "White cards, black rules and hard shadows, with huge condensed numerals." },
  { key: "phosphor", label: "Phosphor", style: "phosphor", preset: "default", font: "ibm-plex-mono", board_bg_color: "#020503",
    blurb: "A green CRT terminal: monospace, block bars, scanlines." },
  { key: "paper", label: "Paper", style: "paper", preset: "default", font: "schibsted-grotesk", board_bg_color: "#e6e6e1",
    blurb: "Type and hairlines on e-paper gray, serif numerals, red only for failures." },
  { key: "obsidian", label: "Obsidian", style: "soft", preset: "obsidian", font: "inter", board_bg_color: "#0b0910",
    blurb: "Rounded, deep indigo cards with a soft glow." },
  { key: "carbon", label: "Carbon", style: "sharp", preset: "carbon", font: "rajdhani", board_bg_color: "#050505",
    blurb: "Square black cards with an amber edge." },
  { key: "nord", label: "Nord", style: "classic", preset: "nord", font: "ibm-plex-sans", board_bg_color: "#242933",
    blurb: "Muted arctic blues." },
  { key: "light", label: "Light", style: "soft", preset: "light", font: "inter", board_bg_color: "#e2e8f0",
    blurb: "Light cards for bright rooms." },
];

export const THEME_PRESETS = [
  {
    key: "default", label: "Default", accent: "#3b82f6",
    card_bg_color: "#171c24", card_bg_opacity: 1,
    card_gradient: "false", card_bg2_color: "#0e1116", card_bg2_opacity: 0, card_gradient_dir: 180,
    card_stroke_color: "#2b3a50", card_stroke_opacity: 1, card_stroke_width: 1,
    card_accent_color: "#3b82f6", card_accent_opacity: 1, card_accent_width: 3,
    card_glow: "false", card_glow_color: "#3b82f6", card_glow_opacity: 0.3, card_glow_size: 12,
  },
  {
    key: "carbon", label: "Carbon", accent: "#f59e0b",
    card_bg_color: "#0c0c0c", card_bg_opacity: 1,
    card_gradient: "false", card_bg2_color: "#1a1a1a", card_bg2_opacity: 0, card_gradient_dir: 180,
    card_stroke_color: "#2a2a2a", card_stroke_opacity: 1, card_stroke_width: 1,
    card_accent_color: "#f59e0b", card_accent_opacity: 1, card_accent_width: 3,
    card_glow: "false", card_glow_color: "#f59e0b", card_glow_opacity: 0.25, card_glow_size: 10,
  },
  {
    key: "nord", label: "Nord", accent: "#88c0d0",
    card_bg_color: "#2e3440", card_bg_opacity: 1,
    card_gradient: "false", card_bg2_color: "#3b4252", card_bg2_opacity: 0, card_gradient_dir: 180,
    card_stroke_color: "#434c5e", card_stroke_opacity: 1, card_stroke_width: 1,
    card_accent_color: "#88c0d0", card_accent_opacity: 1, card_accent_width: 3,
    card_glow: "false", card_glow_color: "#88c0d0", card_glow_opacity: 0.2, card_glow_size: 8,
  },
  {
    key: "obsidian", label: "Obsidian", accent: "#818cf8",
    card_bg_color: "#13111a", card_bg_opacity: 1,
    card_gradient: "true", card_bg2_color: "#1a1628", card_bg2_opacity: 1, card_gradient_dir: 135,
    card_stroke_color: "#2d2640", card_stroke_opacity: 1, card_stroke_width: 1,
    card_accent_color: "#818cf8", card_accent_opacity: 1, card_accent_width: 3,
    card_glow: "true", card_glow_color: "#818cf8", card_glow_opacity: 0.15, card_glow_size: 16,
  },
  {
    key: "solarized", label: "Solarized", accent: "#b58900",
    card_bg_color: "#002b36", card_bg_opacity: 1,
    card_gradient: "false", card_bg2_color: "#003847", card_bg2_opacity: 0, card_gradient_dir: 180,
    card_stroke_color: "#073642", card_stroke_opacity: 1, card_stroke_width: 1,
    card_accent_color: "#b58900", card_accent_opacity: 1, card_accent_width: 3,
    card_glow: "false", card_glow_color: "#b58900", card_glow_opacity: 0.2, card_glow_size: 8,
  },
  {
    key: "light", label: "Light", accent: "#3b82f6",
    card_bg_color: "#f8fafc", card_bg_opacity: 1,
    card_gradient: "false", card_bg2_color: "#f1f5f9", card_bg2_opacity: 0, card_gradient_dir: 180,
    card_stroke_color: "#e2e8f0", card_stroke_opacity: 1, card_stroke_width: 1,
    card_accent_color: "#3b82f6", card_accent_opacity: 1, card_accent_width: 3,
    card_glow: "false", card_glow_color: "#3b82f6", card_glow_opacity: 0.15, card_glow_size: 8,
  },
  {
    key: "aurora", label: "Aurora", accent: "#5eead4",
    card_bg_color: "#ffffff", card_bg_opacity: 0.08,
    card_gradient: "false", card_bg2_color: "#ffffff", card_bg2_opacity: 0, card_gradient_dir: 160,
    card_stroke_color: "#ffffff", card_stroke_opacity: 0.18, card_stroke_width: 1,
    card_accent_color: "#5eead4", card_accent_opacity: 0, card_accent_width: 0,
    card_glow: "false", card_glow_color: "#a78bfa", card_glow_opacity: 0.2, card_glow_size: 16,
  },
  {
    key: "forest", label: "Forest", accent: "#34d399",
    card_bg_color: "#0d1f17", card_bg_opacity: 1,
    card_gradient: "true", card_bg2_color: "#0a1a12", card_bg2_opacity: 1, card_gradient_dir: 180,
    card_stroke_color: "#1a3a28", card_stroke_opacity: 1, card_stroke_width: 1,
    card_accent_color: "#34d399", card_accent_opacity: 1, card_accent_width: 3,
    card_glow: "true", card_glow_color: "#34d399", card_glow_opacity: 0.15, card_glow_size: 10,
  },
];

export const FONTS = [
  { key: "inter",          label: "Inter",          family: "Inter" },
  { key: "outfit",         label: "Outfit",         family: "Outfit" },
  { key: "space-grotesk",  label: "Space Grotesk",  family: "Space Grotesk" },
  { key: "rajdhani",       label: "Rajdhani",       family: "Rajdhani" },
  { key: "orbitron",       label: "Orbitron",       family: "Orbitron" },
  { key: "jetbrains-mono", label: "JetBrains Mono", family: "JetBrains Mono" },
  { key: "sora",           label: "Sora",           family: "Sora" },
  { key: "ibm-plex-sans",  label: "IBM Plex Sans",  family: "IBM Plex Sans" },
  { key: "manrope",        label: "Manrope",        family: "Manrope" },
  { key: "archivo",        label: "Archivo",        family: "Archivo" },
  { key: "ibm-plex-mono",  label: "IBM Plex Mono",  family: "IBM Plex Mono" },
  { key: "schibsted-grotesk", label: "Schibsted Grotesk", family: "Schibsted Grotesk" },
];

const FONT_URLS = {
  "inter":          "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
  "outfit":         "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap",
  "space-grotesk":  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap",
  "rajdhani":       "https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&display=swap",
  "orbitron":       "https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700;800&display=swap",
  "jetbrains-mono": "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap",
  "sora":           "https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&display=swap",
  "ibm-plex-sans":  "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap",
  "manrope":        "https://fonts.googleapis.com/css2?family=Manrope:wght@200..800&display=swap",
  "archivo":        "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&display=swap",
  "ibm-plex-mono":  "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap",
  "schibsted-grotesk": "https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400..800&display=swap",
  "instrument-serif": "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap",
};

// Extra faces a style uses for numerals or headers, whatever the body font.
const STYLE_FONTS = {
  aurora: ["manrope"], bento: ["manrope"], hud: ["rajdhani"], signal: ["archivo"],
  phosphor: ["ibm-plex-mono"], paper: ["instrument-serif", "schibsted-grotesk"],
};

export function loadFont(key) {
  const url = FONT_URLS[key];
  if (!url || document.getElementById(`tb-font-${key}`)) return;
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", id: `tb-font-${key}`, href: url });
  document.head.appendChild(link);
}

// Shared SVG paint servers that themes reference from CSS: a gradient for
// Aurora's rings, hatching for Signal and dithering for Paper ring tracks.
function ensureGradientDefs() {
  if (document.getElementById("tb-grad-defs")) return;
  const holder = document.createElement("div");
  holder.id = "tb-grad-defs";
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  holder.innerHTML = `<svg width="0" height="0"><defs>
    <linearGradient id="tb-grad-aurora" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#a78bfa"/>
    </linearGradient>
    <pattern id="tb-hatch" width="1.6" height="1.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="1.6" height="1.6" fill="#ffffff"/><rect width="0.55" height="1.6" fill="#111111"/>
    </pattern>
    <pattern id="tb-dither" width="1" height="1" patternUnits="userSpaceOnUse">
      <rect width="1" height="1" fill="#e6e6e1"/><circle cx="0.5" cy="0.5" r="0.28" fill="#1b1b1b"/>
    </pattern></defs></svg>`;
  (document.body || document.documentElement).appendChild(holder);
}

// scope: pass #preview-viewport in the editor so themes only affect the preview area.
//        pass null/omit for the display page so themes affect the whole page.
export function applyTheme({ palette = "default", style = "classic", font = "inter", shape = "theme", pattern = "none" } = {}, scope = null) {
  const target = scope || document.documentElement;
  target.dataset.palette = palette;
  target.dataset.style   = style;
  target.dataset.font    = font;
  target.dataset.shape   = shape || "theme";
  target.dataset.pattern = pattern || "none";
  target.dataset.ink     = LIGHT_STYLES.has(style) ? "dark" : "";
  if (document.body) ensureGradientDefs();
  else document.addEventListener("DOMContentLoaded", ensureGradientDefs, { once: true });
  loadFont(font);
  for (const f of STYLE_FONTS[style] || []) loadFont(f);
}

export function hexToRgba(hex, alpha = 1) {
  if (!hex || !hex.startsWith('#') || hex.length < 7) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${parseFloat(alpha).toFixed(2)})`;
}

export function applyCardStyle(settings = {}, scope = null) {
  const s = settings;
  // Complete themes (Aurora, Bento, HUD, …) draw their own card surface in CSS.
  const ownsSurface = OWNING_STYLES.has(s.theme_style);

  const bgColor   = s.card_bg_color   || '#171c24';
  const bgOpacity = s.card_bg_opacity  != null ? parseFloat(s.card_bg_opacity) : 1;
  const bgRgba    = hexToRgba(bgColor, bgOpacity);
  let   bgValue   = bgRgba;
  if (s.card_gradient === 'true') {
    const bg2Rgba = hexToRgba(s.card_bg2_color || '#0e1116', s.card_bg2_opacity != null ? parseFloat(s.card_bg2_opacity) : 0);
    bgValue = `linear-gradient(${s.card_gradient_dir || 180}deg, ${bgRgba}, ${bg2Rgba})`;
  }

  const strokeRgba  = hexToRgba(s.card_stroke_color || '#2b3a50', s.card_stroke_opacity != null ? parseFloat(s.card_stroke_opacity) : 1);
  const strokeWidth = s.card_stroke_width || 1;
  const accentRgba  = hexToRgba(s.card_accent_color || '#3b82f6', s.card_accent_opacity != null ? parseFloat(s.card_accent_opacity) : 1);
  const accentWidth = s.card_accent_width || 3;

  let glowValue = 'none';
  if (s.card_glow === 'true') {
    const glowRgba = hexToRgba(s.card_glow_color || '#3b82f6', s.card_glow_opacity != null ? parseFloat(s.card_glow_opacity) : 0.3);
    glowValue = `0 0 ${s.card_glow_size || 12}px ${glowRgba}`;
  }

  // Inject a <style> block with !important + high-specificity selector so the
  // designer values beat any !important rules from the style variants (glass, neon, etc.).
  // ID selectors (0,1,0,0) beat attribute selectors (0,0,1,0) in specificity.
  let prefix, tagId;
  if (!scope || scope === document.documentElement) {
    // Display page: body.display has specificity (0,0,1,1) which beats [data-style="x"] (0,0,1,0)
    prefix = 'body.display';
    tagId  = 'tb-card-style-display';
  } else {
    prefix = `#${scope.id}`;
    tagId  = `tb-card-style-${scope.id}`;
  }

  let el = document.getElementById(tagId);
  if (!el) {
    el = document.createElement('style');
    el.id = tagId;
    document.head.appendChild(el);
  }
  el.textContent = ownsSurface ? "" : `
    ${prefix} .layout-stack-card,
    ${prefix} .stack-cell {
      background: ${bgValue} !important;
      border: ${strokeWidth}px solid ${strokeRgba} !important;
      box-shadow: ${glowValue} !important;
    }
    ${prefix} .layout-stack-card,
    ${prefix} .stack-cell {
      border-left: ${accentWidth}px solid ${accentRgba} !important;
    }
  `;
}
