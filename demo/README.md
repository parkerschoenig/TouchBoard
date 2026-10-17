# TouchBoard live demo

A static build of the real editor and display that runs entirely in the browser, published at **touchboard.pshl.app**.

```bash
node demo/build.mjs              # → demo/dist (Node 20+, no dependencies)
npx wrangler pages dev demo/dist
```

## How it works

- **`build.mjs`** copies `frontend/` (never `data/`) into `demo/dist`.
  - It loads the demo runtime first in each page's `<head>`, swaps the login form for an "Enter the demo" button, and keeps state across the app's own reloads (switching profile, restoring a backup).
  - Every patch must still match, or the build fails.
- **`runtime/server.js`** ports `routes.py`, `db.py` and `poller.py`: profiles (with clone ID remapping), widgets, stacks, pages, data sources, ping targets, users and settings.
  - It also has a 1-second poller and a fake `EventSource` for `/api/stream`.
- **Shared state:** state lives in `localStorage` and syncs between tabs over a `BroadcastChannel`, so the **Open Display** tab updates as you edit. Reloading the editor starts fresh.
- **`runtime/generators.js`** returns data in the exact shape each integration produces, as random walks so the board moves. Weather is real (Open-Meteo, from the browser), with a synthetic fallback.
- **`runtime/fernet.js`** implements the backup envelope from `backup.py` in WebCrypto: PBKDF2-SHA256 and Fernet. Demo exports are real TouchBoard backups, and real backups import.
- **`kit/demo-kit.js`** is vendored from the portfolio repo: PRNG, router, and the "Live demo" ribbon.

Data sources use `*.home.arpa`, and ping targets use RFC 5737 documentation addresses. No real hosts or credentials are involved.
