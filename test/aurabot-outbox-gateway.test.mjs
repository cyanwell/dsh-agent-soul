// 出站口适配层（OneBot client → 进程内 outbox）的回归测试。
// ★ 只用假的 client / 假的 outbox：不连网关、不读配置、不发一条真消息。
//
// 覆盖的正是这次迁移的验收点：
//   ① client 的 start/stop/restart/state 还在（别把连接能力一起搬走）
//   ② send_group_msg / send_private_msg：chatId 与消息体原样落到 outbox.send；
//      成功 → { message_id }；失败 → 抛（上游 hub 的 catch 会 bump('errors')）
//   ③ 幂等键：默认**每次新生成**（不是内容摘要）；显式给的照用
//   ④ send_poke：群/私聊目标与 user_id 落到 outbox.poke
//   ⑤ 其余动作原样转给真 client
//   ⑥ 没有出站口 → 拒绝，绝不回落直连
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// hub 会往 dataDir 写 sessions.json / recent-media.json —— 指到临时目录，别碰真实的 aurabot 数据
process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-outbox-gw-'))

const {
  createOutboxGateway,
  outboxFromCtx,
  selectAurabotOutbox,
  AURABOT_OUTBOX_EGRESS_MODE,
  OutboxGatewayError,
  MIGRATED_ACTIONS,
  MIGRATED_OUTBOX_ACTIONS,
  ONEBOT_DEFAULT_TIMEOUT_MS,
} = await import('../src/aurabot/adapter/outbox-gateway.mjs')
const { ACT_ACTIONS } = await import('../src/adapters/outbox.mjs')

const ok = (messageId) => ({ ok: true, retcode: 0, messageId, deduped: false })
const bad = (error, retcode = null) => ({ ok: false, retcode, messageId: null, deduped: false, error })

/** 假 OneBot client：只记账，不连任何东西。 */
function fakeClient () {
  const calls = []
  const lifecycle = []
  return {
    calls,
    lifecycle,
    state: 'connected',
    call: async (action, params, opts) => {
      calls.push({ action, params, opts })
      return { from: 'client', action }
    },
    start () { lifecycle.push('start'); this.state = 'connecting' },
    stop () { lifecycle.push('stop'); this.state = 'stopped' },
    restart () { lifecycle.push('restart'); this.state = 'connecting' },
  }
}

/** 假 outbox：只记账。sendResult / pokeResult / actResult 可以是值，也可以是函数。 */
function fakeOutbox ({
  sendResult = ok(9001),
  pokeResult = { ok: true, retcode: 0, poked: '200' },
  actResult = { ok: true, retcode: 0, data: { emoji_id: 'EMOJI-1' } },
} = {}) {
  const sends = []
  const pokes = []
  const acts = []
  return {
    sends,
    pokes,
    acts,
    send: async (chatId, segments, opts) => {
      sends.push({ chatId, segments, opts })
      return typeof sendResult === 'function' ? sendResult(chatId, segments, opts) : sendResult
    },
    poke: async (chatId, userId, opts) => {
      pokes.push({ chatId, userId, opts })
      return typeof pokeResult === 'function' ? pokeResult(chatId, userId, opts) : pokeResult
    },
    act: async (action, params, opts) => {
      acts.push({ action, params, opts })
      return typeof actResult === 'function' ? actResult(action, params, opts) : actResult
    },
  }
}

/**
 * 第一~八片迁走的 act 动作（第八片之后共 19 个）+ 各自的真实调用参数（取自 Aurabot 的调用点）。
 * ★ 第六片迁走的上传那一对**单独一份**（UPLOAD_PAIR / hub 段的用例）：它们的判据不同
 *   （落点是别人的群 / 别人的私聊），混进这份「自身动作」的清单会让人以为它们是一类。
 */
const ACT_ACTION_CASES = [
  ['set_input_status', { user_id: 10001, event_type: 1 }],   // hub.js：正在输入
  ['modify_custom_face', { emoji_id: 'E-1', desc: '偷图' }],  // stickers.js：写回备注
  ['delete_custom_face', { emoji_id: 'E-2' }],               // stickers.js：从收藏里删
  ['set_self_longnick', { longNick: '签名一行' }],            // profile：改签名
  ['set_qq_profile', { nickname: '砚青' }],                   // profile：改昵称
  ['set_qq_avatar', { file: 'base64://YXZhdGFy' }],          // profile / 头像同步：换头像（base64 形态）
  ['add_custom_face', { file: 'base64://QkM=' }],             // stickers.js：收藏一张表情
  ['set_friend_add_request', { flag: 'ev-flag:abc', approve: true }],      // contacts：通过一条收到的申请
  ['set_doubt_friends_add_request', { flag: 'doubt-uid-77', approve: false }], // contacts：拒绝被过滤的申请
  ['delete_qzone_msg', { tid: 'post-77a1' }],                                 // qzone.remove()：删自己发过的一条说说
  ['set_group_special_title', { group_id: 100, user_id: 200, special_title: '头衔' }],
  ['_send_group_notice', { group_id: 100, content: '公告' }],
  ['send_qzone_msg', { content: '一条说说', ugc_right: 1 }],
  ['comment_qzone', { tid: 'post-1', content: '评论一句', target_uin: 200 }],
  ['set_group_ban', { group_id: 100, user_id: 200, duration: 600 }],            // group-admin：禁言（分钟 × 60）
  ['set_group_kick', { group_id: 100, user_id: 200, reject_add_request: false }], // group-admin：踢人
  ['like_qzone', { tid: 'post-1', target_uin: 200, abstime: 1732530000 }],      // qzone-social：点赞（说说 / 对象 / 发布时间）
]

/**
 * set_qq_avatar 的三种既有 file 形态 —— **三种都是真实调用点**，一个都不许归一。
 *   ① profile applyAvatar 的第一手 / 头像同步 handler 唯一的一手
 *   ② profile applyAvatar 的第二手（base64 被网关拒时改传本机临时文件）
 *   ③ profile 模块直接给网址那条
 * ★ 只测一种 = 只测了三分之一的迁移，而漏掉的那种失败起来像「网关说图不行」。
 */
const AVATAR_FILES = [
  'base64://iVBORw0KGgoAAAANSUhEUg',       // ① base64://
  'C:\\Users\\pc\\AppData\\Local\\Temp\\avatar-9-1.jpg', // ② 本机路径
  'https://example.invalid/avatar.png',    // ③ 网址
]

/**
 * 第六片（2026-11-24）：上传那一对 —— **只这两个名字**，参数照抄 hub.js sendFile 的真实调用：
 *   group   → { group_id: Number(id), file, name }
 *   private → { user_id: Number(id), file, name }
 * ★ file 三种既有形态都在真实路径上出现过：
 *   ① 本机绝对路径（hub 按本机路径发的第一手）
 *   ② 'base64://' + 整份内容（本机路径失败后 hub 自己改走的第二手 —— **业务回落，不是传输重试**）
 *   ③ http(s) 网址（外部地址，外部失败**不**回落 base64）
 */
const UPLOAD_PAIR = ['upload_group_file', 'upload_private_file']

/** 计数用的确定性键生成器（真实默认是 randomUUID，这里只要能看出「每次不一样」）。 */
function counterKeys () {
  let n = 0
  return () => 'k' + (++n)
}

test('迁移清单：只有这三个动作改道', () => {
  assert.deepEqual(MIGRATED_ACTIONS.slice(), ['send_group_msg', 'send_private_msg', 'send_poke'])
})

test('send_group_msg：group_id → group:<id>，消息体原样交给 outbox.send', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ sendResult: ok(12345) })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const segments = [{ type: 'text', data: { text: '早' } }, { type: 'face', data: { id: '14' } }]
  const r = await gw.call('send_group_msg', { group_id: 100, message: segments })

  assert.equal(outbox.sends.length, 1)
  assert.equal(outbox.sends[0].chatId, 'group:100')
  assert.deepEqual(outbox.sends[0].segments, segments)
  assert.deepEqual(r, { message_id: 12345 }, '成功要映射成 OneBot 的 data 形状')
  assert.equal(client.calls.length, 0, '迁移过的动作不许再打真 client')
})

test('send_private_msg：user_id → private:<id>，纯字符串正文原样传下去', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ sendResult: ok(777) })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const r = await gw.call('send_private_msg', { user_id: 200, message: 'hello' })

  assert.equal(outbox.sends[0].chatId, 'private:200')
  assert.equal(outbox.sends[0].segments, 'hello')
  assert.deepEqual(r, { message_id: 777 })
  assert.equal(client.calls.length, 0)
})

test('幂等键：默认每次新生成，绝不退化成内容摘要', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ sendResult: ok(1) })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const msg = [{ type: 'text', data: { text: '一模一样' } }]
  await gw.call('send_group_msg', { group_id: 100, message: msg })
  await gw.call('send_group_msg', { group_id: 100, message: msg })

  const [a, b] = outbox.sends.map((s) => s.opts && s.opts.idempotencyKey)
  assert.equal(a, 'k1')
  assert.equal(b, 'k2')
  assert.notEqual(a, b, '两条故意一样的话必须是两个键，否则 10 分钟内会被静默并成一条')
})

test('幂等键：调用方显式给了就照用（重试要沿用同一个键）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ sendResult: ok(2) })
  let made = 0
  const gw = createOutboxGateway({ client, outbox, newKey: () => { made++; return 'generated-' + made } })

  await gw.call('send_private_msg', { user_id: 200, message: 'x' }, { idempotencyKey: 'retry-42' })
  await gw.call('send_private_msg', { user_id: 200, message: 'x' }, { idempotencyKey: 'retry-42' })

  assert.deepEqual(outbox.sends.map((s) => s.opts.idempotencyKey), ['retry-42', 'retry-42'])
  assert.equal(made, 0, '显式给了键就不该再生成')
})

