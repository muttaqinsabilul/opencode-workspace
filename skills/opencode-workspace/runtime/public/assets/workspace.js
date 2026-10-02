(function () {
'use strict';

const API = '/workspace/api/state';
const POLL_MS = 1000;
const CFG = window.WORKSPACE || {};
const TEAM_NAMES = Array.isArray(CFG.team) && CFG.team.length === 4 ? CFG.team : ['Alex', 'Mia', 'Leo', 'Emma'];
const LEAD_NAME = typeof CFG.lead === 'string' ? CFG.lead : 'Jack';
const COLORS = CFG.colors || {
  lead: '#4f46e5',
  team: ['#ea580c', '#0ea5e9', '#2563eb', '#db2777'],
  freelancers: ['#0891b2', '#ca8a04', '#16a34a', '#9333ea', '#0284c7', '#ea580c'],
};
const SPARE = Math.max(0, Math.min(4, Number(CFG.spare_desks) || 4));

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtHm = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtNum = new Intl.NumberFormat('en-US');
const hhmmss = (iso) => (iso ? fmtTime.format(new Date(iso)).replace(/\./g, ':') : '');
const hhmm = (iso) => (iso ? fmtHm.format(new Date(iso)).replace(/\./g, ':') : '');
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDate.format(new Date(iso));
};
const dur = (a, b) => {
  const s = Math.max(0, ((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)} sec`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} m`;
};
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} sec`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} min ${r} sec` : `${m} min`;
  }
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} m`;
};
const runDur = (r) => (r && typeof r.elapsedMs === 'number' ? fmtElapsed(r.elapsedMs) : dur(r.started, r.ended));
const clip = (s, n) => { const a = Array.from(String(s ?? '')); return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join(''); };
const initial = (s) => Array.from(String(s || '?'))[0].toUpperCase();
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const FEED_CATS = {
  all: () => true,
  text: (e) => e.kind === 'text' || e.kind === 'user',
  tool: (e) => e.kind === 'tool',
  ask: (e) => e.kind === 'assign' || e.kind === 'resume',
  done: (e) => e.kind === 'done',
};
let feedCat = 'all';
try {
  const v = localStorage.getItem('workspace.feedCat');
  if (v && FEED_CATS[v]) feedCat = v;
} catch (_) {}
function feedMatch(e) {
  const f = FEED_CATS[feedCat] || FEED_CATS.all;
  try {
    return !!f(e);
  } catch (_) {
    return true;
  }
}
function syncFeedFilter() {
  const box = document.getElementById('feedFilter');
  if (!box) return;
  const btns = box.querySelectorAll('[data-fcat]');
  for (const b of btns) {
    b.setAttribute('aria-pressed', String(b.dataset.fcat === feedCat));
  }
}

/* right-hand panel has two tabs: subagent + activity */
let panelTab = 'agents';
try {
  const v = localStorage.getItem('workspace.tab');
  if (v === 'agents' || v === 'activity') panelTab = v;
} catch (_) {}
function selectTab(name, remember = true) {
  if (name !== 'agents' && name !== 'activity') return;
  panelTab = name;
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('on', p.dataset.pane === name));
  if (remember) {
    try { localStorage.setItem('workspace.tab', name); } catch (_) {}
  }
}

const STATE_UI = {
  working: { label: 'Working', css: '#1f9d57' },
  done: { label: 'Done', css: '#0f7f8f' },
  idle: { label: 'Idle', css: '#8a8378' },
};
const RUN_UI = {
  working: { label: 'Working', css: '#1f9d57' },
  done: { label: 'Done', css: '#0f7f8f' },
  stopped: { label: 'Stopped', css: '#c46a1c' },
  userStopped: { label: 'Stopped', css: '#c46a1c' },
  'no-activity': { label: 'Inactive', css: '#8a8378' },
  limit: { label: 'Limit', css: '#c43d3d' },
};
function runUi(r) {
  if (!r) return RUN_UI.done;
  if (r.status === 'stopped' && r.reason === 'no-activity') return RUN_UI['no-activity'];
  if (r.status === 'stopped' && r.reason === 'userStopped') return RUN_UI.userStopped;
  return RUN_UI[r.status] || RUN_UI.done;
}

function drawRoundRect(ctx, x, y, w, h, r) {
  if (r === undefined) r = 0;
  if (typeof r === 'number') {
    const maxR = Math.min(Math.abs(w) / 2, Math.abs(h) / 2);
    r = Math.min(r, maxR);
    r = [r, r, r, r];
  } else if (Array.isArray(r)) {
    if (r.length === 1) r = [r[0], r[0], r[0], r[0]];
    else if (r.length === 2) r = [r[0], r[1], r[0], r[1]];
  } else {
    r = [0, 0, 0, 0];
  }
  const maxR = Math.min(Math.abs(w) / 2, Math.abs(h) / 2);
  const tl = Math.min(r[0] || 0, maxR);
  const tr = Math.min(r[1] || 0, maxR);
  const br = Math.min(r[2] || 0, maxR);
  const bl = Math.min(r[3] || 0, maxR);

  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  ctx.lineTo(x + bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
  ctx.lineTo(x, y + tl);
  ctx.quadraticCurveTo(x, y, x + tl, y);
  ctx.closePath();
}

const TILE = 32;
const MAP_WIDTH = 1290;
const MAP_HEIGHT = 876;
const OUT_X = 1016;              // east wall edge — everything right of it is outside the building
const WALK_YARD_X = OUT_X + 124; // pavement side, the food stall stands here

// Studio Utama: top row y=250 (chairs y=310), bottom row y=400 (chairs y=460)
const DESK_POS = {
  A0: { gx: 12.875, gy: 9.6875, dir: 'up', label: 'You' },
  A3: { gx: 16.5, gy: 9.6875, dir: 'up', label: 'Leo' },
  A4: { gx: 20.125, gy: 9.6875, dir: 'up', label: 'Emma' },
  A1: { gx: 14.6875, gy: 14.375, dir: 'up', label: 'Alex' },
  A2: { gx: 18.3125, gy: 14.375, dir: 'up', label: 'Mia' },
  // Studio CX: top row y=200 (chairs y=250), bottom y=270 (chairs y=320)
  B0: { gx: 25.875, gy: 7.8125, dir: 'up', label: 'Spare 1' },
  B1: { gx: 29.0, gy: 7.8125, dir: 'up', label: 'Spare 2' },
  B2: { gx: 25.875, gy: 10.0, dir: 'up', label: 'Spare 3' },
  B3: { gx: 29.0, gy: 10.0, dir: 'up', label: 'Spare 4' },
};

const DOOR_ENTRANCE = { gx: 4.4, gy: 21.4 };

const host = $('scene');
const canvas = document.createElement('canvas');
canvas.style.display = 'block';
canvas.style.touchAction = 'none';
canvas.style.imageRendering = 'auto';
host.appendChild(canvas);
const ctx = canvas.getContext('2d');
if (!ctx) document.body.classList.add('nogl-on');

const DPR = Math.min(window.devicePixelRatio || 1, 2);
let viewW = 0;
let viewH = 0;

const cam = {
  x: MAP_WIDTH / 2,
  y: MAP_HEIGHT / 2,
  zoom: 1.0,
  targetZoom: 1.0,
  minZoom: 0.45,
  maxZoom: 1.4,
  locked: false,
  fitZoom: 1.0,
  userZoom: false,
};
let dragging = false;
let dragStart = { x: 0, y: 0 };
let camStart = { x: 0, y: 0 };
const pointers = new Map();
let pinchDist = 0;
let skipClick = false;

function screenToWorld(sx, sy) {
  return {
    wx: (sx - viewW / 2) / cam.zoom + cam.x,
    wy: (sy - viewH / 2) / cam.zoom + cam.y,
  };
}
function worldToScreen(wx, wy) {
  return {
    sx: (wx - cam.x) * cam.zoom + viewW / 2,
    sy: (wy - cam.y) * cam.zoom + viewH / 2,
  };
}

function makeActor(key, name, role, color, deskId, spriteVariant, defaultGx, defaultGy, defaultDir, badge) {
  const desk = DESK_POS[deskId] || DESK_POS.A0;
  const initGx = defaultGx !== undefined ? defaultGx : desk.gx;
  const initGy = defaultGy !== undefined ? defaultGy : desk.gy;
  const initDir = defaultDir || desk.dir;
  const initBadge = badge !== undefined ? badge : name;

  return {
    key,
    name,
    role,
    color,
    deskId,
    spriteVariant: spriteVariant || 0,
    gx: initGx,
    gy: initGy,
    dir: initDir,
    goalX: initGx,
    goalY: initGy,
    goalDir: initDir,
    walking: false,
    walkTime: 0,
    isSitting: true,
    route: null,
    poi: null,
    poiNode: null,
    dwellUntil: 0,
    activity: 'idle',
    work: false,
    idleNext: performance.now() + Math.random() * 4000,
    leaving: false,
    gone: false,
    bubble: null,
    bubbleTime: 0,
    data: null,
    badgeText: initBadge,
    badgeDefault: initBadge,
  };
}

const LEAD = makeActor('lead', LEAD_NAME, 'Lead', COLORS.lead, 'A0', 0, 12.875, 9.6875, 'up', LEAD_NAME);
const ALEX = makeActor('team-0', TEAM_NAMES[0], 'Team', COLORS.team[0], 'A1', 1, 14.6875, 14.375, 'up');
const MIA = makeActor('team-1', TEAM_NAMES[1], 'Team', COLORS.team[1], 'A2', 2, 18.3125, 14.375, 'up');
const LEO = makeActor('team-2', TEAM_NAMES[2], 'Team', COLORS.team[2], 'A3', 1, 16.5, 9.6875, 'up');

const actors = new Map();
actors.set('lead', LEAD);
actors.set('team-0', ALEX);
actors.set('team-1', MIA);
actors.set('team-2', LEO);

function showBubble(actor, text, durationMs = 4500) {
  actor.bubble = text;
  actor.bubbleTime = performance.now() + durationMs;
}

const short8 = (s) => String(s ?? '').slice(0, 8);
function workBadge(actor, suffix) {
  if (actor.badgeDefault === undefined) actor.badgeDefault = actor.badgeText;
  const next = suffix ? `${actor.badgeDefault} · ${suffix}` : actor.badgeDefault;
  if (actor.badgeText !== next) actor.badgeText = next;
}
function workBubble(actor, text) {
  if (actor.bubble !== text) actor.bubble = text;
  actor.bubbleTime = Infinity;
}
function clearWorkLabel(actor) {
  if (actor.badgeDefault !== undefined && actor.badgeText !== actor.badgeDefault) actor.badgeText = actor.badgeDefault;
  if (actor.bubbleTime === Infinity) {
    actor.bubble = null;
    actor.bubbleTime = 0;
  }
}
function syncName(a, name) {
  if (!name || a.badgeDefault === name) return;
  a.name = name;
  a.badgeDefault = name;
  if (!a.work) a.badgeText = name;
}

const CHATTER_LINES = [
  'Refactoring component...',
  'All tests passing! 100% 🎉',
  '☕ Coffee break?',
  'Pushing to staging...',
  'Bug on line 42 🧐',
  'Code review approved! 👍',
  'Pixel art UI looks neat! 🎨',
  'Syncing workspace data...',
];

const CHAT_LINES = [
  '☕ coffee first...',
  'the soup was good, I tell you!',
  'what to watch later?',
  'please review my PR 🙏',
  'staging all green!',
  '...',
  "let's go, keep moving!",
  'praying first, ok? 🙃',
];

const WANDER_MIN_X = 4.2, WANDER_MAX_X = 38, WANDER_MIN_Y = 2.4, WANDER_MAX_Y = 26.4;

const WALK_NODES = {
  // west corridor (backbone): x = 10.0 (px 320),
  hallN: { x: 10.0, y: 1.4 }, hallA: { x: 10.0, y: 5.4 }, hallB: { x: 10.0, y: 14.2 },
  hallC: { x: 10.0, y: 21.9 }, hallD: { x: 10.0, y: 25.8 },
  // east corridor: x = 23.3 (px 746)
  eastN: { x: 23.3, y: 1.4 }, eastCX: { x: 23.3, y: 5.4 }, eastGar: { x: 23.3, y: 14.4 },
  eastSan: { x: 23.3, y: 25.6 },
  // outer door (wall x=110, opening y 660..710)
  door: { x: 2.6, y: 21.4 }, doorE2: { x: 4.6, y: 22.6 },
  // west rooms: musolla, nonton tv, warung kopi
  musD: { x: 8.4, y: 5.4 }, musP: { x: 6.5, y: 6.6 },
  tvD: { x: 8.4, y: 14.2 }, tvP: { x: 6.5, y: 16.4 },
  warD: { x: 8.4, y: 22.6 }, warP: { x: 6.6, y: 24.8 },
  // studio utama: path between desk rows
  stW: { x: 11.0, y: 7.0 }, stN: { x: 13.5, y: 7.0 }, stY: { x: 22.0, y: 7.0 },
  stS: { x: 11.0, y: 11.0 }, stX: { x: 22.0, y: 11.0 }, stDown: { x: 13.75, y: 19.8 },
  // studio cx
  cxTop: { x: 27.4, y: 5.6 }, cxMid: { x: 27.4, y: 10.25 },
  // east door + food-stall yard (outside the building)
  eastDoor: { x: 32.3, y: 14.2 }, bakFront: { x: 33.6, y: 16.4 },
  // ruang santai + ping pong
  san: { x: 27.4, y: 23.6 },
  ppM: { x: 17.6, y: 24.7 }, ppW: { x: 12.5, y: 24.7 },
};
const WALK_EDGES = [
  ['hallN', 'hallA'], ['hallA', 'hallB'], ['hallB', 'hallC'], ['hallC', 'hallD'],
  ['hallA', 'musD'], ['musD', 'musP'],
  ['hallB', 'tvD'], ['tvD', 'tvP'],
  ['hallC', 'warD'], ['warD', 'warP'],
  ['warD', 'doorE2'], ['doorE2', 'door'], ['door', 'gardenX'],
  ['hallB', 'stW'], ['stW', 'stN'], ['stN', 'stY'], ['stY', 'stX'],
  ['stW', 'stS'], ['stS', 'stX'], ['stS', 'stDown'],
  ['stY', 'eastCX'], ['stX', 'eastGar'], ['eastN', 'eastCX'],
  ['eastCX', 'eastGar'], ['eastGar', 'eastSan'],
  ['eastCX', 'cxTop'], ['cxTop', 'cxMid'],
  ['eastGar', 'eastDoor'], ['eastDoor', 'bakFront'],
  ['eastSan', 'san'], ['eastSan', 'ppM'],
  ['hallC', 'ppW'], ['ppW', 'ppM'],
];
const WALK_ADJ = {};
for (const [a, b] of WALK_EDGES) {
  (WALK_ADJ[a] = WALK_ADJ[a] || []).push(b);
  (WALK_ADJ[b] = WALK_ADJ[b] || []).push(a);
}
function nearestNode(x, y) {
  let best = 'hallN'; let bd = Infinity;
  for (const id in WALK_NODES) {
    const n = WALK_NODES[id];
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}
function findPath(from, to) {
  if (from === to) return [];
  const prev = { [from]: null };
  const q = [from];
  while (q.length) {
    const cur = q.shift();
    for (const nx of WALK_ADJ[cur] || []) {
      if (!(nx in prev)) {
        prev[nx] = cur;
        if (nx === to) {
          const path = [nx];
          let p = cur;
          while (p !== from && p !== null) { path.unshift(p); p = prev[p]; }
          return path;
        }
        q.push(nx);
      }
    }
  }
  return [];
}
const POIS = [
  { x: 6.5, y: 6.6, dir: 'up', act: 'quick prayer...', dwell: 7000, node: 'musP' },
  { x: 6.5, y: 16.4, dir: 'up', act: 'watching a new film...', dwell: 9000, node: 'tvP' },
  { x: 6.6, y: 24.8, dir: 'up', act: 'coffee first...', dwell: 6000, node: 'warP' },
  { x: 17.6, y: 24.7, dir: 'up', act: "one more round...", dwell: 7000, node: 'ppM' },
  { x: 12.5, y: 24.7, dir: 'up', act: 'wild ball!', dwell: 6000, node: 'ppW' },
  { x: 27.4, y: 23.6, dir: 'up', act: 'lying down for a sec...', dwell: 9000, node: 'san', sit: true },
  { x: 33.6, y: 17.3, dir: 'up', act: 'meatball soup, please!', dwell: 7000, node: 'bakP' },
  { x: 27.4, y: 10.25, dir: 'up', act: 'light chat...', dwell: 6000, node: 'cxMid' },
  { x: 2.4, y: 21.4, dir: 'right', act: 'fresh air out here...', dwell: 6000, node: 'gardenX' },
];
for (const p of POIS) WALK_NODES[p.node] = { x: p.x, y: p.y };

/* One point = one agent. Without this two agents could stand on the same spot
   (e.g. both in the musolla) and look like one doubled-up character. */
const POI_CLAIM = new Map();
function claimFree(a) {
  for (const p of POIS) {
    const owner = POI_CLAIM.get(p.node);
    if (owner && owner !== a.key) continue;
    POI_CLAIM.set(p.node, a.key);
    return p;
  }
  return null;
}
function releasePoi(a) {
  if (a.poiNode && POI_CLAIM.get(a.poiNode) === a.key) POI_CLAIM.delete(a.poiNode);
  a.poiNode = null;
  a.poi = null;
}
function crowdedAt(a, minDist = 0.42) {
  for (const b of actors.values()) {
    if (b === a || b.gone) continue;
    if (Math.hypot(b.gx - a.gx, b.gy - a.gy) < minDist) return true;
  }
  return false;
}

function arrivePoi(a, now) {
  const p = a.poi;
  a.poi = null;
  if (!p) return;
  a.goalX = p.x; a.goalY = p.y;
  a.goalDir = p.dir; a.dir = p.dir;
  a.isSitting = !!p.sit;
  a.dwellUntil = now + p.dwell;
  a.idleNext = a.dwellUntil;
  if (p.act) showBubble(a, p.act, 3500);
}

let lastChatter = performance.now();
function updateChatter(now) {
  if (now - lastChatter < 5000) return;
  lastChatter = now;
  const list = [...actors.values()].filter(a => !a.gone && !a.work);
  if (list.length === 0) return;
  const a = pickOne(list);
  if (!a.bubble || now > a.bubbleTime) {
    showBubble(a, pickOne(a.walking ? CHATTER_LINES : CHAT_LINES), 3500);
  }
}

function wanderStep(a, now) {
  if (a.gone || a.work) return;
  if (a.walking) return;
  if (a.route && a.route.length) return;
  if (a.dwellUntil && now < a.dwellUntil) return;
  if (now < (a.idleNext || 0)) return;
  if (Math.random() < 0.6) {
    const p = claimFree(a);
    if (p) {
      const path = findPath(nearestNode(a.gx, a.gy), p.node);
      a.route = path.map((id) => ({ x: WALK_NODES[id].x, y: WALK_NODES[id].y }));
      a.poi = p;
      a.poiNode = p.node;
      if (!a.route.length) { arrivePoi(a, now); return; }
      a.isSitting = false;
      a.idleNext = Infinity;
      return;
    }
  }
  releasePoi(a);
  const rx = (Math.random() * 6 - 3);
  const ry = (Math.random() * 6 - 3);
  a.goalX = clamp(a.gx + rx, WANDER_MIN_X, WANDER_MAX_X);
  a.goalY = clamp(a.gy + ry, WANDER_MIN_Y, WANDER_MAX_Y);
  a.goalDir = a.dir;
  a.isSitting = false;
  a.idleNext = now + 6000 + Math.random() * 7000;
  if (crowdedAt(a)) a.idleNext = Math.min(a.idleNext, now + 1200);
  if (Math.random() < 0.35) showBubble(a, pickOne(CHAT_LINES), 3000);
}

function updateActor(a, dt) {
  if (a.gone) return;

  if (a.route && a.route.length && !a.work) {
    const wp = a.route[0];
    a.goalX = wp.x;
    a.goalY = wp.y;
    if (Math.hypot(wp.x - a.gx, wp.y - a.gy) < 0.12) {
      a.route.shift();
      if (!a.route.length) arrivePoi(a, performance.now());
    }
  }

  const dx = a.goalX - a.gx;
  const dy = a.goalY - a.gy;
  const dist = Math.hypot(dx, dy);

  if (dist > 0.05) {
    a.walking = true;
    a.isSitting = false;
    a.walkTime += dt * 8;
    const speed = 3.6 * dt;
    const move = Math.min(dist, speed);
    a.gx += (dx / dist) * move;
    a.gy += (dy / dist) * move;

    if (Math.abs(dx) > Math.abs(dy)) {
      a.dir = dx > 0 ? 'right' : 'left';
    } else {
      a.dir = dy > 0 ? 'down' : 'up';
    }
  } else {
    a.gx = a.goalX;
    a.gy = a.goalY;
    a.dir = a.goalDir || a.dir;
    a.walking = false;
    if (a.work) {
      a.isSitting = true;
    } else {
      a.isSitting = false;
      if (!a.idleNext || a.idleNext === Infinity) a.idleNext = performance.now() + 2000 + Math.random() * 3000;
    }
  }
}

function setActorDestination(a, gx, gy, dir, isWork) {
  a.work = !!isWork;
  a.leaving = false;
  a.gone = false;
  a.route = null;
  releasePoi(a);
  a.dwellUntil = 0;
  if (isWork) {
    a.goalX = gx;
    a.goalY = gy;
    a.goalDir = dir;
    a.isSitting = true;
    a.idleNext = Infinity;
  } else {
    a.isSitting = false;
    const same = Math.hypot(a.goalX - gx, a.goalY - gy) < 0.2;
    a.goalX = gx;
    a.goalY = gy;
    a.goalDir = dir;
    a.idleNext = performance.now() + (same ? 500 : 1500);
  }
}

const PAL = {
  grassLight: '#b5e87a',
  grassMid: '#9cd762',
  grassTuft: '#53ae79', 
  treeBark: '#f8fafc',
  treeBarkDark: '#cbd5e1',
  treeLeaf1: '#7fd65c',
  treeLeaf2: '#56b83b',
  treeLeaf3: '#369324',
  curb: '#7d8fa3',

  wallTop: '#b3c2c7',
  wallFront: '#6f748f',
  wallDivider: '#414d5e',
  wallOutline: '#2d3748',
  windowCyan: '#a5f3fc',
  windowFrame: '#475569',

  woodBeige1: '#f0e4d9',
  woodBeige2: '#e4d5c5',
  woodLine: '#c9b8a4',
  chevronBlue1: '#ccd4e4',
  chevronBlue2: '#b6bfd6',
  chevronGrey1: '#d5dde6',
  chevronGrey2: '#bdcad8',
  circleTile1: '#eeecfa',
  circleTile2: '#d8d8e8',

  musollaCarpet1: '#0e4f47',
  musollaCarpet2: '#0b5f54',
  musollaCarpet3: '#d9a441',
  sportFloor1: '#e7dcc3',
  sportFloor2: '#d3c4a3',
  concrete1: '#c8c6c1',
  concrete2: '#b0aea8',
  concrete3: '#dcdad5',
  pavement1: '#e3e5e4',
  pavement2: '#cfd3d2',
  asphalt1: '#59616d',
  asphalt2: '#4c545f',
  roadLine: '#f6d365',

  purpleRug1: '#8e9cd9',
  purpleRug2: '#888dcd',
  latticeRugBg: '#f0f4f8',
  latticeRugLine: '#b3bcd4',

  oakDesk: '#c58b54',
  oakDeskDark: '#935823',
  peachSofa: '#f8a896',
  peachSofaTuft: '#e28370',
  peachSofaBorder: '#cd6552',
  camelSofa: '#de8b4b',
  camelSofaDark: '#be6b2b',
  blueSofa: '#1d63d8',
  blueSofaLight: '#3b82f6',
  blueSofaDark: '#1446a0',
  orangeChair: '#ea6d2e',
  blueChair: '#2563eb',
  meshChair: '#1e293b',
  meshChairLight: '#334155',

  pingPongGreen: '#2e9e5b',
  pingPongLine: '#ffffff',
  pingPongNet: '#64748b',
  waterBlue: '#38bdf8',
  waterJug: '#0284c7',

  shadow: 'rgba(15, 23, 42, 0.15)',
};

function drawWoodPlanks(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = PAL.woodBeige1; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PAL.woodLine; ctx.lineWidth = 1;

  const rowH = 14;
  const colW = 44;
  for (let py = y; py < y + h + rowH; py += rowH) {
    ctx.beginPath(); ctx.moveTo(x, py); ctx.lineTo(x + w, py); ctx.stroke();
    const rowIdx = Math.floor((py - y) / rowH);
    const offset = (rowIdx % 2) * (colW / 2);
    for (let px = x + offset; px < x + w + colW; px += colW) {
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + rowH); ctx.stroke();
    }
  }
  ctx.restore();
}

function drawChevronFloor(ctx, x, y, w, h, col1, col2) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = col1; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = col2;

  const step = 14;
  for (let py = y - step * 2; py < y + h + step * 2; py += step) {
    ctx.beginPath();
    for (let px = x - step * 2; px < x + w + step * 2; px += step * 2) {
      ctx.moveTo(px, py);
      ctx.lineTo(px + step, py + step / 2);
      ctx.lineTo(px + step * 2, py);
      ctx.lineTo(px + step * 2, py + 4);
      ctx.lineTo(px + step, py + step / 2 + 4);
      ctx.lineTo(px, py + 4);
    }
    ctx.fill();
  }
  ctx.restore();
}

function drawCircularFloor(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = PAL.circleTile1; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PAL.circleTile2; ctx.lineWidth = 1;

  const s = 24;
  for (let py = y + 12; py < y + h + s; py += s) {
    for (let px = x + 12; px < x + w + s; px += s) {
      ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.restore();
}

function drawStripedLoungeRug(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = PAL.shadow;
  drawRoundRect(ctx, x + 3, y + 3, w, h, 6);
  ctx.fill();

  ctx.beginPath();
  drawRoundRect(ctx, x, y, w, h, 6);
  ctx.clip();

  ctx.fillStyle = PAL.purpleRug1; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = PAL.purpleRug2;
  const stripeW = 20;
  for (let px = x; px < x + w; px += stripeW * 2) {
    ctx.fillRect(px, y, stripeW, h);
  }
  ctx.restore();
}

function drawLatticeRug(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = PAL.shadow;
  drawRoundRect(ctx, x + 2, y + 2, w, h, 6);
  ctx.fill();

  ctx.beginPath();
  drawRoundRect(ctx, x, y, w, h, 6);
  ctx.clip();

  ctx.fillStyle = PAL.latticeRugBg; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PAL.latticeRugLine; ctx.lineWidth = 1.5;

  const step = 20;
  for (let d = -h; d < w + h; d += step) {
    ctx.beginPath(); ctx.moveTo(x + d, y); ctx.lineTo(x + d + h, y + h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + d, y + h); ctx.lineTo(x + d + h, y); ctx.stroke();
  }
  ctx.restore();
}

function drawGarden(ctx) {
  ctx.fillStyle = PAL.grassLight;
  ctx.fillRect(0, 0, 110, MAP_HEIGHT);
  ctx.fillStyle = PAL.grassMid;
  ctx.fillRect(0, 60, 110, 90);
  ctx.fillRect(0, 330, 110, 120);
  ctx.fillRect(0, 620, 110, 110);

  ctx.fillStyle = PAL.grassTuft;
  for (let y = 10; y < MAP_HEIGHT; y += 28) {
    for (let x = 12; x < 95; x += 24) {
      const h = hash(`${x},${y}`);
      if (h % 2 === 0) {
        ctx.fillRect(x, y, 2, 4);
        ctx.fillRect(x + 2, y - 2, 2, 6);
        ctx.fillRect(x + 4, y, 2, 4);
      }
    }
  }

  ctx.fillStyle = '#94a3b8'; ctx.fillRect(104, 0, 6, MAP_HEIGHT);
  ctx.fillStyle = PAL.curb; ctx.fillRect(108, 0, 2, MAP_HEIGHT);
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(104, 0, 1, MAP_HEIGHT);

  drawBirchTree(ctx, 52, 130, 44);

  ctx.fillStyle = 'rgba(20, 60, 20, 0.22)';
  ctx.beginPath(); ctx.ellipse(50, 486, 46, 20, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#8a5a2e'; ctx.fillRect(39, 440, 10, 50);
  ctx.strokeStyle = '#5a3a18'; ctx.lineWidth = 1; ctx.strokeRect(39, 440, 10, 50);
  ctx.fillStyle = '#369324';
  ctx.beginPath(); ctx.arc(44, 410, 34, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(24, 428, 26, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(64, 428, 26, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#56b83b';
  ctx.beginPath(); ctx.arc(44, 406, 28, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(28, 424, 20, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(60, 424, 20, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#7fd65c';
  ctx.beginPath(); ctx.arc(38, 400, 16, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = 'rgba(20, 60, 20, 0.22)';
  ctx.beginPath(); ctx.ellipse(54, 672, 30, 12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#8a5a2e'; ctx.fillRect(49, 656, 8, 16);
  ctx.fillStyle = '#2f9e44';
  ctx.beginPath(); ctx.moveTo(52, 596); ctx.lineTo(26, 640); ctx.lineTo(78, 640); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(52, 612); ctx.lineTo(24, 658); ctx.lineTo(80, 658); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#1e5e28'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(52, 596); ctx.lineTo(26, 640); ctx.lineTo(78, 640); ctx.closePath(); ctx.stroke();
  ctx.fillStyle = 'rgba(20, 60, 20, 0.22)';
  ctx.beginPath(); ctx.ellipse(58, 800, 42, 18, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#8a5a2e'; ctx.fillRect(47, 758, 10, 46);
  ctx.strokeStyle = '#5a3a18'; ctx.strokeRect(47, 758, 10, 46);
  ctx.fillStyle = '#369324'; ctx.beginPath(); ctx.arc(52, 730, 36, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#56b83b'; ctx.beginPath(); ctx.arc(52, 726, 30, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#7fd65c'; ctx.beginPath(); ctx.arc(46, 720, 17, 0, Math.PI * 2); ctx.fill();
}

function drawBirchTree(ctx, x, y, r) {
  ctx.fillStyle = 'rgba(20, 60, 20, 0.22)';
  ctx.beginPath();
  ctx.ellipse(x + 6, y + r - 2, r * 0.95, r * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = PAL.treeBark;
  ctx.fillRect(x - 5, y + r * 0.35, 10, r * 0.65);
  ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1;
  ctx.strokeRect(x - 5, y + r * 0.35, 10, r * 0.65);
  ctx.fillStyle = PAL.treeBarkDark;
  ctx.fillRect(x - 5, y + r * 0.5, 5, 2);
  ctx.fillRect(x + 1, y + r * 0.75, 4, 2);

  const clusters = [
    { dx: 0, dy: -r * 0.35, cr: r * 0.55 },
    { dx: -r * 0.35, dy: -r * 0.1, cr: r * 0.5 },
    { dx: r * 0.35, dy: -r * 0.1, cr: r * 0.5 },
    { dx: -r * 0.2, dy: r * 0.2, cr: r * 0.48 },
    { dx: r * 0.2, dy: r * 0.2, cr: r * 0.48 },
    { dx: 0, dy: 0, cr: r * 0.6 },
  ];
  ctx.fillStyle = PAL.treeLeaf3;
  for (const c of clusters) {
    ctx.beginPath(); ctx.arc(x + c.dx, y + c.dy + 3, c.cr, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = PAL.treeLeaf2;
  for (const c of clusters) {
    ctx.beginPath(); ctx.arc(x + c.dx, y + c.dy, c.cr - 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = PAL.treeLeaf1;
  for (const c of clusters) {
    ctx.beginPath(); ctx.arc(x + c.dx - 3, y + c.dy - 4, c.cr * 0.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#2f7a1e'; ctx.lineWidth = 1;
  for (const c of clusters) {
    ctx.beginPath(); ctx.arc(x + c.dx, y + c.dy + 3, c.cr, 0.3, Math.PI * 0.9); ctx.stroke();
  }
}

/* =====================================================================
   New floor plan — 3 columns + corridors
   x  110..300  west column   (Musolla / Nonton TV / Warung Kopi)
   x  303..309  wall A        |  310..338 west corridor
   x  340..722  middle column (Studio Utama / Ping Pong)
   x  725..731  wall B        |  732..758 east corridor
   x  760..1012 east column   (Studio CX / Garasi / Ruang Santai)
   cross corridor: y 38..100, x 310..758
   x 1016..1290 outdoor yard  (pavement + gerai bakso, outside the wall)
   ===================================================================== */

function drawFloors(ctx) {
  drawWoodPlanks(ctx, 110, 38, 906, 826);

  // west column
  drawMusollaCarpet(ctx, 114, 38, 186, 264);
  drawStripedLoungeRug(ctx, 122, 380, 170, 220);
  drawCircularFloor(ctx, 114, 628, 186, 236);

  // middle column
  drawChevronFloor(ctx, 340, 38, 382, 582, PAL.chevronGrey1, PAL.chevronGrey2);
  drawSportFloor(ctx, 340, 628, 382, 236);

  // east column
  drawChevronFloor(ctx, 760, 106, 252, 236, PAL.chevronBlue1, PAL.chevronBlue2);
  drawConcreteFloor(ctx, 760, 348, 252, 274);
  drawLatticeRug(ctx, 768, 636, 236, 220);
}

function drawWalls(ctx) {
  // outer shell
  drawHWall(ctx, 110, 24, 906, 14);
  drawVWall(ctx, 110, 24, 844, 8);
  drawVWall(ctx, 1016, 24, 844, 8);
  drawHWall(ctx, 110, 868, 906, 8);

  // column divider wall
  drawVWall(ctx, 306, 24, 844, 6);
  drawVWall(ctx, 728, 24, 844, 6);

  // wall between rooms
  drawHWall(ctx, 110, 300, 196, 8);
  drawHWall(ctx, 110, 620, 196, 8);
  drawHWall(ctx, 340, 620, 382, 8);
  drawHWall(ctx, 760, 340, 252, 8);
  drawHWall(ctx, 760, 620, 252, 8);

  // doorway
  ctx.fillStyle = PAL.woodBeige1;
  ctx.fillRect(303, 150, 6, 50);
  ctx.fillRect(303, 430, 6, 50);
  ctx.fillRect(303, 700, 6, 70);
  ctx.fillRect(725, 150, 6, 50);
  ctx.fillRect(725, 410, 6, 50);
  ctx.fillRect(725, 790, 6, 70);
  ctx.fillRect(410, 620, 70, 8);
  ctx.fillRect(106, 660, 12, 50);
  ctx.fillRect(1012, 440, 8, 50);
}

function drawHWall(ctx, x, y, w, h) {
  ctx.fillStyle = PAL.wallFront; ctx.fillRect(x, y + 2, w, h - 2);
  ctx.fillStyle = PAL.wallTop; ctx.fillRect(x, y, w, 3);
  ctx.fillStyle = PAL.wallOutline; ctx.fillRect(x, y + h - 1, w, 1);
}

function drawVWall(ctx, x, y, h, w) {
  ctx.fillStyle = PAL.wallDivider; ctx.fillRect(x - w / 2, y, w, h);
  ctx.fillStyle = PAL.wallTop; ctx.fillRect(x - w / 2, y, 2, h);
}

/* ---------- special floors ---------- */

function drawMusollaCarpet(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = PAL.musollaCarpet1; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = PAL.musollaCarpet2;
  const s = 26;
  for (let py = y; py < y + h + s; py += s) {
    for (let px = x; px < x + w + s; px += s) {
      if ((px + py) % 52 === 0) {
        ctx.beginPath();
        ctx.moveTo(px, py - 10); ctx.lineTo(px + 9, py);
        ctx.lineTo(px, py + 10); ctx.lineTo(px - 9, py);
        ctx.closePath(); ctx.fill();
      }
    }
  }
  ctx.strokeStyle = PAL.musollaCarpet3; ctx.lineWidth = 2;
  ctx.strokeRect(x + 10, y + 10, w - 20, h - 20);
  ctx.restore();
}

function drawSportFloor(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = PAL.sportFloor1; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PAL.sportFloor2; ctx.lineWidth = 1;
  for (let py = y; py < y + h + 26; py += 26) { ctx.beginPath(); ctx.moveTo(x, py); ctx.lineTo(x + w, py); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 3;
  ctx.strokeRect(x + 16, y + 16, w - 32, h - 32);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x + w / 2, y + 16); ctx.lineTo(x + w / 2, y + h - 16); ctx.stroke();
  ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, 26, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawConcreteFloor(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = PAL.concrete1; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PAL.concrete2; ctx.lineWidth = 1;
  for (let py = y + 30; py < y + h; py += 30) { ctx.beginPath(); ctx.moveTo(x, py); ctx.lineTo(x + w, py); ctx.stroke(); }
  for (let i = 0; i < 90; i++) {
    const px = x + (hash(`bx${i}`) % Math.max(1, w - 4));
    const py = y + (hash(`by${i}`) % Math.max(1, h - 4));
    ctx.fillStyle = i % 3 === 0 ? PAL.concrete2 : PAL.concrete3;
    ctx.fillRect(px, py, 2, 2);
  }
  ctx.fillStyle = 'rgba(15,23,42,0.08)';
  ctx.beginPath(); ctx.ellipse(x + w * 0.34, y + h * 0.7, 28, 13, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/* ---------- MUSOLLA  (x 114..300, y 38..302) ---------- */

function drawMusolla(ctx) {
  const mx = 208;
  ctx.fillStyle = '#134e4a'; ctx.fillRect(mx - 34, 32, 68, 16);
  ctx.fillStyle = '#0f766e'; ctx.fillRect(mx - 28, 46, 56, 56);
  ctx.fillStyle = '#5eead4';
  ctx.beginPath();
  ctx.moveTo(mx - 22, 102); ctx.lineTo(mx - 22, 68);
  ctx.arc(mx, 68, 22, Math.PI, 0);
  ctx.lineTo(mx + 22, 102); ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#115e59'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(mx, 78, 7, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#b45309'; ctx.lineWidth = 1; ctx.stroke();

  for (const lx of [140, 276]) {
    ctx.strokeStyle = '#57534e'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(lx, 34); ctx.lineTo(lx, 46); ctx.stroke();
    ctx.fillStyle = '#fcd34d';
    ctx.beginPath();
    ctx.moveTo(lx - 7, 46); ctx.lineTo(lx + 7, 46); ctx.lineTo(lx + 5, 60); ctx.lineTo(lx - 5, 60);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#b45309'; ctx.stroke();
  }

  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) drawPrayerRug(ctx, 124 + c * 70, 152 + r * 54);

  // ablution spot
  ctx.fillStyle = PAL.shadow; ctx.fillRect(116, 98, 34, 22);
  ctx.fillStyle = '#e2e8f0'; ctx.fillRect(114, 96, 34, 22);
  ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1; ctx.strokeRect(114.5, 96.5, 33, 21);
  ctx.fillStyle = '#94a3b8'; ctx.fillRect(118, 100, 12, 8); ctx.fillRect(134, 100, 12, 8);
  ctx.fillStyle = '#64748b'; ctx.beginPath(); ctx.arc(131, 90, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(130, 93, 2, 5);
  ctx.fillStyle = '#38bdf8'; ctx.fillRect(152, 98, 8, 16);
  ctx.fillStyle = '#bae6fd'; ctx.fillRect(152, 98, 8, 3);

  // wall clock
  ctx.fillStyle = '#f8fafc'; ctx.beginPath(); ctx.arc(246, 120, 9, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#334155'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#334155'; ctx.fillRect(245, 114, 2, 7);

  drawWaterCooler(ctx, 270, 128);

  // shoe rack
  ctx.fillStyle = '#78350f'; ctx.fillRect(232, 268, 36, 28);
  ctx.fillStyle = '#92400e'; ctx.fillRect(232, 268, 36, 3);
  ctx.strokeStyle = '#5b3410'; ctx.lineWidth = 1; ctx.strokeRect(232.5, 268.5, 35, 27);
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(236, 274, 9, 4); ctx.fillRect(249, 274, 9, 4);
  ctx.fillRect(236, 282, 9, 4); ctx.fillRect(249, 282, 9, 4);

  drawPottedPlant(ctx, 292, 216, 'tall');
  drawPillLabel(ctx, 208, 130, 'Musolla', '#0f766e', '#ccfbf1');
}

function drawPrayerRug(ctx, x, y) {
  ctx.fillStyle = PAL.shadow; ctx.fillRect(x + 2, y + 3, 60, 32);
  ctx.fillStyle = '#0f766e'; ctx.fillRect(x, y, 60, 32);
  ctx.strokeStyle = '#5eead4'; ctx.lineWidth = 1; ctx.strokeRect(x + 2.5, y + 2.5, 55, 27);
  ctx.beginPath();
  ctx.moveTo(x + 6, y + 25); ctx.lineTo(x + 30, y + 7); ctx.lineTo(x + 54, y + 25);
  ctx.strokeStyle = '#99f6e4'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = '#134e4a'; ctx.beginPath(); ctx.arc(x + 30, y + 19, 3, 0, Math.PI * 2); ctx.fill();
}

/* ---------- NONTON TV  (x 114..300, y 302..620) ---------- */

function drawNontonTV(ctx) {
  ctx.fillStyle = PAL.shadow; ctx.fillRect(124, 346, 172, 52);
  ctx.fillStyle = '#0f172a'; ctx.fillRect(120, 342, 176, 56);
  ctx.save();
  ctx.beginPath(); ctx.rect(124, 346, 168, 48); ctx.clip();
  ctx.fillStyle = '#312e81'; ctx.fillRect(124, 346, 168, 48);
  ctx.fillStyle = '#4c1d95'; ctx.fillRect(124, 374, 168, 20);
  ctx.fillStyle = '#f59e0b'; ctx.beginPath(); ctx.arc(246, 358, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.moveTo(124, 394); ctx.lineTo(146, 370); ctx.lineTo(164, 384); ctx.lineTo(182, 366);
  ctx.lineTo(202, 388); ctx.lineTo(220, 372); ctx.lineTo(244, 394); ctx.lineTo(292, 394);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#64748b'; ctx.fillRect(124, 397, 168, 3);

  // media shelf
  ctx.fillStyle = PAL.shadow; ctx.fillRect(126, 406, 172, 20);
  ctx.fillStyle = '#c58b54'; ctx.fillRect(124, 404, 172, 20);
  ctx.fillStyle = '#935823'; ctx.fillRect(124, 404, 172, 3);
  ctx.strokeStyle = '#7c4a1c'; ctx.lineWidth = 1; ctx.strokeRect(124.5, 404.5, 171, 19);
  ctx.fillStyle = '#1e293b'; ctx.fillRect(136, 410, 34, 10);
  ctx.fillStyle = '#38bdf8'; ctx.fillRect(138, 412, 30, 3);
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = '#f1f5f9'; ctx.fillRect(238 + i * 11, 408, 9, 6);
    ctx.fillStyle = '#94a3b8'; ctx.fillRect(238 + i * 11, 414, 9, 2);
  }

  drawCamelLeatherSofa(ctx, 208, 464, 148, 26);
  drawBeanBag(ctx, 148, 524, '#ea580c');
  drawBeanBag(ctx, 268, 524, '#2563eb');
  drawCamelLeatherSofa(ctx, 208, 570, 130, 24);

  // snack basket
  ctx.fillStyle = PAL.shadow; ctx.fillRect(272, 508, 26, 18);
  ctx.fillStyle = '#334155'; ctx.fillRect(270, 506, 26, 18);
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1; ctx.strokeRect(270.5, 506.5, 25, 17);
  ctx.fillStyle = '#f97316'; ctx.beginPath(); ctx.arc(276, 502, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fbbf24'; ctx.fillRect(284, 498, 8, 6);

  // floor lamp
  ctx.fillStyle = '#475569'; ctx.fillRect(120, 516, 3, 40);
  ctx.fillStyle = '#fbbf24';
  ctx.beginPath();
  ctx.moveTo(112, 516); ctx.lineTo(132, 516); ctx.lineTo(127, 502); ctx.lineTo(117, 502);
  ctx.closePath(); ctx.fill();

  drawPottedPlant(ctx, 292, 470, 'monstera');
  drawPillLabel(ctx, 208, 442, 'Nonton TV', '#1e293b', '#e2e8f0');
}

function drawBeanBag(ctx, x, y, col) {
  ctx.fillStyle = PAL.shadow; ctx.beginPath(); ctx.ellipse(x, y + 14, 15, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.ellipse(x, y + 4, 16, 12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath(); ctx.ellipse(x - 5, y, 7, 5, 0, 0, Math.PI * 2); ctx.fill();
}

/* ---------- WARUNG KOPI  (x 114..300, y 620..868) ---------- */

function drawWarungKopi(ctx) {
  // menu board
  ctx.fillStyle = '#2f3b34'; ctx.fillRect(120, 650, 84, 54);
  ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = 3; ctx.strokeRect(120.5, 650.5, 83, 53);
  ctx.fillStyle = '#e7e5e4';
  ctx.font = 'bold 9px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('KOPI', 128, 666);
  ctx.font = '6.5px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('susu   8k', 128, 678);
  ctx.fillText('panas  6k', 128, 688);
  ctx.fillText('teh    4k', 128, 698);
  ctx.textAlign = 'center';

  // cake display case
  ctx.fillStyle = PAL.shadow; ctx.fillRect(216, 662, 82, 40);
  ctx.fillStyle = '#cbd5e1'; ctx.fillRect(214, 660, 82, 40);
  ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1; ctx.strokeRect(214.5, 660.5, 81, 39);
  ctx.fillStyle = '#fef3c7'; ctx.fillRect(218, 678, 74, 18);
  ctx.fillStyle = '#f59e0b';
  for (let i = 0; i < 5; i++) {
    ctx.beginPath(); ctx.arc(226 + i * 15, 684, 5, 0, Math.PI * 2); ctx.fill();
  }

  // bar
  ctx.fillStyle = PAL.shadow; ctx.fillRect(124, 800, 172, 56);
  ctx.fillStyle = '#a9784a'; ctx.fillRect(122, 798, 172, 56);
  ctx.fillStyle = '#c58b54'; ctx.fillRect(122, 798, 172, 6);
  ctx.strokeStyle = '#6d3c18'; ctx.lineWidth = 1; ctx.strokeRect(122.5, 798.5, 171, 55);
  ctx.fillStyle = '#7c4a1c';
  for (let i = 0; i < 4; i++) ctx.fillRect(132 + i * 42, 818, 30, 2);

  // espresso machine
  ctx.fillStyle = PAL.shadow; ctx.fillRect(212, 776, 46, 22);
  ctx.fillStyle = '#b91c1c'; ctx.fillRect(210, 774, 46, 22);
  ctx.fillStyle = '#ef4444'; ctx.fillRect(210, 774, 46, 4);
  ctx.strokeStyle = '#7f1d1d'; ctx.lineWidth = 1; ctx.strokeRect(210.5, 774.5, 45, 21);
  ctx.fillStyle = '#e2e8f0'; ctx.fillRect(216, 782, 8, 10); ctx.fillRect(242, 782, 8, 10);
  ctx.fillStyle = '#475569'; ctx.fillRect(230, 790, 6, 4);

  // stack of glasses
  ctx.fillStyle = '#f8fafc';
  for (let i = 0; i < 4; i++) {
    ctx.beginPath(); ctx.ellipse(180, 790 - i * 5, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.stroke();
  }

  for (let i = 0; i < 3; i++) drawBarStool(ctx, 150 + i * 46, 772);

  for (let i = 0; i < 2; i++) {
    const lx = 152 + i * 104;
    ctx.strokeStyle = '#57534e'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(lx, 716); ctx.lineTo(lx, 732); ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.moveTo(lx - 8, 732); ctx.lineTo(lx + 8, 732); ctx.lineTo(lx + 5, 746); ctx.lineTo(lx - 5, 746);
    ctx.closePath(); ctx.fill();
  }

  drawPottedPlant(ctx, 292, 740, 'monstera');
  drawPillLabel(ctx, 208, 726, 'Warung Kopi', '#78350f', '#fef3c7');
}

function drawBarStool(ctx, x, y) {
  ctx.fillStyle = PAL.shadow; ctx.beginPath(); ctx.ellipse(x, y + 20, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#334155'; ctx.fillRect(x - 2, y + 8, 4, 12);
  ctx.fillStyle = '#b45309'; ctx.beginPath(); ctx.ellipse(x, y, 11, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#d97706'; ctx.beginPath(); ctx.ellipse(x, y - 1, 8, 3, 0, 0, Math.PI * 2); ctx.fill();
}

/* ---------- STUDIO UTAMA  (x 340..722, y 106..620) ---------- */

function drawStudioDek(ctx) {
  drawAquarium(ctx, 368, 116);

  ctx.fillStyle = '#f8fafc'; ctx.fillRect(452, 112, 120, 68);
  ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 2; ctx.strokeRect(452.5, 112.5, 119, 67);
  ctx.fillStyle = '#dc2626'; ctx.fillRect(462, 124, 40, 3);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(462, 136, 78, 2); ctx.fillRect(462, 144, 62, 2); ctx.fillRect(462, 152, 70, 2);
  ctx.fillStyle = '#2563eb'; ctx.fillRect(462, 164, 44, 2);
  ctx.fillStyle = '#16a34a'; ctx.fillRect(518, 162, 30, 2);

  // pantry
  ctx.fillStyle = PAL.shadow; ctx.fillRect(594, 132, 118, 40);
  ctx.fillStyle = '#c58b54'; ctx.fillRect(592, 130, 118, 40);
  ctx.fillStyle = '#935823'; ctx.fillRect(592, 130, 118, 4);
  ctx.strokeStyle = '#6d3c18'; ctx.lineWidth = 1; ctx.strokeRect(592.5, 130.5, 117, 39);
  ctx.fillStyle = '#1e293b'; ctx.fillRect(602, 112, 38, 18);
  ctx.fillStyle = '#334155'; ctx.fillRect(606, 116, 30, 4);
  ctx.fillStyle = '#e2e8f0'; ctx.fillRect(648, 112, 12, 16);
  ctx.fillStyle = '#94a3b8'; ctx.fillRect(650, 116, 8, 4);
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath(); ctx.ellipse(674 + i * 11, 124, 5, 6, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#92400e'; ctx.fillRect(596, 106, 114, 5);
  const jarCols = ['#22c55e', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4'];
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = jarCols[i]; ctx.fillRect(604 + i * 22, 88, 11, 18);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(606 + i * 22, 90, 3, 14);
    ctx.fillStyle = '#78350f'; ctx.fillRect(602 + i * 22, 84, 15, 4);
  }

  for (const px of [348, 700]) {
    ctx.fillStyle = '#334155'; ctx.fillRect(px, 112, 14, 16);
    ctx.fillStyle = '#16a34a';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(px + 3 + i * 3, 92, 2, 22);
      ctx.beginPath(); ctx.arc(px + 4 + i * 3, 94 + i * 3, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // small pinboard in the studio's left corner
  ctx.fillStyle = PAL.shadow; ctx.fillRect(348, 470, 62, 52);
  ctx.fillStyle = '#a9784a'; ctx.fillRect(346, 468, 62, 52);
  ctx.fillStyle = '#c58b54'; ctx.fillRect(346, 468, 62, 4);
  ctx.fillStyle = '#fef9c3'; ctx.fillRect(352, 476, 24, 18);
  ctx.fillStyle = '#bbf7d0'; ctx.fillRect(380, 476, 24, 18);
  ctx.fillStyle = '#fecaca'; ctx.fillRect(352, 498, 52, 16);
  ctx.strokeStyle = '#7c4a1c'; ctx.lineWidth = 1; ctx.strokeRect(346.5, 468.5, 61, 51);
}

function drawStudioUtama(ctx) {
  drawStudioDek(ctx);

  const deskW = 104; const deskH = 36;
  const meshChair = (x, y) => {
    ctx.fillStyle = PAL.shadow; ctx.beginPath(); ctx.ellipse(x, y + 7, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0f172a'; drawRoundRect(ctx, x - 10, y - 7, 20, 15, 4); ctx.fill();
    ctx.fillStyle = '#1e293b'; drawRoundRect(ctx, x - 9, y - 6, 18, 13, 3); ctx.fill();
    ctx.fillStyle = '#334155';
    for (let dx = -6; dx <= 6; dx += 4) ctx.fillRect(x + dx, y - 4, 2, 8);
    ctx.fillStyle = '#475569'; ctx.fillRect(x - 1, y + 8, 2, 5);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(x - 7, y + 12, 3, 2); ctx.fillRect(x + 4, y + 12, 3, 2); ctx.fillRect(x - 1, y + 13, 3, 2);
  };
  const deskBase = (dx, dy) => {
    ctx.fillStyle = PAL.shadow; ctx.fillRect(dx + 2, dy + 4, deskW, deskH);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(dx, dy, deskW, deskH);
    ctx.fillStyle = '#cbd5e1'; ctx.fillRect(dx, dy + deskH - 4, deskW, 4);
    ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1; ctx.strokeRect(dx, dy, deskW, deskH);
  };
  const monitor = (x, y, w, h, screen) => {
    ctx.fillStyle = '#0f172a'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = screen; ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
    drawCodeLines(ctx, x + 2, y + 2, w - 4, h - 4);
    ctx.fillStyle = '#94a3b8'; ctx.fillRect(x + w / 2 - 1, y + h, 2, 4);
    ctx.fillStyle = '#64748b'; ctx.fillRect(x + w / 2 - 6, y + h + 4, 12, 2);
  };
  const keyboard = (x, y, w) => {
    ctx.fillStyle = '#0f172a'; ctx.fillRect(x, y, w, 7);
    ctx.fillStyle = '#94a3b8'; ctx.fillRect(x + 1, y + 1, w - 2, 5);
    ctx.fillStyle = '#475569';
    for (let k = 2; k < w - 2; k += 4) ctx.fillRect(x + k, y + 2, 2, 3);
  };

  const rowA = 250;
  const colsA = [360, 476, 592];
  for (let i = 0; i < 3; i++) {
    const dx = colsA[i];
    deskBase(dx, rowA);
    if (i === 0) {
      monitor(dx + 6, rowA + 6, 30, 20, '#1e293b');
      ctx.fillStyle = '#334155'; ctx.fillRect(dx + 10, rowA + 12, 20, 2); ctx.fillRect(dx + 10, rowA + 18, 20, 2);
      monitor(dx + 42, rowA + 4, 30, 20, '#38bdf8');
      ctx.fillStyle = '#e0f2fe'; ctx.fillRect(dx + 44, rowA + 8, 26, 2); ctx.fillRect(dx + 44, rowA + 14, 18, 2);
      keyboard(dx + 42, rowA + 27, 28);
      ctx.fillStyle = '#eab308'; ctx.beginPath(); ctx.arc(dx + 82, rowA + 12, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1; ctx.stroke();
      ctx.strokeStyle = '#92400e'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(dx + 84, rowA + 16); ctx.lineTo(dx + 86, rowA + 28); ctx.stroke();
      drawStickyNote(ctx, dx + 92, rowA + 2);
      drawDeskMug(ctx, dx + 78, rowA + 24);
    } else if (i === 1) {
      drawPottedPlant(ctx, dx + 16, rowA + 18, 'small');
      monitor(dx + 34, rowA + 4, 28, 22, '#1e293b');
      ctx.fillStyle = '#475569'; ctx.fillRect(dx + 38, rowA + 10, 20, 2); ctx.fillRect(dx + 38, rowA + 16, 14, 2);
      keyboard(dx + 36, rowA + 28, 24);
      ctx.fillStyle = '#0f172a'; ctx.fillRect(dx + 68, rowA + 8, 12, 22);
      ctx.fillStyle = '#2563eb'; ctx.fillRect(dx + 69, rowA + 9, 10, 20);
      ctx.fillStyle = '#93c5fd'; ctx.fillRect(dx + 69, rowA + 9, 10, 4);
      ctx.fillStyle = '#dc2626'; ctx.fillRect(dx + 86, rowA + 12, 5, 9);
      drawStickyNote(ctx, dx + 84, rowA + 26);
      drawDeskMug(ctx, dx + 60, rowA + 24);
    } else {
      monitor(dx + 8, rowA + 6, 32, 18, '#db2777');
      ctx.fillStyle = '#fbcfe8'; ctx.fillRect(dx + 10, rowA + 10, 28, 2);
      monitor(dx + 48, rowA + 4, 16, 22, '#0284c7');
      ctx.fillStyle = '#38bdf8'; ctx.fillRect(dx + 50, rowA + 10, 12, 2); ctx.fillRect(dx + 50, rowA + 16, 12, 2);
      keyboard(dx + 26, rowA + 27, 24);
      drawStickyNote(ctx, dx + 70, rowA + 2);
      drawDeskMug(ctx, dx + 86, rowA + 24);
    }
    meshChair(dx + deskW / 2, rowA + 60);
  }

  const rowB = 400;
  const colsB = [418, 534];
  for (let i = 0; i < 2; i++) {
    const dx = colsB[i];
    deskBase(dx, rowB);
    if (i === 0) {
      ctx.fillStyle = '#0f172a'; ctx.fillRect(dx + 6, rowB + 6, 28, 22);
      ctx.strokeStyle = '#475569'; ctx.lineWidth = 1; ctx.strokeRect(dx + 6, rowB + 6, 28, 22);
      ctx.fillStyle = '#020617'; ctx.beginPath(); ctx.arc(dx + 20, rowB + 17, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e2e8f0'; ctx.beginPath(); ctx.arc(dx + 20, rowB + 17, 2.5, 0, Math.PI * 2); ctx.fill();
      monitor(dx + 46, rowB + 4, 32, 20, '#e2e8f0');
      ctx.fillStyle = '#94a3b8'; ctx.fillRect(dx + 48, rowB + 10, 26, 2); ctx.fillRect(dx + 48, rowB + 16, 18, 2);
      keyboard(dx + 48, rowB + 27, 26);
      drawStickyNote(ctx, dx + 84, rowB + 2);
      drawDeskMug(ctx, dx + 84, rowB + 24);
    } else {
      ctx.fillStyle = '#94a3b8'; ctx.fillRect(dx + 6, rowB + 6, 10, 20);
      ctx.strokeStyle = '#475569'; ctx.lineWidth = 1; ctx.strokeRect(dx + 6, rowB + 6, 10, 20);
      ctx.fillStyle = '#0f172a'; ctx.fillRect(dx + 8, rowB + 8, 6, 3); ctx.fillRect(dx + 8, rowB + 14, 6, 3);
      monitor(dx + 24, rowB + 4, 34, 20, '#38bdf8');
      ctx.fillStyle = '#e0f2fe'; ctx.fillRect(dx + 26, rowB + 10, 30, 2);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(dx + 66, rowB + 8, 17, 18);
      ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1; ctx.strokeRect(dx + 66, rowB + 8, 17, 18);
      ctx.fillStyle = '#cbd5e1'; ctx.fillRect(dx + 68, rowB + 12, 13, 1); ctx.fillRect(dx + 68, rowB + 16, 13, 1);
      keyboard(dx + 28, rowB + 27, 26);
      ctx.fillStyle = '#ea580c'; ctx.fillRect(dx + 60, rowB + 27, 7, 2);
      drawStickyNote(ctx, dx + 88, rowB + 2);
      drawDeskMug(ctx, dx + 84, rowB + 24);
    }
    meshChair(dx + deskW / 2, rowB + 60);
  }

  // flex corner: backup workstation
  drawSwivelMeshChair(ctx, 700, 500, 'up');
  drawSwivelMeshChair(ctx, 700, 566, 'up');
  drawPottedPlant(ctx, 704, 340, 'monstera');
  drawPottedPlant(ctx, 352, 588, 'tall');

  drawPillLabel(ctx, 531, 214, 'Studio Utama', '#334155', '#f1f5f9');
}

/* ---------- PING PONG  (x 340..722, y 620..868) ---------- */

function drawPingPongRoom(ctx) {
  // scoreboard (on the room's west wall)
  ctx.fillStyle = PAL.shadow; ctx.fillRect(354, 638, 84, 44);
  ctx.fillStyle = '#1e293b'; ctx.fillRect(352, 636, 84, 44);
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1; ctx.strokeRect(352.5, 636.5, 83, 43);
  ctx.fillStyle = '#fef08a';
  ctx.fillRect(360, 644, 30, 20); ctx.fillRect(398, 644, 30, 20);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 11px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('11', 375, 659); ctx.fillText('7', 413, 659);
  ctx.textAlign = 'center';

  drawPingPongTable(ctx, 452, 690, 132, 76);

  // racket + ball
  ctx.fillStyle = '#dc2626'; ctx.beginPath(); ctx.ellipse(420, 726, 8, 6, 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1f2937'; ctx.fillRect(426, 728, 12, 3);
  ctx.fillStyle = '#f8fafc'; ctx.beginPath(); ctx.arc(628, 728, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2563eb'; ctx.beginPath(); ctx.ellipse(660, 722, 8, 6, -0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1f2937'; ctx.fillRect(654, 724, 12, 3);

  drawBench(ctx, 366, 690, 22, 80);
  drawBench(ctx, 690, 690, 22, 80);

  // towel hook + racket
  ctx.fillStyle = '#334155'; ctx.fillRect(366, 648, 54, 8);
  ctx.fillStyle = '#fbbf24'; ctx.fillRect(370, 656, 20, 26);
  ctx.fillStyle = '#0f172a'; ctx.fillRect(370, 662, 20, 2); ctx.fillRect(370, 670, 20, 2);

  drawWaterCooler(ctx, 686, 812);
  drawPottedPlant(ctx, 700, 648, 'monstera');
  drawPottedPlant(ctx, 640, 848, 'tall');

  drawPillLabel(ctx, 531, 674, 'Ping Pong', '#14532d', '#bbf7d0');
  // clear walking space under the table for agents
}

function drawBench(ctx, x, y, w, h) {
  ctx.fillStyle = PAL.shadow; ctx.fillRect(x + 2, y + 3, w, h);
  ctx.fillStyle = '#c58b54'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#935823'; ctx.fillRect(x, y, w, 4);
  ctx.strokeStyle = '#6d3c18'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = '#7c4a1c'; ctx.fillRect(x + w / 2 - 1, y + 6, 2, h - 12);
}

function drawPingPongTable(ctx, x, y, w, h) {
  ctx.fillStyle = PAL.shadow; ctx.fillRect(x + 3, y + 4, w, h);
  ctx.fillStyle = PAL.pingPongGreen; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PAL.pingPongLine; ctx.lineWidth = 1.5; ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
  ctx.beginPath(); ctx.moveTo(x + w / 2, y + 2); ctx.lineTo(x + w / 2, y + h - 2); ctx.stroke();
  ctx.fillStyle = PAL.pingPongNet; ctx.fillRect(x + w / 2 - 2, y - 2, 4, h + 4);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x + w / 2 - 1, y, 2, h);
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(x + 4, y + 4, w - 8, 3);
}

/* ---------- STUDIO CX  (x 760..1012, y 106..340) ---------- */

function drawStudioCX(ctx) {
  ctx.fillStyle = '#f8fafc'; ctx.fillRect(778, 116, 90, 54);
  ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 2; ctx.strokeRect(778.5, 116.5, 89, 53);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(786, 126, 50, 2); ctx.fillRect(786, 136, 34, 2);
  ctx.fillStyle = '#dc2626'; ctx.fillRect(824, 150, 22, 2);
  ctx.fillStyle = '#2563eb'; ctx.fillRect(786, 150, 30, 2);

  const deskW = 96; const deskH = 34;
  const cols = [780, 880];
  const meshChair = (x, y) => {
    ctx.fillStyle = PAL.shadow; ctx.beginPath(); ctx.ellipse(x, y + 7, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0f172a'; drawRoundRect(ctx, x - 10, y - 7, 20, 15, 4); ctx.fill();
    ctx.fillStyle = '#1e293b'; drawRoundRect(ctx, x - 9, y - 6, 18, 13, 3); ctx.fill();
    ctx.fillStyle = '#334155';
    for (let dx = -6; dx <= 6; dx += 4) ctx.fillRect(x + dx, y - 4, 2, 8);
    ctx.fillStyle = '#475569'; ctx.fillRect(x - 1, y + 8, 2, 5);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(x - 7, y + 12, 3, 2); ctx.fillRect(x + 4, y + 12, 3, 2); ctx.fillRect(x - 1, y + 13, 3, 2);
  };
  const deskBase = (dx, dy) => {
    ctx.fillStyle = PAL.shadow; ctx.fillRect(dx + 2, dy + 4, deskW, deskH);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(dx, dy, deskW, deskH);
    ctx.fillStyle = '#cbd5e1'; ctx.fillRect(dx, dy + deskH - 4, deskW, 4);
    ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1; ctx.strokeRect(dx, dy, deskW, deskH);
  };
  const imac = (x, y, screen) => {
    ctx.fillStyle = '#0f172a'; ctx.fillRect(x, y, 28, 18);
    ctx.fillStyle = screen; ctx.fillRect(x + 2, y + 2, 24, 14);
    drawCodeLines(ctx, x + 2, y + 2, 24, 14);
    ctx.fillStyle = '#94a3b8'; ctx.fillRect(x + 12, y + 18, 4, 4);
    ctx.fillStyle = '#64748b'; ctx.fillRect(x + 7, y + 22, 14, 2);
  };
  const keyboard = (x, y, w) => {
    ctx.fillStyle = '#0f172a'; ctx.fillRect(x, y, w, 5);
    ctx.fillStyle = '#cbd5e1'; ctx.fillRect(x + 1, y + 1, w - 2, 3);
  };

  const rowY = [200, 270];
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 2; i++) {
      const dx = cols[i]; const dy = rowY[r];
      deskBase(dx, dy);
      if ((r + i) % 2 === 0) {
        drawPottedPlant(ctx, dx + 14, dy + 12, 'small');
        imac(dx + 34, dy + 2, '#e2e8f0');
        ctx.fillStyle = '#94a3b8'; ctx.fillRect(dx + 36, dy + 6, 20, 2);
        keyboard(dx + 36, dy + 24, 22);
        ctx.fillStyle = '#eab308'; ctx.fillRect(dx + 68, dy + 8, 3, 8);
        ctx.fillStyle = '#2563eb'; ctx.fillRect(dx + 74, dy + 8, 9, 12);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(dx + 75, dy + 10, 7, 2); ctx.fillRect(dx + 75, dy + 14, 7, 2);
        drawStickyNote(ctx, dx + 20, dy + 2);
        drawDeskMug(ctx, dx + 72, dy + 20);
      } else {
        imac(dx + 10, dy + 4, '#38bdf8');
        ctx.fillStyle = '#e0f2fe'; ctx.fillRect(dx + 12, dy + 8, 24, 2);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(dx + 52, dy + 6, 17, 18);
        ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1; ctx.strokeRect(dx + 52, dy + 6, 17, 18);
        ctx.fillStyle = '#cbd5e1'; ctx.fillRect(dx + 54, dy + 10, 13, 1); ctx.fillRect(dx + 54, dy + 14, 13, 1);
        keyboard(dx + 12, dy + 24, 22);
        ctx.fillStyle = '#dc2626'; ctx.fillRect(dx + 80, dy + 12, 5, 8);
        drawStickyNote(ctx, dx + 74, dy + 2);
        drawDeskMug(ctx, dx + 38, dy + 22);
      }
      meshChair(dx + deskW / 2, dy + 50);
    }
  }

  drawPottedPlant(ctx, 994, 296, 'tall');
  drawPillLabel(ctx, 886, 180, 'Studio CX', '#1e3a8a', '#dbeafe');
}

/* ---------- GARASI  (x 760..1012, y 340..620) ---------- */

function drawGarasi(ctx) {
  // roller door
  ctx.fillStyle = '#94a3b8'; ctx.fillRect(770, 352, 84, 30);
  ctx.fillStyle = '#cbd5e1';
  for (let i = 0; i < 4; i++) ctx.fillRect(772, 354 + i * 7, 80, 5);
  ctx.fillStyle = '#64748b'; ctx.fillRect(768, 350, 88, 3); ctx.fillRect(768, 380, 88, 3);

  // tool board
  ctx.fillStyle = '#334155'; ctx.fillRect(770, 400, 60, 96);
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1; ctx.strokeRect(770.5, 400.5, 59, 95);
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(778, 408, 4, 18); ctx.fillRect(788, 408, 4, 14); ctx.fillRect(798, 408, 4, 22);
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(812, 416, 7, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(786, 448); ctx.lineTo(790, 462); ctx.stroke();
  ctx.beginPath(); ctx.arc(782, 446, 5, 0.6, 5.4); ctx.stroke();
  ctx.fillStyle = '#f97316'; ctx.fillRect(778, 472, 44, 4);
  ctx.fillStyle = '#ef4444'; ctx.fillRect(778, 480, 28, 4);

  // tyre + jerrycan
  for (let i = 0; i < 3; i++) {
    const ty = 560 + i * 20;
    ctx.fillStyle = '#1e293b';
    drawRoundRect(ctx, 766, ty, 50, 20, 8); ctx.fill();
    ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#334155';
    drawRoundRect(ctx, 772, ty + 4, 38, 12, 6); ctx.fill();
  }
  ctx.fillStyle = '#b45309'; ctx.fillRect(836, 560, 20, 30);
  ctx.strokeStyle = '#7c4a1c'; ctx.lineWidth = 1; ctx.strokeRect(836.5, 560.5, 19, 29);
  ctx.fillStyle = '#78350f'; ctx.fillRect(842, 556, 8, 5);

  // workbench + toolbox
  ctx.fillStyle = PAL.shadow; ctx.fillRect(872, 396, 128, 46);
  ctx.fillStyle = PAL.oakDesk; ctx.fillRect(870, 392, 128, 44);
  ctx.fillStyle = PAL.oakDeskDark; ctx.fillRect(870, 392, 128, 4);
  ctx.strokeStyle = '#7c4a1c'; ctx.lineWidth = 1; ctx.strokeRect(870.5, 392.5, 127, 43);
  ctx.fillStyle = '#334155'; ctx.fillRect(878, 402, 26, 18);
  ctx.fillStyle = '#38bdf8'; ctx.fillRect(880, 404, 22, 5);
  ctx.fillStyle = '#94a3b8'; ctx.fillRect(878, 418, 26, 3);
  ctx.fillStyle = '#1e293b'; ctx.fillRect(924, 400, 12, 8); ctx.fillRect(924, 412, 12, 8);
  ctx.fillStyle = '#f97316'; ctx.fillRect(956, 398, 30, 6); ctx.fillStyle = '#7f1d1d'; ctx.fillRect(956, 410, 20, 5);
  ctx.fillStyle = '#4b5563';
  ctx.fillRect(872, 436, 4, 26); ctx.fillRect(992, 436, 4, 26);
  ctx.fillStyle = '#e5e7eb'; ctx.fillRect(950, 420, 6, 10);

  // tyre rack
  ctx.fillStyle = '#475569'; ctx.fillRect(770, 512, 96, 6);
  ctx.fillStyle = '#334155'; ctx.fillRect(774, 518, 4, 26); ctx.fillRect(858, 518, 4, 26);
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = '#1e293b';
    drawRoundRect(ctx, 778 + i * 44, 484, 44, 18, 7); ctx.fill();
    ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#334155';
    drawRoundRect(ctx, 784 + i * 44, 488, 32, 10, 5); ctx.fill();
  }
  ctx.fillStyle = '#1e293b';
  drawRoundRect(ctx, 950, 484, 52, 20, 8); ctx.fill();
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#334155'; drawRoundRect(ctx, 956, 488, 40, 12, 6); ctx.fill();

  drawPottedPlant(ctx, 1000, 596, 'small');
  drawPillLabel(ctx, 886, 368, 'Garasi', '#334155', '#e2e8f0');
}

/* ---------- OUTDOOR YARD + GERAI BAKSO  (x 1016..1290) ---------- */

function drawOutdoor(ctx, now) {
  const yardW = WALK_YARD_X - OUT_X;
  // pavement
  ctx.fillStyle = PAL.pavement1; ctx.fillRect(OUT_X, 0, yardW, MAP_HEIGHT);
  ctx.strokeStyle = PAL.pavement2; ctx.lineWidth = 1;
  for (let y = 0; y < MAP_HEIGHT; y += 58) { ctx.beginPath(); ctx.moveTo(OUT_X, y + 0.5); ctx.lineTo(OUT_X + yardW, y + 0.5); ctx.stroke(); }
  for (let x = OUT_X + 58; x < OUT_X + yardW; x += 58) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, MAP_HEIGHT); ctx.stroke(); }
  // kerb + road asphalt
  ctx.fillStyle = PAL.curb; ctx.fillRect(OUT_X + yardW, 0, 6, MAP_HEIGHT);
  ctx.fillStyle = PAL.pavement2; ctx.fillRect(OUT_X + yardW - 3, 0, 3, MAP_HEIGHT);
  ctx.fillStyle = PAL.asphalt1; ctx.fillRect(OUT_X + yardW + 6, 0, MAP_WIDTH - OUT_X - yardW - 6, MAP_HEIGHT);
  ctx.strokeStyle = PAL.asphalt2; ctx.lineWidth = 1;
  for (let y = 24; y < MAP_HEIGHT; y += 56) { ctx.beginPath(); ctx.moveTo(OUT_X + yardW + 7, y + 0.5); ctx.lineTo(MAP_WIDTH, y + 0.5); ctx.stroke(); }
  ctx.fillStyle = PAL.roadLine;
  for (let y = 0; y < MAP_HEIGHT; y += 84) ctx.fillRect(OUT_X + yardW + 22, y, 5, 40);
  ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(OUT_X + yardW + 11, 0, 3, MAP_HEIGHT);

  // footpath from the east door to the pavement
  ctx.fillStyle = PAL.pavement2;
  ctx.fillRect(OUT_X - 4, 440, yardW + 4, 34);

  // street lamp
  ctx.fillStyle = '#475569'; ctx.fillRect(OUT_X + 96, 118, 5, 5); ctx.fillRect(OUT_X + 96, 118, 4, 74);
  ctx.fillStyle = '#fbbf24';
  ctx.beginPath(); ctx.arc(OUT_X + 96, 112, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(251,191,36,0.18)';
  ctx.beginPath(); ctx.arc(OUT_X + 96, 112, 16, 0, Math.PI * 2); ctx.fill();

  // flower pots + roadside plants
  drawPottedPlant(ctx, OUT_X + 26, 262, 'monstera');
  drawPottedPlant(ctx, OUT_X + 30, 636, 'tall');
  drawBirchTree(ctx, OUT_X + 92, 806, 30);
  ctx.fillStyle = PAL.grassMid; ctx.fillRect(OUT_X, 856, yardW, 20);
  ctx.fillStyle = PAL.grassTuft;
  for (let x = OUT_X + 6; x < OUT_X + yardW; x += 22) ctx.fillRect(x, 858, 2, 5);

  drawBaksoStall(ctx, now);
}

function drawBaksoStall(ctx, now) {
  const cx = WALK_YARD_X - 62; const cy = 470;

  // cart canopy
  ctx.fillStyle = 'rgba(15,23,42,0.16)'; ctx.fillRect(cx - 62, cy - 40, 124, 8);
  ctx.fillStyle = '#f8fafc'; ctx.fillRect(cx - 58, cy - 36, 116, 10);
  ctx.fillStyle = '#dc2626';
  for (let i = 0; i < 6; i++) ctx.fillRect(cx - 58 + i * 19, cy - 36, 10, 10);
  ctx.fillStyle = '#7f1d1d'; ctx.fillRect(cx - 58, cy - 27, 116, 2);

  // food cart
  ctx.fillStyle = PAL.shadow; ctx.fillRect(cx - 58, cy + 44, 116, 14);
  ctx.fillStyle = '#dc2626'; ctx.fillRect(cx - 54, cy - 6, 108, 46);
  ctx.fillStyle = '#ef4444'; ctx.fillRect(cx - 54, cy - 6, 108, 6);
  ctx.strokeStyle = '#7f1d1d'; ctx.lineWidth = 1; ctx.strokeRect(cx - 53.5, cy - 5.5, 107, 45);
  ctx.fillStyle = '#fecaca'; ctx.fillRect(cx - 44, cy + 6, 44, 6);
  ctx.fillStyle = '#7f1d1d'; ctx.fillRect(cx - 44, cy + 16, 32, 3); ctx.fillRect(cx - 44, cy + 22, 24, 3);
  ctx.fillStyle = '#1e293b';
  ctx.beginPath(); ctx.arc(cx - 32, cy + 46, 11, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 32, cy + 46, 11, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#94a3b8';
  ctx.beginPath(); ctx.arc(cx - 32, cy + 46, 4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 32, cy + 46, 4, 0, Math.PI * 2); ctx.fill();
  // stock pot + steam
  ctx.fillStyle = '#334155';
  drawRoundRect(ctx, cx - 34, cy - 26, 46, 22, 5); ctx.fill();
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#fbbf24'; ctx.fillRect(cx - 30, cy - 22, 38, 6);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let i = 0; i < 3; i++) {
    const ph = (now * 0.0008 + i * 0.33) % 1;
    ctx.beginPath();
    ctx.arc(cx - 26 + i * 14 + Math.sin(ph * 6) * 3, cy - 30 - ph * 26, 5 + ph * 5, 0, Math.PI * 2);
    ctx.fill();
  }
  // bowl
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath(); ctx.ellipse(cx + 34, cy - 12 - i * 5, 11, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.stroke();
  }
  // signage
  ctx.fillStyle = '#0f172a'; ctx.fillRect(cx - 46, cy - 52, 92, 20);
  ctx.fillStyle = '#22c55e';
  ctx.font = 'bold 12px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('BAKSO', cx, cy - 38);
  ctx.textAlign = 'center';

  for (let i = 0; i < 3; i++) drawBarStool(ctx, cx - 34 + i * 34, cy + 62);

  drawBaksoVendor(ctx, cx, cy - 76, now);

  drawPillLabel(ctx, cx, 356, 'Gerai Bakso', '#7c2d12', '#fee2e2');
}

function drawBaksoVendor(ctx, x, y, now) {
  const bob = Math.sin(now * 0.002) * 1.2;
  ctx.fillStyle = 'rgba(15,23,42,0.2)';
  ctx.beginPath(); ctx.ellipse(x, y + 12, 11, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1e293b'; ctx.fillRect(x - 6, y + 4, 5, 9); ctx.fillRect(x + 1, y + 4, 5, 9);
  ctx.fillStyle = '#e2e8f0'; drawRoundRect(ctx, x - 9, y - 6 + bob, 18, 14, 3); ctx.fill();
  ctx.fillStyle = '#b45309'; drawRoundRect(ctx, x - 6, y - 2 + bob, 12, 11, 2); ctx.fill();
  ctx.fillStyle = '#78350f'; ctx.fillRect(x - 6, y - 2 + bob, 12, 2);
  ctx.fillStyle = '#e2e8f0'; ctx.fillRect(x - 12, y - 5 + bob, 4, 10); ctx.fillRect(x + 8, y - 5 + bob, 4, 10);
  ctx.fillStyle = '#fed7aa'; ctx.fillRect(x - 12, y - 1 + bob, 4, 4); ctx.fillRect(x + 8, y - 1 + bob, 4, 4);
  ctx.fillStyle = '#fed7aa'; ctx.beginPath(); ctx.arc(x, y - 14 + bob, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1e293b';
  ctx.beginPath(); ctx.arc(x, y - 16 + bob, 8, Math.PI, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#dc2626'; ctx.fillRect(x - 9, y - 22 + bob, 18, 5); ctx.fillRect(x - 4, y - 17 + bob, 14, 2);
  ctx.fillStyle = '#0f172a'; ctx.fillRect(x - 4, y - 13 + bob, 2, 2); ctx.fillRect(x + 2, y - 13 + bob, 2, 2);
  ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x + 10, y - 1 + bob); ctx.lineTo(x + 16, y - 10 + bob); ctx.stroke();
  ctx.fillStyle = '#cbd5e1'; ctx.beginPath(); ctx.arc(x + 17, y - 11 + bob, 3, 0, Math.PI * 2); ctx.fill();
}

/* ---------- RUANG SANTAI  (x 760..1012, y 620..868) ---------- */

function drawRuangSantai(ctx) {
  drawPeachTuftedSofa(ctx, 830, 690, 92, 28, 'down');
  drawPeachTuftedSofa(ctx, 830, 800, 92, 28, 'up');

  ctx.fillStyle = PAL.shadow; ctx.fillRect(802, 738, 62, 26);
  ctx.fillStyle = '#1e293b'; drawRoundRect(ctx, 800, 736, 62, 26, 5); ctx.fill();
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#f8fafc'; ctx.fillRect(810, 742, 14, 12);
  ctx.fillStyle = '#38bdf8'; ctx.fillRect(808, 740, 18, 4);
  ctx.fillStyle = '#fef08a'; ctx.beginPath(); ctx.arc(844, 746, 4, 0, Math.PI * 2); ctx.fill();

  drawModularCubeBookcase(ctx, 768, 660, 52, 60);
  drawModularCubeBookcase(ctx, 952, 660, 52, 60);
  drawTopiaryTree(ctx, 782, 666);
  drawTopiaryTree(ctx, 968, 666);

  drawPottedPlant(ctx, 1000, 756, 'monstera');
  drawPottedPlant(ctx, 770, 838, 'tall');

  ctx.fillStyle = PAL.shadow; ctx.fillRect(950, 828, 44, 24);
  ctx.fillStyle = '#cf9257'; ctx.fillRect(948, 826, 44, 24);
  ctx.strokeStyle = '#5a3a18'; ctx.lineWidth = 1; ctx.strokeRect(948.5, 826.5, 43, 23);
  drawSleepingCat(ctx, 970, 832);

  for (const lx of [820, 900]) {
    ctx.strokeStyle = '#57534e'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(lx, 636); ctx.lineTo(lx, 652); ctx.stroke();
    ctx.fillStyle = '#fcd34d';
    ctx.beginPath();
    ctx.moveTo(lx - 7, 652); ctx.lineTo(lx + 7, 652); ctx.lineTo(lx + 5, 666); ctx.lineTo(lx - 5, 666);
    ctx.closePath(); ctx.fill();
  }

  drawPillLabel(ctx, 886, 652, 'Ruang Santai', '#7c2d12', '#ffedd5');
}

function drawTopiaryTree(ctx, x, y) {
  ctx.fillStyle = PAL.shadow; ctx.beginPath(); ctx.ellipse(x, y + 16, 8, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#334155'; ctx.fillRect(x - 5, y + 8, 10, 10);
  ctx.fillStyle = '#78350f'; ctx.fillRect(x - 1, y, 2, 8);
  ctx.fillStyle = '#22c55e'; ctx.beginPath(); ctx.arc(x, y - 2, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#4ade80'; ctx.beginPath(); ctx.arc(x - 3, y - 4, 5, 0, Math.PI * 2); ctx.fill();
}

function drawModularCubeBookcase(ctx, x, y, w, h) {
  ctx.fillStyle = PAL.shadow; ctx.fillRect(x + 2, y + 4, w, h);
  ctx.fillStyle = '#475569'; ctx.fillRect(x, y, w, h);
  const cw = (w - 8) / 3;
  const ch = (h - 8) / 3;
  const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(x + 2 + c * (cw + 2), y + 2 + r * (ch + 2), cw, ch);
      ctx.fillStyle = colors[(r * 3 + c) % colors.length];
      ctx.fillRect(x + 4 + c * (cw + 2), y + 6 + r * (ch + 2), 6, ch - 8);
    }
  }
}

function drawPeachTuftedSofa(ctx, x, y, w, h, facing) {
  ctx.fillStyle = PAL.shadow; ctx.fillRect(x - w / 2 + 2, y + 4, w, h);
  ctx.fillStyle = PAL.peachSofaBorder; drawRoundRect(ctx, x - w / 2, y, w, h, 6); ctx.fill();
  ctx.fillStyle = PAL.peachSofa; drawRoundRect(ctx, x - w / 2 + 2, y + 2, w - 4, h - 4, 4); ctx.fill();
  ctx.fillStyle = PAL.peachSofaTuft;
  for (let gx = x - w / 2 + 12; gx < x + w / 2 - 8; gx += 14) {
    ctx.fillRect(gx, y + 8, 2, 2);
    ctx.fillRect(gx, y + 16, 2, 2);
  }
}

function drawSleepingCat(ctx, x, y) {
  ctx.fillStyle = '#f97316'; ctx.beginPath(); ctx.ellipse(x, y, 7, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ea580c'; ctx.beginPath(); ctx.arc(x + 4, y - 2, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#c2410c';
  ctx.beginPath(); ctx.moveTo(x + 3, y - 5); ctx.lineTo(x + 5, y - 8); ctx.lineTo(x + 7, y - 5); ctx.fill();
  ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x - 5, y + 1, 4, 0, Math.PI); ctx.stroke();
}

function drawCamelLeatherSofa(ctx, x, y, w, h, facing) {
  ctx.fillStyle = PAL.shadow; ctx.fillRect(x - w / 2 + 2, y + 4, w, h);
  ctx.fillStyle = PAL.camelSofa; drawRoundRect(ctx, x - w / 2, y, w, h, 6); ctx.fill();
  ctx.fillStyle = PAL.camelSofaDark;
  const cw = (w - 12) / 2;
  ctx.fillRect(x - w / 2 + 5, y + 4, cw, h - 8);
  ctx.fillRect(x - w / 2 + 7 + cw, y + 4, cw, h - 8);
}

function drawAquarium(ctx, x, y) {
  const w = 58; const h = 48;
  const now = performance.now();
  ctx.fillStyle = PAL.shadow; ctx.fillRect(x + 1, y + 3, w, h + 8);
  ctx.fillStyle = '#0f172a'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#1e293b'; ctx.fillRect(x + 4, y + h, 6, 8); ctx.fillRect(x + w - 10, y + h, 6, 8);

  ctx.fillStyle = '#9be3f5'; ctx.fillRect(x + 3, y + 3, w - 6, h - 9);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'; ctx.fillRect(x + 3, y + 3, w - 6, 3);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'; ctx.fillRect(x + 3, y + 3, 3, h - 9);
  ctx.fillStyle = '#e8dcce'; ctx.fillRect(x + 3, y + h - 11, w - 6, 5);
  ctx.fillStyle = '#cbd5e1'; ctx.fillRect(x + 3, y + h - 11, w - 6, 1);

  const sway = Math.sin(now * 0.003) * 2;
  ctx.fillStyle = '#15803d';
  ctx.fillRect(x + 8 + sway, y + 16, 4, 20);
  ctx.fillRect(x + w - 14 + sway, y + 12, 4, 24);
  ctx.fillStyle = '#22c55e';
  ctx.fillRect(x + 9 + sway, y + 18, 2, 16);
  ctx.fillRect(x + w - 13 + sway, y + 14, 2, 18);

  const fx1 = x + 18 + Math.sin(now * 0.002) * 8;
  const fy1 = y + 18 + Math.cos(now * 0.0025) * 3;
  ctx.fillStyle = '#ea580c'; ctx.fillRect(fx1, fy1, 9, 5);
  ctx.beginPath(); ctx.moveTo(fx1, fy1); ctx.lineTo(fx1 - 4, fy1 + 2.5); ctx.lineTo(fx1, fy1 + 5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.fillRect(fx1 + 3, fy1, 3, 5);
  ctx.fillStyle = '#0f172a'; ctx.fillRect(fx1 + 6, fy1 + 1, 1, 1);
  const fx2 = x + 34 + Math.cos(now * 0.0018) * 6;
  const fy2 = y + 28 + Math.sin(now * 0.0022) * 2;
  ctx.fillStyle = '#f97316'; ctx.fillRect(fx2, fy2, 7, 4);
  ctx.beginPath(); ctx.moveTo(fx2 + 7, fy2); ctx.lineTo(fx2 + 10, fy2 + 2); ctx.lineTo(fx2 + 7, fy2 + 4); ctx.closePath(); ctx.fill();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  const b1 = (now * 0.02) % (h - 18);
  ctx.fillRect(x + 26, y + h - 14 - b1, 2, 2);
  const b2 = (now * 0.015 + 12) % (h - 18);
  ctx.fillRect(x + 40, y + h - 14 - b2, 2, 2);

  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h);
}

function drawWaterCooler(ctx, x, y) {
  ctx.fillStyle = PAL.shadow; ctx.fillRect(x + 2, y + 10, 16, 28);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y + 8, 16, 28);
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.strokeRect(x, y + 8, 16, 28);

  ctx.fillStyle = PAL.waterJug; drawRoundRect(ctx, x + 1, y - 8, 14, 16, 4); ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'; ctx.fillRect(x + 3, y - 4, 10, 3);

  ctx.fillStyle = '#ef4444'; ctx.fillRect(x + 3, y + 14, 3, 4);
  ctx.fillStyle = '#3b82f6'; ctx.fillRect(x + 10, y + 14, 3, 4);
  ctx.fillStyle = '#334155'; ctx.fillRect(x + 2, y + 22, 12, 3);
}

function drawSwivelMeshChair(ctx, x, y, dir) {
  ctx.fillStyle = PAL.shadow; ctx.beginPath(); ctx.ellipse(x, y + 6, 12, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = PAL.meshChair; drawRoundRect(ctx, x - 10, y - 6, 20, 14, 4); ctx.fill();
  ctx.fillStyle = PAL.meshChairLight;
  if (dir === 'up') ctx.fillRect(x - 8, y + 2, 16, 4);
  else ctx.fillRect(x - 8, y - 6, 16, 4);
}

function drawPottedPlant(ctx, x, y, type) {
  ctx.fillStyle = '#d97706'; ctx.fillRect(x - 7, y + 4, 14, 12);
  ctx.fillStyle = '#b45309'; ctx.fillRect(x - 8, y + 3, 16, 3);

  if (type === 'tall' || type === 'palm') {
    ctx.fillStyle = '#16a34a';
    ctx.beginPath(); ctx.ellipse(x, y - 6, 8, 18, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x - 8, y - 2, 7, 14, -0.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + 8, y - 2, 7, 14, 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#22c55e';
    ctx.beginPath(); ctx.ellipse(x, y - 8, 5, 12, 0, 0, Math.PI * 2); ctx.fill();
  } else if (type === 'fiddle' || type === 'monstera') {
    ctx.fillStyle = '#15803d';
    ctx.beginPath(); ctx.arc(x - 8, y - 6, 10, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 8, y - 6, 10, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y - 14, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#22c55e';
    ctx.beginPath(); ctx.arc(x - 4, y - 10, 7, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = '#22c55e';
    ctx.beginPath(); ctx.arc(x, y + 1, 6, 0, Math.PI * 2); ctx.fill();
  }
}

function drawCodeLines(ctx, x, y, w, h) {
  if (w < 10 || h < 7) return;
  const cols = ['#4ade80', '#facc15', '#38bdf8', '#f472b6', '#e2e8f0'];
  const rows = Math.max(1, Math.min(4, Math.floor((h - 2) / 4)));
  for (let i = 0; i < rows; i++) {
    const ly = y + 2 + i * 4;
    if (ly + 2 > y + h - 1) break;
    const span = Math.max(4, Math.floor(w / 2));
    const lw = Math.max(4, w - 4 - ((i * 5 + Math.abs(Math.floor(x))) % span));
    ctx.fillStyle = cols[(i + Math.abs(Math.floor(x))) % cols.length];
    ctx.fillRect(x + 2, ly, Math.min(lw, w - 4), 2);
  }
}
function drawDeskMug(ctx, x, y) {
  ctx.fillStyle = 'rgba(15,23,42,0.15)'; ctx.fillRect(x + 1, y + 8, 8, 2);
  ctx.fillStyle = '#ea580c'; ctx.fillRect(x, y, 7, 8);
  ctx.fillStyle = '#fb923c'; ctx.fillRect(x, y, 7, 2);
  ctx.fillStyle = '#3f2d20'; ctx.fillRect(x + 1, y + 1, 5, 2);
  ctx.strokeStyle = '#9a3412'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x + 8, y + 4, 2.5, -Math.PI / 2, Math.PI / 2); ctx.stroke();
}
function drawStickyNote(ctx, x, y) {
  ctx.fillStyle = 'rgba(15,23,42,0.15)'; ctx.fillRect(x + 1, y + 1, 7, 7);
  ctx.fillStyle = '#fef08a'; ctx.fillRect(x, y, 7, 7);
  ctx.fillStyle = '#eab308'; ctx.fillRect(x, y, 7, 2);
  ctx.fillStyle = '#a16207'; ctx.fillRect(x + 1, y + 4, 5, 1);
}

// y = table edge where the character sits
const SEAT_EDGE = {
  A0: 286, A3: 286, A4: 286,
  A1: 436, A2: 436,
  B0: 234, B1: 234, B2: 304, B3: 304,
};
function drawSeatedActor(ctx, actor, px, py, edgeY) {
  const v = actor.spriteVariant;
  const hairColors = ['#1e293b', '#78350f', '#b45309', '#1e1b4b', '#f59e0b', '#475569', '#ec4899'];
  const skinTones = ['#fed7aa', '#d97706', '#fcd34d', '#fed7aa', '#fde047', '#9a3412', '#fed7aa'];
  const hairCol = hairColors[v % hairColors.length];
  const skinCol = skinTones[v % skinTones.length];
  const outfitCol = actor.color || '#4f46e5';
  const by = py; 

  ctx.save();
  if (edgeY) {
    ctx.beginPath();
    ctx.rect(0, edgeY, MAP_WIDTH, MAP_HEIGHT - edgeY);
    ctx.clip();
  }

  ctx.fillStyle = '#0f172a'; drawRoundRect(ctx, px - 11, by - 1, 22, 9, 3); ctx.fill();
  ctx.fillStyle = '#1e293b'; drawRoundRect(ctx, px - 10, by, 20, 7, 2); ctx.fill();
  ctx.fillStyle = '#334155';
  ctx.fillRect(px - 6, by + 1, 2, 5); ctx.fillRect(px - 1, by + 1, 2, 5); ctx.fillRect(px + 4, by + 1, 2, 5);

  ctx.fillStyle = outfitCol;
  drawRoundRect(ctx, px - 8, by - 16, 16, 7, 3); ctx.fill();
  drawRoundRect(ctx, px - 8, by - 11, 16, 13, 4); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(px - 8, by - 11, 16, 2);

  ctx.fillStyle = outfitCol;
  ctx.fillRect(px - 11, by - 9, 4, 8); ctx.fillRect(px + 7, by - 9, 4, 8);
  ctx.fillStyle = skinCol;
  ctx.fillRect(px - 11, by - 13, 4, 3); ctx.fillRect(px + 7, by - 13, 4, 3);

  ctx.fillStyle = skinCol;
  ctx.beginPath(); ctx.arc(px, by - 19, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = hairCol;
  ctx.beginPath(); ctx.arc(px, by - 20, 8.5, 0, Math.PI * 2); ctx.fill();
  if (v === 1 || v === 2) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(px - 10, by - 22, 20, 3);
    ctx.fillRect(px - 11, by - 22, 4, 7);
    ctx.fillRect(px + 7, by - 22, 4, 7);
  } else if (v === 0) {
    ctx.fillStyle = '#0f172a'; ctx.fillRect(px - 9, by - 26, 18, 5);
  }

  ctx.fillStyle = PAL.meshChair; drawRoundRect(ctx, px - 11, by + 4, 22, 12, 4); ctx.fill();
  ctx.fillStyle = PAL.meshChairLight; ctx.fillRect(px - 9, by + 6, 18, 3);
  ctx.fillStyle = '#475569'; ctx.fillRect(px - 2, by + 16, 4, 5);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(px - 9, by + 20, 7, 3); ctx.fillRect(px + 2, by + 20, 7, 3);
  ctx.fillRect(px - 9, by + 23, 3, 2); ctx.fillRect(px - 1, by + 23, 3, 2); ctx.fillRect(px + 7, by + 23, 3, 2);

  ctx.restore();
}

function relCompact(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
function drawWorkCard(ctx, actor, px, bottomY) {
  const d = actor.data || {};
  const r = d.run || null;
  const name = actor.name || d.name || '?';
  let rel = '';
  const tIso = r ? r.started : d.updated;
  const rc = relCompact(tIso);
  if (rc) rel = `Working · ${rc}`;
  let task = '';
  if (r) task = r.task || r.stitle || r.agent_type || '';
  else task = d.stitle || (d.last && d.last[0] && d.last[0].text) || d.activity || '';
  task = String(task || '').trim();

  const fName = 'bold 10px "Plus Jakarta Sans", sans-serif';
  const fSmall = '9px "Plus Jakarta Sans", sans-serif';
  ctx.font = fName;
  const nameW = ctx.measureText(clip(name, 24)).width;
  ctx.font = fSmall;
  const relW = rel ? ctx.measureText(rel).width : 0;
  const words = task.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (Array.from(next).length > 26) {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === 2) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < 2) lines.push(cur);
  let rest = words.length > 0 && lines.join(' ').length < task.length;
  if (lines.length === 2 && rest) lines[1] = `${lines[1]}…`;
  if (!lines.length && task) lines.push(clip(task, 26));
  let taskW = 0;
  for (const ln of lines) taskW = Math.max(taskW, ctx.measureText(ln).width);

  const w = Math.min(190, Math.max(nameW + 22, relW, taskW) + 18);
  const h = 22 + (rel ? 13 : 0) + lines.length * 12 + 6;
  const cx = clamp(px, w / 2 + 2, MAP_WIDTH - w / 2 - 2);
  const y0 = bottomY - h;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  drawRoundRect(ctx, cx - w / 2, y0, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'; ctx.lineWidth = 1; ctx.stroke();

  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#22c55e';
  ctx.beginPath(); ctx.arc(cx - w / 2 + 10, y0 + 13, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.font = fName; ctx.fillStyle = '#ffffff';
  ctx.fillText(clip(name, 24), cx - w / 2 + 17, y0 + 16.5);
  let ly = y0 + 22;
  if (rel) {
    ctx.font = fSmall; ctx.fillStyle = '#4ade80';
    ctx.fillText(rel, cx - w / 2 + 9, y0 + 33);
    ly = y0 + 35;
  }
  ctx.font = fSmall; ctx.fillStyle = '#e2e8f0';
  for (const ln of lines) {
    ly += 12;
    ctx.fillText(ln, cx - w / 2 + 9, ly);
  }
  ctx.textAlign = 'center';
}


function drawCharacter(ctx, actor, now) {
  drawCharacterProcedural(ctx, actor, now);
}
function drawCharacterProcedural(ctx, actor, now) {
  if (actor.gone) return;

  const px = actor.gx * TILE;
  const py = actor.gy * TILE;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.22)';
  ctx.beginPath(); ctx.ellipse(px, py + 12, 10, 5, 0, 0, Math.PI * 2); ctx.fill();

  if (actor.work && !actor.walking) {
    const edgeY = SEAT_EDGE[actor.deskId] || 0;
    drawSeatedActor(ctx, actor, px, py, edgeY);
    if (actor.data) {
      drawWorkCard(ctx, actor, px, (edgeY || py - 28) - 6);
    } else if (actor.badgeText) {
      drawCharacterNametag(ctx, px, py - 40, actor);
    }
    return;
  }

  let bob = 0;
  let legSwing = 0;
  if (actor.walking) {
    bob = Math.sin(actor.walkTime * 2) * 2;
    legSwing = Math.sin(actor.walkTime) * 4;
  }

  const cy = py - 4 + bob;
  const dir = actor.dir;
  const v = actor.spriteVariant;

  const hairColors = ['#1e293b', '#78350f', '#b45309', '#1e1b4b', '#f59e0b', '#475569', '#ec4899'];
  const skinTones = ['#fed7aa', '#d97706', '#fcd34d', '#fed7aa', '#fde047', '#9a3412', '#fed7aa'];
  const hairCol = hairColors[v % hairColors.length];
  const skinCol = skinTones[v % skinTones.length];
  const outfitCol = actor.color || '#4f46e5';

  ctx.fillStyle = '#1e293b';
  if (dir === 'up' || dir === 'down') {
    ctx.fillRect(px - 6 + legSwing, cy + 10, 4, 7);
    ctx.fillRect(px + 2 - legSwing, cy + 10, 4, 7);
  } else {
    ctx.fillRect(px - 3 + legSwing, cy + 10, 6, 7);
  }

  ctx.fillStyle = outfitCol;
  drawRoundRect(ctx, px - 8, cy - 2, 16, 13, 3);
  ctx.fill();

  ctx.fillStyle = skinCol;
  ctx.beginPath(); ctx.arc(px, cy - 10, 8, 0, Math.PI * 2); ctx.fill();

  if (dir === 'up') {
    ctx.fillStyle = hairCol;
    ctx.beginPath(); ctx.arc(px, cy - 11, 8.5, 0, Math.PI * 2); ctx.fill();

    if (v === 1 || v === 2) {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px - 10, cy - 13, 20, 3);
      ctx.fillRect(px - 11, cy - 13, 4, 7);
      ctx.fillRect(px + 7, cy - 13, 4, 7);
    }
  } else {
    ctx.fillStyle = hairCol;
    ctx.beginPath(); ctx.arc(px, cy - 13, 8.5, Math.PI, Math.PI * 2); ctx.fill();

    if (v === 0) {
      ctx.fillStyle = '#0f172a'; ctx.fillRect(px - 9, cy - 17, 18, 5);
    } else if (v === 6) {
      ctx.fillStyle = '#f472b6'; ctx.fillRect(px - 12, cy - 18, 24, 4);
      drawRoundRect(ctx, px - 8, cy - 22, 16, 8, 3); ctx.fill();
    }

    ctx.fillStyle = '#0f172a';
    if (v === 5) {
      ctx.fillStyle = '#c026d3'; ctx.fillRect(px - 7, cy - 12, 14, 5);
      ctx.fillStyle = '#0f172a';
    } else if (dir === 'left') {
      ctx.fillRect(px - 6, cy - 11, 2, 3);
      ctx.fillRect(px - 2, cy - 11, 2, 3);
    } else if (dir === 'right') {
      ctx.fillRect(px + 1, cy - 11, 2, 3);
      ctx.fillRect(px + 5, cy - 11, 2, 3);
    } else {
      ctx.fillRect(px - 4, cy - 11, 2, 3);
      ctx.fillRect(px + 2, cy - 11, 2, 3);
    }

    if (v === 1 || v === 2) {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px - 10, cy - 14, 20, 3);
      ctx.fillRect(px - 11, cy - 13, 4, 7);
      ctx.fillRect(px + 7, cy - 13, 4, 7);
    }
  }

  if (actor.badgeText) {
    drawCharacterNametag(ctx, px, cy - 26, actor);
  }

  if (actor.bubble && (actor.bubbleTime === Infinity || now < actor.bubbleTime)) {
    drawSpeechBubble(ctx, px, cy - 44, actor.bubble);
  }
}

function drawCharacterNametag(ctx, x, y, actor) {
  const text = actor.badgeText || actor.name;
  ctx.font = 'bold 9.5px "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const tm = ctx.measureText(text);
  const w = tm.width + 16;
  const h = 17;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
  drawRoundRect(ctx, x - w / 2, y - h / 2, w, h, 9);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'; ctx.lineWidth = 1; ctx.stroke();

  if (actor.work || actor.key === 'lead') {
    ctx.fillStyle = '#22c55e';
    ctx.beginPath(); ctx.arc(x - w / 2 + 7, y, 2.5, 0, Math.PI * 2); ctx.fill();
  }

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 2, y);
}

function drawSpeechBubble(ctx, x, y, text) {
  ctx.font = '10px "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const tm = ctx.measureText(text);
  const w = Math.min(180, Math.max(34, tm.width + 16));
  const h = 20;

  ctx.fillStyle = PAL.shadow;
  drawRoundRect(ctx, x - w / 2 + 1, y - h / 2 + 2, w, h, 8);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  drawRoundRect(ctx, x - w / 2, y - h / 2, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(x - 4, y + h / 2); ctx.lineTo(x + 4, y + h / 2); ctx.lineTo(x, y + h / 2 + 5);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#1e293b';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(clip(text, 26), x, y);
}

function drawPillLabel(ctx, x, y, text, textColor, bgColor, icon) {
  ctx.font = 'bold 11px "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const label = icon ? `${icon} ${text}` : text;
  const tm = ctx.measureText(label);
  const w = tm.width + 18;
  const h = 20;

  ctx.fillStyle = bgColor || '#ffffff';
  drawRoundRect(ctx, x - w / 2, y - h / 2, w, h, 10);
  ctx.fill();
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.stroke();

  ctx.fillStyle = textColor || '#1e293b';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y);
}

function drawScene(now) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, viewW, viewH);

  ctx.save();
  try {
    const step = 1 / cam.zoom;
    const snapX = Math.round(cam.x / step) * step;
    const snapY = Math.round(cam.y / step) * step;
    ctx.translate(Math.round(viewW / 2), Math.round(viewH / 2));
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-snapX, -snapY);

    drawGarden(ctx);

    drawFloors(ctx);

    drawWalls(ctx);

    drawMusolla(ctx);
    drawNontonTV(ctx);
    drawWarungKopi(ctx);
    drawStudioUtama(ctx);
    drawPingPongRoom(ctx);
    drawStudioCX(ctx);
    drawGarasi(ctx);
    drawOutdoor(ctx, now);
    drawRuangSantai(ctx);

    const sortedActors = [...actors.values()].sort((a, b) => a.gy - b.gy);
    for (const a of sortedActors) {
      drawCharacter(ctx, a, now);
    }
  } catch (err) {
    console.error('[workspace] drawScene error:', err);
  } finally {
    ctx.restore();
  }
}

let lastData = null;

let pollTimer = 0;
let pollInFlight = false;
function schedulePoll(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

async function poll() {
  clearTimeout(pollTimer);
  if (!document.hidden && !pollInFlight) {
    pollInFlight = true;
    try {
      const res = await fetch(API);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const prevFeed = lastData && lastData.feed ? lastData.feed : null;
      lastData = data;
      applyState(data);
      renderUi(data);
      refreshActorDetail();
      notifyDone(prevFeed, data.feed);
      if ($('liveDot')) $('liveDot').classList.remove('off');
      if ($('liveTxt')) $('liveTxt').textContent = 'Connected';
    } catch (err) {
      if ($('liveDot')) $('liveDot').classList.add('off');
      if ($('liveTxt')) $('liveTxt').textContent = 'Disconnected';
    } finally {
      pollInFlight = false;
    }
  }
  schedulePoll(POLL_MS);
}

function applyState(data) {
  const projShort = clip(data.project || '', 14);
  const k = data.lead;
  LEAD.data = k;
  syncName(LEAD, k.name);
  const isLeadWork = k.state === 'working';
  if (isLeadWork) {
    setActorDestination(LEAD, DESK_POS.A0.gx, DESK_POS.A0.gy, 'up', true);
    const sess8 = short8(k.session);
    const kTitle60 = k.stitle ? clip(k.stitle, 60) : null;
    const kTitle14 = k.stitle ? clip(k.stitle, 14) : null;
    workBadge(LEAD, kTitle14 ? (sess8 ? `${kTitle14} · ${sess8}` : kTitle14) : (sess8 ? (projShort ? `${projShort} · ${sess8}` : sess8) : null));
    if (kTitle60) workBubble(LEAD, sess8 ? `${kTitle60} · ${sess8}` : kTitle60);
    else {
      const ktask = clip((k.last && k.last[0] && k.last[0].text) || k.activity || 'Main session', 60);
      workBubble(LEAD, sess8 ? `${ktask} · ${sess8}` : ktask);
    }
  } else if (LEAD.work) {
    setActorDestination(LEAD, LEAD.gx, LEAD.gy, 'down', false);
    clearWorkLabel(LEAD);
  }

  const teamList = data.team || [];
  const TEAM_SEATS = [
    { a: ALEX, desk: 'A1' },
    { a: MIA, desk: 'A2' },
    { a: LEO, desk: 'A3' },
  ];
  for (let i = 0; i < TEAM_SEATS.length; i++) {
    const m = teamList[i];
    if (!m) continue;
    const a = TEAM_SEATS[i].a;
    const d = DESK_POS[TEAM_SEATS[i].desk];
    a.data = m;
    syncName(a, m.name);
    if (m.state === 'working') {
      setActorDestination(a, d.gx, d.gy, 'up', true);
      if (m.run) {
        const id8 = short8(m.run.id);
        workBadge(a, projShort ? `${projShort} · ${id8}` : id8);
        workBubble(a, `${clip(m.run.task || m.run.agent_type || 'Working', 60)} · ${id8}`);
      }
    } else if (a.work) {
      setActorDestination(a, a.gx, a.gy, 'down', false);
      clearWorkLabel(a);
    }
  }

  for (const a of [...actors.keys()]) {
    if (a !== 'lead' && !a.startsWith('team-')) actors.delete(a);
  }
}

const NOTIF_MUTE_KEY = 'workspace-mute';
let notifMuted = false;
try { notifMuted = localStorage.getItem(NOTIF_MUTE_KEY) === '1'; } catch (_e) { notifMuted = false; }
const seenDone = new Set();
let notifSeeded = false;
let titleBase = document.title;
let titleTimer = 0;
let titleUnread = 0;
let titleMsg = '';
let audioCtx = null;
function doneKey(e) { return `${e.t || ''}|${e.name || ''}|${e.text || ''}`; }
function isFailDone(text) { return /(stopped|stopped-by-user|paused - usage limit|usage limit|no activity for|no-activity|failed|inactive)/i.test(String(text || '')); }
function ensureAudio() {
  if (notifMuted) return null;
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch (_e) { return null; }
}
function beep(ok) {
  if (notifMuted || document.hidden) return;
  const ac = ensureAudio();
  if (!ac) return;
  try {
    const t0 = ac.currentTime;
    const notes = ok ? [880, 1174.66] : [311.13, 233.08];
    notes.forEach((f, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const s = t0 + i * 0.14;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.2, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.13);
      o.connect(g);
      g.connect(ac.destination);
      o.start(s);
      o.stop(s + 0.15);
    });
  } catch (_e) {  }
}
function showToast(kind, title, text) {
  const box = $('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = kind === 'fail' ? 'toast fail' : 'toast ok';
  el.setAttribute('role', 'status');
  const t = document.createElement('div');
  t.className = 'tt';
  t.textContent = title;
  const x = document.createElement('button');
  x.className = 'tx';
  x.type = 'button';
  x.setAttribute('aria-label', 'Close notification');
  x.textContent = '×';
  x.addEventListener('click', (ev) => { ev.stopPropagation(); stopBlink(); if (el.parentNode) el.parentNode.removeChild(el); });
  const p = document.createElement('p');
  p.textContent = clip(text || '', 160);
  el.appendChild(t);
  el.appendChild(x);
  el.appendChild(p);
  el.addEventListener('click', () => { stopBlink(); });
  box.appendChild(el);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 6000);
}
function blinkTitle(msg) {
  if (!titleBase) titleBase = document.title;
  titleUnread += 1;
  titleMsg = msg;
  if (titleTimer) return;
  let on = false;
  titleTimer = setInterval(() => {
    on = !on;
    document.title = on ? `(${titleUnread}) ${titleMsg}` : titleBase;
  }, 1000);
}
function stopBlink() {
  if (titleTimer) { clearInterval(titleTimer); titleTimer = 0; }
  titleUnread = 0;
  if (titleBase && document.title !== titleBase) document.title = titleBase;
}
function syncMuteBtn() {
  const b = $('muteBtn');
  if (!b) return;
  b.textContent = notifMuted ? 'Sound: off' : 'Sound: on';
  b.setAttribute('aria-pressed', String(notifMuted));
  b.title = notifMuted ? 'Unmute done/fail sounds' : 'Mute done/fail sounds';
}
function toggleMute() {
  notifMuted = !notifMuted;
  try { localStorage.setItem(NOTIF_MUTE_KEY, notifMuted ? '1' : '0'); } catch (_e) {  }
  if (!notifMuted) ensureAudio();
  syncMuteBtn();
}
function notifyDone(prevFeed, nextFeed) {
  const list = Array.isArray(nextFeed) ? nextFeed : [];
  if (!notifSeeded) {
    for (const e of list) if (e && e.kind === 'done') seenDone.add(doneKey(e));
    notifSeeded = true;
    syncMuteBtn();
    return;
  }
  if (seenDone.size > 600) {
    const it = seenDone.values();
    for (let i = 0; i < 100; i++) { const v = it.next().value; if (v === undefined) break; seenDone.delete(v); }
  }
  const fresh = [];
  for (const e of list) {
    if (!e || e.kind !== 'done') continue;
    const k = doneKey(e);
    if (seenDone.has(k)) continue;
    seenDone.add(k);
    fresh.push(e);
  }
  if (!fresh.length) return;
  fresh.reverse();
  const show = fresh.slice(-4);
  for (const e of show) {
    const fail = isFailDone(e.text);
    const label = fail ? 'Failed' : 'Done';
    showToast(fail ? 'fail' : 'ok', `${label}: ${clip(e.name || 'subagent', 40)}`, e.text);
    blinkTitle(`${label}: ${clip(e.name || 'subagent', 40)}`);
    beep(!fail);
  }
}
window.__workspaceNotif = { notifyDone, showToast, beep, toggleMute, stopBlink };

function renderUi(d) {
  if ($('sActive')) $('sActive').textContent = fmtNum.format(d.stats?.active || 0);

  const pub = typeof d.public_url === 'string' && /^https:\/\//.test(d.public_url) ? d.public_url : null;
  if ($('pubStat')) $('pubStat').hidden = !pub;
  if (pub && $('pubLink')) $('pubLink').href = pub;

  const sl = $('sessLine');
  if (sl) {
    const ks = d.lead && d.lead.state === 'working' && d.lead.stitle ? d.lead.stitle : null;
    sl.hidden = !ks;
    if (ks && $('sessTitle')) { $('sessTitle').textContent = `Session: ${ks}`; sl.title = ks; }
  }

  const workingTeam = d.team.filter((m) => m.state === 'working').map((m) => m.name);
  const flWork = d.freelancers.filter((f) => f.state === 'working').length;
  let phase;
  if (!d.transcripts) phase = 'No OpenCode activity for this folder yet — workspace fills automatically once OpenCode runs here.';
  else if (workingTeam.length || flWork) phase = `Working: ${[...workingTeam, ...(flWork ? [`${flWork} freelancer`] : [])].join(', ')}${d.lead.state === 'working' ? ` · ${LEAD_NAME} monitoring` : ''}`;
  else if (d.lead.state === 'working') phase = `${LEAD_NAME} working in the main session — team idle waiting for tasks`;
  else if (d.lead.state === 'done') phase = `${LEAD_NAME} just finished — waiting for next instructions`;
  else phase = 'All idle ☕ — watching, coffee & chat. Auto back to work when a subagent arrives.';
  if ($('phase')) {
    $('phase').textContent = phase;
    $('phase').title = phase;
  }

  const banner = $('banner');
  if (banner) {
    if (!d.transcripts) {
      banner.textContent = 'Waiting for OpenCode activity in this project folder.';
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
    }
  }

  const allFeed = d.feed || [];
  const visFeed = allFeed.filter(feedMatch).slice(0, 100);
  const feedHtml = visFeed.map((e) => {
    return `<li class="k-${esc(e.kind)}"><span class="av" style="background:${esc(e.color)}">${esc(initial(String(e.name || '?').replace(/^Freelancer · /, '')))}</span><div><div class="meta"><span class="who" style="color:${esc(e.color)}">${esc(e.name)}</span><time>${esc(hhmmss(e.t))}</time></div><div class="txt">${esc(e.text)}</div></div></li>`;
  }).join('') || (allFeed.length ? '<li><div class="empty" style="grid-column:1/-1">Nothing matches this filter.</div></li>' : '<li><div class="empty" style="grid-column:1/-1">No activity yet.</div></li>');
  const feedEl = $('feed');
  if (feedEl && feedEl.innerHTML !== feedHtml) feedEl.innerHTML = feedHtml;
  if ($('feedCount')) $('feedCount').textContent = fmtNum.format((d.feed || []).length);

  const activeRuns = (d.runs || []).filter((r) => r && r.status === 'working');
  if ($('nActive')) $('nActive').textContent = fmtNum.format(activeRuns.length);
  if ($('paneActive')) {
    const body = activeRuns.length
      ? activeRuns.map((r) => {
        const ui = runUi(r);
        const par = r.parent ? ` · from ${esc(r.parent)}` : '';
        const last = r.last && r.last[0] && r.last[0].text ? esc(clip(r.last[0].text, 90)) : '';
        return `<div class="run"><span class="c" style="background:${esc(r.color)}"></span><span class="t">${esc(r.task)}</span><span class="chip" style="color:${ui.css}"><i></i>${esc(ui.label)}</span><span class="w">${esc(r.label)} · ${esc(r.agent_type || 'subagent')} · ${esc(runDur(r))}${par}${last ? ` · ${last}` : ''}</span></div>`;
      }).join('')
      : '<div class="empty">No active subagent. Everyone idle — coffee, TV, or ping pong.</div>';
    $('paneActive').innerHTML = '<div class="src">Source: <b>running subagent sessions</b> · removed when finished</div>' + body;
  }

  const todos = d.lead.todos;
  if ($('tugasWho')) $('tugasWho').textContent = LEAD_NAME;
  if ($('nTodo')) $('nTodo').textContent = fmtNum.format(todos ? todos.items.filter((it) => it.status !== 'completed').length : 0);
  if ($('paneTodo')) {
    $('paneTodo').innerHTML = `<div class="src">Source: <b>${todos && todos.source ? todos.source : 'task list'}</b> in the main session${todos ? ` · updated ${esc(ago(todos.at))}` : ' (not available yet)'}</div>`
      + (todos && todos.items.length ? todos.items.map((it) => `<div class="todo s-${esc(it.status)}"><i>${it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '▶' : '○'}</i><span>${esc(it.text)}</span></div>`).join('') : '<div class="empty">No task list in the main session yet.</div>');
  }

  const k = d.lead;
  const kLast = k.updated ? `last active ${ago(k.updated)}` : 'no main session yet';
  const kSub = k.other_sessions > 0 ? `+${k.other_sessions} other sessions active`
    : k.activity === 'waiting-team' ? `Waiting for ${k.waiting_on} subagent`
      : k.state === 'idle' ? kLast : k.last?.[0]?.text || kLast;
  const cards = [cardHtml({ key: 'lead', name: LEAD_NAME, role: 'Lead', color: COLORS.lead, state: k.state, task: k.state === 'idle' ? 'Idle — chilling out' : k.activity === 'tool' ? 'Running tool' : 'Main session', act: kSub, working: k.state === 'working' })];
  for (const m of d.team) {
    const r = m.run;
    const task = m.state === 'idle' ? (r ? `Last: ${r.task}` : 'Idle — chilling out') : r?.task || '';
    const act = m.state === 'working' ? r?.last?.[0]?.text || 'Starting work…' : m.state === 'done' ? `Done ${ago(r?.ended)}` : r ? `done ${ago(r.ended)}` : 'waiting for task';
    cards.push(cardHtml({ key: m.key, name: m.name, role: 'Team', color: m.color, state: m.state, task, act, working: m.state === 'working' }));
  }
  const seated = d.freelancers.filter((f) => f.desk !== null && f.desk < SPARE);
  const extra = d.freelancers.filter((f) => f.desk === null || f.desk >= SPARE);
  for (const f of seated) {
    const act = f.state === 'working' ? f.run?.last?.[0]?.text || 'Starting work…' : 'Done, heading home';
    cards.push(cardHtml({ key: f.key, name: f.name, role: 'Freelancer', color: f.color, state: f.state, task: f.run?.task || '', act, working: f.state === 'working' }));
  }
  if (extra.length) {
    const title = extra.map((f) => `Freelancer · ${f.name} — ${STATE_UI[f.state]?.label || f.state}: ${f.run?.task || ''}`).join('\n');
    cards.push(`<div class="card card-ui more" tabindex="0" title="${esc(title)}" aria-label="${esc(`${extra.length} other freelancers without desks`)}"><span class="ava">+${extra.length}</span><div class="h"><span class="nm">Other freelancers</span></div><div class="task">${esc(extra.slice(0, 3).map((f) => f.name).join(', '))}${extra.length > 3 ? ' …' : ''}</div><div class="act">spare desks full — still counted</div></div>`);
  }
  const el = $('cards');
  if (!el) return;
  return;
}

function cardHtml(opts) {
  const { key, name, role, color, state, task, act, working } = opts;
  const chip = STATE_UI[state] || STATE_UI.idle;
  return `<button type="button" class="card card-ui${working ? ' working' : ''}${role === 'Freelancer' ? ' fl' : ''}" data-focus="${esc(key)}" style="--c:${esc(color)}"><span class="ava">${esc(initial(name))}</span><div class="h"><span class="nm">${esc(name)}</span><span class="role">${esc(role)}</span><span class="chip" style="color:${chip.css}"><i></i>${esc(chip.label)}</span></div><div class="task" title="${esc(task)}">${esc(task || '—')}</div><div class="act" title="${esc(act)}">${esc(act || '—')}</div></button>`;
}

let openActorKey = null;
let lastFocusBeforeDetail = null;
function actorScreenPos(a) {
  return worldToScreen(a.gx * TILE, a.gy * TILE);
}
function pickActorAt(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const sx = clientX - r.left;
  const sy = clientY - r.top;
  let best = null;
  let bestD = 34;
  for (const a of actors.values()) {
    if (a.gone) continue;
    const p = actorScreenPos(a);
    const d = Math.hypot(sx - p.sx, sy - p.sy);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}
function actorDetailInfo(a) {
  const d = a.data || null;
  const idleTask = 'Idle — no active task.';
  if (!d) {
    return { name: a.name, role: a.role, color: a.color, state: 'idle', task: idleTask, session8: '–', sessionFull: '', run8: '–', runFull: '', parent: '', last: 'Waiting for next state update.', updated: '' };
  }
  if (a.key === 'lead') {
    const working = d.state === 'working';
    const task = working ? (d.stitle || (d.last && d.last[0] && d.last[0].text) || d.activity || 'Working') : idleTask;
    const last = (d.last && d.last[0] && d.last[0].text) || d.activity || (working ? task : idleTask);
    return { name: d.name || a.name, role: 'Lead', color: d.color || a.color, state: d.state || 'idle', task, session8: d.session || '–', sessionFull: d.session || '', run8: '–', runFull: '', parent: '', last, updated: d.updated || '' };
  }
  const r = d.run || null;
  const working = d.state === 'working' && r;
  const task = working ? (r.task || r.agent_type || 'Working') : idleTask;
  const last = (r && r.last && r.last[0] && r.last[0].text) || (working ? task : (r ? (`done ${ago(r.ended)}`) : idleTask));
  return { name: d.name || a.name, role: d.kind === 'freelancer' ? 'Freelancer' : 'Team', color: d.color || a.color, state: d.state || 'idle', task, session8: r ? short8(r.id) : '–', sessionFull: r ? r.id : '', run8: r && r.segment != null ? `seg-${r.segment}` : (r ? (r.status || '–') : '–'), runFull: r ? (r.task || '') : '', parent: (r && typeof r.parent === 'string') ? r.parent : '', last, updated: (r && (r.updated || r.started)) || '' };
}
function renderActorDetail(a) {
  const info = actorDetailInfo(a);
  const st = STATE_UI[info.state] || STATE_UI.idle;
  $('adAvatar').textContent = initial(info.name);
  $('adAvatar').style.background = info.color || '#8a8378';
  $('adName').textContent = info.name;
  $('adRole').textContent = info.role;
  const chip = $('adStatus');
  chip.textContent = '';
  const dot = document.createElement('i');
  const lab = document.createElement('span');
  lab.textContent = st.label;
  chip.appendChild(dot);
  chip.appendChild(lab);
  chip.style.color = st.css;
  const taskEl = $('adTask');
  taskEl.textContent = info.task;
  taskEl.title = info.task;
  const sEl = $('adSession');
  sEl.textContent = info.session8;
  if (info.sessionFull) sEl.title = info.sessionFull; else sEl.removeAttribute('title');
  const rEl = $('adRun');
  rEl.textContent = info.run8;
  if (info.runFull) rEl.title = info.runFull; else rEl.removeAttribute('title');
  const pRow = $('adParentRow');
  const pEl = $('adParent');
  if (pRow && pEl) {
    pRow.hidden = !info.parent;
    if (info.parent) {
      pEl.textContent = info.parent;
      pEl.title = info.parent;
    }
  }
  $('adLast').textContent = info.last || '–';
  $('adLast').title = info.last || '';
  $('adUpdated').textContent = info.updated ? (`${hhmmss(info.updated)} (${ago(info.updated)})`) : '–';
}
function openActorDetail(key) {
  const a = actors.get(key);
  if (!a) return;
  openActorKey = key;
  lastFocusBeforeDetail = document.activeElement;
  renderActorDetail(a);
  $('detailBackdrop').hidden = false;
  $('actorDetail').hidden = false;
  const btn = $('adClose');
  if (btn) btn.focus({ preventScroll: true });
}
function closeActorDetail() {
  if ($('actorDetail')) $('actorDetail').hidden = true;
  if ($('detailBackdrop')) $('detailBackdrop').hidden = true;
  openActorKey = null;
  if (lastFocusBeforeDetail && lastFocusBeforeDetail.focus) {
    try { lastFocusBeforeDetail.focus({ preventScroll: true }); } catch (err) {}
  }
  lastFocusBeforeDetail = null;
}
function refreshActorDetail() {
  if (!openActorKey) return;
  const a = actors.get(openActorKey);
  if (!a || a.gone) { closeActorDetail(); return; }
  renderActorDetail(a);
}
(function wireActorDetail() {
  const bd = $('detailBackdrop');
  if (bd) bd.addEventListener('click', closeActorDetail);
  const btn = $('adClose');
  if (btn) btn.addEventListener('click', closeActorDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (openActorKey) { e.stopPropagation(); closeActorDetail(); }
  });
  const labelsHost = $('labels');
  if (labelsHost) {
    labelsHost.addEventListener('click', (e) => {
      const t = e.target.closest('[data-actor]');
      if (!t) return;
      focusOn(t.dataset.actor);
      openActorDetail(t.dataset.actor);
    });
  }
})();

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    selectTab(tab.dataset.tab);
    return;
  }
  const fc = e.target.closest('#feedFilter [data-fcat]');
  if (fc && fc.dataset.fcat && FEED_CATS[fc.dataset.fcat]) {
    feedCat = fc.dataset.fcat;
    try {
      localStorage.setItem('workspace.feedCat', feedCat);
    } catch (_) {}
    syncFeedFilter();
    if (lastData) renderUi(lastData);
    return;
  }
  const f = e.target.closest('[data-focus]');
  if (f) focusOn(f.dataset.focus);
});
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'projSel') {
    const v = e.target.value || '';
    if (v) gotoProjectPort(v);
  }
});

function gotoProjectPort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return;
  if (String(p) === String(window.location.port)) return;
  try {
    const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const host = window.location.hostname || '127.0.0.1';
    window.location.href = `${proto}//${host}:${p}/workspace`;
  } catch (_) {  }
}
async function loadProjects() {
  const sel = document.getElementById('projSel');
  const stat = document.getElementById('projStat');
  if (!sel) return;
  const hide = () => { if (stat) stat.hidden = true; else sel.hidden = true; };
  let list = null;
  try {
    const res = await fetch('/workspace/api/projects', { headers: { Accept: 'application/json' } });
    if (!res.ok) { hide(); return; }
    const data = await res.json();
    list = Array.isArray(data) ? data : data.projects;
  } catch (_) {
    hide();
    return;
  }
  if (!Array.isArray(list)) { hide(); return; }
  const items = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const port = Number(p.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    items.push(p);
  }
  if (!items.length) { hide(); return; }
  const here = String(window.location.port);
  if (items.length === 1 && String(Number(items[0].port)) === here) { hide(); return; }
  const base = (s) => String(s || '').split(/[/\\]/).filter(Boolean).pop() || '';
  while (sel.options.length > 1) sel.remove(1);
  for (const p of items) {
    const port = Number(p.port);
    const label = String(p.title || base(p.project) || `project :${port}`);
    const stale = !!p.stale;
    const cur = String(port) === here;
    const opt = document.createElement('option');
    opt.value = String(port);
    opt.textContent = `${label} (:${port})${stale ? ' · stale' : ''}${cur ? ' · current' : ''}`;
    if (cur) opt.selected = true;
    sel.appendChild(opt);
  }
  if (stat) stat.hidden = false;
  else sel.hidden = false;
}

