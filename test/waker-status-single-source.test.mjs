import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readEventsLayer } from '../src/web/status-data.mjs'
import { Ledger } from '../src/organs/waker.mjs'

test('status events layer reads the v4 Core waker ledger rather than a legacy statusDir snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-soul-waker-status-'))
  const statusDir = path.join(root, '30-状态')
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(statusDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  const legacy = path.join(statusDir, 'lead-waker-台账.json')
  fs.writeFileSync(legacy, JSON.stringify({ events: [{ key: 'legacy', t: new Date().toISOString(), title: 'legacy', stage: 'woken', wakeCount: 1, charter: 'unchecked' }] }))
  const ledger = new Ledger(path.join(dataDir, 'ledger.json'))
  ledger.ingest({ key: 'core', t: new Date().toISOString(), title: 'core', from: 'test', tier: 'act' })
  ledger.markWoken('core')
  try {
    const layer = readEventsLayer({ config: { dataDir, statusDir }, opts: { ledger, core: { pid: 1, startedAt: Date.now() } } })
    assert.equal(layer.data.ok, true)
    assert.equal(layer.data.total, 1)
    assert.equal(layer.data.counts.act, 1)
    assert.equal(layer.data.ledgerFile, ledger.file)
    assert.match(layer.note, /AgentSoul v4 Core soul_waker/)
    assert.doesNotMatch(layer.provenance, /lead-waker-台账.json/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
