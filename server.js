'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// RSG Agency Portal — server-side proxy + static host.
//
// Serves the portal (./public) and exposes a thin, read-only /api/* facade over
// the Hermes Command Center backend (rsg-hermes-api). The backend bearer token
// stays server-side and is NEVER sent to the browser.
//
// Every upstream call has a short timeout (UPSTREAM_TIMEOUT_MS, default 8s) and
// on any error returns { _error } with HTTP 200 — the frontend treats that as
// "fall back to sample data" for that section. This is deliberate: the live
// backend has an endpoint (tasks) that can hang for minutes on a dead upstream,
// and the portal must degrade instantly rather than inherit that stall.
//
// Config (env):
//   PORT                 listen port (default 3000)
//   HERMES_API_URL       backend base (default http://rsg-hermes-api:8787)
//   HERMES_API_TOKEN     bearer for the backend (required for live data)
//   RSG_INTAKE_API_KEY   optional X-RSG-API-Key header
//   UPSTREAM_TIMEOUT_MS  per-request upstream timeout (default 8000)
// ─────────────────────────────────────────────────────────────────────────────
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_BASE = (process.env.HERMES_API_URL || 'http://rsg-hermes-api:8787').replace(/\/+$/, '');
// Carrier directory lives in the rsg-carrierhub app (different Supabase table +
// service-role endpoint), reachable via the docker host gateway. No auth needed.
const CARRIERHUB_URL = (process.env.CARRIERHUB_URL || 'http://172.17.0.1:3200').replace(/\/+$/, '');
// The intake gateway (rsg-intake-gate, the nowcerts-write-gateway app), reached
// container-to-container over the shared network — the same way this app reaches
// rsg-hermes-api.
//
// NOT via the docker host gateway: rsg-intake-gate publishes 127.0.0.1:8790,
// which is loopback-ONLY, so 172.17.0.1:8790 cannot connect and the intake panel
// 502s. (rsg-carrierhub publishes 0.0.0.0:3200, which is why the host route works
// for that one and misleadingly looks like the house style.) Going over
// hermes-shared also means intake needs no published host port at all.
//
// Deliberately not exposed on the tailnet either: the portal is the single door,
// and proxying keeps that true for intake too.
const INTAKE_URL = (process.env.INTAKE_GATEWAY_URL || 'http://rsg-intake-gate:8787').replace(/\/+$/, '');
const API_TOKEN = process.env.HERMES_API_TOKEN || '';
const INTAKE_KEY = process.env.RSG_INTAKE_API_KEY || '';
const TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '8000', 10);
// Intake is document upload + OCR + AMS round-trips; 8s is a read-dashboard
// timeout and would kill a legitimate submission mid-flight.
const INTAKE_TIMEOUT_MS = parseInt(process.env.INTAKE_TIMEOUT_MS || '120000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Portal route → backend REST path (read-only).
const ROUTES = {
  '/api/renewals':    '/api/command-center/renewals',
  '/api/tasks':       '/api/command-center/tasks',
  '/api/retention':   '/api/command-center/retention',
  '/api/commissions': '/api/commissions',
  '/api/cases':       '/api/cases',
  '/api/sync-health': '/api/hermes/sync-health',
  // The CRM screen's book. It shipped with hardcoded counts (414 clients, 614
  // policies) and a nav of dead <div>s, so none of this was ever reachable.
  '/api/workspace-stats': '/api/workspace-stats',
  '/api/clients':     '/api/clients',
  '/api/policies':    '/api/policies',
  '/api/pipeline':    '/api/opportunities',
  '/api/quotes':      '/api/quotes'
};

// Leads reads NowCerts live and is the slowest thing the backend exposes; it gets
// the intake budget rather than the 8s dashboard one so it degrades to an empty
// panel instead of poisoning a whole page load.
const SLOW_ROUTES = { '/api/leads': '/api/leads' };

// Paths the intake gateway owns, forwarded verbatim (method, body, headers).
// The built intake UI calls these root-relative, so hosting it on this origin
// needs no path rewriting — these must not collide with ROUTES above.
const INTAKE_PATHS = [
  /^\/api\/intakes(\/|$)/,
  /^\/api\/intake\/documents$/,
  /^\/api\/proposals(\/|$)/,
  /^\/api\/nowcerts\//,
  /^\/api\/reference\//
];

function isIntakePath(p){
  for (let i = 0; i < INTAKE_PATHS.length; i++) if (INTAKE_PATHS[i].test(p)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Operational writes to the Hermes backend.
//
// An allowlist, not an open door. The portal holds the backend bearer and has no
// login of its own, so whatever is listed here is exercisable by anyone who can
// reach the portal. That is an accepted trade for day-to-day case and task work
// on a two-person tailnet — it is NOT acceptable for money or for the system of
// record, so commission approve/reject, ledger overrides, push-to-ams and
// hermes/dispatch are deliberately absent and still answer 405.
//
// `to` rewrites the backend path when it differs from the portal path; omit it
// to forward unchanged. $1 interpolates the first capture group.
// ─────────────────────────────────────────────────────────────────────────────
const WRITE_ROUTES = [
  // Tasks — create, edit, complete.
  { m: 'POST',   re: /^\/api\/tasks$/ },
  { m: 'PATCH',  re: /^\/api\/tasks\/([0-9a-f-]{36})$/ },
  { m: 'POST',   re: /^\/api\/tasks\/([0-9a-f-]{36})\/complete$/,
    to: '/api/command-center/tasks/$1/complete' },

  // Cases — open (ad-hoc or from a template), edit, close with its resolution,
  // or delete outright. Deleting takes the case's tasks, timeline and document
  // links with it (not the Nextcloud files) and is logged with a named actor by
  // the backend; a case opened by mistake had no other way off the board.
  { m: 'POST',   re: /^\/api\/cases$/ },
  { m: 'POST',   re: /^\/api\/cases\/from-template$/ },
  { m: 'PATCH',  re: /^\/api\/cases\/([0-9a-f-]{36})$/ },
  { m: 'POST',   re: /^\/api\/cases\/([0-9a-f-]{36})\/close$/ },
  { m: 'DELETE', re: /^\/api\/cases\/([0-9a-f-]{36})$/ },

  // Tasks — delete. Create/edit/complete are above.
  { m: 'DELETE', re: /^\/api\/tasks\/([0-9a-f-]{36})$/ },

  // Renewal working detail: both premiums, the risk call, the strategy note.
  // The change percentage is generated in Postgres from the premiums, so it is
  // not writable here or anywhere else.
  { m: 'PATCH',  re: /^\/api\/renewals\/([0-9a-f-]{36})$/ },

  // Pipeline — create and move deals.
  { m: 'POST',   re: /^\/api\/opportunities$/ },
  { m: 'PATCH',  re: /^\/api\/opportunities\/([0-9a-f-]{36})$/ },
  { m: 'POST',   re: /^\/api\/opportunities\/([0-9a-f-]{36})\/stage$/ },

  // Correct a client or policy field. An override: it outranks the synced value
  // until NowCerts reports the same thing. The NowCerts identifiers are kept out
  // of reach by the backend's allowlist, not by these lines.
  { m: 'POST',   re: /^\/api\/clients\/([0-9a-f-]{36})\/override$/ },
  { m: 'POST',   re: /^\/api\/policies\/([0-9a-f-]{36})\/override$/ },

  // Push a saved correction ON to NowCerts, keyed on the record's AMS GUID.
  //
  // The header above used to say AMS endpoints stay behind their approval flows,
  // so it is worth being explicit about what changed. The portal still has no
  // login, and anyone on the tailnet can now cause a write to the system of
  // record. That was a deliberate decision (2026-07-28) and it rests on three
  // things holding: the backend refuses any field outside its own allowlist, so
  // identifiers can never be rewritten; it refuses to write at all unless it can
  // first read that record back out of NowCerts by GUID, so a bad id cannot mint
  // a duplicate insured; and every push leaves a queue row plus a
  // portal_write_log entry naming who did it. Commission and ledger endpoints
  // are still absent, and still answer 405.
  { m: 'POST',   re: /^\/api\/clients\/([0-9a-f-]{36})\/push-to-ams$/ },
  { m: 'POST',   re: /^\/api\/policies\/([0-9a-f-]{36})\/push-to-ams$/ },

  // Add a policy — created in NowCerts (the AMS owns what is bound), against an
  // insured the AMS confirms exists.
  { m: 'POST',   re: /^\/api\/policies$/ },

  // Re-drive a correction that never reached NowCerts. Recovery of a write that
  // was already approved once, replayed from its own queue row — not a new one.
  { m: 'POST',   re: /^\/api\/ams\/failed-pushes\/([0-9a-f-]{36})\/retry$/ },

  // Retry a stuck sync job — recovery, not a new write.
  { m: 'POST',   re: /^\/api\/queue\/([0-9a-f-]{36})\/retry$/ },

  // Ask Hermes. A POST because it carries a prompt, but read-only in effect —
  // the backend previews write actions rather than running them. The panel used
  // to render a hardcoded answer with invented figures under a "Hermes" label,
  // which is the one thing an assistant panel must never do.
  // An LLM turn takes far longer than a dashboard read; 8s would kill it mid-answer.
  { m: 'POST',   re: /^\/api\/ask$/, to: '/api/command-center/ask', timeoutMs: 120000 }
];

// Read routes that take a path parameter, so they can't live in the flat ROUTES map.
const READ_PATTERNS = [
  // Corrections that never landed in the AMS — the portal's banner.
  { re: /^\/api\/ams\/failed-pushes$/ },
  // Kanban columns. Same source as the stage-move validation, so the board and
  // the backend cannot disagree about what a stage is.
  { re: /^\/api\/pipeline\/stages$/ },
  { re: /^\/api\/case-templates$/ },
  // Client 360 — the record plus their policies, cases, tasks and opportunities.
  { re: /^\/api\/clients\/([0-9a-f-]{36})$/ },
  { re: /^\/api\/cases\/([0-9a-f-]{36})\/progress$/ },
  { re: /^\/api\/cases\/([0-9a-f-]{36})$/ },
  { re: /^\/api\/cases\/([0-9a-f-]{36})\/tasks$/ }
];

function matchWrite(method, p){
  for (const r of WRITE_ROUTES) {
    if (r.m !== method) continue;
    const hit = p.match(r.re);
    if (hit) return { path: r.to ? r.to.replace('$1', hit[1]) : p, timeoutMs: r.timeoutMs };
  }
  return null;
}

function matchRead(p){
  for (const r of READ_PATTERNS) if (r.re.test(p)) return p;
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Chrome ignores a manifest served as anything else, and the install prompt
  // then never appears with no visible error.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon'
};

function sendJson(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// Proxy a GET to a full upstream URL, normalizing every failure to { _error } @ 200.
// opts.noAuth omits the Hermes bearer (used for the carrierhub directory).
function proxyGet(fullUrl, res, opts){
  opts = opts || {};
  const target = url.parse(fullUrl);
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { 'Accept': 'application/json' };
  if (!opts.noAuth && API_TOKEN) headers['Authorization'] = 'Bearer ' + API_TOKEN;
  if (!opts.noAuth && INTAKE_KEY) headers['X-RSG-API-Key'] = INTAKE_KEY;

  const reqOpts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.path,
    method: 'GET',
    headers: headers
  };

  let finished = false;
  const done = (code, obj) => { if (finished) return; finished = true; sendJson(res, code, obj); };

  const req = lib.request(reqOpts, (up) => {
    let chunks = '';
    up.setEncoding('utf8');
    up.on('data', (c) => { chunks += c; if (chunks.length > 8 * 1024 * 1024) up.destroy(); });
    up.on('end', () => {
      if (up.statusCode >= 200 && up.statusCode < 300) {
        try { done(200, JSON.parse(chunks)); }
        catch (e) { done(200, { _error: 'bad json from backend', status: up.statusCode }); }
      } else {
        done(200, { _error: 'backend ' + up.statusCode, status: up.statusCode });
      }
    });
  });

  const budget = opts.timeoutMs || TIMEOUT_MS;
  req.setTimeout(budget, () => { req.destroy(); done(200, { _error: 'upstream timeout', timeout_ms: budget }); });
  req.on('error', (e) => { done(200, { _error: 'upstream unreachable', detail: String(e.code || e.message) }); });
  req.end();
}

// Stream a request through to an upstream, preserving method, body, status and
// content-type. Unlike proxyGet this does NOT coerce to JSON or swallow errors:
// intake carries multipart uploads, HTML and PDFs, and a failed submission must
// surface its real status so the operator sees it rather than a silent success.
function proxyPass(req, res, fullUrl, opts){
  opts = opts || {};
  const target = url.parse(fullUrl);
  const lib = target.protocol === 'https:' ? https : http;

  // Hop-by-hop and host headers must not be forwarded verbatim.
  const skip = { host:1, connection:1, 'keep-alive':1, 'proxy-authenticate':1,
                 'proxy-authorization':1, te:1, trailer:1, 'transfer-encoding':1,
                 upgrade:1, 'accept-encoding':1 };
  const headers = {};
  for (const k in req.headers) if (!skip[k.toLowerCase()]) headers[k] = req.headers[k];
  // Credentials are attached here, server-side. The browser never holds them.
  if (API_TOKEN) headers['Authorization'] = 'Bearer ' + API_TOKEN;
  if (INTAKE_KEY) headers['X-RSG-API-Key'] = INTAKE_KEY;

  const upstream = lib.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.path,
    method: req.method,
    headers: headers
  }, (up) => {
    const out = {};
    for (const k in up.headers) if (!skip[k.toLowerCase()]) out[k] = up.headers[k];
    res.writeHead(up.statusCode || 502, out);
    up.pipe(res);
  });

  const timeout = opts.timeoutMs || TIMEOUT_MS;
  upstream.setTimeout(timeout, () => {
    upstream.destroy();
    if (!res.headersSent) sendJson(res, 504, { _error: 'intake gateway timeout', timeout_ms: timeout });
    else res.end();
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) sendJson(res, 502, { _error: 'intake gateway unreachable', detail: String(e.code || e.message) });
    else res.end();
  });

  req.pipe(upstream);
}