test('默认键是 UUID 形状（不注入生成器时）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ sendResult: ok(3) })
  const gw = createOutboxGateway({ client, outbox })

  await gw.call('send_group_msg', { group_id: 100, message: 'a' })
  await gw.call('send_group_msg', { group_id: 100, message: 'a' })

  const [a, b] = outbox.sends.map((s) => s.opts.idempotencyKey)
  assert.match(a, /^[0-9a-f-]{36}$/)
  assert.match(b, /^[0-9a-f-]{36}$/)
  assert.notEqual(a, b)
})

test('outbox 回 {ok:false} → 抛（上游 hub 靠这个 bump errors），且没打真 client', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ sendResult: bad('网关 502', 100) })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await assert.rejects(
    () => gw.call('send_group_msg', { group_id: 100, message: 'x' }),
    (error) => {
      assert.equal(error instanceof OutboxGatewayError, true)
      assert.equal(error.code, 'outbox-rejected')
      assert.equal(error.retcode, 100)
      assert.equal(error.action, 'send_group_msg')
      assert.equal(error.transport, false, '重试会再发一条，所以不许被当成可重连的错')
      assert.match(error.message, /网关 502/)
      return true
    },
  )
  assert.equal(client.calls.length, 0)
})

test('outbox 自己抛错 → 也变成拒绝（契约外的错不许漏成「没发也没报」）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ sendResult: () => { throw new Error('boom') } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await assert.rejects(
    () => gw.call('send_private_msg', { user_id: 200, message: 'x' }),
    (error) => error.code === 'outbox-threw' && /boom/.test(error.message),
  )
})

test('id 缺失/畸形 → 拒绝（宁可拒，也不发到错的地方）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await assert.rejects(() => gw.call('send_group_msg', { message: 'x' }), (e) => e.code === 'outbox-bad-target')
  await assert.rejects(() => gw.call('send_private_msg', { user_id: ' 20 0 ', message: 'x' }), (e) => e.code === 'outbox-bad-target')
  await assert.rejects(() => gw.call('send_group_msg', { group_id: 100 }), (e) => e.code === 'outbox-empty')
  assert.equal(outbox.sends.length, 0)
  assert.equal(client.calls.length, 0)
})

test('send_poke：群 → group:<gid> + user_id', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const r = await gw.call('send_poke', { user_id: 200, group_id: 100 }, { timeoutMs: 10000 })

  assert.equal(outbox.pokes.length, 1)
  assert.equal(outbox.pokes[0].chatId, 'group:100')
  assert.equal(outbox.pokes[0].userId, 200)
  assert.equal(outbox.pokes[0].opts.timeoutMs, 10000, 'hub 给的 10s 要原样透传')
  assert.deepEqual(r, { ok: true })
  assert.equal(client.calls.length, 0)
})

test('send_poke：私聊 → private:<id> + user_id', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await gw.call('send_poke', { user_id: 200 })

  assert.equal(outbox.pokes.length, 1)
  assert.equal(outbox.pokes[0].chatId, 'private:200')
  assert.equal(outbox.pokes[0].userId, 200)
  assert.equal(client.calls.length, 0)
})

test('send_poke 失败 → 抛', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ pokeResult: { ok: false, error: '没有可戳的 user_id' } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await assert.rejects(
    () => gw.call('send_poke', { user_id: 200 }),
    (e) => e.code === 'outbox-rejected' && e.action === 'send_poke',
  )
})

test('没有出站口：三个迁移动作全部拒绝，一次都不许打真 client', async () => {
  const client = fakeClient()
  const gw = createOutboxGateway({ client, outbox: null, getOutbox: () => null, newKey: counterKeys() })

  for (const [action, params] of [
    ['send_group_msg', { group_id: 100, message: 'x' }],
    ['send_private_msg', { user_id: 200, message: 'x' }],
    ['send_poke', { user_id: 200 }],
  ]) {
    await assert.rejects(
      () => gw.call(action, params),
      (e) => e.code === 'outbox-unavailable' && /不回落/.test(e.message),
      action + ' 没有出站口时必须拒绝',
    )
  }
  assert.equal(client.calls.length, 0, '没有回落到 OneBot client')
})

test('其余动作原样转给真 client（params / opts / 返回值都不改）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const params = { group_id: 100, no_cache: true }
  const opts = { timeoutMs: 8000, retries: 0 }
  const r = await gw.call('get_group_member_list', params, opts)

  assert.deepEqual(client.calls, [{ action: 'get_group_member_list', params, opts }])
  assert.deepEqual(r, { from: 'client', action: 'get_group_member_list' })
  assert.equal(outbox.sends.length, 0)
  assert.equal(outbox.pokes.length, 0)
})

test('client 的 start/stop/restart/state 还在（连接能力没被搬走）', () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox })

  gw.start()
  gw.restart()
  gw.stop()
  assert.deepEqual(client.lifecycle, ['start', 'restart', 'stop'])
  assert.equal(gw.state, 'stopped')
  assert.equal(gw.state, client.state)
})

test('outboxFromCtx：get / 属性 / 都没有 / get 抛错', () => {
  const ob = fakeOutbox()
  assert.equal(outboxFromCtx({ get: (n) => (n === 'outbox' ? ob : undefined) }), ob)
  assert.equal(outboxFromCtx({ outbox: ob }), ob)
  assert.equal(outboxFromCtx({}), null)
  assert.equal(outboxFromCtx(null), null)
  assert.equal(outboxFromCtx({ get () { throw new Error('service not found') } }), null)
})

test('getOutbox 晚绑定：晚一步就位的出站口也能用上', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ sendResult: ok(5) })
  let current = null
  const gw = createOutboxGateway({ client, getOutbox: () => current, newKey: counterKeys() })

  await assert.rejects(() => gw.call('send_group_msg', { group_id: 100, message: 'x' }), (e) => e.code === 'outbox-unavailable')

  current = outbox
  const r = await gw.call('send_group_msg', { group_id: 100, message: 'x' })
  assert.deepEqual(r, { message_id: 5 })
})

// ────────────────────────────────────────────────────────────────────────────
// 接进 hub 之后的行为：**hub 原有的三道闸（capture / 总开关 / 试运行）必须仍然在上游。**
// 这里不测 hub 的完整逻辑，只测「闸开 → 落到 outbox」「闸关 → 一条都不发」「失败 → 计 errors」。
// ────────────────────────────────────────────────────────────────────────────
const { createHub } = await import('../src/aurabot/src/chat/hub.js')

const quietLog = () => new Proxy({}, { get: () => () => {} })
const fakeStickers = () => ({ enabled: false, match: () => null, pickForReply: () => null, segmentFor: () => null, marked: [], markUsed () {}, collect: async () => ({ ok: false }) })

function hubConfig (over = {}) {
  return {
    enabled: true,
    dryRun: false,
    ownerQQ: '10001',
    ownerName: '主人',
    botQQ: '20002',
    workspaceDir: join(process.env.AURABOT_DATA_DIR, 'ws'),
    merge: { enabled: false, waitSec: 1, maxSec: 2, groupWaitSec: 1, groupMaxSec: 2 },
    voice: { enabled: false, asr: false, autoChance: 0, autoMaxChars: 60 },
    stickers: { enabled: false, faces: false, collect: false, autoChance: 0, fromGroups: false, fromPrivate: false },
    model: {},
    group: {},
    files: { enabled: false, dirs: [] },
    ...over,
  }
}

/** hub 只用到 dsh.agents.get / get() / workspaceRegistry —— 给最小的假宿主。 */
function hubWith (config, gateway) {
  const registry = { list: async () => [{ id: 'ws-1', path: config.workspaceDir }], create: async () => ({ id: 'ws-1' }), archivedSessionIds: [] }
  const dsh = {
    agents: { get: () => null },
    get: (name) => (name === 'workspaceRegistry' ? registry : null),
    workspaceRegistry: registry,
  }
  return createHub({
    dsh,
    getConfig: () => config,
    log: quietLog(),
    onebot: gateway,
    stickers: fakeStickers(),
    tts: { speak: async () => { throw new Error('测试里不走语音') } },
    buildTools: () => [],
  })
}

test('hub 接上适配层：发成功 → 落到 outbox、message_id 回传、sent 计数 +1', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ sendResult: ok(4242) })
  const hub = hubWith(hubConfig(), createOutboxGateway({ client, outbox }))
  try {
    const r = await hub.sendText('private:200', '你好')
    assert.deepEqual(r, { message_id: 4242 })
    assert.equal(outbox.sends.length, 1)
    assert.equal(outbox.sends[0].chatId, 'private:200')
    assert.equal(hub.stats().sent, 1)
    assert.equal(client.calls.filter((c) => c.action === 'send_private_msg').length, 0, '迁移过的动作不许再打真 client')
  } finally { hub.disposeRecentMedia() }
})

test('hub 接上适配层：outbox 失败 → sendText 回 null、errors +1、也没打真 client', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ sendResult: bad('网关挂了') })
  const hub = hubWith(hubConfig(), createOutboxGateway({ client, outbox }))
  try {
    const r = await hub.sendText('private:200', '你好')
    assert.equal(r, null)
    assert.equal(hub.stats().errors, 1, '失败必须记在 hub 原有的 errors 计数上')
    assert.equal(client.calls.filter((c) => c.action === 'send_private_msg').length, 0)
  } finally { hub.disposeRecentMedia() }
})

