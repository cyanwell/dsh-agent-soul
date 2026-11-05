import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply, stripMarkdown, bubbleDelay } from '../src/chat/reply.js'
import { decideGroupReply, policyFor, inQuietHours, DEFAULT_GROUP_POLICY } from '../src/chat/group-policy.js'
import { parseMessageEvent, isStickerSegment, stickerSizeOk, imageSize } from '../src/chat/inbound.js'
import { checkAllowed, levelFor, presetFor, isOwner, profileToolVisible, profilePermits } from '../src/chat/access.js'
import { avatarSource } from '../src/modules/profile/index.js'
import { redact, registerSecret } from '../src/core/redact.js'

test('parseReply 拆 ||| 成多条', () => {
  const r = parseReply('在呢|||刚睡醒 嗯…|||你呢')
  assert.equal(r.silent, false)
  assert.deepEqual(r.items.map((x) => x.value), ['在呢', '刚睡醒 嗯…', '你呢'])
})

test('parseReply 识别语音和表情标记', () => {
  const r = parseReply('哼 谁要你夸 <sticker:卖萌>|||<voice>晚安啦</voice>')
  assert.deepEqual(r.items, [
    { kind: 'text', value: '哼 谁要你夸' },
    { kind: 'sticker', value: '卖萌' },
    { kind: 'voice', value: '晚安啦' },
  ])
  const r2 = parseReply('好耶<sticker:开心></sticker>')
  assert.deepEqual(r2.items.map((x) => x.kind), ['text', 'sticker'])
})

test('parseReply 沉默与空', () => {
  assert.equal(parseReply('[沉默]').silent, true)
  assert.equal(parseReply('   ').silent, true)
  assert.equal(parseReply('|||').silent, true)
})

test('stripMarkdown 洗掉 Markdown', () => {
  assert.equal(stripMarkdown('**好耶** `x` \n# 标题\n- 列表'), '好耶 x\n标题\n列表')
})

test('bubbleDelay 按下一条长短停顿', () => {
  assert.equal(bubbleDelay('嗯', () => 0), 560)
  assert.ok(bubbleDelay('这是一句比较长的话，要打好一会儿才打得完呢', () => 0) > bubbleDelay('嗯', () => 0))
  assert.ok(bubbleDelay('x'.repeat(500), () => 1) <= 4500 * 1.3)
})

test('回复按行拆成多条气泡；列表、代码、长文不拆；最多 5 条', () => {
  const NL = String.fromCharCode(10)
  assert.deepEqual(parseReply(['白米饭！必须是白米饭', '别的都能省 饭不能省'].join(NL)).items.map((x) => x.value), ['白米饭！必须是白米饭', '别的都能省 饭不能省'])
  assert.equal(parseReply(['1. 打开设置', '2. 点插件', '3. 保存'].join(NL)).items.length, 1)
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join(NL)
  assert.equal(parseReply(seven).items.length, 5)
  assert.equal(parseReply(seven).items[4].value, ['e', 'f', 'g'].join(NL))
})

const base = (o) => ({
  policy: policyFor({}, {}, 1),
  mentioned: false,
  repliedToBot: false,
  text: '今天吃什么',
  now: 10_000_000,
  hour: 15,
  recentTimes: [9_990_000, 9_995_000, 9_999_000],
  interjectTimes: [],
  rand: () => 0.01,
  ...o,
})

test('群聊：@、引用、唤醒词必回', () => {
  assert.equal(decideGroupReply(base({ mentioned: true, rand: () => 0.99 })).mode, 'must')
  assert.equal(decideGroupReply(base({ repliedToBot: true, rand: () => 0.99 })).mode, 'must')
  assert.equal(decideGroupReply(base({ text: '肥鱼在吗', rand: () => 0.99 })).mode, 'must')
  // 必回不受静默时段影响
  assert.equal(decideGroupReply(base({ mentioned: true, hour: 3 })).reply, true)
})

