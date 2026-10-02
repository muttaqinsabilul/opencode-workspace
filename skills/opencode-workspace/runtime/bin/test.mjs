#!/usr/bin/env node
// Single entry point for the whole suite, portable on Windows and POSIX shells:
//   node bin/test.mjs [--project=<dir>] [--php-port=8803] [--node-port=8804] [--check-port=8805]
// Step 1 is parity.mjs (PHP built-in server vs Node server, compared byte for
// byte). Step 2 is check.mjs against a throwaway Node server. Step 3 covers port
// rotation. Every run is hermetic: state, storage and the registry live in a temp
// dir that is removed before we exit, and no child is allowed to keep a port bound.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const RUNTIME = path.dirname(BIN);
const arg = (k, d) => process.argv.slice(2).filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3)).pop() ?? d;
const PHP_PORT = Number(arg('php-port', 8803));
const NODE_PORT = Number(arg('node-port', 8804));
const CHECK_PORT = Number(arg('check-port', 8805));
const PROJECT = arg('project', process.cwd());
const IS_WIN = process.platform === 'win32';
const failed = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pass = (n) => console.log(`  PASS ${n}`);
const fail = (n) => {
  failed.push(n);
  console.log(`  FAIL ${n}`);
};
const run = (script, args) => spawnSync(process.execPath, [path.join(BIN, script), ...args], { stdio: 'inherit', windowsHide: true }).status ?? 1;

// Same Windows kill path as parity.mjs: child.kill() never reaches the tree.
const killTree = (p) => {
  if (!p || !p.pid) return;
  try {
    p.kill();
  } catch {
  }
  if (IS_WIN) {
    try {
      spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
    }
  }
};
const portFree = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  let settled = false;
  const done = (v) => {
    if (!settled) {
      settled = true;
      s.destroy();
      resolve(v);
    }
  };
  s.on('connect', () => done(false));
  s.on('error', () => done(true));
  setTimeout(() => done(true), 1000);
});
const ping = (port) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/workspace/api/ping' }, (res) => {
    res.resume();
    resolve(res.statusCode === 200);
  });
  req.on('error', () => resolve(false));
  req.end();
});

console.log(`workspace suite · project ${PROJECT} · php ${PHP_PORT} · node ${NODE_PORT} · check ${CHECK_PORT}`);

console.log('\n-- syntax');
for (const s of ['parity.mjs', 'check.mjs', 'test.mjs']) {
  if (spawnSync(process.execPath, ['--check', path.join(BIN, s)], { stdio: 'ignore', windowsHide: true }).status === 0) pass(`node --check ${s}`);
  else fail(`node --check ${s}`);
}

console.log('\n-- parity: php -S vs node');
if (spawnSync('php', ['-r', 'echo PHP_VERSION;'], { stdio: 'ignore', windowsHide: true }).status !== 0) fail('php not on PATH (parity needs PHP >= 8.1)');
else if (run('parity.mjs', [`--project=${PROJECT}`, `--php-port=${PHP_PORT}`, `--node-port=${NODE_PORT}`]) === 0) pass('parity.mjs');
else fail('parity.mjs');

