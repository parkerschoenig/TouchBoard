// Builds the static TouchBoard demo into demo/dist (Node 20+, no dependencies).
// Copies frontend/ only — never data/ — and patches the few spots that bypass
// the API client. Every patch must still match, so app changes that break the
// demo fail the build instead of the demo.
//
//   node demo/build.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const front = join(root, 'frontend');
const out = join(root, 'demo', 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function patch(src, find, replace, label, { all = false } = {}) {
  const hits = src.split(find).length - 1;
  if (!hits) throw new Error(`demo patch no longer matches: ${label}`);
  if (hits > 1 && !all) throw new Error(`demo patch is ambiguous (${hits} matches): ${label}`);
  return src.split(find).join(replace);
}

const runtime = ['kit/demo-kit.js', 'runtime/seed.js', 'runtime/generators.js', 'runtime/fernet.js', 'runtime/server.js', 'runtime/demo.js'];
const head = (page) =>
  '<head>\n  <meta name="robots" content="noindex, nofollow" />\n' +
  `  <script>window.__TB_DEMO_PAGE=${JSON.stringify(page)};</script>\n` +
  runtime.map((f) => `  <script src="/demo/${f}"></script>`).join('\n');

// ── Static assets (frontend/static only) ───────────────────────────────────
cpSync(join(front, 'static'), join(out, 'static'), { recursive: true });

// ── Pages ───────────────────────────────────────────────────────────────────
const editor = patch(readFileSync(join(front, 'layout-editor.html'), 'utf8'), '<head>', head('editor'), 'editor: head');
writeFileSync(join(out, 'index.html'), editor);

const display = patch(readFileSync(join(front, 'display.html'), 'utf8'), '<head>', head('display'), 'display: head');
writeFileSync(join(out, 'display.html'), display);

let login = patch(readFileSync(join(front, 'login.html'), 'utf8'), '<head>', head('login'), 'login: head');
login = patch(
  login,
  login.slice(login.indexOf('<form id="login-form"'), login.indexOf('</form>') + '</form>'.length),
  `<div class="demo-login">
        <p class="demo-login-note">This is a live demo with simulated integrations. Changes stay in your browser.</p>
        <button class="login-btn" type="button" data-demo-enter>Enter the demo</button>
        <p class="demo-login-note">In production you sign in with a local account here; the display view needs no login.</p>
      </div>`,
  'login: form',
);
login = patch(login, '<script type="module" src="/static/js/login.js"></script>', '<script type="module" src="/demo/runtime/login.js"></script>', 'login: script');
login = patch(login, '</head>', '<style>.demo-login{display:grid;gap:14px}.demo-login-note{margin:0;font-size:13px;opacity:.7;line-height:1.45;text-align:center}</style>\n</head>', 'login: styles');
writeFileSync(join(out, 'login.html'), login);

// ── Keep demo state across the app's own reloads ────────────────────────────
for (const file of ['layout-editor.js', 'display.js']) {
  const p = join(out, 'static', 'js', file);
  writeFileSync(p, patch(readFileSync(p, 'utf8'), 'window.location.reload()', 'DemoKit.reloadKeepingState()', `${file}: reloads`, { all: true }));
}

// ── Runtime + hosting files ─────────────────────────────────────────────────
mkdirSync(join(out, 'demo'), { recursive: true });
cpSync(join(root, 'demo', 'kit'), join(out, 'demo', 'kit'), { recursive: true });
cpSync(join(root, 'demo', 'runtime'), join(out, 'demo', 'runtime'), { recursive: true });
writeFileSync(
  join(out, '_headers'),
  `/*
  Content-Security-Policy: frame-ancestors 'self' https://portfolio.pshl.app
  X-Robots-Tag: noindex, nofollow
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`,
);
writeFileSync(join(out, '_redirects'), '/configure / 302\n/favicon.ico /static/img/favicon.ico 200\n');
writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

// ── Gate: nothing from data/ and nothing identifying may ship ───────────────
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const files = walk(out);
// Real homelab hostnames and LAN ranges must never appear (the seed uses
// *.home.arpa and RFC 5737 documentation addresses).
const forbidden = /lab\.pshl\.app|\.lab\.home|192\.168\.\d/i;
for (const f of files) {
  const rel = relative(out, f);
  if (/\.(db|key|sqlite)$/i.test(rel)) throw new Error(`refusing to ship ${rel}`);
  if (/\.(png|ico|jpg|webp|woff2?)$/i.test(rel)) continue;
  const text = readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    if (forbidden.test(line)) throw new Error(`forbidden string in ${rel}: ${line.trim().slice(0, 120)}`);
  }
}
if (existsSync(join(out, 'data'))) throw new Error('data/ must never be copied');
const kb = Math.round(files.reduce((s, f) => s + statSync(f).size, 0) / 1024);
console.log(`TouchBoard demo built: ${files.length} files, ${kb} KB → ${relative(root, out)}`);
