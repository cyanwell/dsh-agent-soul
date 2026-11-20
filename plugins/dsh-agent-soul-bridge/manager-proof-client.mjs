import { createHash, timingSafeEqual } from 'node:crypto'

const MARKER_RE = /^[A-Za-z0-9_-]{32,128}$/
const HASH_RE = /^[a-f0-9]{64}$/

function sameHash(actual, expected) {
  if (typeof actual !== 'string' || !HASH_RE.test(actual) || !HASH_RE.test(expected)) return false
  const a = Buffer.from(actual, 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function readManagerProof({ marker, shellPid, healthCorePid, token, fetchImpl, baseUrl, signal } = {}) {
  if (typeof marker !== 'string' || !MARKER_RE.test(marker)) return { ok: false, code: 'marker-invalid' }
  if (!Number.isSafeInteger(shellPid) || shellPid <= 0 || !Number.isSafeInteger(healthCorePid) || healthCorePid <= 0) return { ok: false, code: 'pid-invalid' }
  if (typeof token !== 'string' || !token || typeof fetchImpl !== 'function' || typeof baseUrl !== 'string' || !baseUrl) return { ok: false, code: 'proof-transport-unavailable' }
  let response
  try { response = await fetchImpl(new URL('/api/manager-proof', baseUrl), { method: 'GET', headers: { 'X-Soul-Token': token }, signal }) }
  catch { return { ok: false, code: 'proof-unavailable' } }
  if (!response || response.ok !== true || typeof response.json !== 'function') return { ok: false, code: 'proof-unavailable' }
  let body
  try { body = await response.json() } catch { return { ok: false, code: 'proof-invalid' } }
  const identity = body && body.ok === true && body.identity
  if (!identity || Object.keys(identity).sort().join(',') !== 'corePid,markerHash,shellPid,startedAt') return { ok: false, code: 'proof-invalid' }
  if (identity.shellPid !== shellPid || identity.corePid !== healthCorePid) return { ok: false, code: 'proof-pid-mismatch' }
  if (typeof identity.startedAt !== 'string' || !Number.isFinite(Date.parse(identity.startedAt))) return { ok: false, code: 'proof-time-invalid' }
  const expectedHash = createHash('sha256').update(marker, 'utf8').digest('hex')
  if (!sameHash(identity.markerHash, expectedHash)) return { ok: false, code: 'proof-marker-mismatch' }
  return { ok: true, identity: Object.freeze({ shellPid, corePid: healthCorePid, startedAt: identity.startedAt, markerHash: identity.markerHash }) }
}
