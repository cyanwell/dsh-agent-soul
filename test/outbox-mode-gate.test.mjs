// 出站口的**模式闸**（events.egress.mode = off | onebot-http）回归测试。
// ============================================================================
// 钉死的是 2026-11-24 那个真缺口：
//   createOutbox 原来只判 baseUrl，managed 配置却**强制 mode=off 而可能留着 httpUrl** ——
//   于是「开关关着」和「能发出去」同时成立，而这两种状态在日志里长得一模一样。
//
// 这一组测试**不连网关、不读配置、不建 core-entry**：
//   · 出站口自己那道闸 → 假 fetch 计数（0 次就是一次都没出去）；
//   · 「交给谁」那道闸 → 纯函数 selectOutbox / selectAurabotOutbox + 照 core 的装配顺序摞一遍。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  createOutbox, selectOutbox, normalizeEgressMode, outboxView, EGRESS_MODE_ON,
  ACT_ACTIONS, ACT_DEFAULT_TIMEOUT_MS, OUTBOX_PORT, resolveActTimeoutMs,
} = await import('../src/adapters/outbox.mjs')
const {
  selectAurabotOutbox, AURABOT_OUTBOX_EGRESS_MODE, ONEBOT_DEFAULT_TIMEOUT_MS,
} = await import('../src/aurabot/adapter/outbox-gateway.mjs')

/**
 * 白名单里的 act 动作（第一~八片，第八片之后共 19 个）+ 各自的真实调用参数（取自 Aurabot 的调用点）。
 * ★ 第六片迁走的上传那一对**单独一份**（ACT_UPLOADS，见下面）—— 判据不同，不混进这一份。
 * ★ 第六片（2026-11-24）之后白名单是 12 个：上传那一对**单独一份**（ACT_UPLOADS），
 *   因为它和多数的「自身资料动作」不是同一条判据（落点是别人的群 / 别人的私聊）。
 *   分开列不是为了好看：混在一起会让「上传的特例」和「资料动作的通则」看起来是一回事。
 * ★ 第四片（2026-11-24）加的 set_friend_add_request / set_doubt_friends_add_request 也在这一圈里：
 *   它们走的是**同一个** act() 通道，没有为它们开特例 —— 只是名字进了白名单。
 *   ★ 参数照抄 contacts/index.js 的真实调用：{ flag, approve } + timeoutMs 15000。
 *   flag 来自事件（String(ev.flag)）或 get_doubt_friends_add_request 回的 uid。
 * ★ 第五片（2026-11-24）加的 delete_qzone_msg 同理走这一个通道：
 *   参数照抄 features/qzone.js 的 remove()：{ tid }（上游已 trim、已判非空）。
 *   ★ 当时只有这一个 Qzone 名字在名单里；发 / 评论随后各自单独授权迁走，点赞在第八片迁走。
 */
const ACT_ACTION_CASES = [
  ['set_input_status', { user_id: 10001, event_type: 1 }],                 // hub.js：按键中
  ['modify_custom_face', { emoji_id: 'E-1', desc: '偷图' }],                // stickers.js：写回备注
  ['delete_custom_face', { emoji_id: 'E-2' }],                             // stickers.js：从收藏里删
  ['set_self_longnick', { longNick: '签名一行' }],                          // profile：改签名
  ['set_qq_profile', { nickname: '砚青' }],                                 // profile：改昵称
  ['set_qq_avatar', { file: 'http://example.invalid/a.png' }],              // profile / 头像同步：换头像
  ['add_custom_face', { file: 'base64://QkM=' }],                           // stickers.js：收藏一张表情
  ['set_friend_add_request', { flag: 'event-flag-abc123', approve: true }],  // contacts：通过一条收到的申请
  ['set_doubt_friends_add_request', { flag: 'doubt-uid-9f2e', approve: false }], // contacts：拒绝一条被过滤的申请
  ['delete_qzone_msg', { tid: 'post-9f2e1c' }],                             // qzone.remove()：删自己发过的一条说说
  ['set_group_special_title', { group_id: 100, user_id: 200, special_title: '头衔' }],
  ['_send_group_notice', { group_id: 100, content: '公告' }],
  ['send_qzone_msg', { content: '一条说说', ugc_right: 1 }],
  ['comment_qzone', { tid: 'post-1', content: '评论一句', target_uin: 200 }],
  ['set_group_ban', { group_id: 100, user_id: 200, duration: 600 }],            // group-admin：禁言（分钟 × 60）
  ['set_group_kick', { group_id: 100, user_id: 200, reject_add_request: false }], // group-admin：踢人
  ['like_qzone', { tid: 'post-1', target_uin: 200, abstime: 1732530000 }],      // qzone-social：点赞（说说 / 对象 / 发布时间）
]

/**
 * set_qq_avatar 的 **三种既有 file 形态**（一个都不许归一、不许裁剪、不许改写）。
 *
 * ★ 三种不是「可选写法」，是三条真实调用路径各自的产物：
 *   ① base64://…          —— profile 模块 applyAvatar 的第一手、头像同步 handler 唯一的一手；
 *   ② 本机绝对路径         —— profile applyAvatar 的**第二手**（base64 被网关拒时才走它）；
 *   ③ http(s) 网址         —— profile 模块直接给网址那条（avatarSource 只收 http(s)）。
 * ★ 一条测试只测一种形态 = 只测了三分之一的迁移。归一化会把 ② 改写成 ①（或反过来），
 *   而失败的表现是「网关说图不行」—— 与「本来就没换」长得一模一样。
 */
const AVATAR_FILES = [
  'base64://iVBORw0KGgoAAAA',                                        // ① base64://
  'C:\\Users\\pc\\AppData\\Local\\Temp\\avatar-1234-5678.jpg', // ② 本机路径（Windows 写法）
  'https://example.invalid/avatar.jpg',                              // ③ 网址
]

/**
 * 第六片迁走的那一对上传 + hub.sendFile 的真实参数形状：
 *   group   → { group_id: Number(id), file, name }
 *   private → { user_id: Number(id), file, name }
 * ★ 这一层只验「名字 / 请求体逐字 / 超时 120000 原样」三件事。
 *   回落、30MB 上限、允许目录那些判据全在 hub.sendFile 上 ——
 *   在测试里再造一份，等于给同一条判据开第二个源头。
 */
const ACT_UPLOADS = [
  ['upload_group_file', { group_id: 100, file: 'C:\\tmp\\a.pdf', name: 'a.pdf' }],
  ['upload_private_file', { user_id: 200, file: 'base64://QkM=', name: 'a.pdf' }],
]

const BASE = 'http://fake-gateway.invalid:3000'
const TOKEN = 'SECRET-token-1234'

/** 假 fetch：只记账。send 走 res.text()，poke 走 res.json()，两个都给。 */
function fakeFetch ({ retcode = 0, messageId = 4242, status = 200 } = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const payload = { status: 'ok', retcode, data: { message_id: messageId } }
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    }
  }
  return { calls, impl }
}

// ────────────────────────────────────────────────────────────────────────────
// ① 模式闸：mode=off 时 send / poke 都不发，一个请求都不许出去
// ────────────────────────────────────────────────────────────────────────────
test('mode=off + 已配置 baseUrl：send / poke 都拒，fetch 一次都不调，view.mode=off', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ mode: 'off', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false })

  const r = await ob.send('group:100', '在吗')
  assert.equal(r.ok, false, 'mode=off 时不许发出去')
  assert.equal(r.messageId, null)
  assert.match(String(r.error), /off/, '失败要说清是模式关着，不是网络问题')

  const p = await ob.poke('group:100', '10001')
  assert.equal(p.ok, false, '戳一戳也是真发出去的动作，同样不许')
  assert.match(String(p.error), /off/)

  assert.equal(f.calls.length, 0, 'mode=off 时 fetch 调用次数必须是 0（连网都不碰）')

  const v = ob.view()
  assert.equal(v.mode, 'off', 'mode=off 时视图只能说 off —— 哪怕 baseUrl 配着')
  assert.equal(v.egressMode, 'off')
  assert.equal(v.configured, true, '配置了地址是事实，但它不等于「允许发」')
  assert.equal(v.host, 'fake-gateway.invalid:3000')
  assert.equal(v.stats.sent, 0)
  assert.ok(v.stats.failed >= 2)
  assert.equal(JSON.stringify(v).includes(TOKEN), false, '视图里不许出现 token')
})

