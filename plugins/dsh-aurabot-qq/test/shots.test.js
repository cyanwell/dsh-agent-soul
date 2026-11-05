// 截图库 + 让她发截图这两条链路的测试。每条用例用自己的临时数据目录，互不干扰。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// dataDir() 每次调用都读这个环境变量，所以测试之间换目录就能隔离
process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-shots-'))
const freshDir = () => { process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-shots-')) }

const { clockOf, pickShot, createShotStore, loadShots } = await import('../src/bili/shots.js')
const { createBili } = await import('../src/bili/duty.js')
const { normalize } = await import('../src/core/config.js')

test('clockOf：秒数转 mm:ss', () => {
  assert.equal(clockOf(0), '0:00')
  assert.equal(clockOf(9), '0:09')
  assert.equal(clockOf(65), '1:05')
  assert.equal(clockOf(600), '10:00')
  assert.equal(clockOf(undefined), '0:00')
  assert.equal(clockOf(-3), '0:00')
})

test('pickShot：空库返回 null，空查询给最近一张', () => {
  assert.equal(pickShot([], ''), null)
  const items = [
    { file: 'a.jpg', title: '一碗米饭', note: '锅里的米饭' },
    { file: 'b.jpg', title: '猫咪合集', note: '一只猫在打滚' },
    { file: 'c.jpg', title: '翻白眼', note: '教室里' },
  ]
  assert.equal(pickShot(items, '').file, 'a.jpg', '不给条件就是最近的（列表头）')
  assert.equal(pickShot(items, '猫').file, 'b.jpg')
  assert.equal(pickShot(items, '米饭').file, 'a.jpg')
  assert.equal(pickShot(items, '打滚').file, 'b.jpg', '按备注也能命中')
  assert.equal(pickShot(items, '西瓜'), null, '完全对不上就说没有，别答非所问')
})

test('截图库：存下来、去重、超过上限删最旧的', () => {
  freshDir()
  const store = createShotStore({ max: 3 })
  const a = store.put(Buffer.from('frame-a'), { bvid: 'BV1', title: '视频一', sec: 30, note: '第一帧' })
  assert.ok(a && a.file)
  assert.ok(existsSync(store.path(a)), '文件真的写下去了')
  assert.equal(a.bytes, 7, '记下大小，面板要显示')
  assert.equal(loadShots().items.length, 1)

  const again = store.put(Buffer.from('frame-a'), { bvid: 'BV1', title: '视频一', sec: 30 })
  assert.equal(again.file, a.file)
  assert.equal(loadShots().items.length, 1, '同 MD5 不重复入库')

  store.put(Buffer.from('frame-b'), { bvid: 'BV2', title: '视频二', sec: 60 })
  store.put(Buffer.from('frame-c'), { bvid: 'BV3', title: '视频三', sec: 90 })
  store.put(Buffer.from('frame-d'), { bvid: 'BV4', title: '视频四', sec: 120 })
  const items = loadShots().items
  assert.equal(items.length, 3, '上限 3')
  assert.equal(items[0].title, '视频四', '最新的排最前')
  assert.ok(!items.some((i) => i.title === '视频一'), '最旧的被清掉')
  const files = readdirSync(join(process.env.AURABOT_DATA_DIR, 'bili-shots')).filter((f) => f.endsWith('.jpg'))
  assert.equal(files.length, 3, '文件也跟着删了')
})

test('截图库：按标题筛选 / 空条件给全部', () => {
  freshDir()
  const store = createShotStore({ max: 10 })
  store.put(Buffer.from('x1'), { title: '米饭做法' })
  store.put(Buffer.from('x2'), { title: '猫咪日常' })
  assert.equal(store.list('米饭').length, 1)
  assert.equal(store.list('没有的').length, 0)
  assert.equal(store.list('').length, 2)
})

test('截图库：上限可以是函数，面板调小后 trim 会删', () => {
  freshDir()
  const box = { v: 2 }
  const store = createShotStore({ max: () => box.v })
  store.put(Buffer.from('t1'), { title: 'A' })
  store.put(Buffer.from('t2'), { title: 'B' })
  store.put(Buffer.from('t3'), { title: 'C' })
  assert.equal(store.count(), 2, '按函数给的上限裁')
  box.v = 1
  assert.equal(store.trim(), 1, '调小后裁掉 1 张')
  assert.equal(store.count(), 1)
  assert.equal(store.panel()[0].limit, 1, 'panel 里带上当前上限')
})

test('截图库：手动删掉一张，文件也一起删', () => {
  freshDir()
  const store = createShotStore({ max: 10 })
  const it = store.put(Buffer.from('del-me'), { title: '待删', sec: 61 })
  assert.ok(existsSync(store.path(it)))
  const r = store.remove(it.file)
  assert.equal(r.ok, true)
  assert.match(r.message, /1:01/)
  assert.equal(existsSync(store.path(it)), false, '文件真的删了')
  assert.equal(store.count(), 0)
  assert.equal(store.remove('没有这张.jpg').ok, false)
})

test('截图库：panel 给出 mm:ss 和上限，供面板渲染', () => {
  freshDir()
  const store = createShotStore({ max: 5 })
  store.put(Buffer.from('p1'), { bvid: 'BV1', title: '面板视频', sec: 125, note: '备注' })
  const p = store.panel()
  assert.equal(p.length, 1)
  assert.equal(p[0].clock, '2:05')
  assert.equal(p[0].limit, 5)
  assert.equal(p[0].title, '面板视频')
  assert.ok(p[0].file.endsWith('.jpg'))
})

function makeBili () {
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', bili: { enabled: true } })
  const sent = []
  const hub = {
    sendImage: async (chatId, src) => { sent.push({ chatId, src }); return { message_id: 1 } },
    sendText: async () => ({ message_id: 2 }),
    logChat: () => {},
  }
  const bili = createBili({ getConfig: () => cfg, hub, memory: null, log: { info() {}, warn() {}, debug() {} }, dsh: null, api: {} })
  return { bili, sent, cfg }
}

test('sendShot：挑一张发到当前会话，文件是真的被读出来的', async () => {
  freshDir()
  const { bili, sent } = makeBili()
  createShotStore({ max: 10 }).put(Buffer.from('JPEGDATA'), { bvid: 'BV9', title: '测试视频', sec: 75, note: '画面描述' })

  const r = await bili.sendShot({ chatId: 'private:10000001', query: '测试' })
  assert.equal(r.ok, true, r.message)
  assert.match(r.message, /测试视频/)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 'private:10000001')
  assert.equal(readFileSync(sent[0].src).toString(), 'JPEGDATA')
})

