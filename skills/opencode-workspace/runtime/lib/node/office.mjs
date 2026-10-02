import path from 'node:path';
import { scanSource } from './source.mjs';
import { hash, isoMs, readText, phpTrim, strcmp, tsMs } from './util.mjs';

const VERSION = '1.0.0';

export async function buildState({ projectDir, storageDir, cfg, now }) {
  const nowSec = Math.floor(now / 1000);
  const scan = await scanSource({ projectDir, storageDir, cfg, nowSec });
  const RW = cfg.running_window * 1000;
  const CD = cfg.cooldown * 1000;
  const MA = cfg.main_active * 1000;

  const stops = new Map();
  for (const src of [...scan.mains, ...scan.runs]) {
    for (const [id, t] of src.stops) {
      if (!stops.has(id)) stops.set(id, []);
      stops.get(id).push(tsMs(t));
    }
  }

  const runs = [...scan.runs].sort((a, b) => cmp(tsMs(a.started), tsMs(b.started)) || strcmp(a.id, b.id));
  const byId = new Map();
  for (const r of runs) {
    const segs = r.segs.map(([a, b]) => ({ start: tsMs(a), startIso: a, end: b === null ? null : tsMs(b), endIso: b }));
    let status = r.limit ? 'limit' : 'done';
    let reason = null;
    const last = segs[segs.length - 1];
    if (last.end === null) {
      const st = (stops.get(r.id) ?? []).filter((ms) => ms >= last.start);
      const upd = tsMs(r.updated);
      if (st.length) {
        last.end = Math.min(...st);
        status = 'stopped';
        reason = 'userStopped';
      } else if (r.lastKind === 'handback' || r.limit) {
        last.end = upd;
        status = r.limit ? 'limit' : 'done';
      } else if (r.inactive) {
        last.end = upd;
        status = r.limit ? 'limit' : 'done';
      } else if (now - upd <= RW) {
        status = 'working';
      } else {
        last.end = upd + RW;
        status = 'stopped';
        reason = 'no-activity';
      }
      if (last.end !== null) last.endIso = isoMs(last.end);
    }
    r.effSegs = segs;
    r.status = status;
    r.reason = reason;
    byId.set(r.id, r);
  }

  const jobs = [];
  for (const r of runs) r.effSegs.forEach((sg, k) => jobs.push({ run: r, k, ...sg, who: null }));
  jobs.sort((a, b) => cmp(a.start, b.start) || strcmp(a.run.id, b.run.id) || cmp(a.k, b.k));
  const pool = cfg.team.map(() => ({ job: null }));
  const fl = [];
  const charOf = new Map();
  const free = (slot, start) => slot.job === null || (slot.job.end !== null && slot.job.end + CD <= start);
  for (const job of jobs) {
    const prev = charOf.get(job.run.id) ?? null;
    let pick = null;
    if (job.k > 0 && prev !== null) {
      const slot = prev.kind === 'pool' ? pool[prev.idx] : fl[prev.idx];
      if ((slot.job !== null && slot.job.run === job.run) || free(slot, job.start)) pick = prev;
    }
    if (pick === null) {
      const i = pool.findIndex((s) => free(s, job.start));
      if (i >= 0) pick = { kind: 'pool', idx: i, name: cfg.team[i] };
    }
    if (pick === null) {
      let j = fl.findIndex((s) => free(s, job.start));
      if (j < 0) {
        j = fl.length;
        fl.push({ job: null, name: null });
      }
      let name;
      if (prev !== null && prev.kind === 'fl') name = prev.name;
      else {
        const used = new Set(fl.filter((s) => !free(s, job.start)).map((s) => s.name));
        const L = cfg.freelancers.length;
        const base = hash(job.run.id) % L;
        name = null;
        for (let n = 0; n < L; n++) {
          const cand = cfg.freelancers[(base + n) % L];
          if (!used.has(cand)) {
            name = cand;
            break;
          }
        }
        if (name === null) name = `${cfg.freelancers[base]} ${j + 1}`;
      }
      pick = { kind: 'fl', idx: j, name };
    }
    if (pick.kind === 'pool') pool[pick.idx].job = job;
    else {
      fl[pick.idx].job = job;
      fl[pick.idx].name = pick.name;
    }
    job.who = pick;
    charOf.set(job.run.id, pick);
  }

  const leadColor = cfg.colors.lead;
  const flPal = cfg.colors.freelancers;
  const charInfo = (who, run) => (who.kind === 'pool'
    ? { key: `tim-${who.idx}`, name: cfg.team[who.idx], label: cfg.team[who.idx], color: cfg.colors.team[who.idx % cfg.colors.team.length] }
    : { key: `fl-${run.id}`, name: who.name, label: `Freelancer · ${who.name}`, color: flPal[hash(who.name) % flPal.length] });
  const jobState = (job) => (job.end === null ? 'working' : now - job.end < CD ? 'done' : 'idle');
  const task = (r) => (r.description !== '' ? r.description : r.agentType);
  const depthCache = new Map();
  const depthOf = (r) => {
    if (depthCache.has(r.id)) return depthCache.get(r.id);
    let d = 1;
    let cur = r;
    const seen = new Set([r.id]);
    while (cur.parentAgent !== null && byId.has(cur.parentAgent) && !seen.has(cur.parentAgent) && d < 50) {
      seen.add(cur.parentAgent);
      cur = byId.get(cur.parentAgent);
      d += 1;
    }
    depthCache.set(r.id, d);
    return d;
  };
  const parentOf = (r) => {
    const pid = r.parentAgent;
    if (pid !== null && byId.has(pid)) {
      const p = byId.get(pid);
      const who = charInfo(charOf.get(p.id), p);
      return { key: who.key, label: who.label };
    }
    return { key: 'lead', label: cfg.lead };
  };
  const runOut = (job) => {
    const r = job.run;
    const lastJob = r.effSegs.length - 1 === job.k;
    const par = parentOf(r);
    return {
      id: r.id,
      agent_type: r.agentType,
      task: task(r),
      stitle: r.title ? r.title : null,
      status: lastJob ? r.status : 'done',
      reason: lastJob ? r.reason : null,
      segment: job.k + 1,
      started: job.startIso,
      ended: job.end === null ? null : job.endIso,
      updated: r.updated,
      last: [...r.events].reverse().slice(0, 8),
      files: r.files.slice(-6),
      tools: r.tools,
      tokens: r.tokens,
      elapsedMs: (job.end === null ? now : job.end) - job.start,
      parent: par.label,
      parent_key: par.key,
      depth: depthOf(r),
    };
  };

  const team = pool.map((slot, i) => {
    const info = charInfo({ kind: 'pool', idx: i }, null);
    return { ...info, kind: 'team', slot: i, desk: i, state: slot.job ? jobState(slot.job) : 'idle', run: slot.job ? runOut(slot.job) : null };
  });
  const freelancers = [];
  fl.forEach((slot, j) => {
    if (slot.job === null) return;
    const st = jobState(slot.job);
    if (st === 'idle') return;
    const info = charInfo({ kind: 'fl', idx: j, name: slot.name }, slot.job.run);
    freelancers.push({ ...info, kind: 'freelancer', slot: j, desk: j < cfg.spare_desks ? j : null, state: st, run: runOut(slot.job) });
  });

  const kids = new Map();
  for (const r of runs) if (r.status === 'working') kids.set(r.session, (kids.get(r.session) ?? 0) + 1);
  const mains = scan.mains.filter((m) => m.updated !== null)
    .sort((a, b) => cmp(tsMs(b.updated), tsMs(a.updated)) || strcmp(a.session, b.session));
  const mainState = (m) => {
    const age = now - tsMs(m.updated);
    const k = kids.get(m.session) ?? 0;
    if (m.lastKind !== 'final' && age <= MA) return ['working', 'active'];
    if (m.lastKind === 'tool' && age <= RW) return ['working', 'tool'];
    if (k > 0) return ['working', 'waiting-team'];
    if (m.lastKind === 'final' && age < CD) return ['done', null];
    return ['idle', null];
  };
  const states = mains.map(mainState);
  let di = states.findIndex((s) => s[0] === 'working');
  if (di < 0) di = mains.length ? 0 : -1;
  const dm = di >= 0 ? mains[di] : null;
  const activeMains = states.filter((s) => s[0] === 'working').length;
  const lead = {
    key: 'lead', name: cfg.lead, label: cfg.lead, role: 'Lead', kind: 'lead', color: leadColor,
    state: dm ? states[di][0] : 'idle',
    activity: dm ? states[di][1] : null,
    session: dm ? dm.session.slice(0, 8) : null,
    stitle: dm && dm.title ? dm.title : null,
    updated: dm ? dm.updated : null,
    last: dm ? [...dm.events].reverse().filter((e) => e.kind !== 'text' && e.tool !== 'subagent').slice(0, 8) : [],
    tools: dm ? dm.tools : 0,
    tokens: dm ? dm.tokens : 0,
    waiting_on: dm ? kids.get(dm.session) ?? 0 : 0,
    other_sessions: Math.max(0, activeMains - (dm && states[di][0] === 'working' ? 1 : 0)),
    sessions: mains.length,
    todos: dm && dm.todos !== null ? { items: dm.todos, at: dm.todosAt, source: dm.todoSource } : null,
  };

  const K = { key: 'lead', name: cfg.lead, label: cfg.lead, color: leadColor };
  const feed = [];
  const add = (t, ms, who, kind, text, tool, extra) => feed.push({ ms, e: { t, who: who.key, name: who.label, color: who.color, kind, text, tool, ...(extra ?? {}) } });
  for (const m of mains) {
    for (const e of m.events) {
      if (e.kind === 'text' || e.tool === 'subagent') continue;
      add(e.t, tsMs(e.t), K, e.kind, e.text, e.tool);
    }
  }
  for (const job of jobs) {
    const r = job.run;
    const who = charInfo(job.who, r);
    if (job.k === 0) {
      const parent = r.parentAgent !== null && byId.has(r.parentAgent) ? byId.get(r.parentAgent) : null;
      const req = parent !== null ? charInfo(charOf.get(parent.id), parent) : K;
      add(job.startIso, job.start, req, 'assign', `${req.label} asked ${who.label}: ${task(r)}`, null);
    } else {
      add(job.startIso, job.start, who, 'resume', `${who.label} continued: ${task(r)}`, null);
    }
    if (job.end !== null && job.end <= now) {
      const lastJob = r.effSegs.length - 1 === job.k;
      let text = `${who.label} done: ${task(r)}`;
      if (lastJob && r.status === 'limit') text = `${who.label} paused — usage limit`;
      else if (lastJob && r.reason === 'userStopped') text = `${who.label} stopped: ${task(r)}`;
      else if (lastJob && r.reason === 'no-activity') text = `${who.label} stopped — no activity for ${Math.round(cfg.running_window / 60)} min`;
      add(job.endIso, job.end, who, 'done', text, null, { status: r.status, reason: r.reason });
    }
  }
  const jobsOf = new Map();
  for (const job of jobs) {
    if (!jobsOf.has(job.run.id)) jobsOf.set(job.run.id, []);
    jobsOf.get(job.run.id).push(job);
  }
  for (const r of runs) {
    const js = jobsOf.get(r.id) ?? [];
    for (const e of r.events) {
      const ms = tsMs(e.t);
      let job = js[0];
      for (const j of js) if (j.start <= ms) job = j;
      add(e.t, ms, charInfo(job.who, r), e.kind, e.text, e.tool);
    }
  }
  const order = feed.map((f, i) => [f, i]);
  order.sort((a, b) => cmp(b[0].ms, a[0].ms) || cmp(a[1], b[1]));
  const LIFE = new Set(['assign', 'resume', 'done']);
  const life = order.filter((x) => LIFE.has(x[0].e.kind)).slice(0, 60);
  const acts = order.filter((x) => !LIFE.has(x[0].e.kind)).slice(0, 120);
  const merged = [...life, ...acts].sort((a, b) => cmp(b[0].ms, a[0].ms) || cmp(a[1], b[1]));

  const hist = [...runs].sort((a, b) => cmp(tsMs(b.started), tsMs(a.started)) || strcmp(a.id, b.id)).slice(0, 40).map((r) => {
    const js = jobsOf.get(r.id);
    const job = js[js.length - 1];
    const who = charInfo(job.who, r);
    const par = parentOf(r);
    return {
      id: r.id, who: who.key, name: who.name, label: who.label, color: who.color, kind: job.who.kind === 'pool' ? 'team' : 'freelancer',
      agent_type: r.agentType, task: task(r), stitle: r.title ? r.title : null, inactive: !!r.inactive, status: r.status, reason: r.reason,
      started: r.started, ended: job.end === null ? null : job.endIso,
      elapsedMs: (job.end === null ? now : job.end) - tsMs(r.started),
      parent: par.label, parent_key: par.key, depth: depthOf(r), tools: r.tools,
    };
  });
  const recent = runs.filter((r) => now - tsMs(r.started) <= 48 * 3600 * 1000).map((r) => r.started);

  return {
    app: 'opencode-workspace',
    version: VERSION,
    now: isoMs(now),
    project: cfg.title,
    names: [cfg.lead, ...cfg.team].join('|'),
    transcripts: scan.exists,
    lead,
    team,
    freelancers,
    feed: merged.map((x) => x[0].e),
    runs: hist,
    stats: {
      active: runs.filter((r) => r.status === 'working').length,
      freelancers: freelancers.filter((f) => f.state === 'working').length,
      total: runs.length,
      recent_starts: recent,
      sessions_active: activeMains,
    },
    spare_desks: cfg.spare_desks,
    public_url: null,
  };
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
