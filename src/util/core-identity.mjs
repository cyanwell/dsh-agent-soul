// Optional bridge-launch identity for the embedded core. No identity is synthesized here.
// If any manager field is present, all fields must be well-formed and the shell PID must match
// AGENT_SOUL_PARENT. Call before acquiring core.lock; legacy desktop launches stay unchanged.
import crypto from 'node:crypto';

const MARKER_RE = /^[A-Za-z0-9_-]{32,128}$/;

function markerDigest(marker) {
  return crypto.createHash('sha256').update(String(marker), 'utf8').digest('hex');
}

export function readLaunchIdentity(env = process.env) {
  const marker = String(env.AGENT_SOUL_MANAGER_MARKER || '').trim();
  const shellPidText = String(env.AGENT_SOUL_MANAGER_SHELL_PID || '').trim();
  const expectedParentText = String(env.AGENT_SOUL_PARENT || '').trim();
  if (!marker && !shellPidText) return { ok: true, managed: false, identity: null };
  if (!MARKER_RE.test(marker)) return { ok: false, code: 'manager-marker-invalid' };
  if (!/^\d{1,10}$/.test(shellPidText)) return { ok: false, code: 'manager-shell-pid-invalid' };
  if (!/^\d{1,10}$/.test(expectedParentText)) return { ok: false, code: 'parent-pid-missing' };
  const shellPid = Number(shellPidText);
  const parentPid = Number(expectedParentText);
  if (!Number.isSafeInteger(shellPid) || shellPid <= 0 || !Number.isSafeInteger(parentPid) || parentPid <= 0 || shellPid !== parentPid) {
    return { ok: false, code: 'manager-parent-mismatch' };
  }
  return { ok: true, managed: true, identity: Object.freeze({ managed: true, marker, markerHash: markerDigest(marker), shellPid, parentPid }) };
}

export function verifyManagerProof(lockRecord, proof) {
  const manager = lockRecord && lockRecord.manager;
  if (!manager || !proof || typeof proof !== 'object') return { ok: false, code: 'manager-identity-unavailable' };
  const marker = String(proof.marker || '');
  const shellPid = Number(proof.shellPid);
  const corePid = Number(proof.corePid);
  if (!MARKER_RE.test(marker) || !Number.isSafeInteger(shellPid) || shellPid <= 0 || !Number.isSafeInteger(corePid) || corePid <= 0) return { ok: false, code: 'manager-proof-invalid' };
  const supplied = Buffer.from(markerDigest(marker), 'hex');
  const expected = Buffer.from(String(manager.markerHash || ''), 'hex');
  const markerMatches = supplied.length === 32 && expected.length === 32 && crypto.timingSafeEqual(supplied, expected);
  if (!markerMatches || shellPid !== Number(manager.shellPid) || corePid !== Number(manager.corePid) || corePid !== Number(lockRecord.pid)) return { ok: false, code: 'manager-proof-mismatch' };
  return { ok: true, shellPid, corePid };
}

export function managerIdentityView(lockRecord) {
  const manager = lockRecord && lockRecord.manager;
  const corePid = Number(lockRecord && lockRecord.pid);
  const parentPid = Number(lockRecord && lockRecord.parentPid);
  if (!manager || !Number.isSafeInteger(corePid) || corePid <= 0 || manager.corePid !== corePid) return { ok: false, code: 'manager-identity-unavailable' };
  if (!Number.isSafeInteger(manager.shellPid) || manager.shellPid <= 0 || !Number.isSafeInteger(parentPid) || parentPid <= 0 || manager.shellPid !== parentPid || typeof manager.markerHash !== 'string' || !/^[a-f0-9]{64}$/.test(manager.markerHash)) return { ok: false, code: 'manager-lock-invalid' };
  if (!lockRecord.startedAt || !Number.isFinite(Date.parse(lockRecord.startedAt))) return { ok: false, code: 'manager-lock-time-invalid' };
  return { ok: true, identity: Object.freeze({ corePid, shellPid: manager.shellPid, startedAt: String(lockRecord.startedAt), markerHash: manager.markerHash }) };
}

export function bindLaunchIdentity(record, launchIdentity, corePid) {
  if (!record || typeof record !== 'object') throw new TypeError('core lock record is required');
  if (!launchIdentity) return record;
  const marker = String(launchIdentity.marker || '');
  const shellPid = Number(launchIdentity.shellPid);
  const parentPid = Number(launchIdentity.parentPid);
  if (launchIdentity.managed !== true || !MARKER_RE.test(marker) || !Number.isSafeInteger(shellPid) || shellPid <= 0 || !Number.isSafeInteger(parentPid) || parentPid <= 0 || shellPid !== parentPid) {
    throw Object.assign(new Error('invalid manager launch identity'), { code: 'manager-identity-invalid' });
  }
  const digest = markerDigest(marker);
  if (launchIdentity.markerHash !== undefined && launchIdentity.markerHash !== digest) {
    throw Object.assign(new Error('manager marker digest mismatch'), { code: 'manager-identity-invalid' });
  }
  const pid = Number(corePid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Object.assign(new Error('core PID is invalid'), { code: 'core-pid-invalid' });
  return Object.assign({}, record, {
    parentPid: shellPid,
    manager: Object.freeze({ markerHash: digest, shellPid, corePid: pid }),
  });
}
