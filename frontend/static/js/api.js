// Thin REST client for the TouchBoard API.
async function req(method, path, body) {
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