test('群聊：插话受概率、冷却、上限、静默、冷群约束', () => {
  assert.equal(decideGroupReply(base({})).mode, 'interject')
  assert.equal(decideGroupReply(base({ rand: () => 0.5, relevance: 0.3 })).reply, false)
  assert.equal(decideGroupReply(base({ interjectTimes: [10_000_000 - 30_000] })).reason, '插话冷却中')
  const six = [1, 2, 3, 4, 5, 6].map((i) => 10_000_000 - 100_000 * i - 200_000)
  assert.equal(decideGroupReply(base({ interjectTimes: six })).reason, '这小时插话够多了')
  assert.equal(decideGroupReply(base({ hour: 3 })).reason, '静默时段')
  assert.equal(decideGroupReply(base({ recentTimes: [1] })).reason, '群里没在聊')
})

test('群聊：话题无关不插话，越相关越容易插，加入话题后接着聊', () => {
  assert.match(decideGroupReply(base({ relevance: 0.1 })).reason, /关系不大/)
  assert.equal(decideGroupReply(base({ relevance: 0.3, rand: () => 0.3 })).mode, 'interject')
  assert.equal(decideGroupReply(base({ relevance: 0.3, rand: () => 0.4 })).reply, false)
  assert.equal(decideGroupReply(base({ relevance: 0.9, rand: () => 0.65 })).mode, 'interject')
  // 已经在聊这个话题：冷却和上限都不拦，每段都接（一段一回由攒消息保证）
  const six = [1, 2, 3, 4, 5, 6].map((i) => 10_000_000 - 10_000 * i)
  assert.equal(decideGroupReply(base({ relevance: 0.5, engagedUntil: 10_100_000, interjectTimes: six, rand: () => 0.99 })).mode, 'engaged')
  // 话题跑偏了就不接着聊
  assert.notEqual(decideGroupReply(base({ relevance: 0.1, engagedUntil: 10_100_000 })).mode, 'engaged')
})

test('群聊安全刹车：短时间说太多就歇着，主人 @ 能叫动', () => {
  const now = 10_000_000
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => now - 10_000 * i)
  assert.match(decideGroupReply(base({ mentioned: true, botReplyTimes: eight })).reason, /歇一会儿/)
  assert.equal(decideGroupReply(base({ mentioned: true, fromOwner: true, botReplyTimes: eight })).mode, 'must')
  // 没到刹车线照常回
  assert.equal(decideGroupReply(base({ mentioned: true, botReplyTimes: eight.slice(0, 7) })).mode, 'must')
  // 单个字的唤醒词也算必回
  const p = policyFor({ wakeWords: ['鱼'] }, {}, 1)
  assert.equal(decideGroupReply(base({ policy: p, text: '这鱼真大', rand: () => 0.99 })).mode, 'must')
})

test('topicRelevance', async () => {
  const { topicRelevance } = await import('../src/chat/group-policy.js')
  assert.equal(topicRelevance(['今天天气不错', '中午吃啥'], ['白米饭', '天气']), 0.3)
  assert.equal(topicRelevance(['量子力学'], ['白米饭']), 0)
  assert.equal(topicRelevance(['量子力学'], ['白米饭'], 1), 0.5)
})

test('群聊：按群覆盖策略', () => {
  const p = policyFor({ interjectChance: 0.05 }, { 123: { interjectChance: 0 } }, '123')
  assert.equal(p.interjectChance, 0)
  assert.equal(decideGroupReply(base({ policy: p })).reason, '插话关着')
  assert.equal(policyFor({}, {}, 1).cooldownSec, DEFAULT_GROUP_POLICY.cooldownSec)
})

test('inQuietHours 跨零点', () => {
  assert.equal(inQuietHours(23, [23, 9]), true)
  assert.equal(inQuietHours(5, [23, 9]), true)
  assert.equal(inQuietHours(12, [23, 9]), false)
  assert.equal(inQuietHours(2, [1, 8]), true)
})

const SELF = '20000002'

