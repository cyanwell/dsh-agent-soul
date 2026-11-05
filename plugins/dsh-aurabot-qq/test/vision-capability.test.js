// 没有视觉能力的模型：不该收到图片块（那会让整轮请求被模型拒掉）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const { modelVision, canSeeImages, clearVisionCache } = await import(`file:///${REPO}/src/core/llm.js`)

const stub = (resolveModelInfo) => ({ llm: { resolveModelInfo }, get: () => null })

test('模型能力探测：支持 / 不支持 / 宿主没说', async () => {
  clearVisionCache()
  assert.equal(await modelVision(stub(async () => ({ inputModalities: ['text', 'image'] })), 'p', 'm'), true, '声明了 image')
  clearVisionCache()
  assert.equal(await modelVision(stub(async () => ({ inputModalities: ['text'] })), 'p', 'm'), false, '只声明了 text')
  clearVisionCache()
  assert.equal(await modelVision(stub(async () => ({})), 'p', 'm'), null, '没声明 → 不知道')
  clearVisionCache()
  assert.equal(await modelVision(stub(async () => { throw new Error('boom') }), 'p', 'm'), null, '探测失败 → 不知道')
  clearVisionCache()
  assert.equal(await modelVision({ get: () => null }, 'p', 'm'), null, '没有 llm 服务 → 不知道')
})

test('canSeeImages 用当前设置里的模型', async () => {
  clearVisionCache()
  const dsh = stub(async (p, m) => ({ inputModalities: m === 'see' ? ['text', 'image'] : ['text'] }))
  assert.equal(await canSeeImages(dsh, { model: { provider: 'p', model: 'blind' } }), false)
  assert.equal(await canSeeImages(dsh, { model: { provider: 'p', model: 'see' } }), true)
  assert.equal(await canSeeImages(dsh, { model: {} }), null, '没配模型 → 不知道')
})

test('面板手动声明「支持 / 不支持」会覆盖 DSH 的元数据', async () => {
  clearVisionCache()
  const dsh = stub(async () => ({ inputModalities: ['text'] })) // DSH 说不支持
  // 手动说支持 → 就按支持发（哪怕元数据说不支持）
  assert.equal(await canSeeImages(dsh, { model: { provider: 'p', model: 'm', vision: 'on' } }), true)
  // 手动说不支持 → 哪怕元数据说支持，也不发图
  const dsh2 = stub(async () => ({ inputModalities: ['text', 'image'] }))
  assert.equal(await canSeeImages(dsh2, { model: { provider: 'p', model: 'm', vision: 'off' } }), false)
  // auto 仍走元数据
  clearVisionCache()
  assert.equal(await canSeeImages(dsh2, { model: { provider: 'p', model: 'm', vision: 'auto' } }), true)
  // 没配模型时，手动声明依然说话算数
  assert.equal(await canSeeImages(dsh, { model: { vision: 'on' } }), true)
  assert.equal(await canSeeImages(dsh, { model: { vision: 'off' } }), false)
})

// ---- 真跑一遍 hub：模型不支持看图时，图片不能出现在这一轮的内容里 ----
const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-vision-'))
process.env.AURABOT_DATA_DIR = dataDir
process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
mkdirSync(dataDir, { recursive: true })

const OWNER = '10000001'
const BOT = '20000002'
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
  enabled: true, dryRun: true, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
  model: { provider: 'p', model: 'blind', reasoningEffort: '' },
  allow: { private: [], groups: [] },
  snowluma: { autoStart: false, autoAttach: false, dir: join(dataDir, 'none') },
  voice: { enabled: false }, merge: { enabled: false },
}))

const PNG = (() => {
  const b = Buffer.alloc(64)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[7] = 0x0a
  b.writeUInt32BE(64, 16); b.writeUInt32BE(64, 20)
  return b
})()

const { createFakeDsh } = await import(`file:///${REPO}/test/helpers/fake-dsh.js`)
const fake = createFakeDsh({ brain: async () => '我看见啦' })
// 让宿主能回答「这个模型支不支持图片」
fake.ctx.llm.resolveModelInfo = async (p, m) => ({ inputModalities: m === 'see' ? ['text', 'image'] : ['text'] })
const host = await import(`file:///${REPO}/src/host.js`)
const api = host.apply(fake.ctx)
await api.ready
await new Promise((r) => setTimeout(r, 400))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const sendImage = async () => {
  await api.hub.onMessage({
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: Number(BOT), user_id: Number(OWNER), time: Math.floor(Date.now() / 1000),
    message_id: Math.floor(Math.random() * 1e6),
    message: [{ type: 'image', data: { sub_type: 0, file: 'base64://' + PNG.toString('base64') } }],
    sender: { user_id: Number(OWNER), nickname: '主人' },
  })
  await wait(1500)
}

test('模型不支持看图：图片换成一行文字提示，这一轮照常进行', async () => {
  clearVisionCache()
  await sendImage()
  const t = fake.turns.at(-1)
  assert.ok(t, '应该跑了一轮')
  assert.equal(t.images, 0, '不该把图片塞给不支持看图的模型')
  assert.match(String(t.ctxText || t.userText || ''), /看不了图|图片/, '要有文字提示: ' + (t.ctxText || t.userText))
})

test('模型支持看图：图片照常交给她', async () => {
  api.setConfig({ ...api.getConfig(), model: { provider: 'p', model: 'see', reasoningEffort: '' } })
  clearVisionCache()
  await sendImage()
  assert.equal(fake.turns.at(-1).images, 1, '支持看图就该拿到图')
})

test('工具看图能力按当前聊天选的模型判断', async () => {
  const cfg = api.getConfig()
  // 使用假宿主模型列表中存在的模型，验证聊天级模型的选择顺序。
  fake.ctx.llm.resolveModelInfo = async (p, m) => ({ inputModalities: m === 'm-owner' ? ['text', 'image'] : ['text'] })
  api.setConfig({ ...cfg, model: { provider: 'fake', model: 'fake-1', vision: 'auto' }, chatModels: { ...cfg.chatModels, privateDefault: { provider: 'fake', model: 'm-owner' } } })
  clearVisionCache()
  assert.equal(await api.hub.canSeeImages({ kind: 'private', userId: OWNER }), true)
  assert.equal(await api.hub.canSeeImages({ kind: 'group', groupId: '12345' }), false)
  api.setConfig({ ...api.getConfig(), model: { provider: 'fake', model: 'fake-1', vision: 'off' } })
  assert.equal(await api.hub.canSeeImages({ kind: 'private', userId: OWNER }), false)
})

after(() => fake.dispose())