for (const [label, over] of [['总开关关着', { enabled: false }], ['试运行', { dryRun: true }]]) {
  test('hub 接上适配层：' + label + ' → 根本走不到 outbox（闸还在上游）', async () => {
    const client = fakeClient()
    const outbox = fakeOutbox()
    const hub = hubWith(hubConfig(over), createOutboxGateway({ client, outbox }))
    try {
      assert.equal(await hub.sendText('private:200', '你好'), null)
      assert.equal(outbox.sends.length, 0, label + '时一条都不该发')
      assert.equal(client.calls.length, 0)
    } finally { hub.disposeRecentMedia() }
  })
}
// ────────────────────────────────────────────────────────────────────────────
// 2026-11-24：**出站口交不交给 aurabot，只由 config.events.egress.mode 决定。**
//
//   原来的缺口：createOutbox 只判 baseUrl（不判 mode），而 managed 配置强制 mode=off
//   却可能留着 httpUrl —— core 又无条件把 outbox 交给 aurabot，于是适配层拿得到出站口，
//   **mode=off 照样发得出去**。「关着」和「能发」同时成立，是这组测试要钉死的事。
//
//   ★ 这里**不起 core-entry**：判据被收成一个纯函数 selectAurabotOutbox，
//     再照 core 的做法装配一遍（选择 → ctx.services → outboxFromCtx → 网关）。
// ────────────────────────────────────────────────────────────────────────────

/** 一个「完全可用」的假出站口：连 baseUrl 都配了 —— 但 mode 不认时它一个字节都不该收到。 */
function configuredOutbox (opts = {}) {
  return Object.assign(fakeOutbox(opts), { baseUrl: 'http://fake-gateway.invalid:1', configured: true })
}

/** 照 core-entry 的装配方式造一个 aurabot ctx：services.outbox 只放「选出来的那个」。 */
function ctxAsCoreWouldWire (mode, outbox) {
  const wired = selectAurabotOutbox(mode, outbox)
  const services = { outbox: wired }
  // ctx.mjs 会把 services 摊到 ctx 上（只补 ctx 上没有的键），所以 ctx.outbox 也要有
  return { get: (n) => services[n], outbox: wired }
}

function gatewayAsCoreWouldWire (mode, outbox) {
  const client = fakeClient()
  const ctx = ctxAsCoreWouldWire(mode, outbox)
  const gw = createOutboxGateway({ client, getOutbox: () => outboxFromCtx(ctx), newKey: counterKeys() })
  return { gw, client, ctx }
}

const THREE_MIGRATED = [
  ['send_group_msg', { group_id: 100, message: 'x' }],
  ['send_private_msg', { user_id: 200, message: 'x' }],
  ['send_poke', { user_id: 200 }],
]

test('selectAurabotOutbox：只有 onebot-http 才交；off 时连已配置的 outbox 也不交', () => {
  assert.equal(AURABOT_OUTBOX_EGRESS_MODE, 'onebot-http')
  const ob = configuredOutbox()

  assert.equal(selectAurabotOutbox('onebot-http', ob), ob)
  assert.equal(selectAurabotOutbox(' onebot-http ', ob), ob, '前后空白不该被当成另一种模式')

  for (const mode of ['off', '', '   ', undefined, null, 0, false,
    'ONE BOT HTTP', 'onebot_http', 'bridge-console', 'http', 'onebot-http-v2', 'on']) {
    assert.equal(selectAurabotOutbox(mode, ob), null,
      JSON.stringify(mode) + ' 必须不交出站口（而它明明是可用的）')
  }

  assert.equal(selectAurabotOutbox('onebot-http', null), null, '模式认了但没有出站口，也不许造一个')
  assert.equal(selectAurabotOutbox('onebot-http', undefined), null)
})

test('mode=off + 已配置的 outbox：三个迁移动作全部 outbox-unavailable，一次都没发、也没回落', async () => {
  const outbox = configuredOutbox()
  const { gw, client, ctx } = gatewayAsCoreWouldWire('off', outbox)

  assert.equal(ctx.outbox, null, 'mode=off 时 ctx 上根本没有出站口')

  for (const [action, params] of THREE_MIGRATED) {
    await assert.rejects(
      () => gw.call(action, params),
      (e) => e.code === 'outbox-unavailable' && e.stage === 'outbox',
      action + ' 在 mode=off 时必须拒绝',
    )
  }
  assert.equal(outbox.sends.length, 0, 'mode=off 时一条都不许从 outbox 发出去')
  assert.equal(outbox.pokes.length, 0)
  assert.equal(client.calls.length, 0, '也不许回落到 OneBot client')
})

test('mode 缺失（managed 配置只强制关、不保证字段存在）→ 和 off 一样拒绝', async () => {
  const outbox = configuredOutbox()
  const { gw, client } = gatewayAsCoreWouldWire(undefined, outbox)

  for (const [action, params] of THREE_MIGRATED) {
    await assert.rejects(() => gw.call(action, params), (e) => e.code === 'outbox-unavailable', action)
  }
  assert.equal(outbox.sends.length + outbox.pokes.length, 0)
  assert.equal(client.calls.length, 0)
})

test('mode=onebot-http：同一个已配置的 outbox 就正常发（证明闸不是把路整个封死）', async () => {
  const outbox = configuredOutbox({ sendResult: ok(8888) })
  const { gw, client } = gatewayAsCoreWouldWire('onebot-http', outbox)

  assert.deepEqual(await gw.call('send_group_msg', { group_id: 100, message: '早' }), { message_id: 8888 })
  assert.deepEqual(await gw.call('send_poke', { user_id: 200 }), { ok: true })
  assert.equal(outbox.sends.length, 1)
  assert.equal(outbox.pokes.length, 1)
  assert.equal(client.calls.length, 0, '迁移过的动作仍然不许打真 client')
})

for (const mode of ['', 'ONE BOT HTTP', 'onebot_http', 'bridge-console', 'onebot-http-v2']) {
  test('不认的模式（' + JSON.stringify(mode) + '）→ 三个动作全拒，不回落', async () => {
    const outbox = configuredOutbox()
    const { gw, client } = gatewayAsCoreWouldWire(mode, outbox)
    for (const [action, params] of THREE_MIGRATED) {
      await assert.rejects(() => gw.call(action, params), (e) => e.code === 'outbox-unavailable', action)
    }
    assert.equal(outbox.sends.length + outbox.pokes.length, 0)
    assert.equal(client.calls.length, 0)
  })
}


// ────────────────────────────────────────────────────────────────────────────
// ⑦ 迁移兼容：**每次调用的超时必须跟着 OneBot client 走**（2026-11-24）。
//
//   缺口：适配层把 opts 留给了幂等键，timeoutMs 没传给 outbox —— 于是 hub 发消息
//   （它不传 timeoutMs）从 OneBot client 的 30s 默认掉进出站口的 8s。
//   这条不报错，只是慢一点的网关开始「发不出去」，而失败串长得像网络问题。
//
//   ★ 期望值不是抄来的数字：它必须等于 client.js 里那个默认值，测试最后一例直接读源码核对。
// ────────────────────────────────────────────────────────────────────────────

test('send：不给 opts.timeoutMs → 补成 OneBot 的 30s（不是出站口的 8s）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await gw.call('send_group_msg', { group_id: 100, message: 'x' })

  assert.equal(ONEBOT_DEFAULT_TIMEOUT_MS, 30000)
  assert.equal(outbox.sends[0].opts.timeoutMs, 30000, '默认值必须是 OneBot client 的 30s')
  assert.notEqual(outbox.sends[0].opts.timeoutMs, 8000, '不许落进出站口的 8s 默认')
})

test('send：显式 opts.timeoutMs 原样透传（调用方的时间预算不许被这层改写）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await gw.call('send_group_msg', { group_id: 100, message: 'x' }, { timeoutMs: 12000 })
  await gw.call('send_private_msg', { user_id: 200, message: 'x' }, { timeoutMs: 45000 })

  assert.deepEqual(outbox.sends.map((s) => s.opts.timeoutMs), [12000, 45000])
})

test('send：非法 timeoutMs（0 / 负数 / NaN / 空串）→ 回到 30s，不是「不超时」', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  for (const bad of [0, -1, NaN, '', 'abc', null, undefined, Infinity]) {
    await gw.call('send_group_msg', { group_id: 100, message: 'x' }, { timeoutMs: bad })
  }

  for (const s of outbox.sends) assert.equal(s.opts.timeoutMs, 30000)
  assert.equal(outbox.sends.length, 8)
})

test('send_poke：hub 的 10s 透传；不给则 30s（同样不许落进 8s）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await gw.call('send_poke', { user_id: 200, group_id: 100 }, { timeoutMs: 10000 })
  await gw.call('send_poke', { user_id: 200 })

  assert.deepEqual(outbox.pokes.map((p) => p.opts.timeoutMs), [10000, 30000])
  assert.equal(client.calls.length, 0)
})

