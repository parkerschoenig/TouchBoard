/* TouchBoard demo — the initial board: two profiles, placeholder data sources
 * (nothing real — *.home.arpa and RFC 5737 documentation addresses). */
(function (g) {
  'use strict';

  function build() {
    var now = new Date().toISOString();
    var id = { widget: 0, stack: 0 };
    var widgets = [];
    var stacks = [];

    var dataSources = [
      ['proxmox', 'Proxmox', 'https://pve.home.arpa:8006'],
      ['truenas', 'TrueNAS', 'https://nas.home.arpa'],
      ['netbox', 'NetBox', 'https://netbox.home.arpa'],
      ['adguard', 'AdGuard Home', 'https://dns.home.arpa'],
      ['opnsense', 'OPNsense', 'https://fw.home.arpa'],
      ['google_calendar', 'Family calendar', 'https://calendar.google.com'],
    ].map(function (d, i) {
      return { id: i + 1, type: d[0], name: d[1], base_url: d[2], has_secret: true, created_at: now };
    });
    var ds = {};
    dataSources.forEach(function (d) { ds[d.type] = d.id; });

    var pingTargets = [
      ['Web Server', '192.0.2.10', 'Media'],
      ['App Server', '192.0.2.11', 'Media'],
      ['Indexer', '192.0.2.12', 'Media'],
      ['Downloader', '192.0.2.13', 'Media'],
      ['Media Server', '192.0.2.14', 'Media'],
      ['Reverse Proxy', '192.0.2.15', 'Media'],
      ['NAS Primary', '192.0.2.20', 'Storage'],
      ['NAS Backup', '192.0.2.21', 'Storage'],
      ['Gateway', '198.51.100.1', 'Network'],
    ].map(function (p, i) { return { id: i + 1, label: p[0], address: p[1], group: p[2], created_at: now }; });
    var media = [1, 2, 3, 4, 5, 6], storage = [7, 8];

    function w(profile, type, title, config, dsType, interval) {
      var widget = {
        id: ++id.widget, type: type, title: title, config: config || {},
        data_source_id: dsType ? ds[dsType] : null,
        refresh_interval_sec: interval == null ? 15 : interval,
        created_at: now, profile_id: profile,
      };
      widgets.push(widget);
      return widget.id;
    }
    function s(profile, name, widgetIds, mode) {
      var stack = { id: ++id.stack, name: name, widget_ids: widgetIds, cycle_mode: mode || 'tap', created_at: now, profile_id: profile };
      stacks.push(stack);
      return stack.id;
    }
    function node(stackId, x, y, w_, h) { return { stack_id: stackId, x: x, y: y, w: w_, h: h, item_type: 'widget' }; }

    // ── Profile 1: the 1920×720 rack screen ────────────────────────────────
    var clock = w(1, 'clock', 'Clock', { clock_mode: 'digital', clock_format: '24h', clock_style: 'full', clock_timezone: 'America/New_York' }, null, 0);
    var truenas = w(1, 'truenas', 'TrueNAS', { pool_name: '', views: [{ key: 'storage', enabled: true }, { key: 'memory', enabled: true }, { key: 'cpu', enabled: true }] }, 'truenas', 5);
    var proxmox = w(1, 'proxmox', 'Proxmox', {}, 'proxmox', 3);
    var netbox = w(1, 'netbox', 'NetBox', { rack_name: '12U Homelab Rack', views: [{ key: 'rack', enabled: true }, { key: 'ips', enabled: true }, { key: 'vms', enabled: true }, { key: 'devices', enabled: true }] }, 'netbox', 60);
    var weather = w(1, 'weather', 'Weather', { location_name: 'New York', latitude: 40.7128, longitude: -74.006, units: 'fahrenheit', forecast_days: 7 }, null, 300);
    var pingAll = w(1, 'ping', 'All Pings', { target_ids: media.concat(storage) }, null, 5);
    var pingMedia = w(1, 'ping', 'Media Pings', { target_ids: media }, null, 5);
    var pingStorage = w(1, 'ping', 'Storage Pings', { target_ids: storage }, null, 5);
    var adguard = w(1, 'adguard', 'AdGuard', { widget_theme: 'dark', ag_blocked_color: '#a02f22' }, 'adguard', 10);
    var opnsense = w(1, 'opnsense', 'OPNsense', { widget_theme: 'dark', ops_cpu_color: '#ee6d11' }, 'opnsense', 2);
    var calendar = w(1, 'calendar', 'Google Calendar', { calendar_view: 'list', days_ahead: 31, max_events: 25 }, 'google_calendar', 300);
    var pingStorage2 = w(1, 'ping', 'Storage Pings', { target_ids: storage }, null, 5);

    var p1 = [
      { id: 1, name: 'Page 1', layout: [
        node(s(1, 'All Pings', [pingAll, pingMedia, pingStorage]), 0, 0, 4, 16),
        node(s(1, 'Proxmox', [proxmox]), 4, 0, 8, 16),
        node(s(1, 'TrueNAS', [truenas]), 12, 0, 4, 6),
        node(s(1, 'Clock', [clock]), 16, 0, 4, 6),
        node(s(1, 'Weather', [weather]), 12, 6, 8, 10),
        node(s(1, 'NetBox', [netbox]), 20, 0, 4, 16),
      ] },
      { id: 2, name: 'Page 2', layout: [
        node(s(1, 'AdGuard', [adguard]), 0, 0, 5, 9),
        node(s(1, 'Storage Pings', [pingStorage2]), 0, 9, 5, 7),
        node(s(1, 'OPNsense', [opnsense]), 5, 0, 7, 16),
        node(s(1, 'Google Calendar', [calendar]), 12, 0, 12, 16),
      ] },
    ];

    // ── Profile 2: a kitchen tablet ────────────────────────────────────────
    var kClock = w(2, 'clock', 'Clock', { clock_mode: 'digital', clock_format: '12h', clock_style: 'full', clock_timezone: 'America/New_York' }, null, 0);
    var kWeather = w(2, 'weather', 'Weather', { location_name: 'New York', latitude: 40.7128, longitude: -74.006, units: 'fahrenheit', forecast_days: 5 }, null, 300);
    var kCal = w(2, 'calendar', 'This week', { calendar_view: 'list', days_ahead: 7, max_events: 12 }, 'google_calendar', 300);
    var kAd = w(2, 'adguard', 'Ads blocked', { widget_theme: 'dark' }, 'adguard', 10);
    var p2 = [
      { id: 1, name: 'Home', layout: [
        node(s(2, 'Clock', [kClock]), 0, 0, 6, 5),
        node(s(2, 'Weather', [kWeather]), 6, 0, 6, 9),
        node(s(2, 'This week', [kCal]), 0, 5, 6, 11),
        node(s(2, 'Ads blocked', [kAd]), 6, 9, 6, 7),
      ] },
    ];

    var profiles = [
      { id: 1, name: 'Homelab', columns: 24, disp_w: 1920, disp_h: 720, is_active: true, created_at: now, pages: p1 },
      { id: 2, name: 'Kitchen', columns: 12, disp_w: 1280, disp_h: 800, is_active: false, created_at: now, pages: p2 },
    ];

    var settings = {
      theme_style: 'soft', theme_font: 'inter',
      board_bg_color: '#060912',
      card_bg_color: '#13111a', card_bg_opacity: '1',
      card_gradient: 'true', card_bg2_color: '#1a1628', card_bg2_opacity: '1', card_gradient_dir: '135',
      card_stroke_color: '#2d2640', card_stroke_opacity: '1', card_stroke_width: '1',
      card_accent_color: '#818cf8', card_accent_opacity: '1', card_accent_width: '3',
      card_glow: 'true', card_glow_color: '#818cf8', card_glow_opacity: '0.15', card_glow_size: '16',
      card_presets: '[]', widget_font_scale: '1',
      onboarding_done: 'true', tips_enabled: 'true',
    };

    return {
      seq: { widget: id.widget, stack: id.stack, profile: 2, ds: dataSources.length, ping: pingTargets.length, user: 1 },
      profiles: profiles,
      widgets: widgets,
      stacks: stacks,
      dataSources: dataSources,
      pingTargets: pingTargets,
      settings: settings,
      users: [{ id: 1, username: 'demo', is_default_password: false, created_at: now }],
    };
  }

  g.TouchBoardDemoSeed = { build: build };
})(window);