function serveStatic(reqPath, res){
  let rel = reqPath === '/' ? '/index.html' : reqPath;
  rel = rel.replace(/\?.*$/, '');
  // Prevent path traversal.
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(abs, (err, data) => {
    if (err) {
      // SPA-ish fallback to index.html for unknown non-api paths.
      if (path.extname(abs) === '') {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(d2);
        });
      }
      res.writeHead(404); return res.end('not found');
    }
    const ext = path.extname(abs).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // The worker must never be served from browser cache, or a deploy can leave
    // clients pinned to an old shell indefinitely — the worker is what fetches
    // its own replacement.
    if (rel === '/sw.js') headers['Cache-Control'] = 'no-cache';
    // A build stamp on the page itself. An app window left open for days has no
    // way to notice a deploy: navigations are network-first, but nothing
    // navigates until someone reloads, and nobody reloads a dashboard they
    // believe is live.
    if (rel === '/index.html') headers['X-Portal-Build'] = buildStamp();
    res.writeHead(200, headers);
    res.end(data);
  });
}

// mtime of the served page — changes on every deploy and on nothing else. Read
// per call and tolerant of a missing file: a stamp that throws would take down
// the page it exists to describe.
function buildStamp(){
  try { return String(Math.round(fs.statSync(path.join(PUBLIC_DIR, 'index.html')).mtimeMs)); }
  catch { return '0'; }
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const p = parsed.pathname;

  if (p === '/healthz') return sendJson(res, 200, {
    ok: true, backend: API_BASE, token: API_TOKEN ? 'set' : 'missing',
    intake: INTAKE_URL, intake_key: INTAKE_KEY ? 'set' : 'missing'
  });

  // The intake gateway's own operator UI, served on this origin so its
  // root-relative /api/* calls land back here and get forwarded below.
  if (p === '/intake' || p === '/intake/') {
    return proxyPass(req, res, INTAKE_URL + '/app', { timeoutMs: INTAKE_TIMEOUT_MS });
  }

  // Intake API surface — forwarded verbatim, writes included. Checked BEFORE the
  // read-only guard: that guard protects the Hermes dashboard facade, and intake
  // is a write path by definition.
  if (isIntakePath(p)) {
    return proxyPass(req, res, INTAKE_URL + req.url, { timeoutMs: INTAKE_TIMEOUT_MS });
  }

  if (p.indexOf('/api/') === 0) {
    // Allowlisted operational writes (tasks, cases, pipeline). Streamed through
    // with real status codes: a refused close must report WHY it was refused,
    // not fall back to sample data like a dashboard tile.
    if (req.method !== 'GET') {
      const writeTarget = matchWrite(req.method, p);
      if (writeTarget) {
        return proxyPass(req, res, API_BASE + writeTarget.path + (parsed.search || ''),
                         { timeoutMs: writeTarget.timeoutMs || TIMEOUT_MS });
      }
      return sendJson(res, 405, {
        _error: 'not an allowed write',
        detail: 'money and AMS endpoints stay behind their approval flows'
      });
    }
    // Parameterised reads (case detail, checklist progress, template menu).
    const readTarget = matchRead(p);
    if (readTarget) return proxyGet(API_BASE + readTarget + (parsed.search || ''), res);
    // Carrier directory comes from the carrierhub app, not the hermes backend.
    if (p === '/api/carriers') {
      return proxyGet(CARRIERHUB_URL + '/api/carriers', res, { noAuth: true });
    }
    if (SLOW_ROUTES[p]) {
      return proxyGet(API_BASE + SLOW_ROUTES[p] + (parsed.search || ''), res,
                      { timeoutMs: Math.max(TIMEOUT_MS, 45000) });
    }
    const backendPath = ROUTES[p];
    if (!backendPath) return sendJson(res, 404, { _error: 'unknown api route' });
    return proxyGet(API_BASE + backendPath + (parsed.search || ''), res);
  }

  return serveStatic(p, res);
});

server.listen(PORT, () => {
  console.log('[agency-portal] listening on :' + PORT + '  backend=' + API_BASE + '  token=' + (API_TOKEN ? 'set' : 'MISSING'));
});