test('ONEBOT_DEFAULT_TIMEOUT_MS 与 OneBot client 的实际默认同源（改一个不改另一个就会红）', () => {
  const src = readFileSync(new URL('../src/aurabot/src/onebot/client.js', import.meta.url), 'utf8')
  assert.match(src, /async function call\s*\(action, params = \{\}, \{ timeoutMs = 30000\b/,
    'client.js 的默认超时变了 —— 适配层的 ONEBOT_DEFAULT_TIMEOUT_MS 必须跟着变')
})

test('core-entry 的装配处：交出去的是 selectAurabotOutbox 的结果，不是裸 outbox', () => {
  const src = readFileSync(new URL('../src/core-entry.mjs', import.meta.url), 'utf8')
  assert.match(src, /import \{ selectAurabotOutbox \} from '\.\/aurabot\/adapter\/outbox-gateway\.mjs'/)
  assert.match(src, /const aurabotOutbox = selectAurabotOutbox\(_egress\.mode, outbox\)/)
  assert.match(src, /outbox: aurabotOutbox,/)
  // services 块里的条目缩进是 6 格；顶层那个 createEventsIngress 的 outbox 是 2 格，不受影响
  assert.doesNotMatch(src, /^ {6}outbox,$/m, 'services 里不许再把裸 outbox 直接交出去')
})


// ────────────────────────────────────────────────────────────────────────────
// ⑧ act 改道（2026-11-24 第二片 5 + 第三片 2 + 第四片 2 + 第五片 1 + 第六片 2 + 第七片 2 +
//    第八片 3 = 十九个动作走 outbox.act）。
//
//   验收点（每条都是「迁移后不许变」的契约）：
//   · 只有这十九个**确切名字**改道；别的（整群禁言 / 近似串 / 动作 / 泛化转发）
//     仍原样转真 client；
//   ★ 第六片把上传那一对从「别的」挪进了「这些」—— 上面那句因此不能再写「上传」，
//     否则下一个人会以为上传还在旧路上。
//   ★ 第八片把群禁言 / 踢人 / 点赞也挪了进来（用户明确授权），所以这里也不能再拿
//     set_group_ban / like_qzone 当「还在旧路」的例子。**剩下的是近似串和未知动作**。
//   · params **原样**（同一个对象）传下去，opts.timeoutMs 跟着 OneBot 的 30s 走；
//   · 成功返回 data 原件（= client 的 `return j.data`）；
//   · {ok:false} / 抛错 → OutboxGatewayError；没有出站口或出站口没有 act → 拒绝，**不回落**；
//   · 同样的动作做两次就是两次调用（没有幂等键）。
// ────────────────────────────────────────────────────────────────────────────

test('迁移的 act 集合：正好十九个（含群管理三件），且与出站口白名单同源', () => {
  assert.deepEqual(MIGRATED_OUTBOX_ACTIONS.slice(), [
    'set_input_status', 'modify_custom_face', 'delete_custom_face', 'set_self_longnick', 'set_qq_profile',
    'set_qq_avatar', 'add_custom_face',
    'set_friend_add_request', 'set_doubt_friends_add_request',
    'delete_qzone_msg',
    'upload_group_file', 'upload_private_file',
    'set_group_special_title', '_send_group_notice', 'send_qzone_msg', 'comment_qzone',
    'set_group_ban', 'set_group_kick', 'like_qzone',
  ])
  assert.deepEqual(MIGRATED_OUTBOX_ACTIONS.slice(), ACT_ACTIONS.slice(), '适配层的集合与出站口白名单必须是同一份')
  assert.deepEqual(MIGRATED_ACTIONS.slice(), ['send_group_msg', 'send_private_msg', 'send_poke'], '发送那三个不变')

  const gw = createOutboxGateway({ client: fakeClient(), outbox: fakeOutbox() })
  assert.deepEqual(gw.migratedActs, MIGRATED_OUTBOX_ACTIONS.slice(), '面板要能读出来')
assert.equal(gw.migratedActs.length, 19, '适配层改道的 act 正好 19 个（含上传 2、群头衔/公告 2、Qzone 发布/评论/点赞、群禁言/踢人）')
  // ★ 第六片：上传那一对在 / 不在，必须两头都断 —— 只断「在」的话，
  //   「多带了第三个名字」这种错读不出来；只断「不在」的话，名册里两边都有也读不出来。
  for (const name of UPLOAD_PAIR) {
    assert.equal(MIGRATED_OUTBOX_ACTIONS.includes(name), true, name + ' 必须在已迁清单里（第六片）')
    assert.equal(gw.note.includes(name), true, 'note 要写清 ' + name)
  }
  assert.equal(MIGRATED_OUTBOX_ACTIONS.includes('upload_file'), false, 'upload_file 不是 OneBot 的动作名，不许顺手加')
  assert.equal(MIGRATED_OUTBOX_ACTIONS.includes('upload_group_file_extra'), false, '近似串不许被当成白名单名字')
  for (const name of MIGRATED_OUTBOX_ACTIONS) assert.match(gw.note, new RegExp(name), 'note 里要写清 ' + name)

  // ★ 第八片（2026-11-24）：最后三个已知写动作也迁完了 —— 这份「剩余写动作」清单**空了**。
  //   留一个非空名字在这里会变成永远红的假断言；整段删掉又会让下一个人以为「没检查过」。
  //   所以保留结构、断它是空数组，并把**仍然在外面**的东西逐个点名。
  const STILL_DELEGATED_WRITES = []
  assert.equal(STILL_DELEGATED_WRITES.length, 0, '已知写动作全部迁完：剩余 0 个')
  // ★ 双向断：这三个名字必须**同时**出现在已迁清单里、并且 note 说清它们已经走 outbox。
  //   只断一头的话，「清单里两边都有」或者「迁了却没写进自述」都读不出来。
  for (const name of ['set_group_ban', 'set_group_kick', 'like_qzone']) {
    assert.equal(MIGRATED_OUTBOX_ACTIONS.includes(name), true, name + ' 已在第八片迁走')
    assert.match(gw.note, new RegExp(name), 'note 要写清 ' + name + ' 已经走 outbox')
  }
  // ★ 第四片这两个名字**必须**从待办里消失、出现在已迁里 —— 双向都要断，
  //   只断一头的话，「名单里两边都有」这种状态读不出来。
  //   ★ 第五片的 delete_qzone_msg 同样走这条双向断言（而且它是最需要断的一条：
  //     「Qzone 在清单里」和「整个 Qzone 都迁了」只差一个名字）。
  for (const name of ['set_friend_add_request', 'set_doubt_friends_add_request', 'delete_qzone_msg', 'comment_qzone']) {
    assert.equal(MIGRATED_OUTBOX_ACTIONS.includes(name), true, name + ' 必须在已迁清单里')
    assert.equal(STILL_DELEGATED_WRITES.includes(name), false, name + ' 不许还留在剩余清单里')
  }
  for (const name of UPLOAD_PAIR) {
    assert.equal(MIGRATED_OUTBOX_ACTIONS.includes(name), true, name + ' 必须在已迁清单里（第六片已迁）')
  }
  // ★★ 白名单 ≠ 所有 OneBot 写动作。这几个名字仍在外面，而且**必须一直**在外面：
  //    未知的 / 自定义的 / 第三方 facade 上的动作，靠 ACT_ACTIONS 的**逐字相等**来挡。
  //    「剩余 0 个已知写动作」这句话最容易被读歪的就是这一半。
  for (const name of ['set_group_whole_ban', 'set_group_ban_extra', 'Set_Group_Ban',
    'Like_Qzone', 'like_qzone_extra', 'send_msg', 'custom_action']) {
    assert.equal(MIGRATED_OUTBOX_ACTIONS.includes(name), false, name + ' 不许被顺手带进白名单')
  }
})

test('title/notice 路由动作名、params原样进 outbox.act，保留30s默认且不打client', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  for (const [action, params] of ACT_ACTION_CASES) {
    await gw.call(action, params)
    const rec = outbox.acts[outbox.acts.length - 1]
    assert.equal(rec.action, action, action + ' 的 action 名要原样')
    assert.equal(rec.params, params, action + ' 的 params 必须是同一个对象（不重排、不裁剪、不补默认值）')
    assert.equal(rec.opts.timeoutMs, 30000, action + ' 默认要 30s（OneBot client 的值）')
    assert.equal('idempotencyKey' in rec.opts, false, action + ' 不带幂等键（这些动作重复执行是意图）')
  }
  assert.equal(outbox.acts.length, 17, 'ACT_ACTION_CASES 这17项 = 17次 outbox.act；上传pair另有独立测试')
  assert.equal(outbox.sends.length + outbox.pokes.length, 0, '不该混进 send / poke')
  assert.equal(client.calls.length, 0, '迁移过的动作不许再打真 client')
})

test('act 成功 → 返回 outbox 给的 data 原件（与 OneBot client 的 return j.data 同形状）', async () => {
  const data = { emoji_id: 'E-77', desc: '备注一行' }
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const r = await gw.call('modify_custom_face', { emoji_id: 'E-77', desc: '备注一行' })
  assert.deepEqual(r, data, 'data 一个字都不许改（调用方靠 emoji_id 继续干活）')
  assert.equal(client.calls.length, 0)
})

test('act 成功但 data 缺失 → 返回 null（不编一个 {}）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: null } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  assert.equal(await gw.call('set_self_longnick', { longNick: '签名' }), null)
})

test('act 回 {ok:false} → 抛 OutboxGatewayError（outbox-rejected，retcode 带出），没打真 client', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: false, retcode: 100, error: '网关说没权限' } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await assert.rejects(
    () => gw.call('set_qq_profile', { nickname: '砚青' }),
    (error) => {
      assert.equal(error instanceof OutboxGatewayError, true)
      assert.equal(error.code, 'outbox-rejected')
      assert.equal(error.action, 'set_qq_profile')
      assert.equal(error.retcode, 100)
      assert.equal(error.transport, false, '重试会真的再改一次资料，不许被当成可重连的错')
      assert.match(error.message, /没权限/)
      return true
    },
  )
  assert.equal(outbox.acts.length, 1)
  assert.equal(client.calls.length, 0)
})

test('act 自己抛错 → 也变成拒绝（outbox-threw），不回落真 client', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: () => { throw new Error('boom') } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await assert.rejects(
    () => gw.call('delete_custom_face', { emoji_id: 'E-2' }),
    (error) => error.code === 'outbox-threw' && /boom/.test(error.message),
  )
  assert.equal(client.calls.length, 0)
})

