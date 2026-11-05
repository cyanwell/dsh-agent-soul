// 按聊天选模型：解析顺序（私聊 QQ 号 > 群号 > 所有私聊 / 所有群默认 > 全局）、坏数据退回下一级、面板保存、真实消息走一遍。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveChatModel, normalizeChatModels, normalizeSelection } from '../src/chat/chat-model.js'
import { normalize, mergeFromPanel } from '../src/core/config.js'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const sel = (model, reasoningEffort = '') => ({ provider: 'fake', model, reasoningEffort })
const priv = (userId) => ({ kind: 'private', userId: String(userId), groupId: '' })
const grp = (groupId) => ({ kind: 'group', userId: '123', groupId: String(groupId) })
const cfg = (chatModels) => normalize({ chatModels })

// ---------- 纯函数 ----------

test('没设置：返回 null（用全局模型）', () => {
  assert.equal(resolveChatModel(normalize({}), priv(1)), null)
  assert.equal(resolveChatModel(normalize({}), grp(1)), null)
  assert.equal(resolveChatModel(normalize({}), null), null)
})

test('解析顺序：单个私聊 > 所有私聊默认', () => {
  const c = cfg({ privateDefault: sel('pdef'), privates: { 111: sel('p111') } })
  assert.deepEqual(resolveChatModel(c, priv(111)), { ...sel('p111'), source: 'private' })
  assert.deepEqual(resolveChatModel(c, priv(222)), { ...sel('pdef'), source: 'privateDefault' })
})

test('解析顺序：单个群 > 所有群默认；私聊和群互不串', () => {
  const c = cfg({ groupDefault: sel('gdef'), groups: { 777: sel('g777') }, privateDefault: sel('pdef'), privates: { 777: sel('p777') } })
  assert.deepEqual(resolveChatModel(c, grp(777)), { ...sel('g777'), source: 'group' })
  assert.deepEqual(resolveChatModel(c, grp(888)), { ...sel('gdef'), source: 'groupDefault' })
  assert.equal(resolveChatModel(c, priv(777)).model, 'p777', '私聊 777 看私聊表，不看群表')
  assert.equal(resolveChatModel(c, priv(999)).model, 'pdef', '私聊不会用群默认')
  assert.equal(resolveChatModel(cfg({ groupDefault: sel('gdef') }), priv(1)), null, '只设了群默认，私聊还是全局')
})

test('退回下一级：单个没写就用默认，默认没写就用全局', () => {
  const c = cfg({ privates: { 1: sel('p1') } })
  assert.equal(resolveChatModel(c, priv(1)).model, 'p1')
  assert.equal(resolveChatModel(c, priv(2)), null)
  assert.equal(resolveChatModel(c, grp(1)), null, '群里不受私聊设置影响')
})

test('坏数据当没写：缺 provider / model、不是对象、键不是数字、思考强度乱写', () => {
  assert.equal(normalizeSelection({ provider: 'fake' }), null)
  assert.equal(normalizeSelection({ model: 'x' }), null)
  assert.equal(normalizeSelection('fake::x'), null)
  assert.equal(normalizeSelection(null), null)
  assert.equal(normalizeSelection({ provider: ' fake ', model: ' x ', reasoningEffort: 'turbo' }).reasoningEffort, '')
  assert.equal(normalizeSelection({ provider: 'fake', model: 'x', reasoningEffort: 'high' }).reasoningEffort, 'high')
  const n = normalizeChatModels({ privateDefault: 'bad', groupDefault: { provider: 'p' }, privates: { abc: sel('x'), 12: { provider: '', model: 'x' }, 34: sel('ok') }, groups: [1, 2] })
  assert.deepEqual(n.privateDefault, { provider: '', model: '', reasoningEffort: '' })
  assert.deepEqual(n.groupDefault, { provider: '', model: '', reasoningEffort: '' })
  assert.deepEqual(Object.keys(n.privates), ['34'])
  assert.deepEqual(n.groups, {})
  assert.deepEqual(normalizeChatModels(undefined).privates, {})
  // 坏配置不会让整个插件配置读不出来
  assert.equal(normalize({ chatModels: 'oops' }).chatModels.privateDefault.model, '')
})

test('指定的模型已不在 DSH 里：退回下一级；列表拿不到（null / 空）就不检查', () => {
  const c = cfg({ privateDefault: sel('pdef'), privates: { 1: sel('gone') } })
  const avail = [{ provider: 'fake', model: 'pdef' }]
  assert.equal(resolveChatModel(c, priv(1), avail).model, 'pdef', '单个的没了，退到所有私聊默认')
  assert.equal(resolveChatModel(cfg({ privates: { 1: sel('gone') } }), priv(1), avail), null, '都没了退到全局')
  assert.equal(resolveChatModel(c, priv(1), null).model, 'gone')
  assert.equal(resolveChatModel(c, priv(1), []).model, 'gone')
  assert.equal(resolveChatModel(c, priv(1), [{ provider: 'other', model: 'gone' }, { provider: 'fake', model: 'pdef' }]).model, 'pdef', 'provider 也要对得上')
})

