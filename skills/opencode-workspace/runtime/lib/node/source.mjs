import fs from 'node:fs';
import path from 'node:path';
import { apiGet, getService, normDir, resetService } from './oclient.mjs';
import {
  clip, describeTool, isPlainObj, isoMs, mbLen, oneLine, phpTrim, redact, safeLine, strcmp, values,
} from './util.mjs';

const EVENTS_KEEP = 40;
const SEGS_KEEP = 20;
const FILES_KEEP = 12;
const SESS_CAP = 200;
const MSG_LIMIT = 200;
const LIMIT_RE = /(usage limit|rate limit|limit reached|resets? (at|in))/i;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function sumTokens(t) {
  if (!isPlainObj(t)) return { in: 0, out: 0, cache: 0 };
  const c = isPlainObj(t.cache) ? t.cache : {};
  return { in: Math.trunc(num(t.input)), out: Math.trunc(num(t.output)), cache: Math.trunc(num(c.read)) + Math.trunc(num(c.write)) };
}

function cachePath(storageDir, id) {
  return storageDir ? path.join(storageDir, 'cache', `oc-${id}.json`) : null;
}

function readCache(f) {
  if (!f) return null;
  try {
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    return isPlainObj(v) && v.v === 1 ? v : null;
  } catch {
    return null;
  }
}

function writeCache(f, v) {
  if (!f) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(v));
  } catch {
  }
}

function summarize(id, session, messages, isActive, projectDir) {
  const s = {
    started: isoMs(num(session?.time?.created)),
    updated: isoMs(num(session?.time?.updated)),
    tools: 0,
    tokens: sumTokens(session?.tokens),
    events: [],
    lastKind: null,
    limit: null,
    files: [],
    todos: null,
    todosAt: null,
    todoSource: null,
    segs: [],
    stops: [],
    agentType: typeof session?.agent === 'string' && session.agent !== '' ? session.agent : 'build',
    title: typeof session?.title === 'string' ? session.title : '',
  };
  const delegations = [];
  const push = (t, kind, text, tool) => {
    if (t === '' || text === '') return;
    s.events.push({ t, kind, text, tool });
    if (s.events.length > EVENTS_KEEP) s.events.splice(0, s.events.length - EVENTS_KEEP);
  };
  let hasTool = false;
  let hasText = false;
  let finish = null;
  for (const m of messages) {
    if (!isPlainObj(m)) continue;
    if (m.type === 'user') {
      const t = typeof m.time?.created === 'number' ? isoMs(m.time.created) : '';
      if (typeof m.text === 'string' && phpTrim(m.text) !== '') {
        push(t, 'user', 'User instruction', null);
        s.lastKind = 'user';
      }
      continue;
    }
    if (m.type !== 'assistant') continue;
    if (typeof m.finish === 'string') finish = m.finish;
    if (m.error !== undefined && m.error !== null) {
      let es = '';
      try {
        es = JSON.stringify(m.error);
      } catch {
        es = String(m.error);
      }
      if (LIMIT_RE.test(es) && mbLen(es) < 400) s.limit = clip(redact(es), 200);
    }
    for (const p of values(m.content)) {
      if (!isPlainObj(p)) continue;
      if (p.type === 'text') {
        if (typeof p.text !== 'string' || phpTrim(p.text) === '') continue;
        hasText = true;
        if (LIMIT_RE.test(p.text) && mbLen(p.text) < 400) s.limit = clip(redact(p.text), 200);
        const t = typeof m.time?.created === 'number' ? isoMs(m.time.created) : '';
        push(t, 'text', safeLine(p.text, 180), null);
        s.lastKind = 'text';
      } else if (p.type === 'tool') {
        hasTool = true;
        s.tools += 1;
        const inp = isPlainObj(p.state?.input) ? p.state.input : {};
        const t = typeof p.time?.created === 'number' ? isoMs(p.time.created) : '';
        const [text, file] = describeTool(String(p.name || ''), inp, projectDir);
        if (file !== null && !s.files.includes(file)) {
          s.files.push(file);
          if (s.files.length > FILES_KEEP) s.files.splice(0, s.files.length - FILES_KEEP);
        }
        if (p.name === 'subagent') {
          const dg = {
            agent: typeof inp.agent === 'string' ? inp.agent : '',
            description: typeof inp.description === 'string' ? safeLine(inp.description, 140) : '',
            created: typeof p.time?.created === 'number' ? p.time.created : 0,
            child: null,
          };
          const st = p.state;
          if (isPlainObj(st) && Array.isArray(st.content)) {
            for (const c of st.content) {
              if (isPlainObj(c) && typeof c.text === 'string') {
                const m = /sessionID="(ses_[A-Za-z0-9]+)"/.exec(c.text);
                if (m) {
                  dg.child = m[1];
                  break;
                }
              }
            }
          }
          delegations.push(dg);
        }
        push(t, 'tool', text, String(p.name || ''));
        s.lastKind = 'tool';
      }
    }
  }
  if (hasTool) {
    s.limit = null;
    s.lastKind = 'tool';
  } else if (hasText) {
    s.lastKind = finish === 'stop' || (!isActive && finish !== 'tool-calls') ? 'final' : 'text';
  } else if (s.lastKind === null) {
    s.lastKind = 'thinking';
  }
  if (isActive && s.lastKind === 'final') s.lastKind = 'text';
  let maxEv = Date.parse(s.updated);
  for (const e of s.events) {
    const ms = Date.parse(e.t);
    if (Number.isFinite(ms) && ms > maxEv) maxEv = ms;
  }
  if (Number.isFinite(maxEv)) s.updated = isoMs(maxEv);
  const outcome = isActive ? null : session?.outcome;
  if (outcome === 'succeeded' || outcome === 'failed' || outcome === 'interrupted') s.lastKind = 'handback';
  if (outcome === 'failed' || outcome === 'interrupted') s.stops.push([id, s.updated]);
  s._times = [...new Set(s.events.map((e) => Date.parse(e.t)).filter((ms) => Number.isFinite(ms)))].sort((a, b) => a - b);
  return { s, delegations };
}