test('没有出站口 / 出站口没有 act → 十九个白名单动作全拒，不打真 client', async () => {
  const client = fakeClient()
  const noOutbox = createOutboxGateway({ client, outbox: null, getOutbox: () => null, newKey: counterKeys() })
  // ★ 旧出站口（只有 send / poke，没有 act）：也算没有出站口
  const legacy = { send: async () => ok(1), poke: async () => ({ ok: true, retcode: 0 }) }
  const oldOutbox = createOutboxGateway({ client, outbox: legacy, newKey: counterKeys() })

  for (const [action, params] of ACT_ACTION_CASES) {
    await assert.rejects(
      () => noOutbox.call(action, params),
      (e) => e.code === 'outbox-unavailable' && /不回落/.test(e.message),
      action + ' 没有出站口时必须拒绝',
    )
    await assert.rejects(
      () => oldOutbox.call(action, params),
      (e) => e.code === 'outbox-unavailable' && /act/.test(e.message),
      action + ' 出站口没有 act 时必须拒绝（不许回落到 client）',
    )
  }
  assert.equal(client.calls.length, 0, '没有回落到 OneBot client')
})

test('白名单外仍是真 client：整群禁言 / 近似串 / 读动作原样转发', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  // ★ 这片故意保留旧 client 路由作为反向证据；title / notice 已移出此列表。
  //   ★ 第四片把 set_friend_add_request 从这里**移走**了 —— 它已经改道走 act，
  //     留在这份清单里这条测试会从「仍走旧 client」变成一条永远不会执行的假断言。
  //   ★ 第五片把 delete_qzone_msg 从这里**移走**了（它已经进白名单）。
  //     ★ like_qzone 仍须留在这一份里，证明只迁移了明确授权的 comment_qzone。
  //       的反向证据。Qzone 的发布和评论已迁移；点赞仍留旧路。
  // ★ 第六片把 upload_group_file / upload_private_file 从这份清单里**移走**了（它们已进白名单）。
  //   留在这里会让这条测试从「仍走旧 client」变成一条永远绿的假断言。
  // ★ 第八片（2026-11-24）把 set_group_ban / set_group_kick / like_qzone 也**移走**了。
  //   现在这份清单里只剩「本来就不该进白名单」的东西 —— 整群禁言、近似串、读动作。
  //   这才是这条测试真正要保的那一半：**名单之外的一切仍然直达 client**。
  const delegated = [
    ['set_group_whole_ban', { group_id: 100, enable: true }],
    ['set_group_ban_extra', { group_id: 100, user_id: 200, duration: 600 }],
    ['Set_Group_Ban', { group_id: 100, user_id: 200, duration: 600 }],
    ['Like_Qzone', { tid: 'post-1' }],
    ['like_qzone_extra', { tid: 'post-1' }],
    ['get_qzone_list', {}],
  ]
  for (const [action, params] of delegated) await gw.call(action, params)

  assert.deepEqual(client.calls.map((c) => c.action), delegated.map(([a]) => a))
  assert.equal(outbox.acts.length, 0, '这些一个都不许进 act（白名单外）')
  assert.equal(outbox.sends.length + outbox.pokes.length, 0)
})

test('ban/unban/kick/like go through ACT with exact params and caller timeouts', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })
  const routes = [
    { action: 'set_group_ban', params: { group_id: 100, user_id: 200, duration: 600 }, opts: { timeoutMs: 8000 } },
    { action: 'set_group_ban', params: { group_id: 100, user_id: 200, duration: 0 }, opts: { timeoutMs: 8000 } },
    { action: 'set_group_kick', params: { group_id: 100, user_id: 200, reject_add_request: false }, opts: { timeoutMs: 9000 } },
    { action: 'like_qzone', params: { tid: 'post-1', target_uin: 200, abstime: 1732530000 }, opts: { timeoutMs: 20000 } },
  ]
  for (const route of routes) {
    await gw.call(route.action, route.params, route.opts)
    const rec = outbox.acts[outbox.acts.length - 1]
    assert.equal(rec.action, route.action)
    assert.equal(rec.params, route.params, '同一个params对象原样交出')
    assert.equal(rec.opts.timeoutMs, route.opts.timeoutMs, '显式调用timeout原样保留')
    assert.equal('idempotencyKey' in rec.opts, false)
  }
  assert.equal(outbox.acts.length, routes.length)
  assert.equal(client.calls.length, 0, '迁移动作不许回落真client')
})

test('act 的超时：默认 30s、显式 15s（模块改资料那处）照用、坏值回到 30s', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await gw.call('set_qq_profile', { nickname: '砚青' })                                  // 不给 → 30s
  await gw.call('set_self_longnick', { longNick: '签名' }, { timeoutMs: 15000 })          // 模块给 15s
  await gw.call('set_input_status', { user_id: 10001, event_type: 1 }, { timeoutMs: 5000 }) // hub 给 5s
  for (const bad of [0, -1, NaN, '', 'abc', Infinity]) {
    await gw.call('delete_custom_face', { emoji_id: 'E-2' }, { timeoutMs: bad })          // 坏值 → 30s
  }

  assert.deepEqual(outbox.acts.map((a) => a.opts.timeoutMs), [
    30000, 15000, 5000, 30000, 30000, 30000, 30000, 30000, 30000,
  ])
  assert.equal(outbox.acts.length, 9, '这一条只做 3 + 6 次调用；ACT_ACTION_CASES 的十七项在别的测试里')
  assert.equal(client.calls.length, 0)
})

test('重复同样的资料动作 → 两次 outbox.act（没有幂等键，不会被并成一次）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const params = { longNick: '同一句签名' }
  await gw.call('set_self_longnick', params)
  await gw.call('set_self_longnick', params)

  assert.equal(outbox.acts.length, 2, '改两次签名就是两次动作')
  assert.equal('idempotencyKey' in outbox.acts[1].opts, false)
  assert.equal(outbox.sends.length, 0)
  assert.equal(client.calls.length, 0)
})

test('mode=off + 已配置的 outbox：十九个 act 全拒（outbox-unavailable），acts=0、client=0', async () => {
  const outbox = configuredOutbox()
  const { gw, client, ctx } = gatewayAsCoreWouldWire('off', outbox)

  assert.equal(ctx.outbox, null, 'mode=off 时 ctx 上根本没有出站口')
  for (const [action, params] of [...ACT_ACTION_CASES,
    ['upload_group_file', { group_id: 100, file: 'C:\\tmp\\a.pdf', name: 'a.pdf' }],
    ['upload_private_file', { user_id: 200, file: 'base64://QkM=', name: 'a.pdf' }],
  ]) {
    await assert.rejects(
      () => gw.call(action, params),
      (e) => e.code === 'outbox-unavailable' && e.stage === 'outbox',
      action + ' 在 mode=off 时必须拒绝',
    )
  }
  assert.equal(outbox.acts.length, 0, 'mode=off 时一个动作都不许从 outbox 出去')
  assert.equal(client.calls.length, 0, '也不许回落到 OneBot client')
})

test('mode=onebot-http：自身动作都正常走 outbox.act（闸没把路封死）', async () => {
  const outbox = configuredOutbox({ actResult: { ok: true, retcode: 0, data: { emoji_id: 'E-5' } } })
  const { gw, client } = gatewayAsCoreWouldWire('onebot-http', outbox)

  assert.deepEqual(await gw.call('modify_custom_face', { emoji_id: 'E-5' }), { emoji_id: 'E-5' })
  assert.deepEqual(await gw.call('set_qq_profile', { nickname: '砚青' }), { emoji_id: 'E-5' })
  // ★ add_custom_face 的成功形状就是 data.emoji_id —— 网关回什么就交回什么
  assert.deepEqual(await gw.call('add_custom_face', { file: 'base64://QkM=' }), { emoji_id: 'E-5' })
  assert.equal(outbox.acts.length, 3)
  assert.equal(client.calls.length, 0, '迁移过的动作仍然不许打真 client')
})

// ── 第三片（2026-11-24）：头像三种形态 + 收藏表情的 emoji_id ───────────────────
test('set_qq_avatar：三种 file 形态（base64 / 本机路径 / 网址）原样落到 outbox.act，一个字符都不改', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: null } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  for (const file of AVATAR_FILES) {
    await gw.call('set_qq_avatar', { file }, { timeoutMs: 30000 })
    const rec = outbox.acts[outbox.acts.length - 1]
    assert.equal(rec.action, 'set_qq_avatar')
    assert.deepEqual(rec.params, { file }, file + ' 的形态不许被归一 / 裁剪 / 改写')
    assert.equal(rec.params.file, file, 'file 逐字相同')
    assert.equal(rec.opts.timeoutMs, 30000, 'profile 那两处显式给 30s，没给的也落在 30s')
    assert.equal('idempotencyKey' in rec.opts, false, '换头像不挂幂等键')
  }
  assert.equal(outbox.acts.length, 3)
  assert.equal(client.calls.length, 0, '换头像不许打真 client')
})

test('set_qq_avatar：不带 opts 时默认 30s；显式 15s 之类的预算照用', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: null } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await gw.call('set_qq_avatar', { file: AVATAR_FILES[0] })                          // 头像同步 handler：没传
  await gw.call('set_qq_avatar', { file: AVATAR_FILES[2] }, { timeoutMs: 12000 })    // 显式 12s

  assert.deepEqual(outbox.acts.map((a) => a.opts.timeoutMs), [30000, 12000])
  assert.equal(client.calls.length, 0)
})

