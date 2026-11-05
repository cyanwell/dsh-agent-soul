// 最近图片 / 表情应在重启后恢复，并在读取时检查原来的 30 分钟有效期。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import stickersModule from '../src/modules/stickers/index.js'

const OWNER = '10000001'
const BOT = '20000002'
const CHAT = `private:${OWNER}`
const log = { info() {}, debug() {}, warn() {}, error() {} }
const image = (name, sticker = true) => ({ type: 'image', data: { file: name, sub_type: sticker ? 1 : 0 } })
function setup() {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-media-'))
  const dir = process.env.AURABOT_DATA_DIR
  const cfg = normalize({ botQQ: BOT, ownerQQ: OWNER, enabled: false, dryRun: true, stickers: { collect: false, caption: false }, allow: { private: ['10000002'], groups: ['123'] } })
  const hub = (logger = log) => createHub({ dsh: {}, getConfig: () => cfg, log: logger, onebot: {}, stickers: {} })
  return { hub, cfg, dir, file: join(dir, 'recent-media.json') }
}
const send = (hub, seg, user = OWNER, group = '') => hub.onMessage({
  message_type: group ? 'group' : 'private', self_id: Number(BOT), user_id: Number(user),
  ...(group ? { group_id: Number(group) } : {}), message_id: 1, message: [seg], sender: { nickname: '测试' },
})

test('最近表情：重建中枢后仍能取到聊天和发图人对应的消息段', async () => {
  const s = setup(), before = s.hub(), seg = image('sticker.png')
  await send(before, seg)
  const expected = before.recentMedia(CHAT)
  assert.equal(expected.length, 1)
  assert.ok(existsSync(s.file), '消息收到时就落盘，不依赖正常退出')
  before.disposeRecentMedia()
  const after = s.hub()
  assert.deepEqual(after.recentMedia(CHAT), expected)
})

test('最近表情：不再发新图，读取时也要移除过期记录', async (t) => {
  const s = setup(), hub = s.hub()
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  await send(hub, image('old.png'))
  now += 30 * 60_000
  assert.deepEqual(hub.recentMedia(CHAT), [])
  assert.deepEqual(JSON.parse(readFileSync(s.file, 'utf8')), {}, '过期引用从文件中清理')
})

test('恢复时保留原始时间，不因重启重新获得半小时', async (t) => {
  const s = setup(), before = s.hub()
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  await send(before, image('near-expiry.png'))
  const received = now
  now += 29 * 60_000
  const after = s.hub()
  assert.equal(after.recentMedia(CHAT)[0].at, received)
  now += 60_000
  assert.deepEqual(after.recentMedia(CHAT), [])
  assert.deepEqual(s.hub().recentMedia(CHAT), [])
})

test('恢复时清掉已过期、未来时间、坏条目，保留有效图片和商城表情', (t) => {
  const s = setup(), now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  const item = (at, seg = image('valid.png')) => ({ seg, userId: OWNER, at, sticker: true })
  const valid = item(now - 1000)
  const market = item(now, { type: 'mface', data: { emoji_id: '123', key: 'market-key' } })
  writeFileSync(s.file, JSON.stringify({
    [CHAT]: [null, item(now - 30 * 60_000), item(now + 1), item('bad'), item(now, { type: 'text', data: { text: '不是图片' } }), valid, market],
    'group:123': '坏列表', 'private:10000002': [],
  }))
  const hub = s.hub()
  assert.deepEqual(hub.recentMedia(CHAT), [valid, market])
  assert.deepEqual(JSON.parse(readFileSync(s.file, 'utf8')), { [CHAT]: [valid, market] })
})

test('每张图片单独计时，后来的新图不能延长旧图的有效期', async (t) => {
  const s = setup(), hub = s.hub()
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  await send(hub, image('old.png'))
  now += 10 * 60_000
  await send(hub, image('new.png', false))
  now += 20 * 60_000
  assert.deepEqual(hub.recentMedia(CHAT).map((x) => [x.seg.data.file, x.sticker]), [['new.png', false]])
  assert.equal(JSON.parse(readFileSync(s.file, 'utf8'))[CHAT].length, 1)
})

test('重启后按私聊 / 群聊和发图人隔离，维持每个聊天的顺序', async () => {
  const s = setup(), before = s.hub()
  await send(before, image('owner-private.png'))
  await send(before, image('other-private.png'), '10000002')
  await send(before, image('owner-group.png'), OWNER, '123')
  await send(before, image('other-group.png'), '10000002', '123')
  const after = s.hub(), files = (chat, user) => after.recentMedia(chat, user).map((x) => x.seg.data.file)
  assert.deepEqual(files(CHAT), ['owner-private.png'])
  assert.deepEqual(files('private:10000002'), ['other-private.png'])
  assert.deepEqual(files('group:123'), ['owner-group.png', 'other-group.png'])
  assert.deepEqual(files('group:123', OWNER), ['owner-group.png'])
  assert.deepEqual(files('group:999'), [])
})

test('只记白名单聊天，不持久化机器人自己和无权限来源的图片', async () => {
  const s = setup(), hub = s.hub()
  await send(hub, image('denied-private.png'), '999')
  await send(hub, image('denied-group.png'), OWNER, '999')
  await send(hub, image('self.png'), BOT)
  assert.equal(existsSync(s.file), false)
  assert.deepEqual(s.hub().recentMedia('private:999'), [])
  assert.deepEqual(s.hub().recentMedia('group:999'), [])
})

