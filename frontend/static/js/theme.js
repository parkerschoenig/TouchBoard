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
  { key: "classic", label: "Classic" },
  { key: "glass",   label: "Glass"   },
  { key: "sharp",   label: "Sharp"   },
  { key: "neon",    label: "Neon"    },
  { key: "soft",    label: "Soft"    },
  { key: "retro",   label: "Retro"   },
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
};

// scope: pass #preview-viewport in the editor so themes only affect the preview area.
//        pass null/omit for the display page so themes affect the whole page.
export function applyTheme({ palette = "default", style = "classic", font = "inter" } = {}, scope = null) {
  const target = scope || document.documentElement;
  target.dataset.palette = palette;
  target.dataset.style   = style;
  target.dataset.font    = font;
  const url = FONT_URLS[font];
  if (url) {
    let link = document.getElementById("tb-font-link");
    if (!link) {
      link = Object.assign(document.createElement("link"), { rel: "stylesheet", id: "tb-font-link" });
      document.head.appendChild(link);
    }
    if (link.href !== url) link.href = url;
  }
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
  el.textContent = `
    ${prefix} .layout-stack-card,
    ${prefix} .stack-cell {
      background: ${bgValue} !important;
      border: ${strokeWidth}px solid ${strokeRgba} !important;
      box-shadow: ${glowValue} !important;
    }
    ${prefix} .layout-stack-card {
      border-left: ${accentWidth}px solid ${accentRgba} !important;
    }
  `;
}
