import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPlainObj, readText } from './util.mjs';

let mem = null; 

function serviceFile() {
  const base = process.env.XDG_CONFIG_HOME
    || (os.platform() === 'win32' ? path.join(os.homedir(), '.config') : path.join(os.homedir(), '.config'));
  return path.join(base, 'opencode', 'service.json');
}

function readPassword() {
  if (process.env.WORKSPACE_OPENCODE_PASSWORD) return String(process.env.WORKSPACE_OPENCODE_PASSWORD);
  try {
    const v = JSON.parse(fs.readFileSync(serviceFile(), 'utf8'));
    return isPlainObj(v) && typeof v.password === 'string' ? v.password : '';
  } catch {
    return '';
  }
}

function statusUrl(projectDir) {
  if (process.env.WORKSPACE_OPENCODE_URL) return String(process.env.WORKSPACE_OPENCODE_URL).replace(/\/+$/, '');
  const bin = process.env.WORKSPACE_OPENCODE_BIN || 'opencode';
  try {
    const [cmd, args] = os.platform() === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', `${bin} service status`]]
      : [bin, ['service', 'status']];
    const out = execFileSync(cmd, args,
      { cwd: projectDir, timeout: 10000, encoding: 'utf8', windowsHide: true });
    const m = /https?:\/\/[^\s"']+/.exec(String(out));
    return m ? m[0].replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

function cacheFile(storageDir) {
  return storageDir ? path.join(storageDir, 'oc-service.json') : null;
}

export function resetService() {
  mem = null;
}

export function getService(projectDir, storageDir) {
  if (mem) return mem;
  const cf = cacheFile(storageDir);
  if (cf) {
    try {
      const v = JSON.parse(fs.readFileSync(cf, 'utf8'));
      if (isPlainObj(v) && typeof v.url === 'string' && v.url !== '') {
        mem = { url: v.url, password: typeof v.password === 'string' && v.password !== '' ? v.password : readPassword() };
        if (mem.password !== '') return mem;
        mem = null;
      }
    } catch {
    }
  }
  const url = statusUrl(projectDir);
  if (!url) return null;
  const password = readPassword();
  if (password === '') return null;
  mem = { url, password };
  if (cf) {
    try {
      // `oc-service.json` records where the local service listens, which feeds the trust decision,
      // so keep it owner-only: 0700 for a directory this call creates, 0600 for the file. `mkdir`
      // only applies the mode to directories it creates itself, so an existing shared parent such
      // as `~/.cache` is never re-permissioned; the explicit chmod covers a file an older release
      // created with a looser mode. Both modes are POSIX-only and Windows largely ignores them.
      fs.mkdirSync(path.dirname(cf), { recursive: true, mode: 0o700 });
      fs.writeFileSync(cf, JSON.stringify({ url, at: Date.now() }), { mode: 0o600 });
      fs.chmodSync(cf, 0o600);
    } catch {
    }
  }
  return mem;
}

export async function apiGet(svc, apiPath) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res;
  try {
    res = await fetch(svc.url + apiPath, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`opencode:${svc.password}`, 'utf8').toString('base64')}`,
      },
    });
  } catch (e) {
    resetService();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`opencode ${res.status} for ${apiPath}`);
  return res.json();
}

export function normDir(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export { readText };
