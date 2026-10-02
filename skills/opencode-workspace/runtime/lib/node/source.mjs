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
// Cache schema version. Bumped to 2 when delegation records started carrying a child session id:
// a `v: 1` cache holds records whose `child` is always null, and an inactive session is never
// re-summarised, so those wrong records would otherwise persist for the whole window.
const CACHE_V = 2;
// A rendered subagent tool text carries the child session id in one of two shapes: the quoted
// `<subagent sessionID="ses_…">` completion envelope, and the unquoted
// `… (sessionID: ses_…)` background notice. The structured `state.metadata.sessionID` field is
// preferred, this regex is only the fallback for builds that do not send it.
const SES_IN_TEXT = /sessionID(?:=|:\s*)(ses_[A-Za-z0-9]+)/;

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
    return isPlainObj(v) && v.v === CACHE_V ? v : null;
  } catch {
    return null;
  }
}

function writeCache(f, v) {
  if (!f) return;
  try {
    // The per-session cache holds task text, tool inputs and relative paths, so it is kept
    // owner-only: 0700 for a directory this call creates, 0600 for the file. `mkdir` only applies
    // the mode to directories it creates itself, so an existing shared parent such as `~/.cache`
    // is never re-permissioned; the explicit chmod covers a file an older release created with a
    // looser mode. Both modes are POSIX-only and Windows largely ignores them.
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, JSON.stringify(v), { mode: 0o600 });
    fs.chmodSync(f, 0o600);
  } catch {
  }
}

// Child session id recorded by a subagent tool call, or null. The structured field wins; the
// rendered text is only consulted when it is absent, and the summarizing session's own id is
// never accepted, because a subagent report may quote the parent's session id back.
function childIdOf(state, selfId) {
  if (!isPlainObj(state)) return null;
  const md = state.metadata;
  if (isPlainObj(md) && typeof md.sessionID === 'string' && md.sessionID.startsWith('ses_')) {
    return md.sessionID === selfId ? null : md.sessionID;
  }
  if (Array.isArray(state.content)) {
    for (const c of state.content) {
      if (!isPlainObj(c) || typeof c.text !== 'string') continue;
      const m = SES_IN_TEXT.exec(c.text);
      if (m) return m[1] === selfId ? null : m[1];
    }
  }
  return null;
}

function summarize(id, session, messages, isActive, projectDir) {
  // `agent` and `title` are LLM-written summaries of the user's own prompt, which makes them the
  // most likely place for a pasted credential, so both are redacted on the way into the summary.
  // `agentType` falls back to 'build' exactly as before when it is missing or empties out.
  const rawAgent = typeof session?.agent === 'string' && session.agent !== '' ? session.agent : 'build';
  const agentType = redact(rawAgent);
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
    agentType: agentType !== '' ? agentType : 'build',
    title: typeof session?.title === 'string' ? redact(session.title) : '',
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
    // A finished subagent is recorded as a `synthetic` message carrying `metadata.source =
    // 'subagent'`, `metadata.childID` and a top-level `description`. These are collected as
    // delegation records too, because the 200-message window keeps the LATEST messages: a long
    // running subagent pushes its originating tool part out of the window while the completion
    // record stays. Field names and the description are normalised to match the tool-part record
    // exactly, so the two sources are interchangeable.
    if (m.type === 'synthetic') {
      const md = isPlainObj(m.metadata) ? m.metadata : null;
      if (md && md.source === 'subagent' && typeof md.childID === 'string' && md.childID.startsWith('ses_')) {
        delegations.push({
          agent: typeof md.agent === 'string' ? md.agent : '',
          description: typeof m.description === 'string' ? safeLine(m.description, 140) : '',
          created: typeof m.time?.created === 'number' ? m.time.created : 0,
          child: md.childID === id ? null : md.childID,
        });
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
        // `describeTool` already redacts the path; redaction here is idempotent and keeps the
        // invariant local: nothing reaches `s.files` without passing through `redact`.
        if (file !== null && !s.files.includes(file)) {
          s.files.push(redact(file));
          if (s.files.length > FILES_KEEP) s.files.splice(0, s.files.length - FILES_KEEP);
        }
        if (p.name === 'subagent') {
          const dg = {
            agent: typeof inp.agent === 'string' ? inp.agent : '',
            description: typeof inp.description === 'string' ? safeLine(inp.description, 140) : '',
            created: typeof p.time?.created === 'number' ? p.time.created : 0,
            child: childIdOf(p.state, id),
          };
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
  // /api/project returns a bare array today; accept a {data:…} envelope too so a future
  // change of shape shows up as an empty dashboard rather than a silent one.
  const rows = (Array.isArray(projects) ? projects : values(projects)).filter((x) => isPlainObj(x) && normDir(x.canonical || '') === want);
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
    writeCache(cf, { v: CACHE_V, updated: upd, scopeOk: true, s, delegations });
    sums.set(x.id, { s, delegations });
  }
  const delegByParent = new Map();
  for (const [id, v] of sums) delegByParent.set(id, v.delegations);
  // Exact child-id -> description map, plus the set of delegation records already claimed by an
  // exact match. The claim set is what keeps the mapping 1:1: without it, several children whose
  // session id is not recoverable all fell through to the positional heuristic below and were
  // handed the SAME most recent delegation, which is why every running subagent rendered with the
  // same title. A record claimed here is also removed from the positional pool below.
  const exactDesc = new Map();
  const claimedDel = new Map();
  for (const [pid, dl] of delegByParent) {
    const used = new Set();
    claimedDel.set(pid, used);
    for (let i = 0; i < dl.length; i += 1) {
      const d = dl[i];
      if (d.child && d.description !== '') {
        exactDesc.set(d.child, d.description);
        used.add(i);
      }
    }
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
      // Positional fallback for a child whose id was not recoverable. Still 1:1: `kids` is walked
      // in creation order and each delegation record is consumed at most once per parent, so no
      // two children can end up with the same description. Ties break on the record's index in
      // `delegations`, which is message order and therefore identical in both runtimes.
      const dl = delegByParent.get(x.parentID) || [];
      let used = claimedDel.get(x.parentID);
      if (used === undefined) {
        used = new Set();
        claimedDel.set(x.parentID, used);
      }
      const cands = [];
      for (let i = 0; i < dl.length; i += 1) {
        if (!used.has(i) && dl[i].created <= num(x.time?.created)) cands.push(i);
      }
      const same = cands.filter((i) => dl[i].agent === (x.agent || ''));
      const pool = same.length ? same : cands;
      pool.sort((a, b) => dl[b].created - dl[a].created || a - b);
      const pick = pool[0];
      if (pick !== undefined) {
        used.add(pick);
        if (dl[pick].description !== '') desc = dl[pick].description;
      }
      if (desc === '' && v.s.title !== '') desc = safeLine(oneLine(x.title || '', 140), 140);
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
