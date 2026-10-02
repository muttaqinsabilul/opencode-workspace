#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`Butuh Node ≥ 18 (terpasang ${process.versions.node}).`);
  process.exit(1);
}

const RUNTIME = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const PUBLIC = path.join(RUNTIME, 'public');
let PROJECT;
try {
  PROJECT = fs.realpathSync(process.env.WORKSPACE_PROJECT || process.cwd());
} catch {
  console.error(`[workspace] project folder not found: ${process.env.WORKSPACE_PROJECT}`);
  process.exit(1);
}
const STORAGE = process.env.WORKSPACE_STORAGE ? path.resolve(process.env.WORKSPACE_STORAGE) : null;
const { loadConfig } = await import(new URL('../lib/node/config.mjs', import.meta.url));
const { buildState } = await import(new URL('../lib/node/office.mjs', import.meta.url));
const { pageConfig, hostAllowed, SECURITY_HEADERS } = await import(new URL('../lib/node/http.mjs', import.meta.url));

if (STORAGE) {
  try {
    fs.mkdirSync(path.join(STORAGE, 'cache'), { recursive: true });
  } catch {
  }
}
const PROJECT_ID = crypto.createHash('md5').update(PROJECT).digest('hex').slice(0, 12);
const extraHosts = String(process.env.WORKSPACE_ALLOWED_HOSTS || '');
const EXPOSE_PATHS = String(process.env.WORKSPACE_EXPOSE_PATHS || '').trim() === '1';

// Access token. Set with WORKSPACE_TOKEN, or let workspace.sh generate one when
// you start with a non-loopback --bind. It is only demanded from non-loopback
// peers, so a plain http://127.0.0.1:PORT/workspace stays open on the machine
// that opted in. No token = every request behaves exactly as before.
const TOKEN_RE = /^[0-9A-Za-z_-]{16,128}$/;
const TOKEN_COOKIE = 'workspace_token';
function cleanToken(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  return TOKEN_RE.test(t) ? t : '';
}
function activeToken() {
  const e = cleanToken(process.env.WORKSPACE_TOKEN);
  return e === '' ? null : e;
}
if (String(process.env.WORKSPACE_TOKEN || '').trim() !== '' && cleanToken(process.env.WORKSPACE_TOKEN) === '') {
  console.error('[workspace] WORKSPACE_TOKEN ignored: use 16-128 characters of A-Z a-z 0-9 _ or -');
}
const START_TOKEN = activeToken();
function isLoopbackBind(b) {
  return b === '127.0.0.1' || b === 'localhost' || b === '::1' || b === '::ffff:127.0.0.1' || b.startsWith('127.');
}
function loopbackPeer(addr) {
  const a = String(addr || '').replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}
function tokenEquals(expected, got) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(typeof got === 'string' ? got : '', 'utf8');
  const n = Math.max(a.length, b.length);
  const ab = Buffer.alloc(n);
  const bb = Buffer.alloc(n);
  a.copy(ab);
  b.copy(bb);
  // both sides padded to one length: the compare cannot throw on a wrong-length input
  return a.length === b.length && crypto.timingSafeEqual(ab, bb);
}
function cookieToken(req) {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string' || raw === '' || raw.length > 4096) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== TOKEN_COOKIE) continue;
    const v = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return '';
}

const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const scriptJson = (v) => JSON.stringify(v).replace(/[<>&'\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
const rawurldecode = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, '%2B'));
  } catch {
    return null;
  }
};