test('add_custom_face：data.emoji_id 原样交回（调用方拿它去写备注 / 记本地库）', async () => {
  const data = { emoji_id: 'EMOJI-31337', package_id: 7, key: 'k' }
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const r = await gw.call('add_custom_face', { file: 'base64://' + 'QkM=' })

  assert.deepEqual(r, data, 'data 一个字都不许改')
  assert.equal(r.emoji_id, 'EMOJI-31337', 'stickers.js 的 item.emojiId 就是从这里来的')
  assert.deepEqual(outbox.acts[0].params, { file: 'base64://QkM=' }, '请求体原样')
  assert.equal(client.calls.length, 0)
})

test('add_custom_face 回 {ok:false} → 抛（stickers.js 会 catch 并只 warn），没打真 client', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: false, retcode: 100, error: '收藏满了' } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await assert.rejects(
    () => gw.call('add_custom_face', { file: 'base64://QkM=' }),
    (error) => {
      assert.equal(error.code, 'outbox-rejected')
      assert.equal(error.action, 'add_custom_face')
      assert.equal(error.retcode, 100)
      assert.match(error.message, /收藏满了/)
      return true
    },
  )
  assert.equal(client.calls.length, 0)
})

test('add_custom_face：成功但 data 缺 emoji_id → 原样返回那个 data（不编一个 id）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: {} } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  assert.deepEqual(await gw.call('add_custom_face', { file: 'base64://QkM=' }), {},
    '网关没给 emoji_id 就是没给 —— 调用方 String(r?.emoji_id || "") 会得到空串，那是真话')
})

test('同一张头像换两次 / 同一张表情加两次 → 四次 outbox.act（无幂等键）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: { emoji_id: 'E-SAME' } } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const file = 'base64://SAME'
  await gw.call('set_qq_avatar', { file })
  await gw.call('set_qq_avatar', { file })
  await gw.call('add_custom_face', { file })
  await gw.call('add_custom_face', { file })

  assert.equal(outbox.acts.length, 4, '四次调用就是四次动作（重复是意图，不是事故）')
  for (const rec of outbox.acts) assert.equal('idempotencyKey' in rec.opts, false)
  assert.equal(outbox.sends.length, 0)
  assert.equal(client.calls.length, 0)
})
// ────────────────────────────────────────────────────────────────────────────
// ⑨ 第四片（2026-11-24）：好友申请审批的两个名字走 act 时的**适配层契约**。
//
//   验收点：
//   · 两个确切的动作名各自路由到 outbox.act（不多不少），没有第三个名字被带上；
//   · { flag, approve } **同一个对象**原样交出（不 trim、不 Boolean()、不重排）；
//   · timeoutMs 15000（contacts/index.js 显式给的那个）原样到 outbox.act；
//   · 成功 → 交回 outbox 的 data 原件（contacts 不读它，但**也不许编字段**）；
//   · 失败 → OutboxGatewayError（outbox-rejected，不标 transport —— 重试会真的再批一次）；
//   · 同一条申请两次 = 两次 outbox.act（没有幂等键）；
//   · mode=off / 没有出站口 → 拒绝，**一次都不许回落真 client**；
//   · set_group_ban / upload_* 仍然 old-client 兜底（这片只开这两个名字）。
// ────────────────────────────────────────────────────────────────────────────

/**
 * flag 的几种真实形态（逐字比对）—— 事件来的、doubt 列表回的 uid、带空格的、大小写混的。
 * ★ 这一层是**网关适配**：连 `text()` 那种 trim 都不许套到 flag 上 ——
 *   trim 过的 flag 指的就是另一条申请，而失败会长成「网关说 flag 无效」。
 */
const APPROVAL_CASES = [
  ['set_friend_add_request', 'flag:9f2e1c-add-friend-request', true],
  ['set_friend_add_request', '1234567890', false],
  ['set_doubt_friends_add_request', 'doubt-uid-77', true],
  ['set_doubt_friends_add_request', ' MixedCaseFlag-AbC123 ', false],
]

test('好友申请：两个动作名各自路由到 outbox.act，{ flag, approve } 同一个对象原样交出', async () => {
  for (const [action, flag, approve] of APPROVAL_CASES) {
    const client = fakeClient()
    const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: null } })
    const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

    const params = Object.freeze({ flag, approve })
    await gw.call(action, params, { timeoutMs: 15000 })

    assert.equal(outbox.acts.length, 1, action + ' 只该有一次 outbox.act')
    const rec = outbox.acts[0]
    assert.equal(rec.action, action, '动作名原样（两个名字不许互相串）')
    assert.equal(rec.params, params, action + ' 的 params 必须是**同一个对象**（不重排、不裁剪、不补默认值）')
    assert.equal(rec.params.flag, flag, 'flag 逐字相同（连前后空格都保留：' + JSON.stringify(flag) + '）')
    assert.equal(rec.params.approve, approve, 'approve 保持布尔')
    assert.equal(typeof rec.params.approve, 'boolean', 'approve 的类型也是契约')
    assert.equal(rec.opts.timeoutMs, 15000, 'contacts 显式给的 15s 必须原样到出站口')
    assert.equal('idempotencyKey' in rec.opts, false, action + ' 不带幂等键（审批不挂摘要去重）')
    assert.equal(client.calls.length, 0, '迁移过的动作不许再打真 client')
  }
})

test('好友申请：set_friend_add_request 与 set_doubt_friends_add_request 是两个独立动作（不合并、不别名）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: null } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await gw.call('set_friend_add_request', { flag: 'event-flag', approve: true }, { timeoutMs: 15000 })
  await gw.call('set_doubt_friends_add_request', { flag: 'doubt-uid', approve: true }, { timeoutMs: 15000 })

  assert.deepEqual(outbox.acts.map((a) => a.action), ['set_friend_add_request', 'set_doubt_friends_add_request'],
    '两个动作各走各的 —— 事件来的申请与被 QQ 过滤的申请必须分开报（混成一个网关就拒）')
  assert.deepEqual(outbox.acts.map((a) => a.params.flag), ['event-flag', 'doubt-uid'])
  assert.equal(outbox.acts.length, 2, '这片只加了这两个名字，第三个名字出现就说明名单宽度变了')
  assert.equal(outbox.sends.length + outbox.pokes.length, 0)
  assert.equal(client.calls.length, 0)
})

test('好友申请：成功时返回 outbox 的 data 原件（contacts 不读它，但这一层也不许编字段）', async () => {
  const data = { ok: true, user_id: 12345 }
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const r = await gw.call('set_friend_add_request', { flag: 'f-1', approve: true }, { timeoutMs: 15000 })
  assert.deepEqual(r, data, '网关给什么就交回什么（与 client 的 return j.data 同形状）')
  assert.equal(client.calls.length, 0)
})

test('好友申请：data 缺失 → 返回 null（不编一个 { ok:true }）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: null } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  assert.equal(await gw.call('set_doubt_friends_add_request', { flag: 'd-1', approve: false }), null)
})

test('好友申请：outbox 回 {ok:false} → 抛 OutboxGatewayError（outbox-rejected，transport=false）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: false, retcode: 102, error: 'flag 无效或已处理' } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await assert.rejects(
    () => gw.call('set_friend_add_request', { flag: 'bad-flag', approve: true }, { timeoutMs: 15000 }),
    (error) => {
      assert.equal(error instanceof OutboxGatewayError, true)
      assert.equal(error.code, 'outbox-rejected')
      assert.equal(error.action, 'set_friend_add_request')
      assert.equal(error.retcode, 102)
      assert.equal(error.transport, false, '重试会真的再批一次，不许被当成「可重连再试」')
      assert.match(error.message, /flag/)
      return true
    },
  )
  assert.equal(outbox.acts.length, 1)
  assert.equal(client.calls.length, 0)
})

test('好友申请：outbox.act 自己抛错 → 也变成拒绝（outbox-threw），不回落真 client', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: () => { throw new Error('boom') } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await assert.rejects(
    () => gw.call('set_doubt_friends_add_request', { flag: 'f-1', approve: false }, { timeoutMs: 15000 }),
    (error) => error.code === 'outbox-threw' && /boom/.test(error.message),
  )
  assert.equal(client.calls.length, 0)
})

test('好友申请：同一条申请连做两次 = 两次 outbox.act（去重会让「第二次被静默吞掉」变成可能）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: null } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const params = { flag: 'same-flag-abc', approve: true }
  await gw.call('set_friend_add_request', params, { timeoutMs: 15000 })
  await gw.call('set_friend_add_request', params, { timeoutMs: 15000 })

  assert.equal(outbox.acts.length, 2, '两次调用就是两次动作')
  for (const rec of outbox.acts) assert.equal('idempotencyKey' in rec.opts, false)
  assert.deepEqual(outbox.acts.map((a) => a.params.flag), ['same-flag-abc', 'same-flag-abc'])
  assert.equal(client.calls.length, 0)
})

test('好友申请：mode=off → 两个名字全拒，acts=0、client=0（没有回落）', async () => {
  const outbox = configuredOutbox()
  const { gw, client, ctx } = gatewayAsCoreWouldWire('off', outbox)

  assert.equal(ctx.outbox, null, 'mode=off 时 ctx 上根本没有出站口')
  for (const action of ['set_friend_add_request', 'set_doubt_friends_add_request']) {
    await assert.rejects(
      () => gw.call(action, { flag: 'f-1', approve: true }, { timeoutMs: 15000 }),
      (e) => e.code === 'outbox-unavailable' && e.stage === 'outbox',
      action + ' 在 mode=off 时必须拒绝',
    )
  }
  assert.equal(outbox.acts.length, 0, 'mode=off 时一个动作都不许从 outbox 出去')
  assert.equal(client.calls.length, 0, '也不许回落到 OneBot client')
})