test('不传 mode = off（安全默认）：老调用点不会因为「忘了写」而变成能发', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ baseUrl: BASE, fetchImpl: f.impl, register: false })

  assert.equal(ob.view().egressMode, 'off')
  assert.equal((await ob.send('private:200', 'x')).ok, false)
  assert.equal((await ob.poke('private:200', '10001')).ok, false)
  assert.equal(f.calls.length, 0)
  assert.equal(ob.view().mode, 'off')
})

test('不认的模式（拼错 / 大小写 / 别名 / 空）一律等价 off，绝不因为「看着像」放行', async () => {
  const notOn = ['off', '', '   ', undefined, null, 0, false,
    'ONE BOT HTTP', 'Onebot-Http', 'onebot_http', 'bridge-console', 'http', 'on', 'onebot-http-v2']
  for (const mode of notOn) {
    const f = fakeFetch()
    const ob = createOutbox({ mode, baseUrl: BASE, fetchImpl: f.impl, register: false })
    assert.equal((await ob.send('group:100', 'x')).ok, false, JSON.stringify(mode) + ' 不许发')
    assert.equal((await ob.poke('group:100', '10001')).ok, false, JSON.stringify(mode) + ' 不许戳')
    assert.equal(f.calls.length, 0, JSON.stringify(mode) + ' 一个请求都不许出去')
    assert.equal(ob.view().mode, 'off', JSON.stringify(mode) + ' 视图不许说 on')
  }
  // 判据本身只有一种写法：trim 后逐字相等
  assert.equal(normalizeEgressMode(' onebot-http '), 'onebot-http')
  assert.equal(normalizeEgressMode('onebot-http'), EGRESS_MODE_ON)
  assert.equal(normalizeEgressMode('onebot-https'), 'off')
})

// ────────────────────────────────────────────────────────────────────────────
// ② 打开之后照旧：send / poke 真走 fetch，幂等与视图都不变
// ────────────────────────────────────────────────────────────────────────────
test('mode=onebot-http：send / poke 仍走 fake fetch（原契约没被这道闸改坏）', async () => {
  const f = fakeFetch({ messageId: 4242 })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false })

  const r = await ob.send('group:100', '在吗')
  assert.equal(r.ok, true)
  assert.equal(r.messageId, 4242)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, BASE + '/send_group_msg')
  assert.equal(f.calls[0].init.method, 'POST')
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer ' + TOKEN)
  const body = JSON.parse(f.calls[0].init.body)
  assert.equal(body.group_id, 100)
  assert.deepEqual(body.message, [{ type: 'text', data: { text: '在吗' } }])

  // 幂等：同内容再发，网关不再被打第二次
  const again = await ob.send('group:100', '在吗')
  assert.equal(again.ok, true)
  assert.equal(again.deduped, true)
  assert.equal(f.calls.length, 1, '幂等命中不该再打网关')

  const p = await ob.poke('group:100', '10001')
  assert.equal(p.ok, true)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].url, BASE + '/send_poke')
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { user_id: 10001, group_id: 100 })

  const v = ob.view()
  assert.equal(v.mode, 'on')
  assert.equal(v.egressMode, 'onebot-http')
  assert.equal(v.stats.sent, 2)
  assert.equal(v.configured, true)
})

test('mode 认了但没 baseUrl：仍然 fail-closed（两个条件都要满足）', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: '', fetchImpl: f.impl, register: false })

  const r = await ob.send('group:100', 'x')
  const p = await ob.poke('group:100', '10001')
  assert.equal(r.ok, false)
  assert.match(String(r.error), /baseUrl/)
  assert.equal(p.ok, false)
  assert.equal(f.calls.length, 0)
  assert.equal(ob.view().mode, 'off', '模式认了但没接线 —— 视图不许说 on')
  assert.equal(ob.view().egressMode, 'onebot-http', '配置说了什么，照实报')
})

// ────────────────────────────────────────────────────────────────────────────
// ③ close 语义保留：关掉之后不发，计数不抹
// ────────────────────────────────────────────────────────────────────────────
test('close 之后 send / poke 拒绝，view.mode=closed，计数保留', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })
  assert.equal((await ob.send('group:100', '关之前的一条')).ok, true)
  const sentBefore = ob.stats().sent
  assert.equal(sentBefore, 1)

  ob.close()
  ob.close() // 幂等：重复关闭不许抛

  const r = await ob.send('group:100', '关之后')
  assert.equal(r.ok, false)
  assert.match(String(r.error), /关闭/)
  assert.equal((await ob.poke('group:100', '10001')).ok, false)
  assert.equal(f.calls.length, 1, '关掉之后一个请求都不许出去')

  const v = ob.view()
  assert.equal(v.mode, 'closed', 'closed 优先于 on / off —— 它说的是生命周期')
  assert.equal(v.closed, true)
  assert.equal(v.stats.sent, sentBefore, '关掉不许把「发过几条」抹成 0')
})

// ────────────────────────────────────────────────────────────────────────────
// ④ 接线：core 交给 events responder 与 aurabot 的，必须是**同一个**判据的结果
// ────────────────────────────────────────────────────────────────────────────
test('mode=off：事件 responder 与 aurabot 都拿到 null；mode=on：两处是同一个实例', () => {
  // 照 core-entry 的装配顺序摞一遍（不起 core-entry —— 它一 import 就要配置与数据目录）：
  //   events 侧 → createEventsIngress({ outbox: selectOutbox(...) })
  //              events/index.mjs 里判据是 `_replySourceReady && opts.outbox`，为假就不建 responder
  //   aurabot 侧 → createAurabotCtx({ services: { outbox: selectAurabotOutbox(...) } })
  function wireAsCoreWould (mode, outbox) {
    const eventsOutbox = selectOutbox(mode, outbox)
    const aurabotOutbox = selectAurabotOutbox(mode, outbox)
    const replySourceReady = true // reply.sessionRoot / useBridgeSessions 都配好的情况
    return {
      eventsOutbox,
      aurabotOutbox,
      responderBuilt: Boolean(replySourceReady && eventsOutbox),
    }
  }

  const instance = {
    send: async () => ({ ok: true, retcode: 0, messageId: 1 }),
    poke: async () => ({ ok: true, retcode: 0 }),
  }

  const off = wireAsCoreWould('off', instance)
  assert.equal(off.eventsOutbox, null, 'mode=off 时事件层不许拿到出站口')
  assert.equal(off.aurabotOutbox, null, 'mode=off 时 aurabot 也不许拿到')
  assert.equal(off.responderBuilt, false, 'mode=off 时连 responder 都不该建 —— 没有第二只手')
  assert.equal(wireAsCoreWould(undefined, instance).responderBuilt, false, 'mode 缺失 = off')

  const on = wireAsCoreWould('onebot-http', instance)
  assert.equal(on.eventsOutbox, instance, 'mode=on 时事件层拿的就是那一个出站口')
  assert.equal(on.aurabotOutbox, instance)
  assert.equal(on.eventsOutbox, on.aurabotOutbox, '两处必须逐字是同一个实例（一个进程只有一个出站口）')
  assert.equal(on.responderBuilt, true)

  // 两条选择入口必须同源：任取一组模式都不许分叉
  for (const mode of ['off', 'onebot-http', ' onebot-http ', 'ONE BOT HTTP', '', undefined, null, 'on']) {
    assert.equal(selectOutbox(mode, instance), selectAurabotOutbox(mode, instance), JSON.stringify(mode))
  }
  assert.equal(AURABOT_OUTBOX_EGRESS_MODE, EGRESS_MODE_ON, '常量也只有一份')
  // mode 认了但没出站口 —— 不许凭空造一个
  assert.equal(selectOutbox('onebot-http', null), null)
  assert.equal(selectOutbox('onebot-http', undefined), null)
})

// ────────────────────────────────────────────────────────────────────────────
// ⑤ 只读视图：GET /api/outbox 读的就是这一份（登记在进程里）
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// ⑥ 迁移兼容（2026-11-24）：per-call 超时、OneBot 成功语义、poke 的计数与取消
//
//   三件事都是「迁移到进程内出站口之后才出现的差异」，不是口径偏好：
//   · 出站口默认 8s，而 Aurabot 的 OneBot client 默认 30s —— 同一句话迁移后更容易被判超时；
//   · 只认 retcode 会把只回 {status:'ok'} 的网关记成失败（消息其实已经发出去了，调用方还会重试）；
//   · poke 一次失败记两次、且不在 inflight 里 —— failed 翻倍，close() 也掐不断它。
// ────────────────────────────────────────────────────────────────────────────

