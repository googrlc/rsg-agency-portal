# RSG Agency Portal

Unified "hub shell" over the Hermes Command Center: a static SPA host plus a thin,
mostly read-only server-side reverse proxy to several backend services. Entry point
is `server.js` (see `package.json`); the whole UI is `public/index.html`.

## Cursor Cloud specific instructions

- Runtime: Node.js (`engines` requires `>=18`; the VM has v22). The app has **zero
  runtime dependencies** and no lockfile — it uses only Node built-ins. `npm install`
  installs nothing (it is a harmless no-op).
- Run (dev): `npm start` → `node server.js`, listens on `PORT` (default `3000`).
  There is no build step (the UI is a single static `public/index.html`) and no hot
  reload — restart the process to pick up server changes.
- Test: `npm test` runs the `.mjs` files under `test/` using Node's built-in
  `assert` (no test framework). These are pure unit tests for routing/service logic
  and do not need the server or any network.
- Lint: there is **no linter configured** (no ESLint/Prettier, no `lint` script).
- This portal is only a proxy front-door. The real backends — Hermes API
  (`googrlc/rsg-hermes`, required for live data), plus the optional intake gateway
  (`googrlc/rsg-cptintake`), carrier hub (`googrlc/rsg-carrierhub`), and commission
  tracker (`googrlc/rsg-commission-tracker`) — live in **separate repos that are not
  present in this workspace**. There is no docker-compose/Makefile here to bring them
  up together.
- Expected standalone behavior (no upstreams, no `HERMES_API_TOKEN`): `/healthz`
  returns `ok:true` with `token:"missing"`, `/api/services` reports most workspaces
  `offline`/`Unavailable`, and data panels fall back to sample data or show
  `upstream unreachable`. This is **deliberate graceful degradation, not a bug** —
  every upstream call has a short timeout and returns `{ _error }` with HTTP 200 so a
  dead backend never stalls a page. The SPA itself, navigation, `/healthz`,
  `/api/services`, and static serving all work fully offline.
- Live end-to-end data requires standing up the Hermes API separately and providing
  `HERMES_API_TOKEN` (and optionally `RSG_INTAKE_API_KEY`) — configured via env, kept
  server-side only, never sent to the browser. See the env var block at the top of
  `server.js` and `deploy.sh` for the full list of tunables.
- `deploy.sh` and `Dockerfile` are for production Docker deploys (host `3400` →
  container `3000` on the `hermes-shared` network); they are not needed for local dev.
