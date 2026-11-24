// 上游 contacts 模块的**契约保持**测试（2026-11-24 第四片）
// ============================================================================
// 这一片只做一件事：把 set_friend_add_request / set_doubt_friends_add_request 这两个
// **确切的动作名**送进 Core 的 strict outbox.act。所以「上游一行未改、行为不变」是
// 这次迁移最重要的那条断言 —— 而不是「搬运成功」。
//
// 本文件钉死的是 contacts 模块那一侧（**不碰 outbox、不连网关**）：
//   · 权限三档（profileToolVisible / profilePermits）与 allOwner / dryRun 仍然在模块里判；
//   · 通过 / 拒绝的两个 action 名与 { flag, approve } + timeoutMs 15000 原样交出去；
//   · 成功之后**只清那一条** pending（flag 与 userId 都对上才清）；
//   · ★ 失败路径的契约不变：抛出 → 工具回 { ok:false, message: '…没成功：<原文>' }，
//     而且 pending **不清**（没批成就不许从待办里抹掉，否则主人再也看不到这条申请）。
//
// 假 api 只提供模块实际用到的那几样；dataDir 指到临时目录，绝不碰真实数据。
// 跑法：node --test test/contacts-friend-request.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const contacts = (await import('../src/aurabot/src/modules/contacts/index.js')).default

const DIR = mkdtempSync(join(tmpdir(), 'contacts-friend-request-'))
const pendingPath = () => join(DIR, 'friend-requests.json')

const OWNER = '10001'

/** 写一份「已收到过一条申请」的 pending 文件（模块真实写的就是这个形状）。 */
function seedPending (rows) {
  writeFileSync(pendingPath(), JSON.stringify(rows))
}
function readPending () {
  try {
    return JSON.parse(readFileSync(pendingPath(), 'utf8'))
  } catch { return [] }
}
function clearPending () {
  try { writeFileSync(pendingPath(), '[]') } catch { /* 临时目录，清不掉也不影响断言 */ }
}

function baseConfig (over = {}) {
  return {
    enabled: true,
    dryRun: false,
    ownerQQ: OWNER,
    botQQ: '20002',
    allow: { private: [], groups: [] },
    profilePerms: { qqFriendRequest: 'owner' },
    ...over,
  }
}

/**
 * 造一个最小 api：只给 contacts 模块真正用到的东西。
 * ★ onebot.call 是**唯一**的出口，所以每个断言都能落在「模块交出了什么」上。
 */
function mountContacts ({ config = baseConfig(), call } = {}) {
  const calls = []
  const tools = []
  const api = {
    core: {
      hub: { turnSendersAllOwner: () => true },
      // 模块侧 facade 的 call(action, params, opts) 形状
      onebot: {
        state: 'connected',
        call: async (action, params, opts) => {
          calls.push({ action, params, opts })
          return call ? call(action, params, opts) : { ok: true }
        },
      },
    },
    dataDir: (...p) => (p.length ? join(DIR, ...p) : DIR),
    on: () => () => {},
    config: () => config,
    sendText: async () => ({}),
    log: { warn () {}, info () {}, error () {}, debug () {} },
    tool: (fn) => { tools.push(...(fn({ chat: { kind: 'private', userId: String(config.ownerQQ) }, sessionId: 'sys-1' }) || [])) },
  }
  contacts.setup(api)
  return { api, calls, tools }
}

const friendTool = (tools) => tools.find((t) => t.name === 'qq_handle_friend_request')

/** 一次「通过收到的那条申请」的完整往返（approve 用布尔，qq 省略 = 只有一条待处理）。 */
async function approveOnlyPending (config) {
  seedPending([{ flag: 'flag:evt-abc-123', userId: '20003', comment: '我是隔壁的', at: 1 }])
  const { calls, tools } = mountContacts({ config })
  const tool = friendTool(tools)
  assert.ok(tool, 'qq_handle_friend_request 必须挂出来（权限默认 owner + 主人私聊）')
  const result = await tool.execute({ approve: true }, { dryRun: Boolean(config.dryRun) })
  return { result, calls }
}

// ── ① 权限仍在模块里（这一层不复制判据，所以只能在这里验） ──────────────────
test('权限：qqFriendRequest=off → 工具根本不挂出来', () => {
  const { tools } = mountContacts({ config: baseConfig({ profilePerms: { qqFriendRequest: 'off' } }) })
  assert.equal(friendTool(tools), undefined)
})

test('权限：owner 档 + 群聊会话 → 不挂出来（只有主人私聊能做）', () => {
  const tools = []
  const api = {
    core: { hub: { turnSendersAllOwner: () => true }, onebot: { state: 'connected', call: async () => ({}) } },
    dataDir: (...p) => (p.length ? join(DIR, ...p) : DIR),
    on: () => () => {},
    config: () => baseConfig(),
    sendText: async () => ({}),
    log: { warn () {} },
    tool: (fn) => { tools.push(...(fn({ chat: { kind: 'group', userId: '300', groupId: '888' }, sessionId: 'sys-2' }) || [])) },
  }
  contacts.setup(api)
  assert.equal(friendTool(tools), undefined)
})

test('dryRun：试运行里一个动作都不发，但话还是照常说', async () => {
  const { result, calls } = await approveOnlyPending(baseConfig({ dryRun: true }))
  assert.equal(result.ok, true)
  assert.match(result.message, /试运行/)
  assert.equal(calls.filter((c) => c.action === 'set_friend_add_request').length, 0, 'dryRun 时不许发动作')
  assert.equal(readPending().length, 1, '试运行不算处理过，pending 必须留着')
})