/** 永不 resolve 的假 fetch：只在你给的 signal 被 abort 时才失败。用来量「到底等了多久」。 */
function hangingFetch () {
  const calls = []
  const impl = (url, init = {}) => new Promise((resolve, reject) => {
    calls.push({ url: String(url), init })
    const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    if (init.signal) {
      if (init.signal.aborted) return onAbort()
      init.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  return { calls, impl }
}

/** 回**指定原样** JSON 的假 fetch（可以只给 status、不给 retcode）。 */
function rawFetch (payload, { status = 200 } = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const bodyText = typeof payload === 'string' ? payload : JSON.stringify(payload)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => bodyText,
      json: async () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
    }
  }
  return { calls, impl }
}

// ── per-call 超时：显式覆盖配置默认，非法值回落配置默认 ──────────────────────
test('send：per-call timeoutMs 压过配置默认（配置 5s，这次只要 40ms）', async () => {
  const f = hangingFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, timeoutMs: 5000, fetchImpl: f.impl, register: false })

  const t0 = Date.now()
  const r = await ob.send('group:100', '慢网关', { timeoutMs: 40 })
  const spent = Date.now() - t0

  assert.equal(r.ok, false)
  assert.match(String(r.error), /网络错误/)
  assert.ok(spent < 1500, '显式 40ms 必须真的压过配置的 5000ms（实测 ' + spent + 'ms）')
  assert.equal(f.calls.length, 1)
  assert.equal(ob.stats().failed, 1)
})

for (const bad of [0, -1, NaN, 'abc', '', null, undefined, Infinity]) {
  test('send：非法 per-call timeout（' + String(bad) + '）→ 回落配置默认，而不是「不超时」', async () => {
    const f = hangingFetch()
    const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, timeoutMs: 40, fetchImpl: f.impl, register: false })

    const t0 = Date.now()
    const r = await ob.send('group:100', 'x', { timeoutMs: bad })

    assert.equal(r.ok, false)
    assert.ok(Date.now() - t0 < 1500, '回落没生效的话这里会一直挂着（配置是 40ms）')
  })
}

test('poke：per-call timeoutMs 同样生效（hub 给 10s，测试用 40ms 证明它被用上了）', async () => {
  const f = hangingFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, timeoutMs: 5000, fetchImpl: f.impl, register: false })

  const t0 = Date.now()
  const p = await ob.poke('group:100', '10001', { timeoutMs: 40 })

  assert.equal(p.ok, false)
  assert.ok(Date.now() - t0 < 1500, '在途 poke 必须按这次给的 40ms 掐断（实测 ' + (Date.now() - t0) + 'ms）')
  assert.equal(ob.stats().failed, 1)
})

// ── 成功语义：status === 'ok' 或 retcode === 0 ─────────────────────────────
test('send：status="ok" 但没有 retcode → 成功，retcode 记 0、message_id 留住、幂等表也认它', async () => {
  const f = rawFetch({ status: 'ok', data: { message_id: 31337 } })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const r = await ob.send('group:100', '在吗')

  assert.deepEqual(r, { ok: true, retcode: 0, messageId: 31337, deduped: false })
  assert.equal(ob.stats().sent, 1)
  assert.equal(ob.stats().failed, 0, '消息真的发出去了，不许记成失败')
  assert.equal(ob.view().recent[0].retcode, 0)

  // 只有成功才抑制后续；这条进了幂等表就说明它被当成成功记账了
  const again = await ob.send('group:100', '在吗')
  assert.equal(again.ok, true)
  assert.equal(again.deduped, true)
  assert.equal(again.messageId, 31337)
  assert.equal(f.calls.length, 1, '幂等命中不该再打网关')
})

test('send：status 不是 ok 且没有 retcode → 失败（「没说失败」不等于成功）', async () => {
  const f = rawFetch({ status: 'failed', message: '风控拦截' })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const r = await ob.send('group:100', 'x')

  assert.equal(r.ok, false)
  assert.equal(r.retcode, null)
  assert.match(String(r.error), /status=failed/)
  assert.match(String(r.error), /风控拦截/, '网关原话要留在错误里，否则排查只能靠猜')
  assert.equal(ob.stats().failed, 1)
  assert.equal(ob.stats().sent, 0)
})

test('send：回应里既没 status 也没 retcode（{} / null / 非 JSON）→ 一律失败', async () => {
  for (const payload of [{}, 'null', 'not json']) {
    const f = rawFetch(payload)
    const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })
    const r = await ob.send('group:100', 'x')
    assert.equal(r.ok, false, JSON.stringify(payload) + ' 不许被当成成功')
    assert.equal(ob.stats().sent, 0)
  }
})

test('send：retcode=0 即便 status 写着别的也是成功（与 OneBot client 的判据逐字一致）', async () => {
  const f = rawFetch({ status: 'failed', retcode: 0, data: { message_id: 7 } })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const r = await ob.send('group:100', 'x')
  assert.equal(r.ok, true)
  assert.equal(r.messageId, 7)
})

test('send：retcode 非 0 且 status 不是 ok → 失败，retcode 原样带出（错误可判）', async () => {
  const f = rawFetch({ status: 'failed', retcode: 100, wording: '无权限' })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const r = await ob.send('group:100', 'x')
  assert.equal(r.ok, false)
  assert.equal(r.retcode, 100)
  assert.match(String(r.error), /无权限/)
})

// ── poke：成功语义、一次失败只记一次、close() 掐得断 ────────────────────────
test('poke：status="ok" 但没有 retcode → 成功（旧代码把缺 retcode 当 0 也是「成功」，但那是猜的）', async () => {
  const f = rawFetch({ status: 'ok' })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const p = await ob.poke('group:100', '10001')
  assert.deepEqual(p, { ok: true, retcode: 0, poked: '10001' })
  assert.equal(ob.stats().sent, 1)
  assert.equal(ob.stats().failed, 0)
})

test('poke：缺 retcode 且 status 不是 ok → 失败（不许默认成功）', async () => {
  for (const payload of [{ status: 'failed' }, {}, 'null']) {
    const f = rawFetch(payload)
    const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })
    const p = await ob.poke('group:100', '10001')
    assert.equal(p.ok, false, JSON.stringify(payload))
    assert.equal(ob.stats().failed, 1)
  }
})

for (const [label, payload, status] of [
  ['retcode=100', { status: 'failed', retcode: 100, wording: '没权限' }, 200],
  ['status 不是 ok 且缺 retcode', { status: 'failed' }, 200],
  ['HTTP 500', { status: 'failed', retcode: 500 }, 500],
]) {
  test('poke 失败（' + label + '）→ failed 只 +1（旧代码在 fail() 之前又手动加了一次）', async () => {
    const f = rawFetch(payload, { status })
    const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

    const p = await ob.poke('group:100', '10001')

    assert.equal(p.ok, false)
    assert.equal(ob.stats().failed, 1, '一次失败只能记一次')
    assert.equal(ob.stats().sent, 0)
  })
}

test('poke：网络错只记一次 failed，且错误里带 cause（「连不上」和「被掐断」要分得开）', async () => {
  const impl = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: impl, register: false })

  const p = await ob.poke('group:100', '10001')
  assert.equal(p.ok, false)
  assert.match(String(p.error), /ECONNREFUSED/)
  assert.equal(ob.stats().failed, 1)
})

test('close() 掐得断在途 poke（不是等它自己超时）', async () => {
  const f = hangingFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, timeoutMs: 60000, fetchImpl: f.impl, register: false })

  const pending = ob.poke('group:100', '10001', { timeoutMs: 60000 })
  const t0 = Date.now()
  ob.close()
  const p = await pending
  const spent = Date.now() - t0

  assert.equal(p.ok, false)
  assert.ok(spent < 1500, 'close() 之后必须马上结束（实测 ' + spent + 'ms；没登记 inflight 就会挂满 60s）')
  assert.equal(ob.stats().failed, 1)
})

test('poke 成功后不在 inflight 里：再 close() 不重复 abort、计数不变', async () => {
  const f = rawFetch({ status: 'ok' })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  await ob.poke('group:100', '10001')
  const before = ob.stats()
  ob.close()
  ob.close()
  assert.deepEqual(ob.stats(), before)
})

test('outboxView()（/api/outbox 的响应）在 mode=off + httpUrl 时也报 off', async () => {
  const f = fakeFetch()
  // 这条故意 register: true（默认）—— 它验的是「面板读到的那个数」
  const ob = createOutbox({ mode: 'off', baseUrl: BASE, fetchImpl: f.impl })
  const view = outboxView()
  assert.equal(view.mode, 'off')
  assert.equal(view.egressMode, 'off')
  assert.equal(view.configured, true)
  assert.equal(view.stats.sent, 0)
  ob.close()
  assert.equal(outboxView().mode, 'closed', '关掉之后视图仍然说 closed（不是 off）')
})

