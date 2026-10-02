#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const arg = (k, d) => process.argv.slice(2).filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3)).pop() ?? d;
const PROJECT = fs.realpathSync(arg('project', process.cwd()));
const PHP_PORT = Number(arg('php-port', 8791));
const NODE_PORT = Number(arg('node-port', 8792));
const ROUNDS = Number(arg('rounds', 2));
const FORBID = [
  /\bsk-(?!•)[A-Za-z0-9_-]{8,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
  ...process.argv.slice(2).filter((a) => a.startsWith('--forbid=')).map((a) => new RegExp(a.slice(9))),
];
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-parity-'));
const procs = [];
const problems = [];
const ok = [];
const cleanup = () => {
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
    } catch {
    }
  }
  fs.rmSync(STORE, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

function start(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: RUNTIME, env: { ...process.env, WORKSPACE_PROJECT: PROJECT, WORKSPACE_STORAGE: STORE, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => {
    err += d;
  });
  p.on('error', (e) => problems.push(`${cmd} could not start: ${e.message}`));
  procs.push(p);
  return () => err;
}
async function waitUp(base, name, errOf) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await get(base, '/workspace/api/ping')).status === 200) return true;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  problems.push(`${name} not ready at ${base}: ${errOf().slice(0, 400)}`);
  return false;
}
const rawHttp = (base, p, h = {}, method = 'GET') => new Promise((resolve) => {
  let u;
  try {
    u = new URL(base + p);
  } catch {
    resolve({ status: 0, headers: { get: () => null }, text: async () => '', json: async () => null });
    return;
  }
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
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
const get = (base, p, h = {}) => rawHttp(base, p, h, 'GET');
const hostGet = (port, p, host) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => {
    res.resume();
    resolve(res.statusCode);
  });
  req.on('error', () => resolve(0));
  req.end();
});
function diff(a, b, at = '$', ignore = new Set(), out = []) {
  if (out.length > 40) return out;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb) {
    out.push(`${at}: tipe ${ta} ≠ ${tb} (${JSON.stringify(a)?.slice(0, 80)} | ${JSON.stringify(b)?.slice(0, 80)})`);
    return out;
  }
  if (ta === 'array') {
    if (a.length !== b.length) out.push(`${at}: panjang ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${at}[${i}]`, ignore, out);
  } else if (ta === 'object') {
    const ka = Object.keys(a).filter((k) => !(at === '$' && ignore.has(k)));
    const kb = Object.keys(b).filter((k) => !(at === '$' && ignore.has(k)));
    if (ka.join('|') !== kb.join('|')) out.push(`${at}: kunci [${ka}] ≠ [${kb}]`);
    for (const k of ka) if (Object.hasOwn(b, k)) diff(a[k], b[k], `${at}.${k}`, ignore, out);
  } else if (a !== b) out.push(`${at}: ${JSON.stringify(a)?.slice(0, 100)} ≠ ${JSON.stringify(b)?.slice(0, 100)}`);
  return out;
}
function check(name, cond, detail = '') {
  if (cond) ok.push(name);
  else problems.push(`${name}${detail ? `: ${detail}` : ''}`);
}
const normLive = (s) => {
  const fix = (o) => {
    if (Array.isArray(o)) {
      for (const v of o) fix(v);
      return;
    }
    if (o && typeof o === 'object') {
      if (typeof o.elapsedMs === 'number' && (o.ended === null || o.status === 'working')) o.elapsedMs = 0;
      for (const v of Object.values(o)) fix(v);
    }
  };
  fix(s);
};

const phpErr = start('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', 'public', 'public/index.php'], {});
const nodeErr = start(process.execPath, ['bin/serve-node.mjs'], { WORKSPACE_PORT: String(NODE_PORT), WORKSPACE_BIND: '127.0.0.1' });
const P = `http://127.0.0.1:${PHP_PORT}`;
const N = `http://127.0.0.1:${NODE_PORT}`;
const up = (await waitUp(P, 'PHP', phpErr)) & (await waitUp(N, 'Node', nodeErr));

