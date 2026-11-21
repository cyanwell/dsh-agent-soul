#!/usr/bin/env node
// ECHO 第三轮性能原型：只做 TEMP synthetic 的发现成本与失效状态，不写生产 ECHO。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listSessionFiles, resolveSessionVersions } from './echo-live-sync.mjs';

const REAL_TMP = fs.realpathSync(os.tmpdir());

export function assertTempTarget(target) {
  const abs = path.resolve(String(target));
  if (!(abs === REAL_TMP || abs.startsWith(REAL_TMP + path.sep))) {
    throw new Error('WRITE_TARGET_OUTSIDE_OS_TMPDIR: ' + abs);
  }
  return abs;
}

function keyOf(file) {
  const st = fs.statSync(file);
  return { key: st.mtimeMs + ':' + st.size, size: st.size, mtimeMs: st.mtimeMs };
}

function fullManifest(sourceRoot) {
  const raw = listSessionFiles(sourceRoot);
  if (!raw.length) throw new Error('E_NO_SESSIONS: no synthetic session files');
  const resolved = resolveSessionVersions(raw);
  if (resolved.ambiguous.length) throw new Error('E_AMBIGUOUS_SESSION: ' + resolved.ambiguous.length);
  const files = resolved.files.map((f) => ({
    file: path.resolve(f.file).replace(/\\/g, '/'), sid: f.sid, ver: f.ver, ws: f.ws ?? null, ...keyOf(f.file),
  }));
  return { files, byFile: new Map(files.map((f) => [f.file, f])), rows: files.length };
}

function compareManifest(before, after) {
  const changes = [];
  for (const [file, now] of after.byFile) {
    const old = before.byFile.get(file);
    if (!old) changes.push({ type: 'new', file, sid: now.sid });
    else if (old.key !== now.key) changes.push({ type: 'changed', file, sid: now.sid, from: old.key, to: now.key });
  }
  for (const [file, old] of before.byFile) {
    if (!after.byFile.has(file)) changes.push({ type: 'deleted', file, sid: old.sid });
  }
  return changes;
}

/**
 * 完整解析一次目录清单和 mtime:size 指纹；后续 idleRound 不列目录、不 stat。
 * 变化探测必须由外部事件/定期 reconcile 驱动，这里不把缓存命中冒充同步。
 */
export function createManifestFingerprintCache(sourceRoot) {
  const root = assertTempTarget(sourceRoot);
  let manifest = fullManifest(root);
  let dirty = false;
  let overflow = false;
  const candidates = new Map();
  return {
    initial: { state: 'ready', authoritative: false, rows: manifest.rows, files: manifest.files },
    idleRound(reason = 'no-event') {
      return { state: 'candidate', invalidation: dirty ? 'pending' : 'none', authoritative: false, reason, rows: manifest.rows, reads: { readdir: 0, stat: 0 }, candidates: [...candidates.values()] };
    },
    invalidate(file, type = 'changed', reason = 'watch-hint') {
      const abs = path.resolve(file).replace(/\\/g, '/');
      const candidate = { type, file: abs, reason };
      candidates.set(abs, candidate); dirty = true;
      return { state: 'candidate', invalidation: 'pending', authoritative: false, candidate };
    },
    markOverflow(reason = 'watch-overflow') {
      overflow = true; dirty = true;
      return { state: 'candidate', invalidation: 'overflow', authoritative: false, reason };
    },
    reconcile() {
      const before = manifest;
      const next = fullManifest(root);
      const changes = compareManifest(before, next);
      for (const c of candidates.values()) if (!changes.some((x) => x.file === c.file)) changes.push(c);
      const result = { state: 'candidate', invalidation: changes.length ? 'rebuild-required' : 'revalidated', authoritative: false, overflow, rows: next.rows, changes, reads: { readdir: null, stat: null } };
      manifest = next; dirty = false; overflow = false; candidates.clear();
      return result;
    },
    files() { return manifest.files.slice(); },
  };
}

export function measureNodeSpawnCost(rounds, nodePath = process.execPath) {
  const n = Math.max(1, Number(rounds) || 1);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i += 1) {
    const child = spawnSync(nodePath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
    if (child.status !== 0) throw new Error('child startup failed: ' + child.status);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { rounds: n, wallMs: ms, perRoundMs: ms / n, status: 'cost-model-only', residentWorker: 'not-implemented' };
}