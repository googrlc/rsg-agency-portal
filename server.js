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
const API_TOKEN = process.env.HERMES_API_TOKEN || '';
const INTAKE_KEY = process.env.RSG_INTAKE_API_KEY || '';
const TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '8000', 10);
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

  if (p === '/healthz') return sendJson(res, 200, { ok: true, backend: API_BASE, token: API_TOKEN ? 'set' : 'missing' });

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