test('parseMessageEvent：@、引用、图片、表情包、语音', () => {
  const e = {
    post_type: 'message', message_type: 'group', group_id: 555, user_id: 777, message_id: 42, self_id: SELF,
    sender: { nickname: '小明', card: '明明', role: 'member' },
    message: [
      { type: 'reply', data: { id: '41' } },
      { type: 'at', data: { qq: SELF } },
      { type: 'text', data: { text: ' 看这个' } },
      { type: 'image', data: { url: 'http://x/a.jpg', sub_type: 0 } },
      { type: 'mface', data: { emoji_id: 'abc', summary: '[开心]', url: 'http://x/b.gif' } },
      { type: 'image', data: { url: 'http://x/c.gif', sub_type: 1 } },
    ],
  }
  const m = parseMessageEvent(e, SELF)
  assert.equal(m.kind, 'group')
  assert.equal(m.chatId, 'group:555')
  assert.equal(m.nickname, '明明')
  assert.equal(m.mentioned, true)
  assert.equal(m.replyId, '41')
  assert.equal(m.images.length, 1)
  assert.equal(m.stickers.length, 2)
  assert.match(m.text, /看这个/)
})

test('isStickerSegment：普通照片不算表情', () => {
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: 0, url: 'x' } }), false)
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: '1' } }), true)
  assert.equal(isStickerSegment({ type: 'image', data: { emoji_id: 'e' } }), true)
  assert.equal(isStickerSegment({ type: 'mface', data: {} }), true)
})

test('stickerSizeOk 尺寸兜底', () => {
  assert.equal(stickerSizeOk({ width: 240, height: 240, bytes: 50_000 }), true)
  assert.equal(stickerSizeOk({ width: 1080, height: 1080, bytes: 50_000 }), false)
  assert.equal(stickerSizeOk({ width: 300, height: 100, bytes: 50_000 }), false)
  assert.equal(stickerSizeOk({ width: 240, height: 240, bytes: 2_000_000 }), false)
})

test('imageSize 读 PNG 宽高', () => {
  const png = Buffer.alloc(24)
  png[0] = 0x89; png[1] = 0x50
  png.writeUInt32BE(200, 16); png.writeUInt32BE(180, 20)
  assert.deepEqual(imageSize(png), { width: 200, height: 180 })
})

const cfg = { ownerQQ: '10000001', ownerLevel: 'full', allow: { private: ['10000001'], groups: ['555'] } }

test('白名单', () => {
  assert.equal(checkAllowed(cfg, { kind: 'private', userId: '10000001' }).allowed, true)
  assert.equal(checkAllowed(cfg, { kind: 'private', userId: '999' }).allowed, false)
  assert.equal(checkAllowed(cfg, { kind: 'group', groupId: '555', userId: '1' }).allowed, true)
  assert.equal(checkAllowed(cfg, { kind: 'group', groupId: '556', userId: '1' }).allowed, false)
})

test('权限档位：主人私聊完整，群聊永远受限', () => {
  assert.equal(levelFor(cfg, { kind: 'private', userId: '10000001' }), 'full')
  assert.equal(levelFor({ ...cfg, ownerLevel: 'chat' }, { kind: 'private', userId: '10000001' }), 'chat')
  assert.equal(levelFor(cfg, { kind: 'group', userId: '10000001' }), 'social')
  assert.equal(presetFor('full'), 'aurabot-private')
  assert.equal(presetFor('full', { longTasks: true }), 'aurabot-private-long')
  assert.equal(presetFor('social', { longTasks: true }), 'aurabot-social')
  assert.equal(presetFor('social'), 'aurabot-social')
})

test('群管发起人校验：只认主人', () => {
  assert.equal(isOwner(cfg, '10000001'), true)
  assert.equal(isOwner(cfg, '12345'), false)
  assert.equal(isOwner(cfg, ''), false)
})

test('脱敏', () => {
  registerSecret('SuperSecretToken123')
  assert.equal(redact('token=abcdef123456'), 'token=***')
  assert.equal(redact('the value SuperSecretToken123 leaked'), 'the value *** leaked')
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop'), 'Authorization: ***')
  assert.equal(redact('cookie: MUSIC_U=xyz12345'), 'cookie: ***')
  assert.equal(redact('普通的话'), '普通的话')
})

