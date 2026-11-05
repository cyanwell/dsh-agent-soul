// QQ 资料读取：仅主人私聊、只查自身、真实字段语义及按需视觉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import profileModule from '../src/modules/profile/index.js'
import { createQqProfile } from '../src/features/qq-profile.js'
import { normalize } from '../src/core/config.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

const OWNER = '10000001'
const BOT = '20000002'
const ownerChat = { kind: 'private', chatId: `private:${OWNER}`, userId: OWNER }
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])

function setup(overrides = {}) {
  let cfg = normalize({ botQQ: BOT, ownerQQ: OWNER, model: { vision: 'on' }, ...overrides.cfg })
  const calls = [], rules = [], disposers = [], sends = [], downloads = [], asks = [], attachments = []
  let allOwner = true, builder
  const state = { nickname: '大肥鱼', long_nick: '爱吃白米饭' }
  const api = {
    config: () => cfg,
    dsh: overrides.dsh || { attachments: { async admitPromptContent(blocks) {
      attachments.push(...blocks)
      return blocks.map(({ mediaType }) => ({ type: 'image', attachment: { attachmentId: 'avatar-att' }, mediaType }))
    } } },
    core: {
      hub: { turnSendersAllOwner: () => allOwner, modelFor: () => overrides.model,
        async sendSegments(chatId, message) {
          sends.push({ chatId, message })
          return overrides.sendSegments ? overrides.sendSegments(chatId, message) : { message_id: 55 }
        } },
      onebot: { async call(action, params, options) {
        calls.push({ action, params, options })
        if (overrides.call) return overrides.call(action, params)
        if (action === 'get_stranger_info') return { user_id: Number(BOT), ...state }
        if (action === 'get_login_info') return { user_id: Number(BOT), nickname: state.nickname }
        if (action === 'set_qq_profile') state.nickname = params.nickname
        if (action === 'set_self_longnick') state.long_nick = params.longNick
        return null
      } },
    },
    on() {},
    onDispose: (fn) => disposers.push(fn),
    rule: (fn) => rules.push(fn),
    tool: (fn) => { builder = fn },
  }
  profileModule.setup(api, {
    async fetchAvatar(url, options) { downloads.push({ url, options }); return overrides.fetchAvatar ? overrides.fetchAvatar(url, options) : png },
    async ask(_dsh, options) { asks.push(options); return '蓝色的小鲸鱼。' },
  })
  return { calls, state, rules, sends, downloads, asks, attachments,
    tools: (chat = ownerChat) => Object.fromEntries(builder({ chat, sessionId: 's1' }).map((tool) => [tool.name, tool])),
    set: (patch) => { cfg = normalize({ ...cfg, ...patch }) },
    mixed: () => { allOwner = false },
    dispose: () => disposers.forEach((fn) => fn()),
  }
}

function reader(overrides = {}) {
  let cfg = normalize({ botQQ: BOT, ownerQQ: OWNER, model: { vision: 'on' }, ...overrides.cfg })
  const calls = [], images = [], asks = []
  const r = createQqProfile({
    getConfig: () => cfg,
    dsh: overrides.dsh || {},
    onebot: { async call(action, params, options) {
      calls.push({ action, params, options })
      if (overrides.call) return overrides.call(action, params)
      return { user_id: Number(BOT), nickname: '大肥鱼', long_nick: '爱吃白米饭' }
    } },
    fetchAvatar: async (url, options) => { images.push({ url, options }); return overrides.image ?? png },
    ask: async (dsh, options) => { asks.push(options); return overrides.ask ? overrides.ask(options) : '蓝色的小鲸鱼，白色背景。' },
  })
  return { ...r, calls, images, asks, set: (patch) => { cfg = normalize({ ...cfg, ...patch }) } }
}

test('仅主人私聊挂查询工具，修改权限关闭也不影响只读查询', async () => {
  const s = setup({ cfg: { profilePerms: { qqNickname: 'off', qqSignature: 'off', qqAvatar: 'off' } } })
  assert.deepEqual(Object.keys(s.tools()), ['qq_get_profile', 'qq_send_avatar'])
  assert.equal(s.tools({ kind: 'private', userId: '30000003' }).qq_get_profile, undefined)
  assert.equal(s.tools({ kind: 'group', userId: OWNER, groupId: '777' }).qq_get_profile, undefined)
  assert.equal(s.tools({ kind: 'system' }).qq_get_profile, undefined)
  const result = await s.tools().qq_get_profile.execute({})
  assert.equal(result.ok, true)
  assert.equal(result.profile.nickname, '大肥鱼')
  assert.equal(result.profile.signature, '爱吃白米饭')
  assert.deepEqual(s.calls.map((c) => c.action), ['get_stranger_info'])
})

