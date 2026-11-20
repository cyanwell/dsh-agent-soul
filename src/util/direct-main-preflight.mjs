// Read-only sequencing gate for explicitly managed isolated launches.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLaunchIdentity } from './core-identity.mjs';

function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

function canonicalPath(value, label, kind) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, code: `${label}-missing` };
  const resolved = path.resolve(value);
  if (resolved !== value) return { ok: false, code: `${label}-noncanonical` };
  let real;
  try { real = fs.realpathSync(resolved); } catch { return { ok: false, code: `${label}-missing` }; }
  if (real !== resolved) return { ok: false, code: `${label}-noncanonical` };
  let stat;
  try { stat = fs.statSync(real); } catch { return { ok: false, code: `${label}-missing` }; }
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) return { ok: false, code: `${label}-wrong-type` };
  return { ok: true, path: real };
}

export async function checkDirectMainPreflight(env = process.env) {
  if (env.AGENT_SOUL_PREFLIGHT === undefined) return { ok: true, mode: 'legacy-allowed' };
  if (env.AGENT_SOUL_PREFLIGHT !== '1') return { ok: false, code: 'preflight-flag-invalid' };

  const identity = readLaunchIdentity(env);
  if (!identity.ok || identity.managed !== true) return { ok: false, code: identity.code || 'manager-identity-required' };

  let tempRoot;
  try { tempRoot = fs.realpathSync(os.tmpdir()); } catch { return { ok: false, code: 'temp-root-unavailable' }; }
  const specs = [
    ['AGENT_SOUL_HOME', 'isolated-root', 'directory'],
    ['AGENT_SOUL_PREFLIGHT_CONFIG', 'config-path', 'file'],
    ['AGENT_SOUL_DATA', 'data-path', 'directory'],
    ['AGENT_SOUL_SELF', 'self-path', 'file'],
    ['AGENT_SOUL_SYNC_SOURCE_ROOT', 'sync-source-root', 'directory'],
  ];
  const paths = {};
  for (const [key, label, kind] of specs) {
    const checked = canonicalPath(env[key], label, kind);
    if (!checked.ok) return checked;
    if (!isWithin(tempRoot, checked.path)) return { ok: false, code: `${label}-outside-temp` };
    paths[key] = checked.path;
  }

  const root = paths.AGENT_SOUL_HOME;
  if (root === tempRoot) return { ok: false, code: 'isolated-root-not-child-of-temp' };
  for (const [key, target] of Object.entries(paths)) {
    if (key !== 'AGENT_SOUL_HOME' && key !== 'AGENT_SOUL_SYNC_SOURCE_ROOT' && !isWithin(root, target)) return { ok: false, code: `${key.toLowerCase()}-outside-isolated-root` };
  }
  if (!isWithin(root, paths.AGENT_SOUL_SYNC_SOURCE_ROOT)) return { ok: false, code: 'sync-source-root-outside-isolated-root' };
  paths.configFile = paths.AGENT_SOUL_PREFLIGHT_CONFIG;
  paths.syncSourceRoot = paths.AGENT_SOUL_SYNC_SOURCE_ROOT;
  return { ok: true, mode: 'managed-preflight-passed', paths, notValidated: ['persona'] };
}
