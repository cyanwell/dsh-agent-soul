// 端到端：假 DSH 宿主 + 假 QQ 网关，跑通 Aurabot 整条链路。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error('等不到条件成立')
}

function fakePng(w, h, salt = 0) {
  const b = Buffer.alloc(64 + salt)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  b[40] = salt
  return b
}

// 「模型」脚本
async function brain({ preset, text, images, callTool }) {
  if (text.includes('at+表情测试')) return '<at:10000001> 看这个<sticker:开心>'
  if (text.includes('热重载探针')) { const r = await callTool('probe73', {}); return r ? '探针:' + r.message : '没有探针工具' }
  if (text.includes('慢工具测试')) { const r = await callTool('slow74', {}); return r ? '慢工具好了' : '没有慢工具' }
  if (text.includes('排队权限测试0') || text.includes('排队权限测试2')) { const r = await callTool('permprobe90', {}); return r ? String(r.message || '') : '没有探针' }
  if (text.includes('排队权限测试1')) { await sleep(1200); return '第一轮好了' }
  if (text.includes('【空间互动')) { qzonePrompts.push(text); return '哈哈好看' }
  if (/^【(私聊|群聊)/.test(text) && text.includes('戳了戳你')) return '干嘛戳我<poke>'
  if (/^【私聊/.test(text) && text.includes('表情改名测试')) { const m = text.match(/把「(.+?)」/); const r = await callTool('qq_edit_sticker', { sticker: m[1], new_name: '改过的名字', tags: ['开心'] }); return r.message }
  if (/^【私聊/.test(text) && text.includes('表情删除测试')) { const r = await callTool('qq_edit_sticker', { sticker: '改过的名字', delete: true }); return r.message }
  if (/^【私聊/.test(text) && text.includes('翻聊天记录')) { const r = await callTool('qq_chat_history', { count: 5 }); return r.message.split('\n')[0] }
  if (text.includes('查看QQ资料测试')) { const r = await callTool('qq_get_profile', {}); return r?.ok ? '资料查到了' : r ? r.message : '没这个工具' }
  if (text.includes('改昵称测试')) { const r = await callTool('qq_set_nickname', { name: '小鲸鱼' }); return r ? r.message : '没这个工具' }
  if (text.includes('改签名测试')) { const r = await callTool('qq_set_signature', { text: '今天也要开心' }); return r ? r.message : '没这个工具' }
  if (text.includes('刚才那张换头像测试')) { const r = await callTool('qq_set_avatar', { image: 'last' }); return r ? r.message : '没这个工具' }
  if (text.includes('画作换头像测试')) { const r = await callTool('qq_set_avatar', { image: '#1' }); return r ? r.message : '没这个工具' }
  if (text.includes('存画作表情测试')) { const r = await callTool('qq_save_sticker', { painting: '#1', name: '自画像' }); return r ? r.message : '没这个工具' }
  if (text.includes('换头像测试')) { const r = await callTool('qq_set_avatar', { image: 'https://example.com/a.png' }); return r ? r.message : '没这个工具' }
  if (text.includes('本地头像测试')) { const r = await callTool('qq_set_avatar', { image: 'C:/Users/a/secret.png' }); return r ? r.message : '没这个工具' }
  if (text.includes('慢慢想') && !text.includes('补充')) { await sleep(2500); return '想好了' }
  if (text.includes('引用测试') && text.startsWith('【群聊')) { const n = (text.match(/\[(\d+)\][^\n]*引用测试/) || [])[1]; return n ? `<reply:${n}>收到这条啦\n别的我就不挨个回了` : '没看到编号' }
  if (text.includes('第一句') && text.includes('第二句')) return '两句我都看到啦'
  if (text.includes('画一只')) { const r = await callTool('qq_draw_image', { prompt: '一只蓝色小鲸鱼' }); return r && r.ok ? '画好啦' : '画不了' }
  if (text.includes('【写空间日记】')) return '今天主人夸我可爱，开心得尾巴甩来甩去。晚饭吃了一大碗白米饭，满足～明天也要元气满满地陪大家聊天呀'
  if (text.includes('禁言')) {
    const r = await callTool('qq_group_admin', { action: 'ban', user_id: '999', minutes: 5 })
    return r && r.ok ? '好 禁了' : '你谁啊 我只听主人的'
  }
  if (text.includes('发文件越界')) {
    const r = await callTool('qq_send_file', { file: outsideFilePath, name: '外面的文件.txt' })
    return r && r.ok ? '居然发了' : '发文件失败：' + (r && r.message)
  }
  if (text.includes('发文件超限')) {
    const r = await callTool('qq_send_file', { file: bigFilePath, name: '太大了.bin' })
    return r && r.ok ? '居然发了' : '发文件失败：' + (r && r.message)
  }
  if (text.includes('发文件发给群')) {
    const r = await callTool('qq_send_file', { file: sendFilePath, name: '发个文件.txt', target: 'group:555' })
    return r && r.ok ? '发到群里啦' : '发文件失败：' + (r && r.message)
  }
  if (text.includes('发文件目标越界')) {
    const r = await callTool('qq_send_file', { file: sendFilePath, name: '发个文件.txt', target: 'group:999' })
    return r && r.ok ? '居然发了' : '发文件失败：' + (r && r.message)
  }
  if (text.includes('发文件测试')) {
    const r = await callTool('qq_send_file', { file: sendFilePath, name: '发个文件.txt' })
    return r && r.ok ? '文件发出去啦' : '发文件失败：' + (r ? r.message : '没有这个工具')
  }
  if (text.includes('跑个慢任务')) { await new Promise((r) => setTimeout(r, 1500)); return '慢任务跑完了' }
  if (text.includes('改成快的')) return '好 改成快的'
  if (text.includes('语音说你好')) return '你好呀'
  if (text.includes('表情语音测试')) return '<voice>晚安<face:呲牙>😁</voice>'
  if (text.includes('语音带引用')) return '<voice>晚安啦 做个好梦</voice>'
  if (text.includes('晚安')) return '<voice>晚安啦 做个好梦</voice>'
  if (text.includes('没人叫你')) return '[沉默]'
  if (images.length) return '这表情好可爱|||哪来的'
  if (text.includes('[语音]')) return '白米饭yyds'
  if (text.includes('在吗')) return preset === 'aurabot-private' ? '在呢|||刚睡醒 嗯…' : '在呀'
  return '嗯'
}

let mock
const qzonePrompts = []
let fake
let api
let dataDir
let sendFilePath
let bigFilePath
let outsideFilePath

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-e2e-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  sendFilePath = join(dataDir, 'ws', '发个文件.txt')
  bigFilePath = join(dataDir, 'ws', '太大了.bin')
  outsideFilePath = join(dataDir, '外面的文件.txt')
  writeFileSync(sendFilePath, '这是一个测试文件')
  writeFileSync(bigFilePath, Buffer.alloc(2 * 1024 * 1024))
  writeFileSync(outsideFilePath, '不在工作区里的文件')
  mock = await startMockOneBot({ selfId: BOT })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: ['555', '556', '557', '558', '559'] },
    // 556 专门测按头衔不理
    titleFilter: { enabled: true, groups: ['556'], title: '大肥鱼' },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    // 大多数用例要的是「每次都回」，刹车放宽；558/559 专门测一段一回和刹车
    group: { interjectChance: 0, burstMax: 50, overrides: { 557: { interjectChance: 1, minRelevance: 0, minRecentMessages: 0, cooldownSec: 0, quietHours: [0, 0] }, 559: { burstMax: 2 } } },
    diary: { enabled: true },
    qzoneSocial: { friendChance: 1, ownerChance: 1, intervalMin: 1440 },
    merge: { waitSec: 0.4, maxSec: 3, groupWaitSec: 0.4, groupMaxSec: 3 },
    files: { enabled: true, maxMB: 1, dirs: [] },
  }))
  fake = createFakeDsh({ brain })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const priv = (user_id, message, extra = {}) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(user_id), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(user_id), nickname: user_id === OWNER ? 'xiaoming' : '路人' }, message, ...extra })
const grp = (group_id, user_id, message, nick = '群友') => ({ message_type: 'group', sub_type: 'normal', group_id: Number(group_id), user_id: Number(user_id), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(user_id), nickname: nick, card: nick, role: 'member' }, message })
const text = (t) => [{ type: 'text', data: { text: t } }]
const sentTo = (kind, id) => mock.calls.filter((c) => c.action === `send_${kind}_msg` && String(c.params[kind === 'group' ? 'group_id' : 'user_id']) === String(id))

