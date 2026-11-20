import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindLaunchIdentity, managerIdentityView, readLaunchIdentity, verifyManagerProof } from '../src/util/core-identity.mjs';
import { acquireSingleInstance, releaseSingleInstance } from '../src/util/core-guard.mjs';

const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agent-soul-identity-test-'));
try {
  const legacy = readLaunchIdentity({});
  assert.deepEqual(legacy, { ok: true, managed: false, identity: null });
  const legacyParent = readLaunchIdentity({ AGENT_SOUL_PARENT: '321' });
  assert.deepEqual(legacyParent, { ok: true, managed: false, identity: null }, 'legacy desktop parent-watchdog remains unmanaged');
  for (const env of [
    { AGENT_SOUL_MANAGER_MARKER: 'partial-marker' },
    { AGENT_SOUL_MANAGER_SHELL_PID: '321' },
    { AGENT_SOUL_MANAGER_MARKER: 'x'.repeat(32), AGENT_SOUL_MANAGER_SHELL_PID: '321' },
    { AGENT_SOUL_MANAGER_MARKER: 'x'.repeat(32), AGENT_SOUL_MANAGER_SHELL_PID: '321', AGENT_SOUL_PARENT: '322' },
    { AGENT_SOUL_MANAGER_MARKER: 'x'.repeat(32), AGENT_SOUL_MANAGER_SHELL_PID: '-1', AGENT_SOUL_PARENT: '-1' },
  ]) assert.equal(readLaunchIdentity(env).ok, false, 'partial/malformed or mismatched identity must reject');

  const marker = 'A'.repeat(43);
  const env = { AGENT_SOUL_MANAGER_MARKER: marker, AGENT_SOUL_MANAGER_SHELL_PID: '321', AGENT_SOUL_PARENT: '321' };
  const parsed = readLaunchIdentity(env);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.identity.marker, marker);
  assert.equal(parsed.identity.shellPid, 321);
  assert.equal(parsed.identity.parentPid, 321);
  assert.equal(parsed.identity.markerHash.length, 64);
  assert.equal(parsed.identity.managed, true);

  const bound = bindLaunchIdentity({ pid: process.pid, parentPid: 321, startedAt: '2026-11-19T00:00:00.000Z', port: 7310 }, parsed.identity, process.pid);
  assert.deepEqual(bound.manager, { markerHash: parsed.identity.markerHash, shellPid: 321, corePid: process.pid });
  assert.equal(JSON.stringify(bound).includes(marker), false, 'plaintext marker must not be written into core.lock');
  assert.deepEqual(verifyManagerProof(bound, { marker, shellPid: 321, corePid: process.pid }), { ok: true, shellPid: 321, corePid: process.pid });
  const identityView = managerIdentityView(bound);
  assert.deepEqual(identityView, { ok: true, identity: { corePid: process.pid, shellPid: 321, startedAt: '2026-11-19T00:00:00.000Z', markerHash: parsed.identity.markerHash } });
  for (const badLock of [{ pid: process.pid }, { pid: process.pid, startedAt: '2026-11-19T00:00:00.000Z', manager: { corePid: process.pid + 1, shellPid: 321, markerHash: parsed.identity.markerHash } }, { pid: process.pid, parentPid: 322, startedAt: '2026-11-19T00:00:00.000Z', manager: bound.manager }, { pid: process.pid, startedAt: 'bad-time', manager: bound.manager }, { pid: process.pid, startedAt: '2026-11-19T00:00:00.000Z', manager: { corePid: process.pid, shellPid: 321, markerHash: 'bad' } }]) assert.equal(managerIdentityView(badLock).ok, false, 'malformed or legacy lock returns unavailable');
  for (const proof of [{ marker: 'B'.repeat(43), shellPid: 321, corePid: process.pid }, { marker, shellPid: 322, corePid: process.pid }, { marker, shellPid: 321, corePid: process.pid + 1 }, { marker: '', shellPid: 321, corePid: process.pid }]) assert.equal(verifyManagerProof(bound, proof).ok, false, 'bad marker or PID tuple must fail closed');
  assert.equal(verifyManagerProof({ pid: process.pid }, { marker, shellPid: 321, corePid: process.pid }).ok, false, 'legacy lock has no manager identity');
  assert.throws(() => bindLaunchIdentity({ pid: 456 }, { managed: true, marker: parsed.identity.marker, markerHash: parsed.identity.markerHash, shellPid: 321, parentPid: 321 }, 0), { code: 'core-pid-invalid' });

  assert.throws(() => bindLaunchIdentity({ pid: process.pid }, { managed: true, marker: parsed.identity.marker, markerHash: '0'.repeat(64), shellPid: 321, parentPid: 321 }, process.pid), { code: 'manager-identity-invalid' });
  assert.throws(() => bindLaunchIdentity({ pid: process.pid }, { managed: true, marker: parsed.identity.marker, shellPid: 321, parentPid: 322 }, process.pid), { code: 'manager-identity-invalid' });

  const dataDir = path.join(tempRoot, 'data');
  const lock = acquireSingleInstance(dataDir, bound);
  assert.equal(lock.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock.file, 'utf8')).manager, bound.manager);
  releaseSingleInstance(lock);
  assert.equal(fs.existsSync(lock.file), false, 'TEMP core.lock must be removed');
  console.log('core identity selftest: PASS (legacy/managed/malformed/parent mismatch/hash-only lock)');
} finally {
  const markerPath = path.join(tempRoot, 'data', 'core.lock');
  if (fs.existsSync(markerPath)) fs.rmSync(markerPath, { force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
