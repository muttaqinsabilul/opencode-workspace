#!/usr/bin/env node
import http from 'node:http';
const base = (process.argv[2] || `http://127.0.0.1:${process.env.WORKSPACE_PORT || 8788}`).replace(/\/+$/, '').replace(/\/workspace$/, '');
const bad = [];
const good = [];
const t = (name, cond, extra = '') => (cond ? good : bad).push(extra ? `${name} (${extra})` : name);
const get = (p) => new Promise((resolve) => {
  let u;
  try {
    u = new URL(base + p);
  } catch {
    resolve({ status: 0, headers: { get: () => null }, text: async () => '', json: async () => null });
    return;
  }
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: {} }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      const buf = Buffer.concat(chunks).toString('utf8');
      const hm = {};
      for (const [k, v] of Object.entries(res.headers)) hm[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      resolve({ status: res.statusCode ?? 0, headers: { get: (k) => hm[String(k).toLowerCase()] ?? null }, text: async () => buf, json: async () => JSON.parse(buf) });
    });
  });
  req.on('error', () => resolve({ status: 0, headers: { get: () => null }, text: async () => '', json: async () => null }));
  req.end();
});

try {
  const page = await get('/workspace');
  const html = await page.text();
  t('/workspace → 200', page.status === 200, String(page.status));
  t('header X-Robots-Tag noindex', /noindex/.test(page.headers.get('x-robots-tag') || ''));
  t('header Referrer-Policy no-referrer', page.headers.get('referrer-policy') === 'no-referrer');
  t('header Content-Security-Policy', /default-src 'self'/.test(page.headers.get('content-security-policy') || ''));
  const m = /window\.WORKSPACE = (.*?);<\/script>/s.exec(html);
  let cfg = null;
  try {
    cfg = m ? JSON.parse(m[1]) : null;
  } catch {
    cfg = null;
  }
  t('window.WORKSPACE readable', cfg !== null && Array.isArray(cfg.team) && cfg.team.length === 4);
  t('Opencode Workspace title', /Opencode Workspace/.test(html));
  const r = await get('/workspace/api/state');
  const s = await r.json().catch(() => null);
  t('/workspace/api/state → JSON', r.status === 200 && s && s.app === 'opencode-workspace', String(r.status));
  if (s) {
    for (const k of ['lead', 'team', 'freelancers', 'feed', 'runs', 'stats']) t(`state.${k} present`, k in s);
    const txt = JSON.stringify(s);
    t('no sk-… / ghp_… tokens escaping redaction', !/\bsk-(?!•)[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{20,}/.test(txt));
    const busy = s.team.filter((m2) => m2.state === 'working').map((m2) => m2.name);
    console.log(`  ${s.project}: OpenCode sessions ${s.transcripts ? 'present' : 'none yet'} · ${s.lead.name} ${s.lead.state} · team working: ${busy.join(', ') || '—'} · freelancers: ${s.freelancers.length} · ${s.stats.total} subagents (7 days)`);
  }
  t('/workspace/assets/workspace.js → 200', (await get('/workspace/assets/workspace.js')).status === 200);
  for (const p of ['/workspace/assets/..%2F..%2Fdefaults.json', '/defaults.json', '/workspace/no-such-page']) t(`404 ${p}`, (await get(p)).status === 404);
} catch (e) {
  bad.push(`cannot connect to ${base}: ${e.cause?.code || e.message}`);
}
for (const g of good) console.log(`  ok    ${g}`);
for (const b of bad) console.log(`  FAIL  ${b}`);
console.log(bad.length ? `FAILED (${bad.length})` : `OK (${good.length} checks) — open ${base}/workspace`);
process.exit(bad.length ? 1 : 0);