test('查询权限始终仅主人，修改权限设为所有人也不会扩散查询工具', () => {
  const s = setup({ cfg: { profilePerms: { qqNickname: 'all', qqSignature: 'all', qqAvatar: 'all' } } })
  const group = s.tools({ kind: 'group', userId: OWNER, groupId: '777' })
  assert.ok(group.qq_set_nickname)
  assert.equal(group.qq_get_profile, undefined)
})

test('执行时再次核对主人和本轮发言者，拒绝后不调用网关', async () => {
  const s = setup(), tool = s.tools().qq_get_profile
  s.mixed()
  assert.equal((await tool.execute({})).ok, false)
  assert.equal(s.calls.length, 0)
  const changed = setup(), old = changed.tools().qq_get_profile
  changed.set({ ownerQQ: '30000003' })
  assert.equal((await old.execute({})).ok, false)
  assert.equal(changed.calls.length, 0)
})

test('查询对象固定自身，工具不接受其他 QQ 号或任意图片地址', async () => {
  const s = setup(), tool = s.tools().qq_get_profile
  assert.deepEqual(Object.keys(tool.parameters.properties), ['view_avatar'])
  await tool.execute({ user_id: '30000003', avatar_url: 'http://127.0.0.1/secret' })
  assert.deepEqual(s.calls[0].params, { user_id: Number(BOT), no_cache: true })
})

test('资料没有长期缓存，修改后再次查询读取最新值', async () => {
  const s = setup({ cfg: { dryRun: false } }), tools = s.tools()
  assert.equal((await tools.qq_get_profile.execute({})).profile.nickname, '大肥鱼')
  await tools.qq_set_nickname.execute({ name: '爱吃白饭的大肥鱼' })
  await tools.qq_set_signature.execute({ text: '今天也要开心' })
  const updated = await tools.qq_get_profile.execute({})
  assert.equal(updated.profile.nickname, '爱吃白饭的大肥鱼')
  assert.equal(updated.profile.signature, '今天也要开心')
  assert.equal(s.calls.filter((c) => c.action === 'get_stranger_info').length, 2)
})

test('空签名表示未设置，缺失签名明确报告未能获取', async () => {
  const empty = reader({ call: () => ({ user_id: Number(BOT), nickname: '大肥鱼', long_nick: '' }) })
  const a = await empty.read()
  assert.equal(a.profile.signature, '')
  assert.match(a.message, /个性签名：.*未设置/)
  const blank = reader({ call: () => ({ user_id: Number(BOT), nickname: '大肥鱼', long_nick: '   ' }) })
  const w = await blank.read()
  assert.equal(w.profile.signature, '', '全是空格的签名也当未设置')
  assert.match(w.message, /个性签名：.*未设置/)
  const missing = reader({ call: () => ({ user_id: Number(BOT), nickname: '大肥鱼' }) })
  const b = await missing.read()
  assert.equal(b.profile.signature, null)
  assert.match(b.message, /个性签名：.*未能获取/)
  assert.doesNotMatch(b.message, /个性签名：.*未设置/)
})

test('详细接口失败可降级读取昵称，接口都失败时明确返回失败', async () => {
  const s = reader({ call: (action) => {
    if (action === 'get_stranger_info') throw new Error('不支持')
    return { user_id: Number(BOT), nickname: '登录昵称' }
  } })
  const a = await s.read()
  assert.equal(a.ok, true)
  assert.equal(a.profile.nickname, '登录昵称')
  assert.equal(a.profile.signature, null)
  const broken = reader({ call: () => { throw new Error('断开') } })
  assert.equal((await broken.read()).ok, false)
  assert.ok(broken.calls.every((c) => c.options.retries === 0 && c.options.timeoutMs <= 8000))
})

