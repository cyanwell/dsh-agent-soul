import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as guarded from '../lib/index.js'

// Demonstrates the mechanism behind issue #1 against the REAL Cordis runtime:
// reading a service the fiber did not declare throws, and `inject` is what
// declares it. v0.1.1 omitted `inject`, so `ctx.agents` threw on activation.
test('reading an undeclared service throws the without-inject error', async () => {
  const ctx = new Context()
  await ctx.plugin({ name: 'probe-without-inject', apply: (c) => { assert.throws(
    () => c.anythingNotDeclared, /without inject/) } })
})

test('a declared inject makes the same read reachable', async () => {
  const ctx = new Context()
  ctx.provide('anythingNotDeclared', { ok: true })
  await ctx.plugin({
    name: 'probe-with-inject',
    inject: ['anythingNotDeclared'],
    apply: (c) => { assert.equal(c.anythingNotDeclared.ok, true) },
  })
})

test('the shipped plugin declares what it reads', () => {
  assert.deepEqual(guarded.inject, ['agents'])
})