// ────────────────────────────────────────────────────────────────────────────
// ⑦ act()：五个**资料类动作**的白名单通道（2026-11-24 第二片）
//
//   这一片要钉死的六件事，缺一条就不该上线：
//   · 白名单外一个都不许发（尤其：**没有通用 call 通道** —— 近似串 / 未知 / 自定义名字）；
//   · 请求体就是 params 原件（不重排、不裁剪）；
//   · **不套消息摘要幂等**：同一动作同样参数做两次 = 两次请求（改两次签名是意图，不是事故）；
//   · 成功语义与 OneBot client 同一条（status==='ok' 或 retcode===0），data 原样回来；
//   · 默认超时 30000ms（client 同值），per-call 正数覆盖，坏值回落；
//   · 一次失败只记一次、close() 掐得断、params 一个字都不进日志/视图。
// ────────────────────────────────────────────────────────────────────────────

test('act：ACT_ACTION_CASES 里的十九个白名单动作各走自己的 URL，请求体与 params 逐字一致，带 Bearer', async () => {
  for (const [action, params] of ACT_ACTION_CASES) {
    const f = rawFetch({ status: 'ok', retcode: 0, data: { emoji_id: 'E-1' } })
    const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false })

    const r = await ob.act(action, params)

    assert.equal(r.ok, true, action + ' 该成功')
    assert.equal(f.calls.length, 1, action + ' 只该发一个请求')
    assert.equal(f.calls[0].url, BASE + '/' + action, 'URL 就是 baseUrl + / + 动作名')
    assert.equal(f.calls[0].init.method, 'POST')
    assert.equal(f.calls[0].init.headers.authorization, 'Bearer ' + TOKEN, 'token 只在 header 里')
    assert.equal(f.calls[0].init.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(f.calls[0].init.body), params, action + ' 的请求体必须逐字是 params')
  }
})

test('act：同一动作同样参数做两次 → 两次请求（不套消息摘要幂等）', async () => {
  const f = rawFetch({ status: 'ok', retcode: 0, data: { emoji_id: 'E-1' } })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const params = { emoji_id: 'E-1', desc: '同一个备注' }
  const a = await ob.act('modify_custom_face', params)
  const b = await ob.act('modify_custom_face', params)

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(f.calls.length, 2, '同样的资料动作做两次就是两次请求（第二次不许被吞掉）')
  assert.equal(a.deduped, undefined, 'act 的返回里没有 deduped —— 它压根不进幂等表')
  const v = ob.view()
  assert.equal(v.stats.deduped, 0, 'deduped 只属于发消息')
  assert.equal(v.stats.sent, 2)
  assert.equal(v.dedupe.entries, 0, '资料动作不进幂等表')
})

test('act：成功回 data 原件（调用方靠 emoji_id 继续干活）；只回 status:ok 时 data 是 null', async () => {
  const f = rawFetch({ status: 'ok', retcode: 0, data: { emoji_id: 'EMOJI-42', desc: '偷图' } })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const r = await ob.act('modify_custom_face', { emoji_id: 'EMOJI-42', desc: '偷图' })
  assert.deepEqual(r, { ok: true, retcode: 0, data: { emoji_id: 'EMOJI-42', desc: '偷图' } })

  const f2 = rawFetch({ status: 'ok' })
  const ob2 = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f2.impl, register: false })
  const r2 = await ob2.act('set_input_status', { user_id: 10001, event_type: 1 })
  assert.deepEqual(r2, { ok: true, retcode: 0, data: null }, '缺 data 就是 null，不编一个 {}')
  assert.equal(ob2.stats().sent, 1, 'status:ok 没有 retcode 也算成功（与 client 同一判据）')
  assert.equal(ob2.stats().failed, 0)
})

test('act：白名单外的名字一律拒，且一个请求都不发（没有通用 call 通道）', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  // ★ 这份「不在白名单」清单里**故意**还留着已迁名字的近似串
  //   （modify_custom_face_extra / set_qq_avatar_extra / set_friend_add_request_extra /
  //   Set_Friend_Add_Request）：名字要**逐字相等**，前缀像、大小写像都不算数。
  //   ★ 第四片之后 set_friend_add_request 自己**已经**在白名单里了，所以它从这份清单里移出来 ——
  //     把它留在这里，这条测试会从「白名单外拒」变成一条永远绿的假测试。
  //   ★ 第五片之后 delete_qzone_msg 同理**移出**这份清单（它已经进白名单），
  //     但它的近似串 delete_qzone_msg_extra / Delete_Qzone_Msg / delete_qzone_msgs 留在下面 ——
  //     名字要逐字相等，前缀像、大小写像都不算数。Qzone 另外三个也留在这里（它们没迁）。
  //   ★ 第六片之后 upload_group_file / upload_private_file 这两个**确切名字也移出**这份清单，
  //     但上传的近似串（upload_file / Upload_Group_File / upload_group_file_extra）留下 ——
  //     「名字逐字相等」这条判据不能因为迁了一对就放松。
  //   ★ 第七片之后 set_group_special_title / _send_group_notice 这两个**确切名字同样移出**
  //     （它们已进白名单，留在这里会变成一条永远绿的假测试），近似串补在下面 ——
  //     前缀像（_extra）、大小写像（Set_Group_Special_Title）都必须在名单外。
  for (const name of ['set_group_whole_ban',
    'upload_file', 'Upload_Group_File', 'upload_group_file_extra', 'upload_private_file_v2',
    'set_group_special_title_extra', 'Set_Group_Special_Title', '_send_group_notice_extra',
    // ★ 第八片：set_group_ban / set_group_kick / like_qzone 这三个**确切名字**已进白名单，
    //   所以从这份「必须被拒」的清单里移出（留着会变成永远绿的假测试）；
    //   它们的近似串补在这里 —— 名字逐字相等，前缀像、大小写像、复数像都不算数。
    'set_group_ban_extra', 'Set_Group_Ban', 'set_group_bans', 'set_group_kick_v2',
    'Like_Qzone', 'like_qzone_extra', 'like_qzone_msg',
    'delete_qzone_msg_extra', 'Delete_Qzone_Msg', 'delete_qzone_msgs',
    'get_group_member_list', 'send_group_msg', 'send_poke', 'delete_msg',
    'modify_custom_face_extra', 'set_qq_avatar_extra', 'Add_Custom_Face',
    'set_friend_add_request_extra', 'Set_Friend_Add_Request', 'set_doubt_friends_add_request_extra', '', 'ACT', null, undefined]) {
    const r = await ob.act(name, { group_id: 100, ban_duration: 600 })
    assert.equal(r.ok, false, JSON.stringify(name) + ' 不在白名单，必须拒')
    assert.match(String(r.error), /白名单/, JSON.stringify(name) + ' 的失败要说清是白名单，不是网络')
    assert.equal(r.data, undefined, '拒绝时不带 data')
  }
  assert.equal(f.calls.length, 0, '白名单外一个请求都不许出去（连请求体都不生成）')
  assert.equal(ob.stats().sent, 0)
})

test('act：白名单正好是十九个名字，OUTBOX_PORT 只广告 3 发送 + 19 act 动作', () => {
  // ★ 第八片（2026-11-24）在末尾追加 set_group_ban / set_group_kick / like_qzone。
  //   白名单顺序其余部分不变（顺序是接口的一部分，新增一律追加在末尾）。
  assert.deepEqual(ACT_ACTIONS.slice(), [
    'set_input_status', 'modify_custom_face', 'delete_custom_face', 'set_self_longnick', 'set_qq_profile',
    'set_qq_avatar', 'add_custom_face',
    'set_friend_add_request', 'set_doubt_friends_add_request',
    'delete_qzone_msg',
    'upload_group_file', 'upload_private_file',
    'set_group_special_title', '_send_group_notice', 'send_qzone_msg', 'comment_qzone',
    'set_group_ban', 'set_group_kick', 'like_qzone',
  ])
  assert.deepEqual(OUTBOX_PORT.actions.slice(), [
    'send_group_msg', 'send_private_msg', 'send_poke',
    'set_input_status', 'modify_custom_face', 'delete_custom_face', 'set_self_longnick', 'set_qq_profile',
    'set_qq_avatar', 'add_custom_face',
    'set_friend_add_request', 'set_doubt_friends_add_request',
    'delete_qzone_msg',
    'upload_group_file', 'upload_private_file',
    'set_group_special_title', '_send_group_notice', 'send_qzone_msg', 'comment_qzone',
    'set_group_ban', 'set_group_kick', 'like_qzone',
  ])
  assert.equal(OUTBOX_PORT.actions.length, 22, '端口自述正好 22 个动作（3 发送/戳 + 19 act）')
  // ★ 第八片之后「剩余已知写动作是**空的** —— 空也要被断出来：
  //   整段删掉的话，「还剩几个」就没有任何地方说得清了。
  const STILL_DELEGATED = []
  assert.equal(STILL_DELEGATED.length, 0, '已知写动作全部迁完，剩余 0 个')
  assert.equal(STILL_DELEGATED.includes('comment_qzone'), false)
  // ★ 但白名单 ≠ 所有 OneBot 写动作 —— 这是「余 0 个」最容易被读歪的那一半：
  //   未知的 / 自定义的 / 第三方 facade 上的名字仍在外面。
  for (const name of ['set_group_whole_ban', 'set_group_ban_extra', 'Like_Qzone', 'custom_action']) {
    assert.equal(OUTBOX_PORT.actions.includes(name), false, name + ' 不许被顺手带进白名单')
  }
  assert.match(OUTBOX_PORT.note, /没有通用 call/, '自述必须明说没有通用动作通道')
  // ★ 自述必须**逐字**写出每个改道的名字：只报个数读不出「哪几个」（面板与验收脚本读的就是它）
  for (const name of OUTBOX_PORT.actions) assert.match(OUTBOX_PORT.note, new RegExp(name), 'note 里要写清 ' + name)
  const ob = createOutbox({ mode: 'off', baseUrl: BASE, register: false })
  assert.deepEqual(ob.view().actions, OUTBOX_PORT.actions.slice(), '视图读的是同一份')
})

