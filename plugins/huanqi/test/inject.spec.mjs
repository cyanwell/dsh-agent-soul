import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'

// Regression for the v0.1.1 activation crash.
// v0.1.1 read `ctx.agents` with no `inject` declaration, so Cordis's context
// proxy threw `cannot get property "agents" without inject` on the first
// `llm/stream` event and every session in that deployment failed to run.
// TypeScript cannot catch this; the guard is runtime-only.
test('declares the agents service injection', () => {
  assert.ok(Array.isArray(plugin.inject), 'plugin must export an inject array')
  assert.ok(
    plugin.inject.includes('agents'),
    'plugin reads ctx.agents and therefore must declare inject = ["agents"]',
  )
})

test('exposes the documented plugin surface', () => {
  // ★ 换气（2026-10-10）：这个包从 loop-guard fork 而来，但**必须换名**。
  // 宿主半的 `export const name` 若与原插件同名，两个包会注册同名服务，
  // 结果是**整包静默失效** —— 包本身、清单、lockfile 全部正确，
  // 假 ctx 探针也跑得通，只有路由 404（本机 2026-10-01 在 dsh-yanqing-line 上踩过）。
  // 所以这条断言改的是"预期的名字"，不是把测试改松。
  assert.equal(plugin.name, 'huanqi')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
})