test('人格与规则通过提示词变量注入', () => {
  assert.match(fake.variables.get('aurabot_persona')(), /大肥鱼/)
  assert.match(fake.variables.get('aurabot_persona')(), /鲸鱼/)
  assert.match(fake.variables.get('aurabot_rules_social')(), /没有任何电脑操作能力/)
  assert.match(fake.variables.get('aurabot_rules_private')(), /10000001/)
})

test('主人私聊「在吗」：建会话（完整权限 preset）、按 ||| 拆两条发回', async () => {
  mock.push(priv(OWNER, text('在吗')))
  await until(() => sentTo('private', OWNER).length >= 2)
  const msgs = sentTo('private', OWNER).map((c) => c.params.message[0].data.text)
  assert.deepEqual(msgs.slice(0, 2), ['在呢', '刚睡醒 嗯…'])
  const turn = fake.turns.at(-1)
  assert.equal(turn.preset, 'aurabot-private')
  assert.ok(mock.sent('set_input_status').some((c) => c.params.user_id === Number(OWNER) && c.params.event_type === 1), '等回复时显示正在输入')
  assert.match(turn.userText, /^【私聊】xiaoming\(10000001\)：在吗/)
  const ws = fake.workspaces[0]
  assert.ok(ws && ws.sessionIds.length === 1, '会话放进了 Aurabot 工作区')
  // 主人私聊的会话里有完整工具
  const agent = fake.agents.get(ws.sessionIds[0])
  assert.ok(agent.tools.has('qq_send_qzone'))
  assert.ok(agent.tools.has('qq_group_admin'))
})

test('#7 主人私聊：她这一轮还在跑时再发消息，直接 steer 进去，不等整轮结束', async () => {
  const agent = fake.agents.get(fake.workspaces[0].sessionIds[0])
  const before = agent.steered.length
  mock.push(priv(OWNER, text('跑个慢任务')))
  await new Promise((r) => setTimeout(r, 700)) // 过了合并等待，这一轮已经在跑
  mock.push(priv(OWNER, text('改成快的')))
  await until(() => agent.steered.length > before)
  const steered = agent.steered.at(-1).content.filter((c) => c.type === 'text').map((c) => c.text).join('')
  assert.match(steered, /改成快的/)
  await until(() => sentTo('private', OWNER).some((c) => c.params.message[0].data.text === '好 改成快的'))
})

test('系统会话超时会及时返回，晚到的回复不会发到 QQ', async () => {
  const start = Date.now()
  await assert.rejects(api.hub.runSystemTurn('timeout-test', '超时测试', '慢慢想', { timeoutMs: 50 }), /等太久/)
  assert.ok(Date.now() - start < 1500)
  await assert.rejects(api.hub.runSystemTurn('timeout-test', '超时测试', '下一轮', { timeoutMs: 50 }), /上一轮还没结束/)
  await sleep(2800)
  // 只看这次迟到的回复有没有被发出去：别的用例可能刚好在这 2.8 秒里发消息，用全局条数判断会误报
  const late = mock.sent('send_private_msg').filter((c) => JSON.stringify(c.params || {}).includes('想好了'))
  assert.deepEqual(late, [], '超时后晚到的回复不能发到 QQ')
})

test('不在白名单的私聊：不理', async () => {
  const before = fake.turns.length
  mock.push(priv('123456', text('在吗')))
  await sleep(400)
  assert.equal(fake.turns.length, before)
  assert.equal(sentTo('private', '123456').length, 0)
})

