import assert from 'node:assert/strict'
import test from 'node:test'
import { canAttachSnowLuma } from '../src/aurabot/src/host.js'

test('SnowLuma attach requires both running process and affirmative consent', () => {
  assert.equal(canAttachSnowLuma({ running: true, consented: true }), true)
  assert.equal(canAttachSnowLuma({ running: true, consented: false }), false)
  assert.equal(canAttachSnowLuma({ running: true, consented: null }), false)
  assert.equal(canAttachSnowLuma({ running: false, consented: true }), false)
  assert.equal(canAttachSnowLuma({ running: null, consented: null }), false)
})
