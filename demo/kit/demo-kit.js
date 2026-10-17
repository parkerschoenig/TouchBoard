/*! demo-kit v1 — shared runtime for the static live demos on portfolio.pshl.app.
 * Master copy: portfolio/demo-kit/demo-kit.js. Each app repo vendors a copy in demo/kit/.
 *
 * Loaded synchronously as the first script in <head>, before any app code:
 *   - DemoKit.rng(seed)                 deterministic PRNG (mulberry32) + helpers
 *   - DemoKit.dates                     local-time helpers relative to "today"
 *   - DemoKit.session / loadState()     sessionStorage-backed state: survives in-app
 *                                       navigation, resets on a browser reload
 *   - DemoKit.router() / installFetch() in-browser API: same-origin /api/* only
 *   - DemoKit.ribbon({...})             the "Live demo" pill linking back to the portfolio
 *                                       (opts: slug, position, prodUrl, prodLabel,
 *                                       compactWhenEmbedded)
 *   - DemoKit.toast(), download()       small UI helpers
 */
(function (g) {
  'use strict';

  var PORTFOLIO = 'https://portfolio.pshl.app';
  var NS = 'demo:';

  // ── PRNG ────────────────────────────────────────────────────────────────────
  function seedFrom(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }

  function rng(seed) {
    var a = typeof seed === 'number' ? seed >>> 0 : seedFrom(String(seed));
    function next() {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    var r = {
      next: next,
      int: function (min, max) { return Math.floor(next() * (max - min + 1)) + min; },
      float: function (min, max) { return next() * (max - min) + min; },
      chance: function (p) { return next() < p; },
      pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
      weighted: function (pairs) {
        var total = 0, i;
        for (i = 0; i < pairs.length; i++) total += pairs[i][1];
        var x = next() * total;
        for (i = 0; i < pairs.length; i++) { x -= pairs[i][1]; if (x <= 0) return pairs[i][0]; }
        return pairs[pairs.length - 1][0];
      },
      normal: function (mean, sd) {
        var u = 1 - next(), v = next();
        return (mean || 0) + (sd == null ? 1 : sd) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      },
      shuffle: function (arr) {
        for (var i = arr.length - 1; i > 0; i--) {
          var j = Math.floor(next() * (i + 1)), tmp = arr[i];
          arr[i] = arr[j]; arr[j] = tmp;
        }
        return arr;
      },
      sample: function (arr, n) { return r.shuffle(arr.slice()).slice(0, n); },
      id: function (len) {
        var s = '', abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
        for (var i = 0; i < (len || 10); i++) s += abc[Math.floor(next() * abc.length)];
        return s;
      },
      uuid: function () {
        var h = '0123456789abcdef', s = '';
        for (var i = 0; i < 32; i++) s += h[Math.floor(next() * 16)];
        return s.slice(0, 8) + '-' + s.slice(8, 12) + '-4' + s.slice(13, 16) + '-a' + s.slice(17, 20) + '-' + s.slice(20);
      },
    };
    return r;
  }

  // ── Dates (always local time) ───────────────────────────────────────────────
  function pad(n) { return String(n).padStart(2, '0'); }
  var dates = {
    startOfToday: function () { var d = new Date(); d.setHours(0, 0, 0, 0); return d; },
    daysFrom: function (n, h, m) {
      var d = dates.startOfToday();
      d.setDate(d.getDate() + n);
      d.setHours(h == null ? 9 : h, m || 0, 0, 0);
      return d;
    },
    iso: function (n, h, m) { return dates.daysFrom(n, h, m).toISOString(); },
    isoDayLocal: function (n) {
      var d = dates.daysFrom(n, 12);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    },
  };

  // ── Session state ───────────────────────────────────────────────────────────
  var session = {
    get: function (key, fallback) {
      try { var v = sessionStorage.getItem(NS + key); return v == null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { sessionStorage.setItem(NS + key, JSON.stringify(value)); return true; }
      catch (e) { return false; }
    },
    remove: function (key) { try { sessionStorage.removeItem(NS + key); } catch (e) {} },
  };

  function navigationType() {
    try { var n = performance.getEntriesByType('navigation')[0]; return n ? n.type : 'navigate'; }
    catch (e) { return 'navigate'; }
  }

  // A browser reload resets the demo, unless the app itself asked to reload
  // (e.g. switching layouts) via reloadKeepingState().
  var carried = session.get('carry', false);
  session.remove('carry');
  var freshStart = navigationType() === 'reload' && !carried;

  /** App state for `key`: restored from this tab's session, or built by fresh(). */
  var resetKeys = {};
  function loadState(key, fresh) {
    if (freshStart && !resetKeys[key]) {
      resetKeys[key] = true;
      session.remove('state:' + key);
    }
    var saved = session.get('state:' + key, null);
    if (saved) return saved;
    var state = fresh();
    session.set('state:' + key, state);
    return state;
  }

  var saveTimers = {};
  /** Persist state for in-app navigation (debounced). */
  function saveState(key, state) {
    clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(function () { session.set('state:' + key, state); }, 80);
  }
  function flushState(key, state) {
    clearTimeout(saveTimers[key]);
    session.set('state:' + key, state);
  }

  function reloadKeepingState() {
    Object.keys(saveTimers).forEach(function (k) { clearTimeout(saveTimers[k]); });
    if (kit.beforeCarry) kit.beforeCarry();
    session.set('carry', true);
    location.reload();
  }

  function resetDemo() {
    try {
      Object.keys(sessionStorage).forEach(function (k) {
        if (k.indexOf(NS + 'state:') === 0) sessionStorage.removeItem(k);
      });
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(NS) === 0) localStorage.removeItem(k);
      });
    } catch (e) {}
    location.reload();
  }

  // ── Embedding (?embed=1 from the portfolio's iframe) ────────────────────────
  var params = new URLSearchParams(location.search);
  if (params.has('embed')) session.set('embed', true);
  var embedded = session.get('embed', false) || g.self !== g.top;

  // ── In-browser API ──────────────────────────────────────────────────────────
  function json(body, status, headers) {
    var h = { 'Content-Type': 'application/json' };
    for (var k in headers || {}) h[k] = headers[k];
    return new Response(body === undefined ? null : JSON.stringify(body), { status: status || 200, headers: h });
  }
  function text(body, status, type) {
    return new Response(body, { status: status || 200, headers: { 'Content-Type': type || 'text/plain' } });
  }

  function compile(pattern) {
    var keys = [];
    var re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\/:(\w+)/g, function (_, k) {
      keys.push(k);
      return '/([^/]+)';
    }).replace(/\*$/, '(.*)');
    return { re: new RegExp('^' + re + '/?$'), keys: keys };
  }

  function router() {
    var routes = [];
    var api = {
      on: function (method, pattern, handler) {
        var c = compile(pattern);
        routes.push({ method: method.toUpperCase(), re: c.re, keys: c.keys, handler: handler });
        return api;
      },
      handle: async function (ctx) {
        for (var i = 0; i < routes.length; i++) {
          var r = routes[i];
          if (r.method !== ctx.method && r.method !== 'ANY') continue;
          var m = ctx.path.match(r.re);
          if (!m) continue;
          ctx.params = {};
          r.keys.forEach(function (k, j) { ctx.params[k] = decodeURIComponent(m[j + 1]); });
          return r.handler(ctx);
        }
        return null;
      },
    };
    ['get', 'post', 'put', 'patch', 'delete'].forEach(function (m) {
      api[m] = function (p, h) { return api.on(m, p, h); };
    });
    return api;
  }

  var nativeFetch = g.fetch.bind(g);
  var latency = params.get('latency') === '0' ? [0, 0] : [60, 240];

  async function readBody(req) {
    var type = req.headers.get('content-type') || '';
    if (type.indexOf('multipart/form-data') !== -1) return req.formData();
    var raw = await req.text();
    if (!raw) return null;
    if (type.indexOf('application/x-www-form-urlencoded') !== -1) return Object.fromEntries(new URLSearchParams(raw));
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  /** Route same-origin requests under `prefix` to `api` instead of the network. */
  function installFetch(api, options) {
    options = options || {};
    var prefixes = [].concat(options.prefix || '/api/');
    g.fetch = async function (input, init) {
      var req = new Request(input, init);
      var url = new URL(req.url, location.href);
      var mine = url.origin === location.origin && prefixes.some(function (p) { return url.pathname.indexOf(p) === 0; });
      if (!mine) return nativeFetch(input, init);
      var ctx = {
        req: req,
        url: url,
        path: url.pathname,
        method: req.method.toUpperCase(),
        query: Object.fromEntries(url.searchParams),
        searchParams: url.searchParams,
        body: req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req),
      };
      var wait = latency[0] + Math.random() * (latency[1] - latency[0]);
      if (wait) await new Promise(function (r) { setTimeout(r, wait); });
      try {
        var res = await api.handle(ctx);
        if (res) return res;
        console.warn('[demo] no mock for', ctx.method, ctx.path);
        return json({ error: 'Not available in the demo.' }, 404);
      } catch (err) {
        console.error('[demo] handler failed', ctx.method, ctx.path, err);
        return json({ error: (err && err.message) || 'Demo error' }, (err && err.status) || 500);
      }
    };
  }

  // ── UI helpers ──────────────────────────────────────────────────────────────
  function download(data, filename, type) {
    var blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: type || 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  var STYLE = [
    ':host{all:initial;position:fixed;z-index:2147483000;font:500 12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#edebe6}',
    ':host([position="bottom-left"]){left:14px;bottom:14px}',
    ':host([position="bottom-right"]){right:14px;bottom:14px}',
    ':host([position="top-right"]){right:14px;top:14px}',
    ':host([position="top-center"]){left:50%;top:10px;transform:translateX(-50%)}',
    '.pill{display:flex;align-items:center;gap:10px;padding:7px 8px 7px 12px;background:rgba(10,10,11,.88);border:1px solid #2e2e35;border-radius:999px;box-shadow:0 10px 30px rgba(0,0,0,.35);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#d4ff00;box-shadow:0 0 10px #d4ff00;flex:none}',
    '.label b{font-weight:700;letter-spacing:.02em;text-transform:uppercase;font-size:11px}',
    '.label span{color:#a5a5ab}',
    'a,button{all:unset;cursor:pointer;padding:5px 10px;border-radius:999px;border:1px solid #2e2e35;font-size:11px;white-space:nowrap}',
    'a:hover,button:hover{border-color:#d4ff00;color:#d4ff00}',
    'a:focus-visible,button:focus-visible{outline:2px solid #d4ff00;outline-offset:2px}',
    '.min{padding:5px 8px;border-color:transparent;color:#a5a5ab}',
    '.toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);padding:10px 16px;background:#141416;border:1px solid #2e2e35;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.4);font-size:12.5px;max-width:min(520px,90vw);opacity:0;transition:opacity .25s}',
    '.toast.on{opacity:1}',
    ':host([collapsed]) .hide{display:none}',
    '@media(max-width:640px){.label span,.reset{display:none}}',
  ].join('');

  var ribbonEl = null;
  function ribbon(opts) {
    opts = opts || {};
    if (ribbonEl) return ribbonEl;
    var host = document.createElement('demo-ribbon');
    host.setAttribute('position', opts.position || 'bottom-left');
    var root = host.attachShadow({ mode: 'open' });
    var back = PORTFOLIO + '/work/' + (opts.slug || '') + '/';
    root.innerHTML =
      '<style>' + STYLE + '</style>' +
      '<div class="pill" role="region" aria-label="Demo controls">' +
      '<span class="dot" aria-hidden="true"></span>' +
      '<span class="label"><b>Live demo</b><span class="hide"> · changes reset on reload</span></span>' +
      '<button class="reset hide" type="button" title="Start over with fresh sample data">Reset</button>' +
      '<a class="hide" href="' + back + '" target="_top">← Portfolio</a>' +
      (opts.prodUrl ? '<a class="hide" href="' + opts.prodUrl + '" target="_blank" rel="noopener">' + (opts.prodLabel || new URL(opts.prodUrl).host + ' ↗') + '</a>' : '') +
      '<button class="min" type="button" aria-label="Collapse demo controls">–</button>' +
      '</div><div class="toast" role="status" aria-live="polite"></div>';
    root.querySelector('.reset').addEventListener('click', resetDemo);
    var min = root.querySelector('.min');
    function setCollapsed(on) {
      host.toggleAttribute('collapsed', on);
      min.textContent = on ? '+' : '–';
      min.setAttribute('aria-label', on ? 'Expand demo controls' : 'Collapse demo controls');
      session.set('ribbon:collapsed', on);
    }
    min.addEventListener('click', function () { setCollapsed(!host.hasAttribute('collapsed')); });
    setCollapsed(session.get('ribbon:collapsed', embedded && !!opts.compactWhenEmbedded));
    var mount = function () { document.body.appendChild(host); };
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
    ribbonEl = host;
    return host;
  }

  var toastTimer;
  function toast(message) {
    var host = ribbonEl || ribbon({});
    var el = host.shadowRoot.querySelector('.toast');
    el.textContent = message;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 3200);
  }

  var kit = {
    version: 1,
    portfolio: PORTFOLIO,
    embedded: embedded,
    params: params,
    freshStart: freshStart,
    rng: rng,
    dates: dates,
    session: session,
    loadState: loadState,
    saveState: saveState,
    flushState: flushState,
    reloadKeepingState: reloadKeepingState,
    resetDemo: resetDemo,
    json: json,
    text: text,
    router: router,
    installFetch: installFetch,
    nativeFetch: nativeFetch,
    download: download,
    ribbon: ribbon,
    toast: toast,
    beforeCarry: null,
  };
  g.DemoKit = kit;
})(window);
