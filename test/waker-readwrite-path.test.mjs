import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { callTool, closeStore, setStoreMode } from '../src/adapters/mcp-tools.mjs'
import { Ledger } from '../src/organs/waker.mjs'

test('soul_waker state reads the v4 Core ledger that ingest writes and ignores retired DSH ledger snapshots', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-soul-waker-'))
  const soulRoot = path.join(home, 'soul')
  const statusDir = path.join(soulRoot, '30-状态')
  const dataDir = path.join(home, 'data')
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true })
  fs.mkdirSync(statusDir, { recursive: true })
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ dataDir: 'data', workspace: '.', soul: { root: soulRoot } }))
  const legacyFile = path.join(statusDir, 'lead-waker-台账.json')
  fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), events: [{ key: 'legacy-key', t: new Date().toISOString(), title: 'retired snapshot', from: 'old', tier: 'info', stage: 'woken', wakeCount: 1, charter: 'unchecked' }] }))
  const localFile = path.join(dataDir, 'ledger.json')
  const priorHome = process.env.AGENT_SOUL_HOME
  const priorLedger = globalThis.__ledger
  try {
    process.env.AGENT_SOUL_HOME = home
    setStoreMode('rw')
    globalThis.__ledger = new Ledger(localFile)
    const ingested = await callTool('soul_waker', { action: 'ingest', key: 'core-key', title: 'Core report', from: 'test', tier: 'act' })
    assert.match(ingested, /已收进台账 core-key/)
    const state = await callTool('soul_waker', { action: 'state' })
    assert.match(state, /AgentSoul v4 本地台账/)
    assert.match(state, /core-key.*Core report/)
    assert.match(state, /AgentSoul v4 soul_waker 是当前跨会话事件台账/)
    assert.doesNotMatch(state, /legacy-key|retired snapshot|lead-waker-台账.json/)
    const local = JSON.parse(fs.readFileSync(localFile, 'utf8'))
    const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
    assert.equal(local.events.length, 1)
    assert.equal(local.events[0].key, 'core-key')
    assert.equal(legacy.events.length, 1)
    assert.equal(legacy.events[0].key, 'legacy-key')
  } finally {
    closeStore()
    setStoreMode('rw')
    if (priorHome === undefined) delete process.env.AGENT_SOUL_HOME
    else process.env.AGENT_SOUL_HOME = priorHome
    if (priorLedger === undefined) delete globalThis.__ledger
    else globalThis.__ledger = priorLedger
    fs.rmSync(home, { recursive: true, force: true })
  }
})
