// Thin REST client for the TouchBoard API.
let _demoMode = false;
let _demoToastTimer = null;

export function setDemoMode(on) { _demoMode = on; }

function showDemoToast() {
  let t = document.getElementById("demo-save-toast");
  if (!t) {
    t = Object.assign(document.createElement("div"), {
      id: "demo-save-toast", className: "demo-toast",
      textContent: "Demo mode - changes aren't saved",
    });
    document.body.appendChild(t);
  }
  t.classList.add("visible");
  clearTimeout(_demoToastTimer);
  _demoToastTimer = setTimeout(() => t.classList.remove("visible"), 2500);
}

async function req(method, path, body) {
  if (_demoMode && method !== "GET" && !path.startsWith("/api/auth/login")) {
    showDemoToast();
    if (method === "DELETE") return null;
    return { id: Date.now(), ...(body || {}) };
  }

  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(path, opts);
  if (resp.status === 401 && !path.startsWith("/api/auth/")) {
    window.location.href = "/login";
    return;
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${method} ${path} → ${resp.status} ${text}`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

export const api = {
  boardFull: () => req("GET", "/api/board/full"),
  getBoard: () => req("GET", "/api/board"),
  updateBoard: (b) => req("PUT", "/api/board", b),

  listWidgets: () => req("GET", "/api/widgets"),
  createWidget: (w) => req("POST", "/api/widgets", w),
  updateWidget: (id, w) => req("PUT", `/api/widgets/${id}`, w),
  deleteWidget: (id) => req("DELETE", `/api/widgets/${id}`),
  widgetData: (id) => req("GET", `/api/widgets/${id}/data`),

  listStacks: () => req("GET", "/api/stacks"),
  createStack: (s) => req("POST", "/api/stacks", s),
  updateStack: (id, s) => req("PUT", `/api/stacks/${id}`, s),
  deleteStack: (id) => req("DELETE", `/api/stacks/${id}`),

  listDataSources: () => req("GET", "/api/datasources"),
  createDataSource: (d) => req("POST", "/api/datasources", d),
  updateDataSource: (id, d) => req("PATCH", `/api/datasources/${id}`, d),
  deleteDataSource: (id) => req("DELETE", `/api/datasources/${id}`),
  getDataSourceCredentials: (id) => req("GET", `/api/datasources/${id}/credentials`),

  exportBackup: (passphrase) => req("POST", "/api/backup/export", { passphrase }),
  importBackup: (backup, passphrase) => req("POST", "/api/backup/import", { backup, passphrase }),

  listPingTargets: () => req("GET", "/api/ping-targets"),
  createPingTarget: (t) => req("POST", "/api/ping-targets", t),
  updatePingTarget: (id, t) => req("PUT", `/api/ping-targets/${id}`, t),
  deletePingTarget: (id) => req("DELETE", `/api/ping-targets/${id}`),

  getSettings: ()  => req("GET",   "/api/settings"),
  updateSettings: (s) => req("PATCH", "/api/settings", s),

  me: () => req("GET", "/api/auth/me"),
  login: (username, password) => req("POST", "/api/auth/login", { username, password }),
  logout: () => req("POST", "/api/auth/logout"),
  changePassword: (current_password, new_password) =>
    req("POST", "/api/auth/change-password", { current_password, new_password }),

  listUsers: () => req("GET", "/api/users"),
  createUser: (u) => req("POST", "/api/users", u),
  updateUser: (id, u) => req("PUT", `/api/users/${id}`, u),
  deleteUser: (id) => req("DELETE", `/api/users/${id}`),
};
