import assert from 'node:assert/strict'
import test from 'node:test'
import { createOutbox } from '../src/adapters/outbox.mjs'

test('outbox keeps a bounded non-content trace and flags same event/session/part sent twice', async () => {
  let nextId = 700
  const outbox = createOutbox({
    mode: 'onebot-http',
    baseUrl: 'http://fake-gateway.invalid:3000',
    register: false,
    fetchImpl: async () => {
      const messageId = nextId++
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: messageId } }) }
    },
  })
  const trace = { eventIds: ['ev_0123456789abcdef'], sessionHash: 'sess_0123456789abcdef', partIndex: 0 }
  const first = await outbox.send('group:fixture', 'fixture body', { idempotencyKey: 'attempt-1', correlation: trace })
  const second = await outbox.send('group:fixture', 'fixture body', { idempotencyKey: 'attempt-2', correlation: trace })
  assert.equal(first.messageId, 700)
  assert.equal(second.messageId, 701)
  const v = outbox.view()
  assert.equal(v.correlation.duplicateEventParts, 1)
  assert.equal(v.correlation.recent[0].duplicate, true)
  assert.equal(v.correlation.recent[0].messageId, '701')
  assert.equal(v.correlation.recent[0].eventIds[0], trace.eventIds[0])
  assert.equal(v.correlation.recent[0].sessionHash, trace.sessionHash)
  const serialized = JSON.stringify(v.correlation)
  assert.equal(serialized.includes('fixture body'), false)
  assert.equal(serialized.includes('group:fixture'), false)
})

test('missing first message_id is unknown, not duplicate evidence', async () => {
  let call = 0
  const outbox = createOutbox({
    mode: 'onebot-http', baseUrl: 'http://fake-gateway.invalid:3000', register: false,
    fetchImpl: async () => {
      call++
      const data = call === 1 ? {} : { message_id: 901 }
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data }) }
    },
  })
  const correlation = { eventIds: ['ev_0123456789abcdef'], sessionHash: 'sess_0123456789abcdef', partIndex: 0 }
  await outbox.send('group:fixture', 'first', { idempotencyKey: 'missing-id', correlation })
  await outbox.send('group:fixture', 'second', { idempotencyKey: 'has-id', correlation })
  assert.equal(outbox.view().correlation.duplicateEventParts, 0)
})

test('legitimate split bubbles have distinct part indices and do not count as duplicates', async () => {
  let nextId = 800
  const outbox = createOutbox({
    mode: 'onebot-http', baseUrl: 'http://fake-gateway.invalid:3000', register: false,
    fetchImpl: async () => { const messageId = nextId++; return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', data: { message_id: messageId } }) } },
  })
  for (const partIndex of [0, 1]) {
    await outbox.send('private:fixture', 'bubble', {
      idempotencyKey: 'split-' + partIndex,
      correlation: { eventIds: ['ev_abcdef0123456789'], sessionHash: 'sess_abcdef0123456789', partIndex },
    })
  }
  assert.equal(outbox.view().correlation.duplicateEventParts, 0)
  assert.deepEqual(outbox.view().correlation.recent.map((r) => r.partIndex), [1, 0])
})