test('sendShot：库里没有就说清楚，别假装发了', async () => {
  freshDir()
  const { bili, sent } = makeBili()
  const r = await bili.sendShot({ chatId: 'private:10000001', query: '根本没有' })
  assert.equal(sent.length, 0)
  assert.equal(r.ok, false)
  assert.match(r.message, /没有/)
})

test('面板接口：libraryShots / shotFileOf / deleteShot 串起来', async () => {
  freshDir()
  const { bili } = makeBili()
  createShotStore({ max: 10 }).put(Buffer.from('PANELBYTES'), { bvid: 'BV7', title: '面板视频', sec: 42 })

  const lib = bili.libraryShots()
  assert.equal(lib.ok, true)
  assert.equal(lib.items.length, 1)
  const file = lib.items[0].file

  const p = bili.shotFileOf(file)
  assert.ok(p, '能给出发图片用的路径')
  assert.equal(readFileSync(p).toString(), 'PANELBYTES')
  assert.equal(bili.shotFileOf('不存在.jpg'), '', '没有就返回空串')

  const del = bili.deleteShot(file)
  assert.equal(del.ok, true)
  assert.equal(bili.libraryShots().items.length, 0)
  assert.equal(bili.shotFileOf(file), '', '删掉后路径也没了')
})

test('config：shotLibrary 默认 300，越界会被夹住', () => {
  assert.equal(normalize({}).bili.shotLibrary, 300)
  assert.equal(normalize({ bili: { shotLibrary: 5000 } }).bili.shotLibrary, 2000)
  assert.equal(normalize({ bili: { shotLibrary: 1 } }).bili.shotLibrary, 20)
  assert.equal(normalize({ bili: { shotLibrary: 'abc' } }).bili.shotLibrary, 300)
})

