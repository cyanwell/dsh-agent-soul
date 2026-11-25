import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAurabotCtx } from '../src/aurabot/adapter/ctx.mjs'
import { canStartOneBot } from '../src/aurabot/src/host.js'

const coreEntry = readFileSync(new URL('../src/core-entry.mjs', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/aurabot/src/host.js', import.meta.url), 'utf8')

test('Core passes an explicit no-Aurabot-WebSocket owner flag before host evaluation', () => {
  const option = coreEntry.indexOf('onebotConnect: false')
  const load = coreEntry.indexOf("import('./aurabot/src/host.js')")
  assert.notEqual(option, -1)
  assert.notEqual(load, -1)
  assert.ok(option < load)
  assert.ok(coreEntry.includes('onAurabotEvent:'))
  assert.ok(coreEntry.includes('wakeDeliveryBlockedReason:'))
  const adapter = createAurabotCtx({ onebotConnect: false })
  assert.equal(adapter.ctx.aurabotOneBotConnect, false)
  adapter.ctx.dispose()
})

test('embedded owner flag disables every automatic, config-change, and manual OneBot start path', () => {
  assert.equal(canStartOneBot({ aurabotOneBotConnect: false }, {}), false)
  assert.equal(canStartOneBot({ aurabotOneBotConnect: false }, { AURABOT_NO_CONNECT: '1' }), false)
  assert.ok(host.includes("if (startOneBot && onebotState === 'connected') onebot.restart()"))
  assert.ok(host.includes("if (startOneBot && changedConn && onebot.state !== 'stopped') onebot.restart()"))
  assert.ok(host.includes("if (!startOneBot) return { ok: false, code: 'CORE_INGRESS_OWNS_CONNECTION'"))
  assert.ok(host.includes("onebot.state === 'stopped' && startOneBot"))
})

test('Core selects the adapted background LLM service instead of raw LlmClient', () => {
  const adapter = { stream () {} }
  const ctx = createAurabotCtx({ services: { llm: adapter } })
  assert.equal(ctx.ctx.llm, adapter)
  ctx.ctx.dispose()
  const start = coreEntry.indexOf('const ab = createAurabotCtx({')
  const end = coreEntry.indexOf('\n  })', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const call = coreEntry.slice(start, end)
  assert.ok(!/^\s+llm,\s*$/m.test(call))
  assert.ok(call.includes('llm: createAurabotLlm(llm) || bridgeServices.llm'))
})

test('standalone DSH host stays compatible unless its owner explicitly disables OneBot', () => {
  assert.equal(canStartOneBot({}, {}), true)
  assert.equal(canStartOneBot({}, { AURABOT_NO_CONNECT: '1' }), false)
})