if (up) {
  let sp;
  let sn;
  for (let round = 1; round <= ROUNDS; round++) {
    const [rp, rn] = await Promise.all([get(P, '/workspace/api/state'), get(N, '/workspace/api/state')]);
    sp = await rp.json();
    sn = await rn.json();
    normLive(sp);
    normLive(sn);
    const d = diff(sp, sn, '$', new Set(['now']));
    check(`state round ${round} identical (${sp.runs?.length ?? 0} run, ${sp.feed?.length ?? 0} event, ${sp.freelancers?.length ?? 0} freelancer)`, d.length === 0, `\n    ${d.slice(0, 25).join('\n    ')}`);
  }
  const raw = JSON.stringify(sp) + JSON.stringify(sn);
  for (const re of FORBID) check(`no leak of ${re}`, !re.test(raw), (raw.match(re) || [''])[0].slice(0, 60));

  const [hp, hn] = await Promise.all([get(P, '/workspace'), get(N, '/workspace')]);
  const [tp, tn] = [await hp.text(), await hn.text()];
  check('/workspace 200 on both', hp.status === 200 && hn.status === 200, `${hp.status}/${hn.status}`);
  const cfgOf = (t) => {
    const m = /window\.WORKSPACE = (.*?);<\/script>/s.exec(t);
    try {
      return m ? JSON.parse(m[1]) : null;
    } catch {
      return null;
    }
  };
  const cd = diff(cfgOf(tp), cfgOf(tn));
  check('window.WORKSPACE identical & valid', cfgOf(tp) !== null && cd.length === 0, cd.join('; '));
  check('<title> identical', (/<title>(.*?)<\/title>/.exec(tp) || [])[1] === (/<title>(.*?)<\/title>/.exec(tn) || [])[1]);
  check('<title> Opencode Workspace', /Opencode Workspace/.test(tp) && /Opencode Workspace/.test(tn));
  for (const h of ['x-robots-tag', 'referrer-policy', 'x-content-type-options', 'x-frame-options', 'content-security-policy']) {
    check(`header ${h}`, !!hp.headers.get(h) && hp.headers.get(h) === hn.headers.get(h), `${hp.headers.get(h)} / ${hn.headers.get(h)}`);
  }
  const [pp, pn] = await Promise.all([get(P, '/workspace/api/ping'), get(N, '/workspace/api/ping')]);
  const [jp, jn] = [await pp.json(), await pn.json()];
  check('/workspace/api/ping identical (except runtime)', jp.app === 'opencode-workspace' && jp.project === jn.project && jp.runtime === 'php' && jn.runtime === 'node');
  const [ap, an] = await Promise.all([get(P, '/workspace/assets/workspace.js'), get(N, '/workspace/assets/workspace.js')]);
  check('/workspace/assets/workspace.js identical', ap.status === 200 && an.status === 200 && (await ap.text()) === (await an.text()));
  const etag = an.headers.get('etag');
  check('ETag same & 304', etag === ap.headers.get('etag') && (await get(N, '/workspace/assets/workspace.js', { 'If-None-Match': etag })).status === 304
    && (await get(P, '/workspace/assets/workspace.js', { 'If-None-Match': etag })).status === 304);
  for (const bad of [
    '/workspace/assets/..%2F..%2Flib%2Fphp%2FConfig.php', '/workspace/assets/..%2Fdefaults.json', '/workspace/assets/%2e%2e/%2e%2e/defaults.json',
    '/workspace/assets/../../bin/workspace.sh', '/workspace/assets/vendor/three/LICENSE', '/workspace/api/doc?path=README.md', '/workspace/evidence/x.png',
    '/workspace/no-such-page', '/lib/php/Config.php', '/defaults.json', '/views/page.html', '/public/index.php', '/workspace/assets/%00.js',
  ]) {
    const [bp, bn] = await Promise.all([get(P, bad), get(N, bad)]);
    check(`404 ${bad}`, bp.status === 404 && bn.status === 404, `PHP ${bp.status} / Node ${bn.status}`);
  }
  for (const [host, want] of [['evil.example.test', 421], ['evil.example.test:8788', 421], ['abc-def.trycloudflare.com', 200], ['localhost:8788', 200], ['192.168.1.5:8788', 200]]) {
    const [xp, xn] = await Promise.all([hostGet(PHP_PORT, '/workspace/api/ping', host), hostGet(NODE_PORT, '/workspace/api/ping', host)]);
    check(`Host ${host} → ${want}`, xp === want && xn === want, `PHP ${xp} / Node ${xn}`);
  }
  const [mp, mn] = await Promise.all([rawHttp(P, '/workspace/api/state', {}, 'POST'), rawHttp(N, '/workspace/api/state', {}, 'POST')]);
  check('POST rejected (405)', mp.status === 405 && mn.status === 405, `PHP ${mp.status} / Node ${mn.status}`);
  const [rp, rn] = await Promise.all([get(P, '/'), get(N, '/')]);
  check('/ → 302 /workspace', rp.status === 302 && rn.status === 302 && rp.headers.get('location') === '/workspace' && rn.headers.get('location') === '/workspace');
  for (const oldP of ['/kantor', '/kantor/', '/kantor/api/ping', '/kantor/api/state']) {
    const [bp, bn] = await Promise.all([get(P, oldP), get(N, oldP)]);
    check(`${oldP} → 404`, bp.status === 404 && bn.status === 404, `PHP ${bp.status} / Node ${bn.status}`);
  }
}

cleanup();
for (const o of ok) console.log(`  ok   ${o}`);
for (const p of problems) console.log(`  DIFF ${p}`);
console.log(problems.length ? `PARITY FAILED (${problems.length} problems, ${ok.length} ok)` : `PARITY OK (${ok.length} checks)`);
process.exit(problems.length ? 1 : 0);