// ── 第五片（2026-11-24）：delete_qzone_msg 一个名字。三条契约，各一条测试 ─────────
test('act：delete_qzone_msg 的 { tid } 逐字进请求体，且 tid 一个字都不进日志 / 视图 / 记录', async () => {
  const logs = []
  const secretTid = 'post-PRIVATE-7f3a9c'
  const f = rawFetch({ status: 'ok', retcode: 0, data: { tid: secretTid } })
  const ob = createOutbox({
    mode: 'onebot-http', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false,
    log: (m) => logs.push(String(m)),
  })

  const r = await ob.act('delete_qzone_msg', { tid: secretTid })

  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, BASE + '/delete_qzone_msg', 'URL 就是 baseUrl + / + 动作名')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { tid: secretTid }, '请求体只有 tid，且逐字（不 trim、不归一、不多塞字段）')
  assert.deepEqual(r, { ok: true, retcode: 0, data: { tid: secretTid } }, '成功时 data 是网关原件')

  const haystack = logs.join('|') + JSON.stringify(ob.view(20)) + JSON.stringify(ob.stats())
  assert.equal(haystack.includes(secretTid), false, 'tid 不许出现在日志 / 视图 / 计数里（投影不该比权威更方便）')
  assert.match(logs.join('|'), /delete_qzone_msg/, '动作名要在日志里（否则「做过什么」查不出来）')
  const row = ob.view().recent[0]
  assert.equal(row.action, 'delete_qzone_msg')
  assert.equal(row.preview, '', '动作记录没有正文预览')
})

test('act：同一条 tid 删两次 → 两次请求（删除不挂摘要幂等，也不自动重试）', async () => {
  const f = rawFetch({ status: 'ok', retcode: 0, data: null })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const params = { tid: 'post-same' }
  const a = await ob.act('delete_qzone_msg', params)
  const b = await ob.act('delete_qzone_msg', params)

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(f.calls.length, 2, '同一条 tid 删两次就是两次请求（第二次由网关判「已不存在」）')
  assert.equal(ob.view().stats.deduped, 0, 'deduped 只属于发消息')
  assert.equal(ob.view().dedupe.entries, 0, '删除不进幂等表 —— 摘要去重会让「第一次失败、第二次被静默吞掉」成为可能')
})

test('act：delete_qzone_msg 失败（retcode / 网络错）→ ok:false，不重试；失败的删除不许被当成成功', async () => {
  const f = rawFetch({ status: 'failed', retcode: 100, wording: 'tid 无效' })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const r = await ob.act('delete_qzone_msg', { tid: 'post-bad' })
  assert.equal(r.ok, false, '网关说 tid 无效就是失败（本地不默认成功）')
  assert.equal(r.retcode, 100)
  assert.equal(ob.stats().failed, 1)
  assert.equal(ob.stats().sent, 0)
  assert.equal(f.calls.length, 1, '失败不自动重试（重试的语义由调用方判断）')
})

// ── 第六片（2026-11-24）：upload_group_file / upload_private_file 一对 ──────────
//   ★ 这一层只管三件事：**名字、请求体逐字、超时原样**。
//     大小上限 / 允许目录 / 存在性 / base64 回落全在 hub.sendFile 上，这里一条都不复制。
//   ★ 每条测试都只打假 fetch：一次请求都出不了本机。

test('act：上传一对各落各的 URL，请求体（group_id / user_id / file / name）逐字', async () => {
  for (const [action, params] of ACT_UPLOADS) {
    const f = rawFetch({ status: 'ok', retcode: 0, data: {} })
    const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false })

    const r = await ob.act(action, params)

    assert.equal(r.ok, true, action + ' 该成功')
    assert.equal(f.calls.length, 1, action + ' 只该发一个请求')
    assert.equal(f.calls[0].url, BASE + '/' + action, 'URL 就是 baseUrl + / + 动作名（群/私聊是两个不同的动作）')
    assert.equal(f.calls[0].init.method, 'POST')
    assert.equal(f.calls[0].init.headers.authorization, 'Bearer ' + TOKEN)
    assert.deepEqual(JSON.parse(f.calls[0].init.body), params, action + ' 的请求体必须逐字是 params')
    assert.equal(ob.stats().sent, 1)
  }
})

test('act：上传的 file 三种形态（本机路径 / base64:// / 网址）逐字，不改写', async () => {
  const FILES = [
    'C:\\Users\\pc\\PRIVATE-DIR\\report.pdf', // ① 本机绝对路径
    'base64://' + 'QUJDREVGR0g',                        // ② base64://（hub 回落那一手）
    'https://example.invalid/x.zip',                   // ③ 外部网址
  ]
  for (const file of FILES) {
    const f = rawFetch({ status: 'ok', retcode: 0, data: {} })
    const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

    const params = { group_id: 100, file, name: 'report.pdf' }
    await ob.act('upload_group_file', params)

    const body = JSON.parse(f.calls[0].init.body)
    assert.equal(body.file, file, 'file 一个字符都不许被 trim / resolve / 换形态：' + JSON.stringify(file))
    assert.deepEqual(body, params)
  }
})

test('act：上传的 file（路径或 base64 正文）不进日志 / 视图 / 记录 —— 只留动作名', async () => {
  const logs = []
  const secretPath = 'C:\\Users\\pc\\PRIVATE-UPLOAD-7f3a9c\\photo.jpg'
  const secretB64 = 'PRIVATE-UPLOAD-BODY-9d2f1e'
  const f = rawFetch({ status: 'ok', retcode: 0, data: {} })
  const ob = createOutbox({
    mode: 'onebot-http', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false,
    log: (m) => logs.push(String(m)),
  })

  await ob.act('upload_group_file', { group_id: 100, file: secretPath, name: 'photo.jpg' })
  await ob.act('upload_private_file', { user_id: 200, file: 'base64://' + secretB64, name: 'photo.jpg' })

  const haystack = logs.join('|') + JSON.stringify(ob.view(20)) + JSON.stringify(ob.stats())
  assert.equal(haystack.includes(secretPath), false, '本机路径（带用户名 / 目录结构）不许进日志或视图')
  assert.equal(haystack.includes(secretB64), false, 'base64 正文不许进日志或视图（那是文件本身）')
  assert.equal(haystack.includes('photo.jpg'), false, '文件名也不留 —— 它同样是「发了哪个文件」的索引')
  assert.match(logs.join('|'), /upload_group_file/, '动作名必须在（否则「做过什么」查不出来）')
  assert.match(logs.join('|'), /upload_private_file/)
  const rows = ob.view().recent.slice(0, 2).map((x) => x.action).sort()
  assert.deepEqual(rows, ['upload_group_file', 'upload_private_file'], '记录里只有动作名')
  for (const row of ob.view().recent) assert.equal(row.preview, '', '动作记录没有正文预览')
  assert.equal(ob.view().dedupe.entries, 0, '上传不进幂等表')
})

