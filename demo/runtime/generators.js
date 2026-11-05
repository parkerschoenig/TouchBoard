/* TouchBoard demo — live data for each widget type, shaped exactly like the
 * backend integrations return it. Values drift as random walks so the board
 * feels alive. Weather is real (Open-Meteo, keyless) with a synthetic fallback. */
(function (g) {
  'use strict';
  var K = g.DemoKit;
  var r = K.rng(Date.now()); // live jitter: intentionally not deterministic
  var walkers = {};

  function walk(key, start, min, max, step) {
    var v = walkers[key] == null ? start : walkers[key];
    v += (r.next() - 0.5) * 2 * step + (start - v) * 0.04; // drift back toward the baseline
    v = Math.max(min, Math.min(max, v));
    walkers[key] = v;
    return Math.round(v * 10) / 10;
  }
  var GiB = 1024 * 1024 * 1024, TB = 1e12;

  // ── Proxmox ────────────────────────────────────────────────────────────────
  var GUESTS = {
    vms: [[100, 'ubuntu-docker', 'node-a', 12, 44], [101, 'pihole', 'node-b', 2, 19], [102, 'nginx-proxy', 'node-a', 5, 22],
      [103, 'dev-workstation', 'node-b', 0, 0, 'stopped'], [104, 'minecraft', 'node-a', 19, 71], [105, 'windows-lab', 'node-b', 7, 58]],
    lxcs: [[200, 'homeassistant', 'node-a', 5, 31], [201, 'monitoring', 'node-b', 8, 43], [202, 'backup-agent', 'node-a', 1, 13],
      [203, 'cloudflared', 'node-b', 1, 9], [204, 'netbox', 'node-a', 3, 37], [205, 'touchboard', 'node-b', 2, 21]],
  };
  function proxmox(w) {
    var k = 'pve' + w.id;
    var nodes = [['node-a', 38, 65, 64], ['node-b', 30, 58, 64]].map(function (n) {
      var cpu = walk(k + n[0] + 'c', n[1], 3, 96, 4);
      var memPct = walk(k + n[0] + 'm', n[2], 20, 95, 0.6);
      var total = n[3] * GiB;
      return { name: n[0], status: 'online', cpu_pct: cpu, mem_pct: memPct, mem_used: Math.round(total * memPct / 100), mem_total: total };
    });
    var guest = function (kind) {
      return function (v) {
        var running = (v[5] || 'running') === 'running';
        return {
          vmid: v[0], name: v[1], node: v[2], status: running ? 'running' : 'stopped',
          cpu_pct: running ? walk(k + v[0] + 'c', v[3], 0.2, 95, Math.max(0.6, v[3] / 5)) : 0,
          mem_pct: running ? walk(k + v[0] + 'm', v[4], 2, 98, 0.8) : 0,
        };
      };
    };
    var sort = function (a, b) { return (a.status !== 'running') - (b.status !== 'running') || a.name.localeCompare(b.name); };
    var memUsed = nodes.reduce(function (s, n) { return s + n.mem_used; }, 0);
    var memTotal = nodes.reduce(function (s, n) { return s + n.mem_total; }, 0);
    return {
      nodes: nodes,
      uptime: 14 * 86400 + Math.floor((Date.now() / 1000) % 86400),
      cluster_cpu_pct: Math.round(nodes.reduce(function (s, n) { return s + n.cpu_pct; }, 0) / nodes.length * 10) / 10,
      cluster_mem_pct: Math.round(memUsed / memTotal * 1000) / 10,
      vms: GUESTS.vms.map(guest('vm')).sort(sort),
      lxcs: GUESTS.lxcs.map(guest('lxc')).sort(sort),
      storage: [
        { storage: 'local-lvm', node: 'node-a', status: 'active', used: 214748364800, total: 500107862016 },
        { storage: 'local-lvm', node: 'node-b', status: 'active', used: 107374182400, total: 500107862016 },
        { storage: 'nas-nfs', node: 'node-a', status: 'active', used: 858993459200, total: 2000398934016 },
      ],
    };
  }

  // ── TrueNAS ────────────────────────────────────────────────────────────────
  function truenas(w) {
    var k = 'nas' + w.id;
    var memTotal = 32 * GiB;
    var memUsed = walk(k + 'm', 0.56, 0.4, 0.8, 0.01) * memTotal;
    var pools = [
      { name: 'data', status: 'ONLINE', total: 8 * TB, used: 3.8 * TB },
      { name: 'backup', status: 'ONLINE', total: 4 * TB, used: 0.9 * TB },
    ].filter(function (p) { var f = (w.config.pool_name || '').trim().toLowerCase(); return !f || p.name === f; })
      .map(function (p) { return { name: p.name, status: p.status, total: p.total, used: p.used, free: p.total - p.used }; });
    return {
      pools: pools,
      mem_total: memTotal, mem_used: Math.round(memUsed), mem_free: Math.round(memTotal - memUsed),
      mem_arc: Math.round(walk(k + 'arc', 8.6, 6, 12, 0.15) * GiB),
      cpu_pct: walk(k + 'c', 11, 1, 70, 3),
    };
  }

  // ── NetBox (static inventory) ──────────────────────────────────────────────
  function netbox(w) {
    var rackName = (w.config.rack_name || '').trim();
    return {
      total_devices: 14, total_ips: 38, total_vms: 12,
      ips: [
        ['10.0.1.1/24', 'gateway', 'Core Switch'], ['10.0.1.10/24', 'storage', 'Storage Server'], ['10.0.1.20/24', 'media-host', ''],
        ['10.0.1.21/24', 'app-server', ''], ['10.0.1.22/24', 'web-server', ''], ['10.0.1.25/24', 'indexer', ''],
        ['10.0.2.10/24', 'compute-a', 'Compute A'], ['10.0.2.11/24', 'compute-b', 'Compute B'], ['10.0.3.5/24', 'dns', 'DNS Appliance'],
      ].map(function (ip) { return { address: ip[0], status: 'active', description: '', dns_name: ip[1], vrf: '', assigned_device: ip[2] }; }),
      vms: GUESTS.vms.concat(GUESTS.lxcs).map(function (v) {
        return { name: v[1], status: (v[5] || 'running') === 'running' ? 'active' : 'offline', cluster: 'homelab', vcpus: 2, memory: 4096 };
      }),
      rack: rackName ? {
        name: rackName, site: 'Home Lab', u_height: 12,
        devices: [
          ['Storage Server', 'Storage', 1, 2], ['Core Switch', 'Network', 3, 1], ['Compute A', 'Compute', 4, 2],
          ['Compute B', 'Compute', 6, 2], ['UPS', 'Power', 8, 2], ['DNS Appliance', 'DNS', 10, 1],
        ].map(function (d) { return { name: d[0], role: d[1], position: d[2], u_height: d[3], status: 'active' }; }),
      } : { error: 'No rack name configured' },
    };
  }

  // ── AdGuard: queries accumulate through the day ────────────────────────────
  function adguard() {
    var midnight = K.dates.startOfToday().getTime();
    var minutes = (Date.now() - midnight) / 60000;
    var queries = Math.round(1800 + minutes * 41 + (walkers.agj = (walkers.agj || 0) + r.int(0, 9)));
    var pct = walk('agpct', 18.9, 15, 23, 0.08);
    return { queries_today: queries, blocked_today: Math.round(queries * pct / 100), blocked_pct: Math.round(pct * 100) / 100, domains_on_blocklist: 162547 };
  }

  // ── OPNsense ───────────────────────────────────────────────────────────────
  function opnsense(w) {
    var k = 'ops' + w.id;
    var memTotal = 4 * GiB;
    var memPct = walk(k + 'm', 28, 20, 45, 0.4);
    var wanRx = walk(k + 'wr', 120, 2, 920, 70), wanTx = walk(k + 'wt', 18, 1, 300, 9);
    return {
      version: '25.1.6', cpu_pct: walk(k + 'c', 7, 1, 60, 2.5), mem_pct: memPct,
      mem_used: Math.round(memTotal * memPct / 100), mem_total: memTotal,
      interfaces: [
        { device: 'igc0', name: 'WAN', rx_mbps: wanRx, tx_mbps: wanTx },
        { device: 'igc1', name: 'LAN', rx_mbps: walk(k + 'lr', 30, 1, 400, 12), tx_mbps: Math.round(wanRx * 0.92 * 10) / 10 },
        { device: 'vlan20', name: 'SERVERS', rx_mbps: walk(k + 'sr', 14, 0, 300, 8), tx_mbps: walk(k + 'st', 9, 0, 300, 6) },
        { device: 'vlan30', name: 'IOT', rx_mbps: walk(k + 'ir', 0.6, 0, 8, 0.3), tx_mbps: walk(k + 'it', 0.3, 0, 5, 0.2) },
      ].sort(function (a, b) { return (b.rx_mbps + b.tx_mbps) - (a.rx_mbps + a.tx_mbps); }),
    };
  }

  // ── Ping ───────────────────────────────────────────────────────────────────
  var down = {};
  function ping(w, ctx) {
    var cfg = w.config || {};
    var targets = (cfg.targets || []).slice();
    (cfg.target_ids || []).forEach(function (tid) {
      var t = ctx.pingTargets.find(function (p) { return p.id === tid; });
      if (t) targets.push({ label: t.label, address: t.address, group: t.group || '', _id: t.id });
    });
    var results = targets.map(function (t) {
      var key = 'ping:' + (t._id || t.address);
      if (down[key] > 0) down[key]--;
      else if (r.chance(0.006)) down[key] = r.int(2, 5);
      var isDown = down[key] > 0;
      var base = 2 + (String(t.address).split('.').pop() % 17);
      var out = { label: t.label || t.address, address: t.address, up: !isDown,
        latency_ms: isDown ? null : walk(key, base, 0.4, 60, 1.6), detail: isDown ? 'no ICMP reply' : 'ICMP reply' };
      if (t.group) out.group = t.group;
      return out;
    });
    return { targets: results, up_count: results.filter(function (x) { return x.up; }).length, total: results.length };
  }

  // ── Calendar: a believable week relative to today ──────────────────────────
  function calendar(w) {
    var cfg = w.config || {};
    var days = cfg.days_ahead || 31, max = cfg.max_events || 25;
    var d = K.dates;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var at = function (offset, h, m) { var x = d.daysFrom(offset, h, m); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) + 'T' + pad(h) + ':' + pad(m) + ':00'; };
    var allDay = function (offset, title) { return { title: title, all_day: true, start: d.isoDayLocal(offset), end: d.isoDayLocal(offset + 1) }; };
    var timed = function (offset, h, m, mins, title, location) {
      var e = { title: title, all_day: false, start: at(offset, h, m), end: at(offset, h + Math.floor((m + mins) / 60), (m + mins) % 60) };
      if (location) e.location = location;
      return e;
    };
    var dow = new Date().getDay();
    var events = [
      timed(0, 18, 30, 60, 'Climbing gym', 'Downtown'),
      allDay(1, 'Trash & recycling'),
      timed(1, 9, 30, 30, 'Team standup'),
      timed(2, 12, 0, 60, 'Lunch with Sam'),
      timed(3, 19, 0, 120, 'Homelab: rack cable cleanup'),
      allDay((6 - dow + 7) % 7 || 7, 'Track day'),
      timed(4, 8, 0, 60, 'Dentist appointment'),
      allDay(5, 'Internet bill due'),
      timed(6, 10, 0, 90, 'Farmers market'),
      timed(8, 17, 30, 60, 'Oil change'),
      allDay(10, 'Rent due'),
      timed(12, 20, 0, 150, 'Movie night'),
      timed(15, 9, 0, 480, 'Conference', 'Convention center'),
      allDay(20, 'Electric bill'),
      timed(24, 14, 0, 60, 'Haircut'),
    ].filter(function (e) {
      var offset = Math.round((new Date(e.start.length === 10 ? e.start + 'T12:00:00' : e.start) - d.startOfToday()) / 86400000);
      return offset >= 0 && offset <= days;
    }).sort(function (a, b) { return a.start.localeCompare(b.start) || a.title.localeCompare(b.title); });
    return { events: events.slice(0, max) };
  }

  // ── Weather: real Open-Meteo data, synthetic if offline ────────────────────
  var WMO = { 0: 'Clear Sky', 1: 'Mainly Clear', 2: 'Partly Cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Icy Fog',
    51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle', 56: 'Freezing Drizzle', 57: 'Heavy Freezing Drizzle',
    61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain', 66: 'Freezing Rain', 67: 'Heavy Freezing Rain',
    71: 'Light Snow', 73: 'Snow', 75: 'Heavy Snow', 77: 'Snow Grains', 80: 'Light Showers', 81: 'Showers', 82: 'Heavy Showers',
    85: 'Light Snow Showers', 86: 'Heavy Snow Showers', 95: 'Thunderstorm', 96: 'Thunderstorm w/ Hail', 99: 'Thunderstorm w/ Heavy Hail' };
  var label = function (c) { return WMO[c] || 'Unknown'; };
  var weatherCache = {};

  function syntheticWeather(cfg, units, days) {
    var f = units === 'fahrenheit';
    var base = f ? 64 : 18;
    var hourNow = new Date().getHours();
    var code = [0, 1, 2, 3, 61, 2][new Date().getDate() % 6];
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var hourly = [];
    for (var i = 0; i < 12; i++) {
      var dt = K.dates.daysFrom(0, hourNow, 0);
      dt.setHours(hourNow + i);
      var temp = Math.round((base + 7 * Math.sin(((dt.getHours() - 9) / 24) * 2 * Math.PI)) * 10) / 10;
      hourly.push({ time: dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + 'T' + pad(dt.getHours()) + ':00',
        temperature: temp, weathercode: code, label: label(code), precip_prob: code >= 61 ? 60 : 10, windspeed: 8 });
    }
    return {
      location: cfg.location_name || 'Somewhere', unit: units, wind_unit: f ? 'mph' : 'kmh',
      current: { temperature: hourly[0].temperature, feels_like: hourly[0].temperature - 2, humidity: 58, windspeed: 9, weathercode: code, label: label(code) },
      hourly: hourly,
      daily: Array.from({ length: days }, function (_, i) {
        var c = [code, 2, 3, 61, 0, 1, 2][i % 7];
        return { date: K.dates.isoDayLocal(i), weathercode: c, label: label(c), temp_max: base + 6 + (i % 3), temp_min: base - 7 + (i % 2), precip_prob: c >= 61 ? 70 : 10 };
      }),
    };
  }

  async function weather(w) {
    var cfg = w.config || {};
    if (cfg.latitude == null || cfg.longitude == null) return { error: 'latitude and longitude are required' };
    var units = cfg.units || 'fahrenheit';
    var days = [3, 5, 7].indexOf(Number(cfg.forecast_days)) !== -1 ? Number(cfg.forecast_days) : 3;
    var key = cfg.latitude + '_' + cfg.longitude + '_' + units + '_' + days;
    var hit = weatherCache[key];
    if (hit && Date.now() - hit.ts < 600000) return Object.assign({}, hit.data, { location: cfg.location_name || hit.data.location });
    try {
      var p = new URLSearchParams({
        latitude: cfg.latitude, longitude: cfg.longitude,
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weathercode,windspeed_10m',
        hourly: 'temperature_2m,weathercode,precipitation_probability,windspeed_10m',
        daily: 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        temperature_unit: units, windspeed_unit: units === 'fahrenheit' ? 'mph' : 'kmh',
        timezone: 'auto', forecast_days: String(days),
      });
      var res = await K.nativeFetch('https://api.open-meteo.com/v1/forecast?' + p);
      if (!res.ok) throw new Error(res.status);
      var raw = await res.json();
      var cur = raw.current || {}, daily = raw.daily || {}, hourly = raw.hourly || {};
      var hourlyOut = [];
      (hourly.time || []).forEach(function (t, i) {
        if (cur.time && t >= cur.time && hourlyOut.length < 12) {
          hourlyOut.push({ time: t, temperature: hourly.temperature_2m[i], weathercode: hourly.weathercode[i], label: label(hourly.weathercode[i]),
            precip_prob: (hourly.precipitation_probability || [])[i], windspeed: (hourly.windspeed_10m || [])[i] });
        }
      });
      var data = {
        location: cfg.location_name || cfg.latitude + ', ' + cfg.longitude, unit: units, wind_unit: units === 'fahrenheit' ? 'mph' : 'kmh',
        current: { temperature: cur.temperature_2m, feels_like: cur.apparent_temperature, humidity: cur.relative_humidity_2m,
          windspeed: cur.windspeed_10m, weathercode: cur.weathercode || 0, label: label(cur.weathercode || 0) },
        hourly: hourlyOut,
        daily: (daily.time || []).slice(0, days).map(function (date, i) {
          return { date: date, weathercode: daily.weathercode[i], label: label(daily.weathercode[i]), temp_max: daily.temperature_2m_max[i],
            temp_min: daily.temperature_2m_min[i], precip_prob: (daily.precipitation_probability_max || [])[i] };
        }),
      };
      weatherCache[key] = { ts: Date.now(), data: data };
      return data;
    } catch (e) {
      return syntheticWeather(cfg, units, days);
    }
  }

  // ── v2 widgets ─────────────────────────────────────────────────────────────
  // Images can't come from /api in the demo (only fetch() is intercepted), so
  // photos and artwork are generated SVGs passed inline as data: URLs.
  function svgUrl(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }
  var SKIES = [['#1e3c72', '#f8b195', '#2a2340'], ['#134e5e', '#71b280', '#1b2d24'], ['#2c3e50', '#fd746c', '#26203a'],
    ['#0f2027', '#2c5364', '#10181c'], ['#41295a', '#ff9a8b', '#2b1d33'], ['#355c7d', '#c06c84', '#1f2a36']];
  function landscape(i) {
    var s = SKIES[i % SKIES.length], sun = 120 + (i * 97) % 520;
    return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" preserveAspectRatio="xMidYMid slice">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + s[0] + '"/><stop offset="1" stop-color="' + s[1] + '"/></linearGradient></defs>' +
      '<rect width="800" height="500" fill="url(#g)"/><circle cx="' + sun + '" cy="150" r="70" fill="#ffe8b0" opacity=".9"/>' +
      '<path d="M0 500 L' + (180 + i * 30 % 120) + ' 250 L420 500Z" fill="' + s[2] + '"/>' +
      '<path d="M260 500 L' + (520 + i * 40 % 160) + ' 290 L800 500Z" fill="' + s[2] + '" opacity=".85"/></svg>');
  }
  function poster(title, a, b) {
    return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + a + '"/><stop offset="1" stop-color="' + b + '"/></linearGradient></defs>' +
      '<rect width="200" height="300" fill="url(#p)"/><text x="16" y="270" fill="#fff" font-family="sans-serif" font-size="22" font-weight="700">' +
      title.replace(/[<&]/g, '') + '</text></svg>');
  }

  function bookmarks(w) {
    var checks = {}, i = 0;
    ((w.config || {}).groups || []).forEach(function (g) {
      (g.items || []).forEach(function (it) {
        if (it.check && it.url) {
          var down = /down|offline/i.test(it.label || '') || (r.next() < 0.02);
          checks[String(i)] = { label: it.label || it.url, up: !down, latency_ms: down ? null : walk('bm' + w.id + i, 3, 0.4, 40, 1.5), detail: down ? 'TimeoutError' : 'TCP open' };
        }
        i++;
      });
    });
    return { count: i, checks: checks };
  }

  function rest(w) {
    var cfg = w.config || {};
    var values = (cfg.fields || []).map(function (f, k) {
      var v = /uptime|duration/i.test(f.label) ? 86400 * 9 + Math.floor(Date.now() / 1000) % 86400
        : f.format === 'bytes' ? walk('rb' + w.id + k, 4.2e11, 1e11, 9e11, 2e9)
        : walk('rv' + w.id + k, 40 + k * 17, 1, 99, 3);
      return { label: f.label || f.path || 'value', value: v, unit: f.unit || '', format: f.format || 'auto', max: f.max, decimals: f.decimals };
    });
    var rows = cfg.list && cfg.list.path ? ['api', 'worker', 'scheduler', 'queue'].map(function (n) {
      return { label: n, value: r.next() < 0.1 ? 'degraded' : 'ok' };
    }) : [];
    return { status: 200, values: values, rows: rows };
  }

  var SHOWS = [
    { title: 'Severance', subtitle: 'S02E04 · Woe’s Hollow', type: 'episode', user: 'sam', device: 'Living Room TV', d: 2880, c: ['#0f2b46', '#4f8fc0'] },
    { title: 'Dune: Part Two', subtitle: '2024', type: 'movie', user: 'alex', device: 'Projector', d: 9960, c: ['#6b3d12', '#e0a35a'] },
    { title: 'Weightless', subtitle: 'Marconi Union · Ambient', type: 'track', user: 'kitchen', device: 'Kitchen speaker', d: 480, c: ['#1d3b2f', '#7cc6a0'] },
  ];
  var showStart = Date.now();
  function nowplaying(w) {
    var t = (Date.now() - showStart) / 1000;
    var sessions = SHOWS.map(function (s, i) {
      var pos = (i * 900 + t * (i === 1 ? 0 : 1)) % s.d;
      return {
        title: s.title, subtitle: s.subtitle, type: s.type, user: s.user, device: s.device,
        state: i === 1 ? 'paused' : 'playing', duration_s: s.d, position_s: Math.round(pos), progress: pos / s.d,
        art_path: null, art_url: poster(s.title, s.c[0], s.c[1]),
      };
    });
    return { server: 'jellyfin', sessions: sessions.slice(0, Number((w.config || {}).max_sessions) || 4) };
  }

  function photos(w) {
    var urls = [];
    for (var i = 0; i < 6; i++) urls.push(landscape(i));
    var names = ['Lake at dawn', 'Pine ridge', 'Coastline', 'Night drive', 'Desert light', 'Harbor'];
    return { source: 'urls', count: urls.length, urls: urls, names: (w.config || {}).caption ? names : [] };
  }

  var HEADLINES = [
    ['Kernel 6.18 lands with faster NVMe queues', 'Linux News'], ['Proxmox VE 9.1 adds live VM snapshots over NFS', 'Homelab Weekly'],
    ['ZFS 2.4 brings RAIDZ expansion to more pools', 'Storage Digest'], ['Home Assistant ships local voice for 30 languages', 'Smart Home Today'],
    ['Why your UPS battery is lying to you', 'Homelab Weekly'], ['Self-hosted photo apps compared', 'Linux News'],
    ['OPNsense 26.1 roadmap published', 'Network Notes'], ['A 10 W ARM server that runs everything', 'Storage Digest'],
  ];
  function rss(w) {
    var now = Date.now() / 1000;
    var items = HEADLINES.map(function (h, i) {
      return { title: h[0], link: 'https://example.com/news/' + (i + 1), ts: now - (i * 47 + 12) * 60, summary: 'A short summary of the story so the spotlight layout has something to show.', image: landscape(i + 2), source: h[1] };
    });
    return { items: items.slice(0, Number((w.config || {}).max_items) || 20), feed_errors: [] };
  }

  // Home Assistant lights: a few rooms, toggled in memory by /api/widgets/:id/lights
  var LIGHTS = [
    { id: 'light.kitchen', name: 'Kitchen ceiling', area: 'Kitchen', on: true, brightness: 80, color: '#ffb46b', temp: true, kelvin: 2700 },
    { id: 'light.kitchen_pendants', name: 'Kitchen pendants', area: 'Kitchen', on: false, brightness: 60, color: '#ffc98f' },
    { id: 'light.living_lamp', name: 'Floor lamp', area: 'Living room', on: true, brightness: 50, color: '#7850ff', rgb: true, temp: true },
    { id: 'light.tv_strip', name: 'TV light strip', area: 'Living room', on: false, brightness: 70, color: '#38bdf8', rgb: true },
    { id: 'light.office_desk', name: 'Desk lamp', area: 'Office', on: true, brightness: 100, color: '#fff1d6' },
    { id: 'light.porch', name: 'Porch', area: 'Outside', on: false },
    { id: 'switch.coffee', name: 'Coffee maker', area: 'Kitchen', on: false, domain: 'switch' },
  ];
  function lightItem(l) {
    var d = l.domain || 'light';
    return { id: l.id, name: l.name, domain: d, on: l.on, available: true, brightness: l.on && l.brightness ? l.brightness : null,
      color: l.on && l.color ? l.color : null, dimmable: d === 'light', area: l.area, group: false,
      color_capable: !!l.rgb, temp_capable: !!l.temp, min_kelvin: 2000, max_kelvin: 6500, kelvin: l.on ? l.kelvin || null : null, hue: null };
  }
  function lights(w) {
    var cfg = w.config || {}, wanted = cfg.entities || [];
    var pick = wanted.length
      ? wanted.map(function (id) { return LIGHTS.find(function (l) { return l.id === id; }); }).filter(Boolean)
      : LIGHTS.filter(function (l) { return (l.domain || 'light') === 'light' || cfg.include_switches; });
    return { entities: pick.map(lightItem), missing: [] };
  }
  function lightsAct(ids, action, b) {
    b = b || {};
    LIGHTS.forEach(function (l) {
      if (ids.indexOf(l.id) < 0) return;
      l.on = action === 'toggle' ? !l.on : action === 'turn_on';
      if (!l.on) return;
      if (b.brightness != null) l.brightness = b.brightness;
      if (b.rgb) l.color = '#' + b.rgb.map(function (c) { return ('0' + Number(c).toString(16)).slice(-2); }).join('');
      if (b.kelvin != null) { l.kelvin = b.kelvin; l.color = b.kelvin < 3500 ? '#ffb46b' : b.kelvin < 5000 ? '#fff1d6' : '#dce9ff'; }
    });
  }

  var REGISTRY = {
    lights: lights,
    bookmarks: bookmarks, rest: rest, nowplaying: nowplaying, photos: photos, rss: rss,
    notes: function () { return { static: true }; },
    clock: function () { return {}; },
    stream: function (w) { var u = (w.config || {}).stream_url; return u ? { url: u } : { error: 'No stream URL configured' }; },
    proxmox: proxmox, truenas: truenas, netbox: netbox, adguard: adguard, opnsense: opnsense,
    ping: ping, calendar: calendar, weather: weather,
  };
  var NEEDS_SOURCE = { proxmox: 'Proxmox', truenas: 'TrueNAS', netbox: 'NetBox', adguard: 'AdGuard', opnsense: 'OPNsense', calendar: 'Google Calendar', lights: 'Home Assistant' };

  async function generate(widget, ctx) {
    var fn = REGISTRY[widget.type];
    if (!fn) return { error: 'unknown widget type ' + JSON.stringify(widget.type) };
    if (NEEDS_SOURCE[widget.type] && !widget.data_source_id) {
      return { error: 'No ' + NEEDS_SOURCE[widget.type] + ' data source configured. Add one in Settings → Integrations.' };
    }
    try { return await fn(widget, ctx); } catch (e) { return { error: String(e && e.message || e) }; }
  }

  g.TouchBoardDemoData = { generate: generate, lightsAct: lightsAct, lightList: function () { return LIGHTS.map(lightItem); } };
})(window);