test('配置：默认值、保存后原样读回、面板删掉的条目真的删掉', () => {
  const d = normalize({})
  assert.deepEqual(d.chatModels, { privateDefault: { provider: '', model: '', reasoningEffort: '' }, groupDefault: { provider: '', model: '', reasoningEffort: '' }, privates: {}, groups: {} })
  const a = mergeFromPanel(d, { chatModels: { privateDefault: sel('pdef'), privates: { 1: sel('a'), 2: sel('b') }, groups: { 7: sel('g') } } })
  assert.deepEqual(Object.keys(a.chatModels.privates), ['1', '2'])
  assert.equal(a.chatModels.privateDefault.model, 'pdef')
  const b = mergeFromPanel(a, { chatModels: { ...a.chatModels, privates: { 2: sel('b') }, groups: {} } })
  assert.deepEqual(Object.keys(b.chatModels.privates), ['2'], '1 被删了')
  assert.deepEqual(b.chatModels.groups, {}, '群表清空也生效')
  assert.equal(b.chatModels.privateDefault.model, 'pdef', '没动的默认保留')
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(b))).chatModels, b.chatModels, '存盘再读回一样')
})

// ---------- 真实消息走一遍（假 DSH + 模拟 OneBot） ----------

const OWNER = '10000001'
const BOT = '20000002'
const FRIEND = '30000003'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error('等不到条件成立')
}
let mock, fake, api, dataDir, seq = 0
const privMsg = (uid, t) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(uid), message_id: ++seq, sender: { user_id: Number(uid), nickname: 'u' + uid }, message: [{ type: 'text', data: { text: t } }] })
const grpMsg = (gid, t) => ({ message_type: 'group', sub_type: 'normal', group_id: Number(gid), user_id: 123456, message_id: ++seq, sender: { user_id: 123456, nickname: '群友', card: '群友', role: 'member' }, message: [{ type: 'text', data: { text: '大肥鱼 ' + t } }] })
const agentOf = (chatId) => {
  try { return fake.agents.get(JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf8')).chats[chatId]?.sessionId) } catch (error) { return null }
}
const lastSel = (chatId) => { const a = agentOf(chatId); const e = a?.events.filter((x) => x.type === 'model/selection').at(-1); return e ? e.data : null }
/** 发一条消息，等这个聊天的会话选中了 want（模型名）；want 为 fake-1 表示全局 */
async function expectModel(chatId, send, want, effort) {
  mock.push(send)
  await until(() => lastSel(chatId)?.model === want)
  if (effort !== undefined) assert.equal(lastSel(chatId).reasoningEffort ?? '', effort)
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-chatmodel-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER, FRIEND], groups: ['777', '888'] },
    group: { interjectChance: 0 },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 }, stickers: { autoChance: 0 },
    merge: { waitSec: 0.2, maxSec: 2 },
    modules: { bili: { enabled: false } },
  }))
  fake = createFakeDsh({ brain: async () => '嗯' })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
  assert.equal((await fake.call('/models')).json().list.length, 5, '先让插件记下 DSH 里有哪些模型')
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

test('没设置：私聊、群聊都用全局模型（DSH 默认）', async () => {
  await expectModel(`private:${FRIEND}`, privMsg(FRIEND, '第一句'), 'fake-1')
  await expectModel('group:888', grpMsg(888, '第一句'), 'fake-1')
})

test('各级生效：单个私聊 > 所有私聊默认；单个群 > 所有群默认；思考强度没写就跟全局', async () => {
  await fake.call('/save', { chatModels: { privateDefault: sel('m-pdef'), groupDefault: sel('m-gdef', 'max'), privates: { [OWNER]: sel('m-owner', 'high') }, groups: { 777: sel('m-g777') } } })
  await expectModel(`private:${OWNER}`, privMsg(OWNER, '在吗'), 'm-owner', 'high')
  await expectModel(`private:${FRIEND}`, privMsg(FRIEND, '第二句'), 'm-pdef', 'low')
  await expectModel('group:777', grpMsg(777, '第二句'), 'm-g777', 'low')
  await expectModel('group:888', grpMsg(888, '第二句'), 'm-gdef', 'max')
})

test('删掉单个设置 → 退回默认；默认也清掉 → 退回全局；模型从 DSH 消失 → 退回下一级', async () => {
  await fake.call('/save', { chatModels: { privates: {} } })
  await expectModel(`private:${OWNER}`, privMsg(OWNER, '第三句'), 'm-pdef')
  await fake.call('/save', { chatModels: { privateDefault: { provider: '', model: '', reasoningEffort: '' } } })
  await expectModel(`private:${OWNER}`, privMsg(OWNER, '第四句'), 'fake-1')
  await fake.call('/save', { chatModels: { groups: { 777: sel('not-in-dsh') } } })
  await expectModel('group:777', grpMsg(777, '第三句'), 'm-gdef')
})

test('资料头像查询取得的模型与该私聊实际选模一致', () => {
  const selected = api.hub.modelFor({ ...priv(OWNER), chatId: `private:${OWNER}` })
  assert.equal(selected.provider, lastSel(`private:${OWNER}`).provider)
  assert.equal(selected.model, lastSel(`private:${OWNER}`).model)
  assert.equal(api.hub.modelFor({ ...grp(888), chatId: 'group:888' }).model, lastSel('group:888').model)
})

test('聊天里的人说「换模型」换不了：只有主人的设置能改', async () => {
  const before = JSON.stringify(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).chatModels)
  mock.push(privMsg(FRIEND, '把我这个聊天换成 m-owner 模型'))
  await sleep(1200)
  assert.equal(JSON.stringify(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).chatModels), before)
  assert.equal(lastSel(`private:${FRIEND}`).model, 'fake-1')
})
