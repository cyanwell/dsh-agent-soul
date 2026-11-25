import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { handleWakerApi } from '../src/adapters/waker-http.mjs'
import { Ledger } from '../src/organs/waker.mjs'

function response() {
  return { headers: {}, writeHead(code, headers) { this.code = code; this.headers = headers }, end(body) { this.body = body } }
}

test('GET /api/waker and POST /api/waker/decide share the same v4 Core Ledger', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-soul-waker-http-'))
  const file = path.join(dir, 'ledger.json')
  const ledger = new Ledger(file)
  ledger.ingest({ key: 'core-event', t: new Date().toISOString(), title: 'Core event', from: 'test', tier: 'act' })
  ledger.markWoken('core-event')
  try {
    const getResponse = response()
    const getHandled = await handleWakerApi({ url: '/api/waker', method: 'GET' }, getResponse, { ledger })
    assert.equal(getHandled, true)
    assert.equal(getResponse.code, 200)
    const before = JSON.parse(getResponse.body)
    assert.equal(before.file, file)
    assert.equal(before.total, 1)
    assert.equal(before.counts.act, 1)
    assert.equal(before.views.act[0].key, 'core-event')

    const req = new EventEmitter()
    req.url = '/api/waker/decide'
    req.method = 'POST'
    const postResponse = response()
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify({ key: 'core-event', decision: 'resume', charter: 'pass' })))
      req.emit('end')
    })
    const postHandled = await handleWakerApi(req, postResponse, { ledger })
    assert.equal(postHandled, true)
    assert.equal(postResponse.code, 200)

    const afterResponse = response()
    await handleWakerApi({ url: '/api/waker', method: 'GET' }, afterResponse, { ledger })
    const after = JSON.parse(afterResponse.body)
    assert.equal(after.counts.done, 1)
    assert.equal(after.views.done[0].key, 'core-event')
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(disk.events[0].decision, 'resume')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
