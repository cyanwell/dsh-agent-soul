import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-hub-correlation-'))
process.env.AURABOT_DATA_DIR = dataDir
const { createHub } = await import('../src/aurabot/src/chat/hub.js')

const quietLog = () => new Proxy({}, { get: () => () => {} })
const config = {
  enabled: true, dryRun: false, ownerQQ: 'owner-fixture', botQQ: 'bot-fixture', ownerName: 'fixture',
  workspaceDir: join(dataDir, 'workspace'), merge: { enabled: false, waitSec: 1, maxSec: 2, groupWaitSec: 1, groupMaxSec: 2 },
  voice: { enabled: false, asr: false, autoChance: 0, autoMaxChars: 60 },
  stickers: { enabled: false, faces: false, collect: false, autoChance: 0, fromGroups: false, fromPrivate: false },
  model: {}, group: {}, files: { enabled: false, dirs: [] },
}

function makeHub(overrides = {}) {
  const cfg = { ...config, ...overrides }
  const sent = []
  const promptedEventIds = []
  let followups = 0
  const agent = {
    session: { id: 'session-correlation-fixture', append () {} },
    ctx: { tools: { register: () => () => {}, restrict: () => () => {} }, systemPrompt: { context: () => () => {} } },
    followup: async () => { followups++ },
    steer: async () => {},
  }
  const sessionId = agent.session.id
  const registry = { list: async () => [{ id: 'ws-correlation', path: cfg.workspaceDir }], create: async () => ({ id: 'ws-correlation' }), archivedSessionIds: [] }
  const controller = { create: async () => ({ sessionId }), rename: async () => {}, resolveAgent: async () => ({ agent }) }
  const dsh = {
    agents: { get: () => null },
    get: (name) => name === 'workspaceRegistry' ? registry : name === 'sessionController' ? controller : null,
    workspaceRegistry: registry,
  }
  const hub = createHub({
    dsh, getConfig: () => cfg, log: quietLog(),
    onebot: { call: async (action, params, opts) => { sent.push({ action, opts }); return { message_id: 9001 } } },
    stickers: { enabled: false, match: () => null, pickForReply: () => null, segmentFor: () => null, markUsed () {}, collect: async () => ({ ok: false }) },
    tts: { speak: async () => { throw new Error('not used') } },
    buildTools: () => [],
    hooks: { prompt: (content, info) => { promptedEventIds.push(info.eventIds || []); return content } },
  })
  return { hub, sent, sessionId, followups: () => followups, promptedEventIds }
}

const waitFor = async (fn) => {
  const end = Date.now() + 2500
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)) }
  return fn()
}

test('Aurabot state counts a denied message without exposing its sender identity', async () => {
  const { hub } = makeHub({ ownerQQ: 'some-other-fixture' })
  try {
    await hub.onMessage({
      post_type: 'message', message_type: 'private', self_id: 'bot-fixture', user_id: 'blocked-fixture',
      message_id: 45, message: [{ type: 'text', data: { text: 'synthetic denied fixture' } }],
      sender: { nickname: 'fixture', card: 'fixture' },
    }, { eventId: 'ev_abcdef0123456789' })
    const stats = hub.stats()
    assert.equal(stats.received, 1)
    assert.equal(stats.policyDenied, 1)
    assert.equal(stats.enqueued, 0)
    assert.equal(stats.sent, 0)
    assert.equal(JSON.stringify(stats).includes('blocked-fixture'), false)
  } finally {
    hub.disposeRecentMedia()
  }
})

test('eventIds received during a running turn are correlated only with the following turn', async () => {
  const { hub, sent, sessionId } = makeHub()
  const chat = { chatId: 'private:owner-fixture', kind: 'private', userId: 'owner-fixture' }
  const content = [{ type: 'text', text: 'synthetic queued turn' }]
  try {
    await hub.pushToSession(chat, content, 'owner-fixture', { eventIds: ['ev_aaaaaaaaaaaaaaaa'], newTurn: true })
    await hub.pushToSession(chat, content, 'owner-fixture', { eventIds: ['ev_bbbbbbbbbbbbbbbb'] })
    const session = { id: sessionId }
    hub.onSessionEvent(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'reply first' }] } } })
    hub.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    assert.equal(await waitFor(() => sent.filter((x) => x.action === 'send_private_msg').length === 1), true)
    assert.deepEqual(sent.find((x) => x.action === 'send_private_msg').opts.correlation.eventIds, ['ev_aaaaaaaaaaaaaaaa'])
    hub.onSessionEvent(session, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'reply second' }] } } })
    hub.onSessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    assert.equal(await waitFor(() => sent.filter((x) => x.action === 'send_private_msg').length === 2), true)
    assert.deepEqual(sent.filter((x) => x.action === 'send_private_msg')[1].opts.correlation.eventIds, ['ev_bbbbbbbbbbbbbbbb'])
  } finally {
    hub.disposeRecentMedia()
  }
})

test('Core eventId survives a fresh merge flush despite busy reservation and reaches explicit per-bubble OneBot send options', async () => {
  const { hub, sent, sessionId, followups, promptedEventIds } = makeHub()
  try {
    await hub.onMessage({
      post_type: 'message', message_type: 'private', self_id: 'bot-fixture', user_id: 'owner-fixture',
      message_id: 44, message: [{ type: 'text', data: { text: 'input fixture' } }],
      sender: { nickname: 'fixture', card: 'fixture' },
    }, { eventId: 'ev_0123456789abcdef' })
    assert.equal(await waitFor(() => followups() === 1), true, 'the inbound event must reach session followup before simulating turn/end')
    assert.deepEqual(promptedEventIds, [['ev_0123456789abcdef']], 'the eventId must reach the session push metadata')
    const session = { id: sessionId }
    hub.onSessionEvent(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'reply fixture' }] } } })
    hub.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    assert.equal(await waitFor(() => sent.some((x) => x.action === 'send_private_msg')), true)
    const call = sent.find((x) => x.action === 'send_private_msg')
    assert.deepEqual(call.opts.correlation, {
      eventIds: ['ev_0123456789abcdef'],
      sessionHash: 'sess_' + createHash('sha256').update(sessionId).digest('hex').slice(0, 16),
      partIndex: 0,
    })
    const stats = hub.stats()
    assert.deepEqual({ policyDenied: stats.policyDenied, enqueued: stats.enqueued, assistantReplyTurns: stats.assistantReplyTurns, sendAttempts: stats.sendAttempts, sent: stats.sent }, { policyDenied: 0, enqueued: 1, assistantReplyTurns: 1, sendAttempts: 1, sent: 1 })
  } finally {
    hub.disposeRecentMedia()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
