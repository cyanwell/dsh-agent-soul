import assert from 'node:assert/strict'
import test from 'node:test'
import { backgroundLlmStatus } from '../src/aurabot/src/core/llm.js'
import { createAurabotLlm } from '../src/aurabot/adapter/llm-adapter.mjs'

const cfg = { model: { provider: 'provider-x', model: 'model-x' } }

test('background LLM status reports missing service without model or credential details', () => {
  const status = backgroundLlmStatus({}, cfg)
  assert.deepEqual(status, { available: false, state: 'unavailable', reason: '宿主LLM服务不可用' })
})

test('background LLM status reflects Core not-ready state with generic reason only', () => {
  const dsh = { llm: { stream () {}, ready () { return false } } }
  assert.deepEqual(backgroundLlmStatus(dsh, cfg), { available: false, state: 'unavailable', reason: 'Core LLM未配置或未就绪' })
})

test('background LLM status reports ready only with service, ready client and model selection', () => {
  const dsh = { llm: { stream () {}, ready () { return true } } }
  assert.deepEqual(backgroundLlmStatus(dsh, cfg), { available: true, state: 'ready', reason: '' })
  assert.equal(backgroundLlmStatus(dsh, {}).state, 'unavailable')
})

test('Aurabot LLM adapter forwards only boolean readiness', () => {
  const ready = createAurabotLlm({ chat () {}, ready () { return true } })
  const notReady = createAurabotLlm({ chat () {}, ready () { return false } })
  const noSignal = createAurabotLlm({ chat () {} })
  assert.equal(ready.ready(), true)
  assert.equal(notReady.ready(), false)
  assert.equal(noSignal.ready(), null)
})