test('act：上传失败（retcode / HTTP / 网络错）→ ok:false，且**一次调用只发一个请求**（不自动重试）', async () => {
  // ① 业务失败（HTTP 200 + retcode 100）
  const f1 = rawFetch({ status: 'failed', retcode: 100, wording: '不支持的文件类型' })
  const ob1 = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f1.impl, register: false })
  const r1 = await ob1.act('upload_group_file', { group_id: 100, file: 'C:\\tmp\\a.pdf', name: 'a.pdf' })
  assert.equal(r1.ok, false)
  assert.equal(r1.retcode, 100)
  assert.equal(f1.calls.length, 1, '业务失败不许自动重试（重试是 hub 的业务决定，不是传输层的事）')
  assert.equal(ob1.stats().failed, 1, '一次失败只记一次')

  // ② HTTP 500
  const f2 = rawFetch({ status: 'failed', retcode: 1200 }, { status: 500 })
  const ob2 = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f2.impl, register: false })
  const r2 = await ob2.act('upload_private_file', { user_id: 200, file: 'base64://QkM=', name: 'b.pdf' })
  assert.equal(r2.ok, false)
  assert.equal(f2.calls.length, 1, '5xx 也不许在这里重试')

  // ③ 网络错（fetch 自己抛）
  let attempts = 0
  const ob3 = createOutbox({
    mode: 'onebot-http', baseUrl: BASE, register: false,
    fetchImpl: async () => { attempts += 1; const e = new Error('connect ECONNREFUSED'); e.cause = { code: 'ECONNREFUSED' }; throw e },
  })
  const r3 = await ob3.act('upload_group_file', { group_id: 100, file: 'C:\\tmp\\a.pdf', name: 'a.pdf' })
  assert.equal(r3.ok, false, '网络错要返回，不许抛给调用方（hub 的 catch 靠它决定要不要回落 base64）')
  assert.equal(attempts, 1, '★ 网络错也不许在传输层重试：一次 outbox.act = 至多一次上传')
  assert.match(String(r3.error), /ECONNREFUSED/)
})

test('act：上传的 timeoutMs=120000 原样生效（不被 30s 默认吃掉，也不被封顶）', async () => {
  assert.equal(resolveActTimeoutMs(120000), 120000, 'hub 的 FILE_TIMEOUT_MS 必须原样认')
  assert.notEqual(resolveActTimeoutMs(120000), ACT_DEFAULT_TIMEOUT_MS, '120000 不许被折回 30s 默认')
  assert.equal(resolveActTimeoutMs(undefined), 30000, '没给才落 30s（其它动作的默认值不变）')
})

test('act：上传在 mode=off 时连网都不碰（fetch=0，失败说清是模式关着）', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ mode: 'off', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false })

  for (const [action, params] of ACT_UPLOADS) {
    const r = await ob.act(action, params, { timeoutMs: 120000 })
    assert.equal(r.ok, false, action + ' 在 mode=off 时不许发')
    assert.match(String(r.error), /off/, action + ' 的失败要说清是模式关着，不是网络问题')
  }
  assert.equal(f.calls.length, 0, 'mode=off 时 fetch 调用次数必须是 0（连请求体都不生成）')
  assert.equal(ob.stats().sent, 0)
})

test('act：上传的逐字判据 —— 前缀像 / 大小写像 / 后缀补一个都不算白名单里那两个名字', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  // ★ 这里**故意**不放只差空白的写法（' upload_group_file' / 'upload_group_file '）：
  //   act() 从第一片起就对动作名 trim（那是既有行为，这一片不改），所以只差空白的名字**会**匹配。
  //   把那种写法写进「必须被拒」的清单里，会得到一条自相矛盾的测试。
  for (const name of ['upload_file', 'Upload_Group_File', 'UPLOAD_PRIVATE_FILE', 'upload_group_file_extra',
    'upload_private_file_v2', 'upload_group_file_x', 'uploadGroupFile']) {
    const r = await ob.act(name, { group_id: 100, file: 'C:\\tmp\\a.pdf', name: 'a.pdf' })
    assert.equal(r.ok, false, JSON.stringify(name) + ' 不许被当成白名单名字')
    assert.match(String(r.error), /白名单/)
  }
  assert.equal(f.calls.length, 0, '近似串一个请求都不许出去')
})

// ── 第三片（2026-11-24）：头像 + 收藏表情。两个契约，各一条单独的测试 ──────────
test('act：set_qq_avatar 的三种 file 形态（base64 / 本机路径 / 网址）逐字进请求体', async () => {
  for (const file of AVATAR_FILES) {
    const f = rawFetch({ status: 'ok', retcode: 0, data: null })
    const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false })

    const r = await ob.act('set_qq_avatar', { file })

    assert.equal(r.ok, true, file + ' 该发出去')
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].url, BASE + '/set_qq_avatar')
    // ★ 逐字：一个字符都不许归一 / 裁剪 / 改写。写法不同 = 图不同。
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { file }, '请求体必须逐字是 { file }，形态不许被改写')
    assert.equal(JSON.parse(f.calls[0].init.body).file, file, 'file 原样（' + JSON.stringify(file) + '）')
    assert.equal(ob.stats().deduped, 0, '头像不进幂等表')
  }
})

test('act：add_custom_face 的 data.emoji_id 原样交回（stickers.js 靠它继续写备注）', async () => {
  const f = rawFetch({ status: 'ok', retcode: 0, data: { emoji_id: 'MOCK-EMOJI-7', package_id: 3 } })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const r = await ob.act('add_custom_face', { file: 'base64://QkM=' })

  assert.deepEqual(r, { ok: true, retcode: 0, data: { emoji_id: 'MOCK-EMOJI-7', package_id: 3 } }, 'data 原件，不裁成 { ok:true }')
  assert.equal(String(r.data.emoji_id), 'MOCK-EMOJI-7', 'emoji_id 少了这一层，调用方就静默丢一张表情')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { file: 'base64://QkM=' })
  assert.equal(ob.stats().deduped, 0)
})

test('act：头像 / 表情的参数（含 base64 图与路径）一个字都不进日志与视图', async () => {
  const logs = []
  const secretB64 = 'PRIVATE-AVATAR-BASE64-9d2f'
  const secretPath = 'C:\\Users\\pc\\PRIVATE-AVATAR-PATH-7b1c.jpg'
  const f = rawFetch({ status: 'ok', retcode: 0, data: { emoji_id: 'EMOJI-PRIVATE-1' } })
  const ob = createOutbox({
    mode: 'onebot-http', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false,
    log: (m) => logs.push(String(m)),
  })

  await ob.act('set_qq_avatar', { file: 'base64://' + secretB64 })
  await ob.act('set_qq_avatar', { file: secretPath })
  await ob.act('add_custom_face', { file: 'base64://' + secretB64 })

  const haystack = logs.join('|') + JSON.stringify(ob.view(20)) + JSON.stringify(ob.stats())
  for (const secret of [secretB64, 'PRIVATE-AVATAR-PATH-7b1c', 'EMOJI-PRIVATE-1']) {
    assert.equal(haystack.includes(secret), false, secret + ' 不许出现在日志 / 视图 / 计数里')
  }
  assert.match(logs.join('|'), /set_qq_avatar/, '动作名要在日志里（否则「做过什么」查不出来）')
  const row = ob.view().recent[0]
  assert.equal(row.action, 'add_custom_face')
  assert.equal(row.preview, '', '动作记录没有正文预览')
  assert.equal('len' in row, false, '动作记录也不带长度（base64 图会长得离谱）')
  // ★ 但请求体必须真的带上了它（否则上面那条是空断言）
  assert.equal(JSON.parse(f.calls[0].init.body).file, 'base64://' + secretB64)
})

test('act：头像 / 表情的 params 畸形（null / 数组 / 字符串 / 数字）→ 拒，fetch=0', async () => {
  for (const action of ['set_qq_avatar', 'add_custom_face']) {
    const f = fakeFetch()
    const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })
    for (const badParams of [null, ['base64://x'], 'file=base64://x', 42]) {
      const r = await ob.act(action, badParams)
      assert.equal(r.ok, false, action + ' 的 params=' + JSON.stringify(badParams) + ' 不许被当成合法参数')
      assert.match(String(r.error), /params/)
    }
    assert.equal(f.calls.length, 0, action + ' 畸形参数时一个请求都不许出去')
  }
})