test('config：shotChance 默认 0.35，越界会被夹住', () => {
  assert.equal(normalize({}).bili.shotChance, 0.35)
  assert.equal(normalize({ bili: { shotChance: 2 } }).bili.shotChance, 1)
  assert.equal(normalize({ bili: { shotChance: -1 } }).bili.shotChance, 0)
  assert.equal(normalize({ bili: { shotChance: 'abc' } }).bili.shotChance, 0.35)
})

test('截图库：损坏索引中的路径不能越过图库访问或删除文件', () => {
  freshDir()
  const store = createShotStore()
  const real = store.put(Buffer.from('real'), { title: '真实截图' })
  const outside = join(process.env.AURABOT_DATA_DIR, 'outside.jpg')
  writeFileSync(outside, 'keep')
  writeFileSync(join(process.env.AURABOT_DATA_DIR, 'bili-shots/index.json'), JSON.stringify({ items: [
    { file: '../outside.jpg', title: '外部' }, null, real,
  ] }))
  assert.equal(store.path({ file: '../outside.jpg' }), '')
  assert.equal(store.exists({ file: '../outside.jpg' }), false)
  assert.equal(store.remove('../outside.jpg').ok, false)
  assert.deepEqual(store.list(), [real])
  assert.equal(readFileSync(outside, 'utf8'), 'keep')
})

test('sendShot：关闭和试运行不发送、不记成功；发送失败如实返回', async () => {
  for (const mode of ['disabled', 'biliOff', 'dry', 'null', 'empty', 'sim', 'throw']) {
    freshDir()
    const { bili, sent, cfg } = makeBili()
    createShotStore().put(Buffer.from('pic'), { title: '猫' })
    if (mode === 'disabled') cfg.enabled = false
    if (mode === 'biliOff') cfg.bili.enabled = false
    if (mode === 'dry') cfg.dryRun = true
    // 对失败的 hub 单独建实例，确保发送结果决定返回值。
    const target = ['null', 'empty', 'sim', 'throw'].includes(mode) ? createBili({
      getConfig: () => cfg, log: { info() {}, debug() {} },
      hub: { sendImage: async () => { if (mode === 'throw') throw new Error('网关断开'); return mode === 'empty' ? {} : mode === 'sim' ? { message_id: 'sim-1' } : null } }, api: {},
    }) : bili
    const result = await target.sendShot({ chatId: 'private:10000001' })
    assert.equal(result.sent, false, mode)
    assert.equal(result.ok, mode === 'dry' || mode === 'sim', mode)
    if (mode === 'dry') assert.match(result.message, /未实际发送/)
    assert.equal(target.state().history.length, 0, mode)
    assert.equal(sent.length, 0, mode)
  }
})

function browsing({ dryRun = false, sendResult = { message_id: 1 }, failVision = false } = {}) {
  const cfg = normalize({ enabled: true, dryRun, ownerQQ: '10000001', bili: { enabled: true, vision: true, shotChance: 1, perRun: 1 } })
  const sent = []
  const info = { bvid: 'BV1aaaaaaaaa', cid: 1, aid: 1, title: '猫的视频', duration: 60 }
  const bili = createBili({
    getConfig: () => cfg, log: { info() {}, debug() {}, warn() {} },
    api: { view: async () => info, subtitle: async () => '文本字幕', comments: async () => [], search: async () => [{ ...info, play: 100000 }], popular: async () => [] },
    vision: async () => { if (failVision) throw new Error('坏流'); return { text: '猫在吃饭', frames: [{ sec: 10, buf: Buffer.from('frame') }] } },
    hub: {
      runSystemTurn: async (_id, _name, prompt) => prompt.includes('挑 3 个') ? '["猫"]' : '[{"i":1,"feeling":"好可爱"}]',
      sendImage: async (chatId, path) => { sent.push({ chatId, path }); return sendResult },
      sendText: async () => ({}),
    },
  })
  return { bili, sent }
}

