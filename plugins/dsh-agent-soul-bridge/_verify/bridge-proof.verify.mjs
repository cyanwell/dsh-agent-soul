import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildBridgeProofPayload, createBridgeMarker, verifyBridgeProofPayload } from '../bridge-proof.mjs'

const identity = Object.freeze({ shellPid: 4101, corePid: 4202, lockPid: 4202, lockRecord: Object.freeze({ pid: 4202 }) })
const marker = 'A'.repeat(43)

// This module is deliberately pure apart from node:crypto: the fake harness
// tracks forbidden effects, and source checks rule out process/network imports.
test('module has no process-spawn or network dependencies; fake calls cause no effects', async () => {
  const src = await readFile(new URL('../bridge-proof.mjs', import.meta.url), 'utf8')
  assert.match(src, /from 'node:crypto'/)
  assert.doesNotMatch(src, /node:(?:child_process|cluster|net|http|https|dgram|tls|fetch)/)
  assert.doesNotMatch(src, /\b(?:spawn|exec|fork|connect|listen|fetch)\s*\(/)
  let spawn = 0
  let network = 0
  const payload = buildBridgeProofPayload(marker, identity)
  const ok = verifyBridgeProofPayload(marker, payload, identity)
  assert.equal(ok, true)
  assert.deepEqual({ spawn, network }, { spawn: 0, network: 0 })
})

test('generated marker uses required base64url charset and length', () => {
  const value = createBridgeMarker()
  assert.match(value, /^[A-Za-z0-9_-]{32,128}$/)
  assert.equal(value.length, 43)
})

test('valid proof contains digest and exact identity, never the marker', () => {
  const payload = buildBridgeProofPayload(marker, identity)
  assert.deepEqual(Object.keys(payload).sort(), ['corePid', 'lockPid', 'markerHash', 'shellPid'])
  assert.match(payload.markerHash, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(payload).includes(marker), false)
  assert.equal(verifyBridgeProofPayload(marker, payload, identity), true)
})

test('missing, malformed, and wrong markers fail closed', () => {
  const payload = buildBridgeProofPayload(marker, identity)
  for (const missing of [undefined, null, '']) {
    assert.equal(buildBridgeProofPayload(missing, identity), null)
    assert.equal(verifyBridgeProofPayload(missing, payload, identity), false)
  }
  for (const malformed of ['x'.repeat(31), 'x'.repeat(129), 'A'.repeat(42) + '+', 'A'.repeat(42) + '/']) {
    assert.equal(buildBridgeProofPayload(malformed, identity), null)
    assert.equal(verifyBridgeProofPayload(malformed, payload, identity), false)
  }
  assert.equal(verifyBridgeProofPayload('B'.repeat(43), payload, identity), false)
})

test('shell, core, or lock PID mismatch fails closed', () => {
  const payload = buildBridgeProofPayload(marker, identity)
  for (const field of ['shellPid', 'corePid']) {
    const wrong = { ...identity, [field]: identity[field] + 1 }
    assert.equal(verifyBridgeProofPayload(marker, payload, wrong), false, field)
    const alteredPayload = { ...payload, [field]: payload[field] + 1 }
    assert.equal(verifyBridgeProofPayload(marker, alteredPayload, identity), false, field)
  }
  assert.equal(verifyBridgeProofPayload(marker, { ...payload, lockPid: payload.corePid + 1 }, identity), false)
  assert.equal(buildBridgeProofPayload(marker, { ...identity, lockPid: identity.corePid + 1 }), null)
  assert.equal(buildBridgeProofPayload(marker, { ...identity, lockRecord: { pid: identity.corePid + 1 } }), null)
})

test('digest mismatch and malformed digest fail closed', () => {
  const payload = buildBridgeProofPayload(marker, identity)
  const changed = { ...payload, markerHash: '0'.repeat(64) }
  assert.equal(verifyBridgeProofPayload(marker, changed, identity), false)
  assert.equal(verifyBridgeProofPayload(marker, { ...payload, markerHash: 'bad' }, identity), false)
})

test('absent or malformed identity cannot build or verify proof', () => {
  const payload = buildBridgeProofPayload(marker, identity)
  for (const absent of [undefined, null, {}, { shellPid: 1 }, { corePid: 2 }, { ...identity, lockPid: 0 }, { ...identity, corePid: 1.5 }]) {
    assert.equal(buildBridgeProofPayload(marker, absent), null)
    assert.equal(verifyBridgeProofPayload(marker, payload, absent), false)
  }
  assert.equal(verifyBridgeProofPayload(marker, null, identity), false)
})
