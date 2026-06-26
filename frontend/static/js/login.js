import { api } from "./api.js";
import { applyTheme } from "./theme.js";

fetch("/api/settings").then(r => r.json()).then(s => {
  applyTheme({ palette: s.theme_palette, style: s.theme_style, font: s.theme_font });
  if (s.board_bg_color) {
    document.documentElement.style.setProperty("--login-board-bg", s.board_bg_color);
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
