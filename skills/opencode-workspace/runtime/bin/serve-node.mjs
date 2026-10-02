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
  if (p === '/workspace/api/ping') {
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
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
        return { ...e, stale, current: e.port === port };
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
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ app: 'opencode-workspace', projects }));
  }
  const cfg = loadConfig(RUNTIME, PROJECT);
  if (p === '/workspace') {
    const page = fs.readFileSync(path.join(RUNTIME, 'views', 'page.html'), 'utf8');
    const html = page.replace(/\{\{TITLE\}\}|\{\{CONFIG_SCRIPT\}\}/g, (m) => (m === '{{TITLE}}'
      ? htmlEsc(cfg.title)
      : `<script>window.WORKSPACE = ${scriptJson(pageConfig(cfg))};</script>`));
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, html);
  }
  if (p === '/workspace/api/state') {
    try {
      touchRegistry(port, cfg.title, 60);
    } catch {
    }
    const state = await buildState({ projectDir: PROJECT, storageDir: STORAGE, cfg, now: Date.now() });
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(state));
  }
  if (p === '/workspace/badge.svg') {
    let svg;
    try {
      const state = await buildState({ projectDir: PROJECT, storageDir: STORAGE, cfg, now: Date.now() });
      svg = badgeSvg(state, url.searchParams.get('label'));
    } catch {
      svg = badgeSvg(null, url.searchParams.get('label'));
    }
    return send(res, 200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=10' }, svg);
  }
  if (p.startsWith('/workspace/assets/')) {
    const rel = rawurldecode(p.slice('/workspace/assets/'.length));
    if (rel === null || rel.includes('\0')) return send(res, 404, {}, '');
    let base;
    let f;
    let st;
    try {
      base = fs.realpathSync(path.join(PUBLIC, 'assets'));
      f = fs.realpathSync(path.join(PUBLIC, 'assets', rel));
      st = fs.statSync(f);
    } catch {
      return send(res, 404, {}, '');
    }
    if (!f.startsWith(base + path.sep) || !st.isFile()) return send(res, 404, {}, '');
    const ext = path.extname(f).toLowerCase();
    const ctype = ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.woff2' ? 'font/woff2' : ext === '.png' ? 'image/png' : null;
    if (ctype === null) return send(res, 404, {}, '');
    const etag = `"${Math.floor(st.mtimeMs / 1000).toString(16)}-${st.size.toString(16)}"`;
    const h = { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=3600', ETag: etag };
    if (req.headers['if-none-match'] === etag) return send(res, 304, h, '');
    return send(res, 200, { ...h, 'Content-Length': String(st.size) }, req.method === 'HEAD' ? '' : fs.readFileSync(f));
  }
  return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
}

const port = Number(process.env.WORKSPACE_PORT || 8788);
const bind = process.env.WORKSPACE_BIND || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[workspace] invalid port: ${process.env.WORKSPACE_PORT}`);
  process.exit(1);
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
server.listen(port, bind, () => { console.log(`opencode-workspace on http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}/workspace`); console.log('Listening...'); });
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