test('返回其他账号或配置中途改变时，不采用资料或继续识图', async () => {
  const mismatch = reader({ call: () => ({ user_id: 99999999, nickname: '错误账号' }) })
  await assert.rejects(mismatch.read({ viewAvatar: true }), /账号.*不一致/)
  assert.equal(mismatch.calls.length, 1)
  assert.equal(mismatch.images.length, 0)
  const changed = reader({ call: () => { changed.set({ botQQ: '30000003' }); return { nickname: '旧号' } } })
  await assert.rejects(changed.read(), /机器人 QQ 已变化/)
})

test('默认只读文本及头像地址，不下载图片或调用视觉模型', async () => {
  const s = reader(), r = await s.read()
  assert.equal(r.ok, true)
  assert.equal(new URL(r.profile.avatar.url).searchParams.get('nk'), BOT)
  assert.equal(r.profile.avatar.viewed, false)
  assert.equal(s.images.length, 0)
  assert.equal(s.asks.length, 0)
  assert.ok(Number.isFinite(Date.parse(r.fetchedAt)))
})

test('按需下载固定自身头像，真实图片字节交给视觉模型并返回描述', async () => {
  const s = reader(), r = await s.read({ viewAvatar: true })
  assert.equal(r.profile.avatar.viewed, true)
  assert.match(r.profile.avatar.description, /小鲸鱼/)
  assert.equal(new URL(s.images[0].url).hostname, 'q1.qlogo.cn')
  assert.equal(new URL(s.images[0].url).searchParams.get('nk'), BOT)
  assert.equal(s.images[0].options.allowLocal, false)
  assert.equal(s.asks[0].images[0].data, png.toString('base64'))
  assert.equal(s.asks[0].images[0].mediaType, 'image/png')
  assert.ok(s.asks[0].maxTokens >= 1000)
})

test('模型不支持看图时保留文字资料，并明确头像未识别', async () => {
  const s = reader({ cfg: { model: { vision: 'off' } } }), r = await s.read({ viewAvatar: true })
  assert.equal(r.ok, true)
  assert.equal(r.profile.avatar.viewed, false)
  assert.match(r.profile.avatar.error, /不支持看图/)
  assert.equal(r.profile.signature, '爱吃白米饭')
  assert.equal(s.images.length, 0)
  assert.equal(s.asks.length, 0)
})

test('头像识别使用该私聊的最终模型，仍遵守手动视觉开关', async () => {
  const dsh = { llm: { resolveModelInfo: async (p, m) => ({ inputModalities: m === 'qq-profile-see' ? ['text', 'image'] : ['text'] }) } }
  const cfg = { model: { provider: 'qq-profile-test', model: 'blind', vision: 'auto' } }
  const s = reader({ cfg, dsh })
  const result = await s.read({ viewAvatar: true, model: { provider: 'qq-profile-test', model: 'qq-profile-see' } })
  assert.equal(result.profile.avatar.viewed, true)
  assert.equal(s.asks[0].cfg.model.model, 'qq-profile-see')
  const off = reader({ cfg: { model: { ...cfg.model, vision: 'off' } }, dsh })
  assert.equal((await off.read({ viewAvatar: true, model: { provider: 'qq-profile-test', model: 'qq-profile-see' } })).profile.avatar.viewed, false)
  assert.equal(off.asks.length, 0)
})

test('头像不是图片、视觉失败或无正文时如实降级，不编造画面', async () => {
  const bad = reader({ image: Buffer.from('<html>error</html>') })
  assert.match((await bad.read({ viewAvatar: true })).profile.avatar.error, /未返回.*图片/)
  assert.equal(bad.asks.length, 0)
  const failed = reader({ ask: () => { throw new Error('视觉服务失败') } })
  const a = await failed.read({ viewAvatar: true })
  assert.equal(a.profile.avatar.description, null)
  assert.match(a.message, /视觉服务失败/)
  const empty = reader({ ask: () => '' })
  assert.match((await empty.read({ viewAvatar: true })).profile.avatar.error, /没有返回头像描述/)
})

test('主人身份在查询期间变化时，不返回查询结果', async () => {
  const s = setup({ call: () => { s.set({ ownerQQ: '30000003' }); return { user_id: Number(BOT), nickname: '大肥鱼', long_nick: '' } } })
  const r = await s.tools().qq_get_profile.execute({})
  assert.equal(r.ok, false)
  assert.equal(r.profile, undefined)
})