test('好友申请：mode=onebot-http → 两个名字都正常走 outbox.act（闸没把路封死）', async () => {
  const outbox = configuredOutbox({ actResult: { ok: true, retcode: 0, data: null } })
  const { gw, client } = gatewayAsCoreWouldWire('onebot-http', outbox)

  await gw.call('set_friend_add_request', { flag: 'f-1', approve: true }, { timeoutMs: 15000 })
  await gw.call('set_doubt_friends_add_request', { flag: 'd-1', approve: false }, { timeoutMs: 15000 })

  assert.equal(outbox.acts.length, 2)
  assert.deepEqual(outbox.acts.map((a) => a.opts.timeoutMs), [15000, 15000])
  assert.equal(client.calls.length, 0)
})

test('好友申请：不给 timeoutMs → 30s（client 默认），显式 15s 照用，坏值回 30s', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: null } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  await gw.call('set_friend_add_request', { flag: 'a', approve: true })
  await gw.call('set_friend_add_request', { flag: 'b', approve: true }, { timeoutMs: 15000 })
  for (const bad of [0, -1, NaN, '', 'abc', Infinity]) {
    await gw.call('set_doubt_friends_add_request', { flag: 'c', approve: false }, { timeoutMs: bad })
  }

  assert.deepEqual(outbox.acts.map((a) => a.opts.timeoutMs), [
    30000, 15000, 30000, 30000, 30000, 30000, 30000, 30000,
  ])
  assert.equal(client.calls.length, 0)
})

test('set_group_ban / set_group_kick / like_qzone 三项都走 outbox.act（不再 old-client 兜底）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const migratedWrites = [
    ['set_group_ban', { group_id: 100, user_id: 200, duration: 600 }],
    ['set_group_kick', { group_id: 100, user_id: 200, reject_add_request: false }],
    ['like_qzone', { tid: 'post-1', target_uin: 200, abstime: 1732530000 }],
  ]
  for (const [action, params] of migratedWrites) await gw.call(action, params)

  assert.deepEqual(outbox.acts.map((a) => a.action), migratedWrites.map(([a]) => a), '三个都该改道走 act')
  assert.deepEqual(outbox.acts.map((a) => a.params), migratedWrites.map(([, p]) => p), '参数原样（同一个对象）')
  assert.equal(outbox.acts.every((a) => a.opts.timeoutMs === 30000), true, '不给 timeoutMs → 30s（client 默认）')
  assert.equal(outbox.acts.every((a) => !('idempotencyKey' in a.opts)), true, '这三件都不挂幂等键')
  assert.equal(client.calls.length, 0, '一个都不许再打真 client')
  assert.equal(outbox.sends.length + outbox.pokes.length, 0)
})

test('好友申请：反向证据 —— 名字只差一点（复数 / 大小写 / 后缀）仍 old-client，不会误撞进 act', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const nearMisses = [
    ['set_friends_add_request', { flag: 'f', approve: true }],
    ['set_doubt_friend_add_request', { flag: 'f', approve: true }],
    ['SET_FRIEND_ADD_REQUEST', { flag: 'f', approve: true }],
    ['set_friend_add_request_extra', { flag: 'f', approve: true }],
    // ★ 第六片：上传的近似串同样一个都不许被当成白名单名字
    ['upload_file', { group_id: 100, file: 'a.txt' }],
    ['Upload_Group_File', { group_id: 100, file: 'a.txt' }],
    ['upload_group_file_extra', { group_id: 100, file: 'a.txt' }],
    ['upload_private_file_v2', { user_id: 200, file: 'b.txt' }],
    // ★ 第八片：群禁言 / 踢人 / 点赞的近似串同样一个都不许被当成白名单名字
    ['set_group_ban_extra', { group_id: 100, user_id: 200, duration: 600 }],
    ['Set_Group_Ban', { group_id: 100, user_id: 200, duration: 600 }],
    ['set_group_bans', { group_id: 100, user_id: 200, duration: 600 }],
    ['set_group_kick_v2', { group_id: 100, user_id: 200 }],
    ['Like_Qzone', { tid: 'post-1' }],
    ['like_qzone_extra', { tid: 'post-1' }],
    ['like_qzone_msg', { tid: 'post-1' }],
  ]
  for (const [action, params] of nearMisses) await gw.call(action, params)

  assert.equal(outbox.acts.length, 0, '近似串一个都不许被当成白名单里的那两个名字')
  assert.deepEqual(client.calls.map((c) => c.action), nearMisses.map(([a]) => a))
})


// ────────────────────────────────────────────────────────────────────────────
// ⑨ 第六片（2026-11-24）：上传那一对 —— **hub.sendFile 的语义一个字都不许变**。
//
//   这一组全部走「真 hub + 假 outbox + 假 client」：不连网关、不读部署配置、不发一个字节。
//   要钉死的是六件事，每一条都是「迁移后最容易悄悄变坏」的那种：
//     ① 私聊 / 群各自打自己的动作名，params 就是 { user_id|group_id, file, name }；
//     ② 每次传输都用 timeoutMs=120000（FILE_TIMEOUT_MS），不是 30s；
//     ③ 本机路径失败 → hub **自己**再发一次 base64（两次 hub 调用、两次传输、**零**传输层重试）；
//     ④ 外部网址失败 → **不**回落 base64（外部地址本来就不需要 base64 那一手）；
//     ⑤ file 超过 min(30MB, maxMB) → **不**回落 base64，失败语义保持 hub 原文；
//     ⑥ files.enabled / 总开关 / 试运行 / 允许目录 / 大小上限 全部仍在 outbox **之前**。
// ────────────────────────────────────────────────────────────────────────────

const { mkdirSync, writeFileSync: writeTmpFile } = await import('node:fs')

/** hub 的发文件需要 files.enabled + 一个真的文件；文件都建在 AURABOT_DATA_DIR 下的临时工作区。 */
function fileWorkspace () {
  const ws = join(process.env.AURABOT_DATA_DIR, 'ws')
  mkdirSync(ws, { recursive: true })
  return ws
}

function writeFileAt (dir, name, bytes = 16) {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeTmpFile(p, Buffer.alloc(bytes, 'A'))
  return p
}

/** files 配置：enabled + 明确的 maxMB（默认 50，与 hub 的 `|| 50` 同值）。 */
function filesConfig (over = {}) {
  const ws = fileWorkspace()
  return { ws, cfg: hubConfig({ workspaceDir: ws, files: { enabled: true, dirs: [], maxMB: 50, ...over } }) }
}

test('上传：私聊 / 群各打自己的动作名，params 是 { user_id|group_id, file, name }，超时 120000', async () => {
  const { cfg, ws } = filesConfig()
  const local = writeFileAt(ws, 'report.pdf', 32)
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: {} } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })
  const hub = hubWith(cfg, gw)
  try {
    const r1 = await hub.sendFile('private:200', local, 'report.pdf')
    const r2 = await hub.sendFile('group:100', local, 'report.pdf')

    assert.deepEqual(r1, {}, '成功时 hub 把网关 data 原样交回')
    assert.deepEqual(r2, {})
    assert.deepEqual(outbox.acts.map((a) => a.action), ['upload_private_file', 'upload_group_file'],
      '私聊 / 群是两个不同的动作（打错类型不会报错，只会传到错的地方）')
    assert.deepEqual(outbox.acts[0].params, { user_id: 200, file: local, name: 'report.pdf' })
    assert.deepEqual(outbox.acts[1].params, { group_id: 100, file: local, name: 'report.pdf' })
    assert.deepEqual(outbox.acts.map((a) => a.opts.timeoutMs), [120000, 120000],
      '每次上传都用 hub 的 FILE_TIMEOUT_MS=120000（不是 30s 默认）')
    for (const a of outbox.acts) assert.equal('idempotencyKey' in a.opts, false, '上传不挂幂等键')
    assert.equal(client.calls.length, 0, '迁移过的动作不许再打真 client')
    assert.equal(hub.stats().sent, 2)
  } finally { hub.disposeRecentMedia() }
})

test('上传：本机路径失败 → hub 自己改走 base64，**正好两次**传输，且传输层一次都没重试', async () => {
  const { cfg, ws } = filesConfig()
  const local = writeFileAt(ws, 'small.txt', 64)
  const client = fakeClient()
  let attempts = 0
  // ★ 第一次（本机路径）失败，第二次（base64）成功 —— 这就是远程 / 容器网关的真实样子。
  const outbox = fakeOutbox({
    actResult: (action, params) => {
      attempts += 1
      return params.file.startsWith('base64://')
        ? { ok: true, retcode: 0, data: { file_id: 'F-1' } }
        : { ok: false, retcode: 1200, error: '网关看不到这个路径' }
    },
  })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })
  const hub = hubWith(cfg, gw)
  try {
    const r = await hub.sendFile('group:100', local, 'small.txt')

    assert.equal(outbox.acts.length, 2, '★ 回落是**两次 hub 调用**（不是传输层重试）')
    assert.equal(outbox.acts[0].params.file, local, '第一次是本机路径，逐字')
    assert.match(outbox.acts[1].params.file, /^base64:\/\/[A-Za-z0-9+/=]+$/, '第二次是 base64://<内容>')
    assert.equal(outbox.acts[1].params.name, 'small.txt', '两次的 name 都是同一个')
    assert.deepEqual(outbox.acts.map((a) => a.opts.timeoutMs), [120000, 120000], '两次都给 120000')
    assert.equal(attempts, 2, '每一次 outbox.act 只对应一次传输（传输层不许自己再试）')
    assert.equal(client.calls.length, 0)
    assert.equal(hub.stats().sent, 1, '只有成功的那一次计 sent')
    assert.equal(hub.stats().errors, 0, '落了 base64 就不算错')
    assert.deepEqual(r, { file_id: 'F-1' }, '回落成功时返回第二次的 data 原件')
  } finally { hub.disposeRecentMedia() }
})