function buildSegs(s, cooldownMs) {
  const times = s._times || [];
  delete s._times;
  const segs = [];
  let start = null;
  let last = null;
  const flush = (open) => {
    if (start === null) return;
    segs.push([isoMs(start), open ? null : isoMs(last)]);
    if (segs.length > SEGS_KEEP) segs.splice(0, segs.length - SEGS_KEEP);
  };
  for (const ms of times) {
    if (start === null) {
      start = ms;
      last = ms;
    } else if (ms - last <= cooldownMs) {
      last = ms;
    } else {
      flush(false);
      start = ms;
      last = ms;
    }
  }
  flush(true); 
  if (segs.length === 0) segs.push([s.started, null]);
  s.segs = segs;
}

export async function scanSource({ projectDir, storageDir, cfg, nowSec }) {
  const empty = { exists: false, mains: [], runs: [] };
  let svc = getService(projectDir, storageDir);
  if (!svc) return empty;
  const get = async (p) => apiGet(svc, p);
  let projects;
  try {
    projects = await get('/api/project');
  } catch {
    svc = getService(projectDir, storageDir);
    if (!svc) return empty;
    try {
      projects = await apiGet(svc, '/api/project');
    } catch {
      return empty;
    }
  }
  const want = normDir(projectDir);
  // the service can hold several project rows with the same canonical path (re-init, re-clone, moved
  // checkout), and none of them is authoritative: `time.active` gets touched on any row, so ranking
  // by it picks the wrong one and silently hides every session of the newest row. union the
  // sessions of all matching rows instead, deduped by session id.
  const rows = (Array.isArray(projects) ? projects : []).filter((x) => isPlainObj(x) && normDir(x.canonical || '') === want);
  if (!rows.length) return empty;
  let parts = [];
  let active;
  try {
    for (const row of rows) {
      if (!row.id) continue;
      parts.push(await get(`/api/session?project=${encodeURIComponent(row.id)}&limit=${SESS_CAP}&order=desc`));
    }
    active = await get('/api/session/active');
  } catch {
    resetService();
    return empty;
  }
  const merged = new Map();
  for (const p of parts) for (const x of (Array.isArray(p?.data) ? p.data : [])) if (isPlainObj(x) && x.id) merged.set(x.id, x);
  const sessions = [...merged.values()];
  const running = new Set(isPlainObj(active?.data) ? Object.keys(active.data) : []);
  const cutoff = (nowSec - cfg.window_days * 86400) * 1000;
  const inWin = sessions.filter((x) => isPlainObj(x) && num(x.time?.created) >= cutoff);
  const byId = new Map(inWin.map((x) => [x.id, x]));
  const roots = inWin.filter((x) => !x.parentID).sort((a, b) => num(b.time?.updated) - num(a.time?.updated)).slice(0, cfg.mains_max);
  const kids = inWin.filter((x) => x.parentID).sort((a, b) => num(b.time?.created) - num(a.time?.created)).slice(0, SESS_CAP);
  const scope = [...roots, ...kids];
  const scopeIds = new Set(scope.map((x) => x.id));
  const rootOf = (x) => {
    let cur = x;
    const seen = new Set();
    while (cur && cur.parentID && byId.has(cur.parentID) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentID);
    }
    return cur && cur.id ? cur.id : x.id;
  };
  const sums = new Map(); 
  for (const x of scope) {
    const cf = cachePath(storageDir, x.id);
    const upd = num(x.time?.updated);
    const cached = readCache(cf);
    if (cached && cached.updated === upd && !running.has(x.id) && cached.scopeOk) {
      sums.set(x.id, { s: cached.s, delegations: cached.delegations || [] });
      continue;
    }
    let messages = [];
    try {
      const r = await get(`/api/session/${encodeURIComponent(x.id)}/message?order=desc&limit=${MSG_LIMIT}`);
      const got = Array.isArray(r?.data) ? r.data : [];
      messages = got.slice().reverse();
    } catch {
      if (cached) {
        sums.set(x.id, { s: cached.s, delegations: cached.delegations || [] });
        continue;
      }
      messages = [];
    }
    const { s, delegations } = summarize(x.id, x, messages, running.has(x.id), projectDir);
    buildSegs(s, cfg.cooldown * 1000);
    writeCache(cf, { v: 1, updated: upd, scopeOk: true, s, delegations });
    sums.set(x.id, { s, delegations });
  }
  const delegByParent = new Map();
  for (const [id, v] of sums) delegByParent.set(id, v.delegations);
  const exactDesc = new Map(); 
  for (const dl of delegByParent.values()) {
    for (const d of dl) if (d.child && d.description !== '') exactDesc.set(d.child, d.description);
  }
  const mains = [];
  for (const x of roots) {
    const v = sums.get(x.id);
    if (!v) continue;
    mains.push({ ...v.s, session: x.id });
  }
  const runs = [];
  for (const x of kids) {
    const v = sums.get(x.id);
    if (!v) continue;
    let desc = '';
    if (exactDesc.has(x.id)) {
      desc = exactDesc.get(x.id);
    } else {
      const dl = delegByParent.get(x.parentID) || [];
      const cands = dl.filter((d) => d.created <= num(x.time?.created));
      const same = cands.filter((d) => d.agent === (x.agent || ''));
      const pick = (same.length ? same : cands).sort((a, b) => b.created - a.created)[0];
      if (pick && pick.description !== '') desc = pick.description;
      else if (v.s.title !== '') desc = safeLine(oneLine(x.title || '', 140), 140);
    }
    runs.push({
      ...v.s,
      id: x.id,
      session: rootOf(x),
      agentType: v.s.agentType,
      description: desc,
      parentAgent: x.parentID && scopeIds.has(x.parentID) && byId.get(x.parentID)?.parentID ? x.parentID : (x.parentID || null),
      inactive: !running.has(x.id),
    });
  }
  const relAll = (list) => list.map((f) => {
    const n = normDir(f).replace(/^\/+/, '');
    const p = normDir(projectDir).replace(/^\/+/, '');
    if (n.startsWith(p + '/')) return f.slice(projectDir.length + 1).replace(/\\/g, '/');
    const b = f.split(/[/\\]/).pop();
    return b === '' ? f : b;
  });
  for (const m of [...mains, ...runs]) m.files = relAll(m.files).filter((f, i, a) => f !== '' && a.indexOf(f) === i).slice(-FILES_KEEP);
  return { exists: true, mains, runs };
}