test('每个聊天只保留最近 6 张，纯文字不覆盖暂存或更新时间', async () => {
  const s = setup(), hub = s.hub()
  for (let i = 0; i < 8; i++) await send(hub, image(`${i}.png`))
  const disk = readFileSync(s.file, 'utf8')
  await send(hub, { type: 'text', data: { text: '存一下刚才的表情' } })
  assert.equal(readFileSync(s.file, 'utf8'), disk)
  assert.deepEqual(s.hub().recentMedia(CHAT).map((x) => x.seg.data.file), ['2.png', '3.png', '4.png', '5.png', '6.png', '7.png'])
})

test('缺失或损坏的暂存文件不影响聊天，新图片会重建文件', async () => {
  const s = setup()
  for (const raw of ['{broken json', 'null', '[]', '42']) {
    writeFileSync(s.file, raw)
    const hub = s.hub()
    assert.deepEqual(hub.recentMedia(CHAT), [])
    await send(hub, image('recovered.png'))
    assert.equal(s.hub().recentMedia(CHAT)[0].seg.data.file, 'recovered.png')
  }
})

test('磁盘写入失败仍保留本次内存引用，并记录原因', async () => {
  const s = setup(), warnings = []
  mkdirSync(s.file) // 故意令目标成为目录，使原子替换失败。
  const hub = s.hub({ ...log, warn: (...args) => warnings.push(args.join(' ')) })
  await send(hub, image('memory-only.png'))
  assert.equal(hub.recentMedia(CHAT)[0].seg.data.file, 'memory-only.png')
  assert.match(warnings.join('\n'), /暂存写入失败/)
})

test('媒体缓存关闭后旧实例不可取图，迟到消息不再改写暂存，重启实例可正常恢复', async () => {
  const s = setup(), hub = s.hub()
  await send(hub, image('before-dispose.png'))
  const disk = readFileSync(s.file, 'utf8')
  hub.disposeRecentMedia()
  hub.disposeRecentMedia()
  assert.deepEqual(hub.recentMedia(CHAT), [])
  await send(hub, image('late.png'))
  assert.equal(readFileSync(s.file, 'utf8'), disk)
  assert.deepEqual(s.hub().recentMedia(CHAT).map((x) => x.seg.data.file), ['before-dispose.png'])
})

function saveTool(hub, cfg, chat = { kind: 'private', chatId: CHAT, userId: OWNER }) {
  let build
  stickersModule.setup({
    core: { hub, onebot: {}, http: {} }, config: () => cfg, dsh: {}, log,
    tool: (fn) => { build = fn }, route() {}, rule() {},
  })
  return build({ chat, sessionId: 'save-test', level: 'full' }).find((tool) => tool.name === 'qq_save_sticker')
}
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])

test('现有 qq_save_sticker 可在重启后从暂存保存原图、备注及标签，权限仍在执行时检查', async () => {
  const s = setup(), before = s.hub()
  await send(before, image('base64://' + png.toString('base64')))
  before.disposeRecentMedia()
  const after = s.hub(), tool = saveTool(after, s.cfg)
  assert.equal((await tool.execute({ name: '不应保存' })).ok, false)
  assert.equal(existsSync(join(s.dir, 'stickers', 'index.json')), false)
  after.simulateTurn('save-test', [OWNER])
  const result = await tool.execute({ name: '重启后的表情', tags: ['开心'] })
  assert.equal(result.ok, true, result.message)
  const item = JSON.parse(readFileSync(join(s.dir, 'stickers', 'index.json'), 'utf8')).items[0]
  assert.equal(item.name, '重启后的表情')
  assert.deepEqual(item.tags, ['开心'])
  assert.deepEqual(readFileSync(join(s.dir, 'stickers', item.file)), png)
})

test('现有存表情工具在恢复的群聊中仍优先取主人图片', async () => {
  const s = setup(), before = s.hub(), other = Buffer.from(png)
  other[40] = 1
  await send(before, image('base64://' + png.toString('base64')), OWNER, '123')
  await send(before, image('base64://' + other.toString('base64')), '10000002', '123')
  const after = s.hub(), tool = saveTool(after, s.cfg, { kind: 'group', chatId: 'group:123', groupId: '123' })
  after.simulateTurn('save-test', [OWNER])
  assert.equal((await tool.execute({ name: '主人的图' })).ok, true)
  const item = JSON.parse(readFileSync(join(s.dir, 'stickers', 'index.json'), 'utf8')).items[0]
  assert.deepEqual(readFileSync(join(s.dir, 'stickers', item.file)), png)
})

test('过期表情不能经过现有保存工具绕过有效期', async (t) => {
  const s = setup(), hub = s.hub()
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  await send(hub, image('base64://' + png.toString('base64')))
  now += 30 * 60_000
  hub.simulateTurn('save-test', [OWNER])
  const result = await saveTool(hub, s.cfg).execute({ name: '过期' })
  assert.equal(result.ok, false)
  assert.match(result.message, /最近半小时/)
  assert.equal(existsSync(join(s.dir, 'stickers', 'index.json')), false)
})

test('宿主卸载会关闭媒体缓存，旧中枢不能继续读写暂存文件', async () => {
  const s = setup()
  writeFileSync(join(s.dir, 'config.json'), JSON.stringify({ ...s.cfg, snowluma: { ...s.cfg.snowluma, autoStart: false, autoAttach: false, dir: join(s.dir, 'none') } }))
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  const { apply } = await import('../src/host.js')
  const fake = createFakeDsh({ brain: async () => '' }), api = apply(fake.ctx)
  try {
    await api.ready
    await send(api.hub, image('before-unload.png'))
    const disk = readFileSync(s.file, 'utf8')
    fake.dispose()
    assert.deepEqual(api.hub.recentMedia(CHAT), [])
    await send(api.hub, image('late-after-unload.png'))
    assert.equal(readFileSync(s.file, 'utf8'), disk)
  } finally { fake.dispose() }
})
