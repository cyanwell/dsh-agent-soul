// B站头像的 last 由 B站模块解析；不依赖 QQ 画作别名，也不访问真实账号。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import biliModule from '../src/modules/bili/index.js'
import { normalize } from '../src/core/config.js'

test('B站头像：last / 最近图片 / 网址、主人权限和开关在模块内正确解析', async () => {
  const cfg = normalize({ enabled: true, dryRun: true, ownerQQ: '10000001', bili: { enabled: true } })
  const builders = [], events = new Map()
  let owner = true
  const hub = { turnSendersAllOwner: () => owner, chatOfSession: () => '' }
  biliModule.setup({
    config: () => cfg, lazy: () => null, log: { info() {}, debug() {}, warn() {} },
    on: (kind, fn) => events.set(kind, fn), tool: (fn) => builders.push(fn), every() {}, route() {},
    core: { hub },
  })
  const chat = { kind: 'private', userId: '10000001', chatId: 'private:10000001' }
  const tools = builders[1]({ chat, sessionId: 'owner' })
  const avatar = tools.find((t) => t.name === 'bili_set_avatar')
  assert.ok(avatar)
  assert.match((await avatar.execute({ image: 'last' })).message, /还没人发过/)
  events.get('message')({ chatId: chat.chatId, images: [{ data: { url: 'https://image.example/owner.png' } }] })
  events.get('message')({ chatId: 'group:123', images: [{ data: { url: 'https://image.example/other.png' } }] })
  for (const image of ['last', '刚才那张图', '最近的图片']) {
    const r = await avatar.execute({ image })
    assert.equal(r.ok, true, r.message)
    assert.match(r.message, /试运行/)
    assert.match(r.message, /https:\/\/image\.example\/owner\.png/)
  }
  const explicit = await avatar.execute({ image: 'https://image.example/explicit.png' })
  assert.equal(explicit.ok, true)
  assert.match(explicit.message, /explicit\.png/)
  hub.chatOfSession = () => chat.chatId
  const restored = builders[1]({ chat: { ...chat, chatId: 'private:stale' }, sessionId: 'restored' }).find((t) => t.name === 'bili_set_avatar')
  assert.match((await restored.execute({ image: 'last' })).message, /owner\.png/, '使用会话映射的聊天图片，不串到其他聊天')
  assert.equal((await avatar.execute({ image: '#1' })).ok, false, 'B站不把画作编号当网址')
  assert.equal((await avatar.execute({ image: 'C:\\private.png' })).ok, false)
  owner = false
  assert.equal((await avatar.execute({ image: 'last' })).ok, false, '执行时复查当前轮主人权限')
  assert.deepEqual(builders[1]({ chat: { ...chat, userId: '10000002', chatId: 'private:10000002' }, sessionId: 'guest' }), [])
  owner = true
  cfg.bili.enabled = false
  assert.equal((await avatar.execute({ image: 'last' })).ok, false, '已注册工具也复查开关')
})