test('act：不给 params（undefined）→ 请求体是 {}（空对象），由网关判「缺字段」，本地不静默通过', async () => {
  // ★ 这一条记的是**故意保留的口径**：act() 不做字段校验（「不归一、也不猜字段」是它的契约）。
  //   于是 set_qq_avatar 不带 file 时会真的发出一个 {}，靠网关拒；而网关拒绝会变成
  //   ok:false + retcode —— 不会是「本地假装成功」。第三片没有为了这两条改这条口径。
  const f = rawFetch({ status: 'failed', retcode: 102, wording: '缺 file' })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const r = await ob.act('set_qq_avatar')

  assert.deepEqual(JSON.parse(f.calls[0].init.body), {}, 'omit 参数的请求体就是空对象')
  assert.equal(r.ok, false, '网关说缺字段 → 失败（不是本地放行）')
  assert.equal(r.retcode, 102)
  assert.equal(ob.stats().failed, 1)
})

test('act：同一张头像 / 同一张表情做两次 → 两次请求（换两次、加两张都是意图）', async () => {
  const f = rawFetch({ status: 'ok', retcode: 0, data: { emoji_id: 'E-SAME' } })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const sameFile = 'base64://SAME-IMAGE-BYTES'
  await ob.act('set_qq_avatar', { file: sameFile })
  await ob.act('set_qq_avatar', { file: sameFile })
  await ob.act('add_custom_face', { file: sameFile })
  await ob.act('add_custom_face', { file: sameFile })

  assert.equal(f.calls.length, 4, '四次调用 = 四个请求（一个都不许被摘要并入前一次）')
  assert.equal(ob.view().stats.deduped, 0, 'deduped 只属于发消息')
  assert.equal(ob.view().dedupe.entries, 0, '头像 / 表情都不进幂等表')
  assert.equal(ob.view().stats.sent, 4)
})

test('act：params 无法序列化（循环引用 / BigInt）→ 拒，fetch 一次都不调，不抛', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const circular = { file: 'base64://x' }
  circular.self = circular
  const withBigInt = { file: 'base64://y', size: 10n }

  for (const [action, params] of [['set_qq_avatar', circular], ['add_custom_face', withBigInt]]) {
    let threw = false
    let r = null
    try { r = await ob.act(action, params) } catch { threw = true }
    assert.equal(threw, false, action + ' 的序列化失败必须返回，不许抛')
    assert.equal(r.ok, false)
    assert.match(String(r.error), /序列化/, action + ' 的失败要说清是参数问题，不是网络问题')
  }
  assert.equal(f.calls.length, 0, '序列化失败一个请求都不许出去')
  assert.equal(ob.stats().failed, 2)
})

test('act：mode=off + 已配置 baseUrl → 十九个全拒，fetch 一次都不调，也没进幂等表', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ mode: 'off', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false })

  for (const [action, params] of [...ACT_ACTION_CASES, ...ACT_UPLOADS]) {
    const r = await ob.act(action, params)
    assert.equal(r.ok, false, action + ' 在 mode=off 时不许发')
    assert.match(String(r.error), /off/, action + ' 的失败要说清是模式关着')
  }
  assert.equal(f.calls.length, 0, 'mode=off 时 fetch 调用次数必须是 0')
  assert.equal(ob.stats().sent, 0)
  assert.equal(ob.stats().failed, 19, '十九次拒绝 = 十九次失败计数（一次一条）')
  assert.equal(ob.view().dedupe.entries, 0)
  assert.equal(ob.view().mode, 'off')
})

test('act：mode 认了但没 baseUrl → 拒，fetch=0（两个条件都要满足）', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: '', fetchImpl: f.impl, register: false })

  const r = await ob.act('set_qq_profile', { nickname: '砚青' })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /baseUrl/)
  assert.equal(f.calls.length, 0)
})

test('act：params 不是对象（字符串 / 数组 / null）→ 拒，fetch=0', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  for (const badParams of ['nickname=砚青', [1, 2, 3], null, 42]) {
    const r = await ob.act('set_qq_profile', badParams)
    assert.equal(r.ok, false, JSON.stringify(badParams) + ' 不许被当成合法参数')
    assert.match(String(r.error), /params/)
  }
  assert.equal(f.calls.length, 0)
})

test('act：默认超时 30000ms（与 OneBot client 同值），per-call 正数覆盖，坏值回落 30000', () => {
  assert.equal(ACT_DEFAULT_TIMEOUT_MS, 30000)
  assert.equal(ACT_DEFAULT_TIMEOUT_MS, ONEBOT_DEFAULT_TIMEOUT_MS, '两个默认值必须同源，否则迁移后更容易被判超时')
  assert.equal(resolveActTimeoutMs(undefined), 30000)
  assert.equal(resolveActTimeoutMs(null), 30000)
  assert.equal(resolveActTimeoutMs(15000), 15000, '模块改资料给的是 15s，必须照用')
  assert.equal(resolveActTimeoutMs(5000), 5000)
  assert.equal(resolveActTimeoutMs('7000'), 7000, '数字字符串也认（Number 语义）')
  for (const bad of [0, -1, NaN, '', 'abc', Infinity, -Infinity]) {
    assert.equal(resolveActTimeoutMs(bad), 30000, String(bad) + ' 不是「不超时」，回落 30s')
  }
})

test('act：per-call 40ms 真的生效（挂住的网关在 1.5s 内被判失败）', async () => {
  const f = hangingFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, timeoutMs: 5000, fetchImpl: f.impl, register: false })

  const t0 = Date.now()
  const r = await ob.act('set_self_longnick', { longNick: '慢网关' }, { timeoutMs: 40 })
  const spent = Date.now() - t0

  assert.equal(r.ok, false)
  assert.match(String(r.error), /网络错误/)
  assert.ok(spent < 1500, '显式 40ms 必须真的压过 30s 默认（实测 ' + spent + 'ms）')
  assert.equal(f.calls.length, 1)
  assert.equal(ob.stats().failed, 1)
})

for (const [label, payload, status, retcode] of [
  ['retcode=100', { status: 'failed', retcode: 100, wording: '没权限' }, 200, 100],
  ['status 不是 ok 且缺 retcode', { status: 'failed' }, 200, null],
  ['HTTP 500', { status: 'failed', retcode: 500 }, 500, 500],
  ['回的不是 JSON', 'not json', 200, null],
]) {
  test('act 失败（' + label + '）→ ok:false、failed 只 +1、不抛', async () => {
    const f = rawFetch(payload, { status })
    const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

    let threw = false
    let r = null
    try { r = await ob.act('delete_custom_face', { emoji_id: 'E-3' }) } catch { threw = true }

    assert.equal(threw, false, 'act 的失败必须**返回**，不许抛')
    assert.equal(r.ok, false)
    assert.equal(r.retcode, retcode, 'retcode 原样带出（能判是哪一类）')
    assert.equal(ob.stats().failed, 1, '一次失败只能记一次')
    assert.equal(ob.stats().sent, 0)
  })
}

test('act：网络错只打一次网关（不自动重试），错误里带 cause', async () => {
  let n = 0
  const impl = async () => { n += 1; throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: impl, register: false })

  const r = await ob.act('set_input_status', { user_id: 10001, event_type: 1 })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /ECONNREFUSED/)
  assert.equal(n, 1, '重试是调用方对业务语义的判断，不许藏在传输层')
  assert.equal(ob.stats().failed, 1)
})

test('close() 掐得断在途 act（不是等它自己超时）', async () => {
  const f = hangingFetch()
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, timeoutMs: 60000, fetchImpl: f.impl, register: false })

  const pending = ob.act('set_qq_profile', { nickname: '砚青' }, { timeoutMs: 60000 })
  const t0 = Date.now()
  ob.close()
  const r = await pending
  const spent = Date.now() - t0

  assert.equal(r.ok, false)
  assert.ok(spent < 1500, 'close() 之后必须马上结束（实测 ' + spent + 'ms；没登记 inflight 就会挂满 60s）')
  assert.equal(ob.stats().failed, 1)
})