test('wantsVoice：明确要语音才算', async () => {
  const { wantsVoice } = await import('../src/chat/reply.js')
  for (const t of ['用语音跟我发晚安', '发个语音呗', '语音说一下', '给我来段语音', '录个语音']) assert.equal(wantsVoice(t), true, t)
  for (const t of ['晚安', '你的语音好好听', '不要语音', '刚才那条语音是啥']) assert.equal(wantsVoice(t), false, t)
})

test('引用回复：<reply:编号> 挂到下一条气泡上，一轮最多一条，写坏的标签去掉', async () => {
  const { parseReply } = await import('../src/chat/reply.js')
  assert.deepEqual(parseReply('<reply:3>粮收到 省着花\n刷视频那摊我少刷两条').items, [
    { kind: 'text', value: '粮收到 省着花', replyTo: '3' },
    { kind: 'text', value: '刷视频那摊我少刷两条' },
  ])
  assert.equal(parseReply('哈哈\n<reply:2>你说的那个|||<reply:5>还有这个').items.filter((i) => i.replyTo).length, 1)
  assert.equal(parseReply('<reply:1><sticker:开心>').items[0].replyTo, '1')
  assert.deepEqual(parseReply('<reply:x>坏标签').items, [{ kind: 'text', value: '坏标签' }])
  assert.equal(parseReply('正常说话').items[0].replyTo, undefined)
})

test('规则：画画、唱歌只在功能真的能用时告诉她', async () => {
  const { rulesText } = await import('../src/persona/personas.js')
  const { normalize } = await import('../src/core/config.js')
  const off = rulesText('social', normalize({ imageGen: { enabled: true } }))
  assert.doesNotMatch(off, /你会画画|你会唱歌/, '没配生图服务就不说会画')
  const on = rulesText('social', normalize({ imageGen: { enabled: true, baseUrl: 'https://x/v1', model: 'm' }, song: { enabled: true } }))
  assert.match(on, /你会画画：只给主人画/)
  assert.match(on, /你会唱歌/)
})

test('空间互动：评论清洗、好友动态筛选', async () => {
  const { cleanComment, pickFeeds } = await import('../src/features/qzone-social.js')
  assert.equal(cleanComment('**好看**\n第二句\n第三句'), '好看 第二句')
  assert.equal(cleanComment('[沉默]'), '')
  assert.equal(cleanComment('x'.repeat(100)).length, 60)
  const now = Date.now()
  const feeds = [
    { appid: 311, uin: 1, key: 'a', time: now / 1000 - 60 },
    { appid: 6600, uin: 0, key: 'ad', time: now / 1000 },
    { appid: 311, uin: 9, key: 'mine', time: now / 1000 },
    { appid: 311, uin: 2, key: 'old', time: now / 1000 - 2 * 86400 },
  ]
  assert.deepEqual(pickFeeds(feeds, '9', now).map((f) => f.key), ['a'])
})

test('空间互动：一串评论里没回的新消息', async () => {
  const { pendingInThread } = await import('../src/features/qzone-social.js')
  const me = '9'
  assert.deepEqual(pendingInThread({ uin: 1, time: 1, comment_id: 'c1', replies: [] }, me).pending.map((x) => x.id), ['c1'])
  // 她自己的评论下面别人接着回她
  const mine = { uin: 9, time: 1, comment_id: 'c2', replies: [{ uin: 1, time: 2, comment_id: 'r1' }, { uin: 1, time: 3, comment_id: 'r2' }] }
  assert.deepEqual(pendingInThread(mine, me).pending.map((x) => x.id), ['c2/r1', 'c2/r2'])
  // 她已经在串里说了最后一句
  assert.equal(pendingInThread({ uin: 1, time: 1, comment_id: 'c3', replies: [{ uin: 9, time: 2, comment_id: 'r1' }] }, me).pending.length, 0)
  // 处理过的不再算
  assert.equal(pendingInThread(mine, me, new Set(['c2/r1', 'c2/r2'])).pending.length, 0)
})