const NARROW_MQ = window.matchMedia('(max-width: 820px)');
function panelOpen(el) {
  if (!el) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  return el.getBoundingClientRect().width > 0;
}
function viewInsets() {
  const narrow = NARROW_MQ.matches;
  const r = $('sideRight');
  return {
    left: 0,
    right: !narrow && panelOpen(r) ? r.offsetWidth : 0,
    top: 0,
    bottom: narrow && panelOpen(r) ? r.offsetHeight : 0,
  };
}
function clampCam() {
  const ins = viewInsets();
  const vw = Math.max(0, (viewW - ins.left - ins.right) / cam.zoom / 2);
  const vh = Math.max(0, (viewH - ins.top - ins.bottom) / cam.zoom / 2);
  const offX = (ins.left - ins.right) / (2 * cam.zoom);
  const offY = (ins.bottom - ins.top) / (2 * cam.zoom);
  cam.x = vw >= MAP_WIDTH / 2 ? MAP_WIDTH / 2 - offX : clamp(cam.x, vw - offX, MAP_WIDTH - vw - offX);
  cam.y = vh >= MAP_HEIGHT / 2 ? MAP_HEIGHT / 2 - offY : clamp(cam.y, vh - offY, MAP_HEIGHT - vh - offY);
}
function shiftCamToVisibleCenter() {
  const ins = viewInsets();
  cam.x -= (ins.left - ins.right) / (2 * cam.zoom);
  cam.y -= (ins.bottom - ins.top) / (2 * cam.zoom);
}
function zoomAt(clientX, clientY, factor) {
  if (!(factor > 0)) return;
  const r = canvas.getBoundingClientRect();
  const before = screenToWorld(clientX - r.left, clientY - r.top);
  const zMin = cam.fitZoom || cam.zoom;
  cam.zoom = clamp(cam.zoom * factor, zMin, zMin * 4);
  cam.userZoom = cam.zoom > zMin + 1e-6;
  const after = screenToWorld(clientX - r.left, clientY - r.top);
  cam.x += before.wx - after.wx;
  cam.y += before.wy - after.wy;
  clampCam();
}
function focusOn(key) {
  const a = actors.get(key);
  if (!a) return;
  cam.x = a.gx * TILE;
  cam.y = a.gy * TILE;
  shiftCamToVisibleCenter();
  clampCam();
}

canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    camStart = { x: cam.x, y: cam.y };
  } else if (pointers.size === 2) {
    dragging = false;
    skipClick = true;
    const pts = [...pointers.values()];
    pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const pts = [...pointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (pinchDist > 0 && d > 0) {
      zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, d / pinchDist);
    }
    pinchDist = d;
    return;
  }
  if (!dragging) return;
  cam.x = camStart.x - (e.clientX - dragStart.x) / cam.zoom;
  cam.y = camStart.y - (e.clientY - dragStart.y) / cam.zoom;
  clampCam();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size > 0) return; 
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  const moved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
  const wasDrag = dragging;
  dragging = false;
  pinchDist = 0;

  if (wasDrag && !skipClick && moved < 6) {
    const closest = pickActorAt(e.clientX, e.clientY);
    if (closest) {
      focusOn(closest.key);
      openActorDetail(closest.key);
    } else if (openActorKey) {
      closeActorDetail();
    }
  }
  skipClick = false;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

canvas.addEventListener('dblclick', (e) => {
  const zMin = cam.fitZoom || cam.zoom;
  if (cam.zoom > zMin + 1e-6) {
    cam.zoom = zMin;
    cam.userZoom = false;
    cam.x = MAP_WIDTH / 2;
    cam.y = MAP_HEIGHT / 2;
    shiftCamToVisibleCenter();
  } else {
    zoomAt(e.clientX, e.clientY, 2);
  }
  clampCam();
});

