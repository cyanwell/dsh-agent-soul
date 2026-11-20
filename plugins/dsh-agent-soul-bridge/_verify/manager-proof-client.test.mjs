import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readManagerProof } from '../manager-proof-client.mjs'

const marker = 'B'.repeat(43)
const markerHash = createHash('sha256').update(marker).digest('hex')
const identity = { corePid: 8802, shellPid: 8801, startedAt: '2026-11-19T22:00:00.000Z', markerHash }
function fakeFetch(body, status = 200, capture = {}) {
  return async (url, init) => { capture.url = String(url); capture.init = init; return { ok: status >= 200 && status < 300, status, json: async () => body } }
}
const base = { marker, shellPid: 8801, healthCorePid: 8802, token: 'test-token-never-log', baseUrl: 'http://127.0.0.1:7310' }

test('valid proof binds shell spawn PID, health core PID, hash, and sends token header only', async () => {
  const capture = {}
  const result = await readManagerProof({ ...base, fetchImpl: fakeFetch({ ok: true, identity }, 200, capture) })
  assert.equal(result.ok, true)
  assert.deepEqual(result.identity, { shellPid: 8801, corePid: 8802, startedAt: identity.startedAt, markerHash })
  assert.equal(capture.url, 'http://127.0.0.1:7310/api/manager-proof')
  assert.deepEqual(capture.init.headers, { 'X-Soul-Token': base.token })
  assert.equal(Object.keys(capture.init.headers).some(k => /token/i.test(k) && k !== 'X-Soul-Token'), false)
  assert.equal(JSON.stringify(result).includes(marker), false)
  assert.equal(JSON.stringify(result).includes(base.token), false)
})

test('wrong marker hash, shell/core PID swap, or extra fields fail closed', async () => {
  const cases = [
    [{ ...identity, markerHash: 'a'.repeat(64) }, 'proof-marker-mismatch'],
    [{ ...identity, shellPid: 8802, corePid: 8801 }, 'proof-pid-mismatch'],
    [{ ...identity, unrelated: 'leak' }, 'proof-invalid'],
    [{ ...identity, startedAt: 'bad-time' }, 'proof-time-invalid'],
  ]
  for (const [bad, code] of cases) {
    const result = await readManagerProof({ ...base, fetchImpl: fakeFetch({ ok: true, identity: bad }) })
    assert.deepEqual(result, { ok: false, code })
  }
})

test('missing credentials or unavailable HTTP response fail closed without fetch', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: false, status: 409, json: async () => ({ ok: false }) } }
  assert.deepEqual(await readManagerProof({ ...base, token: '', fetchImpl }), { ok: false, code: 'proof-transport-unavailable' })
  assert.deepEqual(await readManagerProof({ ...base, fetchImpl: async () => { calls++; throw new Error('opaque') } }), { ok: false, code: 'proof-unavailable' })
  assert.equal(calls, 1)
})
