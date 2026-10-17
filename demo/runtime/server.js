/* TouchBoard demo — backend/api/routes.py, db.py and poller.py in the browser.
 *
 * State is shared between the editor and display tabs through localStorage and
 * a BroadcastChannel, so editing in one tab updates the display in another, just
 * like the real SSE stream. A browser reload of the editor starts fresh. */
(function (g) {
  'use strict';
  var K = g.DemoKit;
  var SEED_VERSION = 1;
  var LS_STATE = 'demo:touchboard:state';
  var LS_ROLE = 'demo:touchboard:signed-in';
  var tab = Math.random().toString(36).slice(2);
  var channel = 'BroadcastChannel' in g ? new BroadcastChannel('touchboard-demo') : null;

  var read = function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  var write = function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  var clone = function (v) { return JSON.parse(JSON.stringify(v)); };
  var nowIso = function () { return new Date().toISOString(); };

  function start(page) {
    var state = read(LS_STATE);
    if (!state || state.v !== SEED_VERSION || (page === 'editor' && K.freshStart)) {
      state = g.TouchBoardDemoSeed.build();
      state.v = SEED_VERSION;
      state.secrets = {};
      write(LS_STATE, state);
    }

    // ── SSE: subscribers, cache, poller ──────────────────────────────────────
    var subscribers = new Set();
    var cache = {};
    var lastRun = {};

    function publish(env, local) {
      subscribers.forEach(function (s) { s._send(env); });
      if (!local && channel && env.type && !('data' in env && env.widget_id)) channel.postMessage({ from: tab, event: env });
    }
    function commit(events) {
      write(LS_STATE, state);
      (events || []).forEach(function (e) { publish(e); });
      if (channel && !(events || []).length) channel.postMessage({ from: tab, event: null });
    }
    if (channel) {
      channel.onmessage = function (m) {
        if (!m.data || m.data.from === tab) return;
        var fresh = read(LS_STATE);
        if (fresh) Object.keys(state).forEach(function (k) { delete state[k]; }), Object.assign(state, fresh);
        if (m.data.event) publish(m.data.event, true);
        else publish({ type: 'active_profile_changed', profile_id: activeId() }, true);
      };
    }

    function FakeEventSource(url) {
      this.url = url;
      this.withCredentials = false;
      this.readyState = 0;
      this.onopen = this.onmessage = this.onerror = null;
      this._listeners = {};
      var self = this;
      subscribers.add(this);
      setTimeout(function () {
        if (self.readyState === 2) return;
        self.readyState = 1;
        self._emit('open', new Event('open'));
        Object.keys(cache).forEach(function (id) { self._send(cache[id]); });
      }, 0);
    }
    FakeEventSource.CONNECTING = 0; FakeEventSource.OPEN = 1; FakeEventSource.CLOSED = 2;
    FakeEventSource.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); };
    FakeEventSource.prototype.removeEventListener = function (t, fn) { this._listeners[t] = (this._listeners[t] || []).filter(function (f) { return f !== fn; }); };
    FakeEventSource.prototype.close = function () { this.readyState = 2; subscribers.delete(this); };
    FakeEventSource.prototype._emit = function (t, ev) {
      var self = this;
      if (typeof this['on' + t] === 'function') this['on' + t].call(this, ev);
      (this._listeners[t] || []).forEach(function (fn) { fn.call(self, ev); });
    };
    FakeEventSource.prototype._send = function (env) {
      if (this.readyState !== 1) return;
      this._emit('message', new MessageEvent('message', { data: JSON.stringify(env) }));
    };

    var NativeEventSource = g.EventSource;
    g.EventSource = function (url, opts) {
      var u = new URL(url, location.href);
      if (u.origin === location.origin && u.pathname === '/api/stream') return new FakeEventSource(u.href);
      return new NativeEventSource(url, opts);
    };
    g.EventSource.CONNECTING = 0; g.EventSource.OPEN = 1; g.EventSource.CLOSED = 2;

    async function poll(w) {
      lastRun[w.id] = Date.now();
      var data = await g.TouchBoardDemoData.generate(w, { pingTargets: state.pingTargets });
      var env = { widget_id: w.id, type: w.type, data: data, ts: Date.now() / 1000 };
      cache[w.id] = env;
      publish(env, true);
      return env;
    }
    setInterval(function () {
      if (document.hidden) return;
      var live = {};
      state.widgets.forEach(function (w) {
        live[w.id] = true;
        var interval = Math.max(2, w.refresh_interval_sec || 0) * 1000;
        if (!(w.id in lastRun) || Date.now() - lastRun[w.id] >= interval) poll(w);
      });
      Object.keys(cache).forEach(function (id) { if (!live[id]) { delete cache[id]; delete lastRun[id]; } });
    }, 1000);

    // ── helpers mirroring db.py ──────────────────────────────────────────────
    var notFound = function (what) { return K.json({ detail: what + ' not found' }, 404); };
    var noContent = function () { return new Response(null, { status: 204 }); };
    var signedIn = function () { return !!read(LS_ROLE); };
    var unauth = function () { return K.json({ detail: 'not authenticated' }, 401); };
    var activeId = function () { var p = state.profiles.find(function (x) { return x.is_active; }) || state.profiles[0]; return p.id; };
    var pid = function (ctx) { return ctx.query.profile_id != null ? Number(ctx.query.profile_id) : activeId(); };
    var strip = function (o) { var c = clone(o); delete c.profile_id; return c; };
    var byId = function (list, id) { return list.find(function (x) { return x.id === Number(id); }); };
    var profileOut = function (p, withPages) {
      var o = { id: p.id, name: p.name, columns: p.columns, disp_w: p.disp_w, disp_h: p.disp_h, is_active: !!p.is_active, created_at: p.created_at };
      if (withPages) o.pages = clone(p.pages && p.pages.length ? p.pages : [{ id: 1, name: 'Page 1', layout: [] }]);
      return o;
    };
    var widgetsOf = function (id) { return state.widgets.filter(function (w) { return w.profile_id === id; }).map(strip); };
    var stacksOf = function (id) { return state.stacks.filter(function (s) { return s.profile_id === id; }).map(strip); };
    var user = function () { return clone(state.users[0]); };
    var auth = function (fn) { return function (ctx) { return signedIn() ? fn(ctx) : unauth(); }; };

    function cloneProfile(name, fromId) {
      var src = byId(state.profiles, fromId);
      if (!src) { var e = new Error('source profile not found'); e.status = 400; throw e; }
      var id = ++state.seq.profile;
      var wmap = {}, smap = {};
      state.widgets.filter(function (w) { return w.profile_id === src.id; }).forEach(function (w) {
        var c = clone(w); c.id = ++state.seq.widget; c.profile_id = id; c.created_at = nowIso();
        wmap[w.id] = c.id; state.widgets.push(c);
      });
      state.stacks.filter(function (s) { return s.profile_id === src.id; }).forEach(function (s) {
        var c = clone(s); c.id = ++state.seq.stack; c.profile_id = id; c.created_at = nowIso();
        c.widget_ids = s.widget_ids.filter(function (x) { return x in wmap; }).map(function (x) { return wmap[x]; });
        smap[s.id] = c.id; state.stacks.push(c);
      });
      var pages = clone(src.pages || []);
      pages.forEach(function (pg) { (pg.layout || []).forEach(function (n) { if (n.stack_id in smap) n.stack_id = smap[n.stack_id]; }); });
      var p = { id: id, name: name, columns: src.columns, disp_w: src.disp_w, disp_h: src.disp_h, is_active: false, created_at: nowIso(), pages: pages };
      state.profiles.push(p);
      return p;
    }

    function dumpConfig(profileId) {
      var p = byId(state.profiles, profileId);
      return {
        board: { columns: p.columns, layout: JSON.stringify(p.pages), disp_w: p.disp_w, disp_h: p.disp_h },
        data_sources: state.dataSources.map(function (d) {
          return { id: d.id, type: d.type, name: d.name, base_url: d.base_url, created_at: d.created_at, credentials: state.secrets[d.id] || demoCreds(d.type) };
        }),
        widgets: state.widgets.filter(function (w) { return w.profile_id === profileId; }).map(function (w) {
          return { id: w.id, type: w.type, title: w.title, config: JSON.stringify(w.config), data_source_id: w.data_source_id, refresh_interval_sec: w.refresh_interval_sec, created_at: w.created_at };
        }),
        stacks: state.stacks.filter(function (s) { return s.profile_id === profileId; }).map(function (s) {
          return { id: s.id, name: s.name, widget_ids: JSON.stringify(s.widget_ids), cycle_mode: s.cycle_mode, created_at: s.created_at };
        }),
        ping_targets: state.pingTargets.map(function (t) { return { id: t.id, label: t.label, address: t.address, grp: t.group, created_at: t.created_at }; }),
        settings: Object.keys(state.settings).map(function (k) { return { key: k, value: state.settings[k] }; }),
      };
    }

    function restoreConfig(snap, profileId) {
      var p = byId(state.profiles, profileId);
      state.widgets = state.widgets.filter(function (w) { return w.profile_id !== profileId; });
      state.stacks = state.stacks.filter(function (s) { return s.profile_id !== profileId; });
      if (snap.board) {
        p.columns = snap.board.columns;
        p.pages = JSON.parse(snap.board.layout || '[]');
        p.disp_w = snap.board.disp_w || 1920;
        p.disp_h = snap.board.disp_h || 720;
      }
      state.dataSources = (snap.data_sources || []).map(function (d) {
        state.secrets[d.id] = d.credentials || {};
        return { id: d.id, type: d.type, name: d.name, base_url: d.base_url, has_secret: !!(d.credentials && Object.keys(d.credentials).length), created_at: d.created_at };
      });
      (snap.widgets || []).forEach(function (w) {
        state.widgets.push({ id: w.id, type: w.type, title: w.title, config: JSON.parse(w.config || '{}'), data_source_id: w.data_source_id, refresh_interval_sec: w.refresh_interval_sec, created_at: w.created_at, profile_id: profileId });
      });
      (snap.stacks || []).forEach(function (s) {
        state.stacks.push({ id: s.id, name: s.name, widget_ids: JSON.parse(s.widget_ids || '[]'), cycle_mode: s.cycle_mode, created_at: s.created_at, profile_id: profileId });
      });
      state.pingTargets = (snap.ping_targets || []).map(function (t) { return { id: t.id, label: t.label, address: t.address, group: t.grp || '', created_at: t.created_at }; });
      (snap.settings || []).forEach(function (s) { state.settings[s.key] = s.value; });
      var max = function (list) { return list.reduce(function (m, x) { return Math.max(m, x.id); }, 0); };
      state.seq.widget = Math.max(state.seq.widget, max(state.widgets));
      state.seq.stack = Math.max(state.seq.stack, max(state.stacks));
      state.seq.ds = Math.max(state.seq.ds, max(state.dataSources));
      state.seq.ping = Math.max(state.seq.ping, max(state.pingTargets));
    }

    function demoCreds(type) {
      return {
        proxmox: { username: 'touchboard', realm: 'pve', token_id: 'dashboard', api_key: 'demo-not-a-real-key' },
        truenas: { username: 'touchboard', password: 'demo-not-a-real-password' },
        netbox: { token: 'demo-not-a-real-token' },
        adguard: { username: 'touchboard', password: 'demo-not-a-real-password' },
        opnsense: { api_key: 'demo-key', api_secret: 'demo-not-a-real-secret' },
        google_calendar: { ical_urls: 'https://calendar.google.com/calendar/ical/demo/private-0000/basic.ics' },
      }[type] || {};
    }

    // ── routes ───────────────────────────────────────────────────────────────
    var api = K.router();

    api.post('/api/auth/login', function () { write(LS_ROLE, true); return K.json(user()); });
    api.post('/api/auth/logout', function () { try { localStorage.removeItem(LS_ROLE); } catch (e) {} return noContent(); });
    api.get('/api/auth/me', auth(function () { return K.json(user()); }));
    api.post('/api/auth/change-password', auth(function (ctx) {
      var b = ctx.body || {};
      if (!b.new_password || b.new_password.length < 8) return K.json({ detail: 'new password must be at least 8 characters' }, 400);
      K.toast('Demo: password change simulated.');
      return K.json(user());
    }));

    api.get('/api/settings', function () { return K.json(clone(state.settings)); });
    api.patch('/api/settings', auth(function (ctx) {
      Object.keys(ctx.body || {}).forEach(function (k) { if (ctx.body[k] != null) state.settings[k] = String(ctx.body[k]); });
      commit([{ type: 'settings_update', data: clone(state.settings) }]);
      return K.json(clone(state.settings));
    }));
    api.get('/api/update-check', function () { return K.json({ checked_at: null, update_available: false, sha: null, url: null, label: null }); });

    api.get('/api/users', auth(function () { return K.json(clone(state.users)); }));
    api.post('/api/users', auth(function (ctx) {
      var b = ctx.body || {};
      if (state.users.some(function (u) { return u.username === b.username; })) return K.json({ detail: 'username already taken' }, 409);
      var u = { id: ++state.seq.user, username: b.username, is_default_password: false, created_at: nowIso() };
      state.users.push(u); commit();
      return K.json(u, 201);
    }));
    api.put('/api/users/:id', auth(function (ctx) {
      var u = byId(state.users, ctx.params.id); if (!u) return notFound('user');
      var b = ctx.body || {};
      if (b.username != null) {
        if (state.users.some(function (x) { return x.username === b.username && x.id !== u.id; })) return K.json({ detail: 'username already taken' }, 409);
        u.username = b.username;
      }
      if (b.password != null && b.password.length < 8) return K.json({ detail: 'password must be at least 8 characters' }, 400);
      commit();
      return K.json(clone(u));
    }));
    api.delete('/api/users/:id', auth(function (ctx) {
      if (Number(ctx.params.id) === state.users[0].id) return K.json({ detail: 'cannot delete your own account' }, 400);
      var i = state.users.findIndex(function (u) { return u.id === Number(ctx.params.id); });
      if (i === -1) return notFound('user');
      state.users.splice(i, 1); commit();
      return noContent();
    }));

    api.get('/api/widgets', auth(function (ctx) { return K.json(widgetsOf(pid(ctx))); }));
    api.post('/api/widgets', auth(function (ctx) {
      var b = ctx.body || {};
      var w = { id: ++state.seq.widget, type: b.type, title: b.title, config: b.config || {}, data_source_id: b.data_source_id == null ? null : b.data_source_id,
        refresh_interval_sec: b.refresh_interval_sec == null ? 30 : b.refresh_interval_sec, created_at: nowIso(), profile_id: pid(ctx) };
      state.widgets.push(w); commit();
      poll(w);
      return K.json(strip(w), 201);
    }));
    api.get('/api/widgets/:id/data', async function (ctx) {
      var w = byId(state.widgets, ctx.params.id); if (!w) return notFound('widget');
      return K.json(cache[w.id] || await poll(w));
    });
    api.get('/api/widgets/:id', auth(function (ctx) { var w = byId(state.widgets, ctx.params.id); return w ? K.json(strip(w)) : notFound('widget'); }));
    api.put('/api/widgets/:id', auth(function (ctx) {
      var w = byId(state.widgets, ctx.params.id); if (!w) return notFound('widget');
      var b = ctx.body || {};
      ['type', 'title', 'config', 'data_source_id', 'refresh_interval_sec'].forEach(function (k) { if (k in b && b[k] != null) w[k] = b[k]; });
      delete lastRun[w.id];
      commit([{ type: 'widget_update', widget_id: w.id }]);
      poll(w);
      return K.json(strip(w));
    }));
    api.delete('/api/widgets/:id', auth(function (ctx) {
      var w = byId(state.widgets, ctx.params.id); if (!w) return notFound('widget');
      state.widgets = state.widgets.filter(function (x) { return x !== w; });
      state.stacks.forEach(function (s) { if (s.profile_id === w.profile_id) s.widget_ids = s.widget_ids.filter(function (i) { return i !== w.id; }); });
      commit();
      return noContent();
    }));

    api.get('/api/stacks', auth(function (ctx) { return K.json(stacksOf(pid(ctx))); }));
    api.post('/api/stacks', auth(function (ctx) {
      var b = ctx.body || {};
      var s = { id: ++state.seq.stack, name: b.name, widget_ids: b.widget_ids || [], cycle_mode: b.cycle_mode || 'tap', created_at: nowIso(), profile_id: pid(ctx) };
      state.stacks.push(s); commit();
      return K.json(strip(s), 201);
    }));
    api.put('/api/stacks/:id', auth(function (ctx) {
      var s = byId(state.stacks, ctx.params.id); if (!s) return notFound('stack');
      var b = ctx.body || {};
      ['name', 'widget_ids', 'cycle_mode'].forEach(function (k) { if (k in b && b[k] != null) s[k] = b[k]; });
      commit();
      return K.json(strip(s));
    }));
    api.delete('/api/stacks/:id', auth(function (ctx) {
      var s = byId(state.stacks, ctx.params.id); if (!s) return notFound('stack');
      state.stacks = state.stacks.filter(function (x) { return x !== s; });
      var p = byId(state.profiles, s.profile_id);
      if (p) (p.pages || []).forEach(function (pg) { pg.layout = (pg.layout || []).filter(function (n) { return n.stack_id !== s.id; }); });
      commit();
      return noContent();
    }));

    api.get('/api/board', function (ctx) { var p = byId(state.profiles, pid(ctx)); return p ? K.json(profileOut(p, true)) : K.json(null); });
    api.put('/api/board', auth(function (ctx) {
      var p = byId(state.profiles, pid(ctx)); if (!p) return notFound('profile');
      var b = ctx.body || {};
      if (b.columns != null) p.columns = b.columns;
      if (b.pages != null) p.pages = b.pages;
      commit();
      return K.json(profileOut(p, true));
    }));
    api.get('/api/board/full', function (ctx) {
      var id = pid(ctx), p = byId(state.profiles, id);
      return K.json({ board: p ? profileOut(p, true) : null, stacks: stacksOf(id), widgets: widgetsOf(id) });
    });

    api.get('/api/profiles', auth(function () { return K.json(state.profiles.map(function (p) { return profileOut(p, false); })); }));
    api.get('/api/profiles/active', function () { return K.json({ profile_id: activeId() }); });
    api.post('/api/profiles', auth(function (ctx) {
      var b = ctx.body || {};
      var p;
      if (b.clone_from != null) p = cloneProfile(b.name, b.clone_from);
      else {
        p = { id: ++state.seq.profile, name: b.name, columns: 6, disp_w: 1920, disp_h: 720, is_active: false, created_at: nowIso(), pages: [] };
        state.profiles.push(p);
      }
      commit();
      return K.json(profileOut(p, true), 201);
    }));
    api.post('/api/profiles/:id/duplicate', auth(function (ctx) {
      var p = cloneProfile((ctx.body || {}).name, Number(ctx.params.id));
      commit();
      return K.json(profileOut(p, true), 201);
    }));
    api.patch('/api/profiles/:id', auth(function (ctx) {
      var p = byId(state.profiles, ctx.params.id); if (!p) return notFound('profile');
      var b = ctx.body || {};
      if (b.name != null) p.name = b.name;
      ['columns', 'pages', 'disp_w', 'disp_h'].forEach(function (k) { if (b[k] != null) p[k] = b[k]; });
      commit(p.is_active ? [{ type: 'active_profile_changed', profile_id: p.id }] : []);
      return K.json(profileOut(p, true));
    }));
    api.delete('/api/profiles/:id', auth(function (ctx) {
      if (state.profiles.length <= 1) return K.json({ detail: 'cannot delete the last remaining profile' }, 400);
      var p = byId(state.profiles, ctx.params.id); if (!p) return notFound('profile');
      if (p.is_active) return K.json({ detail: 'cannot delete the active profile — switch to another profile first' }, 400);
      state.profiles = state.profiles.filter(function (x) { return x !== p; });
      commit();
      return noContent();
    }));
    api.post('/api/profiles/:id/activate', auth(function (ctx) {
      var p = byId(state.profiles, ctx.params.id); if (!p) return notFound('profile');
      state.profiles.forEach(function (x) { x.is_active = x === p; });
      commit([{ type: 'active_profile_changed', profile_id: p.id }]);
      return K.json(profileOut(p, true));
    }));

    api.get('/api/datasources', auth(function () { return K.json(clone(state.dataSources)); }));
    api.post('/api/datasources', auth(function (ctx) {
      var b = ctx.body || {};
      var d = { id: ++state.seq.ds, type: b.type, name: b.name, base_url: b.base_url, has_secret: !!(b.credentials && Object.keys(b.credentials).length), created_at: nowIso() };
      state.dataSources.push(d);
      if (d.has_secret) state.secrets[d.id] = b.credentials;
      commit();
      return K.json(clone(d), 201);
    }));
    api.patch('/api/datasources/:id', auth(function (ctx) {
      var d = byId(state.dataSources, ctx.params.id); if (!d) return notFound('data source');
      var b = ctx.body || {};
      if (b.name != null) d.name = b.name;
      if (b.base_url != null) d.base_url = b.base_url;
      if (b.credentials && Object.keys(b.credentials).length) { state.secrets[d.id] = b.credentials; d.has_secret = true; }
      state.widgets.forEach(function (w) { if (w.data_source_id === d.id) delete lastRun[w.id]; });
      commit();
      return K.json(clone(d));
    }));
    api.delete('/api/datasources/:id', auth(function (ctx) {
      var i = state.dataSources.findIndex(function (d) { return d.id === Number(ctx.params.id); });
      if (i === -1) return notFound('data source');
      state.dataSources.splice(i, 1); commit();
      return noContent();
    }));
    api.get('/api/datasources/:id/credentials', auth(function (ctx) {
      var d = byId(state.dataSources, ctx.params.id); if (!d) return notFound('data source');
      return K.json(clone(state.secrets[d.id] || demoCreds(d.type)));
    }));

    api.post('/api/backup/export', auth(async function (ctx) {
      try { return K.json(await g.TouchBoardDemoFernet.exportEnvelope(dumpConfig(activeId()), (ctx.body || {}).passphrase)); }
      catch (e) { return K.json({ detail: e.message }, 400); }
    }));
    api.post('/api/backup/import', auth(async function (ctx) {
      var b = ctx.body || {};
      try { restoreConfig(await g.TouchBoardDemoFernet.importEnvelope(b.backup, b.passphrase), activeId()); }
      catch (e) { return K.json({ detail: e.message }, 400); }
      Object.keys(cache).forEach(function (k) { delete cache[k]; });
      Object.keys(lastRun).forEach(function (k) { delete lastRun[k]; });
      commit([{ type: 'config_restored' }]);
      return K.json({ ok: true });
    }));

    api.get('/api/ping-targets', auth(function () { return K.json(clone(state.pingTargets)); }));
    api.post('/api/ping-targets', auth(function (ctx) {
      var b = ctx.body || {};
      var t = { id: ++state.seq.ping, label: b.label, address: b.address, group: b.group || '', created_at: nowIso() };
      state.pingTargets.push(t); commit();
      return K.json(clone(t), 201);
    }));
    api.put('/api/ping-targets/:id', auth(function (ctx) {
      var t = byId(state.pingTargets, ctx.params.id); if (!t) return K.json({ detail: 'Not Found' }, 404);
      var b = ctx.body || {};
      ['label', 'address', 'group'].forEach(function (k) { if (b[k] != null) t[k] = b[k]; });
      commit();
      return K.json(clone(t));
    }));
    api.delete('/api/ping-targets/:id', auth(function (ctx) {
      var i = state.pingTargets.findIndex(function (t) { return t.id === Number(ctx.params.id); });
      if (i === -1) return K.json({ detail: 'Not Found' }, 404);
      state.pingTargets.splice(i, 1); commit();
      return noContent();
    }));

    api.get('/api/debug/widget/:id', auth(async function (ctx) {
      var w = byId(state.widgets, ctx.params.id); if (!w) return notFound('widget');
      var data = await g.TouchBoardDemoData.generate(w, { pingTargets: state.pingTargets });
      return K.json({ widget: strip(w), data_source_id: w.data_source_id, result: data });
    }));

    K.installFetch(api);
    K.beforeCarry = function () { write(LS_STATE, state); };
    return { state: state, signedIn: signedIn, signIn: function () { write(LS_ROLE, true); } };
  }

  g.TouchBoardDemoServer = { start: start };
})(window);