function badgeSvg(state, rawLabel) {
  const clean = String(rawLabel ?? '').replace(/[<>&"']/g, '');
  const label = [...clean].slice(0, 24).join('') || 'opencode-workspace';
  const st = state && typeof state === 'object' ? state : null;
  const n = st ? Number(st.stats && st.stats.active) || 0 : 0;
  const leadBusy = !!st && !!st.lead && st.lead.state === 'working';
  const busy = n > 0 || leadBusy;
  const right = st === null ? 'inactive' : n > 0 ? `${n} active` : leadBusy ? 'busy' : 'idle';
  const fill = st === null ? '#555' : busy ? '#2563eb' : '#16a34a';
  const tw = (s) => Math.round([...String(s)].length * 0.6 * 11); 
  const leftW = 12 + tw(label);
  const rightW = 12 + tw(right);
  const aria = `${label}: ${right}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${leftW + rightW}" height="20" role="img" aria-label="${aria}"><title>${aria}</title>`
    + `<rect width="${leftW}" height="20" rx="3" fill="#555"/><rect x="${leftW}" width="${rightW}" height="20" rx="3" fill="${fill}"/>`
    + `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">`
    + `<text x="${leftW / 2}" y="14">${label}</text><text x="${leftW + rightW / 2}" y="14">${right}</text></g></svg>`;
}

function projectBaseName(p) {
  const parts = String(p).replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].slice(0, 256) : '';
}

function registryFile() {
  try {
    const xdg = String(process.env.XDG_CACHE_HOME || '').trim();
    const base = xdg !== '' ? xdg : path.join(os.homedir(), '.cache');
    return path.join(base, 'opencode-workspace', 'registry.json');
  } catch {
    return null;
  }
}
function readRegistry() {
  try {
    const f = registryFile();
    if (!f) return [];
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.projects) ? j.projects : []);
    const out = [];
    for (const e of arr) {
      if (!e || typeof e !== 'object') continue;
      const port = Number(e.port);
      const project = typeof e.project === 'string' ? e.project.slice(0, 256) : '';
      if (project === '' || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      out.push({
        project,
        port,
        title: typeof e.title === 'string' ? e.title.slice(0, 80) : '',
        updated: typeof e.updated === 'string' ? e.updated.slice(0, 40) : '',
      });
    }
    return out;
  } catch {
    return [];
  }
}
function touchRegistry(port, title, minAgeSec = 0) {
  try {
    const v = process.env.WORKSPACE_NO_REGISTRY;
    if (v && v !== '0') return;
    const f = registryFile();
    if (!f || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const now = new Date();
    if (minAgeSec > 0) {
      const mine = readRegistry().find((e) => e.project === PROJECT);
      const t = mine ? Date.parse(mine.updated) : NaN;
      if (Number.isFinite(t) && now.getTime() - t < minAgeSec * 1000) return;
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const iso = now.toISOString();
    const clean = String(title || '').slice(0, 80);
    let found = false;
    const arr = readRegistry().map((e) => {
      if (e.project === PROJECT) {
        found = true;
        return { project: PROJECT, port, title: clean, updated: iso };
      }
      return e;
    });
    if (!found) arr.push({ project: PROJECT, port, title: clean, updated: iso });
    arr.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
    const tmp = `${f}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(arr.slice(0, 20), null, 1));
    fs.renameSync(tmp, f);
  } catch {
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed');
  if (!hostAllowed(req.headers.host, extraHosts)) return send(res, 421, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Unknown host');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request');
  }
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '' || p === '/index.php') return send(res, 302, { Location: '/workspace' }, '');
  if (p.startsWith('/workspace')) {
    const token = activeToken();
    if (!token) return route(req, res, url, p, null);
    const q = url.searchParams.get('k');
    if (q !== null && tokenEquals(token, q)) {
      // first visit with the link: hand the token to the browser so a reload,
      // a bookmark and the project switcher keep working without ?k=
      const cookie = [`${TOKEN_COOKIE}=${token}`, 'Path=/workspace', 'HttpOnly', 'SameSite=Lax'];
      return route(req, res, url, p, { 'Set-Cookie': cookie.join('; ') });
    }
    // loopback peers are the machine that opted in, so they keep the plain local URL.
    const local = loopbackPeer(req.socket.remoteAddress);
    if (local || tokenEquals(token, q) || tokenEquals(token, cookieToken(req))) return route(req, res, url, p, null);
    return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'Workspace token required');
  }
  return route(req, res, url, p, null);
}

async function route(req, res, url, p, headers) {
  const reply = (status, h, body) => send(res, status, headers ? { ...h, ...headers } : h, body);
  if (p === '/workspace/api/ping') {
    return reply(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ app: 'opencode-workspace', project: PROJECT_ID, runtime: 'node' }));
  }
  if (p === '/workspace/api/projects') {
    try {
      touchRegistry(port, loadConfig(RUNTIME, PROJECT).title);
    } catch {
    }
    const nowMs = Date.now();
    const seen = new Set();
    const projects = readRegistry()
      .map((e) => {
        const t = Date.parse(e.updated);
        const stale = !(Number.isFinite(t) && nowMs - t <= 10 * 60 * 1000);
        // absolute folder path only with WORKSPACE_EXPOSE_PATHS=1; the switcher
        // labels a project from `project` either way (basename === its own base())
        return { ...e, id: crypto.createHash('md5').update(e.project).digest('hex').slice(0, 12), project: EXPOSE_PATHS ? e.project : projectBaseName(e.project), stale, current: e.port === port };
      })
      .filter((e) => !e.stale)
      .sort((a, b) => {
        if (a.current !== b.current) return a.current ? -1 : 1;
        return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0;
      })
      .filter((e) => {
        if (seen.has(e.port)) return false;
        seen.add(e.port);
        return true;
      });
    return reply(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ app: 'opencode-workspace', projects }));
  }
  const cfg = loadConfig(RUNTIME, PROJECT);
  if (p === '/workspace') {
    const page = fs.readFileSync(path.join(RUNTIME, 'views', 'page.html'), 'utf8');
    const html = page.replace(/\{\{TITLE\}\}|\{\{CONFIG_SCRIPT\}\}/g, (m) => (m === '{{TITLE}}'
      ? htmlEsc(cfg.title)
      : `<script>window.WORKSPACE = ${scriptJson(pageConfig(cfg))};</script>`));
    return reply(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, html);
  }
  if (p === '/workspace/api/state') {
    try {
      touchRegistry(port, cfg.title, 60);
    } catch {
    }
    const state = await buildState({ projectDir: PROJECT, storageDir: STORAGE, cfg, now: Date.now() });
    return reply(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(state));
  }
  if (p === '/workspace/badge.svg') {
    let svg;
    try {
      const state = await buildState({ projectDir: PROJECT, storageDir: STORAGE, cfg, now: Date.now() });
      svg = badgeSvg(state, url.searchParams.get('label'));
    } catch {
      svg = badgeSvg(null, url.searchParams.get('label'));
    }
    return reply(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=10' }, svg);
  }
  if (p.startsWith('/workspace/assets/')) {
    const rel = rawurldecode(p.slice('/workspace/assets/'.length));
    if (rel === null || rel.includes('\0')) return reply(404, {}, '');
    let base;
    let f;
    let st;
    try {
      base = fs.realpathSync(path.join(PUBLIC, 'assets'));
      f = fs.realpathSync(path.join(PUBLIC, 'assets', rel));
      st = fs.statSync(f);
    } catch {
      return reply(404, {}, '');
    }
    if (!f.startsWith(base + path.sep) || !st.isFile()) return reply(404, {}, '');
    const ext = path.extname(f).toLowerCase();
    const ctype = ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.woff2' ? 'font/woff2' : ext === '.png' ? 'image/png' : null;
    if (ctype === null) return reply(404, {}, '');
    const etag = `"${Math.floor(st.mtimeMs / 1000).toString(16)}-${st.size.toString(16)}"`;
    const h = { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=3600', ETag: etag };
    if (req.headers['if-none-match'] === etag) return reply(304, h, '');
    return reply(200, { ...h, 'Content-Length': String(st.size) }, req.method === 'HEAD' ? '' : fs.readFileSync(f));
  }
  return reply(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
}

const port = Number(process.env.WORKSPACE_PORT || 8788);
const bind = process.env.WORKSPACE_BIND || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[workspace] invalid port: ${process.env.WORKSPACE_PORT}`);
  process.exit(1);
}
if (!isLoopbackBind(bind)) {
  if (String(process.env.WORKSPACE_ALLOW_LAN || '').trim() !== '1') {
    console.error(`[workspace] refusing to bind ${bind}: every host that can reach this address would read this project's agent activity with no login. Re-run with WORKSPACE_ALLOW_LAN=1 to accept that, or bind 127.0.0.1.`);
    process.exit(1);
  }
  if (!START_TOKEN) {
    console.error(`[workspace] refusing to bind ${bind}: WORKSPACE_ALLOW_LAN=1 also needs an access token. Set WORKSPACE_TOKEN to 16-128 characters of A-Z a-z 0-9 _ -.`);
    process.exit(1);
  }
}
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(`[workspace] ${req.method} ${req.url}: ${e && e.stack ? e.stack : e}`);
    if (!res.headersSent) send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Server error');
    else res.end();
  });
});
server.on('error', (e) => {
  console.error(`[workspace] server failed: ${e.code === 'EADDRINUSE' ? `port ${port} already in use` : e.message}`);
  process.exit(e.code === 'EADDRINUSE' ? 3 : 1);
});
server.listen(port, bind, () => {
  console.log(`opencode-workspace on http://${bind}:${port}/workspace`);
  if (!isLoopbackBind(bind)) console.log(`[workspace] listening on ${bind} — reachable from the network, access token required`);
  console.log('Listening...');
});
try {
  touchRegistry(port, loadConfig(RUNTIME, PROJECT).title);
  const t = setInterval(() => {
    try {
      touchRegistry(port, loadConfig(RUNTIME, PROJECT).title);
    } catch {
    }
  }, 5 * 60 * 1000);
  if (t.unref) t.unref();
} catch {
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.(); 
    setTimeout(() => process.exit(0), 800).unref();
  });
}