test('试运行和调试允许只读查询，模块卸载后旧工具失效', async () => {
  for (const cfg of [{ dryRun: true }, { debug: true }]) {
    const s = setup({ cfg }), tool = s.tools().qq_get_profile
    assert.equal((await tool.execute({})).ok, true)
    const before = s.calls.length
    s.dispose()
    assert.equal((await tool.execute({})).ok, false)
    assert.equal(s.calls.length, before)
  }
})

test('查询等待期间卸载，不会继续获取头像或返回陈旧结果', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = reader({ call: () => gate })
  const work = s.read({ viewAvatar: true })
  s.dispose()
  release({ user_id: Number(BOT), nickname: '旧实例' })
  await assert.rejects(work, /关闭或卸载/)
  assert.equal(s.images.length, 0)
})

test('主动查询规则只在主人私聊规则中出现，要求依据实时结果回答', () => {
  const s = setup()
  const privateRules = s.rules.map((fn) => fn('private')).join('\n')
  assert.match(privateRules, /qq_get_profile/)
  assert.match(privateRules, /主动/)
  assert.match(privateRules, /view_avatar=true/)
  assert.match(privateRules, /qq_send_avatar/)
  assert.match(privateRules, /不要.*重复发图/)
  assert.equal(s.rules.map((fn) => fn('social')).join(''), '')
})

test('查询头像工具返回同一张图的登记附件，render 把图片交给聊天模型且不发送 QQ 消息', async () => {
  const s = setup(), tool = s.tools().qq_get_profile
  const result = await tool.execute({ view_avatar: true })
  assert.equal(result.profile.avatar.attached, true)
  assert.equal(result.profile.avatar.viewed, true)
  assert.equal(result.image.attachment.attachmentId, 'avatar-att')
  assert.equal(result.image.data, undefined)
  const blocks = tool.output.render({}, result)
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'image'])
  assert.equal(s.attachments[0].data, png.toString('base64'))
  assert.equal(s.asks[0].images[0].data, s.attachments[0].data)
  assert.equal(s.downloads.length, 1)
  assert.equal(s.sends.length, 0)
  assert.deepEqual(tool.output.render({}, { ok: false, message: '拒绝', image: result.image }).map((b) => b.type), ['text'])
})

test('文字识别失败仍保留实际图片附件；附件失败仍保留文字描述', async () => {
  const withImage = reader({ dsh: { attachments: { admitPromptContent: async () => [{ type: 'image', attachment: { attachmentId: 'real-avatar' } }] } }, ask: () => { throw new Error('描述超时') } })
  const a = await withImage.read({ viewAvatar: true })
  assert.equal(a.profile.avatar.viewed, false)
  assert.equal(a.profile.avatar.attached, true)
  assert.equal(a.image.attachment.attachmentId, 'real-avatar')
  assert.match(a.message, /描述超时/)
  const noImage = reader({ dsh: { attachments: { admitPromptContent: async () => { throw new Error('不可登记') } } } })
  const b = await noImage.read({ viewAvatar: true })
  assert.equal(b.profile.avatar.viewed, true)
  assert.equal(b.profile.avatar.attached, false)
  assert.equal(b.image, undefined)
  assert.match(b.message, /图片未附上/)
})

test('发送头像工具只给当前主人私聊，修改头像权限关闭也可用', async () => {
  const s = setup({ cfg: { enabled: true, dryRun: false, profilePerms: { qqAvatar: 'off' } } })
  const tool = s.tools().qq_send_avatar
  assert.deepEqual(tool.parameters.properties, {})
  for (const chat of [{ kind: 'private', userId: '30000003' }, { kind: 'group', userId: OWNER }, { kind: 'system' }]) assert.equal(s.tools(chat).qq_send_avatar, undefined)
  const r = await tool.execute({ target: 'group:777', avatar_url: 'http://127.0.0.1/private', user_id: '30000003' })
  assert.equal(r.sent, true)
  assert.equal(r.messageId, 55)
  assert.equal(s.sends.length, 1)
  assert.equal(s.sends[0].chatId, ownerChat.chatId)
  assert.deepEqual(s.sends[0].message, [{ type: 'image', data: { file: 'base64://' + png.toString('base64') } }])
  assert.equal(new URL(s.downloads[0].url).searchParams.get('nk'), BOT)
  assert.equal(s.downloads[0].options.allowLocal, false)
  assert.equal(s.asks.length, 0)
})

