import assert from 'node:assert/strict'
import test from 'node:test'
import { createOneBotIngress } from '../src/events/ingress-onebot.mjs'
import { createCoreIngressReceiver } from '../src/aurabot/adapter/core-ingress.mjs'

test('one Core WebSocket fans an inbound event to Aurabot before the separate ledger allow-list', async () => {
  let socket
  let socketCreates = 0
  const forwarded = []
  const appended = []
  const ingress = createOneBotIngress({
    store: { append (env) { appended.push(env); return { ok: true } }, pushError () { return { t: 'test' } } },
    url: 'ws://127.0.0.1:3003',
    allow: { all: false, chats: [] },
    selfId: 'bot-test',
    bootId: 'boot-test',
    onAurabotEvent (event, meta) { forwarded.push({ event, meta }); return true },
    transport: { create () { socketCreates++; socket = { close () {} }; return socket } },
    log () {},
    now: () => 1000,
  })
  await ingress.start()
  socket.onopen()
  const event = { post_type: 'message', message_type: 'private', self_id: 'bot-test', user_id: 'sender-test', message_id: 42, time: 1, message: [{ type: 'text', data: { text: 'fixture only' } }] }
  socket.onmessage({ data: JSON.stringify(event) })
  assert.equal(socketCreates, 1)
  assert.equal(forwarded.length, 1)
  assert.deepEqual(forwarded[0].event, event)
  assert.match(forwarded[0].meta.eventId, /^ev_[a-f0-9]{16}$/)
  assert.equal(appended.length, 0)
  assert.equal(ingress.counters.notAllowed, 1)
  ingress.stop()
})

test('Aurabot module mutations do not alter the append-only Core event payload', async () => {
  let socket
  const appended = []
  const ingress = createOneBotIngress({
    store: { append (env) { appended.push(env); return { ok: true } }, pushError () { return { t: 'test' } }, readAll () { return [] } },
    url: 'ws://127.0.0.1:3003', allow: { all: true, chats: [] }, selfId: 'bot-test', bootId: 'boot-copy',
    onAurabotEvent (event) { event.message[0].data.text = 'module mutation'; return true },
    transport: { create () { socket = { close () {} }; return socket } }, log () {}, now: () => 2000,
  })
  await ingress.start()
  socket.onopen()
  socket.onmessage({ data: JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 'bot-test', user_id: 'sender-test', message_id: 43, time: 2, message: [{ type: 'text', data: { text: 'fixture original' } }] }) })
  assert.equal(appended.length, 1)
  assert.equal(appended[0].payload.message[0].data.text, 'fixture original')
  assert.equal(ingress.counters.aurabotForwarded, 1)
  ingress.stop()
})

test('Aurabot Core ingress receiver checks bot identity, forwards eventId metadata and deduplicates in memory', () => {
  const accepted = []
  const receive = createCoreIngressReceiver({ getSelfId: () => 'bot-test', onEvent: (ev, meta) => accepted.push({ ev, meta }) })
  const event = { post_type: 'message', self_id: 'bot-test', user_id: 'sender-test', message_id: 42 }
  assert.equal(receive(event, { eventId: 'ev_0123456789abcdef' }), true)
  assert.equal(receive(event, { eventId: 'ev_0123456789abcdef' }), false)
  assert.equal(receive({ ...event, self_id: 'other-bot' }, { eventId: 'ev_fedcba9876543210' }), false)
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].meta.eventId, 'ev_0123456789abcdef')
})

test('Aurabot receiver never processes self-sent message frames', () => {
  const accepted = []
  const receive = createCoreIngressReceiver({ getSelfId: () => 'bot-test', onEvent: (ev) => accepted.push(ev) })
  assert.equal(receive({ post_type: 'message', self_id: 'bot-test', user_id: 'bot-test', message_id: 43 }, { eventId: 'ev_self' }), false)
  assert.equal(accepted.length, 0)
})