test('watch：画面和字幕进入阅读结果并存图，视觉失败仍返回文字', async () => {
  freshDir()
  const { bili } = browsing()
  const r = await bili.watch('BV1aaaaaaaaa')
  assert.equal(r.ok, true)
  assert.match(r.message, /文本字幕/)
  assert.match(r.message, /猫在吃饭/)
  assert.equal(bili.libraryShots().items.length, 1)
  freshDir()
  const fallback = await browsing({ failVision: true }).bili.watch('BV1aaaaaaaaa')
  assert.equal(fallback.ok, true)
  assert.match(fallback.message, /文本字幕/)
  assert.ok(!fallback.message.includes('画面（抽帧）'))
})

test('自动截图：只发主人私聊、使用真实文件路径，试运行和失败不计发送', async () => {
  for (const mode of ['sent', 'dry', 'failed']) {
    freshDir()
    const { bili, sent } = browsing({ dryRun: mode === 'dry', sendResult: mode === 'failed' ? null : { message_id: 1 } })
    const r = await bili.run({ force: true })
    assert.equal(r.ok, true, r.message)
    assert.equal(r.shots, mode === 'sent' ? 1 : 0, mode)
    assert.equal(bili.state().history.filter((i) => i.kind === 'shot').length, r.shots)
    assert.equal(sent.length, mode === 'dry' ? 0 : 1)
    if (sent.length) {
      assert.equal(sent[0].chatId, 'private:10000001')
      assert.equal(readFileSync(sent[0].path, 'utf8'), 'frame')
    }
  }
})

test('B 站模块：截图库路由预览 / 删除、工具固定发当前会话、关闭后隐藏', async () => {
  freshDir()
  const { default: module } = await import('../src/modules/bili/index.js')
  const { cfg, sent } = makeBili()
  const routes = new Map(), builders = []
  const fake = {
    config: () => cfg, lazy: () => null, log: { info() {}, warn() {}, debug() {} },
    on() {}, every() {}, tool: (build) => builders.push(build), route: (p, handler) => routes.set(p, handler),
    core: {
      hub: { sendImage: async (chatId, src) => { sent.push({ chatId, src }); return { message_id: 8 } } },
      http: { query: (req) => req.query, body: async (req) => req.body, send: (_res, status, body, type) => ({ status, body, type }) },
    },
  }
  module.setup(fake)
  const shot = createShotStore().put(Buffer.from('preview'), { title: '预览' })
  const list = await routes.get('/bili/shots')()
  assert.equal(list.items[0].file, shot.file)
  const image = await routes.get('/bili/shot/image')({ query: { file: shot.file } }, {})
  assert.equal(image.type, 'image/jpeg')
  assert.equal(image.body.toString(), 'preview')
  assert.equal((await routes.get('/bili/shot/image')({ query: { file: '../outside' } }, {})).status, 404)
  const tools = builders[0]({ chat: { kind: 'group', chatId: 'group:123' } })
  const tool = tools.find((t) => t.name === 'qq_send_shot')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['query'])
  assert.equal((await tool.execute({})).sent, true)
  assert.equal(sent[0].chatId, 'group:123')
  cfg.bili.enabled = false
  assert.deepEqual(builders[0]({ chat: { kind: 'private' } }), [])
  assert.equal((await tool.execute({})).ok, false, '旧工具也复查开关')
  const deleted = await routes.get('/bili/shot/delete')({ body: { file: shot.file } })
  assert.equal(deleted.ok, true)
  assert.equal((await routes.get('/bili/shot/image')({ query: { file: shot.file } }, {})).status, 404)
})
