// TouchBoard demo — login page: same theming as login.js, one-click sign-in.
import { applyTheme } from "/static/js/theme.js";
import { initThemeSwitcher } from "/static/js/theme-switcher.js";

initThemeSwitcher();

fetch("/api/settings").then(r => r.json()).then(s => {
  applyTheme({ palette: s.theme_palette, style: s.theme_style, font: s.theme_font });
  if (s.board_bg_color) document.documentElement.style.setProperty("--login-board-bg", s.board_bg_color);
}).catch(() => {});

document.querySelector("[data-demo-enter]").addEventListener("click", async (e) => {
  e.currentTarget.disabled = true;
  await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "demo", password: "demo" }),
  });
  window.location.href = "/";
});