// ── ② 成功路径：两个 action 名 / { flag, approve } / 15s，pending 只清那一条 ──
test('成功：set_friend_add_request { flag, approve } + timeoutMs 15000 原样交出，pending 清空', async () => {
  seedPending([{ flag: 'flag:evt-abc-123', userId: '20003', comment: '我是隔壁的', at: 1 }])
  const { calls, tools } = mountContacts({})
  const tool = friendTool(tools)
  const result = await tool.execute({ approve: true }, { dryRun: false })

  assert.equal(result.ok, true)
  assert.match(result.message, /已通过 QQ 20003 的好友申请/)
  const acts = calls.filter((c) => c.action === 'set_friend_add_request')
  assert.equal(acts.length, 1, '只该批一条')
  assert.deepEqual(acts[0].params, { flag: 'flag:evt-abc-123', approve: true }, 'flag 逐字、approve 布尔')
  assert.equal(typeof acts[0].params.approve, 'boolean')
  assert.equal(acts[0].opts.timeoutMs, 15000, 'contacts 显式给的 15s 必须原样')
  assert.deepEqual(readPending(), [], '成功后只清掉被批的那一条（这里是唯一一条）')
})

test('成功（拒绝）：approve=false 也是布尔，pending 同样只清那一条', async () => {
  seedPending([
    { flag: 'flag:keep', userId: '20009', at: 2 },
    { flag: 'flag:evt-abc-123', userId: '20003', at: 1 },
  ])
  const { calls, tools } = mountContacts({})
  const tool = friendTool(tools)
  const result = await tool.execute({ qq: '20003', approve: false }, { dryRun: false })

  assert.equal(result.ok, true)
  assert.match(result.message, /已拒绝 QQ 20003/)
  assert.deepEqual(calls.filter((c) => c.action === 'set_friend_add_request')[0].params,
    { flag: 'flag:evt-abc-123', approve: false })
  assert.deepEqual(readPending().map((x) => x.userId), ['20009'], '别人的那条必须还在')
})

// ── ③ ★ 失败路径的契约：抛出 → ok:false + 原文，pending **不清** ─────────────
for (const [label, action] of [
  ['出站口拒绝（OutboxGatewayError）', 'set_friend_add_request'],
  ['任何抛出的错都走同一条路', 'set_friend_add_request'],
]) {
  test('失败（' + label + '）：工具回 ok:false、把原文带进 message，pending 不清', async () => {
    seedPending([{ flag: 'flag:evt-abc-123', userId: '20003', at: 1 }])
    const boom = new Error(action + ' 失败（出站口）：flag 无效或已处理')
    boom.code = 'outbox-rejected'
    boom.transport = false
    const { calls, tools } = mountContacts({ call: () => { throw boom } })
    const tool = friendTool(tools)

    const result = await tool.execute({ approve: true }, { dryRun: false })

    assert.equal(result.ok, false, '失败必须回 ok:false（工具层不许抛）')
    assert.match(result.message, /通过 QQ 20003 的好友申请没成功：/)
    assert.match(result.message, /flag 无效或已处理/, '出站口的原文要带出来，否则主人只看到一句「没成功」')
    assert.equal(calls.filter((c) => c.action === 'set_friend_add_request').length, 1, '只尝试一次（出站口不重试，这里也不许补）')
    assert.equal(readPending().length, 1, '★ 没批成就不许把这条申请从待办里抹掉')
    assert.equal(readPending()[0].flag, 'flag:evt-abc-123')
  })
}

// ── ④ 「可能认识的人」那条：读动作仍直达 client，写动作才改道 ───────────────
test('doubt 路径：先 get_doubt_friends_add_request（读，仍直达 client），再 set_doubt_friends_add_request', async () => {
  clearPending()
  const call = (action) => {
    if (action === 'get_doubt_friends_add_request') return [{ uid: 'doubt-uid-77', user_id: '20007' }]
    return { ok: true }
  }
  const { calls, tools } = mountContacts({ call })
  const tool = friendTool(tools)
  const result = await tool.execute({ qq: '20007', approve: true }, { dryRun: false })

  assert.equal(result.ok, true)
  assert.deepEqual(calls[0], {
    action: 'get_doubt_friends_add_request', params: { count: 50 }, opts: { timeoutMs: 15000 },
  }, '读动作原样（这条没迁移，也不该被这次改动碰到）')
  const write = calls.find((c) => c.action === 'set_doubt_friends_add_request')
  assert.deepEqual(write.params, { flag: 'doubt-uid-77', approve: true }, 'uid 逐字当 flag')
  assert.equal(write.opts.timeoutMs, 15000)
  assert.equal(calls.some((c) => c.action === 'set_friend_add_request'), false, 'doubt 那条不许误走 event 的那个名字')
})

test('没有待处理申请 → 先说清楚，一个动作都不发', async () => {
  clearPending()
  const { calls, tools } = mountContacts({ call: () => [] })
  const tool = friendTool(tools)
  const result = await tool.execute({ approve: true }, { dryRun: false })

  assert.equal(result.ok, false)
  assert.match(result.message, /现在没有待处理的(好友)?申请/)
  assert.equal(calls.filter((c) => /^set_/.test(c.action)).length, 0)
})
