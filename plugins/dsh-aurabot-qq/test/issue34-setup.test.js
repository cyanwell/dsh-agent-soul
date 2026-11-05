// #34：已有 Docker OneBot 连接的老安装，向导能安全完成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const BOT = '20000002'
const OWNER = '10000001'
const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-setup-'))
process.env.AURABOT_DATA_DIR = dataDir
process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')

test('未核对不能跳过；已有连接核对机器人号后可以完成并持久化', async (t) => {
  const mock = await startMockOneBot({ selfId: BOT })
  const fake = createFakeDsh({ brain: async () => '好' })
  t.after(async () => { fake.dispose(); await mock.close() })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, setupDone: false, botQQ: BOT, ownerQQ: OWNER,
    snowluma: { httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token },
  }))
  const { apply } = await import('../src/host.js')
  const api = apply(fake.ctx)
  await api.ready
  let result = (await fake.call('/setup/done', { existingConnection: true })).json()
  assert.equal(result.ok, false)
  assert.equal(api.getConfig().setupDone, false)
  result = (await fake.call('/onebot/reconnect')).json()
  assert.equal(result.ok, true, result.message)
  result = (await fake.call('/setup/done', { existingConnection: true })).json()
  assert.equal(result.ok, true, result.message)
  assert.equal(result.config.setupDone, true)
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).setupDone, true)
  api.setConfig({ ...api.getConfig(), setupDone: false, botQQ: '30000003' })
  result = (await fake.call('/setup/done', { existingConnection: true })).json()
  assert.equal(result.ok, false, '换机器人号后旧连接不能再用来完成向导')
})
