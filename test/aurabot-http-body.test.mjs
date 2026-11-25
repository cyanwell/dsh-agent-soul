import assert from 'node:assert/strict'
import test from 'node:test'
import { readAurabotBody } from '../src/aurabot/src/host.js'

test('Aurabot reuses the parsed req.body supplied after the adapter drained the request stream', async () => {
  const expected = { merge: { waitSec: 3.1 }, imageGen: { galleryShown: 21 } }
  const req = {
    body: expected,
    async *[Symbol.asyncIterator]() { throw new Error('request stream already consumed') },
  }
  assert.deepEqual(await readAurabotBody(req), expected)
})

test('Aurabot body parser retains the standalone raw-stream fallback', async () => {
  const req = {
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"ok":true}') },
  }
  assert.deepEqual(await readAurabotBody(req), { ok: true })
})