test('更新：版本比较、仓库名、更新命令、更新说明', async () => {
  const u = await import('../src/core/update.js')
  assert.ok(u.compareVersions('0.3.0', '0.2.9') > 0)
  assert.ok(u.compareVersions('0.10.0', '0.9.0') > 0)
  assert.equal(u.compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(u.repoOf({ repository: { url: 'https://github.com/a/b.git' } }), 'a/b')
  assert.match(u.updateCommand('a/b'), /plugin --profile desktop add github:a\/b$/)
  const log = '# 更新记录\n\n## 0.3.0\n\n- 新的\n\n## 0.2.0\n\n- 旧的'
  assert.equal(u.changelogSection(log, '0.3.0'), '- 新的')
  assert.equal(u.changelogSection(log, '0.2.0'), '- 旧的')
  assert.equal(u.changelogSection(log, '9.9.9'), '')
  const check = u.createUpdateChecker({ pkg: { version: '0.2.0', repository: 'https://github.com/a/b' }, fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.3.0' }) }) })
  const r = await check()
  assert.equal(r.newer, true)
  assert.equal(r.latest, '0.3.0')
})

test('更新后：会公开发东西的新功能，老用户先关着，新安装照常默认开', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-upd-'))
  const prev = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  try {
    const { loadConfig } = await import('../src/core/config.js')
    assert.equal(loadConfig().qzoneSocial.enabled, true, '新安装（还没走完向导）默认开')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ setupDone: true, botQQ: '1', ownerQQ: '2' }))
    assert.equal(loadConfig().qzoneSocial.enabled, false, '老用户更新：先关着')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ setupDone: true, qzoneSocial: { enabled: true } }))
    assert.equal(loadConfig().qzoneSocial.enabled, true, '自己打开过的保持打开')
  } finally {
    process.env.AURABOT_DATA_DIR = prev
  }
})

test('空间互动：说说下的评论整理成上下文', async () => {
  const { summarizeComments } = await import('../src/features/qzone-social.js')
  const comments = [
    { uin: 1, name: 'A', content: '好看', comment_id: 'c1', replies: [{ uin: 9, name: '大肥鱼', content: '谢谢' }] },
    { uin: 2, name: '小明', content: '在哪拍的', comment_id: 'c2', replies: [] },
  ]
  assert.deepEqual(summarizeComments(comments, { selfId: '9', ownerQQ: '2', ownerName: '主人' }), ['A：好看', '  └ 你：谢谢', '小明（你的主人）：在哪拍的'])
  assert.deepEqual(summarizeComments(comments, { selfId: '9', exclude: 'c1' }), ['小明：在哪拍的'])
  assert.equal(summarizeComments(comments, { selfId: '9', max: 1 }).at(-1), '……还有 2 条')
})

test('解析：合并转发记下 id，回复里的 <poke> 变成戳一戳', async () => {
  const { parseMessageEvent } = await import('../src/chat/inbound.js')
  const { parseReply } = await import('../src/chat/reply.js')
  const m = parseMessageEvent({ message_type: 'group', group_id: 1, user_id: 2, message: [{ type: 'forward', data: { id: 'abc' } }] }, '9')
  assert.deepEqual(m.forwards, ['abc'])
  assert.match(m.text, /合并转发/)
  assert.deepEqual(parseReply('干嘛<poke>').items.map((i) => i.kind), ['text', 'poke'])
  assert.equal(parseReply('<poke><poke>').items.filter((i) => i.kind === 'poke').length, 1, '一轮最多戳一次')
})

