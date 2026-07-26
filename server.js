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
// The intake gateway (rsg-intake-gate, the nowcerts-write-gateway app). It binds
// 127.0.0.1 on the host, so from inside this container it is reachable only via
// the docker host gateway. Deliberately NOT published on the tailnet: the portal
// is the single door, and proxying keeps that true for intake too.
const INTAKE_URL = (process.env.INTAKE_GATEWAY_URL || 'http://172.17.0.1:8790').replace(/\/+$/, '');
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
  '/api/sync-health': '/api/hermes/sync-health'
};

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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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

  req.setTimeout(TIMEOUT_MS, () => { req.destroy(); done(200, { _error: 'upstream timeout', timeout_ms: TIMEOUT_MS }); });
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
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
    if (req.method !== 'GET') return sendJson(res, 405, { _error: 'read-only proxy' });
    // Carrier directory comes from the carrierhub app, not the hermes backend.
    if (p === '/api/carriers') {
      return proxyGet(CARRIERHUB_URL + '/api/carriers', res, { noAuth: true });
    }
    const backendPath = ROUTES[p];
    if (!backendPath) return sendJson(res, 404, { _error: 'unknown api route' });
    return proxyGet(API_BASE + backendPath, res);
  }

  return serveStatic(p, res);
});

server.listen(PORT, () => {
  console.log('[agency-portal] listening on :' + PORT + '  backend=' + API_BASE + '  token=' + (API_TOKEN ? 'set' : 'MISSING'));
});