test('上传：外部网址失败 → **不**回落 base64（外部地址不需要那一手），错误照 hub 原文抛出', async () => {
  const { cfg } = filesConfig()
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: false, retcode: 1200, error: '下载失败' } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })
  const hub = hubWith(cfg, gw)
  try {
    await assert.rejects(
      () => hub.sendFile('private:200', 'https://example.invalid/big.zip', 'big.zip'),
      (e) => /发文件失败：/.test(e.message) && /下载失败/.test(e.message),
    )
    assert.equal(outbox.acts.length, 1, '外部地址失败只发一次，不许回落 base64')
    assert.equal(outbox.acts[0].params.file, 'https://example.invalid/big.zip', '网址逐字')
    assert.equal(outbox.acts[0].opts.timeoutMs, 120000)
    assert.equal(hub.stats().errors, 1)
    assert.equal(client.calls.length, 0)
  } finally { hub.disposeRecentMedia() }
})

test('上传：超过 maxMB → 在 outbox 之前就拒；超过 30MB 但没超 maxMB → 失败后**不**回落 base64', async () => {
  // ★ 这两个界限是 hub.sendFile 的两条独立判据，别混成一条：
  //   ① size > maxBytes            → 直接拒（一个请求都不发）
  //   ② size > min(30MB, maxBytes) → 可以发，但**失败后不回落 base64**
  //      （30MB 是 FILE_BASE64_MAX：再大就不该把整份内容塞进请求体）
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: false, retcode: 1200, error: '网关 413' } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  // ① 上限 1MB + 2MB 文件 → 门口就拒
  const tiny = filesConfig({ maxMB: 1 })
  const overMax = writeFileAt(tiny.ws, 'over.bin', 2 * 1024 * 1024)
  const hubTiny = hubWith(tiny.cfg, gw)
  try {
    await assert.rejects(() => hubTiny.sendFile('group:100', overMax, 'over.bin'), /文件太大/)
    assert.equal(outbox.acts.length, 0, '★ 大小上限在 outbox 之前 —— 一个请求都没发')
  } finally { hubTiny.disposeRecentMedia() }

  // ② 上限 40MB + 31MB 文件 → 能发，但失败后不回落 base64（31MB > 30MB）
  const wide = filesConfig({ maxMB: 40 })
  const overBase64 = writeFileAt(wide.ws, 'big31.bin', 31 * 1024 * 1024)
  const hubWide = hubWith(wide.cfg, gw)
  try {
    await assert.rejects(
      () => hubWide.sendFile('private:200', overBase64, 'big31.bin'),
      /发文件失败：/,
      '超过 30MB 的文件失败后不回落 —— 报的就是第一次那一条',
    )
    assert.equal(outbox.acts.length, 1, '★ 只发了一次：31MB > min(30MB, 40MB)，不许再读一遍塞成 base64')
    assert.equal(outbox.acts[0].params.file, overBase64, '第一次就是本机路径原件')
    assert.equal(outbox.acts[0].opts.timeoutMs, 120000)
    assert.equal(hubWide.stats().errors, 1)
    assert.equal(client.calls.length, 0)
  } finally { hubWide.disposeRecentMedia() }
})

test('上传：失败的回落保留 hub 原有的错误语义（第二次的 message 优先，没有就用第一次的）', async () => {
  const { cfg, ws } = filesConfig()
  const local = writeFileAt(ws, 'x.txt', 8)
  const client = fakeClient()
  const outbox = fakeOutbox({
    actResult: (action, params) => (params.file.startsWith('base64://')
      ? { ok: false, retcode: 1200, error: 'BASE64-REJECTED' }
      : { ok: false, retcode: 1200, error: 'PATH-REJECTED' }),
  })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })
  const hub = hubWith(cfg, gw)
  try {
    await assert.rejects(
      () => hub.sendFile('private:200', local, 'x.txt'),
      (e) => /发文件失败：/.test(e.message) && /BASE64-REJECTED/.test(e.message),
      '两次都失败时，hub 报的是第二次（base64）那一条',
    )
    assert.equal(outbox.acts.length, 2)
    assert.equal(hub.stats().errors, 1, '★ 整次发送只记一次 errors（不是每失败一次记一次）')
    assert.equal(hub.stats().sent, 0)
  } finally { hub.disposeRecentMedia() }
})

for (const [label, over, expectReason] of [
  ['files.enabled=false', { files: { enabled: false, dirs: [] } }, /发文件没打开/],
  ['总开关 enabled=false', { enabled: false }, null],
  ['试运行 dryRun=true', { dryRun: true }, null],
]) {
  test('上传：' + label + ' → 一个请求都不进 outbox', async () => {
    const ws = fileWorkspace()
    const local = writeFileAt(ws, 'ok.txt', 8)
    const cfg = hubConfig({ workspaceDir: ws, files: { enabled: true, dirs: [], maxMB: 50 }, ...over })
    const client = fakeClient()
    const outbox = fakeOutbox()
    const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })
    const hub = hubWith(cfg, gw)
    try {
      if (expectReason) {
        await assert.rejects(() => hub.sendFile('private:200', local, 'ok.txt'), expectReason,
          label + ' 要在 outbox 之前就拒')
      } else {
        assert.equal(await hub.sendFile('private:200', local, 'ok.txt'), null, label + ' 下不发，返回 null')
      }
      assert.equal(outbox.acts.length, 0, label + ' 时一次上传都不许进 outbox')
      assert.equal(client.calls.length, 0, '也不许回落到 OneBot client')
    } finally { hub.disposeRecentMedia() }
  })
}

test('上传：允许目录之外的绝对路径 → 在 outbox 之前就拒；目录内的照发', async () => {
  const ws = fileWorkspace()
  const inside = writeFileAt(ws, 'inside.txt', 8)
  const outsideWs = join(process.env.AURABOT_DATA_DIR, 'outside')
  const outside = writeFileAt(outsideWs, 'outside.txt', 8)
  const cfg = hubConfig({ workspaceDir: ws, files: { enabled: true, dirs: [], maxMB: 50 } })
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: {} } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })
  const hub = hubWith(cfg, gw)
  try {
    await assert.rejects(() => hub.sendFile('group:100', outside, 'outside.txt'), /允许发送的目录/)
    assert.equal(outbox.acts.length, 0, '★ 目录校验在 outbox 之前')
    await hub.sendFile('group:100', inside, 'inside.txt')
    assert.equal(outbox.acts.length, 1, '目录内的文件照发')
  } finally { hub.disposeRecentMedia() }
})

test('上传：mode=off → 两个上传动作全拒（outbox-unavailable），acts=0、client=0', async () => {
  const outbox = configuredOutbox()
  const { gw, client, ctx } = gatewayAsCoreWouldWire('off', outbox)

  assert.equal(ctx.outbox, null, 'mode=off 时 ctx 上根本没有出站口')
  for (const [action, params] of [
    ['upload_group_file', { group_id: 100, file: 'C:\\tmp\\a.pdf', name: 'a.pdf' }],
    ['upload_private_file', { user_id: 200, file: 'C:\\tmp\\b.pdf', name: 'b.pdf' }],
  ]) {
    await assert.rejects(
      () => gw.call(action, params, { timeoutMs: 120000 }),
      (e) => e.code === 'outbox-unavailable' && e.stage === 'outbox',
      action + ' 在 mode=off 时必须拒绝',
    )
  }
  assert.equal(outbox.acts.length, 0, 'mode=off 时一次上传都不许从 outbox 出去')
  assert.equal(client.calls.length, 0, '也不许回落到 OneBot client')
})

test('上传：显式 timeoutMs 原样透传；不给就是 30s（不是 120000 —— 120000 是 hub 给的）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: {} } })
  const gw = createOutboxGateway({ client, outbox, newKey: counterKeys() })

  const groupParams = { group_id: 100, file: 'C:\\tmp\\a.pdf', name: 'a.pdf' }
  await gw.call('upload_group_file', groupParams, { timeoutMs: 120000 })
  await gw.call('upload_private_file', { user_id: 200, file: 'C:\\tmp\\b.pdf', name: 'b.pdf' })

  assert.deepEqual(outbox.acts.map((a) => a.opts.timeoutMs), [120000, 30000],
    '显式 120000 照用；不给则落 OneBot 的 30s 默认（不是这一层替它编一个 120000）')
  // ★ 同一个对象交下去：不重排、不裁剪、不补默认值、不把 file 换成别的形态。
  assert.equal(outbox.acts[0].params, groupParams, 'params 必须是同一个对象（上传也不重排 / 不裁剪）')
  assert.equal(client.calls.length, 0)
})

test('上传：没有出站口 → 拒绝，不回落真 client（和别的白名单动作同一条线）', async () => {
  const client = fakeClient()
  const gw = createOutboxGateway({ client, outbox: null, getOutbox: () => null, newKey: counterKeys() })

  for (const action of UPLOAD_PAIR) {
    await assert.rejects(
      () => gw.call(action, { group_id: 100, user_id: 200, file: 'C:\\tmp\\a.pdf', name: 'a.pdf' }, { timeoutMs: 120000 }),
      (e) => e.code === 'outbox-unavailable' && /不回落/.test(e.message),
      action + ' 没有出站口时必须拒绝',
    )
  }
  assert.equal(client.calls.length, 0, '没有回落到 OneBot client')
})
