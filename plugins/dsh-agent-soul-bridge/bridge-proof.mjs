import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const MARKER_RE = /^[A-Za-z0-9_-]{32,128}$/
const DIGEST_RE = /^[a-f0-9]{64}$/
const PID_FIELDS = ['shellPid', 'corePid']

function validMarker(marker) {
  return typeof marker === 'string' && MARKER_RE.test(marker)
}

function validIdentity(identity) {
  return identity !== null && typeof identity === 'object' &&
    PID_FIELDS.every((field) => Number.isSafeInteger(identity[field]) && identity[field] > 0) &&
    (identity.lockPid === undefined || identity.lockPid === identity.corePid) &&
    (identity.lockRecord === undefined || identity.lockRecord?.pid === identity.corePid)
}

function hashMarker(marker) {
  return createHash('sha256').update(marker, 'utf8').digest('hex')
}

function equalDigest(actual, expected) {
  if (!DIGEST_RE.test(actual) || !DIGEST_RE.test(expected)) return false
  const a = Buffer.from(actual, 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createBridgeMarker() {
  return randomBytes(32).toString('base64url')
}

// The returned payload contains no marker material, only its SHA-256 digest.
export function buildBridgeProofPayload(marker, identity) {
  if (!validMarker(marker) || !validIdentity(identity)) return null
  return Object.freeze({
    markerHash: hashMarker(marker),
    shellPid: identity.shellPid,
    corePid: identity.corePid,
    lockPid: identity.corePid
  })
}

export function verifyBridgeProofPayload(marker, payload, expectedIdentity) {
  if (!validMarker(marker) || !validIdentity(expectedIdentity) ||
      payload === null || typeof payload !== 'object' ||
      !validIdentity(payload) || payload.lockPid !== payload.corePid ||
      typeof payload.markerHash !== 'string') return false

  if (payload.shellPid !== expectedIdentity.shellPid ||
      payload.corePid !== expectedIdentity.corePid ||
      payload.lockPid !== expectedIdentity.lockPid) return false

  return equalDigest(payload.markerHash, hashMarker(marker))
}