test('纯文本模型也能发送当前头像；再次发送重新下载当前图片', async () => {
  let image = png
  const s = setup({ cfg: { enabled: true, dryRun: false, model: { vision: 'off' } }, fetchAvatar: () => image })
  const tool = s.tools().qq_send_avatar
  assert.equal((await tool.execute({})).sent, true)
  image = Buffer.concat([png, Buffer.from('new-avatar')])
  assert.equal((await tool.execute({})).sent, true)
  assert.equal(s.downloads.length, 2)
  assert.notEqual(s.sends[0].message[0].data.file, s.sends[1].message[0].data.file)
  assert.equal(s.asks.length, 0)
  assert.equal(s.attachments.length, 0)
})

test('试运行、调试、总开关关闭不下载或发送头像', async () => {
  for (const cfg of [{ enabled: true, dryRun: true }, { enabled: true, debug: true }, { enabled: false, dryRun: false }]) {
    const s = setup({ cfg }), r = await s.tools().qq_send_avatar.execute({})
    assert.equal(r.sent, false)
    assert.equal(s.downloads.length, 0)
    assert.equal(s.sends.length, 0)
    if (cfg.enabled) assert.equal(r.simulated, true)
    else assert.equal(r.ok, false)
  }
})

test('发送执行前重新校验主人、本轮身份及模块是否存活', async () => {
  for (const change of [(s) => s.mixed(), (s) => s.set({ ownerQQ: '30000003' }), (s) => s.dispose()]) {
    const s = setup({ cfg: { enabled: true, dryRun: false } }), tool = s.tools().qq_send_avatar
    change(s)
    const r = await tool.execute({})
    assert.equal(r.ok, false)
    assert.equal(s.downloads.length, 0)
    assert.equal(s.sends.length, 0)
  }
})

test('下载等待期间切换账号、主人、模式、模块或总开关，不继续发送', async () => {
  for (const change of [(s) => s.set({ botQQ: '30000003' }), (s) => s.set({ ownerQQ: '30000003' }), (s) => s.mixed(), (s) => s.set({ debug: true }), (s) => s.set({ enabled: false }), (s) => s.dispose()]) {
    let release
    const waiting = new Promise((r) => { release = r })
    const s = setup({ cfg: { enabled: true, dryRun: false }, fetchAvatar: () => waiting })
    const work = s.tools().qq_send_avatar.execute({})
    assert.equal(s.downloads.length, 1)
    change(s); release(png)
    const r = await work
    assert.equal(r.sent, false)
    assert.equal(s.sends.length, 0)
  }
})

test('下载失败、非图片、过大图片和网关未确认不报告发送成功', async () => {
  for (const fetchAvatar of [() => { throw new Error('下载超时') }, () => Buffer.from('<html>error</html>'), () => Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    const s = setup({ cfg: { enabled: true, dryRun: false }, fetchAvatar })
    const r = await s.tools().qq_send_avatar.execute({})
    assert.equal(r.ok, false)
    assert.equal(r.sent, false)
    assert.equal(s.sends.length, 0)
  }
  for (const sendSegments of [() => null, () => ({}), () => { throw new Error('网关断开') }]) {
    const s = setup({ cfg: { enabled: true, dryRun: false }, sendSegments })
    const r = await s.tools().qq_send_avatar.execute({})
    assert.equal(r.ok, false)
    assert.equal(r.sent, false)
    assert.equal(s.sends.length, 1, '失败后不会额外再发一次')
  }
})

test('发送头像经过模拟 OneBot 网关，只有一条真实图片段而不是链接文字', async (t) => {
  const gateway = await startMockOneBot({ selfId: BOT })
  t.after(() => gateway.close())
  const s = setup({ cfg: { enabled: true, dryRun: false }, async sendSegments(chatId, message) {
    const r = await fetch(gateway.httpUrl + '/send_private_msg', { method: 'POST', headers: { authorization: 'Bearer ' + gateway.token, 'content-type': 'application/json' }, body: JSON.stringify({ user_id: Number(chatId.slice(8)), message }) })
    return (await r.json()).data
  } })
  const r = await s.tools().qq_send_avatar.execute({})
  assert.equal(r.sent, true)
  const sent = gateway.sent('send_private_msg')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].params.user_id, Number(OWNER))
  assert.deepEqual(sent[0].params.message, [{ type: 'image', data: { file: 'base64://' + png.toString('base64') } }])
})