function resetCameraFit() {
  const ins = viewInsets();
  const availW = Math.max(300, viewW - ins.left - ins.right);
  const availH = Math.max(260, viewH - ins.top - ins.bottom);
  const fit = Math.min(availW / MAP_WIDTH, availH / MAP_HEIGHT);
  const z = clamp(fit, 0.45, 1.4);
  cam.fitZoom = z;
  if (!cam.userZoom) {
    cam.zoom = z;
    cam.x = MAP_WIDTH / 2;
    cam.y = MAP_HEIGHT / 2;
    shiftCamToVisibleCenter();
  }
  cam.zoom = clamp(cam.zoom || z, z, z * 4);
  cam.targetZoom = cam.zoom;
  clampCam();
}

/* ---- right panel is always open; it just has to follow the layout shift ---- */
function watchLayout() {
  if (typeof NARROW_MQ.addEventListener === 'function') NARROW_MQ.addEventListener('change', () => resetCameraFit());
}

function headerH() {
  const t = document.querySelector('.top');
  return t && t.offsetHeight ? t.offsetHeight : 48;
}

function onResize() {
  const th = headerH();
  document.documentElement.style.setProperty('--topH', `${th}px`);
  viewW = window.innerWidth;
  viewH = Math.max(200, window.innerHeight - th);
  canvas.width = Math.round(viewW * DPR);
  canvas.height = Math.round(viewH * DPR);
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
  resetCameraFit();
}
window.addEventListener('resize', onResize);
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) e.preventDefault();
});
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
watchLayout();
selectTab(panelTab, false);
onResize();
syncFeedFilter();

let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const dt = Math.min((now - lastT) / 1000, 0.25);
  lastT = now;

  for (const a of actors.values()) {
    wanderStep(a, now);
    updateActor(a, dt);
  }
  updateChatter(now);

  drawScene(now);
}

requestAnimationFrame(frame);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    lastT = performance.now();
    poll();
  }
});
window.addEventListener('focus', () => {
  stopBlink();
  if (!document.hidden) poll();
});
document.addEventListener('click', () => { stopBlink(); });
document.addEventListener('pointerdown', () => { ensureAudio(); }, { passive: true });
document.addEventListener('keydown', () => { ensureAudio(); });
(function () {
  const mb = $('muteBtn');
  if (mb) mb.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); stopBlink(); });
  syncMuteBtn();
})();
loadProjects();
poll();

setTimeout(() => {
  const l = $('loading');
  if (l) {
    if (l.remove) l.remove();
    else if (l.parentNode) l.parentNode.removeChild(l);
  }
}, 400);

})();