test('act：params 一个字都不进日志 / 视图 / 记录（昵称、签名、备注是用户内容）', async () => {
  const logs = []
  const secretNick = 'PRIVATE-NICK-7f3a'
  const secretSign = 'PRIVATE-SIGN-9c1d'
  const secretDesc = 'PRIVATE-DESC-2b8e'

  const f = rawFetch({ status: 'ok', retcode: 0, data: { emoji_id: 'E-9' } })
  const ob = createOutbox({
    mode: 'onebot-http', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false,
    log: (m) => logs.push(String(m)),
  })

  await ob.act('set_qq_profile', { nickname: secretNick })
  await ob.act('set_self_longnick', { longNick: secretSign })
  await ob.act('modify_custom_face', { emoji_id: 'E-9', desc: secretDesc })

  const haystack = logs.join('|') + JSON.stringify(ob.view(20)) + JSON.stringify(ob.stats())
  for (const secret of [secretNick, secretSign, secretDesc]) {
    assert.equal(haystack.includes(secret), false, secret + ' 不许出现在日志 / 视图 / 计数里')
  }
  assert.match(logs.join('|'), /set_qq_profile/, '动作名要在日志里（否则「做过什么」查不出来）')

  const row = ob.view().recent[0]
  assert.equal(row.action, 'modify_custom_face')
  assert.equal(row.preview, '', '动作记录没有正文预览')
  assert.equal('len' in row, false, '动作记录也不带长度')
  assert.equal(JSON.stringify(row).includes(secretDesc), false)
})
// ── 第四片（2026-11-24）：好友申请审批这两个名字（set_friend_add_request /
//    set_doubt_friends_add_request）走 act 时的契约。
//
//   四条：
//   · 请求体逐字是 { flag, approve } —— flag 由网关签发，**一个字符都不许改**；
//   · 同一条申请做两次 = 两次请求（审批类不挂摘要幂等，也不自动重试）；
//   · 成败语义与其它动作同一条（status==='ok' 或 retcode===0）；
//   · flag / approve **一个字都不进**日志 / 视图 / 记录。
// ────────────────────────────────────────────────────────────────────────────

/**
 * flag 的几种真实形态 —— 逐字比对，一个都不许归一。
 *   ① 事件来的 flag：SnowLuma 的 flag 常常是带冒号 / 下划线的长串；
 *   ② get_doubt_friends_add_request 回的 uid（可能是纯数字串）；
 *   ③ 带前后空格的（网关给什么就是什么，这一层不许 trim —— trim 完就是另一条申请）；
 *   ④ 大小写混写的（同上）。
 * ★ 只测一种 = 只测了四分之一的迁移，而漏掉的那种失败起来像「网关说 flag 无效」。
 */
const APPROVAL_FLAGS = [
  'flag:9f2e1c-add-friend-request',
  '1234567890',
  ' padded-flag-with-spaces ',
  'MixedCaseFlag-AbC123',
]

test('act：set_friend_add_request / set_doubt_friends_add_request 的 { flag, approve } 逐字进请求体', async () => {
  for (const action of ['set_friend_add_request', 'set_doubt_friends_add_request']) {
    for (const flag of APPROVAL_FLAGS) {
      for (const approve of [true, false]) {
        const f = rawFetch({ status: 'ok', retcode: 0, data: null })
        const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false })

        const params = { flag, approve }
        const r = await ob.act(action, params, { timeoutMs: 15000 })

        assert.equal(r.ok, true, action + ' ' + JSON.stringify(flag) + ' approve=' + approve + ' 该成功')
        assert.equal(f.calls.length, 1, action + ' 只该发一个请求')
        assert.equal(f.calls[0].url, BASE + '/' + action, 'URL 就是 baseUrl + / + 动作名（两个名字各落各的）')
        const body = JSON.parse(f.calls[0].init.body)
        assert.deepEqual(body, params, action + ' 的请求体必须逐字是 { flag, approve }')
        assert.equal(body.flag, flag, 'flag 逐字相同（' + JSON.stringify(flag) + '）')
        assert.equal(body.approve, approve, 'approve 保持布尔（不许被压成 0/1 或字符串）')
        assert.equal(typeof body.approve, 'boolean', 'approve 的类型也是契约的一部分')
      }
    }
  }
})

test('act：同一条申请连着做两次 = 两次请求（审批类不挂摘要幂等）', async () => {
  const f = rawFetch({ status: 'ok', retcode: 0, data: null })
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

  const params = { flag: 'same-request-flag-77', approve: true }
  const a = await ob.act('set_friend_add_request', params)
  const b = await ob.act('set_friend_add_request', params)

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(f.calls.length, 2, '同一条申请连点两次通过就是两次请求（第二次由网关判「已处理」）')
  assert.equal(a.deduped, undefined, 'act 的返回里没有 deduped —— 它压根不进幂等表')
  assert.equal(ob.view().stats.deduped, 0, 'deduped 只属于发消息')
  assert.equal(ob.view().stats.sent, 2)
  assert.equal(ob.view().dedupe.entries, 0, '审批类动作不进幂等表')
  // ★ 两次的请求体必须仍是一样的原件：去重在这里会表现为「第二次没请求」或「第二次被改写」
  assert.deepEqual(JSON.parse(f.calls[0].init.body), params)
  assert.deepEqual(JSON.parse(f.calls[1].init.body), params)
})

test('act：审批类失败（retcode / HTTP 500 / 网络错）→ ok:false、failed 只 +1、不重试', async () => {
  for (const [label, payload, status] of [
    ['retcode=100', { status: 'failed', retcode: 100, wording: 'flag 无效' }, 200],
    ['status 不是 ok 且缺 retcode', { status: 'failed' }, 200],
    ['HTTP 500', { status: 'failed', retcode: 500 }, 500],
    ['回的不是 JSON', 'not json', 200],
  ]) {
    const f = rawFetch(payload, { status })
    const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: f.impl, register: false })

    let threw = false
    let r = null
    try { r = await ob.act('set_friend_add_request', { flag: 'f-1', approve: true }) } catch { threw = true }

    assert.equal(threw, false, '审批失败必须**返回**，不许抛')
    assert.equal(r.ok, false, label)
    assert.equal(ob.stats().failed, 1, '一次失败只能记一次')
    assert.equal(ob.stats().sent, 0)
    assert.equal(f.calls.length, 1, label + '：失败不自动重试（重试是调用方的判断）')
  }
})

test('act：审批类网络错只打一次网关（不自动重试），错误里带 cause', async () => {
  let n = 0
  const impl = async () => { n += 1; throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
  const ob = createOutbox({ mode: 'onebot-http', baseUrl: BASE, fetchImpl: impl, register: false })

  const r = await ob.act('set_doubt_friends_add_request', { flag: 'd-1', approve: false })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /ECONNREFUSED/)
  assert.equal(n, 1, '重试是调用方对业务语义的判断，不许藏在传输层')
  assert.equal(ob.stats().failed, 1)
})

test('act：flag / approve 一个字都不进日志 / 视图 / 记录（flag 是网关签发的凭据）', async () => {
  const logs = []
  const secretFlag = 'PRIVATE-FLAG-3a7c-received-from-gateway'
  const secretDoubtFlag = 'PRIVATE-DOUBT-UID-9b2e'

  const f = rawFetch({ status: 'ok', retcode: 0, data: null })
  const ob = createOutbox({
    mode: 'onebot-http', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false,
    log: (m) => logs.push(String(m)),
  })

  await ob.act('set_friend_add_request', { flag: secretFlag, approve: true })
  await ob.act('set_doubt_friends_add_request', { flag: secretDoubtFlag, approve: false })

  const haystack = logs.join('|') + JSON.stringify(ob.view(20)) + JSON.stringify(ob.stats())
  for (const secret of [secretFlag, secretDoubtFlag]) {
    assert.equal(haystack.includes(secret), false, secret + ' 不许出现在日志 / 视图 / 计数里')
  }
  assert.match(logs.join('|'), /set_friend_add_request/, '动作名要在日志里（否则「做过什么」查不出来）')

  // ★ 记录里只有动作名与成败：读不出去**批了哪一条**、也读不出去批的是通过还是拒绝
  for (const row of ob.view(20).recent) {
    assert.equal(row.preview, '', '审批记录没有正文预览')
    assert.equal('len' in row, false, '审批记录也不带长度')
    for (const key of ['flag', 'approve', 'params']) {
      assert.equal(key in row, false, '记录里不许有 ' + key + ' 字段')
    }
    assert.equal(String(row.chatId), '', '审批动作没有 chatId')
  }
  // ★ 但请求体必须真的带上了它（否则上面那条是空断言）
  assert.equal(JSON.parse(f.calls[0].init.body).flag, secretFlag)
  assert.equal(JSON.parse(f.calls[1].init.body).flag, secretDoubtFlag)
})

test('act：审批类 mode=off → 两个都拒，fetch 一次都不调（闸在这条通道上也成立）', async () => {
  const f = fakeFetch()
  const ob = createOutbox({ mode: 'off', baseUrl: BASE, token: TOKEN, fetchImpl: f.impl, register: false })

  for (const action of ['set_friend_add_request', 'set_doubt_friends_add_request']) {
    const r = await ob.act(action, { flag: 'f-1', approve: true })
    assert.equal(r.ok, false, action + ' 在 mode=off 时不许发')
    assert.match(String(r.error), /off/, action + ' 的失败要说清是模式关着，不是网络问题')
  }
  assert.equal(f.calls.length, 0, 'mode=off 时 fetch 调用次数必须是 0')
})
