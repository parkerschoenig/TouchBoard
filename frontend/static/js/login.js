import { api } from "./api.js";
import { applyTheme, hexToRgba } from "./theme.js";
import { initThemeSwitcher } from "./theme-switcher.js";

initThemeSwitcher();

fetch("/api/settings").then(r => r.json()).then(s => {
  applyTheme({ palette: s.theme_palette, style: s.theme_style, font: s.theme_font });

  // Sync board background with login page background
  if (s.board_bg_color) {
    document.documentElement.style.setProperty("--login-board-bg", s.board_bg_color);
  }

  // Apply card styling to the login card so it matches the board's cards
  const card = document.querySelector(".login-card");
  if (card) {
    const bgColor   = s.card_bg_color   || "#13111a";
    const bgOpacity = s.card_bg_opacity  != null ? parseFloat(s.card_bg_opacity) : 1;
    const bgRgba    = hexToRgba(bgColor, bgOpacity);
    let   bgValue   = bgRgba;
    if (s.card_gradient === "true") {
      const bg2Rgba = hexToRgba(s.card_bg2_color || "#1a1628", s.card_bg2_opacity != null ? parseFloat(s.card_bg2_opacity) : 1);
      bgValue = `linear-gradient(${s.card_gradient_dir || 135}deg, ${bgRgba}, ${bg2Rgba})`;
    }
    const strokeRgba  = hexToRgba(s.card_stroke_color || "#2d2640", s.card_stroke_opacity != null ? parseFloat(s.card_stroke_opacity) : 1);
    const strokeWidth = s.card_stroke_width || 1;
    const accentRgba  = hexToRgba(s.card_accent_color || "#818cf8", s.card_accent_opacity != null ? parseFloat(s.card_accent_opacity) : 1);
    const accentWidth = s.card_accent_width || 3;
    let glowValue = "none";
    if (s.card_glow === "true") {
      const glowRgba = hexToRgba(s.card_glow_color || "#818cf8", s.card_glow_opacity != null ? parseFloat(s.card_glow_opacity) : 0.15);
      glowValue = `0 0 ${s.card_glow_size || 16}px ${glowRgba}`;
    }
    card.style.background   = bgValue;
    card.style.border       = `${strokeWidth}px solid ${strokeRgba}`;
    card.style.borderLeft   = `${accentWidth}px solid ${accentRgba}`;
    card.style.boxShadow    = glowValue;
  }
}).catch(() => {});

const form  = document.getElementById("login-form");
const errEl = document.getElementById("login-error");
const btn   = form.querySelector("button[type=submit]");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Signing in…";

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  try {
    await api.login(username, password);
    window.location.href = "/";
  } catch (err) {
    const msg = err.message || "";
    errEl.textContent = msg.includes("401") ? "Invalid username or password." : "Login failed. Try again.";
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});
