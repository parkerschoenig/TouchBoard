// Command palette (Ctrl/Cmd+K). Commands: {title, group, hint, keywords, run}.
// Type to filter (fuzzy, in order), arrows to move, Enter to run, Esc to close.

function score(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase(), t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) return 1000 - idx - (t.length - q.length) * 0.1 + (idx === 0 || t[idx - 1] === " " ? 200 : 0);
  let ti = 0, s = 0, run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    run = found === ti ? run + 1 : 0;
    s += 1 + run * 2;
    ti = found + 1;
  }
  return s;
}

let openDlg = null;

export function openPalette(getCommands, { placeholder = "Type a command or a widget name…", initial = "" } = {}) {
  if (openDlg) { openDlg.querySelector("input").focus(); return; }
  const dlg = document.createElement("dialog");
  dlg.className = "ed-cmdk";
  dlg.innerHTML = `<div class="ed-cmdk-box">
      <input class="ed-cmdk-input" type="text" autocomplete="off" spellcheck="false" aria-label="Command">
      <div class="ed-cmdk-list" role="listbox"></div>
      <div class="ed-cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div>
    </div>`;
  document.body.appendChild(dlg);
  openDlg = dlg;
  const input = dlg.querySelector("input");
  const list = dlg.querySelector(".ed-cmdk-list");
  input.placeholder = placeholder;
  input.value = initial;
  const commands = getCommands();
  let shown = [], active = 0;

  function render() {
    const q = input.value.trim();
    shown = commands
      .map((c) => ({ c, s: score(q, `${c.title} ${c.group || ""} ${c.keywords || ""}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.c);
    if (!q) shown.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.innerHTML = "";
    if (!shown.length) {
      list.appendChild(Object.assign(document.createElement("div"), { className: "ed-cmdk-empty", textContent: "No matching commands" }));
      return;
    }
    let lastGroup = null;
    shown.forEach((c, i) => {
      if (!q && c.group !== lastGroup) {
        list.appendChild(Object.assign(document.createElement("div"), { className: "ed-cmdk-group", textContent: c.group || "" }));
        lastGroup = c.group;
      }
      const row = document.createElement("div");
      row.className = "ed-cmdk-row" + (i === active ? " active" : "");
      row.setAttribute("role", "option");
      const t = Object.assign(document.createElement("span"), { className: "ed-cmdk-title", textContent: c.title });
      row.appendChild(t);
      if (c.hint) row.appendChild(Object.assign(document.createElement("span"), { className: "ed-cmdk-hint", textContent: c.hint }));
      row.addEventListener("mousemove", () => { if (active !== i) { active = i; paint(); } });
      row.addEventListener("click", () => run(i));
      list.appendChild(row);
    });
  }
  function paint() {
    list.querySelectorAll(".ed-cmdk-row").forEach((r, i) => r.classList.toggle("active", i === active));
    list.querySelector(".ed-cmdk-row.active")?.scrollIntoView({ block: "nearest" });
  }
  function close() { dlg.close(); dlg.remove(); openDlg = null; }
  function run(i) {
    const c = shown[i];
    if (!c) return;
    close();
    Promise.resolve().then(() => c.run());
  }
  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); run(active); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  render();
  dlg.showModal();
  input.focus();
}

export function isPaletteOpen() { return !!openDlg; }