test('#6 改资料权限：默认仅主人私聊；所有人含群；关了都不行；执行时再查', async () => {
  const { normalize } = await import('../src/core/config.js')
  const d = normalize({ ownerQQ: '1' })
  assert.deepEqual(d.profilePerms, { qqNickname: 'owner', qqSignature: 'owner', qqAvatar: 'owner', biliSign: 'owner', biliAvatar: 'owner', qqFriendRequest: 'owner', whitelist: 'owner', douyinBrowse: 'owner', douyinLike: 'owner', douyinComment: 'owner', douyinShareOwner: 'owner', douyinDm: 'owner' })
  assert.equal(normalize({ profilePerms: { qqAvatar: 'boss', biliSign: 'all' } }).profilePerms.qqAvatar, 'owner', '乱填的回到默认')
  const ownerPm = { kind: 'private', userId: '1' }
  const otherPm = { kind: 'private', userId: '2' }
  const group = { kind: 'group', userId: '1', groupId: '9' }
  assert.equal(profileToolVisible(d, 'qqNickname', ownerPm), true)
  assert.equal(profileToolVisible(d, 'qqNickname', otherPm), false)
  assert.equal(profileToolVisible(d, 'qqNickname', group), false)
  assert.equal(profilePermits(d, 'qqNickname', ownerPm, true).ok, true)
  assert.equal(profilePermits(d, 'qqNickname', ownerPm, false).ok, false, '主人私聊里混进了别人的话也不行')
  const all = normalize({ ownerQQ: '1', profilePerms: { qqNickname: 'all' } })
  assert.equal(profileToolVisible(all, 'qqNickname', group), true)
  assert.equal(profilePermits(all, 'qqNickname', otherPm, false).ok, true)
  assert.equal(profileToolVisible(all, 'qqNickname', { kind: 'system' }), false)
  const off = normalize({ ownerQQ: '1', profilePerms: { qqNickname: 'off' } })
  assert.equal(profileToolVisible(off, 'qqNickname', ownerPm), false)
  assert.equal(profilePermits(off, 'qqNickname', ownerPm, true).ok, false)
})

test('#6 头像来源：显式网址直接给网关；「刚才那张」和「画作」由工具取字节；本地路径不收', () => {
  assert.deepEqual(avatarSource('https://a.com/x.png'), { ok: true, file: 'https://a.com/x.png' })
  // last / 画作编号 现在在工具里换成本地图片字节，不再走 avatarSource
  assert.equal(avatarSource('last').ok, false)
  assert.equal(avatarSource('C:/Windows/x.png').ok, false)
  assert.equal(avatarSource('file:///etc/passwd').ok, false)
  assert.equal(avatarSource('base64://AAAA').ok, false)
})

test('#28 QQ 网关：默认 SnowLuma；接自己的 OneBot 机器人时用 onebot；乱填的回到 SnowLuma', async () => {
  const { normalize } = await import('../src/core/config.js')
  assert.equal(normalize({}).gateway, 'snowluma')
  assert.equal(normalize({ gateway: 'onebot', snowluma: { wsUrl: 'ws://napcat:3001' } }).gateway, 'onebot')
  assert.equal(normalize({ gateway: 'onebot', snowluma: { wsUrl: 'ws://napcat:3001' } }).snowluma.wsUrl, 'ws://napcat:3001')
  assert.equal(normalize({ gateway: 'whatever' }).gateway, 'snowluma')
})

test('#32 工作区位置：面板填的绝对路径优先，相对路径 / 乱填的当没填', async () => {
  const { normalize } = await import('../src/core/config.js')
  const { workspaceDirOf, WORKSPACE_DIR } = await import('../src/chat/hub.js')
  assert.equal(normalize({}).workspaceDir, '')
  assert.equal(workspaceDirOf(normalize({})), WORKSPACE_DIR)
  assert.equal(workspaceDirOf(normalize({ workspaceDir: ' D:\\Aurabot\\qq-chats ' })), 'D:\\Aurabot\\qq-chats')
  assert.equal(workspaceDirOf(normalize({ workspaceDir: '/srv/aurabot/chats' })), '/srv/aurabot/chats')
  assert.equal(normalize({ workspaceDir: 'chats' }).workspaceDir, '')
  assert.equal(normalize({ workspaceDir: '..\\x' }).workspaceDir, '')
})