test('群聊：没叫她不回；@她必回（群聊 preset，无本地工具）', async () => {
  const before = fake.turns.length
  mock.push(grp('555', '777', text('今天天气不错')))
  await sleep(400)
  assert.equal(fake.turns.length, before, '插话概率 0 时普通消息不回')
  mock.push(grp('555', '777', [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 在吗' } }]))
  await until(() => sentTo('group', '555').length >= 1)
  const turn = fake.turns.at(-1)
  assert.equal(turn.preset, 'aurabot-social')
  assert.match(turn.userText, /@了你/)
  assert.match(turn.userText, /今天天气不错/, '带上了群里刚才的聊天')
  const reply = sentTo('group', '555').at(-1).params.message
  assert.equal(reply[0].type, 'reply', '回复引用了对方的消息')
  assert.deepEqual(reply[1], { type: 'at', data: { qq: '777' } }, '回复真实 @ 对方')
  const agent = fake.agents.get(turn.sessionId)
  assert.ok(!agent.tools.has('qq_send_qzone'), '群聊会话没有发空间这类主人工具')
  assert.ok(!agent.tools.has('qq_send_message'))
  assert.ok(!agent.tools.has('qq_send_file'), '群聊会话没有发文件工具')
})

test('群聊：叫名字（唤醒词）必回', async () => {
  const n = sentTo('group', '555').length
  mock.push(grp('555', '778', text('肥鱼 在吗')))
  await until(() => sentTo('group', '555').length > n)
})

test('群聊插话：她可以选择不说话', async () => {
  const before = fake.turns.length
  mock.push(grp('557', '777', text('随便聊聊')))
  await until(() => fake.turns.length > before)
  assert.match(fake.turns.at(-1).userText, /没人叫你/)
  await sleep(300)
  assert.equal(sentTo('group', '557').length, 0, '回了 [沉默] 就不发')
})

test('群管：群友要求禁言被拒绝，主人要求才执行', async () => {
  mock.push(grp('555', '777', [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 把999禁言' } }]))
  await until(() => fake.turns.at(-1)?.userText.includes('把999禁言') && fake.turns.at(-1).toolCalls.length)
  let call = fake.turns.at(-1).toolCalls[0]
  assert.equal(call.result.ok, false)
  assert.equal(mock.sent('set_group_ban').length, 0)

  mock.push(grp('555', OWNER, [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 帮我把999禁言' } }], 'xiaoming'))
  await until(() => mock.sent('set_group_ban').length === 1)
  call = fake.turns.at(-1).toolCalls[0]
  assert.equal(call.result.ok, true)
  assert.equal(mock.sent('set_group_ban')[0].params.duration, 300)
})

test('群管：群友和主人的话合并成一轮时，主人的要求照样执行', async () => {
  const n = mock.sent('set_group_ban').length
  mock.push(grp('555', '777', [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 哈哈哈' } }]))
  mock.push(grp('555', OWNER, [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 他太吵了 把999禁言' } }], 'xiaoming'))
  await until(() => mock.sent('set_group_ban').length === n + 1)
  assert.equal(fake.turns.at(-1).toolCalls[0].result.ok, true)
})

test('群管：她在群里只是普通成员时，主人要求也做不了，并说明原因', async () => {
  mock.state.roles['555'] = 'member'
  try {
    const n = mock.sent('set_group_ban').length
    mock.push(grp('555', OWNER, [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 再把999禁言一次' } }], 'xiaoming'))
    await until(() => fake.turns.at(-1)?.userText.includes('再把999禁言一次') && fake.turns.at(-1).toolCalls.length)
    const r = fake.turns.at(-1).toolCalls[0].result
    assert.equal(r.ok, false)
    assert.match(r.message, /普通成员/)
    assert.equal(mock.sent('set_group_ban').length, n)
  } finally {
    delete mock.state.roles['555']
  }
})

test('按头衔不理：勾选的群里头衔是「大肥鱼」的成员 @ 她、戳她都不交给模型；没头衔的照常回', async () => {
  const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
  const titled = (uid, t) => ({ ...grp('556', uid, at(t), '另一只鱼'), sender: { user_id: Number(uid), nickname: '另一只鱼', card: '', role: 'member', title: '大肥鱼' } })
  const turns = fake.turns.length
  mock.push(titled('880', '你好呀'))
  mock.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 556, user_id: 880, target_id: Number(BOT), self_id: Number(BOT) })
  await sleep(1500)
  assert.equal(fake.turns.length, turns, '机器人的消息和戳一戳都没交给她')
  mock.push(grp('556', '881', at('在吗'), '普通群友'))
  await until(() => fake.turns.length > turns)
  assert.match(fake.turns.at(-1).userText, /在吗/)
  assert.doesNotMatch(fake.turns.at(-1).userText, /你好呀/, '被过滤的那条也没进群聊上下文')
})

test('QQ 命令：主人 /silent 后群里 @ 她也不回，/active 恢复；群友发命令不算', async () => {
  const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
  let n = sentTo('group', '555').length
  mock.push(grp('555', '777', text('/silent')))
  await sleep(500)
  mock.push(grp('555', OWNER, text('/silent'), 'xiaoming'))
  // 群友那句会交给模型，回复可能晚到、排在后面，所以等「不说话」那条出现，别只看最后一条
  await until(() => sentTo('group', '555').slice(n).some((m) => /不说话/.test(JSON.stringify(m))))
  const turns = fake.turns.length
  n = sentTo('group', '555').length
  mock.push(grp('555', '778', at('在吗')))
  await sleep(800)
  assert.equal(fake.turns.length, turns, '闭嘴时 @ 她也不交给模型')
  assert.equal(sentTo('group', '555').length, n)
  mock.push(grp('555', OWNER, text('/active'), 'xiaoming'))
  await until(() => sentTo('group', '555').length > n)
  mock.push(grp('555', '778', at('在吗')))
  await until(() => fake.turns.length > turns)
})

test('群聊一段一回：好几个人连着 @ 她，她看完整段只回一次，提示词里有每个人的话', async () => {
  const before = fake.turns.length
  const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
  mock.push(grp('558', '701', at('第一个人说话'), '甲'))
  mock.push(grp('558', '702', at('第二个人说话'), '乙'))
  mock.push(grp('558', '703', text('第三个人没叫她'), '丙'))
  mock.push(grp('558', '704', at('第四个人说话'), '丁'))
  await until(() => fake.turns.length > before)
  await sleep(1500)
  const mine = fake.turns.slice(before).filter((t) => t.userText.includes('群聊'))
  assert.equal(mine.length, 1, '只交给她一次')
  for (const w of ['第一个人', '第二个人', '第三个人', '第四个人']) assert.ok(mine[0].userText.includes(w), w)
  assert.match(mine[0].userText, /不要一条一条地挨个回/)
  // 检索记忆用的只是大家说的话，不带提示词里的说明；也记下了这一段是谁在说
  const sid = api.hub.sessions()['group:558'].sessionId
  assert.doesNotMatch(api.hub.lastTextOf(sid), /挨个回|引用回复/)
  assert.match(api.hub.lastTextOf(sid), /第一个人说话/)
  assert.deepEqual(api.hub.speakersOf(sid).sort(), ['701', '702', '703', '704'])
  const reply = sentTo('group', '558').at(-1).params.message
  assert.ok(!reply.some((seg) => seg.type === 'reply' || seg.type === 'at'), '多个人同时叫她时不猜要引用或 @ 谁')
})

test('群聊：她还在回上一段时新来的消息先攒着，回完再一起看（不会一条一轮）', async () => {
  const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
  const before = fake.turns.length
  mock.push(grp('558', '720', at('慢慢想一下这个问题'), '戊'))
  await sleep(1200) // 已经交给她了，她正在想
  mock.push(grp('558', '721', at('补充一句A'), '己'))
  mock.push(grp('558', '722', at('补充一句B'), '庚'))
  mock.push(grp('558', '723', at('补充一句C'), '辛'))
  await until(() => fake.turns.length >= before + 2, 12000)
  await sleep(1500)
  const mine = fake.turns.slice(before).filter((t) => t.userText.includes('群聊'))
  assert.equal(mine.length, 2, '第一段一轮，她想的时候来的三条合成第二轮')
  assert.ok(['补充一句A', '补充一句B', '补充一句C'].every((w) => mine[1].userText.includes(w)))
})

test('群聊被引用：引用她的消息后，回复引用并 @ 对方', async () => {
  const outgoing = await api.hub.sendText('group:555', '前一条测试消息')
  const sentId = String(outgoing.message_id)
  const target = grp('555', '779', [{ type: 'reply', data: { id: sentId } }, ...text('谢谢你')])
  const n = sentTo('group', '555').length
  mock.push(target)
  await until(() => sentTo('group', '555').length > n)
  const segs = sentTo('group', '555').at(-1).params.message
  assert.deepEqual(segs[0], { type: 'reply', data: { id: String(target.message_id) } })
  assert.deepEqual(segs[1], { type: 'at', data: { qq: '779' } })
})

test('群聊引用回复：她写 <reply:编号>，发出去的那条带上对应消息的引用', async () => {
  const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
  const first = grp('558', '730', text('先随便说一句'), '壬')
  const target = grp('558', '731', at('引用测试 这条要被引用'), '癸')
  mock.push(first)
  mock.push(target)
  const n = sentTo('group', '558').length
  await until(() => sentTo('group', '558').length >= n + 2)
  const [quoted, plain] = sentTo('group', '558').slice(n)
  assert.deepEqual(quoted.params.message[0], { type: 'reply', data: { id: String(target.message_id) } })
  assert.deepEqual(quoted.params.message[1], { type: 'at', data: { qq: '731' } })
  assert.equal(quoted.params.message.at(-1).data.text, '收到这条啦')
  assert.equal(plain.params.message[0].type, 'text', '其余的照常发，不引用')
})

test('空间互动：回复自己说说下的新评论、评论好友说说并点赞，不重复', async () => {
  const now = Math.floor(Date.now() / 1000)
  mock.state.qzoneList = [{ tid: 't1', content: '今天吃了白米饭', time: now - 600, comment_num: 1, is_private: false, images: [] }]
  mock.state.qzoneDetail = {
    t1: { tid: 't1', content: '今天吃了白米饭', comment_num: 1, comments: [{ uin: 777, name: '群友', time: now - 300, content: '好可爱', comment_id: 'c1', replies: [] }] },
    f1: { tid: 'f1', content: '周末去看海了', comment_num: 1, comments: [{ uin: 888, name: '路人甲', time: now - 50, content: '真羡慕', comment_id: 'x1', replies: [] }] },
  }
  mock.state.feeds = [
    { uin: Number(OWNER), nickname: 'xiaoming', time: now - 100, appid: 311, key: 'f1', html: '<div>周末去看海了</div>' },
    { uin: 0, nickname: '', time: now, appid: 6600, key: 'advertisement_outlink_0', html: '广告' },
    { uin: Number(BOT), nickname: '大肥鱼', time: now - 50, appid: 311, key: 't1', html: '今天吃了白米饭' },
  ]
  const r = (await fake.call('/qzone/social/run')).json()
  assert.equal(r.ok, true, r.message)
  const comments = mock.sent('comment_qzone').map((c) => c.params)
  assert.deepEqual(comments.find((c) => c.tid === 't1'), { tid: 't1', content: '回复 群友：哈哈好看' })
  assert.deepEqual(comments.find((c) => c.tid === 'f1'), { tid: 'f1', content: '哈哈好看', target_uin: Number(OWNER) })
  assert.equal(comments.length, 2, '广告和她自己的说说不碰')
  assert.equal(mock.sent('like_qzone')[0].params.tid, 'f1')
  assert.ok(qzonePrompts.some((p) => p.includes('周末去看海了') && p.includes('已经有这些评论') && p.includes('真羡慕')), '评好友说说时带上了说说内容和楼里的评论')
  await fake.call('/qzone/social/run')
  assert.equal(mock.sent('comment_qzone').length, 2, '同一条评论、同一条说说不会再评')
  const st = (await fake.call('/qzone/social/state')).json()
  assert.equal(st.count, 2)
  // 她在空间评论过谁，记成了自己的经历
  assert.ok(api.memory.recentEvents(24, 10).some((m) => m.text.includes('评论了') && m.about === OWNER))
})

test('空间互动：别人在她的评论下面接着回她，她会接着回（一串只回一次）', async () => {
  const now = Math.floor(Date.now() / 1000)
  const before = mock.sent('comment_qzone').length
  mock.state.feeds = []
  mock.state.qzoneDetail.t1.comments.push({
    uin: Number(BOT), name: '大肥鱼', time: now - 200, content: '回复 群友：哈哈好看', comment_id: 'c2',
    replies: [{ uin: 777, name: '群友', time: now - 100, content: '你也好看', comment_id: 'r1' }, { uin: 777, name: '群友', time: now - 90, content: '真的', comment_id: 'r2' }],
  })
  await fake.call('/qzone/social/run')
  const added = mock.sent('comment_qzone').slice(before).map((c) => c.params)
  assert.deepEqual(added, [{ tid: 't1', content: '回复 群友：哈哈好看' }], '两条新回复合起来只回一次')
  await fake.call('/qzone/social/run')
  assert.equal(mock.sent('comment_qzone').length, before + 1, '回过的不再回')
})

test('戳一戳：主人戳她，她会回话，还会戳回去；20 秒内重复戳只算一次', async () => {
  const turns = fake.turns.length
  const poke = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: Number(BOT), user_id: Number(OWNER), sender_id: Number(OWNER), target_id: Number(BOT) }
  mock.push(poke)
  await until(() => mock.sent('send_poke').length === 1)
  assert.match(fake.turns.at(-1).userText, /戳了戳你/)
  assert.equal(mock.sent('send_poke')[0].params.user_id, Number(OWNER))
  assert.equal(sentTo('private', OWNER).at(-1).params.message[0].data.text, '干嘛戳我')
  mock.push(poke)
  await sleep(1200)
  assert.equal(fake.turns.length, turns + 1, '连着戳只算一次')
  // 戳的不是她就不管
  mock.push({ ...poke, target_id: 12345 })
  await sleep(800)
  assert.equal(fake.turns.length, turns + 1)
})

test('合并转发：她能看到转发里的聊天记录', async () => {
  mock.state.forwards = { fw1: [
    { sender: { user_id: 801, nickname: '转发甲' }, message: [{ type: 'text', data: { text: '转发里的话甲' } }] },
    { sender: { user_id: 802, nickname: '转发乙' }, message: [{ type: 'text', data: { text: '转发里的话乙' } }] },
  ] }
  const before = fake.turns.length
  mock.push(grp('558', '805', [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 你看看这个' } }, { type: 'forward', data: { id: 'fw1' } }], '寄件人'))
  await until(() => fake.turns.length > before)
  const t = fake.turns.at(-1).userText
  assert.match(t, /合并转发的聊天记录（2 条）/)
  assert.match(t, /转发甲：转发里的话甲/)
  assert.match(t, /转发乙：转发里的话乙/)
})

test('群聊刹车：短时间说够次数就歇着，主人 @ 还能叫动', async () => {
  const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
  for (let i = 0; i < 2; i++) {
    const n = sentTo('group', '559').length
    mock.push(grp('559', '710', at('在吗' + i)))
    await until(() => sentTo('group', '559').length > n)
    await sleep(600)
  }
  const turns = fake.turns.length
  mock.push(grp('559', '711', at('在吗 再来')))
  await sleep(1500)
  assert.equal(fake.turns.length, turns, '说够 2 次了，群友 @ 也先不回')
  mock.push(grp('559', OWNER, at('在吗 主人来了'), 'xiaoming'))
  await until(() => fake.turns.length > turns)
})

test('看图：主人发来表情包，她能看到图；表情被收藏并起了备注', async () => {
  const png = fakePng(240, 240, 1)
  mock.push(priv(OWNER, [{ type: 'mface', data: { emoji_id: 'x1', summary: '[开心]', file: 'base64://' + png.toString('base64') } }]))
  await until(() => fake.turns.at(-1)?.images === 1)
  assert.match(fake.turns.at(-1).reply, /可爱/)
  await until(() => mock.sent('add_custom_face').length === 1)
  await until(() => mock.sent('modify_custom_face').length === 1)
  assert.equal(mock.sent('modify_custom_face')[0].params.desc, '可爱的小鲸鱼')
  const lib = JSON.parse(readFileSync(join(dataDir, 'stickers', 'index.json'), 'utf8'))
  assert.equal(lib.items.length, 1)
  assert.deepEqual(lib.items[0].tags, ['开心', '卖萌'])
})

test('普通照片不收进表情库', async () => {
  const photo = fakePng(1080, 720, 2)
  mock.push(priv(OWNER, [{ type: 'image', data: { sub_type: 0, file: 'base64://' + photo.toString('base64') } }]))
  await until(() => fake.turns.at(-1)?.images === 1 && fake.turns.length > 0)
  await sleep(300)
  assert.equal(mock.sent('add_custom_face').length, 1, '数量没变')
})

test('语音：回复里的 <voice> 变成 QQ 语音条', async () => {
  mock.push(priv(OWNER, text('晚安')))
  await until(() => sentTo('private', OWNER).some((c) => c.params.message[0].type === 'record'), 20000)
  const rec = sentTo('private', OWNER).find((c) => c.params.message[0].type === 'record')
  assert.match(rec.params.message[0].data.file, /^base64:\/\//)
})

test('引用 + 语音：语音条单独一条发，不和引用/@ 拼在同一条（issue #103）', async () => {
  const http = await import('node:http')
  // 用本地 HTTP TTS 避免依赖各平台的 TTS（Windows 语音在 Linux 上不可用）
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'audio/wav'); res.end(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2000)])) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  await fake.call('/save', { voice: { engine: 'http', http: { urlTemplate: `http://127.0.0.1:${srv.address().port}/tts?text={text}` } } })
  try {
    const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]
    const before = mock.calls.length
    mock.push(grp('557', '999', at('语音带引用'), 'xiaoming'))
    await until(() => mock.calls.slice(before).some((c) => c.action === 'send_group_msg' && (c.params.message || []).some((s) => s.type === 'record')), 20000)
    const recs = mock.calls.slice(before).filter((c) => c.action === 'send_group_msg' && (c.params.message || []).some((s) => s.type === 'record'))
    assert.equal(recs.length, 1, '语音条应该只发一条')
    assert.deepEqual(recs[0].params.message.map((s) => s.type), ['record'], '语音条必须单独一条，不能带引用/@：' + JSON.stringify(recs[0].params.message.map((s) => s.type)))
  } finally {
    srv.close()
    await fake.call('/save', { voice: { engine: 'windows' } })
  }
})

test('语音条不把 QQ 表情/emoji 念出来（face 标签和 emoji 在 TTS 前去掉）', async () => {
  const http = await import('node:http')
  let spoken = ''
  const srv = http.createServer((req, res) => { spoken = new URL(req.url, 'http://x').searchParams.get('text') || ''; res.end(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2000)])) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  await fake.call('/save', { voice: { engine: 'http', http: { urlTemplate: `http://127.0.0.1:${srv.address().port}/tts?text={text}` } } })
  try {
    const n = sentTo('private', OWNER).length
    mock.push(priv(OWNER, text('表情语音测试')))
    await until(() => sentTo('private', OWNER).slice(n).some((c) => (c.params.message || []).some((s) => s.type === 'record')), 20000)
    assert.match(spoken, /晚安/, '能念的字要保留：' + spoken)
    assert.doesNotMatch(spoken, /呲牙|face:|😁|在读/, '表情标签和 emoji 不能念出来：' + spoken)
  } finally {
    srv.close()
    await fake.call('/save', { voice: { engine: 'windows' } })
  }
})

test('听语音：收到语音先转文字再交给她', async () => {
  mock.push(priv(OWNER, [{ type: 'record', data: { file: 'abc.amr' } }]))
  await until(() => fake.turns.at(-1)?.userText.includes('[语音] 今天想吃白米饭'))
})

test('空间日记：手动写一篇（仅自己可见），配今天画的图，不往聊天里发，然后删除', async () => {
  const { savePainting } = await import('../src/features/paintings.js')
  const { unlinkSync } = await import('node:fs')
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const painting = savePainting(png, '日记配图测试', { now: new Date() })
  // 只统计这次调用里产生的投递：前一条消息的回复可能还在异步发送，
  // 用「调用前后全局条数」判断会偶发失败（就是那个 27 !== 26 的老毛病）
  const { result, sent } = await api.hub.capture(() => fake.call('/diary/run', { visibility: 'self' }))
  const r = result.json()
  assert.equal(r.ok, true, r.message)
  assert.equal(r.images, 1, '今天画了图，日记应该配一张')
  const q = mock.sent('send_qzone_msg')[0]
  assert.equal(q.params.ugc_right, 64)
  assert.match(q.params.content, /白米饭/)
  assert.equal(q.params.images.length, 1, '说说带了一张图')
  assert.match(q.params.images[0], /^base64:\/\//)
  assert.deepEqual(sent, [], '日记那一轮没转发到聊天里')
  const d = (await fake.call('/qzone/delete', { tid: r.tid })).json()
  assert.equal(d.ok, true)
  assert.equal(mock.qzone.size, 0)

  // 面板关掉「日记配图」：只发文字
  await fake.call('/save', { diary: { attachImage: false } })
  const r2 = (await api.hub.capture(() => fake.call('/diary/run', { visibility: 'self' }))).result.json()
  assert.equal(r2.ok, true, r2.message)
  assert.equal(r2.images, 0)
  const q2 = mock.sent('send_qzone_msg')[1]
  assert.equal(q2.params.images, undefined, '关掉后不带图')
  await fake.call('/qzone/delete', { tid: r2.tid })

  // 配图发不出去（空间不认这张图）：不能憋住整篇日记，退回只发文字
  const painting2 = savePainting(png, '日记配图失败测试', { now: new Date() })
  mock.state.failQzoneImage = true
  try {
    const r3 = (await api.hub.capture(() => fake.call('/diary/run', { visibility: 'self' }))).result.json()
    assert.equal(r3.ok, true, '配图失败也要把日记发出去')
    assert.equal(r3.images, 0, '最后没配成图')
    const q3 = mock.sent('send_qzone_msg')[2]
    assert.equal(q3.params.images, undefined, '退回只发文字的说说')
    await fake.call('/qzone/delete', { tid: r3.tid })
  } finally {
    mock.state.failQzoneImage = false
    await fake.call('/save', { diary: { attachImage: true } })
  }
  try { unlinkSync(painting2) } catch (error) {}
  try { unlinkSync(painting) } catch (error) {}
})

test('面板接口：概览、人格切换', async () => {
  const s = (await fake.call('/state')).json()
  assert.equal(s.ok, true)
  assert.equal(s.onebot.state, 'connected')
  assert.equal(s.config.snowluma.httpToken, '', '令牌不回传给面板')
  assert.equal(s.config.snowluma.httpTokenSet, true)
  const p = (await fake.call('/personas')).json()
  assert.ok(p.list.some((x) => x.id === 'dafeiyu'))
  const saved = (await fake.call('/persona/save', { id: 'test2', name: '测试', body: '你是测试人格小蓝。' })).json()
  assert.equal(saved.ok, true)
  const used = (await fake.call('/persona/use', { id: 'test2' })).json()
  assert.equal(used.ok, true)
  assert.match(fake.variables.get('aurabot_persona')(), /小蓝/)
  await fake.call('/persona/use', { id: 'dafeiyu' })
})

test('头像：上传自定义头像、同步成 QQ 头像、恢复默认', async () => {
  const before = (await fake.call('/avatar')).raw()
  assert.ok(before.length > 1000, '默认头像是插件自带的那张')
  const png = fakePng(200, 200, 7)
  const up = (await fake.call('/avatar/upload', { data: 'data:image/png;base64,' + png.toString('base64') })).json()
  assert.equal(up.ok, true)
  assert.equal((await fake.call('/state')).json().avatar.custom, true)
  assert.deepEqual(Buffer.from((await fake.call('/avatar')).raw()), png)
  assert.equal((await fake.call('/avatar/upload', { data: Buffer.from('not an image at all').toString('base64') })).json().ok, false)
  assert.equal((await fake.call('/avatar/sync-qq')).json().ok, true)
  assert.ok(mock.sent('set_qq_avatar')[0].params.file.startsWith('base64://'))
  await fake.call('/avatar/reset')
  assert.equal((await fake.call('/state')).json().avatar.custom, false)
  assert.equal((await fake.call('/avatar')).raw().length, before.length)
})

test('日志里没有令牌原文', async () => {
  const files = readdirSync(join(dataDir, 'logs'))
  const all = files.map((f) => readFileSync(join(dataDir, 'logs', f), 'utf8')).join('\n')
  assert.ok(all.length > 0)
  assert.ok(!all.includes(mock.token), '日志里出现了 token')
})

test('重新开始：归档会话，下一条消息开新会话', async () => {
  const before = Object.keys((await fake.call('/state')).json().sessions).length
  assert.ok(before > 0)
  const r = (await fake.call('/sessions/reset')).json()
  assert.equal(r.ok, true)
  assert.equal(Object.keys((await fake.call('/state')).json().sessions).length, 0)
})

test('语音发不出去时退回成发文字', async () => {
  mock.state.failRecord = true
  const n = sentTo('private', OWNER).length
  mock.push(priv(OWNER, text('晚安')))
  await until(() => sentTo('private', OWNER).slice(n).some((c) => c.params.message[0].type === 'text' && c.params.message[0].data.text.includes('晚安')), 20000)
  mock.state.failRecord = false
})

test('明确要语音但她只打了字：插件强制转成语音', async () => {
  const n = sentTo('private', OWNER).length
  mock.push(priv(OWNER, text('用语音说你好')))
  await until(() => sentTo('private', OWNER).slice(n).some((c) => c.params.message[0].type === 'record'), 20000)
  assert.ok(!sentTo('private', OWNER).slice(n).some((c) => c.params.message[0].type === 'text' && c.params.message[0].data.text === '你好呀'))
})

test('连发合并：一口气发两句，她只回一次', async () => {
  const before = fake.turns.length
  mock.push(priv(OWNER, text('第一句')))
  await sleep(150)
  mock.push(priv(OWNER, text('第二句')))
  await until(() => fake.turns.length > before)
  await sleep(800)
  assert.equal(fake.turns.length, before + 1, '两句合成了一轮')
  assert.match(fake.turns.at(-1).userText, /第一句[\s\S]*第二句/)
})

test('本地 CosyVoice：裸 PCM 包成 WAV 发出语音', async () => {
  const http = await import('node:http')
  let got = null
  const srv = http.createServer(async (req, res) => {
    let b = ''
    for await (const c of req) b += c
    got = { url: req.url, body: new URLSearchParams(b) }
    res.end(Buffer.alloc(22050 * 2 * 0.5))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  await fake.call('/save', { voice: { engine: 'cosyvoice', cosyvoice: { url: `http://127.0.0.1:${srv.address().port}`, spkId: '中文女' } } })
  const r = (await fake.call('/voice/test', { text: '你好呀' })).json()
  srv.close()
  await fake.call('/save', { voice: { engine: 'windows' } })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.engine, 'cosyvoice')
  assert.equal(got.url, '/inference_sft')
  assert.equal(got.body.get('tts_text'), '你好呀')
  assert.equal(Buffer.from(r.data, 'base64').toString('ascii', 0, 4), 'RIFF')
})

test('生图：主人让她画图，调生图服务并把图发出去', async () => {
  const http = await import('node:http')
  let body = null
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const srv = http.createServer(async (req, res) => {
    let b = ''
    for await (const c of req) b += c
    body = JSON.parse(b)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  await fake.call('/save', { imageGen: { enabled: true, baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, model: 'test-model', apiKey: 'img-key-123456', stylePrompt: '可爱风' } })
  const n = sentTo('private', OWNER).length
  mock.push(priv(OWNER, text('画一只鲸鱼')))
  await until(() => sentTo('private', OWNER).slice(n).some((c) => c.params.message[0].type === 'image'), 10000)
  srv.close()
  assert.equal(body.model, 'test-model')
  assert.match(body.prompt, /可爱风.*一只蓝色小鲸鱼/)
  const st = (await fake.call('/state')).json()
  assert.equal(st.config.imageGen.apiKey, '', '生图密钥不回传')
  assert.equal(st.config.imageGen.apiKeySet, true)
})

test('生图工具结果：能看图时带 image 块，纯文本模型只给文字（#37）', async () => {
  const http = await import('node:http')
  // 用带尺寸的 PNG：这张画之后还会被「存成表情」，表情库会校验宽高
  const png = fakePng(240, 240, 7)
  const srv = http.createServer(async (req, res) => {
    for await (const _ of req) { /* 读完请求体 */ }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${srv.address().port}/v1`
  // 找准「这次画图」那一轮：别用 sentTo 计数判断，前一个用例的回复可能还在异步发送
  const drawTurn = () => [...fake.turns].reverse().find((t) => (t.toolCalls || []).some((c) => c.name === 'qq_draw_image'))
  const draw = async (vision, seeOwn = true) => {
    const before = drawTurn()
    await fake.call('/save', {
      model: { vision },
      imageGen: { enabled: true, baseUrl, model: 'test-model', apiKey: 'img-key-123456', seeOwn },
    })
    mock.push(priv(OWNER, text('画一只鲸鱼')))
    await until(() => drawTurn() && drawTurn() !== before, 15000)
    return drawTurn().toolCalls.find((c) => c.name === 'qq_draw_image').result
  }

  // 面板里声明「支持」：工具结果里要有图，而且是登记过的附件块
  // （直接塞 base64 会让下一轮请求整轮失败，见 imageToolBlock 的注释）
  const withImg = await draw('on')
  assert.ok(withImg.image, '能看图的模型应拿到 image')
  assert.equal(withImg.image.type, 'image')
  assert.ok(withImg.image.attachment?.attachmentId, '要登记成附件块')
  assert.equal(withImg.image.data, undefined, '不要裸 base64')
  assert.match(withImg.message || '', /画作编号 #1/, '画完给一个画作编号，换头像 / 收表情时用')
  // #59：能看图的模型要拿到本地保存路径，方便她收录表情包 / 存素材
  assert.ok(withImg.path && /\.png$/.test(withImg.path), '能看图时要返回本地路径：' + JSON.stringify(withImg.path))
  assert.match(withImg.message || '', /已保存到本机：/, '路径写进工具结果文字里')
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(withImg.path), true, '路径对应的文件真的存在')
  assert.equal(withImg.prompt, '一只蓝色小鲸鱼', '带上原始提示词')
  assert.ok(Number(withImg.bytes) > 0 && Number(withImg.elapsedMs) >= 0, '带字节数和耗时')

  // 「让她画完自己看一眼」关掉：不传图、不给路径，但编号照给（还能换头像 / 存表情）
  const noLook = await draw('on', false)
  assert.equal(noLook.image, undefined, '关掉开关就不该塞图')
  assert.match(noLook.message || '', /没把图给你看/)
  assert.match(noLook.message || '', /画作编号 #1/)
  assert.doesNotMatch(noLook.message || '', /已保存到本机/, '开关关着时也不给路径')

  // 声明「不支持」：纯文本模型，绝不能塞 image 块
  const noImg = await draw('off')
  assert.equal(noImg.image, undefined, '纯文本模型不应该拿到 image 块')
  assert.match(noImg.message || '', /没能把图片交给你看/, '看不了图时要如实说，别让她编画面')
  assert.doesNotMatch(noImg.message || '', /存在\s*[A-Za-z]:[\\/]|\.png|已保存到本机/, '看不了图的模型不给文件路径')

  // 恢复默认
  await fake.call('/save', { model: { vision: 'auto' }, imageGen: { seeOwn: true } })
  srv.close()
})

test('画作编号：换头像 / 存表情都能用，而且不靠文件路径', async () => {
  // 上一条用例在这个聊天里画过图，画作编号已经登记
  mock.push(priv(OWNER, text('画作换头像测试')))
  const a = await lastCall('画作换头像测试')
  assert.equal(a.result.ok, true, JSON.stringify(a.result))
  const call = mock.sent('set_qq_avatar').at(-1)
  const file = String(call.params.file)
  assert.match(file, /^base64:\/\/|avatar-/i, '用画作换头像：交的是图片数据，不是模型给的路径')

  const before = (await fake.call('/stickers')).json().items.length
  mock.push(priv(OWNER, text('存画作表情测试')))
  const b = await lastCall('存画作表情测试')
  assert.equal(b.result.ok, true, JSON.stringify(b.result))
  const items = (await fake.call('/stickers')).json().items
  assert.equal(items.length, before + 1, '自己画的图能收进表情库')
  assert.ok(items.some((i) => i.name === '自画像'), '名字用她给的那个')
})

test('换头像：主人发来的图也能用，不能被「她的画作」抢走', async () => {
  // 主人先发一张图（和画作不同的字节，能区分是哪张）
  const png = fakePng(300, 300, 11)
  mock.push(priv(OWNER, [{ type: 'image', data: { sub_type: 0, file: 'base64://' + png.toString('base64') } }]))
  await until(() => fake.turns.at(-1)?.images === 1)

  const n = mock.sent('set_qq_avatar').length
  mock.push(priv(OWNER, text('刚才那张换头像测试')))
  const c = await lastCall('刚才那张换头像测试')
  assert.equal(c.result.ok, true, JSON.stringify(c.result))
  assert.equal(mock.sent('set_qq_avatar').length, n + 1, '真的调了换头像')
  const call = mock.sent('set_qq_avatar').at(-1)
  const file = String(call.params.file)
  assert.match(file, /^base64:\/\/|avatar-/i, '应该交图片数据，而不是链接')
  const sent = file.startsWith('base64://')
    ? Buffer.from(file.slice('base64://'.length), 'base64')
    : readFileSync(file)
  assert.deepEqual(sent, png, '换上去的是主人发的那张图，不是她自己的画')
})

test('每日整理：往日的临时流水整理后清空，今天的保留；空间日记进了记忆库', async () => {
  const { existsSync } = await import('node:fs')
  const dir = join(dataDir, 'chatlog')
  mkdirSync(dir, { recursive: true })
  const old = join(dir, '2026-01-01.jsonl')
  writeFileSync(old, ['你好', '我喜欢吃辣', '周末一起打游戏吧', '好呀'].map((t, i) => JSON.stringify({ t: i, chatId: 'private:' + OWNER, who: i % 2 ? 'bot' : 'xiaoming', text: t })).join('\n') + '\n')
  const r = (await fake.call('/memory/extract', {})).json()
  assert.equal(r.ok, true, r.message)
  assert.equal(existsSync(old), false, '往日的流水被清空')
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  assert.equal(existsSync(join(dir, key + '.jsonl')), true, '今天的流水保留')
  const mem = (await fake.call('/memories')).json()
  assert.ok(mem.items.some((m) => m.source === 'diary' && m.text.includes('白米饭')), '空间日记进了记忆库')
})

test('表情包她自己整理：改名、改标签（同步到 QQ 收藏备注）、删掉', async () => {
  const up = (await fake.call('/sticker/upload', { data: fakePng(200, 200, 9).toString('base64'), name: '测试猫猫' })).json()
  assert.equal(up.ok, true)
  const target = (await fake.call('/stickers')).json().items.find((i) => i.name === '测试猫猫')
  assert.ok(target)
  const mods = mock.sent('modify_custom_face').length
  mock.push(priv(OWNER, text(`表情改名测试 把「${target.name}」改个名`)))
  await until(() => fake.turns.at(-1)?.userText.includes('表情改名测试') && fake.turns.at(-1).toolCalls.length)
  assert.match(fake.turns.at(-1).toolCalls[0].result.message, /改好了/)
  const after = (await fake.call('/stickers')).json().items.find((i) => i.md5 === target.md5)
  assert.equal(after.name, '改过的名字')
  assert.deepEqual(after.tags, ['开心'])
  if (target.emojiId) await until(() => mock.sent('modify_custom_face').length > mods)
  mock.push(priv(OWNER, text('表情删除测试')))
  await until(() => fake.turns.at(-1)?.userText.includes('表情删除测试') && fake.turns.at(-1).toolCalls.length)
  assert.match(fake.turns.at(-1).toolCalls[0].result.message, /删掉了/)
  assert.equal((await fake.call('/stickers')).json().items.some((i) => i.md5 === target.md5), false)
})

test('翻聊天记录：读当前聊天更早的消息', async () => {
  mock.state.history = [{ time: 1700000000, user_id: 777, sender: { user_id: 777, nickname: '老张' }, message: [{ type: 'text', data: { text: '上周说好去吃火锅' } }] }]
  mock.push(priv(OWNER, text('翻聊天记录看看')))
  await until(() => fake.turns.at(-1)?.userText.includes('翻聊天记录') && fake.turns.at(-1).toolCalls.length)
  assert.match(fake.turns.at(-1).toolCalls[0].result.message, /老张：上周说好去吃火锅/)
})

const lastCall = (word) => until(() => { const t = fake.turns.at(-1); return t?.userText.includes(word) && t.toolCalls.length ? t.toolCalls[0] : null })

test('#6 改资料：默认仅主人私聊，昵称 / 签名 / 头像走 SnowLuma 对应动作', async () => {
  mock.push(priv(OWNER, text('改昵称测试')))
  let c = await lastCall('改昵称测试')
  assert.equal(c.result.ok, true)
  assert.deepEqual(mock.sent('set_qq_profile').at(-1).params, { nickname: '小鲸鱼' })
  mock.push(priv(OWNER, text('改签名测试')))
  c = await lastCall('改签名测试')
  assert.equal(c.result.ok, true)
  assert.deepEqual(mock.sent('set_self_longnick').at(-1).params, { longNick: '今天也要开心' })
  mock.push(priv(OWNER, text('换头像测试')))
  c = await lastCall('换头像测试')
  assert.equal(c.result.ok, true)
  assert.equal(mock.sent('set_qq_avatar').at(-1).params.file, 'https://example.com/a.png')
  const n = mock.sent('set_qq_avatar').length
  mock.push(priv(OWNER, text('本地头像测试')))
  c = await lastCall('本地头像测试')
  assert.equal(c.result.ok, false, '本地路径不收')
  assert.equal(mock.sent('set_qq_avatar').length, n)
})

test('#6 改资料：群里默认没有这些工具；调成「所有人」后群友也能改；「关」了谁都不行', async () => {
  const n = mock.sent('set_qq_profile').length
  mock.push(grp('555', OWNER, [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 改昵称测试一' } }], 'xiaoming'))
  let c = await lastCall('改昵称测试一')
  assert.equal(c.result.message, 'no such tool')
  assert.equal(mock.sent('set_qq_profile').length, n)

  await fake.call('/save', { profilePerms: { qqNickname: 'all' } })
  mock.push(grp('555', '777', [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 改昵称测试二' } }]))
  c = await lastCall('改昵称测试二')
  assert.equal(c.result.ok, true)
  assert.equal(mock.sent('set_qq_profile').length, n + 1)

  await fake.call('/save', { profilePerms: { qqNickname: 'off' } })
  mock.push(priv(OWNER, text('改昵称测试三')))
  c = await lastCall('改昵称测试三')
  assert.equal(c.result.message, 'no such tool')
  assert.equal(mock.sent('set_qq_profile').length, n + 1)
  await fake.call('/save', { profilePerms: { qqNickname: 'owner' } })
})

test('#52 发文件：主人私聊让她发本机文件，走 OneBot upload_private_file', async () => {
  const before = mock.sent('upload_private_file').length
  mock.push(priv(OWNER, text('发文件测试一')))
  await until(() => mock.sent('upload_private_file').length > before)
  const call = mock.sent('upload_private_file').at(-1)
  assert.equal(String(call.params.user_id), OWNER)
  assert.equal(call.params.file, sendFilePath)
  assert.equal(call.params.name, '发个文件.txt')
  await until(() => sentTo('private', OWNER).some((c) => c.params.message.some((s) => s.type === 'text' && s.data.text === '文件发出去啦')))
  assert.equal(fake.turns.at(-1).toolCalls.at(-1).result.ok, true)
})

test('#52 发文件：网关看不到本机路径时，小文件自动改走 base64', async () => {
  mock.state.failUploadPath = true
  try {
    const before = mock.sent('upload_private_file').length
    mock.push(priv(OWNER, text('发文件测试二')))
    await until(() => mock.sent('upload_private_file').length >= before + 2)
    const tried = mock.sent('upload_private_file').slice(before)
    assert.equal(tried[0].params.file, sendFilePath, '先按本机路径发')
    assert.match(String(tried[1].params.file), /^base64:\/\//)
    assert.equal(Buffer.from(String(tried[1].params.file).slice('base64://'.length), 'base64').toString('utf8'), '这是一个测试文件')
    await until(() => sentTo('private', OWNER).some((c) => c.params.message.some((s) => s.type === 'text' && s.data.text === '文件发出去啦')))
  } finally {
    mock.state.failUploadPath = false
  }
})

test('#52 发文件：模拟测试里只截获，不真的上传', async () => {
  const before = mock.sent('upload_private_file').length + mock.sent('upload_group_file').length
  const r = (await fake.call('/modules/tool', { name: 'qq_send_file', args: { file: sendFilePath, name: '发个文件.txt' } })).json()
  assert.equal(r.ok, true)
  assert.equal(r.result.ok, true, r.result.message)
  assert.match(JSON.stringify(r.sent), /\[文件\]/)
  assert.equal(mock.sent('upload_private_file').length + mock.sent('upload_group_file').length, before, '模拟里不能真上传')
})

test('#52 发文件：只允许发 QQ 工作区 / 面板加过的目录里的文件', async () => {
  const before = mock.sent('upload_private_file').length
  mock.push(priv(OWNER, text('发文件越界一')))
  await until(() => sentTo('private', OWNER).some((c) => c.params.message.some((s) => s.type === 'text' && String(s.data.text).includes('允许发送的目录'))))
  assert.equal(mock.sent('upload_private_file').length, before, '越界的文件没有上传')
})

test('#52 发文件：超过大小上限不发，并说明上限', async () => {
  const before = mock.sent('upload_private_file').length
  mock.push(priv(OWNER, text('发文件超限一')))
  await until(() => sentTo('private', OWNER).some((c) => c.params.message.some((s) => s.type === 'text' && String(s.data.text).includes('文件太大'))))
  assert.equal(mock.sent('upload_private_file').length, before, '超限的文件没有上传')
})

test('#52 发文件：主人让她发给白名单里的群（走 upload_group_file）', async () => {
  const before = mock.sent('upload_group_file').length
  mock.push(priv(OWNER, text('发文件发给群一')))
  await until(() => mock.sent('upload_group_file').length > before)
  const call = mock.sent('upload_group_file').at(-1)
  assert.equal(String(call.params.group_id), '555')
  assert.equal(call.params.file, sendFilePath)
  assert.equal(call.params.name, '发个文件.txt')
})

test('#52 发文件：target 不在白名单里就拒绝', async () => {
  const before = mock.sent('upload_group_file').length + mock.sent('upload_private_file').length
  mock.push(priv(OWNER, text('发文件目标越界一')))
  await until(() => sentTo('private', OWNER).some((c) => c.params.message.some((s) => s.type === 'text' && String(s.data.text).includes('不在白名单里'))))
  assert.equal(mock.sent('upload_group_file').length + mock.sent('upload_private_file').length, before)
})

test('#52 发文件：面板关掉「发文件」后，她就没这个工具了', async () => {
  await fake.call('/save', { files: { enabled: false } })
  try {
    const before = mock.sent('upload_private_file').length
    mock.push(priv(OWNER, text('发文件测试三')))
    await until(() => sentTo('private', OWNER).some((c) => c.params.message.some((s) => s.type === 'text' && String(s.data.text).includes('没有这个工具'))))
    assert.equal(mock.sent('upload_private_file').length, before, '关掉后不会上传')
  } finally {
    await fake.call('/save', { files: { enabled: true } })
  }
})


test('主人私聊可以查询最新 QQ 资料，关闭资料模块后查询工具撤销', async () => {
  const expected = { ...mock.state.selfProfile }
  mock.push(priv(OWNER, text('查看QQ资料测试')))
  const c = await lastCall('查看QQ资料测试')
  assert.equal(c.result.ok, true)
  assert.equal(c.result.profile.nickname, expected.nickname)
  assert.equal(c.result.profile.signature, expected.long_nick)
  assert.equal(mock.sent('get_stranger_info').at(-1).params.no_cache, true)
  assert.match(fake.variables.get('aurabot_rules_private')(), /qq_get_profile/)
  assert.doesNotMatch(fake.variables.get('aurabot_rules_social')(), /qq_get_profile/)
  try {
    await fake.call('/save', { modules: { profile: { enabled: false } } })
    await until(() => !api.modules.use('profile'))
    assert.doesNotMatch(fake.variables.get('aurabot_rules_private')(), /qq_get_profile/)
    mock.push(priv(OWNER, text('查看QQ资料测试 模块关闭')))
    const unavailable = await lastCall('模块关闭')
    assert.equal(unavailable.result.message, 'no such tool')
  } finally {
    await fake.call('/save', { modules: { profile: { enabled: true } } })
  }
})

test('#58 在 DSH 会话窗口里直接打字：这一轮按主人说的算（重开会话后也一样）', async () => {
  // 先重新开始所有 QQ 会话，模拟用户点「重新开始所有 QQ 会话」
  await fake.call('/sessions/reset')
  // 从 QQ 发一条消息，建立新的 QQ 会话
  const n = fake.turns.length
  mock.push(priv(OWNER, text('在吗')))
  await until(() => fake.turns.length > n)
  const sid = fake.workspaces[0].sessionIds.at(-1)
  assert.ok(sid, '新会话建出来了')
  // 模拟主人在 DSH 会话窗口里直接打字（DSH 会发 user/message，source.kind = 'user'）
  api.hub.onSessionEvent({ id: sid }, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我把 B 站头像改一下' }] } })
  assert.equal(api.hub.turnSendersAllOwner(sid), true, '面板里直接打字也算主人')
  assert.equal(api.hub.turnHasOwner(sid), true)
  // 权限真的通了：改昵称工具（默认仅主人）能执行
  const agent = fake.agents.get(sid)
  const tool = agent && agent.tools.get('qq_set_nickname')
  assert.ok(tool, '会话里有改资料工具')
  const r = await tool.execute({ name: '小鲸鱼' }, { agent })
  assert.equal(r.ok, true, JSON.stringify(r))
  // 从 QQ 转进来的消息（source.kind = 'aurabot'）不会误标成「面板里直接打字」
  api.hub.onSessionEvent({ id: sid }, { type: 'turn/end', data: { turn: 999999, reason: { kind: 'completed' } } })
  api.hub.onSessionEvent({ id: sid }, { type: 'user/message', data: { role: 'user', source: { kind: 'aurabot' }, content: [{ type: 'text', text: 'x' }] } })
  assert.equal(api.hub.turnSendersAllOwner(sid), true, '主人私聊里还有 #90 的安全兜底：这里只可能是主人说话')
})

test('模块热重载后：已有会话下一轮会重挂新实例的工具（issue #73）', async () => {
  const modsDir = join(dataDir, 'modules', 'probe73')
  mkdirSync(modsDir, { recursive: true })
  const writeProbe = (v) => writeFileSync(join(modsDir, 'index.mjs'), `export default {
  id: 'probe73', name: '探针', api: 1,
  setup(api) {
    api.tool(({ chat, level }) => level === 'chat' ? [] : [api.defineTool({
      name: 'probe73', description: '探针', properties: {},
      execute: async () => ({ ok: true, message: ${JSON.stringify(v)} }),
    })])
  },
}`)
  const ask = async () => {
    const n = fake.turns.length
    mock.push(priv(OWNER, text('热重载探针')))
    await until(() => fake.turns.length > n)
    return String(fake.turns.at(-1).reply || '')
  }
  writeProbe('v1')
  // 等模块被 watcher 加载（每 3 秒扫一次），最多 20 秒
  const first = await until(async () => { const r = await ask(); return r.includes('v1') ? r : null }, 20000)
  assert.match(first, /v1/)
  writeProbe('v2') // 改文件触发热重载
  const second = await until(async () => { const r = await ask(); return r.includes('v2') ? r : null }, 20000)
  assert.match(second, /v2/, '热重载后会话应重挂新实例的工具，而不是继续用旧闭包')
  rmSync(modsDir, { recursive: true, force: true })
})

test('#77 群里 at 标签和表情包同时出现：at 是真 @，表情包单独一条', async () => {
  const up = (await fake.call('/sticker/upload', { data: fakePng(200, 200, 7).toString('base64'), name: '开心' })).json()
  assert.equal(up.ok, true)
  const before = mock.calls.length
  mock.push(grp('557', '999', text('at+表情测试'), 'xiaoming'))
  await until(() => mock.calls.slice(before).filter((c) => c.action === 'send_group_msg').length >= 2, 12000)
  const sent = mock.calls.slice(before).filter((c) => c.action === 'send_group_msg').map((c) => c.params.message)
  const atMsg = sent.find((m) => m.some((s) => s.type === 'at'))
  assert.ok(atMsg, '要有真 @ 消息：' + JSON.stringify(sent))
  assert.ok(atMsg.some((s) => s.type === 'at' && String(s.data.qq) === OWNER), 'at 目标是主人：' + JSON.stringify(atMsg))
  assert.ok(sent.some((m) => m.some((s) => s.type === 'image')), '表情包要单独一条：' + JSON.stringify(sent))
  assert.ok(!sent.some((m) => m.some((s) => s.type === 'text' && /@10000001/.test(s.data.text))), '不能把 at 降级成文字：' + JSON.stringify(sent))
})

test('慢工具卡住超过 1.5 秒先发一条「正在做」提示，不让主人干等整轮（issue #74）', async () => {
  const modsDir = join(dataDir, 'modules', 'slow74')
  mkdirSync(modsDir, { recursive: true })
  writeFileSync(join(modsDir, 'index.mjs'), `export default {
  id: 'slow74', name: '慢工具探针', api: 1,
  setup(api) {
    api.tool(({ chat, level }) => level === 'chat' ? [] : [api.defineTool({
      name: 'slow74', description: '慢工具探针',
      slow: '还在忙，稍等一会儿～',
      properties: {},
      execute: async () => { await new Promise((r) => setTimeout(r, 1800)); return { ok: true, message: '慢的好了' } },
    })])
  },
}`)
  const before = mock.calls.length
  const turn = async () => {
    const n = fake.turns.length
    mock.push(priv(OWNER, text('慢工具测试')))
    await until(() => fake.turns.length > n, 15000)
    return fake.turns.at(-1)
  }
  const t = await until(async () => { const x = await turn(); return x.reply === '慢工具好了' ? x : null }, 25000)
  assert.equal(t.reply, '慢工具好了')
  const sent = mock.calls.slice(before).filter((c) => c.action === 'send_private_msg').map((c) => c.params.message)
  const texts = sent.map((m) => (m || []).filter((s) => s.type === 'text').map((s) => s.data.text).join(''))
  const noticeAt = texts.findIndex((x) => /还在忙/.test(x))
  const doneAt = texts.findIndex((x) => /慢工具好了/.test(x))
  assert.ok(noticeAt >= 0, '慢工具卡住时要先发提示：' + JSON.stringify(texts))
  assert.ok(doneAt > noticeAt, '提示要比最终回复先到：' + JSON.stringify(texts))
  rmSync(modsDir, { recursive: true, force: true })
})

test('主人私聊里这一轮的说话人记录丢了，也按主人算（#90 兜底）', async () => {
  const n = fake.turns.length
  mock.push(priv(OWNER, text('兜底测试')))
  await until(() => fake.turns.length > n, 8000)
  const sid = fake.turns.at(-1).sessionId
  assert.ok(sid, '主人私聊会话应该已经建过')
  api.hub.simulateTurn(sid, [])
  api.hub.onSessionEvent({ id: sid }, { type: 'turn/end', data: { turn: 999, reason: { kind: 'completed' } } })
  assert.equal(api.hub.turnSendersAllOwner(sid), true, '主人私聊里仅主人操作不该被误拒')
  assert.equal(api.hub.turnHasOwner(sid), true)
  const gsid = api.hub.sessions()['group:557']?.sessionId
  if (gsid) {
    api.hub.simulateTurn(gsid, [])
    api.hub.onSessionEvent({ id: gsid }, { type: 'turn/end', data: { turn: 998, reason: { kind: 'completed' } } })
    assert.equal(api.hub.turnSendersAllOwner(gsid), false, '群聊不能兜底成主人')
  }
})

test('上一轮还在跑时排队的新消息，不会让下一轮的「仅主人」判断失效（#90）', async () => {
  const modsDir = join(dataDir, 'modules', 'permprobe90')
  mkdirSync(modsDir, { recursive: true })
  writeFileSync(join(modsDir, 'index.mjs'), `export default {
  id: 'permprobe90', name: '权限探针', api: 1,
  setup(api) {
    const hub = api.core.hub
    api.tool(({ level, sessionId }) => level === 'chat' ? [] : [api.defineTool({
      name: 'permprobe90', description: '权限探针',
      properties: {},
      execute: async () => ({ ok: true, message: 'allOwner=' + hub.turnSendersAllOwner(sessionId) + ',hasOwner=' + hub.turnHasOwner(sessionId) }),
    })])
  },
}`)
  // 先等探针工具装上（模块 watcher 每 3 秒扫一次），期间反复发探测消息
  const probe = async () => {
    const n = fake.turns.length
    mock.push(grp('557', OWNER, text('排队权限测试0'), '主人'))
    await until(() => fake.turns.length > n, 8000)
    return String(fake.turns.at(-1).reply || '')
  }
  await until(async () => /allOwner=/.test(await probe()), 20000)
  // 上一轮还在跑（brain sleep 1200ms）时来下一条消息，两条都在 557 群里
  const before = fake.turns.length
  mock.push(grp('557', OWNER, text('排队权限测试1'), '主人'))
  await sleep(800)
  mock.push(grp('557', OWNER, text('排队权限测试2'), '主人'))
  const second = await until(() => fake.turns.slice(before).find((t) => /allOwner=/.test(String(t.reply))), 20000)
  assert.match(String(second.reply), /allOwner=true/, '排队轮次也要认出主人：' + second.reply)
  rmSync(modsDir, { recursive: true, force: true })
})
