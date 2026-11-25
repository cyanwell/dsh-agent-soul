import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createWakeDeliverer } from '../src/events/deliver.mjs'

const coreEntry = readFileSync(new URL('../src/core-entry.mjs', import.meta.url), 'utf8')

test('Core/Aurabot composition blocks generic event social replies and explains why', async () => {
  assert.ok(coreEntry.includes("wakeDeliveryBlockedReason: 'QQ社交回复由Aurabot处理；leadRelay的跨会话宪章链独立运行'"))
  const d = createWakeDeliverer({ enabled: () => false, disabledReason: 'QQ social handled by Aurabot', dispatch: { resolve () { throw new Error('must not dispatch') } } })
  const result = await d.deliver([{ chatId: 'group:fixture', text: 'fixture only', eventId: 'ev_test' }])
  assert.equal(result.disabled, true)
  assert.equal(d.view().enabled, false)
  assert.equal(d.view().disabledReason, 'QQ social handled by Aurabot')
  assert.equal(d.view().delivered, 0)
})