console.log('\n-- check: node server');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
const srv = spawn(process.execPath, [path.join(BIN, 'serve-node.mjs')], {
  cwd: RUNTIME,
  env: {
    ...process.env,
    WORKSPACE_PROJECT: PROJECT,
    WORKSPACE_STORAGE: path.join(TMP, 'storage'),
    XDG_CACHE_HOME: path.join(TMP, 'cache'),
    WORKSPACE_PORT: String(CHECK_PORT),
    WORKSPACE_BIND: '127.0.0.1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});
let srvErr = '';
srv.stderr.on('data', (d) => {
  srvErr += d;
});
process.on('exit', () => {
  killTree(srv);
  fs.rmSync(TMP, { recursive: true, force: true });
});
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(150);
    up = await ping(CHECK_PORT);
  }
  if (!up) fail(`check.mjs (no server on ${CHECK_PORT}${srvErr ? `: ${srvErr.slice(0, 200)}` : ''})`);
  else if (run('check.mjs', [`http://127.0.0.1:${CHECK_PORT}`]) === 0) pass('check.mjs');
  else fail('check.mjs');
} finally {
  killTree(srv);
  let free = false;
  for (let i = 0; i < 50 && !free; i++) {
    await sleep(100);
    killTree(srv);
    free = await portFree(CHECK_PORT);
  }
  if (free) pass(`port ${CHECK_PORT} released`);
  else fail(`port ${CHECK_PORT} still bound after cleanup`);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('\n-- port rotation on a busy port');
// Regression: the Windows launchers (workspace.ps1 / workspace.cmd) reach serve-node.mjs
// with no port pre-flight, so a busy port must move up instead of exiting 3.
const ROT = CHECK_PORT + 1;
const RTMP = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-rotate-'));
const rotEnv = (port, strict) => ({
  ...process.env,
  WORKSPACE_PROJECT: PROJECT,
  WORKSPACE_STORAGE: path.join(RTMP, 'storage'),
  XDG_CACHE_HOME: path.join(RTMP, 'cache'),
  WORKSPACE_PORT: String(port),
  WORKSPACE_BIND: '127.0.0.1',
  ...(strict ? { WORKSPACE_PORT_STRICT: '1' } : { WORKSPACE_PORT_STRICT: '' }),
});
const spawnRot = (port, strict) => {
  const p = spawn(process.execPath, [path.join(BIN, 'serve-node.mjs')], { cwd: RUNTIME, env: rotEnv(port, strict), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  p.err = '';
  p.stderr.on('data', (d) => {
    p.err += d;
  });
  return p;
};
const waitPing = async (port, tries) => {
  for (let i = 0; i < tries; i++) {
    if (await ping(port)) return true;
    await sleep(150);
  }
  return false;
};
// Hold ROT with a plain TCP listener before the rotation cases start. Spawning two
// servers on the same port and hoping the first one wins is a coin flip on Windows:
// when the second one won, it held ROT, the first moved up, and the assertion failed
// for a server that had behaved correctly. A listener we own removes the race.
const rotBlocker = net.createServer();
await new Promise((r) => rotBlocker.listen(ROT, '127.0.0.1', r));
const holder = spawnRot(ROT, false);
const moved = spawnRot(ROT, false);
const strict = spawnRot(ROT, true);
process.on('exit', () => {
  killTree(holder);
  killTree(moved);
  killTree(strict);
  try { rotBlocker.close(); } catch {}
  fs.rmSync(RTMP, { recursive: true, force: true });
});
try {
  // rotBlocker already owns ROT, so the loose launcher must step up to ROT + 1.
  if (await waitPing(ROT + 1, 200) && /already in use/.test(moved.err)) pass(`busy port ${ROT} moves to ${ROT + 1}`);
  else fail(`busy port ${ROT} did not move to ${ROT + 1}${moved.err ? `: ${moved.err.slice(0, 200)}` : ''}`);
  const code = await new Promise((r) => {
    if (strict.exitCode !== null) return r(strict.exitCode);
    strict.on('exit', r);
  });
  // workspace.sh owns the walk and reads exit 3 to retry one port up; strict mode keeps that contract.
  if (code === 3) pass('WORKSPACE_PORT_STRICT=1 still exits 3 on a busy port');
  else fail(`WORKSPACE_PORT_STRICT=1 exited ${code}, want 3`);
} finally {
  killTree(holder);
  killTree(moved);
  killTree(strict);
  await new Promise((r) => rotBlocker.close(r));
  let free = false;
  for (let i = 0; i < 50 && !free; i++) {
    await sleep(100);
    killTree(holder);
    killTree(moved);
    free = await portFree(ROT) && await portFree(ROT + 1);
  }
  if (free) pass(`ports ${ROT}–${ROT + 1} released`);
  else fail(`ports ${ROT}–${ROT + 1} still bound after cleanup`);
  fs.rmSync(RTMP, { recursive: true, force: true });
}

console.log(failed.length ? `\nSUITE FAILED: ${failed.join(', ')}` : '\nSUITE OK');
process.exit(failed.length ? 1 : 0);